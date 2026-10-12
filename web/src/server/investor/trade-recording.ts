import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { amount } from "../ledger/decimal";
import { hash, getActiveLedgerEvents, recordFact, validateLedgerTime, type Actor, type LedgerCommand } from "../ledger/service";
import { assertLedgerCommand } from "../contracts";
import { parseStrictJson } from "../strict-json";
import { getInvestorAccountWorkspace } from "./accounts";
import { reconciliationInstantMicros } from "../ledger/reconciliation-schemas";
import { tradeRecordingContextSchema, tradeRecordingIntentSchema, type TradeRecordingContext, type TradeRecordingIntent } from "./trade-recording-schemas";

function invalid(): never { throw new Error("INVESTOR_TRADE_EVIDENCE_INVALID"); }
function command(row: ReturnType<typeof getActiveLedgerEvents>[number], portfolio: string, account: string, now: string) {
  try {
    const value = parseStrictJson(row.payload_json) as LedgerCommand; assertLedgerCommand(value);
    const stored = row as typeof row & { source_id: string; source_event_id: string | null };
    validateLedgerTime(value, row.recorded_at);
    const { expected_revision: _, idempotency_key: __, ...semantic } = value;
    if (hash(semantic) !== row.payload_hash || row.portfolio_id !== portfolio || row.account_id !== account
      || value.source_id !== stored.source_id || (value.source_event_id ?? null) !== stored.source_event_id
      || value.portfolio_id !== portfolio || value.fact.account_id !== account
      || value.fact.type !== row.event_type || value.effective_at !== row.effective_at || value.time_precision !== row.time_precision
      || value.source_timezone !== row.source_timezone || reconciliationInstantMicros(row.recorded_at) === null
      || reconciliationInstantMicros(row.recorded_at)! > reconciliationInstantMicros(now)!) invalid();
    return value;
  } catch { invalid(); }
}
function verifyPostings(db: Database.Database, event: string, account: string, currency: string, expected: Record<string, string>, onlyTrade = false) {
  const rows = db.prepare(`SELECT account_id,currency,ledger_account,amount FROM postings WHERE event_id=?${onlyTrade
    ? " AND ledger_account IN ('cash_settled','trade_payable','trade_receivable')" : ""} ORDER BY ledger_account`).all(event) as {
    account_id: string; currency: string; ledger_account: string; amount: string;
  }[];
  const nonzero = Object.entries(expected).filter(([, value]) => !amount(value).isZero());
  if (rows.length !== nonzero.length || rows.some(row => row.account_id !== account || row.currency !== currency
    || !(row.ledger_account in expected) || !amount(row.amount).eq(expected[row.ledger_account]))
    || new Set(rows.map(row => row.ledger_account)).size !== rows.length) invalid();
}
export function getTradeRecordingContext(db: Database.Database, actor: Actor, accountId: string, now = new Date().toISOString()): TradeRecordingContext {
  return db.transaction(() => {
    const scope = getInvestorAccountWorkspace(db, actor, now), link = scope.link;
    const book = scope.books.find(row => row.id === link?.document.portfolio_id), account = scope.accounts.find(row => row.id === accountId);
    if (!book || !link || !account) throw new Error("INVESTOR_ACCOUNT_OUT_OF_SCOPE");
    const count = db.prepare("SELECT count(*) n FROM ledger_events WHERE portfolio_id=?").get(book.id) as { n: number };
    if (count.n > 10000) throw new Error("INVESTOR_TRADE_CAPACITY_REQUIRES_REVIEW");
    const listings = db.prepare(`SELECT l.id,l.ticker,l.currency,l.market,i.name FROM listings l JOIN instruments i ON i.id=l.instrument_id
      WHERE EXISTS(SELECT 1 FROM audit_events a WHERE a.portfolio_id=? AND a.actor_id=? AND a.action='register_listing'
        AND a.object_type='workbench_command' AND json_extract(a.payload_json,'$.result.listing_id')=l.id)
      OR EXISTS(SELECT 1 FROM position_movements p JOIN ledger_events e ON e.id=p.event_id WHERE e.portfolio_id=? AND p.listing_id=l.id)
      OR EXISTS(SELECT 1 FROM security_transit_movements p JOIN ledger_events e ON e.id=p.event_id WHERE e.portfolio_id=? AND p.listing_id=l.id)
      ORDER BY l.market,l.ticker,l.id LIMIT 201`).all(book.id, actor.id, book.id, book.id) as TradeRecordingContext["listings"];
    if (listings.length > 200) throw new Error("INVESTOR_TRADE_CAPACITY_REQUIRES_REVIEW");
    const active = getActiveLedgerEvents(db, book.id, book.ledger_revision).filter(row => row.account_id === account.id);
    const entries = active.filter(row => ["buy", "sell", "settlement"].includes(row.event_type)).map(row => ({ row, value: command(row, book.id, account.id, now) }));
    const parents = new Map(entries.filter(item => item.row.event_type !== "settlement").map(item => [item.row.id, item]));
    const settlements = new Map<string, typeof entries>();
    for (const item of entries.filter(item => item.row.event_type === "settlement")) {
      const { row, value } = item;
      const parent = parents.get(value.fact.related_event_id!);
      if (!parent || parent.row.ledger_revision >= row.ledger_revision || parent.row.event_type !== value.fact.direction
        || parent.value.fact.currency !== value.fact.currency || amount(value.fact.amount).isZero()) invalid();
      const payment = amount(value.fact.amount), buying = value.fact.direction === "buy";
      if (buying && payment.lt(0)) invalid();
      verifyPostings(db, row.id, account.id, value.fact.currency, {
        cash_settled: payment.mul(buying ? -1 : 1).toFixed(),
        [buying ? "trade_payable" : "trade_receivable"]: payment.mul(buying ? 1 : -1).toFixed(),
      });
      const children = settlements.get(parent.row.id) ?? []; children.push(item); settlements.set(parent.row.id, children);
    }
    const unsettled: TradeRecordingContext["unsettled_trades"] = [];
    for (const { row, value } of entries.filter(item => item.row.event_type === "buy" || item.row.event_type === "sell")) {
      const kind = row.event_type === "buy" ? "trade_payable" : "trade_receivable";
      const principal = value.fact.consideration === undefined ? amount(value.fact.quantity).mul(amount(value.fact.price)) : amount(value.fact.consideration);
      const fee = amount(value.fact.fee ?? "0"), buying = row.event_type === "buy";
      if (!principal.gt(0) || fee.lt(0)) invalid();
      let remaining = buying ? principal.add(fee) : principal.sub(fee);
      verifyPostings(db, row.id, account.id, value.fact.currency, { [kind]: remaining.mul(buying ? -1 : 1).toFixed() }, true);
      for (const child of settlements.get(row.id) ?? []) {
        if (child.value.fact.direction !== row.event_type || child.value.fact.currency !== value.fact.currency) invalid();
        const payment = amount(child.value.fact.amount);
        if (payment.isPositive() !== remaining.isPositive() || payment.abs().gt(remaining.abs())) invalid();
        remaining = remaining.sub(payment);
      }
      // Negative-net legacy sells need the signed advanced ledger workflow, not this positive-amount form.
      if (remaining.gt(0)) unsettled.push({ event_id: row.id, direction: row.event_type as "buy" | "sell", currency: value.fact.currency,
        effective_at: row.effective_at, source_id: value.source_id, source_event_id: value.source_event_id ?? null });
    }
    if (unsettled.length > 50) throw new Error("INVESTOR_TRADE_CAPACITY_REQUIRES_REVIEW");
    const identity = { schema_version: "investor-trade-recording-v1" as const, workspace_id: scope.workspace_id!, workspace_revision: scope.workspace_revision,
      portfolio_id: book.id, ledger_revision: book.ledger_revision, link_id: link.id, link_version: link.version, account_id: account.id,
      account_row_version: account.row_version, account_status: account.status, listings, unsettled_trades: unsettled,
      basis: "metadata_only_no_fact_prefill" as const, execution_authorized: false as const };
    const evidence = entries.map(({ row }) => ({ id: row.id, payload_hash: row.payload_hash, revision: row.ledger_revision }));
    try { return tradeRecordingContextSchema.parse({ ...identity, checked_at: now, read_only: scope.read_only, context_hash: hash({ identity, evidence }) }); }
    catch { invalid(); }
  }).deferred();
}
export function recordInvestorTradeFact(db: Database.Database, actor: Actor, raw: TradeRecordingIntent & { idempotency_key: string; expected_revision?: number }, now: string) {
  const { idempotency_key, expected_revision: _, ...intent } = raw;
  const input = { ...tradeRecordingIntentSchema.parse(intent), idempotency_key };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(idempotency_key)) throw new Error("INVESTOR_TRADE_INPUT_INVALID");
  assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db);
    const context = getTradeRecordingContext(db, actor, input.account_id, now);
    if (context.portfolio_id !== input.portfolio_id) throw new Error("INVESTOR_ACCOUNT_OUT_OF_SCOPE");
    if (context.link_id !== input.expected_link_id || context.link_version !== input.expected_link_version
      || context.ledger_revision !== input.expected_ledger_revision || context.account_row_version !== input.expected_account_row_version
      || context.context_hash !== input.expected_context_hash) throw new Error("INVESTOR_TRADE_CONTEXT_CONFLICT");
    if (context.account_status === "disabled") throw new Error("INVESTOR_TRADE_ACCOUNT_DISABLED");
    const entry = input.entry;
    if (entry.type === "settlement") {
      if (!context.unsettled_trades.some(row => row.event_id === entry.related_event_id && row.direction === entry.direction && row.currency === entry.currency))
        throw new Error("INVESTOR_TRADE_SETTLEMENT_REVIEW_REQUIRED");
    } else if (!context.listings.some(row => row.id === entry.listing_id && row.currency === entry.currency)
      || entry.type === "sell" && amount(entry.fee).gte(entry.consideration)) throw new Error("INVESTOR_TRADE_INPUT_INVALID");
    try {
      const result = recordFact(db, actor, { portfolio_id: context.portfolio_id, expected_revision: input.expected_ledger_revision,
        idempotency_key: "investor-trade:" + hash({ owner: actor.id, idempotency_key: input.idempotency_key }), source_id: input.source_id, source_event_id: input.source_event_id,
        effective_at: input.effective_date, time_precision: "date", source_timezone: input.source_timezone,
        reason: "Operator transcription, not a broker file: " + input.source_reference, fact: { ...entry, account_id: context.account_id } }, now);
      if (result.warnings.includes("ORIGINAL_SOURCE_SUPERSEDED")) throw new Error("INVESTOR_TRADE_SOURCE_SUPERSEDED");
      return result;
    } catch (error) {
      if (error instanceof Error) {
        if (["SOURCE_DUPLICATE_CONFLICT", "DUPLICATE_CONFLICT"].includes(error.message)) throw new Error("INVESTOR_TRADE_SOURCE_DUPLICATE_CONFLICT");
        if (error.message === "CHRONOLOGY_REVIEW_REQUIRED") throw new Error("INVESTOR_TRADE_CHRONOLOGY_REQUIRES_REVIEW");
        if (error.message === "POSITION_HISTORY_REQUIRED") throw new Error("INVESTOR_TRADE_POSITION_HISTORY_REQUIRED");
        if (["EXCEEDS_OUTSTANDING", "INVALID_RELATED_EVENT", "RELATED_EVENT_NOT_FOUND", "INVALID_SETTLEMENT"].includes(error.message)) throw new Error("INVESTOR_TRADE_SETTLEMENT_REVIEW_REQUIRED");
        if (["FUTURE_FACT_NOT_ALLOWED", "INVALID_EFFECTIVE_TIME", "INVALID_SOURCE_TIMEZONE"].includes(error.message)) throw new Error("INVESTOR_TRADE_INPUT_INVALID");
      }
      throw error;
    }
  }).immediate();
}
