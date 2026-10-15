import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { getCashRecordingContext } from "../src/server/investor/cash-recording";
import { cashRecordingIntentSchema, type CashRecordingIntent } from "../src/server/investor/cash-recording-schemas";
import { tradeRecordingIntentSchema } from "../src/server/investor/trade-recording-schemas";
import { getInvestorReconciliationContext } from "../src/server/investor/reconciliation";
import { createAccount, createPortfolio, recordFact, revision } from "../src/server/ledger/service";
import { correctLedger } from "../src/server/ledger/corrections";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { investorHoldingsFixture, holdingsNow as now } from "./investor-holdings-fixture";

type Fixture = ReturnType<typeof investorHoldingsFixture>;
const protectedTables = ["position_movements", "position_projections", "approval_events", "activations", "reservations", "execution_reports",
  "investor_profiles", "investor_funding_plans", "investor_models", "investor_ai_requests", "outbox", "job_runs"];
const facts = ["ledger_events", "postings", "account_projections", "ledger_heads", "accounts", "command_dedup", "investor_commands", "investor_workspaces", "audit_events"];
function rows(f: Fixture, tables = facts) { return tables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }
function context(f: Fixture) { return getCashRecordingContext(f.db, f.actor, f.account, now); }
function intent(f: Fixture, currency: "CNY" | "HKD" | "USD" = "CNY", type: "deposit" | "withdrawal" = "deposit", source = "fictional-deposit"): CashRecordingIntent {
  const c = context(f);
  return cashRecordingIntentSchema.parse({ action: "record_linked_cash_fact", portfolio_id: c.portfolio_id, account_id: c.account_id,
    expected_ledger_revision: c.ledger_revision, expected_account_row_version: c.account_row_version,
    expected_link_id: c.link_id, expected_link_version: c.link_version, expected_context_hash: c.context_hash,
    basis: "operator_external_cash_transcription_not_broker_file", acknowledgement: true,
    source_id: "FICTIONAL-CASH", source_event_id: source, source_reference: "Fictional external cash transcription only",
    effective_date: "2026-01-02", source_timezone: "Asia/Shanghai", entry: { type, currency, amount: "300.01" } });
}
function submit(f: Fixture, input = intent(f), key = "cash-command", expected?: number) {
  return executeInvestorCommand(f.db, f.actor, { ...input, idempotency_key: key,
    expected_revision: expected ?? getInvestorState(f.db, f.actor, now).revision }, now);
}
function balance(f: Fixture, currency: string, ledger = "cash_settled") {
  return (f.db.prepare("SELECT balance FROM account_projections WHERE account_id=? AND currency=? AND ledger_account=?")
    .get(f.account, currency, ledger) as { balance: string } | undefined)?.balance ?? "0";
}

test("cash context is scoped read-only metadata, with no plan, cash, date or amount defaults", () => {
  const f = investorHoldingsFixture(); try {
    const foreign = createPortfolio(f.db, { id: "fictional-foreign" }, "Fictional foreign", now);
    const account = createAccount(f.db, { id: "fictional-foreign" }, foreign, "Fictional", "Fictional", "USD", now);
    const before = rows(f), count = f.db.prepare("SELECT total_changes() n").get(), c = context(f);
    assert.deepEqual(rows(f), before); assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), count);
    assert.deepEqual(c.allowed_currencies, ["CNY", "HKD", "USD"]); assert.equal(c.execution_authorized, false);
    assert.doesNotMatch(JSON.stringify(c), /"(?:amount|balance|budget|planned|quantity|price|fee|effective_date)"/);
    assert.throws(() => getCashRecordingContext(f.db, f.actor, account, now), /OUT_OF_SCOPE/);
    assert.throws(() => getCashRecordingContext(f.db, { id: "fictional-foreign" }, f.account, now), /OUT_OF_SCOPE/);
  } finally { f.close(); }
});

test("explicit external cash changes exact currency cash and external capital, invalidates reconciliation, never creates securities or authority", () => {
  const f = investorHoldingsFixture(); try {
    f.reconcile(); const before = rows(f, protectedTables), start = context(f);
    for (const currency of ["CNY", "HKD", "USD"] as const) {
      const prior = balance(f, currency), addition = intent(f, currency, "deposit", "in-" + currency), receipt = submit(f, addition, "in-" + currency);
      const posting = f.db.prepare("SELECT ledger_account,amount FROM postings WHERE event_id=? ORDER BY ledger_account").all(receipt.resource_id);
      assert.deepEqual(posting, [{ ledger_account: "cash_settled", amount: "300.01" }, { ledger_account: "external_capital", amount: "-300.01" }]);
      const out = intent(f, currency, "withdrawal", "out-" + currency); out.entry.amount = "300.01";
      submit(f, out, "out-" + currency); assert.equal(balance(f, currency), prior);
    }
    const end = context(f); assert.equal(end.ledger_revision, start.ledger_revision + 6);
    assert.equal(end.workspace_revision, start.workspace_revision + 6); assert.equal(end.account_status, "reconciliation_required");
    assert.equal(getInvestorReconciliationContext(f.db, f.actor, f.account, now, f.readOptions).latest?.current_facts, false);
    assert.deepEqual(rows(f, protectedTables), before);
  } finally { f.close(); }
});

test("exact lost-response retry and a repeated imported source cannot deposit twice; conflicting sources roll back", () => {
  const f = investorHoldingsFixture(); try {
    const c = context(f), input = intent(f), first = submit(f, input), saved = rows(f);
    assert.deepEqual(submit(f, input, "cash-command", c.workspace_revision), first); assert.deepEqual(rows(f), saved);
    const repeated = submit(f, intent(f), "new-command-same-source"); assert.equal(repeated.resource_id, first.resource_id);
    assert.equal(balance(f, "CNY"), "400.01");
    const audit = JSON.parse((f.db.prepare("SELECT payload_json FROM audit_events WHERE id=?").get(repeated.audit_id) as { payload_json: string }).payload_json);
    assert.equal(audit.result.duplicate, true); assert.equal(audit.result.execution_authorized, false);
    assert.equal(audit.result.basis, "operator_external_cash_transcription_not_broker_file");
    const bad = intent(f); bad.entry.amount = "301"; const before = rows(f);
    assert.throws(() => submit(f, bad, "conflicting-source"), /CASH_SOURCE_DUPLICATE_CONFLICT/); assert.deepEqual(rows(f), before);
    const native = intent(f, "USD", "deposit", "same-as-csv");
    const recorded = recordFact(f.db, f.actor, { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: "fictional-import",
      source_id: native.source_id, source_event_id: native.source_event_id, effective_at: native.effective_date, source_timezone: native.source_timezone,
      time_precision: "date", reason: "Fictional previously imported source", fact: { ...native.entry, account_id: f.account } }, now);
    const same = submit(f, intent(f, "USD", "deposit", "same-as-csv"), "after-import"); assert.equal(same.resource_id, recorded.event_id);
    assert.equal(balance(f, "USD"), "300.01");
  } finally { f.close(); }
});

test("cash facts cannot pass old trade contracts, invent fees or orders, use unknown currencies, false acknowledgements or invalid dates", () => {
  const f = investorHoldingsFixture(); try {
    const base = intent(f); assert.equal(tradeRecordingIntentSchema.safeParse(base).success, false);
    const bad = [
      { ...base, acknowledgement: false }, { ...base, effective_date: "2026-01-03" }, { ...base, effective_date: "2026-02-30" },
      { ...base, effective_date: "2025-12-01" }, { ...base, source_timezone: "Pacific/Unknown" }, { ...base, account_id: "foreign" },
      { ...base, portfolio_id: "foreign" }, { ...base, expected_context_hash: "d".repeat(64) },
      { ...base, entry: { ...base.entry, currency: "JPY" } }, { ...base, entry: { ...base.entry, amount: "0" } },
      { ...base, entry: { ...base.entry, amount: "-1" } }, { ...base, entry: { ...base.entry, amount: "1.001" } },
      { ...base, entry: { ...base.entry, type: "transfer_in" } }, { ...base, entry: { ...base.entry, fee: "0" } },
      { ...base, actual_arrivals_confirmed: true }, { ...base, execution_authorized: true }, { ...base, owner_id: "other" },
    ];
    const before = rows(f);
    for (const [i, input] of bad.entries()) { assert.throws(() => submit(f, input as CashRecordingIntent, "bad-" + i)); assert.deepEqual(rows(f), before); }
  } finally { f.close(); }
});

test("scope, account state, maximum idempotency length and late audit failures are checked atomically", () => {
  const f = investorHoldingsFixture(); try {
    const old = intent(f), key = "x".repeat(160), first = submit(f, old, key);
    assert.match((f.db.prepare("SELECT idempotency_key FROM ledger_events WHERE id=?").get(first.resource_id) as { idempotency_key: string }).idempotency_key, /^investor-cash:[a-f0-9]{64}$/);
    assert.throws(() => submit(f, old, "stale-context"), /CASH_CONTEXT_CONFLICT/);
    f.db.prepare("UPDATE accounts SET status='disabled',row_version=row_version+1 WHERE id=?").run(f.account);
    const disabled = intent(f, "USD", "deposit", "disabled"), before = rows(f);
    assert.throws(() => submit(f, disabled, "disabled"), /CASH_ACCOUNT_DISABLED/); assert.deepEqual(rows(f), before);
  } finally { f.close(); }
  const g = investorHoldingsFixture(); try {
    const input = intent(g), before = rows(g);
    g.db.exec("CREATE TRIGGER fictional_cash_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action='investor_record_linked_cash_fact' BEGIN SELECT RAISE(ABORT,'FICTIONAL_LATE_AUDIT_FAILURE'); END");
    assert.throws(() => submit(g, input), /FICTIONAL_LATE_AUDIT_FAILURE/); assert.deepEqual(rows(g), before);
  } finally { g.close(); }
});

test("corrected source cannot be resurrected, and recovery lock blocks even exact successful retries", () => {
  const f = investorHoldingsFixture(); try {
    const input = intent(f), first = submit(f, input), attachment = storeJsonAttachment(f.db, f.actor, { portfolio_id: f.portfolio, account_id: f.account,
      raw: JSON.stringify({ fictional: true, source: "Correction evidence" }) }, { dataDir: f.directory, now });
    correctLedger(f.db, f.actor, { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: "fictional-void-cash",
      attachment_id: attachment.id, reason: "Fictional void", changes: [{ action: "void", event_id: first.resource_id }] }, { dataDir: f.directory, now });
    const before = rows(f); assert.throws(() => submit(f, intent(f), "resurrection"), /CASH_SOURCE_SUPERSEDED/); assert.deepEqual(rows(f), before);
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "FICTIONAL RECOVERY LOCK\n");
    assert.equal(context(f).read_only, true);
    assert.throws(() => submit(f, input, "cash-command", 2), /WORKBENCH_READ_ONLY/); assert.deepEqual(rows(f), before);
  } finally { f.close(); }
});
