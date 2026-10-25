import assert from "node:assert/strict";
import test from "node:test";
import { currentInvestorDisplay } from "../src/components/workbench/research-format";
import { displayBefore, displayUntil, displayState } from "./investor-display-state-fixture";
import { blockedResearchDisplayState } from "./investor-research-blocker-fixture";

const before = Date.parse(displayBefore);
test("the current bound train failure replaces only generic guidance, never the immutable observation or risk answer", () => {
  const state = blockedResearchDisplayState(), original = JSON.stringify(state);
  const view = currentInvestorDisplay(state, before);
  assert.match(view.researchBlocker!.title, /训练模拟执行有缺口/);
  assert.match(view.gaps[0].detail, /不能据此判定你的风险预算过低/);
  assert.doesNotMatch(view.gaps[0].action, /确认风险后|提高风险预算/);
  assert.match(view.gaps[0].action, /不通过提高风险或反复重跑/);
  assert.equal(view.outcome, "insufficient_evidence"); assert.equal(view.stale, false);
  assert.equal(JSON.stringify(state), original);
  assert.match(state.latest!.document.gaps[0].action, /确认风险后/);
});
test("other gaps, confirmed risk failures, active models and synthetic or mismatched studies are never reclassified", () => {
  const variants: Array<(s: ReturnType<typeof blockedResearchDisplayState>) => void> = [
    s => { s.research_task!.profile_id = "other-profile"; },
    s => { s.research_task!.profile_version++; },
    s => { s.latest!.document.input_version = "a".repeat(64); },
    s => { s.latest!.document.profile_id = "other-profile"; },
    s => { s.latest!.document.profile_version++; },
    s => { s.effective_gaps[0] = { ...s.effective_gaps[0], code: "REFERENCE_SOURCE_REVOKED" }; },
    s => { s.effective_gaps.push({ ...s.effective_gaps[0], code: "REFERENCE_SOURCE_EXPIRED" }); },
    s => { s.effective_gaps.push({ ...s.effective_gaps[0], code: "RISK_BUDGET_UNCONFIRMED" }); },
    s => { s.research_task!.study!.qualification = "synthetic_test_only"; delete s.research_task!.study!.source_context; },
    s => { s.research_task!.study!.candidates[0].usable = true; },
    s => { s.profile!.document.loss_tolerance = null; },
    s => { s.research_task!.status = "running"; },
    s => { s.research_task!.completed_at = displayUntil; },
    s => { s.research_task!.reason_codes = ["NO_CANDIDATE_WITHIN_CONFIRMED_RISK_BUDGET"]; },
    s => { s.research_task!.reason_codes.push("SELECTED_CANDIDATE_FAILED_VALIDATION"); },
    s => { s.model_watch = displayState("observe", "watch").model_watch; },
    s => { s.plan = displayState("observe", "plan").plan; },
    s => { s.effective_outcome = "observe"; },
  ];
  for (const mutate of variants) {
    const state = blockedResearchDisplayState(); mutate(state);
    const original = JSON.stringify(state), view = currentInvestorDisplay(state, before);
    assert.equal(view.researchBlocker, null); assert.deepEqual(view.gaps, state.effective_gaps);
    assert.equal(JSON.stringify(state), original);
  }
});
test("source expiry wins even while the browser clock is earlier than the verified baseline", () => {
  for (const state of [blockedResearchDisplayState(), { ...blockedResearchDisplayState(), checked_at: displayUntil }]) {
    const view = currentInvestorDisplay(state, state.checked_at === displayUntil ? before : Date.parse(displayUntil));
    assert.equal(view.researchBlocker, null); assert.equal(view.researchTask!.status, "outdated");
    assert.equal(view.gaps[0].code, "REFERENCE_SOURCE_EXPIRED"); assert.equal(view.stale, true);
  }
});
test("a bound later-phase hold retains its phase and frozen-candidate warning, not generic risk confirmation", () => {
  const state = blockedResearchDisplayState();
  state.research_task!.reason_codes = ["RECONSTRUCTED_RESEARCH_ONLY", "SELECTED_CANDIDATE_FAILED_VALIDATION"];
  state.research_task!.registry!.freeze_hash = "b".repeat(64);
  state.research_task!.registry!.phases.validation = { registered: 1, completed: 1 };
  state.research_task!.study!.phase_checks = [{ phase: "train", execution_failure_count: 0, benchmark_execution_failure_count: 0 },
    { phase: "validation", execution_failure_count: 1, benchmark_execution_failure_count: 0 }];
  const view = currentInvestorDisplay(state, before);
  assert.match(view.researchBlocker!.title, /验证期未通过/);
  assert.match(view.gaps[0].action, /不会改选候选或自动启用监测/);
  assert.equal(view.outcome, "insufficient_evidence");
});
