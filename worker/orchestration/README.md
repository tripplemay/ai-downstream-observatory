# Persistent, fenced command worker

The worker reads explicitly created `command_requests`. It does not create
investment policies, account facts, actual trades or activated strategies.
No job exists just because a new day/month began, and a historical period is
never relabeled as a timely decision that was not actually made.

```sh
python -m worker.orchestration --db /absolute/path/workbench.db --once
python -m worker.orchestration --db /absolute/path/workbench.db --poll-seconds 5
```

Long-running mode exits on SIGTERM/SIGINT and only dispatches supported command
types below. `--once` returns 2 for a terminal partial/failed result and 1 for an
exception; daemon mode logs the failed attempt and keeps running. There is no
external fetch, AI invocation, broker execution or actual email transport.

## Authenticated command requests

Web owns creation of `command_requests`, actor identity, authorization and
idempotency. Worker checks the canonical payload hash and portfolio scope.
JSON property names use ASCII code-unit order and UTF-8 unescaped values for
cross-language hashes. Monetary fields are always decimal strings.

| `command_type` | `payload_json` |
| --- | --- |
| `valuation` | `{ "cutoff_at": "...Z", "rules": { shared valuation-rules schema }, "mode": "as_known" }`; mode optional, `restated` supported |
| `market_ingest` | `{ "document": { shared market-batch schema }, "publish": true }` |
| `performance` | `{ "valuation_ids": ["earlier-id", "later-id"], "evaluation_timezone": "Asia/Shanghai" }` |

The job scope is the request portfolio, period is the request's creation date,
and input version binds request ID and payload hash. Repeated dispatch cannot
duplicate a task. Unsupported command types and another module's jobs are not
claimed. A partial ingestion persists its original evidence and terminal partial
outcome, not success or a new publication. A successfully computed blocked
valuation is a successful computation with `quality=blocked`, not permission
to execute an investment recommendation.

## Python API

- `enqueue_job`: unique `(job_type, scope, period, input_version)`; differing
  retry settings/request identity conflict rather than silently replace a job.
- `claim_job`: one SQLite write transaction handles expired attempts, bounded
  retries, owner, monotone fencing token and new attempt. Each attempt is kept.
- `heartbeat`: extends a currently valid lease; cannot resurrect an expired one.
- `complete_job`: checks owner/token/attempt/lease before and after the commit
  effect; result writes and optional outbox insertion commit atomically.
  `JobCommit` lets the effect report a terminal partial/failed outcome honestly.
- `fail_job`: failed attempt is recorded; bounded exponential retry or terminal
  failure/partial state. Failures are never translated into successful dates.
- `run_one`: long preparation is outside the write transaction. Return a short
  `effect(db)` for fenced writes; services can use nested savepoints safely.
- `enqueue_notification`: records a pending outbox entry with immutable semantic
  dedup key. It sends nothing; same key/different payload conflicts. External
  delivery is a separate future adapter and must retain at-least-once/uncertain
  outcomes rather than claiming exactly-once email delivery.

The default lease is 300 seconds for the command dispatcher. Longer computation
must heartbeat or use a sufficiently validated lease budget; an expired result
is discarded. Every write and commit rechecks read-only/recovery markers.

```sh
python -m unittest discover -s tests/orchestration -v
```
