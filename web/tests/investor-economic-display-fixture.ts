import { parseInvestorState } from "../src/components/workbench/investor-client";
import { fundingTimeline, type InvestorFundingPlan } from "../src/server/investor/funding-schemas";
import { fundedStudyDenials } from "../src/server/investor/funded-study-schemas";
import { fundedComparisonSchema, fundedComparisonDenials } from "../src/server/investor/funded-comparison-schemas";
import { fundedAnalysisSchema } from "../src/server/investor/funded-analysis-schemas";
import { analyzeFundedTrace } from "../src/server/investor/funded-analysis-math";
import { continuousPerformance } from "../src/server/investor/continuous-performance";
import { economicInstant } from "../src/server/investor/continuous-market";
import { Decimal } from "../src/server/ledger/decimal";
import type { runContinuousEconomics } from "../src/server/investor/continuous-economics";
import { displayState, displayBinding, displayBefore, displayUntil } from "./investor-display-state-fixture";

// Invented strict client contracts and arithmetic trace, not a persisted/qualified research producer.
export function economicDisplayFixture() {
  const base = displayState();
  const document: InvestorFundingPlan = { schema_version: "investor-funding-plan-v1", start_date: "2026-01-01", horizon_years: 1,
    evaluation_timezone: "Asia/Shanghai", initial_capital_cny: "100", annual_contribution_cny: "0", first_annual_date: null,
    entry_method: "immediate", actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false };
  const plan = { id: "fictional-display-funding", version: 1, profile_id: base.profile!.id, profile_hash: base.profile!.content_hash,
    content_hash: "f".repeat(64), created_at: displayBefore, document, timeline: fundingTimeline(document) };
  const state = parseInvestorState({ ...base, session_binding: displayBinding,
    funding: { status: "planned", plan, actual_cash_linked: false, execution_authorized: false, live_advice_eligible: false },
    funded_study: { id: "fictional-display-study", profile_id: base.profile!.id, funding_plan_id: plan.id, input_version: "e".repeat(64),
      status: "calculated_unverified", created_at: displayBefore, completed_at: displayBefore, historical_start_date: "2025-01-01",
      candidate_count: 1, reason_codes: [], ...fundedStudyDenials } }, displayBinding);
  const curve = [{ at: "2025-01-01T00:00:00Z", unit_nav: "1", nav_cny: "100", profit_cny: "0", principal_cny: "100", cash_cny: "0", locked_cash_cny: "0" },
    { at: "2025-01-02T00:00:00Z", unit_nav: "1.01", nav_cny: "101", profit_cny: "1", principal_cny: "100", cash_cny: "0", locked_cash_cny: "0" }];
  const trace = { curve, ...continuousPerformance(economicInstant(curve[0].at), economicInstant(curve[1].at), new Decimal(100), new Decimal(101), [], curve, "UTC"),
    ending_nav_cny: "101", profit_cny: "1", fees_cny: "0", fx_fees_cny: "0", slippage_cny: "0", cash_rounding_cny: "0", ending_cash_ratio: "0", execution_failure_count: 0 };
  const series = analyzeFundedTrace(trace as unknown as ReturnType<typeof runContinuousEconomics>, "UTC"), parameters = "c".repeat(64);
  const comparison = fundedComparisonSchema.parse({ schema_version: "investor-funded-comparison-v1", workspace_id: state.workspace_id,
    workspace_revision: state.revision, profile_id: state.profile!.id, funding_plan_id: plan.id, request_id: state.funded_study!.id,
    input_version: state.funded_study!.input_version, run_id: "fictional-display-run", checked_at: displayBefore, valid_until: displayUntil,
    status: "verified_retrospective", reason_codes: [], ...fundedComparisonDenials, economics_independently_replayed: true,
    candidates: [{ parameters_hash: parameters, result_hash: "d".repeat(64), economics_hash: "b".repeat(64), status: "verified_retrospective", reason_code: null,
      rebalance: "first_decision_each_year", allocation: [{ asset_id: "fictional-display-asset", symbol: "FICTIONAL_DISPLAY_ETF", market: "US", currency: "USD", role: "growth", weight: "1" }],
      paths: { immediate: series.summary, staged: series.summary } }] });
  const { candidates: ignored, ...context } = comparison; void ignored;
  const analysis = fundedAnalysisSchema.parse({ ...context, schema_version: "investor-funded-path-analysis-v1",
    parameters_hash: parameters, path: "immediate", analysis: {
      path: "immediate", evaluation_timezone: "UTC", window: { start: curve[0].at, end: curve[1].at }, parameters_hash: parameters,
      input_hash: "a".repeat(64), economics_hash: comparison.candidates[0].economics_hash!, candidate_summary_verified: true,
      candidate: series, baseline: series, baseline_rule: "same_weights_hold_new_cash_repair_v1", baseline_rule_hash: "a".repeat(64), baseline_preregistered: false,
      curve_basis: "last_observed_point_per_local_date_full_window_not_interpolated", risk_basis: "all_model_observation_points_unit_nav_not_principal",
      rolling_basis: "observed_month_end_unit_nav_ratios_12_36_60_months_not_probability",
      comparison: { ending_nav_difference_cny: "0", profit_difference_cny: "0", twr_difference: "0", fees_difference_cny: "0", fx_fees_difference_cny: "0", slippage_difference_cny: "0" } },
  });
  return { state, comparison, analysis, parameters };
}

export function riskDisplayState() {
  const state = displayState();
  return parseInvestorState({ ...state, session_binding: displayBinding, research_task: {
    id: "fictional-risk-display", profile_id: state.profile!.id, profile_version: state.profile!.version, input_version: "c".repeat(64),
    engine_version: "investor-diversified-reference-v1", status: "calculated", created_at: displayBefore, completed_at: displayBefore,
    reason_codes: [], registry: null, live_advice_eligible: false, study: {
      status: "risk_options_ready", qualification: "owner_reviewed_reconstructed", result_hash: "a".repeat(64), implementation_hash: "b".repeat(64),
      source_context: { range_start: "2025-01-01", range_end: "2025-01-02", valid_until: displayUntil, basis: "owner_reviewed_historical_reconstruction",
        listings: [{ listing_id: "fictional-risk-asset", provider_symbol: "FICTIONAL_RISK_ETF", market: "US", role: "growth" }] },
      candidates: [{ parameters_hash: "c".repeat(64), weights: { "fictional-risk-asset": "1" }, train_net_twr: "0.01", train_drawdown: "-0.10",
        benchmark_net_twr: "0", usable: true, stresses: [{ id: "fictional-shock", label: "FICTIONAL_DISPLAY_SHOCK", portfolio_return: "-0.20" }] }],
    } } }, displayBinding);
}
