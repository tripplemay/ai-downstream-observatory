import { z } from "zod";
import { investorHash, investorId, investorInstant } from "./schemas";
import { actionReviewInputSchema, actionReviewResponseSchema } from "./action-review-schemas";

export const unchangedRecoveryAcknowledgements = ["unchanged_economic_events_and_tax", "source_overlap_and_old_differences_unchanged",
  "reported_coverage_not_objective_absence", "original_failure_and_history_retained", "separate_current_data_readmission", "register_new_default_off_rule"] as const;
export const unchangedRecoverySubmitSchema = z.object({ schema_version: z.literal("investor-unchanged-action-recovery-submit-v1"),
  preview_id: investorId, expected_revision: z.number().int().nonnegative().safe(), idempotency_key: investorId,
  failed_publication_id: investorId, failed_publication_hash: investorHash,
  acknowledgements: z.object(Object.fromEntries(unchangedRecoveryAcknowledgements.map(key => [key, z.literal(true)]))).strict(),
  enable_rule: z.boolean(),
}).strict();
export const unchangedRecoveryInputSchema = z.discriminatedUnion("kind", [actionReviewInputSchema.options[0],
  z.object({ kind: z.literal("confirmation"), body: unchangedRecoverySubmitSchema }).strict()]);

export const unchangedRecoveryViewSchema = z.object({ preview_id: investorId,
  failed_publication_id: investorId, failed_publication_hash: investorHash,
  failed_source_day: z.string().date(), failed_at: investorInstant,
  failure_code: z.enum(["SOURCE_CAPTURE_TERMINAL_FAILURE", "MAINTENANCE_WINDOW_MISSED"]),
}).strict();
export const unchangedRecoveryResponseSchema = z.object({ schema_version: z.literal("investor-unchanged-action-recovery-response-v1"),
  review: actionReviewResponseSchema, recovery: unchangedRecoveryViewSchema.nullable(),
}).strict();
export type UnchangedRecoveryResponse = z.infer<typeof unchangedRecoveryResponseSchema>;
