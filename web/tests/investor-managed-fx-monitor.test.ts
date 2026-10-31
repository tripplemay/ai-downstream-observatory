import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { readInvestorMonitorEvidenceSource } from "../src/server/investor/monitor-source";
import { parseInvestorState } from "../src/components/workbench/investor-client";

type Obj = Record<string, unknown>;
function python(f: ReturnType<typeof investorFixture>, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args], {
    cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 262144, stdio: ["ignore", "pipe", "pipe"],
  })) as Obj;
}
function stable(f: ReturnType<typeof investorFixture>) {
  return ["investor_profiles", "investor_reference_plans", "investor_models", "investor_model_controls", "investor_plan_selections"].map(name => ({ name, rows: f.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() }));
}

test("both saved US model versions preserve unknown costs, then advance with explicit fictional cost evidence and fail closed", () => {
  for (const fixed of [false, true]) {
    const f = investorFixture();
    try {
      saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
      const source = python(f, "tests.investor.managed_fx_monitor_fixture", ["--stage", "history", ...(fixed ? ["--fixed-policy-v2"] : [])]);
      assert.equal(source.frozen_max_fx_age_seconds, 518400);
      python(f, "tests.investor.queue_fixture", ["--mode", "core"]);
      const saveAt = "2026-01-02T12:00:04.000Z", candidate = getInvestorState(f.db, actor, saveAt); assert.ok(candidate.plan);
      executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: candidate.plan.id, expected_revision: candidate.revision,
        idempotency_key: "save-fictional-managed-fx" }, saveAt);
      const frozen = stable(f), saved = getInvestorState(f.db, actor, saveAt);
      for (const stage of ["seed", "costs", "advance"]) {
        const result = python(f, "tests.investor.managed_fx_monitor_fixture", ["--stage", stage]);
        assert.equal(result.real_provider_called, false); assert.equal(result.real_gateway_called, false); assert.equal(result.fx_mock_calls, stage === "costs" ? 0 : 1);
        assert.equal(result.unavailable_reason, null);
        const changes = f.db.prepare("SELECT total_changes() n").get(), at = result.at as string;
        const input = readInvestorMonitorEvidenceSource(f.db, saved.workspace_id!, saved.model_watch!.id, result.input_id as string, at);
        assert.equal(input.unavailable_reason, null); assert.deepEqual(input.projection, result.projection);
        const state = getInvestorState(f.db, actor, at);
        if (stage === "seed") {
          assert.equal(result.expected_cost_gap, "CANNOT_COMPARE_CHANGE_COST"); assert.equal(result.checkpoints, 0);
          assert.equal(state.effective_outcome, "insufficient_evidence"); assert.equal(state.model_watch?.model_nav_cny, null);
        } else {
          assert.ok(["observe", "decision_required"].includes(state.effective_outcome)); assert.notEqual(state.model_watch?.model_nav_cny, null);
        }
        assert.equal(state.live_advice_eligible, false); assert.deepEqual(parseInvestorState({ ...state, session_binding: "a".repeat(64) }, "a".repeat(64)), state);
        assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes); assert.deepEqual(stable(f), frozen);
        const stale = getInvestorState(f.db, actor, (result.projection as Obj).valid_until as string);
        assert.equal(stale.effective_outcome, "insufficient_evidence"); assert.equal(stale.model_watch?.model_nav_cny, null);
      }
      const revoked = python(f, "tests.investor.managed_fx_monitor_fixture", ["--stage", "withdraw"]);
      assert.equal(revoked.raw_fx_payload_count, 0);
      const state = getInvestorState(f.db, actor, revoked.at as string);
      assert.equal(state.effective_outcome, "insufficient_evidence"); assert.equal(state.model_watch?.model_nav_cny, null);
      assert.deepEqual(stable(f), frozen);
      for (const name of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
        assert.equal((f.db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0);
    } finally { f.close(); }
  }
});
