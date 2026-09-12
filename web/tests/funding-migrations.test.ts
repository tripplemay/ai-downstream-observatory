import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadMigrations, migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { canonical, createAccount, createPortfolio, hash, recordFact } from "../src/server/ledger/service";
import { openWorkbench } from "../src/server/workbench-db";
import { getFundingState, linkFundingReceipt, publishFundingPlanVersion } from "../src/server/funding/service";

const now = "2026-06-01T00:00:00.000Z", actor = { id: "SYNTHETIC-MIGRATION", kind: "human" as const };

test("v8 to current schema preserves immutable ledger/legacy plan and creates no funding matches or real cash", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "funding-migration-")), filename = path.join(directory, "workbench.db");
  let db = new Database(filename);
  try {
    db.pragma("foreign_keys=ON"); db.pragma("journal_mode=WAL");
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,filename TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)");
    for (const migration of loadMigrations().slice(0, 8)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?,?,?)").run(migration.version, migration.file, migration.sha256, now);
      db.pragma(`user_version=${migration.version}`);
    }
    const portfolio = createPortfolio(db, actor, "Synthetic old plan", now), account = createAccount(db, actor, portfolio, "A", "Synthetic", "CNY", now);
    const legacyPlan = { initial_cny: "100", annual_cny: "25", contribution_count: 2, arrival: "year_start", years: [{ year: 1, planned_cny: "125" }, { year: 2, planned_cny: "25" }] };
    db.prepare("INSERT INTO funding_plan_versions(id,portfolio_id,version,currency,plan_json,content_hash,actor_id,created_at) VALUES(?,?,1,'CNY',?,?,?,?)").run(randomUUID(), portfolio, canonical(legacyPlan), hash(legacyPlan), actor.id, now);
    // Seed a historical v8 record without asking current application code to write an obsolete schema.
    const command = { portfolio_id: portfolio, expected_revision: 0, idempotency_key: randomUUID(), source_id: "synthetic", effective_at: "2026-01-01", time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Synthetic v8 fact", fact: { type: "deposit", account_id: account, currency: "CNY", amount: "12.345" } };
    const eventId = randomUUID();
    db.prepare("INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,time_precision,source_timezone,recorded_at,source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id,reason) VALUES(?,?,?,'deposit',?,'date','Asia/Shanghai',?,'synthetic',?,?,?,1,?,?)")
      .run(eventId, portfolio, account, command.effective_at, now, command.idempotency_key, hash(command), canonical(command), actor.id, command.reason);
    for (const [name, value] of [["cash_settled", "12.345"], ["external_capital", "-12.345"]]) {
      db.prepare("INSERT INTO postings VALUES(?,?,?,'CNY',?,?)").run(randomUUID(), eventId, account, name, value);
      db.prepare("INSERT INTO account_projections(account_id,currency,ledger_account,balance,ledger_revision) VALUES(?,'CNY',?,?,1)").run(account, name, value);
    }
    db.prepare("UPDATE ledger_heads SET revision=1 WHERE portfolio_id=?").run(portfolio);
    const before = Object.fromEntries(["funding_plan_versions", "ledger_events", "postings", "account_projections", "audit_events"].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    db.close(); migrateWorkbench(filename); db = openWorkbench(filename);
    for (const [table, rows] of Object.entries(before)) assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows);
    const state = getFundingState(db, actor, portfolio, { now });
    assert.equal(state.plan_status, "needs_review"); assert.equal(state.funding_revision, 0); assert.equal(state.links.length, 0); assert.equal(state.account_cash[0].available, "12.345");
    assert.equal(db.pragma("user_version", { simple: true }), loadMigrations().length); assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("v9 SQL scope guards reject cross-portfolio receipts and cross-currency tranche parents", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "funding-scope-")), filename = path.join(directory, "workbench.db");
  migrateWorkbench(filename); const db = openWorkbench(filename);
  try {
    const portfolio = createPortfolio(db, actor, "A", now), other = createPortfolio(db, actor, "B", now);
    const account = createAccount(db, actor, portfolio, "A", "Synthetic", "CNY", now), foreignAccount = createAccount(db, actor, other, "B", "Synthetic", "CNY", now);
    const record = (owner: string, account_id: string, currency: string) => recordFact(db, actor, { portfolio_id: owner, expected_revision: 0, idempotency_key: randomUUID(), source_id: "synthetic", effective_at: "2026-01-01", time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Synthetic", fact: { type: "deposit", account_id, currency, amount: "10" } }, now);
    const fact = record(portfolio, account, "USD"), foreign = record(other, foreignAccount, "CNY");
    const plan = { schema_version: 2, title: "Scope fixture", timezone: "Asia/Shanghai", sources: [{ id: "source", label: "Source", kind: "contribution", currency: "CNY", planned_amount: "10", period_start: "2026-01-01", period_end: "2026-12-31", expected_arrival_date: null, account_id: account, status: "planned" }], tranches: [] };
    const version = publishFundingPlanVersion(db, actor, { portfolio_id: portfolio, expected_funding_revision: 0, expected_ledger_revision: 1, idempotency_key: randomUUID(), reason: "Synthetic", plan, acknowledge_shortfall: false }, { now });
    const source = db.prepare("SELECT id FROM funding_plan_items WHERE plan_version_id=?").get(version.plan_version_id) as { id: string };
    const insert = db.prepare("INSERT INTO funding_plan_links(id,portfolio_id,plan_item_id,action,ledger_event_id,amount,currency,funding_revision,ledger_revision,actor_id,reason,created_at) VALUES(?,?,?,'receipt_attach',?,'1','CNY',2,1,?,'Synthetic',?)");
    for (const event of [foreign.event_id, fact.event_id]) assert.throws(() => insert.run(randomUUID(), portfolio, source.id, event, actor.id, now), /funding receipt scope mismatch/);
    assert.throws(() => db.prepare("INSERT INTO funding_plan_items(id,portfolio_id,plan_version_id,logical_id,kind,parent_key,currency,planned_amount,item_json) VALUES(?,?,?,'tranche','tranche','source','USD','1',?)").run(randomUUID(), portfolio, version.plan_version_id, canonical({})), /funding tranche source mismatch/);
    assert.throws(() => db.prepare("UPDATE funding_plan_heads SET revision=revision+2 WHERE portfolio_id=?").run(portfolio), /funding head revision/);
    assert.throws(() => db.prepare("DELETE FROM funding_plan_heads").run(), /cannot be deleted/);
    assert.throws(() => linkFundingReceipt(db, actor, { portfolio_id: other, expected_funding_revision: 0, expected_ledger_revision: 1, idempotency_key: randomUUID(), reason: "Synthetic", source_id: "source", ledger_event_id: foreign.event_id, amount: "1" }, { now }), /FUNDING_PLAN_REVIEW_REQUIRED/);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
