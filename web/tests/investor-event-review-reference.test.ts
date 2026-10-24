import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { hash } from "../src/server/ledger/service";
import { verifyInvestorKernelResult } from "../src/server/investor/kernel-contracts";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { parseInvestorState } from "../src/components/workbench/investor-client";

function python(script: string) {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", script], {
    cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}
const vector = () => python("import json; from tests.research.event_review_fixtures import case; from tests.investor.fixtures import profile; from worker.investor.strategy import research_reference; d,p,s=case(); pref=profile('0.30'); print(json.dumps({'request':{'action':'research','dataset':d,'plan':p,'policy':s,'profile':pref},'result':research_reference(d,p,s,pref,allow_synthetic=True)}))");

test("explicit v2 admission independently reproduces resolved cancellations without downgrading old policy", () => {
  const f = vector();
  assert.equal(f.result.status, "reference_ready");
  assert.equal(verifyInvestorKernelResult(f.request, f.result).engine_version, "investor-diversified-reference-v2");
  assert(f.result.candidates.every((row: { train: { execution_failure_count: number } }) => row.train.execution_failure_count > 0));
  const old = structuredClone(f.request); old.policy.schema_version = "investor-strategy-policy-v1"; delete old.policy.execution_admission;
  assert.throws(() => verifyInvestorKernelResult(old, f.result));
  const stripped = structuredClone(f.result); stripped.schema_version = "investor-strategy-result-v1"; stripped.engine_version = "investor-diversified-reference-v1";
  const { result_hash: ignored, ...body } = stripped; void ignored; stripped.result_hash = hash(body);
  assert.throws(() => verifyInvestorKernelResult(f.request, stripped));
});

test("resealed cancellation counts and lineage cannot self-certify a completed review", () => {
  const f = vector();
  for (const [key, value] of [["execution_failure_count", 0], ["resolved_corporate_action_cancellation_count", 0],
    ["unresolved_order_review_count", 1], ["order_review_lineage_hash", "0".repeat(64)]] as const) {
    const forged = structuredClone(f.result); forged.candidates[0].train[key] = value;
    const { result_hash: ignored, ...body } = forged; void ignored; forged.result_hash = hash(body);
    assert.throws(() => verifyInvestorKernelResult(f.request, forged), /INVESTOR_KERNEL_RESULT_INVALID|INVESTOR_BOUNDED_RESEARCH_REPLAY_MISMATCH/);
  }
});

test("ordinary admission, core, read model, save, monitor and human review preserve v5 lineage and no financial writes", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
    const helper = (module: string, args: string[] = []) => {
      const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args], {
        cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 65536,
      });
      assert.equal(child.status, 0, child.stderr);
    };
    helper("tests.investor.evidence_fixture", ["--fixed-policy-v2", "--event-review-execution-v5"]);
    helper("tests.investor.queue_fixture", ["--mode", "core"]);
    const now = "2026-01-02T12:00:04.000Z", binding = "a".repeat(64);
    let state = getInvestorState(f.db, actor, now);
    assert(state.plan); assert(state.research_task?.study);
    assert.equal(state.research_task.engine_version, "investor-diversified-reference-v2");
    assert(state.plan.document.strategy_version.includes("+event-review-v1"));
    assert(state.plan.document.estimated_cost.includes("原始取消仍展示"));
    const checks = state.research_task.study.candidates[0].train_checks!;
    assert(checks.execution_failure_count > 0);
    assert.equal(checks.execution_review?.strategy.terminal_failure_count, 0);
    assert.equal(checks.execution_review?.strategy.unresolved_reviews, 0);
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    const stripped = structuredClone(state); delete stripped.research_task!.study!.candidates[0].train_checks!.execution_review;
    assert.throws(() => parseInvestorState({ ...stripped, session_binding: binding }, binding), /RESPONSE_INVALID/);
    executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan.id, expected_revision: state.revision, idempotency_key: "synthetic-v5-save" }, now);
    assert.equal(getInvestorState(f.db, actor, now).model_watch?.status, "awaiting_inputs");
    helper("tests.investor.monitor_data_fixture", ["--admit", "--monitor", "--later", "--funding"]);
    const later = "2026-01-03T12:15:04.000Z";
    state = getInvestorState(f.db, actor, later); assert.equal(state.model_watch?.status, "research_decision");
    executeInvestorCommand(f.db, actor, { action: "review", observation_id: state.latest!.id, decision: "defer", note: "Fictional review only", expected_revision: state.revision, idempotency_key: "synthetic-v5-review" }, later);
    assert.equal(getInvestorState(f.db, actor, later).decisions[0]?.decision, "defer");
    for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
      assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
  } finally { f.close(); }
});
