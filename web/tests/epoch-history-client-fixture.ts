import assert from "node:assert/strict";
import type {TestContext} from "node:test";
import {hash} from "../src/server/ledger/service";
import {reviewNow as now,reviewBinding as binding} from "./action-review-client-fixture";
import {mountInvestorDisplay} from "./investor-display-fixture";
import * as schemas from "../src/server/investor/epoch-history-schemas";
import * as client from "../src/components/workbench/investor-epoch-history-client";
import {readActionReviewJson} from "../src/components/workbench/investor-action-review-client";
export const historyScope={workspace:"w",model:"fictional-model",binding};
export function historyResponse(ready=false,offset=0):schemas.HistoryWorkflowResponse{return {schema_version:"investor-epoch-history-workflow-response-v1",workspace_id:"w",workspace_revision:4,model_id:historyScope.model,
 session_binding:binding,lookup_nonce:null,checked_at:new Date(now+offset).toISOString(),refresh_after:new Date(now+offset+15000).toISOString(),read_only:false,
 epoch:{id:"fictional-epoch",enabled:true,valid_until:new Date(now+3600000).toISOString()},request:ready?{id:"fictional-plan-intent",action:"prepare",intent_hash:"b".repeat(64),created_at:new Date(now).toISOString(),valid_until:new Date(now+60000).toISOString(),status:"plan_ready",code:"HISTORY_WORKFLOW_PLAN_READY"}:null,
 preview:ready?{id:"fictional-plan-witness",content_hash:"a".repeat(64),workspace_revision:4,valid_until:new Date(now+60000).toISOString(),plan_status:"download_confirmation_required",expected_date_count:4,retained_date_count:2,missing_date_count:2,total_tiles:2,
  tiles:["VT.US","BND.US"].map(symbol=>({symbol,market:"US",start_date:"2026-10-20",end_date:"2026-10-20",expected_date_count:1})),prior_callback_count:1,historical_metadata_only:true}:null,download:null,
 visibility:"private_owner_only_not_ai",provider_calls:0,current_source_eligibility_restored:false,monitoring_resumed:false,trading_permission:false};}
export function historyReply(attempt:client.HistoryAttempt,status:"queued"|"plan_ready"|"download_queued"="queued",offset=0){
 const v=historyResponse(status==="plan_ready"||attempt.intent.action==="confirm",offset);v.lookup_nonce=attempt.nonce;
 v.request={id:"fictional-history-intent",action:attempt.intent.action as "prepare"|"confirm",intent_hash:hash(attempt.intent),created_at:new Date(now).toISOString(),valid_until:new Date(now+60000).toISOString(),status,
  code:status==="queued"?null:status==="plan_ready"?"HISTORY_WORKFLOW_PLAN_READY":"HISTORY_WORKFLOW_DOWNLOAD_QUEUED"};
 if(status==="download_queued"){v.workspace_revision=5;v.download={id:"fictional-history-batch",content_hash:"d".repeat(64),created_at:new Date(now+offset).toISOString(),valid_until:new Date(now+60000).toISOString(),historical_metadata_only:true,
  slots:v.preview!.tiles.slice(0,Number(attempt.intent.max_calls)).map((t,index)=>({...t,index,reserved:true,status:"collected"}))};}
 return v;
}
export async function verifyHistoryClient(){const v=historyResponse(true),answers=Object.fromEntries(schemas.historyAcknowledgements.map(k=>[k,true]));
 assert.throws(()=>client.buildHistoryAttempt("confirm",v,historyScope,{},1,"fictional-history-nonce",now),/ACK_REQUIRED/);
 assert.throws(()=>client.buildHistoryAttempt("confirm",v,historyScope,answers,1,"fictional-history-nonce",now+15000),/EXPIRED/);
 for(const patch of [{read_only:true},{session_binding:"e".repeat(64)},{epoch:{...v.epoch!,enabled:false}}])assert.throws(()=>client.buildHistoryAttempt("confirm",{...v,...patch},historyScope,answers,1,"fictional-history-nonce",now));
 const intent=client.buildHistoryAttempt("confirm",v,historyScope,answers,2,"fictional-history-nonce",now);assert.equal(intent.intent.max_calls,2);
 const queued=historyReply(intent);await client.parseHistoryResponse(queued,historyScope,intent,now);
 for(const patch of [{lookup_nonce:"other"},{request:{...queued.request!,intent_hash:"f".repeat(64)}},{trading_permission:true},{quotes:[]},{model_id:"foreign"}])await assert.rejects(()=>client.parseHistoryResponse({...queued,...patch},historyScope,intent,now));
}
function mount(t:TestContext){let nonce=0;const locks:boolean[]=[],changed:number[]=[];
 const h=mountInvestorDisplay(t,new URL("../src/components/workbench/investor-epoch-history.tsx",import.meta.url),"InvestorEpochHistory",{workspaceId:"w",modelId:historyScope.model,binding,disabled:false,onGuardChange:(v:boolean)=>locks.push(v),onChanged:()=>changed.push(1)},
  {"@/components/session-boundary":{useSessionBoundary:()=>({verified:true,sessionBinding:binding})},"@/server/investor/epoch-history-schemas":schemas,"./investor-epoch-history-client":client,"./investor-action-review-client":{readActionReviewJson}},now,
  {crypto:{randomUUID:()=>"fictional-history-"+(++nonce),subtle:globalThis.crypto.subtle}});
 const reply=async(i:number,v:unknown,status=200)=>{h.requests[i].resolve(new Response(JSON.stringify(v),{status}));await h.waitFor(()=>!h.text().includes("正在核对回补记录…"));};
 const check=async(i:number)=>{(h.nodes().filter(n=>n.type==="input")[i].props.onChange as (e:unknown)=>void)({target:{checked:true}});await h.flush();};
 const submit=(i:number)=>{(h.nodes().filter(n=>n.type==="form")[i].props.onSubmit as (e:unknown)=>void)({preventDefault(){}});};
 const attempt=(i:number):client.HistoryAttempt=>{const body=String(h.requests[i].options.body),intent=JSON.parse(body);return {body,intent,nonce:intent.idempotency_key};};
 return {...h,reply,check,submit,attempt,locks,changed};
}
export async function verifyHistoryJourney(t:TestContext){const h=mount(t);await h.waitRequests(1);await h.reply(0,historyResponse());h.submit(0);await h.flush();assert.equal(h.requests.length,1);
 await h.check(0);h.submit(0);h.submit(0);await h.waitRequests(2);const prepare=h.attempt(1);await h.reply(1,historyReply(prepare),202);
 await h.advance(now+2500);await h.waitRequests(3);await h.reply(2,historyReply(prepare,"plan_ready",2500));assert.match(h.text(),/历史缺口摘要/);
 assert.deepEqual(h.nodes().filter(n=>n.type==="input").map(n=>n.props.checked),[false,false,false,false,false]);
 for(let i=1;i<=4;i++)await h.check(i);h.submit(1);h.submit(1);await h.waitRequests(4);const confirm=h.attempt(3);assert.equal(confirm.intent.max_calls,1);
 await h.reply(3,historyReply(confirm),202);await h.advance(now+5000);await h.waitRequests(5);await h.reply(4,historyReply(confirm,"download_queued",5000));
 assert.match(h.text(),/原件已保存/);assert.match(h.text(),/具体结果见下方/);assert.doesNotMatch(h.text(),/本次最多下载前/);
 assert.equal(h.requests.filter(x=>x.method==="POST").length,2);assert.equal(h.changed.length,1);assert.equal(h.locks.at(-1),false);
 await h.invalidate();assert.equal(h.text(),"");
}
export async function verifyHistoryUnknown(t:TestContext){const h=mount(t);await h.waitRequests(1);await h.reply(0,historyResponse());await h.check(0);h.submit(0);await h.waitRequests(2);const original=h.attempt(1);
 await h.fail(1);assert.match(h.text(),/原提交尚未核实/);await h.advance(now+10000);assert.equal(h.requests.length,2);
 await h.click("核对历史回补进度");await h.waitRequests(3);assert.match(h.requests[2].url,new RegExp("nonce="+original.nonce));await h.reply(2,historyReply(original,"queued",10000));assert.equal(h.requests.filter(x=>x.method==="POST").length,1);
}
export async function verifyHistoryRetained(t:TestContext){const h=mount(t);await h.waitRequests(1);await h.reply(0,historyResponse(true));for(let i=1;i<=4;i++)await h.check(i);
 const saved=h.nodes().filter(n=>n.type==="form")[1].props.onSubmit as (e:unknown)=>void;
 h.setWall(now+15000);await h.wake();saved({preventDefault(){}});await h.flush();assert.equal(h.requests.length,1);
 await h.change({disabled:true});saved({preventDefault(){}});await h.flush();assert.equal(h.requests.length,1);
}
export async function verifyHistoryBudget(t:TestContext){const h=mount(t);await h.waitRequests(1);await h.reply(0,historyResponse(true));for(let i=1;i<=4;i++)await h.check(i);
 const old=h.nodes().filter(n=>n.type==="form")[1].props.onSubmit as (e:unknown)=>void;
 (h.node("select")!.props.onChange as (e:unknown)=>void)({target:{value:"2"}});await h.flush();assert.deepEqual(h.nodes().filter(n=>n.type==="input").map(n=>n.props.checked),[false,false,false,false,false]);
 old({preventDefault(){}});await h.flush();assert.equal(h.requests.length,1);
 for(let i=1;i<=4;i++)await h.check(i);await h.advance(now+12000);await h.waitRequests(2);assert.equal(h.requests[1].method,"GET");await h.reply(1,historyResponse(true,12000));
 assert.deepEqual(h.nodes().filter(n=>n.type==="input").map(n=>n.props.checked),[false,true,true,true,true]);h.submit(1);await h.waitRequests(3);assert.equal(h.attempt(2).intent.max_calls,2);await h.reply(2,historyReply(h.attempt(2),"queued",12000),202);
}
export async function verifyHistorySession(t:TestContext){const h=mount(t);await h.waitRequests(1);await h.reply(0,historyResponse());await h.check(0);h.submit(0);await h.waitRequests(2);const original=h.attempt(1);
 await h.invalidate();await h.reply(1,historyReply(original),202);assert.equal(h.text(),"");assert.equal(h.requests.filter(x=>x.method==="POST").length,1);
}
export async function verifyHistoryPollFailure(t:TestContext){const h=mount(t),draft=historyResponse(true),answers=Object.fromEntries(schemas.historyAcknowledgements.map(k=>[k,true]));
 const attempt=client.buildHistoryAttempt("confirm",draft,historyScope,answers,1,"fictional-poll-confirm",now),running=historyReply(attempt,"download_queued");running.lookup_nonce=null;running.download!.slots[0].status="running";
 await h.waitRequests(1);await h.reply(0,running);assert.equal(h.locks.at(-1),true);
 await h.advance(now+2500);await h.waitRequests(2);await h.fail(1);assert.match(h.text(),/原提交尚未核实/);assert.equal(h.locks.at(-1),true,"a failed GET must retain the waiting lock, not revive old parent derivatives");
 await h.advance(now+5000);assert.equal(h.requests.length,2);h.submit(0);await h.flush();assert.equal(h.requests.length,2);
 await h.click("核对历史回补进度");await h.waitRequests(3);const completed=historyReply(attempt,"download_queued",5000);completed.lookup_nonce=null;await h.reply(2,completed);
 assert.equal(h.locks.at(-1),false);assert.equal(h.changed.length,1);assert.equal(h.requests.filter(r=>r.method==="POST").length,0);
}
