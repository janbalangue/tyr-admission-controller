---
title: Developing Tyr
---

# Developing Tyr

## Release gate

Install dependencies and run the full release gate:

```bash
npm ci
npm run release:check

# Zero-cost metrics demonstration
npm run demo:up
npm run demo:normal
npm run demo:overload
npm run demo:down
```

## Development commands

```bash
npm run lint
npm run lint:fix
npm run typecheck
npm test
npm run build
npm run docs
npm run smoke
npm run verify:routing
npm run verify:routing-topology
npm run verify:openai-responses
npm run verify:responses-state
npm run verify:borrowed-restoration
npm run verify:stop
npm run verify:demand
npm run verify:admission-provenance
npm run verify:eval
npm run release:check

# Self-serve evaluation
npm run eval
npm run eval:serve

# Zero-cost metrics demonstration
npm run demo:up
npm run demo:normal
npm run demo:overload
npm run demo:down
```

## Repository layout

```text
config/
  tyr.example.yaml  documented configuration template
  tyr.schema.json   JSON Schema for editor and CI integration
src/
  admission.ts      request projection and estimator policy
  adapters.ts       provider validation, projection, and usage parsing
  cli.ts            offline configuration validation command
  config.ts         YAML and legacy environment configuration loading
  identity.ts       JWT/JWKS authentication, immutable identity, and role policy
  index.ts          validated process entrypoint and managed-mode lifecycle
  latchflo.ts        built-in Latchflo agent, retry, readiness, demand heartbeat, and token persistence
  demand.ts          accepted-heartbeat demand deltas derived from live pool statistics
  pools.ts          v3.18 policy runtime, progressive reconciliation, versioned limits, stop policy, observe mode, and drain
  routing.ts        protected peer snapshots and request-specific replica selection
  responses-state.ts response memory for Responses follow-ups and its state file
  server.ts         HTTP proxy, routing, admission, telemetry, timeouts, and shutdown
  telemetry.ts      Prometheus metrics and structured admission audit events
  sse.ts            Anthropic streaming usage extraction
  sse-openai.ts     OpenAI Chat Completions streaming usage extraction
  sse-responses.ts  OpenAI Responses semantic streaming usage extraction
  validation.ts     provider-agnostic request shape validation
test/
  admission.test.ts request projection and estimator regression tests
  config.test.ts    file-schema and environment compatibility tests
  gateway.test.ts   gateway end-to-end tests
  routing.test.ts   request-specific replica-scoring regression tests
  demand.test.ts    managed demand snapshot and checkpoint regression tests
  routing-gateway.test.ts authenticated one-hop routing integration tests
  latchflo.test.ts  managed-agent, readiness, persistence, and expiration tests
  pools-v311.test.ts v3.11 preview, exact admission provenance, observe, reconfiguration, and drain tests
  responses-state.test.ts response-memory bounds, ownership, and state-file tests
  responses-state-gateway.test.ts follow-up admission, refusal, streaming, and restart tests
  responses-state-config.test.ts responsesState file-configuration and schema tests
  stop.test.ts      stop policy, overrun, take-back, drain-deadline, and stop metric tests
  stop-gateway.test.ts stopped-request replies, stopping shutdown, response memory, and managed-pool tests
  stop-config.test.ts stop file-configuration and schema tests
  stream-head.test.ts streamed-reply status before and after the first chunk
  stream-usage-final.test.ts which stream usage each provider format marks as final
eval/
  run.mjs           self-serve evaluation runner (npm run eval, eval:serve, verify:eval)
  tyr.eval.yaml     single-node evaluation configuration with admission classes
  provider.mjs      capacity-limited mock OpenAI provider
  identity.mjs      local evaluation-only JWT issuer
  sdk/              OpenAI SDK quickstarts for Node and Python
guides/             topical documentation, also published as the documentation site
typedoc.json        documentation site configuration (npm run docs)
Dockerfile          production multi-stage image
compose.example.yaml local file-configured container example
demo/                mock provider, Prometheus, Grafana, dashboard, and load generator
EVALUATION.md       evaluation checklist
```
