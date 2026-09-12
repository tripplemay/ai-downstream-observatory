import type Database from "better-sqlite3";
import { dividendStateFor, revision, type Actor } from "./service";
import { ledgerFactQualityAt } from "./fact-quality-db";

export function dividendWorkspace(db: Database.Database, actor: Actor, portfolioId: string, accountId: string, expectedRevision: number, before?: number, now = new Date().toISOString()) {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || (before !== undefined && (!Number.isSafeInteger(before) || before < 1))) throw new Error("INVALID_DIVIDEND_QUERY");
  return db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM accounts WHERE portfolio_id=? AND id=?").get(portfolioId, accountId)) throw new Error("ACCOUNT_OUT_OF_SCOPE");
    const current = revision(db, portfolioId);
    if (current !== expectedRevision) throw new Error("VERSION_CONFLICT");
    const roots = db.prepare(`SELECT e.id,e.event_type,e.effective_at,e.time_precision,e.source_timezone,e.ledger_revision,e.payload_json
      FROM ledger_events e WHERE e.portfolio_id=? AND e.account_id=? AND e.ledger_revision<?
        AND e.event_type IN ('dividend','dividend_accrual','dividend_net','corporate_action_notice')
        AND e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id)
      ORDER BY e.ledger_revision DESC,e.id LIMIT 101`).all(portfolioId, accountId, before ?? current + 1) as {
        id: string; event_type: string; effective_at: string; time_precision: string; source_timezone: string; ledger_revision: number; payload_json: string;
      }[];
    const page = roots.slice(0, 100);
    const rows = page.map(root => ({
      ...root, command: JSON.parse(root.payload_json),
      dividend: root.event_type === "corporate_action_notice" ? null : dividendStateFor(db, portfolioId, root.id),
      resolution: root.event_type !== "corporate_action_notice" ? null : db.prepare(`SELECT e.id,e.payload_json,e.effective_at,e.time_precision,e.source_timezone
        FROM ledger_events e WHERE e.portfolio_id=? AND e.account_id=? AND e.event_type='corporate_action_resolution'
          AND json_extract(e.payload_json,'$.fact.related_event_id')=? AND e.reversal_of IS NULL
          AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id) ORDER BY e.ledger_revision DESC LIMIT 1`).get(portfolioId, accountId, root.id) ?? null,
    }));
    return { portfolio_id: portfolioId, account_id: accountId, revision: current, rows, next_cursor: roots.length > 100 ? page[page.length - 1].ledger_revision : null,
      quality: ledgerFactQualityAt(db, portfolioId, now, now, "restated", current) };
  })();
}
export type DividendWorkspaceState = ReturnType<typeof dividendWorkspace>;
