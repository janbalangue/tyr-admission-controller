---
title: HTTP API
---

# HTTP API

## Routes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/messages` | Identity-authorized, admission-gated Anthropic Messages proxy |
| `POST` | `/v1/chat/completions` | Identity-authorized, admission-gated OpenAI Chat Completions proxy |
| `POST` | `/v1/responses` | Identity-authorized, admission-gated OpenAI Responses proxy |
| `GET` | `/stats` | Live per-pool statistics; optional operator JWT role or bearer token |
| `GET` | `/metrics` | Prometheus text; optional operator JWT role or bearer token |
| `GET` | `/healthz` | Process liveness |
| `GET` | `/readyz` | Managed readiness; `503` until all configured Latchflo grants are valid |
| `GET` | `/_tyr/capacity` | Protected internal capacity snapshot when replica routing is configured |

A provider route is enabled only when its upstream base URL is configured.
Calling a disabled provider route returns `404` with
`error.type: "route_not_configured"`.

## Forwarded request headers

Tyr forwards only the provider headers below. Provider credentials remain owned
by the calling application and must not be placed in Tyr configuration files.

| Provider route | Forwarded headers |
|---|---|
| Anthropic | `content-type`, `x-api-key`, `authorization`, `anthropic-version`, `anthropic-beta` |
| OpenAI | `content-type`, `authorization`, `openai-organization`, `openai-project` |

## Admission response headers

Every validated, pool-routed request includes an advisory snapshot. The one
exception is a follow-up refused as `unknown_previous_response`, which has no
reservation to preview:

| Header | Meaning |
|---|---|
| `x-admission-mode` | `enforce` or `observe` |
| `x-admission-class` | Bounded configured class selected for the request, when admission classes are enabled |
| `x-admission-preview` | Advisory `admit` or `reject` result at request arrival |
| `x-admission-preview-revision` | Limit revision used for the advisory preview |
| `x-admission-preview-reason` | Present when the advisory result rejects |
| `x-admission-reserved-tokens` | Exact input-plus-output reservation when a token budget exists |
| `x-admission-prior-tokens` | Recorded size of the earlier response a Responses follow-up names; included in `x-admission-reserved-tokens` when the pool has a token budget. Present only on a follow-up when [response memory](response-memory.md) is configured |
| `x-admission-id` | Bulkhead UUID, or `shadow-...` for an observe-mode bypass |
| `x-admission-outcome` | `admitted` or native v3.12 `bypassed` outcome |
| `x-admission-revision` | Revision active when execution began; immediate rejections use the preview revision |
| `x-admission-slot-borrowed` | `true` when this admission used shared rather than class-protected local concurrency |
| `x-admission-borrowed-tokens` | Tokens attributed to the shared rather than class-protected token remainder |
| `x-admission-slot-deadline-ms` | Configured local borrowed-slot deadline when it applies; repeated on deadline errors |
| `x-admission-bypass-reason` | Capacity reason simulated by an observe-mode bypass |
| `x-latchflo-grant-id` | Exact Latchflo capacity grant associated with `x-admission-revision`, when present |
| `x-latchflo-controller-epoch` | Latchflo fencing epoch that issued the associated grant |
| `x-tyr-routed-by` | Ingress Tyr instance that selected a remote replica; present only after forwarding |
| `x-tyr-routed-to` | Tyr instance that performed the authoritative admission and provider invocation |

A request Tyr stopped after admitting it, whose reply had not started, has
`x-admission-reason: stopped` and `x-admission-stop-cause` set to `overrun`,
`limits` or `drain_deadline`. It gets no retry hint. See
[Stopping admitted requests](stopping-admitted-requests.md).

Actual admission rejections also include `x-admission-reason`, and — when Tyr
has enough evidence — a retry hint:

| Header | Meaning |
|---|---|
| `x-admission-retry-after-ms` | The estimated wait in milliseconds. Always present when Tyr has a hint. Prefer this. |
| `retry-after` | The same wait in whole seconds, per RFC 9110. Rounded up, so a caller that obeys it never arrives before capacity exists. **Only sent when the wait is at least one second** — below that the header cannot express it without overstating it badly, and Tyr leaves the client's own backoff alone rather than parking it five times too long. |

Tyr estimates the wait from **observed upstream completion intervals** for the
pool, held as a time-decayed moving average, combined with the queue depth or
token deficit reported in the rejection detail. This is why the hint lives in
Tyr and not in `async-bulkhead-llm`: the library only sees admission decisions
and correctly refuses to invent an ETA it has no basis for, whereas Tyr proxies
the work and watches it finish.

The honesty rule survives the move. Until a pool has produced
`retryHint.minSamples` completions, **no header is emitted at all** — a missing
hint means "unknown", never a guess. Hints are omitted entirely for `shutdown`
(this instance is draining; re-resolve rather than wait), `aborted` (the caller
already gave up), and `unshareable_result` (a deduplication conflict that
waiting cannot resolve).

Set `retryHint.enabled: false`, or `TYR_RETRY_HINT_ENABLED=false`, to suppress
both headers.

Advisory results are not guarantees; capacity can change before authoritative
admission, and a retry hint is an estimate rather than a reservation.

## Error contract

| Status | Error type or reason | Meaning and retry guidance |
|---:|---|---|
| `400` | `invalid_json` or `invalid_request` | The request is malformed; correct it before retrying. |
| `401` | `identity_required`, `identity_invalid`, `operator_unauthorized`, or `routing_unauthorized` | Identity or an internal routing credential is missing or invalid; do not retry the same credential unchanged. |
| `403` | `identity_forbidden` | The verified identity lacks a required role; retry only after authorization changes. |
| `404` | `not_found`, `route_not_configured`, `routing_not_configured`, or `metrics_disabled` | The route is unknown, its upstream or replica routing is disabled, or metrics exposition is disabled. |
| `413` | `payload_too_large` | The request body exceeds `server.maxRequestBodyBytes`. |
| `422` | `unsupported_model` | No configured pool matches the requested model. |
| `422` | `unknown_previous_response` | With response memory configured, the request names a `previous_response_id` that Tyr has no usable record of. The provider was not called. Do not retry unchanged; resend the earlier turns in the request instead. |
| `429` | `admission_rejected`, commonly `budget_limit` or `concurrency_limit` | Tyr is protecting bounded capacity; honor `x-admission-retry-after-ms` when present, otherwise retry with backoff or reduce demand. |
| `500` | `internal` | Tyr encountered an unexpected internal failure; retry according to the caller's server-error policy. |
| `502` | `upstream_error` or `routing_peer_unavailable` | The provider or selected Tyr peer failed before a valid response was returned. `upstream_error` carries `cause.code` (for example `ECONNREFUSED` or `UND_ERR_SOCKET`) when the transport reported one. A routed request is not automatically replayed. |
| `503` | `identity_unavailable` | Tyr cannot currently verify identity because the verifier or JWKS endpoint is unavailable; retry with backoff. |
| `503` | `admission_rejected` with reason `shutdown` | This Tyr instance is draining and no longer accepts admissions; retry another instance or retry with backoff. |
| `503` | `admission_stopped` | With a stop policy configured, Tyr stopped a request it had admitted, before any part of its reply was written. `error.cause` is `overrun`, `limits` or `drain_deadline`. Tyr dropped the upstream call, but the provider may already have done part or all of the work; retry only when the operation is safe to repeat, and on another instance when the cause is `drain_deadline`. |
| `504` | `borrowed_admission_deadline` | Tyr returned a borrowed local slot and requested upstream cancellation. The body reports local release as enforced and upstream reclamation as unverified; retry only when the operation is safe to repeat. |
| `504` | `response_timeout`, `idle_timeout`, `routing_peer_timeout`, or `admission_rejected` with reason `timeout` | A provider, selected Tyr peer, stream-idle, or queued-admission deadline expired; retry only according to the operation's idempotency policy. |

Admission rejection bodies include the pool name and the bounded capacity detail
reported by `async-bulkhead-llm`. Identity errors use `error.type` and do not
include admission-capacity details. Only `401` identity responses include a
`WWW-Authenticate` challenge; `503 identity_unavailable` deliberately does not.

A streamed reply's status line is written with its first chunk. A streamed
request that fails or is stopped before that gets the status in the table
above, although the provider may already have answered with headers. Once a
chunk has been written the status cannot change, and the connection is closed
instead.

## Example requests

Anthropic Messages:

```bash
curl -i http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_ANTHROPIC_API_KEY' \
  -H 'anthropic-version: 2023-06-01' \
  --data '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Explain admission control."}]
  }'
```

OpenAI Chat Completions:

```bash
curl -i http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_OPENAI_API_KEY' \
  --data '{
    "model": "gpt-4o",
    "max_completion_tokens": 512,
    "messages": [{"role": "user", "content": "Explain admission control."}]
  }'
```

OpenAI Responses (recommended for new OpenAI integrations):

```bash
curl -i http://127.0.0.1:8787/v1/responses \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_OPENAI_API_KEY' \
  --data '{
    "model": "gpt-5.6",
    "max_output_tokens": 512,
    "input": "Explain admission control."
  }'
```

Tyr 0.36.0 supports synchronous and streaming Responses requests. To keep
pre-admission token reservations bounded, it rejects server-side
`conversation`, stored `prompt` templates, `item_reference`,
`background: true`, and provider-managed retrieval/computer tools.
Request-visible `function` and `custom` tools are supported.
`previous_response_id` is rejected too unless
[response memory](response-memory.md) is configured.

For OpenAI Chat Completions streaming requests, set
`stream_options: { "include_usage": true }` when supported so Tyr can reconcile
usage from the final stream chunk. Responses streams reconcile cumulative usage
from semantic lifecycle events such as `response.completed`. Anthropic streaming
usage is extracted from supported `message_start` and `message_delta` events.
