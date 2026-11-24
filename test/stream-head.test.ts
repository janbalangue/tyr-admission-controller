import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PoolConfig } from "../src/pools.js";
import { createGateway, type GatewayOptions } from "../src/server.js";
import type {
  TyrAdmissionAuditEvent,
  TyrUpstreamFailureEvent,
} from "../src/telemetry.js";

// A streamed reply's status line is written with its first chunk. Until then
// the client has received nothing, so whatever ends the request in that time
// is answered with its own status. After the first chunk the reply can only
// be cut.

const openServers: Server[] = [];

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
});

/** A provider whose reply to each streamed request is driven by `reply`. */
async function startUpstream(
  reply: (res: ServerResponse) => void,
): Promise<string> {
  return listen(
    createServer((req, res) => {
      req.resume();
      req.on("end", () => reply(res));
    }),
  );
}

const event = (res: ServerResponse, data: unknown): void => {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

function pool(overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    name: "primary",
    modelPrefixes: ["gpt"],
    model: "gpt-4o",
    maxConcurrent: 2,
    budget: 10_000,
    adaptiveEstimation: { enabled: false },
    ...overrides,
  };
}

async function startGateway(
  upstreamUrl: string,
  options: Partial<GatewayOptions> = {},
) {
  const audits: TyrAdmissionAuditEvent[] = [];
  const diagnostics: TyrUpstreamFailureEvent[] = [];
  const gateway = createGateway({
    openaiUpstreamUrl: upstreamUrl,
    pools: [pool()],
    ...options,
    telemetry: {
      auditEnabled: true,
      auditSink: (audit) => audits.push(audit),
      diagnosticSink: (diagnostic) => diagnostics.push(diagnostic),
    },
  });
  return { url: await listen(gateway.server), audits, diagnostics };
}

function stream(url: string): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

/** Reads a body until it ends or the connection is cut. */
async function readBody(
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

describe("a streamed reply that fails before its first chunk", () => {
  it("gets 504 idle_timeout when the provider sends headers and then stalls", async () => {
    const upstreamUrl = await startUpstream((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
    });
    const { url, audits } = await startGateway(upstreamUrl, {
      idleTimeoutMs: 40,
    });

    const response = await stream(url);

    expect(response.status).toBe(504);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      error: {
        type: "idle_timeout",
        message: "upstream stream stalled for 40ms",
      },
    });
    expect(audits[0]).toMatchObject({ settlement: "idle_timeout" });
  });

  it("gets 502 upstream_error when the provider drops the connection", async () => {
    const upstreamUrl = await startUpstream((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      setTimeout(() => res.destroy(), 20);
    });
    const { url, audits, diagnostics } = await startGateway(upstreamUrl);

    const response = await stream(url);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { type: "upstream_error" },
    });
    expect(audits[0]).toMatchObject({ settlement: "upstream_error" });
    // Nothing had been sent, so no stream was torn.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ afterHeaders: false });
  });

  it("gets 504 borrowed_admission_deadline when its borrowed slot expires", async () => {
    const upstreamUrl = await startUpstream((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
    });
    const { url, audits } = await startGateway(upstreamUrl, {
      pools: [
        pool({
          admissionClasses: {
            defaultClass: "background",
            classes: {
              interactive: { protectedConcurrent: 1 },
              background: {
                borrowedAdmissionSlot: {
                  releaseMechanism: "deadline_abandonment",
                  deadlineMs: 40,
                },
              },
            },
          },
        }),
      ],
    });

    const response = await stream(url);

    expect(response.status).toBe(504);
    expect(response.headers.get("x-admission-reason")).toBe(
      "borrowed_admission_deadline",
    );
    expect(await response.json()).toMatchObject({
      error: { type: "borrowed_admission_deadline", localSlotReleased: true },
    });
    expect(audits[0]).toMatchObject({
      settlement: "borrowed_admission_deadline",
    });
  });
});

describe("a streamed reply after its first chunk", () => {
  it("is cut when the provider then stalls", async () => {
    const upstreamUrl = await startUpstream((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      event(res, { choices: [{ delta: { content: "partial" } }] });
    });
    const { url, audits } = await startGateway(upstreamUrl, {
      idleTimeoutMs: 40,
    });

    const response = await stream(url);
    expect(response.status).toBe(200);
    const body = await readBody(response);

    expect(body.cut).toBe(true);
    expect(body.text).toContain("partial");
    expect(audits[0]).toMatchObject({ settlement: "idle_timeout" });
  });

  it("is cut when the provider then drops the connection", async () => {
    const upstreamUrl = await startUpstream((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      event(res, { choices: [{ delta: { content: "partial" } }] });
      setTimeout(() => res.destroy(), 20);
    });
    const { url, diagnostics } = await startGateway(upstreamUrl);

    const response = await stream(url);
    expect(response.status).toBe(200);

    expect(await readBody(response)).toMatchObject({ cut: true });
    expect(diagnostics[0]).toMatchObject({ afterHeaders: true });
  });
});

describe("a streamed reply's head", () => {
  it("carries the provider's status and content type with the first chunk", async () => {
    const upstreamUrl = await startUpstream((res) => {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      event(res, { choices: [{ delta: { content: "hi" } }] });
      res.end("data: [DONE]\n\n");
    });
    const { url } = await startGateway(upstreamUrl);

    const response = await stream(url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-admission-outcome")).toBe("admitted");
    expect(await readBody(response)).toEqual({
      text: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
      cut: false,
    });
  });

  it("is still sent for a provider reply that has no body", async () => {
    const upstreamUrl = await startUpstream((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end();
    });
    const { url, audits } = await startGateway(upstreamUrl);

    const response = await stream(url);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await readBody(response)).toEqual({ text: "", cut: false });
    expect(audits[0]).toMatchObject({ settlement: "completed" });
  });

  it("passes on a provider's error status for a streamed request", async () => {
    const upstreamUrl = await startUpstream((res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end('{"error":{"type":"rate_limit_exceeded"}}');
    });
    const { url } = await startGateway(upstreamUrl);

    const response = await stream(url);

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(
      '{"error":{"type":"rate_limit_exceeded"}}',
    );
  });
});
