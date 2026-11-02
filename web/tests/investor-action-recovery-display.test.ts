import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as client from "../src/components/workbench/investor-action-recovery-client";
import * as reviewClient from "../src/components/workbench/investor-action-review-client";
import { hash } from "../src/server/ledger/service";
import { mountInvestorDisplay } from "./investor-display-fixture";
import { recoveryResponse } from "./action-recovery-client-fixture";
import { reviewBinding as binding, reviewNow as now } from "./action-review-client-fixture";

function mount(t: TestContext) {
  let nonce = 0; const locks: boolean[] = [], value = recoveryResponse();
  const h = mountInvestorDisplay(t, new URL("../src/components/workbench/investor-action-recovery.tsx", import.meta.url), "InvestorActionRecovery",
    { view: value.review.view!, requestId: "fictional-job", workspaceId: "w", binding, disabled: false, onGuardChange: (v: boolean) => locks.push(v) },
    { "@/components/session-boundary": { useSessionBoundary: () => ({ verified: true, sessionBinding: binding }) },
      "./investor-action-recovery-client": client, "./investor-action-review-client": reviewClient }, now, { crypto: { randomUUID: () => `fictional-recovery-${++nonce}` } });
  async function reply(index: number, raw: unknown = value) {
    h.requests[index].resolve(new Response(JSON.stringify(raw))); await h.waitFor(() => !h.text().includes("正在核对恢复依据与受理记录…"));
  }
  async function check(index: number, checked = true) {
    (h.nodes().filter(row => row.type === "input")[index].props.onChange as (e: unknown) => void)({ target: { checked } }); await h.flush();
  }
  async function ready() { await h.click("复核无变化维护恢复"); await reply(0); }
  const submit = () => (h.node("form")!.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  return { ...h, reply, ready, check, submit, locks, value };
}
test("recovery opens lazily, guards parent scope, shows original failure/coverage and requires separate unchecked consent", async t => {
  const h = mount(t); await h.flush(); assert.equal(h.requests.length, 0); await h.ready();
  assert.equal(h.requests[0].url, "/api/workbench/investor/action-recovery?request=fictional-job"); assert.equal(h.locks.at(-1), true);
  for (const text of ["单次采集终态失败", "2026-11-02", "2026-10-31", "不保证客观不存在其他事件", "不修改既有事件"]) assert.ok(h.text().includes(text), text);
  assert.deepEqual(h.nodes().filter(row => row.type === "input").map(row => row.props.checked), [false, false]);
  assert.equal(h.button("登记无变化维护接续")!.props.disabled, true);
  await h.check(0); await h.check(1); assert.equal(h.nodes().filter(row => row.type === "input")[0].props.checked, false);
  await h.click("收起恢复复核"); assert.equal(h.locks.at(-1), false); assert.equal(h.node("form"), undefined);
});
test("double click posts once; a lost response keeps immutable nonce and GET lookup never falls back or auto-writes", async t => {
  const h = mount(t); await h.ready(); await h.check(0); h.submit(); h.submit(); await h.waitRequests(2);
  const original = h.requests[1].options.body, input = JSON.parse(original as string); assert.equal(input.body.enable_rule, false);
  await h.fail(1); assert.match(h.text(), /原恢复提交仍待核实/); assert.equal(h.button("收起恢复复核")!.props.disabled, true);
  await h.click("核对恢复受理状态"); assert.equal(h.requests[2].method, "GET"); assert.match(h.requests[2].url, new RegExp(`nonce=${input.body.idempotency_key}$`));
  const missing = recoveryResponse(); missing.review.request = null; missing.review.view = null; missing.review.lookup_nonce = input.body.idempotency_key; missing.recovery = null;
  await h.reply(2, missing); assert.match(h.text(), /原恢复提交仍待核实/); await h.advance(now + 10000); assert.equal(h.requests.length, 3);
  await h.click("使用原恢复请求重试"); assert.equal(h.requests[3].options.body, original);
  const receipt = recoveryResponse(); receipt.recovery = null; receipt.review.view = null; receipt.review.lookup_nonce = input.body.idempotency_key;
  receipt.review.request = { ...receipt.review.request!, id: "fictional-confirmation-job", kind: "confirmation", intent_hash: hash(input), status: "confirmed",
    code: "ACTION_REVIEW_CONFIRMED", resource_id: "fictional-confirmation", resource_hash: "f".repeat(64), resource_valid_until: null };
  await h.reply(3, receipt); assert.match(h.text(), /不代表监测已恢复，也未执行交易/); assert.equal(h.node("form"), undefined);
});
test("actual-clock expiry hides recovery evidence, and stale callbacks cannot submit after lock or session invalidation", async t => {
  const h = mount(t); await h.ready(); await h.check(0);
  const submit = h.node("form")!.props.onSubmit as (event: unknown) => void;
  await h.change({ disabled: true }); submit({ preventDefault() {} }); await h.flush(); assert.equal(h.requests.length, 1);
  await h.change({ disabled: false }); await h.advance(now + 16000); assert.equal(h.node("form"), undefined); assert.doesNotMatch(h.text(), /原停止：/);
  await h.invalidate(); submit({ preventDefault() {} }); await h.flush(); assert.equal(h.requests.filter(r => r.method === "POST").length, 0);
  assert.equal(h.locks.at(-1), false); assert.equal(h.button("复核无变化维护恢复")!.props.disabled, true); h.close(); assert.equal(h.timers.size, 0);
});
test("source deadline wakes without polling or any transport response", async t => {
  const h = mount(t); await h.click("复核无变化维护恢复"); const short = recoveryResponse();
  short.review.refresh_after = new Date(now + 1000).toISOString();
  short.review.view!.refresh_after = short.review.refresh_after;
  await h.reply(0, short); assert.ok(h.node("form")); await h.advance(now + 1001);
  assert.equal(h.requests.length, 1); assert.equal(h.node("form"), undefined); assert.doesNotMatch(h.text(), /原停止：/);
});
