---
title: Known limitations
---

# Known limitations

- Standalone budgets and statistics are per process. Configure Latchflo managed
  mode when replicas must share a bounded fleet-wide capacity envelope.
- Latchflo coordination uses expiring partitioned grants rather than a strict
  distributed lease on every request. Capacity can be temporarily unavailable
  during safe lease handoff.
- Borrowed-slot deadlines enforce reclamation of Tyr-local concurrency only.
  Provider cancellation may be best-effort, so upstream account, queue, or
  accelerator protection still requires an unlent floor or another release
  mechanism that can be proven to reclaim that resource.
- Capacity snapshots are advisory and can race with authoritative admission;
  stale or unavailable peers are ignored, and a routed rejection is returned
  without a second automatic attempt. Managed peer membership is dynamic only
  when Latchflo 0.13+ publishes `routingTopology`; standalone peer membership
  remains startup configuration.
- Upstream, estimator, timeout, routing-secret, and admission-mode configuration
  is loaded only at startup. Admission-limit snapshots and managed routing
  topology can be replaced at runtime.
- Adaptive calibration is local, learned only from live observations, and is not
  persisted across restarts.
- JWT identity currently supports direct JWKS URLs and RSA signatures; OIDC discovery, EC signatures, and durable identity-policy distribution remain external work.
- Prometheus export is built in, but OTLP/OpenTelemetry export and durable audit storage remain external integration work.
- SSE usage extraction must be verified against the exact provider API versions
  used in production. Missing usage affects reservation refunds, not proxying.
- Upstream response headers are not generally passed through; Tyr returns the
  upstream status and body with a normalized content type.
- There is no Anthropic/OpenAI format translation.
- Response memory is per process in v0.36.0. A `previous_response_id`
  follow-up is admitted only on the replica that recorded the response it
  names, and capacity routing does not forward Responses requests that create
  or use a record. A response deleted at the provider keeps its record until
  `ttlMs`; its follow-up is reserved, sent, and then rejected by the provider.
  `maxEntries` is shared by all callers and is not divided between tenants.
- Server-side `conversation` and stored `prompt` references, `item_reference`,
  background execution, and provider-managed retrieval/computer tools are
  rejected until Tyr can reserve their capacity without undercounting unseen
  state.
- Stopping an admitted request is opt-in and local. A stop returns Tyr's slot
  and tokens and drops the upstream call. It does not prove the provider
  stopped work.
  - A reply that has started is cut without an error event, so the client
    cannot tell a stop from a broken connection.
  - An overrun is measured on the request's hold. With progressive
    reconciliation on, a request is stopped only after its output has overrun
    by about the size of its reservation.
  - A request is stopped for an overrun only when the provider reports the
    usage before the reply ends. OpenAI's Chat Completions and Responses
    streams report usage as they end, so their requests are never stopped for
    their own output.
  - On a pool with a queue, a stop can turn a waiting request into a
    `429 budget_limit`: the waiter takes the returned slot while the stopped
    request's tokens are still charged.
  - The stop policy is local configuration. Latchflo does not distribute it,
    and Tyr does not tell Latchflo that it stops work.
- Multi-controller Latchflo failover, tenant policy, and supported Helm packaging
  remain roadmap work.
