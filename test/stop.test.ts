import { describe, expect, it } from "vitest";
import {
  LLMAdmissionStoppedError,
  LLMBulkheadRejectedError,
  type LLMRequest,
} from "async-bulkhead-llm";
import {
  createPools,
  MAX_TAKE_BACK_GRACE_MS,
  type AdmissionRunContext,
  type Pool,
  type PoolConfig,
} from "../src/pools.js";
import { TyrTelemetry } from "../src/telemetry.js";

function poolConfig(overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    name: "stoppable",
    modelPrefixes: ["gpt"],
    model: "gpt-4o",
    maxConcurrent: 2,
    budget: 10_000,
    adaptiveEstimation: { enabled: false },
    ...overrides,
  };
}

/** The same pool with no token budget, so only concurrency is limited. */
function unbudgeted(overrides: Partial<PoolConfig> = {}): PoolConfig {
  const config = poolConfig(overrides);
  delete config.budget;
  delete config.adaptiveEstimation;
  return config;
}

function request(maxTokens = 1_000, content = "stop policy test"): LLMRequest {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content }],
    max_tokens: maxTokens,
  };
}

type HeldCall = {
  /** Settles like `pool.run`: with the callback's value, or the stop. */
  readonly running: Promise<string>;
  /** Resolves once the callback has been called. */
  readonly started: Promise<void>;
  readonly signal: AbortSignal | undefined;
  readonly context: AdmissionRunContext;
  /** Lets the callback return, as an upstream call that ended would. */
  finish(value?: string): void;
};

/** Admits a request whose callback stays running until `finish` is called. */
function hold(
  pool: Pool,
  llmRequest: LLMRequest = request(),
  priority: "normal" | "high" = "normal",
): HeldCall {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let finish!: (value: string) => void;
  let signal: AbortSignal | undefined;
  let context: AdmissionRunContext | undefined;
  const running = pool.run(
    llmRequest,
    pool.prepare(llmRequest, priority),
    (callbackSignal, callbackContext) => {
      signal = callbackSignal;
      context = callbackContext;
      markStarted();
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
    { priority },
  );
  // A stop rejects `running` before the test awaits it.
  running.catch(() => undefined);
  return {
    running,
    started,
    get signal() {
      return signal;
    },
    get context() {
      if (context === undefined) throw new Error("callback has not started");
      return context;
    },
    finish: (value = "done") => finish(value),
  };
}

const settle = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("stop policy configuration", () => {
  it("rejects a policy that is malformed or cannot apply to the pool", () => {
    const cases: Array<[PoolConfig, RegExp]> = [
      [
        poolConfig({ stop: [] as never }),
        /pools\[0\]\.stop must be an object/,
      ],
      [
        poolConfig({ stop: null as never }),
        /pools\[0\]\.stop must be an object/,
      ],
      [
        poolConfig({ stop: {} }),
        /pools\[0\]\.stop must set overrunAllowanceTokens or takeBackGraceMs/,
      ],
      [
        poolConfig({ stop: { graceMs: 5 } as never }),
        /pools\[0\]\.stop contains unknown property "graceMs"/,
      ],
      [
        poolConfig({ stop: { overrunAllowanceTokens: -1 } }),
        /pools\[0\]\.stop\.overrunAllowanceTokens must be a safe integer >= 0/,
      ],
      [
        poolConfig({ stop: { overrunAllowanceTokens: 1.5 } }),
        /pools\[0\]\.stop\.overrunAllowanceTokens must be a safe integer >= 0/,
      ],
      [
        poolConfig({ stop: { takeBackGraceMs: -1 } }),
        /pools\[0\]\.stop\.takeBackGraceMs must be a safe integer >= 0/,
      ],
      [
        poolConfig({ stop: { takeBackGraceMs: MAX_TAKE_BACK_GRACE_MS + 1 } }),
        /pools\[0\]\.stop\.takeBackGraceMs must be <= 2147483647/,
      ],
      [
        unbudgeted({ stop: { overrunAllowanceTokens: 0 } }),
        /pools\[0\]\.stop\.overrunAllowanceTokens requires pools\[0\]\.budget/,
      ],
      [
        poolConfig({ admissionMode: "observe", stop: { takeBackGraceMs: 0 } }),
        /pools\[0\]\.stop requires pools\[0\]\.admissionMode to be "enforce"/,
      ],
    ];
    for (const [config, message] of cases) {
      expect(() => createPools([config])).toThrow(message);
    }
  });

  it("accepts the largest grace period and a take-back policy without a budget", () => {
    const pools = createPools([
      unbudgeted({ stop: { takeBackGraceMs: MAX_TAKE_BACK_GRACE_MS } }),
    ]);

    expect(pools.limits().stoppable).toEqual({
      revision: 1,
      maxConcurrent: 2,
      maxQueue: 0,
      stop: { takeBackGraceMs: MAX_TAKE_BACK_GRACE_MS },
    });
  });
});

describe("stating the stop policy", () => {
  it("leaves a pool without a policy at its configured revision", () => {
    const pools = createPools([poolConfig({ initialRevision: 7 })]);

    expect(pools.limits().stoppable).toEqual({
      revision: 7,
      maxConcurrent: 2,
      maxQueue: 0,
      tokenBudget: { budget: 10_000, highPriorityReserve: 0 },
    });
    expect(pools.stats().stoppable?.tyr).not.toHaveProperty("stop");
  });

  it("starts an open pool at its configured revision with the policy applied", () => {
    const stop = { overrunAllowanceTokens: 500, takeBackGraceMs: 2_000 };
    const pools = createPools([poolConfig({ initialRevision: 100, stop })]);

    expect(pools.limits().stoppable).toEqual({
      revision: 100,
      maxConcurrent: 2,
      maxQueue: 0,
      tokenBudget: { budget: 10_000, highPriorityReserve: 0 },
      stop,
    });
    expect(pools.stats().stoppable?.tyr.stop).toEqual({
      policy: stop,
      stopped: 0,
      stoppedByCause: { overrun: 0, limits: 0, drain_deadline: 0 },
    });
  });

  it("starts an open pool at revision 1 when the configured revision is 0", () => {
    for (const initialRevision of [undefined, 0]) {
      const pools = createPools([
        poolConfig({
          ...(initialRevision === undefined ? {} : { initialRevision }),
          stop: { takeBackGraceMs: 50 },
        }),
      ]);

      expect(pools.limits().stoppable).toMatchObject({
        revision: 1,
        stop: { takeBackGraceMs: 50 },
      });
    }
  });

  it("keeps class limits and the high-priority reserve when it states the policy at startup", () => {
    const pools = createPools([
      poolConfig({
        initialRevision: 4,
        highPriorityReserve: 1_000,
        admissionClasses: {
          defaultClass: "standard",
          classes: {
            standard: { protectedConcurrent: 1, maxInFlightTokens: 6_000 },
            batch: { maxConcurrent: 1 },
          },
        },
        stop: { overrunAllowanceTokens: 0 },
      }),
    ]);

    expect(pools.limits().stoppable).toEqual({
      revision: 4,
      maxConcurrent: 2,
      maxQueue: 0,
      tokenBudget: { budget: 10_000, highPriorityReserve: 1_000 },
      admissionClasses: {
        standard: { protectedConcurrent: 1, maxInFlightTokens: 6_000 },
        batch: { maxConcurrent: 1 },
      },
      stop: { overrunAllowanceTokens: 0 },
    });
  });

  it("leaves a pool that starts closed at its revision until the first update", async () => {
    const stop = { takeBackGraceMs: 10 };
    const pools = createPools([poolConfig({ maxConcurrent: 0, stop })]);

    // A Latchflo-managed pool must still be at revision 0 for its first grant.
    expect(pools.limits().stoppable).toEqual({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
      tokenBudget: { budget: 10_000, highPriorityReserve: 0 },
    });
    expect(pools.stats().stoppable?.tyr.stop).toMatchObject({ policy: stop });

    const result = pools.applyLimits([
      {
        pool: "stoppable",
        limits: {
          revision: 1,
          maxConcurrent: 1,
          maxQueue: 0,
          tokenBudget: { budget: 10_000, highPriorityReserve: 0 },
        },
      },
    ]);
    expect(result).toMatchObject({ applied: true });
    expect(pools.limits().stoppable).toMatchObject({ revision: 1, stop });

    // The first request it admits can be aborted by a stop.
    const pool = pools.get("stoppable")!;
    const held = hold(pool);
    await held.started;
    pools.applyLimits([
      {
        pool: "stoppable",
        limits: {
          revision: 2,
          maxConcurrent: 0,
          maxQueue: 0,
          tokenBudget: { budget: 10_000, highPriorityReserve: 0 },
        },
      },
    ]);
    await expect(held.running).rejects.toMatchObject({ cause: "limits" });
    expect(held.signal?.aborted).toBe(true);
    held.finish();
  });

  it("states the policy again on every limits update and ignores one the update supplies", () => {
    const stop = { overrunAllowanceTokens: 500, takeBackGraceMs: 2_000 };
    const pools = createPools([poolConfig({ stop })]);
    const limits = (revision: number, extra: object = {}) => ({
      revision,
      maxConcurrent: 4,
      maxQueue: 0,
      tokenBudget: { budget: 20_000, highPriorityReserve: 0 },
      ...extra,
    });

    expect(
      pools.applyLimits([{ pool: "stoppable", limits: limits(2) }]),
    ).toMatchObject({ applied: true });
    expect(pools.limits().stoppable).toEqual({ ...limits(2), stop });

    // Neither the checked path nor the pool's own controller reads `stop`.
    pools.applyLimits([
      {
        pool: "stoppable",
        limits: limits(3, { stop: { overrunAllowanceTokens: 0 } }),
      },
    ]);
    expect(pools.limits().stoppable).toEqual({ ...limits(3), stop });
    pools
      .get("stoppable")!
      .controller.applyLimits(limits(4, { stop: { takeBackGraceMs: 0 } }));
    expect(pools.limits().stoppable).toEqual({ ...limits(4), stop });
  });

  it("drops a stop policy passed to the controller of a pool without one", async () => {
    const pools = createPools([poolConfig()]);
    const pool = pools.get("stoppable")!;
    const held = hold(pool);
    await held.started;

    pool.controller.applyLimits({
      revision: 1,
      maxConcurrent: 0,
      maxQueue: 0,
      tokenBudget: { budget: 10_000, highPriorityReserve: 0 },
      stop: { takeBackGraceMs: 0 },
    });
    expect(pools.limits().stoppable).not.toHaveProperty("stop");
    await settle(25);
    expect(held.signal?.aborted ?? false).toBe(false);
    expect(pool.stats().llm.stopped).toBeUndefined();

    held.finish();
    await expect(held.running).resolves.toBe("done");
  });

  it("records the applied policy on admission provenance", async () => {
    const stop = { takeBackGraceMs: 1_000 };
    const pools = createPools([poolConfig({ stop })]);
    const pool = pools.get("stoppable")!;
    const held = hold(pool);
    await held.started;

    expect(pool.stats().tyr.admissionProvenance.events[0]).toMatchObject({
      limitRevision: 1,
      limits: {
        revision: 1,
        maxConcurrent: 2,
        maxQueue: 0,
        tokenBudget: { budget: 10_000, highPriorityReserve: 0 },
        stop,
      },
    });
    held.finish();
    await held.running;

    const plain = createPools([poolConfig()]).get("stoppable")!;
    const unstoppable = hold(plain);
    await unstoppable.started;
    expect(
      plain.stats().tyr.admissionProvenance.events[0]?.limits,
    ).not.toHaveProperty("stop");
    unstoppable.finish();
    await unstoppable.running;
  });
});

describe("overrun stops", () => {
  it("stops a request once its hold passes its reservation by more than the allowance", async () => {
    const pools = createPools([
      poolConfig({
        stop: { overrunAllowanceTokens: 100 },
        // The conservative hold: reported input plus the reserved output.
        progressiveReconciliation: { enabled: false },
      }),
    ]);
    const pool = pools.get("stoppable")!;
    const held = hold(pool);
    await held.started;
    const reservation = held.context.reservation!;

    const within = held.context.reportUsage({
      input: reservation.input + 100,
      output: 0,
    });
    expect(within).toMatchObject({ held: reservation.reserved + 100 });
    expect(within.stopped).toBeUndefined();
    expect(held.signal?.aborted).toBe(false);

    const over = held.context.reportUsage({
      input: reservation.input + 101,
      output: 0,
    });
    expect(over).toMatchObject({
      held: reservation.reserved + 101,
      stopped: true,
    });

    const error = await held.running.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(LLMAdmissionStoppedError);
    expect(error).toMatchObject({
      cause: "overrun",
      code: "LLM_ADMISSION_STOPPED",
      admissionId: held.context.admissionId,
    });
    expect(held.signal?.aborted).toBe(true);
    expect(held.signal?.reason).toBe(error);

    // The slot is back at once. The tokens stay charged until the callback
    // settles, because the abort does not prove the provider stopped.
    expect(pool.stats()).toMatchObject({
      bulkhead: { inFlight: 0 },
      llm: { inFlight: 1, stopped: 1, stoppedByCause: { overrun: 1 } },
      tokenBudget: { inFlightTokens: reservation.reserved + 101 },
      tyr: {
        stop: {
          policy: { overrunAllowanceTokens: 100 },
          stopped: 1,
          stoppedByCause: { overrun: 1, limits: 0, drain_deadline: 0 },
        },
        restoration: { upstreamCapacity: { activeAccountingHolds: 1 } },
      },
    });

    held.finish();
    await settle();
    expect(pool.stats()).toMatchObject({
      llm: { inFlight: 0, released: 1 },
      tokenBudget: { inFlightTokens: 0 },
      tyr: { restoration: { upstreamCapacity: { activeAccountingHolds: 0 } } },
    });
  });

  it("stops the newest request when a report leaves the pool above its budget", async () => {
    const pools = createPools([
      poolConfig({
        budget: 2_200,
        stop: { overrunAllowanceTokens: 5_000 },
        progressiveReconciliation: { enabled: false },
      }),
    ]);
    const pool = pools.get("stoppable")!;
    const older = hold(pool);
    await older.started;
    const newer = hold(pool);
    await newer.started;
    const reservation = older.context.reservation!;
    expect(reservation.reserved * 2).toBeLessThanOrEqual(2_200);

    // Well inside its own allowance, but the pool no longer fits its budget.
    const report = older.context.reportUsage({
      input: reservation.input + 500,
      output: 0,
    });
    expect(report.stopped).toBeUndefined();
    await expect(newer.running).rejects.toMatchObject({ cause: "overrun" });
    expect(older.signal?.aborted).toBe(false);
    expect(pool.stats().tyr.stop).toMatchObject({
      stopped: 1,
      stoppedByCause: { overrun: 1 },
    });

    newer.finish();
    older.finish();
    await expect(older.running).resolves.toBe("done");
  });

  it("does not stop a request for the progressive safety margin", async () => {
    // Progressive reconciliation is on by default, with a 256-token margin.
    const pools = createPools([
      poolConfig({ stop: { overrunAllowanceTokens: 0 } }),
    ]);
    const pool = pools.get("stoppable")!;
    const held = hold(pool, request(100, "hi"));
    await held.started;
    const reservation = held.context.reservation!;
    expect(reservation.reserved).toBeLessThan(256);

    for (const output of [0, 60, 100]) {
      const report = held.context.reportUsage({
        input: reservation.input,
        output,
      });
      expect(report.held).toBeLessThanOrEqual(reservation.reserved);
      expect(report.stopped).toBeUndefined();
    }
    expect(pool.stats().tokenBudget?.totalOverrun).toBe(0);

    // Output past the reservation is a real overrun, counted from the hold.
    const over = held.context.reportUsage({
      input: reservation.input,
      output: 100 + reservation.input + 1,
    });
    expect(over).toMatchObject({
      held: reservation.reserved + 1,
      stopped: true,
    });
    await expect(held.running).rejects.toMatchObject({ cause: "overrun" });
    held.finish();
  });
});

describe("take-back stops", () => {
  it("stops what a limits update left above the new limits once the grace period ends", async () => {
    const pools = createPools([poolConfig({ stop: { takeBackGraceMs: 40 } })]);
    const pool = pools.get("stoppable")!;
    const first = hold(pool);
    await first.started;
    const second = hold(pool);
    await second.started;

    const startedAt = Date.now();
    pools.applyLimits([
      {
        pool: "stoppable",
        limits: {
          revision: 2,
          maxConcurrent: 1,
          maxQueue: 0,
          tokenBudget: { budget: 10_000, highPriorityReserve: 0 },
        },
      },
    ]);
    // Nothing is stopped inside applyLimits or during the grace period.
    expect(second.signal?.aborted).toBe(false);
    expect(pool.stats().llm.stopped).toBeUndefined();

    await expect(second.running).rejects.toMatchObject({ cause: "limits" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
    expect(second.signal?.aborted).toBe(true);
    // The request admitted first fits the new limit and runs on.
    expect(first.signal?.aborted).toBe(false);
    expect(pool.stats()).toMatchObject({
      bulkhead: { inFlight: 1 },
      llm: { inFlight: 2, stopped: 1, stoppedByCause: { limits: 1 } },
    });

    second.finish();
    first.finish();
    await expect(first.running).resolves.toBe("done");
  });

  it("stops nothing when the work fits again before the grace period ends", async () => {
    const pools = createPools([poolConfig({ stop: { takeBackGraceMs: 60 } })]);
    const pool = pools.get("stoppable")!;
    const first = hold(pool);
    await first.started;
    const second = hold(pool);
    await second.started;

    pools.applyLimits([
      {
        pool: "stoppable",
        limits: {
          revision: 2,
          maxConcurrent: 1,
          maxQueue: 0,
          tokenBudget: { budget: 10_000, highPriorityReserve: 0 },
        },
      },
    ]);
    second.finish();
    await expect(second.running).resolves.toBe("done");
    await settle(90);

    expect(first.signal?.aborted).toBe(false);
    expect(pool.stats().llm.stopped).toBeUndefined();
    first.finish();
    await expect(first.running).resolves.toBe("done");
  });

  it("stops normal-priority work before high-priority work", async () => {
    const pools = createPools([poolConfig({ stop: { takeBackGraceMs: 0 } })]);
    const pool = pools.get("stoppable")!;
    const normal = hold(pool, request(), "normal");
    await normal.started;
    // Admitted last, which would otherwise make it the first to stop.
    const high = hold(pool, request(), "high");
    await high.started;

    pools.applyLimits([
      {
        pool: "stoppable",
        limits: {
          revision: 2,
          maxConcurrent: 1,
          maxQueue: 0,
          tokenBudget: { budget: 10_000, highPriorityReserve: 0 },
        },
      },
    ]);
    await expect(normal.running).rejects.toMatchObject({ cause: "limits" });
    expect(high.signal?.aborted).toBe(false);

    normal.finish();
    high.finish();
    await expect(high.running).resolves.toBe("done");
  });
});

describe("stopping at a drain deadline", () => {
  it("stops what is still running and reports how many", async () => {
    const pools = createPools([
      poolConfig(),
      poolConfig({ name: "idle", modelPrefixes: ["o3"] }),
    ]);
    const pool = pools.get("stoppable")!;
    const held = hold(pool);
    await held.started;

    const result = await pools.drain(20, { stopOnTimeout: true });

    expect(result).toEqual({
      drained: false,
      inFlight: 1,
      pending: 0,
      stopped: 1,
      pools: {
        stoppable: { drained: false, inFlight: 1, pending: 0, stopped: 1 },
        idle: { drained: true, inFlight: 0, pending: 0, stopped: 0 },
      },
    });
    await expect(held.running).rejects.toMatchObject({
      cause: "drain_deadline",
    });
    // No stop policy was in force at admission, so the library rejects the
    // caller without aborting the callback. The gateway aborts it instead.
    expect(held.signal).toBeUndefined();
    expect(pool.stats().tyr.stop).toEqual({
      stopped: 1,
      stoppedByCause: { overrun: 0, limits: 0, drain_deadline: 1 },
    });

    held.finish();
    await settle();
    await expect(pools.drain(50, { stopOnTimeout: true })).resolves.toMatchObject({
      drained: true,
      inFlight: 0,
      stopped: 0,
    });
  });

  it("aborts the callback of a pool that had a stop policy", async () => {
    const pools = createPools([poolConfig({ stop: { takeBackGraceMs: 60_000 } })]);
    const held = hold(pools.get("stoppable")!);
    await held.started;

    await expect(pools.drain(10, { stopOnTimeout: true })).resolves.toMatchObject({
      drained: false,
      stopped: 1,
    });
    await expect(held.running).rejects.toMatchObject({
      cause: "drain_deadline",
    });
    expect(held.signal?.aborted).toBe(true);
    held.finish();
  });

  it("reports no stopped count and stops nothing unless asked to", async () => {
    const pools = createPools([poolConfig()]);
    const pool = pools.get("stoppable")!;
    const held = hold(pool);
    await held.started;

    const result = await pools.drain(15);

    expect(result).toStrictEqual({
      drained: false,
      inFlight: 1,
      pending: 0,
      pools: { stoppable: { drained: false, inFlight: 1, pending: 0 } },
    });
    expect(pool.stats().llm.stopped).toBeUndefined();
    held.finish();
    await expect(held.running).resolves.toBe("done");
  });

  it("needs a deadline to stop at, and leaves admission open when it has none", async () => {
    const pools = createPools([poolConfig()]);
    const pool = pools.get("stoppable")!;

    await expect(pools.drain(undefined, { stopOnTimeout: true })).rejects.toThrow(
      "stopOnTimeout requires timeoutMs",
    );
    await expect(pool.drain(undefined, { stopOnTimeout: true })).rejects.toThrow(
      "stoppable stopOnTimeout requires timeoutMs",
    );

    const llmRequest = request();
    await expect(
      pool.run(llmRequest, pool.prepare(llmRequest, "normal"), async () => "ok", {
        priority: "normal",
      }),
    ).resolves.toBe("ok");
  });

  it("turns away new work after a stopping drain as any closed pool does", async () => {
    const pools = createPools([poolConfig()]);
    const pool = pools.get("stoppable")!;
    await pools.drain(5, { stopOnTimeout: true });

    const llmRequest = request();
    await expect(
      pool.run(llmRequest, pool.prepare(llmRequest, "normal"), async () => "ok", {
        priority: "normal",
      }),
    ).rejects.toBeInstanceOf(LLMBulkheadRejectedError);
  });
});

describe("stop metrics", () => {
  it("exposes stop counters and the configured policy for a pool that has one", async () => {
    const pools = createPools([
      poolConfig({
        stop: { overrunAllowanceTokens: 100, takeBackGraceMs: 2_500 },
        progressiveReconciliation: { enabled: false },
        admissionClasses: {
          defaultClass: "standard",
          classes: { standard: {}, batch: {} },
        },
      }),
      poolConfig({ name: "plain", modelPrefixes: ["o3"] }),
    ]);
    const pool = pools.get("stoppable")!;
    const held = hold(pool);
    await held.started;
    const reservation = held.context.reservation!;
    held.context.reportUsage({ input: reservation.input + 101, output: 0 });
    await expect(held.running).rejects.toMatchObject({ cause: "overrun" });
    held.finish();
    await settle();

    const metrics = new TyrTelemetry().renderPrometheus(pools.stats(), true);

    expect(metrics).toContain("# TYPE tyr_pool_stopped_total counter");
    expect(metrics).toContain(
      'tyr_pool_stopped_total{cause="overrun",pool="stoppable"} 1',
    );
    expect(metrics).toContain(
      'tyr_pool_stopped_total{cause="limits",pool="stoppable"} 0',
    );
    expect(metrics).toContain(
      'tyr_pool_stopped_total{cause="drain_deadline",pool="stoppable"} 0',
    );
    expect(metrics).toContain(
      'tyr_pool_admission_class_stopped_total{admission_class="standard",pool="stoppable"} 1',
    );
    expect(metrics).toContain(
      'tyr_pool_admission_class_stopped_total{admission_class="batch",pool="stoppable"} 0',
    );
    expect(metrics).toContain(
      'tyr_pool_stop_overrun_allowance_tokens{pool="stoppable"} 100',
    );
    expect(metrics).toContain(
      'tyr_pool_stop_take_back_grace_seconds{pool="stoppable"} 2.5',
    );
    // A pool with no policy and no stop has no stop series.
    expect(metrics).not.toMatch(/tyr_pool_stop[^\n]*pool="plain"/);
  });

  it("exposes no stop series for pools that cannot stop anything", () => {
    const pools = createPools([poolConfig()]);

    const metrics = new TyrTelemetry().renderPrometheus(pools.stats(), true);

    expect(metrics).not.toContain("tyr_pool_stop");
    expect(metrics).not.toContain("_stopped_total");
  });
});
