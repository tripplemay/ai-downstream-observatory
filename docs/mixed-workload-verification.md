# Mixed HTTP workload verification

This is a synthetic engineering harness, not an investment strategy, live-data
certification, formal performance pass or deployment approval. Schema remains 24.

## What runs

`web/scripts/benchmark-workbench-mixed.ts` creates a fresh OS-temporary database,
starts the production Next server on loopback and runs the normal continuous
Python `core` worker. Authentication, market ingestion/publication, valuation,
policy activation, proposal creation/risk checks, approval/cancellation and CSV
background preview/confirmation use the existing HTTP commands. No test-only
business route or automatic order is added.

Four independently scheduled classes exercise workbench GET, governance GET,
small `record_fact` POST and `approve_proposal` POST. The approval operation also
creates its proposal and cancels the remaining reservation. Full operation time
and the target HTTP request time are separate. Neither is server-only latency.
The scheduler has bounded in-flight requests, queues and deadlines; failures and
late operations are retained rather than hidden by automatic retries.

The fixture has ten synthetic accounts across separate CSV, small-write,
approval and valuation portfolios in one SQLite database. This preserves writer
contention without deliberately invalidating every command through unrelated
portfolio-revision races. Seeded research and legacy gate records are explicitly
labelled prerequisites, not genuine research/gate passes. Actual market
publication, valuations, approvals, reservations and CSV success are not seeded.

## Liquidity ingestion contract

The normal ingestion path now accepts the four metrics already required by the
approval risk engine:

| Metric | Unit and semantics |
|---|---|
| `spread_bps` | `bps`, nonnegative |
| `premium_bps` | `bps`, signed premium/discount |
| `turnover` | Nonnegative amount in the listing currency |
| `volume` | `shares`, nonnegative integral quantity |

Each requires a listing and `price_basis=not_applicable`; it belongs to a
`prices` or `mixed` batch. Existing parent/source, batch, timing, publication,
provenance and risk gates still apply. Valid observation syntax does not prove
liquidity is adequate or verified by an external provider. In particular, zero
volume may be recorded but does not qualify a proposal for approval.

## Reproduce a small correctness smoke

On macOS or Linux, install the repository's locked Web dependencies and workbench Python
requirements in a dedicated environment. Set both Python variables to that
environment, then from `web/`:

```sh
npm run build:evaluation-worker
npm run build:csv-worker
npm run build:verification-worker
npm run typecheck
npm run build
./node_modules/.bin/tsx scripts/benchmark-workbench-mixed.ts --history 30 --listings 10 --market-rows 50 --csv-rows 10 --count 20 --interval-ms 250 --poll-seconds 0.1
```

The explicit 0.1-second poll is a smoke-test configuration, not the deployed
5-second default. `--core-count` defaults to one. A single worker serializes its
background jobs; multiple workers are a separate, declared topology.
The 250-ms arrival interval gives the small run a non-idle request horizon.
Actual per-window target-HTTP overlaps are reported, not assumed from this setting.
`--setup-seconds` separately bounds fixture generation and bootstrap; generation
runs in its own bounded process so synchronous SQLite work cannot prevent the
supervisor timer from firing. `--overall-seconds` bounds the measured workload,
not setup. An interrupted partial fixture remains local for inspection.

`--background-cycles` and `--background-interval-ms` define a fixed schedule of
normal price/FX publication and valuation cycles. A slow preceding cycle may
delay the next cycle; planned, actual start and completion times are retained.
The schedule is never shifted to hide lateness, and idle time is not counted as
background execution. Each cycle has its own overlap window and sample counts.

Reports, original CSV/mapping bytes, the pre-dispatch HTTP journal and synthetic
database/attachment evidence stay under ignored `artifacts/verification/`.
Retained attachments require a `0700` directory and `0600` files; original-byte
hashes and modes are checked before temporary originals may be removed.
Authentication storage is not copied into the retained database artifact.
Personal plans and broker credentials are not inputs to this harness.

## Independent correctness and shutdown

`tests/performance/mixed_workload_oracle.py` opens the database read-only and
checks facts, postings, movements, projections, request/receipt links, CSV
original-byte hashes, approval/cancellation evidence, market publication pages
and recomputed valuation items/NAV. Baseline and pre-confirmation checks prove
CSV preview did not write financial facts. The pre-confirmation check does not
require the in-flight response journal to have caught up with concurrent commits.

Full outcome-set verification runs only after the owned server and workers have
stopped. A client timeout is never treated as a rollback. Normal core shutdown
must exit cleanly, with no unclassified/truncated error diagnostics; forced or
uncertain cleanup blocks the final oracle, backup and temporary-directory
removal. The directory is retained for inspection rather than declared safe.
Historical cleared lease deadlines are not reconstructed as if they were
persisted evidence.
For a separate replay, copy evidence to a fresh private directory, record the
path relocation and compare bytes/modes. SQLite read-only access can still create
WAL/SHM lock files, so do not open the original retained database in place.

The oracle also rejects duplicate expected small-write receipts and extra
proposal/approval/reservation effects. GET responses are checked against the
fixture's actual snapshot semantics, including atomic pre/post-CSV balances;
HTTP 200 or a correct terminal database alone is not a correct response proof.

## Server timing and full-quantity resource pilot

Only the benchmark Next process loads the fixed server observer; application
routes and authentication are unchanged. The observer records a bounded private
journal for tool-generated request IDs on the two measured API paths. It never
records request bodies, query strings, cookies or session bindings. Each request
event must pair with a finish, abort or incomplete terminal record. Duplicate,
missing, malformed, over-capacity or failed writes invalidate telemetry rather
than produce zero-duration samples.

`server_samples` and `server_latency` measure request-event to response-finish
wall time, including begin-observer write overhead and server streaming/backpressure.
They exclude time before the HTTP request event and client receive/parse time; they are not CPU
time or exact SQLite lock time. Original client timings, queues, failures and
shortfalls remain visible. `csv_timing` separates submit, acceptance and observed
terminal response from the independently timed Python oracle.

The manual `workbench-performance-pilot-manual` workflow accepts only an exact
reviewed mainline commit and a fixed `small` or `full` profile. It is separate
from CI and release. The full profile requests 10 accounts, 1,000 listings,
2,000,000 historical padding observations, 50,000 facts, a 10,000-row CSV and
1,000 samples per foreground class, with 12 scheduled background update cycles.

The non-root workload, generator and all child workers share a single Linux
cgroup. The supervisor must observe the actual four-CPU quota/affinity, 8-GiB
memory limit, zero swap limit, non-tmpfs local block storage, and pre/post resource
samples. Kernel nonrotational-device metadata is not independent physical-media
inspection. CPU throttling, memory/OOM and I/O observations are retained; missing
or unverified constraints fail the pilot. An outer forced stop cannot prove
rollback or turn an uncertain writer into a successful result. Only explicitly
allowlisted synthetic evidence is uploaded; authentication storage is excluded.

The full profile remains a resource/correctness pilot, not formal performance
acceptance: active holdings are sparse, the bulk historical market rows are not
published valuation inputs, and true process-cold, representative market-data
and lock-wait evidence are still separate outstanding work. A passing pilot does
not complete the failure-injection or independent-host recovery requirements.

### 2026-09-29 local full-size diagnostic (failed)

`artifacts/verification/mixed-workload-v28/full-local-2/report.json` is a retained
macOS development run, not the four-CPU/eight-GiB Linux pilot. Its fixed arrivals
were 1,000 per class at 250 ms spacing with a 32-slot per-class queue. The fixture
reached 10 accounts, 1,000 listings, 2,000,000 market observations and 50,000
ledger facts. Twelve market/valuation cycles and both 10,000-row CSV flows
overlapped the foreground requests. Baseline, preview and final independent
oracles passed; the final database and attachment evidence were retained, and
the 607-file source snapshot had no drift. The run nevertheless **failed**:

| Foreground class | Successful / planned | Failure breakdown |
| --- | ---: | --- |
| Ledger GET | 954 / 1,000 | 45 queue full; 1 client transport failure before server observation |
| Governance GET | 953 / 1,000 | 47 queue full |
| Record fact | 797 / 1,000 | 202 queue full; 1 HTTP 503 |
| Approval | 634 / 1,000 | 352 queue full; 13 queue deadline; 1 HTTP 503 |

The authenticated server trace paired all 6,493 requests that reached the
server. The one client transport failure had no server trace, so the original
report also recorded `SERVER_TRACE_TARGET_MISMATCH`. Subsequent harness code
separates unobserved client failures from missing traces for successful HTTP
targets; it does not convert the failed sample into a success. The two 503s
coincided with the CSV confirmation window and were logged as `SqliteError`,
but the exact SQLite error code was not captured, so lock contention is a
hypothesis, not an established cause. CSV preview and confirmation finished in
13.65 s and 19.24 s; those two timings alone do not pass the mixed-workload gate.
Successful-request server p95 values were below 0.5 s in each class, but this
excludes the queue-full, deadline, transport and 503 failures and cannot be
reported as a passing p95. The original failed report is immutable evidence;
the updated harness requires a new run for its own validation.

## What remains outside this smoke

- A passing run with the specified 4 vCPU / 8 GiB / local SSD environment and full dataset.
- At least 1,000 valid samples per required query/atomic-command class, warm/cold
  distinctions, resource use, lock waits and the complete concurrent workload.
- Queue-to-terminal overlap is not proof of simultaneous SQLite writer locks.
  Report actual phase overlap and do not invent a per-CSV-phase sample threshold.
- Real provider/issuer/broker evidence, genuine strategy/gate approval, the full
  native UI/fault/accessibility matrix, independent-host recovery and cutover.

The formal thresholds in `06-validation-and-acceptance.md` remain unchanged.
