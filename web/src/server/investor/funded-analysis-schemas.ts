import { z } from "zod";
import { fundedComparisonPathSchema } from "./funded-comparison-schemas";

const digest = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const decimal = z.string().max(200).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,120})?$/);
const at = z.string().max(30).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/).refine(value => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
});
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
});
export const analysisPathSchema = z.enum(["immediate", "staged"]);
export const fundedAnalysisPointSchema = z.object({ at, local_date: date, nav_cny: decimal, principal_cny: decimal, profit_cny: decimal,
  cash_cny: decimal, locked_cash_cny: decimal, unit_nav: decimal, drawdown: decimal.nullable() }).strict();
const episode = z.object({ peak_at: at, trough_at: at, recovered_at: at.nullable(), duration_days: z.number().int().nonnegative(), ongoing: z.boolean() }).strict();
const interval = z.object({ from_at: at, to_at: at, return: decimal }).strict();
export const fundedAnalysisSeriesSchema = z.object({ summary: fundedComparisonPathSchema,
  trace_hash: digest, full_observation_count: z.number().int().positive().max(100000), daily_curve_hash: digest,
  daily: z.array(fundedAnalysisPointSchema).min(1).max(3670),
  monthly: z.array(fundedAnalysisPointSchema.extend({ period: z.string().regex(/^\d{4}-\d{2}$/) }).strict()).min(1).max(121),
  risk: z.object({ status: z.enum(["computed", "unit_nav_unavailable"]), max_drawdown: decimal.nullable(), peak_at: at.nullable(),
    trough_at: at.nullable(), recovered_at: at.nullable(), recovery_days: z.number().int().nonnegative().nullable(),
    longest_underwater: episode.nullable() }).strict(),
  rolling: z.array(z.object({ months: z.union([z.literal(12), z.literal(36), z.literal(60)]), status: z.enum(["computed", "insufficient_history"]),
    window_count: z.number().int().nonnegative().max(121), negative_count: z.number().int().nonnegative().max(121),
    negative_fraction: decimal.nullable(), worst: interval.nullable(), best: interval.nullable() }).strict()).length(3),
}).strict();
export const fundedAnalysisDataSchema = z.object({ path: analysisPathSchema, evaluation_timezone: z.string().min(1).max(80),
  window: z.object({ start: at, end: at }).strict(), parameters_hash: digest, input_hash: digest, economics_hash: digest,
  candidate_summary_verified: z.literal(true), candidate: fundedAnalysisSeriesSchema, baseline: fundedAnalysisSeriesSchema,
  baseline_rule: z.literal("same_weights_hold_new_cash_repair_v1"), baseline_rule_hash: digest, baseline_preregistered: z.literal(false),
  curve_basis: z.literal("last_observed_point_per_local_date_full_window_not_interpolated"),
  risk_basis: z.literal("all_model_observation_points_unit_nav_not_principal"),
  rolling_basis: z.literal("observed_month_end_unit_nav_ratios_12_36_60_months_not_probability"),
  comparison: z.object({ ending_nav_difference_cny: decimal, profit_difference_cny: decimal, twr_difference: decimal.nullable(),
    fees_difference_cny: decimal, fx_fees_difference_cny: decimal, slippage_difference_cny: decimal }).strict(),
}).strict();
export const fundedAnalysisSchema = z.object({ schema_version: z.literal("investor-funded-path-analysis-v1"),
  workspace_id: id.nullable(), workspace_revision: z.number().int().nonnegative(), profile_id: id.nullable(), funding_plan_id: id.nullable(),
  request_id: id.nullable(), input_version: digest.nullable(), run_id: id.nullable(), checked_at: at, valid_until: at.nullable(),
  parameters_hash: digest, path: analysisPathSchema,
  status: z.enum(["not_started", "pending", "blocked", "outdated", "unavailable", "verified_retrospective", "verified_with_execution_gaps"]),
  reason_codes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)).max(8), analysis: fundedAnalysisDataSchema.nullable(),
  scope: z.literal("retrospective_reconstructed_research"), economics_independently_replayed: z.boolean(),
  source_independently_verified: z.literal(false), parameters_independently_preregistered: z.literal(false),
  engine_trace_hash_independently_certified: z.literal(false), actual_arrivals_confirmed: z.literal(false),
  publication_eligible: z.literal(false), execution_authorized: z.literal(false), live_advice_eligible: z.literal(false),
}).strict().refine(value => (["verified_retrospective", "verified_with_execution_gaps"].includes(value.status)) === (value.analysis !== null)
  && value.economics_independently_replayed === (value.status === "verified_retrospective")
  && (!value.analysis || value.analysis.parameters_hash === value.parameters_hash && value.analysis.path === value.path
    && value.run_id !== null && value.valid_until !== null && value.valid_until > value.checked_at));
export type FundedPathAnalysis = z.infer<typeof fundedAnalysisSchema>;
export type FundedAnalysisData = z.infer<typeof fundedAnalysisDataSchema>;
export type FundedAnalysisSeries = z.infer<typeof fundedAnalysisSeriesSchema>;
