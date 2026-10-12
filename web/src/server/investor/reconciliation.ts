import type Database from "better-sqlite3";
import { amount } from "../ledger/decimal";
import { canonical, type Actor } from "../ledger/service";
import { compareReconciliationStatement, reconcileAccount, type ReconciliationResult } from "../ledger/reconciliation";
import { readJsonAttachment, storeJsonAttachment, type AttachmentOptions } from "../ledger/attachments";
import { parseStrictJson } from "../strict-json";
import { getInvestorAccountWorkspace } from "./accounts";
import { RECONCILIATION_BALANCES, statementSchema } from "../ledger/reconciliation-schemas";
import { reconciliationContextSchema, reconciliationInstantMicros, type ReconciliationIntent, type ReconciliationContext } from "./reconciliation-schemas";

function bad(): never { throw new Error("INVESTOR_RECONCILIATION_EVIDENCE_INVALID"); }
const reconciliationOrder = "substr(created_at,1,19) DESC,substr(replace(substr(created_at,21,6),'Z','')||'000000',1,6) DESC,id DESC";
function metadata(db: Database.Database, actor: Actor, portfolio: string, account: string, row: { id: string; status: string; ledger_revision: number; attachment_id: string; result_json: string; created_at: string }, now: string, options: AttachmentOptions) {
  try {
    const value = parseStrictJson(row.result_json) as ReconciliationResult;
    if (!value || canonical(Object.keys(value).sort()) !== canonical(["account_activated", "attachment_id", "cutoff_at", "id", "issues", "ledger_revision", "prior_open_issues", "status"])
      || value.id !== row.id || value.status !== row.status || value.attachment_id !== row.attachment_id || value.ledger_revision !== row.ledger_revision
      || !["matched", "issues"].includes(value.status) || !Array.isArray(value.issues) || value.issues.length > 1000
      || !Number.isSafeInteger(value.prior_open_issues) || value.prior_open_issues < 0 || typeof value.account_activated !== "boolean"
      || !Number.isSafeInteger(row.ledger_revision) || row.ledger_revision < 0
      || (value.status === "matched") !== (value.issues.length === 0)
      || value.account_activated && (value.status !== "matched" || value.prior_open_issues !== 0)
      || new Set(value.issues.map(issue => issue.id)).size !== value.issues.length
      || value.issues.some(issue => !issue || canonical(Object.keys(issue).sort()) !== canonical(["details", "id", "issue_type"])
        || typeof issue.id !== "string" || !issue.id || typeof issue.issue_type !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(issue.issue_type)
        || !issue.details || typeof issue.details !== "object" || Array.isArray(issue.details))
      || reconciliationInstantMicros(value.cutoff_at) === null || reconciliationInstantMicros(row.created_at) === null
      || reconciliationInstantMicros(value.cutoff_at)! > reconciliationInstantMicros(row.created_at)!
      || reconciliationInstantMicros(row.created_at)! > reconciliationInstantMicros(now)!) bad();
    const audits = db.prepare("SELECT * FROM audit_events WHERE action='reconcile_account' AND object_id=? AND object_type='reconciliation_run' LIMIT 2").all(row.id) as
      { actor_id: string; portfolio_id: string; ledger_revision: number; created_at: string; payload_json: string }[];
    if (audits.length !== 1 || audits[0].actor_id !== actor.id || audits[0].portfolio_id !== portfolio || audits[0].ledger_revision !== row.ledger_revision || audits[0].created_at !== row.created_at) bad();
    const proof = parseStrictJson(audits[0].payload_json) as Record<string, unknown>;
    const original = readJsonAttachment(db, actor, portfolio, row.attachment_id, { ...options, accountId: account });
    const sourceAudit = db.prepare(`SELECT created_at FROM audit_events WHERE actor_id=? AND action='store_attachment' AND object_type='attachment'
      AND object_id=? AND portfolio_id=? AND json_extract(payload_json,'$.account_id')=? ORDER BY created_at LIMIT 1`).get(actor.id, row.attachment_id, portfolio, account) as { created_at: string } | undefined;
    if (!sourceAudit || reconciliationInstantMicros(sourceAudit.created_at) === null
      || reconciliationInstantMicros(sourceAudit.created_at)! > reconciliationInstantMicros(row.created_at)!) bad();
    const fields = ["account_id", "attachment_id", "content_hash", "status", "issue_count", "resolved_issue_ids", "account_activated"];
    if (proof && ("security_transit_lots" in proof || "security_transits_complete" in proof)) fields.push("security_transit_lots", "security_transits_complete");
    const statement = statementSchema.parse(parseStrictJson(original.bytes.toString("utf8")));
    if (proof.account_id !== account || proof.attachment_id !== row.attachment_id || proof.status !== row.status || proof.issue_count !== value.issues.length
      || proof.account_activated !== value.account_activated || proof.content_hash !== original.attachment.content_hash
      || canonical(Object.keys(proof).sort()) !== canonical(fields.sort()) || !Array.isArray(proof.resolved_issue_ids)
      || proof.resolved_issue_ids.length > 1000 || proof.resolved_issue_ids.some(id => typeof id !== "string" || !id || id.length > 200)
      || statement.portfolio_id !== portfolio || statement.account_id !== account || statement.cutoff_at !== value.cutoff_at
      || proof.security_transit_lots !== undefined && (!Number.isSafeInteger(proof.security_transit_lots) || Number(proof.security_transit_lots) < 0)
      || proof.security_transits_complete !== undefined && proof.security_transits_complete !== (statement.coverage.security_transits_complete === true)) bad();
    return value;
  } catch { bad(); }
}

export function getInvestorReconciliationContext(db: Database.Database, actor: Actor, accountId: string, now = new Date().toISOString(), options: AttachmentOptions = {}): ReconciliationContext {
  return db.transaction(() => {
    const scope = getInvestorAccountWorkspace(db, actor, now), link = scope.link, book = scope.books.find(row => row.id === link?.document.portfolio_id);
    const account = scope.accounts.find(row => row.id === accountId);
    if (!book || !link || !account) throw new Error("INVESTOR_ACCOUNT_OUT_OF_SCOPE");
    const positions = db.prepare("SELECT listing_id,currency,quantity FROM position_projections WHERE account_id=? AND quantity<>'0' ORDER BY listing_id LIMIT 101").all(account.id) as { listing_id: string; currency: string; quantity: string }[];
    const balances = db.prepare(`SELECT currency,balance FROM account_projections WHERE account_id=? AND balance<>'0'
      AND ledger_account IN (${RECONCILIATION_BALANCES.map(() => "?").join(",")}) LIMIT 161`).all(account.id, ...RECONCILIATION_BALANCES) as { currency: string; balance: string }[];
    const transits = db.prepare(`SELECT t.transfer_event_id,t.source_account_id,t.target_account_id,t.listing_id,t.currency,t.quantity,
      CASE WHEN s.portfolio_id=? THEN s.name END source_name,CASE WHEN d.portfolio_id=? THEN d.name END target_name
      FROM security_transit_projections t LEFT JOIN accounts s ON s.id=t.source_account_id LEFT JOIN accounts d ON d.id=t.target_account_id
      WHERE (t.source_account_id=? OR t.target_account_id=?) AND t.quantity<>'0' ORDER BY t.transfer_event_id LIMIT 31`).all(book.id, book.id, account.id, account.id) as
      (ReconciliationContext["requirements"]["transits"][number] & { quantity: string })[];
    const listings = db.prepare(`SELECT l.id,l.ticker,l.currency,l.market,i.name FROM listings l JOIN instruments i ON i.id=l.instrument_id
      WHERE EXISTS(SELECT 1 FROM audit_events a WHERE a.portfolio_id=? AND a.action='register_listing' AND a.object_type='workbench_command' AND json_extract(a.payload_json,'$.result.listing_id')=l.id)
      OR EXISTS(SELECT 1 FROM position_movements p JOIN ledger_events e ON e.id=p.event_id WHERE e.portfolio_id=? AND p.listing_id=l.id)
      OR EXISTS(SELECT 1 FROM security_transit_movements p JOIN ledger_events e ON e.id=p.event_id WHERE e.portfolio_id=? AND p.listing_id=l.id)
      ORDER BY l.market,l.ticker,l.id LIMIT 201`).all(book.id, book.id, book.id) as ReconciliationContext["requirements"]["listings"];
    if (positions.length > 100 || balances.length > 160 || transits.length > 30 || listings.length > 200) throw new Error("INVESTOR_RECONCILIATION_CAPACITY_REQUIRES_REVIEW");
    const currencies = new Set([account.base_currency]);
    for (const row of [...positions, ...balances, ...transits]) {
      const value = "quantity" in row ? row.quantity : row.balance;
      if (!amount(value).isZero()) currencies.add(row.currency);
    }
    if (currencies.size > 20) throw new Error("INVESTOR_RECONCILIATION_CAPACITY_REQUIRES_REVIEW");
    const rows = db.prepare(`SELECT * FROM reconciliation_runs WHERE portfolio_id=? AND account_id=? ORDER BY ${reconciliationOrder} LIMIT 2`).all(book.id, account.id) as Parameters<typeof metadata>[4][];
    const row = rows[0];
    let latest: ReconciliationContext["latest"] = null;
    const openIds = db.prepare(`SELECT i.id issue_id,i.issue_type,i.details_json,r.id run_id FROM reconciliation_issues i JOIN reconciliation_runs r ON r.id=i.run_id
      WHERE r.portfolio_id=? AND r.account_id=? AND i.status='open' ORDER BY i.id LIMIT 101`).all(book.id, account.id) as { issue_id: string; issue_type: string; details_json: string; run_id: string }[];
    if (openIds.length > 100) throw new Error("INVESTOR_RECONCILIATION_CAPACITY_REQUIRES_REVIEW");
    const runCache = new Map<string, ReconciliationResult>();
    let historyStatus: ReconciliationContext["history_status"] = "verified", openIssues: ReconciliationContext["open_issues"] = [];
    try {
      if (rows[1] && reconciliationInstantMicros(rows[1].created_at) === reconciliationInstantMicros(row.created_at)) bad();
      if (row) { const value = metadata(db, actor, book.id, account.id, row, now, options);
        latest = { id: row.id, status: value.status, ledger_revision: row.ledger_revision, cutoff_at: value.cutoff_at, created_at: row.created_at,
          issue_count: value.issues.length, prior_open_issues: value.prior_open_issues, account_activated: value.account_activated, current_facts: row.ledger_revision === book.ledger_revision };
        runCache.set(row.id, value); }
      openIssues = openIds.map(issue => {
      let result = runCache.get(issue.run_id);
      if (!result) { const run = db.prepare("SELECT * FROM reconciliation_runs WHERE id=?").get(issue.run_id) as Parameters<typeof metadata>[4]; result = metadata(db, actor, book.id, account.id, run, now, options); runCache.set(issue.run_id, result); }
      const original = result.issues.find(row => row.id === issue.issue_id);
      if (!original || original.issue_type !== issue.issue_type || canonical(original.details) !== canonical(parseStrictJson(issue.details_json))) bad();
      return { id: issue.issue_id, code: issue.issue_type, cutoff_at: result.cutoff_at };
      });
    } catch {
      // Lost old source evidence must not fabricate a pass or prevent a new independent submission.
      latest = null; openIssues = []; historyStatus = "unavailable";
    }
    try { return reconciliationContextSchema.parse({ schema_version: "investor-reconciliation-v1", workspace_id: scope.workspace_id, workspace_revision: scope.workspace_revision,
      checked_at: now, portfolio_id: book.id, ledger_revision: book.ledger_revision, link_id: link.id, link_version: link.version, account_id: account.id,
      account_row_version: account.row_version, read_only: scope.read_only, requirements: { currencies: [...currencies].sort(),
        known_positions: positions.filter(row => !amount(row.quantity).isZero()).map(row => row.listing_id), listings,
        transits: transits.filter(row => !amount(row.quantity).isZero()).map(({ quantity: _, ...row }) => row) }, latest, open_issues: openIssues,
        history_status: historyStatus, open_issue_count: openIds.length, scope: "metadata_only_no_prefilled_balances", execution_authorized: false }); }
    catch { bad(); }
  })();
}

export function reconcileInvestorAccount(db: Database.Database, actor: Actor, input: ReconciliationIntent, now: string, options: AttachmentOptions = {}) {
  const context = getInvestorReconciliationContext(db, actor, input.account_id, now, options);
  if (context.portfolio_id !== input.portfolio_id || input.statement.portfolio_id !== input.portfolio_id || input.statement.account_id !== input.account_id) throw new Error("INVESTOR_ACCOUNT_OUT_OF_SCOPE");
  if (context.link_id !== input.expected_link_id || context.link_version !== input.expected_link_version) throw new Error("INVESTOR_RECONCILIATION_CONTEXT_CONFLICT");
  if (context.ledger_revision !== input.expected_ledger_revision || context.account_row_version !== input.expected_account_row_version) throw new Error("INVESTOR_RECONCILIATION_CONTEXT_CONFLICT");
  if (reconciliationInstantMicros(input.statement.cutoff_at)! > reconciliationInstantMicros(now)!) throw new Error("INVESTOR_RECONCILIATION_INPUT_INVALID");
  const known = new Map(context.requirements.listings.map(row => [row.id, row.currency]));
  if (input.statement.positions.some(row => known.get(row.listing_id) !== row.currency)
    || input.statement.security_transits.some(row => known.get(row.listing_id) !== row.currency || !context.requirements.transits.some(item =>
      item.transfer_event_id === row.transfer_event_id && item.source_account_id === row.source_account_id && item.target_account_id === row.target_account_id && item.listing_id === row.listing_id && item.currency === row.currency))
    || new Set(input.resolves_issue_ids).size !== input.resolves_issue_ids.length || input.resolves_issue_ids.some(id => !context.open_issues.some(row => row.id === id))
    || input.resolves_issue_ids.length && (!input.resolution_reason || context.open_issues.some(row => input.resolves_issue_ids.includes(row.id)
      && reconciliationInstantMicros(row.cutoff_at)! > reconciliationInstantMicros(input.statement.cutoff_at)!))) throw new Error("INVESTOR_RECONCILIATION_INPUT_INVALID");
  const command = { portfolio_id: input.portfolio_id, account_id: input.account_id, expected_revision: input.expected_ledger_revision };
  try {
    const replay = compareReconciliationStatement(db, actor, command, input.statement, now);
    if (input.resolves_issue_ids.length && replay.issues.length) throw new Error("INVESTOR_RECONCILIATION_INPUT_INVALID");
  } catch (error) { if (error instanceof Error && error.message === "HISTORICAL_RECONCILIATION_UNSUPPORTED") throw new Error("INVESTOR_RECONCILIATION_CUTOFF_UNSUPPORTED"); throw error; }
  const attachment = storeJsonAttachment(db, actor, { portfolio_id: input.portfolio_id, account_id: input.account_id, raw: canonical(input.statement) }, { ...options, now });
  return reconcileAccount(db, actor, { ...command, attachment_id: attachment.id, resolves_issue_ids: input.resolves_issue_ids, resolution_reason: input.resolution_reason }, { ...options, now });
}
