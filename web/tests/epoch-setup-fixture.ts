import assert from "node:assert/strict";
import type {TestContext} from "node:test";
import {hash} from "../src/server/ledger/service";
import {reviewNow as now,reviewBinding as binding} from "./action-review-client-fixture";
import {mountInvestorDisplay} from "./investor-display-fixture";
import * as schemas from "../src/server/investor/epoch-registration-schemas";
import * as client from "../src/components/workbench/investor-epoch-setup-client";
import type {EpochPreviewResponse} from "../src/server/investor/epoch-preview-schemas";
import type {EpochRegistrationResponse} from "../src/server/investor/epoch-registration-schemas";
import {readActionReviewJson} from "../src/components/workbench/investor-action-review-client";
export const setupScope={workspace:"w",model:"fictional-model",binding};
const shared=(revision:number,offset:number)=>({workspace_id:"w",workspace_revision:revision,model_id:"fictional-model",session_binding:binding,lookup_nonce:null,
  checked_at:new Date(now+offset).toISOString(),refresh_after:new Date(now+offset+15000).toISOString(),read_only:false,visibility:"private_owner_only_not_ai" as const,provider_calls:0 as const,trading_permission:false as const});
export function setupPreview(ready=false,offset=0):EpochPreviewResponse{return {...shared(ready?2:1,offset),schema_version:"investor-epoch-preview-response-v1",model_hash:"a".repeat(64),
  request:ready?{id:"fictional-preparation",intent_hash:"b".repeat(64),model_id:"fictional-model",created_at:new Date(now).toISOString(),valid_until:new Date(now+60000).toISOString(),status:"preview_ready",code:"EPOCH_PREVIEW_READY"}:null,
  preview:ready?{id:"fictional-preview",content_hash:"c".repeat(64),workspace_revision:2,created_at:new Date(now).toISOString(),valid_until:new Date(now+60000).toISOString(),
    original_head_id:"fictional-head",corrections:[{correction_id:"fictional-correction",confirmation_hash:"d".repeat(64),handover_id:"fictional-handover",handover_hash:"e".repeat(64)}],
    ranges:[{start_date:"2026-10-15",end_date:"2026-10-19"}],historical_metadata_only:true,current_source_eligibility_restored:false,epoch_registered:false,monitoring_resumed:false}:null};}
export function setupRegistration(revision=1,offset=0):EpochRegistrationResponse{return {...shared(revision,offset),schema_version:"investor-epoch-registration-response-v1",request:null,receipt:null};}
export function setupReply(attempt:client.EpochSetupAttempt,ready=false,offset=0):EpochPreviewResponse|EpochRegistrationResponse{
  const req={id:"fictional-request",intent_hash:hash(attempt.intent),created_at:new Date(now).toISOString(),valid_until:new Date(now+60000).toISOString()};
  if(attempt.kind==="preview"){const p=setupPreview(ready,offset);return {...p,lookup_nonce:attempt.nonce,request:{...req,model_id:setupScope.model,status:ready?"preview_ready":"queued",code:ready?"EPOCH_PREVIEW_READY":null}};}
  return {...setupRegistration(ready?4:3,offset),lookup_nonce:attempt.nonce,request:{...req,preview_id:String(attempt.intent.preview_id),status:ready?"registered":"queued"},
    receipt:ready?{epoch_id:"fictional-registered-epoch",registration_hash:"f".repeat(64),registered_at:new Date(now+offset).toISOString(),valid_until:new Date(now+3600000).toISOString(),
      historical_registration_only:true,monitoring_resumed:false,current_source_eligibility_restored:false,trading_permission:false}:null};
}
export async function verifySetupClient(){
  const p=setupPreview(true),r=setupRegistration(2),answers=Object.fromEntries(schemas.epochRegistrationAcknowledgements.map(k=>[k,true]));
  assert.throws(()=>client.buildEpochSetupAttempt("registration",p,r,setupScope,{},"fictional-command",now),/ACK_REQUIRED/);
  assert.throws(()=>client.buildEpochSetupAttempt("registration",p,r,setupScope,answers,"fictional-command",now+15000),/EXPIRED/);
  assert.throws(()=>client.buildEpochSetupAttempt("registration",p,setupRegistration(),setupScope,answers,"fictional-command",now),/CHANGED/);
  const attempt=client.buildEpochSetupAttempt("registration",p,r,setupScope,answers,"fictional-command",now),queued=setupReply(attempt);
  await client.parseEpochSetupResponse("registration",queued,setupScope,attempt,now);
  for(const patch of [{session_binding:"e".repeat(64)},{lookup_nonce:"other"},{request:{...queued.request!,intent_hash:"e".repeat(64)}},{model_id:"foreign"},{trading_permission:true}])
    await assert.rejects(()=>client.parseEpochSetupResponse("registration",{...queued,...patch},setupScope,attempt,now));
}
function mount(t:TestContext){
  const locks:boolean[]=[],changed:number[]=[];let nonce=0;
  const h=mountInvestorDisplay(t,new URL("../src/components/workbench/investor-epoch-setup.tsx",import.meta.url),"InvestorEpochSetup",
    {workspaceId:"w",modelId:setupScope.model,binding,disabled:false,onGuardChange:(v:boolean)=>locks.push(v),onChanged:()=>changed.push(1)},
    {"@/components/session-boundary":{useSessionBoundary:()=>({verified:true,sessionBinding:binding})},"@/server/investor/epoch-registration-schemas":schemas,
      "./investor-epoch-setup-client":client,"./investor-action-review-client":{readActionReviewJson}},now,
    {crypto:{randomUUID:()=>"fictional-setup-"+(++nonce),subtle:globalThis.crypto.subtle}});
  const reply=async(i:number,v:unknown,status=200)=>{h.requests[i].resolve(new Response(JSON.stringify(v),{status}));await h.waitFor(()=>!h.text().includes("正在核对阶段记录…"));};
  const ready=async(prepared=false)=>{await h.waitRequests(1);await reply(0,setupPreview(prepared));await h.waitRequests(2);await reply(1,setupRegistration(prepared?2:1));};
  const change=async(i:number)=>{(h.nodes().filter(n=>n.type==="input")[i].props.onChange as (e:unknown)=>void)({target:{checked:true}});await h.flush();};
  const submit=(i:number)=>{(h.nodes().filter(n=>n.type==="form")[i].props.onSubmit as (e:unknown)=>void)({preventDefault(){}});};
  const attempt=(i:number,kind:client.EpochSetupKind):client.EpochSetupAttempt=>{const body=String(h.requests[i].options.body);return {kind,body,intent:JSON.parse(body),nonce:JSON.parse(body).idempotency_key};};
  return {...h,reply,ready,check:change,submit,attempt,locks,changed};
}
export async function verifySetupJourney(t:TestContext){
  const h=mount(t);await h.ready();h.submit(0);await h.flush();assert.equal(h.requests.length,2);
  await h.check(0);h.submit(0);h.submit(0);await h.waitRequests(3);const preview=h.attempt(2,"preview");
  await h.reply(2,setupReply(preview),202);await h.advance(now+2500);await h.waitRequests(4);assert.match(h.requests[3].url,/nonce=fictional-setup/);
  await h.reply(3,setupReply(preview,true,2500));await h.waitRequests(5);await h.reply(4,setupRegistration(2,2500));
  assert.match(h.text(),/本次准备摘要/);for(let i=1;i<=6;i++)await h.check(i);
  h.submit(1);h.submit(1);await h.waitRequests(6);const registration=h.attempt(5,"registration");
  await h.reply(5,setupReply(registration,false,2500),202);await h.advance(now+5000);await h.waitRequests(7);
  await h.reply(6,setupReply(registration,true,5000));assert.match(h.text(),/研究阶段已登记，尚未启用观察/);
  assert.equal(h.changed.length,1);assert.equal(h.locks.at(-1),false);assert.equal(h.requests.filter(v=>v.method==="POST").length,2);
  await h.invalidate();assert.equal(h.text(),"");
}
export async function verifySetupUnknown(t:TestContext){
  const h=mount(t);await h.ready();await h.check(0);h.submit(0);await h.waitRequests(3);const original=h.attempt(2,"preview");
  await h.fail(2);assert.match(h.text(),/原提交尚未核实/);await h.advance(now+10000);assert.equal(h.requests.length,3);
  await h.click("核对阶段准备进度");await h.waitRequests(4);assert.match(h.requests[3].url,new RegExp("nonce="+original.nonce));
  await h.reply(3,setupReply(original,false,10000));assert.equal(h.requests.filter(v=>v.method==="POST").length,1);
}
export async function verifySetupExpiry(t:TestContext){
  const h=mount(t);await h.ready(true);for(let i=1;i<=6;i++)await h.check(i);
  const saved=h.nodes().filter(n=>n.type==="form")[1].props.onSubmit as (e:unknown)=>void;
  h.setWall(now+15000);await h.wake();saved({preventDefault(){}});await h.flush();assert.equal(h.requests.length,2);
  await h.change({disabled:true});saved({preventDefault(){}});await h.flush();assert.equal(h.requests.length,2);
}
