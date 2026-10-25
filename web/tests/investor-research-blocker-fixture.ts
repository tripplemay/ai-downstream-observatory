import { researchTaskSchema } from "../src/server/investor/schemas";
import { hash } from "../src/server/ledger/service";
import { displayBefore, displayUntil, displayState } from "./investor-display-state-fixture";

/** Fictional display contract, not a provider-qualified source or investor account. */
export function blockedResearchDisplayState() {
  const state = displayState();
  state.plan = null;
  state.profile!.document.loss_tolerance = "0.30";
  state.research_task = researchTaskSchema.parse({ id: "fictional-train-hold", profile_id: state.profile!.id,
    profile_version: state.profile!.version, input_version: "e".repeat(64), engine_version: "investor-diversified-reference-v1",
    status: "calculated", created_at: displayBefore, completed_at: displayBefore,
    reason_codes: ["RECONSTRUCTED_RESEARCH_ONLY", "NO_CANDIDATE_WITHIN_CONFIRMED_RISK_BUDGET"], live_advice_eligible: false,
    registry: { experiment_id: "fictional-train-experiment", manifest_hash: "b".repeat(64),
      phases: { train: { registered: 1, completed: 1 }, validation: { registered: 0, completed: 0 }, holdout: { registered: 0, completed: 0 } },
      freeze_hash: null, prior_window_exposures: 0, exposure_watermark: 1, holdout_status: "not_independently_verified",
      coverage: "local_investor_trials_only", live_advice_eligible: false },
    study: { status: "insufficient_evidence", qualification: "owner_reviewed_reconstructed", result_hash: "c".repeat(64),
      implementation_hash: "d".repeat(64), phase_checks: [], source_context: { range_start: "2025-01-01", range_end: "2025-06-01",
        valid_until: displayUntil, basis: "owner_reviewed_historical_reconstruction",
        listings: [{ listing_id: "CN:ALPHA", provider_symbol: "501998.SH", market: "CN", role: "growth" }] },
      candidates: [{ parameters_hash: "f".repeat(64), weights: { "CN:ALPHA": "1" }, train_net_twr: "0.01", train_drawdown: "-0.01",
        benchmark_net_twr: "0.02", usable: false, stresses: [],
        train_checks: { metrics_complete: true, execution_failure_count: 1, benchmark_execution_failure_count: 2 } }] },
  });
  const gap = { code: "RECONSTRUCTED_RESEARCH_ONLY", title: "历史重建研究尚未形成观察方案",
    detail: "Fictional original immutable gap", affected_markets: ["CN" as const], action: "确认风险后完成参考方案与监测准入。" };
  const observation = state.latest!;
  observation.candidate_plan_id = null;
  observation.document = { ...observation.document, outcome: "insufficient_evidence", input_version: state.research_task.input_version,
    gaps: [gap], reasons: ["Fictional historical generic research explanation"], next_review_at: null,
    next_conditions: ["风险与流动性约束明确后复核"], monitoring: "not_enabled" };
  delete observation.document.model_change;
  observation.content_hash = hash(observation.document);
  state.observations = [observation];
  state.effective_gaps = [gap];
  state.effective_outcome = "insufficient_evidence";
  return state;
}
