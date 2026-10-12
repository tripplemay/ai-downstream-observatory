import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { canonical, hash } from "../src/server/ledger/service";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { readEvidenceCheckpoint, readEvidenceMonitorRun } from "../src/server/investor/evidence-monitor";
import { parseInvestorState } from "../src/components/workbench/investor-client";

type Obj = Record<string, unknown>;
type Fixture = ReturnType<typeof investorFixture>;
const now = "2026-01-03T12:00:04.000Z", due = "2026-01-03T16:00:00.000Z";
const funding = { schema_version: "investor-funding-plan-v1" as const, start_date: "2026-01-02", horizon_years: 1,
  evaluation_timezone: "Asia/Shanghai" as const, initial_capital_cny: "100.01", annual_contribution_cny: "10.01",
  first_annual_date: "2026-01-04", entry_method: "three_tranches_60_days" as const,
  actual_arrivals_confirmed: false as const, execution_authorized: false as const, live_advice_eligible: false as const };
function helper(f: Fixture, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args],
    { cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 1048576, stdio: ["ignore", "pipe", "pipe"] })) as Obj;
}
function saveFunding(f: Fixture, at: string, key: string) {
  const state = getInvestorState(f.db, actor, at);
  return executeInvestorCommand(f.db, actor, { action: "save_funding_plan", funding_plan: funding,
    expected_revision: state.revision, idempotency_key: key }, at);
}
function seed(f: Fixture, fixed = true, conflict = false) {
  saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
  helper(f, "tests.investor.evidence_fixture", fixed ? ["--fixed-policy-v2"] : []);
  helper(f, "tests.investor.queue_fixture", ["--mode", "core"]);
  const state = getInvestorState(f.db, actor, "2026-01-02T12:00:04.000Z");
  executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan!.id, expected_revision: state.revision, idempotency_key: "fund-model" },
    "2026-01-02T12:00:04.000Z");
  saveFunding(f, "2026-01-02T12:00:05.000Z", "fund-first");
  return helper(f, "tests.investor.monitor_data_fixture", ["--admit", "--monitor", "--extra-closed-day", ...(conflict ? ["--funding"] : [])]);
}
function calculate(f: Fixture, at: string) { return helper(f, "tests.investor.queue_fixture", ["--mode", "core", "--now", at]); }
function latest(f: Fixture) { return f.db.prepare("SELECT * FROM investor_evidence_monitor_runs ORDER BY rowid DESC LIMIT 1").get() as Obj; }
function checkpoint(f: Fixture, at: string, header = latest(f)) {
  const model = f.db.prepare("SELECT * FROM investor_models").get() as Obj, document = JSON.parse(String(model.document_json)) as Obj;
  return readEvidenceCheckpoint(f.db, String(model.workspace_id), model, document, header.checkpoint_id, at).checkpoint!;
}
function noFinance(f: Fixture) {
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
}

test("saved funding reaches default core, independent Node/client replay, future/due and sparse legacy/fixed state", () => {
  for (const fixed of [false, true]) {
    const f = investorFixture();
    try {
      const input = seed(f, fixed), first = checkpoint(f, now), raw = (input.document as Obj).projection_hash;
      let state = getInvestorState(f.db, actor, now);
      assert.equal(state.latest!.document.model_change!.funding_status, "not_due");
      assert.equal(first.schema_version, "investor-evidence-model-checkpoint-v3"); assert.equal(first.projection_hash, raw);
      calculate(f, "2026-01-03T15:59:59.999Z");
      const pending = latest(f), read = readEvidenceMonitorRun(f.db, state.workspace_id!, String(pending.id), "2026-01-03T15:59:59.999Z");
      assert.equal(read.run.next_check_at, due);
      const overdue = getInvestorState(f.db, actor, due);
      assert.equal(overdue.effective_outcome, "insufficient_evidence"); assert.equal(overdue.model_watch!.status, "outdated");
      assert.ok(overdue.effective_gaps.some(gap => gap.code === "MONITOR_FUNDING_CONTEXT_CHANGED"));
      calculate(f, due); state = getInvestorState(f.db, actor, due);
      const after = checkpoint(f, due), dueRun = latest(f);
      assert.equal(state.effective_outcome, "decision_required"); assert.equal(state.latest!.document.model_change!.funding_status, "hypothetical_due");
      assert.equal(state.latest!.document.model_change!.model_nav_cny, "10000");
      assert.deepEqual(after.quantities, first.quantities); assert.deepEqual(after.cash_by_currency, first.cash_by_currency);
      assert.equal(after.projection_hash, raw); assert.equal(after.sequence, fixed ? 2 : 1);
      assert.equal((f.db.prepare("SELECT json_extract(document_json,'$.engine_version') engine FROM investor_evidence_monitor_requests ORDER BY rowid DESC LIMIT 1").get() as Obj).engine,
        "investor-evidence-model-watcher-v4");
      calculate(f, "2026-01-03T16:15:03.000Z"); state = getInvestorState(f.db, actor, "2026-01-03T16:15:04.000Z");
      assert.equal(latest(f).checkpoint_id, dueRun.checkpoint_id);
      const session = "a".repeat(64); assert.deepEqual(parseInvestorState({ ...state, session_binding: session }, session), state);
      for (const decision of ["accept_idea", "defer", "reject"] as const) {
        executeInvestorCommand(f.db, actor, { action: "review", observation_id: state.latest!.id, decision, note: "Invented review, never execution",
          expected_revision: state.revision, idempotency_key: "fund-review-" + decision }, "2026-01-03T16:15:04.000Z");
        state = getInvestorState(f.db, actor, "2026-01-03T16:15:04.000Z");
        assert.deepEqual(checkpoint(f, "2026-01-03T16:15:04.000Z"), after);
      }
      noFinance(f);
    } finally { f.close(); }
  }
});

test("a saved new plan immediately hides old conclusions, then replays its own version without rewriting old checkpoints", () => {
  const f = investorFixture();
  try {
    seed(f); calculate(f, due);
    const oldRun = latest(f), old = checkpoint(f, due, oldRun), at = "2026-01-03T16:01:00.000Z";
    saveFunding(f, at, "fund-revision-two");
    let state = getInvestorState(f.db, actor, at);
    assert.equal(state.effective_outcome, "insufficient_evidence"); assert.equal(state.model_watch!.model_nav_cny, null);
    assert.ok(state.effective_gaps.some(gap => gap.code === "MONITOR_FUNDING_PLAN_CHANGED"));
    calculate(f, at); state = getInvestorState(f.db, actor, at);
    const current = checkpoint(f, at);
    assert.equal(state.latest!.document.model_change!.funding_status, "not_due");
    assert.notDeepEqual(current.funding_binding, old.funding_binding);
    assert.deepEqual(checkpoint(f, at, oldRun), old); assert.deepEqual(current.quantities, old.quantities);
    assert.deepEqual(current.cash_by_currency, old.cash_by_currency); noFinance(f);
  } finally { f.close(); }
});

test("private plan and raw monitor intent conflict is independently reproduced as a blocked gap", () => {
  const f = investorFixture();
  try {
    seed(f, true, true);
    const state = getInvestorState(f.db, actor, now);
    assert.equal(state.effective_outcome, "insufficient_evidence");
    assert.ok(state.latest!.document.gaps.some(gap => gap.code === "MONITOR_FUNDING_INTENTS_CONFLICT"));
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_evidence_model_checkpoints").get() as Obj).n, 0); noFinance(f);
  } finally { f.close(); }
});

test("resealing a checkpoint's funding origin cannot evade archived-plan and whole-state replay", () => {
  const f = investorFixture();
  try {
    seed(f); const header = latest(f), original = checkpoint(f, now), altered = structuredClone(original);
    (altered.funding_binding as Obj).plan_declared_at = "2026-01-02T12:00:06.000Z";
    f.db.exec("DROP TRIGGER investor_evidence_checkpoint_no_update; DROP TRIGGER investor_evidence_checkpoint_payload_update;");
    f.db.prepare("UPDATE investor_evidence_checkpoint_payloads SET payload=? WHERE checkpoint_id=?").run(Buffer.from(canonical(altered)), header.checkpoint_id);
    f.db.prepare("UPDATE investor_evidence_model_checkpoints SET content_hash=? WHERE id=?").run(hash(altered), header.checkpoint_id);
    assert.throws(() => checkpoint(f, now)); noFinance(f);
  } finally { f.close(); }
});

test("SQL rejects forged funding-request scope, closed fields, hashes and legacy omission of a saved plan", () => {
  const f = investorFixture();
  try {
    seed(f);
    const row = f.db.prepare("SELECT * FROM investor_evidence_monitor_requests ORDER BY rowid DESC LIMIT 1").get() as Obj;
    const original = JSON.parse(String(row.document_json)) as Obj, binding = original.funding_binding as Obj;
    const legacy: Obj = { ...original, schema_version: "investor-evidence-monitor-request-v1", engine_version: "investor-evidence-model-watcher-v3" };
    delete legacy.funding_binding; delete legacy.funding_context_hash;
    const variants = [{ ...original, funding_binding: { ...binding, funding_plan_id: "foreign-plan" } },
      { ...original, funding_binding: { ...binding, model_hash: "c".repeat(64) } },
      { ...original, funding_binding: { ...binding, plan_declared_at: now } },
      { ...original, funding_context_hash: "not-a-hash" }, { ...original, extra: "not-closed" }, legacy];
    const before = f.db.prepare("SELECT count(*) n FROM investor_evidence_monitor_requests").get();
    for (const [index, document] of variants.entries()) {
      assert.throws(() => f.db.prepare(`INSERT INTO investor_evidence_monitor_requests
        (id,workspace_id,model_id,control_id,input_id,checkpoint_id,period,request_key,input_version,document_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run("forged-fund-" + index, row.workspace_id, row.model_id, row.control_id, row.input_id, row.checkpoint_id,
        "forged-period", hash({ attempt: index }), hash(document), canonical(document), now), /planned funding|saved funding/);
    }
    assert.deepEqual(f.db.prepare("SELECT count(*) n FROM investor_evidence_monitor_requests").get(), before); noFinance(f);
  } finally { f.close(); }
});
