import assert from "node:assert/strict";
import { readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { getInvestorReconciliationContext } from "../src/server/investor/reconciliation";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { canonical, createPortfolio, createAccount } from "../src/server/ledger/service";
import { reconciliationIntentSchema } from "../src/server/investor/reconciliation-schemas";
import { parseInvestorReconciliation, blankStatementDraft, buildReconciliationIntent, statementDayCutoff } from "../src/components/workbench/investor-reconciliation-client";
import { investorHoldingsFixture, holdingsNow as now } from "./investor-holdings-fixture";

const binding = "a".repeat(64);
type Fixture = ReturnType<typeof investorHoldingsFixture>;
const tables = ["ledger_events", "postings", "position_movements", "account_projections", "position_projections", "security_transit_movements", "security_transit_projections",
  "approval_events", "activations", "reservations", "execution_reports"];
function facts(f: Fixture) { return tables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }
function row(f: Fixture, sql: string, ...values: string[]) { return f.db.prepare(sql).get(...values) as { n: number; status: string }; }
function context(f: Fixture, account = f.account) { return getInvestorReconciliationContext(f.db, f.actor, account, now, f.readOptions); }
function intent(f: Fixture, cash = "100") {
  const ctx = context(f), statement = f.statement();
  statement.balances.find(row => row.currency === "CNY" && row.ledger_account === "cash_settled")!.balance = cash;
  return { action: "reconcile_linked_account", portfolio_id: f.portfolio, account_id: f.account, expected_ledger_revision: ctx.ledger_revision,
    expected_account_row_version: ctx.account_row_version, expected_link_id: ctx.link_id, expected_link_version: ctx.link_version,
    source_reference: "Fictional independent manual transcription", basis: "operator_transcription_not_broker_file", acknowledgement: true,
    statement, resolves_issue_ids: [] as string[], resolution_reason: "" };
}
function submit(f: Fixture, input = intent(f), key = "fictional-reconcile", revision?: number) {
  const n = (f.db.prepare("SELECT count(*) n FROM reconciliation_runs").get() as { n: number }).n;
  const commandAt = new Date(Date.parse(now) - 100 + n).toISOString();
  return executeInvestorCommand(f.db, f.actor, { ...input, idempotency_key: key, expected_revision: revision ?? getInvestorState(f.db, f.actor, now).revision }, commandAt, f.readOptions);
}
function expected(f: Fixture) { const c = context(f); return { binding, workspace: c.workspace_id, revision: c.workspace_revision, portfolio: c.portfolio_id,
  ledgerRevision: c.ledger_revision, linkId: c.link_id, linkVersion: c.link_version, accountId: c.account_id, accountRowVersion: c.account_row_version }; }

test("reconciliation context is explicit, owned, zero-write metadata with no amount or quantity prefills", () => {
  const f = investorHoldingsFixture({ securities: true, twoAccounts: true, transit: true }); try {
    const foreignBook = createPortfolio(f.db, { id: "other" }, "Fictional foreign", now);
    const foreignAccount = createAccount(f.db, { id: "other" }, foreignBook, "Fictional foreign", "Fictional broker", "USD", now);
    const before = f.db.prepare("SELECT total_changes() n").get(), result = context(f);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    assert.equal(result.latest, null); assert.deepEqual(result.requirements.currencies, ["CNY", "USD"]);
    assert.equal(result.requirements.known_positions.length, 2); assert.equal(result.requirements.transits.length, 1);
    assert.ok(!JSON.stringify(result).includes(foreignAccount)); assert.ok(!JSON.stringify(result).includes('"quantity"')); assert.ok(!JSON.stringify(result).includes('"balance"'));
    for (const account of [foreignAccount, "missing"]) assert.throws(() => context(f, account), /OUT_OF_SCOPE/);
    assert.equal(result.execution_authorized, false); assert.deepEqual(parseInvestorReconciliation({ ...result, session_binding: binding }, expected(f)), result);
    const blank = blankStatementDraft(result);
    assert.ok(blank.currencies.every(row => Object.values(row.balances).every(value => value === "") && !row.zeroOthers));
    assert.ok([...blank.positions, ...blank.transits].every(row => row.quantity === "")); assert.equal(blank.acknowledged, false);
  } finally { f.close(); }
});

test("reconciliation currencies exclude accounting counterlegs that are not broker balances", () => {
  const f = investorHoldingsFixture(); try {
    f.db.prepare("INSERT INTO account_projections(account_id,currency,ledger_account,balance,ledger_revision) VALUES(?,?,?,?,?)")
      .run(f.account, "USD", "external_capital", "-10", 1);
    assert.deepEqual(context(f).requirements.currencies, ["CNY"]);
    f.db.prepare("INSERT INTO account_projections(account_id,currency,ledger_account,balance,ledger_revision) VALUES(?,?,?,?,?)")
      .run(f.account, "USD", "cash_settled", "10", 1);
    assert.deepEqual(context(f).requirements.currencies, ["CNY", "USD"]);
  } finally { f.close(); }
});

test("explicit structured matching is atomic metadata, original bytes, immutable receipt and idempotent retry", () => {
  const f = investorHoldingsFixture(); try {
    const input = intent(f), before = facts(f), revision = getInvestorState(f.db, f.actor, now).revision;
    const receipt = submit(f, input, "same", revision), after = f.db.prepare("SELECT total_changes() n").get();
    assert.equal(receipt.action, "reconcile_linked_account"); assert.deepEqual(submit(f, input, "same", revision), receipt);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), after); assert.deepEqual(facts(f), before);
    const current = context(f); assert.equal(current.latest?.status, "matched"); assert.equal(current.latest?.account_activated, true);
    assert.equal(current.account_row_version, input.expected_account_row_version + 1); assert.equal(current.workspace_revision, revision + 1);
    const source = f.db.prepare("SELECT a.content_hash FROM attachments a JOIN reconciliation_runs r ON r.attachment_id=a.id WHERE r.id=?").get(receipt.resource_id) as { content_hash: string };
    assert.ok(source.content_hash); assert.equal(row(f, "SELECT count(*) n FROM reconciliation_runs").n, 1);
    assert.throws(() => submit(f, { ...input, source_reference: "different" }, "same", revision), /DUPLICATE_CONFLICT/);
  } finally { f.close(); }
});

test("mismatch stays open and new matching evidence does not silently resolve previous issues", () => {
  const f = investorHoldingsFixture(); try {
    const before = facts(f); submit(f, intent(f, "99"), "wrong");
    let ctx = context(f); assert.equal(ctx.latest?.status, "issues"); assert.equal(ctx.open_issue_count, 1); assert.equal(ctx.latest?.account_activated, false);
    submit(f, intent(f), "right-without-resolution"); ctx = context(f);
    assert.equal(ctx.latest?.status, "matched"); assert.equal(ctx.open_issue_count, 1); assert.equal(ctx.latest?.account_activated, false);
    const fixed = { ...intent(f), resolves_issue_ids: ctx.open_issues.map(row => row.id), resolution_reason: "Fictional transcription corrected from independent source" };
    submit(f, fixed, "explicit-resolution"); ctx = context(f);
    assert.equal(ctx.open_issue_count, 0); assert.equal(ctx.latest?.account_activated, true); assert.deepEqual(facts(f), before);
    assert.equal(row(f, "SELECT count(*) n FROM reconciliation_issues WHERE status='resolved'").n, 1);
  } finally { f.close(); }
});

test("scope, version, acknowledgement and supported cutoff failures leave no submission or attachment rows", () => {
  const f = investorHoldingsFixture(); try {
    const valid = intent(f), ws = getInvestorState(f.db, f.actor, now).revision, before = facts(f);
    const cases = [
      { ...valid, expected_account_row_version: valid.expected_account_row_version + 1 }, { ...valid, expected_ledger_revision: valid.expected_ledger_revision + 1 },
      { ...valid, expected_link_version: valid.expected_link_version + 1 }, { ...valid, expected_link_id: "another" }, { ...valid, portfolio_id: "another" },
      { ...valid, acknowledgement: false }, { ...valid, basis: "broker_certified" },
      { ...valid, statement: { ...valid.statement, cutoff_at: now.replace(".000Z", ".000001Z") } },
      { ...valid, statement: { ...valid.statement, cutoff_at: "2026-01-01T00:00:00Z" } },
      { ...valid, statement: { ...valid.statement, cutoff_at: "2026-02-30T00:00:00Z" } },
      { ...valid, resolves_issue_ids: ["foreign"], resolution_reason: "No" },
    ];
    for (const [i, input] of cases.entries()) assert.throws(() => executeInvestorCommand(f.db, f.actor, { ...input, expected_revision: ws, idempotency_key: "bad-" + i }, now, f.readOptions));
    assert.throws(() => submit(f, valid, "stale-workspace", ws - 1), /VERSION_CONFLICT/);
    assert.equal(row(f, "SELECT count(*) n FROM reconciliation_runs").n, 0); assert.equal(row(f, "SELECT count(*) n FROM attachments").n, 0);
    assert.equal(getInvestorState(f.db, f.actor, now).revision, ws); assert.deepEqual(facts(f), before);
  } finally { f.close(); }
});

test("lost old original hides its result but permits a new independent submission without clearing old issues", () => {
  const f = investorHoldingsFixture(); try {
    submit(f, intent(f, "99"), "mismatch");
    const attachment = f.db.prepare("SELECT storage_key FROM attachments LIMIT 1").get() as { storage_key: string };
    unlinkSync(path.join(f.directory, attachment.storage_key));
    const broken = context(f); assert.equal(broken.history_status, "unavailable"); assert.equal(broken.latest, null); assert.equal(broken.open_issue_count, 1);
    assert.deepEqual(broken.open_issues, []); submit(f, intent(f), "new-source");
    const current = context(f); assert.equal(current.history_status, "unavailable"); assert.equal(current.latest, null); assert.equal(current.open_issue_count, 1);
    assert.equal(row(f, "SELECT status FROM accounts WHERE id=?", f.account).status, "reconciliation_required");
  } finally { f.close(); }
});

test("a source audit recorded after reconciliation cannot authenticate its historical result", () => {
  const f = investorHoldingsFixture(); try {
    submit(f);
    assert.equal(context(f).history_status, "verified");
    f.db.exec("DROP TRIGGER audit_events_no_update");
    f.db.prepare("UPDATE audit_events SET created_at=? WHERE action='store_attachment'").run(now);
    const result = context(f);
    assert.equal(result.history_status, "unavailable"); assert.equal(result.latest, null);
  } finally { f.close(); }
});

test("forged security or transit identities are rejected before any source file is stored", () => {
  const f = investorHoldingsFixture({ securities: true, twoAccounts: true, transit: true }); try {
    const valid = intent(f), before = facts(f), revision = getInvestorState(f.db, f.actor, now).revision;
    const cases = [
      { ...valid, statement: { ...valid.statement, positions: valid.statement.positions.map((row, i) => i ? row : { ...row, listing_id: "foreign-listing" }) } },
      { ...valid, statement: { ...valid.statement, positions: valid.statement.positions.map((row, i) => i ? row : { ...row, currency: "USD" }) } },
      ...["transfer_event_id", "source_account_id", "target_account_id", "listing_id"].map(key => ({ ...valid, statement: { ...valid.statement,
        security_transits: valid.statement.security_transits!.map(row => ({ ...row, [key]: "foreign" })) } })),
    ];
    for (const [i, input] of cases.entries()) assert.throws(() => submit(f, input, "forged-" + i, revision), /INPUT_INVALID/);
    assert.deepEqual(facts(f), before); assert.equal(row(f, "SELECT count(*) n FROM attachments").n, 0);
    assert.equal(row(f, "SELECT count(*) n FROM reconciliation_runs").n, 0);
  } finally { f.close(); }
});

test("disabled account and recovery locks cannot be bypassed by structured reconciliation", () => {
  const f = investorHoldingsFixture(); try {
    f.db.prepare("UPDATE accounts SET status='disabled',row_version=row_version+1 WHERE id=?").run(f.account);
    submit(f); assert.equal(context(f).latest?.account_activated, false); assert.equal(row(f, "SELECT status FROM accounts WHERE id=?", f.account).status, "disabled");
    const before = f.db.prepare("SELECT total_changes() n").get(); writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "FICTIONAL RECOVERY\n");
    assert.equal(context(f).read_only, true); assert.throws(() => submit(f, intent(f), "restore"), /WORKBENCH_READ_ONLY/);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  } finally { f.close(); }
});

test("late audit failure rolls back all DB records and leaves at most a private unreferenced source blob", () => {
  const f = investorHoldingsFixture(); try {
    const before = facts(f), ctx = context(f);
    f.db.exec("CREATE TRIGGER fictional_reconciliation_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action='investor_reconcile_linked_account' BEGIN SELECT RAISE(ABORT,'fictional failure'); END");
    assert.throws(() => submit(f), /fictional failure/); assert.deepEqual(facts(f), before);
    assert.equal(context(f).account_row_version, ctx.account_row_version); assert.equal(context(f).workspace_revision, ctx.workspace_revision);
    for (const table of ["reconciliation_runs", "reconciliation_issues", "attachments"]) assert.equal(row(f, `SELECT count(*) n FROM ${table}`).n, 0);
    assert.equal(row(f, "SELECT count(*) n FROM investor_commands WHERE idempotency_key='fictional-reconcile'").n, 0);
    const blobs = readdirSync(path.join(f.directory, "attachments")); assert.equal(blobs.length, 1);
    assert.equal(statSync(path.join(f.directory, "attachments", blobs[0])).mode & 0o777, 0o600);
  } finally { f.close(); }
});

test("equal-instant latest reconciliation is ambiguous, never an arbitrary UUID choice", () => {
  const f = investorHoldingsFixture(); try {
    submit(f, intent(f, "99"), "wrong"); submit(f, intent(f), "right");
    f.db.prepare("UPDATE reconciliation_runs SET created_at=?").run(now);
    assert.equal(context(f).history_status, "unavailable"); assert.equal(context(f).latest, null);
  } finally { f.close(); }
});

test("client rejects changed scopes, unclosed metadata and amount-bearing responses", () => {
  const f = investorHoldingsFixture(); try {
    const result = context(f), expectedScope = expected(f), raw = { ...result, session_binding: binding };
    for (const patch of [{ session_binding: "b".repeat(64) }, { account_id: "foreign" }, { link_id: "old" }, { link_version: result.link_version + 1 },
      { ledger_revision: result.ledger_revision + 1 }, { account_row_version: result.account_row_version + 1 }, { workspace_revision: result.workspace_revision + 1 },
      { requirements: { ...result.requirements, balances: [{ amount: "100" }] } }, { execution_authorized: true }, { open_issue_count: 1 }])
      assert.throws(() => parseInvestorReconciliation({ ...raw, ...patch }, expectedScope), /RESPONSE_INVALID/);
    assert.throws(() => parseInvestorReconciliation({ ...raw, requirements: { ...result.requirements, currencies: ["CNY", "CNY"] } }, expectedScope), /RESPONSE_INVALID/);
  } finally { f.close(); }
});

test("manual draft requires real values, explicit zeros and complete acknowledgement, with exact DST date boundary", () => {
  const f = investorHoldingsFixture(); try {
    const ctx = context(f), draft = blankStatementDraft(ctx);
    assert.throws(() => buildReconciliationIntent(ctx, draft), /DRAFT_INVALID/);
    Object.assign(draft, { source: "Fictional independent source", date: "2026-01-01", zone: "Asia/Shanghai", acknowledged: true });
    draft.currencies[0].balances.cash_settled = "100";
    assert.throws(() => buildReconciliationIntent(ctx, draft), /DRAFT_INVALID/);
    draft.currencies[0].zeroOthers = true;
    const input = buildReconciliationIntent(ctx, draft); assert.equal(input.statement.cutoff_at, "2026-01-01T16:00:00.000Z");
    assert.ok(input.statement.balances.filter(row => row.ledger_account !== "cash_settled").every(row => row.balance === "0"));
    assert.ok(reconciliationIntentSchema.safeParse(input).success);
    draft.acknowledged = false; assert.throws(() => buildReconciliationIntent(ctx, draft), /DRAFT_INVALID/);
    assert.equal(statementDayCutoff("2026-03-07", "America/New_York"), "2026-03-08T05:00:00.000Z");
    assert.equal(statementDayCutoff("2026-03-08", "America/New_York"), "2026-03-09T04:00:00.000Z");
    assert.equal(statementDayCutoff("2026-11-01", "America/New_York"), "2026-11-02T05:00:00.000Z");
    assert.equal(statementDayCutoff("2026-02-30", "UTC"), null); assert.equal(statementDayCutoff("2026-01-01", "invented"), null);
  } finally { f.close(); }
});
