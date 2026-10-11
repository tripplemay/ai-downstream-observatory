import type Database from "better-sqlite3";
import { canonical, type Actor } from "../ledger/service";
import { readJsonAttachment, type AttachmentOptions } from "../ledger/attachments";
import { compareReconciliationStatement, statementSchema, type ReconciliationResult } from "../ledger/reconciliation";
import { parseStrictJson } from "../strict-json";
import { holdingsInstantMicros, type HoldingsGapCode } from "./holdings-schemas";

export const reconciliationReadOrderSql = "substr(created_at,1,19) DESC,substr(replace(substr(created_at,21,6),'Z','')||'000000',1,6) DESC,id DESC";
function fail(code: HoldingsGapCode): never { throw new Error(code); }

export function readInvestorReconciliation(db: Database.Database, actor: Actor, portfolio: string, account: string,
  revision: number, now: string, options: AttachmentOptions = {}) {
  const rows = db.prepare(`SELECT * FROM reconciliation_runs WHERE portfolio_id=? AND account_id=? ORDER BY ${reconciliationReadOrderSql} LIMIT 2`)
    .all(portfolio, account) as { id: string; ledger_revision: number; attachment_id: string; status: string; result_json: string; created_at: string }[];
  const row = rows[0];
  if (rows[1] && holdingsInstantMicros(rows[1].created_at) === holdingsInstantMicros(row.created_at)) fail("RECONCILIATION_EVIDENCE_INVALID");
  if (!row || row.status !== "matched") fail("RECONCILIATION_REQUIRED");
  try {
    const created = holdingsInstantMicros(row.created_at), checked = holdingsInstantMicros(now);
    if (created === null || checked === null || created > checked || !Number.isSafeInteger(row.ledger_revision) || row.ledger_revision < 0 || row.ledger_revision > revision) fail("RECONCILIATION_EVIDENCE_INVALID");
    const result = parseStrictJson(row.result_json) as ReconciliationResult;
    if (!result || canonical(Object.keys(result).sort()) !== canonical(["account_activated", "attachment_id", "cutoff_at", "id", "issues", "ledger_revision", "prior_open_issues", "status"])
      || result.id !== row.id || result.attachment_id !== row.attachment_id || result.ledger_revision !== row.ledger_revision || result.status !== "matched"
      || !Array.isArray(result.issues) || result.issues.length || result.prior_open_issues !== 0 || typeof result.account_activated !== "boolean"
      || holdingsInstantMicros(result.cutoff_at) === null || holdingsInstantMicros(result.cutoff_at)! > created) fail("RECONCILIATION_EVIDENCE_INVALID");
    const audits = db.prepare("SELECT * FROM audit_events WHERE action='reconcile_account' AND object_type='reconciliation_run' AND object_id=? LIMIT 2").all(row.id) as
      { actor_id: string; portfolio_id: string; ledger_revision: number; created_at: string; payload_json: string }[];
    if (audits.length !== 1 || audits[0].actor_id !== actor.id || audits[0].portfolio_id !== portfolio || audits[0].ledger_revision !== row.ledger_revision || audits[0].created_at !== row.created_at) fail("RECONCILIATION_EVIDENCE_INVALID");
    const payload = parseStrictJson(audits[0].payload_json) as Record<string, unknown>;
    const fields = ["account_id", "attachment_id", "content_hash", "status", "issue_count", "resolved_issue_ids", "account_activated"];
    if (payload && ("security_transit_lots" in payload || "security_transits_complete" in payload)) fields.push("security_transit_lots", "security_transits_complete");
    if (!payload || payload.account_id !== account || payload.attachment_id !== row.attachment_id || payload.status !== "matched" || payload.issue_count !== 0
      || payload.account_activated !== result.account_activated || !Array.isArray(payload.resolved_issue_ids) || payload.resolved_issue_ids.length > 1000
      || payload.resolved_issue_ids.some(value => typeof value !== "string" || !value || value.length > 200)
      || canonical(Object.keys(payload).sort()) !== canonical(fields.sort())) fail("RECONCILIATION_EVIDENCE_INVALID");
    const lastTouch = db.prepare(`SELECT max(e.ledger_revision) revision FROM ledger_events e WHERE e.portfolio_id=? AND
      (e.account_id=? OR EXISTS(SELECT 1 FROM postings p WHERE p.event_id=e.id AND p.account_id=?)
      OR EXISTS(SELECT 1 FROM position_movements p WHERE p.event_id=e.id AND p.account_id=?)
      OR EXISTS(SELECT 1 FROM security_transit_movements p WHERE p.event_id=e.id AND (p.source_account_id=? OR p.target_account_id=?)))`)
      .get(portfolio, account, account, account, account, account) as { revision: number | null };
    if (lastTouch.revision !== null && lastTouch.revision > row.ledger_revision) fail("RECONCILIATION_FACTS_CHANGED");
    if (db.prepare(`SELECT 1 FROM reconciliation_issues i JOIN reconciliation_runs r ON r.id=i.run_id
      WHERE r.portfolio_id=? AND r.account_id=? AND i.status='open' LIMIT 1`).get(portfolio, account)) fail("RECONCILIATION_REQUIRED");
    let original: ReturnType<typeof readJsonAttachment>;
    try { original = readJsonAttachment(db, actor, portfolio, row.attachment_id, { ...options, accountId: account }); }
    catch { fail("RECONCILIATION_SOURCE_UNAVAILABLE"); }
    if (payload.content_hash !== original.attachment.content_hash) fail("RECONCILIATION_EVIDENCE_INVALID");
    const sourceAudit = db.prepare(`SELECT created_at FROM audit_events WHERE actor_id=? AND action='store_attachment' AND object_type='attachment'
      AND object_id=? AND portfolio_id=? AND json_extract(payload_json,'$.account_id')=? ORDER BY created_at LIMIT 1`).get(actor.id, row.attachment_id, portfolio, account) as { created_at: string } | undefined;
    if (!sourceAudit || holdingsInstantMicros(sourceAudit.created_at) === null || holdingsInstantMicros(sourceAudit.created_at)! > created) fail("RECONCILIATION_EVIDENCE_INVALID");
    const statement = statementSchema.parse(parseStrictJson(original.bytes.toString("utf8")));
    if (statement.cutoff_at !== result.cutoff_at || statement.portfolio_id !== portfolio || statement.account_id !== account) fail("RECONCILIATION_EVIDENCE_INVALID");
    const replay = compareReconciliationStatement(db, actor, { portfolio_id: portfolio, account_id: account, expected_revision: revision }, statement, now);
    if (replay.issues.length) fail("RECONCILIATION_MISMATCH");
    if (payload.security_transit_lots !== undefined && payload.security_transit_lots !== replay.actualTransits.length
      || payload.security_transits_complete !== undefined && payload.security_transits_complete !== replay.transitCoverage) fail("RECONCILIATION_EVIDENCE_INVALID");
    return { account_id: account, run_id: row.id, attachment_hash: original.attachment.content_hash, cutoff_at: statement.cutoff_at };
  } catch (error) {
    if (error instanceof Error && /^RECONCILIATION_(?:REQUIRED|EVIDENCE_INVALID|SOURCE_UNAVAILABLE|FACTS_CHANGED|MISMATCH)$/.test(error.message)) throw error;
    fail("RECONCILIATION_EVIDENCE_INVALID");
  }
}
