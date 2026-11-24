import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LatchfloTyrAgent } from "../src/latchflo.js";
import type { PoolConfig } from "../src/pools.js";
import { createGateway, type GatewayOptions } from "../src/server.js";
import type { TyrAdmissionAuditEvent } from "../src/telemetry.js";

const openServers: Server[] = [];
const tempDirectories: string[] = [];

async function listen(server: Server): Promise<string> {
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("condition was not met before timeout"));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

type UpstreamCall = {
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly res: ServerResponse;
  /** The gateway closed the connection before the reply was finished. */
  aborted: boolean;
};

/**
 * A provider that answers only when the test says so. Each call is kept so a
 * test can reply to it, stream on it, or check that the gateway dropped it.
 */
async function startUpstream(
  onCall?: (call: UpstreamCall) => void,
): Promise<{ url: string; calls: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const call: UpstreamCall = {
        path: new URL(req.url ?? "/", "http://upstream").pathname,
        body: JSON.parse(Buffer.concat(chunks).toString()) as Record<
          string,
          unknown
        >,
        res,
        aborted: false,
      };
      res.on("close", () => {
        if (!res.writableFinished) call.aborted = true;
      });
      calls.push(call);
      onCall?.(call);
    });
  });
  return { url: await listen(server), calls };
}

function replyChat(call: UpstreamCall): void {
  call.res.writeHead(200, { "content-type": "application/json" });
  call.res.end(
    JSON.stringify({
      id: "chatcmpl-test",
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 6 },
    }),
  );
}

function sse(call: UpstreamCall, event: string, data: unknown): void {
  call.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function pool(overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    name: "primary",
    modelPrefixes: ["gpt", "claude"],
    model: "gpt-4o",
    maxConcurrent: 2,
    budget: 10_000,
    adaptiveEstimation: { enabled: false },
    ...overrides,
  };
}

function limits(revision: number, maxConcurrent: number) {
  return {
    revision,
    maxConcurrent,
    maxQueue: 0,
    tokenBudget: { budget: 10_000, highPriorityReserve: 0 },
  };
}

async function startGateway(options: Omit<GatewayOptions, "telemetry">) {
  const audits: TyrAdmissionAuditEvent[] = [];
  const gateway = createGateway({
    ...options,
    telemetry: {
      metricsEnabled: true,
      auditEnabled: true,
      auditSink: (event) => audits.push(event),
    },
  });
  return { gateway, url: await listen(gateway.server), audits };
}

function chat(url: string, content: string): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content }],
      max_tokens: 100,
    }),
  });
}

/** Reads a streamed body until it ends or the connection is cut. */
async function readStream(
  response: Response,
): Promise<{ text: string; cut: boolean }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text, cut: false };
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return { text, cut: true };
  }
}

describe("a request stopped for overrunning", () => {
  it("has its stream cut and its upstream call dropped", async () => {
    const upstream = await startUpstream((call) => {
      call.res.writeHead(200, { "content-type": "text/event-stream" });
      sse(call, "message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 1 } },
      });
      sse(call, "message_delta", {
        type: "message_delta",
        usage: { output_tokens: 40 },
      });
      // Far past the 100 output tokens the request reserved.
      setTimeout(() => {
        sse(call, "message_delta", {
          type: "message_delta",
          usage: { output_tokens: 5_000 },
        });
      }, 20);
      // A provider that ignores the limit would go on to finish normally.
      setTimeout(() => {
        if (call.res.destroyed) return;
        sse(call, "message_stop", { type: "message_stop" });
        call.res.end();
      }, 400);
    });
    const { gateway, url, audits } = await startGateway({
      upstreamUrl: upstream.url,
      pools: [
        pool({
          stop: { overrunAllowanceTokens: 50 },
          progressiveReconciliation: { enabled: false },
        }),
      ],
    });

    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "write without end" }],
      }),
    });
    expect(response.status).toBe(200);
    const admissionId = response.headers.get("x-admission-id");
    expect(admissionId).toBeTruthy();

    const body = await readStream(response);

    expect(body.cut).toBe(true);
    expect(body.text).not.toContain("message_stop");
    await waitFor(() => upstream.calls[0]?.aborted === true);
    await waitFor(() => audits.length === 1);
    expect(audits[0]).toMatchObject({
      outcome: "admitted",
      settlement: "stopped",
      stopCause: "overrun",
      admissionId,
      usage: { input: 1, output: 5_000 },
    });

    // The tokens came back once the dropped upstream call settled.
    await waitFor(
      () => gateway.control.stats().primary?.tokenBudget?.inFlightTokens === 0,
    );
    expect(gateway.control.stats().primary).toMatchObject({
      bulkhead: { inFlight: 0 },
      llm: { inFlight: 0, stopped: 1, stoppedByCause: { overrun: 1 } },
      tyr: {
        stop: {
          policy: { overrunAllowanceTokens: 50 },
          stopped: 1,
          stoppedByCause: { overrun: 1, limits: 0, drain_deadline: 0 },
        },
      },
    });

    const metrics = await (await fetch(`${url}/metrics`)).text();
    expect(metrics).toContain(
      'tyr_requests_total{outcome="stopped",pool="primary",provider="anthropic"} 1',
    );
    expect(metrics).toContain(
      'tyr_pool_stopped_total{cause="overrun",pool="primary"} 1',
    );
    expect(metrics).toContain(
      'tyr_upstream_duration_seconds_count{outcome="stopped",pool="primary",provider="anthropic"} 1',
    );
    // A stop is not an upstream failure and not an admission rejection.
    expect(metrics).not.toMatch(/tyr_upstream_failures_total\{/);
    expect(metrics).not.toMatch(/tyr_admission_rejections_total\{/);
  });

  it("gets 503 when the first chunk of its stream reports the overrun", async () => {
    const upstream = await startUpstream((call) => {
      call.res.writeHead(200, { "content-type": "text/event-stream" });
      // Far more input than Tyr estimated for a three-word prompt.
      sse(call, "message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 400 } },
      });
      setTimeout(() => {
        if (call.res.destroyed) return;
        sse(call, "message_stop", { type: "message_stop" });
        call.res.end();
      }, 300);
    });
    const { url, audits } = await startGateway({
      upstreamUrl: upstream.url,
      pools: [
        pool({
          stop: { overrunAllowanceTokens: 50 },
          progressiveReconciliation: { enabled: false },
        }),
      ],
    });

    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "three word prompt" }],
      }),
    });

    // Nothing of the reply had been written, so the stop has a status.
    expect(response.status).toBe(503);
    expect(response.headers.get("x-admission-stop-cause")).toBe("overrun");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({
      error: { type: "admission_stopped", cause: "overrun" },
    });
    await waitFor(() => upstream.calls[0]?.aborted === true);
    expect(audits[0]).toMatchObject({
      settlement: "stopped",
      stopCause: "overrun",
      usage: { input: 400, output: 0 },
    });
  });

  it("is not stopped by the usage its provider sends as the reply ends", async () => {
    // Each provider's closing usage reports 9,000 output tokens against a
    // 100-token reservation. By then the provider has finished the reply.
    const upstream = await startUpstream((call) => {
      call.res.writeHead(200, { "content-type": "text/event-stream" });
      const data = (value: unknown): void => {
        call.res.write(`data: ${JSON.stringify(value)}\n\n`);
      };
      if (call.path === "/v1/chat/completions") {
        data({ choices: [{ delta: { content: "the whole answer" } }], usage: null });
        data({ choices: [{ delta: {}, finish_reason: "stop" }], usage: null });
        data({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 9_000 } });
        call.res.write("data: [DONE]\n\n");
      } else if (call.path === "/v1/responses") {
        sse(call, "response.created", {
          type: "response.created",
          response: { id: "resp_done", status: "in_progress", usage: null },
        });
        sse(call, "response.completed", {
          type: "response.completed",
          response: {
            id: "resp_done",
            status: "completed",
            usage: { input_tokens: 5, output_tokens: 9_000 },
          },
        });
      } else {
        sse(call, "message_start", {
          type: "message_start",
          message: { usage: { input_tokens: 5 } },
        });
        sse(call, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 9_000 },
        });
        sse(call, "message_stop", { type: "message_stop" });
      }
      call.res.end();
    });
    const { gateway, url, audits } = await startGateway({
      upstreamUrl: upstream.url,
      openaiUpstreamUrl: upstream.url,
      pools: [pool({ stop: { overrunAllowanceTokens: 50 } })],
    });
    const stream = (path: string, body: object): Promise<Response> =>
      fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, stream: true }),
      });

    const chatReply = await readStream(
      await stream("/v1/chat/completions", {
        model: "gpt-4o",
        max_tokens: 100,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    const responsesReply = await readStream(
      await stream("/v1/responses", {
        model: "gpt-4o",
        input: "hello",
        max_output_tokens: 100,
      }),
    );
    const messagesReply = await readStream(
      await stream("/v1/messages", {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(chatReply).toMatchObject({ cut: false });
    expect(chatReply.text).toContain("data: [DONE]");
    expect(responsesReply).toMatchObject({ cut: false });
    expect(responsesReply.text).toContain("response.completed");
    expect(messagesReply).toMatchObject({ cut: false });
    expect(messagesReply.text).toContain("message_stop");

    await waitFor(() => audits.length === 3);
    for (const audit of audits) {
      // The closing usage still settles the request's accounting.
      expect(audit).toMatchObject({
        settlement: "completed",
        usage: { input: 5, output: 9_000 },
      });
    }
    expect(gateway.control.stats().primary).toMatchObject({
      tokenBudget: { inFlightTokens: 0, totalConsumed: 3 * 9_005 },
      tyr: { stop: { stopped: 0 } },
    });
  });

  it("reports a provider's closing usage mid-stream only on a pool that cannot stop for it", async () => {
    const upstream = await startUpstream((call) => {
      call.res.writeHead(200, { "content-type": "text/event-stream" });
      call.res.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 30 } })}\n\n`,
      );
      call.res.end("data: [DONE]\n\n");
    });
    const reports = async (stop?: PoolConfig["stop"]): Promise<number> => {
      const { gateway, url } = await startGateway({
        openaiUpstreamUrl: upstream.url,
        pools: [pool(stop === undefined ? {} : { stop })],
      });
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 100,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(await readStream(response)).toMatchObject({ cut: false });
      await waitFor(
        () => gateway.control.stats().primary?.llm.released === 1,
      );
      const stats = gateway.control.stats().primary!;
      expect(stats.tokenBudget?.totalConsumed).toBe(35);
      return stats.tyr.progressiveReconciliation.reports;
    };

    // As in 0.34.1 without a stop policy, and with one that has no allowance.
    expect(await reports()).toBe(1);
    expect(await reports({ takeBackGraceMs: 1_000 })).toBe(1);
    // With an allowance the closing usage is applied at completion instead.
    expect(await reports({ overrunAllowanceTokens: 50 })).toBe(0);
  });

  it("gives its slot to a queued request, which is admitted only if its tokens fit", async () => {
    // One slot, one waiter. The running stream overruns and is stopped.
    const run = async (budget: number): Promise<number> => {
      const upstream = await startUpstream((call) => {
        if (call.body["stream"] !== true) {
          replyChat(call);
          return;
        }
        call.res.writeHead(200, { "content-type": "text/event-stream" });
        sse(call, "message_start", {
          type: "message_start",
          message: { usage: { input_tokens: 1 } },
        });
      });
      const { gateway, url } = await startGateway({
        upstreamUrl: upstream.url,
        openaiUpstreamUrl: upstream.url,
        pools: [
          pool({
            maxConcurrent: 1,
            maxQueue: 1,
            queueTimeoutMs: 2_000,
            budget,
            stop: { overrunAllowanceTokens: 50 },
            progressiveReconciliation: { enabled: false },
          }),
        ],
      });
      const running = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          stream: true,
          messages: [{ role: "user", content: "holds the slot" }],
        }),
      });
      const runningBody = readStream(running);
      await waitFor(() => upstream.calls.length === 1);
      const queued = chat(url, "waits for the slot");
      await waitFor(
        () => gateway.control.stats().primary?.bulkhead.pending === 1,
      );

      sse(upstream.calls[0]!, "message_delta", {
        type: "message_delta",
        usage: { output_tokens: 400 },
      });

      expect(await runningBody).toMatchObject({ cut: true });
      return (await queued).status;
    };

    // Room for both: the waiter takes the slot the stop returned.
    expect(await run(10_000)).toBe(200);
    // The stopped request's tokens are still charged when the waiter is
    // checked, and beside them its reservation does not fit.
    expect(await run(450)).toBe(429);
  });

  it("is left running when its usage stays within the allowance", async () => {
    const upstream = await startUpstream((call) => {
      call.res.writeHead(200, { "content-type": "text/event-stream" });
      sse(call, "message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 1 } },
      });
      sse(call, "message_delta", {
        type: "message_delta",
        usage: { output_tokens: 140 },
      });
      sse(call, "message_stop", { type: "message_stop" });
      call.res.end();
    });
    const { gateway, url, audits } = await startGateway({
      upstreamUrl: upstream.url,
      pools: [
        pool({
          stop: { overrunAllowanceTokens: 50 },
          progressiveReconciliation: { enabled: false },
        }),
      ],
    });

    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "a little over" }],
      }),
    });
    const body = await readStream(response);

    expect(body).toMatchObject({ cut: false });
    expect(body.text).toContain("message_stop");
    await waitFor(() => audits.length === 1);
    expect(audits[0]).toMatchObject({ settlement: "completed" });
    expect(audits[0]).not.toHaveProperty("stopCause");
    expect(gateway.control.stats().primary?.tyr.stop).toMatchObject({
      stopped: 0,
    });
  });
});

describe("a request stopped after its pool's limits were lowered", () => {
  it("gets 503 admission_stopped when its reply has not started", async () => {
    const upstream = await startUpstream();
    const { gateway, url, audits } = await startGateway({
      openaiUpstreamUrl: upstream.url,
      pools: [pool({ initialRevision: 100, stop: { takeBackGraceMs: 30 } })],
    });

    const older = chat(url, "admitted first");
    await waitFor(() => upstream.calls.length === 1);
    const newer = chat(url, "admitted second");
    await waitFor(() => upstream.calls.length === 2);

    const loweredAt = Date.now();
    expect(
      gateway.control.applyLimits([{ pool: "primary", limits: limits(101, 1) }]),
    ).toMatchObject({ applied: true });

    const response = await newer;
    expect(Date.now() - loweredAt).toBeGreaterThanOrEqual(25);
    expect(response.status).toBe(503);
    expect(response.headers.get("x-admission-reason")).toBe("stopped");
    expect(response.headers.get("x-admission-stop-cause")).toBe("limits");
    expect(response.headers.get("x-admission-outcome")).toBe("admitted");
    // Admitted under revision 100; the update that took its slot was 101.
    expect(response.headers.get("x-admission-revision")).toBe("100");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.headers.get("x-admission-retry-after-ms")).toBeNull();
    const admissionId = response.headers.get("x-admission-id");
    expect(await response.json()).toEqual({
      error: {
        type: "admission_stopped",
        cause: "limits",
        message:
          "Tyr stopped this admitted request because its pool's limits were lowered and the grace period for running work ended",
        pool: "primary",
        localSlotReleased: true,
        upstreamCancellation: "requested",
        upstreamReclamation: "unverified",
        resources: { borrowedConcurrency: false, borrowedTokens: 0 },
      },
    });

    // The upstream call of the stopped request was dropped; the other was not.
    await waitFor(() => upstream.calls[1]?.aborted === true);
    expect(upstream.calls[0]?.aborted).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      settlement: "stopped",
      stopCause: "limits",
      admissionId,
      limitRevision: 100,
    });

    // The request that fits the new limit finishes as usual.
    replyChat(upstream.calls[0]!);
    expect((await older).status).toBe(200);
    await waitFor(() => audits.length === 2);
    expect(audits[1]).toMatchObject({ settlement: "completed" });
    expect(gateway.control.stats().primary).toMatchObject({
      bulkhead: { inFlight: 0 },
      llm: { inFlight: 0, stopped: 1, stoppedByCause: { limits: 1 } },
      tokenBudget: { inFlightTokens: 0 },
    });
  });

  it("gets 503 when its stream has not sent a byte yet", async () => {
    // The provider has answered with headers, but no event has arrived.
    const upstream = await startUpstream((call) => {
      call.res.writeHead(200, { "content-type": "text/event-stream" });
      call.res.flushHeaders();
    });
    const { gateway, url } = await startGateway({
      openaiUpstreamUrl: upstream.url,
      pools: [pool({ stop: { takeBackGraceMs: 20 } })],
    });

    const streamed = fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "first token is slow" }],
      }),
    });
    await waitFor(() => upstream.calls.length === 1);
    // Long enough for the provider's headers to reach the gateway.
    await new Promise((resolve) => setTimeout(resolve, 40));
    gateway.control.applyLimits([{ pool: "primary", limits: limits(2, 0) }]);

    const response = await streamed;
    expect(response.status).toBe(503);
    expect(response.headers.get("x-admission-stop-cause")).toBe("limits");
    expect(await response.json()).toMatchObject({
      error: { type: "admission_stopped", cause: "limits" },
    });
    await waitFor(() => upstream.calls[0]?.aborted === true);
  });

  it("stops nothing on a pool without a stop policy", async () => {
    const upstream = await startUpstream();
    const { gateway, url } = await startGateway({
      openaiUpstreamUrl: upstream.url,
      pools: [pool()],
    });

    const running = chat(url, "keeps running");
    await waitFor(() => upstream.calls.length === 1);
    gateway.control.applyLimits([
      {
        pool: "primary",
        limits: { ...limits(1, 0), stop: { takeBackGraceMs: 0 } },
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(upstream.calls[0]?.aborted).toBe(false);
    replyChat(upstream.calls[0]!);
    expect((await running).status).toBe(200);
    expect(gateway.control.stats().primary?.tyr).not.toHaveProperty("stop");
    expect(await (await fetch(`${url}/metrics`)).text()).not.toContain(
      "tyr_pool_stop",
    );
  });
});

describe("shutdown that stops at the drain deadline", () => {
  it("answers 503 to a request that had no reply yet and cuts a running stream", async () => {
    const upstream = await startUpstream((call) => {
      if (call.body["stream"] !== true) return; // never answered
      call.res.writeHead(200, { "content-type": "text/event-stream" });
      sse(call, "message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 1 } },
      });
    });
    const { gateway, url, audits } = await startGateway({
      upstreamUrl: upstream.url,
      openaiUpstreamUrl: upstream.url,
      shutdownDrainTimeoutMs: 40,
      shutdownStopOnDrainTimeout: true,
      pools: [pool()],
    });

    const waiting = chat(url, "no reply yet");
    const streaming = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "mid stream" }],
      }),
    });
    const streamBody = readStream(streaming);
    await waitFor(() => upstream.calls.length === 2);

    const result = await gateway.shutdown();

    expect(result).toEqual({
      drained: false,
      inFlight: 2,
      pending: 0,
      stopped: 2,
      pools: { primary: { drained: false, inFlight: 2, pending: 0, stopped: 2 } },
    });
    const response = await waiting;
    expect(response.status).toBe(503);
    expect(response.headers.get("x-admission-stop-cause")).toBe(
      "drain_deadline",
    );
    expect(response.headers.get("connection")).toBe("close");
    expect(await response.json()).toMatchObject({
      error: { type: "admission_stopped", cause: "drain_deadline" },
    });
    expect(await streamBody).toMatchObject({ cut: true });

    await waitFor(() => upstream.calls.every((call) => call.aborted));
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      expect(audit).toMatchObject({
        settlement: "stopped",
        stopCause: "drain_deadline",
      });
    }
    await waitFor(
      () => gateway.control.stats().primary?.llm.inFlight === 0,
    );
    expect(gateway.control.stats().primary?.tyr.stop).toEqual({
      stopped: 2,
      stoppedByCause: { overrun: 0, limits: 0, drain_deadline: 2 },
    });
  });

  it("answers every request it stops, on every pool and kind of slot", async () => {
    // Two pools drain side by side, and a request on a borrowed slot with a
    // deadline learns of its stop through one more promise than a plain one.
    // Each must still be answered before the connections close.
    const upstream = await startUpstream();
    const { gateway, url } = await startGateway({
      openaiUpstreamUrl: upstream.url,
      shutdownDrainTimeoutMs: 40,
      shutdownStopOnDrainTimeout: true,
      resolveAdmissionClass: (_req, _identity, poolName) =>
        poolName === "classes" ? "background" : undefined,
      pools: [
        pool({ modelPrefixes: ["gpt-4o"] }),
        pool({
          name: "classes",
          modelPrefixes: ["gpt-5"],
          maxConcurrent: 3,
          admissionClasses: {
            defaultClass: "interactive",
            classes: {
              interactive: { protectedConcurrent: 1 },
              background: {
                borrowedAdmissionSlot: {
                  releaseMechanism: "deadline_abandonment",
                  deadlineMs: 60_000,
                },
              },
            },
          },
        }),
      ],
    });
    const send = (model: string): Promise<Response> =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "no reply yet" }],
          max_tokens: 100,
        }),
      });

    const waiting = [
      send("gpt-4o"),
      send("gpt-4o"),
      send("gpt-5"),
      send("gpt-5"),
    ];
    await waitFor(() => upstream.calls.length === 4);
    const result = await gateway.shutdown();

    expect(result).toMatchObject({ drained: false, stopped: 4 });
    const responses = await Promise.all(waiting);
    expect(responses.map((response) => response.status)).toEqual([
      503, 503, 503, 503,
    ]);
    expect(
      responses.map((response) => response.headers.get("x-admission-stop-cause")),
    ).toEqual([
      "drain_deadline",
      "drain_deadline",
      "drain_deadline",
      "drain_deadline",
    ]);
    expect(responses[2]?.headers.get("x-admission-slot-borrowed")).toBe("true");
  });

  it("stops an admitted request of an observe pool too", async () => {
    const upstream = await startUpstream();
    const { gateway, url, audits } = await startGateway({
      openaiUpstreamUrl: upstream.url,
      shutdownDrainTimeoutMs: 30,
      shutdownStopOnDrainTimeout: true,
      pools: [pool({ admissionMode: "observe" })],
    });

    const waiting = chat(url, "observed and admitted");
    await waitFor(() => upstream.calls.length === 1);
    const result = await gateway.shutdown();

    expect(result).toMatchObject({ drained: false, stopped: 1 });
    expect((await waiting).status).toBe(503);
    expect(audits[0]).toMatchObject({
      outcome: "admitted",
      settlement: "stopped",
      stopCause: "drain_deadline",
    });
  });

  it("closes connections without stopping anything when the option is off", async () => {
    const upstream = await startUpstream();
    const { gateway, url, audits } = await startGateway({
      openaiUpstreamUrl: upstream.url,
      shutdownDrainTimeoutMs: 30,
      pools: [pool()],
    });

    const waiting = chat(url, "no reply yet").then(
      (response) => response.status,
      () => "connection closed",
    );
    await waitFor(() => upstream.calls.length === 1);
    const result = await gateway.shutdown();

    expect(result).toStrictEqual({
      drained: false,
      inFlight: 1,
      pending: 0,
      pools: { primary: { drained: false, inFlight: 1, pending: 0 } },
    });
    expect(await waiting).toBe("connection closed");
    await waitFor(() => audits.length === 1);
    expect(audits[0]).toMatchObject({ settlement: "client_disconnect" });
    expect(gateway.control.stats().primary?.llm.stopped).toBeUndefined();
  });

  it("requires a drain deadline to stop at", () => {
    expect(() =>
      createGateway({
        openaiUpstreamUrl: "http://provider.invalid",
        shutdownStopOnDrainTimeout: true,
        pools: [pool()],
      }),
    ).toThrow("shutdownStopOnDrainTimeout requires shutdownDrainTimeoutMs");
    expect(() =>
      createGateway({
        openaiUpstreamUrl: "http://provider.invalid",
        shutdownDrainTimeoutMs: 10,
        shutdownStopOnDrainTimeout: "yes" as never,
        pools: [pool()],
      }),
    ).toThrow("shutdownStopOnDrainTimeout must be a boolean");
    // Off is valid without a deadline.
    createGateway({
      openaiUpstreamUrl: "http://provider.invalid",
      shutdownStopOnDrainTimeout: false,
      pools: [pool()],
    });
  });
});

describe("response memory and a stopped stream", () => {
  it("keeps no record of a Responses stream that was stopped", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tyr-stop-state-"));
    tempDirectories.push(directory);
    const upstream = await startUpstream((call) => {
      call.res.writeHead(200, { "content-type": "text/event-stream" });
      sse(call, "response.created", {
        type: "response.created",
        response: { id: "resp_stopped", status: "in_progress", usage: null },
      });
      setTimeout(() => {
        sse(call, "response.in_progress", {
          type: "response.in_progress",
          response: {
            id: "resp_stopped",
            status: "in_progress",
            usage: { input_tokens: 1, output_tokens: 9_000 },
          },
        });
      }, 10);
      // Never reached: the stream is cut before the response finishes.
      setTimeout(() => {
        if (call.res.destroyed) return;
        sse(call, "response.completed", {
          type: "response.completed",
          response: {
            id: "resp_stopped",
            status: "completed",
            usage: { input_tokens: 1, output_tokens: 9_100 },
          },
        });
        call.res.end();
      }, 400);
    });
    const { gateway, url } = await startGateway({
      openaiUpstreamUrl: upstream.url,
      responsesState: { file: join(directory, "responses.jsonl") },
      pools: [pool({ stop: { overrunAllowanceTokens: 50 } })],
    });

    const stopped = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: "write without end",
        max_output_tokens: 100,
        stream: true,
      }),
    });
    expect(await readStream(stopped)).toMatchObject({ cut: true });
    await waitFor(
      () => gateway.control.stats().primary?.tyr.stop?.stopped === 1,
    );

    const followUp = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: "and then?",
        max_output_tokens: 100,
        previous_response_id: "resp_stopped",
      }),
    });

    expect(followUp.status).toBe(422);
    expect(await followUp.json()).toMatchObject({
      error: { type: "unknown_previous_response" },
    });
    expect(gateway.control.stats().primary?.tyr.responsesState).toMatchObject({
      records: 0,
      recorded: 0,
      refused: 1,
    });
    await gateway.shutdown();
  });
});

describe("a Latchflo-managed pool with a stop policy", () => {
  it("keeps the policy on every grant and stops running work after a grant expires", async () => {
    const upstream = await startUpstream();
    const stop = { takeBackGraceMs: 30 };
    const { gateway, url, audits } = await startGateway({
      openaiUpstreamUrl: upstream.url,
      pools: [
        {
          name: "primary",
          modelPrefixes: ["gpt"],
          model: "gpt-4o",
          // What managed mode requires: closed, at revision 0.
          maxConcurrent: 0,
          maxQueue: 0,
          initialRevision: 0,
          stop,
        },
      ],
    });
    expect(gateway.control.limits().primary).toEqual({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });

    const acks: Array<Record<string, unknown>> = [];
    const expiresAt = new Date(Date.now() + 250).toISOString();
    const fetchStub: typeof globalThis.fetch = (input, init) => {
      const target = String(input);
      if (target.endsWith("/desired-state")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              controllerEpoch: 7,
              serverTime: new Date().toISOString(),
              heartbeatIntervalMs: 10_000,
              pollIntervalMs: 10_000,
              grants: [
                {
                  grantId: "00000000-0000-4000-8000-000000000035",
                  instanceId: "tyr-a",
                  pool: "primary",
                  controllerEpoch: 7,
                  revision: 11,
                  issuedAt: new Date().toISOString(),
                  expiresAt,
                  limits: { revision: 11, maxConcurrent: 4, maxQueue: 0 },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (target.endsWith("/ack")) {
        acks.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["primary"],
      agentToken: "persisted-token",
      control: gateway.control,
      fetch: fetchStub,
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();

    // The grant's revision is the pool's revision, and the policy rides on it.
    expect(agent.ready()).toBe(true);
    expect(acks).toEqual([expect.objectContaining({ status: "applied" })]);
    expect(gateway.control.limits().primary).toEqual({
      revision: 11,
      maxConcurrent: 4,
      maxQueue: 0,
      stop,
    });

    const running = chat(url, "outlives the grant");
    await waitFor(() => upstream.calls.length === 1);

    // At expiry Tyr applies the next revision with zero capacity. That update
    // carries the policy too, so the request is stopped after the grace period.
    const response = await running;
    expect(Date.parse(expiresAt)).toBeLessThanOrEqual(Date.now());
    expect(response.status).toBe(503);
    expect(response.headers.get("x-admission-stop-cause")).toBe("limits");
    expect(response.headers.get("x-admission-revision")).toBe("11");
    expect(response.headers.get("x-latchflo-grant-id")).toBe(
      "00000000-0000-4000-8000-000000000035",
    );
    expect(gateway.control.limits().primary).toEqual({
      revision: 12,
      maxConcurrent: 0,
      maxQueue: 0,
      stop,
    });
    expect(agent.ready()).toBe(false);
    await waitFor(() => upstream.calls[0]?.aborted === true);
    expect(audits[0]).toMatchObject({
      settlement: "stopped",
      stopCause: "limits",
      grant: { grantId: "00000000-0000-4000-8000-000000000035", revision: 11 },
    });
    agent.stop();
  });
});
