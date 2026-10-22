import assert from "node:assert/strict";
import test from "node:test";
import { RECONCILIATION_BALANCES } from "../src/server/ledger/reconciliation-schemas";
import { getInvestorReconciliationContext } from "../src/server/investor/reconciliation";
import * as client from "../src/components/workbench/investor-reconciliation-client";
import { investorHoldingsFixture, holdingsNow } from "./investor-holdings-fixture";
import { mountInvestorDisplay } from "./investor-display-fixture";

const binding = "a".repeat(64);
function mount(t: { after: (fn: () => void) => void }) {
  const f = investorHoldingsFixture(); t.after(() => f.close());
  const context = getInvestorReconciliationContext(f.db, f.actor, f.account, holdingsNow, f.readOptions);
  const scope = { binding, workspace: context.workspace_id, revision: context.workspace_revision, portfolio: context.portfolio_id,
    ledgerRevision: context.ledger_revision, linkId: context.link_id, linkVersion: context.link_version, accountId: context.account_id,
    accountRowVersion: context.account_row_version };
  const commands: unknown[] = [], locks: boolean[] = [];
  const h = mountInvestorDisplay(t, new URL("../src/components/workbench/investor-reconciliation-panel.tsx", import.meta.url), "InvestorReconciliationPanel",
    { scope, accountName: "Fictional account", disabled: false, onCommand: (value: unknown) => commands.push(value), onDraftLockChange: (value: boolean) => locks.push(value) },
    { "next/link": { default: "Link" }, "@/components/ui/input": { Input: "Input" },
      "@/components/session-boundary": { useSessionBoundary: () => ({ verified: true, sessionBinding: binding }) },
      "@/server/ledger/reconciliation-schemas": { RECONCILIATION_BALANCES }, "./investor-reconciliation-client": client }, Date.parse(holdingsNow));
  return { ...h, context, scope, commands, locks, response: { ...context, session_binding: binding } };
}

test("a reconciliation response discarded after another account operation locks the scope is cancelled, never parsed or reused", async t => {
  const h = mount(t); await h.flush(); assert.equal(h.requests.length, 1);
  const signal = h.requests[0].options.signal!; assert.equal(signal.aborted, false);
  await h.change({ disabled: true });
  let parsed = false;
  h.requests[0].resolve({ status: 200, ok: true, json: async () => { parsed = true; return h.response; }, text: async () => "" });
  await h.flush();
  assert.equal(parsed, false); assert.equal(signal.aborted, true); assert.equal(h.timers.size, 0);
  assert.equal(h.button("录入独立资料"), undefined); assert.equal(h.commands.length, 0);
  await h.change({ disabled: false }); assert.equal(h.requests.length, 2);
  await h.reply(1, h.response); assert.equal(h.button("录入独立资料")?.props.disabled, false);
  assert.ok(h.requests.every(row => row.method === "GET"));
});

test("a rejected reconciliation response closes its unread body and does not automatically retry", async t => {
  const h = mount(t); await h.flush(); await h.reply(0, { error: "fictional unavailable" }, 503);
  assert.equal(h.requests[0].options.signal!.aborted, true); assert.equal(h.timers.size, 0);
  assert.match(h.text(), /对账范围读取未通过核验/);
  await h.advance(Date.parse(holdingsNow) + 300000); assert.equal(h.requests.length, 1); assert.equal(h.commands.length, 0);
  await h.click("重读对账范围"); await h.reply(1, h.response);
  assert.equal(h.button("录入独立资料")?.props.disabled, false);
});

test("valid reconciliation JSON finishes before cleanup; verified context survives without a fact or draft mutation", async t => {
  const h = mount(t); await h.flush(); const signal = h.requests[0].options.signal!;
  let complete!: () => void, parsed = false;
  const body = new Promise<void>(resolve => { complete = resolve; });
  h.requests[0].resolve({ status: 200, ok: true, json: async () => { parsed = true; await body; return h.response; }, text: async () => "" });
  await h.flush(); assert.equal(parsed, true); assert.equal(signal.aborted, false); assert.equal(h.button("录入独立资料"), undefined);
  complete(); await h.flush(); assert.equal(signal.aborted, true); assert.equal(h.timers.size, 0);
  assert.equal(h.button("录入独立资料")?.props.disabled, false); assert.equal(h.commands.length, 0);
  assert.match(h.text(), /尚未保存该账户的独立对账/);
});

test("scope changes and session invalidation cancel old reads and ignore late foreign 401 responses", async t => {
  const h = mount(t); await h.flush(); const first = h.requests[0].options.signal!;
  await h.change({ scope: { ...h.scope, revision: h.scope.revision + 1 } }); assert.equal(first.aborted, true);
  await h.reply(0, null, 401); assert.equal(h.requests.length, 2); assert.equal(h.commands.length, 0);
  const second = h.requests[1].options.signal!; assert.equal(second.aborted, false);
  await h.invalidate(); assert.equal(second.aborted, true);
  await h.reply(1, h.response); assert.equal(h.button("录入独立资料"), undefined);
  h.close(); assert.equal(h.timers.size, 0); assert.ok([...h.windowListeners.values(), ...h.documentListeners.values()].every(rows => rows.size === 0));
});
