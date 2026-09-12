import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { governanceFixture, human, now } from "./governance-fixture";
import { hash, revision } from "../src/server/ledger/service";
import { saveSchedule, setScheduleStatus } from "../src/server/evaluation/service";
import type { EvaluationScheduleDefinition } from "../src/server/evaluation/schemas";

const root = path.resolve(".."), publisher = path.resolve("dist/monthly-evaluation.mjs");
const scheduled = "2026-01-05T12:01:00.000000Z";
const deadline = "2026-01-05T13:01:00.000000Z";
const python = process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3";

const claimScript = `
import json, sys
from dataclasses import asdict
from worker.orchestration.db import open_database
from worker.orchestration.evaluations import discover_due_cycles
from worker.orchestration.runtime import sync_requests
from worker.orchestration.jobs import claim_job
db = open_database(sys.argv[1])
try:
    cycles = discover_due_cycles(db, now=sys.argv[2])
    sync_requests(db, now=sys.argv[2])
    lease = claim_job(db, 'synthetic-fixed-cli-integration', lease_seconds=60, job_type='monthly_evaluation')
    assert lease is not None
    print(json.dumps({'cycles': cycles, 'lease': asdict(lease)}))
finally:
    db.close()
`;

const publishScript = `
import json, sys
from worker.orchestration.db import open_database
from worker.orchestration.external import publish_monthly, committed_monthly_job
from worker.orchestration.jobs import Lease, ExternalCommit
db = open_database(sys.argv[1])
try:
    lease = Lease(**json.loads(sys.argv[2]))
    job = dict(db.execute('SELECT * FROM job_runs WHERE id=?', (lease.job_id,)).fetchone())
    assert not db.in_transaction
    committed = publish_monthly(db, job, lease, lease_seconds=60, max_run_seconds=15)
    assert isinstance(committed, ExternalCommit)
    receipt = committed_monthly_job(db, lease)
    assert receipt is not None
    print(json.dumps({'bridge': type(committed).__name__, 'job': receipt, 'result': json.loads(receipt['result_json'])}))
finally:
    db.close()
`;

const pollScript = `
import json, sys
from worker.orchestration.db import open_database
from worker.orchestration.runtime import run_pending_once
db = open_database(sys.argv[1])
try:
    print(json.dumps(run_pending_once(db, 'synthetic-fixed-cli-restart')))
finally:
    db.close()
`;

interface Lease { job_id: string; owner: string; fencing_token: number; attempt: number; lease_until: string }
interface JobResult {
  schema_version: "monthly-evaluation-job-result-v1"; cycle_id: string; evaluation_attempt_id: string;
  outcome: "blocked"; proposal_id: null;
}
type Fixture = ReturnType<typeof fixture>;

function fixture(t: { after(callback: () => void): void }) {
  assert.ok(existsSync(publisher), "Build the fixed monthly publisher bundle before running this integration test");
  assert.ok(Date.now() > Date.parse(deadline), "This fixture intentionally tests a genuinely expired historical deadline");
  const f = governanceFixture(undefined, "0", "42000", true); t.after(f.close);
  const definition: EvaluationScheduleDefinition = {
    schema_version: "evaluation-schedule-v1", environment: "actual", frequency: "monthly",
    policy_version_id: f.policyVersion.id, strategy_version_id: f.strategyVersion.id, activation_id: f.activated!.id,
    timezone: "UTC", start_month: "2026-01", end_month: "2026-01",
    trigger: { day: 5, hour: 12, minute: 1 }, deadline_seconds: 3600, max_attempts: 3,
    targets: { method: "manual_weight_targets_v1", weight_basis: "portfolio_nav",
      rows: [{ account_id: f.account, listing_id: "l", currency: "CNY", weight: "0.5" }],
      absolute_tolerance_cny: "0", weight_tolerance: "0", tolerance_rule: "max_absolute_or_weight",
      unlisted_strategy_positions: "block", pending_activity: "block", price_rule: "close_rounded_to_step", quantity_rule: "floor_to_step" },
  };
  const saved = saveSchedule(f.db, human, { ...f.envelope(), expected_schedule_id: null, expected_schedule_revision: 0, definition_json: JSON.stringify(definition) }, { now });
  setScheduleStatus(f.db, human, { ...f.envelope(), schedule_id: saved.schedule_id, expected_schedule_revision: 1, status: "enabled" }, { now: "2026-01-05T12:00:30.000Z" });
  return { ...f, saved };
}

function environment(f: Fixture): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    WORKBENCH_DB_PATH: f.filename, WORKBENCH_DATA_DIR: f.dataDir, WORKBENCH_MODE: "ledger" };
}

function runPython<T>(f: Fixture, script: string, ...args: string[]): T {
  const child = spawnSync(python, ["-c", script, f.filename, ...args], {
    cwd: root, env: environment(f), encoding: "utf8", timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return JSON.parse(child.stdout) as T;
}

function claim(f: Fixture): { cycle: string; lease: Lease } {
  const value = runPython<{ cycles: string[]; lease: Lease }>(f, claimScript, scheduled);
  assert.equal(value.cycles.length, 1);
  assert.equal(value.lease.attempt, 1);
  assert.ok(Date.parse(value.lease.lease_until) > Date.now());
  return { cycle: value.cycles[0], lease: value.lease };
}

function tableCounts(f: Fixture, tables: string[]) {
  return Object.fromEntries(tables.map(table => [table, (f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n]));
}

function databaseSnapshot(f: Fixture) {
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return hash(tables.map(({ name }) => ({ table: name, rows: f.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all() })));
}

function financialSnapshot(f: Fixture, tables: string[]) {
  return hash(tables.map(table => ({ table, rows: f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() })));
}

test("real Python Popen bridge and fixed Node CLI atomically persist a truthful deadline block", t => {
  const f = fixture(t), initialRevision = revision(f.db, f.portfolio);
  const unaffectedTables = ["ledger_events", "postings", "position_movements", "security_transit_movements", "funding_plan_versions",
    "proposals", "proposal_items", "risk_runs", "approval_events", "reservations", "execution_reports", "account_projections", "position_projections"];
  const runtimeTables = ["evaluation_cycles", "evaluation_cycle_requests", "evaluation_attempts", "job_runs", "job_attempts", "outbox"];
  const before = tableCounts(f, unaffectedTables), financialBefore = financialSnapshot(f, unaffectedTables);
  const runtimeBefore = tableCounts(f, runtimeTables), { cycle, lease } = claim(f);
  const executed = runPython<{ bridge: string; job: { status: string }; result: JobResult }>(f, publishScript, JSON.stringify(lease));
  assert.equal(executed.bridge, "ExternalCommit");
  assert.equal(executed.job.status, "succeeded");
  assert.deepEqual(executed.result, { schema_version: "monthly-evaluation-job-result-v1", cycle_id: cycle,
    evaluation_attempt_id: executed.result.evaluation_attempt_id, outcome: "blocked", proposal_id: null });
  assert.equal(revision(f.db, f.portfolio), initialRevision);
  assert.deepEqual(tableCounts(f, unaffectedTables), before);
  assert.equal(financialSnapshot(f, unaffectedTables), financialBefore);
  assert.deepEqual(tableCounts(f, runtimeTables), Object.fromEntries(runtimeTables.map(table => [table, runtimeBefore[table] + 1])));
  const storedCycle = f.db.prepare("SELECT * FROM evaluation_cycles WHERE id=?").get(cycle) as {
    status: string; outcome: string; scheduled_at: string; cutoff_at: string; knowledge_at: string; deadline_at: string;
    terminal_attempt_id: string; completed_at: string;
  };
  assert.equal(storedCycle.status, "blocked"); assert.equal(storedCycle.outcome, "blocked");
  assert.equal(storedCycle.scheduled_at, scheduled); assert.equal(storedCycle.cutoff_at, scheduled); assert.equal(storedCycle.knowledge_at, scheduled);
  assert.equal(storedCycle.deadline_at, deadline); assert.equal(storedCycle.terminal_attempt_id, executed.result.evaluation_attempt_id);
  const attempt = f.db.prepare("SELECT * FROM evaluation_attempts WHERE id=?").get(executed.result.evaluation_attempt_id) as {
    status: string; job_attempt_id: string; input_manifest: string; input_hash: string; result_json: string; result_hash: string; completed_at: string;
  };
  assert.equal(attempt.status, "blocked");
  assert.equal(hash(JSON.parse(attempt.input_manifest)), attempt.input_hash); assert.equal(hash(JSON.parse(attempt.result_json)), attempt.result_hash);
  const result = JSON.parse(attempt.result_json) as { reason_codes: string[]; candidate_items: unknown[]; risk: unknown; broker_order_sent: boolean; late: boolean };
  assert.deepEqual(result.reason_codes, ["EVALUATION_DEADLINE_MISSED"]);
  assert.deepEqual(result.candidate_items, []); assert.equal(result.risk, null); assert.equal(result.broker_order_sent, false); assert.equal(result.late, true);
  assert.equal(attempt.completed_at, storedCycle.completed_at);
  const jobAttempt = f.db.prepare("SELECT * FROM job_attempts WHERE id=?").get(attempt.job_attempt_id) as {
    job_id: string; status: string; fencing_token: number; attempt: number; started_at: string; finished_at: string;
  };
  assert.equal(jobAttempt.job_id, lease.job_id); assert.equal(jobAttempt.status, "succeeded");
  assert.equal(jobAttempt.fencing_token, lease.fencing_token); assert.equal(jobAttempt.attempt, lease.attempt);
  assert.equal(jobAttempt.finished_at, attempt.completed_at); assert.ok(Date.parse(jobAttempt.started_at) > Date.parse(deadline));
  const job = f.db.prepare("SELECT * FROM job_runs WHERE id=?").get(lease.job_id) as {
    status: string; fencing_token: number; attempt_count: number; lease_owner: null; lease_until: null; result_json: string;
  };
  assert.equal(job.status, "succeeded"); assert.equal(job.fencing_token, lease.fencing_token); assert.equal(job.attempt_count, lease.attempt);
  assert.equal(job.lease_owner, null); assert.equal(job.lease_until, null); assert.deepEqual(JSON.parse(job.result_json), executed.result);
  const notification = f.db.prepare("SELECT topic,payload_json,status FROM outbox WHERE dedup_key=?").get(`monthly-evaluation:${executed.result.evaluation_attempt_id}`) as { topic: string; payload_json: string; status: string };
  assert.equal(notification.topic, "monthly_evaluation"); assert.equal(notification.status, "pending");
  assert.deepEqual(JSON.parse(notification.payload_json), executed.result);
  const committedSnapshot = databaseSnapshot(f);
  assert.equal(runPython(f, pollScript), null);
  assert.equal(databaseSnapshot(f), committedSnapshot, "restart/re-discovery must not repeat a completed monthly financial effect");
});

test("fixed Node CLI rejects caller clock, actor, result and database arguments before any writes", t => {
  const f = fixture(t), { lease } = claim(f), before = databaseSnapshot(f);
  const identity = ["--job-id", lease.job_id, "--lease-owner", lease.owner,
    "--fencing-token", String(lease.fencing_token), "--attempt", String(lease.attempt)];
  for (const [flag, value] of [["--clock", scheduled], ["--actor", "synthetic-human"], ["--result", '{"outcome":"unchanged"}'], ["--db", f.filename]]) {
    const child = spawnSync(process.execPath, [publisher, ...identity, flag, value], { cwd: root, env: environment(f), encoding: "utf8", timeout: 15000 });
    assert.equal(child.status, 1, `${flag}: ${child.stderr || child.error?.message}`);
    assert.equal(child.stdout, ""); assert.match(child.stderr, /^EVALUATION_WORKER_FAILED\n$/);
    assert.equal(databaseSnapshot(f), before);
  }
});

test("real Node subprocess cannot publish using the wrong fencing token", t => {
  const f = fixture(t), { lease } = claim(f), before = databaseSnapshot(f);
  const child = spawnSync(process.execPath, [publisher, "--job-id", lease.job_id, "--lease-owner", lease.owner,
    "--fencing-token", String(lease.fencing_token + 1), "--attempt", String(lease.attempt)], {
    cwd: root, env: environment(f), encoding: "utf8", timeout: 15000,
  });
  assert.equal(child.status, 1, child.stderr || child.error?.message); assert.equal(child.stdout, "");
  assert.match(child.stderr, /^STALE_OR_EXPIRED_LEASE\n$/); assert.equal(databaseSnapshot(f), before);
  assert.equal((f.db.prepare("SELECT status FROM job_runs WHERE id=?").get(lease.job_id) as { status: string }).status, "running");
});
