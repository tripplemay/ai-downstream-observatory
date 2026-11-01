import assert from "node:assert/strict";
import test,{type TestContext} from "node:test";
import {webcrypto} from "node:crypto";
import {hash} from "../src/server/ledger/service";
import * as client from "../src/components/workbench/investor-action-review-client";
import {mountInvestorDisplay} from "./investor-display-fixture";
import {reviewAt,reviewBinding as binding,reviewNow as now,reviewResponse,reviewView} from "./action-review-client-fixture";

function mount(t:TestContext) {
  let nonce=0;const locks:boolean[]=[],refreshes:number[]=[];
  const h=mountInvestorDisplay(t,new URL("../src/components/workbench/investor-action-review.tsx",import.meta.url),"InvestorActionReview",
    {workspaceId:"w",binding,disabled:false,onScopeChange:(value:boolean)=>locks.push(value),onRefresh:()=>refreshes.push(1)},
    {"@/components/ui/input":{Input:"Input"},"@/components/session-boundary":{useSessionBoundary:()=>({verified:true,sessionBinding:binding})},
      "./investor-action-review-client":client},now,{crypto:{randomUUID:()=>`fictional-review-${++nonce}`,subtle:webcrypto.subtle}});
  async function reply(index:number,value:unknown,status=200) {
    h.requests[index].resolve(new Response(JSON.stringify(value),{status}));
    await h.waitFor(()=>!h.text().includes("正在核对受理记录与当前资料…"));
  }
  async function ready() {await h.click("查看并复核资料更新");await reply(0,reviewResponse());}
  async function edit(index:number,value:string) {(h.nodes().filter(row=>row.type==="Input")[index].props.onChange as (event:unknown)=>void)({target:{value}});await h.flush();}
  async function check(index:number,value=true) {(h.nodes().filter(row=>row.type==="input")[index].props.onChange as (event:unknown)=>void)({target:{checked:value}});await h.flush();}
  async function fill() {await edit(0,"2026-11-02T14:30");await edit(1,"2026-11-09T21:00");await edit(2,"0.432109");await check(0);}
  const submit=()=> (h.node("form")!.props.onSubmit as (event:unknown)=>void)({preventDefault(){}});
  return {...h,locks,refreshes,reply,ready,edit,check,fill,submit};
}
test("ordinary review opens lazily, shows exact source differences and old tax privately, and starts with blank assumptions and no consent",async t=>{
  const h=mount(t);await h.flush();assert.equal(h.requests.length,0);assert.equal(h.locks.at(-1),false);
  await h.ready();assert.equal(h.requests[0].method,"GET");assert.equal(h.locks.at(-1),true);
  for(const text of ["4.32109 USD/份","未复权金额 4.321 USD/份","调整字段 4.32","Fictional unchanged private tax explanation","不是交易授权"])assert.ok(h.text().includes(text),text);
  assert.deepEqual(h.nodes().filter(row=>row.type==="Input").map(row=>row.props.value),["","",""]);
  assert.deepEqual(h.nodes().filter(row=>row.type==="input").map(row=>row.props.checked),[false,false]);
  assert.equal(h.button("登记研究审阅，不执行交易")!.props.disabled,true);
  await h.click("收起并清除本地输入");assert.equal(h.locks.at(-1),false);assert.equal(h.refreshes.length,1);assert.doesNotMatch(h.text(),/Fictional unchanged private/);
});
test("explicit confirmation posts one immutable intent, separate enable stays false, and receipt status never claims admission or trades",async t=>{
  const h=mount(t);await h.ready();await h.fill();assert.equal(h.button("登记研究审阅，不执行交易")!.props.disabled,false);
  h.submit();h.submit();await h.waitRequests(2);assert.equal(h.requests[1].method,"POST");
  const body=JSON.parse(h.requests[1].options.body as string);assert.equal(body.kind,"confirmation");assert.equal(body.body.enable_rule,false);assert.equal(body.body.new_events[0].tax_per_unit,"0.432109");
  const original=h.requests[1].options.body;
  await h.fail(1);assert.match(h.text(),/原提交仍待核实/);assert.equal(h.button("收起并清除本地输入")!.props.disabled,true);
  await h.advance(now+30000);assert.equal(h.requests.length,2);assert.equal(h.button("登记研究审阅，不执行交易"),undefined);
  await h.click("使用原请求重试");assert.equal(h.requests[2].options.body,original);
  const receipt=reviewResponse({checked_at:"2026-11-03T06:00:33.001Z",refresh_after:"2026-11-03T06:00:48.001Z",workspace_revision:2,lookup_nonce:body.body.idempotency_key,view:null,
    request:{...reviewResponse().request!,kind:"confirmation",intent_hash:hash(body),status:"confirmed",code:"ACTION_REVIEW_CONFIRMED",resource_id:"fictional-confirmation",resource_hash:"f".repeat(64),resource_valid_until:null}});
  await h.reply(2,receipt);assert.match(h.text(),/登记不等于监测已恢复；系统未下单/);assert.doesNotMatch(h.text(),/原提交仍待核实/);
  assert.equal(h.requests.filter(row=>row.method==="POST").length,2);assert.equal(h.nodes().some(row=>row.type==="Input"),false);
});
test("lost-response recovery is GET by original nonce; an empty lookup cannot adopt another request or silently retry",async t=>{
  const h=mount(t);await h.ready();await h.fill();h.submit();await h.waitRequests(2);const body=JSON.parse(h.requests[1].options.body as string);await h.fail(1);
  await h.click("核对受理状态");assert.equal(h.requests[2].method,"GET");assert.equal(h.requests[2].url,`/api/workbench/investor/action-review?nonce=${body.body.idempotency_key}`);
  await h.reply(2,reviewResponse({request:null,view:null,lookup_nonce:body.body.idempotency_key}));assert.match(h.text(),/原提交仍待核实/);
  await h.advance(now+10000);assert.equal(h.requests.length,3);
  await h.click("核对受理状态");await h.reply(3,reviewResponse({lookup_nonce:body.body.idempotency_key}));
  assert.match(h.text(),/原提交仍待核实/);assert.doesNotMatch(h.text(),/Fictional unchanged private tax explanation/);
});
test("editing or preparing a new witness clears consent; same-fund drafts survive but another fund never inherits its tax or instants",async t=>{
  const h=mount(t);await h.ready();await h.fill();await h.check(1);assert.deepEqual(h.nodes().filter(row=>row.type==="input").map(row=>row.props.checked),[false,true]);
  await h.check(0);await h.edit(2,"0.5");assert.equal(h.nodes().filter(row=>row.type==="input")[0].props.checked,false);
  await h.click("重新准备该基金预览");const intent=JSON.parse(h.requests[1].options.body as string),view=reviewView("VT.US","fictional-reprepared");
  await h.reply(1,reviewResponse({view,lookup_nonce:intent.idempotency_key,request:{...reviewResponse().request!,intent_hash:hash(intent),resource_id:view.preview.preview_id,resource_hash:hash(view.preview)}}));
  assert.deepEqual(h.nodes().filter(row=>row.type==="Input").map(row=>row.props.value),["2026-11-02T14:30","2026-11-09T21:00","0.5"]);
  assert.deepEqual(h.nodes().filter(row=>row.type==="input").map(row=>row.props.checked),[false,false]);
  await h.click("核对受理状态");await h.reply(2,reviewResponse({view:null,preview_error:"ACTION_REVIEW_VIEW_UNAVAILABLE"}));
  await h.click("准备 BND.US 更新预览");const other=JSON.parse(h.requests[3].options.body as string),bnd=reviewView("BND.US","fictional-bnd");
  await h.reply(3,reviewResponse({view:bnd,lookup_nonce:other.idempotency_key,request:{...reviewResponse().request!,symbol:"BND.US",intent_hash:hash(other),resource_id:bnd.preview.preview_id,resource_hash:hash(bnd.preview)}}));
  assert.deepEqual(h.nodes().filter(row=>row.type==="Input").map(row=>row.props.value),["","",""]);
});
test("stale views cannot confirm, failed reads hide source facts, and old callbacks cannot write after a parent lock or session invalidation",async t=>{
  const h=mount(t);await h.ready();await h.fill();const callback=h.node("form")!.props.onSubmit as (event:unknown)=>void,oldSubmit=()=>callback({preventDefault(){}});await h.change({disabled:true});oldSubmit();await h.flush();assert.equal(h.requests.length,1);
  await h.change({disabled:false});await h.advance(now+60000);assert.equal(h.button("登记研究审阅，不执行交易")!.props.disabled,true);assert.equal(h.requests.at(-1)!.method,"GET");
  await h.fail(h.requests.length-1);assert.doesNotMatch(h.text(),/Fictional unchanged private tax explanation|4\.32109 USD/);
  await h.invalidate();oldSubmit();await h.flush();assert.equal(h.requests.filter(row=>row.method==="POST").length,0);assert.equal(h.locks.at(-1),false);
  assert.equal(h.button("查看并复核资料更新")!.props.disabled,true);h.close();assert.equal(h.timers.size,0);
});
test("queued previews poll only GET; original deadlines and ready metadata without qualified view never enable confirmation",async t=>{
  const h=mount(t);await h.click("查看并复核资料更新");await h.reply(0,reviewResponse({workspace_revision:0,view:null,request:null}));
  await h.click("准备 VT.US 更新预览");const intent=JSON.parse(h.requests[1].options.body as string),base=reviewResponse().request!;
  await h.reply(1,reviewResponse({workspace_revision:0,view:null,lookup_nonce:intent.idempotency_key,request:{...base,intent_hash:hash(intent),status:"queued",code:null,resource_id:null,resource_hash:null,resource_valid_until:null}}),202);
  await h.advance(now+2500);assert.equal(h.requests[2].method,"GET");assert.match(h.requests[2].url,/request=fictional-job/);
  await h.reply(2,reviewResponse({view:null,preview_error:"ACTION_REVIEW_VIEW_UNAVAILABLE"}));assert.equal(h.node("form"),undefined);
  assert.equal(h.requests.filter(row=>row.method==="POST").length,1);assert.match(h.text(),/当前原文或依赖未通过核对/);
});
