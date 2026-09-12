import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import { buildLedgerFactQuality, type LedgerFactQualityInput } from "../src/server/ledger/fact-quality";
import { canonical, hash, createPortfolio, createAccount, recordFact, revision, type LedgerCommand } from "../src/server/ledger/service";
import { correctLedger } from "../src/server/ledger/corrections";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import type { Fact } from "../src/server/ledger/engine";
import { loadMigrations, migrateWorkbench, migrationDirectory } from "../../scripts/migrate-workbench.mjs";

type Row = Record<string, unknown>;
const START = "2025-01-01T00:00:00.000000Z", END = "2025-01-10T00:00:00.000000Z";
const rootPath = fileURLToPath(new URL("../../", import.meta.url));
function event(id: string, type: string, fields: Row = {}, options: Row = {}): Row {
  const row: Row = { id, portfolio_id: "p", account_id: "a", environment: "actual", event_type: type,
    effective_at: "2025-01-02T00:00:00.000000Z", recorded_at: START, time_precision: "second", source_timezone: "UTC",
    source_id: "synthetic-fixture", source_event_id: null, idempotency_key: id, ledger_revision: 1,
    actor_id: "fixture", reversal_of: null, import_batch_id: null, ...options };
  const command: Row = { portfolio_id: row.portfolio_id, expected_revision: Number(row.ledger_revision) - 1,
    idempotency_key: id, source_id: row.source_id, effective_at: row.effective_at, time_precision: row.time_precision,
    source_timezone: row.source_timezone, reason: "Synthetic retained source", fact: { type, account_id: row.account_id, currency: "CNY", ...fields } };
  if (row.source_event_id !== null) command.source_event_id = row.source_event_id;
  row.payload_json = canonical(command);
  row.payload_hash = hash(Object.fromEntries(Object.entries(command).filter(([key]) => !["expected_revision", "idempotency_key"].includes(key))));
  return row;
}
function reverse(original: Row, options: Row = {}): Row {
  const payload = { schema_version: "ledger-reversal-v1", original_event_id: original.id, reason: "Synthetic reversal" };
  return { ...original, id: "reverse-" + original.id, event_type: "reversal", reversal_of: original.id,
    ledger_revision: Number(original.ledger_revision) + 10, payload_json: canonical(payload), payload_hash: hash(payload), ...options };
}
function input(rows: Row[], extra: Partial<LedgerFactQualityInput> = {}): LedgerFactQualityInput {
  return { portfolio_id: "p", ledger_revision: Math.max(0, ...rows.map(row => Number(row.ledger_revision))),
    cutoff_at: END, knowledge_at: END, mode: "restated", ...extra };
}
const crossCases: { events: Row[]; input: LedgerFactQualityInput }[] = [];
function proof(rows: Row[], extra: Partial<LedgerFactQualityInput> = {}) {
  const request = input(rows, extra), result = buildLedgerFactQuality(rows, request);
  crossCases.push({ events: rows, input: request });
  return result;
}
const child = (id: string, type: string, fields: Row, revision: number, options: Row = {}) => event(id, type, { related_event_id: "gross", evidence_reference: "Synthetic retained statement", ...fields }, { ledger_revision: revision, ...options });

test("unknown legacy taxes are not final zero and cumulative tax confirmation never invents cash", () => {
  const root = event("gross", "dividend_accrual", { amount: "200", tax_status: "unknown" });
  const paid = child("paid", "dividend_payment", { amount: "180" }, 2);
  const before = proof([root, paid]);
  assert.equal(before.nav_quality, "provisional");
  assert.equal(before.dividends[0].recognized_tax, null);
  assert.equal(before.dividends[0].cash_received, "180");
  assert.equal(before.dividends[0].receivable, "20");
  const after = proof([root, paid, child("tax", "dividend_tax_assessment", { tax: "20", tax_status: "confirmed" }, 3)]);
  assert.equal(after.nav_quality, "complete");
  assert.equal(after.dividends[0].cash_received, "180");
  assert.equal(after.dividends[0].receivable, "0");
  for (const type of ["dividend", "dividend_accrual"]) {
    assert.equal(proof([event("legacy", type, { amount: "200" })]).nav_quality, "provisional");
    assert.equal(proof([event("legacy", type, { amount: "200", tax: "0" })]).nav_quality, "complete");
  }
});

test("actual receipt above an estimate, tax deduction and refund remain separate exact balances", () => {
  const rows = [event("gross", "dividend_accrual", { amount: "200", tax: "30", tax_status: "estimated" }),
    child("paid", "dividend_payment", { amount: "180" }, 2)];
  assert.equal(proof([...rows]).dividends[0].tax_payable, "-10");
  rows.push(child("assessed", "dividend_tax_assessment", { tax: "25", tax_status: "confirmed" }, 3));
  assert.equal(proof([...rows]).dividends[0].tax_payable, "-5");
  rows.push(child("deducted", "dividend_tax_payment", { amount: "5" }, 4));
  assert.equal(proof([...rows]).dividends[0].cash_received, "175");
  rows.push(child("adjusted", "dividend_tax_assessment", { tax: "20", tax_status: "confirmed" }, 5));
  assert.equal(proof([...rows]).dividends[0].receivable, "5");
  rows.push(child("refunded", "dividend_payment", { amount: "5" }, 6));
  const final = proof([...rows]).dividends[0];
  assert.deepEqual([final.cash_received, final.receivable, final.tax_payable, final.recognized_tax], ["180", "0", "0", "20"]);
  assert.equal(proof([...rows, child("double-deduct", "dividend_tax_payment", { amount: "1" }, 7)]).nav_quality, "blocked");
});

test("net-only final cash separates attribution; provisional net needs an explicit confirmed assessment", () => {
  for (const net_status of ["final", "provisional"]) {
    const rows = [event("net", "dividend_net", { amount: "180", net_status })];
    const initial = proof([...rows]);
    assert.equal(initial.nav_quality, net_status === "final" ? "complete" : "provisional");
    assert.equal(initial.attribution_quality, "provisional");
    assert.equal(initial.dividends[0].gross_amount, null);
    rows.push(child("breakdown", "dividend_breakdown", { related_event_id: "net", gross_amount: "200", tax: "20" }, 2));
    const brokenDown = proof([...rows]);
    assert.equal(brokenDown.nav_quality, net_status === "final" ? "complete" : "provisional");
    assert.equal(brokenDown.dividends[0].cash_received, "180");
    rows.push(child("confirm", "dividend_tax_assessment", { related_event_id: "net", tax: "20", tax_status: "confirmed" }, 3));
    assert.equal(proof([...rows]).attribution_quality, "complete");
    rows.push(child("estimate-again", "dividend_tax_assessment", { related_event_id: "net", tax: "20", tax_status: "estimated" }, 4));
    assert.equal(proof([...rows]).nav_quality, "provisional");
  }
});

test("unresolved notices block even without positions; resolution dependencies bind original sources", () => {
  const notice = event("notice", "corporate_action_notice", { action_kind: "merger", listing_id: "l", evidence_reference: "Synthetic notice" });
  assert.equal(proof([notice]).nav_quality, "blocked");
  const buy = event("buy", "buy", { listing_id: "l", quantity: "10", consideration: "100" }, { ledger_revision: 2 });
  const settlement = event("settle", "settlement", { related_event_id: "buy", amount: "100" }, { ledger_revision: 3 });
  const resolution = event("resolve", "corporate_action_resolution", { related_event_id: "notice", resolution: "recorded", supporting_event_ids: ["settle"], evidence_reference: "Synthetic verification" }, { ledger_revision: 4 });
  const good = proof([notice, buy, settlement, resolution]);
  assert.equal(good.nav_quality, "complete");
  assert.deepEqual(Object.keys(good.event_hashes), ["buy", "notice", "resolve", "settle"]);
  assert.equal(proof([notice, settlement, resolution]).nav_quality, "blocked");
  const reversed = reverse(buy);
  const invalid = proof([notice, buy, settlement, resolution, reversed]);
  assert.equal(invalid.nav_quality, "blocked");
  assert.equal(invalid.event_hashes[reversed.id as string], hash(reversed));
  assert.equal(proof([notice, { ...buy, account_id: "other" }, settlement, resolution]).nav_quality, "blocked");
});

test("date notices begin locally but date resolutions only clear at next midnight including DST", () => {
  for (const [zone, day, start, end] of [
    ["Asia/Shanghai", "2025-01-02", "2025-01-01T16:00:00Z", "2025-01-02T16:00:00Z"],
    ["America/New_York", "2025-03-09", "2025-03-09T05:00:00Z", "2025-03-10T04:00:00Z"],
  ]) {
    const notice = event("notice", "corporate_action_notice", { action_kind: "other" }, { effective_at: day, time_precision: "date", source_timezone: zone });
    const resolution = event("resolve", "corporate_action_resolution", { related_event_id: "notice", resolution: "not_applicable", supporting_event_ids: [] }, { ledger_revision: 2, effective_at: day, time_precision: "date", source_timezone: zone });
    assert.equal(proof([notice, resolution], { cutoff_at: start }).nav_quality, "blocked");
    assert.equal(proof([notice, resolution], { cutoff_at: end }).nav_quality, "complete");
    assert.equal(proof([notice, resolution, reverse(resolution)], { cutoff_at: start }).nav_quality, "blocked");
    assert.equal(proof([notice, resolution, reverse(resolution)], { cutoff_at: end }).nav_quality, "blocked");
  }
});

test("microseconds, knowledge cutoffs, scope, revision and reversed quality facts are independently replayed", () => {
  const notice = event("notice", "corporate_action_notice", { action_kind: "other" }, { effective_at: "2025-01-02T00:00:00.000001Z" });
  const resolution = event("resolve", "corporate_action_resolution", { related_event_id: "notice", resolution: "not_applicable", supporting_event_ids: [] }, { ledger_revision: 2, recorded_at: "2025-01-05T00:00:00Z" });
  assert.equal(proof([notice], { cutoff_at: "2025-01-02T00:00:00.000000Z" }).nav_quality, "complete");
  assert.equal(proof([notice], { cutoff_at: "2025-01-02T00:00:00.000001Z" }).nav_quality, "blocked");
  assert.equal(proof([notice, resolution], { cutoff_at: "2025-01-03T00:00:00Z", mode: "as_known" }).nav_quality, "blocked");
  assert.equal(proof([notice, resolution], { cutoff_at: "2025-01-03T00:00:00Z" }).nav_quality, "complete");
  assert.equal(proof([notice, resolution], { ledger_revision: 1 }).nav_quality, "blocked");
  const reversed = reverse(notice);
  assert.equal(proof([notice, reversed]).nav_quality, "complete");
  assert.equal(proof([notice, { ...reversed, payload_hash: "0".repeat(64) }]).nav_quality, "blocked");
  assert.equal(proof([notice, reversed, resolution]).nav_quality, "blocked");
  assert.equal(proof([event("other", "corporate_action_notice", { action_kind: "other" }, { portfolio_id: "elsewhere" })]).nav_quality, "complete");
});

test("period proof catches intermediate unresolved states without creating artificial date precision failures", () => {
  const notice = event("notice", "corporate_action_notice", { action_kind: "other" });
  const resolve = event("resolve", "corporate_action_resolution", { related_event_id: "notice", resolution: "not_applicable", supporting_event_ids: [] }, { ledger_revision: 2, effective_at: "2025-01-04T00:00:00Z" });
  const rows = [notice, resolve], period = proof(rows, { period_start: START });
  assert.equal(proof(rows).nav_quality, "complete");
  assert.equal(period.nav_quality, "blocked");
  assert.equal(period.corporate_actions[0].status, "resolved");
  assert.ok(period.issues.includes("CORPORATE_ACTION_UNRESOLVED:notice"));
  const date = event("div", "dividend", { amount: "200", tax: "20" }, { effective_at: "2025-01-02", time_precision: "date", source_timezone: "Asia/Shanghai", recorded_at: "2025-01-02T01:00:00Z" });
  assert.equal(proof([date], { cutoff_at: "2025-01-02T02:00:00Z" }).nav_quality, "provisional");
  assert.equal(proof([date], { period_start: START, mode: "as_known" }).nav_quality, "complete");
  const unknown = event("gross", "dividend_accrual", { amount: "200" });
  const confirmed = child("tax", "dividend_tax_assessment", { tax: "20", tax_status: "confirmed" }, 2, { effective_at: "2025-01-04T00:00:00Z" });
  assert.equal(proof([unknown, confirmed]).nav_quality, "complete");
  assert.equal(proof([unknown, confirmed], { period_start: START }).nav_quality, "provisional");
});

test("evidence hashes are canonical, immutable-source changes block, and malformed enums fail closed", () => {
  const row = event("div", "dividend", { amount: "200", tax: "0" });
  const good = proof([row]), { binding_id, ...rest } = good;
  assert.equal(binding_id, hash(rest));
  assert.equal(good.event_hashes.div, hash(row));
  assert.equal(proof([{ ...row, payload_hash: "0".repeat(64) }]).nav_quality, "blocked");
  assert.equal(proof([{ ...row, effective_at: "2025-01-03T00:00:00Z" }]).nav_quality, "blocked");
  assert.throws(() => buildLedgerFactQuality([event("bad", "dividend", { amount: "200", tax: "0", tax_status: "invented" })], input([row])), /FACT_QUALITY_EVIDENCE_INVALID/);
  assert.throws(() => buildLedgerFactQuality([], input([], { period_start: "2025-02-01T00:00:00Z" })), /INVALID_FACT_QUALITY_PERIOD/);
});

test("real ledger commands and correction reversals reproduce the independently derived balances and quality", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "fact-quality-ledger-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "workbench.db"); migrateWorkbench(filename);
  const db = new Database(filename); t.after(() => db.close()); db.pragma("foreign_keys=ON");
  const actor = { id: "synthetic-quality-owner" }, portfolio = createPortfolio(db, actor, "Synthetic quality", END);
  const account = createAccount(db, actor, portfolio, "Synthetic", "Fixture", "CNY", END);
  let sequence = 0;
  const record = (fact: Partial<Fact> & Pick<Fact, "type">) => {
    const command: LedgerCommand = { portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: `quality-${++sequence}`,
      source_id: "synthetic", source_event_id: `source-${sequence}`, effective_at: "2025-01-02T00:00:00.000Z", time_precision: "second", source_timezone: "UTC",
      reason: "Synthetic retained original", fact: { account_id: account, currency: "CNY", ...fact } };
    return recordFact(db, actor, command, END);
  };
  const read = () => proof(db.prepare("SELECT * FROM ledger_events WHERE portfolio_id=?").all(portfolio) as Row[], { portfolio_id: portfolio });
  const gross = record({ type: "dividend_accrual", amount: "200" });
  record({ type: "dividend_payment", related_event_id: gross.event_id, amount: "180" });
  assert.equal(read().dividends[0].receivable, "20");
  record({ type: "dividend_tax_assessment", related_event_id: gross.event_id, tax: "25", tax_status: "confirmed", evidence_reference: "Synthetic final tax" });
  let state = read().dividends[0];
  assert.deepEqual([state.cash_received, state.receivable, state.tax_payable], ["180", "0", "-5"]);
  record({ type: "dividend_tax_payment", related_event_id: gross.event_id, amount: "5", evidence_reference: "Synthetic actual deduction" });
  state = read().dividends[0];
  assert.deepEqual([state.cash_received, state.receivable, state.tax_payable], ["175", "0", "0"]);
  const cash = db.prepare("SELECT balance FROM account_projections WHERE account_id=? AND ledger_account='cash_settled'").get(account) as { balance: string };
  assert.equal(cash.balance, state.cash_received);
  const notice = record({ type: "corporate_action_notice", action_kind: "merger", evidence_reference: "Synthetic retained notice" });
  assert.equal(read().nav_quality, "blocked");
  const resolution = record({ type: "corporate_action_resolution", related_event_id: notice.event_id, resolution: "not_applicable", supporting_event_ids: [], evidence_reference: "Synthetic not applicable decision" });
  assert.equal(read().nav_quality, "complete");
  const attachment = storeJsonAttachment(db, actor, { portfolio_id: portfolio, account_id: account, raw: '{"evidence":"SYNTHETIC"}' }, { dataDir: directory, now: END });
  correctLedger(db, actor, { portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: "void-resolution", attachment_id: attachment.id,
    reason: "Synthetic invalidated resolution", changes: [{ action: "void", event_id: resolution.event_id }] }, { dataDir: directory, now: END });
  assert.equal(read().nav_quality, "blocked");
  assert.equal(read().dividends[0].cash_received, "175");
});

test("independent Python and TypeScript reducers produce byte-identical point and interval manifests", () => {
  assert.ok(crossCases.length >= 40);
  const script = `import json,sys\nfrom worker.accounting.fact_quality import evaluate_fact_quality\nitems=json.load(sys.stdin)\nprint(json.dumps([evaluate_fact_quality(item['events'],**item['input']) for item in items],sort_keys=True,separators=(',',':'),ensure_ascii=False))`;
  const python = JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", script], {
    cwd: rootPath, input: JSON.stringify(crossCases), encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  }));
  const typescript = crossCases.map(item => buildLedgerFactQuality(item.events, item.input));
  for (let index = 0; index < typescript.length; index++) assert.deepEqual(typescript[index], python[index], `cross-language case ${index}`);
});

test("v11 to v12 preserves all postings and adds only the tax-payable account with original guards", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "fact-quality-v12-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = loadMigrations().slice(0, 11), oldDirectory = path.join(directory, "migrations"), filename = path.join(directory, "workbench.db");
  mkdirSync(oldDirectory);
  for (const migration of previous) cpSync(path.join(migrationDirectory, migration.file), path.join(oldDirectory, migration.file));
  writeFileSync(path.join(oldDirectory, "manifest.json"), JSON.stringify({ format_version: 1, migrations: previous }));
  assert.equal(migrateWorkbench(filename, { directory: oldDirectory }).version, 11);
  let db = new Database(filename);
  db.pragma("foreign_keys=ON");
  db.prepare("INSERT INTO portfolios(id,name,created_at) VALUES('p','fixture',?)").run(START);
  db.prepare("INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES('a','p','fixture','synthetic','CNY',?)").run(START);
  db.prepare("INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,recorded_at,source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id) VALUES('e','p','a','dividend',?,?,'fixture','e',?,'{}',1,'fixture')").run(START, START, "0".repeat(64));
  db.prepare("INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES('old','e','a','CNY','cash_settled','12345678901234567890.000000000000000001')").run();
  const before = db.prepare("SELECT * FROM postings ORDER BY id").all();
  assert.throws(() => db.prepare("INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES('tax','e','a','CNY','dividend_tax_payable','-5')").run(), /CHECK/);
  db.close();
  const throughV12 = loadMigrations().slice(0, 12);
  cpSync(path.join(migrationDirectory, throughV12[11].file), path.join(oldDirectory, throughV12[11].file));
  writeFileSync(path.join(oldDirectory, "manifest.json"), JSON.stringify({ format_version: 1, migrations: throughV12 }));
  assert.equal(migrateWorkbench(filename, { directory: oldDirectory }).version, 12);
  db = new Database(filename); t.after(() => db.close()); db.pragma("foreign_keys=ON");
  assert.deepEqual(db.prepare("SELECT * FROM postings ORDER BY id").all(), before);
  db.prepare("INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES('tax','e','a','CNY','dividend_tax_payable','-5')").run();
  assert.throws(() => db.prepare("UPDATE postings SET amount='0' WHERE id='old'").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM postings WHERE id='tax'").run(), /append-only/);
  assert.throws(() => db.prepare("INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES('missing','absent','a','CNY','dividend_tax_payable','-5')").run(), /FOREIGN KEY/);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.equal(db.pragma("quick_check", { simple: true }), "ok");
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='postings_event'").get());
});
