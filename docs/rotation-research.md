# ETF monthly rotation research

Status: development, research only. This adds a versioned ranking and sell/buy
simulation engine; it does not approve a strategy, activate actual monthly
schedules, send broker orders or certify forward observation.

## Version boundary

- `research-plan-v1` / `research-dataset-v1` retain the original contribution-only
  fixed-weight engine. Existing frozen reports and their financial result hashes
  are not relabeled as rotation results.
- `research-plan-v2` requires `research-dataset-v2`, explicit settlement evidence,
  and versioned rotation or fixed-rebalance candidates. Its benchmark must be an
  explicit fixed-rebalance candidate using the same v2 execution engine.
- Candidate parameters, costs, tolerance, capital and dates must be supplied and
  preregistered. No personal plan, numeric portfolio default or strategy approval
  is inferred from the new schemas. Existing MOM20/MA200/top-three terminology
  describes an unapproved legacy candidate, not a mandatory or optimal setting.
- Training, validation and holdout still restart independently. `actual_replay`
  means replay with ingestion-time constraints, not a decision actually formed
  in real time. Continuous frozen forward simulation remains separate work.

## Explicit signal definition

The rotation parameter version is `research-rotation-parameters-v1`:

```text
universe: unique listing IDs in the frozen dataset
momentum_sessions: integer 1..252
moving_average_sessions: integer 2..500
top_n: integer 1..100
target_fraction: Decimal string, 0 < value <= 1
signal_basis: gross_total_return_index
ranking_currency: listing_currency
weighting: equal_top_n_slots
eligibility: strictly_above_moving_average
momentum_floor: null or Decimal string >= -1
rebalance: first_decision_each_month
tie_break: listing_id_ascending
insufficient_history: ineligible
missing_data: block
tolerance: { absolute_cny: nonnegative Decimal, weight: Decimal 0..1 }
```

Signal history contains the exact required market sessions, not merely the last
available observations. Each bar selects the revision visible at that decision;
later revisions cannot change an earlier decision. An omitted required bar,
ambiguous revision, unavailable closing observation or unknown left-side history
coverage blocks ranking. An inactive listing is ineligible; a genuinely newly
listed instrument with insufficient history is ineligible, not a fictitious
full-history asset. These rules do not prove the historical universe is complete.

For each interval between two closes, begin with one share and zero gross cash.
Apply known corporate actions in timestamp order; at the same instant apply
splits before dividends, with ID as the deterministic tie-break. A split changes
share units; a dividend adds gross cash using units at that action, not a later
split-adjusted quantity. The interval factor is:

```text
(ending_units * current_unadjusted_close + accumulated_gross_cash)
/ previous_unadjusted_close
```

Chaining those factors forms the gross-total-return index, reinvested at each
period close solely for signal comparison. Momentum is `TR[-1] / TR[-1-N] - 1`;
the moving average includes the latest `M` index points. Eligibility requires
the latest index to be strictly above that average and, when a floor is supplied,
momentum strictly above the floor. Ranking uses exact rational comparisons;
decimal evidence is rounded explicitly, never an epsilon-based tie rule.

Eligible assets sort by decreasing momentum and then ascending listing ID.
Each selected slot has weight `target_fraction / top_n`; unused slots remain
cash. They are not redistributed to the surviving candidates. No eligible
asset is a valid all-cash target; missing evidence is a blocked result instead.
The signal index is not used as an execution price or added again to NAV.

The alternative `research-fixed-rebalance-parameters-v1` requires explicit
weights, the same monthly rule and tolerance. It is distinct from v1's
contribution-only fixed allocation and is the preregistered v2 benchmark.

## Periods, orders and settlement

Only the first declared decision in each evaluation-timezone calendar month
uses its monthly slot. It records `proposed`, `unchanged` or `blocked`; later
decision times in that month are monitoring records, not another opportunity to
rank and rebalance. A blocked month is not silently retried using newer data.
In particular, an unchanged first decision does not permit next-day rotation.

Targets use whole simulated portfolio NAV in CNY. Positions, settled cash,
unsettled stock, sale receivables and dividend receivables all remain in NAV.
Signed target gaps compare against `max(absolute_cny, NAV * weight_tolerance)`.
Out-of-tolerance dust, missing execution opportunities, unavailable cash and
pending activity do not become `unchanged`. Partial order plans disclose their
unresolved issues rather than hiding an incomplete target behind a success flag.

Quantities and maximum buy budgets are fixed using information at the decision.
Fills use a strictly later tradable session's actual unadjusted closing quote;
a later price increase cannot resize quantities with hindsight. The old holding
earns returns until its sale; the new holding cannot earn its selection-day move.
All orders expire at the next local month boundary or phase end, whichever is
earlier; equality with the expiry instant is too late to execute.

Dataset v2 adds one settlement record for every declared market session:

```text
{ market, session_date, settled_at, published_at, source_evidence }
```

The map must be complete, unique and matched to the trading calendar. Settlement
cannot precede the close; its publication cannot be later than that close.
`actual_replay` additionally requires calendar `ingested_at` no later than the
close. There is no guessed business-day offset or universal T+N default.

- Bought shares enter ownership/NAV at fill, but cannot be sold before their
  explicit stock settlement.
- The declared research model converts sale proceeds to CNY at fill, including
  explicit FX costs. They remain CNY receivables until cash settlement, not
  spendable cash and not a foreign-currency balance revalued with later FX.
- A buy dependent on sales waits for actual simulated cash settlement before
  reserving its original budget and selecting a strictly later close. Projected
  sale proceeds cannot finance a same-close or pre-settlement purchase.
- Insufficient realized proceeds, excessive fill cost or failed dependencies
  produce explicit skipped orders. No quantity is silently recomputed.
- Splits adjust ownership, unsettled stock and pending order quantities; a
  transformed order that violates the trading unit is not filled as a fractional
  lot. Unsupported residual rights require explicit handling, not invented sales.

This is an explicit research execution assumption, not a claim about any user's
broker, settlement rules, FX facility, fees or tax situation. Those require their
own verified evidence before investment admission.

## Corporate actions, cash and performance

The simulation records split ownership, gross dividend entitlement, supplied
withholding and net dividend payment. Foreign dividends remain in their original
currency; they are not automatically converted or spent. Signals use gross
total return, while portfolio NAV uses actual simulated shares and after-tax
cash/receivables, preventing dividend double counting.

If an action occurs before the next close, the previous unadjusted quote cannot
simply be multiplied by already-adjusted shares. For that interval the engine
derives a theoretical ex-action carry mark: divide by split ratios and subtract
gross per-share dividends in action order. The record retains the raw quote ID,
action IDs, raw/derived values and the explicit theoretical mark label. A
nonpositive derived mark blocks calculation. It is not an observed market quote;
fills still require a real next-close observation. Missing required new-session
prices cannot be replaced with this carry calculation.

Contributions enter on their specified arrival dates, issue portfolio units at
pre-flow NAV and are included identically in strategy and benchmark. Idle cash,
fees, FX costs, settlement receivables and execution failures remain in results.
Reports retain cash-flow profit, TWR, ACT/365 XIRR, observed unit-NAV drawdown,
recovery, cash ratios and both buy/sell turnover with the named denominator.
No contribution or internal sale is labeled investment profit.
Signed cash rounding is recorded separately from commission, FX and slippage:
a positive value is a cost and a negative value a gain. It is not silently
discarded from the cash reconciliation.

## Entry points and evidence

Use the existing research command flow: register experiment and frozen dataset,
register a preregistered candidate trial, run its ID, then explicitly freeze and
unseal through the existing human controls. Shared Ajv/Python contracts reject
version mixing. Parameter semantics and complete calendars are checked by the
worker; a structurally accepted request can still terminate as a failed job.
New engine and signal sources participate in the implementation manifest; code
changes require a newly registered trial rather than changing an old run.

The research page reads a bounded summary, not every stored curve/event. It
shows the original candidate parameters, plan and engine versions, simulated
capital/contributions/NAV/profit, costs, cash ratio, turnover, execution failures
and monthly outcome counts. Missing older metrics remain unavailable, not zero;
a proposed plan is not a fill or approval. This is not a real-account dashboard
or a continuous forward-performance record.

Signal evidence retains selected observation/action IDs, window bounds and a
hash of the complete selected vector, rather than repeating every derived point
in each monthly report. Frozen inputs and formula versions permit replay. Exact
rational arithmetic has explicit size guards; excessive intermediate values
block with `ROTATION_NUMERIC_EVIDENCE_LIMIT`, not a float approximation.
The schema's cardinality bounds do not guarantee every combination fits an
entry point: the HTTP request limit remains 5 MiB and each CLI JSON input
32 MiB. Large multi-month end-to-end resource acceptance remains outstanding;
an in-memory ranking benchmark does not include validation, simulation or DB
publication and cannot certify that workflow.

- Implementation: `worker/research/{rotation,rotation_signals}.py`;
  dispatch and validation: `backtest.py`, `snapshot.py`, `registry.py`.
- Tests: `tests/research/test_rotation*.py`, `tests/research/contracts.test.mjs`,
  `web/tests/rotation-research.test.ts` and the unchanged v1 report/oracle tests.
- Native interface, complete long-history performance, real exchange calendars,
  actual data licensing/history, continuous forward records and S-01 through
  S-10 are not certified by synthetic regression tests. Gates remain unpassed;
  backtest returns do not grant live eligibility or promise future returns.

The local frozen-source checkpoint passed Web 513, Python 358, Node 96 and
fresh-build HTTP 69 cases. The HTTP manifest binds 378 source files to schema 15
and build `Acaofnbv1hbjSYFc-1Mn7`; see the exact paths, failed-first-run correction
and remaining gates in [the tracker](07-implementation-tracker.md) and
[acceptance map](08-acceptance-evidence-map.md#15-月度轮动研究v2-本地候选证据).
Actual commit/CI/image publication must be verified separately. These counts
do not certify all strategy requirements or production readiness.
