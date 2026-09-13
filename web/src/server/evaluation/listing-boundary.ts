import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";

interface BoundaryRow {
  cycle_id: string;
  portfolio_id: string;
  knowledge_at: string | null;
  capture_kind: "cycle_insert_transaction" | "legacy_missing";
  watermark_sequence: number | null;
}
export interface EvaluationListingBoundary {
  schema_version: "evaluation-listing-boundary-v1";
  cycle_id: string;
  portfolio_id: string;
  knowledge_at: string;
  capture_kind: "cycle_insert_transaction";
  watermark_sequence: number;
  proof_hash: string;
}

export function readEvaluationListingBoundary(db: Database.Database, cycle: { id: string; portfolio_id: string; knowledge_at: string }): EvaluationListingBoundary {
  const row = db.prepare("SELECT * FROM evaluation_listing_review_boundaries WHERE cycle_id=?").get(cycle.id) as BoundaryRow | undefined;
  if (!row || row.capture_kind === "legacy_missing") throw new Error("EVALUATION_LISTING_BOUNDARY_MISSING");
  const original = db.prepare("SELECT id,portfolio_id,knowledge_at FROM evaluation_cycles WHERE id=?").get(cycle.id);
  if (canonical(Object.keys(row).sort()) !== canonical(["capture_kind", "cycle_id", "knowledge_at", "portfolio_id", "watermark_sequence"])
    || !original || canonical(original) !== canonical({ id: cycle.id, portfolio_id: cycle.portfolio_id, knowledge_at: cycle.knowledge_at })
    || row.cycle_id !== cycle.id || row.portfolio_id !== cycle.portfolio_id || row.knowledge_at !== cycle.knowledge_at
    || row.capture_kind !== "cycle_insert_transaction" || !Number.isSafeInteger(row.watermark_sequence) || row.watermark_sequence! < 0) throw new Error("EVALUATION_LISTING_BOUNDARY_INVALID");
  const watermark = row.watermark_sequence === 0 ? null : db.prepare(`SELECT s.sequence,s.version_id,s.portfolio_id FROM listing_review_sequences s
    JOIN listing_review_versions r ON r.id=s.version_id AND r.portfolio_id=s.portfolio_id WHERE s.sequence=? AND s.portfolio_id=?`).get(row.watermark_sequence, row.portfolio_id);
  if (row.watermark_sequence !== 0 && !watermark) throw new Error("EVALUATION_LISTING_BOUNDARY_INVALID");
  return { schema_version: "evaluation-listing-boundary-v1", cycle_id: row.cycle_id, portfolio_id: row.portfolio_id,
    knowledge_at: row.knowledge_at!, capture_kind: row.capture_kind, watermark_sequence: row.watermark_sequence!, proof_hash: hash({ boundary: row, watermark }) };
}
