import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { explainInvestorObservation, maintainInvestorAiExplanations, readInvestorAiExplanation, type AiExplanationOptions } from "./ai-explanation";

/** Startup and every pass clean retained text; only an existing explicit intent may dispatch. */
export async function runInvestorAiBackgroundPass(db: Database.Database, actor: { id: string },
  dispatch: boolean, options: AiExplanationOptions = {}) {
  assertWritableDatabase(db);
  const purged = maintainInvestorAiExplanations(db, actor, options);
  if (!dispatch || options.signal?.aborted) return { purged, processed: false };
  const pending = db.prepare(`SELECT 1 FROM investor_ai_requests r LEFT JOIN investor_ai_dispatches d ON d.request_id=r.id
    LEFT JOIN investor_ai_purges p ON p.request_id=r.id WHERE r.actor_id=? AND d.request_id IS NULL AND p.request_id IS NULL LIMIT 1`).get(actor.id);
  if (!pending) return { purged, processed: false };
  const status = readInvestorAiExplanation(db, actor, options);
  if (status.status !== "queued") return { purged, processed: false };
  await explainInvestorObservation(db, actor, { observation_id: status.observation_id!, binding_hash: status.binding_hash! }, options);
  return { purged, processed: true };
}
