# Explicit market publication and valuation

This module is separate from `worker/fetch_data.py` and `db.py`. Publication and
valuation commands do not fetch external sources. The explicit
`inspect-longbridge` (OAuth) and `inspect-longbridge-apikey` commands make bounded
market reads and emit only check metadata. None of these commands execute broker orders, activate
strategies, write ledger facts, or seed real balances. Synthetic data is labeled
reconstructed and cannot produce a complete valuation of an actual portfolio.

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

## Isolated Longbridge OAuth inspection

This development-only entry point is distinct from the existing LongPort SDK
collector and capture schemas. It requires an explicit absolute CLI binary,
an existing private OAuth HOME (owner-only permissions, not the user's global
HOME), one validated symbol, both window endpoints, and caller-supplied expected
dates. The adapter does not log in, read traditional keys, infer holidays, open
a database, save market values, or enable a scheduler.

```sh
python -m worker.market inspect-longbridge \
  --cli-binary /private/tools/longbridge \
  --oauth-home /private/tools/oauth-home \
  --symbol SYNTH.US --start 2025-06-05 --end 2025-06-06 \
  --expected-date 2025-06-05 --expected-date 2025-06-06
```

The paths and symbol above are placeholders, not a callable real-data fixture.
Authenticate the dedicated HOME using the official CLI before inspecting.
Version `0.28.7` is locked; currently only the verified macOS arm64 binary is
approved. Its executable digest is derived from the release archive verified
against the official cask; the archive and executable digests are different.
The runtime checks a private binary copy before execution and permits only
`--version`, `quote`, and `kline history` with fixed `day/none/intraday` options.
Each call has a 30-second parent deadline and an independent kernel timer;
stdout is bounded to 2 MiB, diagnostics to 16 KiB, and the environment excludes
caller credentials, proxy overrides and database configuration. Provider
diagnostics are reduced to fixed error codes, never echoed verbatim. Temporary
files contain only the verified executable and an empty dotenv file; OAuth
state may be refreshed by the CLI in the dedicated HOME.

Daily prices retain exact decimal spelling and volume uses an int64 decimal
string. UTC bar times are converted using the market's IANA timezone, including
US DST. Empty, missing, duplicate, unexpected, out-of-order, current/future or
invalid bars fail rather than fill gaps. Passing expected-set equality only
proves equality with the caller's dates, not an approved trading calendar.

Successful inspection exits 0 with `status=sample_read_ok`, counts, local dates
and explicit unverified fields; it emits no price values or authentication
material. There is no arbitrary CLI subcommand or `--execute` passthrough.
Quote freshness remains unverified because the locked CLI does not expose the
source timestamp. Identity, licensing, company actions, total return and
production readiness are not established. Details and local live-read evidence
are in `docs/11-longbridge-ai-market-data-access.md`.

```sh
python -m unittest tests.market.test_longbridge_cli_provider -v
```

## Isolated Longbridge API Key inspection

`inspect-longbridge-apikey` reuses the locked `longport==4.3.7` SDK child for one
explicit daily window. It has no database access, no price persistence, no
automatic credential fallback and no account/trade commands. Choose exactly one
credential source: an absolute private owner-only regular file, or explicitly
`--credentials-env` for the provider container's injected environment.

```sh
python -m worker.market inspect-longbridge-apikey \
  --credentials-file /private/config/longbridge.env \
  --symbol SYNTH.US --currency USD --start 2025-06-05 --end 2025-06-06 \
  --expected-date 2025-06-05 --expected-date 2025-06-06
```

The values above are placeholders. One complete `LONGBRIDGE_*` or `LONGPORT_*`
App Key/App Secret/Access Token set is required; mixed or partial namespaces
fail rather than silently choosing credentials. This alias support also applies
to the existing provider worker's environment input. The file parser never
sources shell code or searches dotenv files. No credentials go into argv.

The SDK child uses a closed UTC environment and an empty dotenv file. A shared
bounded memory transport drains output while writing the private stdin protocol,
enforces output/diagnostic caps and parent/kernel deadlines, and cleans up on
cancellation. Returned projections are rebound to the request and call interval
and canonically replayed before emitting only metadata. It does not use the
older collector's temporary-file capture path. Currency, identity, licensing,
calendar, company actions, total return and production readiness remain
unverified; access-token expiry and rotation are operator responsibilities.

Generic server integration and local read evidence are in
`docs/12-longbridge-apikey-server-access.md`. The optional Compose provider and
collection plans remain disabled unless separately approved; this inspector is
not a new onboarding prerequisite for portfolio research.

```sh
python -m unittest tests.market.test_longbridge_apikey_provider -v
```

## SDK-confirmed daily callback receiver foundation

`providers/longport_confirmed.py` is a separate read-only Python receiver, not an
automatically enabled collector. The private investor wrapper below uses its
own versioned receipt, never the historical-v1 capture format.
It locks `longport==4.3.7`, uses `PushCandlestickMode.Confirmed`, Day/Intraday,
fixed official endpoints and only QuoteContext. No TradeContext, account, order
or token-refresh call is exposed. The original historical adapter still rejects
the current local date; a callback is not repackaged as a historical-v1 receipt.

The pinned SDK computes `is_confirmed` in its local candlestick engine. This is
not an exchange signoff, a preserved network message or proof of uninterrupted
streaming. Subscribing also warms the SDK with up to 1000 unadjusted historical
bars; those returned snapshots are ignored, not used to fill missed callbacks.
See the [official push description](https://open.longbridge.com/zh-HK/docs/quote/push/candlestick)
and [pinned implementation](https://github.com/longportapp/openapi/blob/72e9be585d2724358ddaf7d6afbb64bb9e01205d/rust/src/quote/core.rs).

Requests are copied before credential or subprocess I/O, binding 1-32 unique
listings, one explicit session per listing, calendar hash, reviewed
close/availability and an explicit 32-hex watch ID. A watch lasts 1-900
seconds with a separate 30-second startup allowance, parent cancellation,
kernel timer, disabled core dumps and a 2 MiB output-file cap. Credentials enter
only through the private stdin protocol. The owned child uses a 0700 temporary
HOME, a 0600 empty dotenv and a closed UTC environment; the parent kills/reaps
its process group and removes its files on success, failure, timeout or stop.

Only an actual callback with a boolean confirmed flag, daily period, regular
session, correct local date and receipt no earlier than the supplied availability
can produce a projection. Decimals and int64 volume stay exact. Identical
callbacks deduplicate; conflicting bars, bad callbacks/protocol or a late child
failure discard the batch. Empty/partial coverage remains explicit. A callback
arriving before the declared availability fails rather than being retimed; a
new watch started after the close cannot retrospectively prove a missed event.
Different market closes need separately scheduled windows, not assumed joint
coverage in one short watch.

Canonical NDJSON is independently replayed in Python, including strict byte
comparison to reject boolean/integer aliases. Pure parsing always remains
`parser_only_not_network_authenticated`; only the fixed isolated transport sets
`isolated_official_sdk_callback`. Neither label approves licensing, calendar,
identity, buyability or investment use. The caller must not accept the JSON label
as proof of origin. The wrapper now performs owner/source checks and retention
cleanup; monitor admission, automatic collection scheduling and three-market
live acceptance are still unimplemented.

```sh
python -m unittest tests.market.test_longport_confirmed
WORKBENCH_TEST_PYTHON=/absolute/private/venv/bin/python \
  node scripts/verify-longport-confirmed-receiver.mjs \
  --temporary-root /absolute/external/owned-0700-directory
```

Tests use fictional credentials, callbacks and child transports. The installed
SDK is inspected offline without constructing a quote context. These checks
make no real market or gateway request and are not production certification.

### Private confirmed-capture persistence

`worker/investor/confirmed_capture.py` checks the current workspace owner and
audited, approved rights/listing/calendar reviews before I/O, during cancellation
polls and again in a short commit transaction. Network waits hold no write lock.
Rights must cover private research, retention, display and backup. A withdrawal,
changed source, restore lock, expired grant or late stop prevents the whole
capture/audit/target/payload write. Injected receivers are always synthetic;
production clock/endpoint/SDK/qualification overrides are not CLI options.

Migration 41 adds separate immutable captures, normalized target bindings,
bounded removable protocol envelopes and audited purge receipts. Expiry is the
earliest rights/review/retention deadline across every watched target, including
missing events. Exact canonical callback bytes are replayed; caller-supplied
records or status labels are ignored. No raw network bytes are claimed.
Python and `web/src/server/investor/confirmed-source.ts` independently replay
private retained evidence, checking current sources, owner/audit, scope, hashes,
calendar, time, coverage and purge markers. Synthetic reads are test-only.

Advanced owner CLI commands are `collect-confirmed-prices` (a private file with
only `targets` and `watch_seconds`, plus a private credentials file),
`check-confirmed-capture` and `purge-confirmed-payload`. Output is metadata only.
Each target has rights/listing/calendar review IDs and an explicit session date;
no caller price or calendar array is accepted. See the
[private pipeline](../../docs/14-private-research-data-pipeline.md#私有收盘回调收据与独立读取).

Default core maintenance now logically deletes expired/withdrawn-rights
confirmed payloads within the existing shared budget. Immutable receipts stay.
This does not prove WAL/backup erasure, produce observations, enqueue monitoring,
or connect these captures to `monitor_data`. Automatic listening around each
market close, downstream admission and real licensed evidence remain open.

```sh
WORKBENCH_TEST_PYTHON=/absolute/private/venv/bin/python \
  node scripts/verify-investor-confirmed-captures.mjs \
  --temporary-root /absolute/external/owned-0700-directory
```

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
