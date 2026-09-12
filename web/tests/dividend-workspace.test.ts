import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, recordFact, revision, type LedgerCommand } from "../src/server/ledger/service";
import { dividendWorkspace } from "../src/server/ledger/dividend-queries";
import { RECONCILIATION_BALANCES, reconcileAccount, type AccountStatement } from "../src/server/ledger/reconciliation";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { availableResources, validateAccount } from "../src/server/governance/risk";
import type { Policy } from "../src/server/governance/schemas";

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "etf-dividend-workspace-"));
  const filename = path.join(dir, "workbench.db"); migrateWorkbench(filename);
  const db = openWorkbench(filename), actor = { id: "synthetic-human" }, now = "2026-01-05T12:00:00.000Z";
  const portfolio = createPortfolio(db, actor, "Synthetic dividend test only", now);
  const account = createAccount(db, actor, portfolio, "Synthetic A", "Synthetic", "CNY", now);
  const second = createAccount(db, actor, portfolio, "Synthetic B", "Synthetic", "CNY", now);
  let n = 0;
  const fact = (fact: Partial<LedgerCommand["fact"]> & Pick<LedgerCommand["fact"], "type">) => recordFact(db, actor, {
    portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: `test:${++n}`, source_id: "synthetic",
    source_event_id: String(n), effective_at: "2026-01-02", time_precision: "date", source_timezone: "UTC", reason: "Synthetic only",
    fact: { account_id: account, currency: "CNY", ...fact },
  }, now);
  const statement = (legacy = false): AccountStatement => {
    const names = RECONCILIATION_BALANCES.filter(name => !legacy || name !== "dividend_tax_payable");
    return { schema_version: 1, portfolio_id: portfolio, account_id: account, cutoff_at: "2026-01-04T00:00:00.000Z",
      coverage: { currencies: ["CNY"], ledger_accounts: names, positions_complete: true, balances_complete: true }, positions: [],
      balances: names.map(ledger_account => ({ currency: "CNY", ledger_account, balance: (db.prepare("SELECT balance FROM account_projections WHERE account_id=? AND currency='CNY' AND ledger_account=?").get(account, ledger_account) as { balance: string } | undefined)?.balance ?? "0" })) };
  };
  const run = (value = statement(), resolves: string[] = []) => {
    const source = storeJsonAttachment(db, actor, { portfolio_id: portfolio, account_id: account, raw: JSON.stringify(value) }, { dataDir: dir, now });
    return reconcileAccount(db, actor, { portfolio_id: portfolio, account_id: account, expected_revision: revision(db, portfolio), attachment_id: source.id, resolves_issue_ids: resolves,
      ...(resolves.length ? { resolution_reason: "Synthetic new confirmed tax evidence" } : {}) }, { dataDir: dir, now });
  };
  return { db, actor, now, portfolio, account, second, fact, statement, run, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("dividend root query is account scoped, revision bound and has stable complete pagination", () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 105 }, () => f.fact({ type: "corporate_action_notice", action_kind: "other", evidence_reference: "Synthetic unresolved notice" }).event_id);
    f.fact({ type: "corporate_action_notice", account_id: f.second, action_kind: "other", evidence_reference: "Another account" });
    const first = dividendWorkspace(f.db, f.actor, f.portfolio, f.account, 106, undefined, f.now);
    assert.equal(first.rows.length, 100); assert.equal(first.next_cursor, 6); assert.equal(first.quality.nav_quality, "blocked");
    const second = dividendWorkspace(f.db, f.actor, f.portfolio, f.account, 106, first.next_cursor!, f.now);
    assert.equal(second.rows.length, 5); assert.equal(second.next_cursor, null);
    assert.deepEqual([...first.rows, ...second.rows].map(row => row.id), ids.reverse());
    assert.throws(() => dividendWorkspace(f.db, f.actor, f.portfolio, f.account, 105), /VERSION_CONFLICT/);
    assert.throws(() => dividendWorkspace(f.db, f.actor, "other", f.account, 106), /ACCOUNT_OUT_OF_SCOPE/);
    assert.throws(() => dividendWorkspace(f.db, { id: "" }, f.portfolio, f.account, 106), /UNAUTHENTICATED/);
    assert.throws(() => dividendWorkspace(f.db, f.actor, f.portfolio, f.account, 106, 0), /INVALID_DIVIDEND_QUERY/);
    assert.equal(revision(f.db, f.portfolio), 106);
  } finally { f.close(); }
});

test("matched monetary balances cannot clear unknown tax; final assessment and explicit issue resolution can", () => {
  const f = fixture();
  try {
    f.fact({ type: "opening_cash", amount: "1000" });
    const root = f.fact({ type: "dividend_accrual", amount: "200", tax_status: "unknown" });
    f.fact({ type: "dividend_payment", related_event_id: root.event_id, amount: "180" });
    const unresolved = f.run();
    assert.deepEqual(unresolved.issues.map(row => row.issue_type), ["unresolved_financial_facts"]); assert.equal(unresolved.account_activated, false);
    f.fact({ type: "dividend_tax_assessment", related_event_id: root.event_id, tax: "20", tax_status: "confirmed", evidence_reference: "Synthetic final tax" });
    assert.throws(() => f.run(f.statement(), ["wrong-account-issue"]), /RECONCILIATION_ISSUE_OUT_OF_SCOPE/);
    const cleared = f.run(f.statement(), unresolved.issues.map(row => row.id));
    assert.equal(cleared.account_activated, true);
    const view = dividendWorkspace(f.db, f.actor, f.portfolio, f.account, 4, undefined, f.now);
    assert.equal(view.quality.performance_quality, "complete"); assert.equal(view.rows[0].dividend?.net_cash, "180"); assert.equal(view.rows[0].dividend?.receivable, "0");
  } finally { f.close(); }
});

test("final net cash with unknown attribution does not block reconciliation, provisional net does", () => {
  for (const net_status of ["final", "provisional"] as const) {
    const f = fixture();
    try {
      f.fact({ type: "dividend_net", amount: "180", net_status });
      const result = f.run(); assert.equal(result.account_activated, net_status === "final");
      const view = dividendWorkspace(f.db, f.actor, f.portfolio, f.account, 1, undefined, f.now);
      assert.equal(view.quality.attribution_quality, "provisional");
    } finally { f.close(); }
  }
});

test("legacy seven-account statements remain valid at zero tax liability but cannot omit a real payable", () => {
  const f = fixture();
  try {
    f.fact({ type: "opening_cash", amount: "1000" });
    assert.equal(f.run(f.statement(true)).account_activated, true);
    const root = f.fact({ type: "dividend", amount: "200", tax: "20" });
    f.fact({ type: "dividend_tax_assessment", related_event_id: root.event_id, tax: "25", tax_status: "confirmed", evidence_reference: "Synthetic final cumulative tax" });
    const result = f.run(f.statement(true));
    assert.ok(result.issues.some(row => row.issue_type === "missing_balance_coverage" && row.details.ledger_account === "dividend_tax_payable"));
    assert.ok(result.issues.some(row => row.issue_type === "missing_statement_balance" && row.details.expected === "-5"));
    assert.equal(f.run(f.statement(), result.issues.map(row => row.id)).account_activated, true);
    const balances = f.db.prepare("SELECT * FROM account_projections WHERE account_id=?").all(f.account) as Parameters<typeof availableResources>[0];
    assert.equal(availableResources(balances, [], []).available.get(`${f.account}:CNY`)?.toFixed(), "1175");
  } finally { f.close(); }
});

test("unresolved company action blocks reconciliation and risk even if account status was forced active", () => {
  const f = fixture();
  try {
    f.fact({ type: "opening_cash", amount: "1000" }); f.run();
    const notice = f.fact({ type: "corporate_action_notice", action_kind: "merger", evidence_reference: "Synthetic pending merger" });
    f.db.prepare("UPDATE accounts SET status='active' WHERE id=?").run(f.account);
    const policy = { account_ids: [f.account], execution: { max_reconciliation_age_seconds: 604800 } } as Policy;
    assert.throws(() => validateAccount(f.db, f.portfolio, f.account, policy, f.now), /ACCOUNT_RECONCILIATION_REQUIRED/);
    const pending = f.run(); assert.equal(pending.account_activated, false);
    f.fact({ type: "corporate_action_resolution", related_event_id: notice.event_id, resolution: "not_applicable", supporting_event_ids: [], evidence_reference: "Synthetic verified different listing" });
    assert.equal(f.run(f.statement(), pending.issues.map(row => row.id)).account_activated, true);
    assert.doesNotThrow(() => validateAccount(f.db, f.portfolio, f.account, policy, f.now));
  } finally { f.close(); }
});
