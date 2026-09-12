import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, recordFact, revision, type LedgerCommand } from "../src/server/ledger/service";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { RECONCILIATION_BALANCES, reconcileAccount, type AccountStatement } from "../src/server/ledger/reconciliation";
import type { Fact } from "../src/server/ledger/engine";

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "etf-reconcile-")), filename = path.join(dir, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), actor = { id: "owner" };
  const now = "2026-01-03T12:00:00.000Z", options = { dataDir: dir, now };
  const portfolio = createPortfolio(db, actor, "Synthetic", now), account = createAccount(db, actor, portfolio, "A", "Synthetic", "CNY", now);
  const second = createAccount(db, actor, portfolio, "B", "Synthetic", "CNY", now);
  db.prepare("INSERT INTO instruments(id,name,created_at) VALUES('ri','Synthetic ETF',?)").run(now);
  db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('rl','ri','CN','SSE','TEST-R','CNY',?)").run(now);
  let n = 0;
  const fact = (data: Partial<Fact> & Pick<Fact, "type">) => recordFact(db, actor, {
    portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: `reconcile:${++n}`,
    source_id: "synthetic", source_event_id: String(n), effective_at: "2026-01-01", time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Synthetic fixture",
    fact: { account_id: account, currency: "CNY", ...data },
  } as LedgerCommand, now);
  fact({ type: "opening_cash", amount: "100" });
  const statement = (cash = "100"): AccountStatement => ({
    schema_version: 1, portfolio_id: portfolio, account_id: account, cutoff_at: "2026-01-02T00:00:00.000Z",
    coverage: { currencies: ["CNY"], ledger_accounts: [...RECONCILIATION_BALANCES], positions_complete: true, balances_complete: true },
    balances: RECONCILIATION_BALANCES.map(ledger_account => ({ currency: "CNY", ledger_account, balance: ledger_account === "cash_settled" ? cash : "0" })),
    positions: [],
  });
  const source = (value: AccountStatement) => storeJsonAttachment(db, actor, { portfolio_id: portfolio, account_id: account, raw: JSON.stringify(value) }, options);
  const run = (value: AccountStatement) => {
    const attachment = source(value);
    return reconcileAccount(db, actor, { portfolio_id: portfolio, account_id: account, expected_revision: revision(db, portfolio), attachment_id: attachment.id }, options);
  };
  const status = (id: string) => (db.prepare("SELECT status FROM accounts WHERE id=?").get(id) as { status: string }).status;
  return { db, actor, portfolio, account, second, options, fact, statement, source, run, status, dir, filename, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("matching complete statement uses exact decimals and activates only the reconciled account", () => {
  const f = fixture();
  try {
    const before = f.db.prepare("SELECT * FROM account_projections").all();
    const result = f.run(f.statement("100.000000000000000000"));
    assert.equal(result.status, "matched"); assert.equal(result.account_activated, true); assert.deepEqual(result.issues, []);
    assert.equal(f.status(f.account), "active"); assert.equal(f.status(f.second), "reconciliation_required");
    assert.deepEqual(f.db.prepare("SELECT * FROM account_projections").all(), before);
    assert.equal(revision(f.db, f.portfolio), 1);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM account_capabilities").get() as { n: number }).n, 0);
  } finally { f.close(); }
});

test("small decimal difference is an issue, never a silent balancing adjustment", () => {
  const f = fixture();
  try {
    const result = f.run(f.statement("100.000000000000000001"));
    assert.equal(result.status, "issues"); assert.equal(result.account_activated, false);
    assert.deepEqual(result.issues.map(issue => issue.issue_type), ["balance_mismatch"]);
    assert.equal(result.issues[0].details.difference, "0.000000000000000001");
    assert.equal(f.status(f.account), "reconciliation_required");
    assert.equal((f.db.prepare("SELECT balance FROM account_projections WHERE ledger_account='cash_settled'").get() as { balance: string }).balance, "100");
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM reconciliation_issues").get() as { n: number }).n, 1);
  } finally { f.close(); }
});

test("unsettled balances require explicit coverage and explicit zero rows", () => {
  const f = fixture();
  try {
    const missing = f.statement();
    missing.coverage.ledger_accounts = missing.coverage.ledger_accounts.filter(name => name !== "trade_payable");
    missing.balances = missing.balances.filter(row => row.ledger_account !== "trade_payable");
    const result = f.run(missing);
    assert.equal(result.status, "issues");
    assert.ok(result.issues.some(issue => issue.issue_type === "missing_balance_coverage"));
    assert.ok(result.issues.some(issue => issue.issue_type === "missing_statement_balance"));
    assert.equal(f.status(f.account), "reconciliation_required");
  } finally { f.close(); }
});

test("no currency or held security can disappear from statement coverage", () => {
  const f = fixture();
  try {
    f.fact({ type: "opening_position", listing_id: "rl", quantity: "10", cost_amount: "100" });
    f.fact({ type: "fx", amount: "10", target_currency: "USD", received_amount: "1", fee: "0" });
    const result = f.run(f.statement("90"));
    assert.equal(result.status, "issues");
    assert.ok(result.issues.some(issue => issue.issue_type === "missing_currency_coverage" && issue.details.currency === "USD"));
    assert.ok(result.issues.some(issue => issue.issue_type === "missing_statement_position" && issue.details.listing_id === "rl"));
  } finally { f.close(); }
});

test("held positions and signed payables match exactly before settlement", () => {
  const f = fixture();
  try {
    f.fact({ type: "buy", listing_id: "rl", quantity: "10", price: "2", fee: "1" });
    const statement = f.statement();
    statement.balances.find(row => row.ledger_account === "trade_payable")!.balance = "-21";
    statement.positions = [{ listing_id: "rl", currency: "CNY", quantity: "10" }];
    assert.equal(f.run(statement).status, "matched");
  } finally { f.close(); }
});

test("duplicate, unknown and mismatched statement securities are not collapsed", () => {
  const f = fixture();
  try {
    const statement = f.statement();
    statement.balances.push({ ...statement.balances[0] });
    statement.positions = [{ listing_id: "unknown", currency: "CNY", quantity: "1" }, { listing_id: "unknown", currency: "CNY", quantity: "1" }];
    const result = f.run(statement);
    for (const kind of ["duplicate_balance", "duplicate_position", "invalid_statement_listing", "position_mismatch"]) assert.ok(result.issues.some(issue => issue.issue_type === kind), kind);
  } finally { f.close(); }
});

test("statement source attachment and account/portfolio scope are mandatory", () => {
  const f = fixture();
  try {
    const attachment = f.source(f.statement());
    const input = { portfolio_id: f.portfolio, account_id: f.account, expected_revision: 1, attachment_id: attachment.id };
    assert.throws(() => reconcileAccount(f.db, f.actor, { ...input, attachment_id: "missing" }, f.options), /OUT_OF_SCOPE/);
    assert.throws(() => reconcileAccount(f.db, f.actor, { ...input, account_id: f.second }, f.options), /OUT_OF_SCOPE/);
    assert.throws(() => reconcileAccount(f.db, { id: "" }, input, f.options), /UNAUTHENTICATED/);
    const wrongStatement = f.statement(); wrongStatement.account_id = f.second;
    const wrongAttachment = f.source(wrongStatement);
    assert.throws(() => reconcileAccount(f.db, f.actor, { ...input, attachment_id: wrongAttachment.id }, f.options), /STATEMENT_OUT_OF_SCOPE/);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM reconciliation_runs").get() as { n: number }).n, 0);
  } finally { f.close(); }
});

test("historical/intraday cutoffs never compare newer current projections", () => {
  const f = fixture();
  try {
    const old = f.statement(); old.cutoff_at = "2026-01-01T12:00:00.000Z";
    assert.throws(() => f.run(old), /HISTORICAL_RECONCILIATION_UNSUPPORTED/);
    const future = f.statement(); future.cutoff_at = "2099-01-01T00:00:00.000Z";
    assert.throws(() => f.run(future), /FUTURE_STATEMENT_NOT_ALLOWED/);
    const attachment = f.source(f.statement());
    recordFact(f.db, f.actor, { portfolio_id: f.portfolio, expected_revision: 1, idempotency_key: "later", source_id: "fixture", effective_at: "2026-01-03T10:00:00.000Z", time_precision: "second", source_timezone: "UTC", reason: "Synthetic later fact", fact: { type: "deposit", account_id: f.account, currency: "CNY", amount: "1" } }, f.options.now);
    assert.throws(() => reconcileAccount(f.db, f.actor, { portfolio_id: f.portfolio, account_id: f.account, expected_revision: 2, attachment_id: attachment.id }, f.options), /HISTORICAL_RECONCILIATION_UNSUPPORTED/);
  } finally { f.close(); }
});

test("ledger revision changes and restore guard reject reconciliation without partial state", () => {
  const f = fixture();
  try {
    const attachment = f.source(f.statement());
    const input = { portfolio_id: f.portfolio, account_id: f.account, expected_revision: 0, attachment_id: attachment.id };
    assert.throws(() => reconcileAccount(f.db, f.actor, input, f.options), /VERSION_CONFLICT/);
    writeFileSync(path.join(f.dir, "RESTORE_PENDING_REVIEW"), "pending");
    assert.throws(() => reconcileAccount(f.db, f.actor, { ...input, expected_revision: 1 }, f.options), /WORKBENCH_READ_ONLY/);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM reconciliation_runs").get() as { n: number }).n, 0);
  } finally { f.close(); }
});

test("new matching evidence does not silently resolve earlier open discrepancies", () => {
  const f = fixture();
  try {
    const first = f.run(f.statement("90"));
    const matching = f.run(f.statement());
    assert.equal(matching.status, "matched"); assert.equal(matching.account_activated, false); assert.equal(matching.prior_open_issues, 1);
    const attachment = f.source(f.statement());
    const input = { portfolio_id: f.portfolio, account_id: f.account, expected_revision: 1, attachment_id: attachment.id, resolves_issue_ids: first.issues.map(issue => issue.id) };
    assert.throws(() => reconcileAccount(f.db, f.actor, input, f.options), /INVALID_RECONCILIATION_RESOLUTION/);
    const resolved = reconcileAccount(f.db, f.actor, { ...input, resolution_reason: "Replaced incorrect synthetic source statement; full evidence now matches." }, f.options);
    assert.equal(resolved.account_activated, true); assert.equal(resolved.prior_open_issues, 0);
    const issue = f.db.prepare("SELECT status,resolution_json,resolved_by FROM reconciliation_issues WHERE id=?").get(first.issues[0].id) as { status: string; resolution_json: string; resolved_by: string };
    assert.equal(issue.status, "resolved"); assert.equal(issue.resolved_by, "owner"); assert.equal(JSON.parse(issue.resolution_json).matched_run_id, resolved.id);
  } finally { f.close(); }
});

test("disabled accounts are never re-enabled by matching reconciliation", () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE accounts SET status='disabled' WHERE id=?").run(f.account);
    const result = f.run(f.statement());
    assert.equal(result.status, "matched"); assert.equal(result.account_activated, false); assert.equal(f.status(f.account), "disabled");
  } finally { f.close(); }
});
