---
title: Configuration
---

# Configuration

## File configuration

Set `TYR_CONFIG_FILE` to select file mode. Relative paths are resolved from the
process working directory:

```bash
TYR_CONFIG_FILE=/etc/tyr/config.yaml
```

Values are literal. Tyr does not expand `${ENV_VAR}` placeholders inside YAML.
Keep provider credentials in the calling application or its secret manager.

File mode does not merge with legacy Tyr environment variables. When
`TYR_CONFIG_FILE` is set, variables such as `PORT`, `UPSTREAM_URL`,
`TOKEN_BUDGET`, and `MAX_CONCURRENT` cause startup to fail. This keeps the
effective policy deterministic and reviewable.

When `TYR_CONFIG_FILE` is absent, Tyr uses the legacy single-pool environment
configuration documented in [`.env.example`](../.env.example).

## Run Tyr from a configuration file

Copy the example configuration:

```bash
cp config/tyr.example.yaml tyr.yaml
```

Edit `tyr.yaml`, then validate it without opening a listener:

```bash
npm run validate:config -- --config ./tyr.yaml
```

Successful validation prints the resolved file path, schema version, SHA-256
configuration fingerprint, port, pool names, and enabled routes.

Start Tyr:

```bash
TYR_CONFIG_FILE=./tyr.yaml npm start
```

At startup, Tyr validates the entire file before calling `server.listen()`.
Unreadable files, malformed YAML, unknown properties, invalid URLs, duplicate
pool names or model prefixes, unsafe numeric values, and invalid reserve
relationships terminate the process with a nonzero exit code.

Startup configuration seeds pool routing, estimator policy, timeout behavior,
and the initial admission-limit snapshot. Routing and estimator changes still
require a restart. Concurrency, queue capacity, token budget, and high-priority
reserve can be replaced at runtime through the versioned `control` interface;
existing work drains under the new ceilings. It is not stopped merely because
a limit shrank, unless the pool has a
[take-back grace period](stopping-admitted-requests.md).

## Configuration schema

Every configuration file must declare the current schema version:

```yaml
version: 1
```

The documented template is
[`config/tyr.example.yaml`](../config/tyr.example.yaml). Editor and CI tooling can
use [`config/tyr.schema.json`](../config/tyr.schema.json), while runtime validation
remains the source of truth for cross-field rules.

### Complete example

```yaml
version: 1

server:
  port: 8787
  maxRequestBodyBytes: 1048576
  maxOutputTokens: 200000

upstreams:
  anthropic:
    baseUrl: https://api.anthropic.com
  openai:
    baseUrl: https://api.openai.com

timeouts:
  responseHeadersMs: 30000
  streamIdleMs: 30000
  clientStallMs: 30000

shutdown:
  drainTimeoutMs: 30000
  stopOnDrainTimeout: false

priority:
  trustHeader: false

identity:
  jwt:
    jwksUrl: https://identity.example.com/.well-known/jwks.json
    issuer: https://identity.example.com/
    audience: moflux-tyr
    header: x-tyr-identity-token
    algorithms: [RS256]
    claims:
      subject: sub
      tenantId: tenant_id
      applicationId: azp
      roles: roles
  roles:
    invoke: [tyr.invoke]
    operator: [tyr.operator]
    highPriority: [tyr.priority.high]

telemetry:
  metrics:
    enabled: true
  audit:
    enabled: false

pools:
  - name: interactive-claude
    modelPrefixes: [claude-sonnet-4, claude-haiku-4]
    estimatorModel: claude-sonnet-4-5
    maxConcurrent: 40
    maxQueue: 0
    limitsRevision: 100
    admissionMode: enforce
    inFlightTokenBudget: 400000
    highPriorityTokenReserve: 80000
    defaultOutputReservation: 8192
    opaqueMediaInputTokenReservation: 2048
    adaptiveEstimation:
      enabled: true
      smoothing: 0.2
      minSamples: 5
      minCorrection: 0.5
      maxCorrection: 2
      maxModels: 64

  - name: batch-openai
    modelPrefixes: [gpt-4o, gpt-5, o1, o3, o4]
    estimatorModel: gpt-4o
    maxConcurrent: 20
    maxQueue: 0
    limitsRevision: 100
    admissionMode: observe
    inFlightTokenBudget: 250000
    defaultOutputReservation: 4096
```

### Field reference

| Field | Required | Meaning |
|---|---:|---|
| `version` | Yes | Configuration schema version; currently `1` |
| `server.port` | No | Listen port; default `8787` |
| `server.maxRequestBodyBytes` | No | Maximum buffered request body; default 1 MiB |
| `server.maxOutputTokens` | No | Validation ceiling for request output-limit fields; default `200000` |
| `upstreams.anthropic.baseUrl` | One upstream required | Enables `POST /v1/messages` |
| `upstreams.openai.baseUrl` | One upstream required | Enables `POST /v1/chat/completions` and `POST /v1/responses` |
| `timeouts.responseHeadersMs` | No | Maximum wait for upstream response headers |
| `timeouts.streamIdleMs` | No | Maximum gap between upstream stream chunks |
| `timeouts.clientStallMs` | No | Maximum wait for a backpressured client to drain |
| `shutdown.drainTimeoutMs` | No | Bounded graceful-drain deadline; omit for unbounded drain |
| `shutdown.stopOnDrainTimeout` | No | Stop requests still running at the drain deadline; requires `drainTimeoutMs`; default `false` |
| `priority.trustHeader` | No | Legacy trusted-proxy fallback; ignored on provider routes when identity is configured |
| `identity.jwt.jwksUrl` | Identity only | HTTP(S) JWKS endpoint used to verify JWT signatures |
| `identity.jwt.issuer` | Identity only | Exact required `iss` claim |
| `identity.jwt.audience` | Identity only | Required audience string or list; at least one must match `aud` |
| `identity.jwt.header` | No | Header containing `Bearer <JWT>`; default `x-tyr-identity-token` |
| `identity.jwt.algorithms` | No | Allowed RSA algorithms; default `[RS256]` |
| `identity.jwt.cacheTtlMs` | No | JWKS cache lifetime; unknown `kid` forces one refresh |
| `identity.jwt.requestTimeoutMs` | No | JWKS request deadline; default `5000` |
| `identity.jwt.clockSkewSeconds` | No | Clock tolerance for `exp`, `nbf`, and `iat`; default `30` |
| `identity.jwt.requireExpiration` | No | Require `exp`; default `true` |
| `identity.jwt.claims.*` | No | Claim names for subject, tenant, application, and roles |
| `identity.roles.invoke` | No | Any matching role may invoke provider routes; omitted/empty allows any authenticated identity |
| `identity.roles.operator` | No | Any matching role may read `/stats` and `/metrics` |
| `identity.roles.highPriority` | No | Any matching role receives `high` admission priority |
| `routing.capacityAware.instanceId` | Routing only | Stable identifier for this Tyr replica |
| `routing.capacityAware.sharedSecretEnv` | Routing only | Environment variable containing the shared Tyr-to-Tyr secret |
| `routing.capacityAware.peers` | Routing only | Startup/fallback peer IDs and base URLs; managed Latchflo 0.13+ topology replaces the set after the first newer topology snapshot |
| `routing.capacityAware.pollIntervalMs` | No | Peer snapshot refresh cadence; default `100` |
| `routing.capacityAware.staleAfterMs` | No | Maximum usable peer snapshot age; default `1000` |
| `routing.capacityAware.probeTimeoutMs` | No | Peer capacity-probe deadline; default `250` |
| `routing.capacityAware.forwardTimeoutMs` | No | Deadline for a routed peer to return response headers; default `30000` |
| `telemetry.metrics.enabled` | No | Expose Prometheus text at `/metrics`; default `true` |
| `telemetry.audit.enabled` | No | Emit one structured JSON line per admission decision; default `false` |
| `retryHint.enabled` | No | Send retry hints on capacity rejections; default `true` |
| `retryHint.minMs` | No | Smallest hint Tyr sends; default `50` |
| `retryHint.maxMs` | No | Largest hint Tyr sends; default `30000` |
| `retryHint.halfLifeMs` | No | Half-life of the observed-completion average; default `5000` |
| `retryHint.minSamples` | No | Completions a pool needs before it sends a hint; default `3` |
| `responsesState.file` | Response memory only | State file for recorded Responses replies; created when missing, relative to the configuration file's directory |
| `responsesState.maxEntries` | No | Most records kept at once, from `1` through `1000000`; default `10000` |
| `responsesState.ttlMs` | No | Milliseconds a record stays usable; default `2592000000` (30 days) |
| `pools[].name` | Yes | Unique pool name used in stats and rejection details |
| `pools[].modelPrefixes` | Yes | Unique prefixes; longest matching prefix wins |
| `pools[].estimatorModel` | Yes | Model used for estimator ratios; requests are not rewritten |
| `pools[].maxConcurrent` | Yes | Maximum active requests in the pool |
| `pools[].maxQueue` | No | Maximum accepted waiters; default `0` for fail-fast admission |
| `pools[].queueTimeoutMs` | No | Construction-time timeout for queued requests |
| `pools[].limitsRevision` | No | Initial non-negative admission-limit revision; default `0` |
| `pools[].admissionMode` | No | `enforce` (default) or shadow `observe` |
| `pools[].inFlightTokenBudget` | No | Admission-time in-flight token ceiling |
| `pools[].highPriorityTokenReserve` | No | Token headroom reserved for high-priority requests |
| `pools[].defaultOutputReservation` | No | Output reservation used when the request omits an output limit |
| `pools[].opaqueMediaInputTokenReservation` | No | Fixed surcharge per opaque media/document block; default `2048`, `0` disables it |
| `pools[].adaptiveEstimation.enabled` | No | Enables local per-model correction; default `true` for budgeted pools |
| `pools[].adaptiveEstimation.smoothing` | No | EWMA smoothing in `(0, 1]`; default `0.2` |
| `pools[].adaptiveEstimation.minSamples` | No | Samples before applying correction; default `5` |
| `pools[].adaptiveEstimation.minCorrection` | No | Lower factor clamp; default `0.5` |
| `pools[].adaptiveEstimation.maxCorrection` | No | Upper factor clamp; default `2` |
| `pools[].adaptiveEstimation.maxModels` | No | Maximum tracked model keys; default `64` |
| `pools[].admissionClasses.defaultClass` | Classes only | Configured class used when no ordered identity rule matches |
| `pools[].admissionClasses.classes` | Classes only | Fixed map of at most 64 class IDs to optional protected floors and hard concurrency/token ceilings |
| `pools[].admissionClasses.classes.<id>.borrowedAdmissionSlot.releaseMechanism` | No | Must be `deadline_abandonment`; releases only borrowed local concurrency |
| `pools[].admissionClasses.classes.<id>.borrowedAdmissionSlot.deadlineMs` | With borrowed-slot policy | Post-admission local slot lease from `1` through `2147483647` ms; not an upstream reclamation guarantee |
| `pools[].admissionClasses.rules` | No | Up to 256 ordered mappings from trusted subject, tenant, application, or role claims to fixed class IDs |
| `pools[].stop.overrunAllowanceTokens` | No | Tokens a request's hold may grow above its reservation before the request is stopped; requires `inFlightTokenBudget` |
| `pools[].stop.takeBackGraceMs` | No | Milliseconds after a limits update before requests above the new limits are stopped, from `0` through `2147483647` |

Identity verification remains fail closed when no usable key is cached. A fresh
cached key remains usable until `identity.jwt.cacheTtlMs` expires, allowing Tyr to
continue serving through a temporary JWKS outage without weakening signature
verification.

`inFlightTokenBudget` is tri-state:

- Omit it to disable token-budget admission for the pool.
- Set it to `0` to reject every budget-gated request.
- Set a positive integer to enforce an in-flight ceiling.

`highPriorityTokenReserve` requires `inFlightTokenBudget` and cannot exceed it.
It reserves token headroom only; it does not reserve a concurrency slot or
preempt running work.

`opaqueMediaInputTokenReservation` controls the conservative surcharge applied
to each opaque image, audio, document, file, or video block. Omit it for 2,048
tokens per block. Set it to `0` only when another estimator or upstream policy
accounts for that cost.

`adaptiveEstimation` requires no external state. Set `enabled: false` when a
custom exact tokenizer is already supplying reservations or when deterministic
estimates across process restarts are more important than local calibration.

`shutdown.drainTimeoutMs` uses the bounded drain result. When the deadline
expires, Tyr records the outstanding count, closes remaining HTTP connections,
and returns the snapshot from `shutdown()`. If it is omitted, shutdown waits
for final token settlement as well as local concurrency. A callback that remains
unsettled after its borrowed slot was returned can therefore keep an unbounded
shutdown pending; configure the timeout when process termination must be
bounded. Expiry bounds Tyr's wait, not upstream provider execution.

`shutdown.stopOnDrainTimeout` and a pool's `stop` block turn on
[stopping admitted requests](stopping-admitted-requests.md). A `stop` block must
set at least one of its two fields and cannot be combined with
`admissionMode: observe`.

## Validate configuration in CI

```bash
npm ci
npm run validate:config -- --config ./deploy/tyr.yaml
```

The built CLI is also available directly:

```bash
npm run build
node dist/cli.js validate --config ./deploy/tyr.yaml
```

The package declares a `tyr` binary, so an installed package can run:

```bash
tyr validate --config ./deploy/tyr.yaml
```

## Legacy environment mode

The original environment entrypoint remains available for simple single-pool
deployments:

```bash
UPSTREAM_URL=https://api.anthropic.com \
OPENAI_UPSTREAM_URL=https://api.openai.com \
TOKEN_BUDGET=500000 \
ADMISSION_MODE=enforce \
ADAPTIVE_ESTIMATION=true \
OPAQUE_MEDIA_INPUT_TOKENS=2048 \
MAX_CONCURRENT=50 \
npm start
```

See [`.env.example`](../.env.example) for every legacy variable. New multi-pool
deployments should use file configuration.
