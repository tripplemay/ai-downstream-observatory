import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, getActiveLedgerEvents, recordFact, revision, type LedgerCommand } from "../src/server/ledger/service";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { correctLedger } from "../src/server/ledger/corrections";
import { executeFundingCommand } from "../src/server/funding-commands";
import { deferFundingTranche, getFundingState, isFundingClientError, linkFundingReceipt, publishFundingPlanVersion, unlinkFundingReceipt, type FundingPlan } from "../src/server/funding/service";
import { fundingTransaction } from "../src/server/funding/core";

const actor = { id: "SYNTHETIC-FUNDING-TEST", kind: "human" as const }, now = "2026-06-01T12:00:00.000Z";
export function fundingFixture() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "etf-funding-test-")), filename = path.join(dataDir, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, actor, "Synthetic funding only", now);
  const account = createAccount(db, actor, portfolio, "Synthetic A", "No broker", "CNY", now);
  const options = { now, dataDir };
  const state = () => getFundingState(db, actor, portfolio, options);
  const envelope = () => ({ portfolio_id: portfolio, expected_funding_revision: state().funding_revision, expected_ledger_revision: revision(db, portfolio), idempotency_key: randomUUID(), reason: "Synthetic planning test only" });
  const plan: FundingPlan = { schema_version: 2, title: "Synthetic plan, not actual money", timezone: "Asia/Shanghai", sources: [
    { id: "initial", label: "Initial", kind: "initial", currency: "CNY", planned_amount: "1000", period_start: "2026-01-01", period_end: "2026-12-31", expected_arrival_date: "2026-01-01", account_id: account, status: "planned" },
    { id: "annual", label: "Contribution", kind: "contribution", currency: "CNY", planned_amount: "500", period_start: "2026-01-01", period_end: "2026-12-31", expected_arrival_date: null, account_id: null, status: "planned" },
  ], tranches: [{ id: "batch1", source_id: "initial", label: "First batch", planned_amount: "600", account_id: account, invest_by: "2026-05-01", unspent_action: "Human review; no automatic trade", status: "planned" }] };
  const publish = (value = plan, acknowledge_shortfall = false) => publishFundingPlanVersion(db, actor, { ...envelope(), plan: value, acknowledge_shortfall }, options);
  const record = (fact: LedgerCommand["fact"], effective_at = "2026-01-01", source_timezone = "Asia/Shanghai", time_precision: "date" | "second" = "date") => recordFact(db, actor, { portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: randomUUID(), source_id: "synthetic-only", effective_at, source_timezone, time_precision, fact, reason: "Synthetic actual ledger fixture" }, now);
  const receipt = (source_id: string, ledger_event_id: string, amount: string) => linkFundingReceipt(db, actor, { ...envelope(), source_id, ledger_event_id, amount }, options);
  return { db, filename, dataDir, portfolio, account, options, plan, envelope, state, publish, record, receipt, close: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test("P04 new portfolio has no default plan; publishing explicit dates creates no actual capital", () => {
  const f = fundingFixture();
  try {
    assert.equal(f.state().plan_status, "not_configured"); assert.equal(f.state().plan, null);
    assert.deepEqual(f.state().account_cash, []); assert.equal(f.state().funding_revision, 0);
    assert.equal(f.state().accounts[0].id, f.account);
    const result = f.publish();
    assert.equal(result.funding_revision, 1); assert.equal(result.ledger_revision, 0);
    assert.equal(f.state().plan_status, "confirmed_plan"); assert.equal(f.state().sources[0].matched_amount, "0");
    assert.equal(f.state().sources[0].planned_unallocated, "400"); assert.equal(f.state().tranches[0].due_status, "overdue");
    assert.equal(f.state().sources[1].due_status, "needs_schedule");
    assert.equal(getActiveLedgerEvents(f.db, f.portfolio).length, 0);
    for (const table of ["reservations", "ledger_events", "postings"]) assert.equal((f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n, 0);
    assert.equal(f.state().versions.length, 1); assert.equal(f.state().versions[0].version, 1);
  } finally { f.close(); }
});

test("funding commands are strict human-only CAS and semantic-idempotent independently of ledger", () => {
  const f = fundingFixture();
  try {
    const input = { ...f.envelope(), plan: f.plan, acknowledge_shortfall: false };
    for (const kind of ["ai", "worker", "strategy"] as const) assert.throws(() => publishFundingPlanVersion(f.db, { ...actor, kind }, input, f.options), /FUNDING_PERMISSION_DENIED/);
    assert.throws(() => publishFundingPlanVersion(f.db, { id: "", kind: "human" }, input, f.options), /UNAUTHENTICATED/);
    assert.throws(() => executeFundingCommand(f.db, actor, { operation: "publish_plan", command: input, actor }, f.options));
    assert.throws(() => publishFundingPlanVersion(f.db, actor, { ...input, unknown: true }, f.options));
    const first = publishFundingPlanVersion(f.db, actor, input, f.options);
    assert.equal(publishFundingPlanVersion(f.db, actor, { ...input, expected_funding_revision: 99, expected_ledger_revision: 99 }, f.options).duplicate, true);
    assert.throws(() => publishFundingPlanVersion(f.db, actor, { ...input, reason: "different" }, f.options), /DUPLICATE_CONFLICT/);
    assert.throws(() => publishFundingPlanVersion(f.db, actor, { ...input, idempotency_key: randomUUID() }, f.options), /FUNDING_VERSION_CONFLICT/);
    const stale = f.envelope();
    f.record({ type: "deposit", account_id: f.account, currency: "CNY", amount: "1" });
    assert.throws(() => publishFundingPlanVersion(f.db, actor, { ...stale, plan: f.plan, acknowledge_shortfall: false }, f.options), /FUNDING_VERSION_CONFLICT/);
    assert.equal(f.state().funding_revision, first.funding_revision);
    assert.equal(isFundingClientError("UNIQUE constraint failed: private_data"), false);
  } finally { f.close(); }
});

test("plan semantics reject wrong scopes, invalid dates, floats, duplicate identities and overassigned budgets", () => {
  const f = fundingFixture();
  try {
    const invalid = (change: (plan: FundingPlan) => void, expected: RegExp = /./) => { const p = structuredClone(f.plan); change(p); assert.throws(() => f.publish(p), expected); };
    invalid(p => p.sources[0].planned_amount = "-1");
    invalid(p => p.sources[0].planned_amount = 1 as unknown as string);
    invalid(p => p.sources[0].planned_amount = "Infinity");
    invalid(p => p.sources[0].period_start = "2026-02-30");
    invalid(p => p.sources[0].period_end = "2025-01-01", /FUNDING_INVALID_PERIOD/);
    invalid(p => p.sources[0].account_id = "other", /ACCOUNT_OUT_OF_SCOPE/);
    invalid(p => p.tranches[0].id = "initial", /FUNDING_DUPLICATE_ITEM/);
    invalid(p => p.tranches[0].planned_amount = "1000.000000000000000001", /FUNDING_TRANCHE_BUDGET_EXCEEDED/);
    invalid(p => p.tranches[0].source_id = "missing", /FUNDING_INVALID_SOURCE/);
    f.publish();
    invalid(p => p.sources.splice(1), /FUNDING_ITEM_REMOVAL_FORBIDDEN/);
    invalid(p => p.sources[0].status = "cancelled", /FUNDING_CANCEL_DEPENDENCIES/);
    assert.equal(f.state().funding_revision, 1);
  } finally { f.close(); }
});

test("initial capital may be opening cash or a later deposit; actual receipt classification is preserved", () => {
  const f = fundingFixture();
  try {
    f.publish();
    const opening = f.record({ type: "opening_cash", account_id: f.account, currency: "CNY", amount: "800" });
    const deposit = f.record({ type: "deposit", account_id: f.account, currency: "CNY", amount: "500" }, "2026-01-02");
    f.receipt("initial", opening.event_id, "800"); f.receipt("initial", deposit.event_id, "200"); f.receipt("annual", deposit.event_id, "300");
    const state = f.state();
    assert.equal(state.sources[0].matched_amount, "1000"); assert.equal(state.sources[0].opening_amount, "800"); assert.equal(state.sources[0].contribution_amount, "200");
    assert.equal(state.sources[0].due_status, "funded"); assert.equal(state.sources[1].matched_amount, "300");
    assert.equal(state.account_cash[0].settled, "1300"); assert.equal(state.account_cash[0].available, "1300");
    assert.equal(state.matchable_facts.find(row => row.id === deposit.event_id)!.remaining_amount, "0");
    assert.throws(() => f.receipt("annual", deposit.event_id, "0.000000000000000001"), /FUNDING_RECEIPT_OVERALLOCATED/);
    assert.throws(() => f.receipt("annual", opening.event_id, "1"), /FUNDING_RECEIPT_TYPE_MISMATCH/);
  } finally { f.close(); }
});

test("receipt links are append-only, exact, scoped and reversible without changing cash", () => {
  const f = fundingFixture();
  try {
    f.publish(); const fact = f.record({ type: "deposit", account_id: f.account, currency: "CNY", amount: "0.3" });
    const first = f.receipt("annual", fact.event_id, "0.1"); f.receipt("annual", fact.event_id, "0.2");
    assert.equal(f.state().sources[1].matched_amount, "0.3");
    assert.throws(() => f.receipt("annual", fact.event_id, "0"), /FUNDING_POSITIVE_AMOUNT_REQUIRED/);
    assert.throws(() => f.db.prepare("UPDATE funding_plan_links SET amount='100' WHERE id=?").run(first.id), /append-only/);
    assert.throws(() => f.db.prepare("DELETE FROM funding_plan_items").run(), /append-only/);
    const before = revision(f.db, f.portfolio);
    const input = { ...f.envelope(), link_id: first.id };
    unlinkFundingReceipt(f.db, actor, input, f.options);
    assert.equal(unlinkFundingReceipt(f.db, actor, input, f.options).duplicate, true);
    assert.equal(revision(f.db, f.portfolio), before); assert.equal(f.state().account_cash[0].available, "0.3");
    assert.equal(f.state().sources[1].matched_amount, "0.2"); assert.equal(f.state().matchable_facts[0].remaining_amount, "0.1");
    assert.equal(f.state().link_history.length, 3); assert.equal(f.state().links.find(row => row.id === first.id)!.status, "released");
    assert.throws(() => unlinkFundingReceipt(f.db, actor, { ...f.envelope(), link_id: first.id }, f.options), /FUNDING_LINK_ALREADY_RELEASED/);
  } finally { f.close(); }
});

test("FX is not an arrival; currency, date certainty and portfolio scope constrain receipt matching", () => {
  const f = fundingFixture();
  try {
    f.publish();
    const usd = f.record({ type: "deposit", account_id: f.account, currency: "USD", amount: "10" });
    assert.throws(() => f.receipt("annual", usd.event_id, "1"), /FUNDING_CURRENCY_MISMATCH/);
    const zoned = f.record({ type: "deposit", account_id: f.account, currency: "CNY", amount: "10" }, "2026-01-02", "America/New_York");
    assert.throws(() => f.receipt("annual", zoned.event_id, "1"), /FUNDING_DATE_SCOPE_UNCERTAIN/);
    const precise = f.record({ type: "deposit", account_id: f.account, currency: "CNY", amount: "10" }, "2026-01-03T02:00:00.000Z", "UTC", "second");
    f.receipt("annual", precise.event_id, "1");
    const fx = f.record({ type: "fx", account_id: f.account, currency: "CNY", target_currency: "USD", amount: "7", received_amount: "1" }, "2026-01-04");
    assert.throws(() => f.receipt("annual", fx.event_id, "1"), /FUNDING_RECEIPT_SUPERSEDED/);
    const before = structuredClone(f.state().plan!); before.sources[1].period_start = "2026-02-01";
    assert.throws(() => f.publish(before), /FUNDING_LINKED_ITEM_CHANGED/);
    const other = createPortfolio(f.db, actor, "Other", now), account = createAccount(f.db, actor, other, "Other", "Synthetic", "CNY", now);
    const out = recordFact(f.db, actor, { portfolio_id: other, expected_revision: 0, idempotency_key: randomUUID(), source_id: "synthetic", effective_at: "2026-01-01", time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Synthetic", fact: { type: "deposit", account_id: account, currency: "CNY", amount: "10" } }, now);
    assert.throws(() => f.receipt("annual", out.event_id, "1"), /FUNDING_RECEIPT_SUPERSEDED/);
    assert.equal(f.state().matchable_facts.some(row => row.id === out.event_id), false);
  } finally { f.close(); }
});

test("corrected receipt is visibly invalidated and never retargeted or counted again automatically", () => {
  const f = fundingFixture();
  try {
    f.publish(); const original = f.record({ type: "deposit", account_id: f.account, currency: "CNY", amount: "100" });
    const link = f.receipt("annual", original.event_id, "100");
    const attachment = storeJsonAttachment(f.db, actor, { portfolio_id: f.portfolio, account_id: f.account, raw: '{"synthetic_correction":true}' }, f.options);
    correctLedger(f.db, actor, { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: randomUUID(), attachment_id: attachment.id, reason: "Synthetic receipt correction", changes: [{ action: "replace", event_id: original.event_id, replacement: { effective_at: "2026-01-01", time_precision: "date", source_timezone: "Asia/Shanghai", fact: { type: "deposit", account_id: f.account, currency: "CNY", amount: "80" } } }] }, f.options);
    const state = f.state(); assert.equal(state.links[0].status, "needs_review"); assert.equal(state.sources[1].matched_amount, "0");
    assert.equal(state.sources[1].needs_review_count, 1); assert.equal(state.account_cash[0].available, "80");
    assert.throws(() => f.receipt("annual", original.event_id, "1"), /FUNDING_RECEIPT_SUPERSEDED/);
    unlinkFundingReceipt(f.db, actor, { ...f.envelope(), link_id: link.id }, f.options);
    f.receipt("annual", state.matchable_facts[0].id, "80"); assert.equal(f.state().sources[1].matched_amount, "80");
  } finally { f.close(); }
});

test("defer appends exact deadline history; acknowledged lower budget never edits receipts", () => {
  const f = fundingFixture();
  try {
    f.publish(); const fact = f.record({ type: "deposit", account_id: f.account, currency: "CNY", amount: "700" }); f.receipt("initial", fact.event_id, "700");
    const input = { ...f.envelope(), tranche_id: "batch1", invest_by: "2026-07-01", unspent_action: "Explicit human review, no buying instruction" };
    const result = deferFundingTranche(f.db, actor, input, f.options);
    assert.equal(result.previous_invest_by, "2026-05-01"); assert.equal(f.state().plan!.tranches[0].invest_by, "2026-07-01");
    assert.equal((f.state().versions[1].plan as FundingPlan).tranches[0].invest_by, "2026-05-01");
    assert.throws(() => deferFundingTranche(f.db, actor, { ...f.envelope(), tranche_id: "batch1", invest_by: "2026-06-02", unspent_action: "review" }, f.options), /FUNDING_DEFER_MUST_BE_FUTURE/);
    const reduced = structuredClone(f.state().plan!); reduced.sources[0].planned_amount = "650";
    assert.throws(() => f.publish(reduced), /FUNDING_ACKNOWLEDGEMENT_REQUIRED/);
    f.publish(reduced, true); assert.equal(f.state().sources[0].excess_arrival, "50"); assert.equal(f.state().account_cash[0].available, "700");
    assert.equal(revision(f.db, f.portfolio), 1);
  } finally { f.close(); }
});

test("recovery guard rejects writes on existing connection and rechecks before commit; GET remains read-only", () => {
  const f = fundingFixture();
  try {
    f.publish(); const marker = path.join(f.dataDir, "RESTORE_PENDING_REVIEW");
    const before = f.state();
    assert.throws(() => fundingTransaction(f.db, actor, "test_guard", f.envelope(), f.options, () => {
      writeFileSync(marker, "SYNTHETIC recovery drill");
      return { plan_version_id: (f.db.prepare("SELECT current_version_id FROM funding_plan_heads WHERE portfolio_id=?").get(f.portfolio) as { current_version_id: string }).current_version_id };
    }), /WORKBENCH_READ_ONLY/);
    assert.equal(f.state().read_only, true); assert.equal(f.state().funding_revision, before.funding_revision);
    assert.throws(() => f.publish(), /WORKBENCH_READ_ONLY/);
    const readOnly = openWorkbench(f.filename);
    try { assert.equal(getFundingState(readOnly, actor, f.portfolio, f.options).read_only, true); } finally { readOnly.close(); }
  } finally { f.close(); }
});

test("two independent processes cannot overallocate the same receipt or lose funding revisions", async () => {
  const f = fundingFixture();
  try {
    f.publish(); const fact = f.record({ type: "deposit", account_id: f.account, currency: "CNY", amount: "100" });
    const start = Date.now() + 400, run = promisify(execFile);
    const commands = ["initial", "annual"].map(source_id => ({ ...f.envelope(), source_id, ledger_event_id: fact.event_id, amount: "60" }));
    const outputs = await Promise.all(commands.map(command => run(process.execPath, ["--import", "tsx", "tests/funding-race-worker.ts", f.filename, String(start), JSON.stringify(command)], { cwd: process.cwd() })));
    const results = outputs.map(output => JSON.parse(output.stdout) as { ok: boolean; error?: string });
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.find(result => !result.ok)!.error, "FUNDING_VERSION_CONFLICT");
    const rejected = commands[results.findIndex(result => !result.ok)];
    assert.throws(() => linkFundingReceipt(f.db, actor, { ...rejected, ...f.envelope() }, f.options), /FUNDING_RECEIPT_OVERALLOCATED/);
    assert.equal(f.state().funding_revision, 2); assert.equal(f.state().matchable_facts[0].remaining_amount, "40");
  } finally { f.close(); }
});
