import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { assertWritableDatabase } from "../workbench-db";
import { parseStrictJson } from "../strict-json";
import { amount, exact } from "./decimal";
import { readJsonAttachment, type AttachmentOptions } from "./attachments";
import { audit, canonical, revision, type Actor } from "./service";
import { ledgerFactQualityAt } from "./fact-quality-db";

const BASE_RECONCILIATION_BALANCES = ["cash_settled", "trade_receivable", "trade_payable", "dividend_receivable", "transfer_in_transit", "other_liability", "cash_hold"] as const;
export const RECONCILIATION_BALANCES = [...BASE_RECONCILIATION_BALANCES, "dividend_tax_payable"] as const;
const id = z.string().min(1).max(200);
const currency = z.string().regex(/^[A-Z]{3}$/);
const decimal = z.string().max(80).superRefine((value, context) => {
  try { amount(value); } catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_DECIMAL" }); }
});
export const statementSchema = z.object({
  schema_version: z.literal(1), portfolio_id: id, account_id: id,
  cutoff_at: z.string().datetime({ offset: false }),
  coverage: z.object({
    currencies: z.array(currency).min(1).max(100),
    ledger_accounts: z.array(z.enum(RECONCILIATION_BALANCES)).min(1).max(RECONCILIATION_BALANCES.length),
    positions_complete: z.literal(true), balances_complete: z.literal(true),
    security_transits_complete: z.literal(true).optional(),
  }).strict(),
  balances: z.array(z.object({ currency, ledger_account: z.enum(RECONCILIATION_BALANCES), balance: decimal }).strict()).max(1000),
  positions: z.array(z.object({ listing_id: id, currency, quantity: decimal }).strict()).max(10000),
  security_transits: z.array(z.object({ transfer_event_id: id, source_account_id: id, target_account_id: id, listing_id: id, currency, quantity: decimal }).strict()).max(10000).optional(),
}).strict();
export type AccountStatement = z.infer<typeof statementSchema>;
export interface ReconciliationCommand {
  portfolio_id: string; account_id: string; expected_revision: number; attachment_id: string;
  resolves_issue_ids?: string[]; resolution_reason?: string;
}
export interface ReconciliationIssue { id: string; issue_type: string; details: Record<string, unknown> }
export interface ReconciliationResult {
  id: string; status: "matched" | "issues"; ledger_revision: number; cutoff_at: string; attachment_id: string;
  issues: ReconciliationIssue[]; prior_open_issues: number; account_activated: boolean;
}

function currentAccount(db: Database.Database, actor: Actor, portfolioId: string, accountId: string): { base_currency: string; status: string } {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  const account = db.prepare("SELECT base_currency,status FROM accounts WHERE id=? AND portfolio_id=?").get(accountId, portfolioId) as { base_currency: string; status: string } | undefined;
  if (!account) throw new Error("ACCOUNT_OUT_OF_SCOPE");
  return account;
}

function assertCutoff(db: Database.Database, accountId: string, cutoff: string, now: string): void {
  const cutoffTime = new Date(cutoff).getTime(), currentTime = new Date(now).getTime();
  if (!Number.isFinite(currentTime)) throw new Error("INVALID_CLOCK");
  if (cutoffTime > currentTime) throw new Error("FUTURE_STATEMENT_NOT_ALLOWED");
  const events = db.prepare("SELECT e.effective_at,e.time_precision,e.source_timezone FROM ledger_events e WHERE e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id) AND (e.account_id=? OR EXISTS(SELECT 1 FROM postings p WHERE p.event_id=e.id AND p.account_id=?) OR EXISTS(SELECT 1 FROM position_movements p WHERE p.event_id=e.id AND p.account_id=?) OR EXISTS(SELECT 1 FROM security_transit_movements t WHERE t.event_id=e.id AND (t.source_account_id=? OR t.target_account_id=?)))")
    .all(accountId, accountId, accountId, accountId, accountId) as { effective_at: string; time_precision: string; source_timezone: string }[];
  for (const event of events) {
    if (event.time_precision === "second") {
      if (new Date(event.effective_at).getTime() > cutoffTime) throw new Error("HISTORICAL_RECONCILIATION_UNSUPPORTED");
    } else {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: event.source_timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(cutoff));
      const part = (type: string) => parts.find(item => item.type === type)!.value;
      const cutoffDay = `${part("year")}-${part("month")}-${part("day")}`;
      // A date-only fact has no invented intraday time; only a completed local day can be compared.
      if (event.effective_at >= cutoffDay) throw new Error("HISTORICAL_RECONCILIATION_UNSUPPORTED");
    }
  }
}

export function reconcileAccount(db: Database.Database, actor: Actor, input: ReconciliationCommand, options: AttachmentOptions = {}): ReconciliationResult {
  currentAccount(db, actor, input.portfolio_id, input.account_id);
  assertWritableDatabase(db);
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) throw new Error("INVALID_RECONCILIATION_COMMAND");
  const resolveIds = input.resolves_issue_ids ?? [];
  if (resolveIds.length > 1000 || new Set(resolveIds).size !== resolveIds.length || resolveIds.some(value => typeof value !== "string" || !value || value.length > 200)
    || (resolveIds.length && (!input.resolution_reason?.trim() || input.resolution_reason.length > 2000))) throw new Error("INVALID_RECONCILIATION_RESOLUTION");
  const { bytes, attachment } = readJsonAttachment(db, actor, input.portfolio_id, input.attachment_id, { ...options, accountId: input.account_id });
  let raw: unknown;
  try { raw = parseStrictJson(bytes.toString("utf8")); } catch { throw new Error("INVALID_STATEMENT_JSON"); }
  const parsed = statementSchema.safeParse(raw);
  if (!parsed.success) throw new Error("INVALID_ACCOUNT_STATEMENT");
  const statement = parsed.data;
  if (statement.portfolio_id !== input.portfolio_id || statement.account_id !== input.account_id) throw new Error("STATEMENT_OUT_OF_SCOPE");
  const now = options.now ?? new Date().toISOString();
  return db.transaction(() => {
    assertWritableDatabase(db);
    const account = currentAccount(db, actor, input.portfolio_id, input.account_id);
    if (revision(db, input.portfolio_id) !== input.expected_revision) throw new Error("VERSION_CONFLICT");
    assertCutoff(db, input.account_id, statement.cutoff_at, now);
    const issues: ReconciliationIssue[] = [];
    const issue = (issue_type: string, details: Record<string, unknown>) => issues.push({ id: randomUUID(), issue_type, details });
    const coverage = new Set(statement.coverage.currencies);
    const balanceCoverage = new Set(statement.coverage.ledger_accounts);
    if (coverage.size !== statement.coverage.currencies.length || balanceCoverage.size !== statement.coverage.ledger_accounts.length) issue("duplicate_coverage", {});
    const actualBalances = db.prepare("SELECT currency,ledger_account,balance FROM account_projections WHERE account_id=?").all(input.account_id) as { currency: string; ledger_account: string; balance: string }[];
    // A legacy statement remains usable when the newly introduced liability is absent.
    const requireTaxPayable = balanceCoverage.has("dividend_tax_payable") || statement.balances.some(row => row.ledger_account === "dividend_tax_payable")
      || actualBalances.some(row => row.ledger_account === "dividend_tax_payable" && !amount(row.balance).isZero());
    const comparedBalances = requireTaxPayable ? RECONCILIATION_BALANCES : BASE_RECONCILIATION_BALANCES;
    for (const name of comparedBalances) if (!balanceCoverage.has(name)) issue("missing_balance_coverage", { ledger_account: name });
    const actualPositions = db.prepare("SELECT listing_id,currency,quantity FROM position_projections WHERE account_id=?").all(input.account_id) as { listing_id: string; currency: string; quantity: string }[];
    type Transit = NonNullable<AccountStatement["security_transits"]>[number];
    const actualTransits = (db.prepare("SELECT transfer_event_id,source_account_id,target_account_id,listing_id,currency,quantity FROM security_transit_projections WHERE source_account_id=? OR target_account_id=? ORDER BY transfer_event_id").all(input.account_id, input.account_id) as Transit[]).filter(row => !amount(row.quantity).isZero());
    const requiredCurrencies = new Set([account.base_currency]);
    for (const balance of actualBalances) if (RECONCILIATION_BALANCES.includes(balance.ledger_account as typeof RECONCILIATION_BALANCES[number]) && !amount(balance.balance).isZero()) requiredCurrencies.add(balance.currency);
    for (const position of actualPositions) if (!amount(position.quantity).isZero()) requiredCurrencies.add(position.currency);
    for (const transit of actualTransits) requiredCurrencies.add(transit.currency);
    for (const required of requiredCurrencies) if (!coverage.has(required)) issue("missing_currency_coverage", { currency: required });
    const balanceKey = (row: { currency: string; ledger_account: string }) => `${row.currency}:${row.ledger_account}`;
    const actual = new Map(actualBalances.map(row => [balanceKey(row), row.balance]));
    const reported = new Map<string, string>();
    for (const row of statement.balances) {
      const key = balanceKey(row);
      if (reported.has(key)) issue("duplicate_balance", { key });
      else reported.set(key, row.balance);
      if (!coverage.has(row.currency) || !balanceCoverage.has(row.ledger_account)) issue("balance_outside_coverage", { key });
    }
    const comparedCurrencies = new Set([...coverage, ...requiredCurrencies]);
    for (const curr of comparedCurrencies) for (const ledger_account of comparedBalances) {
      const key = `${curr}:${ledger_account}`, expected = actual.get(key) ?? "0", supplied = reported.get(key);
      if (supplied === undefined) issue("missing_statement_balance", { currency: curr, ledger_account, expected });
      else if (!amount(expected).equals(amount(supplied))) issue("balance_mismatch", { currency: curr, ledger_account, expected, reported: supplied, difference: exact(amount(supplied).sub(amount(expected))) });
    }
    const actualPositionMap = new Map(actualPositions.map(row => [row.listing_id, row]));
    const reportedPositions = new Map<string, AccountStatement["positions"][number]>();
    for (const row of statement.positions) {
      if (reportedPositions.has(row.listing_id)) issue("duplicate_position", { listing_id: row.listing_id });
      else reportedPositions.set(row.listing_id, row);
      if (!coverage.has(row.currency)) issue("position_outside_coverage", { listing_id: row.listing_id, currency: row.currency });
      const listing = db.prepare("SELECT currency FROM listings WHERE id=?").get(row.listing_id) as { currency: string } | undefined;
      if (!listing || listing.currency !== row.currency) issue("invalid_statement_listing", { listing_id: row.listing_id, currency: row.currency });
    }
    for (const listingId of new Set([...actualPositions.filter(row => !amount(row.quantity).isZero()).map(row => row.listing_id), ...reportedPositions.keys()])) {
      const book = actualPositionMap.get(listingId), supplied = reportedPositions.get(listingId);
      if (!supplied) issue("missing_statement_position", { listing_id: listingId, expected: book!.quantity });
      else if ((book && book.currency !== supplied.currency) || !amount(book?.quantity ?? "0").equals(amount(supplied.quantity))) issue("position_mismatch", { listing_id: listingId, expected: book?.quantity ?? "0", reported: supplied.quantity, currency: supplied.currency });
    }
    const transitCoverage = statement.coverage.security_transits_complete === true;
    if (actualTransits.length || transitCoverage || statement.security_transits !== undefined) {
      if (!transitCoverage) issue("missing_security_transit_coverage", {});
      if (statement.security_transits === undefined) issue("missing_statement_security_transits", {});
    }
    const transitIdentity = (row: Transit) => ({ source_account_id: row.source_account_id, target_account_id: row.target_account_id, listing_id: row.listing_id, currency: row.currency });
    const validTransitIdentity = (row: Transit) => {
      if (row.source_account_id === row.target_account_id || ![row.source_account_id, row.target_account_id].includes(input.account_id)) return false;
      if (![row.source_account_id, row.target_account_id].every(accountId => db.prepare("SELECT 1 FROM accounts WHERE id=? AND portfolio_id=?").get(accountId, input.portfolio_id))) return false;
      const transfer = db.prepare("SELECT payload_json FROM ledger_events e WHERE e.id=? AND e.portfolio_id=? AND e.event_type='security_transfer_out' AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id)").get(row.transfer_event_id, input.portfolio_id) as { payload_json: string } | undefined;
      if (!transfer) return false;
      const fact = JSON.parse(transfer.payload_json).fact;
      const listing = db.prepare("SELECT currency FROM listings WHERE id=?").get(row.listing_id) as { currency: string } | undefined;
      return fact.account_id === row.source_account_id && fact.target_account_id === row.target_account_id && fact.listing_id === row.listing_id && fact.currency === row.currency && listing?.currency === row.currency;
    };
    const actualTransitMap = new Map(actualTransits.map(row => [row.transfer_event_id, row]));
    for (const row of actualTransits) if (!validTransitIdentity(row) || amount(row.quantity).lt(0)) issue("invalid_ledger_security_transit", { transfer_event_id: row.transfer_event_id });
    const reportedTransits = new Map<string, Transit>();
    for (const row of statement.security_transits ?? []) {
      if (reportedTransits.has(row.transfer_event_id)) issue("duplicate_security_transit", { transfer_event_id: row.transfer_event_id });
      else reportedTransits.set(row.transfer_event_id, row);
      if (!validTransitIdentity(row)) issue("invalid_statement_security_transit", { transfer_event_id: row.transfer_event_id });
      if (!coverage.has(row.currency)) issue("security_transit_outside_coverage", { transfer_event_id: row.transfer_event_id, currency: row.currency });
      if (!amount(row.quantity).gt(0)) issue("invalid_statement_security_transit_quantity", { transfer_event_id: row.transfer_event_id, quantity: row.quantity });
    }
    for (const transferId of new Set([...actualTransitMap.keys(), ...reportedTransits.keys()])) {
      const book = actualTransitMap.get(transferId), supplied = reportedTransits.get(transferId);
      if (!supplied) issue("missing_statement_security_transit", { transfer_event_id: transferId, expected: book!.quantity });
      else if (!book) issue("unexpected_statement_security_transit", { transfer_event_id: transferId, reported: supplied.quantity });
      else {
        if (canonical(transitIdentity(book)) !== canonical(transitIdentity(supplied))) issue("security_transit_identity_mismatch", { transfer_event_id: transferId, expected: transitIdentity(book), reported: transitIdentity(supplied) });
        if (!amount(book.quantity).eq(supplied.quantity)) issue("security_transit_quantity_mismatch", { transfer_event_id: transferId, expected: book.quantity, reported: supplied.quantity, difference: exact(amount(supplied.quantity).sub(book.quantity)) });
      }
    }
    const factQuality = ledgerFactQualityAt(db, input.portfolio_id, statement.cutoff_at, now, "restated", input.expected_revision);
    const unresolvedDividends = factQuality.dividends.filter(row => row.account_id === input.account_id && (row.nav_quality !== "complete" || row.performance_quality !== "complete"));
    const unresolvedActions = factQuality.corporate_actions.filter(row => row.account_id === input.account_id && row.status !== "resolved");
    if (unresolvedDividends.length || unresolvedActions.length) issue("unresolved_financial_facts", {
      quality_binding_id: factQuality.binding_id,
      dividend_event_ids: unresolvedDividends.map(row => row.event_id), corporate_action_event_ids: unresolvedActions.map(row => row.event_id),
    });
    const runId = randomUUID();
    if (resolveIds.length && issues.length) throw new Error("RESOLUTION_REQUIRES_MATCHED_STATEMENT");
    const resolved: { id: string }[] = [];
    for (const issueId of resolveIds) {
      const previous = db.prepare("SELECT i.id,r.result_json FROM reconciliation_issues i JOIN reconciliation_runs r ON r.id=i.run_id WHERE i.id=? AND i.status='open' AND r.account_id=? AND r.portfolio_id=?")
        .get(issueId, input.account_id, input.portfolio_id) as { id: string; result_json: string } | undefined;
      if (!previous) throw new Error("RECONCILIATION_ISSUE_OUT_OF_SCOPE");
      const prior = JSON.parse(previous.result_json) as { cutoff_at: string };
      if (!prior.cutoff_at || new Date(prior.cutoff_at).getTime() > new Date(statement.cutoff_at).getTime()) throw new Error("RESOLUTION_CUTOFF_TOO_EARLY");
      resolved.push(previous);
    }
    for (const previous of resolved) db.prepare("UPDATE reconciliation_issues SET status='resolved',resolution_json=?,resolved_by=?,resolved_at=? WHERE id=? AND status='open'")
      .run(canonical({ matched_run_id: runId, attachment_id: attachment.id, reason: input.resolution_reason }), actor.id, now, previous.id);
    const priorOpen = (db.prepare("SELECT COUNT(*) AS count FROM reconciliation_issues i JOIN reconciliation_runs r ON r.id=i.run_id WHERE r.account_id=? AND r.portfolio_id=? AND i.status='open'").get(input.account_id, input.portfolio_id) as { count: number }).count;
    const active = !issues.length && priorOpen === 0 && account.status !== "disabled";
    const result: ReconciliationResult = { id: runId, status: issues.length ? "issues" : "matched", ledger_revision: input.expected_revision, cutoff_at: statement.cutoff_at, attachment_id: attachment.id, issues, prior_open_issues: priorOpen, account_activated: active };
    db.prepare("INSERT INTO reconciliation_runs(id,portfolio_id,account_id,ledger_revision,attachment_id,status,result_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(runId, input.portfolio_id, input.account_id, input.expected_revision, attachment.id, result.status, canonical(result), now);
    for (const row of issues) db.prepare("INSERT INTO reconciliation_issues(id,run_id,issue_type,details_json) VALUES(?,?,?,?)").run(row.id, runId, row.issue_type, canonical(row.details));
    if (account.status !== "disabled") db.prepare("UPDATE accounts SET status=?,row_version=row_version+1 WHERE id=? AND portfolio_id=?")
      .run(active ? "active" : "reconciliation_required", input.account_id, input.portfolio_id);
    audit(db, actor, "reconcile_account", "reconciliation_run", runId, input.portfolio_id, input.expected_revision,
      { account_id: input.account_id, attachment_id: attachment.id, content_hash: attachment.content_hash, status: result.status, issue_count: issues.length, resolved_issue_ids: resolveIds, account_activated: active, security_transit_lots: actualTransits.length, security_transits_complete: transitCoverage }, now);
    assertWritableDatabase(db);
    return result;
  }).immediate();
}
