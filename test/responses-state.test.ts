import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RESPONSES_STATE_MAX_ENTRIES,
  DEFAULT_RESPONSES_STATE_TTL_MS,
  MAX_RESPONSE_ID_LENGTH,
  MAX_RESPONSES_STATE_MAX_ENTRIES,
  recordableResponse,
  recordableStreamResponse,
  RESPONSES_STATE_SCHEMA,
  ResponsesStateFileError,
  ResponsesStateStore,
  type ResponsesStateDependencies,
  type ResponsesStateOptions,
} from "../src/responses-state.js";

const HEADER = `${JSON.stringify({ schema: RESPONSES_STATE_SCHEMA })}\n`;

let dir: string;
let file: string;
let now: number;
let warnings: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tyr-responses-state-"));
  file = join(dir, "state.jsonl");
  now = 1_700_000_000_000;
  warnings = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function open(
  options: Partial<ResponsesStateOptions> = {},
  dependencies: ResponsesStateDependencies = {},
): ResponsesStateStore {
  return new ResponsesStateStore(
    { file, ...options },
    {
      now: () => now,
      warn: (message) => warnings.push(message),
      ...dependencies,
    },
  );
}

function recordedIds(): string[] {
  return recordLines().map((line) => (JSON.parse(line) as { id: string }).id);
}

function diskFull(): Error {
  return Object.assign(new Error("ENOSPC: no space left on device, write"), {
    code: "ENOSPC",
  });
}

function recordLines(): string[] {
  return readFileSync(file, "utf8").split("\n").slice(1, -1);
}

describe("ResponsesStateStore", () => {
  it("resolves a follow-up to the recorded size of the response it names", () => {
    const store = open();
    expect(store.record({ pool: "openai", responseId: "resp_1", tokens: 50 })).toBe(
      true,
    );

    expect(store.resolveFollowUp({ pool: "openai", responseId: "resp_1" })).toBe(50);
    expect(store.stats("openai")).toEqual({
      records: 1,
      recorded: 1,
      evicted: 0,
      expired: 0,
      followUps: 1,
      priorTokens: 50,
      refused: 0,
      persistFailures: 0,
    });
  });

  it("refuses an id it never recorded", () => {
    const store = open();

    expect(
      store.resolveFollowUp({ pool: "openai", responseId: "resp_none" }),
    ).toBeUndefined();
    expect(store.stats("openai").refused).toBe(1);
    expect(store.stats("openai").followUps).toBe(0);
  });

  it("uses the defaults when bounds are omitted", () => {
    const store = open();

    expect(store.maxEntries).toBe(DEFAULT_RESPONSES_STATE_MAX_ENTRIES);
    expect(store.ttlMs).toBe(DEFAULT_RESPONSES_STATE_TTL_MS);
    expect(store.file).toBe(file);
  });

  it("drops the oldest record once maxEntries is exceeded", () => {
    const store = open({ maxEntries: 2 });
    store.record({ pool: "openai", responseId: "resp_1", tokens: 10 });
    store.record({ pool: "openai", responseId: "resp_2", tokens: 20 });
    store.record({ pool: "openai", responseId: "resp_3", tokens: 30 });

    expect(
      store.resolveFollowUp({ pool: "openai", responseId: "resp_1" }),
    ).toBeUndefined();
    expect(store.resolveFollowUp({ pool: "openai", responseId: "resp_2" })).toBe(20);
    expect(store.resolveFollowUp({ pool: "openai", responseId: "resp_3" })).toBe(30);
    expect(store.stats("openai")).toMatchObject({
      records: 2,
      recorded: 3,
      evicted: 1,
      refused: 1,
    });
    expect(store.size).toBe(2);
  });

  it("expires a record once it is ttlMs old", () => {
    const store = open({ ttlMs: 200 });
    store.record({ pool: "openai", responseId: "resp_1", tokens: 50 });

    now += 199;
    expect(store.resolveFollowUp({ pool: "openai", responseId: "resp_1" })).toBe(50);

    now += 1;
    expect(
      store.resolveFollowUp({ pool: "openai", responseId: "resp_1" }),
    ).toBeUndefined();
    expect(store.stats("openai")).toMatchObject({
      records: 0,
      expired: 1,
      refused: 1,
    });
  });

  it("stops counting an expired record without waiting for a follow-up", () => {
    const store = open({ ttlMs: 200 });
    store.record({ pool: "openai", responseId: "resp_1", tokens: 50 });
    now += 100;
    store.record({ pool: "openai", responseId: "resp_2", tokens: 60 });

    now += 150;
    expect(store.stats("openai")).toMatchObject({ records: 1, expired: 1 });
    expect(store.size).toBe(1);
  });

  it("keeps one record when the same id is recorded again", () => {
    const store = open({ maxEntries: 2 });
    store.record({ pool: "openai", responseId: "resp_1", tokens: 10 });
    store.record({ pool: "openai", responseId: "resp_2", tokens: 20 });
    // The newer size replaces the older one and makes resp_1 the newest.
    store.record({ pool: "openai", responseId: "resp_1", tokens: 15 });
    store.record({ pool: "openai", responseId: "resp_3", tokens: 30 });

    expect(store.resolveFollowUp({ pool: "openai", responseId: "resp_1" })).toBe(15);
    expect(
      store.resolveFollowUp({ pool: "openai", responseId: "resp_2" }),
    ).toBeUndefined();
    expect(store.stats("openai").records).toBe(2);
  });

  it("does not write the same record twice", () => {
    const store = open();
    store.record({ pool: "openai", responseId: "resp_1", tokens: 50 });
    store.record({ pool: "openai", responseId: "resp_1", tokens: 50 });

    expect(recordLines()).toHaveLength(1);
    expect(store.stats("openai").recorded).toBe(1);
  });

  it("serves a record only to the tenant and application that created it", () => {
    const store = open();
    store.record({
      pool: "openai",
      responseId: "resp_1",
      tokens: 50,
      owner: { tenantId: "t1", applicationId: "a1" },
    });

    expect(
      store.resolveFollowUp({
        pool: "openai",
        responseId: "resp_1",
        owner: { tenantId: "t1", applicationId: "a1" },
      }),
    ).toBe(50);
    for (const owner of [
      { tenantId: "t2", applicationId: "a1" },
      { tenantId: "t1", applicationId: "a2" },
      { tenantId: "t1" },
      { applicationId: "a1" },
      undefined,
    ]) {
      expect(
        store.resolveFollowUp({
          pool: "openai",
          responseId: "resp_1",
          ...(owner === undefined ? {} : { owner }),
        }),
      ).toBeUndefined();
    }
    expect(store.stats("openai")).toMatchObject({ followUps: 1, refused: 5 });
    // A refused caller does not disturb the record.
    expect(store.stats("openai").records).toBe(1);
  });

  it("does not hand an unowned record to an identified caller", () => {
    const store = open();
    store.record({ pool: "openai", responseId: "resp_1", tokens: 50 });

    expect(
      store.resolveFollowUp({
        pool: "openai",
        responseId: "resp_1",
        owner: { tenantId: "t1", applicationId: "a1" },
      }),
    ).toBeUndefined();
    expect(store.resolveFollowUp({ pool: "openai", responseId: "resp_1" })).toBe(50);
  });

  it("counts a record for the pool that created it and a follow-up for the pool that used it", () => {
    const store = open();
    store.record({ pool: "fast", responseId: "resp_1", tokens: 50 });

    expect(store.resolveFollowUp({ pool: "deep", responseId: "resp_1" })).toBe(50);
    expect(store.stats("fast")).toMatchObject({ records: 1, followUps: 0 });
    expect(store.stats("deep")).toMatchObject({
      records: 0,
      followUps: 1,
      priorTokens: 50,
    });
    expect(store.stats("unused")).toMatchObject({ records: 0, recorded: 0 });
  });

  it("rejects responses it cannot record", () => {
    const store = open();

    expect(store.record({ pool: "openai", responseId: "", tokens: 1 })).toBe(false);
    expect(
      store.record({
        pool: "openai",
        responseId: "r".repeat(MAX_RESPONSE_ID_LENGTH + 1),
        tokens: 1,
      }),
    ).toBe(false);
    expect(store.record({ pool: "openai", responseId: "resp_1", tokens: -1 })).toBe(
      false,
    );
    expect(store.record({ pool: "openai", responseId: "resp_1", tokens: 1.5 })).toBe(
      false,
    );
    expect(store.size).toBe(0);
    expect(recordLines()).toHaveLength(0);
  });
});

describe("ResponsesStateStore persistence", () => {
  it("creates the file, with missing directories, readable only by its owner", () => {
    file = join(dir, "nested", "deeper", "state.jsonl");
    open();

    expect(readFileSync(file, "utf8")).toBe(HEADER);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("has a record on disk as soon as record() returns", () => {
    const store = open();
    store.record({
      pool: "openai",
      responseId: "resp_1",
      tokens: 50,
      owner: { tenantId: "t1", applicationId: "a1" },
    });

    expect(recordLines().map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        id: "resp_1",
        pool: "openai",
        tokens: 50,
        at: now,
        tenantId: "t1",
        applicationId: "a1",
      },
    ]);
  });

  it("restores records, with their owners, in a process that never saw them", () => {
    const first = open();
    first.record({ pool: "openai", responseId: "resp_1", tokens: 50 });
    first.record({
      pool: "openai",
      responseId: "resp_2",
      tokens: 70,
      owner: { tenantId: "t1", applicationId: "a1" },
    });
    // No close(): the first process is treated as killed.

    const second = open();
    expect(second.resolveFollowUp({ pool: "openai", responseId: "resp_1" })).toBe(50);
    expect(
      second.resolveFollowUp({
        pool: "openai",
        responseId: "resp_2",
        owner: { tenantId: "t1", applicationId: "a1" },
      }),
    ).toBe(70);
    expect(
      second.resolveFollowUp({ pool: "openai", responseId: "resp_2" }),
    ).toBeUndefined();
    expect(second.stats("openai")).toMatchObject({ records: 2, recorded: 0 });
    expect(warnings).toEqual([]);
  });

  it("keeps the age of a restored record", () => {
    const first = open({ ttlMs: 1_000 });
    first.record({ pool: "openai", responseId: "resp_1", tokens: 50 });

    now += 600;
    const second = open({ ttlMs: 1_000 });
    expect(second.resolveFollowUp({ pool: "openai", responseId: "resp_1" })).toBe(50);

    now += 400;
    expect(
      second.resolveFollowUp({ pool: "openai", responseId: "resp_1" }),
    ).toBeUndefined();
  });

  it("ignores a partly written last line and repairs the file", () => {
    const first = open();
    first.record({ pool: "openai", responseId: "resp_1", tokens: 50 });
    appendFileSync(file, '{"id":"resp_torn","pool":"openai","tok');

    const second = open();
    expect(second.resolveFollowUp({ pool: "openai", responseId: "resp_1" })).toBe(50);
    expect(
      second.resolveFollowUp({ pool: "openai", responseId: "resp_torn" }),
    ).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("partly written last line");
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(recordLines()).toHaveLength(1);

    // The next record starts on its own line and survives another restart.
    second.record({ pool: "openai", responseId: "resp_2", tokens: 60 });
    const third = open();
    expect(third.resolveFollowUp({ pool: "openai", responseId: "resp_2" })).toBe(60);
    expect(warnings).toHaveLength(1);
  });

  it("skips unreadable lines and keeps the rest", () => {
    writeFileSync(
      file,
      `${HEADER}${JSON.stringify({ id: "resp_1", pool: "openai", tokens: 50, at: now })}\nnot json\n${JSON.stringify({ id: "resp_bad", pool: "openai", tokens: -5, at: now })}\n${JSON.stringify({ id: "resp_2", pool: "openai", tokens: 60, at: now })}\n`,
    );

    const store = open();
    expect(store.resolveFollowUp({ pool: "openai", responseId: "resp_1" })).toBe(50);
    expect(store.resolveFollowUp({ pool: "openai", responseId: "resp_2" })).toBe(60);
    expect(
      store.resolveFollowUp({ pool: "openai", responseId: "resp_bad" }),
    ).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ignored 2 unreadable lines");
    expect(recordLines()).toHaveLength(2);
  });

  it("will not overwrite a file that is not a Tyr state file", () => {
    for (const contents of ["agent-token-value\n", "agent-token-value", "{}\n"]) {
      writeFileSync(file, contents);

      expect(() => open()).toThrow(ResponsesStateFileError);
      expect(() => open()).toThrow(/not a Tyr responses-state file/);
      expect(readFileSync(file, "utf8")).toBe(contents);
    }
  });

  it("will not read a state file written with a newer schema", () => {
    const contents = `${JSON.stringify({ schema: "tyr.responses-state.v2" })}\n`;
    writeFileSync(file, contents);

    expect(() => open()).toThrow(/uses schema tyr\.responses-state\.v2/);
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it("starts empty when the very first write was interrupted", () => {
    for (const contents of ["", HEADER.slice(0, 12)]) {
      writeFileSync(file, contents);

      const store = open();
      expect(store.size).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(HEADER);
    }
    expect(warnings).toEqual([]);
  });

  it("reports a path it cannot use", () => {
    file = dir;

    expect(() => open()).toThrow(/unable to use responsesState\.file/);
  });

  it("applies bounds that changed while it was down without counting them", () => {
    const first = open({ maxEntries: 10, ttlMs: 10_000 });
    first.record({ pool: "openai", responseId: "resp_1", tokens: 10 });
    now += 1_000;
    first.record({ pool: "openai", responseId: "resp_2", tokens: 20 });
    now += 1_000;
    first.record({ pool: "openai", responseId: "resp_3", tokens: 30 });

    const smaller = open({ maxEntries: 2, ttlMs: 10_000 });
    expect(smaller.size).toBe(2);
    expect(smaller.stats("openai")).toMatchObject({ records: 2, evicted: 0 });
    expect(recordLines()).toHaveLength(2);

    const shorter = open({ maxEntries: 2, ttlMs: 500 });
    expect(shorter.size).toBe(1);
    expect(shorter.stats("openai")).toMatchObject({ records: 1, expired: 0 });
    expect(shorter.resolveFollowUp({ pool: "openai", responseId: "resp_3" })).toBe(30);
    expect(recordLines()).toHaveLength(1);
  });

  it("rewrites the file before superseded lines pile up", () => {
    const store = open({ maxEntries: 2 });
    for (let index = 1; index <= 500; index += 1) {
      store.record({ pool: "openai", responseId: `resp_${index}`, tokens: index });
    }

    // Never more than 2 * maxEntries + 64 record lines, however many were written.
    expect(recordLines().length).toBeLessThanOrEqual(68);
    const reopened = open({ maxEntries: 2 });
    expect(reopened.resolveFollowUp({ pool: "openai", responseId: "resp_500" })).toBe(
      500,
    );
    expect(reopened.resolveFollowUp({ pool: "openai", responseId: "resp_499" })).toBe(
      499,
    );
    expect(
      reopened.resolveFollowUp({ pool: "openai", responseId: "resp_498" }),
    ).toBeUndefined();
    expect(store.stats("openai").persistFailures).toBe(0);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it("keeps records usable and counts the failure when the file cannot be written", () => {
    const store = open({ maxEntries: 1 });
    rmSync(dir, { recursive: true, force: true });

    // Appends still reach the unlinked file, so the first failure is the
    // rewrite that follows 2 * maxEntries + 64 appended lines.
    for (let index = 1; index <= 70; index += 1) {
      expect(
        store.record({ pool: "openai", responseId: `resp_${index}`, tokens: index }),
      ).toBe(true);
    }

    expect(store.resolveFollowUp({ pool: "openai", responseId: "resp_70" })).toBe(70);
    expect(store.stats("openai").persistFailures).toBeGreaterThanOrEqual(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("records stay in memory");
  });

  it("keeps serving from memory after close()", () => {
    const store = open();
    store.record({ pool: "openai", responseId: "resp_1", tokens: 50 });
    store.close();
    store.close();

    expect(store.record({ pool: "openai", responseId: "resp_2", tokens: 60 })).toBe(
      true,
    );
    expect(store.resolveFollowUp({ pool: "openai", responseId: "resp_2" })).toBe(60);
    expect(recordLines()).toHaveLength(1);
    expect(store.stats("openai").persistFailures).toBe(0);
    expect(warnings).toEqual([]);
  });
});

describe("ResponsesStateStore file handling under failure", () => {
  it("does not append after a failed write, and rewrites the file once it can", () => {
    let failNext = false;
    const store = open(
      {},
      {
        writeSync: (fd, buffer, offset, length) => {
          if (!failNext) return writeSync(fd, buffer, offset, length);
          failNext = false;
          // Part of the line reaches the disk before it fills up.
          writeSync(fd, buffer, offset, Math.min(12, length));
          throw diskFull();
        },
      },
    );
    store.record({ pool: "openai", responseId: "resp_1", tokens: 10 });

    failNext = true;
    expect(store.record({ pool: "openai", responseId: "resp_2", tokens: 20 })).toBe(
      true,
    );
    expect(store.stats("openai").persistFailures).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("records stay in memory");
    const torn = readFileSync(file, "utf8");
    expect(torn.endsWith("\n")).toBe(false);

    // Inside the retry delay nothing is written after the fragment, which
    // would have corrupted this record too.
    store.record({ pool: "openai", responseId: "resp_3", tokens: 30 });
    expect(readFileSync(file, "utf8")).toBe(torn);
    expect(store.stats("openai").persistFailures).toBe(2);
    expect(store.resolveFollowUp({ pool: "openai", responseId: "resp_2" })).toBe(20);

    now += 1_000;
    store.record({ pool: "openai", responseId: "resp_4", tokens: 40 });
    // The rewrite saved all four, including the two that had failed.
    expect(recordedIds()).toEqual(["resp_1", "resp_2", "resp_3", "resp_4"]);
    expect(store.stats("openai").persistFailures).toBe(2);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("writable again; 4 records are on disk");

    store.record({ pool: "openai", responseId: "resp_5", tokens: 50 });
    expect(recordedIds()).toHaveLength(5);

    const reopened = open();
    for (const [id, tokens] of [
      ["resp_1", 10],
      ["resp_2", 20],
      ["resp_3", 30],
      ["resp_4", 40],
      ["resp_5", 50],
    ] as const) {
      expect(reopened.resolveFollowUp({ pool: "openai", responseId: id })).toBe(
        tokens,
      );
    }
    expect(warnings).toHaveLength(2);
  });

  it("stops appending when a rewrite fails and retries it with a growing delay", () => {
    const store = open({ maxEntries: 1 });
    rmSync(dir, { recursive: true, force: true });
    // Appends still reach the unlinked file. The 67th crosses the bound of
    // 2 * maxEntries + 64 lines and needs a rewrite, which cannot succeed.
    for (let index = 1; index <= 67; index += 1) {
      store.record({ pool: "openai", responseId: `resp_${index}`, tokens: index });
    }
    expect(store.stats("openai").persistFailures).toBe(1);
    expect(warnings).toHaveLength(1);

    now += 999;
    store.record({ pool: "openai", responseId: "resp_68", tokens: 68 });
    expect(store.stats("openai").persistFailures).toBe(2);

    // The first retry, one second after the failure, fails as well.
    now += 1;
    store.record({ pool: "openai", responseId: "resp_69", tokens: 69 });
    expect(store.stats("openai").persistFailures).toBe(3);

    // The directory is back, but the next retry is now two seconds away.
    mkdirSync(dir, { recursive: true });
    now += 1_999;
    store.record({ pool: "openai", responseId: "resp_70", tokens: 70 });
    expect(existsSync(file)).toBe(false);
    expect(store.stats("openai").persistFailures).toBe(4);

    now += 1;
    store.record({ pool: "openai", responseId: "resp_71", tokens: 71 });
    expect(readFileSync(file, "utf8").startsWith(HEADER)).toBe(true);
    expect(recordedIds()).toEqual(["resp_71"]);
    expect(store.stats("openai").persistFailures).toBe(4);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("writable again; 1 record is on disk");

    const reopened = open({ maxEntries: 1 });
    expect(reopened.resolveFollowUp({ pool: "openai", responseId: "resp_71" })).toBe(
      71,
    );
  });

  it("recreates a removed file with its header at the next rewrite", () => {
    const store = open({ maxEntries: 1 });
    store.record({ pool: "openai", responseId: "resp_1", tokens: 1 });
    rmSync(file);

    for (let index = 2; index <= 67; index += 1) {
      store.record({ pool: "openai", responseId: `resp_${index}`, tokens: index });
    }

    expect(readFileSync(file, "utf8").startsWith(HEADER)).toBe(true);
    expect(recordedIds()).toEqual(["resp_67"]);
    expect(store.stats("openai").persistFailures).toBe(0);
    expect(warnings).toEqual([]);
    expect(open({ maxEntries: 1 }).size).toBe(1);
  });

  it("starts from a readable file it cannot rewrite, then repairs it", () => {
    const first = open();
    first.record({ pool: "openai", responseId: "resp_1", tokens: 10 });
    first.record({ pool: "openai", responseId: "resp_2", tokens: 20 });
    // A superseded line means the next start has to rewrite the file.
    first.record({ pool: "openai", responseId: "resp_1", tokens: 15 });
    const stale = readFileSync(file, "utf8");

    let failing = true;
    const second = open(
      {},
      {
        writeSync: (fd, buffer, offset, length) => {
          if (failing) throw diskFull();
          return writeSync(fd, buffer, offset, length);
        },
      },
    );
    // A full disk must not keep Tyr from starting with the records it read.
    expect(second.resolveFollowUp({ pool: "openai", responseId: "resp_1" })).toBe(15);
    expect(second.resolveFollowUp({ pool: "openai", responseId: "resp_2" })).toBe(20);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("records stay in memory");
    expect(readFileSync(file, "utf8")).toBe(stale);

    second.record({ pool: "openai", responseId: "resp_3", tokens: 30 });
    expect(readFileSync(file, "utf8")).toBe(stale);
    expect(second.stats("openai").persistFailures).toBe(1);

    failing = false;
    now += 1_000;
    second.record({ pool: "openai", responseId: "resp_4", tokens: 40 });
    expect(recordedIds()).toEqual(["resp_2", "resp_1", "resp_3", "resp_4"]);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it("fails to start when it cannot create the file", () => {
    expect(() =>
      open(
        {},
        {
          writeSync: () => {
            throw diskFull();
          },
        },
      ),
    ).toThrow(/unable to use responsesState\.file .*ENOSPC/);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });
});

describe("ResponsesStateStore loading", () => {
  it("reads records that span read boundaries, including multi-byte text", () => {
    const owner = { tenantId: "ténant-日本-🚀", applicationId: "app" };
    const first = open();
    for (let index = 1; index <= 40; index += 1) {
      first.record({ pool: "pöol", responseId: `resp_${index}`, tokens: index, owner });
    }

    for (const readChunkBytes of [1, 7, 64, 4_096]) {
      const store = open({}, { readChunkBytes });
      expect(store.size).toBe(40);
      expect(
        store.resolveFollowUp({ pool: "pöol", responseId: "resp_40", owner }),
      ).toBe(40);
      expect(
        store.resolveFollowUp({ pool: "pöol", responseId: "resp_1", owner }),
      ).toBe(1);
    }
    expect(warnings).toEqual([]);
  });

  it("finds a partly written last line whatever the read size", () => {
    const first = open();
    first.record({ pool: "openai", responseId: "resp_1", tokens: 50 });
    appendFileSync(file, '{"id":"resp_torn","pool":"openai","tok');
    const torn = readFileSync(file, "utf8");

    for (const readChunkBytes of [1, 5, 1_024]) {
      writeFileSync(file, torn);
      warnings.length = 0;
      const store = open({}, { readChunkBytes });
      expect(store.size).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("partly written last line");
      expect(recordedIds()).toEqual(["resp_1"]);
    }
  });

  it("skips a line longer than any line it writes", () => {
    const record = (id: string, extra: Record<string, unknown> = {}) =>
      `${JSON.stringify({ id, pool: "openai", tokens: 50, at: now, ...extra })}\n`;
    const contents = `${HEADER}${record("resp_1")}${record("resp_big", { note: "x".repeat(70_000) })}${record("resp_2")}`;

    for (const readChunkBytes of [1_000, 1_048_576]) {
      // Loading repairs the file, so each pass starts from the damaged one.
      writeFileSync(file, contents);
      warnings.length = 0;
      const store = open({}, { readChunkBytes });
      expect(store.size).toBe(2);
      expect(
        store.resolveFollowUp({ pool: "openai", responseId: "resp_big" }),
      ).toBeUndefined();
      expect(warnings[0]).toContain("ignored 1 unreadable line");
    }
  });

  it("refuses a large file with no header line and leaves it alone", () => {
    const contents = "x".repeat(300_000);
    writeFileSync(file, contents);

    for (const readChunkBytes of [4_096, 1_048_576]) {
      expect(() => open({}, { readChunkBytes })).toThrow(
        /not a Tyr responses-state file/,
      );
    }
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it(
    "loads and evicts in time proportional to the number of records",
    () => {
      const maxEntries = 150_000;
      const lines = [JSON.stringify({ schema: RESPONSES_STATE_SCHEMA })];
      for (let index = 0; index < 2 * maxEntries + 64; index += 1) {
        lines.push(
          JSON.stringify({ id: `resp_${index}`, pool: "openai", tokens: 1, at: now }),
        );
      }
      writeFileSync(file, `${lines.join("\n")}\n`);

      // Half of these records are evicted while loading. Taking the oldest
      // from the first key of a Map made that quadratic: about 10 seconds at
      // this size. The bound is loose so a slow machine does not fail it.
      const started = performance.now();
      const store = open({ maxEntries });
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(store.size).toBe(maxEntries);

      const steady = performance.now();
      for (let index = 0; index < 20_000; index += 1) {
        store.record({ pool: "openai", responseId: `next_${index}`, tokens: 1 });
      }
      expect(performance.now() - steady).toBeLessThan(5_000);
      expect(store.size).toBe(maxEntries);
      expect(store.stats("openai").evicted).toBe(20_000);
    },
    30_000,
  );
});

describe("ResponsesStateStore options", () => {
  it("rejects unusable options", () => {
    expect(() => new ResponsesStateStore({ file: "  " })).toThrow(
      "responsesState.file must be a non-empty string",
    );
    for (const maxEntries of [0, 1.5, -1]) {
      expect(() => open({ maxEntries })).toThrow(
        "responsesState.maxEntries must be a safe integer >= 1",
      );
    }
    expect(() =>
      open({ maxEntries: MAX_RESPONSES_STATE_MAX_ENTRIES + 1 }),
    ).toThrow(
      `responsesState.maxEntries must be a safe integer <= ${MAX_RESPONSES_STATE_MAX_ENTRIES}`,
    );
    for (const ttlMs of [0, 0.5, -10]) {
      expect(() => open({ ttlMs })).toThrow(
        "responsesState.ttlMs must be a safe integer >= 1",
      );
    }
    // Nothing was created by the rejected options.
    expect(existsSync(file)).toBe(false);
  });
});

describe("recordableResponse", () => {
  it("reads the id and the input plus output tokens of a finished response", () => {
    expect(
      recordableResponse({
        id: "resp_1",
        object: "response",
        status: "completed",
        usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50 },
      }),
    ).toEqual({ id: "resp_1", tokens: 50 });
    // Providers that omit status are still recordable.
    expect(
      recordableResponse({ id: "resp_2", usage: { input_tokens: 7.9, output_tokens: 3 } }),
    ).toEqual({ id: "resp_2", tokens: 10 });
    expect(
      recordableResponse({
        id: "resp_3",
        status: "incomplete",
        usage: { input_tokens: 5, output_tokens: 0 },
      }),
    ).toEqual({ id: "resp_3", tokens: 5 });
  });

  it("returns nothing for a response that cannot be recorded", () => {
    for (const value of [
      null,
      "resp_1",
      [],
      {},
      { id: "resp_1" },
      { id: "resp_1", usage: null },
      { id: "resp_1", usage: { input_tokens: 20 } },
      { id: "resp_1", usage: { input_tokens: -1, output_tokens: 3 } },
      { id: "resp_1", usage: { input_tokens: "20", output_tokens: 3 } },
      { id: "", usage: { input_tokens: 20, output_tokens: 30 } },
      { id: 7, usage: { input_tokens: 20, output_tokens: 30 } },
      {
        id: "r".repeat(MAX_RESPONSE_ID_LENGTH + 1),
        usage: { input_tokens: 20, output_tokens: 30 },
      },
      {
        id: "resp_1",
        status: "in_progress",
        usage: { input_tokens: 20, output_tokens: 30 },
      },
      {
        id: "resp_1",
        status: "queued",
        usage: { input_tokens: 20, output_tokens: 30 },
      },
    ]) {
      expect(recordableResponse(value)).toBeUndefined();
    }
  });
});

describe("recordableStreamResponse", () => {
  const usage = { input_tokens: 20, output_tokens: 30 };

  it("records a response only from an event that shows it is finished", () => {
    for (const status of ["completed", "incomplete", "failed", "cancelled"]) {
      expect(
        recordableStreamResponse({ id: "resp_1", status, usage }, "response.created"),
      ).toEqual({ id: "resp_1", tokens: 50 });
    }
    // Providers that omit status are judged by the event type.
    for (const type of ["response.completed", "response.incomplete", "response.failed"]) {
      expect(recordableStreamResponse({ id: "resp_1", usage }, type)).toEqual({
        id: "resp_1",
        tokens: 50,
      });
    }
  });

  it("ignores usage on an event that does not show the response is finished", () => {
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{ id: "resp_1", usage }, "response.created"],
      [{ id: "resp_1", usage }, "response.in_progress"],
      [{ id: "resp_1", usage }, "response.output_text.delta"],
      [{ id: "resp_1", usage }, undefined],
      [{ id: "resp_1", status: "in_progress", usage }, "response.completed"],
      [{ id: "resp_1", status: "queued", usage }, "response.completed"],
      [{ id: "resp_1", status: "streaming", usage }, "response.completed"],
      [{ id: "resp_1", status: null, usage }, "response.completed"],
      [{ id: "resp_1", status: "completed" }, "response.completed"],
      [{ status: "completed", usage }, "response.completed"],
    ];
    for (const [response, type] of cases) {
      expect(recordableStreamResponse(response, type)).toBeUndefined();
    }
    expect(recordableStreamResponse(null, "response.completed")).toBeUndefined();
  });
});
