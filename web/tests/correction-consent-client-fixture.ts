import { hash } from "../src/server/ledger/service";
import { correctionConsentAcknowledgements, correctionConsentResponseSchema, type CorrectionConsentResponse } from "../src/server/investor/correction-consent-schemas";
import { reviewAt, reviewBinding, reviewNow } from "./action-review-client-fixture";

export const consentScope = { workspace: "w", binding: reviewBinding, model: "fictional-model", impact: "fictional-impact" };
export const consentSummaryHash = "b".repeat(64);
export const consentAnswers = Object.fromEntries(correctionConsentAcknowledgements.map(key => [key, true]));
export function consentResponse(patch: Partial<CorrectionConsentResponse> = {}): CorrectionConsentResponse {
  return correctionConsentResponseSchema.parse({ schema_version: "investor-correction-consent-response-v1", workspace_id: "w", workspace_revision: 1,
    checked_at: reviewAt, refresh_after: new Date(reviewNow + 15000).toISOString(), session_binding: reviewBinding, lookup_nonce: null, read_only: false,
    candidate: { impact_request_id: "fictional-impact", impact_result_hash: "c".repeat(64), model_id: "fictional-model", preview_id: "fictional-preview",
      workspace_revision: 1, summary_hash: consentSummaryHash, valid_until: new Date(reviewNow + 60000).toISOString(), all_differences_resolved: true },
    request: null, receipt: null, visibility: "private_owner_only_not_ai", provider_calls: 0, trading_permission: false, ...patch });
}
export function queuedConsent(intent: unknown) {
  return consentResponse({ candidate: null, lookup_nonce: (intent as { idempotency_key: string }).idempotency_key,
    request: { id: "fictional-consent-request", model_id: "fictional-model", impact_request_id: "fictional-impact", intent_hash: hash(intent), created_at: reviewAt,
      valid_until: new Date(reviewNow + 60000).toISOString(), status: "queued", code: null } });
}
export function confirmedConsent(intent: unknown) {
  const queued = queuedConsent(intent);
  return consentResponse({ ...queued, workspace_revision: 2, request: { ...queued.request!, status: "confirmed", code: "CORRECTION_CONSENT_CONFIRMED" },
    receipt: { schema_version: "investor-correction-consent-receipt-v1", confirmation_id: "fictional-consent", workspace_id: "w", workspace_revision: 2,
      model_id: "fictional-model", impact_request_id: "fictional-impact", impact_result_hash: "c".repeat(64), request_id: "fictional-consent-request",
      created_at: reviewAt, valid_until: new Date(reviewNow + 60000).toISOString(), economic_correction_approved: true, baseline_registered: true,
      historical_registration_only: true, current_source_eligibility_restored: false, monitor_data_readmission_required: true, monitoring_resumed: false,
      checkpoint_created: false, trading_permission: false, source_values_included: false, provider_calls: 0 } });
}
