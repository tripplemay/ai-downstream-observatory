import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createPortfolio, createAccount, recordFact } from "../src/server/ledger/service";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { getInvestorAccountWorkspace } from "../src/server/investor/accounts";
import { parseInvestorAccounts } from "../src/components/workbench/investor-accounts-client";
import { parseInvestorState, verifyInvestorReceipt } from "../src/components/workbench/investor-client";
import { investorActor as actor, investorFixture, investorNow as now, saveSyntheticProfile } from "./investor-fixture";

const binding = "a".repeat(64), account = { name: "Fictional account", broker: "Fictional broker", currency: "CNY" };
type Fixture = ReturnType<typeof investorFixture>;
const protectedTables = ["ledger_events", "postings", "position_movements", "account_projections", "position_projections", "approval_events", "activations", "reservations", "execution_reports"];
function facts(f: Fixture) { return protectedTables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }
function command(f: Fixture, intent: Record<string, unknown>, key = "test", rev?: number) {
  return executeInvestorCommand(f.db, actor, { ...intent, idempotency_key: key, expected_revision: rev ?? getInvestorState(f.db, actor, now).revision }, now);
}
function book(f: Fixture, owner = actor) { const id = createPortfolio(f.db, owner, "Fictional ledger", now); createAccount(f.db, owner, id, account.name, account.broker, account.currency, now); return id; }

test("optional accounts GET is read only and never chooses a global first portfolio", () => {
  const f = investorFixture(); try {
    const own = book(f), other = book(f, { id: "other" }), before = facts(f), changes = f.db.prepare("SELECT total_changes() n").get();
    assert.equal(getInvestorAccountWorkspace(f.db, actor, now).workspace_id, null);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes);
    saveSyntheticProfile(f); const afterProfile = f.db.prepare("SELECT total_changes() n").get();
    const state = getInvestorAccountWorkspace(f.db, actor, now);
    assert.deepEqual(state.books.map(row => row.id), [own]); assert.ok(!JSON.stringify(state).includes(other));
    assert.equal(state.link, null); assert.deepEqual(state.accounts, []); assert.equal(state.execution_authorized, false);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), afterProfile); assert.deepEqual(facts(f), before);
    assert.throws(() => getInvestorAccountWorkspace(f.db, { id: "" }, now), /UNAUTHENTICATED/);
  } finally { f.close(); }
});

test("explicit link and unlink are versioned metadata only and preserve all actual facts", () => {
  const f = investorFixture(); try {
    saveSyntheticProfile(f); const own = book(f), before = facts(f);
    const intent = { action: "link_portfolio", portfolio_id: own, expected_ledger_revision: 0 };
    const receipt = command(f, intent, "link", 1);
    assert.deepEqual(command(f, intent, "link", 1), receipt);
    const linked = getInvestorAccountWorkspace(f.db, actor, now);
    assert.equal(linked.link?.version, 1); assert.equal(linked.link?.document.portfolio_id, own); assert.equal(linked.accounts.length, 1);
    const main = getInvestorState(f.db, actor, now); assert.equal(main.actual_holdings_status, "linked");
    assert.deepEqual(parseInvestorState({ ...main, session_binding: binding }, binding), main);
    command(f, { action: "link_portfolio", portfolio_id: null, expected_ledger_revision: null }, "unlink");
    const removed = getInvestorAccountWorkspace(f.db, actor, now);
    assert.equal(removed.link?.version, 2); assert.equal(removed.link?.document.portfolio_id, null); assert.equal(removed.accounts.length, 0);
    assert.equal(getInvestorState(f.db, actor, now).actual_holdings_status, "not_linked"); assert.deepEqual(facts(f), before);
    assert.equal((f.db.prepare("SELECT count(*) n FROM accounts").get() as { n: number }).n, 1);
    for (const sql of ["DELETE FROM investor_portfolio_links", "UPDATE investor_portfolio_links SET version=4", "INSERT OR REPLACE INTO investor_portfolio_links SELECT * FROM investor_portfolio_links LIMIT 1"])
      assert.throws(() => f.db.exec(sql), /immutable|binding differs/);
  } finally { f.close(); }
});

test("foreign or unaudited books, stale revisions and incoherent nulls cannot be linked", () => {
  const f = investorFixture(); try {
    saveSyntheticProfile(f); const own = book(f), foreign = book(f, { id: "other" });
    f.db.prepare("INSERT INTO portfolios(id,name,created_at) VALUES('unaudited','Fictional',?)").run(now);
    f.db.prepare("INSERT INTO ledger_heads VALUES('unaudited',0,?)").run(now);
    const before = facts(f);
    for (const id of [foreign, "unaudited", "missing"]) assert.throws(() => command(f, { action: "link_portfolio", portfolio_id: id, expected_ledger_revision: 0 }, id), /OUT_OF_SCOPE/);
    assert.throws(() => command(f, { action: "link_portfolio", portfolio_id: own, expected_ledger_revision: 1 }), /LEDGER_VERSION_CONFLICT/);
    for (const [portfolio_id, expected_ledger_revision] of [[null, 0], [own, null]])
      assert.throws(() => command(f, { action: "link_portfolio", portfolio_id, expected_ledger_revision }), /ACCOUNT_INPUT_INVALID/);
    assert.equal(getInvestorState(f.db, actor, now).revision, 1); assert.equal(f.db.prepare("SELECT * FROM investor_portfolio_links").all().length, 0);
    assert.deepEqual(facts(f), before);
  } finally { f.close(); }
});

test("one explicit book setup creates empty metadata atomically and retries never add another account", () => {
  const f = investorFixture(); try {
    saveSyntheticProfile(f); const before = facts(f), input = { action: "create_account_book", book_name: "Fictional private ledger", account };
    const result = command(f, input, "setup", 1); assert.deepEqual(command(f, input, "setup", 1), result);
    const state = getInvestorAccountWorkspace(f.db, actor, now);
    assert.equal(state.books.length, 1); assert.equal(state.accounts.length, 1); assert.equal(state.accounts[0].status, "reconciliation_required");
    assert.equal(state.books[0].ledger_revision, 0); assert.deepEqual(facts(f), before);
    verifyInvestorReceipt({ ...result, session_binding: binding }, { body: JSON.stringify({ ...input, expected_revision: 1 }), binding, workspace: state.workspace_id });
    command(f, { action: "add_linked_account", portfolio_id: state.books[0].id, expected_ledger_revision: 0, account: { ...account, currency: "USD" } }, "another");
    assert.equal(getInvestorAccountWorkspace(f.db, actor, now).accounts.length, 2); assert.deepEqual(facts(f), before);
    assert.throws(() => command(f, { action: "add_linked_account", portfolio_id: "foreign", expected_ledger_revision: 0, account }, "foreign"), /OUT_OF_SCOPE/);
  } finally { f.close(); }
});

test("setup does not happen before preferences and late recovery freezes even exact retries", () => {
  const f = investorFixture(); try {
    const input = { action: "create_account_book", book_name: "Fictional private ledger", account };
    assert.throws(() => command(f, input, "setup", 0), /PROFILE_REQUIRED/);
    assert.equal(f.db.prepare("SELECT * FROM portfolios").all().length, 0);
    saveSyntheticProfile(f); command(f, input, "setup", 1);
    const before = f.db.prepare("SELECT total_changes() n").get();
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "FICTIONAL RECOVERY LOCK\n");
    assert.equal(getInvestorAccountWorkspace(f.db, actor, now).read_only, true);
    assert.throws(() => command(f, input, "setup", 1), /WORKBENCH_READ_ONLY/);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  } finally { f.close(); }
});

test("actual cash changes require independent fact commands and invalidate a stale account setup revision", () => {
  const f = investorFixture(); try {
    saveSyntheticProfile(f); command(f, { action: "create_account_book", book_name: "Fictional", account }, "setup");
    const state = getInvestorAccountWorkspace(f.db, actor, now), portfolioId = state.books[0].id;
    recordFact(f.db, actor, { portfolio_id: portfolioId, expected_revision: 0, idempotency_key: "cash", source_id: "fictional-broker", source_event_id: "fictional-deposit",
      effective_at: "2026-01-01", time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Fictional independent fact",
      fact: { type: "deposit", account_id: state.accounts[0].id, currency: "CNY", amount: "123.00" } }, now);
    const before = facts(f);
    assert.throws(() => command(f, { action: "add_linked_account", portfolio_id: portfolioId, expected_ledger_revision: 0, account }, "stale"), /LEDGER_VERSION_CONFLICT/);
    assert.equal(getInvestorAccountWorkspace(f.db, actor, now).books[0].ledger_revision, 1);
    assert.deepEqual(facts(f), before); assert.equal(getInvestorAccountWorkspace(f.db, actor, now).scope, "account_records_not_valued");
  } finally { f.close(); }
});

test("legacy microsecond ledger times remain exact across account association and client reads", () => {
  const f = investorFixture(); try {
    saveSyntheticProfile(f);
    const created = "2026-01-01T12:00:00.000001Z";
    const portfolioId = createPortfolio(f.db, actor, "Fictional microsecond ledger", created);
    const accountId = createAccount(f.db, actor, portfolioId, account.name, account.broker, account.currency, created);
    recordFact(f.db, actor, { portfolio_id: portfolioId, expected_revision: 0, idempotency_key: "microsecond-cash", source_id: "fictional-broker", source_event_id: "fictional-microsecond-deposit",
      effective_at: "2026-01-01", time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Fictional independent fact",
      fact: { type: "deposit", account_id: accountId, currency: "CNY", amount: "123.00" } }, "2026-01-02T11:59:59.999999Z");
    const before = facts(f);
    command(f, { action: "link_portfolio", portfolio_id: portfolioId, expected_ledger_revision: 1 }, "microsecond-link");
    const value = getInvestorAccountWorkspace(f.db, actor, now);
    assert.equal(value.books[0].created_at, created); assert.equal(value.accounts[0].created_at, created);
    assert.equal(value.books[0].ledger_revision, 1);
    assert.deepEqual(parseInvestorAccounts({ ...value, session_binding: binding }, { binding, workspace: value.workspace_id, revision: value.workspace_revision }), value);
    f.db.prepare("UPDATE ledger_heads SET updated_at=? WHERE portfolio_id=?").run(now.replace(".000Z", ".000000Z"), portfolioId);
    assert.equal(getInvestorAccountWorkspace(f.db, actor, now).link?.document.portfolio_id, portfolioId);
    command(f, { action: "create_account_book", book_name: "Fictional second ledger", account }, "microsecond-existing-book-setup");
    const setup = getInvestorAccountWorkspace(f.db, actor, now);
    assert.equal(setup.books.length, 2);
    f.db.prepare("UPDATE ledger_heads SET updated_at=? WHERE portfolio_id=?").run(now.replace(".000Z", ".000000Z"), setup.link!.document.portfolio_id);
    assert.equal(getInvestorAccountWorkspace(f.db, actor, now).books.length, 2);
    f.db.prepare("UPDATE ledger_heads SET updated_at=? WHERE portfolio_id=?").run(now.replace(".000Z", ".000001Z"), portfolioId);
    assert.throws(() => getInvestorAccountWorkspace(f.db, actor, now), /ACCOUNT_EVIDENCE_INVALID/);
    f.db.prepare("UPDATE ledger_heads SET updated_at=? WHERE portfolio_id=?").run(created.replace(".000001Z", ".000000Z"), portfolioId);
    assert.throws(() => getInvestorAccountWorkspace(f.db, actor, now), /ACCOUNT_EVIDENCE_INVALID/);
    assert.deepEqual(facts(f), before);
  } finally { f.close(); }
});

test("legacy account timestamps reject invalid calendars and even one microsecond of future evidence", () => {
  const f = investorFixture(); try {
    saveSyntheticProfile(f); command(f, { action: "create_account_book", book_name: "Fictional", account }, "setup");
    const value = getInvestorAccountWorkspace(f.db, actor, now), expected = { binding, workspace: value.workspace_id, revision: value.workspace_revision };
    const equal = now.replace(".000Z", ".000000Z");
    const response = { ...value, session_binding: binding, accounts: [{ ...value.accounts[0], created_at: equal }] };
    assert.equal(parseInvestorAccounts(response, expected).accounts[0].created_at, equal);
    for (const created_at of [now.replace(".000Z", ".000001Z"), "2026-02-30T00:00:00.000000Z", "0000-01-01T00:00:00.000000Z", "2026-01-01T00:00:00.0001Z", "2026-01-01T00:00:00Z"]) {
      assert.throws(() => parseInvestorAccounts({ ...response, accounts: [{ ...response.accounts[0], created_at }] }, expected), /RESPONSE_INVALID/);
      f.db.prepare("UPDATE accounts SET created_at=? WHERE id=?").run(created_at, value.accounts[0].id);
      assert.throws(() => getInvestorAccountWorkspace(f.db, actor, now), /ACCOUNT_EVIDENCE_INVALID/);
    }
  } finally { f.close(); }
});

test("invalid link digests, mutated creation audits and future evidence fail closed", () => {
  for (const mutate of [
    (f: Fixture) => { f.db.exec("DROP TRIGGER investor_portfolio_link_no_update"); f.db.prepare("UPDATE investor_portfolio_links SET content_hash=?").run("b".repeat(64)); },
    (f: Fixture) => { f.db.exec("DROP TRIGGER investor_portfolio_link_no_update"); f.db.prepare("UPDATE investor_portfolio_links SET version=2").run(); },
    (f: Fixture) => { f.db.prepare("UPDATE ledger_heads SET updated_at='2027-01-01T00:00:00.000Z'").run(); },
    (f: Fixture) => { f.db.prepare("UPDATE accounts SET created_at='2027-01-01T00:00:00.000Z'").run(); },
  ]) {
    const f = investorFixture(); try {
      saveSyntheticProfile(f); command(f, { action: "create_account_book", book_name: "Fictional", account }, "setup"); mutate(f);
      assert.throws(() => getInvestorAccountWorkspace(f.db, actor, now), /EVIDENCE_INVALID/);
      const state = getInvestorState(f.db, actor, now);
      if (state.actual_holdings_status === "unavailable") assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    } finally { f.close(); }
  }
});

test("broken optional account association hides account evidence without making research depend on the ledger", () => {
  const f = investorFixture(); try {
    saveSyntheticProfile(f); command(f, { action: "create_account_book", book_name: "Fictional", account }, "setup");
    const before = facts(f);
    f.db.exec("DROP TRIGGER investor_portfolio_link_no_update"); f.db.prepare("UPDATE investor_portfolio_links SET content_hash=?").run("b".repeat(64));
    const state = getInvestorState(f.db, actor, now); assert.equal(state.actual_holdings_status, "unavailable");
    assert.equal(state.profile?.document.loss_tolerance, null); assert.equal(state.live_advice_eligible, false);
    command(f, { action: "evaluate" }, "independent-research");
    assert.equal(getInvestorState(f.db, actor, now).revision, 3); assert.deepEqual(facts(f), before);
    assert.throws(() => getInvestorAccountWorkspace(f.db, actor, now), /ACCOUNT_EVIDENCE_INVALID/);
  } finally { f.close(); }
});

test("account client rejects mismatched scope, truncated limits, duplicated books and implicit trading permissions", () => {
  const f = investorFixture(); try {
    saveSyntheticProfile(f); command(f, { action: "create_account_book", book_name: "Fictional", account }, "setup");
    const value = getInvestorAccountWorkspace(f.db, actor, now), expected = { binding, workspace: value.workspace_id, revision: value.workspace_revision };
    assert.deepEqual(parseInvestorAccounts({ ...value, session_binding: binding }, expected), value);
    for (const extra of [{ session_binding: "b".repeat(64) }, { workspace_id: "other" }, { workspace_revision: 1 }, { books: [] },
      { books: [...value.books, ...value.books] }, { execution_authorized: true }, { accounts: Array(201).fill(value.accounts[0]) },
      { scope: "actual_portfolio" }, { actor_id: "forged" }, { link: null }])
      assert.throws(() => parseInvestorAccounts({ ...value, session_binding: binding, ...extra }, expected), /RESPONSE_INVALID/);
  } finally { f.close(); }
});
