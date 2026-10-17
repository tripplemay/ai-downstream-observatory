import assert from "node:assert/strict";
import test from "node:test";
import * as client from "../src/components/workbench/investor-valuation-client";
import { mountInvestorDisplay } from "./investor-display-fixture";
import { valuationContext as c, valuationScope as scope, valuationBinding as binding } from "./investor-valuation-fixture";

type Tree = { type: unknown; props: Record<string, unknown> };
function mount(t: { after: (fn: () => void) => void }) {
  const commands: unknown[] = [], locks: boolean[] = [];
  const h = mountInvestorDisplay(t, new URL("../src/components/workbench/investor-valuation-panel.tsx", import.meta.url), "InvestorValuationPanel",
    { scope, disabled: false, onCommand: (input: unknown) => commands.push(input), onDraftLockChange: (locked: boolean) => locks.push(locked) },
    { "@/components/ui/input": { Input: "Input" }, "@/components/session-boundary": { useSessionBoundary: () => ({ verified: true, sessionBinding: binding }) },
      "./investor-valuation-client": client }, Date.parse(c.checked_at));
  function handler() { const form = h.node("form"); assert.ok(form); return form.props.onSubmit as (event: { preventDefault: () => void }) => void; }
  return { ...h, commands, locks, handler,
    input: async (label: string, value: string) => {
      const parent = h.nodes().find(row => row.type === "label" && h.words(row).startsWith(label)); assert.ok(parent, label);
      const input = (parent.props.children as Tree[]).find(row => row && ["Input", "select"].includes(String(row.type))); assert.ok(input);
      (input.props.onChange as (event: unknown) => void)({ target: { value } }); await h.flush();
    },
    acknowledge: async (checked: boolean) => { const box = h.nodes().find(row => row.type === "input" && row.props.type === "checkbox"); assert.ok(box);
      (box.props.onChange as (event: unknown) => void)({ target: { checked } }); await h.flush(); },
  };
}
async function open(h: ReturnType<typeof mount>, document = c) {
  await h.flush(); await h.click("核对估值准备情况与任务"); await h.reply(h.requests.length - 1, { ...document, session_binding: binding });
}
test("valuation opens lazily, never posts on reads, requires explicit rules and sends one intent to the parent's immutable retry path", async t => {
  const h = mount(t); await h.flush(); assert.equal(h.requests.length, 0); await open(h);
  assert.equal(h.locks.at(-1), false); assert.ok(h.requests[0].options.signal?.aborted); await h.click("选择来源并确认本次估值"); assert.equal(h.locks.at(-1), true);
  assert.ok(h.nodes().filter(row => ["Input", "select"].includes(String(row.type))).every(row => row.props.value === ""));
  for (const [name, value] of [["A 股价格来源", "fictional-prices"], ["A 股预期最近交易日", "2026-01-02"], ["汇率来源", "fictional-fx"],
    ["允许的汇率最大时效", "86400"], ["本次规则核查", "Fictional review"]]) await h.input(name, value);
  await h.acknowledge(true); await h.input("本次规则核查", "Fictional revised review"); h.handler()({ preventDefault() {} }); await h.flush(); assert.equal(h.commands.length, 0);
  await h.acknowledge(true); const submit = h.handler(); submit({ preventDefault() {} }); submit({ preventDefault() {} }); await h.flush();
  assert.equal(h.commands.length, 1); assert.equal(h.locks.at(-1), false); assert.ok(h.requests.every(row => row.method === "GET"));
});
test("missing reconciliation and active jobs show their limits rather than asserting readiness or automatic resubmission", async t => {
  const h = mount(t); await open(h, { ...c, cutoff_at: null, gaps: ["RECONCILIATION_REQUIRED"] });
  assert.equal(h.button("选择来源并确认本次估值"), undefined); assert.match(h.text(), /含停用账户/); assert.equal(h.commands.length, 0);
  await open(h, { ...c, task: { id: "fictional-task", status: "running" } }); assert.equal(h.button("选择来源并确认本次估值")!.props.disabled, true);
  assert.match(h.text(), /任务结束不等于估值完整/);
});
test("late headers, metadata errors and scope changes discard unread bodies; invalidated sessions and old callbacks cannot submit", async t => {
  const h = mount(t); await h.flush(); await h.click("核对估值准备情况与任务"); const oldRequest = h.requests[0];
  await h.change({ scope: { ...scope, revision: 3 } }); await h.reply(0, null, 401); assert.equal(oldRequest.options.signal?.aborted, true);
  assert.equal(h.button("核对估值准备情况与任务")!.props.disabled, false);
  await h.change({ scope }); await open(h); await h.click("选择来源并确认本次估值"); const old = h.handler();
  await h.invalidate(); old({ preventDefault() {} }); await h.flush(); assert.equal(h.commands.length, 0); assert.equal(h.locks.at(-1), false);
  assert.equal(h.node("form"), undefined); h.close(); assert.equal(h.timers.size, 0);
});

test("cancelled, edited or externally locked drafts cannot submit through retained old handlers", async t => {
  const h = mount(t); await open(h); await h.click("选择来源并确认本次估值");
  for (const [name, value] of [["A 股价格来源", "fictional-prices"], ["A 股预期最近交易日", "2026-01-02"], ["汇率来源", "fictional-fx"],
    ["允许的汇率最大时效", "86400"], ["本次规则核查", "Fictional review"]]) await h.input(name, value);
  await h.acknowledge(true); const old = h.handler(); await h.change({ disabled: true }); old({ preventDefault() {} }); await h.flush(); assert.equal(h.commands.length, 0);
  await h.change({ disabled: false }); await h.input("本次规则核查", "Fictional revised review"); old({ preventDefault() {} }); await h.flush(); assert.equal(h.commands.length, 0);
  await h.acknowledge(true); const cancelled = h.handler(); await h.click("取消估值草稿"); cancelled({ preventDefault() {} }); await h.flush(); assert.equal(h.commands.length, 0);
});
