import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createGateway } from "../dist/server.js";

// Executable verification of response memory (`responsesState`): follow-ups
// that name `previous_response_id` reserve their own estimate plus the size
// Tyr recorded for the response they name, and a follow-up without a usable
// record is refused before the provider is called.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = mkdtempSync(join(tmpdir(), "tyr-verify-responses-state-"));

// With the pool below, this request reserves 111 tokens: 11 estimated input
// tokens plus the 100-token output limit. The provider reports 20 input and
// 30 output tokens for every reply, so each record is 50 tokens.
const REQUEST = { model: "gpt-4o", input: "hello", max_output_tokens: 100 };
const RESERVED = 111;
const RECORDED = 50;
const POOL = {
  name: "openai",
  modelPrefixes: ["gpt"],
  model: "gpt-4o",
  maxConcurrent: 4,
  budget: 5000,
  adaptiveEstimation: { enabled: false },
};

function listen(server, port = 0) {
  server.listen(port, "127.0.0.1");
  return once(server, "listening").then(() => {
    const address = server.address();
    assert(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  });
}

function sse(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

// Stand-in provider. `metadata.mode: "no-usage"` omits usage from the reply.
let providerCalls = 0;
let createdResponses = 0;
const provider = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    providerCalls += 1;
    createdResponses += 1;
    const id = `resp_${createdResponses}`;
    const usage =
      body.metadata?.mode === "no-usage"
        ? undefined
        : { input_tokens: 20, output_tokens: 30, total_tokens: 50 };
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        sse("response.created", {
          response: { id, status: "in_progress", usage: null },
        }),
      );
      res.write(
        sse("response.completed", {
          response: { id, status: "completed", usage },
        }),
      );
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ id, object: "response", status: "completed", usage }),
    );
  });
});

let stateFiles = 0;
function newStateFile() {
  stateFiles += 1;
  return join(workDir, `state-${stateFiles}.jsonl`);
}

async function withGateway(options, run) {
  const created = createGateway({
    openaiUpstreamUrl: providerUrl,
    pools: [POOL],
    ...options,
  });
  const url = await listen(created.server);
  try {
    await run(url);
  } finally {
    await created.shutdown();
  }
}

async function post(url, body, headers = {}) {
  const response = await fetch(`${url}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function followUp(id, extra = {}) {
  return { ...REQUEST, previous_response_id: id, ...extra };
}

async function poolStats(url) {
  return (await (await fetch(`${url}/stats`)).json()).openai;
}

function assertFollowUp(reply) {
  assert.equal(reply.status, 200);
  assert.equal(
    reply.headers.get("x-admission-reserved-tokens"),
    String(RESERVED + RECORDED),
  );
  assert.equal(reply.headers.get("x-admission-prior-tokens"), String(RECORDED));
}

function assertUnknown(reply) {
  assert.equal(reply.status, 422);
  assert.equal(reply.json.error.type, "unknown_previous_response");
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Tyr exited with code ${child.exitCode} before listening`);
    }
    try {
      if ((await fetch(`${url}/healthz`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await delay(25);
  }
  throw new Error("Tyr did not start listening in time");
}

function startProcess(configPath) {
  const child = spawn(process.execPath, [join(repoRoot, "dist", "index.js")], {
    // A minimal environment: file mode refuses to start next to legacy
    // variables such as PORT.
    env: { PATH: process.env.PATH ?? "", TYR_CONFIG_FILE: configPath },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return child;
}

const providerUrl = await listen(provider);

try {
  // Without responsesState, nothing changes: the follow-up is an invalid
  // request and /stats has no responsesState block.
  await withGateway({}, async (url) => {
    const first = await post(url, REQUEST);
    assert.equal(first.status, 200);
    const rejected = await post(url, followUp(first.json.id));
    assert.equal(rejected.status, 400);
    assert.equal(rejected.json.error.type, "invalid_request");
    assert.equal((await poolStats(url)).tyr.responsesState, undefined);
  });

  // A follow-up reserves its own estimate plus the recorded size.
  await withGateway(
    { responsesState: { file: newStateFile(), maxEntries: 100, ttlMs: 60000 } },
    async (url) => {
      const first = await post(url, REQUEST);
      assert.equal(first.status, 200);
      assert.equal(
        first.headers.get("x-admission-reserved-tokens"),
        String(RESERVED),
      );
      assert.equal(first.headers.get("x-admission-prior-tokens"), null);

      assertFollowUp(await post(url, followUp(first.json.id)));
      let stats = await poolStats(url);
      assert.equal(stats.tyr.responsesState.records, 2);
      assert.equal(stats.tyr.responsesState.followUps, 1);
      assert.equal(stats.tyr.responsesState.priorTokens, RECORDED);
      assert.equal(stats.tokenBudget.inFlightTokens, 0);
      assert.equal(
        stats.tokenBudget.totalReserved,
        RESERVED + RESERVED + RECORDED,
      );

      // An unknown id is refused and the provider is not called.
      const callsBefore = providerCalls;
      const unknown = await post(url, followUp("resp_none"));
      assertUnknown(unknown);
      assert.equal(
        unknown.headers.get("x-admission-reason"),
        "unknown_previous_response",
      );
      assert.equal(providerCalls, callsBefore);
      stats = await poolStats(url);
      assert.equal(stats.tyr.responsesState.refused, 1);
      assert.equal(stats.llm.rejected, 0);

      // A reply that was not stored, or that carried no usage, is not recorded.
      const notStored = await post(url, { ...REQUEST, store: false });
      assert.equal(notStored.status, 200);
      assertUnknown(await post(url, followUp(notStored.json.id)));
      const noUsage = await post(url, {
        ...REQUEST,
        metadata: { mode: "no-usage" },
      });
      assert.equal(noUsage.status, 200);
      assertUnknown(await post(url, followUp(noUsage.json.id)));

      // A streamed reply is recorded from its final event.
      const stream = await post(url, { ...REQUEST, stream: true });
      assert.equal(stream.status, 200);
      const streamedId = /"id":"(resp_\d+)"/.exec(stream.text)?.[1];
      assert.ok(streamedId);
      assertFollowUp(await post(url, followUp(streamedId)));

      const metrics = await (await fetch(`${url}/metrics`)).text();
      assert.match(metrics, /tyr_pool_responses_state_records\{pool="openai"\} \d+/);
      assert.match(
        metrics,
        /tyr_admission_rejections_total\{[^}]*reason="unknown_previous_response"\} 3/,
      );
    },
  );

  // Records are bounded in number.
  await withGateway(
    { responsesState: { file: newStateFile(), maxEntries: 2, ttlMs: 60000 } },
    async (url) => {
      const first = await post(url, REQUEST);
      await post(url, REQUEST);
      const third = await post(url, REQUEST);
      assertUnknown(await post(url, followUp(first.json.id)));
      assertFollowUp(await post(url, followUp(third.json.id)));
      assert.equal((await poolStats(url)).tyr.responsesState.records, 2);
    },
  );

  // Records are bounded in age.
  await withGateway(
    { responsesState: { file: newStateFile(), maxEntries: 100, ttlMs: 200 } },
    async (url) => {
      const first = await post(url, REQUEST);
      await delay(600);
      assertUnknown(await post(url, followUp(first.json.id)));
      assert.equal((await poolStats(url)).tyr.responsesState.expired, 1);
    },
  );

  // A record belongs to the tenant and application that created it.
  await withGateway(
    {
      responsesState: { file: newStateFile(), maxEntries: 100, ttlMs: 60000 },
      identity: {
        authenticate: (req) => ({
          subject: String(req.headers["x-subject"]),
          tenantId: String(req.headers["x-tenant"]),
          applicationId: String(req.headers["x-app"]),
          roles: ["invoke"],
        }),
        invokeRoles: ["invoke"],
      },
    },
    async (url) => {
      const caller = (tenant, app, subject) => ({
        "x-tenant": tenant,
        "x-app": app,
        "x-subject": subject,
      });
      const first = await post(url, REQUEST, caller("t1", "a1", "user-1"));
      assert.equal(first.status, 200);
      assertFollowUp(
        await post(url, followUp(first.json.id), caller("t1", "a1", "user-2")),
      );
      const callsBefore = providerCalls;
      const unknown = await post(
        url,
        followUp("resp_none"),
        caller("t1", "a1", "user-1"),
      );
      for (const headers of [
        caller("t2", "a1", "user-1"),
        caller("t1", "a2", "user-1"),
      ]) {
        const refused = await post(url, followUp(first.json.id), headers);
        assertUnknown(refused);
        // Another owner cannot tell the response exists.
        assert.deepEqual(refused.json, unknown.json);
      }
      assert.equal(providerCalls, callsBefore);
    },
  );

  // Records survive a killed process. Tyr runs as its own process from a
  // configuration file, is killed right after a reply, and is started again.
  const freePort = createServer();
  const port = Number(new URL(await listen(freePort)).port);
  freePort.close();
  await once(freePort, "close");
  const configPath = join(workDir, "tyr.yaml");
  writeFileSync(
    configPath,
    [
      "version: 1",
      "server:",
      `  port: ${port}`,
      "upstreams:",
      "  openai:",
      `    baseUrl: ${providerUrl}`,
      "responsesState:",
      "  file: process-state.jsonl",
      "  maxEntries: 100",
      "  ttlMs: 60000",
      "pools:",
      "  - name: openai",
      "    modelPrefixes: [gpt]",
      "    estimatorModel: gpt-4o",
      "    maxConcurrent: 4",
      "    inFlightTokenBudget: 5000",
      "    adaptiveEstimation:",
      "      enabled: false",
      "",
    ].join("\n"),
  );
  const processUrl = `http://127.0.0.1:${port}`;

  let child = startProcess(configPath);
  let restarted;
  try {
    await waitForHealth(processUrl, child);
    const first = await post(processUrl, REQUEST);
    assert.equal(first.status, 200);
    // The relative path was resolved next to the configuration file, and the
    // record was on disk before the reply ended.
    assert.match(
      readFileSync(join(workDir, "process-state.jsonl"), "utf8"),
      new RegExp(`"id":"${first.json.id}"`),
    );
    child.kill("SIGKILL");
    await once(child, "exit");

    restarted = startProcess(configPath);
    await waitForHealth(processUrl, restarted);
    assertFollowUp(await post(processUrl, followUp(first.json.id)));
    assert.equal((await poolStats(processUrl)).tyr.responsesState.records, 2);

    restarted.kill("SIGTERM");
    const [exitCode] = await once(restarted, "exit");
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (
      restarted !== undefined &&
      restarted.exitCode === null &&
      restarted.signalCode === null
    ) {
      restarted.kill("SIGKILL");
    }
  }

  console.log(
    "Responses state verification passed: unchanged when off, follow-up reservations, unknown-id refusal without a provider call, unrecorded replies, streamed replies, entry and age bounds, ownership, and a record that survives a killed process.",
  );
} finally {
  provider.close();
  rmSync(workDir, { recursive: true, force: true });
}
