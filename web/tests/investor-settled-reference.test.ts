import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { currentInvestorDisplay } from "../src/components/workbench/research-format";

test("ordinary v6 admission/core/read/save/watch/review retains completed funding evidence without financial writes", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
    const helper = (module: string, args: string[]) => {
      const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args], {
        cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 65536 });
      assert.equal(child.status, 0, child.stderr);
    };
    helper("tests.investor.evidence_fixture", ["--fixed-policy-v2", "--settled-intent-execution-v6"]);
    helper("tests.investor.queue_fixture", ["--mode", "core"]);
    const now = "2026-01-02T12:00:04.000Z", binding = "a".repeat(64);
    let state = getInvestorState(f.db, actor, now);
    assert(state.plan && state.research_task?.study);
    assert.equal(state.research_task.engine_version, "investor-diversified-reference-v3");
    assert(state.plan.document.strategy_version.includes("+settled-cash-v1"));
    const checks = state.research_task.study.candidates[0].train_checks!;
    assert.equal(checks.cash_intent_review?.strategy.failed_intents, 0);
    assert.equal(checks.cash_intent_review?.benchmark.pending_intents, 0);
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    const stripped = structuredClone(state); delete stripped.research_task!.study!.candidates[0].train_checks!.cash_intent_review;
    assert.throws(() => parseInvestorState({ ...stripped, session_binding: binding }, binding), /RESPONSE_INVALID/);
    executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan.id,
      expected_revision: state.revision, idempotency_key: "fictional-v6-save" }, now);
    assert.equal(getInvestorState(f.db, actor, now).model_watch?.status, "awaiting_inputs");
    helper("tests.investor.monitor_data_fixture", ["--admit", "--monitor", "--later", "--funding"]);
    const later = "2026-01-03T12:15:04.000Z";
    state = getInvestorState(f.db, actor, later);
    assert.equal(state.model_watch?.status, "research_decision");
    executeInvestorCommand(f.db, actor, { action: "review", observation_id: state.latest!.id, decision: "defer",
      note: "Fictional review only", expected_revision: state.revision, idempotency_key: "fictional-v6-review" }, later);
    assert.equal(getInvestorState(f.db, actor, later).decisions[0]?.decision, "defer");
    for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
      assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
  } finally { f.close(); }
});

test("ordinary orphan summary cannot be displayed as usable or stripped into an older engine", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
    for (const [module, flags] of [["tests.investor.evidence_fixture", ["--fixed-policy-v2", "--settled-intent-execution-v6", "--train-settled-orphan"]],
      ["tests.investor.queue_fixture", ["--mode", "core"]]] as const) {
      const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...flags],
        { cwd: path.resolve(".."), encoding: "utf8", timeout: 60000 });
      assert.equal(child.status, 0, child.stderr);
    }
    const now = "2026-01-02T12:00:04.000Z", binding = "a".repeat(64), state = getInvestorState(f.db, actor, now);
    parseInvestorState({ ...state, session_binding: binding }, binding);
    assert.equal(state.plan, null); assert.equal(state.model_watch, null);
    assert.equal(state.research_task!.registry!.phases.validation.registered, 0);
    const candidate = state.research_task!.study!.candidates[0];
    assert.equal(candidate.train_checks!.execution_failure_count, 0);
    assert(candidate.train_checks!.cash_intent_review!.strategy.failed_intents > 0);
    assert.equal(candidate.usable, false);
    assert.match(currentInvestorDisplay(state, Date.parse(now)).researchBlocker!.title, /交收后买入意图未完成/);
    const forged = structuredClone(state); forged.research_task!.engine_version = "investor-diversified-reference-v2";
    assert.throws(() => parseInvestorState({ ...forged, session_binding: binding }, binding), /RESPONSE_INVALID/);
  } finally { f.close(); }
});
