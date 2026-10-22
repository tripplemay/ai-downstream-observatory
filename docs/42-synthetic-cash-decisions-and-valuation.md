# Synthetic cash-only decisions and cash-flow-adjusted valuation

## Status

This adds a separate `bounded-cash-projection-sandbox-v1` component on top of
documents 40 and 41. It is disconnected from production worker registration,
the investor kernel, the live ledger, HTTP/API, UI, market providers and AI.
It accepts only `synthetic_test_only` documents and never authorizes trading.
The previous buy and journal implementations remain byte-identical.

Files:

- Contract: `contracts/v1/bounded-cash-projection.schema.json`.
- Python: `worker/execution_sandbox/projection.py`.
- Independent TypeScript: `web/src/server/execution-sandbox/projection.ts`.

## Program and explicit modelled funding

`declare_program` / `declareProgram` binds an existing journal declaration to
an explicit sorted universe, positive quantity steps, integer target weights,
cash weight, drift threshold and up to 120 dated contributions. Asset and cash
weights must total 10,000 bps. Duplicate identities and unsorted schedules fail.
No personal plan, allocation recommendation or default market parameters exist.

`funding_commands` / `fundingCommands` produces deterministic synthetic commands;
it does not post them or verify actual receipt of money. Decisions value only
cash already recorded in the journal. Recorded contributions must be an exact
prefix of the declared schedule; future scheduled cash is not buying power.
Journal append rules still enforce unique identities, monotonic time and due
batch processing. A previously used generated decision ID cannot create a new
batch under the same program.

The program hash binds content and compatible source, not an independent
registration date. `registered_at` is a logical synthetic timestamp inherited
from the journal. `parameters_independently_preregistered` stays false. A changed
program has a different identity, not proof it was chosen before seeing data.
Programs, decisions and valuation inputs must be retained alongside the journal;
the existing journal SQLite store does not persist or enforce programs itself.

## Deterministic cash-only underweight repair

`decide_cash` / `decideCash` fully replays the journal and checks quantity steps,
funding and a complete sorted price frame. Marks must be positive, known by the
decision, not stale under the frozen quote-age policy and not expired. Quote IDs
cannot be duplicated within a frame. Unaccounted corporate actions fail closed.
The explicit execution/expiry window must be in the future; there is no exchange
calendar or automatic scheduling assumption.

For each target asset:

```text
NAV = settled cash + marked holdings
cash floor = ceil_cent(NAV * cash_target_bps / 10000)
deployable = max(0, free cash - cash floor)
underweight = max(0, NAV * asset_weight_bps / 10000 - marked asset value)
eligible = underweight, only if underweight / NAV meets the drift threshold
budget = floor_cent(eligible * min(1, deployable / sum(eligible)))
```

The implementation multiplies before division to avoid intermediate ratio
rounding at a cent boundary. Rounding dust stays cash, never moves to another
asset or a frozen order. The previous buy primitive freezes whole-step quantity,
price cap, fees and full allocated-budget reservation. Below-minimum plans remain
explicitly below minimum; there is no hindsight resizing or fee-free assumption.

Pending batches cause a wait, not a second plan. Overweight holdings are not sold.
This is contribution/cash-only underweight repair, **not full rebalancing**.
Targets, tolerance, contribution timing and price buffer are input assumptions,
not selected or optimized using any real validation window.

## Terminal-processing NAV and performance

`value_journal` / `valueJournal` requires a causal price frame at every journal
event, exactly at the event time, and a final frame at or after the last event.
Before/after a contribution, the same prices value both sides of the cash flow.
Quote IDs cannot change content within the report. Missing, future, stale,
expired or unsupported corporate-action evidence is rejected rather than filled.
No implicit forward-filled daily history or missing execution is manufactured.

Reserved cash remains part of settled cash and NAV; it is not subtracted again.
Pending simulated purchases stay cash until the terminal journal event. Only
resolved simulated fills become positions, and all execution failures survive.

Unitization starts at unit NAV 1 when the first recorded capital arrives. At a
later contribution, new units equal contribution / pre-flow unit NAV. Holdings
and fees affect unit NAV; contributed capital does not count as investment
return. Return is end unit NAV minus 1; profit is end NAV minus contributions.
These can disagree when money arrives after market movements. With no capital,
unit NAV, return and drawdown are null, with `no_contributed_capital` status.

Drawdown samples both pre-event and post-event unit NAV and the final mark. It is
only a **sampled drawdown**, not a complete daily/intraday maximum. Derived ratios
and displayed units round half-even to 12 decimal places; internal computation
uses an isolated 160-digit context. Raw cash and marked values are not rounded
into fake receipts. No CAGR, XIRR, alpha or risk-adjusted performance is claimed.

`valuation_basis` is fixed to `terminal_processing_not_execution_settlement`.
The journal posts fills at batch-terminal processing, not the earlier execution
proxy or actual exchange settlement. This is not an execution-time backtest.
Valuation can account for any journal satisfying the universe/step/funding
constraints; it does not prove every past order came from this generator.
`allocation_policy_compliance_verified` therefore remains false.

## Reference and verification limits

The only reference is `same_flow_cash_zero_interest_zero_cost`: identical
recorded contributions left as non-interest-bearing cash. It exposes the
money-versus-contributions difference; it is explicitly **not an investable market
benchmark**, evidence of alpha, or acceptance of a strategy.

Hand-computed fixtures distinguish profit from time-weighted return, preserve
cash locks and fees, and record missing executions. Exact `Fraction` arithmetic
checks proportional cent budgets independently of the decimal implementation.
Both languages independently construct decisions, replay events and value the
same histories, including 32 seeded synthetic price paths and false-output
resealing checks. Hashes bind inputs, source and outputs; they are not signatures.

Verification entry points (repository root unless noted):

```sh
python -m unittest tests.execution_sandbox.test_projection
node --test tests/execution_sandbox/projection-contracts.test.mjs
# In web/, with WORKBENCH_TEST_PYTHON set to the project Python if needed:
node node_modules/tsx/dist/cli.mjs --test tests/bounded-cash-projection.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

Still required before real portfolio research: actual decision-policy lineage,
formal trial/data-exposure governance, causal market-data admission, supported
corporate actions, sales/settlement, HK/US/FX, an executable market benchmark,
independent evaluation and publication gates. No old study/holdout is reopened,
no real strategy tuned, no model adopted and no production strategy switched.
Scoped tests and same-host source reconstruction are not full CI, UI acceptance,
load acceptance, independent-host recovery or investment-performance evidence.
