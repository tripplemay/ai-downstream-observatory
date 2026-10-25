import { z } from "zod";
import { executionReviewSummarySchema } from "./funded-comparison-schemas";

export const investorResearchEngines = ["investor-diversified-reference-v1", "investor-diversified-reference-v2", "investor-diversified-reference-v3"] as const;
export function researchEngineForPlan(plan: unknown) {
  const version = (plan as Record<string, unknown> | null)?.schema_version;
  return version === "research-plan-v6" ? investorResearchEngines[2] : version === "research-plan-v5" ? investorResearchEngines[1] : investorResearchEngines[0];
}
export const researchExecutionReviewSchema = z.object({ schema_version: z.literal("research-execution-review-v1"),
  strategy: executionReviewSummarySchema, benchmark: executionReviewSummarySchema,
}).strict();
export type ResearchExecutionReview = z.infer<typeof researchExecutionReviewSchema>;
const cashIntentSide = z.object({ pending_intents: z.number().int().nonnegative().safe(), failed_intents: z.number().int().nonnegative().safe(),
  lineage_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const researchCashIntentReviewSchema = z.object({ schema_version: z.literal("research-cash-intent-review-v1"),
  strategy: cashIntentSide, benchmark: cashIntentSide }).strict();
export type ResearchCashIntentReview = z.infer<typeof researchCashIntentReviewSchema>;
type ExecutionChecks = { execution_failure_count: number; benchmark_execution_failure_count: number;
  execution_review?: z.infer<typeof researchExecutionReviewSchema>; cash_intent_review?: z.infer<typeof researchCashIntentReviewSchema> };
export function reviewCountsMatch(checks: ExecutionChecks) {
  if (!checks.execution_review) return true;
  return ([["strategy", checks.execution_failure_count], ["benchmark", checks.benchmark_execution_failure_count]] as const)
    .every(([side, raw]) => {
      const review = checks.execution_review![side];
      return review.cancellations <= raw && review.terminal_failure_count === raw - review.resolved_cancellations;
    });
}
export function executionChecksUsable(checks: ExecutionChecks) {
  const execution = checks.execution_review ? reviewCountsMatch(checks) && [checks.execution_review.strategy, checks.execution_review.benchmark]
    .every(review => review.terminal_failure_count === 0 && review.unresolved_reviews === 0)
    : checks.execution_failure_count === 0 && checks.benchmark_execution_failure_count === 0;
  return execution && (!checks.cash_intent_review || [checks.cash_intent_review.strategy, checks.cash_intent_review.benchmark]
    .every(review => review.pending_intents === 0 && review.failed_intents === 0));
}
export function phaseExecutionReview(summary: Record<string, unknown>) {
  if (!["investor-phase-summary-v2", "investor-phase-summary-v3"].includes(summary.schema_version as string)) return {};
  const side = (prefix: string) => ({ schema_version: "execution-review-summary-v1",
    terminal_failure_count: summary[prefix + "terminal_execution_failure_count"], cancellations: summary[prefix + "corporate_action_cancellation_count"],
    resolved_cancellations: summary[prefix + "resolved_corporate_action_cancellation_count"], unresolved_reviews: summary[prefix + "unresolved_order_review_count"],
    lineage_hash: summary[prefix + "order_review_lineage_hash"],
  });
  const funding = (prefix: string) => ({ pending_intents: summary[prefix + "pending_cash_intent_count"],
    failed_intents: summary[prefix + "failed_cash_intent_count"], lineage_hash: summary[prefix + "cash_intent_lineage_hash"] });
  return { execution_review: researchExecutionReviewSchema.parse({ schema_version: "research-execution-review-v1",
    strategy: side(""), benchmark: side("benchmark_") }), ...(summary.schema_version === "investor-phase-summary-v3"
      ? { cash_intent_review: researchCashIntentReviewSchema.parse({ schema_version: "research-cash-intent-review-v1",
        strategy: funding(""), benchmark: funding("benchmark_") }) } : {}) };
}
