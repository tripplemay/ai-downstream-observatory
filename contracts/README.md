# Versioned workbench contracts

`v1/*.schema.json` are JSON Schema Draft 2020-12. Load all schemas into the same validator registry; `$id` hostnames are stable identifiers, never fetch targets. Use `ajv/dist/2020` with date/date-time formats in TypeScript and `jsonschema.Draft202012Validator` with its format checker in Python. Money, quantities, prices and FX must stay decimal strings throughout parsing and storage.

`ledger-command` is the untrusted command envelope. `actor_id` is deliberately absent: the authenticated server supplies it. `ledger-fact` rejects event-inapplicable and unknown fields. Application checks remain necessary for positive amounts, source quantums, account ownership, timezone validity, linked outstanding balances, cash/position availability, chronology and event-specific arithmetic. Schema validity alone is never authority to book a fact.

`ledger-event` is the immutable persisted/API event representation. In SQLite, its `payload` is encoded as `payload_json`; the other columns retain the same names. The command hash must use deterministic canonical serialization, not arbitrary JSON property order. Same idempotency key and same payload replays the original result; different payload must conflict. Broker source identity is `(account_id, source_id, source_event_id, event_type)`; equal amounts are not a deduplication key.

`market-observation` does not confer completeness or publication. Publication additionally requires a complete validated batch and a manifest; revision and price-basis keys must remain distinct. Unknown publication times are omitted, never replaced by observation or ingestion times.

`market-batch` describes synthetic or explicitly evidenced manual batches, not an external live-source adapter. Plan fields not present as dedicated SQL columns are stored under `market_batches.validation_json.plan`. Page payloads and receipt times are immutable. Batch membership can reuse a previously stored observation without changing its first-ingestion history. Query publication history through `market_publication_events` and observations through `market_batch_members`; do not infer historical scope snapshots from the mutable publication head or observation's first `batch_id`. Synthetic provenance and parent batch/source identities require semantic validation in addition to JSON Schema.

## SQLite migration entrypoint

```sh
node scripts/migrate-workbench.mjs --db /absolute/path/etf-workbench.db
node --test tests/migrations/*.test.mjs
```

The explicit migration command is the only schema writer. It loads the checked-in checksum manifest, verifies contiguous versions and existing history, and applies all pending migrations in one `BEGIN IMMEDIATE` transaction. It refuses legacy/unknown databases, relative paths and `observatory.db` paths (including symlink aliases). Empty schema initialization creates zero portfolios, accounts, funds, approvals or activated strategies. Do not edit an applied migration: add the next numbered file and manifest entry.

Runtime connections must separately enable `foreign_keys`, verify WAL and use `synchronous=FULL`; `verifyWorkbenchSchema(db)` checks version/checksum history without creating tables. The exported `migrateWorkbench(path)` function supports temporary-database integration tests. A schema `TEXT` column prevents lossy SQLite floating-point storage, but SQLite affinity can stringify numeric bindings; callers must validate JSON decimal types before binding. Exact balance checks are performed with decimal arithmetic by the atomic ledger service, not SQLite floating-point sums.

Core table and ledger ownership is defined in [05](../docs/05-architecture-and-migration.md). SQL enforces per-portfolio account references, append-only facts, unique source identities and research/actual isolation. A same-portfolio event may post to both accounts for an internal transfer or FX; it may not cross portfolios. Financial postings and position projections are replaceable only through authorized ledger commands, never direct AI or worker writes.

Unknown-cost sale proceeds are balanced against `unclassified_income`, not recognized as known investment profit. This clearing account is excluded from NAV just like `inventory_cost` and `income`; retain the unknown-cost warning until an evidenced historical-cost correction can classify the amount. `opening_equity` balancing historical inventory cost is not itself the performance inception fair value: freeze an independently evidenced opening valuation before computing inception returns.

## Dividend and corporate-action quality

`ledger-fact` preserves legacy dividend facts with omitted tax, but omission is unknown tax, never confirmed zero. New direct dividends require confirmed explicit tax at the command boundary. Actual net receipts, gross/tax breakdown, cumulative tax assessments and actual additional withholding are different facts: assessments and breakdown do not create cash. Migration 0012 adds the signed `dividend_tax_payable` liability without rewriting prior postings. See [the locked accounting rules](../docs/dividends-and-corporate-actions.md).

`ledger-fact-quality` binds independent NAV, after-tax performance and attribution quality to full immutable event-row hashes, economic cutoffs, ledger revision and knowledge time. Recompute it from the full portfolio event set, including applicable reversals and resolution dependencies; a claimed binding hash alone is not verification. Point evidence has `period_start: null`. Period evidence retains interval-eligible end-state arrays while its top-level qualities, issues and event hashes cover all intermediate quality boundaries. Ordinary date-only dividend facts can make an actual intraday snapshot provisional; internally generated period boundaries must not invent precise intraday event timing. A date-only notice blocks from local midnight; a date-only resolution clears only at the following local midnight.

`valuation-input-v3` requires one `ledger_fact_quality` point proof. `performance-input-v5` requires point proofs in valuation order plus `period_fact_quality`, so an unresolved middle-period action cannot disappear merely because both endpoint snapshots are complete. Restated performance uses one knowledge time for every proof; as-known proof knowledge time is its own cutoff. These contracts do not authorize trading or make unresolved tax/action estimates into actual cash.
