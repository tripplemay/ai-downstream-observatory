import type Database from "better-sqlite3";
import { readActionReviewResponse } from "./action-review-read";
import { readUnchangedActionRecoveryPreview } from "./action-review-lineage";
import { unchangedRecoveryResponseSchema } from "./unchanged-action-recovery-schemas";

export function readUnchangedActionRecoveryResponse(db: Database.Database, actor: { id: string }, binding: string,
  id: string | null = null, now = new Date().toISOString(), options: { latest?: boolean; lookupNonce?: string } = {}) {
  return db.transaction(() => {
    const review = readActionReviewResponse(db, actor, binding, id, now, options);
    let recovery = null;
    if (review.view?.status === "no_reported_changes") {
      try { recovery = readUnchangedActionRecoveryPreview(db, review.workspace_id, actor.id, review.view.preview.preview_id, now); }
      catch { /* Ineligible or unreadable evidence never becomes recovery permission. */ }
    }
    return unchangedRecoveryResponseSchema.parse({ schema_version: "investor-unchanged-action-recovery-response-v1", review, recovery });
  }).deferred();
}
