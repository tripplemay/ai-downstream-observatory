import type Database from "better-sqlite3";
import { buildLedgerFactQuality } from "./fact-quality";
import { revision } from "./service";

export function ledgerFactQualityAt(db: Database.Database, portfolioId: string, cutoff: string, knowledgeAt = cutoff, mode: "as_known" | "restated" = "as_known", atRevision = revision(db, portfolioId), periodStart?: string) {
  const events = db.prepare("SELECT * FROM ledger_events WHERE portfolio_id=? AND ledger_revision<=? ORDER BY ledger_revision,id").all(portfolioId, atRevision) as Record<string, unknown>[];
  return buildLedgerFactQuality(events, { portfolio_id: portfolioId, ledger_revision: atRevision, cutoff_at: cutoff, knowledge_at: knowledgeAt, mode, period_start: periodStart ?? null });
}
