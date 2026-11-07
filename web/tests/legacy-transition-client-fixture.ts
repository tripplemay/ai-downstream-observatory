import { hash } from "../src/server/ledger/service";
import { legacyTransitionResponseSchema, type LegacyTransitionResponse } from "../src/server/investor/legacy-transition-schemas";

export const transitionAt = "2026-11-03T06:00:04.002Z", transitionNow = Date.parse(transitionAt), transitionBinding = "a".repeat(64);
export const transitionIntent = { kind: "preview", model_id: "fictional-model", expected_revision: 0, idempotency_key: "fictional-preview" };
export function transitionResponse(overrides: Partial<LegacyTransitionResponse> = {}): LegacyTransitionResponse {
  const preview = { schema_version: "investor-legacy-transition-witness-v1", preview_id: "fictional-witness", workspace_id: "w", workspace_revision: 1,
    model_id: "fictional-model", control_id: "fictional-control", request_hash: hash({ model_id: transitionIntent.model_id, expected_revision: 0,
      idempotency_key: transitionIntent.idempotency_key }), comparison_hash: "b".repeat(64), basis_hash: "c".repeat(64),
    proof: { model_hash: "d".repeat(64), control_hash: "e".repeat(64), legacy_input_id: "fictional-input", legacy_input_hash: "f".repeat(64), settings_hash: "1".repeat(64),
      checkpoint: { id: "fictional-checkpoint", sequence: 17, content_hash: "2".repeat(64), chain_hash: "3".repeat(64), processed_actions_hash: "4".repeat(64) },
      audited_document_hash: "5".repeat(64), audited_projection_hash: "6".repeat(64), carry_hash: "7".repeat(64), carry_count: 3,
      projection_quality_gaps: ["PRICE_EXPIRED"], source_valid_until: "2026-11-10T00:00:00.000Z" },
    checked_at: transitionAt, created_at: transitionAt, valid_until: "2026-11-03T06:05:04.002Z", approval_performed: false,
    research_admitted: false, trading_permission: false, provider_calls: 0 };
  return legacyTransitionResponseSchema.parse({ schema_version: "investor-legacy-transition-response-v1", workspace_id: "w", workspace_revision: 1,
    checked_at: transitionAt, refresh_after: "2026-11-03T06:00:19.002Z", read_only: false, model: { id: "fictional-model", requires_transition: true }, lookup_nonce: null,
    request: { id: "fictional-job", kind: "preview", model_id: "fictional-model", intent_hash: hash(transitionIntent), created_at: transitionAt,
      valid_until: preview.valid_until, status: "preview_ready", code: "LEGACY_TRANSITION_PREVIEW_READY", resource_id: preview.preview_id,
      resource_hash: hash(preview), resource_valid_until: preview.valid_until },
    view: { preview, monitoring_enabled: false, checked_at: transitionAt, refresh_after: "2026-11-03T06:00:19.002Z" }, preview_error: null,
    current_advice_certified: false, monitoring_activated: false, trading_permission: false, provider_calls: 0, session_binding: transitionBinding, ...overrides });
}
