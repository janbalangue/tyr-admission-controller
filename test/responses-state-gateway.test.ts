import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, type GatewayOptions } from "../src/server.js";
import type { TyrIdentityOptions } from "../src/identity.js";
import type { PoolConfig, TyrPoolStats } from "../src/pools.js";
import type { ResponsesStateOptions } from "../src/responses-state.js";
import type { TyrAdmissionAuditEvent } from "../src/telemetry.js";

const SECRET = "test-routing-secret-32-characters";

// With the pool below and adaptive estimation off, this request reserves 111
// tokens: 11 estimated input tokens plus the 100-token output limit. The
// provider reports 20 input and 30 output tokens, so its record is 50.
const REQUEST = { model: "gpt-4o", input: "hello", max_output_tokens: 100 };
const RESERVED = 111;
const RECORDED = 50;

type Provider = {
  server: Server;
  url: string;
  /** Request bodies the provider received, in order. */
  seen: Record<string, unknown>[];
};

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/**
 * Stand-in for the OpenAI Responses API. `metadata.mode` selects a behavior
 * without changing the request's token estimate:
 * - "no-usage": a reply without usage
 * - "error": HTTP 500
 * - "failed-status": HTTP 200 with status "failed" and usage
 * - "linger": a stream that stays open after its final event
 * - "early-usage": a stream that reports usage on its first event, without a
 *   status, and then breaks off
 */
function startProvider(): Promise<Provider> {
  const seen: Record<string, unknown>[] = [];
  let created = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      seen.push(body);
      const metadata = body["metadata"] as { mode?: string } | undefined;
      const mode = metadata?.mode;
      if (mode === "error") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "provider failed" } }));
        return;
      }
      created += 1;
      const id = `resp_${created}`;
      const usage =
        mode === "no-usage"
          ? undefined
          : { input_tokens: 20, output_tokens: 30, total_tokens: 50 };
      if (body["stream"] === true && mode === "early-usage") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          sse("response.created", {
            response: { id, usage: { input_tokens: 5, output_tokens: 0 } },
          }),
        );
        setTimeout(() => res.destroy(), 20);
        return;
      }
      if (body["stream"] === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          sse("response.created", {
            response: { id, status: "in_progress", usage: null },
          }),
        );
        res.write(sse("response.output_text.delta", { delta: "hi" }));
        res.write(
          sse("response.completed", {
            response: { id, status: "completed", ...(usage ? { usage } : {}) },
          }),
        );
        setTimeout(() => res.end(), mode === "linger" ? 400 : 5);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          object: "response",
          status: mode === "failed-status" ? "failed" : "completed",
          output: [],
          ...(usage ? { usage } : {}),
        }),
      );
    });
  });
  return listen(server).then((url) => ({ server, url, seen }));
}

type Gateway = {
  url: string;
  server: Server;
  shutdown: () => Promise<unknown>;
};

type Reply = {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
};

let provider: Provider;
let dir: string;
let file: string;
let gateways: Gateway[];

beforeAll(async () => {
  provider = await startProvider();
});

afterAll(() => {
  provider.server.close();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tyr-responses-gateway-"));
  file = join(dir, "state.jsonl");
  gateways = [];
  provider.seen.length = 0;
});

afterEach(async () => {
  await Promise.all(gateways.map((gateway) => gateway.shutdown()));
  rmSync(dir, { recursive: true, force: true });
});

async function start(
  options: {
    /** `false` starts a gateway without response memory. */
    responsesState?: Partial<ResponsesStateOptions> | false;
    pool?: Partial<PoolConfig>;
    gateway?: Partial<GatewayOptions>;
  } = {},
): Promise<Gateway> {
  const created = createGateway({
    openaiUpstreamUrl: provider.url,
    ...(options.responsesState === false
      ? {}
      : {
          responsesState: {
            file,
            maxEntries: 100,
            ttlMs: 60_000,
            ...options.responsesState,
          },
        }),
    pools: [
      {
        name: "openai",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 4,
        budget: 5_000,
        adaptiveEstimation: { enabled: false },
        ...options.pool,
      },
    ],
    ...options.gateway,
  });
  const url = await listen(created.server);
  const gateway = { url, server: created.server, shutdown: created.shutdown };
  gateways.push(gateway);
  return gateway;
}

async function post(
  gateway: Gateway,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const response = await fetch(`${gateway.url}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { text };
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

function followUp(id: unknown, extra: Record<string, unknown> = {}) {
  return { ...REQUEST, previous_response_id: id, ...extra };
}

async function stats(gateway: Gateway): Promise<TyrPoolStats> {
  const all = (await (await fetch(`${gateway.url}/stats`)).json()) as Record<
    string,
    TyrPoolStats
  >;
  return all["openai"]!;
}

/** The response id carried by the lifecycle events of a streamed reply. */
function streamedId(text: string): string {
  const match = /"id":"(resp_\d+)"/.exec(text);
  if (match?.[1] === undefined) throw new Error("stream carried no response id");
  return match[1];
}

function errorType(reply: Reply): unknown {
  return (reply.body["error"] as { type?: unknown } | undefined)?.type;
}

describe("response memory is off unless configured", () => {
  it("keeps rejecting previous_response_id and exposes nothing new", async () => {
    const gateway = await start({ responsesState: false });
    const first = await post(gateway, REQUEST);
    expect(first.status).toBe(200);

    const rejected = await post(gateway, followUp(first.body["id"]));
    expect(rejected.status).toBe(400);
    expect(errorType(rejected)).toBe("invalid_request");
    expect(provider.seen).toHaveLength(1);

    expect((await stats(gateway)).tyr).not.toHaveProperty("responsesState");
    const metrics = await (await fetch(`${gateway.url}/metrics`)).text();
    expect(metrics).not.toContain("tyr_pool_responses_state_");
  });

  it("needs the OpenAI upstream that serves the Responses route", () => {
    expect(() =>
      createGateway({
        upstreamUrl: provider.url,
        responsesState: { file },
        pools: [
          { name: "claude", modelPrefixes: ["claude"], model: "claude-sonnet-4", maxConcurrent: 1 },
        ],
      }),
    ).toThrow("responsesState requires openaiUpstreamUrl");
  });
});

describe("follow-ups with response memory", () => {
  it("reserves the follow-up's own estimate plus the recorded size", async () => {
    const gateway = await start();
    const first = await post(gateway, REQUEST);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-admission-reserved-tokens")).toBe(String(RESERVED));
    expect(first.headers.get("x-admission-prior-tokens")).toBeNull();

    const second = await post(gateway, followUp(first.body["id"]));
    expect(second.status).toBe(200);
    expect(second.headers.get("x-admission-reserved-tokens")).toBe(
      String(RESERVED + RECORDED),
    );
    expect(second.headers.get("x-admission-prior-tokens")).toBe(String(RECORDED));
    // The provider receives the follow-up as the client sent it.
    expect(provider.seen[1]).toEqual(followUp(first.body["id"]));

    const snapshot = await stats(gateway);
    expect(snapshot.tyr.responsesState).toEqual({
      records: 2,
      recorded: 2,
      evicted: 0,
      expired: 0,
      followUps: 1,
      priorTokens: RECORDED,
      refused: 0,
      persistFailures: 0,
    });
    expect(snapshot.tokenBudget).toMatchObject({
      inFlightTokens: 0,
      totalReserved: RESERVED + RESERVED + RECORDED,
    });

    const metrics = await (await fetch(`${gateway.url}/metrics`)).text();
    expect(metrics).toContain('tyr_pool_responses_state_records{pool="openai"} 2');
    expect(metrics).toContain(
      `tyr_pool_responses_state_prior_tokens_total{pool="openai"} ${RECORDED}`,
    );
  });

  it("refuses a follow-up to a response it has no record of without calling the provider", async () => {
    const events: TyrAdmissionAuditEvent[] = [];
    const gateway = await start({
      gateway: {
        telemetry: { auditEnabled: true, auditSink: (event) => events.push(event) },
      },
    });

    const refused = await post(gateway, followUp("resp_none"));
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({
      error: {
        type: "unknown_previous_response",
        message:
          "Tyr has no usable record of the response named by previous_response_id, so it cannot reserve the earlier tokens",
        pool: "openai",
      },
    });
    expect(refused.headers.get("x-admission-reason")).toBe(
      "unknown_previous_response",
    );
    expect(refused.headers.get("x-admission-mode")).toBe("enforce");
    expect(refused.headers.get("retry-after")).toBeNull();
    expect(provider.seen).toHaveLength(0);

    const snapshot = await stats(gateway);
    expect(snapshot.tyr.responsesState).toMatchObject({ refused: 1, followUps: 0 });
    // The pool never saw the request.
    expect(snapshot.llm.rejected).toBe(0);
    expect(snapshot.tokenBudget?.totalReserved).toBe(0);

    const metrics = await (await fetch(`${gateway.url}/metrics`)).text();
    expect(metrics).toContain(
      'tyr_admission_rejections_total{admission_class="none",pool="openai",priority="normal",reason="unknown_previous_response"} 1',
    );
    expect(metrics).toContain('tyr_pool_responses_state_refused_total{pool="openai"} 1');
    expect(metrics).toContain(
      'tyr_requests_total{outcome="admission_rejected",pool="openai",provider="openai"} 1',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "rejected",
      settlement: "rejected",
      reason: "unknown_previous_response",
      pool: "openai",
      model: "gpt-4o",
    });
  });

  it("does not shadow the refusal in observe mode", async () => {
    const gateway = await start({ pool: { admissionMode: "observe" } });

    const refused = await post(gateway, followUp("resp_none"));
    expect(refused.status).toBe(422);
    expect(refused.headers.get("x-admission-mode")).toBe("observe");
    expect(provider.seen).toHaveLength(0);
  });

  it("records nothing for a reply that was not stored, carried no usage, or failed", async () => {
    const gateway = await start();
    const notStored = await post(gateway, { ...REQUEST, store: false });
    const noUsage = await post(gateway, { ...REQUEST, metadata: { mode: "no-usage" } });
    const failed = await post(gateway, { ...REQUEST, metadata: { mode: "error" } });
    expect(notStored.status).toBe(200);
    expect(noUsage.status).toBe(200);
    expect(failed.status).toBe(500);
    expect((await stats(gateway)).tyr.responsesState?.records).toBe(0);

    for (const id of [notStored.body["id"], noUsage.body["id"]]) {
      const refused = await post(gateway, followUp(id));
      expect(refused.status).toBe(422);
      expect(errorType(refused)).toBe("unknown_previous_response");
    }
    expect(provider.seen).toHaveLength(3);
  });

  it("records a 200 reply whose response failed, because the provider still holds it", async () => {
    const gateway = await start();
    const failed = await post(gateway, {
      ...REQUEST,
      metadata: { mode: "failed-status" },
    });
    expect(failed.status).toBe(200);
    expect(failed.body["status"]).toBe("failed");

    const second = await post(gateway, followUp(failed.body["id"]));
    expect(second.status).toBe(200);
    expect(second.headers.get("x-admission-prior-tokens")).toBe(String(RECORDED));
  });

  it("admits a follow-up that is itself not stored, without recording its reply", async () => {
    const gateway = await start();
    const first = await post(gateway, REQUEST);

    const second = await post(gateway, followUp(first.body["id"], { store: false }));
    expect(second.status).toBe(200);
    expect(second.headers.get("x-admission-prior-tokens")).toBe(String(RECORDED));
    expect((await stats(gateway)).tyr.responsesState?.records).toBe(1);
  });

  it("treats a null previous_response_id as no previous response", async () => {
    const gateway = await start();

    const reply = await post(gateway, followUp(null));
    expect(reply.status).toBe(200);
    expect(reply.headers.get("x-admission-reserved-tokens")).toBe(String(RESERVED));
    expect(reply.headers.get("x-admission-prior-tokens")).toBeNull();
  });

  it("rejects a previous_response_id that is not a string", async () => {
    const gateway = await start();

    for (const id of [7, "", { id: "resp_1" }]) {
      const reply = await post(gateway, followUp(id));
      expect(reply.status).toBe(400);
      expect(errorType(reply)).toBe("invalid_request");
    }
    expect(provider.seen).toHaveLength(0);
  });

  it("still rejects conversation and background requests", async () => {
    const gateway = await start();

    for (const extra of [{ conversation: "conv_1" }, { background: true }]) {
      const reply = await post(gateway, { ...REQUEST, ...extra });
      expect(reply.status).toBe(400);
      expect(errorType(reply)).toBe("invalid_request");
    }
  });

  it("keeps the earlier tokens visible when the pool has no room for them", async () => {
    const events: TyrAdmissionAuditEvent[] = [];
    const gateway = await start({
      pool: { budget: 150 },
      gateway: {
        telemetry: { auditEnabled: true, auditSink: (event) => events.push(event) },
      },
    });
    const first = await post(gateway, REQUEST);
    expect(first.status).toBe(200);

    // 111 + 50 exceeds the pool's 150-token budget.
    const rejected = await post(gateway, followUp(first.body["id"]));
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("x-admission-reason")).toBe("budget_limit");
    expect(rejected.headers.get("x-admission-reserved-tokens")).toBe(
      String(RESERVED + RECORDED),
    );
    expect(rejected.headers.get("x-admission-prior-tokens")).toBe(String(RECORDED));
    expect(provider.seen).toHaveLength(1);
    expect((await stats(gateway)).tyr.responsesState).toMatchObject({
      followUps: 1,
      refused: 0,
    });
    expect(events.at(-1)).toMatchObject({
      outcome: "rejected",
      reason: "budget_limit",
      reservedTokens: RESERVED + RECORDED,
      priorTokens: RECORDED,
    });
    expect(events[0]).not.toHaveProperty("priorTokens");
  });

  it("puts the earlier tokens in the audit event of an admitted follow-up", async () => {
    const events: TyrAdmissionAuditEvent[] = [];
    const gateway = await start({
      gateway: {
        telemetry: { auditEnabled: true, auditSink: (event) => events.push(event) },
      },
    });
    const first = await post(gateway, REQUEST);
    await post(gateway, followUp(first.body["id"]));

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      outcome: "admitted",
      settlement: "completed",
      reservedTokens: RESERVED + RECORDED,
      priorTokens: RECORDED,
    });
  });
});

describe("streamed replies", () => {
  it("records a streamed reply from its final event", async () => {
    const gateway = await start();
    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...REQUEST, stream: true }),
    });
    const text = await response.text();
    expect(text).toContain("response.completed");

    const second = await post(gateway, followUp(streamedId(text)));
    expect(second.status).toBe(200);
    expect(second.headers.get("x-admission-reserved-tokens")).toBe(
      String(RESERVED + RECORDED),
    );
    expect((await stats(gateway)).tyr.responsesState).toMatchObject({
      records: 2,
      recorded: 2,
    });
  });

  it("does not record usage from an event that is not final", async () => {
    const gateway = await start();
    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...REQUEST,
        stream: true,
        metadata: { mode: "early-usage" },
      }),
    });
    let text = "";
    try {
      text = await response.text();
    } catch {
      // The provider broke the stream off; what arrived is not available.
    }
    const id = /"id":"(resp_\d+)"/.exec(text)?.[1];

    // The 5 tokens on the first event are not the size of a finished
    // response. Recording them would under-reserve the follow-up.
    expect((await stats(gateway)).tyr.responsesState).toMatchObject({
      records: 0,
      recorded: 0,
    });
    if (id !== undefined) {
      const refused = await post(gateway, followUp(id));
      expect(refused.status).toBe(422);
    }
  });

  it("has the record in place before the stream ends", async () => {
    const gateway = await start();
    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...REQUEST, stream: true, metadata: { mode: "linger" } }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("response.completed")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain("response.completed");

    // The provider keeps the stream open for another 400 ms. A client that
    // sends its follow-up as soon as it sees the final event is still served.
    const id = streamedId(text);
    const second = await post(gateway, followUp(id));
    expect(second.status).toBe(200);
    expect(second.headers.get("x-admission-prior-tokens")).toBe(String(RECORDED));
    expect(readFileSync(file, "utf8")).toContain(`"id":"${id}"`);

    let ended = false;
    while (!ended) ended = (await reader.read()).done;
  });
});

describe("bounds and restarts", () => {
  it("writes the record before the reply ends", async () => {
    const gateway = await start();
    const first = await post(gateway, REQUEST);

    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({
      id: first.body["id"],
      pool: "openai",
      tokens: RECORDED,
    });
  });

  it("drops the oldest record beyond maxEntries", async () => {
    const gateway = await start({ responsesState: { maxEntries: 2 } });
    const first = await post(gateway, REQUEST);
    await post(gateway, REQUEST);
    const third = await post(gateway, REQUEST);

    expect((await post(gateway, followUp(first.body["id"]))).status).toBe(422);
    expect((await post(gateway, followUp(third.body["id"]))).status).toBe(200);
    expect((await stats(gateway)).tyr.responsesState).toMatchObject({
      records: 2,
      evicted: 2,
    });
  });

  it("refuses a follow-up to a record older than ttlMs", async () => {
    const gateway = await start({ responsesState: { ttlMs: 150 } });
    const first = await post(gateway, REQUEST);

    // The exact boundary is covered with a fake clock in the store tests.
    // Here only the expired side is asserted, so a slow machine cannot fail it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await post(gateway, followUp(first.body["id"]))).status).toBe(422);
    expect((await stats(gateway)).tyr.responsesState).toMatchObject({
      records: 0,
      expired: 1,
    });
  });

  it("admits a follow-up after a restart that skipped shutdown", async () => {
    const before = await start();
    const first = await post(before, REQUEST);
    // `before` is never shut down here, as if its process had been killed.

    const after = await start();
    const second = await post(after, followUp(first.body["id"]));
    expect(second.status).toBe(200);
    expect(second.headers.get("x-admission-reserved-tokens")).toBe(
      String(RESERVED + RECORDED),
    );
    expect((await stats(after)).tyr.responsesState).toMatchObject({
      records: 2,
      recorded: 1,
    });
  });

  it("fails to start on a file that is not its own, and leaves it alone", () => {
    writeFileSync(file, "some-other-credential\n");

    expect(() =>
      createGateway({
        openaiUpstreamUrl: provider.url,
        responsesState: { file },
        pools: [
          { name: "openai", modelPrefixes: ["gpt"], model: "gpt-4o", maxConcurrent: 1 },
        ],
      }),
    ).toThrow(/not a Tyr responses-state file/);
    expect(readFileSync(file, "utf8")).toBe("some-other-credential\n");
  });
});

describe("ownership", () => {
  const identity: TyrIdentityOptions = {
    authenticate: (req) => ({
      subject: String(req.headers["x-subject"] ?? "user-1"),
      tenantId: String(req.headers["x-tenant"]),
      applicationId: String(req.headers["x-app"]),
      roles: ["invoke"],
    }),
    invokeRoles: ["invoke"],
  };
  const caller = (tenant: string, app: string, subject = "user-1") => ({
    "x-tenant": tenant,
    "x-app": app,
    "x-subject": subject,
  });

  it("admits follow-ups only from the tenant and application that created the response", async () => {
    const gateway = await start({ gateway: { identity } });
    const first = await post(gateway, REQUEST, caller("t1", "a1"));
    expect(first.status).toBe(200);

    const sameOwner = await post(
      gateway,
      followUp(first.body["id"]),
      caller("t1", "a1", "user-2"),
    );
    expect(sameOwner.status).toBe(200);
    expect(sameOwner.headers.get("x-admission-reserved-tokens")).toBe(
      String(RESERVED + RECORDED),
    );

    const calls = provider.seen.length;
    const unknown = await post(gateway, followUp("resp_none"), caller("t1", "a1"));
    for (const headers of [caller("t2", "a1"), caller("t1", "a2")]) {
      const refused = await post(gateway, followUp(first.body["id"]), headers);
      // Another owner sees exactly what an unknown id produces.
      expect(refused.status).toBe(422);
      expect(refused.body).toEqual(unknown.body);
    }
    expect(provider.seen).toHaveLength(calls);
    expect((await stats(gateway)).tyr.responsesState).toMatchObject({
      followUps: 1,
      refused: 3,
    });
  });
});

describe("adaptive estimation", () => {
  it("adds the recorded size exactly and leaves follow-ups out of calibration", async () => {
    const gateway = await start({ pool: { adaptiveEstimation: { enabled: true } } });
    // Five samples switch the correction on. The provider reports 20 input
    // tokens against an 11-token estimate, so later estimates are scaled up.
    let last = await post(gateway, REQUEST);
    for (let index = 0; index < 6; index += 1) last = await post(gateway, REQUEST);
    const corrected = Number(last.headers.get("x-admission-reserved-tokens"));
    expect(corrected).toBeGreaterThan(RESERVED);
    const before = (await stats(gateway)).tyr.adaptiveEstimation.corrections;
    expect(before).toHaveLength(1);

    const second = await post(gateway, followUp(last.body["id"]));
    expect(second.status).toBe(200);
    // The 50 recorded tokens are added as they are, not multiplied by the
    // correction factor that applies to the estimate.
    expect(Number(second.headers.get("x-admission-reserved-tokens"))).toBe(
      corrected + RECORDED,
    );

    const after = (await stats(gateway)).tyr.adaptiveEstimation.corrections;
    expect(after).toEqual(before);
  });
});

describe("capacity routing", () => {
  it("admits record-bound requests on the replica that received them", async () => {
    const routing = {
      sharedSecret: SECRET,
      pollIntervalMs: 20,
      staleAfterMs: 500,
      probeTimeoutMs: 200,
      forwardTimeoutMs: 2_000,
    };
    // The peer has far more headroom, so capacity routing prefers it. It has
    // no response memory, like a replica that was not upgraded or configured.
    const peer = await start({
      responsesState: false,
      pool: { maxConcurrent: 8, budget: 50_000 },
      gateway: {
        capacityRouting: { ...routing, instanceId: "tyr-b", peers: [] },
      },
    });
    const ingress = await start({
      pool: { maxConcurrent: 1, budget: 1_500 },
      gateway: {
        capacityRouting: {
          ...routing,
          instanceId: "tyr-a",
          peers: [{ id: "tyr-b", baseUrl: peer.url }],
        },
      },
    });

    // A reply that will not be recorded is still routed by capacity.
    let routedTo: string | null = null;
    const deadline = Date.now() + 3_000;
    while (routedTo === null && Date.now() < deadline) {
      const reply = await post(ingress, { ...REQUEST, store: false });
      expect(reply.status).toBe(200);
      routedTo = reply.headers.get("x-tyr-routed-to");
      if (routedTo === null) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(routedTo).toBe("tyr-b");

    // A reply that will be recorded is admitted where it arrived.
    const first = await post(ingress, REQUEST);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-tyr-routed-to")).toBeNull();

    // So is the follow-up, which finds the record on the same replica.
    const second = await post(ingress, followUp(first.body["id"]));
    expect(second.status).toBe(200);
    expect(second.headers.get("x-tyr-routed-to")).toBeNull();
    expect(second.headers.get("x-admission-prior-tokens")).toBe(String(RECORDED));

    // Even a follow-up that will not be recorded stays with its record.
    const third = await post(ingress, followUp(first.body["id"], { store: false }));
    expect(third.status).toBe(200);
    expect(third.headers.get("x-tyr-routed-to")).toBeNull();
  });
});
