"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import type { ActionReviewResponse, ActionReviewView } from "@/server/investor/action-review-schemas";
import { useInvestorDisplayClock } from "./investor-display-clock";
import { actionReviewAttempt, actionReviewErrorText, blankActionReviewDrafts, buildActionReviewConfirmation,
  parseActionReviewResponse, readActionReviewJson, type ActionReviewAttempt, type ActionReviewDraft } from "./investor-action-review-client";

const field="flex min-w-0 flex-col gap-2 text-sm";
const labels:Record<string,string>={queued:"已受理，等待后台核对",running:"后台正在核对原文与版本",preview_ready:"预览已登记，确认前仍须核对当前原文",
  confirmed:"研究审阅已登记；不是交易或监测准入",rejected:"本次请求未通过核对",expired:"本次请求或原确认期限已到",outdated:"工作区已变化，原预览不能确认",unknown:"本次任务结果尚未核实，不自动重试"};
const acknowledgements=["已核对发行人每份金额、单位和币种，以及两源的精确差异。","以下有效/支付时刻是我明确选择的研究假设，不是提供方精确时刻。",
  "研究税额由我明确填写；原税务说明仍适用于本次研究。","覆盖依据是这两源的报告范围，不保证客观不存在其他事件。",
  "本次不重述既有历史，只登记新报告事件；新规则先按默认停用登记。"];
function SourceChanges({view}:{view:ActionReviewView}) {
  return <div className="space-y-3">{view.changes.map(row=><section key={row.date} className="min-w-0 rounded-xl border p-3 text-sm">
    <h4 className="font-semibold">{row.date} · {row.disposition==="historical_correction"?"历史记录变化":"新报告日期"}（纽约）</h4>
    {row.outside_common_coverage&&<p className="mt-2 text-amber-700">超出两源共同覆盖，不能直接确认。</p>}
    {(["previous","current"] as const).map(side=><div key={side} className="mt-3 space-y-2 break-words">
      <p className="font-medium">{side==="previous"?"原登记依据":"当前保留原文"}</p>
      {row[side].issuer.map(item=><p key={item.record_hash}>发行人 {item.issuer_type_code}：{item.distribution_amount} USD/份；记录日 {item.record_date}，支付日 {item.pay_date}。</p>)}
      {row[side].dividends.map(item=><p key={item.record_hash}>EODHD：未复权金额 {item.unadjusted_value} {item.reported_currency}/份；调整字段 {item.value}（不替代发行人毛额）；记录日 {item.record_date??"未提供"}，支付日 {item.payment_date??"未提供"}。</p>)}
      {row[side].splits.map(item=><p key={item.record_hash}>拆分报告：{item.numerator} / {item.denominator}。</p>)}
      {!row[side].issuer.length&&!row[side].dividends.length&&!row[side].splits.length&&<p className="text-muted-foreground">此比较子集中没有记录，不据此认定客观没有事件。</p>}
    </div>)}
  </section>)}</div>;
}
export function InvestorActionReview({workspaceId,binding,disabled,onScopeChange,onRefresh}:{
  workspaceId:string;binding:string;disabled:boolean;onScopeChange:(locked:boolean)=>void;onRefresh:()=>void;
}) {
  const session=useSessionBoundary(),scope=workspaceId+":"+binding;
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[data,setData]=useState<ActionReviewResponse|null>(null),[error,setError]=useState("");
  const [drafts,setDrafts]=useState<ActionReviewDraft[]>([]),[ack,setAck]=useState(false),[enable,setEnable]=useState(false),[uncertain,setUncertain]=useState(false);
  const alive=useRef(true),invalidated=useRef(false),epoch=useRef(0),active=useRef<AbortController|null>(null),pending=useRef<ActionReviewAttempt|null>(null);
  const tracking=useRef<string|null>(null),viewKey=useRef<string|null>(null),draftSymbol=useRef<string|null>(null);
  const verified=session?.verified===true&&session.sessionBinding===binding&&!invalidated.current;
  const current=useRef({scope,verified,disabled});current.current={scope,verified,disabled};
  const now=useInvestorDisplayClock(data?.checked_at??null,[data?.view?.refresh_after,data?.view?.preview.valid_until].join("|"));
  useEffect(()=>{
    alive.current=true;
    const invalidate=()=>{invalidated.current=true;epoch.current++;active.current?.abort();pending.current=null;tracking.current=null;viewKey.current=null;draftSymbol.current=null;
      setData(null);setDrafts([]);setAck(false);setEnable(false);setUncertain(false);setOpen(false);setBusy(false);};
    window.addEventListener(SESSION_INVALIDATED_EVENT,invalidate);
    return()=>{alive.current=false;epoch.current++;active.current?.abort();window.removeEventListener(SESSION_INVALIDATED_EVENT,invalidate);};
  },[]);
  useEffect(()=>{epoch.current++;active.current?.abort();active.current=null;pending.current=null;tracking.current=null;viewKey.current=null;draftSymbol.current=null;
    setData(null);setDrafts([]);setAck(false);setEnable(false);setUncertain(false);setOpen(false);setBusy(false);},[scope]);
  useEffect(()=>{if(!verified){epoch.current++;active.current?.abort();pending.current=null;setData(null);setDrafts([]);setAck(false);setEnable(false);setUncertain(false);}},[verified]);
  useEffect(()=>{onScopeChange(verified&&open);},[verified,open,onScopeChange]);
  useEffect(()=>()=>onScopeChange(false),[onScopeChange]);
  useEffect(()=>{
    if(!uncertain&&!drafts.some(row=>row.at||row.pay_at||row.tax_per_unit))return;
    const unload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};
    const navigate=(event:MouseEvent)=>{if(event.target instanceof Element&&event.target.closest("a[href]")&&!window.confirm("仍有未确认的研究输入或未核实的提交。离开后请先读取登记状态，不能推定提交失败。确定离开吗？")){event.preventDefault();event.stopPropagation();}};
    window.addEventListener("beforeunload",unload);document.addEventListener("click",navigate,true);
    return()=>{window.removeEventListener("beforeunload",unload);document.removeEventListener("click",navigate,true);};
  },[uncertain,drafts]);
  function apply(value:ActionReviewResponse) {
    const next=value.view,key=next?next.provider_symbol+":"+next.preview.preview_id+":"+next.preview.draft_basis_hash:null;
    if(next&&key!==viewKey.current){const sameSymbol=draftSymbol.current===next.provider_symbol;setAck(false);setEnable(false);setDrafts(previous=>blankActionReviewDrafts(next).map(row=>{
      const old=sameSymbol?previous.find(item=>item.type===row.type&&item.date===row.date):undefined;return old?{...row,at:old.at,pay_at:old.pay_at,tax_per_unit:old.tax_per_unit}:row;
    }));viewKey.current=key;draftSymbol.current=next.provider_symbol;}
    if(value.preview_error){setAck(false);setEnable(false);}
    if(value.request?.status==="confirmed"){setDrafts([]);setAck(false);setEnable(false);viewKey.current=null;draftSymbol.current=null;}
    setData(value);
  }
  async function exchange(attempt?:ActionReviewAttempt) {
    const start=current.current;
    if(!start.verified||active.current||attempt&&start.disabled)return;
    const controller=new AbortController(),sequence=++epoch.current;active.current=controller;setBusy(true);setError("");
    const valid=()=>alive.current&&!invalidated.current&&sequence===epoch.current&&current.current.scope===start.scope&&current.current.verified;
    const recovery=pending.current,url=attempt?"/api/workbench/investor/action-review":recovery?`/api/workbench/investor/action-review?nonce=${encodeURIComponent(recovery.nonce)}`
      :tracking.current?`/api/workbench/investor/action-review?request=${encodeURIComponent(tracking.current)}`:"/api/workbench/investor/action-review";
    const timer=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await fetch(url,{method:attempt?"POST":"GET",credentials:"same-origin",redirect:"error",cache:"no-store",signal:controller.signal,
        headers:{"X-Workbench-Session-Binding":binding,...(attempt?{"Content-Type":"application/json"}:{})},...(attempt?{body:attempt.body}:{})});
      if(!valid())return;
      if(response.status===401){window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT));return;}
      const raw=await readActionReviewJson(response);if(!valid())return;
      if(!response.ok){
        if(attempt&&[400,403,409,413,423].includes(response.status)){pending.current=null;setUncertain(false);setAck(false);setEnable(false);}
        throw new Error(raw&&typeof raw==="object"&&"error" in raw?String(raw.error):"ACTION_REVIEW_UNAVAILABLE");
      }
      const value=await parseActionReviewResponse(raw,binding,workspaceId,Date.now(),attempt??recovery??undefined);if(!valid())return;
      if(value.request){
        if(!attempt&&!recovery&&tracking.current&&value.request.id!==tracking.current)throw new Error("ACTION_REVIEW_RESPONSE_INVALID");
        tracking.current=value.request.id;
        if(attempt||recovery){pending.current=null;setUncertain(false);}
        if((attempt||recovery)?.intent&&value.request.kind==="confirmation"){setDrafts([]);setAck(false);setEnable(false);viewKey.current=null;draftSymbol.current=null;}
      }
      apply(value);
    }catch(error){if(valid()){setError(actionReviewErrorText(error));setAck(false);setEnable(false);setData(value=>value?{...value,view:null,preview_error:"ACTION_REVIEW_VIEW_UNAVAILABLE"}:null);}}
    finally{clearTimeout(timer);if(active.current===controller){active.current=null;if(alive.current)setBusy(false);}}
  }
  useEffect(()=>{
    if(!open||!verified||uncertain||!data?.request||!["queued","running","preview_ready"].includes(data.request.status))return;
    const timer=setInterval(()=>{if(document.visibilityState==="visible"&&!active.current&&!pending.current)void exchange();},data.request.status==="preview_ready"?15000:2500);
    return()=>clearInterval(timer);
  },[open,verified,uncertain,data?.request?.id,data?.request?.status]);
  function prepare(symbol:"VT.US"|"BND.US") {
    if(!data||current.current.disabled||data.read_only||active.current||pending.current||!current.current.verified)return;
    const attempt=actionReviewAttempt({kind:"preview",symbol,expected_revision:data.workspace_revision,idempotency_key:crypto.randomUUID()},binding,workspaceId);
    pending.current=attempt;setUncertain(true);setAck(false);setEnable(false);void exchange(attempt);
  }
  function submit(event:FormEvent) {
    event.preventDefault();if(!data?.view||current.current.disabled||data.read_only||active.current||pending.current||!current.current.verified)return;
    try {
      const intent=buildActionReviewConfirmation(data.view,drafts,ack,enable,crypto.randomUUID(),now);
      const attempt=actionReviewAttempt(intent,binding,workspaceId);pending.current=attempt;setUncertain(true);void exchange(attempt);
    }catch(error){setError(actionReviewErrorText(error));}
  }
  function edit(index:number,key:"at"|"pay_at"|"tax_per_unit",value:string) {setDrafts(rows=>rows.map((row,i)=>i===index?{...row,[key]:value}:row));setAck(false);setError("");}
  const view=data?.view,stale=!view||now>=Date.parse(view.refresh_after)||now>=Date.parse(view.preview.valid_until);
  const locked=disabled||busy||!verified||!!data?.read_only||uncertain||stale;
  return <section aria-labelledby="action-review-title" className="min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6">
    <h2 id="action-review-title" className="font-semibold">资料有变化，在这里核对</h2>
    <p className="mt-2 text-sm text-muted-foreground">查看已保留的发行人和交叉资料，确认必要研究假设。不用填写来源编号或 JSON，不重新请求行情，不授权交易。</p>
    {!open?<Button className="mt-4" variant="outline" disabled={disabled||!verified} onClick={()=>{if(current.current.disabled||!current.current.verified)return;onScopeChange(true);setOpen(true);void exchange();}}>查看并复核资料更新</Button>:<div className="mt-4 space-y-4">
      <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={busy||!verified} onClick={()=>void exchange()}>核对受理状态</Button>
        <Button type="button" variant="ghost" disabled={busy||uncertain} onClick={()=>{epoch.current++;active.current?.abort();setOpen(false);setData(null);setDrafts([]);setAck(false);setEnable(false);tracking.current=null;viewKey.current=null;draftSymbol.current=null;onScopeChange(false);onRefresh();}}>收起并清除本地输入</Button></div>
      {busy&&<p role="status" className="text-sm">正在核对受理记录与当前资料…</p>}
      {error&&<p role="alert" className="break-words text-sm text-red-600">{error}</p>}
      {uncertain&&<div role="status" className="space-y-2 rounded-xl border p-3 text-sm"><p>原提交仍待核实。连接失败不等于未受理；不会自动创建第二个请求。</p>
        <Button type="button" variant="outline" disabled={busy||disabled||!verified} onClick={()=>{if(pending.current)void exchange(pending.current);}}>使用原请求重试</Button></div>}
      {data?.read_only&&<p role="status" className="text-sm">系统当前只读，只能核对登记状态。</p>}
      {data?.request&&<p role="status" className="text-sm">{labels[data.request.status]}{data.request.status==="rejected"?`（${data.request.code}）`:""}。</p>}
      {data?.request?.status==="confirmed"&&<p className="text-sm">已保留原历史。当前行情、汇率、费用和模型接续仍须重新核验，登记不等于监测已恢复；系统未下单。</p>}
      {data?.preview_error&&<p role="status" className="text-sm">当前原文或依赖未通过核对，已隐藏旧预览；保留的本地输入仍未确认。</p>}
      {data&&!view&&!uncertain&&!busy&&!["queued","running"].includes(data.request?.status??"")&&<div className="flex flex-wrap gap-3">
        {data.symbols.map(symbol=><Button key={symbol} type="button" variant="outline" disabled={disabled||data.read_only||!verified} onClick={()=>prepare(symbol)}>准备 {symbol} 更新预览</Button>)}
        {!data.symbols.length&&<p className="text-sm">暂无可以唯一定位的已登记维护规则；不以最新记录覆盖其他来源。</p>}
      </div>}
      {view&&<div className="space-y-4">
        <p className="text-sm">{view.provider_symbol} · 来源批次 {view.source_day}（纽约）；历史覆盖 {view.previous_coverage_end}，待核对覆盖 {view.candidate_coverage_end}。</p>
        <p className="break-words text-xs text-muted-foreground">原确认截止 {view.preview.valid_until.replace("T"," ")}；刷新不会延长。预览核对时间 {view.checked_at.replace("T"," ")}。</p>
        <SourceChanges view={view}/>
        <div className="rounded-xl border p-3 text-sm"><p className="font-medium">原税务说明（本入口不修改）</p><p className="mt-2 whitespace-pre-wrap break-words">{view.unchanged_tax_assumption}</p></div>
        {!view.confirmation_supported&&<p role="status" className="text-sm">{view.status==="no_reported_changes"?"没有新增可确认记录；不会重复批准。":"存在历史更正、共同覆盖以外记录或其他来源差异，不能当作普通追加。需另行核对影响范围，不能通过重新启用清除。"}</p>}
        {view.confirmation_supported&&<form onSubmit={submit} className="space-y-4"><fieldset disabled={locked} className="min-w-0 space-y-4">
          <p className="text-sm">来源只报告日期。以下时刻采用 UTC，由你明确选择为研究假设，不冒充提供方的精确时刻；换算后的纽约日期须与来源一致。未知税额不要填零。</p>
          {drafts.map((row,index)=><div key={row.type+row.date} className="grid min-w-0 gap-3 rounded-xl border p-3 sm:grid-cols-2">
            <h4 className="text-sm font-medium sm:col-span-2">{row.date} · {row.type==="dividend"?"分配报告":"拆分报告"}的研究假设</h4>
            <label className={field}>研究有效时刻（UTC）<Input type="datetime-local" step="1" required value={row.at} onChange={event=>edit(index,"at",event.target.value)}/></label>
            {row.type==="dividend"&&<><label className={field}>研究支付时刻（UTC）<Input type="datetime-local" step="1" required value={row.pay_at} onChange={event=>edit(index,"pay_at",event.target.value)}/></label>
              <label className={field}>每份研究税额（USD）<Input inputMode="decimal" autoComplete="off" maxLength={60} required value={row.tax_per_unit} onChange={event=>edit(index,"tax_per_unit",event.target.value)}/></label></>}
          </div>)}
          <ul className="list-disc space-y-2 pl-5 text-sm">{acknowledgements.map(text=><li key={text}>{text}</li>)}</ul>
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={ack} onChange={event=>setAck(event.target.checked)} className="mt-1"/>我已逐项核对以上内容，确认本次研究假设与数据审阅；这不是交易授权。</label>
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={enable} onChange={event=>{setEnable(event.target.checked);setAck(false);}} className="mt-1"/>另行选择：登记后启用新的有界资料维护。仍只在无新增、无变化时续接，出现异常就停止，不自动批准新事件。</label>
          <Button disabled={locked||!ack}>登记研究审阅，不执行交易</Button>
        </fieldset></form>}
        {stale&&<p role="status" className="text-sm">预览已到复核时间，当前不能确认；请核对受理状态。输入仍只保留在本地未确认草稿中。</p>}
        <Button type="button" variant="outline" disabled={disabled||busy||uncertain||data.read_only||!verified} onClick={()=>prepare(view.provider_symbol)}>重新准备该基金预览</Button>
      </div>}
    </div>}
  </section>;
}
