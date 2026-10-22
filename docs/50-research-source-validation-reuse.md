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
