import assert from "node:assert/strict";
import type { WorkbenchMixedFixture } from "./workbench-mixed-fixture";

/** Check the snapshot actually returned over HTTP, not just the final database. */
export function assertMixedLedgerView(value: any, fixture: WorkbenchMixedFixture, csvRows: number) {
  const target = fixture.ids.csv;
  assert.equal(value.selected, target.portfolio_id);
  assert.equal(value.read_only, false);
  const added = value.revision - fixture.revisions.csv;
  assert.ok(added === 0 || added === csvRows, "CSV_SNAPSHOT_NOT_ATOMIC");
  assert.deepEqual(value.accounts.map((row: any) => row.id).sort(), [...target.account_ids].sort());
  assert.deepEqual(value.positions, []);
  assert.deepEqual(value.security_transits, []);
  assert.equal(value.listings.length, fixture.counts.listings);
  assert.equal(new Set(value.listings.map((row: any) => row.id)).size, fixture.counts.listings);
  const expected = new Map<string, string>();
  target.account_ids.forEach((id, index) => {
    const terms = BigInt(Math.max(0, Math.ceil((fixture.expected.csv_history_facts - index) / 7)));
    let cash = terms * (2n * BigInt(index + 1) + (terms - 1n) * 7n) / 2n;
    if (index === 0 && added) cash += BigInt(csvRows) * (2000001n + BigInt(csvRows)) / 2n;
    if (cash) {
      expected.set(`${id}:CNY:cash_settled`, String(cash));
      expected.set(`${id}:CNY:external_capital`, String(-cash));
    }
  });
  const actual = new Map<string, string>();
  for (const row of value.balances) {
    const key = `${row.account_id}:${row.currency}:${row.ledger_account}`;
    assert.equal(actual.has(key), false, "DUPLICATE_BALANCE");
    assert.match(row.balance, /^(0|-?[1-9]\d*)$/);
    actual.set(key, row.balance);
  }
  assert.deepEqual(actual, expected, "HTTP_CASH_SNAPSHOT_MISMATCH");
  assert.equal(value.events.length, Math.min(value.revision, 100));
  value.events.forEach((row: any, index: number) => {
    assert.equal(row.ledger_revision, value.revision - index);
    assert.equal(row.event_type, "deposit");
    assert.ok(target.account_ids.includes(row.account_id));
  });
}

export function assertMixedGovernanceView(value: any, fixture: WorkbenchMixedFixture, activationId: string) {
  const target = fixture.ids.approval;
  assert.equal(value.ledger_revision, fixture.revisions.approval);
  assert.equal(value.broker_ordering_enabled, false);
  assert.deepEqual(value.policy_versions.map((row: any) => row.id), [target.policy_version_id]);
  assert.deepEqual(value.strategy_versions.map((row: any) => row.id), [target.strategy_version_id]);
  assert.deepEqual(value.activations.map((row: any) => row.id), [activationId]);
  assert.equal(value.capabilities.length, 1);
  assert.equal(value.capabilities[0].account_id, target.account_id);
  assert.deepEqual(value.execution_reports, []);
  assert.ok(Array.isArray(value.proposals) && value.proposals.length <= 200);
  assert.equal(new Set(value.proposals.map((row: any) => row.id)).size, value.proposals.length);
  for (const row of value.proposals) {
    assert.equal(row.ledger_revision, fixture.revisions.approval);
    assert.equal(row.policy_version_id, target.policy_version_id);
    assert.equal(row.strategy_version_id, target.strategy_version_id);
    assert.equal(row.environment, "actual");
    assert.ok(["cancel_remainder", "approved_requires_preexecution_check", "awaiting_human_approval", "blocked"].includes(row.status));
  }
}
