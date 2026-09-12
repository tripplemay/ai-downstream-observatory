# ETF workbench implementation and release tracker

Updated: 2026-09-12. This is a progress record, not an acceptance certificate.

## Objective and authority

Implement the full six-document v1.0 plan, test it, push the code and deploy to
production. The user has authorized that objective. Investment policy choices,
actual account facts and strategy admission still require their own evidence;
engineering authorization does not manufacture those facts.

The scope remains P-01 through P-08, ACC-01 through ACC-19, E-01 through E-32,
S-01 through S-10 and migration/recovery requirements. Passing a subset below
does not shrink that scope or certify a release.

The publication boundary is confirmed: publish code and generic examples; keep
the personal investment plan isolated locally and inspect the Git index before
committing. The six original personal v1.0 baselines are retained locally;
replacing personal parameters with public templates does not reduce scope.

## Implementation sequence and current evidence

| Workstream | Current implementation | Remaining work / release evidence |
|---|---|---|
| Contracts and new database | Versioned migrations through v13; immutable facts, scoped foreign keys, shared JSON Schema; append-only funding/security-transit/CSV evidence and private catalog versions; dividend tax payable and independently reproducible fact-quality contracts | v13 image/recovery rerun, actual cutover tail-difference proof, final pushed release binding |
| Authentication | Sealed sessions, persistent revocation/rate limit, server-side guards, strict Origin; authenticated HTTP and native login/logout checked; initialization/login share UTF-8 password bounds | Production TLS/proxy, operator configuration and real owner login |
| Financial ledger | Exact decimal facts, cash/trades/settlement/dividends/FX/transfers/splits; unknown/estimated/confirmed tax, net-only receipts, cumulative tax assessment and actual withholding kept separate; corporate-action notice/resolution isolation; securities transit and append-only dependent corrections | Real dividend/tax/corporate-action and security-transfer evidence, full acceptance matrix |
| Import and reconciliation | JSON and raw CSV attachment/preview/atomic confirmation; immutable mappings and row evidence; explicit duplicate review and persistent source aliases; scoped downloads and encrypted recovery; explicit balance/tax-payable/settled/transit reconciliation and unresolved-fact guards | Domestic/cross-border broker samples, visual mapping wizard, large background imports and full throughput/fault acceptance |
| Accounting and performance | Immutable NAV v4/performance v5; source-owned transit NAV and per-event external-flow FX; independent Python/Web fact-quality proofs for NAV, after-tax performance and attribution, including intermediate-period unresolved states | Actual historical FX/provider and dividend evidence, full attribution/benchmark/history workflows; implementation is not complete acceptance |
| Funding plans | Dated multi-currency sources and tranches, version editing/deferral, partial receipt matching, execution association, cash/reservation separation, over-budget acknowledgement, correction review and full audit history | User-confirmed dated plan, broker evidence, D-05 allocation choices and full execution/funding workflow acceptance |
| ETF research directory | Portfolio-private membership/source/profile/disclosure versions; independent CAS, stable pagination, account-evidence summaries and up-to-four version-bound comparisons; TS/Python exact-decimal overlap bounds with coverage and date semantics | Verified provider originals, identity-kind/lifecycle migration, current fees/liquidity/premiums and weighted exposures; full P-05 and native comparison/mobile acceptance |
| Market and orchestration | Immutable paged batches, validate/publish CAS, as-known/restated valuation, leases/fencing/retry/outbox; valuation/market/performance worker commands | Real provider adapters, validated exchange calendars, recurring schedules, full fault/load tests |
| Strategy and AI | Preregistered fixed-weight research, frozen inputs/implementation, train/validation/holdout separation, same-flow/cost/FX benchmark; seven Web-to-Worker commands and read-only AI review; 3300-day synthetic indexed replay | Live providers/models, complete rotation/forward simulation and genuine S-gate evidence |
| Governance and execution | Human version/capability APIs, risk/approval CAS, independent-process cash/share reservation race tests, execution reports separate from facts; trusted verification import rejects user PASS claims; Web/API integration | Actual trusted verification Worker, formal evidence and runtime manifest binding; actual D/G/S approvals remain absent |
| Product UI | Account, funding, catalog, research and governance workspaces; typed securities and dividend/tax/corporate-action preview/confirm; advanced CSV mapping upload/editor and paged row review; frozen same-body confirmation retry | Visual mapping wizard, full native catalog comparison and positive governance flow, complete accessibility and readonly UX; supported workflows still need full acceptance |
| Deployment | Manual-only release, encrypted backup/restore, non-root v8 images; full real legacy-copy archive/recovery rehearsal; old production unchanged; late recovery marker blocks migration/cutover | Independent-host restore, protected credentials/configuration, index privacy verification, push/CI/release and post-release checks |

## Reproducible checks

Run from repository root unless otherwise stated. Test suites use temporary
databases and synthetic facts, not user accounts.

```sh
node --test tests/*/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py' -v
shellcheck scripts/deploy-workbench.sh tests/deployment/container-smoke.sh
```

Run from `web/`:

```sh
npm test
npm run typecheck
npm run build
npm run test:auth:http
npm run test:workbench:http
```

Previous local v11 CSV checkpoint, retained as historical evidence, not v12 acceptance:

- Web 236/236, Python 199/199, root Node 58/58 (including migrations and flow
  contracts), typecheck, authentication HTTP and shellcheck passed. Production
  dependency audit: zero vulnerabilities. Cross-language Web tests require both
  Python environment variables below; two early runs used the wrong interpreter
  and are not included in these final passing counts.
- Production build `gorUQLjTLYwvNA5cMv6uC`, HTTP 41/41 (eight new CSV scenarios),
  schema v11. Run `2026-09-12T02:03:43.133Z` through
  `2026-09-12T02:03:45.638Z`; all 264 source entries unchanged during and after.
  Evidence: `artifacts/verification/workbench-http/2026-09-12T02-03-43-133Z`;
  manifest SHA-256 `fe19de0f2edeaa001746edfb16b393af5941feaf7628fcace32414133b616384`.
- Earlier HTTP run `2026-09-12T02-00-47-859Z` correctly failed: the global Next
  CSP overrode attachment sandbox headers. A dedicated attachment-path CSP rule
  fixed it; the final build and HTTP41 verified the real response, without
  weakening the assertion.
- Independent review found and reproduced same-file linked-row double entry,
  cross-file source-binding loss and stale-preview source alias rebinding without
  a monetary revision change. All have failing-before/passing-after regressions;
  current confirmation rechecks source contents/target and in-batch identity.
- Native browser synthetic fixture: 26-row/two-page review, inert formula/raw-byte download,
  no automatic decisions, last-page gating, actual commit then lost response,
  exact retry (25 facts, CNY 448.125), A-B-A scope reset, desktop dark/mobile
  dark+light and logout 401. See `artifacts/verification/browser-csv/report.md`.
- Logs: `artifacts/verification/final-regression/*csv-v11*.log`. Final Web run is
  `web-csv-v11-post-headers.log`; final build/HTTP use `*-download-headers.log`.
  v11 migration SHA-256 is
  `4d14a01683591ced051136a734d67cd3fc2d169149dc5989b7f721d859f0e54e`.
- No native domestic/cross-border broker format certification, 10k-row background throughput,
  new v11 container/independent-host recovery or production cutover is claimed.
  All new work remains unstaged; prior index tree
  `c21aecfe9b4cfb088aeb954af41e75e97e7743fe` is unchanged. No commit/push.

Previous local v10 / valuation-v3 / performance-v4 checkpoint, not current v11 acceptance:

- Web 189/189, Python 199/199 (accounting 55, market 28, orchestration 24,
  performance 58, research 34), root Node 48/48. Typecheck, authentication HTTP,
  shellcheck and production dependency audit passed (zero vulnerabilities).
- Production build and HTTP 33/33 passed, schema v10, build
  `ES7lzBrbEWzQPr0lrtKP5`, from `2026-09-12T01:19:25.293Z` to
  `2026-09-12T01:19:41.016Z`. All 250 source entries were unchanged during the
  run and at subsequent verification. Evidence:
  `artifacts/verification/workbench-http/2026-09-12T01-19-25-293Z`.
  Manifest SHA-256:
  `10e3a9e34d69eaf37761f89ec651f247280601836799ffa2c5a9348aa49156ad`.
- Securities native browser flow covered external receipt, internal dispatch,
  partial receipt, final return, preview invalidation and an actual confirmation
  commit followed by lost response and exact retry. Desktop light/mobile dark
  screenshots, logout and limitations:
  `artifacts/verification/browser-securities/report.md`.
- Independent review reproduced a directory-limit UI bug for the 1001st
  listing. Receipt/return now derives security identity from the selected lot;
  regression and final build passed. The native browser run predates only this
  pagination-specific fix, which has not been rechecked natively.
- First full Web pass exposed two obsolete test fixtures (current code writing
  a historical v8 schema, and a v2 valuation labeled current). Historical rows
  are now seeded explicitly; current valuation fixtures include v3 evidence.
  The final counts above are after those corrections, not the failed run.
- CSV foundation has 15 passing tests but no production CSV command or native
  broker certification. See [CSV boundaries](csv-import.md). Securities contracts,
  valuation/performance and account reconciliation are documented in
  [security transfers](security-transfers.md).
- All this work remains unstaged; the prior index tree is unchanged. No v10
  container build, independent-host recovery, commit, push or production cutover
  is claimed. Logs: `artifacts/verification/final-regression/*securities-v10*.log`.

Previous local v9/performance-v3 engineering checkpoint, not current v10 evidence:

- Web 147/147, Python 180/180 (including performance 47), root Node 46/46.
  Typecheck, authentication HTTP, shellcheck and dependency audit passed;
  npm audit reported zero vulnerabilities.
- Production build and HTTP 32/32 passed, schema v9, build
  `fUrKvxbFw1rcI85svrs1o`; source inventory covers 231 files and changed by zero
  files during the run and at post-browser verification. Evidence:
  `artifacts/verification/workbench-http/2026-09-12T00-31-30-306Z`.
  Manifest SHA-256:
  `a7e353189bdef51b2d9d9f3f1293568399b71204fb6b1f25ff121e60b1d450d9`.
- Funding browser checks include typed plan save, empty account selection,
  confirmed conflict/refresh/retry, actual commit followed by a lost response
  and exact deduplicated retry, failed reads, scope changes, separate budget
  acknowledgement, receipt matching and deferral without duplicating cash,
  desktop/mobile layout and logout. Report and three inspected screenshots:
  `artifacts/verification/browser-funding/report.md`.
- Earlier browser attempts correctly rejected a fixture with an obsolete v9
  checksum. A separate Node 25 development reload exposed CommonJS `require`
  in the TypeScript Tailwind config; static plugin imports fixed it. The final
  clean-fixture browser run and production build used the corrected config.
- These changes have not been staged or published. The prior index checkpoint
  remains intact. No v9 container or production deployment is claimed.

Previous v8 checkpoint evidence (retained, not evidence for current v9 images):

- Web: 112/112 passed on the post-recovery-guard source. Typecheck passed.
- Python: 160/160 passed: accounting 50, market 25, orchestration 24,
  research 34 and performance 27. Root Node post-guard suite: 45/45 passed.
- Workbench production-build HTTP flow: 27/27 passed on schema v8, build
  `nfeqzr5gpw2NBFGCGDcvt`; artifacts at
  `artifacts/verification/workbench-http/2026-09-11T23-10-40-674Z`.
  Its source inventory changed by zero files during the run. Earlier HTTP
  manifests remain untouched and describe only their original snapshots.
- Authentication HTTP, shellcheck and dependency audit passed; npm audit
  reported zero vulnerabilities. Logs are in
  `artifacts/verification/final-regression/` (local, excluded from Git).
- Native browser synthetic operations, desktop/mobile screenshots and limitations:
  `artifacts/verification/browser-operations/report.md`.
- Research/governance dark desktop/mobile checks and refresh/scope fault
  injection: `artifacts/verification/browser-decisions/report.md` and
  `refresh-guards-20260912.md`. These do not prove a live approval/trade cycle.
- Isolated container release/restore rehearsal: see
  [production release verification](production-release-verification.md). This was
  not a deployment of the new application to the production URL.
- Final v8 image fixture `20260911T231619Z-427243` passed after adding the missing
  builder scripts directory; no typecheck was disabled. A separate real legacy
  Online Backup copy (17 tables, 812,776 rows) was fully compared, archived into
  an otherwise empty v8 database and restored from a 932,701,236-byte encrypted
  package. Total case time was 379.483 s under 1 CPU/1 GiB; restore process was
  76.384 s. This is a same-host case, not production RTO or full load acceptance.
  Aggregate evidence: `artifacts/verification/release/v8-20260912-2316/`.

Counts change with new tests; source/manifest changes invalidate prior release
claims. The local Python environment used for these checks is
`/tmp/etf-workbench-python-venv/bin/python`; set both `WORKBENCH_PYTHON` and
`WORKBENCH_TEST_PYTHON` for Web cross-language tests and HTTP/fixture scripts.

## Known incomplete paths

- Ordinary late fact entry still raises `CHRONOLOGY_REVIEW_REQUIRED`; the explicit
  correction command now supports void/replace/insert with immutable evidence,
  reversals and dependent replay. Mixed time precision/timezones, ambiguous
  same-day order and more than 5,000 replay steps remain deliberately blocked.
- JSON and generic explicit CSV mapping are not completed domestic/cross-border
  broker integrations. Raw attachments and versioned mappings are retained;
  actual broker samples, visual mapping and background throughput remain open.
- Complete/provisional/blocked valuations and performance are published and
  shown, with stale ledger versions visible. Current methods are NAV v4
  and performance v5; earlier evidence is marked superseded. Unknown tax and
  provisional net receipts do not become confirmed tax-free income; unresolved
  company actions block exact valuation/returns. Independent point and period
  fact-quality proofs are implemented but not fully accepted. Foreign flows
  lacking approved rules, timing or verified FX remain blocked. All date-only
  external securities flows, including CNY, require true timing before returns
  can be evaluated. See [security transfers](security-transfers.md).
- Research and governance implementation does not equal live strategy admission.
  No synthetic result, uploaded PASS text or engineering approval can fulfill
  the user's outstanding D choices or live G/S evidence.
- The old database and old strategy have not been turned into actual records.
  The full production-copy archive/recovery rehearsal now passes; final cutover
  tail differences and independent-host recovery still require separate proof.
- Live capital allocation, benchmark, thresholds, broker access/fees and actual
  opening records are not inferred from the user's approval to develop.

## Production baseline (read-only observation)

Checked on 2026-09-12 local timezone:

- Repository worktree at `/opt/observatory` is clean, release
  `f38d244d7b050a113e34da74d1d79bd466f7ef1b`.
- `observatory-web-1` and `observatory-worker-1` are running; web binds only
  `127.0.0.1:5051`, with the documented HTTPS reverse proxy responding HTTP 200.
- Both containers share the project's `data` mount; worker reads project
  `config` read-only and runs the legacy scheduler.
- Production SQLite `quick_check` returned `ok`; unlike the older local copy,
  it includes ETF, strategy, advice and paper-trading tables. It therefore
  requires full legacy mapping/rehearsal, not the small local-only fixture.
- No production data, configuration, container or repository change was made.
  Later writes were confined to a separate remote validation directory and
  dedicated image tags. The original production container IDs/start times and
  HTTP 200 response remained unchanged after that rehearsal.

## Release completion audit

The per-requirement map is [08 acceptance evidence](08-acceptance-evidence-map.md):
32 engineering cases, 19 accounting requirements, 8 product areas and 10
strategy gates. None is promoted to full acceptance by this aggregate count.
The current checkpoint is not an automatic production release. The confirmed
public boundary is code and generic examples, with personal plans isolated
locally. Inspect the actual Git index before committing; a clean public
worktree alone does not prove that staged content is free of personal data.
Historical checkpoints below record their evidence at the time of each run.
The latest pre-publication audit is recorded in the final section; verify actual
commit/push/CI status against Git and workflow records separately. The manual
deployment workflow remains untriggered.

Before declaring the objective complete, produce an evidence map for each
applicable E/S gate, document any user-approved restricted mode without calling
blocked gates passed, and verify the actual pushed SHA, workflow, running image,
schema, authentication, task/data freshness, ledger reconciliation and backup
restore. CI success and HTTP 200 alone are insufficient.

## v12 dividend/accounting and publication-boundary checkpoint

The 2026-09-12 checkpoint adds cumulative withholding assessment separately
from actual cash deductions/refunds, net-only income and later gross/tax
breakdown, and unresolved/resolved corporate-action facts. NAV, after-tax
performance and attribution have independent point/period evidence. Web
recomputes the evidence and monetary item coverage; late historical knowledge,
future-to-preparation quotes, self-rehashed omitted facts and provisional
periods cannot be used to display final returns. See
[the implementation contract](dividends-and-corporate-actions.md).

- Final Web regression: 281/281; Python: 226/226; root Node suites: 58/58.
  Typecheck, authenticated HTTP, shellcheck and production dependency audit
  also passed (zero reported production vulnerabilities).
- Build `zsylCE98VErz5CO_yavMh`; production-build HTTP 45/45, schema 12,
  `artifacts/verification/workbench-http/2026-09-12T03-07-10-027Z/`.
  All 282 inventoried source files were unchanged during the run and subsequent
  source verification. Manifest SHA-256:
  `f3c2e8693e75440934469a206e92b1ba0d705eff03e72ce6e570cd8d67b4f9df`.
- Migration 0012 SHA-256:
  `72db560f47e10f73f42905d5fc5baa097ae5409fbfc91cf0fddfd92fdaf46575`.
  Upgrade tests preserve existing postings, foreign keys and append-only guards.
- Native browser report: `artifacts/verification/browser-dividends/report.md`.
  The synthetic flow includes committed-but-lost confirmation response with
  identical-body retry, signed payable/refund math, net-only attribution,
  unresolved notice, account-switch preview invalidation and logout.
- Publication boundary is now explicit: public code/generic examples, personal
  plans local only. Original planning documents and the previous index patch
  are preserved under ignored `.private/personal-plan/2026-09-12/`. Public
  planning documents are generic templates; creating a portfolio no longer
  generates any funding plan. Existing local plans are not rewritten.
  The prior staged checkpoint remains untouched; before any commit/push the
  index must be updated deliberately and checked again for personal content.

The full v12 container/recovery/cutover and actual owner/broker acceptance have
not run. Period-quality evaluation still has worst-case O(n^2) work and has not
passed long-history load acceptance. This checkpoint does not certify the full
E/S matrix, real tax treatment, production release or profitability.

## v13 private ETF research directory checkpoint

See [the directory contract](etf-catalog.md). New metadata belongs to the selected
portfolio and cannot change global identity, economic facts or governance
permissions. Partial holdings disclosure produces explicit conservative bounds,
not rescaled full coverage. Comparison binds exact historical versions and dates.
The existing risk calculation now hashes metadata consumed by active buy
reservations even when that listing is absent from current holdings/proposal
items; a regression proves the formerly omitted path changes the risk hash.

- Web 315/315; Python 244/244 (35.086 s); root Node 63/63 (3.855 s).
  Typecheck, authentication HTTP, shellcheck and build passed; production npm
  audit reported zero vulnerabilities. Logs: `artifacts/verification/final-regression/`
  with `catalog-v13` filenames. Early root Node/HTTP attempts used an interpreter
  without `jsonschema`; retained failures are not included in passing totals.
- Build `CVIVVyLIjP7cDu6zR1jU5`; HTTP 50/50 on schema 13, run
  `2026-09-12T12:23:57.265Z` through `2026-09-12T12:24:00.321Z`.
  All 304 inventoried source files unchanged during and after the run.
  Directory: `artifacts/verification/workbench-http/2026-09-12T12-23-57-265Z/`;
  manifest SHA-256 `1c4bb87d80c25bdb6a64dcc655fa924c10a6071f10202cf627b028f0e4373640`.
- Migration 0013 SHA-256:
  `d570a9cc2be57e73555b36a430f7b9a9c70f6d8e017ce7bb5446ad7cf451f9d4`.
- Partial native browser evidence: two entries, one source and an actual committed
  lost response followed by byte-identical retry; catalog revision 3 and ledger
  revision 0. No later profile/holdings versions exist in the preserved fixture.
  Browser runtime loss and a nonresponsive development server prevented remaining
  native comparison/mobile checks. The task-owned fixture was stopped after
  preserving its database and process sample; no successful visual acceptance or
  production behavior is inferred. See `artifacts/verification/browser-catalog/`.
- Privacy review also found the old long-history research fixture still reused
  the personal funding combination. It now uses unrelated synthetic values;
  the old fixture/results are preserved locally, and the public benchmark and
  multi90 baseline were actually rerun, not relabeled as historical measurements.
  The original oracle/short baseline are unchanged. See
  [the updated benchmark evidence](research-index-benchmark.md).

The old staged tree remains untouched. A publication-safe worktree does not make
that old index safe: deliberately refresh and inspect the index before any commit
or push. No push, new production deployment or full P-05/E/S acceptance is claimed.

## v13 public-code pre-publication audit

This section supersedes the earlier pending-index notes, not their historical
test evidence. The existing index was backed up locally before a deliberate
refresh. A second audit read all 365 actual index blobs (3,048,056 bytes), checked
them byte-for-byte against the worktree and compared authorized local planning
originals. No nonignored untracked files or protected data paths remained in
that candidate. The old personal-plan bindings were removed; no real credentials,
personal broker/account identifiers or personal absolute paths were found.
This is a scoped review, not a universal secret-detection guarantee. The generic
publication documentation added afterwards is reviewed separately.

- `.dockerignore` now excludes both root and nested `.private` directories;
  the release regression checks Git and Docker protected-path boundaries.
- Root Node regression: 64/64; `node-publication-v13.log`. The complete npm audit,
  including development dependencies, reported zero vulnerabilities;
  `audit-publication-v13.log`. The application sources remain unchanged from
  the Web 315/315 and Python 244/244 baseline above.
- Fresh build `_IFKKZvXTDE0gEl0OZ8sk`, HTTP 50/50, schema 13, run
  `2026-09-12T12:36:41.073Z` through `2026-09-12T12:36:57.608Z`.
  All 304 inventoried source files were unchanged during and after the run.
  Directory: `artifacts/verification/workbench-http/2026-09-12T12-36-41-073Z/`;
  manifest SHA-256 `bc05b00fe6099f0181117beddc1c5ee21b53fba6d0255ae5439ff0c4dd22e91a`.
- Local Node is 25.7.0; CI and Docker target Node 22. Local results do not replace
  the required Linux/Node 22 tests or current-image container checks.

The candidate is suitable for a public-code checkpoint under
[the privacy boundary](publication-privacy.md). It is not production approval,
full product acceptance or strategy admission. The browser runtime remains
unavailable, so the missing native catalog checks above are still pending.
No production workflow or application cutover was performed by this audit.

### First published checkpoint and CI follow-up

Public-code commit `2c14c62f5fbe84aa26b02c296fa199d8cb71024f` was pushed normally;
the remote main SHA matched. GitHub CI run `34694551968` failed overall, despite
Python 244/244, Web 315/315 and the isolated container smoke passing. The Node
Compose config fixture depended on a missing host env file (63/64), and the
container job could not upload its root-owned synthetic report. The follow-up
isolates the config fixture and hands off only its generated report; production
runtime configuration and personal-data permissions are not relaxed. The original
logs remain local. Check the subsequent exact-SHA CI result before treating these
test-environment corrections as verified; this does not change the outstanding
product, native-browser, recovery or strategy gates.
