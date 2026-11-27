# Tyr Admission Controller

**Decide which LLM requests run, before the provider is called.**

[![CI](https://github.com/janbalangue/tyr-admission-controller/actions/workflows/ci.yml/badge.svg)](https://github.com/janbalangue/tyr-admission-controller/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/janbalangue/tyr-admission-controller.svg)](https://github.com/janbalangue/tyr-admission-controller/releases)
[![license](https://img.shields.io/github/license/janbalangue/tyr-admission-controller.svg)](LICENSE.txt)

📖 **[Full documentation →](https://janbalangue.github.io/tyr-admission-controller/)**

> **Status:** v0.36.0, pre-1.0, licensed under Apache-2.0 (see
> [`LICENSE.txt`](LICENSE.txt)). Built on
> [`async-bulkhead-llm@3.18.0`](https://www.npmjs.com/package/async-bulkhead-llm).

---

## The problem

An LLM provider or inference server has finite capacity. It enforces that limit
one request at a time as requests arrive, so when it is full it rejects
whichever request comes next. It does not know which of your workloads that
request belongs to. When a batch job and user-facing traffic share one
provider, a burst from the batch job fails the users' requests too.

In one run of the [evaluation below](#evaluate-tyr-in-five-minutes),
interactive callers sharing a provider with a batch flood completed 6% of their
requests. Through Tyr, the same callers completed every request and the
provider rejected none.

## What it does

Tyr is an admission-first proxy for Anthropic Messages, OpenAI Chat
Completions, and the OpenAI Responses API. Before a request reaches the
provider, Tyr reserves the tokens it will need and checks them against the
concurrency and token capacity you configured. It then admits the request,
rejects it with a retry hint, or, in observe mode, records what it would have
done. Admission classes keep one workload, such as a batch job, from taking the
capacity another depends on, such as user-facing traffic.

A client changes its base URL and keeps sending its own provider key. Tyr
forwards the key and never stores it.

Tyr runs on its own. Latchflo, a separately licensed control plane, can
coordinate one capacity envelope across many Tyr replicas.

→ [How admission works](guides/concepts.md)

## Should you use it?

**Probably yes if:** several workloads share one provider or inference server,
and the ones that matter must keep working when the others burst.

**Probably not if:** you need an in-process limit inside one Node.js service.
[`async-bulkhead-llm`](https://www.npmjs.com/package/async-bulkhead-llm), the
library Tyr is built on, does that without a proxy.

**Not a replacement for:** a general-purpose provider gateway, your provider
SDK, or a provider's rate limits and spend caps. Tyr does not translate between
Anthropic and OpenAI request formats, and its token estimate is for load
shedding, not billing.

## Evaluate Tyr in five minutes

You need Node.js 22 or newer. You do not need an API key, Docker, Kubernetes,
or Latchflo.

```bash
git clone https://github.com/janbalangue/tyr-admission-controller.git
cd tyr-admission-controller
npm ci
npm run eval
```

`npm run eval` starts three local processes: a mock OpenAI provider that serves
8 requests at a time and answers 429 beyond that, a local token issuer, and Tyr
with [`eval/tyr.eval.yaml`](eval/tyr.eval.yaml). It sends the same workload
twice, straight to the provider and then through Tyr. One run printed:

```text
Interactive and batch traffic sharing a provider that serves 8 requests at a time
  3 interactive callers (250 ms pause between requests) and 24 batch callers (no pause); every caller waits 200 ms after a 429.

                                    Direct to provider      Through Tyr
  Interactive requests completed    12 / 188 (6%)           60 / 60 (100%)
  Interactive p95 latency           0.51 s                  0.57 s
  Batch requests completed          228 (14.9/s)            150 (9.8/s)
  Rejected by the provider (429)    1,380                   0
  Rejected by Tyr (429)             —                       interactive 0, batch 1,387
  Provider peak concurrency         8 of 8                  8 of 8
```

The evaluation config gives interactive traffic three protected slots and holds
batch to a ceiling of five, so the provider never goes over capacity. The cost
is batch throughput: slots reserved for interactive traffic sometimes sit idle.

To point the OpenAI SDK at Tyr, keep the stack running with `npm run eval:serve`
and, in another terminal, run the quickstart:

```bash
npm --prefix eval/sdk install && node eval/sdk/quickstart.mjs
```

The only changes a client needs are the base URL and Tyr's identity header. The
client keeps sending its own provider key; Tyr forwards it and never stores it.

```js
const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: process.env.OPENAI_API_KEY,
  // Selects the admission class. The evaluation issues these tokens locally.
  defaultHeaders: { "x-tyr-identity-token": `Bearer ${token}` },
});
const response = await client.responses.create({ model, input: "Hello", max_output_tokens: 64 });
```

[`eval/sdk/quickstart.py`](eval/sdk/quickstart.py) does the same with the Python
SDK. To run the workload against OpenAI instead of the mock, which is billed and
capped at 40 requests of 16 output tokens:

```bash
OPENAI_API_KEY=... npm run eval -- --upstream=openai --model=<model> --confirm-live
```

[`EVALUATION.md`](EVALUATION.md) is the checklist for the next step: measuring
your own traffic in observe mode before enforcing anything.

## Run it

Since 0.36.0, each release is published as a container image for
`linux/amd64` and `linux/arm64`. Copy
[`config/tyr.example.yaml`](config/tyr.example.yaml) to `tyr.yaml`, edit it,
and mount it read-only:

```bash
docker run --rm \
  --name tyr \
  -p 127.0.0.1:8787:8787 \
  -e TYR_CONFIG_FILE=/etc/tyr/config.yaml \
  -v "$PWD/tyr.yaml:/etc/tyr/config.yaml:ro" \
  ghcr.io/janbalangue/tyr-admission-controller:0.36.0
```

Or run it from source:

```bash
npm ci
TYR_CONFIG_FILE=./tyr.yaml npm start
```

Tyr validates the entire file before it opens its listener, and exits with a
nonzero code when the file is invalid.

→ [Running Tyr in a container](guides/deployment.md) ·
[Configuration](guides/configuration.md)

## Send requests through it

```bash
curl -i http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_OPENAI_API_KEY' \
  --data '{
    "model": "gpt-4o",
    "max_completion_tokens": 512,
    "messages": [{"role": "user", "content": "Explain admission control."}]
  }'
```

Every validated, pool-routed request comes back with `x-admission-*` headers
that report the decision, such as the mode, the admission ID, the limit
revision in force, and the tokens reserved when the pool has a token budget. A
capacity rejection is a `429` with `x-admission-reason` and, when Tyr has
enough evidence, a retry hint in `x-admission-retry-after-ms`.

→ [HTTP API](guides/http-api.md)

## Limit tokens, not just requests

`maxConcurrent` counts requests. `inFlightTokenBudget` adds an admission-time
ceiling on the tokens in flight:

```yaml
pools:
  - name: interactive-claude
    modelPrefixes: [claude-sonnet-4, claude-haiku-4]
    estimatorModel: claude-sonnet-4-5
    maxConcurrent: 40
    inFlightTokenBudget: 400000
    defaultOutputReservation: 8192
```

An admitted request reserves its estimated input plus `max_tokens` or
`max_completion_tokens`, falling back to `defaultOutputReservation` when the
request gives no output limit. Actual provider usage refunds unused capacity at
completion, and streaming usage can correct the hold while the response is
running.

→ [How admission works](guides/concepts.md) ·
[Streaming reconciliation](guides/streaming.md)

## Keep one workload from starving another

Admission classes partition a pool into a bounded set of service classes. Each
class may have a protected floor and a hard ceiling beneath the pool limit:

```yaml
    admissionClasses:
      defaultClass: standard
      classes:
        standard:
          protectedConcurrent: 12
          maxConcurrent: 32
        premium:
          protectedConcurrent: 8
          maxConcurrent: 24
      rules:
        - admissionClass: premium
          tenantIds: [tenant-paid]
```

A request consumes its own protected capacity first. Work above that floor
borrows from the shared remainder left after every configured floor. Class
selection uses the authenticated identity Tyr verifies from a JWT.

→ [Admission classes](guides/admission-classes.md) ·
[Identity and priority](guides/identity.md)

## Measure before you enforce

`admissionMode: observe` runs the same reservation and capacity decision but
proxies the requests that would have been rejected, and counts them in
`/stats`. Use it to measure prospective rejection rates on your own traffic
before you enforce anything.

→ [Evaluating Tyr](EVALUATION.md)

## Watching it work

- `GET /stats` returns live per-pool statistics.
- `GET /metrics` returns Prometheus text with bounded labels only. Model
  strings, request IDs and tenant-supplied identity values never become metric
  labels.
- `telemetry.audit.enabled: true` emits one JSON line per admission decision.
- `npm run demo:up` starts a local Prometheus and Grafana demonstration that
  calls no paid model provider.

→ [Runtime behavior and telemetry](guides/telemetry.md)

## Stopping admitted requests

By default Tyr never touches a request once it has admitted it. A deployment
can opt in to stopping admitted requests in three situations:

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

A stop is a local decision. It returns Tyr's slot and tokens and drops the
upstream call. It does not prove the provider stopped work.

→ [Stopping admitted requests](guides/stopping-admitted-requests.md)

## More than one replica

Standalone budgets and statistics are per process. Two optional features cover
a fleet:

- **Latchflo managed mode.** Latchflo issues expiring grants so that replicas
  share one bounded fleet-wide capacity envelope.
- **Capacity-aware replica routing.** Before admission, a replica can forward a
  request once to a peer that has more room.

→ [Latchflo managed mode](guides/latchflo.md) ·
[Capacity-aware replica routing](guides/replica-routing.md)

---

## Documentation

| Guide | What's in it |
|---|---|
| [How admission works](guides/concepts.md) | The request lifecycle, token reservations and refunds, adaptive estimation, enforce and observe modes |
| [Admission classes](guides/admission-classes.md) | Protected floors and hard ceilings per workload, borrowing, borrowed-slot deadlines |
| [Identity and priority](guides/identity.md) | JWT identity, roles, high priority, the legacy trusted header |
| [HTTP API](guides/http-api.md) | Routes, forwarded headers, admission response headers, retry hints, the error contract, example requests |
| [Configuration](guides/configuration.md) | The configuration file, a complete example, every field, offline validation, legacy environment mode |
| [Running Tyr in a container](guides/deployment.md) | The published image, building your own, Compose |
| [Streaming reconciliation](guides/streaming.md) | Returning capacity while a reply is still streaming |
| [Stopping admitted requests](guides/stopping-admitted-requests.md) | Opt-in stops on overrun, after a limits change, and at the drain deadline |
| [Response memory](guides/response-memory.md) | Admitting `previous_response_id` follow-ups on the Responses API |
| [Runtime behavior and telemetry](guides/telemetry.md) | Shutdown, `/stats`, `/metrics`, audit events, upstream failure diagnostics, the Grafana demo |
| [Capacity-aware replica routing](guides/replica-routing.md) | Forwarding a request once to a replica with more room |
| [Latchflo managed mode](guides/latchflo.md) | Fleet-wide grants, readiness, demand heartbeats, capacity handoffs |
| [Embedded control surface](guides/embedding.md) | `createGateway()` and applying limits from your own code |
| [Known limitations](guides/limitations.md) | What Tyr does not do yet, and where its guarantees stop |
| [Developing Tyr](guides/development.md) | The release gate, development commands, repository layout |
| [Evaluating Tyr](EVALUATION.md) | A checklist from the five-minute evaluation to observe mode on your own traffic |

The **[documentation site](https://janbalangue.github.io/tyr-admission-controller/)**
carries these guides and an API reference for embedders, generated from the
source types on every push to `master`. Release-by-release detail lives in the
[changelog](CHANGELOG.md), planned work in the [roadmap](ROADMAP.md), and each
release's checks in the [verification record](VERIFICATION.md).

## What it deliberately doesn't do

- **No format translation.** An Anthropic-shaped request goes to an
  Anthropic-shaped upstream, and an OpenAI-shaped request to an OpenAI-shaped
  one.
- **No provider credentials.** The calling application owns its provider key
  and sends it with each request. Keys do not belong in Tyr's configuration.
- **No retries.** Tyr does not send a request to the provider, or to another
  replica, a second time. Retrying is the caller's decision.
- **No rate limiting or spend caps.** A token budget limits the work in flight
  at one time. It is not a provider RPM/TPM limit or a cumulative spend policy,
  and the estimate behind it is not a billing-grade tokenizer.
- **No fleet-wide accounting by itself.** One Tyr process knows only its own
  pools. Sharing an envelope across replicas takes Latchflo managed mode.

→ [Known limitations](guides/limitations.md)

## Compatibility

- **Node.js:** 22 or newer to run from source. The published image runs
  Node.js 24.
- **Container image:** `linux/amd64` and `linux/arm64`, from 0.36.0.
- **Upstreams:** at least one Anthropic-shaped or OpenAI-shaped upstream.
- **Stability:** pre-1.0, so a minor version may include breaking changes. The
  TypeScript interfaces used to embed Tyr are not yet stable.

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) to contribute and
[`SECURITY.md`](SECURITY.md) to report a vulnerability.

## License

Tyr is licensed under the [Apache License, Version 2.0](LICENSE.txt). See
[`NOTICE.txt`](NOTICE.txt) for attribution and
[`THIRD_PARTY_NOTICES.txt`](THIRD_PARTY_NOTICES.txt) for the licenses of bundled
runtime dependencies.

Tyr runs standalone without any control plane. Latchflo managed mode requires a
Latchflo deployment; Latchflo is a separately licensed proprietary control plane
and is not covered by this license.
