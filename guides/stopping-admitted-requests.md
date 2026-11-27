---
title: Stopping admitted requests
---

# Stopping admitted requests

By default Tyr never touches a request once it has admitted it. A request that
uses more tokens than it reserved only widens its hold, a lowered limit waits
for running requests to finish, and a bounded shutdown closes connections at
its deadline. Since 0.35.0 a deployment can opt in to stopping admitted
requests in those three situations. Stops are made by
`async-bulkhead-llm@3.18.0`.

```yaml
shutdown:
  drainTimeoutMs: 30000
  stopOnDrainTimeout: true          # stop what outlives the drain deadline

pools:
  - name: interactive-claude
    inFlightTokenBudget: 400000
    stop:
      overrunAllowanceTokens: 2000  # how far a hold may pass its reservation
      takeBackGraceMs: 5000         # then work above lowered limits is stopped
```

A stop means the same thing whatever caused it:

- The request's concurrency slot returns at once.
- Tyr drops the upstream call. The request's tokens are returned when that
  call has ended on Tyr's side, normally within milliseconds. Tyr does not
  wait for the provider, and it cannot tell whether the provider stopped
  work.
- A request that has been sent no part of its reply gets `503` with
  `error.type: "admission_stopped"`, `x-admission-reason: stopped` and
  `x-admission-stop-cause`. That includes a streamed request whose first
  chunk has not been written. Once part of a reply has been written, the
  reply is cut: its connection closes with no further event. Neither gets a
  retry hint.
- The request is counted and audited as `stopped`, with its cause. It is not
  an admission rejection and not an upstream failure.
- On a pool with a queue (`maxQueue` above 0), the returned slot goes to the
  request at the head of the queue at once, while the stopped request's
  tokens are still charged. A waiter whose reservation does not fit beside
  them is rejected with `429 budget_limit` instead of waiting.

| Cause | Turned on by | A request is stopped when |
|---|---|---|
| `overrun` | `pools[].stop.overrunAllowanceTokens` | A usage report raises its hold more than the allowance above its reservation. Also, when a report leaves the pool above `inFlightTokenBudget`, or a class above `maxInFlightTokens`, requests are stopped until the rest fit. |
| `limits` | `pools[].stop.takeBackGraceMs` | A limits update left running requests above the new limits, and the grace period has ended. |
| `drain_deadline` | `shutdown.stopOnDrainTimeout` | It is still running when `shutdown.drainTimeoutMs` elapses. |

When Tyr has to choose, it stops requests on borrowed class capacity first,
then normal priority before high priority, then the request admitted last.
Queued requests and observe-mode bypasses hold no capacity and are never
stopped.

## Overrun

The allowance is measured on the request's hold: the tokens it has charged to
the pool. It is not measured on the request's usage.

- With progressive reconciliation on, which is the default for a budgeted
  pool, a hold shrinks as the reply streams and grows again only by the output
  beyond the request's output reservation. The request is stopped once that
  excess is more than its reservation plus the allowance, less the safety
  margin it still holds. A request that reserved 1,000 input and 4,096 output
  tokens, with the default 256-token margin and an allowance of 2,000, is
  stopped after about 6,800 tokens of output beyond the 4,096. An input
  estimate that was too low does not grow the hold.
- With `progressiveReconciliation.enabled: false`, a hold is the reported
  input plus the larger of the output reservation and the reported output.
  The request is stopped once its input above the estimate plus its output
  above the reservation exceeds the allowance. An input estimate that was too
  low counts here, so leave room for estimation error.
- Tyr sees usage before a request completes only while its reply streams. A
  request that is not streamed reports usage at completion, so it is never
  stopped for its own usage. It can still be stopped to make room when
  another request's report leaves the pool above its budget.
- The usage a provider sends as it ends a reply never stops that reply. By
  then the work is done, and cutting the reply would save nothing. On a pool
  with an allowance Tyr applies that usage when the request completes. It is
  recognized as the Anthropic `message_delta` that carries a stop reason, a
  Chat Completions usage chunk with no choices or with a finish reason, and a
  Responses event that shows a finished response.
- An overrun stop therefore needs usage that arrives before the reply ends.
  In the stream formats Tyr reads, OpenAI's Chat Completions and Responses
  report usage only as a reply ends, so their requests are not stopped for
  their own output. Anthropic reports input tokens in its first event and
  output tokens in its closing one. What an allowance acts on is a server
  that reports cumulative usage while it streams, input that Anthropic
  reports above the estimate when progressive reconciliation is off, and a
  pool or class pushed above its token ceiling by either.
- On a pool with an allowance, closing usage is not a mid-stream report: it
  is absent from `tyr.progressiveReconciliation`, and an overrun that only
  the closing usage shows is not added to `tyr_pool_tokens_overrun_total`.
  The consumed-token counters include it.

## Take-back

- Nothing is stopped during the grace period, and a request that finishes
  inside it is left alone. A grace period of `0` stops on the next timer tick.
- "Above the new limits" covers the pool's `maxConcurrent`, its token budget,
  a class's own ceilings, and a class floor that was restored while other
  classes were using that capacity.
- A newer limits update replaces a take-back that is still waiting, and its
  own grace period starts when it is applied. Updates that arrive faster than
  the grace period keep postponing the stop, so choose a grace period shorter
  than the interval between updates.
- In [Latchflo managed mode](latchflo.md) this bounds a shrink that
  otherwise waits for requests to finish. It also covers the zero-capacity
  revision Tyr applies when a grant expires: requests still running when the
  grace period ends are stopped.

## Shutdown

`shutdown.stopOnDrainTimeout` requires `shutdown.drainTimeoutMs`. It applies
to every pool, including observe pools and pools without a `stop` block. At
the deadline Tyr stops each request still running, answers or cuts it, and
then closes the remaining connections as before. `shutdown()` reports
`stopped`, the number of admissions the deadline stopped, and the process logs
it as `stopped=<n>`. The result is taken at the deadline, before the dropped
calls have ended, so `drained` is `false` and `inFlight` still counts them.

## Where the policy lives

The library accepts a stop policy only as part of a limits snapshot and does
not carry it from one revision to the next. Tyr therefore states the pool's
configured policy on every limits update it applies, whether the update comes
from the [embedded control surface](embedding.md) or from
Latchflo. A `stop` field on an update is ignored: a control plane does not
choose the policy.

- A pool that starts open applies the policy at startup, at revision
  `max(limitsRevision, 1)`. Revision 0 cannot carry a policy, so a pool whose
  `limitsRevision` is 0 or omitted starts at revision 1, and its first runtime
  update must be revision 2 or higher.
- A pool that starts closed (`maxConcurrent: 0`), as every Latchflo-managed
  pool does, keeps its configured revision and gets the policy with its first
  update.
- A `stop` block cannot be combined with `admissionMode: observe`.
- Stop settings are read from a configuration file or passed to
  `createGateway`. Legacy environment mode has no variables for them.

## Observing stops

- `GET /stats`: `limits.stop` is the applied policy. `tyr.stop` holds the
  configured `policy`, `stopped`, and `stoppedByCause` with every cause
  listed. It is present on a pool with a `stop` block, and on any pool once
  one of its requests has been stopped. `llm.stopped` and
  `llm.stoppedByCause` are the library's own counters and are absent until
  the first stop.
- `GET /metrics`: `tyr_pool_stopped_total{pool,cause}`,
  `tyr_pool_admission_class_stopped_total{pool,admission_class}`,
  `tyr_pool_stop_overrun_allowance_tokens{pool}` and
  `tyr_pool_stop_take_back_grace_seconds{pool}`. They exist only for a pool
  that reports `tyr.stop`. `tyr_requests_total` and
  `tyr_upstream_duration_seconds` gain the `outcome` value `stopped`.
- Between a stop and the end of the dropped call, the request holds tokens
  but no slot. For that moment it shows in `tyr_pool_work_in_flight` and in
  `tyr.restoration.upstreamCapacity.activeAccountingHolds`, not in
  `tyr_pool_in_flight`.
- The admission audit event has `settlement: "stopped"` and a `stopCause`.

A stop is a local decision. It returns Tyr's slot and tokens and closes Tyr's
connection to the provider. It does not prove that a provider account, a
model-side queue or an accelerator stopped work, and Tyr lends the returned
capacity again without that proof. If the constrained resource is upstream,
keep an unlent floor or use a provider-side partition.
