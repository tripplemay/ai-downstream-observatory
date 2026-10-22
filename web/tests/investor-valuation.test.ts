import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { revision } from "../src/server/ledger/service";
import { enqueueWorkbenchTask } from "../src/server/workbench-commands";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { getInvestorValuationContext } from "../src/server/investor/valuation";
import { getInvestorHoldings } from "../src/server/investor/holdings";
import { valuationIntentSchema, type ValuationIntent } from "../src/server/investor/valuation-schemas";
import { holdingsPython, investorHoldingsFixture, holdingsNow } from "./investor-holdings-fixture";
import { publishValuationFixtureMarket } from "./investor-valuation-market-fixture";

type Fixture = ReturnType<typeof investorHoldingsFixture>;
const at = (n: number) => new Date(Date.parse(holdingsNow) + n * 1000).toISOString();
const protectedTables = ["ledger_events", "postings", "position_movements", "security_transit_movements", "position_projections", "account_projections",
  "accounts", "ledger_heads", "reconciliation_runs", "approval_events", "activations", "reservations", "execution_reports", "investor_profiles",
  "investor_funding_plans", "investor_models", "investor_ai_requests"];
function rows(f: Fixture, tables = protectedTables) { return tables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }
function context(f: Fixture, second = 2) { return getInvestorValuationContext(f.db, f.actor, at(second), f.readOptions); }
function core(f: Fixture, second: number) { return holdingsPython(f, "tests.investor.valuation_fixture", ["--now", at(second)]); }
function publish(f: Fixture) {
  assert.equal(context(f, 0).sources.length, 0); publishValuationFixtureMarket(f);
}
function intent(f: Fixture): ValuationIntent {
  const c = context(f);
  return valuationIntentSchema.parse({ action: "request_linked_valuation", portfolio_id: c.portfolio_id, expected_ledger_revision: c.ledger_revision,
    expected_link_id: c.link_id, expected_link_version: c.link_version, expected_context_hash: c.context_hash, cutoff_at: c.cutoff_at,
    prices: c.listings.length ? [{ market: "CN", scope: "FICTIONAL:prices", expected_session: "2026-01-02" }] : [],
    fx: c.currencies.some(currency => currency !== "CNY") ? { scope: "FICTIONAL:fx", max_age_seconds: 86400 } : null,
    source_reference: "Fictional rules reviewed, not provider certification", acknowledgement: true, basis: "owner_reviewed_valuation_rules_not_provider_certification" });
}
function submit(f: Fixture, input = intent(f), key = "fictional-valuation", expected?: number) {
  return executeInvestorCommand(f.db, f.actor, { ...input, idempotency_key: key, expected_revision: expected ?? getInvestorState(f.db, f.actor, at(3)).revision }, at(3), f.readOptions);
}

test("valuation metadata is whole-book, independent-reconciliation-gated, read-only and never invents market data or authority", () => {
  const f = investorHoldingsFixture({ twoAccounts: true }); try {
    const initial = context(f); assert.equal(initial.cutoff_at, null); assert.equal(initial.accounts.length, 2);
    assert.deepEqual(initial.gaps, ["RECONCILIATION_REQUIRED"]); f.reconcile(); f.reconcile(f.second!);
    f.db.prepare("UPDATE accounts SET status='disabled',row_version=row_version+1 WHERE id=?").run(f.second);
    const before = f.db.prepare("SELECT total_changes() n").get(), c = context(f);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); assert.deepEqual(c.gaps, []);
    assert.equal(c.cutoff_at, f.statement().cutoff_at); assert.equal(c.accounts[1].gap, null); assert.equal(c.execution_authorized, false);
    assert.doesNotMatch(JSON.stringify(c), /"(?:amount|quantity|price|nav_cny|budget|balance)"/);
    assert.deepEqual(c.sources, []); assert.throws(() => getInvestorValuationContext(f.db, { id: "foreign" }, at(2), f.readOptions), /OUT_OF_SCOPE/);
  } finally { f.close(); }
});

test("ordinary whole-book request queues exactly once, runs the real core valuation, then passes the independent holdings verifier", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    f.reconcile(); publish(f); assert.equal(context(f).sources.length, 2);
    assert.ok(context(f).sources.every(row => row.mode === "manual_verified"));
    const before = rows(f), c = context(f), input = intent(f), receipt = submit(f, input);
    assert.equal(receipt.action, "request_linked_valuation"); assert.deepEqual(rows(f), before);
    assert.equal(context(f, 3).task?.status, "queued");
    const queued = f.db.prepare("SELECT count(*) n FROM command_requests WHERE command_type='valuation'").get();
    assert.deepEqual(submit(f, input, "fictional-valuation", c.workspace_revision), receipt);
    assert.deepEqual(f.db.prepare("SELECT count(*) n FROM command_requests WHERE command_type='valuation'").get(), queued);
    const payload = JSON.parse((f.db.prepare("SELECT payload_json FROM command_requests WHERE id=?").get(receipt.resource_id) as { payload_json: string }).payload_json);
    assert.equal(payload.expected_inputs.ledger_revision, c.ledger_revision); assert.equal(Object.keys(payload.expected_inputs.market_heads).length, 2);
    assert.equal(payload.mode, "restated"); assert.equal(payload.rules.approved, true);
    const afterRequest = context(f, 3); core(f, 4);
    assert.equal(context(f, 5).context_hash, afterRequest.context_hash); assert.equal(context(f, 5).task?.status, "succeeded");
    const result = getInvestorHoldings(f.db, f.actor, at(5), f.readOptions);
    assert.equal(result.status, "verified_as_of"); assert.equal(result.snapshot?.nav_cny, "260"); assert.equal(result.snapshot?.cutoff_at, c.cutoff_at!.replace("Z", "000Z"));
    assert.deepEqual(rows(f), before); assert.equal(result.execution_authorized, false);
  } finally { f.close(); }
});

test("CNY-only cash can use the same queue without prices, FX defaults or invented securities", () => {
  const f = investorHoldingsFixture(); try {
    f.reconcile(); const before = rows(f); submit(f); core(f, 4);
    assert.equal(getInvestorHoldings(f.db, f.actor, at(5), f.readOptions).snapshot?.nav_cny, "100"); assert.deepEqual(rows(f), before);
  } finally { f.close(); }
});

test("latest task follows the audited workspace sequence when timestamps tie and ignores lookalike advanced keys", () => {
  const f = investorHoldingsFixture(); try {
    f.reconcile(); submit(f); const second = submit(f, intent(f), "fictional-second");
    assert.equal(context(f, 3).task?.id, second.resource_id);
    enqueueWorkbenchTask(f.db, f.actor, { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: "investor-valuation:advanced",
      command_type: "valuation", payload: { cutoff_at: f.statement().cutoff_at, mode: "restated", rules: { schema_version: "valuation-rules-v1", approved: false,
        price_scope_by_market: {}, expected_sessions: {}, corporate_actions_complete: {}, max_fx_age_seconds: 0 } } }, at(4));
    assert.equal(context(f, 5).task?.id, second.resource_id);
  } finally { f.close(); }
});

test("unreconciled accounts, stale ledger/link/source scope, duplicate markets, foreign sources and invalid acknowledgements cannot queue", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    f.reconcile(); publish(f); const input = intent(f), tables = [...protectedTables, "command_requests", "investor_commands", "audit_events", "investor_workspaces"];
    for (const [i, bad] of [
      { ...input, acknowledgement: false }, { ...input, cutoff_at: at(1) }, { ...input, expected_ledger_revision: 0 },
      { ...input, expected_link_version: 99 }, { ...input, expected_context_hash: "b".repeat(64) }, { ...input, portfolio_id: "foreign" },
      { ...input, prices: [...input.prices, ...input.prices] }, { ...input, prices: [] }, { ...input, fx: null },
      { ...input, prices: [{ ...input.prices[0], scope: "foreign" }] }, { ...input, prices: [{ ...input.prices[0], expected_session: "2026-01-03" }] },
      { ...input, fx: { ...input.fx!, max_age_seconds: 2592001 } }, { ...input, rules: { approved: true } }, { ...input, execution_authorized: true },
    ].entries()) { const before = rows(f, tables); assert.throws(() => submit(f, bad as ValuationIntent, "bad-" + i)); assert.deepEqual(rows(f, tables), before); }
    f.record({ type: "deposit", account_id: f.account, currency: "CNY", amount: "1" }, at(2));
    assert.throws(() => submit(f, input), /CONTEXT_CONFLICT/); const c = context(f), fresh = { ...input, expected_ledger_revision: c.ledger_revision, expected_context_hash: c.context_hash };
    assert.throws(() => submit(f, fresh), /RECONCILIATION_REQUIRED/);
  } finally { f.close(); }
});

test("owner evidence and successful source publication are required, not just globally visible source labels", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    f.reconcile(); publish(f); assert.equal(context(f).sources.length, 2);
    f.db.prepare("UPDATE command_requests SET actor_id='foreign' WHERE command_type='market_ingest'").run();
    assert.deepEqual(context(f).sources, []);
    f.db.prepare("UPDATE command_requests SET actor_id=? WHERE command_type='market_ingest'").run(f.actor.id);
    f.db.prepare("UPDATE job_runs SET status='failed' WHERE job_type='market_ingest'").run();
    assert.deepEqual(context(f).sources, []);
  } finally { f.close(); }
});

test("queued ledger or publication changes stop rather than silently revalue different inputs", () => {
  for (const kind of ["ledger", "market"] as const) {
    const f = investorHoldingsFixture({ securities: true }); try {
      f.reconcile(); publish(f); const request = submit(f);
      if (kind === "ledger") f.record({ type: "deposit", account_id: f.account, currency: "CNY", amount: "1" }, at(3));
      else f.db.prepare("UPDATE market_publications SET revision=revision+1 WHERE scope='FICTIONAL:prices'").run();
      const before = rows(f); core(f, 4); assert.deepEqual(rows(f), before);
      assert.equal((f.db.prepare("SELECT count(*) n FROM valuation_runs").get() as { n: number }).n, 0);
      const job = f.db.prepare("SELECT status,result_json FROM job_runs WHERE command_request_id=?").get(request.resource_id) as { status: string; result_json: string };
      assert.equal(job.status, "skipped"); assert.equal(JSON.parse(job.result_json).code, "VALUATION_INPUTS_CHANGED");
    } finally { f.close(); }
  }
});

test("a completed but provisional valuation never becomes verified NAV; recovery blocks requests and exact successful retries", () => {
  const f = investorHoldingsFixture({ securities: true }); try {
    f.reconcile(); publish(f); const input = intent(f); input.prices[0].expected_session = "2026-01-01";
    const c = context(f); submit(f, input); core(f, 4);
    assert.equal(context(f, 5).task?.status, "succeeded"); const result = getInvestorHoldings(f.db, f.actor, at(5), f.readOptions);
    assert.equal(result.snapshot, null); assert.ok(result.gaps.includes("VALUATION_NOT_COMPLETE"));
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "FICTIONAL\n"); assert.equal(context(f, 5).read_only, true);
    const before = rows(f, [...protectedTables, "command_requests", "investor_commands", "audit_events"]);
    assert.throws(() => submit(f, input, "fictional-valuation", c.workspace_revision), /WORKBENCH_READ_ONLY/); assert.deepEqual(rows(f, [...protectedTables, "command_requests", "investor_commands", "audit_events"]), before);
  } finally { f.close(); }
});

test("late investor audit failure rolls back the lower queue, dedup, receipt and workspace version", () => {
  const f = investorHoldingsFixture(); try {
    f.reconcile(); const input = intent(f), tables = [...protectedTables, "command_requests", "command_dedup", "audit_events", "investor_commands", "investor_workspaces"], before = rows(f, tables);
    f.db.exec("CREATE TRIGGER fictional_valuation_failure BEFORE INSERT ON audit_events WHEN NEW.action='investor_request_linked_valuation' BEGIN SELECT RAISE(ABORT,'FICTIONAL_AUDIT_FAILURE'); END");
    assert.throws(() => submit(f, input), /FICTIONAL_AUDIT_FAILURE/); assert.deepEqual(rows(f, tables), before);
  } finally { f.close(); }
});
