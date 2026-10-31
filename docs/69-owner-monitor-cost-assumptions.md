# Explicit research-monitor cost assumptions

This v2 increment addresses a normal-workflow gap: historical study fees do not
certify current monitoring costs, but an owner should not need to prepare JSON
to state research assumptions. Development/acceptance is still in progress.
This document does not declare the feature released or actual tariffs verified.

## Owner flow and authority

The saved-model view exposes an optional **research-monitor cost assumptions**
panel. First-use numeric fields and the validity choice are empty. The owner
explicitly supplies commission basis points, minimum fee in CNY, FX basis points,
slippage basis points and the maximum change-cost/NAV fraction, then acknowledges
the research-only meaning. Unit explanations are not recommended parameter values.
The owner may explicitly restore costs to unknown. Nothing infers a tariff,
tax treatment, actual cash or permission to trade from these entries.

The ordinary investor command is owner/workspace/revision/idempotency bound and
also binds the exact current model hash and previous cost version. Mutation uses
the authenticated session binding. A stale model/profile/plan, expired model,
changed cost version, read-only/restore barrier or corrupt prior receipt cannot
be bypassed by this panel. A lost response retries the original command, not a
fresh key with a reinterpreted amount. Cost entry does not change the profile,
saved model/control, investment weights, risk budget, strategy or financial facts.

## Receipts, time and independent verification

Migration 49 adds immutable owner cost receipts, plus a controlled table rebuild
to admit `investor-monitor-data-input-v3`. Existing v1/v2 contract files stay
unchanged. Old monitor rows, rowids, hashes and dependent foreign-key references
must survive; late migration/FK failure must roll back the whole transaction.

A receipt records the exact model/profile/plan hashes, version, explicitly
confirmed values, research-only basis and validity. The values have their own
deterministic assumption hash, not a broker-certification label. Effective time
is one millisecond after creation, with monotonic versions: a later declaration
cannot retroactively change an already-created input at the same millisecond.

New monitor inputs bind the exact cost receipt as of their creation. Python and
Node independently verify the full receipt/version prefix, model/owner/audit,
hashes, chronology, values and eligibility. Ordinary bootstrap and later source/
callback admission bind the current declaration. Core can re-admit the same
retained source with new explicit assumptions without a provider request, study
rerun, model reset or trading action. Missing/stale market evidence still blocks
that admission; entering fees never manufactures current quotes or actions.

Cost validity limits the **current projection/review deadline**, not raw-source
retention or the lifetime of every ancestor checkpoint. Old inputs remain
independently replayable with the assumptions that were valid at their original
evaluation. A replacement must not rewrite that history, nor cause an expired old
fee estimate to destroy an otherwise retained checkpoint chain. On expiry, new
inputs explicitly return costs to unknown without automatically renewing the
receipt. Unknown costs cannot justify a cost-qualified adjustment; no-trigger
observation remains governed by the existing deterministic policy.

A newly effective owner declaration also fences an already-prepared monitor job
before commit, even before core has created the replacement source input. This
is checked separately from source/model/implementation changes; it must not
publish an old-cost notification during the pending interval. Independent replay
checks the cost rule at the original publication/checkpoint time, not today's
latest version, so a legitimate older result remains historical evidence.

Changing, expiring or invalidating costs hides the old current adjustment/NAV
until a matching new evaluation is available. A corrupt cost receipt reports an
unavailable cost input rather than promoting the last good fee or overwriting
the broken record. Historical audit and independent reference research remain
separate. Raw projection tampering is still rejected by ordinary replay.

## Interaction and acceptance work

The panel shares the existing immutable-command retry and session boundary.
Fee editing and funding/account editing hold separate scope locks so one panel's
cleanup cannot unlock the other's draft. Background refresh does not replace a
locked draft or silently rebind it to another model/version. Validity is checked
again by the server; expiry cannot be waived by keeping an old form open.

Fictional command/core/Node tests exercise unknown-cost bootstrap, explicit
assumptions, replacement, immutable ancestors, restore/idempotency guards,
explicit clearing and corruption. Component/schema checks are not a substitute
for actual browser form, lost-response and mobile acceptance.

The cost-specific suite additionally exercises an ordinary owner declaration
made before the first monitor input: default core binds it during automatic
bootstrap, without another study, model save or source-policy change. A populated
temporary encrypted archive roundtrip preserves all table rows/rowids, the cost
receipt, v3 input and checkpoints. Node and Python replay the restored evidence;
the restore marker still prevents owner writes and core/provider/verifier work.
The archive and restored directory are removed with the fictional test fixture;
this is not an additional production backup or independent-machine recovery.

An opt-in production-build Chromium journey, `browser_v2_journey.py
--with-monitor-costs`, verifies desktop/mobile form layout, empty first-use
values/validity, native required acknowledgement, cancellation, and a focused
draft across more than one normal polling interval. It discards one actual
committed POST response, verifies byte-identical retry without a new version,
applies the declaration through ordinary core, and explicitly restores unknown
costs. Session invalidation removes the draft while the outer session boundary
keeps protected content hidden. The test does not expose concealed content to
make an error banner visible. Browser clock and HTTP response payloads are not
rewritten; the market evidence and empty account documents remain fictional.

These local checks do not establish actual tariffs, investment validity, current
source completeness or public production readiness. Broader source/monitor/
funding regressions, exact-head CI, protected release and real-source normal/
funding/stale production monitoring remain required. No personal fee parameters,
provider credentials, source data or actual financial facts belong in the public
test corpus.
