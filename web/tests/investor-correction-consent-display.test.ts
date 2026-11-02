import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mountInvestorDisplay } from "./investor-display-fixture";
import { reviewBinding as binding, reviewNow as now } from "./action-review-client-fixture";
import { correctionConsentAcknowledgements } from "../src/server/investor/correction-consent-schemas";
import * as schemas from "../src/server/investor/correction-consent-schemas";
import * as client from "../src/components/workbench/investor-correction-consent-client";
import { readActionReviewJson } from "../src/components/workbench/investor-action-review-client";
import { consentResponse, consentSummaryHash, confirmedConsent, queuedConsent } from "./correction-consent-client-fixture";

function mount(t: TestContext, impactId: string | null = "fictional-impact") {
  const locks: boolean[] = [], registered: number[] = [];
  const h = mountInvestorDisplay(t, new URL("../src/components/workbench/investor-correction-consent.tsx", import.meta.url), "InvestorCorrectionConsent",
    { workspaceId: "w", binding, modelId: "fictional-model", impactId, summaryHash: consentSummaryHash, disabled: false, onGuardChange: (v: boolean) => locks.push(v), onRegistered: () => registered.push(1) },
    { "@/components/session-boundary": { useSessionBoundary: () => ({ verified: true, sessionBinding: binding }) },
      "@/server/investor/correction-consent-schemas": schemas, "./investor-correction-consent-client": client, "./investor-action-review-client": { readActionReviewJson } }, now);
  const reply = async (i: number, v: unknown, status = 200) => { h.requests[i].resolve(new Response(JSON.stringify(v), { status })); await h.waitFor(() => !h.text().includes("正在核对更正受理记录…")); };
  const ready = async () => { await h.waitRequests(1); await reply(0, consentResponse()); };
  const check = async (index: number, checked = true) => { (h.nodes().filter(row => row.type === "input")[index].props.onChange as (e: unknown) => void)({ target: { checked } }); await h.flush(); };
  const fill = async () => { for (let i = 0; i < correctionConsentAcknowledgements.length; i++) await check(i); };
  const submit = () => (h.node("form")!.props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
  return { ...h, locks, registered, ready, reply, check, fill, submit };
}
test("new confirmation starts blank, requires every acknowledgement, submits once and polls GET to a metadata-only receipt", async t => {
  const h = mount(t); await h.ready(); assert.match(h.requests[0].url, /impact=fictional-impact/); assert.equal(h.locks.at(-1), false);
  assert.deepEqual(h.nodes().filter(row => row.type === "input").map(row => row.props.checked), new Array(7).fill(false));
  h.submit(); await h.flush(); assert.equal(h.requests.length, 1); await h.fill(); h.submit(); h.submit(); await h.waitRequests(2);
  const intent = JSON.parse(h.requests[1].options.body as string); assert.equal(intent.schema_version, "investor-correction-consent-submit-v1");
  await h.reply(1, queuedConsent(intent), 202); await h.advance(now + 2500); await h.waitRequests(3); assert.equal(h.requests[2].method, "GET");
  await h.reply(2, { ...confirmedConsent(intent), checked_at: new Date(now + 2500).toISOString(), refresh_after: new Date(now + 17500).toISOString() });
  assert.match(h.text(), /历史更正基线已登记，当前监测尚未恢复/); assert.equal(h.registered.length, 1); assert.equal(h.node("form"), undefined);
  assert.equal(h.requests.filter(row => row.method === "POST").length, 1); assert.equal(h.locks.at(-1), false);
});
test("lost POST and empty nonce lookup keep original bytes and uncertainty; no automated second mutation", async t => {
  const h = mount(t); await h.ready(); await h.fill(); h.submit(); await h.waitRequests(2); const body = h.requests[1].options.body as string;
  await h.fail(1); await h.click("核对更正登记状态"); assert.match(h.requests[2].url, /nonce=/);
  await h.reply(2, consentResponse({ candidate: null, lookup_nonce: JSON.parse(body).idempotency_key })); assert.match(h.text(), /原提交是否受理尚未核实/);
  await h.advance(now + 10000); assert.equal(h.requests.length, 3); await h.click("使用原更正请求重试"); assert.equal(h.requests[3].options.body, body);
});
test("actual display deadline hides confirmation even when refresh hangs; changed summary, lock and invalid session defeat retained submit handlers", async t => {
  const h = mount(t); await h.ready(); await h.fill(); const stale = h.node("form")!.props.onSubmit as (e: unknown) => void;
  await h.advance(now + 12000); await h.waitRequests(2); await h.advance(now + 16000);
  assert.equal(h.node("form"), undefined); stale({ preventDefault() {} }); await h.flush(); assert.equal(h.requests.filter(r => r.method === "POST").length, 0);
  const next = mount(t); await next.ready(); await next.fill(); const handler = next.node("form")!.props.onSubmit as (e: unknown) => void;
  await next.change({ summaryHash: "d".repeat(64) }); handler({ preventDefault() {} }); await next.flush(); assert.equal(next.requests.length, 1);
  await next.change({ summaryHash: consentSummaryHash }); await next.fill(); await next.change({ disabled: true }); handler({ preventDefault() {} }); await next.flush(); assert.equal(next.requests.length, 1);
  await next.invalidate(); assert.equal(next.node("form"), undefined); handler({ preventDefault() {} }); await next.flush(); assert.equal(next.requests.length, 1);
});
test("reload reads historical registration by model without needing a still-current comparison or exposing an approval form", async t => {
  const h = mount(t, null); await h.waitRequests(1); assert.match(h.requests[0].url, /model=fictional-model/);
  const intent = client.buildConsentAttempt(consentResponse(), { workspace: "w", binding, model: "fictional-model", impact: "fictional-impact" }, consentSummaryHash,
    Object.fromEntries(correctionConsentAcknowledgements.map(key => [key, true])), "fictional-nonce", now).intent;
  await h.reply(0, confirmedConsent(intent)); await h.waitFor(()=>h.text().includes("历史登记收据")); assert.match(h.text(), /历史登记收据/); assert.equal(h.node("form"), undefined); assert.equal(h.requests[0].method, "GET");
});
test("known source rejection is not presented as an unknown transport result; unmounted handlers cannot submit",async t=>{
  const h=mount(t);await h.ready();await h.fill();const old=h.node("form")!.props.onSubmit as (e:unknown)=>void;
  h.close();old({preventDefault(){}});await h.flush();assert.equal(h.requests.filter(r=>r.method==="POST").length,0);
  const next=mount(t);await next.waitRequests(1);
  const intent=client.buildConsentAttempt(consentResponse(),{workspace:"w",binding,model:"fictional-model",impact:"fictional-impact"},consentSummaryHash,
    Object.fromEntries(correctionConsentAcknowledgements.map(key=>[key,true])),"fictional-nonce",now).intent;
  const queued=queuedConsent(intent);
  await next.reply(0,{...queued,request:{...queued.request!,status:"rejected",code:"CORRECTION_CONSENT_SOURCE_UNAVAILABLE"}});
  assert.match(next.text(),/本次未登记更正基线/);assert.doesNotMatch(next.text(),/连接失败不代表未受理/);assert.equal(next.node("form"),undefined);
});
