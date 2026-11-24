#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  LLMAdmissionStoppedError,
  LLMBulkheadRejectedError,
} from "async-bulkhead-llm";
import { createPools } from "../dist/pools.js";
import { createGateway } from "../dist/server.js";

// Executable verification of stopping admitted requests: nothing is stopped
// unless it is configured, an overrun cuts a stream, a provider's closing
// usage does not, a lowered limit stops what is above it after the grace
// period, a stream that has sent nothing is answered instead of cut, a stop
// returns the slot while the tokens stay charged until the call ends, and a
// shutdown can stop what outlives its drain deadline. The last part runs the
// built server as its own process.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = mkdtempSync(join(tmpdir(), "tyr-verify-stop-"));

function listen(server, port = 0) {
  server.listen(port, "127.0.0.1");
  return once(server, "listening").then(() => {
    const address = server.address();
    assert(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  });
}

async function until(predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(5);
  }
}

// Stand-in provider. What it does is chosen by the first word of the prompt:
//   "hold"     never answers; the test checks whether Tyr drops the call
//   "runaway"  streams output far past the request's limit, then would finish
//   "silent"   answers a stream with headers and then sends nothing
//   "closing"  streams a whole reply and reports heavy usage as it ends
//   anything   answers at once
const calls = [];
const provider = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const prompt = String(body.messages?.[0]?.content ?? "");
    const call = { prompt, res, dropped: false };
    res.on("close", () => {
      if (!res.writableFinished) call.dropped = true;
    });
    calls.push(call);
    if (prompt.startsWith("hold")) return;
    if (prompt.startsWith("silent")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      return;
    }
    if (prompt.startsWith("closing")) {
      const chunk = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      chunk({ choices: [{ delta: { content: "the whole answer" } }], usage: null });
      chunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: null });
      chunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 9000 } });
      res.end("data: [DONE]\n\n");
      return;
    }
    if (prompt.startsWith("runaway")) {
      const event = (type, data) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      event("message_start", { message: { usage: { input_tokens: 1 } } });
      event("message_delta", { usage: { output_tokens: 40 } });
      setTimeout(() => event("message_delta", { usage: { output_tokens: 5000 } }), 20);
      setTimeout(() => {
        if (res.destroyed) return;
        event("message_stop", {});
        res.end();
      }, 400);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-verify",
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 6 },
      }),
    );
  });
});

function answer(call) {
  call.res.writeHead(200, { "content-type": "application/json" });
  call.res.end(
    JSON.stringify({
      id: "chatcmpl-verify",
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 6 },
    }),
  );
}

function chat(url, prompt, extra = {}) {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      ...extra,
    }),
  });
}

const POOL = {
  name: "primary",
  modelPrefixes: ["gpt", "claude"],
  model: "gpt-4o",
  maxConcurrent: 2,
  budget: 10_000,
  adaptiveEstimation: { enabled: false },
};

function limits(revision, maxConcurrent, extra = {}) {
  return {
    revision,
    maxConcurrent,
    maxQueue: 0,
    tokenBudget: { budget: 10_000, highPriorityReserve: 0 },
    ...extra,
  };
}

async function withGateway(options, run) {
  const audits = [];
  const gateway = createGateway({
    upstreamUrl: providerUrl,
    openaiUpstreamUrl: providerUrl,
    telemetry: {
      metricsEnabled: true,
      auditEnabled: true,
      auditSink: (event) => audits.push(event),
    },
    ...options,
  });
  const url = await listen(gateway.server);
  calls.length = 0;
  try {
    await run({ gateway, url, audits });
  } finally {
    gateway.server.closeAllConnections();
    await gateway.shutdown();
  }
}

const providerUrl = await listen(provider);

try {
  // Without a stop policy nothing changes: no stop counters anywhere, and a
  // limits update that names a policy still stops nothing.
  await withGateway({ pools: [POOL] }, async ({ gateway, url }) => {
    const running = chat(url, "hold on");
    await until(() => calls.length === 1, "the provider call");
    const applied = gateway.control.applyLimits([
      { pool: "primary", limits: limits(1, 0, { stop: { takeBackGraceMs: 0 } }) },
    ]);
    assert.equal(applied.applied, true);
    await delay(60);
    assert.equal(calls[0].dropped, false);
    answer(calls[0]);
    assert.equal((await running).status, 200);

    const stats = gateway.control.stats().primary;
    assert.equal(stats.limits.stop, undefined);
    assert.equal(stats.llm.stopped, undefined);
    assert.equal(stats.tyr.stop, undefined);
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.doesNotMatch(metrics, /tyr_pool_stop|_stopped_total|outcome="stopped"/);
  });
  console.log("PASS nothing is stopped, counted or exported without a stop policy");

  // An overrun cuts the stream and drops the provider call.
  await withGateway(
    {
      pools: [
        {
          ...POOL,
          initialRevision: 100,
          stop: { overrunAllowanceTokens: 50 },
          progressiveReconciliation: { enabled: false },
        },
      ],
    },
    async ({ gateway, url, audits }) => {
      // The pool keeps its configured revision and reports the policy.
      assert.deepEqual(gateway.control.limits().primary, {
        ...limits(100, 2),
        stop: { overrunAllowanceTokens: 50 },
      });

      const response = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          stream: true,
          messages: [{ role: "user", content: "runaway output" }],
        }),
      });
      assert.equal(response.status, 200);
      let text = "";
      let cut = false;
      try {
        for await (const chunk of response.body) text += Buffer.from(chunk).toString();
      } catch {
        cut = true;
      }
      assert.equal(cut, true);
      assert.doesNotMatch(text, /message_stop/);
      await until(() => calls[0].dropped, "the provider call to be dropped");
      await until(() => audits.length === 1, "the audit event");
      assert.equal(audits[0].settlement, "stopped");
      assert.equal(audits[0].stopCause, "overrun");
      assert.deepEqual(audits[0].usage, { input: 1, output: 5000 });

      await until(
        () => gateway.control.stats().primary.tokenBudget.inFlightTokens === 0,
        "the tokens to be returned",
      );
      const stats = gateway.control.stats().primary;
      assert.equal(stats.bulkhead.inFlight, 0);
      assert.deepEqual(stats.tyr.stop, {
        policy: { overrunAllowanceTokens: 50 },
        stopped: 1,
        stoppedByCause: { overrun: 1, limits: 0, drain_deadline: 0 },
      });
      const metrics = await (await fetch(`${url}/metrics`)).text();
      assert.match(metrics, /tyr_pool_stopped_total\{cause="overrun",pool="primary"\} 1/);
      assert.match(
        metrics,
        /tyr_requests_total\{outcome="stopped",pool="primary",provider="anthropic"\} 1/,
      );
      assert.match(metrics, /tyr_pool_stop_overrun_allowance_tokens\{pool="primary"\} 50/);
    },
  );
  console.log("PASS an overrun cuts the stream, drops the provider call and is counted");

  // Usage a provider sends as it ends a reply counts work already done. It
  // settles the request's accounting but does not stop the reply.
  await withGateway(
    { pools: [{ ...POOL, stop: { overrunAllowanceTokens: 50 } }] },
    async ({ gateway, url, audits }) => {
      const response = await chat(url, "closing usage", { stream: true });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /the whole answer/);
      assert.match(text, /data: \[DONE\]/);
      await until(() => audits.length === 1, "the audit event");
      assert.equal(audits[0].settlement, "completed");
      assert.deepEqual(audits[0].usage, { input: 5, output: 9000 });
      const stats = gateway.control.stats().primary;
      assert.equal(stats.tyr.stop.stopped, 0);
      assert.equal(stats.tokenBudget.totalConsumed, 9005);
      assert.equal(stats.tokenBudget.inFlightTokens, 0);
    },
  );
  console.log("PASS usage a provider reports as a reply ends does not cut the reply");

  // A lowered limit stops what is above it once the grace period ends, and
  // answers 503 when the reply has not started.
  await withGateway(
    { pools: [{ ...POOL, stop: { takeBackGraceMs: 40 } }] },
    async ({ gateway, url, audits }) => {
      // Revision 0 cannot carry a policy, so an open pool starts at 1.
      assert.equal(gateway.control.limits().primary.revision, 1);
      const older = chat(url, "hold older");
      await until(() => calls.length === 1, "the first provider call");
      const newer = chat(url, "hold newer");
      await until(() => calls.length === 2, "the second provider call");

      const loweredAt = Date.now();
      // The update names no policy, and one it did name would be ignored:
      // the pool's own policy is stated on every revision.
      const applied = gateway.control.applyLimits([
        { pool: "primary", limits: limits(2, 1, { stop: { takeBackGraceMs: 60_000 } }) },
      ]);
      assert.equal(applied.applied, true);
      assert.deepEqual(gateway.control.limits().primary.stop, { takeBackGraceMs: 40 });

      const stopped = await newer;
      assert.ok(Date.now() - loweredAt >= 35, "stopped before the grace period ended");
      assert.equal(stopped.status, 503);
      assert.equal(stopped.headers.get("x-admission-reason"), "stopped");
      assert.equal(stopped.headers.get("x-admission-stop-cause"), "limits");
      assert.equal(stopped.headers.get("retry-after"), null);
      const body = await stopped.json();
      assert.equal(body.error.type, "admission_stopped");
      assert.equal(body.error.cause, "limits");
      assert.equal(body.error.pool, "primary");
      assert.equal(body.error.localSlotReleased, true);
      assert.equal(body.error.upstreamCancellation, "requested");
      assert.equal(body.error.upstreamReclamation, "unverified");
      await until(() => calls[1].dropped, "the stopped provider call to be dropped");
      assert.equal(calls[0].dropped, false);
      assert.equal(audits[0].settlement, "stopped");
      assert.equal(audits[0].stopCause, "limits");

      answer(calls[0]);
      assert.equal((await older).status, 200);
      const stats = gateway.control.stats().primary;
      assert.equal(stats.tyr.stop.stoppedByCause.limits, 1);
      assert.equal(stats.tokenBudget.inFlightTokens, 0);
    },
  );
  console.log("PASS a lowered limit stops the newest request after the grace period with 503 admission_stopped");

  // A streamed request whose provider has answered with headers only has
  // been sent nothing, so its stop is answered with a status too.
  await withGateway(
    { pools: [{ ...POOL, stop: { takeBackGraceMs: 20 } }] },
    async ({ gateway, url }) => {
      const streamed = chat(url, "silent stream", { stream: true });
      await until(() => calls.length === 1, "the provider call");
      await delay(40);
      gateway.control.applyLimits([{ pool: "primary", limits: limits(2, 0) }]);
      const response = await streamed;
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("x-admission-stop-cause"), "limits");
      assert.equal((await response.json()).error.type, "admission_stopped");
      await until(() => calls[0].dropped, "the provider call to be dropped");
    },
  );
  console.log("PASS a stream stopped before its first byte gets 503, not a closed connection");

  // A stop returns the slot at once and keeps the tokens charged until the
  // callback settles, even when the callback ignores the abort.
  {
    const pools = createPools([
      {
        ...POOL,
        maxConcurrent: 1,
        budget: 1_500,
        stop: { overrunAllowanceTokens: 0 },
        progressiveReconciliation: { enabled: false },
      },
    ]);
    const pool = pools.get("primary");
    const request = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "token hold proof" }],
      max_tokens: 1_000,
    };
    let finish;
    let context;
    let signal;
    const stopped = pool.run(
      request,
      pool.prepare(request, "normal"),
      (callbackSignal, callbackContext) => {
        signal = callbackSignal;
        context = callbackContext;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      { priority: "normal" },
    );
    stopped.catch(() => undefined);
    await until(() => context !== undefined, "the callback to start");
    const reserved = context.reservation.reserved;
    const report = context.reportUsage({ input: context.reservation.input + 1, output: 0 });
    assert.equal(report.stopped, true);
    await assert.rejects(stopped, (error) => {
      assert.ok(error instanceof LLMAdmissionStoppedError);
      assert.equal(error.cause, "overrun");
      return true;
    });
    assert.equal(signal.aborted, true);

    const whileHeld = pool.stats();
    assert.equal(whileHeld.bulkhead.inFlight, 0);
    assert.equal(whileHeld.llm.inFlight, 1);
    assert.equal(whileHeld.tokenBudget.inFlightTokens, reserved + 1);
    assert.equal(whileHeld.tyr.restoration.upstreamCapacity.activeAccountingHolds, 1);

    // The slot is free, but the stopped request's tokens are not.
    await assert.rejects(
      pool.run(request, pool.prepare(request, "normal"), async () => "admitted", {
        priority: "normal",
      }),
      (error) => {
        assert.ok(error instanceof LLMBulkheadRejectedError);
        assert.equal(error.reason, "budget_limit");
        return true;
      },
    );
    const small = { ...request, max_tokens: 100 };
    assert.equal(
      await pool.run(small, pool.prepare(small, "normal"), async () => "admitted", {
        priority: "normal",
      }),
      "admitted",
    );

    finish("settled late");
    await delay(5);
    assert.equal(pool.stats().tokenBudget.inFlightTokens, 0);
    assert.equal(pool.stats().llm.inFlight, 0);
  }
  console.log("PASS a stop returns the slot at once and keeps the tokens charged until the call ends");

  // Shutdown, in the built server run as its own process from a file.
  const freePort = createServer();
  const port = Number(new URL(await listen(freePort)).port);
  freePort.close();
  await once(freePort, "close");
  const processUrl = `http://127.0.0.1:${port}`;
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
      "shutdown:",
      "  drainTimeoutMs: 150",
      "  stopOnDrainTimeout: true",
      "pools:",
      "  - name: primary",
      "    modelPrefixes: [gpt]",
      "    estimatorModel: gpt-4o",
      "    maxConcurrent: 2",
      "    limitsRevision: 7",
      "    inFlightTokenBudget: 10000",
      "    stop:",
      "      overrunAllowanceTokens: 2000",
      "      takeBackGraceMs: 5000",
      "",
    ].join("\n"),
  );

  calls.length = 0;
  const child = spawn(process.execPath, [join(repoRoot, "dist", "index.js")], {
    // A minimal environment: file mode refuses to start next to legacy
    // variables such as PORT.
    env: { PATH: process.env.PATH ?? "", TYR_CONFIG_FILE: configPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    await until(() => /listening on/.test(output), "Tyr to start listening", 10_000);

    // The file's stop block reached the pool at the configured revision.
    const stats = (await (await fetch(`${processUrl}/stats`)).json()).primary;
    assert.equal(stats.limits.revision, 7);
    assert.deepEqual(stats.limits.stop, {
      overrunAllowanceTokens: 2000,
      takeBackGraceMs: 5000,
    });

    const waiting = chat(processUrl, "hold through shutdown");
    await until(() => calls.length === 1, "the provider call");
    const signaledAt = Date.now();
    child.kill("SIGTERM");

    const response = await waiting;
    assert.ok(Date.now() - signaledAt >= 140, "stopped before the drain deadline");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-admission-stop-cause"), "drain_deadline");
    assert.equal(response.headers.get("connection"), "close");
    assert.equal((await response.json()).error.type, "admission_stopped");
    await until(() => calls[0].dropped, "the provider call to be dropped");

    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);
    assert.match(output, /shutdown drain deadline reached inFlight=1 pending=0 stopped=1/);
    assert.match(output, /shutdown complete/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  console.log("PASS a shutdown stops what outlives its drain deadline, answers 503 and exits 0");

  console.log(
    "Stop verification passed: unchanged when off, overrun, closing usage, take-back, a stream with no byte sent, the token hold after a stop, and a stopping shutdown in the built server.",
  );
} finally {
  provider.closeAllConnections();
  provider.close();
  rmSync(workDir, { recursive: true, force: true });
}
