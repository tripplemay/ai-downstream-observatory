# Generated-policy runs and an executable model benchmark

## Delivery boundary

The v2 product objective remains the complete P0/P1/P2 workflow and protected
production release, not a collection of standalone passing modules. This change
supplies a missing prerequisite for that workflow: an entire causal, generated
decision history and a non-cash market-portfolio comparator. It does not itself
complete real-data admission, investment evaluation, monitoring or UI delivery.

Protocol: `bounded-cash-run-sandbox-v1`. Python is
`worker/execution_sandbox/study_run.py`; independent TypeScript is
`web/src/server/execution-sandbox/study-run.ts`. The shared contract is
`contracts/v1/bounded-cash-run.schema.json`. Previous buy/journal/projection
source identities and retained reports remain unchanged.

## Whole-run policy lineage

The run starts from a new empty journal. It never accepts an input journal,
prewritten orders, chosen quantities or claimed successful decisions. Inputs
are a bound declaration/program, prospective decision instants/windows and
timestamped valuation/execution evidence. Contribution events come only from
the frozen program schedule. Future scheduled cash is not credited early.

At each frame, the deterministic order is:

1. Mark the prior state, including pre-flow NAV and intra-run price peaks.
2. Resolve due batches, in terminal-time and batch-ID order.
3. Record contributions scheduled exactly at this frame.
4. Generate the scheduled decision from current state and currently known marks.
5. Append only the generated plan, if any; record its before/after journal heads.
6. Mark the resulting state for the frame curve.

All scheduled funding up to the final frame, all decision instants and every
planned expiry need an exact frame. Frames and decisions are sorted and unique.
Multiple future frames cannot cause a past quantity or allocation to change.
Pending batches return an explicit wait decision without adding orders.

Execution observations are mapped from listing IDs to the previously generated
order IDs, only at batch terminal processing. **Below-minimum rows are not active
orders and must not receive execution observations.** A fee-bearing comparator
exposed this integration bug during development; both implementations now filter
those rows while retaining their explicit zero-debit result. No execution gap
gate was relaxed. Missing observations and cap/corporate-action failures remain
counted failures, even if a valuation mark exists for the same asset.

`decision_policy_compliance_verified=true` is supported only by complete run
regeneration, including all commands, states and decisions. The nested older
valuation report correctly retains its own false compliance field: valuation
alone cannot establish order-generation lineage. Consumers must invoke full
replay, not trust a boolean or a rehashed output.

## All supplied marks enter risk sampling

The new curve visits every supplied frame, including marks between journal
events. Pre-event and post-event marks also enter the running peak/drawdown.
Unit issuance uses exact internal pre-flow unit NAV, not rounded displayed units.
Locked cash remains part of NAV. With no contributed capital, performance stays
undefined/null. Fees, upward cent rounding and total debits are accumulated from
the actual simulated resolution rows, not estimated from desired targets.

The older event-only valuation is independently regenerated as a reconciliation
check on end NAV and cash-flow-adjusted return. Its event-only drawdown may miss
an intermediate price peak; it is retained under its original semantics instead
of being silently relabelled as the new full-frame metric. The new maximum is
still only a **sampled** maximum, not proof of a complete exchange calendar.

## Executable same-flow market comparator

`compare_programs` / `comparePrograms` runs two explicit programs independently
through the same frames, decision windows and resolution mechanism. It requires:

- The same start instant, asset universe and quantity-step semantics.
- The same complete contribution schedule, including identities and instants.
- The same price cap, commission, minimum fee, slippage and quote-age policy.
- No precomputed benchmark return series or cost-free fractional portfolio.

Benchmark weights, cash target and drift tolerance are explicit prospective
assumptions. This comparison does not choose a winning benchmark or candidate
from future outcomes. Both sides use cash-only underweight repair; neither sells
overweight assets. The comparator is a **simulated market portfolio**, not an
index, buy-and-hold claim, actual execution certificate or tradable product.
The older zero-interest cash reference remains a separate diagnostic.

Output includes both journals, decision records, full-frame curves, event
reconciliation, fees, execution failures, end-NAV difference and difference
between published 12-decimal cash-flow-adjusted returns. The latter inherits
that display precision. Negative relative results are retained, not discarded.

## Qualification and next integration

All current requests/results are `synthetic_test_only`. The schema cannot be
switched to a real-data qualification. Registration is still not independent;
there is no formal trial budget or durable exposure admission in this component.
Source/input hashes and full replay do not certify market data or independence.

`valuation_basis` stays `terminal_processing_not_execution_settlement`. There is
no actual exchange-fill/settlement claim, no sell/partial/dividend/split/FX engine,
and no HK/US admission. These limits must be resolved or explicitly enforced in
the versioned research adapter before production portfolio generation.

Next integration must bind this entire generated-policy run, not only its
statistics, to durable study/trial/exposure registration and real-source review.
It must preserve old failed trials, already-exposed windows and unopened holdout
status. Then the existing v2 reference-plan, monitoring, human-review and account
flows need real-source end-to-end acceptance. An unchanged production server or
green unit tests does not satisfy that goal.

## Verification

Hand-computed two-asset cases show different holdings, profit and cash-flow-
adjusted returns on the two sides. An extra inter-event peak proves why event-
only drawdown is insufficient. Tests also cover frozen plans under later cap
breaches, absent executions, same-instant funding order, pending decisions,
fee-bearing below-minimum rows, comparison mismatches and resealed false lineage.
Sixteen seeded full-path comparisons are independently regenerated in Python
and TypeScript. All prices, schedules and weights are invented test values.

```sh
python -m unittest tests.execution_sandbox.test_study_run
node --test tests/execution_sandbox/run-contracts.test.mjs
# In web/, with WORKBENCH_TEST_PYTHON set to the project Python if needed:
node node_modules/tsx/dist/cli.mjs --test tests/bounded-cash-run.test.ts
```

Focused tests are not full CI, runtime UI, performance, recovery, real investment
evidence or a release approval. Current behavior must be verified on the exact
candidate commit before deployment.
