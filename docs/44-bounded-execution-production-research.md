# Bounded execution in the production research path

## Scope and versions

`research-plan-v3` is now routed through the existing research comparison,
investor source admission, default core, durable trials, candidate freeze and
reference-plan path. It is not another independent sandbox dispatcher.
The selector still uses `investor-diversified-reference-v1`: its train-only
selection and risk rules are unchanged. The separately versioned execution is
`fixed-policy-bounded-rebalance-v3`, with `research-result-v2` full phase receipts.

The allocation parameters remain `research-fixed-rebalance-parameters-v2`.
An explicit `research-plan-input` union admits old plans or v3; the old plan
schema and its nested execution JSON pointers are not widened. No existing plan,
trial, profile, window or source row is rewritten or automatically upgraded.
Changing a bound changes the admitted input/plan hash and requires a new study.

The new plan requires caller-specified `buy_price_buffer_bps` and
`buy_fx_buffer_bps`, with no production defaults. Test values are invented
software assumptions, not selected buffers or investment recommendations.
Only the low-frequency fixed policy is supported by this execution version.

## Decision, reservation and fill

For each buy, raw close and foreign-FX upper bounds are frozen at decision time.
CNY FX stays exactly 1. Whole-step quantity is sized using both bounds, slippage,
minimum/proportional commission and FX cost. Allocated budgets round down to
cents; buy debits round upward to cents under the financial calculation domain.
The entire cent budget is reserved, not merely the expected debit. Remainder
cash is not recycled into frozen orders.

Only the designated subsequent close proxy may execute. Its raw close and FX
must both stay within the frozen bounds and the resulting debit must remain
within its own budget and currently available settled cash after other locks.
Outside bounds means a retained failure, never a smaller hindsight quantity.
Sale-dependent buys keep their original quantity/budget and activate only after
actual modelled sale-cash settlement; a poor sale cannot borrow future proceeds.

A corporate action affecting an outstanding order cancels it with an explicit
failure instead of changing its frozen quantity or price bounds. Owned and
unsettled shares still receive split adjustments; dividend entitlements, tax
assumptions, payment cash, sale receivables and settlement use the existing
multi-market accounting. Theoretical ex-action carry remains explicitly labelled.
This is an ex-post close-proxy research model, not actual fill certification.

## Governance and independent verification

The existing source reviews, retention/currentness, workspace ownership and
official-capture reconstruction are still required before real admission.
The core commits phase intent before computation, preserves failed exposure,
freezes the selected candidate after training, and retains the original
validation/holdout trial budgets. Unknown risk remains train-only alternatives.
Any execution gap still blocks the selector's zero-gap gate; later phases do
not open after a failed validation. No real old study or holdout was retried.

New source/code versions intentionally change the production implementation
identity. Earlier immutable results keep their identities and archived source;
they are not resealed as v3. The former sandbox test's global source-freeze
assertion is replaced by a source-separation check, while three pre-v3 full
numeric receipt hashes independently guard legacy varying/flat/contribution
semantics. The old contract itself still rejects the new execution model.

The Web read path independently regenerates complete v3 phase economics,
orders, actions, settlements, curves and same-cost market benchmark from the
inputs. It then reconstructs each published summary and full-result hash.
Coherently rehashed false statistics fail. At most 64 immutable-input/summary
digests are cached; no raw payload is cached there and source permission,
expiry and workspace checks remain separate current checks on every read.

Saved references carry `+bounded-close-v1` before the existing fixed-policy
suffix and explain both buffer assumptions in ordinary cost text. The saved
model observes the same allocation policy; it is not an order executor. Existing
normal/new-funding/stale states, human review and financial-write boundaries
remain active. Accepting an idea is not a trade or an execution report.

## Verified boundary and remaining delivery

Tests use invented provider evidence and stub transport, even where the actual
admission/default-core/service code is exercised. They establish software
integration, not supplier permission, real data quality or investment validity.
Independent full phase vectors cover HK/US FX, fees, contributions, owned and
pending corporate actions. Actual service tests cover reference generation,
saving, monitoring, human review, client parsing and stale-state blocking, with
zero actual financial facts or approvals.

The earlier foundation commit's complete Linux CI is a separate receipt, not
acceptance of these subsequent changes. This candidate needs its own full CI,
authenticated responsive UI, privacy review, migration/backup checks and
protected release before deployment. Real-source studies need a new explicit
protocol and exposure registration; no test buffer is silently promoted.

Existing continuous/planned-funding v1/v2 contracts do not accept v3 execution.
[Document 45](45-bounded-continuous-funding.md) adds explicit new continuous and
funded-history versions through the existing private study/read path; old
contracts remain closed. Do not strip bounds and call it compatible. Real-source
end-to-end portfolio/monitoring, permitted AI explanation, the P2 account-level
loop, operational/recovery acceptance and external production business checks
remain part of the original v2 objective. This change alone is not v2 completion.
