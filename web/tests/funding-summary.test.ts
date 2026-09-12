import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { canonical, createAccount, createPortfolio, hash, recordFact } from "../src/server/ledger/service";
import { workbenchState } from "../src/server/ledger/queries";
import { fundingSummary } from "../src/server/funding-summary";
import { currentPlan } from "../src/server/funding/core";
import { publishFundingPlanVersion, type FundingPlan } from "../src/server/funding/service";

const actor = { id: "SYNTHETIC-SUMMARY-TEST", kind: "human" as const };
const now = "2026-06-01T12:00:00.000Z";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "etf-funding-summary-"));
  const filename = path.join(directory, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, actor, "Synthetic summary only", now);
  const account = createAccount(db, actor, portfolio, "Empty synthetic account", "No broker", "CNY", now);
  const source = { kind: "contribution" as const, label: "Synthetic source", period_start: "2027-01-01", period_end: "2027-12-31", expected_arrival_date: null, account_id: null, status: "planned" as const };
  const plan: FundingPlan = { schema_version: 2, title: "Synthetic dated budget", timezone: "Asia/Shanghai", tranches: [], sources: [
    { ...source, id: "s1", currency: "CNY", planned_amount: "9007199254740993.01" },
    { ...source, id: "s2", currency: "CNY", planned_amount: "0.02" },
    { ...source, id: "s3", currency: "USD", planned_amount: "12.3", period_end: "2028-12-31" },
    { ...source, id: "s4", currency: "HKD", planned_amount: "999", status: "cancelled" },
  ] };
  const publish = () => publishFundingPlanVersion(db, actor, { portfolio_id: portfolio,
    expected_funding_revision: 0, expected_ledger_revision: 0, idempotency_key: randomUUID(),
    reason: "Synthetic summary verification", acknowledge_shortfall: false, plan }, { now });
  return { db, directory, portfolio, account, plan, publish, state: () => workbenchState(db, actor, portfolio),
    close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("funding summary reports a new portfolio as not configured, without inventing a plan", () => {
  const f = fixture();
  try {
    assert.equal(fundingSummary(f.db, null, null).status, "not_configured");
    const state = f.state();
    assert.equal(state.funding_summary.status, "not_configured");
    assert.deepEqual(state.funding_summary.totals, []);
    assert.equal(state.funding_summary.funding_revision, 0);
    assert.equal(state.plan, null);
  } finally { f.close(); }
});

test("retained legacy relative plans still require review and creating another portfolio leaves them unchanged", () => {
  const f = fixture();
  try {
    const plan = { initial_cny: "100", annual_cny: "25", contribution_count: 2, arrival: "year_start", years: [{ year: 1, planned_cny: "125" }, { year: 2, planned_cny: "25" }] };
    f.db.prepare("INSERT INTO funding_plan_versions(id,portfolio_id,version,currency,plan_json,content_hash,actor_id,created_at) VALUES(?,?,1,'CNY',?,?,?,?)").run(randomUUID(), f.portfolio, canonical(plan), hash(plan), actor.id, now);
    const before = f.db.prepare("SELECT * FROM funding_plan_versions").all();
    const other = createPortfolio(f.db, actor, "Another synthetic empty portfolio", now);
    assert.deepEqual(f.db.prepare("SELECT * FROM funding_plan_versions").all(), before);
    assert.equal(f.db.prepare("SELECT 1 FROM funding_plan_versions WHERE portfolio_id=?").get(other), undefined);
    const result = f.state().funding_summary;
    assert.equal(result.status, "needs_review"); assert.deepEqual(result.totals, []);
  } finally { f.close(); }
});

test("funding summary verifies the confirmed version and sums exact currencies without mixing them", () => {
  const f = fixture();
  try {
    f.publish();
    const result = f.state().funding_summary;
    assert.equal(result.status, "confirmed_plan"); assert.equal(result.version, 1); assert.equal(result.funding_revision, 1);
    assert.equal(result.source_count, 3); assert.equal(result.period_end, "2028-12-31");
    assert.deepEqual(result.totals, [{ currency: "CNY", planned_amount: "9007199254740993.03" }, { currency: "USD", planned_amount: "12.3" }]);
  } finally { f.close(); }
});

test("corrupt plan hash, items or JSON fail closed without breaking the rest of the ledger read", () => {
  for (const defect of ["hash", "item", "json"] as const) {
    const f = fixture();
    try {
      f.publish();
      recordFact(f.db, actor, { portfolio_id: f.portfolio, expected_revision: 0, idempotency_key: randomUUID(),
        source_id: "synthetic-only", effective_at: now, time_precision: "second", source_timezone: "UTC",
        reason: "Synthetic ledger remains readable", fact: { type: "deposit", account_id: f.account, currency: "CNY", amount: "1" } }, now);
      // Deliberate corruption of an isolated temporary DB, not a supported write path.
      if (defect === "item") {
        f.db.exec("DROP TRIGGER funding_item_no_update");
        f.db.prepare("UPDATE funding_plan_items SET planned_amount='2' WHERE logical_id='s2'").run();
      } else {
        f.db.exec("DROP TRIGGER funding_plan_no_update");
        f.db.prepare(defect === "hash"
          ? "UPDATE funding_plan_versions SET content_hash=? WHERE version=1"
          : "UPDATE funding_plan_versions SET plan_json=? WHERE version=1").run(defect === "hash" ? "0".repeat(64) : "not json: private detail");
      }
      assert.throws(() => currentPlan(f.db, f.portfolio));
      const state = f.state();
      assert.equal(state.funding_summary.status, "needs_review", defect);
      assert.deepEqual(state.funding_summary.totals, [], defect);
      assert.equal(state.funding_summary.review_reason, "FUNDING_PLAN_INTEGRITY_FAILED", defect);
      assert.equal(state.funding_summary.title, null);
      assert.equal(state.accounts[0].id, f.account);
      assert.equal(state.events.length, 1);
      assert.equal(state.revision, 1);
      assert.equal(state.plan?.version, 1);
      if (defect === "json") assert.equal(state.plan?.plan_json, "not json: private detail");
      assert.equal(JSON.stringify(state.funding_summary).includes("private detail"), false);
    } finally { f.close(); }
  }
});

test("funding summary remains readable while the restore marker keeps all workbench writes disabled", () => {
  const f = fixture();
  try {
    f.publish();
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "Synthetic restore marker");
    const state = f.state();
    assert.equal(state.read_only, true);
    assert.equal(state.funding_summary.status, "confirmed_plan");
    assert.equal(state.plan?.version, 1);
  } finally { f.close(); }
});
