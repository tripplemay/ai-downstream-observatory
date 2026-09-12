# Market provider collection

This is a data-source implementation checkpoint, not production or strategy
admission. The approved [publication boundary](publication-privacy.md) applies:
personal plans, account originals and real provider captures are not public
fixtures.

## ECB vertical path (introduced in v16)

The v17 worktree also implements [reviewed references and LongPort price
collection](market-price-collection.md). Its SDK projections use a separate
capture table and contract; they do not replace or reinterpret ECB HTTP bytes.

The authenticated workbench task entry accepts `market_collect`. The request
uses the strict `market-collect.schema.json` contract:

```json
{
  "provider": "ecb",
  "feed": "daily",
  "currencies": ["EUR", "USD"],
  "expected_publication_revision": 0,
  "publish": true
}
```

This is a generic data example, not a portfolio or funding default. Feeds are
`daily` or `hist_90d`; currencies must be explicit and unique, with at most eight
supported values. The server derives
`provider:ecb:fx:<feed>:<sorted-currencies>`. A request cannot supply URLs, tokens,
headers, source grades, raw data, receipts or knowledge timestamps.

1. Existing authentication, portfolio revision and idempotency checks enqueue
   the command without creating cash or trading facts.
2. A leased worker checks the publication head before fetching. HTTPS download
   and XML parsing run outside the SQLite write transaction.
3. Fixed ECB endpoints use system trust through `truststore==0.10.4`, hostname
   and certificate verification, TLS 1.2 or later, public-address DNS checks and
   a pinned numeric socket. No inherited proxy or redirect is used. Size,
   response framing, compression, XML structure and decimal bounds are checked;
   DTD and entity declarations are rejected.
4. The worker preserves XML bytes, allowlisted response metadata, actual receipt
   times, normalized rows and the derived batch. Publication v2 binds all hashes
   and every observation member.
5. The final short transaction rechecks lease/fence, restoration mode, prepared
   hashes and publication CAS, then commits capture, batch, head and job together.
   Job completion is timestamped after the effect, not before it.
6. Python and Web consumers verify provider evidence, not just a source label.
   Python replays the original XML; Web independently checks hashes, exact cross
   arithmetic, documents, membership, worker origin and knowledge-time bindings.

`publish=false` stores a validated capture but does not activate its data. A
terminal collect job cannot later be used by the legacy publish CLI to elevate
it. Publication currently requires a new explicit `publish=true` collection with
the current head. A separately authorized publish-existing-capture command is
not implemented. The old manual/synthetic contract remains distinct and cannot
use the reserved provider namespace.

## Time and rate meaning

ECB quotes currencies against EUR and describes these as information-only
reference rates, not transaction rates. Its usual update time does not prove an
individual observation's historical publication instant.
[ECB reference-rate description](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)

- CNY crosses use `CNY_per_EUR / currency_per_EUR`; both original legs are retained.
  Exact rational arithmetic is rounded once, HALF_EVEN at scale 18, without floats.
- Dates retain `Europe/Berlin` and date precision. Missing `published_at` stays
  missing. `ingested_at` is the response receipt, not the historical rate date.
- `revision_id` is a local capture version, not a claimed official revision.
  Recollection appends evidence and never edits old observations or originals.
- `provider_observed` proves the collection path, not historical PIT. Returned
  dates in the 90-day feed are recorded, not certified as a complete calendar.
- NAV still needs approved rules, eligible knowledge time, currencies and
  freshness, with the existing conservative date-only end-of-day boundary.
  Per-event flow FX still blocks without required publication-time evidence.
  Provider flow evidence uses v3 and performance input/method v6; existing manual
  evidence retains v2/v5 bytes and meaning.
- Current research requires explicit observation instants. This feed does not
  bypass that requirement or activate rotation, execution or AI.

## Original storage and security

Migration v16 adds immutable `market_provider_captures`. Its `raw_body` stores up
to 2 MiB within the private database; normalized and batch documents are each
bounded to 4 MiB. The existing encrypted database backup/restore therefore covers
these bounded originals without an additional untracked attachment directory.
The v17 price path has its own bounded multi-security SDK capture design and
table; it does not rebuild or weaken this v16 table.

DDL and service checks bind capture, request, attempt, fence, source, types and
timestamps. UPDATE, DELETE and SQLite REPLACE cannot overwrite captures. Read-only
verification works during recovery. Network exceptions become fixed error codes
before reaching the job logger; the browser receives summaries, not XML or keys.

Real network checks belong in `.private/provider-captures/`, never in
`artifacts/verification/`, which CI uploads. CI uses synthetic responses and
accounts only. Connect/TLS/read deadlines do not guarantee interruption of OS DNS;
an expired worker cannot publish when it returns. A hard process deadline for
ECB DNS remains a fault-test item. System trust does not disable verification or
modify system certificates. [Truststore API](https://truststore.readthedocs.io/en/latest/)

## LongPort adapter boundary

The pinned `longport==4.3.7` adapter implements bounded day / NoAdjust /
regular-session calls using only the official QuoteContext. It preserves
`sdk_projection` bytes, not falsely labelled HTTP/protobuf originals. It checks
mapping, dates, missing/duplicate/extra bars, Decimal values and timestamps.
Caller-supplied expected dates remain unverified calendar expectations.

The official Python wrapper constructs local naive datetimes from Unix
timestamps. Only the fixed, version-checked UTC child interprets these as UTC;
the pure parser rejects naive inputs. The child uses a private empty `.env`, an
environment allowlist, stdin-only credentials, bounded output, a 30-second timeout
and process-group cleanup. It never constructs a TradeContext.
[Pinned time conversion](https://github.com/longportapp/openapi/blob/72e9be585d2724358ddaf7d6afbb64bb9e01205d/python/src/time.rs),
[official history interface](https://open.longportapp.com/docs/quote/stocks/history-candlestick)

The native wheel and method signatures were checked locally. Synthetic tests
exercise actual isolated processes and the wrapper boundary; no real LongPort
credentials or market call have been used. The v17 `market_collect_prices`
request now connects portfolio-private, human-reviewed mapping/calendar versions
to bounded SDK capture, atomic publication and independent consumers. The review
grade remains `human_reviewed_not_provider_verified`; actual permissions,
authoritative references and live market acceptance remain outstanding.
Adapter tests alone do not establish A/HK/US live coverage.

The SDK is an explicit optional dependency in `requirements-market-longport.txt`,
not the core runtime. Its CPython 3.11 Linux wheels target `manylinux_2_39`, which
cannot run on the core Bookworm/glibc 2.36 image. The v17 dedicated
`Dockerfile.market-provider` uses a digest-pinned Trixie image and reviewed wheel
hashes, binary-only installation, no unpinned transitive dependencies and UID
10001. Core workers do not take optional price jobs. The optional Compose profile
is not automatically deployed by the base release script. Native offline image
validation is a separate CI step; its real-market result must remain false.
Core CI tests use fake SDKs and need no SDK installation or keys.
[Pinned distribution files](https://pypi.org/project/longport/4.3.7/#files)

## Evidence and remaining acceptance

Local ECB daily and 90-day checks exercised real fixed HTTPS, immutable originals,
publication, Python replay and Web verification in an isolated portfolio with no
accounts, cash, policies or approvals. Originals and detailed evidence remain
private. This was not a production database.

Synthetic tests cover v15-to-v16 migration, original-byte encrypted recovery,
contracts, impersonation, leases, CAS, restoration, read-only consumers and PIT.
A live transfer exposed an EOF socket-lifetime error absent from mock responses;
a real local socket-pair / HTTPResponse regression now covers it.

Local frozen-source regression passed Python 443, Web 524, root Node 107 and
production-build HTTP 72 cases, plus typecheck/build/authentication/shell checks.
The three collection HTTP cases use only synthetic XML and verify successful
worker publication, pre-write rejection and failure preserving the previous
head. See the [checkpoint record](07-implementation-tracker.md#provider-collection-worktree-v16).

The v16 public checkpoint is commit
`926dc4ce4912b7cd8768d315a398d43d8ed51fc0`; its exact-SHA
[CI 34710911980](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/34710911980)
succeeded, including Linux core images, schema 16 and local encrypted recovery.
That historical run did not contain the v17 optional provider image or shared
price publication. Native UI acceptance, authoritative calendars, recurring
collection, real broker formats, continuous forward simulation, trusted strategy
admission, independent-host recovery and production deployment remain open.
