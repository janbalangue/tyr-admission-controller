import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIGURATION_ROOT_KEYS, loadRuntimeConfigFile } from "../src/config.js";
import { MAX_RESPONSES_STATE_MAX_ENTRIES } from "../src/responses-state.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs: string[] = [];

function tempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tyr-responses-config-"));
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

function config(responsesState: string, upstream = "openai"): string {
  return `
version: 1
upstreams:
  ${upstream}:
    baseUrl: https://provider.example.com
pools:
  - name: pool
    modelPrefixes: [gpt, claude]
    estimatorModel: gpt-4o
    maxConcurrent: 4
${responsesState}
`;
}

describe("responsesState file configuration", () => {
  it("is absent unless the block is configured", () => {
    const runtime = loadRuntimeConfigFile(tempConfig(config("")), {});

    expect(runtime.gateway).not.toHaveProperty("responsesState");
  });

  it("resolves a relative file from the configuration file's directory", () => {
    const path = tempConfig(
      config(`responsesState:
  file: state/responses.jsonl
  maxEntries: 500
  ttlMs: 3600000`),
    );

    expect(loadRuntimeConfigFile(path, {}).gateway.responsesState).toEqual({
      file: join(dirname(path), "state", "responses.jsonl"),
      maxEntries: 500,
      ttlMs: 3_600_000,
    });
  });

  it("keeps an absolute file and leaves omitted bounds to their defaults", () => {
    const path = tempConfig(
      config(`responsesState:
  file: /var/lib/tyr/responses.jsonl`),
    );

    expect(loadRuntimeConfigFile(path, {}).gateway.responsesState).toEqual({
      file: "/var/lib/tyr/responses.jsonl",
    });
  });

  it("does not create the state file while loading configuration", () => {
    const path = tempConfig(
      config(`responsesState:
  file: responses.jsonl`),
    );
    loadRuntimeConfigFile(path, {});

    expect(() => readFileSync(join(dirname(path), "responses.jsonl"))).toThrow(
      /ENOENT/,
    );
  });

  it("rejects an unusable block", () => {
    const cases: Array<[string, string]> = [
      ["responsesState:", "responsesState must be an object"],
      ["responsesState: on", "responsesState must be an object"],
      [
        "responsesState:\n  maxEntries: 10",
        "responsesState.file must be a non-empty string",
      ],
      [
        'responsesState:\n  file: ""',
        "responsesState.file must be a non-empty string",
      ],
      [
        "responsesState:\n  file: s.jsonl\n  maxEntries: 0",
        "responsesState.maxEntries must be a safe integer >= 1",
      ],
      [
        `responsesState:\n  file: s.jsonl\n  maxEntries: ${MAX_RESPONSES_STATE_MAX_ENTRIES + 1}`,
        `responsesState.maxEntries must be a safe integer <= ${MAX_RESPONSES_STATE_MAX_ENTRIES}`,
      ],
      [
        "responsesState:\n  file: s.jsonl\n  ttlMs: 0",
        "responsesState.ttlMs must be a safe integer >= 1",
      ],
      [
        "responsesState:\n  file: s.jsonl\n  ttlMs: 1.5",
        "responsesState.ttlMs must be a safe integer >= 1",
      ],
      [
        "responsesState:\n  file: s.jsonl\n  backgroundMaxHoldMs: 1000",
        'responsesState contains unknown property "backgroundMaxHoldMs"',
      ],
    ];

    for (const [block, message] of cases) {
      expect(() => loadRuntimeConfigFile(tempConfig(config(block)), {})).toThrow(
        message,
      );
    }
  });

  it("requires the OpenAI upstream that serves the Responses route", () => {
    const path = tempConfig(
      config("responsesState:\n  file: s.jsonl", "anthropic"),
    );

    expect(() => loadRuntimeConfigFile(path, {})).toThrow(
      "responsesState requires upstreams.openai",
    );
  });

  it("accepts the block exactly as the example configuration documents it", () => {
    const example = readFileSync(
      join(repoRoot, "config", "tyr.example.yaml"),
      "utf8",
    );
    const start = example.indexOf("# responsesState:");
    expect(start).toBeGreaterThan(-1);
    const end = example.indexOf("\n\n", start);
    const block = example
      .slice(start, end)
      .split("\n")
      .map((line) => line.replace(/^# ?/, ""))
      .join("\n");
    const path = tempConfig(`${example.slice(0, start)}${block}${example.slice(end)}`);

    expect(loadRuntimeConfigFile(path, {}).gateway.responsesState).toEqual({
      file: join(dirname(path), "tyr-responses-state.jsonl"),
      maxEntries: 10_000,
      ttlMs: 2_592_000_000,
    });
  });
});

describe("config/tyr.schema.json", () => {
  const schema = JSON.parse(
    readFileSync(join(repoRoot, "config", "tyr.schema.json"), "utf8"),
  ) as {
    additionalProperties: boolean;
    properties: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
  };

  it("accepts every top-level key the runtime accepts, and no other", () => {
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(
      [...CONFIGURATION_ROOT_KEYS].sort(),
    );
  });

  it("describes the responsesState block the runtime accepts", () => {
    const block = schema.properties["responsesState"];

    expect(Object.keys(block?.properties ?? {}).sort()).toEqual([
      "file",
      "maxEntries",
      "ttlMs",
    ]);
    expect(block?.required).toEqual(["file"]);
    expect(block?.properties?.["maxEntries"]).toMatchObject({
      maximum: MAX_RESPONSES_STATE_MAX_ENTRIES,
    });
  });
});
