# Actual portfolio performance snapshots

Use authenticated `enqueue_task` with `command_type: "performance"` and payload:

```json
{"valuation_ids": ["earlier-run-id", "later-run-id"], "evaluation_timezone": "Asia/Shanghai"}
```

The worker reads existing, scoped, immutable valuation runs. They must be in
strict chronological order, have the current ledger revision, and use the same
`as_known` or `restated` method. It does not accept user-supplied NAV or returns.
Results and the hash of every valuation input are retained in `performance_runs`.
New facts require regenerated compatible valuations; old performance is retained,
not rewritten or shown as current after a revision change.

- No external flows: exact ratio-linked TWR on the supplied complete snapshots.
- External flows without flow-before NAV: Modified Dietz, explicitly estimated;
  mixed intervals retain a mixed-estimate label. It never calls this exact TWR.
- External capital postings determine flows, not changes in account cash or
  planned funding. Internal transfers, settlement and FX are not contributions.
- XIRR uses ACT/365 investor-sign cash flows and explicit evaluation timezone.
  Same-day, multi-root, no-root and numerical failures remain unavailable or
  ambiguous, not 0%. The opening NAV is the start-of-period investment, not a
  claim to have reconstructed pre-inception lifetime profit.
- Date-only CNY cash flows use end-of-source-local-day timing for Dietz and an explicit
  end-of-day date conversion for XIRR. A snapshot splitting that unknown day is
  blocked rather than silently putting a flow on the wrong side of the boundary.
- Drawdown is measured on flow-neutral unit values at supplied snapshots only;
  it does not claim to measure intraday or missing-observation losses.
- Later-learned facts affecting an earlier `as_known` interval require a
  restatement, rather than booking knowledge changes as investment return.
- Foreign external flows require explicit approved `flow_fx_rules` and immutable
  event-time publication evidence. Missing, stale, synthetic, reconstructed or
  ambiguous evidence blocks all period totals; date-only foreign flows are also
  blocked. Endpoint FX rates are never borrowed for earlier contributions.
- `snapshot-performance-cny-v4` freezes every included capital posting and its
  FX binding in `performance-input-v4`; older v2/v3 runs remain audit history.
- External `security_in`/`security_out` flows retain confirmed gross market value
  and its evidence independently of carry cost. All date-only security flows
  block performance; internal transit does not create external capital.
  Each external security event must have exactly one capital posting and one
  matching signed position movement. Missing/duplicate legs, mismatched scope,
  value or evidence time block totals instead of inventing profit.
  See `docs/performance-flow-fx.md` for the cash-FX command and PIT policy.
- A new account opening snapshot inside the measurement period is blocked until
  the capital boundary is resolved; it is not counted as newly earned profit.

CLI (same contracts and write/recovery guards):

```sh
python -m worker.performance --db /absolute/workbench.db --portfolio ID --file performance.json
python -m unittest discover -s tests/performance -v
```

CLI exit 0 means complete data/method for this calculation, not strategy
validation. Exit 2 includes estimated or blocked results, retained with reasons.
No broker or AI provider is contacted. Benchmark/holdings attribution and daily
automatic production scheduling remain separate implementation work.

## Securities and version boundary

The current worker consumes `decimal-nav-cny-v3:{mode}` valuation runs with
`valuation-input-v2`. In-transit securities are valued once at the source account
using as-of unadjusted price and FX, not carry cost or dispatch-date value. Their
item evidence contains `transfer_event_id`, `target_account_id`, `quantity`,
`price_observation_id` and `fx_observation_id`. Arrival/return reduces that lot
while increasing only the receiving account's settled quantity. Cost and capital
valuation adjustment accounts are neither NAV assets nor income.

`flow-fx-evidence-v2` marks each external flow as `cash` or `security`. Securities
freeze listing, quantity, original-currency confirmed total market value, the
`security-transfer-value-v1` reference/time, and the canonical full-fact hash.
Foreign securities use the same strict per-event FX binding as cash (minimum
80-digit multiplication precision); valuation arithmetic stays at 60 digits.
Approved data-quality rules never grant investment or trading approval.

`tests/market/test_security_transfers.py` and
`tests/performance/test_security_flows.py` use temporary SQLite databases and
the actual TypeScript ledger service. They cover partial receipt, return, split,
unknown costs, external gross-value flows, fees, event vs endpoint FX, date
uncertainty, immutable correction/replay and damaged evidence. All catalog,
price and broker-value inputs are synthetic fixtures, not verified live assets.
