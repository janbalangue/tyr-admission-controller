# Tyr 0.34.1 verification

Date: 2026-11-23

## Version alignment

- Tyr package version: `0.34.1`
- Runtime version constant: `0.34.1`
- Runtime dependency: `async-bulkhead-llm@3.18.0`
- Transitive bulkhead dependency: `async-bulkhead-ts@1.0.1`
- Vendored runtime artifacts:
  - `vendor/async-bulkhead-llm-3.18.0.tgz`
  - `vendor/async-bulkhead-ts-1.0.1.tgz`
  - `vendor/yaml-2.9.0.tgz`
- Package repository: `https://github.com/mofluxhq/tyr-admission-controller.git`

## Required release order

`async-bulkhead-llm@3.18.0` was published to npm on 2026-11-23, before this
release was built. 0.34.1 moves Tyr from 3.17.0 to 3.18.0 and changes nothing
in Tyr's own source except the version constant. Tyr's committed lockfile
intentionally resolves the
exact bundled `vendor/async-bulkhead-llm-3.18.0.tgz`, so the Tyr build is
reproducible without the registry; the vendor artifact is not a substitute for
publishing the declared public package version.
`npm run verify:vendor-provenance` confirms the bundled tarball is
byte-identical to the published one.

## Library update (0.34.1)

3.18.0 can stop work it has already admitted, when a limits snapshot carries a
`stop` policy or a drain passes `stopOnTimeout`. Tyr does neither, so this
release must behave as 0.34.0 did on 3.17.0. Three checks cover that:

- **The existing suite.** All 273 tests from 0.34.0 and every executable
  verifier pass on 3.18.0. The only edit to an existing test is the version
  string one assertion expects.
- **The policy cannot arrive by accident.** A new test in
  `test/pools-v311.test.ts` applies a limits update that carries
  `stop: { takeBackGraceMs: 0 }` and leaves one running call above the new
  ceiling. The update is applied, the applied snapshot has no `stop`, and the
  call runs to completion. With the field forwarded to the library, the same
  test fails: the call is rejected with `LLMAdmissionStoppedError`.
- **Same output as 0.34.0.** The 0.34.0 build on 3.17.0 and this build were
  each started with three pools and sent the same 19 requests: Chat
  Completions, Messages and Responses, plain and streamed, a high-priority
  request, budget and concurrency rejections, an upstream `500`, an
  observe-mode bypass, a borrowed slot that outlived its 60 ms lease, a kill
  switch and a restore through `control.applyLimits`, and a bounded drain
  with one call still running. The comparison covered every reply with its
  admission headers and body, `/stats`, `/metrics`, the 17 audit events, the
  applied limits and the drain result: 2,278 values per run. Five pairs of
  runs showed no difference.

The comparison leaves out values that differ between two runs of one build:
admission ids, timestamps, nanosecond timings, port numbers, the version
string, the bucket and sum samples of the duration histograms (their counts
are compared), and the retry hint, which is computed from wall-clock
completion intervals.

## Response memory (0.34.0)

`npm run verify:responses-state` runs against the built `dist/` and a stand-in
provider that reports 20 input and 30 output tokens for every reply. With a
pool that has `maxConcurrent: 4`, a 5,000-token budget and adaptive estimation
off, the request `{ model: "gpt-4o", input: "hello", max_output_tokens: 100 }`
reserves 111 tokens. The script passes only if:

- without `responsesState`, a follow-up gets `400 invalid_request` and
  `/stats` has no `tyr.responsesState`;
- a follow-up to a recorded response gets `200` with
  `x-admission-reserved-tokens: 161` and `x-admission-prior-tokens: 50`, and
  the pool's `totalReserved` is 111 + 161;
- a follow-up to an unknown id gets `422 unknown_previous_response`, the
  provider's call count does not change, and the pool's `llm.rejected` stays 0;
- a reply to a `store: false` request and a reply without usage are not
  recorded;
- a streamed reply is recorded from its `response.completed` event;
- with `maxEntries: 2`, the first of three responses is unknown and the third
  is known; with `ttlMs: 200`, a follow-up 600 ms later is unknown;
- with identity, a follow-up from the same tenant and application under
  another subject is admitted, and one from another tenant or application
  gets the same body as an unknown id without a provider call;
- the built server, started with `TYR_CONFIG_FILE` and a relative
  `responsesState.file`, has the record on disk when the reply arrives, is
  killed with `SIGKILL`, is started again, and then admits the follow-up with
  161 reserved tokens. `SIGTERM` afterward exits with code 0.

The Vitest suite adds 74 tests in three files. Beyond the cases above they
cover:

- the recorded size added exactly on top of an adaptively corrected estimate,
  with the pool's calibration samples unchanged by the follow-up;
- a follow-up admitted while the first reply's stream is still open, which
  shows the record exists before the reply ends;
- a stream that reports usage on its first event and then breaks off, which
  leaves no record;
- a `429 budget_limit` follow-up that still reports its prior tokens;
- a state file with a partly written last line, unreadable lines, a line
  longer than any Tyr writes, a foreign file, a newer schema, records that
  span read boundaries, and bounds changed between runs;
- a write that fails partway through a line: nothing is appended after the
  fragment, and the next rewrite saves every record, including the one whose
  write failed;
- a rewrite that keeps failing: appends stop, the retry delay doubles, and
  the file is restored with its header once the directory is back;
- a start on a readable file that cannot be rewritten, which serves the
  records it read, and a start that cannot create the file, which fails;
- capacity routing: a `store: false` request is forwarded to a peer with more
  headroom, while a request whose reply will be recorded, and its follow-up,
  are admitted on the replica that received them.

Each of these guarantees was also checked by breaking it on purpose and
confirming a test failed: follow-ups used as calibration samples, the recorded
size passed through the estimator, a streamed record written after its final
event was forwarded, usage accepted from a stream event that is not final,
appending after a failed write, record-bound requests forwarded by capacity
routing, and the owner check removed.

A second-pass review of the first version of this change found four defects
in the store, all fixed here: eviction and loading took time quadratic in
`maxEntries`, a failed append could corrupt the next record, a rewrite that
kept failing let the file grow without bound, and usage on a stream event
that was not final could create an undersized record. Eight of the tests
above fail against that first version.

The 199 tests from 0.33.0 pass with one edit, the version in the
`tyr_build_info` assertion. No other existing test or verify script changed.

With `responsesState` absent, this build was also compared with a build of the
0.33.0 tag. Both received the same nine requests: two plain Responses calls,
one of them streamed, a `previous_response_id` follow-up, a `null`
`previous_response_id`, `store: false`, `conversation`, `background: true`, a
Chat Completions call, and an unrouted model. The statuses, `x-admission-*`
headers and bodies, the `/stats` document, and all 236 `/metrics` lines were
identical once admission ids, timestamps, duration samples and the version
label were masked.

On the development Mac, writing 100,000 records with `maxEntries: 10000` took
0.007 ms per record on average and 0.01 ms at the 99th percentile. The slowest
write, 17 ms, was a rewrite of the state file, which happens once per 10,000
or more records at that setting. Loading the resulting 3 MB file at startup
took 36 ms. At the largest allowed setting, `maxEntries: 1000000`, writing
2,100,000 records took 0.006 ms each on average, the one rewrite took 0.49
seconds, loading the 174 MB file took 1.8 seconds, and the records used about
240 MB of heap.

Not verified: a run against the live OpenAI API, the state file on a mounted
volume in the container image, and more than two replicas.

## Self-serve evaluation (0.33.0)

`npm run verify:eval` runs the evaluation for 5 seconds per phase and passes
only if the direct phase shows contention, every interactive request completes
through Tyr, the provider rejects nothing behind Tyr, and Tyr rejects batch
work. It is part of `release:check` and runs in CI on Node 20, 22, and 24.

A full `npm run eval` on the development Mac completed 12 of 188 interactive
requests (6%) directly and 60 of 60 through Tyr. The provider rejected 1,380
requests directly and none behind Tyr, and Tyr rejected 1,387 batch requests
with `concurrency_limit`. Batch throughput fell from 14.9 to 9.8 requests per
second. Provider peak concurrency was 8 of 8 in both phases.

With `npm run eval:serve` running, `eval/sdk/quickstart.mjs` (openai-node
7.23.0) and `eval/sdk/quickstart.py` (openai-python 3.19.1) each completed
`responses.create(...)` and a Chat Completions call through Tyr and reported
`class=interactive outcome=admitted`. Interrupting the runner stopped all three
processes and freed ports 8787, 9101, and 9102.

Against the evaluation stack, a request without an identity token returned
`401`, and `max_completion_tokens: 1000` returned `400` because it exceeds
`server.maxOutputTokens: 256`. `/metrics` is readable without an operator token.
A model outside the pool's prefixes stopped the run at the first `422`, and the
runner shut the stack down.

Live mode refuses to start without `OPENAI_API_KEY`, `--model`, and
`--confirm-live`. Run with an invalid key, Tyr forwarded the request over HTTPS
to api.openai.com, OpenAI returned `401 invalid_api_key`, and the runner stopped
at that first error. A billed run against OpenAI was not performed.

## Apache-2.0 license and Korrx removal (0.32.0)

`LICENSE.txt` is byte-identical to the Apache License 2.0 text (SHA-256
`c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`), and
`package.json` declares `Apache-2.0`. `npm pack` includes `LICENSE.txt`,
`NOTICE.txt` and `THIRD_PARTY_NOTICES.txt`. An image built from this tree
contains all three files in `/app` and carries the
`org.opencontainers.image.licenses=Apache-2.0` and `source` labels.

`test/gateway.test.ts` asserts that admitted, observe-mode and rejected
responses carry the `x-latchflo-*` grant headers and no `x-korrx-*` headers.
`test/pools-v311.test.ts` asserts that `source: "zab"` and `source: "korrx"`
are rejected with `provenance.source must be "latchflo"` before any pool
changes, and that `source: "latchflo"` applies. `npm run release:check` passes.

## Upstream failure diagnostics (0.31.0)

`test/upstream-failure.test.ts` checks the cause-chain helper on synthetic
chains: it takes the deepest bounded code, rejects unbounded codes and names,
and caps the detail at 300 characters. It also runs two real gateway cases:
- an upstream port that refuses connections must return
  `502 { cause: { name: "Error", code: "ECONNREFUSED" } }`;
- an upstream that destroys the socket after reading the request must return
  `UND_ERR_SOCKET` or `ECONNRESET`.

In both cases the response body must not contain the upstream address, and
exactly one `upstream_failure` diagnostic event must be emitted. The refused
case also checks that `tyr_upstream_failures_total` carries the code label.

## Borrowed-resource restoration contract

An admission class may configure:

```yaml
borrowedAdmissionSlot:
  releaseMechanism: deadline_abandonment
  deadlineMs: 30000
```

The deadline starts only after admission and applies only when that admission
actually borrowed local concurrency. Expiry has deliberately different meaning
for each constrained resource:

| Resource | Release mechanism | Enforceability | Expiry behavior |
|---|---|---|---|
| Tyr admission slot | `deadline_abandonment` | `enforced` | The borrowed local concurrency slot is returned immediately. |
| Local token accounting | callback settlement | `enforced` locally | The reservation remains held until the callback settles, and unbounded drain waits for it. |
| Upstream capacity | `abort_signal` | `unverified` | Tyr requests cancellation but does not claim provider quota, queue, or accelerator capacity was reclaimed. |

Where provider-side termination cannot be proven, an unlent provider/account
floor or independently enforceable partition remains necessary for an upstream
capacity guarantee.

## Executable restoration verification

Run:

```bash
npm run verify:borrowed-restoration
```

The verifier builds Tyr and checks that:

- an expired borrowed admission returns its local concurrency slot;
- the admission's token hold remains while callback work is unsettled;
- that outstanding token hold cannot be falsely re-admitted as free capacity;
- a protected class can admit after local slot restoration;
- no-timeout drain remains pending until the detached callback settles;
- final callback settlement releases the remaining accounting and allows drain;
- `/stats` and Prometheus distinguish enforced local release from unverified
  upstream cancellation.

Vitest integration coverage additionally verifies the `504
borrowed_admission_deadline` response, response headers, structured audit event,
bounded metrics, and strict rejection of incomplete or misleading policy values.

## Observable contract

Successful admission response headers include exact resource attribution:

- `x-admission-slot-borrowed`
- `x-admission-borrowed-tokens`
- `x-admission-slot-deadline-ms` when the borrowed-slot policy applies

On expiry before response headers are sent, Tyr returns `504` with
`x-admission-reason: borrowed_admission_deadline`. The JSON body states that the
local slot was released, upstream cancellation was requested, and upstream
reclamation is unverified.

`GET /stats` exposes `tyr.restoration` per pool. Prometheus exposes:

- `tyr_resource_release_events_total`
- `tyr_pool_work_in_flight`
- `tyr_pool_borrowed_admission_slot_deadlines_total`
- `tyr_pool_admission_class_borrowed_slot_deadlines_total`

The resource metric uses fixed `resource`, `release_mechanism`,
`enforceability`, and `outcome` values. No provider, model, tenant, request,
admission, or grant identifier is introduced as a label.

## Latchflo compatibility

Tyr registers the additive capability
`borrowedAdmissionSlotDeadlines: true`. Older Latchflo versions may ignore it.
Latchflo continues to replace only numeric admission-class limits; the deadline
and release mechanism remain fixed local Tyr policy. The provider request path
still has no synchronous control-plane call.

## Carried-forward compatibility

Tyr 0.34.1 retains the native Anthropic Messages, OpenAI Chat Completions, and
OpenAI Responses routes from 0.29.0. Responses requests stay stateless unless
`responsesState` is configured. Existing identity, routing,
managed-mode, provenance, timing, retry-hint, and progressive-reconciliation
paths remain intact. Classes without `borrowedAdmissionSlot` keep the existing
non-preemptive drain behavior.

## Release gate

From a clean dependency install on Node.js 20 or newer:

```bash
npm ci
npm run release:check
```

The release gate verifies vendored tarball integrity, lint, TypeScript, the full
Vitest suite, all executable integration verifiers (including borrowed
restoration and response state), smoke imports, and `npm pack --dry-run`.

For independent configuration checks:

```bash
npm run build
node dist/cli.js validate --config config/tyr.example.yaml
TYR_ROUTING_SECRET=verification-secret \
  node dist/cli.js validate --config config/tyr.latchflo.example.yaml
git diff --check
```

## Recorded results

The full release gate passed on the development Mac on 2026-11-23, on Node.js
24.18.0, in about 45 seconds:

- 17 Vitest files passed, containing 274 tests;
- every executable verifier passed, including the seven borrowed-restoration
  assertions and `verify:responses-state`;
- both shipped YAML examples passed runtime CLI validation;
- telemetry smoke and `git diff --check` passed;
- `npm pack --dry-run` included 53 files, approximately 162.9 kB packed and
  680.0 kB unpacked.

`npm run verify:vendor-provenance` also passed: the three vendored artifacts
match their published releases. The Vitest suite, every offline verifier, the
quick evaluation and the telemetry smoke also passed locally on Node.js
20.20.0 and 22.23.1, with 274 tests on each. CI was not run for this record.

The final ZIP is checked from a fresh extraction before delivery. It excludes
platform-specific `node_modules`; consumers install the locked development
dependencies with `npm ci`.
