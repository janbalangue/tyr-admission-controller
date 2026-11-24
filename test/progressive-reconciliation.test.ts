import { describe, expect, it } from "vitest";
import type { LLMRequest } from "async-bulkhead-llm";
import { createPools } from "../src/pools.js";

const request: LLMRequest = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "x".repeat(400) }],
  max_tokens: 1000,
};

describe("progressive streaming reconciliation", () => {
  it("releases processed input and output capacity in bounded steps", async () => {
    const pools = createPools([{
      name: "progressive", modelPrefixes: ["gpt"], model: "gpt-4o",
      maxConcurrent: 1, budget: 10_000, adaptiveEstimation: { enabled: false },
      progressiveReconciliation: { updateStepTokens: 100, outputSafetyMarginTokens: 200 },
    }]);
    const pool = pools.get("progressive")!;
    const prepared = pool.prepare(request, "normal");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = pool.run(request, prepared, async (_signal, context) => {
      expect(context).toBeDefined();
      context!.reportUsage({ input: 80, output: 0 });
      expect(pool.stats().tokenBudget?.inFlightTokens).toBe(1000);
      context!.reportUsage({ input: 80, output: 50 });
      expect(pool.stats().tokenBudget?.inFlightTokens).toBe(1000);
      context!.reportUsage({ input: 80, output: 250 });
      expect(pool.stats().tokenBudget?.inFlightTokens).toBe(750);
      context!.reportUsage({ input: 80, output: 900 });
      expect(pool.stats().tokenBudget?.inFlightTokens).toBe(200);
      await gate;
      return { usage: { input: 80, output: 900 } };
    }, { priority: "normal", getUsage: (value) => value.usage });
    // Admission (bulkhead.acquire) resolves over multiple microtask ticks
    // before the pool callback runs, so flush the microtask queue rather
    // than assuming a single `await` suffices.
    await Promise.resolve();
    await Promise.resolve();
    const stats = pool.stats().tyr.progressiveReconciliation;
    expect(stats).toMatchObject({ enabled: true, reports: 4, updates: 3, coalesced: 1 });
    expect(stats.earlyReleasedTokens).toBeGreaterThan(0);
    release();
    await running;
    expect(pool.stats().tokenBudget?.inFlightTokens).toBe(0);
  });

  it("never holds more than a request with a small output reservation reserved", async () => {
    // The default safety margin is 256 tokens, more than this request reserves.
    const pools = createPools([{
      name: "small", modelPrefixes: ["gpt"], model: "gpt-4o",
      maxConcurrent: 1, budget: 10_000, adaptiveEstimation: { enabled: false },
    }]);
    const pool = pools.get("small")!;
    const small: LLMRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    };
    const prepared = pool.prepare(small, "normal");
    const reservation = prepared.reservation!;
    expect(reservation.reserved).toBeLessThan(256);

    await pool.run(small, prepared, async (_signal, context) => {
      // The input reservation is returned; the output reservation is kept.
      const first = context!.reportUsage({ input: reservation.input, output: 0 });
      expect(first.held).toBe(100);
      expect(pool.stats().tokenBudget?.inFlightTokens).toBe(100);
      const last = context!.reportUsage({ input: reservation.input, output: 100 });
      expect(last.held).toBe(100);
      return { usage: { input: reservation.input, output: 100 } };
    }, { priority: "normal", getUsage: (value) => value.usage });

    expect(pool.stats().tokenBudget).toMatchObject({
      inFlightTokens: 0,
      totalOverrun: 0,
    });
  });

  it("rejects invalid progressive configuration", () => {
    expect(() => createPools([{
      name: "missing-budget", modelPrefixes: ["gpt"], model: "gpt-4o",
      maxConcurrent: 1,
      progressiveReconciliation: { enabled: true },
    }])).toThrow(/progressiveReconciliation requires.*budget/);

    expect(() => createPools([{
      name: "bad-step", modelPrefixes: ["gpt"], model: "gpt-4o",
      maxConcurrent: 1, budget: 10_000,
      progressiveReconciliation: { updateStepTokens: 0 },
    }])).toThrow(/updateStepTokens/);
  });

  it("can be disabled without changing v3.12 conservative holds", async () => {
    const pools = createPools([{
      name: "conservative", modelPrefixes: ["gpt"], model: "gpt-4o",
      maxConcurrent: 1, budget: 10_000, adaptiveEstimation: { enabled: false },
      progressiveReconciliation: { enabled: false },
    }]);
    const pool = pools.get("conservative")!;
    const prepared = pool.prepare(request, "normal");
    await pool.run(request, prepared, async (_signal, context) => {
      context!.reportUsage({ input: 80, output: 250 });
      expect(pool.stats().tokenBudget?.inFlightTokens).toBe(1080);
      return { usage: { input: 80, output: 250 } };
    }, { priority: "normal", getUsage: (value) => value.usage });
    expect(pool.stats().tyr.progressiveReconciliation.enabled).toBe(false);
  });
});
