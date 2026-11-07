import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { canonical } from "../ledger/service";
import { readLegacyTransitionPreviewView } from "./legacy-action-transition";
import { legacyTransitionModel, readLegacyTransitionJobStatus } from "./legacy-transition-jobs";
import { legacyTransitionResponseSchema } from "./legacy-transition-schemas";

export function readLegacyTransitionResponse(db: Database.Database, actor: { id: string }, binding: string, id: string | null = null,
  now = new Date().toISOString(), options: { latest?: boolean; lookupNonce?: string } = {}) {
  return db.transaction(() => {
    const status = readLegacyTransitionJobStatus(db, actor, id, now, options.latest ?? true);
    let view = null, previewError: null | "LEGACY_TRANSITION_VIEW_UNAVAILABLE" = null;
    if (status.request?.status === "preview_ready") {
      try { view = readLegacyTransitionPreviewView(db, actor, status.workspace_id as string, status.request.resource_id as string, now); }
      catch { previewError = "LEGACY_TRANSITION_VIEW_UNAVAILABLE"; }
    }
    let refresh = Date.parse(now) + 15000;
    if (view) refresh = Math.min(refresh, Date.parse(view.refresh_after));
    let readOnly = false;
    try { assertWritableDatabase(db); } catch (error) {
      if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") readOnly = true; else throw error;
    }
    const result = legacyTransitionResponseSchema.parse({ ...status, schema_version: "investor-legacy-transition-response-v1", read_only: readOnly,
      model: legacyTransitionModel(db, actor, now), lookup_nonce: options.lookupNonce ?? null, refresh_after: new Date(refresh).toISOString(),
      view, preview_error: previewError, session_binding: binding });
    if (Buffer.byteLength(canonical(result)) > 65536) throw new Error("LEGACY_TRANSITION_RESPONSE_TOO_LARGE"); return result;
  }).deferred();
}
