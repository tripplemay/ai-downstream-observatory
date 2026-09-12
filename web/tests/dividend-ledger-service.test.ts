import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { correctLedger, type CorrectionChange } from "../src/server/ledger/corrections";
import { audit, canonical, createAccount, createPortfolio, dividendStateFor, getActiveLedgerEvents, hash, recordFact, rebuildProjections, revision, type LedgerCommand } from "../src/server/ledger/service";
import type { Fact } from "../src/server/ledger/engine";

const actor = { id: "synthetic-dividend-owner" }, now = "2026-09-12T00:00:00.000Z";
function fixture() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "etf-dividend-")), filename = path.join(dataDir, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, actor, "Synthetic dividend tests", now);
  const account = createAccount(db, actor, portfolio, "A", "Synthetic", "CNY", now), other = createAccount(db, actor, portfolio, "B", "Synthetic", "CNY", now);
  db.prepare("INSERT INTO instruments(id,name,created_at) VALUES('i','Synthetic ETF',?)").run(now);
  for (const listing of ["l", "l2"]) db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES(?,'i','CN','SSE',?,'CNY',?)").run(listing, listing === "l" ? "000001" : "000002", now);
  let n = 0;
  const command = (fact: Partial<Fact> & Pick<Fact, "type">, date = "2026-01-01"): LedgerCommand => ({ portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: `test-${++n}`, source_id: "synthetic", source_event_id: `source-${n}`, effective_at: date, time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Synthetic retained evidence", fact: { account_id: account, currency: "CNY", ...fact } });
  const record = (fact: Partial<Fact> & Pick<Fact, "type">, date?: string) => recordFact(db, actor, command(fact, date), now);
  const child = (root: string, type: Fact["type"], values: Partial<Fact> = {}, date?: string) => record({ type, related_event_id: root, ...(type === "dividend_payment" ? {} : { evidence_reference: "Synthetic original tax statement" }), ...values }, date);
  const attachment = storeJsonAttachment(db, actor, { portfolio_id: portfolio, account_id: account, raw: '{"evidence":"SYNTHETIC ONLY"}' }, { dataDir, now });
  const correction = (changes: CorrectionChange[]) => ({ portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: `correction-${++n}`, attachment_id: attachment.id, reason: "Correct synthetic original evidence", changes });
  const correct = (changes: CorrectionChange[]) => correctLedger(db, actor, correction(changes), { dataDir, now });
  const replace = (eventId: string, changes: Partial<Fact>): CorrectionChange => {
    const previous = JSON.parse(getActiveLedgerEvents(db, portfolio).find(row => row.id === eventId)!.payload_json) as LedgerCommand;
    return { action: "replace", event_id: eventId, replacement: { effective_at: previous.effective_at, time_precision: previous.time_precision, source_timezone: previous.source_timezone, fact: { ...previous.fact, ...changes } } };
  };
  const balance = (name: string) => (db.prepare("SELECT balance FROM account_projections WHERE account_id=? AND currency='CNY' AND ledger_account=?").get(account, name) as { balance: string } | undefined)?.balance ?? "0";
  const snapshot = () => db.prepare("SELECT account_id,currency,ledger_account,balance FROM account_projections WHERE balance<>'0' ORDER BY account_id,currency,ledger_account").all();
  const rebuild = () => { const before = snapshot(); rebuildProjections(db, actor, portfolio, now); assert.deepEqual(snapshot(), before); };
  const eventFact = (eventId: string) => (JSON.parse((db.prepare("SELECT payload_json FROM ledger_events WHERE id=?").get(eventId) as { payload_json: string }).payload_json) as LedgerCommand).fact;
  return { db, dataDir, filename, portfolio, account, other, command, record, child, correction, correct, replace, balance, snapshot, rebuild, eventFact, close: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test("cumulative tax recognition, actual withholding and refund preserve exact independent balances and rebuild", () => {
  const f = fixture();
  try {
    const root = f.record({ type: "dividend_accrual", amount: "200", listing_id: "l" });
    f.child(root.event_id, "dividend_payment", { amount: "180" });
    assert.equal(dividendStateFor(f.db, f.portfolio, root.event_id).receivable, "20");
    for (const tax of ["20", "25"]) {
      f.child(root.event_id, "dividend_tax_assessment", { tax, tax_status: "confirmed" });
      assert.equal(f.balance("cash_settled"), "180");
    }
    assert.equal(f.balance("dividend_tax_payable"), "-5");
    f.child(root.event_id, "dividend_tax_payment", { amount: "5" });
    assert.equal(f.balance("cash_settled"), "175"); assert.equal(f.balance("expense"), "25");
    f.child(root.event_id, "dividend_tax_assessment", { tax: "20", tax_status: "confirmed" });
    assert.equal(f.balance("dividend_receivable"), "5");
    f.child(root.event_id, "dividend_payment", { amount: "5" });
    const state = dividendStateFor(f.db, f.portfolio, root.event_id);
    assert.deepEqual([state.gross_amount, state.tax, state.net_cash, state.receivable, state.tax_payable], ["200", "20", "180", "0", "0"]);
    assert.equal(state.listing_id, "l"); assert.equal(state.assessment_confirmed, true);
    assert.equal(f.balance("external_capital"), "0"); assert.equal(f.balance("income"), "-200"); f.rebuild();
  } finally { f.close(); }
});

test("actual net cash above estimated receivable is accepted and final tax changes no cash", () => {
  const f = fixture();
  try {
    const root = f.record({ type: "dividend_accrual", amount: "200", tax: "30", tax_status: "estimated" });
    f.child(root.event_id, "dividend_payment", { amount: "180" });
    assert.equal(f.balance("dividend_tax_payable"), "-10"); assert.equal(f.balance("dividend_receivable"), "0");
    f.child(root.event_id, "dividend_tax_assessment", { tax: "20", tax_status: "confirmed" });
    assert.equal(f.balance("dividend_tax_payable"), "0"); assert.equal(f.balance("cash_settled"), "180"); f.rebuild();
  } finally { f.close(); }
});

test("net-only breakdown does not finalize provisional net cash; zero-delta assessment is a real revision", () => {
  const f = fixture();
  try {
    const root = f.record({ type: "dividend_net", amount: "180.123456789012345678", net_status: "provisional" });
    assert.equal(dividendStateFor(f.db, f.portfolio, root.event_id).gross_amount, null);
    f.child(root.event_id, "dividend_breakdown", { gross_amount: "200.123456789012345678", tax: "20" });
    const before = dividendStateFor(f.db, f.portfolio, root.event_id), balances = f.snapshot();
    assert.equal(before.net_status, "provisional"); assert.equal(before.assessment_confirmed, false);
    assert.equal(before.gross_amount, "200.123456789012345678");
    assert.throws(() => f.child(root.event_id, "dividend_breakdown", { gross_amount: "200.123456789012345678", tax: "20" }), /DIVIDEND_BREAKDOWN_ALREADY_RECORDED/);
    const receipt = f.child(root.event_id, "dividend_tax_assessment", { tax: "20", tax_status: "confirmed" });
    assert.equal(receipt.revision, 3); assert.equal((f.db.prepare("SELECT count(*) n FROM postings WHERE event_id=?").get(receipt.event_id) as { n: number }).n, 0);
    assert.deepEqual(f.snapshot(), balances); assert.equal(dividendStateFor(f.db, f.portfolio, root.event_id).assessment_confirmed, true);
    f.child(root.event_id, "dividend_tax_assessment", { tax: "20", tax_status: "estimated" });
    assert.equal(dividendStateFor(f.db, f.portfolio, root.event_id).assessment_confirmed, false); f.rebuild();
  } finally { f.close(); }
});

test("direct dividend input must explicitly confirm tax while legacy no-tax facts remain auditable and correctable", () => {
  const f = fixture();
  try {
    assert.throws(() => f.record({ type: "dividend", amount: "200" }), /DIRECT_DIVIDEND_TAX_REQUIRED/);
    const old = f.command({ type: "dividend", amount: "200" }), id = randomUUID();
    // Faithful pre-upgrade persisted event: public recordFact is intentionally not bypassed for new input.
    f.db.prepare("INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,time_precision,source_timezone,recorded_at,source_id,source_event_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id,reason) VALUES(?,?,?,'dividend',?,?,?,?,?,?,?,?,?,1,?,?)").run(id, f.portfolio, f.account, old.effective_at, old.time_precision, old.source_timezone, now, old.source_id, old.source_event_id, old.idempotency_key, hash(old), canonical(old), actor.id, old.reason);
    for (const [account, amount] of [["cash_settled", "200"], ["income", "-200"]]) f.db.prepare("INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES(?,?,?,'CNY',?,?)").run(randomUUID(), id, f.account, account, amount);
    audit(f.db, actor, "record_fact", "ledger_event", id, f.portfolio, 1, { warnings: [] }, now);
    f.db.prepare("UPDATE ledger_heads SET revision=1 WHERE portfolio_id=?").run(f.portfolio); rebuildProjections(f.db, actor, f.portfolio, now); f.rebuild();
    assert.equal(dividendStateFor(f.db, f.portfolio, id).tax_status, "unknown");
    const result = f.correct([f.replace(id, { amount: "210" })]), replacement = result.replacements.find(row => row.original_event_id === id)!.event_id;
    assert.equal(f.balance("cash_settled"), "210"); assert.equal(dividendStateFor(f.db, f.portfolio, replacement).tax_status, "unknown");
    assert.ok(result.warnings.includes("DIVIDEND_TAX_PROVISIONAL")); assert.equal(f.eventFact(id).amount, "200");
    assert.throws(() => dividendStateFor(f.db, f.portfolio, id), /RELATED_EVENT_NOT_FOUND/);
    assert.ok(recordFact(f.db, actor, { ...old, idempotency_key: "old-reexport" }, now).warnings.includes("ORIGINAL_SOURCE_SUPERSEDED"));
    f.child(replacement, "dividend_tax_assessment", { tax: "10", tax_status: "confirmed" });
    assert.equal(f.balance("cash_settled"), "210"); assert.equal(f.balance("dividend_tax_payable"), "-10"); f.rebuild();
  } finally { f.close(); }
});

test("dividend roots, evidence, exact source identity and cumulative limits fail atomically outside scope", () => {
  const f = fixture();
  try {
    const root = f.record({ type: "dividend_accrual", amount: "200", listing_id: "l" });
    for (const values of [{ account_id: f.other }, { currency: "USD" }, { listing_id: "l2" }, { related_event_id: "missing" }, { evidence_reference: "   " }, { tax: "201" }]) assert.throws(() => f.child(root.event_id, "dividend_tax_assessment", { tax: "20", tax_status: "confirmed", ...values }));
    const otherPortfolio = createPortfolio(f.db, actor, "Foreign", now), foreign = createAccount(f.db, actor, otherPortfolio, "Foreign", "Synthetic", "CNY", now);
    const foreignCommand = { ...f.command({ type: "dividend_accrual", amount: "1", account_id: foreign }), portfolio_id: otherPortfolio, expected_revision: 0 };
    const foreignRoot = recordFact(f.db, actor, foreignCommand, now);
    assert.throws(() => f.child(foreignRoot.event_id, "dividend_tax_assessment", { tax: "0", tax_status: "confirmed" }), /RELATED_EVENT_NOT_FOUND/);
    assert.equal(revision(f.db, f.portfolio), 1);
    const input = f.command({ type: "dividend_tax_assessment", related_event_id: root.event_id, tax: "20", tax_status: "confirmed", evidence_reference: "Synthetic original" });
    const result = recordFact(f.db, actor, input, now);
    assert.equal(recordFact(f.db, actor, { ...input, idempotency_key: "another-export", fact: { ...input.fact, tax: "20.00" } }, now).event_id, result.event_id);
    assert.throws(() => recordFact(f.db, actor, { ...input, idempotency_key: "changed-status", fact: { ...input.fact, tax_status: "estimated" } }, now), /SOURCE_DUPLICATE_CONFLICT/);
    assert.throws(() => f.child(root.event_id, "dividend_tax_payment", { amount: "1" }), /EXCEEDS_OUTSTANDING/);
    assert.throws(() => f.child(root.event_id, "dividend_payment", { amount: "201" }), /EXCEEDS_DIVIDEND_GROSS/); assert.equal(revision(f.db, f.portfolio), 2);
  } finally { f.close(); }
});

test("company markers neither create balances nor close opening period or bypass economic chronology", () => {
  const f = fixture();
  try {
    const notice = f.record({ type: "corporate_action_notice", action_kind: "merger", listing_id: "l", evidence_reference: "Synthetic notice" }, "2026-07-01");
    f.child(notice.event_id, "corporate_action_resolution", { resolution: "not_applicable", supporting_event_ids: [] }, "2026-07-02");
    assert.deepEqual(f.snapshot(), []); assert.equal(revision(f.db, f.portfolio), 2);
    f.record({ type: "opening_cash", amount: "1000" }, "2026-01-01");
    f.record({ type: "fee", amount: "1" }, "2026-01-03");
    f.record({ type: "corporate_action_notice", action_kind: "other", evidence_reference: "Historical discovered notice" }, "2025-12-01");
    assert.throws(() => f.record({ type: "fee", amount: "1" }, "2026-01-02"), /CHRONOLOGY_REVIEW_REQUIRED/);
    assert.throws(() => f.record({ type: "opening_cash", amount: "1", currency: "USD" }), /OPENING_PERIOD_CLOSED/); f.rebuild();
  } finally { f.close(); }
});

test("recorded company resolutions require active same-account economic support and an explicit original-listing match", () => {
  const f = fixture();
  try {
    const notice = f.record({ type: "corporate_action_notice", action_kind: "merger", listing_id: "l", evidence_reference: "Synthetic notice" });
    const deposit = f.record({ type: "deposit", amount: "1000" });
    const buy = f.record({ type: "buy", listing_id: "l", quantity: "1", price: "10" });
    const otherListing = f.record({ type: "buy", listing_id: "l2", quantity: "1", price: "10" });
    const otherAccount = f.record({ type: "buy", account_id: f.other, listing_id: "l", quantity: "1", price: "10" });
    for (const ids of [[deposit.event_id], [notice.event_id], [otherAccount.event_id], [otherListing.event_id], ["missing"]]) assert.throws(() => f.child(notice.event_id, "corporate_action_resolution", { resolution: "recorded", supporting_event_ids: ids }));
    const resolution = f.child(notice.event_id, "corporate_action_resolution", { resolution: "recorded", supporting_event_ids: [buy.event_id, otherListing.event_id] });
    assert.equal((f.db.prepare("SELECT count(*) n FROM postings WHERE event_id=?").get(resolution.event_id) as { n: number }).n, 0);
    assert.throws(() => f.child(notice.event_id, "corporate_action_resolution", { resolution: "not_applicable", supporting_event_ids: [] }), /CORPORATE_ACTION_ALREADY_RESOLVED/); f.rebuild();
  } finally { f.close(); }
});

test("resolution date cannot precede notice or supporting facts, or silently resolve ambiguous precision/timezones", () => {
  const f = fixture();
  try {
    const notice = f.record({ type: "corporate_action_notice", action_kind: "dividend_entitlement", listing_id: "l", evidence_reference: "Synthetic notice" }, "2026-01-02");
    const root = f.record({ type: "dividend_accrual", listing_id: "l", amount: "200" }, "2026-01-03");
    const pay = f.child(root.event_id, "dividend_payment", { amount: "180" }, "2026-01-04");
    const values = { type: "corporate_action_resolution" as const, related_event_id: notice.event_id, resolution: "recorded" as const, supporting_event_ids: [pay.event_id], evidence_reference: "Synthetic determination" };
    for (const date of ["2026-01-01", "2026-01-03"]) assert.throws(() => f.record(values, date), /CORPORATE_ACTION_RESOLUTION_TOO_EARLY/);
    assert.throws(() => recordFact(f.db, actor, { ...f.command(values, "2026-01-05"), source_timezone: "America/New_York" }, now), /CORPORATE_ACTION_TIME_AMBIGUOUS/);
    assert.throws(() => recordFact(f.db, actor, { ...f.command(values), time_precision: "second", effective_at: "2026-01-05T00:00:00Z" }, now), /CORPORATE_ACTION_TIME_AMBIGUOUS/);
    f.record(values, "2026-01-05"); f.rebuild();
  } finally { f.close(); }
});

test("correction replay recomputes cumulative tax deltas and remaps root, payment and company support dependencies", () => {
  const f = fixture();
  try {
    const notice = f.record({ type: "corporate_action_notice", action_kind: "dividend_entitlement", listing_id: "l", evidence_reference: "Synthetic notice" });
    const root = f.record({ type: "dividend_accrual", listing_id: "l", amount: "200", tax: "30", tax_status: "estimated" });
    const pay = f.child(root.event_id, "dividend_payment", { amount: "180" }, "2026-01-02");
    const assessment = f.child(root.event_id, "dividend_tax_assessment", { tax: "20", tax_status: "confirmed" }, "2026-01-03");
    const resolution = f.child(notice.event_id, "corporate_action_resolution", { resolution: "recorded", supporting_event_ids: [pay.event_id, assessment.event_id] }, "2026-01-04");
    const original = f.eventFact(root.event_id), result = f.correct([f.replace(root.event_id, { tax: "10" })]);
    const replaced = (id: string) => result.replacements.find(row => row.original_event_id === id)!.event_id;
    assert.equal(f.eventFact(replaced(pay.event_id)).related_event_id, replaced(root.event_id));
    assert.deepEqual(f.eventFact(replaced(resolution.event_id)).supporting_event_ids, [replaced(pay.event_id), replaced(assessment.event_id)]);
    assert.equal(f.eventFact(replaced(resolution.event_id)).related_event_id, replaced(notice.event_id));
    assert.equal(f.balance("cash_settled"), "180"); assert.equal(f.balance("expense"), "20"); assert.equal(f.balance("dividend_tax_payable"), "0");
    assert.equal(dividendStateFor(f.db, f.portfolio, replaced(root.event_id)).tax, "20"); assert.deepEqual(f.eventFact(root.event_id), original); f.rebuild();
    const prior = revision(f.db, f.portfolio), balances = f.snapshot();
    assert.throws(() => f.correct([{ action: "void", event_id: replaced(pay.event_id) }]), /CORRECTION_DEPENDENCY_MISSING_OR_LATER/);
    assert.equal(revision(f.db, f.portfolio), prior); assert.deepEqual(f.snapshot(), balances);
    f.correct([{ action: "void", event_id: replaced(pay.event_id) }, { action: "void", event_id: replaced(resolution.event_id) }]);
    assert.equal(f.balance("cash_settled"), "0"); assert.equal(f.balance("dividend_receivable"), "180"); f.rebuild();
  } finally { f.close(); }
});

test("zero-delta quality corrections retain independent immutable history and invalidate only affected non-disabled accounts", () => {
  const f = fixture();
  try {
    const root = f.record({ type: "dividend_accrual", amount: "200", tax: "0", tax_status: "estimated" });
    const assessment = f.child(root.event_id, "dividend_tax_assessment", { tax: "0", tax_status: "estimated" });
    f.db.prepare("UPDATE accounts SET status='active'").run(); const balances = f.snapshot();
    const result = f.correct([f.replace(assessment.event_id, { tax_status: "confirmed" })]);
    assert.deepEqual(result.affected_account_ids, [f.account]); assert.deepEqual(f.snapshot(), balances);
    assert.equal((f.db.prepare("SELECT status FROM accounts WHERE id=?").get(f.account) as { status: string }).status, "reconciliation_required");
    assert.equal((f.db.prepare("SELECT status FROM accounts WHERE id=?").get(f.other) as { status: string }).status, "active");
    assert.equal(dividendStateFor(f.db, f.portfolio, root.event_id).assessment_confirmed, true);
    assert.equal(f.eventFact(assessment.event_id).tax_status, "estimated");
    f.db.prepare("UPDATE accounts SET status='disabled' WHERE id=?").run(f.account);
    f.child(root.event_id, "dividend_tax_assessment", { tax: "0", tax_status: "estimated" });
    assert.equal((f.db.prepare("SELECT status FROM accounts WHERE id=?").get(f.account) as { status: string }).status, "disabled"); f.rebuild();
  } finally { f.close(); }
});

test("new dividend and zero-economic commands honor CAS, scoped evidence and existing-connection restore guards", () => {
  const f = fixture();
  try {
    const stale = f.command({ type: "dividend_net", amount: "180", net_status: "final" });
    const root = f.record({ type: "dividend_accrual", amount: "200" });
    assert.throws(() => recordFact(f.db, actor, stale, now), /VERSION_CONFLICT/);
    const input = f.command({ type: "dividend_tax_assessment", related_event_id: root.event_id, tax: "0", tax_status: "confirmed", evidence_reference: "Synthetic statement" });
    const correction = f.correction([f.replace(root.event_id, { tax: "0", tax_status: "confirmed" })]);
    writeFileSync(path.join(f.dataDir, "RESTORE_PENDING_REVIEW"), "Synthetic restore guard", { mode: 0o600 });
    assert.throws(() => recordFact(f.db, actor, input, now), /WORKBENCH_READ_ONLY/);
    assert.throws(() => f.record({ type: "corporate_action_notice", action_kind: "other", evidence_reference: "Synthetic notice" }), /WORKBENCH_READ_ONLY/);
    assert.throws(() => correctLedger(f.db, actor, correction, { dataDir: f.dataDir, now }), /WORKBENCH_READ_ONLY/);
    assert.equal(dividendStateFor(f.db, f.portfolio, root.event_id).tax_status, "unknown"); assert.equal(revision(f.db, f.portfolio), 1);
  } finally { f.close(); }
});

test("net breakdown correction requires an exact paired root correction and replays tax/refund dependencies", () => {
  const f = fixture();
  try {
    const root = f.record({ type: "dividend_net", amount: "180", net_status: "final" });
    const breakdown = f.child(root.event_id, "dividend_breakdown", { gross_amount: "200", tax: "20" }, "2026-01-02");
    f.child(root.event_id, "dividend_tax_assessment", { tax: "25", tax_status: "confirmed" }, "2026-01-03");
    f.child(root.event_id, "dividend_tax_payment", { amount: "5" }, "2026-01-04");
    const before = f.snapshot(), head = revision(f.db, f.portfolio);
    assert.throws(() => f.correct([f.replace(root.event_id, { amount: "181" })]), /DIVIDEND_BREAKDOWN_MISMATCH/);
    assert.equal(revision(f.db, f.portfolio), head); assert.deepEqual(f.snapshot(), before);
    const result = f.correct([f.replace(root.event_id, { amount: "181" }), f.replace(breakdown.event_id, { gross_amount: "201" })]);
    const activeRoot = result.replacements.find(row => row.original_event_id === root.event_id)!.event_id;
    const state = dividendStateFor(f.db, f.portfolio, activeRoot);
    assert.deepEqual([state.gross_amount, state.tax, state.net_cash, state.receivable, state.tax_payable], ["201", "25", "176", "0", "0"]);
    assert.equal(f.balance("income"), "-201"); assert.equal(f.balance("unclassified_income"), "0"); f.rebuild();
  } finally { f.close(); }
});

test("correction insertion cannot sidestep missing root/support or monetary time ordering using information markers", () => {
  const f = fixture();
  try {
    const noticeCommand = { ...f.command({ type: "corporate_action_notice", action_kind: "other", evidence_reference: "Precise information timestamp" }), time_precision: "second" as const, effective_at: "2026-07-01T00:00:00Z", source_timezone: "UTC" };
    const notice = recordFact(f.db, actor, noticeCommand, now);
    const opening = f.record({ type: "opening_cash", amount: "100" });
    f.correct([f.replace(opening.event_id, { amount: "200" })]);
    assert.equal(f.balance("cash_settled"), "200");
    const currentNotice = getActiveLedgerEvents(f.db, f.portfolio).find(row => row.event_type === "corporate_action_notice")!;
    assert.notEqual(currentNotice.id, notice.event_id); assert.equal(currentNotice.effective_at, new Date(noticeCommand.effective_at).toISOString());
    const root = f.record({ type: "dividend_accrual", amount: "20" }, "2026-01-03");
    f.child(root.event_id, "dividend_payment", { amount: "18" }, "2026-01-04");
    const head = revision(f.db, f.portfolio), before = f.snapshot();
    assert.throws(() => f.correct([{ action: "void", event_id: root.event_id }]), /CORRECTION_DEPENDENCY_MISSING_OR_LATER/);
    assert.equal(revision(f.db, f.portfolio), head); assert.deepEqual(f.snapshot(), before); f.rebuild();
  } finally { f.close(); }
});
