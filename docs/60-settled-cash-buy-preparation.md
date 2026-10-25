# Sell, settle, then freeze a new buy: preparation boundary

Status: preparation component and integration specification, NOT a new admitted
research engine or a production cash-funding fix. No existing research-plan
version invokes this component. Old contracts, recorded trials and failures keep
their original meaning. Full v2 P0/P1/P2 delivery remains required.

## Reproduced boundary, not permission to erase failures

The fictional regression changes only a sale's future execution price. All
published v5 orders stay byte-identical. With a declared buy budget of300 and
a frozen worst-case buy cost of295.8, the sale can leave297.4 of settled cash.
The OLD contract still rejects that buy because its declared reservation is300.
A larger fictional sale decline leaves287, which cannot fund even the worst-case
cost. Neither case proves the old fill gate is wrong; neither authorizes
shrinking an already published order, relaxing a bound or deleting a failure.

The design problem is earlier: future sale proceeds are uncertain when the
dependent buy quantity and full budget are frozen. Subtracting a hidden safety
factor chosen from a failed history would not remove this dependency. A new
execution protocol must instead represent the buy as an uncommitted intent
until the necessary sale proceeds have actually settled.

These numbers and securities are fictional arithmetic fixtures, not a personal
portfolio, provider quote, real-study replay or recommendation.

## Implemented preparation component

`worker/research/settled_funding.py` and independently written
`web/src/server/investor/settled-funding.ts` prepare one new batch from a closed
internal document. They do not read a database, fetch quotes, publish orders,
change cash, register a trial or grant source/strategy/account approval.

- A previously declared intent identifies its policy, sale dependencies, buy
  scope and deadline. Only an already declared future decision instant may run.
- Every sale dependency must belong to that intent and be settled, not merely
  filled. Unknown, omitted, failed, expired or unsettled dependencies block.
  A prior published buy for the same intent blocks this preparation even if it
  failed. Existing order IDs cannot be reused for a smaller new quantity.
- Current cash is a snapshot AT the decision instant. Available CNY is settled
  cash minus existing reservations and the cash floor. The component never adds
  sale receipts again and rejects an extra projected-sale-proceeds field.
- Each buy needs an observed raw close at/after the last sale settlement and
  available by the decision. A theoretical ex-action carry is not a fresh close.
  Foreign FX keeps its stated availability and age checks; CNY uses the explicit
  unit reference and does not require a fabricated FX observation.
- Remaining buy needs are inputs from the eventual independent full-book
  reassessment, NOT a replacement for its NAV, target or ownership verification.
  Only current available cash is allocated, pro rata and down to whole cents.
  Fresh quantities use the unchanged price/FX buffers, lot step, slippage,
  commissions, minimum fee and upward-cent cash cost.
- Scope is complete or blocked: a below-minimum member never silently disappears
  from a supposedly successful complete batch. No partial result is published.
- Output carries new IDs, input/cash/policy bindings, exact quantities/caps/costs
  and `published=false`, `live_advice_eligible=false`. This is an arithmetic
  preparation receipt, NOT proof that supplied book/source facts are authentic.

The finite arithmetic boundary uses38 significant input digits/18 fraction
digits,60-digit shared decimal arithmetic, at most20 buy targets/100 current sale
dependencies/10000 book rows/30000 declared instants, and a sizing search bound
of10^30 lot units. Range overflow blocks; it does not change a user's policy.

Tests include independent integer-rational cost/ceiling/maximal-lot checks,
cross-language complete receipts, exact FX age/microsecond boundaries, no
double-credit, scope/ID reuse, old/future/carry prices, expired intents, existing
failed buys, partial minimum-lot rejection and unchanged inputs on failure.
This is not the ordinary producer or a complete simulation/production acceptance.

## Required whole-flow integration before any new real protocol

1. Add an explicit new plan/execution version. When sales are necessary, publish
   only those sell orders and an immutable, uncommitted buy intent. Do not create
   a buy order, quantity, cap or cash reservation from projected sale proceeds.
   Cash-only/no-sales repairs retain their original permission.
2. Track intent state and complete order/action/settlement lineage. A partially
   filled batch retains filled legs and receivables; it is not rolled back.
   Company-action cancellation/replacement of a sale must be independently
   reconstructed before deriving current settled dependency leaves. Do not feed
   this component a hand-edited subset that hides a cancelled or failed sale.
3. At an existing later decision, independently recompute full NAV/targets and
   the original unfilled buy scope from current qualified inputs. Prepare new
   buy orders only from settled cash. New funding and locked/unreleased capital
   retain their own triggers and ownership; no projected contribution is cash.
4. Freeze this buy batch ONCE. Fill price/FX/cash/expiry failure remains terminal,
   not an excuse to call this preparation again with fewer units. A later
   company action uses explicit linked order review, not an unregistered reset
   of the same funding intent or rebalancing already completed legs.
5. Keep unresolved funding intents separate from resolved action cancellations.
   A window-ending pending/failed intent blocks admission even if all cancelled
   orders happen to have replacement metadata. Define and verify no-buy/minimum-
   lot resolution before integration; never label residual target gaps as all
   weights having returned within tolerance.
6. Add versioned full-result, phase-summary, policy/selector and durable registry
   support, plus independent Web replay and visible raw/resolved/final/pending
   state. Preserve every old numeric receipt and exposed window. Update annual
   continuous funding, source admission, request binding, reference/save/watch,
   replay/history and current-display expiry in the SAME version; no stripping
   the new funding rule to run an older annual path.
7. Verify sale-only cancellation, partial fills/settlements, fresh-close wait,
   new contributions during either stage, cash floors/other reservations,
   repeated actions, unknown fees, failed frozen buys, no later decision and
   phase-end orphan intent cases from a clean synthetic baseline. Passing one
   preparation function cannot satisfy these cases.
8. Only after complete ordinary integration, exact-source CI, current native UI
   and protected deployment acceptance may a separately preregistered real
   protocol be considered. Keep original weights/risk/costs/bounds/windows/trial
   budgets and prior exposure; do not rerun a failed study or claim independent
   unseen history. A reference still requires the user's manual save/choice.

Current plan schemas deliberately reject a `research-plan-v6` tag or an injected
funding flag. This document does not enable either by itself. No new provider,
AI-sharing, account or trading authority is introduced.

## Current-user explanation, separate from economic semantics

The investor display now maps a current, fully bound failed research task onto
the otherwise generic historical-reconstruction gap. A confirmed-risk user is
shown the actual train/later-phase blockage and a link to research checks, not
an instruction to confirm the same risk answer again. Profile/version/input,
completed phase/freeze, source validity, model/plan absence and server gaps are
checked before this display-only mapping. Expiry/revocation wins. Original
observations remain visible in history and are never rewritten; no outcome is
promoted and navigation never submits a new research or financial command.
