import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { amount, Decimal, exact } from "./decimal";
import { buildEntry, CORPORATE_SUPPORT_TYPES, DIVIDEND_CHILD_TYPES, DIVIDEND_ROOT_TYPES, isCorporateActionMarker, type DividendState, type Entry, type Fact, type FactState, type Position, type TransitPosition } from "./engine";
import { assertLedgerCommand } from "../contracts";
import { assertWritableDatabase } from "../workbench-db";

// Cache compiled SQL only, never query results, bindings or transaction state.
const statements = new WeakMap<Database.Database, Map<string, Database.Statement>>();
function ledgerStatement(db: Database.Database, sql: string): Database.Statement {
  let cached = statements.get(db);
  if (!cached) { cached = new Map(); statements.set(db, cached); }
  let statement = cached.get(sql);
  if (!statement) { statement = db.prepare(sql); cached.set(sql, statement); }
  return statement;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(zone);
  if (!formatter) {
    try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }); }
    catch { throw new Error("INVALID_SOURCE_TIMEZONE"); }
    if (dayFormatters.size >= 64) dayFormatters.delete(dayFormatters.keys().next().value!);
    dayFormatters.set(zone, formatter);
  }
  return formatter;
}

export interface LedgerCommand {
  portfolio_id: string;
  expected_revision: number;
  idempotency_key: string;
  source_id: string;
  source_event_id?: string;
  effective_at: string;
  time_precision: "date" | "second";
  source_timezone: string;
  reason: string;
  fact: Fact;
}
export interface Actor { id: string }
export interface Receipt { event_id: string; revision: number; audit_id: string; warnings: string[]; duplicate?: boolean }
interface StoredEvent { id: string; payload_hash: string; payload_json: string; ledger_revision: number; event_type: string; account_id: string }
export interface LedgerEventRow extends StoredEvent {
  portfolio_id: string; effective_at: string; time_precision: "date" | "second"; source_timezone: string;
  recorded_at: string; reversal_of: string | null; import_batch_id: string | null;
}
/** Trusted application context, never accepted from a client ledger command. */
export interface RecordContext { importBatchId?: string; eventId?: string; correctionId?: string; supersedesEventId?: string }

export function canonical(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("INVALID_JSON_VALUE");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  if (value === undefined || typeof value === "function" || typeof value === "bigint") throw new Error("INVALID_JSON_VALUE");
  return JSON.stringify(value);
}
export const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export function sourceFingerprint(command: LedgerCommand): string {
  const fact = { ...command.fact };
  for (const key of ["amount", "quantity", "price", "consideration", "cost_amount", "fee", "tax", "gross_amount", "received_amount", "split_numerator", "split_denominator", "market_value"] as const) {
    if (fact[key] !== undefined) fact[key] = exact(amount(fact[key]));
  }
  if (["buy", "sell", "fx", "transfer_out"].includes(fact.type)) fact.fee ??= "0";
  if (["dividend", "dividend_accrual"].includes(fact.type)) fact.tax_status ??= fact.tax === undefined ? "unknown" : "confirmed";
  if (fact.supporting_event_ids) fact.supporting_event_ids = [...fact.supporting_event_ids].sort();
  if (fact.value_evidence?.time_precision === "second") fact.value_evidence = { ...fact.value_evidence, effective_at: new Date(fact.value_evidence.effective_at).toISOString() };
  return hash({ portfolio_id: command.portfolio_id, source_id: command.source_id, source_event_id: command.source_event_id, effective_at: command.time_precision === "second" ? new Date(command.effective_at).toISOString() : command.effective_at, time_precision: command.time_precision, source_timezone: command.source_timezone, fact });
}

export function revision(db: Database.Database, portfolioId: string): number {
  const row = ledgerStatement(db, "SELECT revision FROM ledger_heads WHERE portfolio_id=?").get(portfolioId) as { revision: number } | undefined;
  if (!row) throw new Error("PORTFOLIO_NOT_FOUND");
  return row.revision;
}

export function getActiveLedgerEvents(db: Database.Database, portfolioId: string, atRevision = revision(db, portfolioId)): LedgerEventRow[] {
  const current = revision(db, portfolioId);
  if (!Number.isSafeInteger(atRevision) || atRevision < 0 || atRevision > current) throw new Error("INVALID_LEDGER_REVISION");
  const partialCorrection = ledgerStatement(db, "SELECT id FROM audit_events WHERE portfolio_id=? AND action='correct_ledger' AND json_extract(payload_json,'$.start_revision')<? AND json_extract(payload_json,'$.revision')>? LIMIT 1").get(portfolioId, atRevision, atRevision);
  const partialImport = ledgerStatement(db, "SELECT id FROM import_batches WHERE portfolio_id=? AND status='confirmed' AND expected_revision<? AND confirmed_revision>? LIMIT 1").get(portfolioId, atRevision, atRevision);
  if (partialCorrection || partialImport) throw new Error("REVISION_NOT_PUBLISHED");
  return ledgerStatement(db, "SELECT e.* FROM ledger_events e WHERE e.portfolio_id=? AND e.ledger_revision<=? AND e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id AND r.ledger_revision<=?) ORDER BY e.ledger_revision,e.id").all(portfolioId, atRevision, atRevision) as LedgerEventRow[];
}

function requireActor(actor: Actor): void { if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED"); }
function checkAccount(db: Database.Database, account: string, portfolio: string): void {
  if (!ledgerStatement(db, "SELECT id FROM accounts WHERE id=? AND portfolio_id=?").get(account, portfolio)) throw new Error("ACCOUNT_OUT_OF_SCOPE");
}
export function validateLedgerTime(command: LedgerCommand, now: string): void {
  const value = command.effective_at;
  const dateOnly = command.time_precision === "date";
  if (dateOnly ? !/^\d{4}-\d{2}-\d{2}$/.test(value) : !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error("INVALID_EFFECTIVE_TIME");
  const parsed = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error("INVALID_EFFECTIVE_TIME");
  const formatter = dayFormatter(command.source_timezone);
  const clock = new Date(now);
  if (!Number.isFinite(clock.getTime())) throw new Error("INVALID_CLOCK");
  if (dateOnly) {
    const parts = formatter.formatToParts(clock);
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    if (value > `${part("year")}-${part("month")}-${part("day")}`) throw new Error("FUTURE_FACT_NOT_ALLOWED");
  } else if (parsed.getTime() > clock.getTime()) throw new Error("FUTURE_FACT_NOT_ALLOWED");
}
export function audit(db: Database.Database, actor: Actor, action: string, objectType: string, objectId: string, portfolio: string | null, rev: number | null, payload: unknown, now: string): string {
  const id = randomUUID();
  ledgerStatement(db, "INSERT INTO audit_events(id,actor_id,action,object_type,object_id,portfolio_id,ledger_revision,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, actor.id, action, objectType, objectId, portfolio, rev, canonical(payload), now);
  return id;
}

export function createPortfolio(db: Database.Database, actor: Actor, name: string, now = new Date().toISOString()): string {
  requireActor(actor);
  assertWritableDatabase(db);
  if (!name.trim() || name.length > 120) throw new Error("INVALID_PORTFOLIO_NAME");
  return db.transaction(() => {
    assertWritableDatabase(db);
    const id = randomUUID();
    ledgerStatement(db, "INSERT INTO portfolios(id,name,base_currency,created_at) VALUES(?,?,'CNY',?)").run(id, name.trim(), now);
    ledgerStatement(db, "INSERT INTO ledger_heads(portfolio_id,revision,updated_at) VALUES(?,0,?)").run(id, now);
    audit(db, actor, "create_portfolio", "portfolio", id, id, 0, { name }, now);
    assertWritableDatabase(db);
    return id;
  }).immediate();
}

export function createAccount(db: Database.Database, actor: Actor, portfolioId: string, name: string, broker: string, currency: string, now = new Date().toISOString()): string {
  requireActor(actor);
  assertWritableDatabase(db);
  if (!name.trim() || name.length > 120 || !broker.trim() || broker.length > 120 || !/^[A-Z]{3}$/.test(currency)) throw new Error("INVALID_ACCOUNT");
  return db.transaction(() => {
    assertWritableDatabase(db);
    const rev = revision(db, portfolioId), id = randomUUID();
    ledgerStatement(db, "INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,status,created_at) VALUES(?,?,?,?,?,'reconciliation_required',?)").run(id, portfolioId, name.trim(), broker.trim(), currency, now);
    audit(db, actor, "create_account", "account", id, portfolioId, rev, { name, broker, currency }, now);
    assertWritableDatabase(db);
    return id;
  }).immediate();
}

function activeEvent(db: Database.Database, portfolioId: string, eventId: string): LedgerEventRow {
  const event = ledgerStatement(db, "SELECT e.* FROM ledger_events e WHERE e.id=? AND e.portfolio_id=? AND e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id)").get(eventId, portfolioId) as LedgerEventRow | undefined;
  if (!event) throw new Error("RELATED_EVENT_NOT_FOUND");
  return event;
}

export function dividendStateFor(db: Database.Database, portfolioId: string, rootEventId: string): DividendState {
  const root = activeEvent(db, portfolioId, rootEventId), original = (JSON.parse(root.payload_json) as LedgerCommand).fact;
  if (!(DIVIDEND_ROOT_TYPES as readonly string[]).includes(root.event_type)) throw new Error("INVALID_RELATED_EVENT");
  const children = ledgerStatement(db, "SELECT e.* FROM ledger_events e WHERE e.portfolio_id=? AND json_extract(e.payload_json,'$.fact.related_event_id')=? AND e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id) ORDER BY e.ledger_revision,e.id").all(portfolioId, rootEventId) as LedgerEventRow[];
  const state: DividendState = {
    root_event_id: root.id, type: original.type, account_id: root.account_id, currency: original.currency, listing_id: original.listing_id,
    gross_amount: original.type === "dividend_net" ? null : exact(amount(original.amount)),
    tax: exact(amount(original.tax ?? "0")), tax_status: original.tax_status ?? (original.tax === undefined ? "unknown" : "confirmed"),
    net_cash: "0", receivable: "0", tax_payable: "0", assessment_confirmed: false,
    ...(original.type === "dividend_net" ? { net_amount: exact(amount(original.amount)), net_status: original.net_status } : {}),
  };
  for (const child of children) {
    const fact = (JSON.parse(child.payload_json) as LedgerCommand).fact;
    if (!(DIVIDEND_CHILD_TYPES as readonly string[]).includes(child.event_type) || child.account_id !== root.account_id || fact.currency !== original.currency) throw new Error("INVALID_DIVIDEND_HISTORY");
    if (fact.type === "dividend_breakdown") {
      if (original.type !== "dividend_net" || state.breakdown_event_id) throw new Error("INVALID_DIVIDEND_HISTORY");
      state.gross_amount = exact(amount(fact.gross_amount)); state.tax = exact(amount(fact.tax)); state.tax_status = "confirmed"; state.breakdown_event_id = child.id;
      if (!amount(state.gross_amount).sub(state.tax).eq(state.net_amount!)) throw new Error("INVALID_DIVIDEND_HISTORY");
    } else if (fact.type === "dividend_tax_assessment") {
      if (state.gross_amount === null || !["estimated", "confirmed"].includes(fact.tax_status ?? "")) throw new Error("INVALID_DIVIDEND_HISTORY");
      state.tax = exact(amount(fact.tax)); state.tax_status = fact.tax_status!; state.tax_assessment_event_id = child.id; state.assessment_confirmed = fact.tax_status === "confirmed";
    }
  }
  const balances = new Map<string, Decimal>();
  const postings = ledgerStatement(db, "SELECT p.account_id,p.currency,p.ledger_account,p.amount FROM postings p JOIN ledger_events e ON e.id=p.event_id WHERE e.portfolio_id=? AND (e.id=? OR json_extract(e.payload_json,'$.fact.related_event_id')=?) AND e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id)").all(portfolioId, rootEventId, rootEventId) as { account_id: string; currency: string; ledger_account: string; amount: string }[];
  for (const posting of postings) {
    if (posting.account_id !== root.account_id || posting.currency !== original.currency) throw new Error("INVALID_DIVIDEND_HISTORY");
    balances.set(posting.ledger_account, (balances.get(posting.ledger_account) ?? amount("0")).add(posting.amount));
  }
  state.net_cash = exact(balances.get("cash_settled") ?? amount("0"));
  state.receivable = exact(balances.get("dividend_receivable") ?? amount("0"));
  state.tax_payable = exact(balances.get("dividend_tax_payable") ?? amount("0"));
  if (!(balances.get("expense") ?? amount("0")).eq(state.tax) || amount(state.tax).lt(0) || amount(state.receivable).lt(0) || amount(state.tax_payable).gt(0)) throw new Error("INVALID_DIVIDEND_HISTORY");
  if (state.gross_amount !== null) {
    const remaining = amount(state.gross_amount).sub(state.tax).sub(state.net_cash);
    if (amount(state.gross_amount).lte(0) || amount(state.tax).gt(state.gross_amount) || !Decimal.max(remaining, 0).eq(state.receivable) || !Decimal.min(remaining, 0).eq(state.tax_payable)) throw new Error("INVALID_DIVIDEND_HISTORY");
  }
  return state;
}

function supportListing(db: Database.Database, portfolioId: string, event: LedgerEventRow, visited = new Set<string>()): string | undefined {
  if (visited.has(event.id) || visited.size > 100) throw new Error("INVALID_CORPORATE_ACTION_SUPPORT");
  visited.add(event.id);
  const fact = (JSON.parse(event.payload_json) as LedgerCommand).fact;
  if (fact.listing_id) return fact.listing_id;
  return fact.related_event_id ? supportListing(db, portfolioId, activeEvent(db, portfolioId, fact.related_event_id), visited) : undefined;
}

function assertResolutionTime(command: LedgerCommand, dependency: LedgerEventRow): void {
  if (command.time_precision !== dependency.time_precision || (command.time_precision === "date" && command.source_timezone !== dependency.source_timezone)) throw new Error("CORPORATE_ACTION_TIME_AMBIGUOUS");
  if (Date.parse(command.effective_at) < Date.parse(dependency.effective_at)) throw new Error("CORPORATE_ACTION_RESOLUTION_TOO_EARLY");
}

function stateFor(db: Database.Database, command: LedgerCommand, context: RecordContext): FactState {
  const fact = command.fact;
  const state: FactState = {};
  if (fact.listing_id) {
    const listing = ledgerStatement(db, "SELECT currency FROM listings WHERE id=?").get(fact.listing_id) as { currency: string } | undefined;
    if (!listing || listing.currency !== fact.currency) throw new Error("INVALID_LISTING_CURRENCY");
    const pos = ledgerStatement(db, "SELECT quantity,cost_amount,cost_known,currency FROM position_projections WHERE account_id=? AND listing_id=?").get(fact.account_id, fact.listing_id) as (Omit<Position, "cost_known"> & { cost_known: number }) | undefined;
    if (pos) state.position = { ...pos, cost_known: Boolean(pos.cost_known) };
    if (fact.type === "split") state.transit_positions = (ledgerStatement(db, "SELECT * FROM security_transit_projections WHERE source_account_id=? AND listing_id=?").all(fact.account_id, fact.listing_id) as (Omit<TransitPosition, "cost_known"> & { cost_known: number })[])
      .filter(row => amount(row.quantity).gt(0)).map(row => ({ ...row, cost_known: Boolean(row.cost_known) }));
  }
  if (fact.related_event_id) {
    const source = activeEvent(db, command.portfolio_id, fact.related_event_id);
    const original = (JSON.parse(source.payload_json) as LedgerCommand).fact;
    if ((DIVIDEND_CHILD_TYPES as readonly string[]).includes(fact.type)) {
      state.dividend = dividendStateFor(db, command.portfolio_id, source.id);
      return state;
    }
    if (fact.type === "corporate_action_resolution") {
      if (original.type !== "corporate_action_notice" || source.account_id !== fact.account_id || original.currency !== fact.currency) throw new Error("INVALID_CORPORATE_ACTION_RESOLUTION");
      if (fact.listing_id && fact.listing_id !== original.listing_id) throw new Error("INVALID_CORPORATE_ACTION_SUPPORT");
      assertResolutionTime(command, source);
      const supportIds = fact.supporting_event_ids;
      if (!Array.isArray(supportIds) || new Set(supportIds).size !== supportIds.length) throw new Error("INVALID_CORPORATE_ACTION_SUPPORT");
      let matchingListing = !original.listing_id;
      for (const eventId of supportIds) {
        const support = activeEvent(db, command.portfolio_id, eventId), supported = (JSON.parse(support.payload_json) as LedgerCommand).fact;
        if (!(CORPORATE_SUPPORT_TYPES as readonly string[]).includes(support.event_type) || support.account_id !== fact.account_id || supported.currency !== fact.currency) throw new Error("INVALID_CORPORATE_ACTION_SUPPORT");
        assertResolutionTime(command, support);
        if (supportListing(db, command.portfolio_id, support) === original.listing_id) matchingListing = true;
      }
      if (fact.resolution === "recorded" && !matchingListing) throw new Error("CORPORATE_ACTION_LISTING_SUPPORT_REQUIRED");
      state.notice = { account_id: source.account_id, currency: original.currency, resolved: !!ledgerStatement(db, "SELECT 1 FROM ledger_events e WHERE e.portfolio_id=? AND e.event_type='corporate_action_resolution' AND json_extract(e.payload_json,'$.fact.related_event_id')=? AND e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id)").get(command.portfolio_id, source.id) };
      return state;
    }
    if (["security_transfer_in", "security_transfer_return"].includes(fact.type)) {
      if (original.type !== "security_transfer_out") throw new Error("INVALID_SECURITY_TRANSFER");
      const lot = ledgerStatement(db, "SELECT * FROM security_transit_projections WHERE transfer_event_id=?").get(source.id) as (Omit<TransitPosition, "cost_known"> & { cost_known: number }) | undefined;
      if (!lot) throw new Error("INVALID_SECURITY_TRANSFER");
      state.transfer = { ...lot, cost_known: Boolean(lot.cost_known) };
      return state;
    }
    const ledgerAccount = original.type === "buy" ? "trade_payable" : original.type === "sell" ? "trade_receivable" : "transfer_in_transit";
    const rows = ledgerStatement(db, "SELECT amount FROM postings WHERE event_id=? AND ledger_account=?").all(source.id, ledgerAccount) as { amount: string }[];
    let outstanding = rows.reduce((s, r) => s.add(amount(r.amount)), new Decimal(0));
    if (original.type === "buy") outstanding = outstanding.neg();
    const children = ledgerStatement(db, "SELECT e.payload_json FROM ledger_events e WHERE e.portfolio_id=? AND json_extract(e.payload_json,'$.fact.related_event_id')=? AND e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id)").all(command.portfolio_id, source.id) as { payload_json: string }[];
    for (const child of children) {
      const next = (JSON.parse(child.payload_json) as LedgerCommand).fact;
      if ((original.type === "buy" || original.type === "sell") ? next.type === "settlement" : original.type === "transfer_out" && next.type === "transfer_in") outstanding = outstanding.sub(amount(next.amount));
    }
    state.related = { type: original.type, account_id: source.account_id, currency: original.currency, target_account_id: original.target_account_id, outstanding: exact(outstanding) };
  }
  if (fact.type === "dividend" && fact.tax === undefined && context.correctionId && context.supersedesEventId) {
    const prior = ledgerStatement(db, "SELECT payload_json FROM ledger_events WHERE id=? AND portfolio_id=? AND account_id=? AND event_type='dividend'").get(context.supersedesEventId, command.portfolio_id, fact.account_id) as { payload_json: string } | undefined;
    if (prior && (JSON.parse(prior.payload_json) as LedgerCommand).fact.tax === undefined) state.legacy_direct_dividend = true;
  }
  return state;
}

function applyProjection(db: Database.Database, entry: Entry, rev: number): void {
  for (const p of entry.postings) {
    const old = ledgerStatement(db, "SELECT balance FROM account_projections WHERE account_id=? AND currency=? AND ledger_account=?").get(p.account_id, p.currency, p.ledger_account) as { balance: string } | undefined;
    const balance = exact(amount(old?.balance ?? "0").add(amount(p.amount)));
    ledgerStatement(db, "INSERT INTO account_projections(account_id,currency,ledger_account,balance,ledger_revision) VALUES(?,?,?,?,?) ON CONFLICT(account_id,currency,ledger_account) DO UPDATE SET balance=excluded.balance,ledger_revision=excluded.ledger_revision").run(p.account_id, p.currency, p.ledger_account, balance, rev);
  }
  for (const m of entry.movements) {
    const old = ledgerStatement(db, "SELECT quantity,cost_amount,cost_known FROM position_projections WHERE account_id=? AND listing_id=?").get(m.account_id, m.listing_id) as { quantity: string; cost_amount: string; cost_known: number } | undefined;
    const quantity = exact(amount(old?.quantity ?? "0").add(amount(m.quantity)));
    const cost = exact(amount(old?.cost_amount ?? "0").add(amount(m.cost_amount)));
    const known = Number(m.cost_known && (old?.cost_known !== 0 || amount(old?.quantity ?? "0").isZero()));
    ledgerStatement(db, "INSERT INTO position_projections(account_id,listing_id,quantity,cost_amount,cost_known,currency,ledger_revision) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,listing_id) DO UPDATE SET quantity=excluded.quantity,cost_amount=excluded.cost_amount,cost_known=excluded.cost_known,currency=excluded.currency,ledger_revision=excluded.ledger_revision").run(m.account_id, m.listing_id, quantity, cost, known, m.currency, rev);
  }
  for (const m of entry.transits ?? []) {
    if (!m.transfer_event_id) throw new Error("INVALID_SECURITY_TRANSFER");
    const old = ledgerStatement(db, "SELECT * FROM security_transit_projections WHERE transfer_event_id=?").get(m.transfer_event_id) as (Omit<TransitPosition, "cost_known"> & { cost_known: number }) | undefined;
    if (old && (old.source_account_id !== m.source_account_id || old.target_account_id !== m.target_account_id || old.listing_id !== m.listing_id || old.currency !== m.currency)) throw new Error("INVALID_SECURITY_TRANSFER");
    const quantity = amount(old?.quantity ?? "0").add(m.quantity), cost = amount(old?.cost_amount ?? "0").add(m.cost_amount);
    if (quantity.lt(0) || cost.lt(0) || (quantity.isZero() && !cost.isZero())) throw new Error("INVALID_SECURITY_TRANSIT_BALANCE");
    const known = Number(m.cost_known && (old?.cost_known !== 0 || amount(old?.quantity ?? "0").isZero()));
    ledgerStatement(db, "INSERT INTO security_transit_projections(transfer_event_id,source_account_id,target_account_id,listing_id,currency,quantity,cost_amount,cost_known,ledger_revision) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(transfer_event_id) DO UPDATE SET quantity=excluded.quantity,cost_amount=excluded.cost_amount,cost_known=excluded.cost_known,ledger_revision=excluded.ledger_revision")
      .run(m.transfer_event_id, m.source_account_id, m.target_account_id, m.listing_id, m.currency, exact(quantity), exact(cost), known, rev);
  }
}

export function invalidateAccounts(db: Database.Database, accountIds: Iterable<string>): void {
  const update = ledgerStatement(db, "UPDATE accounts SET status='reconciliation_required',row_version=row_version+1 WHERE id=? AND status<>'disabled'");
  for (const accountId of new Set(accountIds)) update.run(accountId);
}

function duplicateReceipt(db: Database.Database, receipt: Receipt): Receipt {
  const superseded = ledgerStatement(db, "SELECT id FROM ledger_events WHERE reversal_of=?").get(receipt.event_id);
  return { ...receipt, duplicate: true, warnings: [...new Set([...receipt.warnings, ...(superseded ? ["ORIGINAL_SOURCE_SUPERSEDED"] : [])])] };
}

/** Read-only lookup: callers must hold their write transaction through any subsequent binding. */
export function resolveSourceReceipt(db: Database.Database, command: LedgerCommand): Receipt | undefined {
  if (!command.source_event_id) return;
  // Confirmed CSV links bind the broker occurrence even when its fact originated elsewhere.
  const alias = ledgerStatement(db, `SELECT r.normalized_json,o.result_json FROM import_rows r
    JOIN csv_import_outcomes o ON o.batch_id=r.batch_id AND o.row_number=r.row_number
    JOIN import_batches b ON b.id=r.batch_id
    WHERE json_extract(r.normalized_json,'$.fact.account_id')=? AND json_extract(r.normalized_json,'$.source_id')=?
      AND r.source_event_id=? AND json_extract(r.normalized_json,'$.fact.type')=?
      AND b.portfolio_id=? AND b.account_id=? AND b.status='confirmed' AND b.parser_version='csv-v1'
    ORDER BY b.created_at,b.id,r.row_number LIMIT 1`).get(command.fact.account_id, command.source_id, command.source_event_id, command.fact.type, command.portfolio_id, command.fact.account_id) as { normalized_json: string; result_json: string } | undefined;
  if (alias) {
    if (sourceFingerprint(JSON.parse(alias.normalized_json)) !== sourceFingerprint(command)) throw new Error("SOURCE_DUPLICATE_CONFLICT");
    return duplicateReceipt(db, (JSON.parse(alias.result_json) as { receipt: Receipt }).receipt);
  }
  const source = ledgerStatement(db, "SELECT id,payload_hash,payload_json,ledger_revision FROM ledger_events WHERE account_id=? AND source_id=? AND source_event_id=? AND event_type=?").get(command.fact.account_id, command.source_id, command.source_event_id, command.fact.type) as StoredEvent | undefined;
  if (!source) return;
  if (sourceFingerprint(JSON.parse(source.payload_json)) !== sourceFingerprint(command)) throw new Error("SOURCE_DUPLICATE_CONFLICT");
  const auditRow = ledgerStatement(db, "SELECT id,payload_json FROM audit_events WHERE object_id=? AND action='record_fact'").get(source.id) as { id: string; payload_json: string };
  return duplicateReceipt(db, { event_id: source.id, revision: source.ledger_revision, audit_id: auditRow.id,
    warnings: (JSON.parse(auditRow.payload_json).warnings ?? []) as string[] });
}

export function recordFact(db: Database.Database, actor: Actor, command: LedgerCommand, now = new Date().toISOString(), context: RecordContext = {}): Receipt {
  requireActor(actor);
  assertWritableDatabase(db);
  assertLedgerCommand(command);
  if (!Number.isSafeInteger(command.expected_revision) || command.expected_revision < 0 || !command.idempotency_key?.trim() || !command.source_id?.trim() || !command.reason?.trim()) throw new Error("INVALID_COMMAND");
  validateLedgerTime(command, now);
  if (command.time_precision === "second") command = { ...command, effective_at: new Date(command.effective_at).toISOString() };
  if (["security_in", "security_out"].includes(command.fact.type)) {
    const evidence = command.fact.value_evidence!;
    if (!evidence.reference.trim()) throw new Error("INVALID_SECURITY_VALUE_EVIDENCE");
    validateLedgerTime({ ...command, ...evidence }, now);
    const time = evidence.time_precision === "second" ? new Date(evidence.effective_at).toISOString() : evidence.effective_at;
    if (evidence.time_precision !== command.time_precision || evidence.source_timezone !== command.source_timezone || time !== command.effective_at) throw new Error("SECURITY_VALUE_TIME_MISMATCH");
    command = { ...command, fact: { ...command.fact, value_evidence: { ...evidence, effective_at: time } } };
  }
  const { expected_revision: _revision, idempotency_key: _key, ...semantic } = command;
  void _revision; void _key;
  const digest = hash(semantic);
  return db.transaction(() => {
    assertWritableDatabase(db);
    checkAccount(db, command.fact.account_id, command.portfolio_id);
    if (command.fact.target_account_id) checkAccount(db, command.fact.target_account_id, command.portfolio_id);
    if (context.importBatchId && !ledgerStatement(db, "SELECT id FROM import_batches WHERE id=? AND portfolio_id=? AND account_id=? AND attachment_id IS NOT NULL AND status IN ('preview','confirmed')").get(context.importBatchId, command.portfolio_id, command.fact.account_id)) throw new Error("IMPORT_BATCH_OUT_OF_SCOPE");
    if (context.eventId && (!context.correctionId || !/^[a-f0-9-]{36}$/.test(context.eventId))) throw new Error("INVALID_RECORD_CONTEXT");
    const scope = `ledger:${command.portfolio_id}`;
    const duplicate = ledgerStatement(db, "SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?").get(scope, command.idempotency_key) as { payload_hash: string; result_json: string } | undefined;
    if (duplicate) {
      if (duplicate.payload_hash !== digest) throw new Error("DUPLICATE_CONFLICT");
      assertWritableDatabase(db);
      return duplicateReceipt(db, JSON.parse(duplicate.result_json) as Receipt);
    }
    const sourceReceipt = resolveSourceReceipt(db, command);
    if (sourceReceipt) {
      ledgerStatement(db, "INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(scope, command.idempotency_key, digest, canonical(sourceReceipt), now);
      assertWritableDatabase(db);
      return sourceReceipt;
    }
    const previous = revision(db, command.portfolio_id);
    if (previous !== command.expected_revision) throw new Error("VERSION_CONFLICT");
    if (command.fact.type.startsWith("opening_")) {
      const openings = ledgerStatement(db, "SELECT e.event_type,e.payload_json,e.effective_at FROM ledger_events e WHERE e.account_id=? AND e.event_type IN ('opening_cash','opening_position') AND e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id)").all(command.fact.account_id) as { event_type: string; payload_json: string; effective_at: string }[];
      for (const opening of openings) {
        const fact = (JSON.parse(opening.payload_json) as LedgerCommand).fact;
        if (fact.type === command.fact.type && fact.currency === command.fact.currency && fact.listing_id === command.fact.listing_id) throw new Error("OPENING_ALREADY_RECORDED");
        if (opening.effective_at !== command.effective_at) throw new Error("OPENING_DATE_MISMATCH");
      }
      if (ledgerStatement(db, "SELECT e.id FROM ledger_events e WHERE e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id) AND e.event_type NOT IN ('opening_cash','opening_position','corporate_action_notice','corporate_action_resolution') AND (e.account_id=? OR EXISTS(SELECT 1 FROM postings p WHERE p.event_id=e.id AND p.account_id=?) OR EXISTS(SELECT 1 FROM position_movements m WHERE m.event_id=e.id AND m.account_id=?)) LIMIT 1").get(command.fact.account_id, command.fact.account_id, command.fact.account_id)) throw new Error("OPENING_PERIOD_CLOSED");
    }
    const latest = ledgerStatement(db, "SELECT e.effective_at FROM ledger_events e WHERE e.portfolio_id=? AND e.event_type NOT IN ('corporate_action_notice','corporate_action_resolution') AND e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id) ORDER BY julianday(e.effective_at) DESC,e.ledger_revision DESC LIMIT 1").get(command.portfolio_id) as { effective_at: string } | undefined;
    if (!isCorporateActionMarker(command.fact.type) && latest && Date.parse(command.effective_at) < Date.parse(latest.effective_at)) throw new Error("CHRONOLOGY_REVIEW_REQUIRED");
    const entry = buildEntry(command.fact, stateFor(db, command, context)), rev = previous + 1, id = context.eventId ?? randomUUID();
    for (const movement of entry.transits ?? []) movement.transfer_event_id ??= id;
    ledgerStatement(db, "INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,time_precision,source_timezone,recorded_at,source_id,source_event_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id,reason,import_batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, command.portfolio_id, command.fact.account_id, command.fact.type, command.effective_at, command.time_precision, command.source_timezone, now, command.source_id, command.source_event_id ?? null, command.idempotency_key, digest, canonical(command), rev, actor.id, command.reason, context.importBatchId ?? null);
    const posting = ledgerStatement(db, "INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES(?,?,?,?,?,?)");
    for (const p of entry.postings) posting.run(randomUUID(), id, p.account_id, p.currency, p.ledger_account, p.amount);
    const movement = ledgerStatement(db, "INSERT INTO position_movements(id,event_id,account_id,listing_id,quantity,cost_amount,cost_known,currency) VALUES(?,?,?,?,?,?,?,?)");
    for (const m of entry.movements) movement.run(randomUUID(), id, m.account_id, m.listing_id, m.quantity, m.cost_amount, Number(m.cost_known), m.currency);
    const transit = ledgerStatement(db, "INSERT INTO security_transit_movements(id,event_id,transfer_event_id,source_account_id,target_account_id,listing_id,currency,quantity,cost_amount,cost_known) VALUES(?,?,?,?,?,?,?,?,?,?)");
    for (const m of entry.transits ?? []) transit.run(randomUUID(), id, m.transfer_event_id, m.source_account_id, m.target_account_id, m.listing_id, m.currency, m.quantity, m.cost_amount, Number(m.cost_known));
    applyProjection(db, entry, rev);
    ledgerStatement(db, "UPDATE ledger_heads SET revision=?,updated_at=? WHERE portfolio_id=? AND revision=?").run(rev, now, command.portfolio_id, previous);
    invalidateAccounts(db, [command.fact.account_id, ...entry.postings.map(p => p.account_id), ...entry.movements.map(m => m.account_id), ...(entry.transits ?? []).flatMap(m => [m.source_account_id, m.target_account_id])]);
    const auditId = audit(db, actor, "record_fact", "ledger_event", id, command.portfolio_id, rev, { digest, warnings: entry.warnings, import_batch_id: context.importBatchId, correction_id: context.correctionId, supersedes_event_id: context.supersedesEventId }, now);
    const receipt: Receipt = { event_id: id, revision: rev, audit_id: auditId, warnings: entry.warnings };
    ledgerStatement(db, "INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(scope, command.idempotency_key, digest, canonical(receipt), now);
    assertWritableDatabase(db);
    return receipt;
  }).immediate();
}

export function rebuildProjections(db: Database.Database, actor: Actor, portfolioId: string, now = new Date().toISOString()): void {
  requireActor(actor);
  assertWritableDatabase(db);
  db.transaction(() => {
    assertWritableDatabase(db);
    const rev = revision(db, portfolioId);
    ledgerStatement(db, "DELETE FROM account_projections WHERE account_id IN (SELECT id FROM accounts WHERE portfolio_id=?)").run(portfolioId);
    ledgerStatement(db, "DELETE FROM position_projections WHERE account_id IN (SELECT id FROM accounts WHERE portfolio_id=?)").run(portfolioId);
    ledgerStatement(db, "DELETE FROM security_transit_projections WHERE source_account_id IN (SELECT id FROM accounts WHERE portfolio_id=?)").run(portfolioId);
    const events = getActiveLedgerEvents(db, portfolioId);
    for (const event of events) {
      const postings = ledgerStatement(db, "SELECT account_id,currency,ledger_account,amount FROM postings WHERE event_id=? ORDER BY id").all(event.id) as Entry["postings"];
      const rows = ledgerStatement(db, "SELECT account_id,listing_id,currency,quantity,cost_amount,cost_known FROM position_movements WHERE event_id=? ORDER BY id").all(event.id) as (Omit<Entry["movements"][number], "cost_known"> & { cost_known: number })[];
      const transits = ledgerStatement(db, "SELECT transfer_event_id,source_account_id,target_account_id,listing_id,currency,quantity,cost_amount,cost_known FROM security_transit_movements WHERE event_id=? ORDER BY id").all(event.id) as (Omit<TransitPosition, "cost_known"> & { cost_known: number })[];
      applyProjection(db, { postings, movements: rows.map(m => ({ ...m, cost_known: Boolean(m.cost_known) })), transits: transits.map(m => ({ ...m, cost_known: Boolean(m.cost_known) })), warnings: [] }, event.ledger_revision);
    }
    audit(db, actor, "rebuild_projections", "portfolio", portfolioId, portfolioId, rev, {}, now);
    assertWritableDatabase(db);
  }).immediate();
}
