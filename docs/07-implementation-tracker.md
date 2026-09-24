# ETF workbench implementation and release tracker

Updated: 2026-09-25. This is a progress record, not an acceptance certificate.

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
| Contracts and new database | Versioned migrations through v21 in the current worktree; immutable facts, scoped foreign keys, shared JSON Schema; append-only funding/security-transit/CSV evidence, session-scoped confirmation attempts, private catalog and identity-review versions, monthly cycle listing-review sequence boundaries, human-reviewed private market references, bounded HTTP/SDK captures, daily collection authorization/slots and controlled verification evidence | Final-release image/recovery rerun, actual cutover tail-difference proof and production release binding |
| Authentication | Sealed sessions, persistent revocation/rate limit, server-side guards, strict Origin; authenticated HTTP and native login/logout checked; initialization/login share UTF-8 password bounds | Production TLS/proxy, operator configuration and real owner login |
| Financial ledger | Exact decimal facts, cash/trades/settlement/dividends/FX/transfers/splits; unknown/estimated/confirmed tax, net-only receipts, cumulative tax assessment and actual withholding kept separate; corporate-action notice/resolution isolation; securities transit and append-only dependent corrections | Real dividend/tax/corporate-action and security-transfer evidence, full acceptance matrix |
| Import and reconciliation | JSON and raw CSV attachment/preview/atomic confirmation; zero-write CSV inspection and visual explicit mapping; immutable mappings and row evidence; explicit duplicate review and persistent source aliases; scoped downloads and encrypted recovery; explicit balance/tax-payable/settled/transit reconciliation and unresolved-fact guards | Domestic/cross-border broker samples, native wizard acceptance, large background imports and full throughput/fault acceptance |
| Accounting and performance | Immutable NAV v4/performance v5; source-owned transit NAV and per-event external-flow FX; independent Python/Web fact-quality proofs for NAV, after-tax performance and attribution, including intermediate-period unresolved states | Actual historical FX/provider and dividend evidence, full attribution/benchmark/history workflows; implementation is not complete acceptance |
| Funding plans | Dated multi-currency sources and tranches, version editing/deferral, partial receipt matching, execution association, cash/reservation separation, over-budget acknowledgement, correction review and full audit history | User-confirmed dated plan, broker evidence, D-05 allocation choices and full execution/funding workflow acceptance |
| ETF research directory | Portfolio-private membership/source/profile/disclosure versions; independent CAS, stable pagination, account-evidence summaries and up-to-four version-bound comparisons; TS/Python exact-decimal overlap bounds; v19 sourced human identity/lifecycle/product-structure/trading-unit reviews with expiry and independent proofs | Issuer/provider originals and actual identity/lifecycle verification, current fees/liquidity/premiums and weighted exposures; full P-05 and native comparison/mobile acceptance |
| Market and orchestration | Immutable paged batches, validate/publish CAS, as-known/restated valuation, leases/fencing/retry/outbox; monthly discovery and fixed Node publisher; ECB reference-FX plus explicit daily collection schedules; LongPort day-price SDK publication bound to private human-reviewed mapping/calendar versions; separate core/provider roles | Actual A/HK/US permissions/data, authoritative exchange references, recurring price collection, full fault/load tests and current-image verification |
| Strategy and AI | Preregistered v1 contribution-only research plus explicit v2 monthly momentum/MA rotation and fixed-rebalance benchmark; exact PIT ranking, simulated sales/settlement/fixed buys, costs and bounded read-only summaries; frozen inputs/implementation and independent research windows | Live providers/models, continuous forward simulation, complete long-history workflow performance and genuine S-gate evidence; v2 does not activate actual schedules |
| Governance and execution | Human version/capability APIs, risk/approval CAS, independent-process cash/share reservation race tests, execution reports separate from facts; private listing-review inputs invalidate old approvals on change/expiry; price reads bind listing identity and exact knowledge time; v21 controlled runner executes one fixed source-bound synthetic cash subcheck with independent Python/TS proof | Full E/S adapters, formal gate evidence and release/runtime binding beyond this subcheck; executable liquidity inputs and complete look-through; actual D/G/S approvals remain absent |
| Product UI | Account, funding, catalog, research, governance, monthly evaluation, private market-reference and listing-review workspaces; typed securities and dividend/tax/corporate-action preview/confirm; visual CSV mapping and server-backed, current-session, read-only confirmation recovery | Native listing-review/market-reference/monthly/wizard/recovery/BFCache and full catalog comparison/positive governance acceptance; complete accessibility and readonly UX |
| Deployment | Manual-only release, encrypted backup/restore, exact-SHA v21 core/provider/verifier CI and local restore; full historical real legacy-copy archive/recovery rehearsal; separate credential-free/network-free verifier wiring; no current production cutover | Final-release image rerun, independent-host restore, protected credentials/configuration, release and post-release checks |

### v21 controlled engineering verification local checkpoint

The [controlled verification runner](controlled-verification.md) now connects a
normal human request, dedicated fenced verifier job, actual synthetic Node ledger
and Python valuation/performance, immutable raw artifact and independent Web
proof. `E-02.cash-contribution-neutrality.v1` never counts as complete E-02 or
G-03/G-04: `gate_eligible=false`, `completed_requirements=[]`. The main portfolio
gets orchestration evidence only, not fixture financial facts.

Frozen-source local regression passed: Python **590/590**, Web **743/743**, Node
**214/214** (including the opt-in fixture lifecycle), with no failures/skips.
Typecheck, production build, authentication HTTP and shellcheck passed; npm audit
reported zero vulnerabilities. Logs use the `verification-v21-hardened` prefix
under `artifacts/verification/final-regression/`. Earlier rounds exposed and
fixed Unicode request rejection, dedup alias replay, cross-language boolean/ID
and container-type confusion, and a test harness that did not wait for actual
WebCrypto completion. Earlier `final`-named logs are superseded, not erased.

Production-build HTTP passed **91/91**, schema 21, build
`ltJVTfkb8Ibq8-2AK22a0`. All 509 inventoried source hashes matched before/after
execution. Manifest: `artifacts/verification/workbench-http/2026-09-24T17-22-03-354Z/manifest.json`,
SHA-256 `26f06913221c130d9dd3d64e49933e0ba7c91679aad81a97b00aa3fec5372cd5`.
Its seven new verification cases use a normal authenticated request, dedicated
verifier CLI and independent HTTP proof/download; no passing job is seeded.
The controlled-runner source manifest contains 200 files, hash
`02b0a5858ba40bb3785297f8029701a88183b56cda64377216ae2e379d6dd562`,
unchanged across final checks. This is not a complete release attestation.

At this pre-publication local checkpoint, native UI was **NOT_RUN**: Tabbit returned `BROWSER_RUNTIME_UNAVAILABLE`;
no restart or backend substitution was attempted. The fixture lifecycle test
proved process/port/temporary-directory cleanup, not browser interaction.
Evidence: `artifacts/verification/browser-verification-v21/`. Local Docker daemon
is unavailable; actual image smoke, exact-commit CI and production acceptance
remain separate pending checks. No current production cutover occurred.

### v21 published CI and one-restart native verification

Commit `6fd08ae73574bfcb9d6971ea8262a39ca85ebb69` passed
[CI 36034497147](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/36034497147).
Both `test` and `containers` completed successfully. Python 590, Web 743,
authentication and full HTTP 91 passed; CI Node had 213 passes and one default
opt-in lifecycle skip (the separate local enabled run above passed 214/214).
All 509 HTTP source hashes matched this exact commit. Original validation and
container ZIPs match their GitHub SHA256 digests. Independent local Python and
TypeScript checks also verified the downloaded original artifact bytes.

The non-root, network-disabled verifier container executed the actual fixed
fixture and independent proof; its 200-file source manifest, bundle and sidecar
matched local evidence. Provider image smoke exercised native import/signature
and rejected invalid input, without credentials, network or a live quote context.
Encrypted local restore passed, but independent-host recovery was not tested.
Evidence: `artifacts/verification/github-ci/36034497147/verification-result.json`;
the adjacent `verify-checkpoint.mjs` rechecks the pinned historical commit.

After explicit permission, Tabbit was restarted once and its native runtime
recovered. A fresh empty schema-21 synthetic fixture then exercised actual UI
portfolio creation, one explicit request, real verifier completion, A-B-A scope
isolation, 390px wrapping, recovery read-only and cross-tab logout. Normal and
read-only private browser-network downloads matched the original 17,678-byte
SQLite BLOB. OS download-manager/save-dialog completion remains unverified:
Tabbit exposes neither download events nor `chrome://downloads` access.
The separately labelled DOM-only long-ID layout test is not a real server-ID
business test. All fixture processes, its temporary directory and port were
cleaned up; only task-created tabs were closed, retaining the user's original
tabs. Evidence: `artifacts/verification/browser-verification-v21/6fd08ae-native-restart1/`.

This frozen native run found a same-value scope-change defect: selecting the
already-selected portfolio cleared the page and retry draft without triggering
a new read. It failed closed and required explicit refresh; it did not create
another job or disclose another scope. That failure is retained, not reported as
PASS. A subsequent fix must have its own regression and native evidence.

The follow-up fixes only the full `(portfolio, requestId)` same-value guard.
Three added callback regressions first reproduced two failures and then passed;
the third preserves both detail-to-list actions. A new native fixture on the
fixed component independently confirmed unchanged GET/POST counts, retained
draft/acknowledgement and verified data on same-value selection, real request
completion, both detail-return paths, A-B-A isolation, read-only and cross-tab
logout. It required no further browser restart and was fully cleaned up.
Evidence: `artifacts/verification/browser-verification-v21/6fd08ae-scope-guard-rerun1/`.
The 503 unresolved-request byte/key preservation case is callback evidence,
not a claimed native network-fault test.

Fixed-source local regression passed Python **590/590**, Web **746/746**,
Node **214/214** with the lifecycle explicitly enabled after native cleanup,
typecheck, production build, auth HTTP, shellcheck and zero-vulnerability audit.
Full production-build HTTP passed **91/91**, build `O39kAIKakMvv1G3N-z0ME`, with
all 509 source hashes unchanged; manifest:
`artifacts/verification/workbench-http/2026-09-24T17-54-10-331Z/manifest.json`.
The component SHA256 is
`cd616026a6b1ce492635a51469a57d6464383f6e1f8909238b7e722dc1390d47`.
The dedicated verifier's source manifest remains unchanged; it does not include
or attest the UI. Local increment evidence is retained under
`artifacts/verification/browser-verification-v21/same-scope-fix/`.
The native increment records **11 PASS / 1 NOT_VERIFIED** (OS download saving).
The published CI above predates this one-line fix and cannot certify it.

Read-only release preflight still found no `VPS_SSH_HOST_KEY` repository secret
and no GitHub environments. No secret values, server access, deployment or
cutover were attempted. The exact-commit CI and narrow native checks do not
complete full P/ACC/E/S, real-data, investment or production acceptance.

The prior published checkpoint is commit
`8448e72c005d93b865fa2c38d42239655863706f`, CI `34735669873` (Python 553, Web 675,
Node 188, HTTP 84, schema 20). Its retained report is
`artifacts/verification/github-ci/34735669873/verification-result.json`, SHA-256
`ce9a8d5364d66f0ea73e1e235e8f5f612cdaa67ee57f202a08fc4279f285fb6f`.
This is historical evidence, not certification of v21 or current production.

### v18 exact-commit CI checkpoint

Commit `0890ff9392a4c599a12307ad0b0da960df801ca4` passed
[CI 34719063590](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/34719063590),
rechecked against the terminal GitHub run in this v19 work round: Python 525,
Web 598, Node 165, HTTP 81, authentication, typecheck/build, shell checks and
dependency audit (zero reported vulnerabilities). Both Linux core/provider
container jobs passed on schema 18; all 446 HTTP-inventoried source hashes matched
that exact commit. The retained local verification result is
`artifacts/verification/github-ci/34719063590/verification-result.json`.

This closes the previously pending v18 synthetic image check, not a production
cutover, real provider validation or independent-host RPO/RTO. These counts and
images do not certify the newer v19 source changes.

### v19 private listing-review implementation

The [identity-review workflow](listing-identity-reviews.md) now connects ordinary
registration/catalog/source APIs to private, expiring human review versions and
independent TS/Python verification. No global metadata is promoted to approval.
Explicit product-structure facts keep leveraged, inverse and unknown products
outside v1 eligibility. Risk fingerprints bind the review, identity, source and
audit proof; an update or expiry invalidates old approval use without changing
ledger facts, positions, reservations or prior valuations. Monthly evaluation
checks both the original known version and its current validity.

Migration 0019 SHA-256:
`6f93b6c94da0fc934ac1c600144824015c7c63ebada82cffc1f0c93010bea552`.
The prior 18 SQL files and manifest prefix are unchanged. Empty upgrade,
scoped source/member keys, exact audit/identity/decimal bindings, append-only
versions and all unique-key replacement guards are covered by migration tests.

An actual SDK-capture code path first reproduced the `PRICE:<listing_id>` lookup
failure. Risk now reads by explicit listing identity, preserves arbitrary legal
source series names and rejects conflicting same-time values. A second review
found mixed UTC precision admitting a future microsecond; exact observation and
publication comparisons now reject it without silently falling back to an older
bar. Missing spread, premium, turnover and volume remain blocked; their lawful
ingestion and real feed coverage are still unfinished, not filled with zeros.

The native Tabbit diagnostic was rerun and again returned
`BROWSER_RUNTIME_UNAVAILABLE`. Callback/HTTP tests are not native browser,
mobile, accessibility or BFCache acceptance. Production and strategy gates remain
open.

Frozen-source local verification: Python **553/553** (95.879 s), Web **657/657**
(26.226 s), root Node **176/176** (6.722 s), with no failures or skipped tests.
Typecheck, production build, authentication HTTP and shellcheck passed; full npm
audit reported zero vulnerabilities. Logs are under
`artifacts/verification/final-regression/` with `listing-v19` names; the `final`
Python/Web/build runs supersede earlier local attempts, not their retained logs.

HTTP **84/84**, schema 19, build `84JnvqtajOFVmJ_on4c97`, ran from
`2026-09-12T22:12:44.065Z` to `2026-09-12T22:14:03.128Z`. All 465 inventoried
source files matched at start, end and subsequent verification. Manifest:
`artifacts/verification/workbench-http/2026-09-12T22-12-44-065Z/manifest.json`,
SHA-256 `743d023d10b08af5229636cdff37bde52bcffcef38029eae3f56b636f3d28e53`.
`HTTP-LR01..03` cover ordinary registration through private review, current
session/identity/CAS enforcement, immutable supersession and read-only recovery;
all use synthetic originals and leave global approvals and financial facts
unchanged. Native browser checks, exact-new-commit Linux CI/container evidence
and the full release gates remain outstanding. This is not a production cutover.

### Published v19 CI and subsequent native review

Commit `2244c7779e7faee0a4ef7cf08fd228ffbcf55c95` was pushed normally and passed
[CI 34733804426](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/34733804426).
Terminal job metadata, full logs and both artifact ZIP digests were verified:
Python 553, Web 657, Node 176 and HTTP 84 passed, alongside typecheck/build,
authentication, shell checks and zero-vulnerability dependency audit. Both
Linux core/provider images passed on schema 19; the non-root monthly publisher
bundle hash is retained in the container report, and all 465 HTTP source hashes matched this
exact commit. Evidence: `artifacts/verification/github-ci/34733804426/verification-result.json`
(SHA-256 `6a28f4582ca12538a9d3b856a07a63b195874f6fe929ec0fd8e77bf23f1e311e`).
This is synthetic same-host engineering verification, not production, actual
provider/account validation or independent-host recovery.

Tabbit subsequently became available. In a separate synthetic schema-19 dev
fixture, actual UI actions published three private review versions, verified
refresh/history, portfolio isolation, suspension/unknown blocking, recovery
read-only and logout/back denial. The baseline was **10 PASS / 1 FAIL**: long
blocking codes overflowed a 390-pixel viewport. An additional long-name fixture
reproduced the same issue with a 200-character name and 40-character code/exchange.
The layout patch wraps rather than truncates content; same-fixture native
retests have page scroll width equal to viewport width at both 390 and 1440,
and the blocked-code paragraph now has equal client/scroll widths. A new
callback regression first failed on the baseline and the focused suite passed
13/13 after the fix; callback tests are not the visual evidence.

The original failure, seven inspected screenshots, exact component hashes and
synthetic database checks are retained in
`artifacts/verification/browser-listing-v19/verification-result.json`
(SHA-256 `7e80c0e399d55b10a8f8369bd3fe164ad9ed7e0bf5d1b862f669c416c4402f34`).
The fixture was stopped cleanly. Its schema-19/UI result does not verify the new
schema-20 migration or a production build. Cross-tab in-flight session races,
keyboard/screen-reader and demonstrated BFCache restoration remain pending.
The published v19 CI predates this layout patch and the cycle-boundary correction;
both require a new source-bound regression and commit.

Read-only GitHub preflight also found no configured `production` Environment
and no repository `VPS_SSH_HOST_KEY` secret. No secret values were read, no
security settings were changed and no production workflow was dispatched.
Protected host configuration, independent-host restore and all remaining
product/investment gates must still be independently satisfied.

### v20 original-cycle listing-review boundary correction

A normal-service, real Python discovery/claim and Node publisher reproduction
found that a review written after cycle creation with exactly the same
`known_at` as `cycle.knowledge_at` could enter first preparation or a fresh retry.
The existing prepare/commit comparison correctly rejected an in-call change,
and existing proposal approvals still failed with `APPROVAL_STALE`; the defect
was loss of the original cycle's review knowledge boundary, not an approval bypass.

Migration 0020 adds immutable review transaction sequences and captures the
portfolio's sequence watermark inside the cycle INSERT transaction. Monthly
selection requires both the original timestamp cutoff and this immutable upper
bound, and independently checks current review validity even when both clocks
are equal. Every preparation, publication recheck and human retry uses the same
cycle boundary. Reviews already present at that exact timestamp remain usable;
later same-timestamp reviews cannot complete or repair the old period's inputs.
Ordinary review queries and execution approval checks keep their existing
semantics. The boundary and proof are part of monthly inputs and risk hashes.

Existing cycles receive an explicit `legacy_missing` marker, not reconstructed
sequence evidence. Their saved history remains readable; a new evaluation of
such a cycle is blocked rather than silently rebaselined. This sequence covers
listing-review membership in a cycle, not every market/account/strategy PIT
requirement or physical ordering within an unobserved clock interval.
Independent review and the frozen-source local regression passed: Python
**553/553** (117.583 s), Web **675/675** (30.532 s), root Node **188/188**
(13.824 s), no failures or skipped tests. These totals include 12 new migration
cases, 12 cycle-boundary cases, five risk-path cases and the layout regression;
they are not additional counts to add again. The risk cases exercise normally
booked/reconciled/valued security transit, ordinary holdings, normally approved
buy reservations and cross-scope/forged boundary DTOs, not only empty portfolios.
Typecheck, production build, authentication HTTP, shellcheck and full npm audit
passed; audit reported zero vulnerabilities.

HTTP **84/84**, schema 20, build `bGn--Ekiglyo7VgG4U0oW`, ran from
`2026-09-13T03:20:05.384Z` through `2026-09-13T03:21:03.028Z`. All 470 inventoried
sources matched at start, end and subsequent verification. Manifest:
`artifacts/verification/workbench-http/2026-09-13T03-20-05-384Z/manifest.json`,
SHA-256 `260027271abeebeec9b0d6fb2d2b7bbfd40f8bbdfe863bc5870a72855c198858`.
Migration 0020 SHA-256 is
`a143cf7a6578b3329d8800cf927bf55729edcc78d9cd4085e30ee16e9d4c0d3d`;
logs use `listing-boundary-v20` under `artifacts/verification/final-regression/`.

A fresh schema-20 native dev fixture additionally passed **5/5** scoped checks:
UI review publication, exact history after reload, 390-pixel layout and logout/
back isolation. SQLite confirmed the automatic review sequence and no ledger
events. Evidence: `artifacts/verification/browser-listing-v20/verification-result.json`,
SHA-256 `5e31e4ed9e063300f238e727f3f908c4300fc131e1499d7df0559b941a99a5bf`.
The fixture stopped cleanly. This native smoke has no evaluation cycles and
does not certify cycle logic, BFCache, keyboard/screen-reader, actual providers
or production-build equivalence. The v20 exact-commit CI/images, full release
and investment gates still need their own evidence; no production cutover ran.

Latest published checkpoint before the v15 monthly work is commit
`1b06926ac0d9f98a016d6e690be4a73e6a572f2e`; its
[GitHub CI run](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/34700180829)
passed Web 438, Python 244, root Node 81, HTTP 63, build/typecheck/authentication,
dependency audit and Linux container migration/non-root/local encrypted recovery
checks. It was a public code checkpoint, not a production deployment or an
independent-host recovery. The v15 monthly changes require a new source-bound run;
the older counts do not certify them.

Local v15 release candidate (2026-09-12): Web 498/498, Python 284/284 after
correcting a synthetic queue-order assumption, root Node 95/95; typecheck,
production build, authentication HTTP and shell checks passed. HTTP 67/67 uses
schema 15/build `YppVpXF8n7Vgh5sOLLvJI`, with all 366 inventoried sources unchanged.
The monthly workspace and fixed Python-to-Node publisher are implemented;
the real bundle subprocess is tested, but the new Linux runtime image and
exact-commit CI must still be verified. Native Tabbit runtime is unavailable.
See [the monthly checkpoint](monthly-evaluations.md) for evidence and limits.
These are synthetic engineering results, not production or strategy approval.

Historical visual CSV checkpoint (local stable-source validation, schema v13):

- Web 371/371, Python 244/244, root Node 73/73; typecheck, production build,
  authentication HTTP, shellcheck and dependency audit passed (zero reported
  vulnerabilities).
- Production-build HTTP 57/57, build `4XqxSRMTtJj6a_l4Pj0c-`; evidence in
  `artifacts/verification/workbench-http/2026-09-12T13-52-56-430Z/`.
  All 320 source hashes matched before/after and subsequent verification.
- Inspector checks have no attachment, mapping, batch, audit, fact or revision
  writes, including recovery mode. Real service tests cover exact full-value
  pagination, explicit fee/tax, sealed invalid versions, human duplicate review
  and original-byte-to-receipt traceability.
- Remaining wizard gates: native desktop/mobile/accessibility and fault
  interaction; same-document browser history navigation can lose an in-memory
  pending request without the normal link/unload prompt. The UI states this
  limitation; persistence across forced navigation is not claimed.
- Legacy accounting/HTTP/funding fixtures were rebased to unrelated synthetic
  cash values and rerun. Historical local reports remain intact; changing current
  source does not withdraw already-published history or CI artifacts.
- Logs: `web-csv-wizard-private-safe.log`, `python-csv-wizard-private-safe.log`,
  `node-csv-wizard-final.log`, `http-csv-wizard-final.log` under
  `artifacts/verification/final-regression/`. Actual new commit/push/CI results
  remain bound to Git and its workflow, not inferred from this local run.

### v14 confirmation recovery checkpoint

- Append-only exact confirmation attempts are saved in an independent transaction
  before the original CSV confirmation engine runs. Current-session list/detail
  recovery only reads; it does not auto-POST, approve rows or create ledger facts.
  Actual receipt validation distinguishes a successful batch from a failed or
  different review attempt. Browser storage contains no complete request.
- The session boundary hides SSR, pagehide and hidden-tab content before probing
  again; all protected Radix portals are kept inside that subtree. CSV writes
  carry an optional session binding checked before body parsing, and upload
  revalidates the session after reading the body. This is not a substitute for
  Cookie authentication or Origin validation.
- Local frozen-source validation: Web 438/438, Python 244/244, root Node 81/81;
  typecheck, build, authentication HTTP, shellcheck and dependency audit passed
  with zero reported vulnerabilities. Production-build HTTP 63/63 passed on
  schema 14, build `3fnrZ4DRzdltM29QC7Z8V`.
- Evidence: `artifacts/verification/workbench-http/2026-09-12T14-40-42-218Z/`;
  all 340 source hashes matched before, after and on subsequent verification.
  Manifest SHA-256:
  `c10b1f76475525d7ef839824d20f5158ac0f36662a87877cffd928e001c72628`.
- The first HTTP run exposed Next.js merging `Vary` fields; the assertion now
  requires the `Cookie` token instead of incorrectly forbidding framework tokens.
  A fresh build and clean fixture then passed all 63 cases. The failed artifact
  is retained; no execution or security assertion was removed.
- Actual React callback tests caught early scope unlocking during a pending
  recovered-confirmation refresh. The fix retains the lock until refresh ends
  and ignores late failure after session invalidation. Those tests and Portal
  SSR/wrapper tests are not native browser or BFCache acceptance.
- Native wizard/recovery/Portal verification is still outstanding because the
  Tabbit runtime is unavailable and restart approval is pending. Real broker
  formats, background large imports, full product/strategy gates, independent-host
  restore and production release remain outstanding. This is a code checkpoint,
  not deployment or profitability acceptance.

## Reproducible checks

### Daily collection schedules worktree (v18)

[Daily ECB collection](market-collection-schedules.md) adds explicit human save,
enable and pause controls, immutable authorization history and globally unique
scope/date slots. Saving is paused; no portfolio receives a default schedule.
Missed windows are recorded without downloading historical daily feeds. Current
windows take priority over bounded historical bookkeeping within each scan.

Execution rechecks the frozen authorization before/after download, before
publication and at successful job finalization. Pause/resume does not revive old
requests. A final deadline failure rolls back the capture and publication;
completed historical evidence remains valid after later pause. Publication CAS
is never automatically rebased. Neither discovery nor collection creates
financial facts, valuations, advice or orders. LongPort recurrence is not added.

Migration 0018 preserves old migrations and data. Definitions, controls and
slots are independently checked by Python and Web. The history budget is 1024
controls, with revision 1024 reserved for an enabled-to-paused transition;
exhaustion requires maintenance, not implicit renewal. Same-status new commands
also close the previous authorization. Deduplication includes the submitted CAS;
only the original command returns its old receipt. An exact trigger-time enable
is valid; one microsecond later cannot authorize that missed trigger.

Final local validation passed Python 525/525, Web 598/598 and root Node 165/165,
with no failures/skips. Typecheck, production build, authentication HTTP, shell
checks and dependency audit passed (zero reported vulnerabilities). The schema 18
production build `BoaC-frR1nw0aU3kBfgp3` passed HTTP 81/81, including a real UTC
trigger, a loopback HTTP pause during synthetic download, zero partial publication
and valid historical proof after pause/resume. All 446 inventoried sources matched
start/end and subsequent current-file verification. Evidence:
`artifacts/verification/workbench-http/2026-09-12T21-02-02-761Z/manifest.json`,
SHA-256 `fcf2571d1e48d8c256982ad38461aeddcb0024b10a633c8f01a669de86bc208d`.
Migration 0018 SHA-256:
`60315ed2e47d5b89c787cd179317148900a4405f380ca4fb1ffd91aecf14ed62`.

Review first reproduced a system actor masquerading as a human schedule audit.
SQL and both independent readers now reject it, strict audit fields and string
semantics align, and a full 1024-control fixture tests the last-pause boundary.
The first full HTTP run correctly rejected CAS 0 as malformed (400), rather than
the fixture's expected conflict (409). The corrected test separately asserts
invalid zero and valid-but-mismatched CAS; that failed artifact remains intact.
Final logs use `collection-v18-*-final*.log` and `collection-v18-http-second.log`
under `artifacts/verification/final-regression/`.

Native Tabbit diagnosis again returned `BROWSER_RUNTIME_UNAVAILABLE`, exit 69;
there was no restart or native UI acceptance. The new commit still requires its
own exact-SHA CI and images. Neither local synthetic results nor the preceding
v17 CI certify actual data, independent-host recovery, production or investment
gates. Full original scope remains unchanged.

### Subsequent exact-SHA v17 CI verification

Commit `edcb3ea07384f32091d4f76fd452c83c2d6f53e1` passed
[CI 34716214716](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/34716214716):
Python 488, Web 559, root Node 148 and HTTP 77, plus typecheck/build/authentication,
shell checks and dependency audit (zero reported vulnerabilities). Both Linux
core and optional provider images passed schema 17/native-runtime checks; core
encrypted recovery was same-host isolation, not independent-host RPO/RTO proof.
The provider report binds the actual LongPort 4.3.7 extension and records no
credentials, network or quote context. It does not verify real market access.

All 427 HTTP source hashes matched start/end and the exact commit blobs. Original
artifact ZIP sizes/hashes and reports were checked; evidence is retained in
`artifacts/verification/github-ci/34716214716/`. Verification-result SHA-256:
`a792639f3115c276aff97e5c1069d2cc74d2361eaae9407a4f04311ee74b0dbe`.
The earlier failed runs below remain failed historical records. No production
workflow or cutover was performed. New v18 changes require their own checks.

### Price collection worktree (v17)

The next implementation is [reviewed market references and price collection](market-price-collection.md).
Migration 0017 adds private JSON sources, append-only reviewed mapping/calendar
versions and per-scope CAS heads, plus `market_sdk_captures`. The existing v16 ECB
capture table and historical bytes are retained. Review is explicitly
`human_reviewed_not_provider_verified`, not listing/account or investment approval.

An explicit `market_collect_prices` task binds 1–4 listings in one portfolio and
market over at most 31 calendar days to current reviewed references. SDK Decimal
projections, actual receipt times, exact date coverage, hashes and worker origin
are verified before atomic publication. Provider timestamps are not relabeled as
close/publication instants; unknown publication time remains unknown. Current
reference updates invalidate current use, while frozen-knowledge history retains
its original replay boundary. Python and Web independently verify the evidence.
The binding checks catalog market/exchange/currency and provider-symbol format;
it does not verify ETF asset class, provider ticker identity or lifecycle.

The optional Trixie/CPython 3.11 image pins LongPort 4.3.7 wheel hashes and has a
dedicated credential file and role. Core workers neither install the SDK nor take
price jobs. The provider role requires a lease of at least 180 seconds (default
300), shares a database-wide price mutex and uses a 30-second parent/child hard
deadline. Its optional Compose profile is not in the base production cutover.

Targeted local checks, not a final source-wide release result:

- `node --test tests/migrations/*.test.mjs`: 69/69, including 11 new v17 checks;
  v16 table values/BLOB bytes, zero new actual facts, repeat migration no-write,
  human audit/scope/CAS, append-only replacement guards and ECB/SDK separation.
- `tests/deployment/provider-container.test.mjs`: 8/8; static image/hash rules,
  actual isolated Compose config, CLI preflight-before-database, role/mutex and
  kernel-deadline subprocesses, and complete native-report rejection checks.
  The embedded eight Python role/deadline tests are not eight additional
  independent full-suite tests.
- `tests/deployment/release.test.mjs`: 17/17 after the exact credential-basename
  ignore rules and date-neutral documentation correction. Git exclusions are
  exercised in a temporary repository; Docker recursive rules are checked in
  source, not claimed as a local container build.

Frozen-source local regression (2026-09-13): Python 488/488, Web 559/559 and root
Node 127/127 passed with no skipped cases. Typecheck, production build,
authentication HTTP, shellcheck and dependency checks passed; npm audit reported
zero vulnerabilities. Core-only Python had no LongPort module or distribution
before or after testing. The rebuilt monthly publisher hash is
`21f70cc76e506dcdd7b57f6265ce6858e76f1b5d4df18252661bad8ebdca1248`.

Full HTTP passed 77/77 on schema 17, build `xen1hgaLxyanVXxYT9nph`. The five new
price cases exercise real authenticated source/review commands, exact inert
downloads, pre-write rejection, a dedicated Python worker publishing one
two-listing synthetic capture, independent Web verification, failure preserving
the old head and reference-update/current-versus-historical behavior. Evidence:
`artifacts/verification/workbench-http/2026-09-12T19-25-41-402Z/`, manifest hash
`ad9b146d6343fae4875e5223a3f36c589f12f2a037e2b15fc4c63d31ffddd713`.
All 425 source hashes matched before, after and subsequent current-file checking.
Logs use `artifacts/verification/final-regression/provider-v17-*-final2.log`.
Earlier failed fixture runs remain retained; no behavioral guard was relaxed to
make them pass. The shared ID contract remains unchanged and rejects slashes.

Ten controlled React callback tests cover session/generation invalidation,
hash-await races, exact-byte retry/CAS, navigation warnings and private parser
error concealment. Pending requests are page-memory-only, not durable recovery;
forced navigation can still lose them. Native Tabbit diagnosis returned
`BROWSER_RUNTIME_UNAVAILABLE` (exit 69); no browser restart or native UI acceptance
is claimed. Exact-SHA Linux core/provider images, actual permissions/data and
authoritative calendars, recurrence, independent-host recovery and production
remain separate acceptance work. All new test inputs are synthetic; private
credentials and real capture evidence must not enter CI-uploaded paths.

### Subsequent v17 CI and native-report correction

Public commit `1bb5b76bb1dabbf9de880b5247868186a4b42897`, tree
`ea88451bc07f50db1e5ba0ae7e09792d8f117d77`, ran
[CI 34714360107](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/34714360107).
The test job and core schema-17 non-root migration/recovery smoke passed, but the
run failed in the optional provider report. Its image built and loaded the real
SDK; the report then incorrectly assumed that the fileless PyO3 `openapi`
submodule had `__file__`. The provider JSON is zero bytes, not a passing report.
The full run log and both artifacts remain under
`artifacts/verification/github-ci/34714360107/`; no production cutover occurred.

The narrow correction hashes `longport.longport`, requiring the loaded
`openapi` object's identity, an `ExtensionFileLoader`, and identical resolved
`__file__`/`__spec__.origin` paths. It does not relax the native-report gate or
change application code. A core-only regression extracts the actual helper and
rejects broken identity, non-native loader and mismatched origin. The helper also
passed against the actual local SDK without constructing a quote context or
using credentials/network; this is not Linux image acceptance.

After this test-only correction, root Node passed 128/128, shellcheck passed,
and HTTP passed 77/77 using the unchanged production build. The new manifest is
`artifacts/verification/workbench-http/2026-09-12T19-44-28-183Z/manifest.json`,
SHA-256 `05833f18f1520d873191bbf0080a0367993c3d70b2cff138ba8b438ecd604e4b`;
425 source hashes remained unchanged. Logs use `provider-v17-native-fix-*.log`.
The previous full Python/Web results retain their original source boundary;
the corrected commit still requires its own complete CI and Linux image result.

### V17 image proof and streaming HTTP diagnosis

The correction commit `7fcf136ae4ad894a3b07a479e1be446140ce0687` ran
[CI 34715193188](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/34715193188).
Both core and optional provider container checks passed. The real provider
report binds the native SDK binary and adapter to this source, CPython 3.11 and
glibc 2.41; it explicitly records no credentials, no network and no quote context.
This proves native runtime compatibility, not subscription or real price access.
Python 488, Web 559 and root Node 128 passed. HTTP stopped after 46 passes at
`HTTP-INS03` with `fetch failed`; dependency audit was not run. The overall CI
therefore failed. All 425 HTTP inventory entries matched the exact Git blobs.
The original artifact ZIPs, API metadata, logs and independent checks remain in
`artifacts/verification/github-ci/34715193188/`.

The original error omitted both request phase and network cause. A synthetic
Node 22 experiment reproduced `EPIPE` with an early 413 while uploading the old
85-chunk request, but also reproduced transport failures without a completed
server response. This does not establish the original CI's exact cause. Its
script and result are retained in
`artifacts/verification/http-transport-diagnostic/`.

The three transport-limit probes now use Node's HTTP parser with a chunked
request, no declared length, explicit keep-alive and exactly limit-plus-one
payload bytes, without ending the request. Only a complete 413, exact JSON error
and server-directed connection close pass. Reset, truncated body, wrong response
or deadline expiry still fail; there is no retry. Other JSON requests now retain
safe transport/phase/error-code diagnostics. Application size limits and reader
cancellation are unchanged. This test change requires fresh regression and CI;
no production or investment gate is upgraded by the earlier image result.

The final local transport candidate passed root Node 148/148 and HTTP 77/77
without rebuilding unchanged application code. Twenty dedicated loopback
transport tests passed on Node 25.7.0 and 22.22.0, including duplicate/escaped
JSON key rejection added after independent review; the latter is not the exact
CI Node version. The final HTTP manifest is
`artifacts/verification/workbench-http/2026-09-12T20-07-03-623Z/manifest.json`,
SHA-256 `32b77e6ac139e18324d9459b20a79ca64438ba54628bc427d1a106314c6137d0`.
All 427 source hashes matched before, after and current-file verification. Logs
use `provider-v17-http-stream-final-{node,http}.log`; earlier candidate logs
remain distinct. This is local test evidence, not a replacement for new CI.

### Provider collection worktree (v16)

Historical v16 implementation and local results follow; they are not v17 results.

The current worktree adds [provider collection](market-provider-collection.md):
fixed ECB HTTPS capture, immutable original BLOB and worker receipts, versioned
publication, authenticated queueing, independent Python/Web source checks and
knowledge-time binding. Existing v1 manual batch and flow/performance v2/v5
contracts are unchanged; provider evidence has distinct versioned contracts.
The LongPort SDK projection adapter and isolated runtime are implemented, but
shared projection/calendar publication and real entitlement validation remain.

Real public ECB daily/90-day downloads completed the capture-to-publication-to-
Python/Web-verifier path in a separate local database with no accounts, cash or
approvals. Originals stay private and are not CI fixtures. This does not complete
real price coverage, strategy gates, recurring collection or deployment. The
older v15 CI checkpoints do not certify this new worktree; final v16 evidence
must be bound separately.

Local frozen-source regression (2026-09-13): Python 443/443, Web 524/524 and
root Node 107/107 passed. Typecheck, production build, authentication HTTP,
shellcheck and Python dependency consistency passed; npm audit reported zero
vulnerabilities. Full production-build HTTP passed 72/72 on schema 16, build
`Oq5FSZA1E4o249IJA397b`, including three new synthetic collection cases.
Evidence: `artifacts/verification/workbench-http/2026-09-12T18-09-03-125Z/`;
manifest SHA-256
`cc12894b40800045a95ccd3f84b5dbf4a02a66107601c970970e3ffd737518f1`.
Source hashes did not change during HTTP execution. Logs are under
`artifacts/verification/final-regression/provider-v16-*`; the earlier failed
Web fixture run remains preserved and is superseded by the final 524-case run.
Native Tabbit diagnosis again returned `BROWSER_RUNTIME_UNAVAILABLE`; these
results are not native UI acceptance. New exact-commit Linux CI and production
release are not inferred from this local checkpoint.

Pre-commit image review found that the optional LongPort SDK's CPython 3.11 Linux
wheel requires a newer glibc than the current Bookworm image. It was split into
`requirements-market-longport.txt`, with binary-only installation; the current
core runtime does not install this unconnected SDK. The above local run precedes
that dependency-only split. A fresh core-only Python 3.11 environment, confirmed
to contain no LongPort package before or after testing, passed all 443 cases and
`pip check`. After the split, HTTP again passed 72/72 with all 396 source hashes
matching before, after and current files; it reused the same production build.
Evidence: `artifacts/verification/workbench-http/2026-09-12T18-17-46-040Z/`,
manifest SHA-256
`0ec8037e6748f2ca0db011befb8a6b531f15242a67294f037cdb0028d90ac12d`.
Exact-commit Linux CI still needs to bind the resulting commit.

#### Subsequent exact-SHA v16 CI verification

Public commit `926dc4ce4912b7cd8768d315a398d43d8ed51fc0`, tree
`9d45a68699d007b76f60e562fc7322c034ed71ad`, completed
[CI 34710911980](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/34710911980)
successfully. Its core Linux images passed non-root migration to schema 16,
legacy isolation, local encrypted restore with pending review/session revocation,
duplicate-restore rejection and API 401. The fixed publisher actually loaded
Node v22.23.2/native SQLite as UID 10001, rejected a bad lease without changing the
database and produced bundle SHA-256
`480544f1ad346e5e0c9b698eb6c66c2a5f59788b047c4d5d23d4f5cc8458f17e`,
matching the local bundle. All 16 migration checksums matched that commit.

The report and complete log are retained under
`artifacts/verification/github-ci/34710911980/`; container run
`20260912T182101Z-2244`. That image installed core dependencies including
truststore, not optional LongPort. Its 29 LongPort tests used synthetic SDKs and
isolated subprocesses; they did not prove a Linux native SDK import or real quote
permission. `independent_host_restore=false`; no production cutover occurred.
This subsequent result supersedes the v16 pending-CI statement, not the older
local measurements, and does not certify the new v17 worktree.

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

### Published v15 checkpoint and next research work

Commit `251e36e8f5f9508d5e6d27ebc56c6a0c3e5e1dc3` passed exact-commit
[CI 34704293626](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/34704293626):
Web 498, Python 284, root Node 95 and HTTP 67, build/typecheck/authentication,
audit and Linux non-root migration/local encrypted restore. The worker's actual
Node 22/native SQLite publisher bundle matched the local hash. This supersedes
the earlier pending-v15-CI note, not the pending production/independent-host gates.
No production deployment occurred.

The next worktree slice adds [versioned monthly rotation research](rotation-research.md):
PIT gross-total-return momentum/MA ranking, fixed monthly slots, sell/buy orders,
explicit settlement and a same-engine fixed-rebalance benchmark. Original v1
contribution-only report hashes remain regression oracles. It is not an actual
schedule method or continuous forward simulation.

- Local frozen-source validation: Web 513/513, Python 358/358, root Node 96/96;
  typecheck, production build, authentication HTTP and shellcheck passed;
  full npm audit reported zero vulnerabilities.
- Fresh-build HTTP 69/69, schema 15, build `Acaofnbv1hbjSYFc-1Mn7`;
  `artifacts/verification/workbench-http/2026-09-12T16-51-33-968Z/`.
  All 378 inventoried sources matched before/after and on subsequent verification.
  Manifest SHA-256:
  `1dc9b7b5a2aef16565c793268153a4b432f917aa9b0ba928d01bc0c342e2213b`.
- New authenticated network cases run v2 through real Python and verify simulated
  buying/selling/settlement and summaries while 18 actual-state tables remain
  unchanged. The first HTTP attempt incorrectly expected exit 0 for an intentionally
  failed worker job; the corrected test requires the CLI's explicit exit 2 and
  still verifies the failed job/attempt/error. Original failure evidence remains.
- Logs use `rotation-v2` names under `artifacts/verification/final-regression/`;
  final Python and HTTP logs are `rotation-v2-final-python.log` and
  `rotation-v2-final-http.log`. No new native-browser acceptance is claimed.

This local candidate still requires its actual public index review, exact-commit
CI and image evidence. It is not production deployment or full E/S acceptance.
Real providers, continuous forward records, complete performance/fault acceptance,
trusted verification, native UI and independent-host recovery remain outstanding.

The v2 code checkpoint was published as
`d6ac32ba330ab80b57b40dcbafdbfc84837086e1` after inspecting all 442 actual index
blobs (4,046,650 bytes); no protected paths, private-plan bindings or real
credentials were found. Its [CI run 34706708278](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/34706708278)
failed overall: Python 358 and the isolated container job passed, but Web was
512/513. One existing monthly-workspace test injected response 4 before the real
asynchronous hashing step had produced that request. The later Node/build/HTTP
and audit steps did not execute. The follow-up must wait for actual request/hash
completion without weakening receipt validation; no successful rerun or production
release is inferred from the passing local checkpoint or container job.

The follow-up changes only that test harness and evidence documentation, not
application behavior. An explicitly held real hashing promise reproduces the
old `request 4` failure. Tests now observe request/hash completion; incorrect
hash and version still reject the receipt, retain exact pending bytes and clear
confirmation without another POST. Local Web 514/514, typecheck and a fresh
build/HTTP 69/69 passed. Build `sEkIoKGmHirFndk_aAYTy`, schema 15, all 378
before/end/current source hashes match; evidence is
`artifacts/verification/workbench-http/2026-09-12T17-06-35-118Z/`, manifest
SHA-256 `d3a65f80d902076b8e97c88a23759f07e0584d9c764ff92f3c2e9ef9769dd186`.
Logs use `rotation-v2-ci-followup` under the final-regression directory. These
are local follow-up results, not a claim that the next exact-commit CI passed.

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

Follow-up CI `34695004802` at `8780daef8e39884c75b0284cee5d73db8432d997`
verified container migration/recovery/HTTP and report upload. Its Node suite was
71/72: Compose v2 omits `false` from normalized bind JSON, unlike the local CLI.
The next correction checks explicit source guards and adds an actual Linux
existing-path/missing-path container pair; it does not allow automatic host-path
creation. These failed aggregate runs are retained, not relabeled as CI success.
The official Compose 2.38.2 Darwin binary reproduced both omitted false fields
and flattened env-file metadata. The corrected fixture passes all 14 release
tests on that binary and local Compose 5.1.1, using only a synthetic marker.
Required/raw env-file guards remain explicit in source, and production config
validation remains quiet rather than printing potentially resolved secrets.
The Linux missing-source behavior still requires the new container CI run.
