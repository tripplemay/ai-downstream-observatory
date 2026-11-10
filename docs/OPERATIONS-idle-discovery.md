# Idle discovery CPU acceptance

## Scope

This round changes discovery cost, not strategy, risk parameters, prices,
authorization, provider attempt counts or the worker's five-second poll interval.
It introduces no cross-request authorization/result cache and no new service.

- Historical bootstrap receipts whose request range cannot contain the required
  closed session are rejected before reference reconstruction or payload replay.
  Candidate-count bounds run first; ambiguous/invalid metadata falls through.
  Calendar search hints retain owner/audit/hash binding and latest-approved-head
  checks, but do not replay pure fact-schema validation. They never act as grants;
  positive candidates still resolve and fully validate the original calendar.
  Superseded/continued heads conservatively take the original path.
- Initial historical-price discovery skips reconstruction only when every hinted
  target/session is already reserved in the immutable once-only request ledger.
  A new session or missing/ambiguous hint returns to full validation. This cannot
  authorize collection or retry a failed/unknown attempt.
- Positive candidates retain the original source, owner, audit, calendar,
  licensing, expiry, arithmetic, transaction and fencing checks.
- Within the existing 120-second close reservation, the provider worker checks
  the normal fenced claimant before discovery. It defers discovery only for
  that bounded window and preserves the existing supported-type filter, mutex,
  oldest-ready ordering and one-job-per-cycle behavior.

## Metrics

Each worker emits `worker_phase_timings` aggregates at most once per minute,
plus one final non-empty aggregate on shutdown. Metrics contain phase names,
counts, errors, wall seconds, process CPU seconds and maximum wall duration;
never source documents, quotes, positions, workspace IDs or credentials.

`cycle` includes its child phases: do not add its time to the child totals.
Process CPU is not host utilization; use cgroup counter deltas over a measured
monotonic interval for before/after comparisons. A slow phase is observable even
when its cycle fails. These metrics do not bypass any validation or drive policy.

## Release lifecycle

Full successful release verification (including database integrity, migration
hashes, source/config identity and actual healthy image IDs) runs inside the
managed worker's original 75-minute absolute deadline and produces only a
`VERIFIED_PENDING_MANAGER_EXIT` receipt. The 90-second stop hook requires the
actual manager-reported successful main-process exit before publishing terminal
success; otherwise it performs failure fencing. It never repeats an expensive
success scan. A killed main process cannot be blessed by the verification receipt
alone. Neither budget is extended.

An old missing terminal receipt is not automatic success. Explicit operator-only
`reconcile --acknowledge-missing-terminal` can record a once-only, post-deadline
technical reconciliation after a fresh independent check. It requires an
inactive manager, actual exit zero, current source/config/fleet/image identity,
database integrity and the original verified local restore. It cannot rerun the
old release or overwrite its records. The original automatic status remains
`UNKNOWN_REQUIRES_REVIEW`; a separate bound reconciliation permits a new normal
release submission. This operation requires separate owner authorization.

## Production acceptance

1. Retain baseline and candidate source identities, CI coverage/partition
   artifacts and all original assertion/budget evidence.
2. Observe unchanged inputs and no due/running tasks, without inducing provider
   calls, UI polling, load tests, service pauses or CPU limits.
3. Capture at least seven cgroup samples over at least 120 seconds using the
   same collector as the baseline; verify no restarts/OOM/throttling and identify
   unrelated host load separately.
4. Require combined core-worker plus provider idle CPU to fall at least 80%
   relative to the measured baseline (approximately 1.50 cores).
5. Check phase aggregates, the existing queued close task and normal scheduling
   across the relevant trading window. Lower CPU from disabling monitoring or
   skipping the normal positive validation path is not acceptance.
6. Keep a single standing private backup after the new release's own verified
   backup/restore and authorized retention cycle. Never reuse an old deletion
   intent or label a missing receipt successful to permit cleanup.

Synthetic, CI, native lifecycle and production observations are separate gates.
No production CPU improvement is claimed until these measurements exist.
