import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { governanceFixture, human, now } from "./governance-fixture";
import { hash, revision } from "../src/server/ledger/service";
import { approveAccountCapability, cancelRemainder } from "../src/server/governance/service";
import { saveSchedule, setScheduleStatus } from "../src/server/evaluation/service";
import { assertEvaluationLease, evaluationStamp, prepareMonthlyEvaluation, type EvaluationLease } from "../src/server/evaluation/evaluator";
import { publishMonthlyEvaluation } from "../src/server/evaluation/publisher";
import type { EvaluationScheduleDefinition } from "../src/server/evaluation/schemas";

const scheduled = "2026-01-05T12:01:00.000000Z", started = "2026-01-05T12:01:01.000000Z";
const discoverAndClaim = `
import json, sys
from dataclasses import asdict
from worker.orchestration.db import open_database
from worker.orchestration.evaluations import discover_due_cycles
from worker.orchestration.runtime import sync_requests
from worker.orchestration.jobs import claim_job
db = open_database(sys.argv[1])
cycles = discover_due_cycles(db, now=sys.argv[2])
sync_requests(db, now=sys.argv[2])
lease = claim_job(db, 'synthetic-monthly-test', job_type='monthly_evaluation', now=sys.argv[3])
print(json.dumps({'cycles': cycles, 'lease': asdict(lease) if lease else None}))
db.close()
`;
function fixture(t: { after(callback: () => void): void }, quantity = "0", cash = "80000", weight = "0.5", laterPrice?: string, targetListing = "l") {
  const f = governanceFixture(undefined, quantity, cash, true, "CNY", laterPrice); t.after(f.close);
  const definition: EvaluationScheduleDefinition = {
    schema_version: "evaluation-schedule-v1", environment: "actual", frequency: "monthly",
    policy_version_id: f.policyVersion.id, strategy_version_id: f.strategyVersion.id, activation_id: f.activated!.id,
    timezone: "UTC", start_month: "2026-01", end_month: "2026-02", trigger: { day: 5, hour: 12, minute: 1 }, deadline_seconds: 3600, max_attempts: 3,
    targets: { method: "manual_weight_targets_v1", weight_basis: "portfolio_nav", rows: [{ account_id: f.account, listing_id: targetListing, currency: "CNY", weight }],
      absolute_tolerance_cny: "0", weight_tolerance: "0", tolerance_rule: "max_absolute_or_weight", unlisted_strategy_positions: "block", pending_activity: "block", price_rule: "close_rounded_to_step", quantity_rule: "floor_to_step" },
  };
  const saved = saveSchedule(f.db, human, { ...f.envelope(), expected_schedule_id: null, expected_schedule_revision: 0, definition_json: JSON.stringify(definition) }, { now });
  setScheduleStatus(f.db, human, { ...f.envelope(), schedule_id: saved.schedule_id, expected_schedule_revision: 1, status: "enabled" }, { now: "2026-01-05T12:00:30.000Z" });
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3", ["-c", discoverAndClaim, f.filename, scheduled, started], { cwd: path.resolve(".."), encoding: "utf8", timeout: 15000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const discovered = JSON.parse(child.stdout) as { cycles: string[]; lease: EvaluationLease | null };
  assert.equal(discovered.cycles.length, 1); assert.ok(discovered.lease);
  return { ...f, definition, saved, cycle: discovered.cycles[0], lease: discovered.lease, evaluationOptions: { ...f.options, now: started } };
}
type Fixture = ReturnType<typeof fixture>;
const count = (f: Fixture, table: string) => (f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
function noPublication(f: Fixture) {
  assert.equal(count(f, "evaluation_attempts"), 0);
  assert.equal(count(f, "proposals"), 0);
  assert.equal(count(f, "reservations"), 0);
  assert.equal((f.db.prepare("SELECT status FROM job_runs WHERE id=?").get(f.lease.job_id) as { status: string }).status, "running");
}

test("actual Python discovery/claim and Node publisher produce one unapproved proposal atomically", t => {
  const f = fixture(t), before = revision(f.db, f.portfolio), events = count(f, "ledger_events");
  const prepared = prepareMonthlyEvaluation(f.db, f.lease, f.evaluationOptions);
  assert.equal(prepared.outcome, "proposed", JSON.stringify(prepared.reason_codes));
  assert.equal(count(f, "proposals"), 0);
  const result = publishMonthlyEvaluation(f.db, f.lease, f.evaluationOptions);
  assert.equal(result.outcome, "proposed"); assert.ok(result.proposal_id);
  assert.equal(revision(f.db, f.portfolio), before); assert.equal(count(f, "ledger_events"), events);
  assert.equal(count(f, "reservations"), 0); assert.equal(count(f, "approval_events"), 0);
  assert.equal(count(f, "proposals"), 1); assert.equal(count(f, "evaluation_attempts"), 1);
  const item = f.db.prepare("SELECT side,quantity FROM proposal_items WHERE proposal_id=?").get(result.proposal_id);
  assert.deepEqual(item, { side: "buy", quantity: "400" });
  const attempt = f.db.prepare("SELECT * FROM evaluation_attempts WHERE id=?").get(result.evaluation_attempt_id) as { input_manifest: string; input_hash: string; result_json: string; result_hash: string };
  assert.equal(hash(JSON.parse(attempt.input_manifest)), attempt.input_hash); assert.equal(hash(JSON.parse(attempt.result_json)), attempt.result_hash);
  const job = f.db.prepare("SELECT status,result_json,lease_owner FROM job_runs WHERE id=?").get(f.lease.job_id) as { status: string; result_json: string; lease_owner: string | null };
  assert.equal(job.status, "succeeded"); assert.equal(job.lease_owner, null); assert.deepEqual(JSON.parse(job.result_json), result);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM outbox WHERE dedup_key=?").get(`monthly-evaluation:${result.evaluation_attempt_id}`) as { n: number }).n, 1);
  assert.throws(() => publishMonthlyEvaluation(f.db, f.lease, f.evaluationOptions), /STALE_OR_EXPIRED_LEASE/);
  assert.equal(count(f, "proposals"), 1);
  f.publish("manual_verified", "125");
  const nextDay = "2026-01-06T12:01:00.000000Z";
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3", ["-c", discoverAndClaim, f.filename, nextDay, nextDay], { cwd: path.resolve(".."), encoding: "utf8", timeout: 15000 });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), { cycles: [], lease: null });
  assert.equal(count(f, "evaluation_cycles"), 1); assert.equal(count(f, "proposals"), 1);
});

test("unchanged requires a complete explicit target comparison and risk pass, not just zero orders", t => {
  const f = fixture(t, "400", "40000"), result = publishMonthlyEvaluation(f.db, f.lease, f.evaluationOptions);
  assert.equal(result.outcome, "unchanged"); assert.equal(result.proposal_id, null);
  const stored = f.db.prepare("SELECT result_json FROM evaluation_attempts WHERE id=?").get(result.evaluation_attempt_id) as { result_json: string };
  const body = JSON.parse(stored.result_json);
  assert.equal(body.comparison_rows.length, 1); assert.equal(body.comparison_rows[0].within_tolerance, true);
  assert.equal(body.risk.status, "pass"); assert.equal(body.broker_order_sent, false);
  assert.equal(count(f, "proposals"), 0); assert.equal(count(f, "reservations"), 0);
});

test("out-of-tolerance dust becomes a terminal blocked attempt, never unchanged", t => {
  const f = fixture(t, "0", "80000", "0.01"), result = publishMonthlyEvaluation(f.db, f.lease, f.evaluationOptions);
  assert.equal(result.outcome, "blocked"); assert.equal(result.proposal_id, null);
  const stored = f.db.prepare("SELECT result_json FROM evaluation_attempts WHERE id=?").get(result.evaluation_attempt_id) as { result_json: string };
  assert.deepEqual(JSON.parse(stored.result_json).reason_codes, ["EVALUATION_DIFFERENCE_BELOW_TRADING_UNIT"]);
  assert.equal(count(f, "proposals"), 0); assert.equal(count(f, "approval_events"), 0);
});

test("an expired original pending proposal still blocks a delayed evaluation", t => {
  const f = fixture(t, "400", "40000");
  f.proposal("100");
  f.db.prepare("UPDATE job_runs SET lease_until='2026-01-05T13:00:00.000000Z' WHERE id=?").run(f.lease.job_id);
  const result = prepareMonthlyEvaluation(f.db, f.lease, { ...f.evaluationOptions, now: "2026-01-05T12:31:00.000000Z" });
  assert.equal(result.outcome, "blocked"); assert.deepEqual(result.reason_codes, ["EVALUATION_PENDING_ACTIVITY"]);
});

test("post-cutoff cancellation cannot erase original pending activity", t => {
  const f = fixture(t, "400", "40000"), proposal = f.proposal("100"); f.approve(proposal);
  cancelRemainder(f.db, human, { ...f.envelope(), proposal_id: proposal.id }, { ...f.options, now: started });
  const result = prepareMonthlyEvaluation(f.db, f.lease, f.evaluationOptions);
  assert.equal(result.outcome, "blocked"); assert.deepEqual(result.reason_codes, ["EVALUATION_INPUT_KNOWN_AFTER_CUTOFF"]);
});

test("same-session newer prices cannot mix target values with an older NAV vector", t => {
  const f = fixture(t, "400", "40000", "0.625", "125");
  const prepared = prepareMonthlyEvaluation(f.db, f.lease, f.evaluationOptions);
  assert.equal(prepared.outcome, "blocked");
  assert.deepEqual(prepared.reason_codes, ["EVALUATION_VALUATION_PRICE_VECTOR_MISMATCH"]);
  const result = publishMonthlyEvaluation(f.db, f.lease, f.evaluationOptions);
  assert.equal(result.outcome, "blocked"); assert.equal(result.proposal_id, null);
  assert.equal(count(f, "proposals"), 0);
});

test("omitted owned strategy positions block instead of implicitly targeting zero", t => {
  const f = fixture(t, "400", "40000", "0", undefined, "l2");
  const prepared = prepareMonthlyEvaluation(f.db, f.lease, f.evaluationOptions);
  assert.equal(prepared.outcome, "blocked"); assert.deepEqual(prepared.reason_codes, ["EVALUATION_TARGET_SCOPE_INCOMPLETE"]);
  noPublication(f);
});

test("zero unheld targets still require actual account permission evidence", t => {
  const f = fixture(t, "0", "80000", "0");
  f.db.prepare("UPDATE account_capabilities SET valid_to='2026-01-05T12:00:30.000Z' WHERE account_id=?").run(f.account);
  approveAccountCapability(f.db, human, { ...f.envelope(), account_id: f.account, market: "CN", valid_until: "2026-02-01T00:00:00.000Z", attachment_id: f.sourceEvidence,
    rules: { listing_ids: ["l", "l2"], currencies: ["CNY"], buy: false, sell: true, cash_holds_exclude_workbench_reservations: true, cash_holds_exclude_trade_payables: true } }, { ...f.options, now: "2026-01-05T12:00:31.000Z" });
  const prepared = prepareMonthlyEvaluation(f.db, f.lease, f.evaluationOptions);
  assert.equal(prepared.outcome, "blocked"); assert.notDeepEqual(prepared.reason_codes, ["EXPLICIT_TARGETS_WITHIN_TOLERANCE"]);
  assert.match(prepared.reason_codes[0], /ACCOUNT_/); noPublication(f);
});

test("permission known in advance cannot take effect one microsecond after the cycle boundary", t => {
  const f = fixture(t, "0", "80000", "0");
  f.db.prepare("UPDATE account_capabilities SET valid_from='2026-01-05T12:01:00.000001Z' WHERE account_id=?").run(f.account);
  const prepared = prepareMonthlyEvaluation(f.db, f.lease, f.evaluationOptions);
  assert.equal(prepared.outcome, "blocked"); assert.deepEqual(prepared.reason_codes, ["EVALUATION_INPUT_KNOWN_AFTER_CUTOFF"]); noPublication(f);
});

test("unchanged cannot use permission that has expired since the original boundary", t => {
  const f = fixture(t, "0", "80000", "0");
  f.db.prepare("UPDATE account_capabilities SET valid_to='2026-01-05T12:01:00.999999Z' WHERE account_id=?").run(f.account);
  const prepared = prepareMonthlyEvaluation(f.db, f.lease, f.evaluationOptions);
  assert.equal(prepared.outcome, "blocked"); assert.deepEqual(prepared.reason_codes, ["EVALUATION_AUTHORIZATION_EXPIRED"]); noPublication(f);
});

test("gate attachment metadata first known after the boundary is not accepted as historical evidence", t => {
  const f = fixture(t, "400", "40000");
  f.db.prepare("UPDATE attachments SET created_at='2026-01-05T12:01:00.000001Z' WHERE id=?").run(f.gates["G-01"]);
  const prepared = prepareMonthlyEvaluation(f.db, f.lease, f.evaluationOptions);
  assert.equal(prepared.outcome, "blocked"); assert.deepEqual(prepared.reason_codes, ["EVALUATION_INPUT_KNOWN_AFTER_CUTOFF"]); noPublication(f);
});

test("lease boundaries preserve microseconds and reject an exact expiry", t => {
  const f = fixture(t);
  f.db.prepare("UPDATE job_runs SET lease_until='2026-01-05T12:01:01.000001Z' WHERE id=?").run(f.lease.job_id);
  assertEvaluationLease(f.db, f.lease, started);
  assert.throws(() => assertEvaluationLease(f.db, f.lease, "2026-01-05T12:01:01.000001Z"), /STALE_OR_EXPIRED_LEASE/);
  assert.equal(evaluationStamp("2026-01-05T12:01:01Z"), started);
  for (const invalid of ["2026-02-30T00:00:00Z", "2026-01-05T12:01:01.1234567Z", "2026-01-05T12:01:01+00:00"]) assert.throws(() => evaluationStamp(invalid), /EVALUATION_TIME_INVALID/);
});

test("changed financial inputs between preparation and commit roll back the whole publication", t => {
  const f = fixture(t);
  assert.throws(() => publishMonthlyEvaluation(f.db, f.lease, { ...f.evaluationOptions, beforeCommit: () => {
    f.db.prepare("UPDATE accounts SET status='reconciliation_required' WHERE id=?").run(f.account);
  } }), /EVALUATION_INPUT_CHANGED/);
  noPublication(f);
});

test("paused schedules, restore markers, and a final expired lease never leave partial results", t => {
  const f = fixture(t);
  assert.throws(() => publishMonthlyEvaluation(f.db, f.lease, { ...f.evaluationOptions, beforeCommit: () => {
    setScheduleStatus(f.db, human, { ...f.envelope(), schedule_id: f.saved.schedule_id, expected_schedule_revision: 2, status: "paused" }, { now: started });
  } }), /EVALUATION_SCHEDULE_NOT_ENABLED/);
  noPublication(f);
  setScheduleStatus(f.db, human, { ...f.envelope(), schedule_id: f.saved.schedule_id, expected_schedule_revision: 3, status: "enabled" }, { now: started });
  let calls = 0;
  assert.throws(() => publishMonthlyEvaluation(f.db, f.lease, { ...f.evaluationOptions, clock: () => ++calls < 3 ? started : "2026-01-05T12:02:01.000000Z" }), /STALE_OR_EXPIRED_LEASE/);
  noPublication(f);
  assert.throws(() => publishMonthlyEvaluation(f.db, f.lease, { ...f.evaluationOptions, beforeCommit: () => writeFileSync(path.join(f.dataDir, "RESTORE_PENDING_REVIEW"), "SYNTHETIC ONLY", { mode: 0o600 }) }), /WORKBENCH_READ_ONLY/);
  noPublication(f);
});

test("commit-time deadline is enforced even when the worker lease remains valid", t => {
  const f = fixture(t);
  f.db.prepare("UPDATE job_runs SET lease_until='2026-01-05T14:00:00.000000Z' WHERE id=?").run(f.lease.job_id);
  let calls = 0;
  assert.throws(() => publishMonthlyEvaluation(f.db, f.lease, { ...f.evaluationOptions, clock: () => ++calls < 3 ? started : "2026-01-05T13:01:00.000000Z" }), /EVALUATION_DEADLINE_MISSED/);
  noPublication(f);
});
