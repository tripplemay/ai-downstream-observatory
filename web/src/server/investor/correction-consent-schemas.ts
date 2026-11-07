import { z } from "zod";
import { investorHash, investorId, investorInstant } from "./schemas";

const revision = z.number().int().nonnegative().safe();
export const correctionConsentAcknowledgements = ["exact_stored_impact_seen", "explicit_historical_restatement", "selected_report_differences_accepted",
  "tax_and_instants_are_research_assumptions", "preserve_original_history_and_strategy", "new_epoch_not_current_nav", "separate_current_readmission_no_trading"] as const;
export const correctionConsentSubmitSchema = z.object({ schema_version: z.literal("investor-correction-consent-submit-v1"),
  impact_request_id: investorId, expected_result_hash: investorHash, expected_revision: revision, idempotency_key: investorId,
  acknowledgements: z.object(Object.fromEntries(correctionConsentAcknowledgements.map(key => [key, z.literal(true)]))).strict(),
}).strict();
export const correctionConsentCandidateSchema = z.object({ impact_request_id: investorId, impact_result_hash: investorHash,
  model_id: investorId, preview_id: investorId, workspace_revision: revision, summary_hash: investorHash,
  valid_until: investorInstant, all_differences_resolved: z.boolean(),
}).strict();
export const correctionConsentReceiptSchema = z.object({ schema_version: z.literal("investor-correction-consent-receipt-v1"),
  confirmation_id: investorId, workspace_id: investorId, workspace_revision: revision, model_id: investorId,
  impact_request_id: investorId, impact_result_hash: investorHash, request_id: investorId, created_at: investorInstant, valid_until: investorInstant,
  economic_correction_approved: z.literal(true), baseline_registered: z.literal(true), historical_registration_only: z.literal(true),
  current_source_eligibility_restored: z.literal(false), monitor_data_readmission_required: z.literal(true), monitoring_resumed: z.literal(false),
  checkpoint_created: z.literal(false), trading_permission: z.literal(false), source_values_included: z.literal(false), provider_calls: z.literal(0),
}).strict();
export const correctionConsentResponseSchema = z.object({ schema_version: z.literal("investor-correction-consent-response-v1"),
  workspace_id: investorId, workspace_revision: revision, checked_at: investorInstant, refresh_after: investorInstant,
  session_binding: investorHash, lookup_nonce: investorId.nullable(), read_only: z.boolean(),
  candidate: correctionConsentCandidateSchema.nullable(),
  request: z.object({ id: investorId, model_id: investorId, impact_request_id: investorId, intent_hash: investorHash, created_at: investorInstant, valid_until: investorInstant,
    status: z.enum(["queued", "running", "confirmed", "rejected", "expired", "unknown"]),
    code: z.enum(["CORRECTION_CONSENT_CONFIRMED", "CORRECTION_CONSENT_EXPIRED", "CORRECTION_CONSENT_CHANGED", "CORRECTION_CONSENT_SOURCE_UNAVAILABLE", "CORRECTION_CONSENT_UNRESOLVED"]).nullable(),
  }).strict().nullable(), receipt: correctionConsentReceiptSchema.nullable(), visibility: z.literal("private_owner_only_not_ai"), provider_calls: z.literal(0), trading_permission: z.literal(false),
}).strict();
export type CorrectionConsentSubmit = z.infer<typeof correctionConsentSubmitSchema>;
export type CorrectionConsentResponse = z.infer<typeof correctionConsentResponseSchema>;
export type CorrectionConsentCandidate = z.infer<typeof correctionConsentCandidateSchema>;
