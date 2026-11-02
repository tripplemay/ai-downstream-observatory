import type { ActionReviewView } from "@/server/investor/action-review-schemas";
import { unchangedRecoveryAcknowledgements, unchangedRecoveryInputSchema, unchangedRecoveryResponseSchema,
  type UnchangedRecoveryResponse } from "@/server/investor/unchanged-action-recovery-schemas";
import { parseActionReviewResponse, type ActionReviewAttempt } from "./investor-action-review-client";

function check(value: unknown): asserts value { if (!value) throw new Error("ACTION_RECOVERY_RESPONSE_INVALID"); }
export function recoveryAttempt(value: UnchangedRecoveryResponse, acknowledged: boolean, enable: boolean, nonce: string, now = Date.now()): ActionReviewAttempt {
  const { review, recovery } = value, view = review.view;
  check(recovery && view && acknowledged && !review.read_only && now < Date.parse(review.refresh_after)
    && now < Date.parse(view.refresh_after) && now < Date.parse(view.preview.valid_until)
    && review.request?.status === "preview_ready" && view.preview.workspace_revision === review.workspace_revision
    && view.status === "no_reported_changes" && !view.confirmation_supported && view.changes.length === 0
    && view.preview.preview_id === recovery.preview_id && view.source_day > recovery.failed_source_day
    && view.candidate_coverage_end > view.previous_coverage_end && Date.parse(recovery.failed_at) < Date.parse(view.knowledge_not_before));
  const input = unchangedRecoveryInputSchema.parse({ kind: "confirmation", body: {
    schema_version: "investor-unchanged-action-recovery-submit-v1", preview_id: recovery.preview_id,
    expected_revision: review.workspace_revision, idempotency_key: nonce, enable_rule: enable,
    failed_publication_id: recovery.failed_publication_id, failed_publication_hash: recovery.failed_publication_hash,
    acknowledgements: Object.fromEntries(unchangedRecoveryAcknowledgements.map(key => [key, true])),
  } });
  return { body: JSON.stringify(input), nonce, binding: review.session_binding, workspace: review.workspace_id, intent: input };
}
export async function parseRecoveryResponse(raw: unknown, binding: string, workspace: string, original: ActionReviewView,
  now = Date.now(), attempt?: ActionReviewAttempt): Promise<UnchangedRecoveryResponse> {
  const value = unchangedRecoveryResponseSchema.parse(raw);
  await parseActionReviewResponse(value.review, binding, workspace, now, attempt);
  if (value.recovery) {
    const view = value.review.view, failure = value.recovery;
    check(view && view.status === "no_reported_changes" && !view.confirmation_supported && view.changes.length === 0
      && view.preview.preview_id === original.preview.preview_id && view.preview.draft_basis_hash === original.preview.draft_basis_hash
      && failure.preview_id === view.preview.preview_id && view.source_day > failure.failed_source_day
      && Date.parse(failure.failed_at) < Date.parse(view.knowledge_not_before)
      && view.candidate_coverage_end > view.previous_coverage_end);
  }
  return value;
}
