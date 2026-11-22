/**
 * Response memory for OpenAI Responses follow-ups.
 *
 * A request that names `previous_response_id` carries none of the earlier
 * turns in its body, so its input tokens cannot be estimated from the request
 * alone. This store remembers the size of each response Tyr proxied, as the
 * provider reported it, so a follow-up can reserve its own estimate plus that
 * size. A follow-up that names a response the store does not hold is refused
 * before the provider is called.
 *
 * Records are bounded in number and in age, belong to the tenant and
 * application that created them, and are appended to a state file before the
 * reply that created them ends, so a process killed right after a reply keeps
 * the record.
 */
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/** First line of every state file. Later Tyr releases may add newer schemas. */
export const RESPONSES_STATE_SCHEMA = "tyr.responses-state.v1";
const RESPONSES_STATE_SCHEMA_PREFIX = "tyr.responses-state.";

export const DEFAULT_RESPONSES_STATE_MAX_ENTRIES = 10_000;
export const MAX_RESPONSES_STATE_MAX_ENTRIES = 1_000_000;
/** Thirty days, OpenAI's default retention for stored responses. */
export const DEFAULT_RESPONSES_STATE_TTL_MS = 2_592_000_000;
/** Longer provider ids are not recorded, which bounds every state-file line. */
export const MAX_RESPONSE_ID_LENGTH = 512;

const MAX_OWNER_FIELD_LENGTH = 1_024;
/**
 * No line the store writes is longer than this, and a longer line in a file
 * is skipped instead of buffered, so loading uses bounded memory per line.
 */
const MAX_LINE_BYTES = 65_536;
/** Superseded lines tolerated beyond `2 * maxEntries` before a rewrite. */
const COMPACTION_SLACK_LINES = 64;
const REWRITE_CHUNK_CHARACTERS = 64 * 1_024;
const DEFAULT_READ_CHUNK_BYTES = 1_048_576;
/** First wait before a failed state file is rewritten; doubles per failure. */
const INITIAL_REPAIR_DELAY_MS = 1_000;
const MAX_REPAIR_DELAY_MS = 300_000;
/** A response in one of these states has not produced its final usage yet. */
const UNFINISHED_RESPONSE_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "in_progress",
]);
/** Statuses after which usage is final. `cancelled` is the API's spelling. */
const FINAL_RESPONSE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
]);
/** Stream lifecycle events that carry a finished response. */
const FINAL_RESPONSE_EVENTS: ReadonlySet<string> = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

export type ResponsesStateOptions = Readonly<{
  /**
   * State file. Created with its parent directories when missing. Tyr replaces
   * it by renaming a temporary file written next to it, so the directory must
   * be writable. Each Tyr process needs its own file.
   */
  file: string;
  /** Most records kept at once; the oldest is dropped first. Default: 10,000. */
  maxEntries?: number;
  /** Milliseconds a record stays usable. Default: 2,592,000,000 (30 days). */
  ttlMs?: number;
}>;

/** Verified identity a record belongs to. Absent when identity is not configured. */
export type ResponsesStateOwner = Readonly<{
  tenantId?: string;
  applicationId?: string;
}>;

/** Per-pool view published as `tyr.responsesState` in `/stats`. */
export type ResponsesStatePoolStats = {
  /** Usable records created through this pool. */
  records: number;
  /** Records written since start. */
  recorded: number;
  /** Records dropped since start to stay within `maxEntries`. */
  evicted: number;
  /** Records dropped since start because they outlived `ttlMs`. */
  expired: number;
  /** Follow-ups to this pool that named a usable record. */
  followUps: number;
  /** Recorded tokens of the responses those follow-ups named. */
  priorTokens: number;
  /** Follow-ups to this pool refused because no usable record exists. */
  refused: number;
  /**
   * Records that were not on disk when `record()` returned, plus failed
   * rewrites. A record stays usable in memory and is written by the next
   * successful rewrite.
   */
  persistFailures: number;
};

/** Test seams. Production code uses the wall clock, `console.warn` and `fs`. */
export type ResponsesStateDependencies = Readonly<{
  now?: () => number;
  warn?: (message: string) => void;
  /** Stands in for `fs.writeSync` on every state-file write. */
  writeSync?: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ) => number;
  /** Bytes read per call while loading. */
  readChunkBytes?: number;
}>;

/** One record, linked to its neighbors in age order. */
type Entry = {
  readonly id: string;
  readonly pool: string;
  readonly tokens: number;
  /** Wall-clock milliseconds when the record was written. */
  readonly at: number;
  readonly tenantId?: string;
  readonly applicationId?: string;
  older: Entry | undefined;
  newer: Entry | undefined;
};

type FileScan =
  | "missing"
  | { recordLines: number; invalid: number; tornTail: boolean };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function idAndTokens(
  response: Record<string, unknown>,
): { id: string; tokens: number } | undefined {
  const id = response["id"];
  if (!isBoundedString(id, MAX_RESPONSE_ID_LENGTH)) return undefined;
  const usage = response["usage"];
  if (!isPlainObject(usage)) return undefined;
  const input = usage["input_tokens"];
  const output = usage["output_tokens"];
  if (!isTokenCount(input) || !isTokenCount(output)) return undefined;
  const tokens = Math.floor(input) + Math.floor(output);
  if (!Number.isSafeInteger(tokens)) return undefined;
  return { id, tokens };
}

/**
 * Reads the id and size from the JSON body of a non-streaming Responses
 * reply. The reply is complete once its body has arrived, so it is recorded
 * unless it has no usable id, carries no provider usage, or describes a
 * response that is still running.
 */
export function recordableResponse(
  value: unknown,
): { id: string; tokens: number } | undefined {
  if (!isPlainObject(value)) return undefined;
  const status = value["status"];
  if (typeof status === "string" && UNFINISHED_RESPONSE_STATUSES.has(status)) {
    return undefined;
  }
  return idAndTokens(value);
}

/**
 * Reads the id and size from the `response` object of a stream lifecycle
 * event. A stream can end early, so this needs evidence that the response is
 * finished: a final `status`, or, when the response has no status, a final
 * event type. Usage on any earlier event would record too small a size.
 */
export function recordableStreamResponse(
  value: unknown,
  eventType: unknown,
): { id: string; tokens: number } | undefined {
  if (!isPlainObject(value)) return undefined;
  const status = value["status"];
  const finished =
    status === undefined
      ? typeof eventType === "string" && FINAL_RESPONSE_EVENTS.has(eventType)
      : typeof status === "string" && FINAL_RESPONSE_STATUSES.has(status);
  return finished ? idAndTokens(value) : undefined;
}

function serializeRecord(entry: Entry): string {
  return `${JSON.stringify({
    id: entry.id,
    pool: entry.pool,
    tokens: entry.tokens,
    at: entry.at,
    ...(entry.tenantId === undefined ? {} : { tenantId: entry.tenantId }),
    ...(entry.applicationId === undefined
      ? {}
      : { applicationId: entry.applicationId }),
  })}\n`;
}

function parseRecordLine(line: string): Entry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const id = parsed["id"];
  const pool = parsed["pool"];
  const tokens = parsed["tokens"];
  const at = parsed["at"];
  const tenantId = parsed["tenantId"];
  const applicationId = parsed["applicationId"];
  if (
    !isBoundedString(id, MAX_RESPONSE_ID_LENGTH) ||
    typeof pool !== "string" ||
    pool.length === 0 ||
    !Number.isSafeInteger(tokens) ||
    (tokens as number) < 0 ||
    !Number.isSafeInteger(at) ||
    (at as number) < 0 ||
    (tenantId !== undefined &&
      !isBoundedString(tenantId, MAX_OWNER_FIELD_LENGTH)) ||
    (applicationId !== undefined &&
      !isBoundedString(applicationId, MAX_OWNER_FIELD_LENGTH))
  ) {
    return undefined;
  }
  return {
    id,
    pool,
    tokens: tokens as number,
    at: at as number,
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(applicationId === undefined ? {} : { applicationId }),
    older: undefined,
    newer: undefined,
  };
}

function emptyPoolStats(): ResponsesStatePoolStats {
  return {
    records: 0,
    recorded: 0,
    evicted: 0,
    expired: 0,
    followUps: 0,
    priorTokens: 0,
    refused: 0,
    persistFailures: 0,
  };
}

function assertIntegerOption(
  value: number | undefined,
  field: string,
  max?: number,
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a safe integer >= 1`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${field} must be a safe integer <= ${max}`);
  }
}

/** The configured path holds something this release must not read or replace. */
export class ResponsesStateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponsesStateFileError";
  }
}

export class ResponsesStateStore {
  /** Absolute path of the state file. */
  readonly file: string;
  readonly maxEntries: number;
  readonly ttlMs: number;

  readonly #now: () => number;
  readonly #warn: (message: string) => void;
  readonly #writeSync: NonNullable<ResponsesStateDependencies["writeSync"]>;
  readonly #readChunkBytes: number;
  readonly #entries = new Map<string, Entry>();
  /**
   * Records in age order. Eviction and expiry only ever take the oldest, and
   * a linked list gives that in constant time. Reading the first key of a Map
   * instead walks over every key deleted before it.
   */
  #oldest: Entry | undefined;
  #newest: Entry | undefined;
  readonly #pools = new Map<string, ResponsesStatePoolStats>();
  /**
   * Append descriptor. Undefined while the file is suspended: after a failed
   * write its last line may be incomplete, so nothing more is appended until
   * a rewrite has replaced it.
   */
  #fd: number | undefined;
  /** Record lines currently in the file, including superseded ones. */
  #fileLines = 0;
  readonly #compactAtLines: number;
  #suspended = false;
  #repairDelayMs = INITIAL_REPAIR_DELAY_MS;
  #repairScheduledAt = 0;
  #closed = false;

  constructor(
    options: ResponsesStateOptions,
    dependencies: ResponsesStateDependencies = {},
  ) {
    if (typeof options.file !== "string" || options.file.trim().length === 0) {
      throw new Error("responsesState.file must be a non-empty string");
    }
    assertIntegerOption(
      options.maxEntries,
      "responsesState.maxEntries",
      MAX_RESPONSES_STATE_MAX_ENTRIES,
    );
    assertIntegerOption(options.ttlMs, "responsesState.ttlMs");

    this.file = resolve(options.file);
    this.maxEntries = options.maxEntries ?? DEFAULT_RESPONSES_STATE_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_RESPONSES_STATE_TTL_MS;
    this.#now = dependencies.now ?? Date.now;
    this.#warn = dependencies.warn ?? ((message) => console.warn(message));
    this.#writeSync = dependencies.writeSync ?? writeSync;
    this.#readChunkBytes = dependencies.readChunkBytes ?? DEFAULT_READ_CHUNK_BYTES;
    this.#compactAtLines = 2 * this.maxEntries + COMPACTION_SLACK_LINES;

    try {
      this.#load();
    } catch (error) {
      if (error instanceof ResponsesStateFileError) throw error;
      throw new Error(
        `unable to use responsesState.file ${this.file}: ${errorDetail(error)}`,
        { cause: error },
      );
    }
  }

  /** Usable records across every pool. */
  get size(): number {
    this.#purgeExpired(this.#now(), true);
    return this.#entries.size;
  }

  /**
   * Returns the recorded size of the response a follow-up names, or undefined
   * when the follow-up must be refused: the id was never recorded here, its
   * record was dropped or has expired, or it belongs to another owner. The
   * three cases are deliberately indistinguishable to the caller.
   */
  resolveFollowUp(input: {
    /** Pool the follow-up is routed to. */
    pool: string;
    responseId: string;
    owner?: ResponsesStateOwner;
  }): number | undefined {
    const now = this.#now();
    this.#purgeExpired(now, true);
    const requester = this.#poolStats(input.pool);
    const entry = this.#entries.get(input.responseId);
    if (entry === undefined) {
      requester.refused += 1;
      return undefined;
    }
    if (this.#isExpired(entry, now)) {
      this.#drop(entry);
      this.#poolStats(entry.pool).expired += 1;
      requester.refused += 1;
      return undefined;
    }
    if (
      entry.tenantId !== input.owner?.tenantId ||
      entry.applicationId !== input.owner?.applicationId
    ) {
      requester.refused += 1;
      return undefined;
    }
    requester.followUps += 1;
    requester.priorTokens += entry.tokens;
    return entry.tokens;
  }

  /**
   * Records a finished response and appends it to the state file before
   * returning. Returns false when the response cannot be recorded. Never
   * throws: a failed write is counted and the record stays usable in memory.
   */
  record(input: {
    /** Pool that admitted the response. */
    pool: string;
    responseId: string;
    /** Provider-reported input plus output tokens. */
    tokens: number;
    owner?: ResponsesStateOwner;
  }): boolean {
    const tenantId = input.owner?.tenantId;
    const applicationId = input.owner?.applicationId;
    if (
      !isBoundedString(input.responseId, MAX_RESPONSE_ID_LENGTH) ||
      !Number.isSafeInteger(input.tokens) ||
      input.tokens < 0 ||
      (tenantId !== undefined &&
        !isBoundedString(tenantId, MAX_OWNER_FIELD_LENGTH)) ||
      (applicationId !== undefined &&
        !isBoundedString(applicationId, MAX_OWNER_FIELD_LENGTH))
    ) {
      return false;
    }

    const now = this.#now();
    this.#purgeExpired(now, true);
    const existing = this.#entries.get(input.responseId);
    if (
      existing !== undefined &&
      existing.pool === input.pool &&
      existing.tokens === input.tokens &&
      existing.tenantId === tenantId &&
      existing.applicationId === applicationId
    ) {
      // A stream can report the same final usage more than once.
      return true;
    }

    const entry: Entry = {
      id: input.responseId,
      pool: input.pool,
      tokens: input.tokens,
      at: now,
      ...(tenantId === undefined ? {} : { tenantId }),
      ...(applicationId === undefined ? {} : { applicationId }),
      older: undefined,
      newer: undefined,
    };
    const line = serializeRecord(entry);
    // Never keep in memory what could not be read back after a restart.
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return false;

    this.#put(entry);
    this.#poolStats(input.pool).recorded += 1;
    this.#evictOverflow(true);
    this.#persist(entry, line);
    return true;
  }

  /** Counters for one pool. Pools that never used the store report zeros. */
  stats(pool: string): ResponsesStatePoolStats {
    this.#purgeExpired(this.#now(), true);
    return { ...(this.#pools.get(pool) ?? emptyPoolStats()) };
  }

  /** Releases the state file. Later records stay in memory only. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeFile();
  }

  #poolStats(pool: string): ResponsesStatePoolStats {
    let stats = this.#pools.get(pool);
    if (stats === undefined) {
      stats = emptyPoolStats();
      this.#pools.set(pool, stats);
    }
    return stats;
  }

  #isExpired(entry: Entry, now: number): boolean {
    return now - entry.at >= this.ttlMs;
  }

  /** Adds a record as the newest, replacing any record with the same id. */
  #put(entry: Entry): void {
    const existing = this.#entries.get(entry.id);
    if (existing !== undefined) this.#drop(existing);
    this.#entries.set(entry.id, entry);
    entry.older = this.#newest;
    entry.newer = undefined;
    if (this.#newest === undefined) this.#oldest = entry;
    else this.#newest.newer = entry;
    this.#newest = entry;
    this.#poolStats(entry.pool).records += 1;
  }

  #drop(entry: Entry): void {
    this.#entries.delete(entry.id);
    if (entry.older === undefined) this.#oldest = entry.newer;
    else entry.older.newer = entry.newer;
    if (entry.newer === undefined) this.#newest = entry.older;
    else entry.newer.older = entry.older;
    entry.older = undefined;
    entry.newer = undefined;
    this.#poolStats(entry.pool).records -= 1;
  }

  #evictOverflow(count: boolean): void {
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#oldest;
      if (oldest === undefined) return;
      this.#drop(oldest);
      if (count) this.#poolStats(oldest.pool).evicted += 1;
    }
  }

  /** Records are kept oldest first, so expired ones are at the front. */
  #purgeExpired(now: number, count: boolean): void {
    for (
      let oldest = this.#oldest;
      oldest !== undefined && this.#isExpired(oldest, now);
      oldest = this.#oldest
    ) {
      this.#drop(oldest);
      if (count) this.#poolStats(oldest.pool).expired += 1;
    }
  }

  #load(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const scan = this.#scan();
    if (scan === "missing") {
      // No state exists yet. If the file cannot be created here, that is a
      // deployment mistake to report at startup, not something to run past.
      this.#rewrite();
      this.#openForAppend();
      return;
    }

    // Records dropped here were lost before this process started, so they
    // are not counted.
    this.#purgeExpired(this.#now(), false);
    if (scan.tornTail || scan.invalid > 0) {
      this.#warn(
        `tyr responses state: ignored ${scan.invalid} unreadable ${scan.invalid === 1 ? "line" : "lines"}${scan.tornTail ? " and a partly written last line" : ""} in ${this.file}; follow-ups to those responses are refused as unknown`,
      );
    }
    try {
      if (
        scan.tornTail ||
        scan.invalid > 0 ||
        this.#entries.size !== scan.recordLines
      ) {
        // Rewrite so the file holds exactly the usable records and the next
        // append starts on a line boundary.
        this.#rewrite();
      } else {
        this.#fileLines = scan.recordLines;
      }
      this.#openForAppend();
    } catch (error) {
      // The records were read, so serve them from memory. Refusing to start
      // because of a full disk would take every route down with it.
      this.#suspend(error);
    }
  }

  /**
   * Reads the file in fixed-size chunks and replays its records. Memory use
   * is bounded by the usable records and one line, whatever the file's size.
   */
  #scan(): FileScan {
    let fd: number;
    try {
      fd = openSync(this.file, "r");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "missing";
      throw error;
    }

    const chunk = Buffer.allocUnsafe(this.#readChunkBytes);
    let carry: Buffer[] = [];
    let carryBytes = 0;
    // The line being read is already longer than any line Tyr writes.
    let oversized = false;
    let sawBytes = false;
    let lines = 0;
    let recordLines = 0;
    let invalid = 0;

    try {
      for (;;) {
        const read = readSync(fd, chunk, 0, chunk.length, null);
        if (read === 0) break;
        sawBytes = true;
        const view = chunk.subarray(0, read);
        let start = 0;
        for (;;) {
          // 0x0a never occurs inside a multi-byte UTF-8 sequence, so lines
          // are split on bytes and decoded whole.
          const newline = view.indexOf(0x0a, start);
          if (newline === -1) break;
          const segment = view.subarray(start, newline);
          start = newline + 1;
          const line =
            oversized || carryBytes + segment.length > MAX_LINE_BYTES
              ? undefined
              : carryBytes === 0
                ? segment.toString("utf8")
                : Buffer.concat([...carry, segment]).toString("utf8");
          carry = [];
          carryBytes = 0;
          oversized = false;

          if (lines === 0) {
            this.#assertHeader(line ?? "");
          } else {
            recordLines += 1;
            const entry = line === undefined ? undefined : parseRecordLine(line);
            if (entry === undefined) {
              invalid += 1;
            } else {
              this.#put(entry);
              // The bound may be smaller than when the file was written.
              this.#evictOverflow(false);
            }
          }
          lines += 1;
        }

        const rest = view.subarray(start);
        if (rest.length === 0) continue;
        if (oversized || carryBytes + rest.length > MAX_LINE_BYTES) {
          // A first line this long is not Tyr's header.
          if (lines === 0) throw this.#notStateFile();
          oversized = true;
          carry = [];
          carryBytes = 0;
        } else {
          carry.push(Buffer.from(rest));
          carryBytes += rest.length;
        }
      }
    } finally {
      closeSync(fd);
    }

    if (lines === 0) {
      if (!sawBytes) return "missing";
      // The only content Tyr can leave without a newline is a first write
      // that was interrupted. Anything else is someone else's file.
      const header = JSON.stringify({ schema: RESPONSES_STATE_SCHEMA });
      if (header.startsWith(Buffer.concat(carry).toString("utf8"))) {
        return "missing";
      }
      throw this.#notStateFile();
    }
    return { recordLines, invalid, tornTail: carryBytes > 0 || oversized };
  }

  #assertHeader(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw this.#notStateFile();
    }
    const schema = isPlainObject(parsed) ? parsed["schema"] : undefined;
    if (schema === RESPONSES_STATE_SCHEMA) return;
    if (
      typeof schema === "string" &&
      schema.startsWith(RESPONSES_STATE_SCHEMA_PREFIX)
    ) {
      throw new ResponsesStateFileError(
        `responsesState.file ${this.file} uses schema ${schema}, which this Tyr release cannot read; it supports ${RESPONSES_STATE_SCHEMA}`,
      );
    }
    throw this.#notStateFile();
  }

  #notStateFile(): ResponsesStateFileError {
    return new ResponsesStateFileError(
      `responsesState.file ${this.file} exists but is not a Tyr responses-state file; Tyr will not overwrite it`,
    );
  }

  #writeAll(fd: number, text: string): void {
    const buffer = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      offset += this.#writeSync(fd, buffer, offset, buffer.length - offset);
    }
  }

  /**
   * Replaces the file with a header and every usable record, oldest first.
   * The new contents are written to a temporary file and renamed into place,
   * so a reader sees the old file or the new one, never part of either.
   */
  #rewrite(): void {
    const temporaryPath = `${this.file}.${process.pid}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporaryPath, "w", 0o600);
      let chunk = `${JSON.stringify({ schema: RESPONSES_STATE_SCHEMA })}\n`;
      for (let entry = this.#oldest; entry !== undefined; entry = entry.newer) {
        chunk += serializeRecord(entry);
        if (chunk.length >= REWRITE_CHUNK_CHARACTERS) {
          this.#writeAll(fd, chunk);
          chunk = "";
        }
      }
      this.#writeAll(fd, chunk);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporaryPath, this.file);
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // The write already failed; that error is the one to report.
        }
      }
      rmSync(temporaryPath, { force: true });
    }
    this.#fileLines = this.#entries.size;
  }

  /**
   * Opens the existing file for appending. It never creates one: a file made
   * here would have no header, and the next start would refuse it.
   */
  #openForAppend(): void {
    this.#fd = openSync(this.file, constants.O_WRONLY | constants.O_APPEND);
  }

  #closeFile(): void {
    if (this.#fd === undefined) return;
    const fd = this.#fd;
    this.#fd = undefined;
    try {
      closeSync(fd);
    } catch {
      // Nothing useful can be done with a failed close.
    }
  }

  #rewriteAndReopen(): void {
    // The open descriptor would keep appending to the replaced file.
    this.#closeFile();
    this.#rewrite();
    this.#openForAppend();
  }

  #persist(entry: Entry, line: string): void {
    if (this.#closed) return;
    if (this.#fd === undefined) {
      this.#repair(entry.pool);
      return;
    }
    try {
      this.#writeAll(this.#fd, line);
      this.#fileLines += 1;
      if (this.#fileLines > this.#compactAtLines) this.#rewriteAndReopen();
    } catch (error) {
      this.#poolStats(entry.pool).persistFailures += 1;
      this.#suspend(error);
    }
  }

  /**
   * Stops appending after a failed write. The file may now end in part of a
   * line, and appending after it would corrupt the next record as well.
   */
  #suspend(error: unknown): void {
    this.#closeFile();
    this.#repairDelayMs = INITIAL_REPAIR_DELAY_MS;
    this.#repairScheduledAt = this.#now();
    if (this.#suspended) return;
    this.#suspended = true;
    this.#warn(
      `tyr responses state: write to ${this.file} failed (${errorDetail(error)}); records stay in memory until the file can be rewritten`,
    );
  }

  /**
   * Called for each record while the file is suspended. Retries a full
   * rewrite with exponential backoff, because a rewrite costs as much as the
   * whole file and may keep failing. A successful rewrite also saves every
   * record that could not be written in the meantime, including this one.
   */
  #repair(pool: string): void {
    const now = this.#now();
    const elapsed = now - this.#repairScheduledAt;
    // A clock that moved backward must not postpone the retry indefinitely.
    if (elapsed >= this.#repairDelayMs || elapsed < 0) {
      try {
        this.#rewriteAndReopen();
        this.#suspended = false;
        this.#warn(
          `tyr responses state: ${this.file} is writable again; ${this.#entries.size} ${this.#entries.size === 1 ? "record is" : "records are"} on disk`,
        );
        return;
      } catch {
        this.#closeFile();
        this.#repairDelayMs = Math.min(
          this.#repairDelayMs * 2,
          MAX_REPAIR_DELAY_MS,
        );
        this.#repairScheduledAt = now;
      }
    }
    this.#poolStats(pool).persistFailures += 1;
  }
}
