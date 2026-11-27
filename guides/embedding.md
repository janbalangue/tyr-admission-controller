---
title: Embedded control surface
---

# Embedded control surface

`createGateway()` still returns the narrow `control` object for custom embedded
agents and tests. It does not expose the request-execution bulkhead itself.

```ts
const { control } = createGateway(options);
const result = control.applyLimits([
  {
    pool: "interactive-claude",
    limits: {
      revision: 101,
      maxConcurrent: 24,
      maxQueue: 0,
      tokenBudget: { budget: 240_000, highPriorityReserve: 48_000 },
    },
    provenance: {
      source: "latchflo",
      grantId: "f6bc97d0-14ba-4ca7-b9bb-9a275a8b1533",
      controllerEpoch: 12,
      revision: 101,
      expiresAt: "2026-07-24T18:30:00.000Z",
    },
  },
]);

if (!result.applied) console.error(result.reason, result.pool);
```

Every update must provide the complete snapshot expected by that pool.
Revisions must be strictly greater than the current revision, and provenance
revision must match the limit revision. Tyr retains a bounded revision ledger
so in-flight requests remain attributable to the grant captured at admission.
Reductions use shrink-by-attrition; setting `maxConcurrent: 0` disables new
admissions immediately. A pool with `stop.takeBackGraceMs` stops what is still
above the new limits when the grace period ends. Tyr adds the pool's own stop
policy to every update and ignores a `stop` field on the update. A pool that
starts open with a stop policy starts at revision `max(limitsRevision, 1)`,
so read `control.limits()` for the current revision instead of assuming it.
