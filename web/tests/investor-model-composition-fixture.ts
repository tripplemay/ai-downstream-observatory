import { historicalDisplayState, displayBefore, displayUntil, displayBinding } from "./investor-display-state-fixture";
import { observationSchema } from "../src/server/investor/schemas";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { hash } from "../src/server/ledger/service";

// A display-contract fixture only, never a qualified source or monitor producer.
export function compositionDisplayState(outcome: "observe" | "decision_required" = "observe") {
  const state = historicalDisplayState(true), previous = state.latest!, cutoff = "2026-01-02T11:59:00.000Z";
  const document = observationSchema.parse({ ...previous.document, outcome, evaluated_at: displayBefore,
    data_cutoff: cutoff, input_version: "f".repeat(64), next_review_at: displayUntil, monitoring: "active", gaps: [],
    model_change: { assessment_hash: "e".repeat(64), model_nav_cny: "10000", estimated_cost_cny: "1",
      hypothetical_cash_remaining_cny: "999", funding_status: outcome === "decision_required" ? "hypothetical_due" : "none",
      allocation_method: outcome === "decision_required" ? "contribution_repair_without_sales" : "none",
      market_cutoffs: { CN: cutoff, US: cutoff }, constraints_not_checked: ["lot_size", "tradability", "actual_cash", "settlement", "tax", "account_permissions"],
      changes: state.plan!.document.targets.map((target, i) => ({ listing_id: target.listing_id,
        before_target_weight: target.weight, after_target_weight: target.weight, observed_model_weight: i ? "0.38" : "0.61",
        current_model_value_cny: i ? "3800" : "6100", hypothetical_target_value_cny: "9000", difference_cny: "100",
        within_band: false, proposed_change_cny: outcome === "decision_required" ? "200" : "0", remaining_target_difference_cny: "100" })) },
  });
  state.latest = { ...previous, candidate_plan_id: state.plan!.id, content_hash: hash(document), document };
  state.observations = [state.latest]; state.effective_outcome = outcome; state.effective_gaps = [];
  state.model_watch = { ...state.model_watch!, status: outcome === "observe" ? "research_observe" : "research_decision",
    completed_at: displayBefore, next_check_at: displayUntil, checkpoint_sequence: 1, model_nav_cny: "10000",
    evaluation_input_version: document.input_version, source_qualification: "owner_reviewed_reconstructed" };
  return parseInvestorState({ ...state, session_binding: displayBinding }, displayBinding);
}
