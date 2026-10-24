import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { hash } from "../src/server/ledger/service";
import { replayBoundedComparison, type BoundedResearchPlan } from "../src/server/investor/bounded-research";
import { verifyInvestorKernelResult } from "../src/server/investor/kernel-contracts";
import type { ContinuousDataset } from "../src/server/investor/continuous-market";
import type { ContinuousParameters } from "../src/server/investor/continuous-economics";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { prepareFundedStudyInputs } from "../src/server/investor/funded-study-input";
import type { InvestorFundingPlan } from "../src/server/investor/funding-schemas";
import { parseInvestorState } from "../src/components/workbench/investor-client";

function python(script: string, input?: unknown) {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", script], {
    cwd: path.resolve(".."), encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input), timeout: 60000, maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}
type Vector = { input: { dataset: ContinuousDataset; plan: BoundedResearchPlan; parameters: ContinuousParameters; phase: "train" | "validation" | "holdout" }; result: unknown };
const vectors: Vector[] = python("import json; from tests.research.action_aware_fixtures import vectors; print(json.dumps(vectors()))");

test("v4 full independent replay includes causal deferral, split ordering, late knowledge, funding and non-deployment", () => {
  for (const { input, result } of vectors) assert.deepEqual(replayBoundedComparison(input.dataset, input.plan, input.parameters, input.phase), result);
});

test("v4 cannot be downgraded to v3 or omit its explicit action policy", () => {
  const { input } = vectors[0];
  const missing = structuredClone(input.plan); delete missing.execution.order_action_policy;
  assert.throws(() => replayBoundedComparison(input.dataset, missing, input.parameters, input.phase));
  const downgraded = { ...input.plan, schema_version: "research-plan-v3" as const };
  assert.throws(() => replayBoundedComparison(input.dataset, downgraded, input.parameters, input.phase));
});

test("v4 kernel validates full causal economics even after an attacker coherently reseals summary metrics", () => {
  const f = python("import json; from tests.research.action_aware_fixtures import case; from tests.investor.fixtures import profile; from worker.investor.strategy import research_reference; d,p,s=case(); pref=profile('0.30'); print(json.dumps({'request':{'action':'research','dataset':d,'plan':p,'policy':s,'profile':pref},'result':research_reference(d,p,s,pref,allow_synthetic=True)}))");
  assert.equal(f.result.status, "reference_ready");
  assert.equal(verifyInvestorKernelResult(f.request, f.result).status, "reference_ready");
  const unsupported = prepareFundedStudyInputs({} as InvestorFundingPlan, { payload: f.request,
    created_at: "2026-01-01T00:00:00Z", range_start: "2025-01-01", range_end: "2025-06-10" }, "2026-01-01T00:00:00Z", f.request.profile);
  assert.deepEqual(unsupported.reason_codes, ["FUNDED_STUDY_ACTION_AWARE_EXECUTION_NOT_SUPPORTED"]);
  assert.deepEqual(unsupported.inputs, []);
  f.result.candidates[0].train.profit_cny = "999";
  const { result_hash: ignored, ...body } = f.result; void ignored; f.result.result_hash = hash(body);
  assert.throws(() => verifyInvestorKernelResult(f.request, f.result), /INVESTOR_KERNEL_RESULT_INVALID|INVESTOR_BOUNDED_RESEARCH_REPLAY_MISMATCH/);
});

test("v4 normal source admission and default core generate a verified reference without financial writes", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
    const helper = (module: string, args: string[] = []) => {
      const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args], {
        cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 65536,
      });
      assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
    };
    helper("tests.investor.evidence_fixture", ["--fixed-policy-v2", "--action-aware-execution-v4"]);
    helper("tests.investor.queue_fixture", ["--mode", "core"]);
    const now = "2026-01-02T12:00:04.000Z";
    let state = getInvestorState(f.db, actor, now);
    assert(state.plan);
    assert(state.plan.document.strategy_version.includes("+bounded-close-v1+action-aware-close-v1+fixed-policy-v2"));
    assert(state.plan.document.estimated_cost.includes("整批暂不建单"));
    const binding = "a".repeat(64);
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan.id, expected_revision: state.revision, idempotency_key: "synthetic-v4-save" }, now);
    state = getInvestorState(f.db, actor, now); assert.equal(state.model_watch?.status, "awaiting_inputs");
    helper("tests.investor.monitor_data_fixture", ["--admit", "--monitor", "--later", "--funding"]);
    state = getInvestorState(f.db, actor, "2026-01-03T12:15:04.000Z");
    assert.equal(state.model_watch?.status, "research_decision");
    executeInvestorCommand(f.db, actor, { action: "review", observation_id: state.latest!.id, decision: "defer", note: "Fictional review only", expected_revision: state.revision, idempotency_key: "synthetic-v4-review" }, "2026-01-03T12:15:04.000Z");
    assert.equal(getInvestorState(f.db, actor, "2026-01-03T12:15:04.000Z").decisions[0]?.decision, "defer");
    for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
      assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
  } finally { f.close(); }
});
