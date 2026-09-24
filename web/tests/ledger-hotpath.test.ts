import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, recordFact, revision, validateLedgerTime, type LedgerCommand } from "../src/server/ledger/service";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ledger-hotpath-")), filename = path.join(directory, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), actor = { id: "synthetic-owner" };
  const portfolio = createPortfolio(db, actor, "Synthetic"), account = createAccount(db, actor, portfolio, "A", "Synthetic", "CNY");
  const command = (key: string): LedgerCommand => ({ portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: key,
    source_id: "synthetic", source_event_id: key, effective_at: "2026-01-01", time_precision: "date", source_timezone: "UTC",
    reason: "Synthetic cache regression", fact: { type: "deposit", account_id: account, currency: "CNY", amount: "1.25" } });
  return { db, actor, portfolio, account, command, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("ledger hot path reuses compiled SQL without retaining reads or bindings across rollback", t => {
  const f = fixture();
  try {
    const calls = new Map<string, number>(), prepare = f.db.prepare.bind(f.db);
    t.mock.method(f.db, "prepare", (sql: string) => { calls.set(sql, (calls.get(sql) ?? 0) + 1); return prepare(sql); });
    const one = recordFact(f.db, f.actor, f.command("one"));
    const rolledBack = f.command("rollback");
    assert.throws(() => f.db.transaction(() => { recordFact(f.db, f.actor, rolledBack); throw new Error("rollback fixture"); })(), /rollback fixture/);
    assert.equal(revision(f.db, f.portfolio), 1);
    const two = recordFact(f.db, f.actor, rolledBack);
    assert.equal(two.revision, 2); assert.notEqual(two.event_id, one.event_id);
    assert.equal(recordFact(f.db, f.actor, { ...rolledBack, expected_revision: 0 }).event_id, two.event_id);
    const sourceDuplicate = recordFact(f.db, f.actor, { ...rolledBack, idempotency_key: "source-alias", expected_revision: 0 });
    assert.equal(sourceDuplicate.event_id, two.event_id); assert.equal(sourceDuplicate.duplicate, true);
    assert.equal(revision(f.db, f.portfolio), 2);
    assert.equal((prepare("SELECT balance FROM account_projections WHERE account_id=? AND ledger_account='cash_settled'").get(f.account) as { balance: string }).balance, "2.5");
    for (const sql of [
      "SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?",
      "INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)",
      "INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES(?,?,?,?,?,?)",
    ]) assert.equal(calls.get(sql), 1, sql);
  } finally { f.close(); }
});

test("compiled ledger statements remain connection scoped and revalidate changed schema guards", () => {
  const a = fixture(), b = fixture();
  try {
    recordFact(a.db, a.actor, a.command("first"));
    recordFact(b.db, b.actor, b.command("first"));
    a.db.exec("CREATE TRIGGER synthetic_block_fact BEFORE INSERT ON ledger_events BEGIN SELECT RAISE(ABORT, 'synthetic guard'); END");
    assert.throws(() => recordFact(a.db, a.actor, a.command("second")), /synthetic guard/);
    assert.equal(revision(a.db, a.portfolio), 1);
    assert.equal(recordFact(b.db, b.actor, b.command("second")).revision, 2);
    a.db.exec("DROP TRIGGER synthetic_block_fact");
    assert.equal(recordFact(a.db, a.actor, a.command("second")).revision, 2);
  } finally { a.close(); b.close(); }
});

test("warm ledger statements observe another connection and do not bypass a recovery lock", () => {
  const f = fixture(), other = openWorkbench(f.db.name);
  try {
    recordFact(f.db, f.actor, f.command("first"));
    recordFact(other, f.actor, f.command("external"));
    assert.equal(revision(f.db, f.portfolio), 2);
    assert.equal(recordFact(f.db, f.actor, f.command("third")).revision, 3);
    assert.throws(() => recordFact(f.db, f.actor, { ...f.command("third"), fact: { type: "deposit", account_id: f.account, currency: "CNY", amount: "2" } }), /DUPLICATE_CONFLICT/);
    assert.equal(recordFact(f.db, f.actor, f.command("fourth")).revision, 4);
    writeFileSync(path.join(path.dirname(f.db.name), "RESTORE_PENDING_REVIEW"), "Synthetic recovery lock");
    assert.throws(() => recordFact(f.db, f.actor, f.command("blocked")), /WORKBENCH_READ_ONLY/);
    assert.equal(revision(f.db, f.portfolio), 4);
  } finally { other.close(); f.close(); }
});

test("time validation keeps date-only timezone boundaries, clock changes and invalid input checks", () => {
  const command = { effective_at: "2026-01-02", time_precision: "date", source_timezone: "Asia/Shanghai" } as LedgerCommand;
  validateLedgerTime(command, "2026-01-01T16:00:00Z");
  assert.throws(() => validateLedgerTime(command, "2026-01-01T15:59:59Z"), /FUTURE_FACT_NOT_ALLOWED/);
  assert.throws(() => validateLedgerTime({ ...command, source_timezone: "America/New_York" }, "2026-01-02T00:00:00Z"), /FUTURE_FACT_NOT_ALLOWED/);
  validateLedgerTime({ ...command, source_timezone: "America/New_York" }, "2026-01-02T05:00:00Z");
  for (let i = 0; i < 2; i++) {
    assert.throws(() => validateLedgerTime({ ...command, source_timezone: "Synthetic/Invalid" }, "2026-01-03T00:00:00Z"), /INVALID_SOURCE_TIMEZONE/);
    assert.throws(() => validateLedgerTime(command, "invalid"), /INVALID_CLOCK/);
    assert.throws(() => validateLedgerTime({ ...command, effective_at: "2026-02-30" }, "2026-03-10T00:00:00Z"), /INVALID_EFFECTIVE_TIME/);
  }
  const second = { ...command, time_precision: "second" as const, effective_at: "2026-01-01T10:00:00Z" };
  validateLedgerTime(second, "2026-01-01T10:00:00Z");
  assert.throws(() => validateLedgerTime(second, "2026-01-01T09:59:59Z"), /FUTURE_FACT_NOT_ALLOWED/);
  assert.throws(() => validateLedgerTime({ ...second, source_timezone: "Synthetic/Invalid" }, "2026-01-03T00:00:00Z"), /INVALID_SOURCE_TIMEZONE/);
});

test("timezone formatter reuse is bounded and keeps daylight-saving date boundaries", t => {
  const Original = Intl.DateTimeFormat, calls: string[] = [];
  t.mock.method(Intl, "DateTimeFormat", function (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    calls.push(options?.timeZone ?? ""); return new Original(locales, options);
  });
  const zones = Intl.supportedValuesOf("timeZone").slice(0, 70);
  assert.equal(zones.length, 70);
  const command = { effective_at: "2026-01-01", time_precision: "date", source_timezone: "UTC" } as LedgerCommand;
  for (const zone of zones) validateLedgerTime({ ...command, source_timezone: zone }, "2026-09-01T00:00:00Z");
  calls.length = 0;
  validateLedgerTime({ ...command, source_timezone: zones.at(-1)! }, "2026-09-01T00:00:00Z");
  validateLedgerTime({ ...command, source_timezone: zones[6] }, "2026-09-01T00:00:00Z");
  assert.deepEqual(calls, []);
  validateLedgerTime({ ...command, source_timezone: zones[5] }, "2026-09-01T00:00:00Z");
  assert.deepEqual(calls, [zones[5]]);
  validateLedgerTime({ ...command, source_timezone: zones[6] }, "2026-09-01T00:00:00Z");
  assert.deepEqual(calls, [zones[5], zones[6]]);
  const local = { ...command, effective_at: "2026-03-09", source_timezone: "America/New_York" };
  assert.throws(() => validateLedgerTime(local, "2026-03-09T03:59:59Z"), /FUTURE_FACT_NOT_ALLOWED/);
  validateLedgerTime(local, "2026-03-09T04:00:00Z");
});
