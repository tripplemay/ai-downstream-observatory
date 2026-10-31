# Provider discovery without a long reserved writer

This increment addresses a production observation of a busy market-provider
process holding the SQLite WAL writer while no claimed job was recorded. That
observation identifies the process, not its exact Python frame. Fictional
two-connection regressions independently reproduce the problematic discovery
transaction pattern. Exact-commit CI and repaired production acceptance remain
separate from these local results.

## Read preparation, short metadata commit

Initial-price discovery previously entered `BEGIN IMMEDIATE` before rebuilding
the saved reference, validating sources and preparing every listing. Confirmed
watch discovery similarly reserved the writer across model validation. A path
can therefore have zero SQL changes while still preventing another writer.

Both producers now require an autocommit caller and prepare in a per-model
deferred read transaction. All targets/markets are checked before the first
audit/request insert; expensive validation is not interleaved with those writes.
Each model's request/audit batch is atomic. Owner, current model/control/selection,
source bytes/audits/rights, calendar, availability, duplicate-day and expiry
checks remain. Read-only, recovery and stop barriers still reject publication.
The existing job preparation and fenced result-commit checks are unchanged.

In WAL mode, a read snapshot cannot upgrade to a writer after another connection
has committed. This is the intended optimistic fence, not an invitation to
commit a stale prepared plan. See SQLite's [isolation explanation](https://www.sqlite.org/isolation.html)
and [BUSY_SNAPSHOT result code](https://www.sqlite.org/rescode.html#busy_snapshot).
Only ordinary `SQLITE_BUSY` and `SQLITE_BUSY_SNAPSHOT` during discovery defer the
affected batch until a later discovery pass. They do not create a source-quality
failure, retry an HTTP request or claim a successful monitoring result. Other
SQL errors propagate. Workbench validation errors retain their source-gap path.

Requests are durable before I/O. Queuing can be recovered separately from an
existing request if execution stops between metadata commit and job enqueue.
The original request ID/hash and one-attempt job identity are reused; its daily
budget and any earlier attempts are not reset. Confirmed discovery no longer
depends on one global transaction spanning every model and job enqueue.

## Missing pure-validation scope in reference checks

Full dataset reconstruction already bounded reuse of successful pure fact
validation. Reference-header checking also dereferences every retained capture,
but previously repeated the same rights/listing/calendar validation per shard
without that scope. The reference check now uses the same bounded digest-only
scope; each model's preparation also gets an isolated scope.

This does not cache database results, provenance, current source qualification,
permissions, payload parsing or research calculations. Every source/review/audit
and retained payload is still read and checked. Changed bytes cannot hit a fact
validation key. Scopes are isolated and discarded on success or failure; no
cross-request or cross-process cache is introduced.

A disposable five-year, two-asset comparison used 118 invented SDK projections:
pure fact validations fell from 360 to 6, while **all 118 payload replays and
720 audit bindings still ran**. Four alternating runs took approximately
20.4/1.31/1.33/22.7 seconds. SQL changes, provider calls, real data and registered
experiments were zero. This isolates one reference-check component; it is not a
full-role deadline guarantee, shared-VPS load result or production latency SLA.

## Verification boundaries

Regressions cover another Python writer during every expensive preparation
phase, concurrent withdrawal/model pause/duplicate discovery, a real Node writer
against the same fictional WAL database, atomic late failure, request-to-job
recovery, stop/read-only/recovery barriers and propagation of non-busy errors.
Header tests count retained-payload reads separately from pure fact validation
and reject corrupted bytes after facts have already been validated.

The final selected discovery/reference suites passed 53 cases, source/monitor
regressions 137, full orchestration 183, and selected independent Node journeys
4. These sets overlap and are not summed. Five fixed bundles, Next production
build and the serialized post-build TypeScript check passed. An initial negative
test incorrectly assumed capture insertion order rather than canonical manifest
order; the corrected test corrupts the last manifest entry after every preceding
payload has been checked. A first Node command used the repository root instead
of the Web working directory and failed alias resolution before tests ran; the
normal Web invocation passed without changing aliases or compiler gates.

No migration, financial fact, strategy parameter, fee assumption, source
authority, real model save, network capture or trading permission is added by
this code change. Runtime write availability and provider/core progress still
need independent checks after the normal protected deployment. Complete actual
actions/FX/calendar monitoring, source use authorization, ordinary homepage
journeys, long-term capacity, independent running recovery and full v2 P0/P1/P2
acceptance are not replaced by this repair.
