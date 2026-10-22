# Bounded execution with continuous planned funding

## Integrated path and explicit versions

This extends the existing private funding study, not a second simulator or a
replacement for the research admission workflow in [44](44-bounded-execution-production-research.md).
An admitted `research-plan-v3` carries its complete execution assumptions through
calendar selection, every frozen candidate, the default core, retained result
bytes, cold independent replay, comparison and detailed path analysis.

The economic documents are explicitly versioned:

| Document | Bounded version |
| --- | --- |
| Funded input / result | `investor-funded-history-input-v2` / `investor-funded-history-result-v2` |
| Continuous input / plan / result | `investor-long-horizon-input-v3` / `investor-long-horizon-plan-v3` / `investor-long-horizon-result-v3` |
| Policy engine | `continuous-bounded-fixed-policy-funding-v1` |
| Hold-new-cash counterfactual engine | `continuous-bounded-hold-new-cash-v1` |
| Independent economic verification | `funded-history-economic-replay-v2` |

Old contracts remain closed and byte unchanged. The CLI uses an explicit union
request; it does not widen the old input schema. The direct continuous CLI needs
`--bounded-retrospective`, mutually exclusive with the old retrospective flag.
Missing buffers are rejected, not defaulted. Old results cannot be relabelled
as new ones, nor may new bounds be removed to pass an old validator.

The funding projection remains v1 because its principal/calendar semantics have
not changed. The durable request/run remain v1 digest-only workflow envelopes:
they bind the source, candidate, input and result hashes without embedding an
economic engine contract or asserting verification. A changed economic input
gets a different hash. Historical requests and immutable payloads are not
rewritten or automatically retried after a software upgrade.

## One continuous account, two release paths

Initial capital and each annual arrival enter NAV and principal when they
arrive. Unreleased CNY remains cash in NAV, earns no assumed interest, and cannot
fund an order. Local natural-day tranches preserve each lot's cent residual;
same-day lots do not round as one merged lot. Releases are neither trades nor
additional external contributions. Year boundaries never restart positions,
cash, units, receivables, settlements or cost history.

Both immediate and staged paths use the same frozen parameters, decision
times, observations, costs and two caller-specified buy buffers. Only release
timing differs. Buy quantity is frozen using both decision-time bounds and
upward-cent debit, with full allocated-budget reservation. A price/FX breach
retains an execution gap; it never retrospectively shrinks the order. Locked
future capital cannot cover it. Dependent purchases still wait for modelled sale
settlement, and pending corporate actions cancel rather than resize orders.

The hold-new-cash counterfactual changes only the rebalance rule. It uses the
same bounded execution and release path, and never sells to rebalance. It is
not an independently preregistered market benchmark or a forecast.

## Verification and product boundary

Python and TypeScript independently rebuild full traces and the hold-new-cash
counterfactual, including annual arrivals, local releases, fees, raw prices,
FX, owned/pending actions and explicit settlement. New vectors include ten
synthetic years, same-day cents, price/FX breaches, sale dependencies and
corporate-action cancellation. Parent-version continuous trace hashes protect
the legacy path. Coherently resealed incorrect economics or cross-version
results are rejected.

The durable service test uses invented reviewed evidence and stub transport.
It reaches the default core, retained three-candidate results, cold independent
comparison and analysis, strict client parsing, ownership and expiry checks.
Financial facts and approval/execution tables remain empty. These tests do not
establish real data quality, provider rights, a personal return or production
browser acceptance.

This remains retrospective exploration. Historical window selection is calendar
only, not return ranking. No candidate/risk choice, real cash-arrival confirmation,
portfolio adoption, external AI call or broker order is authorized by this path.
Real-source protocol registration, current personal constraints, authentic
responsive UI, P1 monitoring/AI and P2 account closure, operational acceptance
and protected production release remain part of the v2 objective.
