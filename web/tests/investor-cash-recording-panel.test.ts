import assert from "node:assert/strict";
import test from "node:test";
import * as client from "../src/components/workbench/investor-cash-recording-client";
import { TRADE_RECORDING_ZONES } from "../src/server/investor/trade-recording-schemas";
import { mountInvestorDisplay } from "./investor-display-fixture";
import { cashBinding as binding, cashContext as context, cashScope as scope } from "./investor-cash-recording-fixture";

type Tree = { type: unknown; props: Record<string, unknown> };
function mount(t: { after: (fn: () => void) => void }) {
  const commands: unknown[] = [], locks: boolean[] = [];
  const h = mountInvestorDisplay(t, new URL("../src/components/workbench/investor-cash-recording-panel.tsx", import.meta.url), "InvestorCashRecordingPanel",
    { scope, accountName: "Fictional account", disabled: false, onCommand: (input: unknown) => commands.push(input), onDraftLockChange: (value: boolean) => locks.push(value) },
    { "@/components/ui/input": { Input: "Input" }, "@/components/session-boundary": { useSessionBoundary: () => ({ verified: true, sessionBinding: binding }) },
      "@/server/investor/trade-recording-schemas": { TRADE_RECORDING_ZONES }, "./investor-cash-recording-client": client }, Date.parse(context.checked_at));
  function field(label: string) {
    const node = h.nodes().find(row => row.type === "label" && h.words(row).startsWith(label)); assert.ok(node, label);
    const children = node.props.children as Tree[], input = children.find(row => row && ["Input", "select"].includes(String(row.type))); assert.ok(input, label); return input;
  }
  function handler() { const form = h.node("form"); assert.ok(form); return form.props.onSubmit as (event: { preventDefault: () => void }) => void; }
  return { ...h, commands, locks, handler,
    fields: () => h.nodes().filter(row => ["Input", "select"].includes(String(row.type))),
    input: async (label: string, value: string) => { (field(label).props.onChange as (event: unknown) => void)({ target: { value } }); await h.flush(); },
    acknowledge: async (checked: boolean) => { const checkbox = h.nodes().find(row => row.type === "input" && row.props.type === "checkbox"); assert.ok(checkbox);
      (checkbox.props.onChange as (event: unknown) => void)({ target: { checked } }); await h.flush(); },
    submit: async (twice = false) => { const submit = handler(); submit({ preventDefault() {} }); if (twice) submit({ preventDefault() {} }); await h.flush(); },
  };
}
async function fill(h: ReturnType<typeof mount>) {
  for (const [label, value] of [["已发生的资金方向", "deposit"], ["实际资金币种", "USD"], ["实际资金本金", "300.01"],
    ["实际资金日期", "2026-01-01"], ["资金资料时区", "America/New_York"], ["资金来源标识", "FICTIONAL"],
    ["原始资金流水", "cash-1"], ["资金独立资料", "Fictional cash record"]]) await h.input(label, value);
}

test("cash entry starts with one lazy metadata GET and blank fields; only one acknowledged immutable intent reaches the parent", async t => {
  const h = mount(t); await h.flush(); assert.equal(h.requests.length, 0);
  await h.click("录入已到账或已转出资金"); assert.equal(h.locks.at(-1), true); assert.equal(h.requests[0].method, "GET");
  assert.match(h.requests[0].url, /cash-recording\?account=fictional-account$/);
  await h.reply(0, { ...context, session_binding: binding }); assert.ok(h.fields().every(row => row.props.value === ""));
  assert.deepEqual(h.fields().filter(row => row.type === "select").map(row => row.props["aria-label"]), ["已发生的资金方向", "实际资金币种", "资金资料时区"]);
  await fill(h); await h.acknowledge(true); await h.input("实际资金本金", "300.02");
  await h.submit(); assert.equal(h.commands.length, 0); assert.match(h.text(), /明确确认/);
  await h.acknowledge(true); await h.submit(true); assert.equal(h.commands.length, 1); assert.equal(h.locks.at(-1), false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.commands[0])), client.buildCashRecordingIntent(context, { ...client.blankCashRecordingDraft(),
    direction: "deposit", currency: "USD", amount: "300.02", date: "2026-01-01", zone: "America/New_York", source: "FICTIONAL", sourceEvent: "cash-1", reference: "Fictional cash record", acknowledged: true }));
  assert.equal(h.requests.length, 1);
});

test("cash metadata failure does not retry or submit money; late 401 from an old scope cannot poison the new context", async t => {
  const h = mount(t); await h.flush(); await h.click("录入已到账或已转出资金"); await h.fail(0);
  assert.equal(h.requests.length, 1); assert.match(h.text(), /当前账户或版本未通过核验/); assert.equal(h.commands.length, 0);
  await h.click("录入已到账或已转出资金"); await h.change({ scope: { ...scope, accountId: "another-account" } });
  await h.reply(1, null, 401); assert.equal(h.button("录入已到账或已转出资金")!.props.disabled, false);
  assert.equal(h.commands.length, 0); assert.equal(h.locks.at(-1), false);
});

test("cash draft cannot survive identity changes or send through a stale callback; navigation protection is removed on cleanup", async t => {
  const h = mount(t); await h.flush(); await h.click("录入已到账或已转出资金"); await h.reply(0, { ...context, session_binding: binding });
  await fill(h); await h.acknowledge(true); const old = h.handler();
  assert.equal(h.windowListeners.get("beforeunload")?.size, 1); assert.equal(h.documentListeners.get("click")?.size, 1);
  await h.change({ scope: { ...scope, revision: scope.revision + 1 } }); old({ preventDefault() {} }); await h.flush();
  assert.equal(h.commands.length, 0); assert.equal(h.fields().length, 0); assert.equal(h.locks.at(-1), false);
  h.close(); assert.ok([...h.windowListeners.values(), ...h.documentListeners.values()].every(rows => rows.size === 0)); assert.equal(h.timers.size, 0);
});

test("cash session invalidation discards the draft and blocks old actions without a POST", async t => {
  const h = mount(t); await h.flush(); await h.click("录入已到账或已转出资金"); await h.reply(0, { ...context, session_binding: binding });
  await fill(h); await h.acknowledge(true); const old = h.handler(); await h.invalidate(); old({ preventDefault() {} }); await h.flush();
  assert.equal(h.commands.length, 0); assert.equal(h.fields().length, 0); assert.equal(h.button("录入已到账或已转出资金")!.props.disabled, true);
  assert.ok(h.requests.every(row => row.method === "GET"));
});
