import assert from "node:assert/strict";
import test,{type TestContext} from "node:test";
import {webcrypto} from "node:crypto";
import {hash} from "../src/server/ledger/service";
import {mountInvestorDisplay} from "./investor-display-fixture";
import {reviewBinding as binding,reviewAt,reviewNow as now} from "./action-review-client-fixture";
import {correctionView,correctionResponse,readyCorrectionResponse} from "./correction-impact-client-fixture";
import * as client from "../src/components/workbench/investor-correction-impact-client";
import {readActionReviewJson} from "../src/components/workbench/investor-action-review-client";

function mount(t:TestContext,modelId:string|null="fictional-model"){
  let nonce=0;const locks:boolean[]=[],attemptClocks:(number|undefined)[]=[];
  const h=mountInvestorDisplay(t,new URL("../src/components/workbench/investor-correction-impact.tsx",import.meta.url),"InvestorCorrectionImpact",
    {view:correctionView(),modelId,workspaceId:"w",binding,disabled:false,onGuardChange:(value:boolean)=>locks.push(value)},
    {"@/components/ui/input":{Input:"Input"},"@/components/session-boundary":{useSessionBoundary:()=>({verified:true,sessionBinding:binding})},
      "./investor-correction-impact-client":{...client,buildCorrectionAttempt:(...args:Parameters<typeof client.buildCorrectionAttempt>)=>{attemptClocks.push(args[5]);return client.buildCorrectionAttempt(...args);}},
      "./investor-action-review-client":{readActionReviewJson},"./investor-correction-consent":{InvestorCorrectionConsent:"InvestorCorrectionConsent"}},now,{crypto:{randomUUID:()=>`fictional-impact-${++nonce}`,subtle:webcrypto.subtle}});
  async function reply(index:number,value:unknown,status=200){h.requests[index].resolve(new Response(JSON.stringify(value),{status}));await h.waitFor(()=>!h.text().includes("正在核对本次请求…"));}
  async function ready(){await h.waitRequests(1);await reply(0,correctionResponse({request:null}));}
  async function edit(index:number,value:string){(h.nodes().filter(row=>row.type==="Input")[index].props.onChange as (event:unknown)=>void)({target:{value}});await h.flush();}
  async function choose(value:string){(h.node("select")!.props.onChange as (event:unknown)=>void)({target:{value}});await h.flush();}
  async function ack(){(h.nodes().filter(row=>row.type==="input").at(-1)!.props.onChange as (event:unknown)=>void)({target:{checked:true}});await h.flush();}
  async function fill(){await choose("replace");await edit(0,"Fictional explicit comparison only");await edit(1,"2026-11-02T14:30");await edit(2,"2026-11-09T21:00");await edit(3,"0.432109");await ack();}
  const submit=()=>(h.node("form")!.props.onSubmit as (event:unknown)=>void)({preventDefault(){}});
  return {...h,locks,attemptClocks,reply,ready,edit,choose,ack,fill,submit};
}

test("historical correction opens with GET-only recovery, blank choices and assumptions, no implicit consent or model creation",async t=>{
  const h=mount(t);await h.ready();assert.equal(h.requests[0].method,"GET");assert.match(h.requests[0].url,/preview=/);
  assert.equal(h.node("select")!.props.value,"");assert.deepEqual(h.nodes().filter(row=>row.type==="Input").map(row=>row.props.value),[""]);
  assert.equal(h.nodes().filter(row=>row.type==="input").at(-1)!.props.checked,false);
  await h.choose("replace");assert.deepEqual(h.nodes().filter(row=>row.type==="Input").map(row=>row.props.value),["","","",""]);
  assert.equal(h.button("计算假设影响，不批准更正")!.props.disabled,true);
  const missing=mount(t,null);await missing.flush();assert.equal(missing.requests.length,0);assert.match(missing.text(),/尚无观察模型/);assert.equal(missing.node("form"),undefined);
});

test("one explicit intent, queued GET polling and an original-price result never approve correction or trading",async t=>{
  const h=mount(t);await h.ready();await h.fill();h.submit();h.submit();await h.waitRequests(2);assert.equal(h.requests[1].method,"POST");
  assert.deepEqual(h.attemptClocks,[now]);
  const body=JSON.parse(h.requests[1].options.body as string);assert.equal(body.decisions[0].events[0].tax_per_unit,"0.432109");assert.equal(body.model_id,"fictional-model");
  assert.equal("gross_per_unit" in body.decisions[0].events[0],false);
  const queued=correctionResponse({lookup_nonce:body.idempotency_key,request:{...correctionResponse().request!,intent_hash:hash(body)}});
  await h.reply(1,queued,202);await h.advance(now+5000);await h.waitRequests(3);assert.equal(h.requests[2].method,"GET");
  await h.reply(2,readyCorrectionResponse({checked_at:"2026-11-03T06:00:08.001Z",refresh_after:"2026-11-03T06:00:23.001Z",request:{...queued.request!,status:"preview_ready",code:"CORRECTION_IMPACT_READY"}}));
  assert.match(h.text(),/原检查点/);assert.match(h.text(),/10002.5/);assert.match(h.text(),/不是当前行情/);assert.match(h.text(),/正式更正须在下方另行确认/);
  assert.equal(h.requests.filter(row=>row.method==="POST").length,1);
  await h.edit(0,"Changed unsubmitted hypothesis");assert.doesNotMatch(h.text(),/10002.5/);
});

test("a retained submit handler checks the live component clock at the exact deadline even before a display tick",async t=>{
  const h=mount(t);await h.ready();await h.fill();const submit=h.node("form")!.props.onSubmit as (event:unknown)=>void;
  const expiry=Date.parse(correctionView().preview.valid_until);h.setWall(expiry);
  submit({preventDefault(){}});await h.flush();
  assert.deepEqual(h.attemptClocks,[expiry]);assert.equal(h.requests.length,1);
  assert.match(h.text(),/原预览期限已到/);assert.equal(h.requests.filter(row=>row.method==="POST").length,0);
});

test("unknown submission keeps original bytes, empty nonce lookup never clears uncertainty and exact retry is explicit",async t=>{
  const h=mount(t);await h.ready();await h.fill();h.submit();await h.waitRequests(2);const body=h.requests[1].options.body as string,nonce=JSON.parse(body).idempotency_key;
  await h.fail(1);assert.match(h.text(),/原请求是否受理尚未核实/);await h.click("核对比较受理状态");assert.equal(h.requests[2].method,"GET");assert.match(h.requests[2].url,new RegExp("nonce="+nonce));
  await h.reply(2,correctionResponse({request:null,lookup_nonce:nonce}));assert.match(h.text(),/原请求是否受理尚未核实/);
  await h.advance(now+10000);assert.equal(h.requests.length,3);await h.click("使用原请求重试");assert.equal(h.requests[3].options.body,body);
});

test("stale callbacks cannot POST after parent lock or session change; failed reads and expiry hide derived values",async t=>{
  const h=mount(t);await h.ready();await h.fill();const old=h.node("form")!.props.onSubmit as (event:unknown)=>void;
  await h.change({disabled:true});old({preventDefault(){}});await h.flush();assert.equal(h.requests.length,1);
  await h.change({disabled:false});await h.click("清除本地假设");await h.click("核对比较受理状态");await h.reply(1,readyCorrectionResponse());assert.match(h.text(),/10002.5/);
  await h.click("核对比较受理状态");await h.fail(2);assert.doesNotMatch(h.text(),/10002.5/);
  await h.invalidate();old({preventDefault(){}});await h.flush();assert.equal(h.requests.filter(row=>row.method==="POST").length,0);assert.doesNotMatch(h.text(),/10002.5/);assert.equal(h.locks.at(-1),false);
});
test("unmounted correction forms cannot send a new intent through a retained event handler",async t=>{
  const h=mount(t);await h.ready();await h.fill();const old=h.node("form")!.props.onSubmit as (event:unknown)=>void;
  h.close();old({preventDefault(){}});await h.flush();assert.equal(h.requests.filter(row=>row.method==="POST").length,0);assert.equal(h.timers.size,0);
});
test("formal confirmation locks hypothesis edits synchronously; registration hides the old draft and difference but keeps the same receipt scope",async t=>{
  const h=mount(t);await h.ready();await h.fill();const old=h.node("form")!.props.onSubmit as (e:unknown)=>void;
  await h.click("清除本地假设");await h.click("核对比较受理状态");await h.reply(1,readyCorrectionResponse());
  const child=h.node("InvestorCorrectionConsent")!;assert.equal(child.props.summaryHash,readyCorrectionResponse().summary_hash);
  const guard=child.props.onGuardChange as (v:boolean)=>void;guard(true);old({preventDefault(){}});await h.flush();
  assert.equal(h.requests.filter(r=>r.method==="POST").length,0);assert.equal(h.button("清除本地假设")!.props.disabled,true);
  (child.props.onRegistered as ()=>void)();await h.flush();guard(false);await h.flush();
  assert.equal(h.node("form"),undefined);assert.doesNotMatch(h.text(),/10002.5/);
  const retained=h.node("InvestorCorrectionConsent")!;assert.equal(retained.props.impactId,child.props.impactId);assert.equal(retained.props.summaryHash,null);
});
