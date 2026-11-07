# Research source reconstruction: bounded pure-validation reuse

## Purpose

The research path must rebuild admitted history before evaluating a portfolio.
Historical downloads are tiled. Previously each tile revalidated the same
complete reviewed calendar, so calendar validation grew with both calendar
length and tile count. This work reduces that startup cost without changing
strategy, risk, execution, trial exposure or financial facts.

Profiling an invented one-year/two-asset fixture found 74 fact validations for
24 captures; repeated review validation dominated reconstruction. This is a
software fixture, not a measurement of live provider latency.

## Reuse boundary

`build_dataset` and `build_monitor_dataset` each establish a private,
request-local validation scope. `validate_facts` reuses only successful pure
schema/semantic validation, keyed by fact kind and a SHA-256 digest of the exact
sorted JSON encoding. Numeric representations are not normalized for the key.
The cache holds at most 128 digests, no review documents or market payloads.
Beyond that budget validation proceeds normally without storing more entries.
Nested scopes are isolated and restore the outer scope; success or failure
discards the scope. Standalone calls do not reuse validations across requests.

No database lookup or source result is cached. Every review read still checks
workspace ownership, source/review hashes, audits, timestamps, expiry, approval
and latest-review identity. Every capture still checks its receipt, reviewed
binding, use scope, retention and retained payload hash, then replays its SDK
projection. New versions with identical facts must pass their own bindings;
withdrawal, expiry, corruption or missing payload cannot reuse a prior verdict.

No JSON/API switch enables reuse or bypasses validation. The existing read
transaction boundaries and final publication checks remain unchanged. There
are no migrations, permission grants, new retries, source approvals or strategy
parameter defaults. As with any investor-source change, implementation identity
changes; immutable old experiments/results are not rewritten or resealed.

## Reproduce

Use the project's Python environment with its pinned dependencies and the
installed Node migration tooling:

```sh
python -m unittest tests.investor.test_snapshot_validation_reuse -v
python -m tests.investor.benchmark_source_reconstruction --days 1826 --repeats 2
```

The benchmark creates and removes a disposable database. All sources, grants,
listings, calendars and prices are invented; every calendar day is deliberately
a fictional session. SDK transport is stubbed. It does not read credentials,
call a provider, admit a study, register trials, create accounts or produce a
reference portfolio. The uncached and scoped paths use the same retained
receipts, frozen clock and database, comparing the entire reconstructed output,
not just the dataset hash. Timing assertions are intentionally absent from CI.

One local macOS run on 2026-10-22 used 1,826 days, two assets, 118 captures and
3,652 observations. Two uncached replays took 20.54/20.34 seconds; scoped replays
took 2.24/2.22 seconds (median ratio about 9.16). Full outputs were identical,
with zero replay writes or registered experiments. These are relative local
measurements, not Linux/VPS throughput, full-load acceptance or an SLA.

New tests cover exact kind/content keys, mutation, numeric encodings, failed
validation, size/precision rejection, capacity exhaustion, nested/failed scope
cleanup, fresh reads, unchanged whole outputs, per-capture payload replay,
audit/currentness/ownership/expiry checks and corrupted retained payloads.
Related source admission, default-core research, durable trials, bounded
execution, monitor data, confirmed captures, retention and CLI regressions
passed in a final 156-test selection, including confirmed-monitor, initial-price
and monitor-bootstrap paths. The 183 orchestration tests, 26 selected Web
cross-language/service tests, full type check and five background builds also
passed. Their fictional inputs do not establish supplier permission or
investment validity; exact-commit Linux CI remains separate.

## Still required

This removes one measured source of pre-heartbeat work. Source reconstruction,
dataset/plan validation, metrics and other indivisible operations can still
delay heartbeat or cancellation. The 900-second core startup lease is not
reduced, and this benchmark does not prove that all real studies fit that lease.
Further startup/stop-latency and shared-VPS operational acceptance are separate.

The failed earlier real study is not retried, retuned or relabelled; its unopened
holdout remains unopened. A new bounded-policy real study still needs an
explicit frozen protocol, current source reviews and durable exposure records.
Real reference-portfolio generation, continuous monitoring, permitted AI,
account-level review/reporting and protected production release remain part of
the full v2 objective, not completed by this optimization.

## 2026-11-07: separate offline fixture increment

`tests/investor/fixture_dataset_shapes.py` now also de-duplicates the complete
input shape of `investor-action-restatement-kernel.schema.json`, only inside
the existing explicitly offline fixture scope. No production validator changes.
The original comparison, ledger reconstruction, arithmetic, result/fragment
validation, retained bytes, audits, permissions and currentness checks still run.
An explicit uncached full-chain comparison bypasses both fixture aliases.

The shared cache still holds at most eight digests, not documents. Keys include
the full native JSON bytes, contract name, transitive schema content, local
registry/checker identity and format callbacks. Small restatement inputs can
reuse success across real evidence operations; small dataset shapes retain the
old behavior. The schema-closure traversal is separately bounded at 64 schemas
(the restatement closure currently contains 33), not 64 cache entries.

Some retained coverage/action containers are shared within one input. For this
contract only, the key walks their fully expanded JSON paths, counting repeated
subtrees against the same node budget and rejecting cycles. Dataset alias
handling remains conservative. Changed bytes, numeric types, unknown Python
types, excess bytes/nodes/schema closure, failed validation, changed formats,
mutating callbacks, other threads and pre-existing wrappers cannot gain a hit.
Success and failure restore both aliases and discard the context.

Six added tests preserve full arithmetic and explicit uncached equivalence,
transitive-schema/format changes, invalid types/result replay, shared entry
capacity, thread/wrapper/exception cleanup, shared subtrees/cycles, size limits
and mutating callbacks. The first four were run red before the helper changed.
The final fixture selection passed 12 tests; the broader related selection
passed 93. Logs are under `artifacts/verification/fixture-shape-20261107`.

The unchanged complete Web shard 4 passed 247/247 across its original 35 files
in 635.674 seconds, with no drift in 1,601 monitored source files. Independent
timing-parser checks passed 5/5 and TypeScript passed. Root tests passed 460
with one optional skip in 186.348 seconds after correcting a local command that
had accidentally selected Python without `jsonschema`; the failed run remains
in `root.log`, with no source/assertion change to address that environment error.
This is not full local Python/Web discovery execution or new build/HTTP/native
acceptance. Production source, contracts, migrations and CI configuration are
byte-identical to `aa68048`; only tests/docs differ.

One sequential local history-flow sample changed from 18.895 to 18.260 seconds
(about 3.4%). The cache avoided 146 of 149 repeated restatement input shape
validations, while every comparison still executed. An initial attempt did not
cache the shared-container inputs; its timings are retained too. These samples
do not establish a statistically reliable speedup, CI qualification or a VPS
performance claim. The 120-second fixture and 30-minute CI budgets, test
discovery, eight-shard assignment, production configuration and all original
assertions remain unchanged. Aggregate CI timeouts still require verification.

## 2026-11-07: class-owned synthetic prerequisite

Profiling one offline epoch case found substantial repeated serialization and
prerequisite construction. An alternative JSON encoder was measured in ABBA
order and rejected: roughly 1% improvement does not justify replacing a real
serialization path in these tests. No production serializer was changed.

Only `EpochContinuationTests` now constructs its fixed fictional prerequisite
once per class, under the original network/credential denials and original
construction assertions. A single in-memory SQLite template plus its JSON return
value is limited to 8 MiB. Each case still gets a new exclusive scratch database;
the template is copied only into that class's otherwise empty, matching migrated
schema. Migration application timestamps alone are excluded from the pristine
target comparison; all source metadata, rows, rowids, BLOB hashes, schema and
versions are included in the complete copy fingerprint. WAL/FK settings and
foreign keys are checked again. No production database or backup is copied.

The actual case bodies, current-source checks, raw replay, arithmetic, idempotency,
revocation and explicit uncached validation comparison remain unchanged. They run
against the independent case database, not a cached proof or calculated result.
Values cannot share mutable containers between cases. Suite cleanup releases the
one template and resets the class slot; manual fixture setup outside the suite
retains the original construction path. Oversize, non-JSON or external scratch
references decline this optimization and keep the original construction path.

Ten guards cover pristine/schema/history/sequence checks, transactions, read-only
and recovery state, attached or out-of-scope databases, hardlinks, raw BLOB/rowid
integrity, mutation isolation, bounds and resource cleanup. The first eight were
red before implementation. Related tests: 34 passed; original epoch class: all
10 passed in 140.144 seconds. The original Python shard 6 case IDs and assignment
were compared with the retained CI discovery record: all 223 passed, zero skipped,
in 579.153 seconds, with no monitored-source change during execution. This is not
a Linux-runner or VPS performance claim and does not certify the next CI result.

The preliminary ABBA single-case sample was 16.700/16.798 seconds original versus
8.644/8.651 with the template. Its one-time construction cost was 8.453 seconds;
it must not be omitted when evaluating a whole suite. Earlier prototype failures
around variable migration timestamps and the empty `sqlite_sequence` row are
retained, not reclassified as passing or production defects. Evidence remains in
`artifacts/verification/v2-release-audit-20261107/`.

The original root CI selection also passed 460 tests with one explicit optional
skip in 185.600 seconds. The parent `db49d61` push passed all 19 jobs, but its PR
run ended with 18 successful jobs and Web shard 4 cancelled at the aggregate
30-minute limit. Its merge tree matches the head. The retained incomplete TAP
contains 194 completed tests, no completed assertion failure, and a largest
test duration of 347.113 seconds. This Python-only template does not claim to
fix that Web timeout. A separate actual Node CPU profile of that largest test
passed locally in 112.770 seconds; further optimization remains separate from
these class-owned prerequisites and from production acceptance.

## 2026-11-07: file-owned Web prerequisites and unchanged replay

The repeated prerequisites in the epoch, legacy-transition and funded-comparison
Web fixtures now each have at most one file-owned, private RAM image and plain
JSON value (8 MiB combined). They are constructed by the original fictional
producer, not loaded from a repository snapshot or a production backup. Every
copy creates an exclusive new temporary file; existing targets are never
overwritten. Complete schema/metadata/rowid/BLOB fingerprints, the migration
manifest, WAL/FK settings and foreign keys are checked. Non-JSON, oversized or
external scratch dependencies decline reuse. Scope checks reject financial
facts, recovery state, transactions, read-only/attached databases and hardlinks.
File cleanup discards the sole image; individual test cleanup owns each copy.

Only preparation is reused: each original Node replay, source/permission read,
mutation probe, independent arithmetic, client check and cold worker still runs.
Funded-study intents and all candidate calculations run separately in every case;
no funded study result is copied. Non-default funded variants and the two-checkpoint
legacy prerequisite retain their original construction path. Epoch activation,
download confirmation and core publication are not part of the reused paused base.

The full original Web 4 selection passed 247/247, zero skips, in 538.708 seconds.
All 35 files, the discovery/assignment fingerprint and every original test name
matched; 1,604 monitored source files were unchanged during that run. Its earlier
local comparison was 635.674 seconds, not a controlled statistical or Linux/VPS
performance guarantee. Separate complete legacy and funded files passed 8/8 and
12/12 in 24.461 and 146.314 seconds respectively. Bounded preparation/study timing
diagnostics contain only elapsed numbers and a reuse boolean.

Review then identified that separating the first epoch construction must not
give its original preparation a second 120-second budget. They now share one
absolute monotonic deadline; optional deadlines only shorten a named limit.
Invalid or exhausted deadlines reject before spawning, and a real bounded
timeout test preserves failure rather than returning a cached answer. After
this tightening, all 18 affected budget/guard/epoch tests passed in 181.924 seconds;
type checking and the original root selection (460 pass, one explicit optional
skip, 186.763 seconds) passed. The added budget guard means final Web 4 contains
the original 247 tests plus one new test. The earlier full-shard receipt is not
relabelled as execution of this last deadline change; exact-commit CI remains
required. The first TypeScript run found an `unknown` pragma result; that log
is retained and the test helper now narrows it explicitly.

No production source, provider transport, contract, strategy, migration, CI
assignment, 30-minute job limit or production configuration changed. The separate
date-formatter optimization proposal has not been implemented or folded into
this test-only change. Evidence: `artifacts/verification/v2-release-audit-20261107/`.
