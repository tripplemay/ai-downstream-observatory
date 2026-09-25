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

Reports, original CSV/mapping bytes, the pre-dispatch HTTP journal and synthetic
database/attachment evidence stay under ignored `artifacts/verification/`.
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

## What remains outside this smoke

- The specified 4 vCPU / 8 GiB / local SSD environment and full dataset.
- At least 1,000 valid samples per required query/atomic-command class, warm/cold
  distinctions, resource use, lock waits and the complete concurrent workload.
- Queue-to-terminal overlap is not proof of simultaneous SQLite writer locks.
  Report actual phase overlap and do not invent a per-CSV-phase sample threshold.
- Real provider/issuer/broker evidence, genuine strategy/gate approval, the full
  native UI/fault/accessibility matrix, independent-host recovery and cutover.

The formal thresholds in `06-validation-and-acceptance.md` remain unchanged.
