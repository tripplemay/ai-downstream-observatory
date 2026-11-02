import { z } from "zod";
import { investorHash, investorId, investorInstant } from "./schemas";

const revision = z.number().int().nonnegative().safe();
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/).datetime();
export const legacyTransitionAcknowledgements = ["preserve_original_accounting_and_knowledge", "revalidate_current_sources_on_every_use",
  "new_actions_keep_audited_knowledge", "quality_gaps_are_not_current_advice", "research_only_no_trading"] as const;
export const legacyTransitionSubmitSchema = z.object({ schema_version: z.literal("investor-legacy-transition-submit-v1"),
  preview_id: investorId, expected_preview_hash: investorHash, expected_revision: revision, idempotency_key: investorId,
  acknowledgements: z.object({ preserve_original_accounting_and_knowledge: z.literal(true), revalidate_current_sources_on_every_use: z.literal(true),
    new_actions_keep_audited_knowledge: z.literal(true), quality_gaps_are_not_current_advice: z.literal(true), research_only_no_trading: z.literal(true) }).strict(),
}).strict();
export const legacyTransitionInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preview"), model_id: investorId, expected_revision: revision, idempotency_key: investorId }).strict(),
  z.object({ kind: z.literal("confirmation"), body: legacyTransitionSubmitSchema }).strict(),
]);
const witness = z.object({ schema_version: z.literal("investor-legacy-transition-witness-v1"), preview_id: investorId,
  workspace_id: investorId, workspace_revision: revision, model_id: investorId, control_id: investorId,
  request_hash: investorHash, comparison_hash: investorHash, basis_hash: investorHash,
  proof: z.object({ model_hash: investorHash, control_hash: investorHash, legacy_input_id: investorId, legacy_input_hash: investorHash,
    settings_hash: investorHash, checkpoint: z.object({ id: investorId, sequence: z.number().int().min(1).max(1000),
      content_hash: investorHash, chain_hash: investorHash, processed_actions_hash: investorHash }).strict(),
    audited_document_hash: investorHash, audited_projection_hash: investorHash, carry_hash: investorHash, carry_count: z.number().int().min(0).max(20000),
    projection_quality_gaps: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)).max(20).refine(v => new Set(v).size === v.length), source_valid_until: instant,
  }).strict(), checked_at: instant, created_at: instant, valid_until: instant, approval_performed: z.literal(false),
  research_admitted: z.literal(false), trading_permission: z.literal(false), provider_calls: z.literal(0),
}).strict();
export const legacyTransitionViewSchema = z.object({ preview: witness, monitoring_enabled: z.boolean(), checked_at: investorInstant, refresh_after: investorInstant }).strict();
export const legacyTransitionCodeSchema = z.enum(["LEGACY_TRANSITION_PREVIEW_READY", "LEGACY_TRANSITION_REGISTERED", "LEGACY_TRANSITION_VERSION_CHANGED",
  "LEGACY_TRANSITION_PREVIEW_EXPIRED", "LEGACY_TRANSITION_REQUEST_EXPIRED", "LEGACY_TRANSITION_ALREADY_CONFIRMED",
  "LEGACY_TRANSITION_RESTATEMENT_REQUIRED", "LEGACY_TRANSITION_SOURCE_UNAVAILABLE"]);
export const legacyTransitionResponseSchema = z.object({ schema_version: z.literal("investor-legacy-transition-response-v1"),
  workspace_id: investorId, workspace_revision: revision, checked_at: investorInstant, refresh_after: investorInstant,
  read_only: z.boolean(), model: z.object({ id: investorId, requires_transition: z.boolean() }).strict().nullable(), lookup_nonce: investorId.nullable(),
  request: z.object({ id: investorId, kind: z.enum(["preview", "confirmation"]), model_id: investorId, intent_hash: investorHash,
    created_at: investorInstant, valid_until: investorInstant,
    status: z.enum(["queued", "running", "preview_ready", "registered", "rejected", "expired", "outdated", "unknown"]),
    code: legacyTransitionCodeSchema.nullable(), resource_id: investorId.nullable(), resource_hash: investorHash.nullable(), resource_valid_until: instant.nullable(),
  }).strict().nullable(), view: legacyTransitionViewSchema.nullable(), preview_error: z.literal("LEGACY_TRANSITION_VIEW_UNAVAILABLE").nullable(),
  current_advice_certified: z.literal(false), monitoring_activated: z.literal(false), trading_permission: z.literal(false), provider_calls: z.literal(0),
  session_binding: investorHash,
}).strict();
export type LegacyTransitionInput = z.infer<typeof legacyTransitionInputSchema>;
export type LegacyTransitionResponse = z.infer<typeof legacyTransitionResponseSchema>;
