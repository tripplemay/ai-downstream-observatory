import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { getInvestorHoldings } from "../src/server/investor/holdings";
import { getInvestorAccountWorkspace } from "../src/server/investor/accounts";
import { getInvestorState } from "../src/server/investor/service";
import { investorHoldingsSchema, HoldingsDecimal as Decimal } from "../src/server/investor/holdings-schemas";
import { parseInvestorHoldings } from "../src/components/workbench/investor-holdings-client";
import { investorActor as actor, investorFixture } from "./investor-fixture";
import { holdingsNow as now, investorHoldingsFixture } from "./investor-holdings-fixture";

const binding = "a".repeat(64);
type Fixture = ReturnType<typeof investorHoldingsFixture>;
const get = (f: Fixture) => getInvestorHoldings(f.db, actor, now, f.readOptions);
const changes = (f: { db: Fixture["db"] }) => f.db.prepare("SELECT total_changes() n").get();
function expected(f: Fixture) {
  const accounts = getInvestorAccountWorkspace(f.db, actor, now), book = accounts.books.find(row => row.id === accounts.link?.document.portfolio_id);
  return { binding, workspace: accounts.workspace_id, revision: accounts.workspace_revision, portfolio: book?.id ?? null,
    linkId: book ? accounts.link!.id : null, linkVersion: book ? accounts.link!.version : null, ledgerRevision: book?.ledger_revision ?? null,
    accountIds: accounts.accounts.map(row => row.id), plan: getInvestorState(f.db, actor, now).plan };
}

test("holdings read has no implicit scope, never creates facts and does not treat setup as reconciliation", () => {
  const empty = investorFixture(); try {
    const before = changes(empty), value = getInvestorHoldings(empty.db, actor, now);
    assert.equal(value.status, "not_linked"); assert.equal(value.snapshot, null); assert.deepEqual(changes(empty), before);
  } finally { empty.close(); }
  const f = investorHoldingsFixture(); try {
    const before = changes(f), value = get(f);
    assert.equal(value.status, "evidence_required"); assert.deepEqual(value.gaps, ["RECONCILIATION_REQUIRED"]);
    assert.equal(value.snapshot, null); assert.equal(value.comparison, null); assert.deepEqual(changes(f), before);
    const foreign = getInvestorHoldings(f.db, { id: "another-owner" }, now, f.readOptions);
    assert.equal(foreign.portfolio_id, null); assert.equal(foreign.workspace_id, null); assert.ok(!JSON.stringify(foreign).includes(f.portfolio));
  } finally { f.close(); }
});

test("real Node reconciliation and Python cash valuation reach a zero-write, explicitly as-of composition", () => {
  const f = investorHoldingsFixture(); try {
    assert.equal(f.reconcile().status, "matched"); assert.equal(get(f).gaps[0], "VALUATION_REQUIRED");
    assert.equal(f.publish().nav_cny, "100");
    const before = changes(f), value = get(f);
    assert.equal(value.status, "verified_as_of"); assert.equal(value.snapshot?.nav_cny, "100");
    assert.equal(value.snapshot?.components[0].category, "cash_settled"); assert.equal(value.snapshot?.components[0].weight, "1.000000000000000000");
    assert.equal(value.snapshot?.account_sync, "recorded_facts_only_not_realtime");
    assert.deepEqual(value.gaps, ["REFERENCE_NOT_READY"]); assert.equal(value.execution_authorized, false);
    assert.deepEqual(parseInvestorHoldings({ ...value, session_binding: binding }, expected(f)), value);
    assert.deepEqual(changes(f), before);
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "FICTIONAL RECOVERY LOCK\n");
    assert.equal(get(f).read_only, true); assert.equal(get(f).status, "verified_as_of"); assert.deepEqual(changes(f), before);
  } finally { f.close(); }
});

test("entire book includes foreign cash, signed payables, outside securities and each in-transit share exactly once", () => {
  const f = investorHoldingsFixture({ securities: true, twoAccounts: true, transit: true }); try {
    assert.equal(f.reconcile().status, "matched"); assert.equal(f.publish().quality, "complete");
    assert.equal(get(f).snapshot, null); assert.ok(get(f).gaps.includes("RECONCILIATION_REQUIRED"));
    assert.equal(f.reconcile(f.second!).status, "matched");
    const before = changes(f), value = get(f), snapshot = value.snapshot!;
    assert.equal(value.status, "verified_as_of"); assert.equal(snapshot.nav_cny, "310"); assert.equal(snapshot.reconciliations.length, 2);
    const alpha = snapshot.components.find(row => row.listing_id === f.alpha)!;
    assert.equal(alpha.value_cny, "60"); assert.equal(alpha.settled_quantity, "4"); assert.equal(alpha.transit_quantity, "2");
    assert.equal(snapshot.components.find(row => row.category === "cash_settled" && row.currency === "USD")?.value_cny, "70");
    assert.equal(snapshot.components.find(row => row.category === "trade_payable")?.value_cny, "-10");
    assert.equal(snapshot.components.find(row => row.listing_id === f.outside)?.value_cny, "40");
    assert.deepEqual(parseInvestorHoldings({ ...value, session_binding: binding }, expected(f)), value);
    assert.deepEqual(changes(f), before);
  } finally { f.close(); }
});

test("new facts, changed projections, missing original and mutated reconciliation result cannot retain verified balances", () => {
  for (const mutate of [
    (f: Fixture) => { f.record({ type: "deposit", account_id: f.account, currency: "CNY", amount: "1" }, "2026-01-02T12:00:13.000Z"); },
    (f: Fixture) => { f.db.prepare("UPDATE account_projections SET balance='101' WHERE account_id=? AND ledger_account='cash_settled'").run(f.account); },
    (f: Fixture) => { f.db.prepare("UPDATE reconciliation_runs SET result_json='{}'").run(); },
    (f: Fixture) => { const attachment = f.db.prepare("SELECT storage_key FROM attachments LIMIT 1").get() as { storage_key: string }; unlinkSync(path.join(f.directory, attachment.storage_key)); },
  ]) {
    const f = investorHoldingsFixture(); try {
      f.reconcile(); f.publish(); assert.equal(get(f).status, "verified_as_of"); mutate(f);
      const before = changes(f), value = get(f); assert.equal(value.snapshot, null); assert.equal(value.comparison, null);
      assert.equal(value.status, "evidence_required"); assert.ok(value.gaps[0].startsWith("RECONCILIATION_")); assert.deepEqual(changes(f), before);
    } finally { f.close(); }
  }
});

test("future or falsified valuation totals/items fail closed", () => {
  for (const mutate of [
    (f: Fixture) => { f.db.prepare("UPDATE valuation_runs SET nav_cny='101'").run(); },
    (f: Fixture) => { f.db.prepare("UPDATE valuation_runs SET created_at='2026-01-02T12:00:20.000001Z'").run(); },
    (f: Fixture) => { f.db.prepare("UPDATE valuation_items SET value_cny='101'").run(); },
    (f: Fixture) => { f.db.prepare("UPDATE valuation_runs SET issues_json='[]'").run(); },
    (f: Fixture) => { f.db.prepare("UPDATE valuation_items SET quality='provisional'").run(); },
  ]) {
    const f = investorHoldingsFixture(); try {
      f.reconcile(); f.publish();
      // Fault injection is confined to this disposable database; production records remain immutable.
      f.db.exec("DROP TRIGGER valuations_no_update; DROP TRIGGER valuation_items_no_update;");
      mutate(f); const before = changes(f), value = get(f);
      assert.equal(value.status, "evidence_required"); assert.equal(value.snapshot, null); assert.ok(value.gaps[0].startsWith("VALUATION_")); assert.deepEqual(changes(f), before);
    } finally { f.close(); }
  }
});

test("client independently checks whole-book arithmetic, accounts, scope and every derived weight", () => {
  const f = investorHoldingsFixture({ twoAccounts: true }); try {
    f.reconcile(); f.reconcile(f.second!); f.publish(); const value = get(f), context = expected(f);
    for (const patch of [ { session_binding: "b".repeat(64) }, { portfolio_id: "foreign" }, { ledger_revision: 0 }, { execution_authorized: true },
      { snapshot: { ...value.snapshot, nav_cny: "151" } }, { snapshot: { ...value.snapshot, components: [{ ...value.snapshot!.components[0], weight: "0.9" }] } },
      { snapshot: { ...value.snapshot, reconciliations: value.snapshot!.reconciliations.slice(1) } }, { status: "not_linked" }, { gaps: ["RECONCILIATION_REQUIRED"] }, { accidental_raw_statement: {} } ])
      assert.throws(() => parseInvestorHoldings({ ...value, session_binding: binding, ...patch }, context), /RESPONSE_INVALID/);
    const old = value.snapshot!;
    const fake = { ...value, snapshot: { ...old, components: [{ ...old.components[0], account_ids: [f.account] }], reconciliations: old.reconciliations.filter(row => row.account_id === f.account) } };
    assert.ok(investorHoldingsSchema.safeParse(fake).success);
    assert.throws(() => parseInvestorHoldings({ ...fake, session_binding: binding }, context), /RESPONSE_INVALID/);
  } finally { f.close(); }
});

test("newest incomplete valuation is not replaced by an older complete snapshot", () => {
  const f = investorHoldingsFixture(); try {
    f.reconcile(); f.publish(); assert.equal(get(f).status, "verified_as_of");
    f.db.prepare(`INSERT INTO valuation_runs(id,portfolio_id,ledger_revision,market_manifest,method_version,cutoff_at,quality,nav_cny,issues_json,created_at)
      SELECT 'fictional-newer-incomplete',portfolio_id,ledger_revision,market_manifest,method_version,'2026-01-02T12:00:09.000001Z','blocked',NULL,issues_json,'2026-01-02T12:00:12.000001Z'
      FROM valuation_runs LIMIT 1`).run();
    const before = changes(f), value = get(f);
    assert.equal(value.snapshot, null); assert.deepEqual(value.gaps, ["VALUATION_NOT_COMPLETE"]); assert.deepEqual(changes(f), before);
  } finally { f.close(); }
});

test("fictional reconstructed research resolves different ledger IDs only through unique audited identity mappings", () => {
  const f = investorHoldingsFixture({ securities: true, twoAccounts: true, transit: true, reference: true }); try {
    f.reconcile(); f.reconcile(f.second!); f.publish();
    const before = changes(f), value = get(f), comparison = value.comparison!;
    assert.equal(value.status, "verified_as_of"); assert.deepEqual(value.gaps, []); assert.ok(comparison);
    assert.equal(comparison.rows.length, 2); assert.equal(comparison.outside_target_value_cny, "250");
    const alpha = comparison.rows.find(row => row.symbol === "501998.SH")!;
    assert.equal(alpha.actual_value_cny, "60"); assert.equal(alpha.ledger_listing_id, f.alpha); assert.notEqual(alpha.research_listing_id, f.alpha);
    assert.equal(alpha.difference_cny, new Decimal("60").minus(new Decimal("310").mul(alpha.target_weight)).toFixed());
    assert.deepEqual(parseInvestorHoldings({ ...value, session_binding: binding }, expected(f)), value); assert.deepEqual(changes(f), before);
    const wrong = structuredClone(value); wrong.comparison!.rows[0].difference_cny = "0";
    assert.throws(() => parseInvestorHoldings({ ...wrong, session_binding: binding }, expected(f)), /RESPONSE_INVALID/);
    const duplicate = structuredClone(value); duplicate.comparison!.rows[1].ledger_listing_id = duplicate.comparison!.rows[0].ledger_listing_id;
    assert.throws(() => parseInvestorHoldings({ ...duplicate, session_binding: binding }, expected(f)), /RESPONSE_INVALID/);
    const relabeled = structuredClone(value); relabeled.comparison!.rows[0].symbol = "FORGED.SH";
    assert.ok(investorHoldingsSchema.safeParse(relabeled).success);
    assert.throws(() => parseInvestorHoldings({ ...relabeled, session_binding: binding }, expected(f)), /RESPONSE_INVALID/);
    const prolonged = structuredClone(value); prolonged.comparison!.valid_until = "2027-12-01T00:00:00.000Z";
    assert.ok(investorHoldingsSchema.safeParse(prolonged).success);
    assert.throws(() => parseInvestorHoldings({ ...prolonged, session_binding: binding }, expected(f)), /RESPONSE_INVALID/);
    f.db.prepare("UPDATE listings SET ticker='DIFFERENT' WHERE id=?").run(f.alpha);
    const changed = get(f); assert.equal(changed.status, "verified_as_of"); assert.equal(changed.comparison, null);
    assert.ok(changed.gaps.includes("REFERENCE_IDENTITY_REQUIRED"));
  } finally { f.close(); }
});
