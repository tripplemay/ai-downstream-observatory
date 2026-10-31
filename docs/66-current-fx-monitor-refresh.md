# Current FX through subsequent monitor inputs

This increment extends [current FX selection](64-current-fx-source-selection.md)
past the first bootstrap. It is a continuous-model input repair, not source
approval, strategy optimization, a live-data certification or a trade interface.

## Reproduced failure

A fictional saved US model had an initial valid input and checkpoint. A later
calendar-bound callback completed successfully and retained exact close evidence.
An explicitly reviewed, concordant append-only FX source also arrived, but the
feed adapter copied the initial FX review ID into the extended window. The new
snapshot consequently reported expired FX and its admission stayed blocked.
CN/CNY-only happy paths could not expose this defect.

The new foreign-market fixture constructs the reference from reviewed historical
price/FX receipts, normal research and saved-model services; it does not stub the
model/reference resolver or relabel a CN result. Fictional US/HK calendars,
symbols, prices, permissions and callbacks are not real provider qualification.

## Selection with authority continuity

`confirmed_feed._refresh_fx_windows` selects all required currencies once at one
assessment time, using the existing frozen age ceiling and reviewed-source
resolver. It reuses the first-input ambiguity, future-fact, exact-overlap and
restatement checks. Each market receives only its required currency references.
CNY-only windows require no FX query.

A changed review must explicitly declare the **same** `monitor_series` as the
prior window, and must not regress its observation tail. A uniquely fresh but
unrelated or unlabelled source cannot silently replace a stale prior authority.
A legacy review can continue unchanged while current; moving it to a new source
requires explicit authority review, not an inferred declaration. Source-domain
labels, equal values and review timestamps are not authority evidence.

The admission transaction rechecks selection after independent source rebuilding.
A source/selection change rolls back the newly created input and its revision/
audit before recording a blocked first outcome. Stop, read-only and restore gates
are not converted into a successful/blocked admission that commits partial work.
No age, risk, cost, weight, calendar or funding setting is widened or rewritten.

## Late source arrival is not a network retry

The default **core** worker also runs `refresh_monitor_sources`. Cheap headers
identify an already-saved current model with a newly retained complete callback
not represented in its input, or a new reviewed relevant FX version. The adapter
then verifies the existing seed, control, retained receipts and all source rights,
merges completed closes and applies the explicit FX continuity rules.

It makes **zero provider/credential/AI calls**. A fresh review can repair a prior
FX gap without another callback or a history fallback. A current closed-day
price window may also be revalued after FX arrival, without pretending a new
market close occurred. Unknown/partial/failed callbacks do not become complete.
The provider-only worker cannot publish this refresh.

The original feed admission, including `blocked`, remains immutable. Successful
reassessment creates a separate ordinary monitor input plus a closed
`investor-monitor-source-refresh-v1` audit tying prior/new input hashes, model and
control. This is not a rewrite of the original outcome. Unchanged windows are
zero-write; replay does not create another input, model or research trial. Each
model update is transactional, including late audit or stop failures.

The retained checkpoint lineage, fixed policy and separately declared hypothetical
annual-funding binding remain in their existing runtime. A refresh creates no
deposit, actual balance, executed fact, reservation, approval or broker order.
Current-source withdrawal/expiry still hides NAV and returns insufficient
evidence, rather than falling back to an old rate or claiming no action.

## Bounds and remaining product work

This reuses the bounded current-review selector and existing finite feed/capture/
checkpoint limits. It does not remove those limits, certify ten-year capacity,
extend a frozen model's validity, revive expired/withdrawn seed sources or bypass
explicit new-inception/restatement governance. It adds no database migration,
backup, restore directory, source grant or automatic data-review approval.

Real current FX capture and a long-lived authority/head registry, complete
issuer identity/currency/per-share/dividend/split coverage, approved source
installation and scheduled source producers still need completion. Fictional
ordinary/fixed saved-model/core/read-only Node/client/annual-funding/stale checks
are software evidence, not the real-source normal/funding/stale production
acceptance required by the full P0/P1/P2 design. The complete v2 objective remains
open; protected CI/release and actual production journeys stay separate.
