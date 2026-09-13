import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { governanceFixture, human, now } from "./governance-fixture";
import { prepareExecution } from "../src/server/governance/service";
import { hash } from "../src/server/ledger/service";
import { reviewedListingAt } from "../src/server/listing-reviews/service";
import { readEvaluationListingBoundary } from "../src/server/evaluation/listing-boundary";
import { prepareMonthlyEvaluation, type EvaluationLease } from "../src/server/evaluation/evaluator";
import { publishMonthlyEvaluation } from "../src/server/evaluation/publisher";
import { getEvaluationState, retryEvaluation, saveSchedule, setScheduleStatus } from "../src/server/evaluation/service";

const scheduled = "2026-01-05T12:01:00.000000Z";
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
lease = claim_job(db, 'synthetic-listing-boundary-test', job_type='monthly_evaluation', now=sys.argv[2])
print(json.dumps({'cycles':cycles, 'lease':asdict(lease) if lease else None}))
db.close()
`;

function fixture(t: { after(callback: () => void): void }, target = "l", missing: string[] = []) {
  const f = governanceFixture(undefined, "0", "80000", true, "CNY", undefined, missing); t.after(f.close);
  const definition = {
    schema_version: "evaluation-schedule-v1", environment: "actual", frequency: "monthly",
    policy_version_id: f.policyVersion.id, strategy_version_id: f.strategyVersion.id, activation_id: f.activated!.id,
    timezone: "UTC", start_month: "2026-01", end_month: "2026-02", trigger: { day: 5, hour: 12, minute: 1 }, deadline_seconds: 3600, max_attempts: 3,
    targets: { method: "manual_weight_targets_v1", weight_basis: "portfolio_nav", rows: [{ account_id: f.account, listing_id: target, currency: "CNY", weight: "0" }],
      absolute_tolerance_cny: "0", weight_tolerance: "0", tolerance_rule: "max_absolute_or_weight", unlisted_strategy_positions: "block", pending_activity: "block", price_rule: "close_rounded_to_step", quantity_rule: "floor_to_step" },
  };
  const saved = saveSchedule(f.db, human, { ...f.envelope(), expected_schedule_id: null, expected_schedule_revision: 0, definition_json: JSON.stringify(definition) }, { now });
  setScheduleStatus(f.db, human, { ...f.envelope(), schedule_id: saved.schedule_id, expected_schedule_revision: 1, status: "enabled" }, { now: "2026-01-05T12:00:30.000Z" });
  const claim = () => {
    const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3", ["-c", discoverAndClaim, f.filename, scheduled], { cwd: path.resolve(".."), encoding: "utf8", timeout: 15000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const result = JSON.parse(child.stdout) as { cycles: string[]; lease: EvaluationLease | null };
    assert.ok(result.lease);
    const row = f.db.prepare("SELECT payload_json FROM command_requests c JOIN job_runs j ON j.command_request_id=c.id WHERE j.id=?").get(result.lease.job_id) as { payload_json: string };
    return { cycle: JSON.parse(row.payload_json).cycle_id as string, lease: result.lease };
  };
  return { ...f, claim, evaluationOptions: { ...f.options, now: scheduled } };
}
type Fixture = ReturnType<typeof fixture>;
const count = (f: Fixture, table: string) => (f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
const storedAttempt = (f: Fixture, id: string) => {
  const row = f.db.prepare("SELECT input_manifest,input_hash,result_json,result_hash FROM evaluation_attempts WHERE id=?").get(id) as { input_manifest: string; input_hash: string; result_json: string; result_hash: string };
  assert.equal(hash(JSON.parse(row.input_manifest)), row.input_hash); assert.equal(hash(JSON.parse(row.result_json)), row.result_hash);
  return { ...row, input: JSON.parse(row.input_manifest), result: JSON.parse(row.result_json) };
};

test("cycle creation freezes same-timestamp reviews already committed, without blanket rejection", t => {
  const f = fixture(t);
  const review = f.reviewListing("l", { price_step: "0.02" }, scheduled);
  const { cycle, lease } = f.claim();
  const result = publishMonthlyEvaluation(f.db, lease, f.evaluationOptions);
  assert.equal(result.outcome, "unchanged");
  const stored = storedAttempt(f, result.evaluation_attempt_id);
  const sequence = f.db.prepare("SELECT sequence FROM listing_review_sequences WHERE version_id=?").get(review.id) as { sequence: number };
  assert.equal(stored.input.listing_review_boundary.cycle_id, cycle);
  assert.equal(stored.input.listing_review_boundary.watermark_sequence, sequence.sequence);
  assert.equal(stored.input.listings[0].review.id, review.id);
  assert.equal(count(f, "proposals"), 0); assert.equal(count(f, "reservations"), 0);
});

test("same-timestamp review after discovery cannot enter the first monthly preparation", t => {
  const f = fixture(t), { cycle, lease } = f.claim();
  const before = f.db.prepare("SELECT * FROM evaluation_listing_review_boundaries WHERE cycle_id=?").get(cycle);
  f.reviewListing("l", { price_step: "0.02" }, scheduled);
  const prepared = prepareMonthlyEvaluation(f.db, lease, f.evaluationOptions);
  assert.equal(prepared.outcome, "blocked"); assert.deepEqual(prepared.reason_codes, ["LISTING_REVIEW_CHANGED"]);
  const result = publishMonthlyEvaluation(f.db, lease, f.evaluationOptions);
  assert.equal(result.outcome, "blocked"); assert.equal(result.proposal_id, null);
  assert.deepEqual(f.db.prepare("SELECT * FROM evaluation_listing_review_boundaries WHERE cycle_id=?").get(cycle), before);
  assert.equal(count(f, "proposals"), 0);
});

test("same-timestamp prepare/commit conflict stays blocked on fresh preparation and human retry", t => {
  const f = fixture(t), { cycle, lease } = f.claim();
  const original = f.db.prepare("SELECT * FROM evaluation_listing_review_boundaries WHERE cycle_id=?").get(cycle);
  assert.throws(() => publishMonthlyEvaluation(f.db, lease, { ...f.evaluationOptions,
    beforeCommit: () => f.reviewListing("l", { price_step: "0.02" }, scheduled) }), /EVALUATION_INPUT_CHANGED/);
  assert.equal(count(f, "evaluation_attempts"), 0); assert.equal(count(f, "proposals"), 0);
  const failed = publishMonthlyEvaluation(f.db, lease, f.evaluationOptions);
  assert.equal(failed.outcome, "blocked");
  assert.deepEqual(storedAttempt(f, failed.evaluation_attempt_id).result.reason_codes, ["LISTING_REVIEW_CHANGED"]);
  const state = f.db.prepare("SELECT state_revision FROM evaluation_cycles WHERE id=?").get(cycle) as { state_revision: number };
  retryEvaluation(f.db, human, { ...f.envelope(), cycle_id: cycle, expected_state_revision: state.state_revision }, { now: scheduled });
  const retried = f.claim(); assert.equal(retried.cycle, cycle); assert.notEqual(retried.lease.job_id, lease.job_id);
  const result = publishMonthlyEvaluation(f.db, retried.lease, f.evaluationOptions);
  assert.equal(result.outcome, "blocked");
  assert.deepEqual(storedAttempt(f, result.evaluation_attempt_id).result.reason_codes, ["LISTING_REVIEW_CHANGED"]);
  assert.deepEqual(f.db.prepare("SELECT * FROM evaluation_listing_review_boundaries WHERE cycle_id=?").get(cycle), original);
  assert.equal(count(f, "evaluation_attempts"), 2); assert.equal(count(f, "proposals"), 0);
});

test("a first review written after cycle creation remains missing at the original boundary", t => {
  const f = fixture(t, "l2", ["l2"]), { lease } = f.claim();
  assert.deepEqual(prepareMonthlyEvaluation(f.db, lease, f.evaluationOptions).reason_codes, ["LISTING_REVIEW_MISSING"]);
  f.reviewListing("l2", {}, scheduled);
  const result = publishMonthlyEvaluation(f.db, lease, f.evaluationOptions);
  assert.equal(result.outcome, "blocked");
  assert.deepEqual(storedAttempt(f, result.evaluation_attempt_id).result.reason_codes, ["LISTING_REVIEW_MISSING"]);
});

test("a first review at the same clock before cycle creation is usable", t => {
  const f = fixture(t, "l2", ["l2"]);
  f.reviewListing("l2", {}, scheduled);
  const { lease } = f.claim();
  assert.equal(publishMonthlyEvaluation(f.db, lease, f.evaluationOptions).outcome, "unchanged");
});

test("incomplete original review is not healed by a later complete same-timestamp revision", t => {
  const f = fixture(t);
  f.reviewListing("l", { quantity_step: null }, scheduled);
  const { lease } = f.claim();
  f.reviewListing("l", {}, scheduled);
  assert.deepEqual(prepareMonthlyEvaluation(f.db, lease, f.evaluationOptions).reason_codes, ["LISTING_REVIEW_TRADING_UNITS_MISSING"]);
});

test("an unrelated listing review does not invalidate the frozen target evidence", t => {
  const f = fixture(t), { lease } = f.claim();
  f.reviewListing("l2", { price_step: "0.02" }, scheduled);
  assert.equal(publishMonthlyEvaluation(f.db, lease, f.evaluationOptions).outcome, "unchanged");
});

test("regular as-of queries keep their timestamp semantics while old approvals still invalidate", t => {
  const f = governanceFixture(); t.after(f.close);
  const proposal = f.proposal("100"), approval = f.approve(proposal);
  const revised = f.reviewListing("l", { price_step: "0.02" });
  const current = reviewedListingAt(f.db, { portfolio_id: f.portfolio, listing_id: "l", knowledge_at: "2026-01-05T12:00:00.000000Z", now: "2026-01-05T12:00:00.000000Z" });
  assert.equal(current.document!.id, revised.id);
  assert.throws(() => prepareExecution(f.db, human, { ...f.envelope(), proposal_id: proposal.id, approval_id: approval.id }, f.options), /APPROVAL_STALE/);
});

test("boundary reader rejects caller scope mismatch and missing data, without rewriting completed evidence", t => {
  const f = fixture(t), { cycle, lease } = f.claim();
  const result = publishMonthlyEvaluation(f.db, lease, f.evaluationOptions);
  const before = storedAttempt(f, result.evaluation_attempt_id);
  assert.throws(() => readEvaluationListingBoundary(f.db, { id: cycle, portfolio_id: "foreign", knowledge_at: scheduled }), /EVALUATION_LISTING_BOUNDARY_INVALID/);
  assert.throws(() => readEvaluationListingBoundary(f.db, { id: "missing", portfolio_id: f.portfolio, knowledge_at: scheduled }), /EVALUATION_LISTING_BOUNDARY_MISSING/);
  assert.deepEqual(storedAttempt(f, result.evaluation_attempt_id), before);
  const state = getEvaluationState(f.db, human, { portfolio_id: f.portfolio, cycle_id: cycle });
  assert.ok(state.detail);
});

test("legacy boundary markers block pending work but do not invalidate readable completed evidence", t => {
  const completed = fixture(t), done = completed.claim();
  const result = publishMonthlyEvaluation(completed.db, done.lease, completed.evaluationOptions);
  const before = storedAttempt(completed, result.evaluation_attempt_id);
  const pending = fixture(t), waiting = pending.claim();
  // SQL migration tests separately establish that real v19 cycles receive exactly this immutable marker.
  for (const [f, cycle] of [[completed, done.cycle], [pending, waiting.cycle]] as const) {
    f.db.exec("DROP TRIGGER evaluation_listing_boundary_no_update");
    f.db.prepare("UPDATE evaluation_listing_review_boundaries SET capture_kind='legacy_missing',watermark_sequence=NULL WHERE cycle_id=?").run(cycle);
  }
  assert.throws(() => readEvaluationListingBoundary(completed.db, { id: done.cycle, portfolio_id: completed.portfolio, knowledge_at: scheduled }), /EVALUATION_LISTING_BOUNDARY_MISSING/);
  assert.ok(getEvaluationState(completed.db, human, { portfolio_id: completed.portfolio, cycle_id: done.cycle }).detail);
  assert.deepEqual(storedAttempt(completed, result.evaluation_attempt_id), before);
  const blocked = publishMonthlyEvaluation(pending.db, waiting.lease, pending.evaluationOptions);
  assert.equal(blocked.outcome, "blocked");
  assert.deepEqual(storedAttempt(pending, blocked.evaluation_attempt_id).result.reason_codes, ["EVALUATION_LISTING_BOUNDARY_MISSING"]);
  assert.equal(count(pending, "proposals"), 0);
});

test("missing selected sequence mapping is evidence corruption, never fallback to an older review", t => {
  const f = fixture(t);
  const review = f.reviewListing("l", { price_step: "0.02" }, scheduled);
  // Give an unrelated listing the highest sequence so the boundary itself remains resolvable after corruption.
  f.reviewListing("l2", {}, scheduled);
  const { lease } = f.claim();
  f.db.exec("DROP TRIGGER listing_review_sequence_no_delete");
  f.db.prepare("DELETE FROM listing_review_sequences WHERE version_id=?").run(review.id);
  const prepared = prepareMonthlyEvaluation(f.db, lease, f.evaluationOptions);
  assert.equal(prepared.outcome, "blocked");
  assert.deepEqual(prepared.reason_codes, ["LISTING_REVIEW_EVIDENCE_INVALID"]);
});

test("missing watermark sequence is rejected rather than treated as an empty initial snapshot", t => {
  const f = fixture(t), { cycle, lease } = f.claim();
  const boundary = f.db.prepare("SELECT watermark_sequence FROM evaluation_listing_review_boundaries WHERE cycle_id=?").get(cycle) as { watermark_sequence: number };
  f.db.exec("DROP TRIGGER listing_review_sequence_no_delete");
  f.db.prepare("DELETE FROM listing_review_sequences WHERE sequence=?").run(boundary.watermark_sequence);
  assert.deepEqual(prepareMonthlyEvaluation(f.db, lease, f.evaluationOptions).reason_codes, ["EVALUATION_LISTING_BOUNDARY_INVALID"]);
});
