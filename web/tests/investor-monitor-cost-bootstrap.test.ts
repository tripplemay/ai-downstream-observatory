import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { readInvestorMonitorEvidenceSource } from "../src/server/investor/monitor-source";

function python(filename: string, module: string, args: string[]) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", filename, ...args], {
    cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 262144, stdio: ["ignore", "pipe", "pipe"],
  }));
}
test("an ordinary owner cost declaration made before any monitor input is bound by automatic first-input bootstrap", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
    python(f.filename, "tests.investor.managed_fx_monitor_fixture", ["--stage", "history", "--fixed-policy-v2"]);
    python(f.filename, "tests.investor.queue_fixture", ["--mode", "core"]);
    const initial = getInvestorState(f.db, actor, "2026-01-02T12:00:04.000Z"); assert.ok(initial.plan);
    executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: initial.plan.id, expected_revision: initial.revision,
      idempotency_key: "fictional-cost-before-bootstrap-model" }, "2026-01-02T12:00:04.000Z");
    const before = getInvestorState(f.db, actor, "2026-01-02T12:05:02.000Z"); assert.ok(before.monitor_costs?.editable);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_monitor_evidence_inputs").get() as { n: number }).n, 0);
    const protectedRows = ["investor_profiles", "investor_reference_plans", "investor_models", "investor_model_controls", "investor_plan_selections",
      "investor_research_requests", "investor_research_runs", "investor_trial_results", "research_trials"];
    const stable = () => protectedRows.map(name => ({ name, rows: f.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() }));
    const frozen = stable();
    executeInvestorCommand(f.db, actor, { action: "set_monitor_costs", model_id: before.model_watch!.id,
      model_hash: before.monitor_costs.model_hash, expected_cost_version: 0, expected_revision: before.revision,
      idempotency_key: "fictional-cost-before-bootstrap", costs: { commission_bps: "1", minimum_fee_cny: "1", fx_bps: "2", slippage_bps: "3", maximum_cost_fraction: "0.01" },
      validity_days: 7, acknowledged_research_only: true }, "2026-01-02T12:05:02.000Z");
    const pending = getInvestorState(f.db, actor, "2026-01-02T12:05:02.001Z");
    assert.equal(pending.monitor_costs?.status, "pending"); assert.equal(pending.model_watch?.model_nav_cny, null);
    const result = python(f.filename, "tests.investor.managed_fx_monitor_fixture", ["--stage", "seed", "--owner-costs-before-seed"]);
    assert.equal(result.real_provider_called, false); assert.equal(result.real_gateway_called, false);
    assert.equal(result.fx_mock_calls, 1); assert.equal(result.expected_cost_gap, null); assert.equal(result.checkpoints, 1);
    const current = getInvestorState(f.db, actor, result.at); assert.equal(current.monitor_costs?.status, "known");
    const source = readInvestorMonitorEvidenceSource(f.db, current.workspace_id!, current.model_watch!.id, result.input_id, result.at);
    assert.equal(source.unavailable_reason, null); assert.equal(source.document.schema_version, "investor-monitor-data-input-v3");
    assert.deepEqual(source.projection, result.projection); assert.deepEqual(source.projection!.policy.costs, current.monitor_costs!.costs);
    assert.deepEqual(stable(), frozen);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_monitor_evidence_inputs").get() as { n: number }).n, 1);
    assert.equal((f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='investor_bootstrap_monitor_source'").get() as { n: number }).n, 1);
    for (const name of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
      assert.equal((f.db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0);
  } finally { f.close(); }
});
