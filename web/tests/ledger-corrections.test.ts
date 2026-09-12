import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { correctLedger, type CorrectionChange, type CorrectionCommand } from "../src/server/ledger/corrections";
import { previewJsonImport, confirmImport } from "../src/server/ledger/imports";
import { canonical, createAccount, createPortfolio, getActiveLedgerEvents, recordFact, rebuildProjections, revision, type LedgerCommand } from "../src/server/ledger/service";
import { amount, exact } from "../src/server/ledger/decimal";
import type { Fact } from "../src/server/ledger/engine";
import { reconcileAccount, RECONCILIATION_BALANCES } from "../src/server/ledger/reconciliation";

const actor = { id: "synthetic-owner" }, now = "2026-08-01T00:00:00.000Z";
function fixture() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "etf-corrections-"));
  const filename = path.join(dataDir, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, actor, "Synthetic", now);
  const account = createAccount(db, actor, portfolio, "A", "Synthetic", "CNY", now);
  const other = createAccount(db, actor, portfolio, "B", "Synthetic", "CNY", now);
  db.prepare("INSERT INTO instruments(id,name,created_at) VALUES('i','Synthetic ETF',?)").run(now);
  db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('l','i','CN','SSE','000001','CNY',?)").run(now);
  let count = 0;
  const command = (fact: Partial<Fact> & Pick<Fact, "type">, date = "2026-01-01"): LedgerCommand => ({
    portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: `fact-${++count}`, source_id: "synthetic",
    source_event_id: `source-${count}`, effective_at: date, time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Synthetic evidence",
    fact: { account_id: account, currency: "CNY", ...fact },
  });
  const record = (fact: Partial<Fact> & Pick<Fact, "type">, date?: string) => recordFact(db, actor, command(fact, date), "2026-06-01T00:00:00.000Z");
  const raw = '{ "correction_evidence": "SYNTHETIC ONLY" }\n';
  const attachment = storeJsonAttachment(db, actor, { portfolio_id: portfolio, account_id: account, raw }, { dataDir, now });
  const evidenceFor = (accountId: string) => storeJsonAttachment(db, actor, { portfolio_id: portfolio, account_id: accountId, raw }, { dataDir, now });
  const correction = (changes: CorrectionChange[]): CorrectionCommand => ({ portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: `correction-${++count}`, attachment_id: attachment.id, reason: "Correct synthetic records using retained evidence", changes });
  const replace = (eventId: string, fact: Partial<Fact>): CorrectionChange => {
    const source = getActiveLedgerEvents(db, portfolio).find(event => event.id === eventId)!;
    const old = JSON.parse(source.payload_json) as LedgerCommand;
    return { action: "replace", event_id: eventId, replacement: { effective_at: old.effective_at, time_precision: old.time_precision, source_timezone: old.source_timezone, fact: { ...old.fact, ...fact } } };
  };
  const correct = (changes: CorrectionChange[]) => correctLedger(db, actor, correction(changes), { dataDir, now });
  const balance = (ledgerAccount: string, accountId = account, currency = "CNY") => (db.prepare("SELECT balance FROM account_projections WHERE account_id=? AND currency=? AND ledger_account=?").get(accountId, currency, ledgerAccount) as { balance: string } | undefined)?.balance ?? "0";
  const projections = () => ({
    balances: db.prepare("SELECT account_id,currency,ledger_account,balance FROM account_projections WHERE balance<>'0' ORDER BY account_id,currency,ledger_account").all(),
    positions: db.prepare("SELECT account_id,listing_id,currency,quantity,cost_amount,cost_known FROM position_projections ORDER BY account_id,listing_id").all(),
  });
  const assertRebuild = () => { const before = projections(); rebuildProjections(db, actor, portfolio, now); assert.deepEqual(projections(), before); };
  return { db, portfolio, account, other, dataDir, attachment, evidenceFor, command, record, correction, replace, correct, balance, projections, assertRebuild, close: () => { db.close(); rmSync(dataDir, { force: true, recursive: true }); } };
}

test("ACC19 facts invalidate only affected accounts and never enable disabled accounts", () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE accounts SET status='active'").run();
    f.db.prepare("UPDATE accounts SET status='disabled' WHERE id=?").run(f.account);
    f.record({ type: "deposit", amount: "100" });
    assert.deepEqual(f.db.prepare("SELECT status,row_version FROM accounts WHERE id=?").get(f.account), { status: "disabled", row_version: 0 });
    assert.deepEqual(f.db.prepare("SELECT status,row_version FROM accounts WHERE id=?").get(f.other), { status: "active", row_version: 0 });
    f.record({ type: "fx", amount: "10", target_currency: "USD", received_amount: "1.3", target_account_id: f.other });
    assert.equal((f.db.prepare("SELECT status FROM accounts WHERE id=?").get(f.account) as { status: string }).status, "disabled");
    assert.equal((f.db.prepare("SELECT status FROM accounts WHERE id=?").get(f.other) as { status: string }).status, "reconciliation_required");
  } finally { f.close(); }
});

test("E12 correction appends exact reversals, retains prior facts and exposes only published revisions", () => {
  const f = fixture();
  try {
    f.record({ type: "deposit", amount: "1000" });
    const fee = f.record({ type: "fee", amount: "10" }, "2026-01-02");
    const original = f.db.prepare("SELECT * FROM ledger_events WHERE id=?").get(fee.event_id);
    const postings = f.db.prepare("SELECT * FROM postings WHERE event_id=? ORDER BY id").all(fee.event_id);
    const input = f.correction([f.replace(fee.event_id, { amount: "3" })]);
    const result = correctLedger(f.db, actor, input, { dataDir: f.dataDir, now });
    assert.equal(result.revision, 4); assert.equal(result.reversals.length, 1); assert.equal(f.balance("cash_settled"), "997");
    assert.deepEqual(f.db.prepare("SELECT * FROM ledger_events WHERE id=?").get(fee.event_id), original);
    assert.deepEqual(f.db.prepare("SELECT * FROM postings WHERE event_id=? ORDER BY id").all(fee.event_id), postings);
    const reversal = f.db.prepare("SELECT effective_at,recorded_at,payload_json FROM ledger_events WHERE reversal_of=?").get(fee.event_id) as { effective_at: string; recorded_at: string; payload_json: string };
    assert.equal(reversal.effective_at, "2026-01-02"); assert.equal(reversal.recorded_at, now);
    assert.equal(JSON.parse(reversal.payload_json).original_event_id, fee.event_id);
    assert.equal(getActiveLedgerEvents(f.db, f.portfolio, 2).at(-1)!.id, fee.event_id);
    assert.throws(() => getActiveLedgerEvents(f.db, f.portfolio, 3), /REVISION_NOT_PUBLISHED/);
    assert.equal(getActiveLedgerEvents(f.db, f.portfolio).length, 2);
    const asKnown = f.db.prepare("SELECT p.amount FROM postings p JOIN ledger_events e ON e.id=p.event_id WHERE e.recorded_at<=? AND p.ledger_account='cash_settled'").all("2026-07-01T00:00:00.000Z") as { amount: string }[];
    assert.equal(exact(asKnown.reduce((total, row) => total.add(amount(row.amount)), amount("0"))), "990");
    assert.equal(correctLedger(f.db, actor, { ...input, expected_revision: 0 }, { dataDir: f.dataDir, now }).duplicate, true);
    assert.throws(() => correctLedger(f.db, actor, { ...input, reason: "Different" }, { dataDir: f.dataDir, now }), /DUPLICATE_CONFLICT/);
    assert.throws(() => f.db.prepare("UPDATE ledger_events SET reason='altered' WHERE id=?").run(fee.event_id), /append-only/);
    f.assertRebuild();
  } finally { f.close(); }
});

test("E13 historical buy recomputes downstream average cost, realized profit and settlement links", () => {
  const f = fixture();
  try {
    f.record({ type: "opening_cash", amount: "1000" });
    const first = f.record({ type: "buy", listing_id: "l", quantity: "10", price: "10" }, "2026-01-02");
    f.record({ type: "settlement", direction: "buy", related_event_id: first.event_id, amount: "100" }, "2026-01-03");
    const sell = f.record({ type: "sell", listing_id: "l", quantity: "10", price: "30" }, "2026-01-05");
    const settlement = f.record({ type: "settlement", direction: "sell", related_event_id: sell.event_id, amount: "300" }, "2026-01-06");
    assert.equal(f.balance("income"), "-200");
    const late = f.command({ type: "buy", listing_id: "l", quantity: "10", price: "20" }, "2026-01-04");
    assert.throws(() => recordFact(f.db, actor, late, now), /CHRONOLOGY_REVIEW_REQUIRED/);
    const { fact, effective_at, time_precision, source_timezone, source_id, source_event_id } = late;
    const result = f.correct([{ action: "insert", local_id: "late-buy", record: { fact, effective_at, time_precision, source_timezone, source_id, source_event_id } }]);
    assert.equal(f.balance("income"), "-150"); assert.equal(f.balance("cash_settled"), "1200"); assert.equal(f.balance("trade_payable"), "-200");
    assert.deepEqual(f.db.prepare("SELECT quantity,cost_amount,cost_known FROM position_projections").get(), { quantity: "10", cost_amount: "150", cost_known: 1 });
    const newSell = result.replacements.find(row => row.original_event_id === sell.event_id)!.event_id;
    const newSettlement = result.replacements.find(row => row.original_event_id === settlement.event_id)!.event_id;
    const replayed = JSON.parse((f.db.prepare("SELECT payload_json FROM ledger_events WHERE id=?").get(newSettlement) as { payload_json: string }).payload_json) as LedgerCommand;
    assert.equal(replayed.fact.related_event_id, newSell);
    assert.equal(getActiveLedgerEvents(f.db, f.portfolio).length, 6);
    f.assertRebuild();
    // Additive restated accounting equals the active projection, without any fake income offset.
    const all = f.db.prepare("SELECT amount FROM postings WHERE ledger_account='income'").all() as { amount: string }[];
    assert.equal(exact(all.reduce((total, row) => total.add(amount(row.amount)), amount("0"))), "-150");
  } finally { f.close(); }
});

test("same-day historical insertion requires explicit economic order and supports local dependency IDs", () => {
  const f = fixture();
  try {
    const deposit = f.record({ type: "deposit", amount: "1000" });
    const buy = f.command({ type: "buy", listing_id: "l", quantity: "10", price: "10" });
    const change: CorrectionChange = { action: "insert", local_id: "buy", record: buy };
    // Economic records do not accept client revision/idempotency fields.
    assert.throws(() => f.correct([change]), /INVALID_CORRECTION_COMMAND/);
    const pick = ({ fact, effective_at, time_precision, source_timezone, source_id, source_event_id }: LedgerCommand) => ({ fact, effective_at, time_precision, source_timezone, source_id, source_event_id });
    const inserted: CorrectionChange = { action: "insert", local_id: "buy", record: pick(buy) };
    assert.throws(() => f.correct([inserted]), /CORRECTION_ORDER_ANCHOR_REQUIRED/);
    const settle = f.command({ type: "settlement", direction: "buy", related_event_id: "insert:buy", amount: "100" });
    const result = f.correct([{ ...inserted, after_event_id: deposit.event_id }, { action: "insert", local_id: "settle", record: pick(settle), after_event_id: "insert:buy" }]);
    assert.equal(result.inserted.length, 2); assert.equal(f.balance("cash_settled"), "900"); assert.equal(f.balance("trade_payable"), "0");
    f.assertRebuild();
  } finally { f.close(); }
});

test("dependent settlement cannot be silently changed; paired replacements succeed atomically", () => {
  const f = fixture();
  try {
    const buy = f.record({ type: "buy", listing_id: "l", quantity: "10", price: "10" });
    const settlement = f.record({ type: "settlement", direction: "buy", related_event_id: buy.event_id, amount: "100" }, "2026-01-02");
    const before = f.projections();
    assert.throws(() => f.correct([f.replace(buy.event_id, { price: "8" })]), /EXCEEDS_OUTSTANDING/);
    assert.equal(revision(f.db, f.portfolio), 2); assert.deepEqual(f.projections(), before);
    const result = f.correct([f.replace(buy.event_id, { price: "8" }), f.replace(settlement.event_id, { amount: "80" })]);
    assert.equal(f.balance("cash_settled"), "-80"); assert.equal(f.balance("trade_payable"), "0"); assert.equal(result.replacements.length, 2);
    f.assertRebuild();
  } finally { f.close(); }
});

test("voiding transfer legs requires both dependencies and scoped evidence for every changed account", () => {
  const f = fixture();
  try {
    f.record({ type: "deposit", amount: "1000" });
    const outgoing = f.record({ type: "transfer_out", target_account_id: f.other, amount: "100", fee: "2" }, "2026-01-02");
    const incoming = f.record({ type: "transfer_in", account_id: f.other, related_event_id: outgoing.event_id, amount: "100" }, "2026-01-03");
    assert.throws(() => f.correct([{ action: "void", event_id: outgoing.event_id }]), /CORRECTION_DEPENDENCY_MISSING_OR_LATER/);
    assert.throws(() => f.correct([{ action: "void", event_id: outgoing.event_id }, { action: "void", event_id: incoming.event_id }]), /ATTACHMENT_OUT_OF_SCOPE/);
    f.evidenceFor(f.other);
    const result = f.correct([{ action: "void", event_id: outgoing.event_id }, { action: "void", event_id: incoming.event_id }]);
    assert.deepEqual(result.affected_account_ids, [f.account, f.other].sort());
    assert.equal(f.balance("cash_settled"), "1000"); assert.equal(f.balance("cash_settled", f.other), "0"); assert.equal(f.balance("transfer_in_transit"), "0");
    f.assertRebuild();
  } finally { f.close(); }
});

test("cross-currency FX correction remains independently balanced and preserves disabled status", () => {
  const f = fixture();
  try {
    f.evidenceFor(f.other);
    f.record({ type: "deposit", amount: "1000" });
    const fx = f.record({ type: "fx", target_account_id: f.other, target_currency: "USD", amount: "700", received_amount: "100", fee: "1" }, "2026-01-02");
    f.db.prepare("UPDATE accounts SET status='disabled' WHERE id=?").run(f.other);
    const result = f.correct([f.replace(fx.event_id, { received_amount: "99" })]);
    assert.equal(f.balance("cash_settled", f.other, "USD"), "99"); assert.equal(f.balance("cash_settled"), "299");
    assert.equal((f.db.prepare("SELECT status FROM accounts WHERE id=?").get(f.other) as { status: string }).status, "disabled");
    for (const event of [...result.reversals.map(row => row.reversal_event_id), ...result.replacements.map(row => row.event_id)]) {
      const totals = new Map<string, ReturnType<typeof amount>>();
      for (const row of f.db.prepare("SELECT currency,amount FROM postings WHERE event_id=?").all(event) as { currency: string; amount: string }[]) totals.set(row.currency, (totals.get(row.currency) ?? amount("0")).add(amount(row.amount)));
      for (const total of totals.values()) assert.equal(exact(total), "0");
    }
    f.assertRebuild();
  } finally { f.close(); }
});

test("correcting unknown opening cost recalculates sell and clears unclassified income", () => {
  const f = fixture();
  try {
    const opening = f.record({ type: "opening_position", listing_id: "l", quantity: "20" });
    f.record({ type: "sell", listing_id: "l", quantity: "10", price: "30" }, "2026-01-02");
    assert.equal(f.balance("unclassified_income"), "-300");
    f.correct([f.replace(opening.event_id, { cost_amount: "200" })]);
    assert.equal(f.balance("unclassified_income"), "0"); assert.equal(f.balance("income"), "-200");
    assert.deepEqual(f.db.prepare("SELECT quantity,cost_amount,cost_known FROM position_projections").get(), { quantity: "10", cost_amount: "100", cost_known: 1 });
    f.assertRebuild();
  } finally { f.close(); }
});

test("replayed but unchanged other account does not lose reconciliation status", () => {
  const f = fixture();
  try {
    const fee = f.record({ type: "fee", amount: "10" });
    f.record({ type: "deposit", amount: "200", account_id: f.other }, "2026-01-02");
    f.db.prepare("UPDATE accounts SET status='active'").run();
    const before = f.db.prepare("SELECT status,row_version FROM accounts WHERE id=?").get(f.other);
    const result = f.correct([f.replace(fee.event_id, { amount: "3" })]);
    assert.deepEqual(result.affected_account_ids, [f.account]);
    assert.deepEqual(f.db.prepare("SELECT status,row_version FROM accounts WHERE id=?").get(f.other), before);
    assert.equal((f.db.prepare("SELECT status FROM accounts WHERE id=?").get(f.account) as { status: string }).status, "reconciliation_required");
  } finally { f.close(); }
});

test("import batch provenance is trusted, preserved through replay, and original retries do not resurrect facts", () => {
  const f = fixture();
  try {
    const original = f.command({ type: "deposit", amount: "100" });
    const preview = previewJsonImport(f.db, actor, f.portfolio, f.account, JSON.stringify([original]), now, { dataDir: f.dataDir });
    confirmImport(f.db, actor, f.portfolio, preview.id, preview.preview_hash, 0, now, { dataDir: f.dataDir });
    const event = getActiveLedgerEvents(f.db, f.portfolio)[0];
    assert.equal(event.import_batch_id, preview.id);
    const result = f.correct([f.replace(event.id, { amount: "90" })]);
    assert.equal(getActiveLedgerEvents(f.db, f.portfolio)[0].import_batch_id, preview.id);
    const beforeRevision = revision(f.db, f.portfolio);
    const retry = recordFact(f.db, actor, { ...original, expected_revision: beforeRevision, idempotency_key: "other-export" }, now);
    assert.equal(retry.duplicate, true); assert.equal(retry.event_id, event.id); assert.equal(revision(f.db, f.portfolio), beforeRevision);
    assert.ok(retry.warnings.includes("ORIGINAL_SOURCE_SUPERSEDED"));
    assert.ok(recordFact(f.db, actor, { ...original, expected_revision: beforeRevision, idempotency_key: "other-export" }, now).warnings.includes("ORIGINAL_SOURCE_SUPERSEDED"));
    assert.equal(f.balance("cash_settled"), "90"); assert.equal(result.replacements.length, 1);
    assert.throws(() => recordFact(f.db, actor, f.command({ type: "deposit", account_id: f.other, amount: "1" }), now, { importBatchId: preview.id }), /IMPORT_BATCH_OUT_OF_SCOPE/);
    assert.throws(() => recordFact(f.db, actor, { ...f.command({ type: "deposit", amount: "1" }), import_batch_id: preview.id } as LedgerCommand), /VALIDATION_FAILED/);
  } finally { f.close(); }
});

test("invalid scopes, stale CAS, future facts and missing actors make no partial correction", () => {
  const f = fixture();
  try {
    const fee = f.record({ type: "fee", amount: "10" });
    const input = f.correction([f.replace(fee.event_id, { amount: "3" })]);
    f.record({ type: "deposit", amount: "100" });
    assert.throws(() => correctLedger(f.db, actor, input, { dataDir: f.dataDir, now }), /VERSION_CONFLICT/);
    assert.throws(() => correctLedger(f.db, { id: "" }, input, { dataDir: f.dataDir, now }), /UNAUTHENTICATED/);
    assert.throws(() => f.correct([{ action: "void", event_id: "other-portfolio-event" }]), /CORRECTION_EVENT_NOT_ACTIVE/);
    const future = f.replace(fee.event_id, { amount: "3" });
    if (future.action === "replace") future.replacement.effective_at = "2027-01-01";
    assert.throws(() => f.correct([future]), /FUTURE_FACT_NOT_ALLOWED/);
    assert.throws(() => f.correct([f.replace(fee.event_id, { account_id: f.other })]), /CORRECTION_IDENTITY_CHANGE_UNSUPPORTED/);
    assert.equal(revision(f.db, f.portfolio), 2);
    writeFileSync(path.join(f.dataDir, "RESTORE_PENDING_REVIEW"), "Synthetic recovery guard");
    assert.throws(() => f.correct([{ action: "void", event_id: fee.event_id }]), /WORKBENCH_READ_ONLY/);
  } finally { f.close(); }
});

test("ambiguous mixed precision and cross-zone date histories fail explicitly", () => {
  const f = fixture();
  try {
    const first = f.record({ type: "deposit", amount: "100" });
    recordFact(f.db, actor, { ...f.command({ type: "fee", amount: "1" }, "2026-01-02"), source_timezone: "America/New_York" }, now);
    assert.throws(() => f.correct([f.replace(first.event_id, { amount: "90" })]), /CORRECTION_CROSS_TIMEZONE_DATE_UNSUPPORTED/);
    const instant = f.command({ type: "fee", amount: "1" }, "2026-01-03T00:00:00Z");
    instant.time_precision = "second";
    recordFact(f.db, actor, instant, now);
    assert.throws(() => f.correct([f.replace(first.event_id, { amount: "90" })]), /CORRECTION_MIXED_TIME_PRECISION_UNSUPPORTED/);
    assert.equal(revision(f.db, f.portfolio), 3);
  } finally { f.close(); }
});

test("corrected average-cost history equals a clean chronologically recorded baseline", () => {
  const f = fixture(), clean = fixture();
  try {
    const populate = (target: ReturnType<typeof fixture>, includeLate: boolean) => {
      target.record({ type: "opening_cash", amount: "10000" });
      target.record({ type: "buy", listing_id: "l", quantity: "3", consideration: "10" }, "2026-01-02");
      if (includeLate) target.record({ type: "buy", listing_id: "l", quantity: "7", consideration: "30" }, "2026-01-03");
      target.record({ type: "sell", listing_id: "l", quantity: "2", consideration: "20", fee: "1" }, "2026-01-04");
      target.record({ type: "split", listing_id: "l", split_numerator: "3", split_denominator: "2" }, "2026-01-05");
      target.record({ type: "sell", listing_id: "l", quantity: "1", consideration: "10" }, "2026-01-06");
    };
    populate(f, false); populate(clean, true);
    const record = f.command({ type: "buy", listing_id: "l", quantity: "7", consideration: "30" }, "2026-01-03");
    const { fact, effective_at, time_precision, source_timezone, source_id, source_event_id } = record;
    f.correct([{ action: "insert", local_id: "history", record: { fact, effective_at, time_precision, source_timezone, source_id, source_event_id } }]);
    const normalize = (target: ReturnType<typeof fixture>) => ({
      balances: target.db.prepare("SELECT currency,ledger_account,balance FROM account_projections WHERE balance<>'0' ORDER BY currency,ledger_account").all(),
      positions: target.db.prepare("SELECT listing_id,quantity,cost_amount,cost_known,currency FROM position_projections").all(),
    });
    assert.deepEqual(normalize(f), normalize(clean));
    f.assertRebuild(); clean.assertRebuild();
  } finally { f.close(); clean.close(); }
});

test("successive corrections reverse only active replacements, preserving every prior published view", () => {
  const f = fixture();
  try {
    const fee = f.record({ type: "fee", amount: "10" });
    const first = f.correct([f.replace(fee.event_id, { amount: "5" })]);
    const active = first.replacements[0].event_id;
    const second = f.correct([f.replace(active, { amount: "2" })]);
    assert.equal(f.balance("cash_settled"), "-2"); assert.equal(second.revision, 5);
    assert.equal(getActiveLedgerEvents(f.db, f.portfolio, 1)[0].id, fee.event_id);
    assert.equal(getActiveLedgerEvents(f.db, f.portfolio, 3)[0].id, active);
    assert.equal(getActiveLedgerEvents(f.db, f.portfolio, 5)[0].id, second.replacements[0].event_id);
    assert.throws(() => getActiveLedgerEvents(f.db, f.portfolio, 4), /REVISION_NOT_PUBLISHED/);
    assert.throws(() => getActiveLedgerEvents(f.db, f.portfolio, 6), /INVALID_LEDGER_REVISION/);
    assert.throws(() => f.correct([{ action: "void", event_id: fee.event_id }]), /CORRECTION_EVENT_NOT_ACTIVE/);
    f.assertRebuild();
  } finally { f.close(); }
});

test("voided later facts do not prevent reconciling the remaining current cutoff", () => {
  const f = fixture();
  try {
    f.record({ type: "deposit", amount: "100" });
    const later = f.record({ type: "fee", amount: "5" }, "2026-01-10");
    f.correct([{ action: "void", event_id: later.event_id }]);
    const statement = {
      schema_version: 1, portfolio_id: f.portfolio, account_id: f.account, cutoff_at: "2026-01-02T00:00:00.000Z",
      coverage: { currencies: ["CNY"], ledger_accounts: [...RECONCILIATION_BALANCES], positions_complete: true, balances_complete: true },
      balances: RECONCILIATION_BALANCES.map(ledger_account => ({ ledger_account, currency: "CNY", balance: ledger_account === "cash_settled" ? "100" : "0" })), positions: [],
    };
    const attachment = storeJsonAttachment(f.db, actor, { portfolio_id: f.portfolio, account_id: f.account, raw: JSON.stringify(statement) }, { dataDir: f.dataDir, now });
    const result = reconcileAccount(f.db, actor, { portfolio_id: f.portfolio, account_id: f.account, attachment_id: attachment.id, expected_revision: revision(f.db, f.portfolio) }, { dataDir: f.dataDir, now });
    assert.equal(result.status, "matched");
  } finally { f.close(); }
});

test("evidence tampering blocks both fresh correction and an otherwise idempotent retry", () => {
  const f = fixture();
  try {
    const fee = f.record({ type: "fee", amount: "10" });
    const input = f.correction([f.replace(fee.event_id, { amount: "3" })]);
    correctLedger(f.db, actor, input, { dataDir: f.dataDir, now });
    writeFileSync(path.join(f.dataDir, f.attachment.storage_key), "tampered");
    assert.throws(() => correctLedger(f.db, actor, input, { dataDir: f.dataDir, now }), /ATTACHMENT_/);
    const current = getActiveLedgerEvents(f.db, f.portfolio)[0].id;
    assert.throws(() => f.correct([{ action: "void", event_id: current }]), /ATTACHMENT_/);
    assert.equal(revision(f.db, f.portfolio), 3); assert.equal(f.balance("cash_settled"), "-3");
  } finally { f.close(); }
});

test("raw duplicate keys are retained as evidence but rejected before import interpretation", () => {
  const f = fixture();
  try {
    const raw = '[{"fact":{"amount":"1","\\u0061mount":"2"}}]';
    assert.throws(() => previewJsonImport(f.db, actor, f.portfolio, f.account, raw, now, { dataDir: f.dataDir }), /INVALID_JSON_IMPORT/);
    assert.equal(revision(f.db, f.portfolio), 0);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM attachments").get() as { count: number }).count, 2);
  } finally { f.close(); }
});

test("non-finite JSON values cannot collide with null in semantic hashes", () => {
  for (const value of [NaN, Infinity, -Infinity, { fact: { amount: Infinity } }, [NaN]]) assert.throws(() => canonical(value), /INVALID_JSON_VALUE/);
  assert.equal(canonical({ valid: null }), '{"valid":null}');
});

test("recovery marker appearing during a synchronous transaction rolls back facts before commit", () => {
  const f = fixture();
  try {
    const audits = (f.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count;
    f.db.function("synthetic_restore_marker", () => { writeFileSync(path.join(f.dataDir, "RESTORE_PENDING_REVIEW"), "Synthetic restore during transaction"); return 1; });
    f.db.exec("CREATE TEMP TRIGGER synthetic_freeze AFTER INSERT ON ledger_events BEGIN SELECT synthetic_restore_marker(); END");
    assert.throws(() => f.record({ type: "deposit", amount: "100" }), /WORKBENCH_READ_ONLY/);
    assert.equal(revision(f.db, f.portfolio), 0);
    assert.equal(f.balance("cash_settled"), "0");
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count, audits);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM ledger_events").get() as { count: number }).count, 0);
  } finally { f.close(); }
});

test("recovery marker appearing after correction audit prevents the entire reversal batch commit", () => {
  const f = fixture();
  try {
    const fee = f.record({ type: "fee", amount: "10" });
    const audits = (f.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count;
    f.db.function("synthetic_restore_marker", () => { writeFileSync(path.join(f.dataDir, "RESTORE_PENDING_REVIEW"), "Synthetic restore during correction"); return 1; });
    f.db.exec("CREATE TEMP TRIGGER synthetic_freeze AFTER INSERT ON audit_events WHEN NEW.action='correct_ledger' BEGIN SELECT synthetic_restore_marker(); END");
    assert.throws(() => f.correct([f.replace(fee.event_id, { amount: "3" })]), /WORKBENCH_READ_ONLY/);
    assert.equal(revision(f.db, f.portfolio), 1); assert.equal(f.balance("cash_settled"), "-10");
    assert.equal(getActiveLedgerEvents(f.db, f.portfolio)[0].id, fee.event_id);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count, audits);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM ledger_events").get() as { count: number }).count, 1);
  } finally { f.close(); }
});
