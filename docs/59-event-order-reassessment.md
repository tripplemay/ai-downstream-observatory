# Event-driven order reassessment: versioned research contract

Status: implementation specification, not real-study acceptance or trading
authority. Preserve all existing versions and already exposed windows.

`research-plan-v5` explicitly selects
`order_action_policy=defer_known_else_cancel_batch_and_reassess`. The phase
engine is `fixed-policy-event-review-rebalance-v5`. Continuous funding must use
the same lifecycle, not a stripped older execution object.

## Causal lifecycle

1. Keep the v4 known-action precommit check. Never use a future publication or
   ingestion time to avoid an order that was already frozen.
2. If a new action affects an outstanding order, cancel the entire still-open
   batch. Preserve every published order's original quantity, bounds and budget,
   every cancellation and its cause. Already filled positions, costs and sale
   receivables remain real within the research model; do not roll them back.
3. Release only an actually reserved unspent budget. Removal of the reservation
   is NOT an incoming cashflow and must not add cash again. Waiting-for-sale
   orders had no settled-cash reservation to refund.
4. A linked review may run only at an already declared future decision instant,
   after settlement and a newly available raw close at/after the affected action.
   Do not schedule extra attempts or reuse theoretical pre-action carry as a
   fresh quote. Retain the original no-sales cash-repair constraint. Any scoped
   cooldown exception applies only to this cancelled intent.
   Reassess only the cancelled, still-unfilled listing scope; do not silently
   rebalance already completed legs. Full portfolio prices/NAV/targets remain
   the sizing basis. An original no-sales repair remains no-sales, and newer
   funding/calendar triggers are preserved for ordinary later evaluation.
   New funding must not turn an originally sale-enabled cancelled rebalance
   into a partial cash-only buy and then call the whole intent resolved.
   Conversely an originally no-sales repair can never gain sale permission.
5. A complete new proposal gets NEW order IDs, new then-known bounds/quantities,
   and explicit predecessor links. Do not resize an old published order. Partial
   planning or missing input cannot close a review. A fresh review can explicitly
   conclude that targets are already within the frozen tolerance.
   A no-sales buy repair which is no longer needed has its own completion
   reason; it is not labelled as all targets having returned within tolerance.
6. Otherwise close a review only when all replacement orders filled (sales must
   settle before dependent buys). A further action can create a linked new
   generation. Bounds/cash/FX/settlement/expiry failures are terminal, NOT a
   reason to retry the failed order with a smaller quantity or looser bounds.

## Evidence and admission

Keep `execution_failure_count` as the raw skipped/expired/deployment-failed
event count, including action cancellations. Add separate raw/resolved action
cancellation counts, terminal gap count and unresolved review count. Only
fully reconstructed resolved action cancellations may be excluded from the
terminal count; all other failures remain terminal. An unresolved review at the
window end must block admission. Preserve full review/order/action lineage.

This requires a separately versioned, explicitly selected research-admission
policy/result: zero terminal gaps AND zero unresolved reviews, not an alteration
of the old selector's zero raw-failure rule. Display both raw cancellations and
terminal gaps. Independent Web economics must reproduce every field and event;
resealed claimed success or replacement metadata alone is never proof.

The explicit pair is `investor-strategy-policy-v2` with
`execution_admission=causal_review_zero_terminal_gaps`, and
`investor-strategy-result-v2` / `investor-diversified-reference-v2`.
Only `research-plan-v5` can select it. Old plans keep policy/result v1 and
their zero-raw-failure gate. The new `investor-phase-summary-v2` retains the
original metrics plus both strategy and benchmark review counts and lineage
hashes. Source admission, request/run engine binding, durable trial receipts,
the training-only freeze, reference rendering and independent Web replay all
consume this same version; neither a missing tag nor a stripped policy is an
upgrade path.

For annual funding, `investor-funded-history-input-v3` maps to
`investor-long-horizon-input-v4` / plan v4. The corresponding result contracts
are funded-history v3 and long-horizon v4. Candidate and holding comparison use
the same causal review lifecycle, continuous units, original cash releases,
costs, settlement and fixed buy bounds. The phase source builder preserves the
execution policy rather than falling back to v1/v2. The intermediate v4
precommit-only phase plan remains explicitly unsupported by continuous funding.

The investor view shows raw skipped/cancelled events alongside terminal gaps,
action cancellations, resolved cancellations and unresolved reviews. Both
server and client verify the same new count equations; path analysis must not
reject a resolved cancellation as a legacy raw failure, or hide unresolved gaps
behind a claimed success label. None of these read-model additions updates old
immutable results or enables actual execution.

No risk budget, candidate weights, costs, caps, phase windows or trial budgets
are chosen by this change. A new real protocol must preserve earlier exposure
and failures, freeze this new admission rule before evaluation, and retain
reconstructed/unseen limitations. No old failed trial or unopened holdout is
automatically replayed. No account fact, approval or broker order is written.
