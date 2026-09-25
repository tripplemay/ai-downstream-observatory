# Background CSV import contract

Status: implementation in progress. This does not certify full P-03/P-08,
ACC-01..19, E-01..32, performance, native UI or production acceptance.

## Authorization and lifecycle

The preview and confirmation commands are separate explicit human requests.
Neither an uploaded file nor a saved `csv_confirmation_attempts` row authorizes
execution. The new submission must acknowledge durable background execution.
An authenticated same-origin request, current session binding, immutable input,
authorization audit and command request are bound in one database transaction.
Confirmation additionally binds the original UTF-8 confirmation request archived
by the existing recovery service. Archival can succeed without authorization;
the dispatcher must never discover archive rows as executable work.

Accepted work continues after closing the page, logout or session expiry. This
must be visible before either submission. Logout immediately rejects further
HTTP operations with that session and clears private client state; it is not a
revocation of a previously accepted delegation. The worker receives no session
token, password, cookie, auth database or authentication secret.

The current authenticated owner can read bounded summaries/pages for their
portfolio and explicitly cancel unfinished work, including work submitted in an
older session. Original request recovery and exact replay stay bound to their
original session. A new session does not silently acquire or retry those bytes.
Cancellation is append-only in the workbench database. Cancellation and the
final financial transaction serialize: cancellation committed first prevents
execution; completed work cannot be retrospectively cancelled. A late cancel
returns a conflict, not a claim that facts were removed.

Requests expire 15 minutes after acceptance. The deadline is server chosen and
immutable; exact retries never renew it. Each job has at most three attempts.
Failed/stale work requires explicit new human review/submission; GET never
dispatches, approves, retries or reauthorizes anything.

## Inputs and immutable bindings

Commands are `csv_import_preview_v1` and `csv_import_confirm_v1` on the core
worker. Their canonical payload is exactly:

```json
{"schema_version":"csv-background-command-v1","request_id":"UUID","input_hash":"SHA256"}
```

The command actor is reserved `system:csv-background`; its ID and idempotency
key equal the background request ID. The human identity is independently bound
by the request and authorization audit, never inferred from the system actor.
The job scope is the portfolio, period is the request's UTC creation date and
input version is `command_id:command_payload_hash`, with three maximum attempts.

`csv_background_requests` retains actor, creating-session hash, portfolio,
account, operation, idempotency key, expected revision, exact input JSON, its
canonical hash, optional CSV bytes, optional confirmation attempt and batch,
command request, authorization audit, creation and expiry timestamps.

`input_hash = hash({operation, portfolio_id, account_id, expected_revision,
input: JSON.parse(input_json)})` using the existing canonical hash algorithm.
Preview input JSON is exactly `{filename, mapping, csv_sha256}`: mapping is the
original mapping string and the SHA binds the original file bytes. Multipart
transport boundaries are not part of the logical identity; the original file
and mapping bytes, filename, scope and revision are. Confirmation input JSON is
exactly `{payload_hash}` and references the separate immutable confirmation
attempt, whose original payload bytes are revalidated by the executor.

Idempotency uniqueness is `(actor_id, session_hash, portfolio_id, operation,
idempotency_key)`. Identical retries return the original request; any changed
logical input conflicts. Limits remain 4 MiB CSV, 256 KiB mapping, 10,000 rows,
5 MiB confirmation payload. Queue retention additionally bounds each creating
session to 128 requests and 64 MiB of stored request input/file bytes.

## Execution and atomic publication

The Python dispatcher creates one ordinary fenced job for each valid command.
Only a fixed Node executable bundle may perform CSV ledger execution. It uses
the existing parser, mapping, duplicate review, preview and confirmation engines;
there is no alternate accounting implementation or caller-provided result.
The child receives a minimal environment and fixed lease arguments, not shell
commands, configurable script paths, provider credentials or `NODE_OPTIONS`.
No network call is needed or permitted by its application code; this is not a
claim of OS network namespace isolation for the network-capable core container.

The child is bounded to 120 seconds; it may start only with at least 150 seconds
remaining on the lease. No competing SQLite writer heartbeat is issued during
the child's whole-batch transaction. Startup, final commit and parent receipt
checks bind request, audit, command, job, attempt and fencing token. Finalization
rechecks deadline, cancellation, lease and filesystem recovery lock with the
transaction still held. Expiry, stale revision, invalid evidence or cancellation
cannot leave partial facts/outcomes or a successful job.

Preview publishes its original batch/rows/manifest but rolls back all dry-run
financial effects. Confirmation publishes all ledger facts, outcomes, audit,
background result and job/attempt success atomically. There is no per-chunk
financial commit. A crash after commit is resolved from the database receipt,
never from child stdout or exit status. Recovery mode permits private reads but
does not start or finalize new work.

Background-owned batches cannot use the old synchronous confirmation endpoint;
it must fail with `CSV_BACKGROUND_CONFIRM_REQUIRED`. The executor uses the
existing inner confirmation engine within its own fenced transaction. The main
CSV workspace now uses these background commands. The explicitly selected legacy
recovery panel cannot create new synchronous CSV previews; it only retains old
current-session recovery behavior. The legacy API and standard JSON importer are
not removed, and their existence is not an automatic fallback for new CSV work.

## Results and queries

`csv_background_results` binds request, job, successful attempt and real batch
to a canonical `csv-background-result-v1` summary:

```text
request_id, operation, input_hash, batch_id, preview_hash, expected_revision,
batch_status, row_count, error_count, review_hash, required_review_count,
confirmed_revision (nullable), receipts_hash (nullable)
```

The ordinary job result is a small envelope with exactly `schema_version:
csv-background-job-result-v1`, `request_id`, `operation`, `batch_id` and
`result_hash`. The last hash binds the separate full summary and actual domain
evidence; stdout is not a substitute for that proof.

The result never treats queue acceptance as import completion. Summary queries
report actual request/job state and attempt count without inventing percentages.
Two explicit confirmations accepted before a batch completes may resolve to the
same independently verified, same-review historical receipts. The later request
does not book those facts again. `succeeded` means processing completed, not that
new events were created; `row_count` counts source rows, not new events from this
request. Multiple request results must not be summed as imported financial facts.
Rows, duplicate candidates and actual receipts use bounded server-side pages,
bound to the immutable request/result/batch/review identity. Queries do not return
the raw original confirmation payload or the original upload buffer. Page reads
are owner/portfolio scoped and require the current session binding; no global
latest-batch fallback is permitted. Invalid result/domain evidence fails closed.

## HTTP transport and bounded pages

The endpoint is `/api/workbench/csv/jobs`. Every GET and POST requires the current
`X-Workbench-Session-Binding`; mutations additionally require the authenticated
same origin. Responses are `private, no-store` and vary on Cookie. An accepted
request returns HTTP 200 with a queued acceptance receipt, not a completed batch.
An exact replay returns that original receipt even if execution has since ended;
the status GET is authoritative for execution state.

- Preview POST is multipart with exactly `portfolio_id`, `account_id`,
  `expected_revision`, `mapping` and `file`. It additionally requires
  `X-CSV-Idempotency-Key` and `X-CSV-Background-Acknowledged: true`.
  The current browser sends an inert file-part filename `upload.csv` and carries
  the original name in `X-CSV-Original-Filename`: canonical unpadded base64url of
  its UTF-8 bytes. This background-only optional header is strictly decoded and
  bounded (800 bytes / 200 UTF-16 units, no existing forbidden controls); when
  present, any other file-part filename is rejected. The decoded original name
  still participates in the existing immutable input hash. Missing-header callers
  retain the original parser-filename behavior; the shared legacy upload parser
  and the five allowed multipart fields are unchanged.
  The outer transport limit is 5 MiB; inner CSV and mapping bounds still apply.
- Confirmation POST is JSON `{action:"confirm", command:{portfolio_id,
  account_id, idempotency_key, payload_text,
  acknowledge_background_execution:true}}`. The original confirmation text is
  bounded to 5 MiB UTF-8. The JSON transport limit is 31 MiB to permit six-byte
  JSON escaping of every original byte plus bounded envelope overhead; this does
  not raise the inner payload limit.
- Cancellation POST is JSON `{action:"cancel", command:{portfolio_id,
  request_id, reason}}`. Neither action accepts caller identity, a result or a
  replacement deadline.
- GET `?portfolio=P` lists requests. Adding `request=R` reads one status;
  `view=preview` reads bounded, proved metadata including the current batch status
  and ledger revision, not just the immutable historical result status.
  `view=rows|candidates|receipts` reads a page. Candidate queries also require a
  source `row` and `kind` (`exact_event_ids`, `possible_event_ids`,
  `exact_prior_rows` or `possible_prior_rows`). Unknown/duplicate query fields
  are rejected, not silently ignored. Only row queries accept `review_only=true`
  or `false`; filtering uses the sealed required-review row numbers and SQL LIMIT.
  Rows expose candidate counts, not complete candidate arrays.

The page schema is `csv-background-page-v1`. List, row, candidate and receipt
limits are respectively 20, 25, 100 and 25, with an 8 MiB response ceiling.
Domain-page cursors bind actor, portfolio, request, immutable result hash, view
and candidate row/kind; row cursors also bind the review-only filter. List cursors
use stable creation-time/ID ordering.
Rows and receipts use SQL-limited extraction; candidate arrays are sliced only
after validating their immutable manifest. The existing full-domain result proof
still runs before page extraction. Bounded response size therefore does not mean
bounded proof CPU or establish the query latency target.

## Main workspace and browser boundary

Preview and confirmation each require a separate, initially unchecked durable
delegation. A third acknowledgement covers complete human review of the original
records, mapping and duplicate candidates. Required row decisions must all be
provided, with reasons and exact candidates selected from verified pages. Visiting
pages is not treated as proof that a human reviewed every record. Files, mappings,
review drafts and pending retry bytes are memory-only; no local storage persists
them. Current-batch status prevents an old successful preview from being treated
as permission to confirm a batch that has since been confirmed.

The browser freezes immutable file bytes, raw mapping text or original confirmation
text, scope, revision and idempotency key before submission. An ambiguous response
does not create a new key or a synchronous fallback. Only an explicit unchanged
retry is permitted within the original session. Clearing the page discards local
retry information, not server authorization. A new session can explicitly inspect
restricted task history and freshly review a successful preview; it does not
recover or replay the old session's original confirmation request.

Preview uses a frozen multipart Blob rather than native FormData string parts:
the latter normalize mapping LF to CRLF and change its authorized input hash.
The multipart boundary is checked against the original content. An inert ASCII
file-part filename plus the strict original-name header preserves Unicode,
quotes, backslashes, leading BOM and literal percent sequences without depending
on platform filename unescaping. In particular, do not emit `filename*` here:
[RFC 7578 section 4.2](https://www.rfc-editor.org/rfc/rfc7578#section-4.2) prohibits
it for multipart/form-data, and Node 22 rejected the former dual-filename header
that Node 25 accepted. Retries reuse the same immutable wire body and header.
Route-level tests must exercise this transport, not only call the service directly
with the intended original strings. Pure transport tests also run without native
SQLite dependencies so supported Node runtimes can execute their real parsers.

Network helpers probe the current session before and after requests, carry the
binding header, and check the component operation epoch after asynchronous work
and immediately before POST. A scope/session change during hashing or a session
probe cannot send a stale write. Response bodies use bounded strict JSON/UTF-8
reading; cancellation of a rejected stream is not awaited indefinitely. Runtime
schemas reject unknown fields and bind pages to the verified request/result/review
identity. The browser recomputes immutable result/input hashes; this supplements,
not replaces, the server's full ledger/evidence proof. Displayed row commands use
a browser-only CSV projection schema without runtime code generation.

Each public GET or POST has one 30-second monotonic deadline covering both
session probes, response reading and hash verification. Timeout aborts the local
transport and releases the UI wait; an explicit, unchanged retry remains the
only write retry. Late transport or crypto completion cannot publish state or
send a stale POST, including when the timer callback itself is delayed. A local
timeout does not revoke work already accepted by the server: inspect status or
explicitly cancel according to the durable-work rules above.

Task history, status refresh, row/candidate/receipt pagination and page restoration
are read-only requests. The UI does not claim accepted `queued` receipts are
completed accounting. Recovery mode disables all background submissions, retries
and cancellations while permitting evidence queries. Original CSV and mapping
downloads remain explicit uses of the existing authenticated attachment API;
downloading an attachment is not restoration of an old confirmation authorization.

This migration does not itself certify native desktop/mobile, accessibility,
fault, full workload or production acceptance. Those require their own frozen
runtime evidence rather than component callback tests alone.

## Acceptance remaining

Required regression covers authenticated input freezing, strict fields/limits,
exact and conflicting retries, archive-without-approval, cross-session limited
recovery, real dispatch/child completion, lease expiry/stale worker, queued cancel,
cancel/commit race, deadline/recovery lock, partial failure rollback, process
restart, committed-response loss, legacy-path rejection and pagination isolation.

The final performance run still uses 10 accounts, 1,000 securities, 2 million
market rows and 50,000 facts with concurrent work and the full 10,000-row preview
and confirmation. Record environment, cold/warm latency, p50/p95/p99, failures,
lock waits and resources. Mapper microbenchmarks or backgrounding a long write
transaction do not prove the 60-second import or 1-second atomic-command goals.
Native desktop/mobile UI and production deployment remain separate gates.

### Retained v23 full-size measurement

`artifacts/verification/csv-background-v23/benchmark-fullscale-2.json` records a
frozen-source, isolated synthetic run on macOS arm64, Node v25.7.0, 10 logical
CPUs and 16 GiB RAM. Its SHA256 is
`5543b89ce8f229b385c4fd63050dee2d07c25d44ac1e9455d30fc432aceaa148`.
The database contained exactly 10 accounts, 1,000 listings, 2,000,000 reconstructed
market observations and 50,000 actual synthetic ledger events before the import.
One 10,000-row preview took 8.928 seconds and one confirmation took 9.316 seconds,
including the real Python dispatcher, fixed Node child and parent receipt check.
All 10,000 unique import receipts and the exact resulting cash balance matched.
Both application and measurement source inventories remained unchanged.

This is **not performance acceptance**: concurrent unrelated-portfolio writes
still produced two `database is locked` errors, each after about 5.42 seconds.
Only 61 and 92 read/write probe pairs occurred during preview and confirmation;
847 additional pairs ran while idle. Their distributions are recorded separately,
not combined into a claim of 1,000 concurrent samples. Import operations were not
repeated for warm/cold distributions. HTTP query/approval/valuation load and child
resource utilization are not measured; parent resource usage is not total worker
usage. The earlier full-size run is retained as an exploratory, source-drifting
baseline, not silently replaced by this measurement.

The remaining implementation must shorten main-database writer occupancy without
weakening immutable-input checks, current-revision CAS or whole-batch atomicity.
Increasing SQLite timeouts, deleting integrity proofs or splitting financial
commits into chunks is not an accepted substitute. Main UI conversion and native
workflow checks must explicitly disclose durable delegation and cancellation
semantics before any accepted preview or confirmation.

### Writer-cost optimization and independent probes

The v23 follow-up caches compiled ledger SQL per database object and at most 64
timezone formatter objects. No data, scope decision, parameter binding, clock,
revision or source receipt is cached. The CSV row/outcome INSERT and receipt-audit
SELECT statements are prepared once per loop. Original SQL execution and final
full-domain proofs remain in the same atomic transaction; neither busy_timeout
nor financial commit boundaries change.

`profile-baseline-1.json`, `profile-optimized-1.json` and
`profile-optimized-1-comparison.json` in the same local evidence directory retain
the source-profile measurements and their differing instrumentation. The optimized
writer intervals were 3.835 / 3.273 seconds. The seed phase warmed that shared
connection's statement cache; do not treat those intervals as fresh-process
worker latency or a full workload result.

The `csv-background-benchmark-v2` report starts separate read and write probe
processes before each real Python/fixed-Node execution. It records process IDs,
monotonic start/end timestamps, unchanged 5,000ms busy_timeout, operation errors,
phase containment and sample shortfalls. `--probe-samples` is the minimum target
per kind per execution phase, not a request to append idle samples.
`--idle-probe-samples` explicitly enables a separate idle baseline and defaults to
zero. Probes are closed-loop with a 20ms delay after each operation, so long writes
reduce the number of attempts; they are not an open-loop arrival-rate test.
Worker wall time and probe waits do not directly measure the fixed child's
transaction-lock interval, which is explicitly marked `NOT_MEASURED`.

The first source- and bundle-frozen optimized full-size run is
`artifacts/verification/csv-background-v23/benchmark-optimized-independent-1.json`,
SHA256 `76ac14ef4e82266681300f9b728b2cbac24ca3d12e55a6d815ebe8ae37e3ecfd`.
Preview / confirmation took 4.875 / 5.522 seconds. Independent active-phase probes
recorded 222 / 252 reads and 54 / 99 successful writes, with no errors and no idle
samples. The 10,000 unique receipts, all 153 committed probe facts and exact
synthetic cash balance matched. Nevertheless, maximum write latency was
3.584 / 3.246 seconds and none of the four 1,000-sample targets was reached.
This is a reproducible scoped improvement, **not concurrent-performance
acceptance**. HTTP/approval/valuation load, target-host limits, repeated warm/cold
distributions, UI/native workflow and production checks remain open.

A second independently seeded database and fresh worker processes reproduced the
same correctness checks with no source, measurement or bundle drift:
`artifacts/verification/csv-background-v23/benchmark-optimized-independent-2.json`,
SHA256 `7eca82ea156f2645c99d45ee9bee0efebffc746d53b538c87436893795b656d1`.
Preview / confirmation took 5.389 / 6.173 seconds; active reads numbered 246 / 282
and successful writes 57 / 96, again with no errors or idle padding. Maximum write
waits were still 4.046 / 3.928 seconds. Two fresh-worker runs do not establish a
warm/cold distribution or satisfy the 1,000-operation-per-kind workload gate.
