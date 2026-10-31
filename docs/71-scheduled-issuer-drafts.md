# Scheduled issuer drafts

This increment supplies the persistent scheduler/lease step missing from the
[private issuer staging layer](65-private-issuer-capture-storage.md). It does not
certify current distributions/splits, admit financial data or complete v2.
Only the existing fixed Vanguard distribution endpoint is supported; this is
not a three-market corporate-action service.

## Two separate owner decisions, both required

The existing issuer authority continues to govern the fixed fund/query identity,
private uses, retention and permission interval. It does not become a standing
schedule merely because an application upgrade adds scheduling support.

A separate immutable schedule policy binds that authority's ID and exact hash,
lookback days, New York run-after hour, and a validity interval wholly inside the
parent permission. The owner must explicitly acknowledge standing collection of
**unapproved drafts only**, with automatic retry forbidden. There are no default
policy values, arbitrary URLs, credentials, trading grants or financial approval.
Registration creates a disabled control; activation is a separate owner action.
The parent must also be enabled. At most one active schedule per workspace/fund
is allowed, including alternative query flags or parent declarations.

Controls append versions, never rewrite a policy or reset a day's budget. Pausing
the schedule stops future collection; retention and reading already collected
raw data remain governed by the parent permission. Withdrawing that parent keeps
its existing invalidation/purge behavior. Scheduling never extends retention.

## Shared daily budget and fenced transport

After the declared hour on each America/New_York date, discovery may atomically
create the ordinary issuer request plus its scheduled binding. It selects ex
dates from the explicit lookback through that local date. This is an unapproved
query window, not proof that the issuer supplied every event in the window.
Manual and scheduled attempts share the **same workspace/fund/local-date unique
constraint**. New schedules, flags, keys and authorities cannot reset it.
No missed-day catch-up or automatic replay of uncertain attempts is introduced.

New York calendar dates, not fixed 24-hour offsets, determine the next midnight;
DST repeated/skipped hours cannot create a second daily request. Requests expire
at that midnight or the schedule's expiry. A complete 31-second transport margin
is required before starting. Short leases or imminent expiry skip transport.
Near-term confirmed-close watches reserve the provider queue ahead of this work.

The provider role uses one-attempt jobs with a fencing token. The request is
durable before I/O; no database write transaction is held across the isolated
fixed-host HTTPS call. Owner/parent/schedule/control/expiry, lease, stop, read-only
and restore gates are checked before transport and at commit. Returned bytes are
discarded on withdrawal or midnight expiry. Lost lease, process failure, stop or
restore may leave an **indeterminate** request, not permission to retry it.
A later local day is a new standing-rule slot, not a replay of the old request.

Raw payload, ordinary capture receipt, scheduled result and job completion share
one atomic fenced transaction. A late audit failure or stop rolls back all new
capture/payload/result rows while preserving the earlier durable request. An
explicit scheduled-result reader verifies owner/audits, policy/control prefixes,
request hashes, ordinary capture, job/attempt outcome, fence and chronology.
It exposes metadata/status only, not raw responses, rates or private clauses.

Wall-clock metadata uses the existing millisecond publication policy. Precise
job/transport clocks are compared as instants, not lexicographic strings; source
dates and receipt timestamps are not rounded. No price deadline is relaxed to
make issuer scheduling work alongside the other provider jobs.

## Storage and operations

Migration 50 appends four metadata tables. It does not modify old issuer tables,
rows, rowids, contracts, models, research trials, policies or financial facts.
The existing workspace/SHA-256 payload table still deduplicates exact raw bytes;
scheduled receipts reference it rather than making another raw archive. Existing
bounded logical retention and the single-local-backup policy are unchanged.
Daily bounds and dedup are not a measured ten-year storage or recovery result.

This is an **advanced private operator** interface, not a new JSON prerequisite
for the ordinary ETF user. Use the existing owner-only database and an owner-only
policy file outside the checkout, following the strict schedule contract:

```sh
python -m worker.investor.data_pipeline --db /private/workbench.db --workspace WORKSPACE --actor OWNER register-issuer-schedule --file /private/issuer-schedule.json
python -m worker.investor.data_pipeline --db /private/workbench.db --workspace WORKSPACE --actor OWNER control-issuer-schedule --schedule SCHEDULE --enable
python -m worker.investor.data_pipeline --db /private/workbench.db --workspace WORKSPACE --actor OWNER inspect-issuer-scheduled-request --request REQUEST
```

Disable uses the same control command with `--disable`. Re-registering an
identical policy reports its actual current control state; it does not silently
disable, enable or renew it. There is no fetch/retry/clock/test/endpoint override.
Only the provider role consumes these jobs; core/verifier cannot collect them.

## Acceptance still required

Fictional tests cover ordinary provider dispatch, disabled registration, private
CLI scope, shared manual/scheduled budget, two connections, DST, short leases,
transport failure, unknown attempts, withdrawal during/after transport, midnight,
stop/restore and late rollback. Populated v49 upgrade preserves old raw bytes and
rows; a temporary encrypted roundtrip preserves new job fences and unknown state
while restored runtime remains locked. Temporary copies are removed with their
fixtures; no production archive or independent-machine recovery is claimed.

Every captured draft remains `owner_reviewed=false`, `research_admitted=false`,
`corporate_actions_complete=false` and `live_advice_eligible=false`. Identity,
currency, per-unit/tax basis and complete distribution/split coverage still need
qualified evidence. No current source review, reference, model observation,
account cash, order or AI explanation is created by this scheduler.

Exact-head CI, protected code deployment, actual standing-source authorization
and installation, financial source qualification, real normal/funding/stale
homepage journeys and all remaining v2 P0/P1/P2 gates remain separate work. The
implementation or its local tests do not enable any production source.
