# ETF directory and versioned disclosure comparison

Status: v13 research-directory implementation and synthetic API tests completed;
full P-05 acceptance is still open. This is not an approved investment universe
or a brokerage order endpoint.

## Ownership and version boundaries

- Global instrument/listing IDs identify an existing security. Joining a
  portfolio's directory does not rewrite its market, exchange, ticker or currency.
  Legacy `asset_class` values are displayed unchanged: historical records can
  mix wrapper type and underlying asset class. Membership is therefore not a
  certificate that the instrument really is an ETF. A dedicated identity-kind
  migration and verified lifecycle workflow are still required.
- Each portfolio has its own catalog revision, membership, source records,
  immutable profile versions and immutable holdings disclosure versions.
- Directory writes use a separate compare-and-swap revision and semantic
  idempotency key. They do not increment the economic ledger, book cash, change
  holdings, activate listings, approve accounts or expand a policy's universe.
- Source records are private to the portfolio. This release accepts a submitted
  structured JSON document and a human-readable reference, preserving its hash
  and server receipt time. It does not fetch URLs, read arbitrary local paths,
  import account attachments, or certify that a submitted document is a fund's
  authentic original. Provider-file acquisition and verification remain separate
  work. The source download endpoint requires an authenticated session and checks
  portfolio scope and content integrity.
- Publication is a human research action, not independent verification of a
  market fact. Unknown data stays unknown. No failure or empty response changes a
  listing to delisted.

## Profile semantics

Profiles separately retain issuer, tracked index, fund domicile, underlying asset
class, economic-region labels, sector labels, annual expense ratio, distribution
policy and replication method. Nullable fields and `unknown` are intentional.

The annual expense ratio is a decimal fraction of assets per year, not a broker
commission or a complete trading-cost estimate. Regions and sectors in this
first profile contract are labels, not weighted exposure suitable for a
concentration calculation. Identical index IDs do not establish share-class
equivalence, tax equivalence or account access. Trading currency does not by
itself identify underlying economic currency exposure.

Expense ratios, brokerage charges and market trading costs must remain distinct.
ETF market prices can differ from NAV; a spread or premium/discount requires its
own timestamp, basis and source rather than an inferred zero.
Sources: [Investor.gov ETF fees and expenses](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/mutual-fund-and-etf-fees-and-expenses-investor-bulletin),
[Investor.gov ETF bulletin](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-24).

## Holdings and overlap

`holdings-disclosure-v1` supports only `net_assets_long_only`. Each row carries an
explicit namespaced stable security ID and a nonnegative decimal-string weight.
Names, ticker similarities and common issuers do not merge different securities.
Negative weights, unsupported derivative/gross-exposure bases, duplicate IDs,
invalid dates and total weights above one are rejected.

For each disclosure:

```text
coverage = sum(disclosed weights)
uncovered = 1 - coverage
complete = explicitly asserted AND coverage equals 1
```

The supplied coverage must exactly match the decimal sum. A partial disclosure
is never rescaled to 100%. Complete securities coverage is not a claim of complete
sector, region, issuer or derivative-risk coverage.

For two selected disclosures at their own dates:

```text
known_overlap = sum(min(weight_A[id], weight_B[id])) over common security IDs
conservative_upper_bound = min(1, known_overlap + uncovered_A + uncovered_B)
```

The upper bound is conservative, not necessarily tight. An exact label requires
two complete disclosures with the same `as_of` date. Different dates compare
historical vectors, not a current same-day portfolio. Empty partial disclosures
mean unknown overlap between zero and one, not proven diversification.

The hash binds schema version, portfolio/listing identity, disclosure identity and
version, dates, weight basis, completeness, stated coverage and sorted holdings.
Object keys are recursively sorted; security IDs use ASCII ordering; source
decimal strings retain their spelling. TypeScript and Python must reproduce the
same validation and reducer output from shared synthetic fixtures.

Disclosure frequency and availability are source- and jurisdiction-specific; US
Rule 6c-11 disclosure requirements must not be generalized to every A-share,
Hong Kong or US product.
Source: [SEC ETF compliance guide](https://www.sec.gov/investment/exchange-traded-funds-small-entity-compliance-guide).

## User flow and fail-closed behavior

1. Select a portfolio and add existing listing IDs to its research directory.
2. Retain a structured source document, then publish a dated profile or holdings
   version referencing that portfolio's source.
3. Review current and historical versions, disclosure coverage and account-access
   evidence separately. Account evidence is not an executable order permission.
4. Compare at most four distinct listings, binding the exact profile/disclosure
   versions and current catalog revision. Missing versions remain missing.
5. Refresh after a revision conflict. A lost mutation response retries the exact
   same body and idempotency key rather than publishing a duplicate version.

Catalog pages use keyset pagination bound to portfolio, filters and revision.
A directory change invalidates an old cursor. Partial search results and capped
global identity choices must be labeled; they are not the full market universe.
Changing portfolios clears pending previews and comparison selections.
The first page and subsequent pages use the same page size. Unapplied filter
drafts do not change a cursor's filters. Opening another listing clears the
previous listing's holdings draft. Histories and source choices show explicit
truncation flags; holdings versions in lists return summaries rather than every
constituent row.

An uncertain mutation response freezes the editor. The original body/key is
retained until a successful retry or an explicit decision to abandon tracking;
in-page refresh or listing/portfolio switching cannot silently replace it.
This draft is not durable across a forced page reload or navigation away from
the component. Recheck server history before issuing a new command after leaving.

## Verification at this checkpoint

- Migration v12 to v13 preserves preexisting facts; catalog sources and versions
  are append-only with composite portfolio/listing/source foreign keys.
- Web 315/315, Python 244/244 and root Node 63/63 passed. Typecheck, production
  build, authentication HTTP, shellcheck and production dependency audit passed.
- Production-build HTTP 50/50 passed against a fresh synthetic database. The five
  catalog cases exercise separate revisions, retry, private inert source download,
  scope/version guards, explicit unknown overlap, historical-vector bounds,
  stable pagination and recovery-mode read/write separation.
- Manifest: `artifacts/verification/workbench-http/2026-09-12T12-23-57-265Z/`.
  Build `CVIVVyLIjP7cDu6zR1jU5`; 304 inventoried source files unchanged during the
  run and subsequent verification.
- Browser-native add-entry, committed-but-lost-response identical retry, a second
  entry and structured source storage were observed at catalog revision 3 with
  economic revision 0. The later browser profile/disclosure flow did not produce
  profile or holdings versions. Browser Runtime Service became unavailable and
  the development fixture stopped responding; its SQLite snapshot and process
  sample were retained, then the task-owned fixture was stopped.
  No completed native comparison, mobile screenshot or final visual acceptance
  is claimed. See `artifacts/verification/browser-catalog/report.md`.

## Deliberately not granted by this release

- Provider authenticity, a current complete ETF universe or automatic lifecycle
  maintenance.
- Market-price freshness, FX, liquidity, premium/discount, tax treatment or
  live brokerage availability from profile labels alone.
- Use of this research metadata as weighted governance input. Existing independent
  governance evidence and risk gates remain in force.
- Approved candidates, an automatic investment recommendation or a profitability
  claim.
- Public sharing of personal portfolio sources or account evidence. Public code
  and fixtures are generic; personal plans stay in the ignored local directory.
