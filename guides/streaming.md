---
title: Streaming reconciliation
---

# Streaming reconciliation

Progressive reconciliation, introduced in Tyr 0.22, uses the current
`async-bulkhead-llm@3.18.0` runtime to account for the work still ahead
instead of retaining tokens the provider has already processed. For a
streaming request, the first cumulative input report returns the completed
input reservation. Later cumulative output reports shrink the remaining
future-output hold. Updates are coalesced so every token does not create an
accounting write, and a configurable safety floor remains until final release.

```yaml
pools:
  - name: interactive-claude
    inFlightTokenBudget: 400000
    progressiveReconciliation:
      enabled: true                 # default for budgeted pools
      updateStepTokens: 256         # apply after this much additional release
      outputSafetyMarginTokens: 256 # retained until completion
```

`GET /stats` exposes `tyr.progressiveReconciliation` with report, update,
coalescing, and early-release counters. Disable the block explicitly to retain
the conservative 3.12 hold behavior. Streams without cumulative provider usage
remain conservative automatically. The repository lockfile resolves the bundled
`vendor/async-bulkhead-llm-3.18.0.tgz` and
`vendor/async-bulkhead-ts-1.0.1.tgz`, so the release can be built before those
artifacts are fetched from a public registry.
