import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { readInvestorCurrentCalendarReview, readInvestorResearchSource } from "../src/server/investor/source-inputs";
import { readInvestorMonitorEvidenceSource } from "../src/server/investor/monitor-source";
import { hash, canonical } from "../src/server/ledger/service";

type F = ReturnType<typeof investorFixture>;
type Obj = Record<string, unknown>;
type Continuation = { source_input_id: string; original_calendar_review_id: string; new_review_id: string;
  calendar_continuation_id: string | null; unavailable_reason: string | null; workspace_id: string;
  real_provider_called: boolean; real_gateway_called: boolean; financial_facts: number };
const now = "2026-01-03T12:00:04.000Z";
function helper<T = Continuation>(f: F, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args], {
    cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 262144, stdio: ["ignore", "pipe", "pipe"],
  })) as T;
}
function setup(f: F) {
  saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
  helper(f, "tests.investor.evidence_fixture", ["--initial-monitor-calendar", "--fixed-policy-v2"]);
  helper(f, "tests.investor.queue_fixture", ["--mode", "core"]);
  const at = "2026-01-02T12:00:04.000Z", state = getInvestorState(f.db, actor, at); assert.ok(state.plan);
  executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan.id, expected_revision: state.revision,
    idempotency_key: "save-calendar-reference" }, at);
  return getInvestorState(f.db, actor, at);
}
function noFinance(f: F) {
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
}

test("explicit two-hop calendar extension preserves the original research and binds new initial prices to the current exact review", () => {
  const f = investorFixture();
  try {
    const saved = setup(f), row = f.db.prepare("SELECT id FROM investor_evidence_inputs").get() as { id: string };
    const request = { input_id: null, evidence_input_id: row.id };
    const original = readInvestorResearchSource(f.db, saved.workspace_id!, request, now);
    const first = helper(f, "tests.investor.calendar_continuation_fixture", ["--mode", "append"]);
    const second = helper(f, "tests.investor.calendar_continuation_fixture", ["--mode", "append"]);
    assert.equal(first.unavailable_reason, null); assert.equal(second.unavailable_reason, null);
    assert.equal(second.real_provider_called, false); assert.equal(second.real_gateway_called, false);
    const changes = f.db.prepare("SELECT total_changes() n").get();
    assert.deepEqual(readInvestorResearchSource(f.db, saved.workspace_id!, request, now), original);
    assert.equal(readInvestorCurrentCalendarReview(f.db, saved.workspace_id!, first.original_calendar_review_id, now).row.id, second.new_review_id);
    assert.throws(() => readInvestorCurrentCalendarReview(f.db, "foreign", first.original_calendar_review_id, now));
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes);
    const collected = helper<{ stubbed_sdk_calls: number; real_provider_called: boolean }>(f, "tests.investor.initial_price_fixture", ["--mode", "collect"]);
    assert.equal(collected.stubbed_sdk_calls, 2); assert.equal(collected.real_provider_called, false);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_initial_price_requests WHERE calendar_review_id=?").get(second.new_review_id) as { n: number }).n, 2);
    const source = helper<{ registered_input_id: string; projection: Obj }>(f, "tests.investor.initial_price_fixture", ["--mode", "bootstrap"]);
    const before = f.db.prepare("SELECT total_changes() n").get();
    const read = readInvestorMonitorEvidenceSource(f.db, saved.workspace_id!, saved.model_watch!.id, source.registered_input_id, now);
    assert.equal(read.unavailable_reason, null); assert.deepEqual(read.projection, source.projection);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); noFinance(f);
  } finally { f.close(); }
});

test("plain review and later withdrawal never inherit continuity approval", () => {
  for (const mode of ["ordinary", "withdraw"] as const) {
    const f = investorFixture();
    try {
      const saved = setup(f);
      const original = helper(f, "tests.investor.calendar_continuation_fixture", ["--mode", "append"]);
      const changed = helper(f, "tests.investor.calendar_continuation_fixture", ["--mode", mode]);
      assert.equal(changed.unavailable_reason, "REFERENCE_SOURCE_NO_LONGER_CURRENT");
      const before = f.db.prepare("SELECT total_changes() n").get();
      assert.equal(readInvestorResearchSource(f.db, saved.workspace_id!, { input_id: null, evidence_input_id: original.source_input_id }, now)?.unavailable_reason, "REFERENCE_SOURCE_NO_LONGER_CURRENT");
      assert.throws(() => readInvestorCurrentCalendarReview(f.db, saved.workspace_id!, original.original_calendar_review_id, now));
      assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); noFinance(f);
    } finally { f.close(); }
  }
});

test("expired intermediate equality witness is not a renewed origin or a new data grant", () => {
  const f = investorFixture();
  try {
    const saved = setup(f);
    const first = helper(f, "tests.investor.calendar_continuation_fixture", ["--mode", "append-short"]);
    const second = helper(f, "tests.investor.calendar_continuation_fixture", ["--mode", "append-long"]);
    const at = "2026-01-03T12:00:05.000Z", before = f.db.prepare("SELECT total_changes() n").get();
    assert.equal(readInvestorCurrentCalendarReview(f.db, saved.workspace_id!, first.original_calendar_review_id, at).row.id, second.new_review_id);
    assert.equal(readInvestorResearchSource(f.db, saved.workspace_id!, { input_id: null, evidence_input_id: first.source_input_id }, at)?.unavailable_reason, null);
    const deadline = (f.db.prepare("SELECT valid_until FROM investor_data_reviews WHERE id=?").get(first.original_calendar_review_id) as { valid_until: string }).valid_until;
    assert.equal(readInvestorCurrentCalendarReview(f.db, saved.workspace_id!, second.new_review_id, deadline).row.id, second.new_review_id);
    assert.throws(() => readInvestorCurrentCalendarReview(f.db, saved.workspace_id!, first.original_calendar_review_id, deadline));
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); noFinance(f);
  } finally { f.close(); }
});

test("Node rejects an invalid appended calendar even if review, link and audit hashes are resealed", () => {
  const f = investorFixture();
  try {
    const saved = setup(f), approved = helper(f, "tests.investor.calendar_continuation_fixture", ["--mode", "append"]);
    const row = f.db.prepare("SELECT document_json,audit_id FROM investor_data_reviews WHERE id=?").get(approved.new_review_id) as { document_json: string; audit_id: string };
    const doc = JSON.parse(row.document_json), days = doc.facts.days;
    days.at(-1).date = days.at(-2).date;
    f.db.exec("DROP TRIGGER investor_data_review_no_update");
    f.db.prepare("UPDATE investor_data_reviews SET document_json=?,content_hash=? WHERE id=?").run(canonical(doc), hash(doc), approved.new_review_id);
    // The fictional attacker also reseals each claimed checksum, not just one output.
    f.db.exec("DROP TRIGGER audit_events_no_update");
    f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical({ content_hash: hash(doc) }), row.audit_id);
    const link = f.db.prepare("SELECT document_json,audit_id FROM investor_calendar_continuations WHERE id=?").get(approved.calendar_continuation_id) as { document_json: string; audit_id: string };
    const proof = JSON.parse(link.document_json); proof.new_review_hash = hash(doc);
    f.db.exec("DROP TRIGGER investor_calendar_continuation_update");
    f.db.prepare("UPDATE investor_calendar_continuations SET document_json=?,content_hash=? WHERE id=?").run(canonical(proof), hash(proof), approved.calendar_continuation_id);
    f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical({ content_hash: hash(proof) }), link.audit_id);
    const before = f.db.prepare("SELECT total_changes() n").get();
    assert.equal(readInvestorResearchSource(f.db, saved.workspace_id!, { input_id: null, evidence_input_id: approved.source_input_id }, now)?.unavailable_reason, "REFERENCE_SOURCE_NO_LONGER_CURRENT");
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); noFinance(f);
  } finally { f.close(); }
});
