---
title: Admission classes
---

# Admission classes

Admission classes partition a physical pool into a bounded set of service
classes. They are intended for noisy-neighbor isolation, not provider RPM/TPM
rate limiting or cumulative spend policy.

```yaml
pools:
  - name: openai-primary
    modelPrefixes: [gpt, o1, o3, o4]
    estimatorModel: gpt-4o
    maxConcurrent: 40
    inFlightTokenBudget: 400000
    admissionClasses:
      defaultClass: standard
      classes:
        standard:
          protectedConcurrent: 12
          maxConcurrent: 32
          protectedInFlightTokens: 100000
          maxInFlightTokens: 300000
          borrowedAdmissionSlot:
            releaseMechanism: deadline_abandonment
            deadlineMs: 30000
        premium:
          protectedConcurrent: 8
          maxConcurrent: 24
          protectedInFlightTokens: 80000
          maxInFlightTokens: 240000
      rules:
        - admissionClass: premium
          tenantIds: [tenant-paid]
        - admissionClass: premium
          applicationIds: [latency-sensitive-app]
          roles: [tier.premium]
```

The class table is fixed at startup and capped at 64 entries. Rules are capped
at 256 entries, each selector list is capped at 256 values, and only configured
class IDs appear in runtime state or metrics. A request with no matching rule
uses `defaultClass`. When multiple selector categories appear in one rule they
must all match; the first matching rule wins.

Each class may define a protected floor and a hard ceiling beneath the physical
pool limit. A request consumes its own protected capacity first; work above that
floor borrows from the shared remainder left after every configured floor. A
request must fit the physical pool, its hard class ceiling, and the currently
available shared remainder.

Protected floors are strict within the active local limit snapshot. An idle
floor is not implicitly lent to another class; Latchflo can implement
demand-aware lending by issuing a newer atomic class-limit snapshot. Increasing
or shrinking a floor or ceiling stops unsafe new borrowing, but existing work
otherwise restores protection by attrition, unless the pool has a
[take-back grace period](stopping-admitted-requests.md).

`borrowedAdmissionSlot` places a post-admission wall-clock lease on local
concurrency borrowed by that class. It does not apply when the admission fits
inside the class's own protected concurrency. At expiry Tyr returns the borrowed
local slot, aborts the linked callback signal, and returns
`504 borrowed_admission_deadline` to a caller whose response has not started.
The admission's token reservation remains held until the local callback settles,
so returning one resource cannot falsely return another.

That deadline is an enforceable restoration bound only for Tyr's local admission
slot. A provider may continue generating after client cancellation, so Tyr
reports upstream cancellation as requested and upstream reclamation as
unverified. If an account quota, model-side queue, or accelerator is the
constrained resource, retain an unlent floor or an independently enforceable
provider partition for the protected workload. A Tyr deadline alone is not that
upstream guarantee.

Class selection uses authenticated identity produced by Tyr's identity layer.
Without identity, all requests use the configured default class. Programmatic
embedders may supply `resolveAdmissionClass`, but the returned value must still
name a configured class. Never map arbitrary tenant IDs directly to class IDs.

Prometheus exposes bounded per-class protected, borrowed, in-flight,
configured-ceiling, admission, release, and rejection series using only the
configured class ID. Per-pool shared-remainder gauges and `/stats` expose the
corresponding capacity and token-accounting totals.

Latchflo 0.7 and newer may distribute the per-replica class limit table on each
grant. Tyr 0.22 applies protected floors and hard ceilings atomically with the
physical pool revision while keeping identity-to-class rules local.
