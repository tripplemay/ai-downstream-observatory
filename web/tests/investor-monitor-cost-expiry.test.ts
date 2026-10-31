import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { readInvestorMonitorEvidenceSource } from "../src/server/investor/monitor-source";
import { parseInvestorState } from "../src/components/workbench/investor-client";

type Obj = Record<string, unknown>;
const values = { commission_bps: "1", minimum_fee_cny: "1", fx_bps: "2", slippage_bps: "3", maximum_cost_fraction: "0.01" };
function python(f: ReturnType<typeof investorFixture>, module: string, args: string[]) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args], {
    cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 262144, stdio: ["ignore", "pipe", "pipe"],
  })) as Obj;
}
test("fixed-policy costs expire on a closed day and stay unknown through the next confirmed close without losing source retention", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
    python(f, "tests.investor.managed_fx_monitor_fixture", ["--stage", "history", "--fixed-policy-v2"]);
    python(f, "tests.investor.queue_fixture", ["--mode", "core"]);
    const initial = getInvestorState(f.db, actor, "2026-01-02T12:00:04.000Z"); assert.ok(initial.plan);
    executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: initial.plan.id, expected_revision: initial.revision, idempotency_key: "fictional-fixed-cost-model" }, "2026-01-02T12:00:04.000Z");
    python(f, "tests.investor.managed_fx_monitor_fixture", ["--stage", "seed"]);
    const at = "2026-01-02T12:05:04.000Z", state = getInvestorState(f.db, actor, at); assert.ok(state.monitor_costs);
    const models = f.db.prepare("SELECT * FROM investor_models").all(), controls = f.db.prepare("SELECT * FROM investor_model_controls").all();
    executeInvestorCommand(f.db, actor, { action: "set_monitor_costs", model_id: state.model_watch!.id, model_hash: state.monitor_costs.model_hash,
      expected_cost_version: 0, expected_revision: state.revision, idempotency_key: "fictional-fixed-costs", costs: values, validity_days: 1, acknowledged_research_only: true }, at);
    python(f, "tests.investor.queue_fixture", ["--mode", "core", "--now", "2026-01-02T12:05:04.001Z"]);
    const known = getInvestorState(f.db, actor, "2026-01-02T12:05:04.001Z"); assert.equal(known.monitor_costs?.status, "known");
    for (const stage of ["expire", "close"]) {
      const result = python(f, "tests.investor.monitor_cost_fixture", ["--stage", stage]);
      assert.equal(result.real_provider_called, false); assert.equal(result.real_gateway_called, false);
      assert.equal(result.mock_provider_calls, stage === "close" ? 1 : 0); assert.equal(result.unavailable_reason, null);
      assert.ok(Object.values(result.financial_counts as Obj).every(count => count === 0));
      const current = getInvestorState(f.db, actor, result.at as string);
      const source = readInvestorMonitorEvidenceSource(f.db, current.workspace_id!, current.model_watch!.id, result.input_id as string, result.at as string);
      assert.deepEqual(source.projection, result.projection); assert.equal(source.unavailable_reason, null);
      assert.ok((source.document.valid_until as string) > known.monitor_costs!.valid_until!);
      assert.equal(current.monitor_costs?.version, 1); assert.equal(current.monitor_costs.input_applied, true);
      assert.equal(current.monitor_costs.status, "expired");
      assert.equal(source.projection!.policy.costs, null); assert.notEqual(current.effective_outcome, "decision_required");
      assert.deepEqual(parseInvestorState({ ...current, session_binding: "a".repeat(64) }, "a".repeat(64)), current);
    }
    assert.deepEqual(f.db.prepare("SELECT * FROM investor_models").all(), models);
    assert.deepEqual(f.db.prepare("SELECT * FROM investor_model_controls").all(), controls);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_monitor_cost_assumptions").get() as { n: number }).n, 1);
  } finally { f.close(); }
});
