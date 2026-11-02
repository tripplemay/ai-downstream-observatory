import { unchangedRecoveryResponseSchema } from "../src/server/investor/unchanged-action-recovery-schemas";
import { reviewResponse, reviewView } from "./action-review-client-fixture";

export function recoveryResponse() {
  const view = { ...reviewView(), status: "no_reported_changes" as const, confirmation_supported: false, changes: [] };
  return unchangedRecoveryResponseSchema.parse({ schema_version: "investor-unchanged-action-recovery-response-v1",
    review: reviewResponse({ view }), recovery: { preview_id: view.preview.preview_id, failed_publication_id: "fictional-failure",
      failed_publication_hash: "2".repeat(64), failed_source_day: "2026-11-02", failed_at: "2026-11-02T06:00:03.001Z",
      failure_code: "SOURCE_CAPTURE_TERMINAL_FAILURE" } });
}
