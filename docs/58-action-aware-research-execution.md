# Action-aware research execution

## Contract and purpose

`research-plan-v4` adds the explicit frozen execution field
`order_action_policy=defer_known_scheduled_action_before_commit`. It uses the
normal source admission, default core, durable trial/freeze, independent Web
replay, reference rendering, save and observation services. It is not a new
sandbox dispatcher or a change to existing v3 studies.

The engine is `fixed-policy-action-aware-bounded-rebalance-v4`; complete phase
receipts are `research-result-v3`. Existing closed plan contracts still reject
the extra policy. No supplied plan, candidate, failure, profile, trial budget,
exposure, validation or holdout is silently edited/upgraded/restarted.

## Precommit causal check

After the normal target/cost/quantity calculations, but BEFORE publishing any
order or reserving its budget, inspect the tentative batch's scheduled orders.
If a company action for such an order lies strictly after the decision and at
or before its assigned close, AND was known at the decision, defer the entire
batch. Publication time must be at/before the decision; actual-replay mode also
requires ingestion at/before that instant. Later information is never used to
avoid an already frozen failure.

Record `KNOWN_ACTION_BEFORE_SCHEDULED_CLOSE`, the affected listings/sides,
assigned closes and action identities. No tentative order IDs or reservations
are published. Do not consume the calendar slot, new-cash repair trigger or
cooldown. Re-evaluate ONLY at a later decision already present in the frozen
plan, using then-available information and newly computed quantities/bounds.
Do not synthesize extra decision times, replay a failed trial or retry until it
passes. If there is no later eligible decision, incomplete initial deployment
still fails the existing gate.

Deferred reviews have an explicit unresolved lifecycle. A subsequent valid
review records resumption (new orders, targets within tolerance, or the trigger
no longer applying). Missing inputs, cooldown or partial/failed planning do not
erase it. An unresolved review at phase end is an execution failure even if
initial deployment succeeded. Deferral therefore cannot hide an unfulfilled
rebalance behind a zero-failure summary.

This policy covers known actions before a scheduled close, not every possible
future action before a sale-dependent buy eventually activates. A waiting buy
has no assigned close yet; it retains the old strict cancellation semantics.
Unknown-at-decision actions, bounds/cash violations, expiries, settlement gaps
and dependent-sale failures remain counted failures. There is no "ignore
cancellation" option and no relaxation of the selector's zero-gap gate.

Both strategy and same-cost benchmark use the same rule. Delayed deployment
and its cash opportunity cost remain in the complete NAV path. Original-currency
dividends, entitlement/payment timing, splits, fees, settlement and no-margin
constraints are unchanged. No claim is made that the new version improves
returns or passes any real historical study.

## Delivery and outstanding scope

Synthetic vectors must independently match Python and TypeScript full phase
receipts, including events, not just summary statistics. Normal admitted-source
tests must traverse the actual default core/reference/save/monitor/review path
and preserve zero financial/approval writes. Legacy numeric receipts remain
unchanged. Real studies require a separate explicit frozen protocol preserving
all prior exposure; this increment does not automatically run one.

Precommit checking alone is NOT a solution for inputs that establish an action
as known only at its event instant. Such actions still cancel pending v4 orders
and fail, as they should under this contract. An explicit post-event
cancellation/reassessment lifecycle and proof of no unresolved execution gaps
remain necessary before claiming that the real research blocker is repaired.
Do not invent an earlier announcement time or remove recorded failures.

The current continuous funded-history versions do NOT implement this new
policy. They explicitly return
`FUNDED_STUDY_ACTION_AWARE_EXECUTION_NOT_SUPPORTED`, rather than stripping the
policy or pretending old economics apply. A separately versioned continuous
integration remains required by the original v2 objective, as do real-reference,
three-market monitoring/AI, account-level, operational and production acceptance.
