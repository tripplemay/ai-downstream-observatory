import { z } from "zod";
import { investorHash, investorId, investorInstant } from "./schemas";

const revision = z.number().int().nonnegative().safe();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).date();
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/).datetime();
export const actionReviewDecimal = z.string().max(60).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/)
  .refine(value => value.replace(/[-.]/g, "").replace(/^0+/, "").length <= 38);
export const actionReviewAcknowledgements = ["issuer_amount_unit_and_currency", "reported_differences_seen", "explicit_research_instants",
  "explicit_tax_amounts", "unchanged_tax_assumption_applies", "reported_coverage_not_objective_absence", "no_historical_restatement", "register_new_default_off_rule"] as const;
export const actionReviewSubmitSchema = z.object({ schema_version: z.literal("investor-action-review-submit-v1"),
  preview_id: investorId, expected_revision: revision, idempotency_key: investorId, enable_rule: z.boolean(),
  acknowledgements: z.object(Object.fromEntries(actionReviewAcknowledgements.map(key => [key, z.literal(true)]))).strict(),
  new_events: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("dividend"), date: day, at: instant, pay_at: instant, tax_per_unit: actionReviewDecimal }).strict(),
    z.object({ type: z.literal("split"), date: day, at: instant }).strict(),
  ])).min(1).max(1000),
}).strict();
export const actionReviewInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preview"), symbol: z.enum(["VT.US", "BND.US"]), expected_revision: revision, idempotency_key: investorId }).strict(),
  z.object({ kind: z.literal("confirmation"), body: actionReviewSubmitSchema }).strict(),
]);
const witness = z.object({ schema_version: z.literal("investor-action-review-preview-v1"), preview_id: investorId,
  workspace_id: investorId, workspace_revision: revision, request_hash: investorHash, authority_id: investorId, authority_hash: investorHash,
  control_id: investorId, control_hash: investorHash, draft_basis_hash: investorHash, checked_at: instant, created_at: instant, valid_until: instant,
  validity_policy: z.literal("owner_review_15m").optional(), approval_performed: z.literal(false), provider_calls: z.literal(0),
  research_admitted: z.literal(false), trading_permission: z.literal(false) }).strict();
const issuer = z.object({ ex_date: day, issuer_type_code: z.string().min(1).max(32), distribution_amount: actionReviewDecimal,
  record_date: day, pay_date: day, record_hash: investorHash }).strict();
const dividend = z.object({ date: day, value: actionReviewDecimal, unadjusted_value: actionReviewDecimal,
  reported_currency: z.string().min(1).max(3), declaration_date: day.nullable(), record_date: day.nullable(), payment_date: day.nullable(),
  reported_period: z.string().max(100).nullable(), record_hash: investorHash }).strict();
const split = z.object({ date: day, numerator: actionReviewDecimal, denominator: actionReviewDecimal, record_hash: investorHash }).strict();
const records = z.object({ issuer: z.array(issuer).max(2048), dividends: z.array(dividend).max(2048), splits: z.array(split).max(2048) }).strict();
export const actionReviewChangeSchema = z.object({ date: day, disposition: z.enum(["new_report", "historical_correction"]), outside_common_coverage: z.boolean(),
  previous: records, current: records, effective_at: z.null(), payment_at: z.null(), tax_per_unit: z.null() }).strict();
export const actionReviewViewSchema = z.object({ schema_version: z.literal("investor-action-review-view-v1"),
  preview: witness, provider_symbol: z.enum(["VT.US", "BND.US"]), source_day: day,
  status: z.enum(["new_reported_actions", "no_reported_changes", "historical_correction_required", "source_review_required"]),
  previous_coverage_end: day, candidate_coverage_end: day, knowledge_not_before: instant,
  unchanged_tax_assumption: z.string().min(1).max(2000), changes: z.array(actionReviewChangeSchema).max(4096), confirmation_supported: z.boolean(),
  checked_at: investorInstant, refresh_after: investorInstant, visibility: z.literal("private_owner_only_not_ai"),
  provider_calls: z.literal(0), research_admitted: z.literal(false), trading_permission: z.literal(false) }).strict();
export const actionReviewResponseSchema = z.object({ schema_version: z.literal("investor-action-review-response-v1"),
  workspace_id: investorId, workspace_revision: revision, checked_at: investorInstant, refresh_after: investorInstant, read_only: z.boolean(),
  symbols: z.array(z.enum(["VT.US", "BND.US"])).max(2),lookup_nonce:investorId.nullable(), research_admitted: z.literal(false), trading_permission: z.literal(false), provider_calls: z.literal(0),
  request: z.object({ id: investorId, kind: z.enum(["preview", "confirmation"]), symbol: z.enum(["VT.US", "BND.US"]),intent_hash:investorHash,created_at: investorInstant,
    valid_until: investorInstant, status: z.enum(["queued", "running", "preview_ready", "confirmed", "rejected", "expired", "outdated", "unknown"]),
    code: z.enum(["ACTION_REVIEW_PREVIEW_READY", "ACTION_REVIEW_CONFIRMED", "ACTION_REVIEW_VERSION_CHANGED", "ACTION_REVIEW_PREVIEW_EXPIRED",
      "ACTION_REVIEW_SOURCE_UNAVAILABLE", "ACTION_REVIEW_HISTORICAL_REVIEW_REQUIRED", "ACTION_REVIEW_INVALID_ANSWERS", "ACTION_REVIEW_RULE_RETIRED",
      "ACTION_REVIEW_SCOPE_CHANGED", "ACTION_REVIEW_REQUEST_EXPIRED", "ACTION_REVIEW_FAILED"]).nullable(),
    resource_id: investorId.nullable(), resource_hash: investorHash.nullable(), resource_valid_until: instant.nullable() }).strict().nullable(),
  view: actionReviewViewSchema.nullable(), preview_error: z.enum(["ACTION_REVIEW_VIEW_UNAVAILABLE", "ACTION_REVIEW_VIEW_CHANGED"]).nullable(),
  session_binding: investorHash,
}).strict();
export type ActionReviewView = z.infer<typeof actionReviewViewSchema>;
export type ActionReviewResponse = z.infer<typeof actionReviewResponseSchema>;
