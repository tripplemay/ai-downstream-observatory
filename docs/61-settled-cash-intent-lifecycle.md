# Sell, settle, decide, then publish: research kernel v6

Status: direct research-kernel integration, NOT ordinary investor admission or
production deployment. Full v2 P0/P1/P2 remains the objective. This increment
does not reopen an old trial, change personal constraints, enable a real protocol
or grant account/trading permission.

## Implemented causal flow

`research-plan-v6` explicitly requires
`buy_funding_policy=declare_sales_then_freeze_buy_from_settled_cash`. Old plan
versions reject that field and keep their original semantics. The ordinary
`research-plan-input` contract still rejects v6 until all downstream contracts,
admission and continuous funding are integrated; no fallback to v5 is allowed.
Persistent experiment registration also rejects v6 before touching a connection;
the direct-kernel contract cannot consume trial budget or expose a holdout.

The actual rotation kernel, rather than a separate simplified simulator, now:

1. Independently evaluates the full current book using the existing policy,
   calendar, raw closes, FX, costs, lot steps and action rules.
2. When buys require a rebalance with sales, publishes only the frozen sell
   orders. It records an immutable buy intent with original sale roots, original
   buy scope and deadline. The policy hash binds parameters, execution, declared
   decision times and window. No buy quantity, cap, budget or reservation exists
   yet, and projected sale receipts are not spendable cash.
3. Follows preserved cancellation/replacement events to the complete current
   sale leaves. Already filled legs and unsettled receivables stay in the book;
   they are never undone. Ordinary failures are terminal. A cancelled sale may
   cease to be needed only through the explicit action-review completion reason,
   not by deleting its dependency or fabricating a cash settlement.
4. Waits for all required actual settlements and an existing later decision.
   It recomputes full NAV and original-scope deficits. Current cash is debited
   for reservations and cash floors; contributions are credited once and keep
   their separate later policy trigger. Neither settlement nor a timer publishes
   a buy between declared decisions.
5. Uses the independently reconstructed leaf projection with preparation v2.
   Empty current sale leaves are allowed only when the kernel has reconstructed
   their explicit resolved action lineage; the arithmetic component alone does
   not authenticate that fact. A raw post-settlement close, or a raw close after
   declaration when no sale remains, is required. Theoretical action carries are
   not fresh executable quotes. Known scheduled actions defer tentative buys.
6. Publishes one new buy batch, with fresh IDs, caps, quantities and budget from
   current settled cash. Each quantity is frozen thereafter. Price, FX, funding
   or expiry failure never causes an implicit smaller retry. Explicit subsequent
   company-action reviews retain original roots and replacement generations;
   their buy-only scope cannot sell or rebalance already completed legs.
7. Records distinct completion, failed and pending intent states. No-longer-
   needed original buy scope is not a claim that every target is within tolerance.
   A phase-ending orphan expires and remains a failed intent even if there are
   no raw order failures. It must block future admission.

At the new preparation boundary, the existing whole-cent cash quantum is applied
explicitly: cash floors round upward and remaining monetary needs downward.
Unrounded NAV/targets/deltas remain in the reassessment event. A positive need
that cannot support the complete lot/fee batch stays blocked; it is not silently
removed or called a completed rebalance. This is a new versioned rule, not a
change to old results, risk budgets, costs or price/FX bounds.

The v6 execution arithmetic uses a local256-digit context; shared ledger and
reported performance rules remain unchanged. Web performance replay copies
amounts into the shared context and explicitly performs the annualization's
end/start division, matching Python rather than loosening comparison tolerances.

## Independent verification

- Python scenario tests cover immutable sale-only declaration, different future
  sale prices, no future decision, terminal frozen-buy failure, fresh-close
  waiting, new contribution, no-longer-needed scope, sale replacement, buy
  replacement and a completed foreign-market leg followed by cancellation of
  only its remaining domestic sibling. One contribution is not a second sale
  receipt; partial fills and review history remain intact.
- Independently written Web economics and cash-intent reconstruction compare
  complete outputs for ten fictional vectors, including every event, cash/stock
  settlement, quantity, curve, intent, review and hash. No metric is copied from
  a claimed result to make replay pass.
- Research discovery211/211, investor/registry/strategy/funding54/54 and related
  Web26/26 passed; type checking and five fixed background bundles also passed.
  The Web set includes
  the old continuous economics, ten-year and three-market cases, v5 lineage,
  normal v5 admission/core/read/save/watch, preparation and the new v6 vectors.
  These are local synthetic checks, not real-source, full-CI or release evidence.

Source: `worker/research/cash_intents.py`, `worker/research/rotation.py`,
`web/src/server/investor/cash-intents.ts`,
`web/src/server/investor/continuous-economics.ts` and preparation v2.
Reproduce with `python -m unittest tests.research.test_cash_intent_runtime` and
`cd web && node --import tsx --test tests/investor-cash-intent-runtime.test.ts`.
Cross-language tests need the repository Python dependencies; all inputs are
fictional. They do not call a provider, AI gateway, broker or production service.

## Required before ordinary use or any new real study

Do not advertise this kernel as the finished investment workflow. Still required:

- Versioned full report and phase summaries, immutable trial registration and
  selector policy. Candidate AND benchmark must have zero failed/pending intents
  in every admitted phase, in addition to existing execution/review gates.
- Source admission, kernel request binding, default core, strict Web/client
  parsing, reference/save/watch/history and expiration with the same new fields.
- The same explicit execution semantics for annual continuous funding and its
  holding baseline, versioned inputs/results and normal funded-history producer.
  Do not remove the funding rule or restart annual capital to run an old path.
- Broader interleavings: repeated sale actions, multiple partly settled sale
  dependencies, three markets under v6, locked-capital releases, extreme-range
  performance and whole-window orphan/fee/minimum-lot cases.
- Exact-source full CI, current ordinary UI and protected production acceptance,
  then a separately frozen real protocol preserving all prior exposure/results.
  No automatic reference adoption, financial write or trade follows a pass.
