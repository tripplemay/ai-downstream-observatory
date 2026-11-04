import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mountInvestorDisplay } from "./investor-display-fixture";
import { reviewBinding as binding, reviewNow as now } from "./action-review-client-fixture";
import { correctionConsentAcknowledgements } from "../src/server/investor/correction-consent-schemas";
import * as schemas from "../src/server/investor/correction-consent-schemas";
import * as client from "../src/components/workbench/investor-correction-consent-client";
import { readActionReviewJson } from "../src/components/workbench/investor-action-review-client";
import { consentResponse, consentSummaryHash, confirmedConsent, queuedConsent } from "./correction-consent-client-fixture";
import * as epochSchemas from "../src/server/investor/epoch-control-schemas";
import * as epochClient from "../src/components/workbench/investor-epoch-control-client";
import {epochResponse,queuedEpochControl,pausedEpochControl} from "./epoch-control-client-fixture";

function mount(t: TestContext, impactId: string | null = "fictional-impact", summaryHash: string | null = consentSummaryHash) {
  const locks: boolean[] = [], registered: number[] = [];
  const h = mountInvestorDisplay(t, new URL("../src/components/workbench/investor-correction-consent.tsx", import.meta.url), "InvestorCorrectionConsent",
    { workspaceId: "w", binding, modelId: "fictional-model", impactId, summaryHash, disabled: false, onGuardChange: (v: boolean) => locks.push(v), onRegistered: () => registered.push(1) },
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
  await next.change({ summaryHash: "d".repeat(64) }); handler({ preventDefault() {} }); await next.waitRequests(2);assert.equal(next.requests[1].method,"GET");
  await next.reply(1,consentResponse({candidate:{...consentResponse().candidate!,summary_hash:"d".repeat(64)}}));handler({preventDefault(){}});await next.flush();
  assert.equal(next.requests.filter(r=>r.method==="POST").length,0);
  await next.change({ summaryHash: consentSummaryHash });await next.waitRequests(3);await next.reply(2,consentResponse());handler({preventDefault(){}});await next.flush();
  assert.equal(next.requests.filter(r=>r.method==="POST").length,0);await next.fill(); await next.change({ disabled: true }); handler({ preventDefault() {} }); await next.flush(); assert.equal(next.requests.length, 3);
  await next.invalidate(); assert.equal(next.node("form"), undefined); handler({ preventDefault() {} }); await next.flush(); assert.equal(next.requests.length, 3);
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
test("a newly displayed completed comparison requalifies an initially empty confirmation without any POST",async t=>{
  const h=mount(t,"fictional-impact",null);await h.waitRequests(1);await h.reply(0,consentResponse({candidate:null}));
  assert.equal(h.node("form"),undefined);await h.change({summaryHash:consentSummaryHash});await h.waitRequests(2);
  assert.equal(h.requests[1].method,"GET");await h.reply(1,consentResponse());assert.equal(h.nodes().filter(r=>r.type==="input").length,7);
  assert.equal(h.requests.filter(r=>r.method==="POST").length,0);
});
test("a late empty initial read cannot suppress the new comparison; failed requalification never becomes an automatic retry loop",async t=>{
  const h=mount(t,"fictional-impact",null);await h.waitRequests(1);await h.change({summaryHash:consentSummaryHash});assert.equal(h.requests.length,1);
  await h.reply(0,consentResponse({candidate:null}));await h.waitRequests(2);await h.fail(1);assert.equal(h.node("form"),undefined);
  await h.advance(now+10000);assert.equal(h.requests.length,2);assert.equal(h.requests.filter(r=>r.method==="POST").length,0);
});
test("compact confirmation removes intrinsic fieldset/button minimums and retains a visible nonshrinking checkbox",async t=>{
  const h=mount(t);await h.ready();assert.match(String(h.node("fieldset")!.props.className),/min-w-0/);
  const button=h.button("登记本次历史更正，不恢复监测或交易")!;assert.match(String(button.props.className),/max-w-full/);assert.match(String(button.props.className),/whitespace-normal/);
  for(const checkbox of h.nodes().filter(r=>r.type==="input"))assert.match(String(checkbox.props.className),/shrink-0/);
});
function mountEpoch(t:TestContext){
  const locks:boolean[]=[],changed:number[]=[];
  let nonce=0;
  const h=mountInvestorDisplay(t,new URL("../src/components/workbench/investor-epoch-control.tsx",import.meta.url),"InvestorEpochControl",
    {workspaceId:"w",modelId:"fictional-model",binding,disabled:false,onGuardChange:(v:boolean)=>locks.push(v),onChanged:()=>changed.push(1)},
    {"@/components/session-boundary":{useSessionBoundary:()=>({verified:true,sessionBinding:binding})},"@/server/investor/epoch-control-schemas":epochSchemas,
      "./investor-epoch-control-client":epochClient,"./investor-action-review-client":{readActionReviewJson}},now,
    {crypto:{randomUUID:()=>"fictional-epoch-command-"+(++nonce),subtle:globalThis.crypto.subtle}});
  const reply=async(i:number,value:unknown,status=200)=>{h.requests[i].resolve(new Response(JSON.stringify(value),{status}));await h.waitFor(()=>!h.text().includes("正在核对受理记录…"));};
  const fill=async()=>{for(let index=0;index<3;index++){const input=h.nodes().filter(row=>row.type==="input")[index];(input.props.onChange as (e:unknown)=>void)({target:{checked:true}});await h.flush();}};
  const submit=()=>{(h.node("form")!.props.onSubmit as (e:unknown)=>void)({preventDefault(){}});};
  return {...h,reply,fill,submit,locks,changed};
}
test("epoch metadata advances after the enable receipt recheck the parent, but unchanged reads and queued intents do not unlock it",async t=>{
  const h=mountEpoch(t);await h.waitRequests(1);await h.reply(0,epochResponse());
  const initial=h.changed.length;await h.click("核对观察开关");await h.waitRequests(2);await h.reply(1,epochResponse());assert.equal(h.changed.length,initial);
  await h.fill();h.submit();await h.waitRequests(3);const intent=JSON.parse(h.requests[2].options.body as string),queued=queuedEpochControl(intent);
  await h.reply(2,queued,202);assert.equal(h.changed.length,initial);assert.equal(h.locks.at(-1),true);
  await h.advance(now+2500);await h.waitRequests(4);
  const applied={...queued,workspace_revision:2,checked_at:new Date(now+2500).toISOString(),refresh_after:new Date(now+17500).toISOString(),
    epoch:{...queued.epoch!,enabled:true,control_id:"fictional-enabled",control_version:1},
    request:{...queued.request!,status:"applied",code:"EPOCH_CONTROL_APPLIED"},
    receipt:{control_id:"fictional-enabled",intent_hash:queued.request!.intent_hash,epoch_id:intent.epoch_id,enabled:true}};
  await h.reply(3,applied);assert.equal(h.changed.length,initial+1);assert.equal(h.locks.at(-1),false);
  await h.click("核对观察开关");await h.waitRequests(5);await h.reply(4,applied);assert.equal(h.changed.length,initial+1);
  await h.click("核对观察开关");await h.waitRequests(6);
  const published={...applied,workspace_revision:3,epoch:{...applied.epoch,checkpoint:{id:"fictional-next-checkpoint",content_hash:"c".repeat(64)}}};
  await h.reply(5,published);assert.equal(h.changed.length,initial+2);
  await h.click("核对观察开关");await h.waitRequests(7);await h.reply(6,{...published,workspace_revision:4,
    epoch:{...published.epoch,enabled:false,control_id:"fictional-other-tab-pause",control_version:2}});
  assert.equal(h.changed.length,initial+3);assert.match(h.text(),/本阶段尚未启用或已暂停/);
  assert.equal(h.requests.filter(row=>row.method==="POST").length,1);
});
test("epoch control submits one explicit activation, polls no automatic POST, and allows a distinct pause while activation is queued",async t=>{
  const h=mountEpoch(t);await h.waitRequests(1);await h.reply(0,epochResponse());assert.equal(h.locks.at(-1),false);
  assert.deepEqual(h.nodes().filter(n=>n.type==="input").map(n=>n.props.checked),[false,false,false]);
  h.submit();await h.flush();assert.equal(h.requests.length,1);await h.fill();h.submit();h.submit();await h.waitRequests(2);
  const enabled=JSON.parse(h.requests[1].options.body as string);await h.reply(1,queuedEpochControl(enabled),202);
  assert.equal(h.button("取消待启用并暂停本阶段")?.props.disabled,false);await h.click("取消待启用并暂停本阶段");await h.waitRequests(3);
  const pause=JSON.parse(h.requests[2].options.body as string);assert.equal(pause.enabled,false);assert.notEqual(pause.idempotency_key,enabled.idempotency_key);
  await h.reply(2,pausedEpochControl(pause));assert.match(h.text(),/本阶段尚未启用或已暂停/);assert.equal(h.locks.at(-1),false);
});
test("epoch control lost responses retain exact bytes; deadline, session, parent locks and unmount defeat old submit handlers",async t=>{
  const h=mountEpoch(t);await h.waitRequests(1);await h.reply(0,epochResponse());await h.fill();h.submit();await h.waitRequests(2);
  const body=h.requests[1].options.body as string;await h.fail(1);await h.click("核对观察开关");await h.waitRequests(3);assert.match(h.requests[2].url,/nonce=/);
  await h.fail(2);await h.advance(now+10000);assert.equal(h.requests.length,3);await h.click("明确重试原请求");await h.waitRequests(4);assert.equal(h.requests[3].options.body,body);
  const next=mountEpoch(t);await next.waitRequests(1);await next.reply(0,epochResponse());await next.fill();const stale=next.node("form")!.props.onSubmit as (e:unknown)=>void;
  await next.advance(now+15000);stale({preventDefault(){}});await next.flush();assert.equal(next.requests.filter(r=>r.method==="POST").length,0);
  await next.change({disabled:true});stale({preventDefault(){}});await next.flush();assert.equal(next.requests.filter(r=>r.method==="POST").length,0);
  await next.invalidate();stale({preventDefault(){}});await next.flush();assert.equal(next.requests.filter(r=>r.method==="POST").length,0);
  const closed=mountEpoch(t);await closed.waitRequests(1);await closed.reply(0,epochResponse());await closed.fill();const old=closed.node("form")!.props.onSubmit as (e:unknown)=>void;
  closed.close();old({preventDefault(){}});await closed.flush();assert.equal(closed.requests.filter(r=>r.method==="POST").length,0);assert.equal(closed.locks.at(-1),false);
});
