# Initial-price checks at the actual transport boundary

Initial-price preparation may spend substantial time replaying a retained
reference and its source bindings before calling the provider. A clock sampled
before that work is not evidence that a lease or request still has enough time
left at the start of I/O. Production metadata showed expired earlier attempts,
but did not identify their exact Python phase or prove whether HTTP occurred.
The fictional regressions here independently reproduce the stale-clock defect;
they do not establish that it was the sole cause of those production failures.

## Fresh checks, unchanged budgets

Preparation checks the current wall clock, stop signal, write/recovery mode and
original lease before and after expensive read validation. An internal callback
runs after the full price binding and retained-overlap checks, immediately before
the existing isolated SDK collector. It checks the latest owner, profile,
selection, model control and rights/listing/calendar review identities again,
then checks the clock and lease again. The original provider timeout plus its
existing safety margin must fit inside both the request expiry and the original
lease. Paused or superseded work skips without a provider call. A consumed margin
fails closed; it does not increase a timeout or extend a lease.

The callback is an in-process callable, not a JSON argument, public command,
caller-controlled production clock or source-qualification override. Binding,
payload and currentness validation still run; this is not permission caching.
Pure fact validation reuse is isolated separately to preparation and final
commit, and discarded before network I/O. Database results, source qualification,
audit checks and economic calculations are not cached across those scopes.

After the SDK returns, fresh stop/write/recovery/lease checks run before a
publishable effect can be returned. The existing fenced final transaction still
revalidates the complete current binding and atomically commits capture, audit,
run and job result. A stop or expired lease is not disguised as a provider error.
An SDK call whose outcome is unknown is not repeated. Request IDs, one-attempt
jobs, daily budgets, history overlap policy and retention remain unchanged.

## Verification and scope

Fictional tests advance time or change controls inside the actual binding path,
and distinguish zero SDK calls before I/O from one call followed by rejected
publication. They cover lease expiry, consumed margin, stop, read-only/recovery,
model pause, rights withdrawal and expiry/stop during transport. A separate test
keeps the final commit stop barrier after successful preparation. Invalid or
raising callbacks cannot reach the SDK or create captures or financial facts.

The selected initial-price, discovery and data-evidence regression passed 54
tests; the selected source/monitor regression passed 97 and independent Node
journeys passed 9. These sets overlap and are not summed. Five fixed bundles,
Next production build and the serialized post-build typecheck passed. The
initial negative run and an intermediate fixture failure remain in private
development evidence. This change adds no migration, source authority,
strategy change, funding assumption, order or trading permission. Historical
research keeps its frozen implementation identity; old trials are not rerun or
silently resealed because transport code changed.

Exact-commit CI, protected deployment and actual current-data/monitoring
acceptance are separate requirements. Earlier expired attempts remain closed;
this repair does not recover their missing prices. Complete corporate actions,
continuous qualified data, ordinary/funding/stale journeys, independent running
recovery, capacity and the remaining v2 P0/P1/P2 work remain open.
