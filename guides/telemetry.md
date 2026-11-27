---
title: Runtime behavior and telemetry
---

# Runtime behavior and telemetry

## Request handling

Request bodies are buffered up to `maxRequestBodyBytes`, 1 MiB by default.
Streaming responses honor downstream backpressure, abort upstream work when the
client disconnects, and support separate response-header, upstream-idle, and
client-stall timeouts. Non-streaming responses are buffered and returned with an
explicit `content-length`.

## Shutdown

`SIGTERM` and `SIGINT` stop new admissions, close the HTTP server, and drain
in-flight bulkhead work. Requests reaching an existing keep-alive connection
during shutdown receive `503` with `x-admission-reason: shutdown`. When
`shutdown.drainTimeoutMs` is configured, Tyr closes remaining connections after
the bounded v3.12 drain snapshot reports outstanding work. With
`shutdown.stopOnDrainTimeout` as well, Tyr first stops the requests still
running at the deadline: one whose reply has not started gets `503
admission_stopped`, and each is counted and audited as stopped.

Without `shutdown.drainTimeoutMs`, drain also waits for final token settlement
after a borrowed local slot has been returned. A callback that never settles
therefore keeps shutdown pending even though interactive local concurrency is
already restored. The bounded form reports that admission as outstanding and
allows Tyr to finish closing connections; it does not establish that upstream
work stopped.

## Live statistics

`/stats` exposes the live bulkhead statistics plus a `tyr` object for each pool.
That object contains admission mode, advisory admit/reject counts, observe-mode
bypass counts, adaptive correction snapshots, progressive-reconciliation
statistics, current Latchflo provenance, and bounded exact admission provenance.
When configured, the underlying snapshot also contains bounded per-class limits
and live usage. `tyr.restoration` states the release mechanism and enforceability
separately for local admission slots and upstream capacity, lists configured
class deadlines, counts slot releases and cancellation requests, and reports
local work whose slot has been returned while its accounting has not settled.
`admissionSlots.releasedByCause` splits those releases into `deadline` (an
expired lease) and `manual` (an explicit `abandonBorrowedConcurrency()` call).
Tyr never abandons manually, so a non-zero `manual` count only appears when an
embedder returns a slot itself. Only `deadline` expiry aborts the callback
signal, so `upstreamCapacity.cancellationRequested` counts that cause alone; a
rising `deadline` share means the configured lease is too tight.
`upstreamCapacity.activeAccountingHolds` also counts stopped requests whose
upstream call has not settled. `tyr.stop` reports a pool's stop policy and its
stopped requests by cause; see
[Stopping admitted requests](stopping-admitted-requests.md).

`tyr.admissionProvenance` is a fixed-size 512-event ring for successful,
capacity-holding admissions only; observe-mode bypasses are intentionally absent.
Each event uses schema `tyr.admission-provenance.v1` and includes a pool-local
monotonic `sequence`, `admittedAt`, Tyr-generated `admissionId`, `pool`,
`priority`, optional `admissionClass`, `limitRevision`, `reservedTokens`, the
exact `resources` borrowing attribution, the applied `limits` snapshot
(with `limits.stop` when the pool has a stop policy), and the
matching managed `grant` when one
exists. The wrapper also reports `retained`, `dropped`, `captureFailures`, and
`nextSequence`. Benchmark consumers should require `captureFailures == 0` and
track `sequence` gaps before treating the retained events as complete evidence.
Matching the event's `grant.grantId`/`limitRevision` to a committed Latchflo
successor grant proves which allocation authorized an admission without relying
on cross-process clock ordering. Request bodies, identity, and client-supplied
request IDs are not retained in this ring.

## Prometheus metrics

`/metrics` exposes Prometheus text format with only bounded dimensions: configured
pool name, configured admission-class ID, provider shape, priority, status
class, outcome, and enumerated reason. Model strings, request IDs, admission
IDs, grant IDs, and tenant-supplied identity values never become metric labels.

Tyr 0.36.0 carries forward two admission-path histograms.
`tyr_admission_decision_seconds` measures synchronous local decision work and
**excludes** the awaited local concurrency acquire.
`tyr_admission_queue_wait_seconds` measures that acquire wait separately. Both
are emitted only for enforce-mode admission decisions and are split by
`pool`, `outcome` (`admitted` or `rejected`), and bounded `admission_class`.
Use each histogram's `_sum` / `_count` for the per-outcome mean; do not pool
admitted and rejected decisions because their mixes can differ across arms. The
decision histogram uses 5 µs–50 ms diagnostic buckets, while queue wait reuses
the normal duration buckets. A precheck rejection contributes exactly zero to
queue-wait sum.

Borrowed-slot restoration is exposed through
`tyr_resource_release_events_total`,
`tyr_pool_borrowed_admission_slot_deadlines_total`,
`tyr_pool_admission_class_borrowed_slot_deadlines_total`, and
`tyr_pool_work_in_flight`. The resource metric intentionally emits an enforced
local-slot release series and a separate unverified upstream cancellation-request
series; neither the label nor the count claims that provider capacity was
reclaimed. The local-slot series counts every early return, while the upstream
series and `tyr_pool_borrowed_admission_slot_deadlines_total` count deadline
expiries only. The per-class counter has no upstream cause split, so it counts
every early return for the class.

For coordination comparisons, Tyr's decision duration is the local decision
cost to compare with an external coordinator that grants/refuses immediately;
queue wait is local capacity contention and is intentionally not part of that
decision-cost comparison.

## Protecting the operator endpoints

Set `TYR_OPERATOR_BEARER_TOKEN` to require `Authorization: Bearer <token>` for
both `/stats` and `/metrics`. Leave it unset for the local demo or protect the
endpoints at the network layer.

## Audit events

Set `telemetry.audit.enabled: true` or `TYR_AUDIT_ENABLED=true` to emit one JSON
line per admission decision. Audit output is intentionally richer than metrics
and can include authenticated subject, tenant, application, roles, model,
admission ID, reservation, exact grant provenance, final usage, and settlement. Audit-sink failures are isolated from proxy behavior and
counted by `tyr_audit_write_failures_total`.

## Upstream failure diagnostics

Upstream failures are always reported, whether or not audit output is enabled.
`tyr_upstream_failures_total{pool,provider,code}` counts them by bounded
transport code. Each one also writes a `{"schema":"tyr.diagnostic.v1","event":"upstream_failure",...}`
line to stderr with the code, syscall, whether headers had already been sent,
and a bounded detail message. The detail can include internal addresses, so it
is logged but never returned to the caller.

## Prometheus and Grafana demo

The repository includes a completely local demonstration that does not call a
paid model provider:

```bash
npm run demo:up
```

Open Grafana at `http://localhost:3000`. The **Moflux / Tyr Overload
Protection** dashboard and Prometheus datasource are provisioned automatically.
Prometheus is also available at `http://localhost:9090`, and Tyr at
`http://localhost:8787`.

In a second terminal, establish the normal baseline:

```bash
npm run demo:normal
```

Then generate a fail-fast overload burst:

```bash
npm run demo:overload
```

The dashboard shows the four-slot concurrency ceiling, admitted traffic,
capacity rejections by reason, token holds and refunds, upstream status, p95
latency, and readiness. The mock provider deliberately holds calls for 1.2 seconds,
so the overloaded run makes Tyr's pre-provider shedding visible without API
keys or usage charges. Stop and remove the stack with `npm run demo:down`.

The demo intentionally leaves the operator token unset. When enabling
`TYR_OPERATOR_BEARER_TOKEN`, add the same bearer credential to Prometheus's
scrape configuration.
