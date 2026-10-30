import { getInvestorState } from "../src/server/investor/service";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { investorActor, investorFixture, saveSyntheticProfile, seedSyntheticCandidate, syntheticProfile } from "./investor-fixture";
import { hash } from "../src/server/ledger/service";
import { observationSchema, referencePlanSchema, researchTaskSchema } from "../src/server/investor/schemas";
import { phaseExecutionReview } from "../src/server/investor/research-execution";

export const displayBinding = "a".repeat(64), displayBefore = "2026-01-02T12:00:02.000Z";
export const displayUntil = "2026-01-02T12:00:03.000Z", displayFuture = "2026-01-05T12:00:00.000Z";
export function displayState(outcome: "observe" | "decision_required" = "decision_required", deadline: "review" | "plan" | "watch" = "review", confirmedRisk = false) {
  const fixture = investorFixture();
  try {
    saveSyntheticProfile(fixture, investorActor, confirmedRisk ? { ...syntheticProfile, loss_tolerance: "0.20" } : syntheticProfile);
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

// Fictional display contract only; this does not create qualified source evidence.
export function historicalDisplayState(saved = false) {
  const state = displayState("observe", "plan", true), plan = state.plan!;
  const document = referencePlanSchema.parse({ ...plan.document, data_mode: "reconstructed",
    reference_evidence: { request_id: "fictional-reference-request", run_id: "fictional-reference-run", source_input_id: "fictional-reference-source",
      experiment_id: "fictional-reference-experiment", manifest_hash: "b".repeat(64), result_hash: "c".repeat(64), selected_parameters_hash: "d".repeat(64),
      holdout_status: "not_independently_verified", qualification: "owner_reviewed_reconstructed" } });
  state.plan = { ...plan, document, content_hash: hash(document), saved_for_observation: saved };
  const gaps = [{ code: "RECONSTRUCTED_RESEARCH_ONLY", title: "Fictional historical reference; monitoring not ready",
    detail: "Fictional UI fixture, never provider or investment qualification", affected_markets: [], action: "Inspect fictional monitoring prerequisites" }];
  const latest = { ...state.latest!.document }; delete latest.model_change;
  state.latest = { ...state.latest!, candidate_plan_id: null, document: observationSchema.parse({ ...latest, outcome: "insufficient_evidence",
    data_cutoff: null, next_review_at: null, monitoring: "not_enabled", gaps, reasons: ["Fictional reference exists; current monitoring evidence is missing"] }) };
  state.latest.content_hash = hash(state.latest.document); state.observations = [state.latest];
  state.effective_outcome = "insufficient_evidence"; state.effective_gaps = gaps;
  const summary = { schema_version: "investor-phase-summary-v3", terminal_execution_failure_count: 0, corporate_action_cancellation_count: 0,
    resolved_corporate_action_cancellation_count: 0, unresolved_order_review_count: 0, order_review_lineage_hash: "e".repeat(64),
    failed_cash_intent_count: 0, pending_cash_intent_count: 0, cash_intent_lineage_hash: "f".repeat(64) };
  const checks = { execution_failure_count: 0, benchmark_execution_failure_count: 0,
    ...phaseExecutionReview({ ...summary, ...Object.fromEntries(Object.entries(summary).map(([key, value]) => ["benchmark_" + key, value])) }) };
  const evidence = document.reference_evidence!;
  state.research_task = researchTaskSchema.parse({ id: evidence.request_id, profile_id: state.profile!.id,
    profile_version: state.profile!.version, input_version: document.input_version, engine_version: "investor-diversified-reference-v3",
    status: "calculated", created_at: document.created_at, completed_at: document.created_at, reason_codes: ["RECONSTRUCTED_RESEARCH_ONLY"],
    live_advice_eligible: false, registry: { experiment_id: evidence.experiment_id, manifest_hash: evidence.manifest_hash,
      phases: { train: { registered: 1, completed: 1 }, validation: { registered: 1, completed: 1 }, holdout: { registered: 1, completed: 1 } },
      freeze_hash: "a".repeat(64), prior_window_exposures: 0, exposure_watermark: 3, holdout_status: evidence.holdout_status,
      coverage: "local_investor_trials_only", live_advice_eligible: false },
    study: { status: "reference_ready", qualification: evidence.qualification, result_hash: evidence.result_hash, implementation_hash: "a".repeat(64),
      phase_checks: ["train", "validation", "holdout"].map(phase => ({ phase, ...checks })),
      source_context: { range_start: "2025-01-01", range_end: "2026-01-01", valid_until: document.valid_until,
        basis: "owner_reviewed_historical_reconstruction", listings: document.targets.map(target => ({ listing_id: target.listing_id,
          provider_symbol: target.symbol, market: target.market, role: "growth" })) },
      candidates: [{ parameters_hash: evidence.selected_parameters_hash, weights: Object.fromEntries(document.targets.map(target => [target.listing_id, target.weight])),
        train_net_twr: "0.1", train_drawdown: "-0.1", benchmark_net_twr: "0.1", usable: true, stresses: [],
        train_checks: { metrics_complete: true, ...checks } }] } });
  state.model_watch = saved ? { id: "fictional-saved-watch", profile_id: state.profile!.id, plan_id: plan.id, plan_hash: hash(document),
    valid_until: document.valid_until, enabled: true, status: "awaiting_inputs", created_at: displayBefore, completed_at: null,
    next_check_at: null, checkpoint_sequence: 0, initial_notional_cny: "10000", model_nav_cny: null,
    source_qualification: "not_available", live_advice_eligible: false } : null;
  return parseInvestorState({ ...state, session_binding: displayBinding }, displayBinding);
}
