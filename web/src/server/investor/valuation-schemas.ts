import { z } from "zod";
import { valuationCalendarCheckSchema } from "../valuation-calendar-schemas";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const scopeId = z.string().min(1).max(200);
const revision = z.number().int().nonnegative().safe(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime(), market = z.enum(["CN", "HK", "US"]);
export const valuationPreparationSchema = z.object({
  markets: z.array(z.object({ market, expected_session: z.string().date().nullable(), calendar_checks: z.array(valuationCalendarCheckSchema).max(200),
    candidate_scopes: z.array(scopeId).max(100), suggested_scope: scopeId.nullable(),
    gaps: z.array(z.enum(["CALENDAR_REQUIRED", "CALENDAR_UNUSABLE", "CALENDAR_SESSIONS_DIFFER", "PRICE_SOURCE_REQUIRED", "PRICE_SOURCE_AMBIGUOUS"])).max(5),
  }).strict()).max(3),
  fx: z.object({ required: z.boolean(), candidates: z.array(z.object({ scope: scopeId, oldest_age_seconds: revision }).strict()).max(100),
    suggested_scope: scopeId.nullable(), gap: z.enum(["FX_SOURCE_REQUIRED", "FX_SOURCE_AMBIGUOUS"]).nullable() }).strict(),
  evidence_hash: hash, basis: z.literal("reviewed_metadata_suggestions_not_quality_approval"), approval_required: z.literal(true),
}).strict().superRefine((value, ctx) => {
  const unique = (items: string[]) => new Set(items).size === items.length;
  if (!unique(value.markets.map(row => row.market))) ctx.addIssue({ code: "custom", message: "DUPLICATE_PREPARED_MARKET" });
  for (const row of value.markets) {
    if (!unique(row.candidate_scopes) || row.suggested_scope !== (row.candidate_scopes.length === 1 ? row.candidate_scopes[0] : null)
      || (row.expected_session === null ? row.calendar_checks.length > 0 || row.candidate_scopes.length > 0 : !row.calendar_checks.length)
      || row.calendar_checks.some(check => check.market !== row.market || check.expected_session !== row.expected_session)
      || !unique(row.calendar_checks.map(check => check.exchange))) ctx.addIssue({ code: "custom", message: "INCONSISTENT_PREPARED_MARKET" });
  }
  if (!unique(value.fx.candidates.map(row => row.scope)) || value.fx.suggested_scope !== (value.fx.candidates.length === 1 ? value.fx.candidates[0].scope : null)
    || (!value.fx.required && (value.fx.candidates.length > 0 || value.fx.gap !== null))) ctx.addIssue({ code: "custom", message: "INCONSISTENT_PREPARED_FX" });
});
export const valuationGapCodes = ["RECONCILIATION_REQUIRED", "RECONCILIATION_EVIDENCE_INVALID", "RECONCILIATION_SOURCE_UNAVAILABLE",
  "RECONCILIATION_FACTS_CHANGED", "RECONCILIATION_MISMATCH", "ACCOUNT_BOOK_EMPTY"] as const;
export const valuationIntentSchema = z.object({ action: z.literal("request_linked_valuation"), portfolio_id: id,
  expected_ledger_revision: revision, expected_link_id: id, expected_link_version: revision.refine(value => value > 0), expected_context_hash: hash,
  cutoff_at: instant, prices: z.array(z.object({ market, scope: scopeId, expected_session: z.string().date() }).strict()).max(3),
  fx: z.object({ scope: scopeId, max_age_seconds: z.number().int().min(0).max(2592000) }).strict().nullable(),
  source_reference: z.string().trim().min(1).max(500), acknowledgement: z.literal(true),
  basis: z.literal("owner_reviewed_valuation_rules_not_provider_certification"),
}).strict();
export const valuationContextSchema = z.object({ schema_version: z.literal("investor-valuation-v2"), workspace_id: id,
  workspace_revision: revision.refine(value => value > 0), portfolio_id: id, ledger_revision: revision, link_id: id,
  link_version: revision.refine(value => value > 0), context_hash: hash, checked_at: z.string().datetime({ precision: 3 }), read_only: z.boolean(),
  cutoff_at: instant.nullable(), accounts: z.array(z.object({ id, row_version: revision, status: z.enum(["active", "disabled", "reconciliation_required"]),
    reconciliation: z.object({ run_id: id, attachment_hash: hash, cutoff_at: instant }).strict().nullable(), gap: z.enum(valuationGapCodes).nullable() }).strict()).max(200),
  listings: z.array(z.object({ id, ticker: z.string().min(1).max(40), market, exchange: z.string().min(1).max(200), currency: z.string().regex(/^[A-Z]{3}$/) }).strict()).max(200),
  currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).max(20),
  sources: z.array(z.object({ scope: scopeId, revision: revision.refine(value => value > 0), manifest_hash: hash,
    batch_type: z.enum(["prices", "fx"]), mode: z.enum(["provider_observed", "manual_verified"]), markets: z.array(market).max(3),
  }).strict()).max(100),
  gaps: z.array(z.enum(valuationGapCodes)).max(6),
  preparation: valuationPreparationSchema,
  task: z.object({ id, status: z.enum(["queued", "running", "succeeded", "partial", "failed", "skipped", "retry_queued", "cancelled"]) }).strict().nullable(),
  basis: z.literal("metadata_only_whole_book_historical_requirements"), execution_authorized: z.literal(false),
}).strict();
export type ValuationContext = z.infer<typeof valuationContextSchema>;
export type ValuationIntent = z.infer<typeof valuationIntentSchema>;
export type ValuationPreparation = z.infer<typeof valuationPreparationSchema>;
