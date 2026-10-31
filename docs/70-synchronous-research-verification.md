# Synchronous research-proof reuse

This increment reduces repeated deterministic research checks inside one
investor-state read. It does not replace the continuous-source work or declare
the full v2 product complete. A source/permission/monitoring gap remains a gap.

## Boundary

`getInvestorState` creates a fresh synchronous proof scope inside its existing
SQLite transaction. Successful bounded research calculation checks may be reused
only while constructing that one state response. No process-wide result cache,
database cache table, background result, provider request or persisted snapshot
is introduced. Scope exit, including exceptions, discards every proof. Nested
reads have separate scopes; asynchronous callbacks are rejected.

The request schema, result schema and result seal are checked on every call.
Only the subsequent deterministic calculation checks for research plans v3-v6
are eligible. Their proof key hashes the complete request and complete result,
plus the Decimal arithmetic configuration. It does not trust an asserted
`result_hash` as the entire key. Resealed arithmetic or input changes require
fresh independent replay. Failed verification never records a proof.

At most 64 digest-only proofs are retained per read. When full, additional
distinct calculations are verified normally rather than evicted, deferred or
accepted. Source data, prices, account values and result objects are not retained
in the scope. Legacy research v1/v2 and monitor assessments keep their original
verification path; hashing them for reuse showed no benefit in the local probe.

All database reads and source qualification, ownership, audit, latest-version,
withdrawal, expiry, payload, registry and model/control checks still execute.
No currentness or provenance decision is memoized. A later state read cannot
inherit a proof from an earlier response, even for the same owner and timestamp.
No contract, migration, policy, economic result or financial fact changes.

## Evidence and limitations

Focused regression covers the bounded and legacy kernels, resealed economics
after a valid proof, nested/failed/bounded scopes, source withdrawal/expiry,
monitor checkpoints, ordinary v6 save/review and explicit monitoring costs.
Scope unit counters establish success-only reuse and the retention bound; they
are not a market-data or economic qualification certificate.

A local invented v6 model was read through the old and new service in the same
process and same temporary database. After warming both versions, seven pairs
were alternated. Every returned state matched exactly and SQLite changes stayed
unchanged; financial facts remained empty. In this probe the median was about
548 ms before and 468 ms after. A simpler legacy model showed no useful benefit
and is excluded from reuse. These are one-fixture observations, not an SLA,
production speed claim, full-load result or diagnosis of the earlier proxy 502.

The local temporary fixture is removed after the probe; it creates no production
backup or restore copy. Type checks, fixed bundles and production build remain
separate from exact-head CI, protected release, real continuous sources, public
production acceptance, long-term capacity and independent recovery requirements.
