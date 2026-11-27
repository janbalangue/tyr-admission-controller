---
title: Latchflo managed mode
---

# Latchflo managed mode

Tyr runs on its own. Latchflo, a separately licensed control plane, can
coordinate one capacity envelope across many Tyr replicas.

## Overview

Use [`config/tyr.latchflo.example.yaml`](../config/tyr.latchflo.example.yaml) as the
starting point. Managed pools must begin closed:

```yaml
pools:
  - name: openai-primary
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 0
    maxQueue: 0
    limitsRevision: 0
    admissionMode: enforce

controlPlane:
  type: latchflo
  url: http://latchflo-control-plane:8080
  instanceId: tyr-a
  pools: [openai-primary]
  bootstrapTokenEnv: LATCHFLO_AGENT_BOOTSTRAP_TOKEN
  agentTokenFile: /var/lib/tyr/latchflo-agent.token
```

`/healthz` reports process liveness. `/readyz` returns `503` until all managed
pools hold valid grants and returns to `503` when a grant expires. The listener
may therefore remain observable while admission remains safely closed.

With Latchflo 0.6 or newer, the same authenticated heartbeat also carries a
bounded demand snapshot for every managed pool. No additional endpoint or
request-path callback is required. Latchflo can use these observations for
work-conserving capacity groups while continuing to fence all allocations with
expiring grants.

## Managed-mode configuration

File configuration can make Latchflo operation part of Tyr's normal process
lifecycle. No package installation or `src/index.ts` modification is required.

```yaml
routing:
  capacityAware:
    instanceId: tyr-a
    sharedSecretEnv: TYR_ROUTING_SECRET
    # Empty is valid in Latchflo 0.13+ managed mode; desired-state topology
    # supplies the routable fleet after startup.
    peers: []

controlPlane:
  type: latchflo
  url: http://latchflo-control-plane:8080
  instanceId: tyr-a
  pools: [interactive-claude, batch-openai]
  bootstrapTokenEnv: LATCHFLO_AGENT_BOOTSTRAP_TOKEN
  agentTokenFile: /var/lib/tyr/latchflo-agent.token
  retryIntervalMs: 1000
  retryMaxIntervalMs: 30000
  requestTimeoutMs: 5000
  metadata:
    region: us-west
    zone: us-west-2a
    version: 0.36.0
    endpoint: http://tyr-a:8787
    labels:
      environment: demo
```

The bootstrap credential is read from the named environment variable only when
no persisted agent token exists. After registration, Tyr writes the rotated
agent token atomically with owner-only permissions. Relative token paths are
resolved against the configuration file directory.

When both managed mode and capacity-aware routing are enabled, the routing and
control-plane `instanceId` values must match. Latchflo 0.13+ advertises active
agents that have routing endpoints; Tyr treats each newer topology as the complete
peer set. Older Latchflo responses omit `routingTopology`, in which case the
startup `peers` list remains unchanged. `TYR_ROUTING_SECRET` is still provisioned
directly to Tyr replicas and is not part of Latchflo desired state.

Tyr opens its HTTP listener even when Latchflo is temporarily unavailable so
`/healthz` can distinguish process health from control-plane readiness.
Transient registration, heartbeat, and desired-state failures use single-flight,
bounded exponential backoff with jitter; `429` and `503` `Retry-After` values are
honored as a minimum delay. Permanent configuration, authentication, and
protocol failures are not retried continuously. Every control-plane request is
bounded by `requestTimeoutMs`.

## Demand-aware Latchflo heartbeats

Tyr automatically derives one snapshot per managed pool from its existing
statistics. Tyr 0.36.0 carries forward bounded per-class demand in that additive
heartbeat while preserving the original pool-level fields:

```json
{
  "demand": [
    {
      "pool": "interactive-claude",
      "observedAt": "2026-08-01T20:00:00.000Z",
      "inFlight": 12,
      "pending": 0,
      "recentAdmissions": 31,
      "recentRejections": 4,
      "recentBudgetRejections": 3,
      "recentConcurrencyRejections": 1,
      "inFlightTokens": 9200,
      "availableTokens": 800,
      "lastRequestAt": "2026-08-01T19:59:59.900Z",
      "admissionClasses": [
        {
          "admissionClass": "premium",
          "inFlight": 8,
          "recentAdmissions": 24,
          "recentRejections": 3,
          "recentBudgetRejections": 2,
          "recentConcurrencyRejections": 1,
          "protectedConcurrent": 4,
          "protectedConcurrentInUse": 4,
          "borrowedConcurrent": 4,
          "maxConcurrent": 12,
          "inFlightTokens": 6100,
          "protectedInFlightTokens": 4000,
          "protectedTokensInUse": 4000,
          "borrowedInFlightTokens": 2100,
          "maxInFlightTokens": 12000,
          "lastRequestAt": "2026-08-01T19:59:59.900Z"
        }
      ]
    }
  ]
}
```

`recent*` values are deltas since the last heartbeat accepted by Latchflo, not
process-lifetime totals. Current in-flight work keeps a pool demanding even when
no new arrivals occurred during the interval. A failed heartbeat does not
advance the checkpoint, so its activity is retried rather than lost.

The same accepted-heartbeat semantics apply independently to every configured
admission class. `admissionClasses` is deterministic and bounded by Tyr's fixed
class table (at most 64 entries); tenant, application, subject, and other raw
identity values never become heartbeat keys. `protected*` and `borrowed*` fields
report current use of the active floor and shared remainder. They are telemetry,
not a request for Tyr to resize its own limits.

Tyr 0.36.0 advertises `admissionClassDemand: true`,
`grantOccupancyAck: true`, `admissionClassOccupancyAck: true`, and the additive
`borrowedAdmissionSlotDeadlines: true` capability at registration. Older control
planes that ignore unknown capability and nested evidence fields remain
compatible. Latchflo 0.10.0 continues to use the physical-pool proof introduced
in Tyr 0.24; Latchflo 0.11+ can require the class capability before committing a
class-only handoff ahead of lease expiry.

Tyr omits token fields for concurrency-only pools and currently omits
`oldestPendingMs` because the underlying queue statistics do not expose waiter
age. Latchflo can still age continuous demand from successive reports. Missing
or stale telemetry remains protected by Latchflo; it cannot cause a floor to be
lent early.

## Acknowledged capacity handoffs

When Latchflo 0.10.0 restores capacity from a borrower, it can issue a lower
complete physical-pool grant as a drain target. Tyr installs that higher
revision locally first, so no new request can extend occupancy beyond the new
ceiling. Active work is not revoked; the pool shrinks by attrition. With
`stop.takeBackGraceMs` on the pool, requests still above the new limits when
the grace period ends are stopped, which bounds how long the shrink takes.

Only after the `applied` acknowledgement succeeds does Tyr publish a separate
demand heartbeat. If the exact published snapshot is still above the new
`maxConcurrent` limit, or above a newly introduced/lower token budget, Tyr uses
a bounded 500 ms evidence cadence until a published snapshot is at or below the
target. Normal heartbeat cadence then resumes. Failed acknowledgements or
heartbeats do not weaken local enforcement, and Latchflo can still fall back to
lease expiry rather than double-allocating capacity.

The acknowledgement's `occupancy` object is additive observability evidence;
Latchflo 0.10.0 does not need to trust it to commit a transfer. The fresh
post-ack heartbeat remains the authoritative proof used by that control plane.

Tyr 0.36.0 applies the same ordering to restrictive class-only changes. When a
protected floor is restored, the newly protected capacity reduces the shared
remainder. Tyr therefore keeps publishing bounded class evidence until the sum
of `borrowedConcurrent` fits within the desired shared concurrency remainder and,
for token-managed pools, the sum of `borrowedInFlightTokens` fits within the
desired shared token remainder. Reduced per-class hard ceilings must also contain
their current class occupancy. The heartbeat includes the active protected floors
and hard ceilings so Latchflo can reject stale snapshots.

`/readyz` remains `503` until every managed pool has a complete unexpired grant.
A transient poll failure does not discard a still-valid lease. When a grant
expires, Tyr applies the reserved next even revision with zero capacity and
immediately becomes unready. Requests already running continue, unless the
pool has `stop.takeBackGraceMs`: that revision carries the pool's stop policy
like any other, so they are stopped when the grace period ends. Grant
acknowledgements are best-effort and cannot
interrupt local expiration enforcement after limits have been applied.

Omit `controlPlane.pools` to manage every pool declared in the Tyr file. Pool
names are validated at startup, and a grant batch is preflighted before any
local pool mutates. Queue timeout, model routing, estimator policy, admission
mode, stop policy, and provider upstreams remain construction-time settings.
