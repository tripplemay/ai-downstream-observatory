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
function helper(f: F, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args], {
    cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 262144, stdio: ["ignore", "pipe", "pipe"],
  })) as { document: Obj; projection: Obj; registered_input_id: string; stubbed_sdk_calls: number; real_provider_called: boolean; real_gateway_called: boolean };
}

test("default provider acquires missing prices and core seeds both saved model versions; Node independently replays the standard receipt", () => {
  for (const fixed of [false, true]) {
    const f = investorFixture();
    try {
      saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
      helper(f, "tests.investor.evidence_fixture", ["--initial-monitor-calendar", ...(fixed ? ["--fixed-policy-v2"] : [])]);
      helper(f, "tests.investor.queue_fixture", ["--mode", "core"]);
      const at = "2026-01-02T12:00:04.000Z", state = getInvestorState(f.db, actor, at); assert.ok(state.plan);
      executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan.id, expected_revision: state.revision,
        idempotency_key: "save-initial-reference" }, at);
      const saved = getInvestorState(f.db, actor, at), value = helper(f, "tests.investor.initial_price_fixture");
      assert.equal(value.stubbed_sdk_calls, 2); assert.equal(value.real_provider_called, false); assert.equal(value.real_gateway_called, false);
      assert.equal(value.document.schema_version, "investor-monitor-data-input-v1");
      const current = "2026-01-03T12:00:04.000Z", before = f.db.prepare("SELECT total_changes() n").get();
      const source = readInvestorMonitorEvidenceSource(f.db, saved.workspace_id!, saved.model_watch!.id, value.registered_input_id, current);
      assert.equal(source.unavailable_reason, null); assert.deepEqual(source.projection, value.projection);
      const monitored = getInvestorState(f.db, actor, current);
      assert.equal(monitored.effective_outcome, "insufficient_evidence"); assert.equal(monitored.model_watch?.status, "blocked");
      assert.equal(monitored.model_watch?.checkpoint_sequence, 0); assert.equal(monitored.live_advice_eligible, false);
      assert.deepEqual(parseInvestorState({ ...monitored, session_binding: "a".repeat(64) }, "a".repeat(64)), monitored);
      assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
      assert.equal((f.db.prepare("SELECT count(*) n FROM investor_initial_price_runs WHERE status='collected'").get() as { n: number }).n, 2);
      for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
        assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
    } finally { f.close(); }
  }
});
