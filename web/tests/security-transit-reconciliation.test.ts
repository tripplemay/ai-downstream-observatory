import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, recordFact, revision, type LedgerCommand } from "../src/server/ledger/service";
import type { Fact } from "../src/server/ledger/engine";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { reconcileAccount, RECONCILIATION_BALANCES, type AccountStatement } from "../src/server/ledger/reconciliation";

const actor = { id: "SYNTHETIC-TRANSIT-RECONCILIATION" }, now = "2026-01-15T12:00:00.000Z";
type Transit = NonNullable<AccountStatement["security_transits"]>[number];
function fixture(cost: string | null = "1000", currency = "CNY") {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "etf-transit-reconciliation-")), filename = path.join(dataDir, "workbench.db");
  migrateWorkbench(filename); const db = openWorkbench(filename);
  const portfolio = createPortfolio(db, actor, "Synthetic transit statements only", now);
  const source = createAccount(db, actor, portfolio, "Synthetic source", "Not a broker", "CNY", now), target = createAccount(db, actor, portfolio, "Synthetic target", "Not a broker", "CNY", now);
  const options = { dataDir, now };
  db.prepare("INSERT INTO instruments(id,name,created_at) VALUES('transit-i','Synthetic ETF',?)").run(now);
  db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('transit-l','transit-i','CN','SSE','000001',?,?)").run(currency, now);
  const record = (fact: Partial<Fact> & Pick<Fact, "type">, date = "2026-01-02") => recordFact(db, actor, { portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: randomUUID(), source_id: "synthetic-only", source_event_id: randomUUID(), effective_at: date, time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Synthetic transfer evidence", fact: { account_id: source, currency, ...fact } } as LedgerCommand, now);
  record({ type: "opening_position", listing_id: "transit-l", quantity: "10", ...(cost !== null ? { cost_amount: cost } : {}) }, "2026-01-01");
  const dispatch = record({ type: "security_transfer_out", listing_id: "transit-l", target_account_id: target, quantity: "4" });
  const lot = (quantity: string, transferId = dispatch.event_id): Transit => ({ transfer_event_id: transferId, source_account_id: source, target_account_id: target, listing_id: "transit-l", currency, quantity });
  const statement = (account: string, held: string, transits: Transit[] | undefined = [lot("4")], cutoff = "2026-01-10T00:00:00.000Z"): AccountStatement => {
    const currencies = [...new Set(["CNY", currency])];
    return { schema_version: 1, portfolio_id: portfolio, account_id: account, cutoff_at: cutoff,
      coverage: { currencies, ledger_accounts: [...RECONCILIATION_BALANCES], positions_complete: true, balances_complete: true, ...(transits !== undefined ? { security_transits_complete: true as const } : {}) },
      balances: currencies.flatMap(currency => RECONCILIATION_BALANCES.map(ledger_account => ({ currency, ledger_account, balance: "0" }))),
      positions: held === "0" ? [] : [{ listing_id: "transit-l", currency, quantity: held }],
      ...(transits !== undefined ? { security_transits: transits } : {}),
    };
  };
  const store = (value: AccountStatement | Record<string, unknown>, account: string) => storeJsonAttachment(db, actor, { portfolio_id: portfolio, account_id: account, raw: JSON.stringify(value) }, options);
  const run = (value: AccountStatement, resolveIds: string[] = []) => reconcileAccount(db, actor, { portfolio_id: portfolio, account_id: value.account_id, expected_revision: revision(db, portfolio), attachment_id: store(value, value.account_id).id, ...(resolveIds.length ? { resolves_issue_ids: resolveIds, resolution_reason: "Synthetic supplement now explicitly reconciles pending receiving/outgoing lots" } : {}) }, options);
  const status = (account: string) => (db.prepare("SELECT status FROM accounts WHERE id=?").get(account) as { status: string }).status;
  return { db, portfolio, source, target, currency, options, record, dispatch, lot, statement, store, run, status, close: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test("known, zero and unknown-cost pending lots require quantity evidence from both source and target", () => {
  for (const cost of ["1000", "0", null]) {
    const f = fixture(cost);
    try {
      const before = f.db.prepare("SELECT * FROM security_transit_projections").all();
      assert.equal((before[0] as { cost_known: number }).cost_known, cost === null ? 0 : 1);
      const source = f.run(f.statement(f.source, "6")); assert.equal(source.status, "matched"); assert.equal(source.account_activated, true);
      assert.equal(f.status(f.target), "reconciliation_required");
      const target = f.run(f.statement(f.target, "0")); assert.equal(target.status, "matched"); assert.equal(target.account_activated, true);
      assert.equal(f.db.prepare("SELECT 1 FROM position_projections WHERE account_id=?").get(f.target), undefined);
      assert.deepEqual(f.db.prepare("SELECT * FROM security_transit_projections").all(), before);
      assert.equal(revision(f.db, f.portfolio), 2);
      assert.equal((f.db.prepare("SELECT COUNT(*) n FROM account_capabilities").get() as { n: number }).n, 0);
    } finally { f.close(); }
  }
});

test("missing transit coverage/rows cannot activate either side despite matching settled cash and positions", () => {
  const f = fixture();
  try {
    for (const [account, held] of [[f.source, "6"], [f.target, "0"]]) {
      const missing = f.statement(account, held); delete missing.security_transits; delete missing.coverage.security_transits_complete;
      const result = f.run(missing);
      assert.equal(result.status, "issues"); assert.equal(result.account_activated, false);
      for (const type of ["missing_security_transit_coverage", "missing_statement_security_transits", "missing_statement_security_transit"]) assert.ok(result.issues.some(issue => issue.issue_type === type), type);
      assert.equal(f.status(account), "reconciliation_required");
    }
    const flagOnly = f.statement(f.target, "0"); delete flagOnly.security_transits;
    assert.ok(f.run(flagOnly).issues.some(issue => issue.issue_type === "missing_statement_security_transits"));
    const rowsOnly = f.statement(f.target, "0"); delete rowsOnly.coverage.security_transits_complete;
    assert.ok(f.run(rowsOnly).issues.some(issue => issue.issue_type === "missing_security_transit_coverage"));
  } finally { f.close(); }
});

test("pending receiving cannot be counted as settled target shares or retained source shares", () => {
  const f = fixture();
  try {
    for (const [account, incorrectlyHeld] of [[f.source, "10"], [f.target, "4"]]) {
      const result = f.run(f.statement(account, incorrectlyHeld));
      assert.equal(result.status, "issues"); assert.ok(result.issues.some(issue => issue.issue_type === "position_mismatch"));
      assert.equal(result.account_activated, false);
    }
  } finally { f.close(); }
});

test("transit rows reject quantity differences, duplicates, missing lots, forged scope and client cost", () => {
  const f = fixture();
  try {
    const foreignPortfolio = createPortfolio(f.db, actor, "Other synthetic", now), foreignAccount = createAccount(f.db, actor, foreignPortfolio, "Other", "No broker", "CNY", now);
    const patches: [Partial<Transit>, string][] = [[{ quantity: "4.000000000000000001" }, "security_transit_quantity_mismatch"], [{ quantity: "0" }, "invalid_statement_security_transit_quantity"], [{ quantity: "-4" }, "invalid_statement_security_transit_quantity"], [{ source_account_id: foreignAccount }, "invalid_statement_security_transit"], [{ source_account_id: f.target, target_account_id: f.source }, "security_transit_identity_mismatch"], [{ listing_id: "missing" }, "invalid_statement_security_transit"], [{ currency: "USD" }, "security_transit_identity_mismatch"], [{ transfer_event_id: "missing" }, "unexpected_statement_security_transit"]];
    for (const [patch, expected] of patches) {
      const statement = f.statement(f.target, "0", [{ ...f.lot("4"), ...patch }]);
      const result = f.run(statement); assert.equal(result.account_activated, false); assert.ok(result.issues.some(issue => issue.issue_type === expected), expected);
      if (patch.quantity === "4.000000000000000001") assert.equal(result.issues.find(issue => issue.issue_type === expected)!.details.difference, "0.000000000000000001");
    }
    assert.ok(f.run(f.statement(f.target, "0", [f.lot("4"), f.lot("4")])).issues.some(issue => issue.issue_type === "duplicate_security_transit"));
    assert.ok(f.run(f.statement(f.target, "0", [])).issues.some(issue => issue.issue_type === "missing_statement_security_transit"));
    const extraCost = f.statement(f.target, "0"); (extraCost.security_transits![0] as Transit & { cost_amount: string }).cost_amount = "0";
    const attachment = f.store(extraCost, f.target);
    assert.throws(() => reconcileAccount(f.db, actor, { portfolio_id: f.portfolio, account_id: f.target, expected_revision: 2, attachment_id: attachment.id }, f.options), /INVALID_ACCOUNT_STATEMENT/);
  } finally { f.close(); }
});

test("each transfer lot remains distinct and foreign pending currency cannot disappear", () => {
  const f = fixture(null, "USD");
  try {
    const second = f.record({ type: "security_transfer_out", listing_id: "transit-l", quantity: "2", target_account_id: f.target });
    const aggregated = f.run(f.statement(f.target, "0", [f.lot("6")]));
    assert.ok(aggregated.issues.some(issue => issue.issue_type === "security_transit_quantity_mismatch"));
    assert.ok(aggregated.issues.some(issue => issue.issue_type === "missing_statement_security_transit" && issue.details.transfer_event_id === second.event_id));
    const missingCurrency = f.statement(f.target, "0", [f.lot("4"), f.lot("2", second.event_id)]);
    missingCurrency.coverage.currencies = ["CNY"]; missingCurrency.balances = missingCurrency.balances.filter(row => row.currency === "CNY");
    const result = f.run(missingCurrency);
    assert.ok(result.issues.some(issue => issue.issue_type === "missing_currency_coverage" && issue.details.currency === "USD"));
    assert.ok(result.issues.some(issue => issue.issue_type === "security_transit_outside_coverage"));
    assert.equal(f.run(f.statement(f.source, "4", [f.lot("4"), f.lot("2", second.event_id)])).status, "matched");
  } finally { f.close(); }
});

test("partial receipt, return and splits compare remaining quantity without client-supplied cost", () => {
  const f = fixture(null);
  try {
    f.record({ type: "security_transfer_in", account_id: f.target, listing_id: "transit-l", quantity: "1", related_event_id: f.dispatch.event_id }, "2026-01-03");
    assert.equal(f.run(f.statement(f.source, "6", [f.lot("3")])).status, "matched");
    assert.equal(f.run(f.statement(f.target, "1", [f.lot("3")])).status, "matched");
    f.record({ type: "security_transfer_return", listing_id: "transit-l", quantity: "2", related_event_id: f.dispatch.event_id }, "2026-01-04");
    assert.equal(f.run(f.statement(f.source, "8", [f.lot("1")])).status, "matched");
    assert.equal(f.run(f.statement(f.target, "1", [f.lot("1")])).status, "matched");
    f.record({ type: "split", listing_id: "transit-l", split_numerator: "2", split_denominator: "1" }, "2026-01-05");
    f.record({ type: "split", account_id: f.target, listing_id: "transit-l", split_numerator: "2", split_denominator: "1" }, "2026-01-05");
    assert.equal(f.run(f.statement(f.source, "16", [f.lot("2")])).status, "matched");
    assert.equal(f.run(f.statement(f.target, "2", [f.lot("2")])).status, "matched");
    f.record({ type: "security_transfer_in", account_id: f.target, listing_id: "transit-l", quantity: "2", related_event_id: f.dispatch.event_id }, "2026-01-06");
    const oldSource = f.statement(f.source, "16", []), oldTarget = f.statement(f.target, "4", []);
    delete oldSource.security_transits; delete oldSource.coverage.security_transits_complete;
    delete oldTarget.security_transits; delete oldTarget.coverage.security_transits_complete;
    assert.equal(f.run(oldSource).status, "matched"); assert.equal(f.run(oldTarget).status, "matched");
    assert.ok(f.run(f.statement(f.target, "4", [f.lot("2")])).issues.some(issue => issue.issue_type === "unexpected_statement_security_transit"));
    assert.equal(f.db.prepare("SELECT 1 FROM account_projections WHERE ledger_account='cash_settled'").get(), undefined);
  } finally { f.close(); }
});

test("zero-cost transit movements are cutoff relevant for both sides, including receipt/return/split", () => {
  for (const operation of ["out", "in", "return", "split"] as const) {
    const f = fixture(null);
    try {
      let account = f.target, held = "0", pending = "4";
      const cutoff = operation === "out" ? "2026-01-02T00:00:00.000Z" : "2026-01-04T00:00:00.000Z";
      if (operation === "in") { f.record({ type: "security_transfer_in", account_id: f.target, listing_id: "transit-l", quantity: "1", related_event_id: f.dispatch.event_id }, "2026-01-04"); account = f.source; held = "6"; pending = "3"; }
      if (operation === "return") { f.record({ type: "security_transfer_return", listing_id: "transit-l", quantity: "1", related_event_id: f.dispatch.event_id }, "2026-01-04"); pending = "3"; }
      if (operation === "split") { f.record({ type: "split", listing_id: "transit-l", split_numerator: "2", split_denominator: "1" }, "2026-01-04"); pending = "8"; }
      assert.equal((f.db.prepare("SELECT COUNT(*) n FROM postings").get() as { n: number }).n, 0);
      assert.throws(() => f.run(f.statement(account, held, [f.lot(pending)], cutoff)), /HISTORICAL_RECONCILIATION_UNSUPPORTED/, operation);
      assert.equal((f.db.prepare("SELECT COUNT(*) n FROM reconciliation_runs").get() as { n: number }).n, 0);
    } finally { f.close(); }
  }
});

test("a matching supplement needs explicit issue resolution and never activates the other or disabled account", () => {
  const f = fixture();
  try {
    const missing = f.statement(f.target, "0", []), first = f.run(missing);
    assert.equal(first.status, "issues");
    const matched = f.run(f.statement(f.target, "0")); assert.equal(matched.status, "matched"); assert.equal(matched.account_activated, false);
    const resolved = f.run(f.statement(f.target, "0"), first.issues.map(issue => issue.id));
    assert.equal(resolved.account_activated, true); assert.equal(resolved.prior_open_issues, 0); assert.equal(f.status(f.source), "reconciliation_required");
    f.db.prepare("UPDATE accounts SET status='disabled' WHERE id=?").run(f.source);
    assert.equal(f.run(f.statement(f.source, "6")).account_activated, false); assert.equal(f.status(f.source), "disabled");
  } finally { f.close(); }
});
