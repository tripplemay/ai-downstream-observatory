import assert from "node:assert/strict";
import test from "node:test";
import * as client from "../src/components/workbench/investor-ai-client";
import type { AiExplanationStatus } from "../src/server/investor/ai-explanation-schemas";
import { mountInvestorDisplay } from "./investor-display-fixture";
import { displayBinding as binding, displayBefore, displayUntil, displayFuture, displayState } from "./investor-display-state-fixture";

const source = new URL("../src/components/workbench/investor-ai-panel.tsx", import.meta.url), before = Date.parse(displayBefore), until = Date.parse(displayUntil);
function mount(t: { after: (fn: () => void) => void }) {
  const state = displayState();
  return { state, ...mountInvestorDisplay(t, source, "InvestorAiPanel", { state, binding, disabled: false }, { "./investor-ai-client": client }, before) };
}
function response(state: ReturnType<typeof displayState>, status: AiExplanationStatus["status"] = "complete", validUntil = displayUntil, session = binding) {
  return { schema_version: "investor-ai-explanation-v1", status, reason_code: status === "blocked" ? "INVESTOR_AI_NO_QUALIFIED_MONITOR" : null,
    observation_id: state.latest!.id, binding_hash: "c".repeat(64), valid_until: validUntil, narrative_verified: false, live_advice_eligible: false, session_binding: session,
    review: status === "complete" ? { schema_version: "ai-research-review-v1", facts: [
      { evidence_id: "derived:max_abs_target_gap", metric: "model.max_abs_target_gap", value: "0.01", as_of: displayBefore },
      { evidence_id: "derived:target_change_count", metric: "model.target_change_count", value: "0", as_of: displayBefore }],
      inferences: [], supporting_evidence: [], counter_evidence: [], risks: [], recommendation: "review", reason: "FICTIONAL_REVIEW_TEXT",
      unknowns: [], invalidation_conditions: [] } : null };
}
test("actual AI panel hides expired text exactly, never revives it after rollback, and does not auto-generate or keep polling expiry", async t => {
  const h = mount(t); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, "GET"); await h.reply(0, response(h.state));
  assert.match(h.text(), /FICTIONAL_REVIEW_TEXT/); await h.advance(until);
  assert.doesNotMatch(h.text(), /FICTIONAL_REVIEW_TEXT/); assert.match(h.text(), /本次解释已到期/);
  await h.advance(before, 1000); await h.wake(); assert.doesNotMatch(h.text(), /FICTIONAL_REVIEW_TEXT/);
  await h.advance(before, 60000); assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0);
  h.close(); assert.equal([...h.windowListeners.values()].every(rows => rows.size === 0), true);
  assert.equal([...h.documentListeners.values()].every(rows => rows.size === 0), true);
});
test("rollback before expiry and a hidden-page wake still retire text using elapsed time", async t => {
  const h = mount(t); await h.reply(0, response(h.state)); h.document.visibilityState = "hidden";
  await h.advance(before - 10000, 1000); assert.doesNotMatch(h.text(), /FICTIONAL_REVIEW_TEXT/);
  h.document.visibilityState = "visible"; await h.wake(); assert.doesNotMatch(h.text(), /FICTIONAL_REVIEW_TEXT/); assert.equal(h.requests.length, 1);
});
test("a render-time forward jump retires AI text permanently even before a timer fires", async t => {
  const h = mount(t); await h.reply(0, response(h.state)); h.setWall(until); await h.change({ disabled: false });
  assert.doesNotMatch(h.text(), /FICTIONAL_REVIEW_TEXT/); h.setWall(before); await h.change({ disabled: false });
  assert.doesNotMatch(h.text(), /FICTIONAL_REVIEW_TEXT/); assert.equal(h.requests.length, 1);
});
test("one explicit POST uses only closed observation metadata; status polling GETs and unknown receipt never auto-resends", async t => {
  const h = mount(t); await h.reply(0, response(h.state, "available", displayFuture));
  await h.click("解释本次观察（单次调用）"); assert.equal(h.requests[1].method, "POST");
  assert.deepEqual(JSON.parse(String(h.requests[1].options.body)), { observation_id: h.state.latest!.id, binding_hash: "c".repeat(64) });
  assert.equal(h.requests[1].options.credentials, "same-origin"); assert.equal(h.requests[1].options.headers && (h.requests[1].options.headers as Record<string, string>)["X-Workbench-Session-Binding"], binding);
  await h.fail(1); await h.advance(before + 5000); assert.equal(h.requests.length, 2);
  assert.match(h.text(), /不自动重试/); await h.click("核对解释状态"); assert.equal(h.requests[2].method, "GET");
  await h.reply(2, response(h.state, "queued", displayFuture)); await h.advance(before + 10000); assert.equal(h.requests[3].method, "GET");
  await h.reply(3, response(h.state, "running", displayFuture));
  assert.equal(h.requests.filter(row => row.method === "POST").length, 1);
});
test("late expired responses after a clock rollback remain hidden; explicit refresh can show only a genuinely newer deadline", async t => {
  const h = mount(t); await h.reply(0, response(h.state)); await h.click("核对解释状态");
  await h.advance(until); await h.advance(before, 1000); await h.reply(1, response(h.state));
  assert.doesNotMatch(h.text(), /FICTIONAL_REVIEW_TEXT/); assert.equal(h.requests.length, 2);
  await h.click("核对解释状态"); await h.reply(2, response(h.state, "complete", displayFuture)); assert.match(h.text(), /FICTIONAL_REVIEW_TEXT/);
  assert.equal(h.requests.every(row => row.method === "GET"), true);
});
test("an obsolete identity response including 401 cannot poison a new binding; current 401 aborts subsequent access", async t => {
  const h = mount(t), other = "b".repeat(64); await h.change({ binding: other });
  assert.equal(h.requests[0].options.signal?.aborted, true); await h.reply(0, {}, 401);
  await h.reply(1, response(h.state, "complete", displayFuture, other)); assert.match(h.text(), /FICTIONAL_REVIEW_TEXT/);
  await h.click("核对解释状态"); await h.reply(2, {}, 401); assert.doesNotMatch(h.text(), /FICTIONAL_REVIEW_TEXT/);
  await h.advance(before + 60000); assert.equal(h.requests.length, 3);
});
test("new observation and session invalidation clear text, abort outstanding work, and suppress replies and timers", async t => {
  const h = mount(t); await h.reply(0, response(h.state, "complete", displayFuture));
  const state = { ...h.state, revision: h.state.revision + 1, latest: { ...h.state.latest!, id: "fictional-new-observation" } };
  await h.change({ state }); assert.doesNotMatch(h.text(), /FICTIONAL_REVIEW_TEXT/);
  await h.reply(1, response(h.state, "complete", displayFuture)); assert.doesNotMatch(h.text(), /FICTIONAL_REVIEW_TEXT/);
  await h.click("核对解释状态"); await h.invalidate(); assert.equal(h.requests[2].options.signal?.aborted, true);
  await h.reply(2, response(state, "complete", displayFuture)); await h.advance(before + 60000);
  assert.doesNotMatch(h.text(), /FICTIONAL_REVIEW_TEXT/); assert.equal(h.requests.length, 3);
});
test("a first response with a previously unknown deadline is checked against elapsed time, even without any intermediate render", async t => {
  const h = mount(t); await h.advance(until); await h.advance(before, 1000); await h.reply(0, response(h.state));
  assert.doesNotMatch(h.text(), /FICTIONAL_REVIEW_TEXT/); assert.match(h.text(), /解释条件暂时无法核对/);
  assert.equal(h.requests.length, 1);
});
test("cached generation callbacks cannot POST after disable or identity change", async t => {
  const h = mount(t); await h.reply(0, response(h.state, "available", displayFuture));
  const old = h.button("解释本次观察（单次调用）")!.props.onClick as () => void;
  await h.change({ disabled: true }); old(); await h.flush(); assert.equal(h.requests.length, 1);
  await h.change({ disabled: false, binding: "b".repeat(64) }); old(); await h.flush();
  assert.equal(h.requests.length, 2); assert.equal(h.requests.every(row => row.method === "GET"), true);
});
