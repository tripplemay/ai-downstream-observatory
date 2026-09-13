import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { governanceFixture, human, now } from "./governance-fixture";
import { canonical, createAccount, hash, recordFact, revision } from "../src/server/ledger/service";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { reconcileAccount, RECONCILIATION_BALANCES } from "../src/server/ledger/reconciliation";
import { currentPublications, evaluateRisk, type ProposalContext, type ProposalRow } from "../src/server/governance/risk";
import { readEvaluationListingBoundary, type EvaluationListingBoundary } from "../src/server/evaluation/listing-boundary";
import { saveSchedule, setScheduleStatus } from "../src/server/evaluation/service";

const scheduled = "2026-01-05T12:01:00.000000Z";
type Fixture = ReturnType<typeof governanceFixture>;
const python = (script: string, args: string[]) => {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3", ["-c", script, ...args],
    { cwd: path.resolve(".."), encoding: "utf8", timeout: 15000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return JSON.parse(child.stdout);
};
const discovery = `
import json, sys
from dataclasses import asdict
from worker.orchestration.db import open_database
from worker.orchestration.evaluations import discover_due_cycles
from worker.orchestration.runtime import sync_requests
from worker.orchestration.jobs import claim_job
db = open_database(sys.argv[1])
cycles = discover_due_cycles(db, now=sys.argv[2])
sync_requests(db, now=sys.argv[2])
lease = claim_job(db, 'synthetic-boundary-risk', job_type='monthly_evaluation', now=sys.argv[2])
print(json.dumps({'cycles':cycles, 'lease':asdict(lease) if lease else None}))
db.close()
`;

function setup(t: { after(callback: () => void): void }, position = "0") {
  // Reused governance gates, market data and baseline valuation remain synthetic fixtures;
  // boundary, review, ledger facts, reservations, discovery and claim use actual producer paths.
  const f = governanceFixture(undefined, position, "80000"); t.after(f.close); return f;
}
function capture(f: Fixture) {
  const definition = {
    schema_version: "evaluation-schedule-v1", environment: "actual", frequency: "monthly",
    policy_version_id: f.policyVersion.id, strategy_version_id: f.strategyVersion.id, activation_id: f.activated!.id,
    timezone: "UTC", start_month: "2026-01", end_month: "2026-02", trigger: { day: 5, hour: 12, minute: 1 }, deadline_seconds: 3600, max_attempts: 3,
    targets: { method: "manual_weight_targets_v1", weight_basis: "portfolio_nav", rows: [{ account_id: f.account, listing_id: "l", currency: "CNY", weight: "0" }],
      absolute_tolerance_cny: "0", weight_tolerance: "0", tolerance_rule: "max_absolute_or_weight", unlisted_strategy_positions: "block", pending_activity: "block", price_rule: "close_rounded_to_step", quantity_rule: "floor_to_step" },
  };
  const saved = saveSchedule(f.db, human, { ...f.envelope(), expected_schedule_id: null, expected_schedule_revision: 0, definition_json: JSON.stringify(definition) }, { now });
  setScheduleStatus(f.db, human, { ...f.envelope(), schedule_id: saved.schedule_id, expected_schedule_revision: 1, status: "enabled" }, { now: "2026-01-05T12:00:30.000Z" });
  const result = python(discovery, [f.filename, scheduled]) as { cycles: string[]; lease: { job_id: string } | null };
  assert.equal(result.cycles.length, 1); assert.ok(result.lease);
  const request = f.db.prepare("SELECT c.payload_json,j.status FROM command_requests c JOIN job_runs j ON j.command_request_id=c.id WHERE j.id=?").get(result.lease.job_id) as { payload_json: string; status: string };
  assert.equal(request.status, "running");
  const cycle = JSON.parse(request.payload_json).cycle_id as string;
  assert.equal(cycle, result.cycles[0]);
  return readEvaluationListingBoundary(f.db, { id: cycle, portfolio_id: f.portfolio, knowledge_at: scheduled });
}
function risk(f: Fixture, boundary: EvaluationListingBoundary, supplied: EvaluationListingBoundary | null = boundary, valuationId: string = f.valuationId) {
  const context: ProposalContext = { activation_id: f.activated!.id, valuation_id: valuationId, publications: currentPublications(f.db, f.policy, scheduled, f.portfolio) };
  // Match the evaluator's read-only virtual proposal. Empty items isolate existing owned exposure
  // and pending buys: no candidate order can incidentally supply the missing review check.
  const proposal: ProposalRow = { id: `evaluation:${boundary.cycle_id}`, portfolio_id: f.portfolio, environment: "actual",
    policy_version_id: f.policyVersion.id, strategy_version_id: f.strategyVersion.id, ledger_revision: revision(f.db, f.portfolio),
    market_manifest: canonical(context), input_hash: hash({ cycle: boundary.cycle_id, context, items: [] }),
    expires_at: "2026-01-05T12:30:00.000000Z", created_at: scheduled };
  return evaluateRisk(f.db, human, proposal, [], context, { ...f.options, now: scheduled }, scheduled, false, supplied ?? undefined);
}
function expectedBlocked(value: ReturnType<typeof risk>, code: string) {
  assert.equal(value.status, "blocked"); assert.deepEqual(value.checks.map(check => check.code), [code]);
}
function financialSnapshot(f: Fixture) {
  return Object.fromEntries(["ledger_events", "postings", "position_movements", "security_transit_movements", "position_projections", "security_transit_projections",
    "valuation_runs", "valuation_items", "proposals", "proposal_items", "approval_events", "reservations"].map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test("valid cycle boundary permits read-only risk calculation and binds its input hash without creating orders", t => {
  const f = setup(t), boundary = capture(f), before = financialSnapshot(f);
  const checked = risk(f, boundary), currentOnly = risk(f, boundary, null);
  assert.equal(checked.status, "pass"); assert.equal(currentOnly.status, "pass");
  assert.notEqual(checked.input_hash, currentOnly.input_hash); assert.deepEqual(checked.budgets, []);
  assert.deepEqual(financialSnapshot(f), before);
});

test("owned positions reject a same-time later review through the complete boundary DTO with no proposal items", t => {
  const f = setup(t, "100"), boundary = capture(f);
  assert.equal((f.db.prepare("SELECT quantity FROM position_projections WHERE account_id=? AND listing_id='l'").get(f.account) as { quantity: string }).quantity, "100");
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM reservations").get() as { n: number }).n, 0);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM security_transit_projections").get() as { n: number }).n, 0);
  assert.equal(risk(f, boundary).status, "pass"); const before = financialSnapshot(f);
  const newer = f.reviewListing("l", { price_step: "0.02" }, scheduled);
  assert.equal(newer.known_at, boundary.knowledge_at);
  expectedBlocked(risk(f, boundary), "LISTING_REVIEW_CHANGED");
  assert.equal(risk(f, boundary, null).status, "pass"); assert.deepEqual(financialSnapshot(f), before);
});

test("normal approved buy reservation rejects a same-time later review even with zero holdings and no new order items", t => {
  const f = setup(t), proposed = f.proposal("100"); f.approve(proposed);
  const reservation = f.db.prepare("SELECT status,side,listing_id,quantity FROM reservations WHERE proposal_item_id IN (SELECT id FROM proposal_items WHERE proposal_id=?)").get(proposed.id);
  assert.deepEqual(reservation, { status: "active", side: "buy", listing_id: "l", quantity: "100" });
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM position_projections WHERE quantity<>'0'").get() as { n: number }).n, 0);
  const boundary = capture(f); assert.equal(risk(f, boundary).status, "pass"); const before = financialSnapshot(f);
  f.reviewListing("l", { price_step: "0.02" }, scheduled);
  expectedBlocked(risk(f, boundary), "LISTING_REVIEW_CHANGED");
  assert.equal(risk(f, boundary, null).status, "pass"); assert.deepEqual(financialSnapshot(f), before);
});

test("risk refuses an actual other-portfolio cycle boundary and forged proof or watermark fields", t => {
  const f = setup(t), foreign = setup(t), boundary = capture(f), foreignBoundary = capture(foreign);
  const before = financialSnapshot(f);
  expectedBlocked(risk(f, boundary, foreignBoundary), "LISTING_REVIEW_OUT_OF_SCOPE");
  for (const patch of [{ proof_hash: "0".repeat(64) }, { watermark_sequence: boundary.watermark_sequence + 1 },
    { cycle_id: foreignBoundary.cycle_id }, { knowledge_at: "2026-01-05T12:01:00.000001Z" }, { extra_authority: true }]) {
    expectedBlocked(risk(f, boundary, { ...boundary, ...patch }), "LISTING_REVIEW_EVIDENCE_INVALID");
  }
  assert.equal(risk(f, boundary).status, "pass"); assert.deepEqual(financialSnapshot(f), before);
});

test("normal security transfer, explicit transit reconciliation and Python valuation preserve transit ownership but freeze its review", t => {
  const f = setup(t, "100"), target = createAccount(f.db, human, f.portfolio, "Synthetic transfer target", "Synthetic only", "CNY", now);
  const dispatch = recordFact(f.db, human, f.command({ type: "security_transfer_out", account_id: f.account, target_account_id: target,
    listing_id: "l", currency: "CNY", quantity: "100" }, "2026-01-02"), now);
  const transit = { transfer_event_id: dispatch.event_id, source_account_id: f.account, target_account_id: target, listing_id: "l", currency: "CNY", quantity: "100" };
  for (const account of [f.account, target]) {
    const statement = { schema_version: 1, portfolio_id: f.portfolio, account_id: account, cutoff_at: "2026-01-05T02:00:00.000Z",
      coverage: { currencies: ["CNY"], ledger_accounts: [...RECONCILIATION_BALANCES], positions_complete: true, balances_complete: true, security_transits_complete: true },
      balances: RECONCILIATION_BALANCES.map(ledger_account => ({ currency: "CNY", ledger_account, balance: ledger_account === "cash_settled" && account === f.account ? "80000" : "0" })),
      positions: [], security_transits: [transit] };
    const attachment = storeJsonAttachment(f.db, human, { portfolio_id: f.portfolio, account_id: account, raw: JSON.stringify(statement) }, f.options);
    const reconciled = reconcileAccount(f.db, human, { portfolio_id: f.portfolio, account_id: account, expected_revision: revision(f.db, f.portfolio), attachment_id: attachment.id }, f.options);
    assert.equal(reconciled.status, "matched");
  }
  const previous = f.db.prepare("SELECT market_manifest FROM valuation_runs WHERE id=?").get(f.valuationId) as { market_manifest: string };
  const valued = python(`
import json, sys
from worker.orchestration.db import open_database
from worker.market.valuation import value_portfolio
db = open_database(sys.argv[1])
result = value_portfolio(db, sys.argv[2], '2026-01-05T02:00:00.000000Z', json.loads(sys.argv[3]), mode='restated', now=sys.argv[4])
print(json.dumps(result))
db.close()
`, [f.filename, f.portfolio, JSON.stringify(JSON.parse(previous.market_manifest).rules), now]) as { id: string; quality: string; nav_cny: string; ledger_revision: number };
  assert.equal(valued.quality, "complete"); assert.equal(valued.nav_cny, "90000"); assert.equal(valued.ledger_revision, revision(f.db, f.portfolio));
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM position_projections WHERE quantity<>'0'").get() as { n: number }).n, 0);
  assert.equal((f.db.prepare("SELECT quantity FROM security_transit_projections WHERE transfer_event_id=?").get(dispatch.event_id) as { quantity: string }).quantity, "100");
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM reservations").get() as { n: number }).n, 0);
  const boundary = capture(f); assert.equal(risk(f, boundary, boundary, valued.id).status, "pass"); const before = financialSnapshot(f);
  f.reviewListing("l", { price_step: "0.02" }, scheduled);
  expectedBlocked(risk(f, boundary, boundary, valued.id), "LISTING_REVIEW_CHANGED");
  assert.equal(risk(f, boundary, null, valued.id).status, "pass"); assert.deepEqual(financialSnapshot(f), before);
});
