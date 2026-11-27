---
title: How admission works
---

# How admission works

Tyr sits between a client and its LLM provider. For each request it decides,
before the provider is called, whether the request runs now.

## Request lifecycle

For each provider request, Tyr:

1. Authenticates and authorizes the caller before buffering the request when
   identity is enabled.
2. Buffers and validates the JSON body within the configured size limit.
3. Routes the model to the longest matching pool prefix and projects provider
   prompt content into an admission request.
4. With [response memory](response-memory.md)
   configured, resolves a Responses follow-up to the recorded size of the
   response it names, or refuses it.
5. Computes one immutable reservation preview.
6. When capacity-aware routing is enabled, compares the local grant partition
   with fresh peer snapshots and may forward the request once to a roomier Tyr.
   A request bound to a response record is admitted where it arrived.
7. The serving Tyr captures its complete versioned limit snapshot, computes its
   own authoritative reservation, and calls the native v3.15 `run()` path in
   the configured `enforce` or `observe` mode.
8. Reconciles live and final provider usage. Budgeted streams progressively
   return processed capacity when cumulative usage is available; native observe
   bypass releases also feed adaptive estimation. With response memory
   configured, the size of a Responses reply is recorded before the reply ends.
9. Releases remaining capacity when the request completes, fails, or the client
   disconnects. With a [stop policy](stopping-admitted-requests.md), Tyr may
   also stop the request itself.

Tyr does not translate between Anthropic and OpenAI request formats.

## Capacity semantics

A pool's `inFlightTokenBudget` is an **admission-time in-flight ceiling**. An
admitted request reserves estimated input plus `max_tokens` or
`max_completion_tokens`, falling back to the pool's
`defaultOutputReservation` when the request does not provide an output limit.
Actual provider usage refunds unused capacity at completion, and streaming
usage can correct the active hold while the response is running.

Usage reported after admission can exceed the original estimate. In that case,
`async-bulkhead-llm` expands the active hold, so live `inFlightTokens` may
temporarily exceed the configured ceiling. Tyr blocks new admissions until
capacity is released. By default it does not abort an already-running request:
this is deliberate overrun accounting, not a post-admission kill switch. A
pool can opt in to [stopping such a request](stopping-admitted-requests.md).

Admission estimation uses the library request surfaces instead of folding the
entire provider request into a synthetic user message:

- Anthropic `system` and provider messages remain first-class request fields.
- Tool schemas, tool calls, response formats, roles, and provider-specific
  prompt metadata are charged through `extraInputTokens`.
- Opaque image, audio, document, file, and video blocks use the library's
  `opaqueBlockTokens` policy.
- Inline binary payload text is omitted from literal prompt estimation so a
  base64 payload is not mistaken for ordinary text.

The estimate is intended for load shedding and capacity protection. It is not a
billing-grade tokenizer or a substitute for provider usage records.

For token-budgeted pools, adaptive estimation is enabled by default. Tyr records
provider-reported input usage on release and applies the library's bounded
per-model EWMA correction after the configured minimum sample count. Output
reservations are never adapted. Calibration is local, in-memory, and reset when
the process restarts.

## Admission modes

`enforce` is the default and returns the normal `429`/`503` admission response.
`observe` runs the same reservation and capacity decision but proxies requests
that would have failed for budget, concurrency, queue, or admission timeout.
Those bypasses receive a synthetic `shadow-...` admission ID and are counted in
`/stats`. Shutdown and client-abort behavior are never shadowed. A pool in
`observe` mode cannot have a `stop` block.

Observe mode models the system that would exist under enforcement: requests
that would be rejected do not consume simulated pool capacity. It is therefore
appropriate for measuring prospective rejection rates before enabling policy,
not for representing actual upstream load while bypasses are running.
