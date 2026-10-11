import assert from "node:assert/strict";
import test from "node:test";
import { currentInvestorDisplay, currentPlanDisplay } from "../src/components/workbench/research-format";
import { displayBefore, displayUntil, displayState } from "./investor-display-state-fixture";

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
