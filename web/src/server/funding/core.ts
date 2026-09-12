import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { audit, canonical, getActiveLedgerEvents, hash, revision, type LedgerCommand } from "../ledger/service";
import { amount, exact } from "../ledger/decimal";
import { availableResources, type Balance, type Position, type Reservation } from "../governance/risk";
import { assertWritableDatabase } from "../workbench-db";
import { fundingPlanSchema, type FundingActor, type FundingEnvelope, type FundingOptions, type FundingPlan } from "./schemas";

export interface Head { current_version_id: string; revision: number }
export interface PlanRow { id: string; version: number; plan_json: string; content_hash: string; created_at: string }
export interface Item { id: string; portfolio_id: string; plan_version_id: string; logical_id: string; kind: "source" | "tranche"; parent_key: string | null; currency: string; planned_amount: string; item_json: string }
export interface Link { id: string; portfolio_id: string; plan_item_id: string; action: "receipt_attach" | "receipt_detach" | "execution_attach" | "execution_detach"; ledger_event_id: string | null; proposal_item_id: string | null; amount: string | null; currency: string; reverses_link_id: string | null; funding_revision: number; ledger_revision: number; actor_id: string; reason: string; created_at: string; logical_id: string }
export interface ReceiptFact { id: string; event_type: "deposit" | "opening_cash"; account_id: string; currency: string; amount: string; effective_at: string; time_precision: "date" | "second"; source_timezone: string; recorded_at: string }
export interface ExecutionItem { id: string; proposal_id: string; account_id: string; listing_id: string; currency: string; quantity: string; limit_price: string; estimated_fees: string; side: string; expires_at: string; created_at: string }
export function requireFundingActor(actor: FundingActor, write = true) {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  if (write && actor.kind !== "human") throw new Error("FUNDING_PERMISSION_DENIED");
}
export function fundingClock(options: FundingOptions) {
  const value = new Date(options.now ?? Date.now());
  if (!Number.isFinite(value.getTime())) throw new Error("INVALID_CLOCK");
  return value.toISOString();
}
export function localDate(instant: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function fundingHead(db: Database.Database, portfolio: string): Head | undefined {
  return db.prepare("SELECT current_version_id,revision FROM funding_plan_heads WHERE portfolio_id=?").get(portfolio) as Head | undefined;
}
export function currentPlan(db: Database.Database, portfolio: string): { row: PlanRow; plan: FundingPlan; items: Item[] } | null {
  const row = db.prepare("SELECT v.* FROM funding_plan_heads h JOIN funding_plan_versions v ON v.id=h.current_version_id AND v.portfolio_id=h.portfolio_id WHERE h.portfolio_id=?").get(portfolio) as PlanRow | undefined;
  if (!row) return null;
  const plan = fundingPlanSchema.parse(JSON.parse(row.plan_json));
  if (hash(plan) !== row.content_hash) throw new Error("FUNDING_PLAN_HASH_MISMATCH");
  const items = db.prepare("SELECT * FROM funding_plan_items WHERE plan_version_id=? ORDER BY kind DESC,logical_id").all(row.id) as Item[];
  const expected = [...plan.sources.map(item => ({ item, kind: "source", parent: null, currency: item.currency })), ...plan.tranches.map(item => ({ item, kind: "tranche", parent: item.source_id, currency: plan.sources.find(source => source.id === item.source_id)?.currency }))];
  if (items.length !== expected.length || expected.some(value => !items.some(row => row.logical_id === value.item.id && row.kind === value.kind && row.parent_key === value.parent && row.currency === value.currency && row.planned_amount === value.item.planned_amount && row.item_json === canonical(value.item)))) throw new Error("FUNDING_PLAN_HASH_MISMATCH");
  return { row, plan, items };
}
export function allLinks(db: Database.Database, portfolio: string): Link[] {
  return db.prepare("SELECT l.*,i.logical_id FROM funding_plan_links l JOIN funding_plan_items i ON i.id=l.plan_item_id WHERE l.portfolio_id=? ORDER BY l.funding_revision,l.id").all(portfolio) as Link[];
}
export function activeLinks(links: Link[]) {
  const reversed = new Set(links.map(link => link.reverses_link_id).filter(Boolean));
  return links.filter(link => link.action.endsWith("_attach") && !reversed.has(link.id));
}
export function receiptFacts(db: Database.Database, portfolio: string): ReceiptFact[] {
  return getActiveLedgerEvents(db, portfolio).filter(event => ["deposit", "opening_cash"].includes(event.event_type)).map(event => {
    const fact = (JSON.parse(event.payload_json) as LedgerCommand).fact;
    return { id: event.id, event_type: event.event_type as ReceiptFact["event_type"], account_id: event.account_id, currency: fact.currency, amount: exact(amount(fact.amount)), effective_at: event.effective_at, time_precision: event.time_precision, source_timezone: event.source_timezone, recorded_at: event.recorded_at };
  });
}
export function executionItems(db: Database.Database, portfolio: string): ExecutionItem[] {
  return db.prepare("SELECT i.*,p.expires_at,p.created_at FROM proposal_items i JOIN proposals p ON p.id=i.proposal_id WHERE p.portfolio_id=? AND p.environment='actual' AND i.side='buy' ORDER BY p.created_at DESC,i.id").all(portfolio) as ExecutionItem[];
}
export function resources(db: Database.Database, portfolio: string) {
  const accounts = db.prepare("SELECT id,name,status,row_version FROM accounts WHERE portfolio_id=? ORDER BY id").all(portfolio) as { id: string; name: string; status: string; row_version: number }[];
  const balances = db.prepare("SELECT p.account_id,p.currency,p.ledger_account,p.balance FROM account_projections p JOIN accounts a ON a.id=p.account_id WHERE a.portfolio_id=? ORDER BY p.account_id,p.currency,p.ledger_account").all(portfolio) as Balance[];
  const positions = db.prepare("SELECT p.account_id,p.listing_id,p.currency,p.quantity,p.cost_known FROM position_projections p JOIN accounts a ON a.id=p.account_id WHERE a.portfolio_id=? ORDER BY p.account_id,p.listing_id").all(portfolio) as Position[];
  const reservations = db.prepare("SELECT * FROM reservations WHERE portfolio_id=? ORDER BY id").all(portfolio) as (Reservation & { status: string })[];
  const issues = db.prepare("SELECT r.account_id,COUNT(*) issue_count FROM reconciliation_issues i JOIN reconciliation_runs r ON r.id=i.run_id WHERE r.portfolio_id=? AND i.status='open' GROUP BY r.account_id ORDER BY r.account_id").all(portfolio) as { account_id: string; issue_count: number }[];
  const active = reservations.filter(row => row.status === "active");
  const { available } = availableResources(balances, positions, active);
  const cash = [...new Set([...balances.map(row => `${row.account_id}:${row.currency}`), ...active.filter(row => row.side === "buy").map(row => `${row.account_id}:${row.currency}`)])].sort().map(key => {
    const split = key.lastIndexOf(":"), accountId = key.slice(0, split), currency = key.slice(split + 1), account = accounts.find(row => row.id === accountId)!;
    const value = (name: string) => balances.find(row => row.account_id === accountId && row.currency === currency && row.ledger_account === name)?.balance ?? "0";
    const reserved = active.filter(row => row.account_id === accountId && row.currency === currency && row.side === "buy").reduce((sum, row) => sum.add(row.amount), amount("0"));
    return { account_id: accountId, account_name: account.name, account_status: account.status, currency, settled: value("cash_settled"), trade_payable: value("trade_payable"), other_liability: value("other_liability"), cash_holds: value("cash_hold"), active_reservations: exact(reserved), available: exact(available.get(key) ?? amount("0")), reconciliation_issue_count: issues.find(row => row.account_id === accountId)?.issue_count ?? 0, eligible_for_advice: false as const };
  });
  return { accounts, balances, positions, reservations, cash, hash: hash({ ledger_revision: revision(db, portfolio), accounts, balances, positions, reservations, issues }) };
}
export function fundingTransaction(db: Database.Database, actor: FundingActor, operation: string, input: FundingEnvelope, options: FundingOptions, effect: (context: { now: string; next: number; current: Head | undefined }) => { plan_version_id: string; [key: string]: unknown }) {
  requireFundingActor(actor); assertWritableDatabase(db);
  const now = fundingClock(options);
  const semantic = { ...input } as Record<string, unknown>;
  for (const key of ["expected_ledger_revision", "expected_funding_revision", "expected_resources_hash", "idempotency_key"]) delete semantic[key];
  const scope = `funding:${operation}:${input.portfolio_id}`, digest = hash(semantic);
  return db.transaction(() => {
    assertWritableDatabase(db);
    const ledgerRevision = revision(db, input.portfolio_id), head = fundingHead(db, input.portfolio_id);
    const previous = db.prepare("SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?").get(scope, input.idempotency_key) as { payload_hash: string; result_json: string } | undefined;
    if (previous) { if (previous.payload_hash !== digest) throw new Error("DUPLICATE_CONFLICT"); assertWritableDatabase(db); return { ...JSON.parse(previous.result_json), duplicate: true }; }
    if (ledgerRevision !== input.expected_ledger_revision || (head?.revision ?? 0) !== input.expected_funding_revision) throw new Error("FUNDING_VERSION_CONFLICT");
    const next = (head?.revision ?? 0) + 1, outcome = effect({ now, next, current: head });
    const result = { ...outcome, funding_revision: next, ledger_revision: ledgerRevision, facts_changed: false, reservations_changed: false };
    if (head) db.prepare("UPDATE funding_plan_heads SET current_version_id=?,revision=?,updated_at=? WHERE portfolio_id=? AND revision=?").run(outcome.plan_version_id, next, now, input.portfolio_id, head.revision);
    else db.prepare("INSERT INTO funding_plan_heads(portfolio_id,current_version_id,revision,updated_at) VALUES(?,?,?,?)").run(input.portfolio_id, outcome.plan_version_id, next, now);
    const auditId = audit(db, actor, operation, "funding_plan", outcome.plan_version_id, input.portfolio_id, ledgerRevision, { input, result }, now);
    const receipt = { ...result, audit_id: auditId };
    db.prepare("INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(scope, input.idempotency_key, digest, canonical(receipt), now);
    assertWritableDatabase(db);
    return receipt;
  }).immediate();
}
export function insertLink(db: Database.Database, actor: FundingActor, input: FundingEnvelope, item: Item, values: { action: Link["action"]; ledger_event_id?: string | null; proposal_item_id?: string | null; amount?: string | null; reverses_link_id?: string | null }, next: number, now: string) {
  const id = randomUUID();
  db.prepare("INSERT INTO funding_plan_links(id,portfolio_id,plan_item_id,action,ledger_event_id,proposal_item_id,amount,currency,reverses_link_id,funding_revision,ledger_revision,actor_id,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, input.portfolio_id, item.id, values.action, values.ledger_event_id ?? null, values.proposal_item_id ?? null, values.amount ?? null, item.currency, values.reverses_link_id ?? null, next, input.expected_ledger_revision, actor.id, input.reason, now);
  return id;
}
