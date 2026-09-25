import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCsvTransaction } from "../src/server/csv-background/transaction-timing";
import type { CsvTransactionTiming } from "../src/server/csv-background/types";

function check(timing: CsvTransactionTiming, outcome: CsvTransactionTiming["outcome"]) {
  assert.equal(timing.schema_version, "csv-transaction-timing-v1");
  assert.equal(timing.outcome, outcome);
  for (const value of [timing.transaction_call_us, timing.begin_to_callback_us, timing.callback_us, timing.finalize_tail_us]) {
    assert.ok(Number.isSafeInteger(value) && value! >= 0);
  }
  assert.equal(timing.begin_to_callback_us! + timing.callback_us! + timing.finalize_tail_us!, timing.transaction_call_us);
}

test("CSV timing observes the outer transaction after commit without changing its result", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE facts(value INTEGER)");
    const seen: CsvTransactionTiming[] = [];
    const result = { value: "receipt" };
    assert.equal(runCsvTransaction(db, () => {
      assert.equal(db.inTransaction, true);
      db.transaction(() => db.prepare("INSERT INTO facts VALUES(1)").run())();
      return result;
    }, timing => { assert.equal(db.inTransaction, false); seen.push(timing); throw new Error("diagnostic failure"); }), result);
    assert.equal(seen.length, 1); check(seen[0], "returned");
    assert.deepEqual(db.prepare("SELECT * FROM facts").all(), [{ value: 1 }]);
    assert.equal(runCsvTransaction(db, () => 7), 7);
  } finally { db.close(); }
});

test("CSV timing preserves the original error and observes rollback", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE facts(value INTEGER)");
    const failure = new Error("original"), seen: CsvTransactionTiming[] = [];
    assert.throws(() => runCsvTransaction(db, () => { db.exec("INSERT INTO facts VALUES(1)"); throw failure; }, timing => {
      assert.equal(db.inTransaction, false); seen.push(timing); throw new Error("diagnostic failure");
    }), error => error === failure);
    assert.equal(seen.length, 1); check(seen[0], "threw");
    assert.deepEqual(db.prepare("SELECT * FROM facts").all(), []);
  } finally { db.close(); }
});

test("CSV timing reports a failed BEGIN without inventing callback or lock timing", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "csv-timing-"));
  const first = new Database(path.join(directory, "db.sqlite")), second = new Database(path.join(directory, "db.sqlite"), { timeout: 0 });
  try {
    first.exec("CREATE TABLE facts(value INTEGER)");
    first.exec("BEGIN IMMEDIATE");
    const seen: CsvTransactionTiming[] = [];
    assert.throws(() => runCsvTransaction(second, () => assert.fail("BEGIN must not enter callback"), timing => seen.push(timing)), /locked/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].outcome, "threw");
    assert.ok(Number.isSafeInteger(seen[0].transaction_call_us) && seen[0].transaction_call_us >= 0);
    assert.equal(seen[0].begin_to_callback_us, null); assert.equal(seen[0].callback_us, null); assert.equal(seen[0].finalize_tail_us, null);
  } finally { if (first.inTransaction) first.exec("ROLLBACK"); second.close(); first.close(); rmSync(directory, { recursive: true }); }
});

test("CSV timing never treats a nested savepoint as an outer writer transaction", () => {
  const db = new Database(":memory:");
  try {
    db.transaction(() => {
      assert.throws(() => runCsvTransaction(db, () => assert.fail("nested callback"), () => assert.fail("nested timing")), /INDEPENDENT_TRANSACTION_REQUIRED/);
    }).immediate();
  } finally { db.close(); }
});
