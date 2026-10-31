import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";

function python(f: ReturnType<typeof investorFixture>, module: string, args: string[]) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args], {
    cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 262144, stdio: ["ignore", "pipe", "pipe"],
  }));
}
test("an actual concurrent owner command fences an already prepared monitor before a new cost input exists", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
    python(f, "tests.investor.managed_fx_monitor_fixture", ["--stage", "history"]);
    python(f, "tests.investor.queue_fixture", ["--mode", "core"]);
    const first = getInvestorState(f.db, actor, "2026-01-02T12:00:04.000Z"); assert.ok(first.plan);
    executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: first.plan.id, expected_revision: first.revision, idempotency_key: "fictional-race-model" }, "2026-01-02T12:00:04.000Z");
    python(f, "tests.investor.managed_fx_monitor_fixture", ["--stage", "seed"]);
    const at = "2026-01-02T12:05:04.000Z", state = getInvestorState(f.db, actor, at);
    executeInvestorCommand(f.db, actor, { action: "set_monitor_costs", model_id: state.model_watch!.id, model_hash: state.monitor_costs!.model_hash,
      expected_cost_version: 0, expected_revision: state.revision, idempotency_key: "fictional-initial-race-fees", acknowledged_research_only: true,
      costs: { commission_bps: "1", minimum_fee_cny: "1", fx_bps: "2", slippage_bps: "3", maximum_cost_fraction: "0.01" }, validity_days: 30 }, at);
    python(f, "tests.investor.queue_fixture", ["--mode", "core", "--now", "2026-01-02T12:05:04.001Z"]);
    const race = python(f, "tests.investor.monitor_cost_fixture", ["--stage", "race"]);
    assert.equal(race.status, "skipped"); assert.equal(race.result.code, "INVESTOR_MONITOR_SUPERSEDED"); assert.equal(race.unchanged, true);
    assert.equal(race.implementation_unchanged, true); assert.equal(race.source_input_unchanged, true);
    assert.equal(race.real_provider_called, false); assert.equal(race.real_gateway_called, false);
    const pending = getInvestorState(f.db, actor, race.at);
    assert.equal(pending.monitor_costs?.status, "pending"); assert.equal(pending.effective_outcome, "insufficient_evidence");
    assert.equal(pending.model_watch?.model_nav_cny, null); assert.equal(pending.monitor_costs?.version, 2);
    python(f, "tests.investor.queue_fixture", ["--mode", "core", "--now", "2026-01-02T12:16:04.004Z"]);
    const current = getInvestorState(f.db, actor, "2026-01-02T12:16:04.004Z");
    assert.equal(current.monitor_costs?.status, "known"); assert.equal(current.monitor_costs.costs?.fx_bps, "5");
    for (const name of ["portfolios","accounts","ledger_events","postings","approval_events","execution_reports"])
      assert.equal((f.db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0);
  } finally { f.close(); }
});
