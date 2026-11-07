import assert from "node:assert/strict";
import test from "node:test";
import { currentResearchModelComposition, researchDecimalDifference } from "../src/components/workbench/investor-model-composition";
import { formatResearchWeightDelta } from "../src/components/workbench/research-format";
import { compositionDisplayState } from "./investor-model-composition-fixture";
import { displayBefore, displayUntil, displayState, historicalDisplayState } from "./investor-display-state-fixture";

const at = Date.parse(displayBefore);
test("current composition keeps whole-model weights and current values, never hypothetical funding targets or personal budgets", () => {
  for (const outcome of ["observe", "decision_required"] as const) {
    const state = compositionDisplayState(outcome), original = JSON.stringify(state), result = currentResearchModelComposition(state, at)!;
    assert.ok(result); assert.equal(result.model_nav_cny, "10000"); assert.equal(result.targets[0].observed_weight, "0.61");
    assert.equal(result.targets[1].observed_weight, "0.38"); assert.equal(result.targets[0].value_cny, "6100");
    assert.equal(result.targets[1].value_cny, "3800"); assert.equal(result.targets[0].weight_difference, "0.01");
    assert.equal(result.targets[1].weight_difference, "-0.02"); assert.equal(JSON.stringify(state), original);
    state.profile!.document.illustrative_budget_cny = "123456.78";
    state.profile!.document.planned_annual_contribution_cny = "1111.11";
    assert.deepEqual(currentResearchModelComposition(state, at), result);
  }
});
test("decimal weight differences preserve all source digits and distinguish tiny positive and negative deviations", () => {
  const tiny = "0." + "0".repeat(119) + "1";
  assert.equal(researchDecimalDifference("0.6" + "0".repeat(118) + "1", "0.6"), tiny);
  assert.equal(researchDecimalDifference("0.6", "0.6" + "0".repeat(118) + "1"), "-" + tiny);
  assert.equal(researchDecimalDifference("0.6000", "0.6"), "0");
  assert.equal(researchDecimalDifference("-0.1", "0.2"), "-0.3");
  assert.equal(formatResearchWeightDelta(tiny), "+<0.01 个百分点");
  assert.equal(formatResearchWeightDelta("-" + tiny), "-<0.01 个百分点");
  assert.equal(formatResearchWeightDelta("0"), "0.00 个百分点");
  assert.equal(formatResearchWeightDelta("0.01"), "+1.00 个百分点");
  assert.equal(formatResearchWeightDelta("-0.02"), "-2.00 个百分点");
  for (const value of ["1e-3", "01", "NaN", "0." + "1".repeat(121)]) assert.throws(() => researchDecimalDifference(value, "0"));
});
test("missing, synthetic, expired, paused, mismatched or unqualified evidence cannot become a current model composition", () => {
  for (const state of [displayState(), historicalDisplayState(false), historicalDisplayState(true)])
    assert.equal(currentResearchModelComposition(state, at), null);
  const changes: ((state: ReturnType<typeof compositionDisplayState>) => void)[] = [
    s => { s.effective_outcome = "insufficient_evidence"; }, s => { s.latest!.document.monitoring = "not_enabled"; },
    s => { s.model_watch!.enabled = false; s.model_watch!.status = "paused"; },
    s => { s.model_watch!.status = "outdated"; }, s => { s.model_watch!.status = "awaiting_evaluation"; },
    s => { s.model_watch!.source_qualification = "synthetic_test_only"; }, s => { s.model_watch!.checkpoint_sequence = 0; },
    s => { s.model_watch!.model_nav_cny = "10001"; }, s => { s.model_watch!.evaluation_input_version = "a".repeat(64); },
    s => { s.model_watch!.profile_id = "different-profile"; }, s => { s.model_watch!.plan_hash = "a".repeat(64); },
    s => { s.latest!.candidate_plan_id = "different-plan"; }, s => { s.latest!.document.profile_version++; },
    s => { s.profile!.document.loss_tolerance = null; }, s => { s.plan!.saved_for_observation = false; },
    s => { s.latest!.document.model_change!.changes.pop(); },
    s => { s.latest!.document.model_change!.changes[0].listing_id = "different-listing"; },
    s => { s.latest!.document.model_change!.changes[0].after_target_weight = "0.5"; },
    s => { s.latest!.document.model_change!.changes[0].observed_model_weight = "1.01"; },
    s => { s.latest!.document.model_change!.changes[0].observed_model_weight = "-0.01"; },
    s => { s.latest!.document.model_change!.changes[0].current_model_value_cny = "-1"; },
    s => { s.plan!.document.targets[1] = { ...s.plan!.document.targets[0] }; },
    s => { delete s.latest!.document.model_change!.market_cutoffs.CN; },
    s => { s.latest!.document.model_change!.market_cutoffs.CN = "2026-01-02T12:00:03.000Z"; },
  ];
  const base = compositionDisplayState();
  for (const change of changes) { const state = structuredClone(base); change(state); assert.equal(currentResearchModelComposition(state, at), null); }
  assert.equal(currentResearchModelComposition(base, Date.parse(displayUntil)), null);
  assert.equal(currentResearchModelComposition(base, NaN), null);
});
