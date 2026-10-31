# Explicit continuity for an extended calendar

Status: implementation under development; not production calendar approval,
provider certification, automatic collection permission or complete v2 acceptance.

## Why this is separate from a normal review

An ordinary new calendar review invalidates references to its predecessor. That
remains the default, including when the new review happens to contain the same
dates. A separately expressed owner decision can preserve the old historical
prefix when extending a calendar. It must not rewrite a frozen research source,
retime a prior decision, repeat a study or silently renew a data grant.

The existing private `review-source` input accepts the optional
`continues_calendar_review_id`. It names the exact current predecessor, not an
arbitrary earlier review. The command still requires its existing private file,
owner, source, complete `facts`, explicit decision, reason and expiry. There is
no URL, clock, credential, synthetic or permission override. This belongs to
advanced source operations; initial investor onboarding needs no new JSON.

## Atomic acceptance

Only an approved calendar can continue another approved calendar of the same
source and workspace. Market and range start must match, the new end must be
later, and every original day and timestamp must match exactly. Complete
contiguous-day, close, availability, settlement and known-at checks still apply.
Dropping old dates, changing a prior session, skipping a review, adding unknown
fields or continuing rights/listing/FX/action reviews is rejected.

The new calendar review, its audit and its explicit continuity receipt commit
together. A failure rolls everything back; it does not leave an accidental
superseding head. Migration 51 adds only an initially empty immutable metadata
table and guards. It approves no existing relationship and rewrites no old row,
rowid, capture, input, result, model, financial fact or source permission.

## Historical replay versus new collection

Historical readers return the **original** facts, original identifiers and
original deadlines. Python and independent Node replay the explicit lineage,
hashes, source identity, owner audits, consecutive review versions and exact
prefix equality. The origin and final head must remain valid at the time of
use. Intermediate reviews are historical equality witnesses, checked at their
approval times; each successor must have been approved before its predecessor
expired. This does not revive an expired original capture or input.

New initial-price and confirmed-watch plans use the exact latest reviewed
calendar. An old calendar identifier cannot start or commit a new collection,
even when it remains acceptable for replaying an old receipt. Existing fresh
transport clocks, stop/read-only/restoration controls, leases, one-attempt
requests and final commit fences remain. No provider is called by approval or
by these read paths. Other source reviews and permissions do not inherit
calendar continuity. An ordinary update or withdrawal breaks the old path.

No source qualification or database result is cached across calls. Updating a
calendar is not a licence renewal, a new standing collector, action completeness,
AI-sharing permission, strategy approval or a trade authorization.

## Bounded scope and remaining work

Proof traversal is bounded to 16 explicit links. An approval exceeding that
limit is rejected before replacing a usable head. The existing 3,660-day
calendar limit and every original input/model expiry remain unchanged. This is
not an unbounded ten-year rollover: explicit new starts/finite replay, rolling
calendar windows and later source renewals still need their own complete design
and acceptance. No old calendar is automatically extended or approved here.

Software tests use invented facts and stubbed transports. Real source
installation, complete current monitoring and the full v2 P0/P1/P2 requirements
remain separate. Exact-commit CI, protected deployment, production source
acceptance and capacity/recovery evidence must not be inferred from local tests.
