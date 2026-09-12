# Explicit market publication and valuation

This module is separate from `worker/fetch_data.py` and `db.py`. It never fetches
external sources, executes broker orders, activates strategies, writes ledger
facts, or seeds real balances. Synthetic data is labeled reconstructed and
cannot produce a complete valuation of an actual portfolio.

## Runtime prerequisites

- Python 3.11 with `requirements-workbench.txt` installed.
- An absolute existing workbench database path, migrated with
  `node scripts/migrate-workbench.mjs --db /absolute/path/workbench.db`.
- Runtime has the same `migrations/manifest.json`, SQL files and `contracts/v1`
  as the web application. No implicit schema initialization is performed.
- WAL, foreign keys and FULL synchronous mode. Legacy `observatory.db`, missing
  databases and mismatched migration checksums are rejected.
- Every write transaction checks `WORKBENCH_MODE=read_only` and a sibling
  `RESTORE_PENDING_REVIEW` marker, including before committing side effects.

## Public batch API

`stage_batch(db, plan)`, `stage_page(db, batch_id, page_number, observations)`,
`validate_batch(db, batch_id)`, `publish_batch(db, batch_id, expected_revision)`.
`ingest_document(db, document, publish=False)` runs the sequence for a document
matching `contracts/v1/market-batch.schema.json` and the observation schema.

Original page JSON, canonical hash and actual receipt time are append-only.
The stored observation's `ingested_at` is the system receipt time, not an imported
claim; first ingestion is retained when another batch reuses the observation.
Published snapshots use `market_batch_members` and append-only publication
history, not the observation's first `batch_id` or just today's mutable head.
Empty/missing pages, conflicting revisions, duplicate rows, wrong price basis
or scope cannot replace the publication. No batch changes listing lifecycle.
Publication is one revision-CAS transaction. Partial/failed batches are terminal:
retry the corrected input as a new batch, never alter retained originals.

Supported metrics:

| Metric | Series/value/unit |
| --- | --- |
| `close` | Existing listing, exact nonnegative decimal, listing currency, explicit price basis |
| `fx_cny_per_unit` | `FX:USD` or other 3-letter currency, positive decimal, `CNY_per_unit_currency`, `not_applicable` basis |
| `universe_member` | Existing listing, `1`, `boolean`, `not_applicable` basis; omission is not delisting |

`manual_verified` requires source evidence; it is an explicitly imported and
reviewed source, not a claim that this program has live market connectivity.
`raw_hash` is supplied source provenance; the system separately computes the
canonical page hash. It does not claim to have downloaded/verified that remote
source merely because a source hash was provided.

## CLI

```sh
python -m worker.market ingest --db /absolute/path/workbench.db --file batch.json --publish
python -m worker.market value --db /absolute/path/workbench.db --portfolio PORTFOLIO_ID \
  --cutoff 2026-09-12T10:00:00Z --rules valuation-rules.json
python -m worker.market synthetic --batch demo:1 --listing EXISTING_LISTING_ID
```

Synthetic output goes to stdout only. Input limit is 32 MiB; duplicate JSON keys
and nonfinite JSON constants are rejected. `value` exits 2 when quality is not
complete; `ingest` exits 2 for partial/failed batches. Errors exit 1. A CLI exit
0 means that operation succeeded, not that investment gates passed.

## Valuation contract

Rules use shared `contracts/v1/valuation-rules.schema.json`. `approved` and
`approval_evidence` relate only to data quality; neither authorizes L-3 advice.
The caller supplies evidenced market session cutoffs and company-action
coverage, rather than the worker inventing a trading calendar or freshness rule.

`prepare_valuation(db, portfolio_id, cutoff_at, rules, mode='as_known')` reads a
consistent ledger/version snapshot and computes a `PreparedValuation` without
writing. It reconstructs amounts from postings and position movements effective
by cutoff, not unconditional latest projections. `as_known` excludes facts
recorded later and uses only publications known at cutoff. `restated` can use
later-recorded facts and later source corrections, but economic event/price times
must still precede cutoff; it is a separately versioned method, never evidence
that later data was available to an earlier decision. A selected publication
must contain the required historical rows; no silent archive fallback patches
an incomplete snapshot.

`persist_valuation(db, prepared)` atomically inserts immutable runs/items after
verifying ledger and current market heads still match. `value_portfolio` combines
both. An existing identical input tuple reuses the prior run. Financial sums use
the pure Decimal accounting domain and preserve signed cash/receivable/payable
postings. Inventory cost, income, unclassified-income clearing and reservations
are not double-counted as assets. Missing FX/prices produce `nav_cny=None`, never
an invented zero. Known partial value is explicitly recorded in `issues_json`.

Date-only facts on the cutoff day and stale sessions/actions are provisional;
missing prerequisites, synthetic/reconstructed market inputs and invalid
balances block a complete total. Published rows retain their actual dates and
source revisions. The module does not silently choose between tied conflicting
source revisions.

The current method is `decimal-nav-cny-v2:as_known` or
`decimal-nav-cny-v2:restated`. Both ingestion and valuation consumption check
that a close's unit equals the listing currency. FX consumption requires the
exact `CNY_per_unit_currency` unit; adjusted/total-return prices never substitute
for unadjusted position marks. A malformed pre-existing publication is blocked
rather than trusted merely because it was previously published. Old v1 results
remain immutable audit records and are neither reused nor accepted as prepared
inputs by the current writer. The regression fixture deliberately injects bad
stored history into a temporary database; normal ingestion already rejects it.

```sh
python -m unittest discover -s tests/market -v
node --test tests/market/contracts.test.mjs
```

Tests use isolated, migrated temporary databases and synthetic evidence. They
do not establish that a real broker export, real data source, production account
reconciliation or an investment strategy has been approved.
