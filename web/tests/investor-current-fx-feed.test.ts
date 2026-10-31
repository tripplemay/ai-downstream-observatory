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
function python(f: F, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args], {
    cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 262144, stdio: ["ignore", "pipe", "pipe"],
  })) as Obj;
}
function stable(f: F) {
  return ["investor_profiles", "investor_reference_plans", "investor_models", "investor_model_controls", "investor_plan_selections"]
    .map(name => ({ name, rows: f.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() }));
}

test("both saved US model versions recover late FX through default core and readonly Node/client, then hide stale NAV", () => {
  for (const fixed of [false, true]) {
    const f = investorFixture();
    try {
      saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
      python(f, "tests.investor.evidence_fixture", ["--research-market", "US", ...(fixed ? ["--fixed-policy-v2"] : [])]);
      python(f, "tests.investor.queue_fixture", ["--mode", "core"]);
      const saveAt = "2026-01-02T12:00:04.000Z", candidate = getInvestorState(f.db, actor, saveAt); assert.ok(candidate.plan);
      executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: candidate.plan.id,
        expected_revision: candidate.revision, idempotency_key: "save-fictional-fx-feed" }, saveAt);
      const saved = getInvestorState(f.db, actor, saveAt), frozen = stable(f);
      const blocked = python(f, "tests.investor.fx_feed_fixture", ["--stage", "blocked"]);
      assert.equal(blocked.real_provider_called, false); assert.equal(blocked.real_gateway_called, false);
      const originalAdmission = f.db.prepare("SELECT * FROM investor_confirmed_feed_admissions").get();
      const gap = getInvestorState(f.db, actor, blocked.blocked_at as string);
      assert.equal(gap.effective_outcome, "insufficient_evidence"); assert.equal(gap.model_watch?.model_nav_cny, null);
      const result = python(f, "tests.investor.fx_feed_fixture", ["--stage", "current"]);
      assert.equal(result.real_provider_called, false); assert.equal(result.real_gateway_called, false);
      assert.notEqual(result.input_id, result.seed_input_id);
      assert.deepEqual(f.db.prepare("SELECT * FROM investor_confirmed_feed_admissions").get(), originalAdmission);
      const before = f.db.prepare("SELECT total_changes() n").get(), at = result.at as string;
      const source = readInvestorMonitorEvidenceSource(f.db, saved.workspace_id!, saved.model_watch!.id, result.input_id as string, at);
      assert.equal(source.unavailable_reason, null); assert.deepEqual(source.projection, result.projection);
      const state = getInvestorState(f.db, actor, at);
      assert.ok(["observe", "decision_required"].includes(state.effective_outcome)); assert.equal(state.model_watch?.checkpoint_sequence, 2);
      assert.notEqual(state.model_watch?.model_nav_cny, null); assert.equal(state.live_advice_eligible, false);
      assert.deepEqual(parseInvestorState({ ...state, session_binding: "a".repeat(64) }, "a".repeat(64)), state);
      const refresh = JSON.parse((f.db.prepare("SELECT payload_json FROM audit_events WHERE action='investor_refresh_monitor_source'").get() as { payload_json: string }).payload_json) as Obj;
      assert.equal(refresh.schema_version, "investor-monitor-source-refresh-v1");
      assert.equal(refresh.previous_input_id, result.seed_input_id); assert.equal(refresh.input_id, result.input_id);
      assert.equal(refresh.live_advice_eligible, false);
      const staleAt = (result.projection as Obj).valid_until as string;
      const stale = getInvestorState(f.db, actor, staleAt);
      assert.equal(stale.effective_outcome, "insufficient_evidence"); assert.equal(stale.model_watch?.model_nav_cny, null);
      assert.deepEqual(stable(f), frozen); assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
      execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c",
        "import sys;from worker.orchestration.db import open_database;from worker.investor.data_evidence import review_source;db=open_database(sys.argv[1]);row=db.execute('SELECT * FROM investor_data_reviews WHERE id=?',(sys.argv[2],)).fetchone();review_source(db,row['workspace_id'],'synthetic-investor',row['source_id'],'withdrawn',None,'Fictional FX withdrawal','2027-01-01T00:00:00.000Z',now=sys.argv[3]);db.close()",
        f.filename, result.current_fx_review_id as string, at], { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
      const withdrawn = readInvestorMonitorEvidenceSource(f.db, saved.workspace_id!, saved.model_watch!.id, result.input_id as string, at);
      assert.equal(withdrawn.unavailable_reason, "REFERENCE_SOURCE_NO_LONGER_CURRENT"); assert.equal(withdrawn.projection, null);
      const unavailable = getInvestorState(f.db, actor, at);
      assert.equal(unavailable.effective_outcome, "insufficient_evidence"); assert.equal(unavailable.model_watch?.model_nav_cny, null);
      for (const name of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
        assert.equal((f.db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0);
    } finally { f.close(); }
  }
});
