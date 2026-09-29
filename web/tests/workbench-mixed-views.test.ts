import assert from "node:assert/strict";
import test from "node:test";
import { assertMixedGovernanceView, assertMixedLedgerView } from "../scripts/workbench-mixed-views";
import type { WorkbenchMixedFixture } from "../scripts/workbench-mixed-fixture";

const fixture = {
  ids: { csv: { portfolio_id: "csv", account_ids: ["a", "b", "c", "d", "e", "f", "g"] },
    approval: { account_id: "approval", policy_version_id: "policy", strategy_version_id: "strategy" } },
  revisions: { csv: 8, approval: 1 }, counts: { listings: 2 }, expected: { csv_history_facts: 8 },
} as unknown as WorkbenchMixedFixture;
function ledger(confirmed = false) {
  const revision = 8 + (confirmed ? 2 : 0);
  return { selected: "csv", read_only: false, revision, accounts: fixture.ids.csv.account_ids.map(id => ({ id })),
    positions: [], security_transits: [], listings: [{ id: "one" }, { id: "two" }],
    balances: fixture.ids.csv.account_ids.flatMap((id, index) => {
      const amount = index === 0 ? 9 + (confirmed ? 2000003 : 0) : index + 1;
      return [{ account_id: id, currency: "CNY", ledger_account: "cash_settled", balance: String(amount) },
        { account_id: id, currency: "CNY", ledger_account: "external_capital", balance: String(-amount) }];
    }), events: Array.from({ length: revision }, (_, index) => ({ ledger_revision: revision - index, event_type: "deposit", account_id: "a" })) };
}
test("HTTP ledger snapshots independently check pre-confirm and atomic completed balances", () => {
  assertMixedLedgerView(ledger(), fixture, 2);
  assertMixedLedgerView(ledger(true), fixture, 2);
  for (const mutate of [
    (value: any) => { value.balances[0].balance = "10"; },
    (value: any) => { value.revision = 9; },
    (value: any) => { value.balances.push(value.balances[0]); },
    (value: any) => { value.events[0].ledger_revision--; },
    (value: any) => { value.accounts[0].id = "foreign"; },
    (value: any) => { value.listings[1].id = "one"; },
  ]) { const value = ledger(); mutate(value); assert.throws(() => assertMixedLedgerView(value, fixture, 2)); }
});
test("HTTP governance snapshots cannot pass as an empty or cross-scope 200 response", () => {
  const value = { ledger_revision: 1, broker_ordering_enabled: false, policy_versions: [{ id: "policy" }], strategy_versions: [{ id: "strategy" }],
    activations: [{ id: "activation" }], capabilities: [{ account_id: "approval" }], execution_reports: [], proposals: [] };
  assertMixedGovernanceView(value, fixture, "activation");
  assert.throws(() => assertMixedGovernanceView({}, fixture, "activation"));
  for (const change of [{ broker_ordering_enabled: true }, { policy_versions: [] }, { ledger_revision: 2 }, { capabilities: [{ account_id: "foreign" }] },
    { execution_reports: [{ id: "unexpected" }] }, { activations: [{ id: "other" }] }]) {
    assert.throws(() => assertMixedGovernanceView({ ...value, ...change }, fixture, "activation"));
  }
});
