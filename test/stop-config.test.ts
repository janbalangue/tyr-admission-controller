import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfig, loadRuntimeConfigFile } from "../src/config.js";
import { createPools, MAX_TAKE_BACK_GRACE_MS } from "../src/pools.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs: string[] = [];

function tempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tyr-stop-config-"));
  tempDirs.push(dir);
  const path = join(dir, "tyr.yaml");
  writeFileSync(path, contents, "utf8");
  return path;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** One budgeted pool; `pool` and `root` are YAML added at each level. */
function config(pool = "", root = ""): string {
  return `
version: 1
upstreams:
  openai:
    baseUrl: https://provider.example.com
pools:
  - name: pool
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 4
    inFlightTokenBudget: 100000
${pool}
${root}
`;
}

function load(pool = "", root = "") {
  return loadRuntimeConfigFile(tempConfig(config(pool, root)), {}).gateway;
}

describe("stop file configuration", () => {
  it("is absent unless configured", () => {
    const gateway = load();

    expect(gateway.pools[0]).not.toHaveProperty("stop");
    expect(gateway).not.toHaveProperty("shutdownStopOnDrainTimeout");
  });

  it("reads a pool's stop block", () => {
    expect(
      load(`    stop:
      overrunAllowanceTokens: 2000
      takeBackGraceMs: 5000`).pools[0]?.stop,
    ).toEqual({ overrunAllowanceTokens: 2_000, takeBackGraceMs: 5_000 });

    expect(
      load(`    stop:
      takeBackGraceMs: 0`).pools[0]?.stop,
    ).toEqual({ takeBackGraceMs: 0 });

    expect(
      load(`    stop:
      overrunAllowanceTokens: 0`).pools[0]?.stop,
    ).toEqual({ overrunAllowanceTokens: 0 });
  });

  it("produces a pool that starts with the policy applied", () => {
    const gateway = load(`    limitsRevision: 100
    stop:
      takeBackGraceMs: ${MAX_TAKE_BACK_GRACE_MS}`);

    expect(createPools(gateway.pools).limits().pool).toMatchObject({
      revision: 100,
      stop: { takeBackGraceMs: MAX_TAKE_BACK_GRACE_MS },
    });
  });

  it("rejects a malformed stop block", () => {
    const cases: Array<[string, string]> = [
      ["    stop: 5", "pools[0].stop must be an object"],
      ["    stop: []", "pools[0].stop must be an object"],
      [
        "    stop: {}",
        "pools[0].stop must set overrunAllowanceTokens or takeBackGraceMs",
      ],
      [
        "    stop:\n      graceMs: 5",
        'pools[0].stop contains unknown property "graceMs"',
      ],
      [
        "    stop:\n      overrunAllowanceTokens: -1",
        "pools[0].stop.overrunAllowanceTokens must be a safe integer >= 0",
      ],
      [
        "    stop:\n      overrunAllowanceTokens: 1.5",
        "pools[0].stop.overrunAllowanceTokens must be a safe integer >= 0",
      ],
      [
        '    stop:\n      takeBackGraceMs: "5s"',
        "pools[0].stop.takeBackGraceMs must be a safe integer >= 0",
      ],
      [
        `    stop:\n      takeBackGraceMs: ${MAX_TAKE_BACK_GRACE_MS + 1}`,
        "pools[0].stop.takeBackGraceMs must be a safe integer <= 2147483647",
      ],
      [
        "    admissionMode: observe\n    stop:\n      takeBackGraceMs: 5",
        "pools[0].stop requires pools[0].admissionMode to be enforce",
      ],
    ];

    for (const [pool, message] of cases) {
      expect(() => load(pool)).toThrow(message);
    }
  });

  it("requires a token budget for an overrun allowance, in the file's own terms", () => {
    const path = tempConfig(`
version: 1
upstreams:
  openai:
    baseUrl: https://provider.example.com
pools:
  - name: pool
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 4
    stop:
      overrunAllowanceTokens: 100
`);

    expect(() => loadRuntimeConfigFile(path, {})).toThrow(
      "pools[0].stop.overrunAllowanceTokens requires pools[0].inFlightTokenBudget",
    );
  });

  it("reads shutdown.stopOnDrainTimeout and requires a drain deadline for it", () => {
    expect(
      load(
        "",
        `shutdown:
  drainTimeoutMs: 30000
  stopOnDrainTimeout: true`,
      ),
    ).toMatchObject({
      shutdownDrainTimeoutMs: 30_000,
      shutdownStopOnDrainTimeout: true,
    });

    // Off needs no deadline.
    expect(
      load("", "shutdown:\n  stopOnDrainTimeout: false"),
    ).toMatchObject({ shutdownStopOnDrainTimeout: false });

    expect(() => load("", "shutdown:\n  stopOnDrainTimeout: true")).toThrow(
      "shutdown.stopOnDrainTimeout requires shutdown.drainTimeoutMs",
    );
    expect(() =>
      load("", "shutdown:\n  drainTimeoutMs: 10\n  stopOnDrainTimeout: yes please"),
    ).toThrow("shutdown.stopOnDrainTimeout must be a boolean");
  });

  it("lets a Latchflo-managed pool keep its required starting state", () => {
    const path = tempConfig(`
version: 1
upstreams:
  openai:
    baseUrl: https://provider.example.com
pools:
  - name: managed
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 0
    maxQueue: 0
    limitsRevision: 0
    stop:
      takeBackGraceMs: 5000
controlPlane:
  type: latchflo
  url: http://latchflo.example.com
  instanceId: tyr-a
`);

    const runtime = loadRuntimeConfigFile(path, {});

    expect(runtime.controlPlane?.pools).toEqual(["managed"]);
    // Still at revision 0, as the first grant needs.
    expect(createPools(runtime.gateway.pools).limits().managed).toEqual({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
  });

  it("accepts the stop block exactly as the example configuration documents it", () => {
    const example = readFileSync(
      join(repoRoot, "config", "tyr.example.yaml"),
      "utf8",
    );
    const start = example.indexOf("    # stop:");
    expect(start).toBeGreaterThan(-1);
    const end = example.indexOf("    # Optional bounded service classes.", start);
    expect(end).toBeGreaterThan(start);
    const block = example
      .slice(start, end)
      .split("\n")
      .map((line) => line.replace(/^(\s*)# ?/, "$1"))
      .join("\n");
    const path = tempConfig(`${example.slice(0, start)}${block}${example.slice(end)}`);

    const gateway = loadRuntimeConfigFile(path, {}).gateway;

    expect(gateway.pools[0]?.stop).toEqual({
      overrunAllowanceTokens: 2_000,
      takeBackGraceMs: 5_000,
    });
    expect(gateway.shutdownStopOnDrainTimeout).toBe(false);
    // The example pool has limitsRevision 100 and starts open.
    expect(createPools(gateway.pools).limits()["interactive-claude"]).toMatchObject({
      revision: 100,
      stop: { overrunAllowanceTokens: 2_000, takeBackGraceMs: 5_000 },
    });
  });

  it("accepts the stop block the Latchflo example documents", () => {
    const example = readFileSync(
      join(repoRoot, "config", "tyr.latchflo.example.yaml"),
      "utf8",
    );
    const start = example.indexOf("    # stop:");
    expect(start).toBeGreaterThan(-1);
    const end = example.indexOf("    # Latchflo owns the physical pool grant.", start);
    expect(end).toBeGreaterThan(start);
    const block = example
      .slice(start, end)
      .split("\n")
      .map((line) => line.replace(/^(\s*)# ?/, "$1"))
      .join("\n");
    const path = tempConfig(`${example.slice(0, start)}${block}${example.slice(end)}`);

    const runtime = loadRuntimeConfigFile(path, {
      TYR_ROUTING_SECRET: "0123456789abcdef0123",
    });

    expect(runtime.gateway.pools[0]?.stop).toEqual({ takeBackGraceMs: 5_000 });
    expect(runtime.controlPlane?.pools).toEqual(["openai-primary"]);
  });

  it("has no legacy environment variables", () => {
    const gateway = loadRuntimeConfig({
      UPSTREAM_URL: "https://provider.example.com",
      SHUTDOWN_DRAIN_TIMEOUT_MS: "1000",
    }).gateway;

    expect(gateway.pools[0]).not.toHaveProperty("stop");
    expect(gateway).not.toHaveProperty("shutdownStopOnDrainTimeout");
  });
});

describe("config/tyr.schema.json stop settings", () => {
  type SchemaObject = {
    additionalProperties?: boolean;
    minProperties?: number;
    properties: Record<string, Record<string, unknown>>;
    if?: unknown;
    then?: unknown;
  };
  const schema = JSON.parse(
    readFileSync(join(repoRoot, "config", "tyr.schema.json"), "utf8"),
  ) as {
    properties: Record<string, SchemaObject>;
    $defs: {
      pool: { properties: Record<string, SchemaObject>; allOf?: unknown[] };
    };
  };

  it("describes the pool stop block the runtime accepts", () => {
    const block = schema.$defs.pool.properties["stop"];

    expect(block?.additionalProperties).toBe(false);
    // The runtime refuses an empty block.
    expect(block?.minProperties).toBe(1);
    expect(Object.keys(block?.properties ?? {}).sort()).toEqual([
      "overrunAllowanceTokens",
      "takeBackGraceMs",
    ]);
    expect(block?.properties["overrunAllowanceTokens"]).toMatchObject({
      type: "integer",
      minimum: 0,
    });
    expect(block?.properties["takeBackGraceMs"]).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: MAX_TAKE_BACK_GRACE_MS,
    });
  });

  it("states the two rules that tie a stop block to the rest of its pool", () => {
    expect(schema.$defs.pool.allOf).toEqual([
      // An overrun allowance needs a token budget.
      {
        if: {
          properties: { stop: { required: ["overrunAllowanceTokens"] } },
          required: ["stop"],
        },
        then: { required: ["inFlightTokenBudget"] },
      },
      // A stop block cannot be on an observe pool.
      {
        if: { required: ["stop"] },
        then: { properties: { admissionMode: { const: "enforce" } } },
      },
    ]);
  });

  it("describes the shutdown block the runtime accepts", () => {
    const shutdown = schema.properties["shutdown"];

    expect(shutdown?.additionalProperties).toBe(false);
    expect(Object.keys(shutdown?.properties ?? {}).sort()).toEqual([
      "drainTimeoutMs",
      "stopOnDrainTimeout",
    ]);
    // Only `true` needs the deadline, as at runtime.
    expect(shutdown?.if).toEqual({
      properties: { stopOnDrainTimeout: { const: true } },
      required: ["stopOnDrainTimeout"],
    });
    expect(shutdown?.then).toEqual({ required: ["drainTimeoutMs"] });
  });
});
