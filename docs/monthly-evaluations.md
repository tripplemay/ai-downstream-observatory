# Monthly evaluation implementation contract

Status: implementation in progress. This does not activate a schedule, approve
an investment policy, certify a strategy or authorize broker orders.

## Scope and invariants

- Actual-mode, monthly evaluation of an explicitly authorized `manual_target_v1`
  strategy. Target weights use total portfolio NAV as denominator; targets only
  cover that strategy's universe. Other strategy/core holdings remain unchanged
  but still participate in whole-portfolio risk checks.
- Every owned or source-owned in-transit position in the strategy universe must
  have an explicit account/listing target, including explicit zero when desired.
  Missing targets are blocked, never implicitly sold or silently ignored.
- Sum of target weights cannot exceed the active strategy/policy budget. No
  investment defaults, automatic funding, FX, approvals, reservations or facts.
- Outcomes are `unchanged`, `proposed`, `blocked`. No generated orders is not
  evidence of `unchanged`; insufficient cash/shares, pending activity, missing
  inputs or an out-of-tolerance difference below one trading unit are blocked.
- An unchanged result requires complete evidence, both directions of target
  differences inside the explicitly approved tolerance, and deterministic
  whole-portfolio risk checks. Empty proposals are never persisted.
- Nonempty items call the existing `createProposal` and its risk engine. Risk
  failure is a blocked cycle; passing candidates still require human approval.

## Schedule definition wire

`evaluation-schedule-v1` is strict JSON:

```text
schema_version: "evaluation-schedule-v1"
frequency: "monthly"
environment: "actual"
policy_version_id, strategy_version_id, activation_id: nonempty IDs
timezone: explicit IANA timezone
start_month, end_month: inclusive YYYY-MM (end_month may be null)
trigger: { day: 1..28, hour: 0..23, minute: 0..59 }
deadline_seconds: integer 1..604800
max_attempts: integer 1..5
targets: {
  method: "manual_weight_targets_v1",
  weight_basis: "portfolio_nav",
  rows: [{ account_id, listing_id, currency, weight: Decimal string 0..1 }],
  absolute_tolerance_cny: nonnegative Decimal string,
  weight_tolerance: Decimal string 0..1,
  tolerance_rule: "max_absolute_or_weight",
  unlisted_strategy_positions: "block",
  pending_activity: "block",
  price_rule: "close_rounded_to_step",
  quantity_rule: "floor_to_step"
}
```

Rows are unique by account/listing, bounded at 100. Tolerance is exactly
`max(absolute_tolerance_cny, NAV * weight_tolerance)`; compare unrounded signed
value differences before rounding quantities. Cash minimums and fee estimates
come from the active policy, never a budget or assumed sale settlement.

Saving creates an immutable version and leaves the schedule paused. Enabling,
pausing and retrying require a human command, reason, idempotency key and CAS.
Save commands also require `expected_schedule_id`: null for a new identity,
or the selected existing schedule ID. A matching revision on another strategy's
schedule is not authorization to edit it. The audit binds the same identity.
The first authorized month must not precede the month containing approval.
No same-month extra cycle is implicitly authorized by changing a version.

## Persistence wire

- `evaluation_schedules`: id, portfolio_id, environment (`actual`), strategy_key,
  scope_key (`portfolio`), created_by, created_at. Immutable identity; unique
  portfolio/environment/strategy_key/scope_key.
- `evaluation_schedule_versions`: id, schedule_id, version, policy_version_id,
  strategy_version_id, definition_json, content_hash, created_by, created_at.
  Immutable, versioned and scope-bound.
- `evaluation_schedule_heads`: schedule_id, current_version_id, revision,
  status (`enabled`/`paused`), last_audit_id, updated_at. Updates increment CAS.
- Extend `evaluation_cycles` with schedule_version_id, environment, strategy_key,
  scope_key, scheduled_at, cutoff_at, knowledge_at, deadline_at, created_at,
  state_revision, terminal_attempt_id. Preserve old rows without fabricating
  authorization. New cycles require all bindings; stable unique slot is
  portfolio/environment/strategy_key/scope_key/period. Legacy `scope` is the
  derived `actual:portfolio`; period is YYYY-MM.
- `evaluation_cycle_requests`: command_request_id (PK/FK), cycle_id, generation,
  requested_by, reason, created_at. Immutable and unique cycle/generation; the
  referenced command is `monthly_evaluation` with payload `{cycle_id}` only.
  Jobs bind through `job_runs.command_request_id`; no arbitrary client result.
- Extend `evaluation_attempts` with job_attempt_id (unique FK), input_hash,
  result_hash, completed_at. Domain attempt numbers increase per cycle. Crashes
  before a domain result remain visible in job_attempts, not invented outcomes.
- Cycle identity is immutable. Completed results never reopen. Explicit retries
  of blocked/failed cycles append a request/attempt and retain the original
  period, schedule version, cutoff, knowledge boundary and deadline.

## Time, evidence and execution ownership

The Python worker discovers due periods from enabled immutable definitions and
creates a cycle and command atomically. The local trigger must resolve to one
UTC instant; ambiguous/nonexistent local times are rejected, not guessed. Both
cutoff and knowledge boundary are that original scheduled instant. Discovery
after the instant is marked late; data first known afterward cannot be used to
pretend a timely decision. A missed execution deadline cannot publish advice.

The evaluator binds actual revision, an existing complete eligible valuation,
policy/strategy/activation and schedule hashes, consumed publications and market
observations, accounts/reconciliation, capabilities/evidence, positions/transit,
reservations and proposal/approval history. Evidence must be complete as known
at the original boundary and remain eligible at publication. Unavailable
historical evidence is an explicit block, not replacement with today's state.
Post-boundary cancellation, reservation release and natural proposal expiry
cannot erase activity that was pending at the boundary. NAV price/FX references
must match the knowledge-time vector for every valuation item, including
non-target holdings and foreign-currency cash; sharing a session is insufficient.

Python owns discovery, job claiming, lease/heartbeat and retries. A fixed local
Node publisher reuses the existing TypeScript governance engine. It accepts
only a lease identity, reads the authorized cycle itself, computes outside the
write transaction, then revalidates the exact inputs and lease inside a short
transaction. Cycle/attempt, proposal/risk if any, outbox and job completion
commit together. No Node write is invoked while Python holds a write lock.
The bridge is not a Web endpoint, arbitrary script runner or client result API.

If the response is lost after commit, Python reads the matching terminal job;
it does not repeat financial effects. Expired lease holders, paused/replaced
schedule heads, restore locks and changed inputs cannot publish stale results.
Notifications are outbox records only; delivery retry must not re-evaluate.
The final commit guard also checks the original deadline and proposal TTL,
even when the job lease remains valid. Normalizing lease and authorization
timestamps must retain all six fractional digits rather than truncate to
JavaScript milliseconds.

## Human workspace and fixed publisher packaging

`/workbench/evaluations` provides explicit JSON definition editing without
personal numeric defaults, separate save/enable/pause confirmation, bounded
period and attempt pagination, and read-only result/evidence inspection.
Saving compares the returned definition version and SHA-256 against the exact
original UTF-8 bytes. Requests bind both the selected schedule and the current
verified session. Hashing and authorization probes recheck that binding before
any POST; mismatched or unverified sessions expose only a restricted skeleton.

An unresolved request retains its exact body and idempotency key in memory for
manual reconfirmation. A current-session 401 clears authorization even if its
body is malformed. Temporary 503/network failure hides and locks the workspace
but preserves that pending request; it never automatically resubmits it.
Leaving or reloading does not persist/recover monthly commands. The proposal
link opens governance, where the user must locate the displayed proposal ID;
it does not claim automatic selection or approval.

`npm --prefix web run build:evaluation-worker` produces the ignored local bundle
`web/dist/monthly-evaluation.mjs`. The worker Dockerfile rebuilds from locked
dependencies and source, then packages Node 22, that fixed bundle and matching
native SQLite dependencies on the same Debian release. Python invokes only the
fixed lease CLI, without holding a write transaction; it verifies the committed
database receipt rather than trusting process output. Unknown clock, actor,
result, database-path or script arguments cannot select publisher behavior.
The container fixture must execute the real Python bridge and Node/native-SQLite
bundle as UID 10001 and prove a nonexistent lease produces zero logical writes.
Source and structural tests alone do not certify that runtime image.

## Required evidence before accepting this slice

Real synthetic fixture flows must cover unchanged/proposed/blocked; unchanged
followed by next-day input changes must not create a second monthly cycle.
Also cover duplicate dispatch, version changes, failed/blocked explicit retry,
expired fencing, heartbeat, crash/response loss, restoration locks, no future
knowledge, deadline expiry, rounding/fees/FX, in-transit ownership, incomplete
targets and pending activity. Show that approval, reservations and ledger facts
remain untouched by evaluation. Native UI and production container evidence
remain separate acceptance requirements.

## Local release-candidate checkpoint: 2026-09-12

- Web unit/integration suite: 498 passed, zero skipped. Fifteen publisher tests
  use actual Python discovery/claim before the Node financial publisher. Three
  fixed-CLI tests exercise the real subprocess bundle and SQLite, including
  deadline-blocked completion and argument/lease rejection. The CLI fixture is
  not evidence that an expired period can produce advice; proposed/unchanged
  outcomes have separate publisher fixtures with explicitly controlled time.
- Python accounting/market/orchestration/research suite: 284 passed. The first
  release run exposed a test's random-ID queue-order assumption; the corrected
  fixture persists the earlier valuation job before discovering monthly work.
  Business scheduling logic and the original assertions were not weakened.
  Both failure and passing retry logs are retained.
- Node migration/market/recovery/deployment suite: 95 passed. TypeScript,
  authentication HTTP, shell checks and the production build passed. The full
  dependency audit, including development dependencies, reported zero vulnerabilities.
- HTTP: 67 passed, schema 15, build `YppVpXF8n7Vgh5sOLLvJI`. All 366 inventoried
  sources matched during and after the run. `HTTP-EV01..04` cover authorization,
  strict input, empty defaults, zero logical writes, readonly recovery and
  session-binding rejection; these are not positive investment-admission tests.
- Local logs: `artifacts/verification/final-regression/monthly-evaluation-v15-release-*`.
  HTTP evidence: `artifacts/verification/workbench-http/2026-09-12T16-00-40-270Z/`;
  manifest SHA-256 `393a9dc59b39f024e437b5300b84d7f92796f73823869bf66e058895c3cbbc94`.
  These are ignored synthetic artifacts, not personal data or admission evidence.

This records local pre-publication evidence, not an already deployed release.
Exact-commit Linux/Node 22 CI and the current container image still require
verification; local Node is 25.7.0 and the Docker daemon is unavailable.
Tabbit reports `BROWSER_RUNTIME_UNAVAILABLE`; native desktop/mobile, keyboard,
portal and BFCache acceptance are not replaced by callback or HTTP tests.
Live providers/calendars, complete rotation/forward simulation, trusted gate
verification and production deployment remain separate unfinished work. None
of these counts approves personal targets or guarantees returns.
