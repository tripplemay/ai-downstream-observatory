import assert from "node:assert/strict";
import test from "node:test";
import { currentInvestorDisplay, currentPlanDisplay } from "../src/components/workbench/research-format";
import { displayBefore, displayUntil, displayState, historicalDisplayState } from "./investor-display-state-fixture";

test("current projection invalidates at the exact review boundary but never rewrites history or promotes evidence", () => {
  const state = displayState(), original = JSON.stringify(state), until = Date.parse(displayUntil);
  assert.equal(currentInvestorDisplay(state, until - 1).outcome, "decision_required");
  const stale = currentInvestorDisplay(state, until);
  assert.equal(stale.outcome, "insufficient_evidence"); assert.equal(stale.stale, true);
  assert.equal(stale.gaps[0].code, "MONITOR_REVIEW_OVERDUE"); assert.equal(JSON.stringify(state), original);
  assert.equal(state.latest!.document.outcome, "decision_required");
  const blocked = { ...state, effective_outcome: "insufficient_evidence" as const, effective_gaps: [{ ...stale.gaps[0], code: "FICTIONAL_MISSING_EVIDENCE" }] };
  assert.equal(currentInvestorDisplay(blocked, Date.parse(displayBefore)).outcome, "insufficient_evidence");
  assert.equal(currentInvestorDisplay(blocked, until).gaps.length, 2);
});
test("all plan modes lose current eligibility; reconstructed weights disappear and synthetic history remains explicitly expired", () => {
  const state = displayState("observe", "plan"), until = Date.parse(displayUntil), original = JSON.stringify(state);
  assert.equal(currentInvestorDisplay(state, until - 1).outcome, "observe");
  assert.equal(currentInvestorDisplay(state, until).outcome, "insufficient_evidence");
  assert.equal(currentInvestorDisplay(state, until).plan?.quality, "expired");
  const document = state.plan!.document; assert.ok(document.schema_version === "investor-reference-plan-v1");
  assert.equal(currentPlanDisplay({ ...state.plan!, document: { ...document, data_mode: "reconstructed" } }, until), null);
  assert.equal(currentPlanDisplay({ ...state.plan!, document: { ...document, data_mode: "live_observed" } }, until)?.quality, "expired");
  assert.equal(JSON.stringify(state), original);
});
test("model deadline synchronizes NAV and main conclusion, while server checked time is the minimum display baseline", () => {
  const state = displayState("observe", "watch"), until = Date.parse(displayUntil);
  const current = currentInvestorDisplay(state, until - 1); assert.equal(current.modelWatch?.model_nav_cny, "12345.67");
  const stale = currentInvestorDisplay(state, until); assert.equal(stale.modelWatch?.status, "overdue");
  assert.equal(stale.modelWatch?.model_nav_cny, null); assert.equal(stale.outcome, "insufficient_evidence");
  assert.ok(stale.gaps.some(gap => gap.code === "MONITOR_NOT_CURRENT"));
  const checkedAfter = { ...state, checked_at: displayUntil };
  assert.equal(currentInvestorDisplay(checkedAfter, until - 1).outcome, "insufficient_evidence");
  assert.equal(currentInvestorDisplay({ ...state, effective_gaps: stale.gaps }, until).gaps.length, stale.gaps.length);
});
test("source-context expiry hides candidates and registry without deleting the saved study or unrelated server gaps", () => {
  const state = displayState(), until = Date.parse(displayUntil);
  // Only the lifetime fields are consumed here; full reconstructed producer validation is tested separately.
  const task = { status: "calculated", reason_codes: [], study: { source_context: { valid_until: displayUntil } }, registry: { fictional: true } };
  const input = { ...state, research_task: task as unknown as NonNullable<typeof state.research_task> };
  assert.equal(currentInvestorDisplay(input, until - 1).researchTask, task);
  const result = currentInvestorDisplay(input, until);
  assert.equal(result.researchTask?.status, "outdated"); assert.equal(result.researchTask?.study, null); assert.equal(result.researchTask?.registry, null);
  assert.ok(result.gaps.some(gap => gap.code === "REFERENCE_SOURCE_EXPIRED")); assert.notEqual(input.research_task.study, null);
});

test("reference progress distinguishes generated and saved artifacts without promoting missing monitoring evidence", () => {
  for (const saved of [false, true]) {
    const state = historicalDisplayState(saved), original = JSON.stringify(state);
    const view = currentInvestorDisplay(state, Date.parse(displayBefore));
    assert.equal(view.outcome, "insufficient_evidence"); assert.equal(view.stale, false);
    assert.equal(view.referenceProgress?.title, saved ? "研究方案已保存，监测尚未就绪" : "历史参考组合已生成");
    assert.equal(view.referenceProgress?.href, saved ? "#research-model-watch" : "#research-reference-plan");
    assert.equal(view.gaps[0].code, "RECONSTRUCTED_RESEARCH_ONLY");
    assert.equal(state.model_watch?.model_nav_cny ?? null, null);
    assert.equal(JSON.stringify(state), original);
    assert.equal(currentInvestorDisplay(state, Date.parse(displayUntil)).referenceProgress, null);
  }
});
test("progress cannot hide source invalidation, unknown risk, profile changes, failed monitoring or actual outcomes", () => {
  const before = Date.parse(displayBefore);
  const states = [historicalDisplayState(), historicalDisplayState(true), historicalDisplayState(true), historicalDisplayState(),
    historicalDisplayState(), historicalDisplayState(true), historicalDisplayState(), historicalDisplayState(true)];
  states[0].effective_gaps[0].code = "REFERENCE_SOURCE_NO_LONGER_CURRENT";
  states[1].model_watch!.status = "failed";
  states[2].model_watch!.plan_id = "fictional-other-plan";
  states[3].profile!.document.loss_tolerance = null;
  states[4].plan!.quality = "different_profile";
  states[5].model_watch!.profile_id = "fictional-other-profile";
  states[6].read_only = true;
  states[7].effective_outcome = "decision_required";
  for (const state of states) assert.equal(currentInvestorDisplay(state, before).referenceProgress, null);
  assert.equal(currentInvestorDisplay(displayState("observe"), before).referenceProgress, null);
});
test("paused and blocked observation are described without claiming successful monitoring or enabling anything", () => {
  const state = historicalDisplayState(true);
  state.model_watch!.enabled = false; state.model_watch!.status = "paused";
  assert.equal(currentInvestorDisplay(state, Date.parse(displayBefore)).referenceProgress?.title, "研究方案已保存，观察任务已暂停");
  state.model_watch!.enabled = true; state.model_watch!.status = "blocked";
  const view = currentInvestorDisplay(state, Date.parse(displayBefore));
  assert.equal(view.referenceProgress?.title, "研究方案已保存，监测证据仍不足");
  assert.equal(view.outcome, "insufficient_evidence");
});
