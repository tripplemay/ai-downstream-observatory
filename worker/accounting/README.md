# Pure accounting domain

Implements the computation boundaries in `docs/04-data-and-accounting.md`.
Python 3.9+ standard library only; no database, network, broker, AI, or global
Decimal context mutation. All runtime financial arithmetic uses a local
60-digit, half-even Decimal context. Financial JSON values remain strings.

## Public contract

Import APIs from `worker.accounting`. Invalid inputs raise `AccountingError`;
valid inputs with insufficient evidence return explicit unavailable states.

| API | Inputs and output |
| --- | --- |
| `fact_decimal(value)` | Strict string/Decimal/integer fact boundary; maximum 38 digits and 18 fractional digits; floats, booleans, exponent strings and nonfinite values rejected. Source-format parsing belongs upstream. |
| `canonical(value)`, `quantize_cash(value, quantum)` | JSON decimal string and explicit half-even quantum rounding. Intermediate calculations are not quantized. |
| `buy(Position, quantity, principal, fee)` | New `TradeEffect` containing position, payable and expense. Principal is the broker-confirmed amount, not silently recomputed from a displayed price. |
| `sell(Position, quantity, principal, fee)` | New position, net receivable, expense and gross realized profit using moving-average management cost. Unknown historical cost stays `None`. |
| `settle_buy/sell(CurrencyBalance, amount)` | Change only settled cash and matching payable/receivable; never recognize positions or fees twice. Actual negative cash is retained, not hidden. |
| `split`, `unrealized`, `pay_dividend` | Cost-preserving ratio adjustment, management unrealized PNL and receipt-to-cash conversion. |
| `available_cash(balance, holds, reservations)` | Conservative spendable cash, not NAV. Caller deduplicates broker holds/reservations and enforces atomic reservations. |
| `nav_cny(balances, positions, fx, quality, issues)` | `ValuationResult(nav_cny, known_partial_cny, quality, issues)`; only `complete` gets a portfolio total. Non-CNY FX is never assumed. Aggregate account balances by currency and positions by listing before calling; duplicate listings are rejected. |
| `cashflow_profit(nav, opening, external_flows)` | Positive portfolio contributions, negative withdrawals; returns NAV minus opening minus net funding. Caller must exclude internal trades, transfers and dividends. |
| `exact_twr(start_at, end_at, opening, closing, ValuedFlow[])` | `ReturnResult(value, method, status, assumptions)`, with `method=exact_twr`; each flow needs its pre-flow valuation. UTC-aware datetimes, strictly increasing flow times, aggregate simultaneous flows first; zero-asset restarts are not linked. |
| `modified_dietz(..., TimedFlow[], evaluation_timezone)` | Same result shape with `method=modified_dietz_estimate`; date-only flows require explicit evaluation timezone and produce `date_only_eod_assumption`. |
| `chain_returns(ReturnResult[])` | Every member must represent contiguous, nonoverlapping periods checked by the orchestration layer. One estimated member makes the entire chain estimated; missing periods cannot be bridged. |
| `xirr(DatedCashflow[])` | `XirrResult(rate, status, roots, residual, duration_days, reason, algorithm)`; amounts use investor signs and include the terminal valuation. Pass dates already converted to the evaluation timezone, never datetime objects. |
| `xnpv(rate, DatedCashflow[])` | Recomputable ACT/365 residual. Rate must be strictly greater than -1. |
| `drawdown(NavPoint[], estimated=False)` | Flow-neutral unit NAV only; returns worst drawdown, peak/trough/recovery timestamps and quality. Missing intervals do not invent lows/recovery and prevent a complete-series MDD. |
| `annualized_unit_return(start_nav, end_nav, days)` | Unit NAV only, actual-day annualization, with short-period label. Never feed total assets across cash flows. |
| `fx_return_decomposition(local_return, fx_return)` | Local, FX, cross and CNY returns; the cross term is retained. |
| `amount_attribution(nav, opening, flows, components)` | Signed CNY components plus explicit unexplained residual, never an invented balancing cash event. |
| `eligible_at(DataTimes, decision_at, mode)` | Distinguishes `actual_replay`, archived `historical_point_in_time` and `reconstructed`; late ingestion blocks actual replay. |
| `valuation_quality(PriceRequirement[], cutoff, missing_fx, mode)` | Each listing's expected latest completed session comes from a validated external calendar. Unknown calendar/rules/price/FX blocks; stale or incomplete actions are provisional. Only complete actual-mode data is decision eligible. |

`nav_cny` and the performance methods do not verify source provenance themselves.
The orchestrator must pass the quality result plus a frozen ledger/market version
and persist those input manifests with each published calculation.

## XIRR diagnostic policy

ACT/365 follows the [Microsoft XIRR formula](https://support.microsoft.com/en-us/excel/functions/xirr-function).
Same-day cash flows are aggregated without mutating originals. A single sign
change allows bracketed unique-root solving. For unconventional schedules,
positive scaling and exponential-polynomial derivative isolation partition the
domain into monotone intervals, checking extrema as well as sign crossings.
Tail-dominance inequalities establish finite global search bounds. Multiple or
nearly tangent roots return `ambiguous`, never an arbitrarily selected rate.
More than 32 nonzero unconventional dated terms return `ambiguous` with
`root_isolation_budget`; finite precision, insufficient tail bounds or failed
residual verification also fail closed. They are not silently classified as
`no_root`. A valid, proved zero return may be `ok`; unavailable states use `None`.

Precise TWR and labeled Modified Dietz follow the distinctions in the
[GIPS handbook calculation discussion](https://www.gipsstandards.org/standards/gips-standards-for-firms/gips-standards-handbook-for-firms/).
These method references are not a claim of GIPS compliance or investment merit.

## Verification

```sh
python3 -m unittest discover -s tests/accounting -v
```

`tests/accounting/golden.json` is language-neutral, synthetic fixture data.
Its 13 cases cover F-02 through F-11, F-13, F-14 and F-16 from the approved
accounting specification. Further tests cover precision, same-day flows, ACT/365
leap years, reference irregular XIRR, multiple/no/tangent roots, cost gaps,
cash-flow resets, timezones, stale data and fixed-seed trade/settlement invariants.

These tests verify pure computations, not persistence, import idempotency,
authorization, concurrent reserves, production recovery or strategy validity.
F-01, F-12 and F-15 require integration evidence outside this module. Tests that
construct balance snapshots do not substitute for event-ledger replay tests.
