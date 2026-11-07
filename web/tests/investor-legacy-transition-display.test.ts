import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { webcrypto } from "node:crypto";
import { hash } from "../src/server/ledger/service";
import * as client from "../src/components/workbench/investor-legacy-transition-client";
import * as schemas from "../src/server/investor/legacy-transition-schemas";
import { mountInvestorDisplay } from "./investor-display-fixture";
import { transitionBinding as binding, transitionNow as now, transitionResponse } from "./legacy-transition-client-fixture";

function mount(t: TestContext) {
  let nonce = 0; const locks: boolean[] = [], refreshes: number[] = [];
  const h = mountInvestorDisplay(t, new URL("../src/components/workbench/investor-legacy-transition.tsx", import.meta.url), "InvestorLegacyTransition",
    { workspaceId: "w", binding, disabled: false, onScopeChange: (value: boolean) => locks.push(value), onRefresh: () => refreshes.push(1) },
    { "@/components/session-boundary": { useSessionBoundary: () => ({ verified: true, sessionBinding: binding }) },
      "@/server/investor/legacy-transition-schemas": schemas, "./investor-legacy-transition-client": client }, now,
    { crypto: { randomUUID: () => `fictional-legacy-${++nonce}`, subtle: webcrypto.subtle } });
  async function reply(index: number, value: unknown, status = 200) {
    h.requests[index].resolve(new Response(JSON.stringify(value), { status }));
    await h.waitFor(() => !h.text().includes("正在核对受理记录与历史证据…"));
  }
  async function ready() { await h.click("检查是否需要兼容"); await reply(0, transitionResponse()); }
  async function acknowledge() {
    for (const row of h.nodes().filter(row => row.type === "input")) (row.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    await h.flush();
  }
  const submit = () => (h.node("form")!.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  return { ...h, locks, refreshes, reply, ready, acknowledge, submit };
}
test("compatibility is lazy and opt-in, has no internal-id fields, preserves pause and starts with every acknowledgement false", async t => {
  const h = mount(t); await h.flush(); assert.equal(h.requests.length, 0); await h.ready(); assert.equal(h.requests[0].method, "GET");
  assert.equal(h.locks.at(-1), true); assert.match(h.text(), /17 期观察记录及 3 项已处理事件/); assert.match(h.text(), /原监测状态：暂停/);
  assert.deepEqual(h.nodes().filter(row => row.type === "input").map(row => row.props.checked), [false, false, false, false, false]);
  assert.equal(h.button("确认兼容并登记来源，不执行交易")!.props.disabled, true);
  assert.equal(h.nodes().some(row => row.type === "Input" || row.type === "textarea"), false);
  await h.click("完成并刷新工作台"); assert.equal(h.locks.at(-1), false); assert.equal(h.refreshes.length, 1);
});
test("confirmation submits once; lost-response recovery first GETs the original nonce, then only explicit byte-identical retry is possible", async t => {
  const h = mount(t); await h.ready(); await h.acknowledge(); h.submit(); h.submit(); await h.waitRequests(2);
  const original = h.requests[1].options.body as string, intent = JSON.parse(original);
  assert.equal(intent.kind, "confirmation"); assert.ok(Object.values(intent.body.acknowledgements).every(value => value === true));
  assert.equal("enable_rule" in intent.body, false); await h.fail(1); assert.match(h.text(), /原请求仍待核实/);
  assert.equal(h.button("以原请求重试")!.props.disabled, true); assert.equal(h.button("完成并刷新工作台")!.props.disabled, true);
  await h.advance(now + 1000); assert.equal(h.requests.length, 2); await h.click("核对受理状态");
  assert.equal(h.requests[2].url, `/api/workbench/investor/legacy-transition?nonce=${intent.body.idempotency_key}`);
  await h.reply(2, transitionResponse({ request: null, view: null, lookup_nonce: intent.body.idempotency_key }));
  assert.equal(h.button("以原请求重试")!.props.disabled, false); await h.click("以原请求重试"); assert.equal(h.requests[3].options.body, original);
  await h.reply(3, transitionResponse({ workspace_revision: 3, lookup_nonce: intent.body.idempotency_key, model: { id: "fictional-model", requires_transition: false }, view: null,
    request: { ...transitionResponse().request!, kind: "confirmation", intent_hash: hash(intent), status: "registered", code: "LEGACY_TRANSITION_REGISTERED",
      resource_id: "fictional-admission", resource_hash: "f".repeat(64), resource_valid_until: null } }));
  assert.match(h.text(), /原监测开关保持不变/); assert.doesNotMatch(h.text(), /原请求仍待核实/); assert.equal(h.requests.filter(row => row.method === "POST").length, 2);
});
test("stale or withdrawn previews cannot confirm; parent scope locks and invalidated sessions also block previously captured callbacks", async t => {
  const h = mount(t); await h.ready(); await h.acknowledge(); const old = h.node("form")!.props.onSubmit as (event: unknown) => void;
  await h.change({ disabled: true }); old({ preventDefault() {} }); await h.flush(); assert.equal(h.requests.length, 1);
  await h.change({ disabled: false }); await h.advance(now + 16000); assert.equal(h.button("确认兼容并登记来源，不执行交易")!.props.disabled, true);
  assert.equal(h.requests.at(-1)!.method, "GET"); await h.fail(h.requests.length - 1); assert.equal(h.node("form"), undefined);
  await h.invalidate(); old({ preventDefault() {} }); await h.flush(); assert.equal(h.requests.filter(row => row.method === "POST").length, 0);
  assert.equal(h.locks.at(-1), false); assert.equal(h.button("检查是否需要兼容")!.props.disabled, true); h.close(); assert.equal(h.timers.size, 0);
});
