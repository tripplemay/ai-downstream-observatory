import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const decimal = z.string().max(1000).regex(/^-?\d+(?:\.\d+)?$/);
const at = z.string().max(30).refine(value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value)));
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
export const executionReviewSummarySchema = z.object({ schema_version: z.enum(["execution-review-summary-v1", "execution-review-summary-v2"]),
  terminal_failure_count: z.number().int().nonnegative(), cancellations: z.number().int().nonnegative(),
  resolved_cancellations: z.number().int().nonnegative(), unresolved_reviews: z.number().int().nonnegative(), lineage_hash: digest,
}).strict().refine(value => value.resolved_cancellations <= value.cancellations);
export const cashIntentSummarySchema = z.object({ schema_version: z.literal("cash-intent-summary-v1"),
  pending_intents: z.number().int().nonnegative(), failed_intents: z.number().int().nonnegative(), lineage_hash: digest,
}).strict();
type ExecutionSummary = { execution_failure_count: number; execution_review?: z.infer<typeof executionReviewSummarySchema>;
  cash_intent_review?: z.infer<typeof cashIntentSummarySchema> };
export function fundedPathExecutionUsable(summary: ExecutionSummary) {
  if (summary.execution_review?.schema_version === "execution-review-summary-v2") {
    if (!summary.cash_intent_review || summary.cash_intent_review.pending_intents !== 0 || summary.cash_intent_review.failed_intents !== 0) return false;
  } else if (summary.cash_intent_review) return false;
  return summary.execution_review
    ? summary.execution_review.terminal_failure_count === 0 && summary.execution_review.unresolved_reviews === 0
      && summary.execution_review.cancellations <= summary.execution_failure_count
      && summary.execution_review.terminal_failure_count === summary.execution_failure_count - summary.execution_review.resolved_cancellations
    : summary.execution_failure_count === 0;
}
export const fundedComparisonPathSchema = z.object({ principal_cny: decimal, ending_nav_cny: decimal, profit_cny: decimal,
  ending_locked_cash_cny: decimal, fees_cny: decimal, fx_fees_cny: decimal, slippage_cny: decimal, cash_rounding_cny: decimal,
  twr: decimal.nullable(), annualized_unit_return: decimal.nullable(), max_drawdown: decimal.nullable(), recovered_at: at.nullable(),
  ending_cash_ratio: decimal.nullable(), execution_failure_count: z.number().int().nonnegative(),
  execution_review: executionReviewSummarySchema.optional(),
  cash_intent_review: cashIntentSummarySchema.optional(),
  xirr: z.object({ status: z.enum(["ok", "ambiguous", "same_day_flows", "missing_signs"]), rate: decimal.nullable(),
    roots: z.array(decimal).max(1), duration_days: z.number().int().nonnegative() }).strict(),
}).strict().refine(value => (value.execution_review?.schema_version === "execution-review-summary-v2") === !!value.cash_intent_review
  && (!value.execution_review || value.execution_review.cancellations <= value.execution_failure_count
    && value.execution_review.terminal_failure_count === value.execution_failure_count - value.execution_review.resolved_cancellations));
export const fundedComparisonCandidateSchema = z.object({ parameters_hash: digest, result_hash: digest.nullable(),
  allocation: z.array(z.object({ asset_id: id, symbol: z.string().min(1).max(40), market: z.enum(["CN", "HK", "US"]),
    currency: z.enum(["CNY", "HKD", "USD"]), role: z.enum(["growth", "defensive", "diversifier"]), weight: decimal }).strict()).min(1).max(1000),
  rebalance: z.enum(["first_decision_each_half_year", "first_decision_each_year"]),
  status: z.enum(["verified_retrospective", "verified_with_execution_gaps", "failed", "unavailable"]), reason_code: code.nullable(),
  economics_hash: digest.nullable(), paths: z.object({ immediate: fundedComparisonPathSchema, staged: fundedComparisonPathSchema }).strict().nullable(),
}).strict().refine(value => (["verified_retrospective", "verified_with_execution_gaps"].includes(value.status)) === (value.paths !== null)
  && (value.paths !== null) === (value.economics_hash !== null) && (value.paths === null || value.result_hash !== null)
  && (value.status === "verified_retrospective") === (value.reason_code === null)
  && (value.status !== "verified_retrospective" || value.paths !== null && Object.values(value.paths).every(fundedPathExecutionUsable)));
export const fundedComparisonSchema = z.object({ schema_version: z.literal("investor-funded-comparison-v1"),
  workspace_id: id.nullable(), workspace_revision: z.number().int().nonnegative(), profile_id: id.nullable(), funding_plan_id: id.nullable(),
  request_id: id.nullable(), input_version: digest.nullable(), run_id: id.nullable(), checked_at: at, valid_until: at.nullable(),
  status: z.enum(["not_started", "pending", "blocked", "outdated", "unavailable", "verified_retrospective", "partial"]),
  reason_codes: z.array(code).max(8), candidates: z.array(fundedComparisonCandidateSchema).max(8),
  scope: z.literal("retrospective_reconstructed_research"), economics_independently_replayed: z.boolean(),
  source_independently_verified: z.literal(false), parameters_independently_preregistered: z.literal(false),
  engine_trace_hash_independently_certified: z.literal(false), actual_arrivals_confirmed: z.literal(false),
  publication_eligible: z.literal(false), execution_authorized: z.literal(false), live_advice_eligible: z.literal(false),
}).strict().refine(value => value.economics_independently_replayed === (value.status === "verified_retrospective")
  && (value.status !== "verified_retrospective" || value.candidates.length > 0 && value.candidates.every(row => row.status === "verified_retrospective"))
  && (!["verified_retrospective", "partial"].includes(value.status) || value.run_id !== null && value.valid_until !== null && value.valid_until > value.checked_at)
  && (["verified_retrospective", "partial"].includes(value.status) || value.candidates.length === 0));
export type FundedComparison = z.infer<typeof fundedComparisonSchema>;
export const fundedComparisonDenials = { scope: "retrospective_reconstructed_research", economics_independently_replayed: false,
  source_independently_verified: false, parameters_independently_preregistered: false, engine_trace_hash_independently_certified: false,
  actual_arrivals_confirmed: false, publication_eligible: false, execution_authorized: false, live_advice_eligible: false } as const;
