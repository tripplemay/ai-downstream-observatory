import assert from "node:assert/strict";
import test from "node:test";
import { blankValuationDraft, buildValuationIntent, parseValuationContext } from "../src/components/workbench/investor-valuation-client";
import { valuationContext as c, valuationScope as scope, valuationBinding as binding, validValuationDraft } from "./investor-valuation-fixture";
import { investorCommandSchema } from "../src/server/investor/schemas";

test("valuation reads bind session, workspace, ledger and link, reject unknown data and never accept another owner scope", () => {
  assert.deepEqual(parseValuationContext({ ...c, session_binding: binding }, scope), c);
  for (const change of [{ session_binding: "b".repeat(64) }, { workspace_id: "foreign" }, { workspace_revision: 99 }, { portfolio_id: "foreign" },
    { ledger_revision: 99 }, { link_id: "foreign" }, { link_version: 2 }, { amount: "100" }, { execution_authorized: true }, { task: { id: "fictional", status: "approved" } }]) {
    assert.throws(() => parseValuationContext({ ...c, session_binding: binding, ...change }, scope));
  }
});
test("typed valuation draft starts with no source, session, FX tolerance, reference or approval defaults", () => {
  const d = blankValuationDraft(c); assert.equal(d.acknowledged, false); assert.equal(d.prices[0].scope, ""); assert.equal(d.prices[0].session, "");
  assert.deepEqual([d.fxScope, d.fxAge, d.reference], ["", "", ""]); assert.throws(() => buildValuationIntent(c, d));
  const intent = buildValuationIntent(c, validValuationDraft()); assert.equal(intent.action, "request_linked_valuation");
  assert.doesNotMatch(JSON.stringify(intent), /"(?:amount|quantity|approved|rules|nav_cny|expected_revision|idempotency_key)"/);
  assert.ok(investorCommandSchema.safeParse({ ...intent, expected_revision: 2, idempotency_key: "fictional" }).success);
  for (const context of [{ ...c, read_only: true }, { ...c, gaps: ["RECONCILIATION_REQUIRED"] }, { ...c, cutoff_at: null }]) assert.throws(() => buildValuationIntent(context as typeof c, validValuationDraft()));
  for (const change of [{ acknowledged: false }, { reference: "" }, { fxAge: "" }, { fxAge: "86400.0" }, { fxAge: "2592001" }, { fxScope: "foreign" }, { prices: [] },
    { prices: [{ market: "CN" as const, scope: "foreign", session: "2026-01-02" }] }]) assert.throws(() => buildValuationIntent(c, { ...validValuationDraft(), ...change }));
});

test("published scope identifiers are preserved exactly rather than silently trimmed into different market keys", () => {
  const context = { ...c, sources: c.sources.map(row => row.batch_type === "fx" ? { ...row, scope: " fictional-fx " } : row) };
  const parsed = parseValuationContext({ ...context, session_binding: binding }, scope);
  assert.equal(buildValuationIntent(parsed, { ...validValuationDraft(), fxScope: " fictional-fx " }).fx?.scope, " fictional-fx ");
});
