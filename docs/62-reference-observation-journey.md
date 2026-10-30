# Reference generation and observation are separate milestones

This increment implements the portfolio-first path in [v2](09-product-v2-portfolio-first.md).
It does not change research constraints, source qualification, economic calculations,
monitoring admission, account facts or trading permissions.

## Two independent state axes

An owner-reviewed historical reference may exist while current monitoring still
has insufficient evidence. Describe both facts, instead of implying that a
generated or saved reference is missing:

| Existing artifact | Primary progress | Current monitoring outcome |
| --- | --- | --- |
| Current historical reference, not selected | Historical reference generated; review it before saving | Unchanged |
| Selected reference and initial observation task | Research plan saved; monitoring not ready | Unchanged |
| Selected reference and blocked task | Research plan saved; monitoring evidence insufficient | Unchanged |
| Selected reference and paused task | Research plan saved; observation paused | Unchanged |

The existing three outcomes remain mutually exclusive. Progress never produces
`observe`, a NAV, a decision card, an order or a source qualification. Synthetic,
expired, different-profile, withdrawn, failed and inconsistent states do not
receive a ready-style progress message. Source and display deadlines still
invalidate the current display without rewriting historical observations.

## Main path

- The primary action is a read-only anchor to the reference or monitoring card.
  Manual research checking remains available in a separate disclosure; opening
  it does not submit or rerun anything.
- With confirmed risk, the reference card precedes the risk panel on the plan
  page. Missing confirmation puts risk first. Expiry expands the risk questions
  and removes current reference claims, but does not reorder the form. Stable
  keyed elements and parents preserve local draft state; source deadlines must
  not move a focused form through the DOM.
- Saving still calls the original authenticated, version-fenced, idempotent
  `save_plan` service. It records a research selection/model, not actual holdings,
  cash, execution approval or a broker order.
- Mobile primary navigation uses four equal-width links with 44px minimum touch
  targets instead of a permanently horizontally scrolling navigation strip.

## Avoid unsolicited work

Investor route links in the sidebar, mobile menu, brand, main navigation and
overview footer do not speculatively prefetch other authenticated SSR routes.
Explicit navigation still runs the normal independent evidence checks. This
removes unnecessary background reads; it does not certify latency, remove
verification, increase request timeouts or establish the cause of a proxy error.

## Required verification

1. Generated and selected references are distinguishable while the current
   outcome remains `insufficient_evidence` and all source gaps remain visible.
2. Expiry, source withdrawal, unknown risk, changed profiles, failed monitoring
   and read-only recovery do not gain ready semantics or new write capability.
3. Opening disclosures and anchor navigation issue no business command. Existing
   session, pending-request, CAS, idempotency and stale-response rules remain.
4. A current reference initially folds confirmed risk; unconfirmed risk is
   visible. Expiry must retain the actual draft, DOM node and keyboard focus,
   expand risk and invalidate current claims without reordering the form.
5. Desktop and narrow mobile layouts, keyboard navigation and actual Next
   route requests are checked against the built candidate, not a previous build.

Unit/component tests only prove their stated software scopes. Current real
monitoring, authorized AI explanations, account-level acceptance, full Linux load,
recovery and the final v2 completion audit remain separate requirements.
