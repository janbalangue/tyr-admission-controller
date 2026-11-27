---
title: Capacity-aware replica routing
---

# Capacity-aware replica routing

Tyr can optionally route an external request to another Tyr replica before
admission. Each replica publishes a shared-secret-protected capacity snapshot
and polls its configured peers outside the request path. For each validated
request, the ingress replica computes the exact local reservation and ranks
fresh, ready replicas by the capacity that would remain after admitting it:

- immediate physical-pool concurrency headroom;
- priority-adjusted physical-pool token headroom when configured;
- selected admission-class concurrency and token headroom;
- shared capacity remaining after protected class floors; and
- the tightest normalized constraint, so global capacity cannot hide a hard
  class ceiling or protection-layer rejection.

Equal candidates prefer the local replica to avoid an unnecessary hop.
Observe-mode pools stay local and are never selected as remote destinations, so
shadow evaluation cannot silently change the request topology or bypass an
enforce-mode ingress decision. A forwarded request carries an authenticated one-hop marker and the selected
bounded admission-class ID under the same shared secret. The class cannot be
reclassified by a drifting destination policy, and the request can never be
forwarded again, preventing routing loops. The destination Tyr remains the
authoritative admission controller and may still reject if capacity changed
after the last snapshot. Tyr never retries a request after forwarding it.

This does not replace Latchflo. Latchflo still owns bounded fleet-wide grants;
capacity-aware routing only chooses which current grant partition should
evaluate a request. Replicas sharing a pool name must use compatible request
projection and estimator policy. Tyr refuses to route between token-aware and token-unaware definitions of the
same pool. Schema-3 snapshots carry protected and borrowed capacity; when local
floors are configured, schema-1/2 peers are excluded because they cannot prove
equivalent enforcement. In Latchflo managed mode, Latchflo 0.13+ may publish a
complete versioned routing topology in desired state. Tyr applies only newer
revisions, filters itself, drops removed-peer capacity immediately, and begins
polling newly advertised peers without a restart. The Tyr-to-Tyr shared secret is
never distributed by Latchflo and remains local configuration. Standalone Tyr, or
managed Tyr connected to an older Latchflo, keeps the configured startup peer list.

```yaml
routing:
  capacityAware:
    instanceId: tyr-r1
    sharedSecretEnv: TYR_ROUTING_SECRET
    pollIntervalMs: 100
    staleAfterMs: 1000
    probeTimeoutMs: 250
    forwardTimeoutMs: 30000
    peers:
      - id: tyr-r2
        baseUrl: http://tyr-r2:8787
      - id: tyr-r3
        baseUrl: http://tyr-r3:8787
```

Set the same random `TYR_ROUTING_SECRET` on every listed replica. Keep peer
URLs on a trusted private network and use TLS whenever that network is not
cryptographically isolated. Successful forwarding adds `x-tyr-routed-by` and
`x-tyr-routed-to` to the client response.
