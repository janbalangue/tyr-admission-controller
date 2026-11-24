import { describe, expect, it } from "vitest";
import { createSSEUsageExtractor, type UsageObservation } from "../src/sse.js";
import { createOpenAISSEUsageExtractor } from "../src/sse-openai.js";
import { createOpenAIResponsesSSEUsageExtractor } from "../src/sse-responses.js";

// Each extractor says whether a usage observation came with the end of the
// reply. Usage that did counts work the provider has already done.

type Seen = Array<[UsageObservation, boolean]>;

const data = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;

describe("Anthropic stream usage", () => {
  it("is final only on the message_delta that carries a stop reason", () => {
    const seen: Seen = [];
    const extractor = createSSEUsageExtractor((usage, final) =>
      seen.push([usage, final]),
    );

    extractor.push(
      data({ type: "message_start", message: { usage: { input_tokens: 20 } } }),
    );
    extractor.push(
      data({ type: "message_delta", usage: { output_tokens: 40 } }),
    );
    extractor.push(
      data({
        type: "message_delta",
        delta: { stop_reason: null },
        usage: { output_tokens: 60 },
      }),
    );
    extractor.push(
      data({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 75 },
      }),
    );

    expect(seen).toEqual([
      [{ input: 20, output: 0 }, false],
      [{ input: 20, output: 40 }, false],
      [{ input: 20, output: 60 }, false],
      [{ input: 20, output: 75 }, true],
    ]);
  });
});

describe("Chat Completions stream usage", () => {
  it("is final on the usage chunk that has no choices", () => {
    const seen: Seen = [];
    const extractor = createOpenAISSEUsageExtractor((usage, final) =>
      seen.push([usage, final]),
    );

    extractor.push(data({ choices: [{ delta: { content: "a" } }], usage: null }));
    extractor.push(
      data({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 30 } }),
    );
    extractor.push("data: [DONE]\n\n");

    expect(seen).toEqual([[{ input: 20, output: 30 }, true]]);
  });

  it("is not final while a choice is still being generated", () => {
    const seen: Seen = [];
    const extractor = createOpenAISSEUsageExtractor((usage, final) =>
      seen.push([usage, final]),
    );

    // A server that reports cumulative usage on every chunk.
    extractor.push(
      data({
        choices: [{ delta: { content: "a" }, finish_reason: null }],
        usage: { prompt_tokens: 20, completion_tokens: 1 },
      }),
    );
    extractor.push(
      data({
        choices: [{ delta: { content: "b" } }],
        usage: { prompt_tokens: 20, completion_tokens: 2 },
      }),
    );
    extractor.push(
      data({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 3 },
      }),
    );
    // A chunk with usage and no `choices` field at all.
    extractor.push(
      data({ usage: { prompt_tokens: 20, completion_tokens: 3 } }),
    );

    expect(seen.map(([usage, final]) => [usage.output, final])).toEqual([
      [1, false],
      [2, false],
      [3, true],
      [3, true],
    ]);
  });
});

describe("Responses stream usage", () => {
  it("is final on an event that shows the response is finished", () => {
    const seen: Seen = [];
    const extractor = createOpenAIResponsesSSEUsageExtractor((usage, final) =>
      seen.push([usage, final]),
    );
    const usage = (output: number) => ({ input_tokens: 20, output_tokens: output });

    extractor.push(
      data({
        type: "response.in_progress",
        response: { id: "r", status: "in_progress", usage: usage(10) },
      }),
    );
    // The status decides when the response has one, whatever the event type.
    extractor.push(
      data({
        type: "response.completed",
        response: { id: "r", status: "in_progress", usage: usage(20) },
      }),
    );
    extractor.push(
      data({
        type: "response.completed",
        response: { id: "r", status: "completed", usage: usage(30) },
      }),
    );
    extractor.push(
      data({
        type: "response.incomplete",
        response: { id: "r", status: "incomplete", usage: usage(40) },
      }),
    );
    // No status: the event type decides.
    extractor.push(
      data({ type: "response.completed", response: { id: "r", usage: usage(50) } }),
    );
    extractor.push(
      data({ type: "response.output_text.delta", response: { id: "r", usage: usage(60) } }),
    );
    // Usage on the event itself, with no response object.
    extractor.push(data({ type: "response.failed", usage: usage(70) }));
    extractor.push(data({ type: "response.in_progress", usage: usage(80) }));

    expect(seen.map(([observed, final]) => [observed.output, final])).toEqual([
      [10, false],
      [20, false],
      [30, true],
      [40, true],
      [50, true],
      [60, false],
      [70, true],
      [80, false],
    ]);
  });
});
