import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { correctLedger, type CorrectionChange } from "../src/server/ledger/corrections";
import { createAccount, createPortfolio, getActiveLedgerEvents, recordFact, rebuildProjections, revision, type LedgerCommand } from "../src/server/ledger/service";
import type { Fact, SecurityTransferValue } from "../src/server/ledger/engine";
import { availableResources, ownedSecurityPositions } from "../src/server/governance/risk";
import { workbenchState } from "../src/server/ledger/queries";

const actor = { id: "synthetic-owner" }, now = "2026-08-01T00:00:00.000Z";
const evidence = (date = "2026-01-01"): SecurityTransferValue => ({ schema_version: "security-transfer-value-v1", reference: "Synthetic broker value confirmation", effective_at: date, time_precision: "date", source_timezone: "Asia/Shanghai" });
function fixture() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "etf-security-transfers-"));
  const filename = path.join(dataDir, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, actor, "Synthetic securities", now);
  const source = createAccount(db, actor, portfolio, "Source", "Synthetic", "CNY", now);
  const target = createAccount(db, actor, portfolio, "Target", "Synthetic", "CNY", now);
  db.prepare("INSERT INTO instruments(id,name,created_at) VALUES('i','Synthetic ETF',?)").run(now);
  db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('l','i','CN','SSE','000001','CNY',?)").run(now);
  let counter = 0;
  const command = (fact: Partial<Fact> & Pick<Fact, "type">, date = "2026-01-01"): LedgerCommand => ({ portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: `fact-${++counter}`, source_id: "synthetic", source_event_id: `source-${counter}`, effective_at: date, time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Synthetic only", fact: { account_id: source, currency: "CNY", ...fact } });
  const record = (fact: Partial<Fact> & Pick<Fact, "type">, date?: string) => recordFact(db, actor, command(fact, date), now);
  const position = (account = source) => db.prepare("SELECT quantity,cost_amount,cost_known FROM position_projections WHERE account_id=? AND listing_id='l'").get(account);
  const transit = (id: string) => db.prepare("SELECT quantity,cost_amount,cost_known FROM security_transit_projections WHERE transfer_event_id=?").get(id);
  const snapshot = () => ({
    balances: db.prepare("SELECT * FROM account_projections ORDER BY account_id,currency,ledger_account").all(),
    positions: db.prepare("SELECT * FROM position_projections ORDER BY account_id,listing_id").all(),
    transits: db.prepare("SELECT * FROM security_transit_projections ORDER BY transfer_event_id").all(),
  });
  const assertRebuild = () => { const before = snapshot(); rebuildProjections(db, actor, portfolio, now); assert.deepEqual(snapshot(), before); };
  const correct = (changes: CorrectionChange[]) => {
    const raw = '{"synthetic":"evidence for source and target"}';
    const attachment = storeJsonAttachment(db, actor, { portfolio_id: portfolio, account_id: source, raw }, { dataDir, now });
    storeJsonAttachment(db, actor, { portfolio_id: portfolio, account_id: target, raw }, { dataDir, now });
    return correctLedger(db, actor, { portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: `correction-${++counter}`, attachment_id: attachment.id, reason: "Synthetic correction", changes }, { dataDir, now });
  };
  return { db, portfolio, source, target, command, record, position, transit, snapshot, assertRebuild, correct, close: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test("external securities freeze confirmed value/time; unknown cost stays unknown, no cash or income invented", () => {
  const f = fixture();
  try {
    const receipt = f.record({ type: "security_in", listing_id: "l", quantity: "100", market_value: "1000", value_evidence: evidence() });
    assert.ok(receipt.warnings.includes("UNKNOWN_HISTORICAL_COST"));
    assert.deepEqual(f.position(), { quantity: "100", cost_amount: "0", cost_known: 0 });
    assert.deepEqual(f.db.prepare("SELECT ledger_account,balance FROM account_projections ORDER BY ledger_account").all(), [
      { ledger_account: "capital_valuation_adjustment", balance: "1000" }, { ledger_account: "external_capital", balance: "-1000" },
    ]);
    f.record({ type: "security_out", listing_id: "l", quantity: "40", market_value: "480", value_evidence: evidence() });
    assert.deepEqual(f.position(), { quantity: "60", cost_amount: "0", cost_known: 0 });
    const rev = revision(f.db, f.portfolio), before = f.snapshot();
    for (const change of [
      { value_evidence: undefined }, { value_evidence: { ...evidence(), reference: "  " } },
      { value_evidence: { ...evidence(), effective_at: "2026-01-02" } },
      { value_evidence: { ...evidence(), source_timezone: "UTC" } },
      { value_evidence: { ...evidence(), time_precision: "second", effective_at: "2026-01-01T00:00:00Z" } },
      { cost_amount: "1" }, { fee: "1" }, { quantity: "61" },
    ]) assert.throws(() => f.record({ type: "security_out", listing_id: "l", quantity: "1", market_value: "12", value_evidence: evidence(), ...change } as Fact));
    assert.equal(revision(f.db, f.portfolio), rev); assert.deepEqual(f.snapshot(), before);
    f.assertRebuild();
  } finally { f.close(); }
});

test("external source dedup normalizes decimals and UTC precision, but changed confirmed evidence conflicts", () => {
  const f = fixture();
  try {
    const command: LedgerCommand = { ...f.command({ type: "security_in", listing_id: "l", quantity: "3", cost_amount: "1", market_value: "6", value_evidence: { ...evidence(), time_precision: "second", effective_at: "2026-01-01T00:00:00Z" } }), time_precision: "second", effective_at: "2026-01-01T00:00:00.000Z" };
    const first = recordFact(f.db, actor, command, now);
    assert.equal(recordFact(f.db, actor, { ...command, idempotency_key: "other-file", fact: { ...command.fact, market_value: "6.00", value_evidence: { ...command.fact.value_evidence!, effective_at: "2026-01-01T00:00:00.000Z" } } }, now).event_id, first.event_id);
    assert.throws(() => recordFact(f.db, actor, { ...command, idempotency_key: "conflict", fact: { ...command.fact, value_evidence: { ...command.fact.value_evidence!, reference: "Different evidence" } } }, now), /SOURCE_DUPLICATE_CONFLICT/);
    assert.equal(revision(f.db, f.portfolio), 1);
  } finally { f.close(); }
});

test("internal transfer only settles received shares and allocates exact remaining cost on partial receive/return", () => {
  const f = fixture();
  try {
    f.record({ type: "opening_position", listing_id: "l", quantity: "3", cost_amount: "1" });
    const dispatch = f.record({ type: "security_transfer_out", listing_id: "l", quantity: "3", target_account_id: f.target });
    assert.deepEqual(f.position(), { quantity: "0", cost_amount: "0", cost_known: 1 }); assert.equal(f.position(f.target), undefined);
    assert.deepEqual(f.transit(dispatch.event_id), { quantity: "3", cost_amount: "1", cost_known: 1 });
    const state = workbenchState(f.db, actor, f.portfolio);
    assert.equal(state.security_transits.length, 1);
    const owned = ownedSecurityPositions(state.positions, state.security_transits);
    assert.equal(owned.filter(p => p.account_id === f.source).reduce((sum, p) => sum + Number(p.quantity), 0), 3);
    assert.equal(owned.filter(p => p.account_id === f.target).length, 0);
    const resources = availableResources([], [{ account_id: f.source, listing_id: "l", quantity: "0", currency: "CNY", cost_known: 1 }], []);
    assert.equal(resources.sellable.get(`${f.source}:l`)!.toString(), "0");
    assert.throws(() => f.record({ type: "sell", listing_id: "l", quantity: "1", price: "10" }), /POSITION_HISTORY_REQUIRED/);
    assert.throws(() => f.record({ type: "security_transfer_in", related_event_id: dispatch.event_id, listing_id: "l", quantity: "1" }), /TRANSFER_TARGET_MISMATCH/);
    assert.throws(() => f.record({ type: "security_transfer_in", account_id: f.target, related_event_id: dispatch.event_id, listing_id: "l", quantity: "4" }), /EXCEEDS_OUTSTANDING/);
    f.record({ type: "security_transfer_in", account_id: f.target, related_event_id: dispatch.event_id, listing_id: "l", quantity: "1" });
    assert.deepEqual(f.position(f.target), { quantity: "1", cost_amount: "0.333333333333333333", cost_known: 1 });
    f.record({ type: "security_transfer_return", related_event_id: dispatch.event_id, listing_id: "l", quantity: "2" });
    assert.deepEqual(f.position(), { quantity: "2", cost_amount: "0.666666666666666667", cost_known: 1 });
    assert.deepEqual(f.transit(dispatch.event_id), { quantity: "0", cost_amount: "0", cost_known: 1 });
    assert.equal(f.db.prepare("SELECT 1 FROM account_projections WHERE ledger_account IN ('cash_settled','external_capital','income','trade_payable','trade_receivable')").get(), undefined);
    assert.throws(() => f.record({ type: "security_transfer_return", related_event_id: dispatch.event_id, listing_id: "l", quantity: "1" }), /EXCEEDS_OUTSTANDING/);
    f.assertRebuild();
  } finally { f.close(); }
});

test("split adjusts each source-owned transit lot; unknown-cost receipts close target opening only on arrival", () => {
  const f = fixture();
  try {
    f.record({ type: "opening_position", listing_id: "l", quantity: "100" });
    const first = f.record({ type: "security_transfer_out", listing_id: "l", quantity: "40", target_account_id: f.target });
    const second = f.record({ type: "security_transfer_out", listing_id: "l", quantity: "60", target_account_id: f.target });
    f.record({ type: "opening_cash", account_id: f.target, amount: "0" });
    f.record({ type: "split", listing_id: "l", split_numerator: "2", split_denominator: "1" });
    assert.deepEqual(f.transit(first.event_id), { quantity: "80", cost_amount: "0", cost_known: 0 });
    assert.deepEqual(f.transit(second.event_id), { quantity: "120", cost_amount: "0", cost_known: 0 });
    f.record({ type: "security_transfer_in", account_id: f.target, related_event_id: first.event_id, listing_id: "l", quantity: "80" });
    assert.deepEqual(f.position(f.target), { quantity: "80", cost_amount: "0", cost_known: 0 });
    assert.throws(() => f.record({ type: "opening_cash", account_id: f.target, currency: "USD", amount: "0" }), /OPENING_PERIOD_CLOSED/);
    f.assertRebuild();
  } finally { f.close(); }
});

test("security scope, CAS and append-only guards roll back atomically", () => {
  const f = fixture();
  try {
    f.record({ type: "opening_position", listing_id: "l", quantity: "3", cost_amount: "1" });
    const elsewhere = createPortfolio(f.db, actor, "Other", now), account = createAccount(f.db, actor, elsewhere, "Other", "Synthetic", "CNY", now);
    for (const change of [{ target_account_id: account }, { target_account_id: f.source }, { currency: "USD" }, { cost_amount: "1" }, { market_value: "1" }]) {
      assert.throws(() => f.record({ type: "security_transfer_out", listing_id: "l", quantity: "3", target_account_id: f.target, ...change }));
    }
    const stale = f.command({ type: "security_transfer_out", listing_id: "l", quantity: "1", target_account_id: f.target });
    const dispatch = f.record({ type: "security_transfer_out", listing_id: "l", quantity: "1", target_account_id: f.target });
    assert.throws(() => recordFact(f.db, actor, stale, now), /VERSION_CONFLICT/);
    assert.equal(revision(f.db, f.portfolio), 2);
    assert.throws(() => f.db.prepare("DELETE FROM security_transit_movements").run(), /append-only/);
    assert.throws(() => f.db.prepare("UPDATE security_transit_movements SET quantity='999'").run(), /append-only/);
    assert.throws(() => f.db.prepare("INSERT INTO security_transit_movements SELECT 'forged',event_id,transfer_event_id,source_account_id,?,listing_id,currency,quantity,cost_amount,cost_known FROM security_transit_movements WHERE transfer_event_id=?").run(account, dispatch.event_id), /portfolio mismatch/);
    assert.deepEqual(f.transit(dispatch.event_id), { quantity: "1", cost_amount: "0.333333333333333333", cost_known: 1 });
  } finally { f.close(); }
});

test("correction remaps transfer dependencies and exactly rebuilds partial received/returned lot costs", () => {
  const f = fixture();
  try {
    const opening = f.record({ type: "opening_position", listing_id: "l", quantity: "3", cost_amount: "1" });
    const dispatch = f.record({ type: "security_transfer_out", listing_id: "l", quantity: "3", target_account_id: f.target }, "2026-01-02");
    const received = f.record({ type: "security_transfer_in", account_id: f.target, listing_id: "l", quantity: "1", related_event_id: dispatch.event_id }, "2026-01-03");
    f.record({ type: "security_transfer_return", listing_id: "l", quantity: "1", related_event_id: dispatch.event_id }, "2026-01-04");
    const before = f.snapshot(), rev = revision(f.db, f.portfolio);
    assert.throws(() => f.correct([{ action: "void", event_id: dispatch.event_id }]), /CORRECTION_DEPENDENCY_MISSING_OR_LATER/);
    assert.equal(revision(f.db, f.portfolio), rev); assert.deepEqual(f.snapshot(), before);
    const original = JSON.parse(getActiveLedgerEvents(f.db, f.portfolio).find(e => e.id === opening.event_id)!.payload_json) as LedgerCommand;
    const result = f.correct([{ action: "replace", event_id: opening.event_id, replacement: { effective_at: original.effective_at, time_precision: original.time_precision, source_timezone: original.source_timezone, fact: { ...original.fact, cost_amount: "3" } } }]);
    const newDispatch = result.replacements.find(r => r.original_event_id === dispatch.event_id)!.event_id;
    const newReceived = result.replacements.find(r => r.original_event_id === received.event_id)!.event_id;
    assert.equal(f.transit(dispatch.event_id), undefined);
    assert.deepEqual(f.transit(newDispatch), { quantity: "1", cost_amount: "1", cost_known: 1 });
    assert.deepEqual(f.position(), { quantity: "1", cost_amount: "1", cost_known: 1 });
    assert.deepEqual(f.position(f.target), { quantity: "1", cost_amount: "1", cost_known: 1 });
    const receivedFact = JSON.parse(getActiveLedgerEvents(f.db, f.portfolio).find(e => e.id === newReceived)!.payload_json).fact;
    assert.equal(receivedFact.related_event_id, newDispatch);
    assert.deepEqual(result.affected_account_ids, [f.source, f.target].sort());
    assert.equal(getActiveLedgerEvents(f.db, f.portfolio, rev).length, 4);
    assert.throws(() => getActiveLedgerEvents(f.db, f.portfolio, rev + 1), /REVISION_NOT_PUBLISHED/);
    f.assertRebuild();
  } finally { f.close(); }
});
