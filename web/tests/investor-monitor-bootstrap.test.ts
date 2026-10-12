import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { readInvestorMonitorEvidenceSource } from "../src/server/investor/monitor-source";
import { parseInvestorState } from "../src/components/workbench/investor-client";

type Obj = Record<string, unknown>;
type F = ReturnType<typeof investorFixture>;
type Evidence = { document: Obj; projection: Obj; registered_input_id: string; rights_review_id: string;
  real_provider_called: boolean; real_gateway_called: boolean };
const now = "2026-01-02T12:05:03.000Z", current = "2026-01-02T12:05:04.000Z";
function helper(f: F, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args], {
    cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 262144, stdio: ["ignore", "pipe", "pipe"],
  })) as Evidence;
}
function save(f: F, fixed: boolean) {
  saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
  helper(f, "tests.investor.evidence_fixture", fixed ? ["--fixed-policy-v2"] : []);
  helper(f, "tests.investor.queue_fixture", ["--mode", "core"]);
  const at = "2026-01-02T12:00:04.000Z", state = getInvestorState(f.db, actor, at); assert.ok(state.plan);
  executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan.id, expected_revision: state.revision,
    idempotency_key: "save-bootstrap-reference" }, at);
  return getInvestorState(f.db, actor, at);
}
function noFinance(f: F) {
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
}

test("default core bootstraps both saved model versions and Node verifies the first input without manual JSON", () => {
  for (const fixed of [false, true]) {
    const f = investorFixture();
    try {
      const saved = save(f, fixed);
      assert.equal((f.db.prepare("SELECT count(*) n FROM investor_monitor_evidence_inputs").get() as { n: number }).n, 0);
      const value = helper(f, "tests.investor.confirmed_monitor_fixture", ["--admit", "--monitor", "--grouped", "--bootstrap"]);
      assert.equal(value.real_provider_called, false); assert.equal(value.real_gateway_called, false);
      assert.ok(value.registered_input_id); assert.equal(value.document.schema_version, "investor-monitor-data-input-v2");
      const settings = value.document.settings as Obj, policy = settings.policy as Obj;
      assert.equal(policy.version, "investor-monitor-bootstrap-quality-v1"); assert.equal(policy.costs, null);
      assert.equal(settings.funding_intent, null); assert.equal(settings.max_quote_age_seconds, 604800);
      const before = f.db.prepare("SELECT total_changes() n").get();
      const input = readInvestorMonitorEvidenceSource(f.db, saved.workspace_id!, saved.model_watch!.id, value.registered_input_id, current);
      assert.equal(input.unavailable_reason, null); assert.deepEqual(input.projection, value.projection);
      const state = getInvestorState(f.db, actor, current);
      // These frozen fictional plans have zero tolerances. Unknown costs cannot
      // authorize a change or checkpoint even for sub-cent quantity rounding.
      assert.equal(state.effective_outcome, "insufficient_evidence"); assert.equal(state.model_watch?.status, "blocked");
      assert.equal(state.model_watch?.checkpoint_sequence, 0); assert.equal(state.model_watch?.model_nav_cny, null);
      assert.equal(state.live_advice_eligible, false);
      assert.deepEqual(parseInvestorState({ ...state, session_binding: "a".repeat(64) }, "a".repeat(64)), state);
      assert.throws(() => readInvestorMonitorEvidenceSource(f.db, "foreign", saved.model_watch!.id, value.registered_input_id, current), /EVIDENCE_INVALID/);
      assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
      assert.equal((f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='investor_bootstrap_monitor_source'").get() as { n: number }).n, 1);
      noFinance(f);
    } finally { f.close(); }
  }
});

test("withdrawal after automatic bootstrap remains unavailable to readonly Node and does not recreate an input", () => {
  const f = investorFixture();
  try {
    const saved = save(f, true), value = helper(f, "tests.investor.confirmed_monitor_fixture", ["--admit", "--monitor", "--bootstrap"]);
    execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c",
      "import sys; from worker.orchestration.db import open_database; from worker.investor.data_evidence import review_source; from worker.orchestration.runtime import run_pending_once; db=open_database(sys.argv[1]); source=db.execute('SELECT source_id FROM investor_data_reviews WHERE id=?',(sys.argv[2],)).fetchone()[0]; workspace=db.execute('SELECT workspace_id FROM investor_models').fetchone()[0]; review_source(db,workspace,'synthetic-investor',source,'withdrawn',None,'Fictional bootstrap withdrawal','2027-01-01T00:00:00.000Z',now=sys.argv[3]); run_pending_once(db,'fictional-core',clock=lambda:sys.argv[3]); db.close()",
      f.filename, value.rights_review_id, current], { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
    const before = f.db.prepare("SELECT total_changes() n").get();
    const input = readInvestorMonitorEvidenceSource(f.db, saved.workspace_id!, saved.model_watch!.id, value.registered_input_id, current);
    assert.equal(input.unavailable_reason, "REFERENCE_SOURCE_NO_LONGER_CURRENT"); assert.equal(input.projection, null);
    const state = getInvestorState(f.db, actor, current);
    assert.equal(state.effective_outcome, "insufficient_evidence"); assert.equal(state.model_watch?.model_nav_cny, null);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_monitor_evidence_inputs").get() as { n: number }).n, 1);
    assert.equal((f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='investor_bootstrap_monitor_source'").get() as { n: number }).n, 1);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); noFinance(f);
  } finally { f.close(); }
});
