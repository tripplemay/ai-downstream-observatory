import { z } from "zod";
import { investorHash, investorId, investorInstant } from "./schemas";
import { actionReviewDecimal } from "./action-review-schemas";

const revision = z.number().int().nonnegative().safe(), day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).date();
const eventTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/).datetime();
export const correctionAcknowledgements = ["hypothetical_only", "source_differences_seen", "explicit_time_and_tax", "original_reported_coverage_only", "unchanged_tax_assumption"] as const;
export const correctionRatioDirection = "provider_numerator_new_units_per_denominator_old_unit_assumed" as const;
const event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dividend"), at: eventTime, pay_at: eventTime, tax_per_unit: actionReviewDecimal }).strict(),
  z.object({ type: z.literal("split"), at: eventTime, ratio_direction: z.literal(correctionRatioDirection) }).strict(),
]);
export const correctionImpactInputSchema = z.object({ schema_version: z.literal("investor-action-correction-impact-request-v1"),
  model_id: investorId, preview_id: investorId, expected_revision: revision, idempotency_key: investorId,
  acknowledgements: z.object(Object.fromEntries(correctionAcknowledgements.map(key => [key, z.literal(true)]))).strict(),
  decisions: z.array(z.object({ date: day, choice: z.enum(["retain", "replace", "cancel"]), reason: z.string().min(1).max(1000), events: z.array(event).max(2) }).strict()
    .refine(row => row.choice === "replace" ? row.events.length > 0 : row.events.length === 0)).min(1).max(1000),
}).strict();
const derived = z.string().max(200).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,120})?$/);
const amounts = z.record(investorId, derived);
export const correctionImpactSummarySchema = z.object({
  checked_at: investorInstant, valid_until: investorInstant, original_checkpoint_at: investorInstant,
  original_valuation_cny: derived, hypothetical_valuation_cny: derived, difference_cny: derived,
  original_quantities: amounts, hypothetical_quantities: amounts, cash_delta: amounts, receivable_delta: amounts,
  ignored_new_report_dates: z.array(day).max(4096),
  basis: z.literal("stored_hypothetical_result_at_original_prices_not_current_nav"),
  economic_correction_approved: z.literal(false), monitoring_resumed: z.literal(false), trading_permission: z.literal(false),
}).strict();
export const correctionImpactResponseSchema = z.object({ schema_version: z.literal("investor-correction-impact-response-v1"),
  workspace_id: investorId, workspace_revision: revision, checked_at: investorInstant, refresh_after: investorInstant,
  session_binding: investorHash, lookup_nonce: investorId.nullable(), read_only: z.boolean(),
  request: z.object({ id: investorId, model_id: investorId, preview_id: investorId, intent_hash: investorHash, created_at: investorInstant, valid_until: investorInstant,
    status: z.enum(["queued", "running", "preview_ready", "rejected", "expired", "outdated", "unknown"]),
    code: z.enum(["CORRECTION_IMPACT_READY", "CORRECTION_IMPACT_VERSION_CHANGED", "CORRECTION_IMPACT_EXPIRED", "CORRECTION_IMPACT_INVALID_ANSWERS", "CORRECTION_IMPACT_SOURCE_UNAVAILABLE"]).nullable(),
  }).strict().nullable(), summary: correctionImpactSummarySchema.nullable(), summary_hash: investorHash.nullable(),
  visibility: z.literal("private_owner_only_not_ai"), provider_calls: z.literal(0), economic_correction_approved: z.literal(false), trading_permission: z.literal(false),
}).strict();
export type CorrectionImpactInput = z.infer<typeof correctionImpactInputSchema>;
export type CorrectionImpactResponse = z.infer<typeof correctionImpactResponseSchema>;
