---
title: Response memory for Responses follow-ups
---

# Response memory for Responses follow-ups

A Responses request that names `previous_response_id` carries none of the
earlier turns in its body, so its input cannot be estimated from the request
alone. By default Tyr rejects it. With `responsesState` configured, Tyr
records the size of each Responses reply it proxies, and a follow-up reserves
its own estimate plus the recorded size of the response it names.

```yaml
responsesState:
  file: /var/lib/tyr/responses-state.jsonl
  maxEntries: 10000   # default; the oldest record is dropped first
  ttlMs: 2592000000   # default, 30 days
```

- A `2xx` Responses reply that carries an `id` and provider `usage` is
  recorded as `input_tokens + output_tokens`. A request with `store: false`,
  a reply without usage, and a reply with any other HTTP status are not
  recorded.
- A streamed reply is recorded only from an event that shows the response is
  finished: one whose response has the status `completed`, `incomplete`,
  `failed` or `cancelled`, or, when the response has no status, a
  `response.completed`, `response.incomplete` or `response.failed` event.
  Usage on any earlier event is ignored, so a stream that breaks off leaves
  no undersized record.
- A follow-up to a recorded response reserves its own estimate plus the
  recorded size. `x-admission-prior-tokens` reports that size, and
  `x-admission-reserved-tokens` includes it when the pool has a token budget.
  The recorded size is an amount the provider reported, so adaptive
  estimation does not scale it, and follow-ups are not used as calibration
  samples.
- A follow-up that names a response Tyr has no usable record of gets `422`
  with `error.type: "unknown_previous_response"`. The provider is not called,
  and no retry hint is sent because waiting cannot help. The refusal carries
  `x-admission-mode`, `x-admission-revision` and
  `x-admission-reason: unknown_previous_response`, but no preview or
  reservation headers. `observe` mode does not shadow it.
- Tyr keeps at most `maxEntries` records, drops the oldest first, and drops
  each record `ttlMs` after it was written.
- Each record is appended to `file` before its reply ends, so a process killed
  right after a reply keeps it. Tyr reads the file at startup, before it
  serves requests, and ignores a partly written last line. It refuses to start
  on a file that is not a Tyr state file or that a newer Tyr wrote, and when
  it cannot read the file or create a missing one.
- With identity configured, a record belongs to the tenant and application
  that created it. A follow-up from anyone else gets the same `422` as an
  unknown id.

`GET /stats` exposes per-pool counters in `tyr.responsesState`: `records`,
`recorded`, `evicted`, `expired`, `followUps`, `priorTokens`, `refused`, and
`persistFailures`. `/metrics` exposes the same values as
`tyr_pool_responses_state_*`. A refusal is also a rejected admission decision:
it counts in `tyr_admission_decisions_total`, in
`tyr_admission_rejections_total` with `reason="unknown_previous_response"`,
and in `tyr_requests_total` as `admission_rejected`, and it emits an admission
audit event when auditing is on. It never reaches the pool, so it does not
appear in `tyr_pool_rejected_total`.

Operating notes:

- Response memory is configured in a configuration file or through
  `createGateway`. Legacy environment mode has no variable for it.
- The state file is created with mode `0600`. A relative `file` is resolved
  from the configuration file's directory. Every Tyr process needs its own
  file.
- Tyr replaces the state file by writing a temporary file next to it and
  renaming it. The directory that holds `file` must therefore be writable;
  mounting only the file is not enough.
- In a container, put `file` in a writable mounted directory that the image's
  `node` user can write. The read-only configuration mount shown under
  [Container usage](deployment.md) is not writable.
- `maxEntries` is one bound for every caller. A caller that creates that many
  responses displaces all older records, including other tenants'. Size it
  for the whole deployment.
- A record takes roughly 250 bytes of memory. After about `maxEntries` new
  records Tyr rewrites the file, which blocks the process for roughly 20 ms
  at 10,000 records and half a second at 1,000,000 on an SSD.
- Records are local to one process. With several replicas, a follow-up is
  admitted only on the replica that recorded the response it names, so keep a
  conversation on one replica.
- With capacity routing on, Tyr admits a Responses request on the replica that
  received it when the request names a record or its reply will be recorded.
  A `store: false` request without `previous_response_id` is still routed by
  capacity.
- When a write to the state file fails, Tyr logs one warning and stops
  appending, because the file may end in part of a line. Records stay usable
  in memory, and each one that is not on disk increases `persistFailures`.
  On the first new record after 1 second, Tyr retries a full rewrite; each
  failure doubles the wait, up to 5 minutes. A successful rewrite puts every
  record it still holds on disk. The same applies when a rewrite at startup
  fails: Tyr starts with the records it read.
- A record survives a killed Tyr process. Appends are not followed by `fsync`,
  so a host crash can lose the newest records; their follow-ups are then
  refused as unknown.
- The recorded size is the earlier reply's input plus output tokens. When the
  provider carries less than that into the next turn, the difference is
  refunded at settlement like any other over-reservation.
