import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, recordFact, rebuildProjections, revision, type LedgerCommand } from "../src/server/ledger/service";
import type { Fact } from "../src/server/ledger/engine";

const actor = { id: "test-owner" };
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "etf-ledger-"));
  const filename = path.join(dir, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, actor, "Test portfolio");
  const account = createAccount(db, actor, portfolio, "Domestic", "Synthetic", "CNY");
  let counter = 0;
  const command = (fact: Partial<Fact> & Pick<Fact, "type">): LedgerCommand => ({ portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: `event-${++counter}`, source_id: "fixture", source_event_id: `source-${counter}`, effective_at: "2026-01-01", time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Synthetic test", fact: { account_id: account, currency: "CNY", ...fact } });
  const close = () => { db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { db, portfolio, account, command, close, filename };
}
const count = (db: Database.Database, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("F01/F02 new portfolios have no implicit funding plan or cash; confirmed funds and revisions are real", () => {
  const f = fixture();
  try {
    assert.equal(count(f.db, "ledger_events"), 0);
    assert.equal(count(f.db, "account_projections"), 0);
    assert.equal(count(f.db, "funding_plan_versions"), 0);
    recordFact(f.db, actor, f.command({ type: "opening_cash", amount: "100" }));
    const receipt = recordFact(f.db, actor, f.command({ type: "deposit", amount: "25" }));
    assert.equal(receipt.revision, 2);
    assert.equal((f.db.prepare("SELECT balance FROM account_projections WHERE ledger_account='cash_settled'").get() as { balance: string }).balance, "125");
    assert.equal(count(f.db, "funding_plan_versions"), 0);
  } finally { f.close(); }
});

test("same command is idempotent; same source across files deduplicates; conflicts fail", () => {
  const f = fixture();
  try {
    const command = f.command({ type: "deposit", amount: "100" });
    const first = recordFact(f.db, actor, command);
    assert.equal(recordFact(f.db, actor, command).event_id, first.event_id);
    assert.equal(recordFact(f.db, actor, { ...command, idempotency_key: "other-file" }).event_id, first.event_id);
    assert.equal(recordFact(f.db, actor, { ...command, idempotency_key: "formatted-file", reason: "Other export", fact: { ...command.fact, amount: "100.00" } }).event_id, first.event_id);
    assert.throws(() => recordFact(f.db, actor, { ...command, idempotency_key: "other-file", source_event_id: "new-source", fact: { ...command.fact, amount: "1" } }), /DUPLICATE_CONFLICT/);
    assert.equal(count(f.db, "ledger_events"), 1);
    assert.throws(() => recordFact(f.db, actor, { ...command, fact: { ...command.fact, amount: "101" } }), /DUPLICATE_CONFLICT/);
    assert.equal(count(f.db, "ledger_events"), 1);
    assert.equal(revision(f.db, f.portfolio), 1);
  } finally { f.close(); }
});

test("stale revision and invalid facts roll back events, projections and audit together", () => {
  const f = fixture();
  try {
    const stale = f.command({ type: "deposit", amount: "1" });
    recordFact(f.db, actor, f.command({ type: "deposit", amount: "100" }));
    const audits = count(f.db, "audit_events");
    assert.throws(() => recordFact(f.db, actor, stale), /VERSION_CONFLICT/);
    assert.throws(() => recordFact(f.db, actor, f.command({ type: "deposit", amount: "-1" })), /POSITIVE/);
    assert.equal(count(f.db, "ledger_events"), 1);
    assert.equal(count(f.db, "audit_events"), audits);
    assert.throws(() => recordFact(f.db, { id: "" }, f.command({ type: "deposit", amount: "1" })), /UNAUTHENTICATED/);
  } finally { f.close(); }
});

test("trade settlement cannot exceed event outstanding, rebuild exactly matches", () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO instruments(id,name,created_at) VALUES('i','Synthetic ETF','2026-01-01')").run();
    f.db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('l','i','CN','SSE','000001','CNY','2026-01-01')").run();
    recordFact(f.db, actor, f.command({ type: "opening_cash", amount: "100000" }));
    const buy = recordFact(f.db, actor, f.command({ type: "buy", listing_id: "l", quantity: "1000", price: "10", fee: "10" }));
    recordFact(f.db, actor, f.command({ type: "settlement", direction: "buy", related_event_id: buy.event_id, amount: "10010" }));
    assert.throws(() => recordFact(f.db, actor, f.command({ type: "settlement", direction: "buy", related_event_id: buy.event_id, amount: "1" })), /EXCEEDS_OUTSTANDING/);
    const before = f.db.prepare("SELECT * FROM account_projections ORDER BY ledger_account").all();
    const beforePosition = f.db.prepare("SELECT * FROM position_projections").all();
    rebuildProjections(f.db, actor, f.portfolio);
    assert.deepEqual(f.db.prepare("SELECT * FROM account_projections ORDER BY ledger_account").all(), before);
    assert.deepEqual(f.db.prepare("SELECT * FROM position_projections").all(), beforePosition);
    assert.throws(() => f.db.prepare("UPDATE ledger_events SET reason='rewritten'").run(), /append-only/);
    assert.throws(() => f.db.prepare("DELETE FROM postings").run(), /append-only/);
  } finally { f.close(); }
});

test("cross-portfolio transfer references are rejected before any mutation", () => {
  const f = fixture();
  try {
    const other = createPortfolio(f.db, actor, "Other");
    const otherAccount = createAccount(f.db, actor, other, "Other", "Synthetic", "CNY");
    assert.throws(() => recordFact(f.db, actor, f.command({ type: "transfer_out", amount: "100", target_account_id: otherAccount })), /OUT_OF_SCOPE/);
    assert.equal(count(f.db, "ledger_events"), 0);
  } finally { f.close(); }
});

test("opening balances are a bounded inception snapshot, not repeatable deposits", () => {
  const f = fixture();
  try {
    recordFact(f.db, actor, f.command({ type: "opening_cash", amount: "100" }));
    assert.throws(() => recordFact(f.db, actor, f.command({ type: "opening_cash", amount: "100" })), /OPENING_ALREADY_RECORDED/);
    recordFact(f.db, actor, f.command({ type: "deposit", amount: "10" }));
    assert.throws(() => recordFact(f.db, actor, f.command({ type: "opening_cash", currency: "USD", amount: "100" })), /OPENING_PERIOD_CLOSED/);
    assert.equal(revision(f.db, f.portfolio), 2);
    assert.equal((f.db.prepare("SELECT balance FROM account_projections WHERE ledger_account='cash_settled'").get() as { balance: string }).balance, "110");
  } finally { f.close(); }
});

test("invalid dates and absent database never silently create a new ledger", () => {
  assert.throws(() => openWorkbench("relative.db"), /ABSOLUTE/);
  assert.throws(() => openWorkbench("/not/a/real/directory/workbench.db"));
  const f = fixture();
  try {
    assert.throws(() => recordFact(f.db, actor, { ...f.command({ type: "deposit", amount: "1" }), effective_at: "2026-02-30" }), /VALIDATION_FAILED:.*format "date"/);
    assert.equal(count(f.db, "ledger_events"), 0);
  } finally { f.close(); }
});

test("future actual facts are refused using source-local dates and UTC instants", () => {
  const f = fixture();
  try {
    assert.throws(() => recordFact(f.db, actor, { ...f.command({ type: "deposit", amount: "500000" }), effective_at: "2027-01-01" }, "2026-01-02T00:00:00Z"), /FUTURE_FACT_NOT_ALLOWED/);
    assert.equal(revision(f.db, f.portfolio), 0);
    recordFact(f.db, actor, { ...f.command({ type: "deposit", amount: "1" }), effective_at: "2026-01-02" }, "2026-01-01T23:00:00Z");
    assert.equal(revision(f.db, f.portfolio), 1);
  } finally { f.close(); }
});

test("instant normalization does not reject a legitimate later millisecond", () => {
  const f = fixture();
  try {
    recordFact(f.db, actor, { ...f.command({ type: "deposit", amount: "1" }), time_precision: "second", effective_at: "2026-01-01T00:00:00Z" });
    recordFact(f.db, actor, { ...f.command({ type: "deposit", amount: "1" }), time_precision: "second", effective_at: "2026-01-01T00:00:00.001Z" });
    assert.equal(revision(f.db, f.portfolio), 2);
  } finally { f.close(); }
});

test("recovery marker freezes both new connections and existing write services", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(path.dirname(f.filename), "RESTORE_PENDING_REVIEW"), "Synthetic recovery guard\n");
    assert.throws(() => recordFact(f.db, actor, f.command({ type: "deposit", amount: "1" })), /WORKBENCH_READ_ONLY/);
    assert.throws(() => createPortfolio(f.db, actor, "Disallowed"), /WORKBENCH_READ_ONLY/);
    const readOnly = openWorkbench(f.filename);
    try { assert.equal(readOnly.readonly, true); assert.equal(revision(readOnly, f.portfolio), 0); }
    finally { readOnly.close(); }
  } finally { f.close(); }
});
