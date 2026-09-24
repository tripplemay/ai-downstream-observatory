# Recurring reviewed ETF daily-price collection

Status: v22 implemented with scoped synthetic local verification; not a complete
acceptance or production certificate. See the current implementation tracker.

## Purpose and authority

Connect the existing reviewed LongPort daily-price collector to an explicit,
versioned schedule. This implements the daily data-update path in P-03/P-05/P-08;
it does not approve securities, strategies, account permissions or trades.
The provider Worker remains an independently configured, opt-in service. No
provider credentials or personal investment parameters enter public examples.

Saving is always paused. Enabling and pausing require a current human session,
explicit reason, acknowledgement, idempotency key and schedule CAS. Page reads,
Worker restart, a new reference version and a saved draft never enable a plan.

## Definition v1

The strict `price-collection-schedule-v1` JSON definition contains exactly:

- `schema_version`, `provider=longport`, `frequency=daily`, `publish=true`;
- `market` (`CN`, `HK`, `US`) and matching `timezone` (`Asia/Shanghai`,
  `Asia/Hong_Kong`, `America/New_York` respectively);
- `mapping_version_ids` and `calendar_version_ids`, binding the complete reviewed
  set of one to four listings in one market; no implicit latest-reference lookup;
- finite `start_date` and `end_date`, inclusive **target price dates**;
- `trigger_local: {hour, minute}`, on the **following local calendar date**;
- `deadline_seconds` (60-86400), `max_attempts` (1-5), and
  `missed_policy=record_no_backfill`.

The definition is bounded to 64 KiB. Dates must fit every selected reviewed
calendar and mapping interval and span no more than 3660 days. Every local
trigger must map to exactly one UTC instant; DST gaps/ambiguities and overlapping
adjacent deadline windows are rejected before authorization. All required
parameters are supplied explicitly, not inferred from a personal plan.

For target date D, the trigger is D+1 in the market timezone, not a claim that
the quote was published at the exchange close. Existing price collection rejects
the current local date; scheduling does not weaken that requirement. The UI
must show the target price date separately from scheduled UTC and actual receipt
time. Provider capture time remains observed, never backdated to the trigger.

## Scope, versions and immutable slots

Keep the existing price scope derived from portfolio, market and the complete
sorted listing IDs. Reference revisions and dates do not create new scopes.
Only one schedule for an exact scope can be enabled. A saved change creates an
immutable version and pauses the schedule; explicit re-enabling is required.

Migration 0022 appends independent `price_collection_schedules`,
`price_collection_schedule_versions`, `price_collection_schedule_controls`,
`price_collection_schedule_heads` and `price_collection_schedule_slots` tables.
Migrations 0001-0021 remain byte-for-byte unchanged. Immutable identity, audit,
version, control and slot relations reject UPDATE/DELETE/REPLACE bypasses.

Each slot uniquely identifies `(scope_key, period=D)` across restarts, changed
versions and pause/resume. It freezes the original schedule version, human
authorization revision/audit, complete reference binding/hash, target date,
scheduled/deadline/creation instants, publication CAS and optional request ID.

| Disposition | Reason | Network/job consequence |
|---|---|---|
| `requested` | Complete open-day references and current authorization | One original fixed price request |
| `skipped` | `MARKET_CLOSED`: all selected calendars closed | No request, job or price publication |
| `blocked` | `MIXED_CALENDAR_SESSION`: only some calendars closed | No shrinking the listing set or synthesizing prices |
| `blocked` | Selected reference is stale, invalid, unavailable or outside coverage | Explicit diagnostic; no silent latest-version substitution |
| `missed` | Original authorization ended or deadline elapsed | Durable gap; no historical network backfill |

Later reference changes never rewrite existing evidence. A missed/blocked slot
cannot be made successful by replacing its request, moving its target date,
editing the schedule or pretending that a later quote arrived on time.

## Worker and publication boundary

The provider role discovers and consumes these price slots; core and verifier
roles do not execute them. Discovery is bounded and restart-safe, with durable
slots rather than an in-memory cursor as the source of truth. Read-only recovery
blocks discovery and publication. There is no new arbitrary provider URL, SDK
command, script, clock or environment input exposed to clients.

Within each visited schedule, discovery derives the earliest missing date from
durable slots and exact authorization intervals. Restarting never makes existing
early dates consume the entire history quota forever, nor skips a middle gap by
using the largest stored date. Expired windows create diagnostic slots, not calls.
Cross-schedule rotation still uses an in-process hint: production scheduling uses
the long-running provider daemon. Independent `--once` processes visit only the
leading bounded scope slice (100 scopes by default); fairness beyond that slice
is not implemented or claimed for cron-style `--once` deployment.

Use the existing strict `market-price-collect-v1` payload unchanged:
`start_date=end_date=D`, the authorized mapping/calendar IDs, `publish=true`
and the publication revision observed when creating the slot. Do not add
schedule fields to that payload. The immutable slot binds its request by foreign
key. Reserved actor `system:price-collection-discovery` without a valid slot is
rejected; existing explicit human one-shot requests preserve their semantics.

Recheck authorization, deadline, complete reference set, lease/fence and recovery
state before and between external calls and in the final atomic transaction.
Pausing, changing a definition or reference, or losing the lease blocks an
in-flight publication. Capture, market batch, publication and job success must
not partially commit. A competing publication fails the frozen CAS; retries
cannot silently upgrade it or allocate a second request for the same day.

Private history independently verifies the original human authorization,
request, job/attempt and capture/publication proof. A later pause does not erase
historically valid evidence. Slot creation, queue state and a closed market are
not reported as successful price collection.

## API and UI

- API: `/api/workbench/price-schedules`, GET scoped state/detail and POST
  `save_schedule` / `set_status`. Use current-session binding and existing
  strict Origin, query, duplicate-key, scope and private-response rules.
- UI: `/workbench/price-schedules`, connected from the market workspace/nav.
- Typed fields and explicit reviewed-reference selection; no default real
  ticker, broker, credential, market, date, trigger or automatic enabling.
- Show schedule versions, enabled/paused state, next trigger, target date,
  immutable slot disposition/reason, attempts, capture and publication status.
- Navigation/session changes clear private drafts and stale responses; reads
  never create or retry work. Uncertain writes retain an exact manual-retry
  request rather than generating a new idempotency key automatically.

The initial workspace shows the current definition and each slot's original
authorized version. The database preserves the full append-only control/version
chain, but the UI does not yet enumerate older versions that produced no slot.
That history-navigation gap remains explicit rather than inferred from storage.

## Required verification

Exercise the ordinary human save/enable API, real provider-role discovery and
isolated test transport through the existing capture/publish pipeline. Cover
next-local-day timing, half-day/closed/mixed calendars, DST and finite ranges,
duplicate discovery, bounded scans, missed windows, paused/revised/stale inputs,
in-flight pause/reference/CAS/lease races, failures/retries, recovery and scoped
historical reads. Preserve actual fixture bytes and expected source knowledge.

Native UI must exercise creation, explicit enable/pause, history, scope/session
isolation, readonly and layout. A synthetic transport is labelled as test
evidence, not real provider permissions, freshness or live market acceptance.
Full P/ACC/E/S, performance, independent-host recovery and release acceptance
remain separately required. Background large-file CSV import, historical
statement reconciliation and full actual-portfolio attribution remain open.
