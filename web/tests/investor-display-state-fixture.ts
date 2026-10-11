import { getInvestorState } from "../src/server/investor/service";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { investorActor, investorFixture, saveSyntheticProfile, seedSyntheticCandidate } from "./investor-fixture";

export const displayBinding = "a".repeat(64), displayBefore = "2026-01-02T12:00:02.000Z";
export const displayUntil = "2026-01-02T12:00:03.000Z", displayFuture = "2026-01-05T12:00:00.000Z";
export function displayState(outcome: "observe" | "decision_required" = "decision_required", deadline: "review" | "plan" | "watch" = "review") {
  const fixture = investorFixture();
  try {
    saveSyntheticProfile(fixture);
    seedSyntheticCandidate(fixture, outcome, investorActor, { nextReview: deadline === "review" ? displayUntil : displayFuture,
      validUntil: deadline === "plan" ? displayUntil : displayFuture });
    const state = getInvestorState(fixture.db, investorActor, displayBefore);
    if (deadline === "watch") state.model_watch = { id: "fictional-display-model", profile_id: state.profile!.id, plan_id: state.plan!.id,
      plan_hash: state.plan!.content_hash, valid_until: displayFuture, enabled: true, status: "synthetic_preview", created_at: displayBefore,
      completed_at: displayBefore, next_check_at: displayUntil, checkpoint_sequence: 1, initial_notional_cny: "10000", model_nav_cny: "12345.67",
      evaluation_input_version: state.latest!.document.input_version, source_qualification: "synthetic_test_only", live_advice_eligible: false };
    // The optional watch is an invented contract fixture, not a qualified monitor producer.
    return parseInvestorState({ ...state, session_binding: displayBinding }, displayBinding);
  } finally { fixture.close(); }
}
