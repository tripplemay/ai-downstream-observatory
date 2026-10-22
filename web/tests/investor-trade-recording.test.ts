import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { getTradeRecordingContext } from "../src/server/investor/trade-recording";
import { tradeRecordingIntentSchema, type TradeRecordingIntent } from "../src/server/investor/trade-recording-schemas";
import { getInvestorReconciliationContext } from "../src/server/investor/reconciliation";
import { createAccount, createPortfolio, recordFact, revision } from "../src/server/ledger/service";
import { registerListing } from "../src/server/workbench-commands";
import { correctLedger } from "../src/server/ledger/corrections";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { investorHoldingsFixture, holdingsNow as now } from "./investor-holdings-fixture";

type Fixture = ReturnType<typeof investorHoldingsFixture>;
const financial = ["ledger_events", "postings", "position_movements", "account_projections", "position_projections", "ledger_heads", "accounts",
  "security_transit_movements", "security_transit_projections"];
const untouched = ["approval_events", "activations", "reservations", "execution_reports", "investor_ai_requests", "outbox", "job_runs"];
function rows(f: Fixture, tables = financial) { return tables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }
function context(f: Fixture, account = f.account) { return getTradeRecordingContext(f.db, f.actor, account, now); }
function intent(f: Fixture, entry?: TradeRecordingIntent["entry"], sourceEvent = "manual-1"): TradeRecordingIntent {
  const ctx = context(f);
  return tradeRecordingIntentSchema.parse({ action: "record_linked_trade_fact", portfolio_id: f.portfolio, account_id: f.account,
    expected_ledger_revision: ctx.ledger_revision, expected_account_row_version: ctx.account_row_version,
    expected_link_id: ctx.link_id, expected_link_version: ctx.link_version, expected_context_hash: ctx.context_hash,
    basis: "operator_transcription_not_broker_file", acknowledgement: true, source_id: "FICTIONAL-MANUAL-SOURCE", source_event_id: sourceEvent,
    source_reference: "Fictional independent transcription, no real funds", effective_date: "2026-01-02", source_timezone: "Asia/Shanghai",
    entry: entry ?? { type: "buy", listing_id: f.alpha!, currency: "CNY", quantity: "2", consideration: "21", fee: "0.1" } });
}
function submit(f: Fixture, input = intent(f), key = "manual-command-1", expected?: number) {
  return executeInvestorCommand(f.db, f.actor, { ...input, idempotency_key: key,
    expected_revision: expected ?? getInvestorState(f.db, f.actor, now).revision }, now, f.readOptions);
}
function balance(f: Fixture, ledger: string) {
  return (f.db.prepare("SELECT balance FROM account_projections WHERE account_id=? AND currency='CNY' AND ledger_account=?").get(f.account, ledger) as { balance: string } | undefined)?.balance ?? "0";
}
function position(f: Fixture) { return f.db.prepare("SELECT quantity,cost_amount FROM position_projections WHERE account_id=? AND listing_id=?").get(f.account, f.alpha) as { quantity: string; cost_amount: string }; }

test("a valid local date ahead of UTC remains readable without inventing an intraday timestamp", () => {
  const at = "2026-01-01T20:00:20.000Z", f = investorHoldingsFixture({ securities: true, now: at }); try {
    const event = recordFact(f.db, f.actor, { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio),
      idempotency_key: "fictional-local-date", source_id: "FICTIONAL", source_event_id: "local-date", effective_at: "2026-01-02", time_precision: "date",
      source_timezone: "Asia/Shanghai", reason: "Fictional date precision only, not real trade evidence",
      fact: { type: "buy", account_id: f.account, listing_id: f.alpha!, currency: "CNY", quantity: "1", consideration: "10", fee: "0" } }, at);
    const current = getTradeRecordingContext(f.db, f.actor, f.account, at), saved = current.unsettled_trades.find(row => row.event_id === event.event_id);
    assert.equal(saved?.effective_at, "2026-01-02"); assert.equal(saved?.source_timezone, "Asia/Shanghai");
  } finally { f.close(); }
});

test("manual context is owned, zero-write metadata; it never prefills money, quantity, fees or a trade", () => {
  const f = investorHoldingsFixture({ securities: true, twoAccounts: true }); try {
    const foreign = createPortfolio(f.db, { id: "fictional-foreign" }, "Fictional foreign", now);
    const account = createAccount(f.db, { id: "fictional-foreign" }, foreign, "Fictional foreign", "Fictional", "USD", now);
    const before = f.db.prepare("SELECT total_changes() n").get(), result = context(f);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    assert.equal(result.listings.length, 2); assert.equal(result.unsettled_trades.length, 1);
    assert.equal(result.execution_authorized, false); assert.equal(result.basis, "metadata_only_no_fact_prefill");
    assert.doesNotMatch(JSON.stringify(result), /"(?:amount|quantity|fee|price|balance|consideration)"/);
    assert.ok(!JSON.stringify(result).includes(account));
    for (const id of [account, "missing"]) assert.throws(() => context(f, id), /OUT_OF_SCOPE/);
    assert.throws(() => getTradeRecordingContext(f.db, { id: "fictional-foreign" }, f.account, now), /OUT_OF_SCOPE/);
  } finally { f.close(); }
});

test("executed buy records exact principal and explicit fee, invalidates reconciliation, but never settles or approves a trade", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    f.reconcile();
    const before = rows(f, untouched), ctx = context(f), input = intent(f), receipt = submit(f, input);
    assert.deepEqual(position(f), { quantity: "8", cost_amount: "81" });
    assert.equal(balance(f, "cash_settled"), "100"); assert.equal(balance(f, "trade_payable"), "-31.1"); assert.equal(balance(f, "expense"), "0.1");
    const updated = context(f); assert.equal(updated.ledger_revision, ctx.ledger_revision + 1);
    assert.equal(updated.workspace_revision, ctx.workspace_revision + 1); assert.equal(updated.account_row_version, ctx.account_row_version + 1);
    assert.equal(updated.account_status, "reconciliation_required");
    assert.equal(getInvestorReconciliationContext(f.db, f.actor, f.account, now, f.readOptions).latest?.current_facts, false);
    assert.deepEqual(rows(f, untouched), before);
    const audit = JSON.parse((f.db.prepare("SELECT payload_json FROM audit_events WHERE id=?").get(receipt.audit_id) as { payload_json: string }).payload_json);
    assert.equal(audit.result.ledger_event_id, receipt.resource_id); assert.equal(audit.result.execution_authorized, false);
    assert.equal(audit.result.basis, "operator_transcription_not_broker_file"); assert.equal(audit.result.duplicate, false);
    const changes = f.db.prepare("SELECT total_changes() n").get();
    assert.deepEqual(submit(f, input, "manual-command-1", ctx.workspace_revision), receipt);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes);
  } finally { f.close(); }
});

test("sell uses recorded inventory and separate partial/final settlement affects cash but not holdings", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    const sold = submit(f, intent(f, { type: "sell", listing_id: f.alpha!, currency: "CNY", quantity: "2", consideration: "25", fee: "0.2" }));
    assert.deepEqual(position(f), { quantity: "4", cost_amount: "40" });
    assert.equal(balance(f, "cash_settled"), "100"); assert.equal(balance(f, "trade_receivable"), "24.8");
    const holdings = position(f), prior = rows(f, untouched);
    for (const [index, payment] of ["10", "14.8"].entries()) {
      submit(f, intent(f, { type: "settlement", related_event_id: sold.resource_id, direction: "sell", currency: "CNY", amount: payment }, "paid-" + index), "paid-" + index);
      assert.deepEqual(position(f), holdings);
    }
    assert.equal(balance(f, "cash_settled"), "124.8"); assert.equal(balance(f, "trade_receivable"), "0");
    assert.ok(!context(f).unsettled_trades.some(row => row.event_id === sold.resource_id)); assert.deepEqual(rows(f, untouched), prior);
  } finally { f.close(); }
});

test("buy settlement debits only independently entered actual cash; it is never inferred from an execution", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    const bought = submit(f), holdings = position(f);
    submit(f, intent(f, { type: "settlement", related_event_id: bought.resource_id, direction: "buy", currency: "CNY", amount: "21.1" }, "cash-paid"), "cash-paid");
    assert.equal(balance(f, "cash_settled"), "78.9"); assert.equal(balance(f, "trade_payable"), "-10"); assert.deepEqual(position(f), holdings);
    assert.ok(!context(f).unsettled_trades.some(row => row.event_id === bought.resource_id));
  } finally { f.close(); }
});

test("source duplicate reuses the original financial event; changed facts under the same source fail atomically", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    const first = submit(f), before = rows(f), second = submit(f, intent(f), "same-source-new-command");
    assert.equal(second.resource_id, first.resource_id); assert.deepEqual(rows(f), before);
    const audit = JSON.parse((f.db.prepare("SELECT payload_json FROM audit_events WHERE id=?").get(second.audit_id) as { payload_json: string }).payload_json);
    assert.equal(audit.result.duplicate, true);
    const forged = intent(f); if (forged.entry.type !== "settlement") forged.entry.consideration = "22";
    const workspace = getInvestorState(f.db, f.actor, now).revision;
    assert.throws(() => submit(f, forged, "changed-source"), /SOURCE_DUPLICATE_CONFLICT/); assert.deepEqual(rows(f), before);
    assert.equal(getInvestorState(f.db, f.actor, now).revision, workspace);
  } finally { f.close(); }
});

test("foreign identities, impossible quantities, excessive settlement, bad dates and guessed facts are rejected without partial writes", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    const base = intent(f), open = context(f).unsettled_trades[0];
    const cases: unknown[] = [
      { ...base, account_id: "foreign" }, { ...base, portfolio_id: "foreign" }, { ...base, acknowledgement: false },
      { ...base, effective_date: "2026-01-03" }, { ...base, effective_date: "2026-02-30" }, { ...base, effective_date: "2025-12-01" },
      { ...base, entry: { ...base.entry, currency: "USD" } }, { ...base, entry: { ...base.entry, listing_id: "foreign" } },
      { ...base, entry: { ...base.entry, quantity: "0" } }, { ...base, entry: { ...base.entry, fee: undefined } },
      { ...base, entry: { ...base.entry, type: "sell", quantity: "7" } },
      { ...base, entry: { type: "settlement", related_event_id: open.event_id, direction: "buy", currency: "CNY", amount: "10.01" } },
      { ...base, entry: { type: "settlement", related_event_id: open.event_id, direction: "sell", currency: "CNY", amount: "1" } },
      { ...base, entry: { type: "settlement", related_event_id: open.event_id, direction: "buy", currency: "USD", amount: "1" } },
      { ...base, entry: { ...base.entry, type: "sell", consideration: "0.1", fee: "0.1" } },
      { ...base, entry: { ...base.entry, price: "10" } }, { ...base, owner_id: "foreign" },
      { ...base, source_id: "invalid source" }, { ...base, source_event_id: "中文编号" },
    ];
    const before = rows(f), ws = context(f).workspace_revision;
    for (const [i, raw] of cases.entries()) {
      assert.throws(() => submit(f, raw as TradeRecordingIntent, "invalid-" + i)); assert.deepEqual(rows(f), before);
      assert.equal(context(f).workspace_revision, ws);
    }
  } finally { f.close(); }
});

test("maximum valid investor idempotency key fits the lower ledger contract through a fixed digest", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    const input = intent(f), ws = context(f).workspace_revision, key = "x".repeat(160), receipt = submit(f, input, key);
    const event = f.db.prepare("SELECT idempotency_key FROM ledger_events WHERE id=?").get(receipt.resource_id) as { idempotency_key: string };
    assert.match(event.idempotency_key, /^investor-trade:[a-f0-9]{64}$/);
    assert.deepEqual(submit(f, input, key, ws), receipt);
  } finally { f.close(); }
});

test("a superseded source cannot resurrect a corrected trade; late rejection rolls back the lower dedup alias", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    const original = submit(f);
    const attachment = storeJsonAttachment(f.db, f.actor, { portfolio_id: f.portfolio, account_id: f.account,
      raw: JSON.stringify({ fictional: true, reason: "Fictional correction evidence" }) }, { dataDir: f.directory, now });
    correctLedger(f.db, f.actor, { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: "fictional-correction",
      attachment_id: attachment.id, reason: "Fictional void only", changes: [{ action: "void", event_id: original.resource_id }] }, { dataDir: f.directory, now });
    const before = rows(f, [...financial, "command_dedup", "investor_commands", "investor_workspaces", "audit_events"]);
    assert.throws(() => submit(f, intent(f), "superseded-new-key"), /SOURCE_SUPERSEDED/);
    assert.deepEqual(rows(f, [...financial, "command_dedup", "investor_commands", "investor_workspaces", "audit_events"]), before);
    assert.deepEqual(position(f), { quantity: "6", cost_amount: "60" });
  } finally { f.close(); }
});

test("settlement posting corruption fails closed, even when the declared child amount is unchanged", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    const parent = context(f).unsettled_trades[0];
    const child = submit(f, intent(f, { type: "settlement", related_event_id: parent.event_id, direction: "buy", currency: "CNY", amount: "4" }, "paid"));
    const triggers = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='postings'").all() as { name: string }[];
    for (const row of triggers) f.db.exec(`DROP TRIGGER "${row.name}"`);
    f.db.prepare("UPDATE postings SET amount='-3' WHERE event_id=? AND ledger_account='cash_settled'").run(child.resource_id);
    assert.throws(() => context(f), /EVIDENCE_INVALID/);
  } finally { f.close(); }
});

test("workspace, account, ledger, link and metadata changes fence stale drafts; disabled and recovery accounts cannot be written", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    const base = intent(f), before = rows(f);
    for (const [i, patch] of [{ expected_ledger_revision: base.expected_ledger_revision - 1 },
      { expected_account_row_version: base.expected_account_row_version + 1 }, { expected_link_id: "old" },
      { expected_link_version: base.expected_link_version + 1 }, { expected_context_hash: "f".repeat(64) }].entries())
      assert.throws(() => submit(f, { ...base, ...patch }, "stale-" + i), /CONTEXT_CONFLICT/);
    assert.throws(() => submit(f, base, "stale-ws", context(f).workspace_revision - 1), /VERSION_CONFLICT/); assert.deepEqual(rows(f), before);
    registerListing(f.db, f.actor, { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: "new-identity",
      market: "CN", exchange: "SSE", ticker: "501996", currency: "CNY", name: "Fictional new identity", asset_class: "unknown", source_evidence: "Fictional only" }, now);
    assert.throws(() => submit(f, base, "stale-listing"), /CONTEXT_CONFLICT/);
    f.db.prepare("UPDATE accounts SET status='disabled',row_version=row_version+1 WHERE id=?").run(f.account);
    assert.throws(() => submit(f, intent(f), "disabled"), /ACCOUNT_DISABLED/);
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "FICTIONAL RECOVERY\n");
    assert.equal(context(f).read_only, true); assert.throws(() => submit(f, intent(f), "restore"), /WORKBENCH_READ_ONLY/);
  } finally { f.close(); }
});

test("late investor audit failure rolls back ledger facts, projections, account invalidation, workspace and both dedup records", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    const before = rows(f, [...financial, ...untouched, "command_dedup", "investor_commands", "investor_workspaces", "audit_events"]);
    f.db.exec("CREATE TRIGGER fictional_trade_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action='investor_record_linked_trade_fact' BEGIN SELECT RAISE(ABORT,'fictional failure'); END");
    assert.throws(() => submit(f), /fictional failure/);
    assert.deepEqual(rows(f, [...financial, ...untouched, "command_dedup", "investor_commands", "investor_workspaces", "audit_events"]), before);
  } finally { f.close(); }
});

test("untrusted posting corruption fails closed instead of creating a selectable settlement parent", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    const event = context(f).unsettled_trades[0].event_id;
    const triggers = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='postings'").all() as { name: string }[];
    for (const row of triggers) f.db.exec(`DROP TRIGGER "${row.name}"`);
    f.db.prepare("UPDATE postings SET amount='-9' WHERE event_id=? AND ledger_account='trade_payable'").run(event);
    assert.throws(() => context(f), /EVIDENCE_INVALID/);
  } finally { f.close(); }
});
