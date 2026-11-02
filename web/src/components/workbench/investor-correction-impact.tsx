"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import type { ActionReviewView } from "@/server/investor/action-review-schemas";
import type { CorrectionImpactResponse } from "@/server/investor/correction-impact-schemas";
import { readActionReviewJson } from "./investor-action-review-client";
import { blankCorrectionDrafts, buildCorrectionAttempt, correctionErrorText, parseCorrectionResponse, type CorrectionAttempt, type CorrectionDraft } from "./investor-correction-impact-client";
import { useInvestorDisplayClock } from "./investor-display-clock";
import { InvestorCorrectionConsent } from "./investor-correction-consent";

const states:Record<string,string>={queued:"比较已受理，等待后台核对",running:"正在重放原来源和历史经济状态",preview_ready:"假设影响已计算，不是更正批准",
  rejected:"本次比较未通过核对",expired:"原比较或预览期限已到",outdated:"来源、模型或控制已有变化，已隐藏旧差额",unknown:"任务结果尚未核实，不自动重试"};
const reasons:Record<string,string>={CORRECTION_IMPACT_VERSION_CHANGED:"工作区、原头或来源已经变化。请重新核对资料后准备新比较。",
  CORRECTION_IMPACT_EXPIRED:"原期限已到。刷新不会延长期限，请重新准备资料预览。",CORRECTION_IMPACT_INVALID_ANSWERS:"逐日假设、税额、日期或拆分方向未通过核对；不要用零代替未知。",
  CORRECTION_IMPACT_SOURCE_UNAVAILABLE:"原件、身份、许可或完整原链尚未通过核对。不会跳过缺口生成差额，也不会恢复监测。"};

export function InvestorCorrectionImpact({view,modelId,workspaceId,binding,disabled,onGuardChange}:{
  view:ActionReviewView;modelId:string|null;workspaceId:string;binding:string;disabled:boolean;onGuardChange:(locked:boolean)=>void;
}) {
  const session=useSessionBoundary(),scope={workspace:workspaceId,binding,model:modelId??"",preview:view.preview.preview_id};
  const key=Object.values(scope).join(":"),[drafts,setDrafts]=useState<CorrectionDraft[]>(()=>blankCorrectionDrafts(view));
  const [ack,setAck]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState("");
  const [data,setData]=useState<CorrectionImpactResponse|null>(null),[hideSummary,setHideSummary]=useState(false);
  const [consentLocked,setConsentLocked]=useState(false),[registered,setRegistered]=useState(false);
  const live=useRef(true),invalid=useRef(false),epoch=useRef(0),active=useRef<AbortController|null>(null),pending=useRef<CorrectionAttempt|null>(null),tracking=useRef<string|null>(null);
  const verified=session?.verified===true&&session.sessionBinding===binding&&!invalid.current;
  const current=useRef({key,verified,disabled,canSubmit:false,dirty:false});current.current={key,verified,disabled,canSubmit:false,dirty:false};
  const now=useInvestorDisplayClock(data?.checked_at??view.checked_at,[view.preview.valid_until,data?.summary?.valid_until].join("|"));
  const dirty=drafts.some(row=>row.choice||row.reason||row.dividend_at||row.pay_at||row.tax||row.split_at||row.ratio_ack);
  current.current.dirty=dirty;
  const waiting=["queued","running"].includes(data?.request?.status??"");
  const correctionState=useRef({busy,uncertain,waiting,dirty});correctionState.current={busy,uncertain,waiting,dirty};
  const protectConsent=useCallback((locked:boolean)=>{
    if(!live.current||invalid.current||!current.current.verified)return;
    if(locked)current.current.canSubmit=false;
    setConsentLocked(locked);onGuardChange(locked||Object.values(correctionState.current).some(Boolean));
  },[onGuardChange]);
  const consentRegistered=useCallback(()=>{setRegistered(true);setDrafts([]);setAck(false);setHideSummary(true);},[]);
  useEffect(()=>{live.current=true;const clear=()=>{invalid.current=true;epoch.current++;active.current?.abort();pending.current=null;tracking.current=null;
    setData(null);setDrafts([]);setAck(false);setBusy(false);setUncertain(false);setError("");};
    window.addEventListener(SESSION_INVALIDATED_EVENT,clear);return()=>{live.current=false;epoch.current++;active.current?.abort();window.removeEventListener(SESSION_INVALIDATED_EVENT,clear);};},[]);
  useEffect(()=>{if(!verified){epoch.current++;active.current?.abort();pending.current=null;tracking.current=null;setData(null);setDrafts([]);setAck(false);setBusy(false);setUncertain(false);}},[verified]);
  useEffect(()=>{if(verified)setDrafts(rows=>rows.length?rows:blankCorrectionDrafts(view));},[verified,view]);
  useEffect(()=>{onGuardChange(verified&&(busy||uncertain||waiting||dirty||consentLocked));},[verified,busy,uncertain,waiting,dirty,consentLocked,onGuardChange]);
  useEffect(()=>()=>onGuardChange(false),[onGuardChange]);
  useEffect(()=>{if(!dirty&&!uncertain)return;const unload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};
    window.addEventListener("beforeunload",unload);return()=>window.removeEventListener("beforeunload",unload);},[dirty,uncertain]);
  async function exchange(attempt?:CorrectionAttempt){
    const start=current.current;if(!live.current||invalid.current||!start.verified||!modelId||active.current||attempt&&start.disabled)return;
    const controller=new AbortController(),sequence=++epoch.current;active.current=controller;setBusy(true);setError("");
    const valid=()=>live.current&&!invalid.current&&epoch.current===sequence&&current.current.key===start.key&&current.current.verified;
    const recovery=pending.current,selection=recovery?`nonce=${encodeURIComponent(recovery.nonce)}`:tracking.current?`request=${encodeURIComponent(tracking.current)}`:`preview=${encodeURIComponent(view.preview.preview_id)}`;
    const timer=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch(`/api/workbench/investor/correction-impact${attempt?"":"?"+selection}`,{method:attempt?"POST":"GET",credentials:"same-origin",redirect:"error",cache:"no-store",signal:controller.signal,
        headers:{"X-Workbench-Session-Binding":binding,...(attempt?{"Content-Type":"application/json"}:{})},...(attempt?{body:attempt.body}:{})});
      if(!valid())return;if(response.status===401){window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT));return;}
      const raw=await readActionReviewJson(response);if(!valid())return;
      if(!response.ok){const code=raw&&typeof raw==="object"&&"error" in raw?String(raw.error):"";
        if(attempt&&[400,403,409,413,423].includes(response.status)&&code!=="CORRECTION_IMPACT_DUPLICATE_CONFLICT"){pending.current=null;setUncertain(false);}
        throw new Error(code);}
      const value=await parseCorrectionResponse(raw,scope,attempt??recovery??undefined,Date.now());if(!valid())return;
      if(value.request){if(!attempt&&!recovery&&tracking.current&&value.request.id!==tracking.current)throw new Error("CORRECTION_IMPACT_RESPONSE_INVALID");
        tracking.current=value.request.id;if(attempt||recovery){pending.current=null;setUncertain(false);setHideSummary(false);}}
      if(value.summary&&!current.current.dirty)setHideSummary(false);setData(value);
    }catch(cause){if(valid()){setError(correctionErrorText(cause));setData(value=>value?{...value,summary:null,summary_hash:null}:null);if(attempt||pending.current)setUncertain(pending.current!==null);}}
    finally{clearTimeout(timer);if(active.current===controller)active.current=null;if(valid())setBusy(false);}
  }
  useEffect(()=>{if(verified&&modelId)void exchange();/* Scope is keyed by the parent. */ // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,verified]);
  useEffect(()=>{if(!verified||busy||uncertain||!waiting||!data)return;const timer=setTimeout(()=>void exchange(),Math.max(1000,Math.min(5000,Date.parse(data.refresh_after)-Date.now())));
    return()=>clearTimeout(timer);/* Poll only durable GET status, never repeat a POST. */ // eslint-disable-next-line react-hooks/exhaustive-deps
  },[verified,busy,uncertain,waiting,data]);
  function edit(index:number,patch:Partial<CorrectionDraft>){if(!live.current||invalid.current||!current.current.canSubmit)return;setDrafts(rows=>rows.map((row,i)=>i===index?{...row,...patch}:row));setAck(false);setHideSummary(true);}
  function submit(event:FormEvent){event.preventDefault();if(!live.current||invalid.current||!current.current.canSubmit||current.current.key!==key||active.current||pending.current||!modelId)return;try{
    const attempt=buildCorrectionAttempt(view,modelId,drafts,ack,crypto.randomUUID());pending.current=attempt;setUncertain(true);setHideSummary(true);void exchange(attempt);
  }catch(cause){setError(correctionErrorText(cause));}}
  const expired=now>=Date.parse(view.preview.valid_until),locked=disabled||!verified||busy||uncertain||waiting||!!data?.read_only||expired||consentLocked||registered;
  current.current.canSubmit=!locked;
  const summary=verified&&!hideSummary&&data?.summary&&now<Date.parse(data.summary.valid_until)?data.summary:null;
  if(!verified)return null;
  return <section aria-labelledby="correction-impact-title" className="min-w-0 space-y-4 rounded-xl border p-4">
    <h3 id="correction-impact-title" className="font-semibold">先看历史变化会产生什么影响</h3>
    <p className="text-sm text-muted-foreground">仅比较原检查点价格和汇率下的假设影响，不显示当前净值、不改写原收益，也不批准更正或交易。提交后后台会重新核对原文、许可和版本。</p>
    {!modelId?<p role="status" className="text-sm">尚无观察模型，不能计算组合历史影响；不会替你创建观察起点。</p>:<>
      <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={busy||consentLocked} onClick={()=>void exchange()}>核对比较受理状态</Button>
        <Button type="button" variant="ghost" disabled={busy||uncertain||waiting||consentLocked||registered} onClick={()=>{setDrafts(blankCorrectionDrafts(view));setAck(false);setError("");setHideSummary(true);}}>清除本地假设</Button></div>
      {busy&&<p role="status" className="text-sm">正在核对本次请求…</p>}{error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
      {uncertain&&<div role="status" className="space-y-2 text-sm"><p>原请求是否受理尚未核实。先核对状态；如需重发，只能使用原请求，不会自动生成第二份。</p>
        <Button type="button" variant="outline" disabled={busy||disabled} onClick={()=>{if(pending.current)void exchange(pending.current);}}>使用原请求重试</Button></div>}
      {data?.request&&<p role="status" className="text-sm">{states[data.request.status]}。{data.request.status==="rejected"&&<span className="mt-2 block">{reasons[data.request.code??""]??"请核对资料缺口后再明确准备新比较。"}</span>}</p>}
      {data?.summary&&now>=Date.parse(data.summary.valid_until)&&<p role="status" className="text-sm">上次比较已到有效期限，已隐藏差额。请核对受理状态；不会把旧结果延长为当前资料。</p>}
      {summary&&<div className="min-w-0 space-y-3 rounded-xl bg-muted/40 p-4 text-sm" data-testid="correction-impact-summary">
        <p className="font-medium">上次已计算的假设比较 · 归一化模型初始单位 10,000 CNY，非你的真实账户或资金</p>
        <p className="break-words">原检查点 {summary.original_checkpoint_at}；假设获知于 {summary.checked_at}。不是当前行情，也不重新计算当时策略决策。</p>
        <dl className="grid min-w-0 gap-3 sm:grid-cols-3">{[["原记录估值",summary.original_valuation_cny],["假设后估值",summary.hypothetical_valuation_cny],["同口径差额",summary.difference_cny]].map(([label,value])=><div key={label} className="min-w-0"><dt>{label}（CNY）</dt><dd className="mt-1 break-all font-mono">{value}</dd></div>)}</dl>
        <p className="font-medium">模型份额</p>
        {Object.keys(summary.original_quantities).some(id=>summary.original_quantities[id]!==summary.hypothetical_quantities[id])
          ?Object.keys(summary.original_quantities).filter(id=>summary.original_quantities[id]!==summary.hypothetical_quantities[id]).map(id=><p key={id} className="break-all">{view.provider_symbol}：{summary.original_quantities[id]} → {summary.hypothetical_quantities[id]}</p>)
          :<p>份额不变。</p>}
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">{[["币种现金差额",summary.cash_delta],["未支付应收差额",summary.receivable_delta]].map(([label,values])=><div key={String(label)} className="min-w-0"><p className="font-medium">{String(label)}</p>
          {Object.entries(values).map(([currency,value])=><p key={currency} className="break-all">{currency}：{value}</p>)}</div>)}</div>
        {!!summary.ignored_new_report_dates.length&&<p>另有新增日期尚未处理：{summary.ignored_new_report_dates.join("、")}。</p>}
        <p>这份结果本身只是已保存的假设比较。正式更正须在下方另行确认；登记状态以独立收据为准，不会据此恢复监测。</p>
      </div>}
      {data?.request&&<InvestorCorrectionConsent key={`${key}:${data.request.id}`} workspaceId={workspaceId} binding={binding} modelId={modelId}
        impactId={data.request.id} summaryHash={summary?data.summary_hash:null} disabled={disabled||busy||uncertain||waiting||!!data.read_only}
        onGuardChange={protectConsent} onRegistered={consentRegistered}/>}
      {!registered&&<form onSubmit={submit} className="space-y-4"><fieldset disabled={locked} className="min-w-0 space-y-4">
        <p className="text-sm">每个历史日期单独选择。未知税额或时刻请保留空白，不要猜测或填零。UTC 时刻换算后的纽约日期须与上方来源相同。</p>
        {drafts.map((row,index)=>{const source=view.changes.find(change=>change.date===row.date)!;return <div key={row.date} className="min-w-0 space-y-3 rounded-xl border p-3 text-sm">
          <h4 className="font-medium">{row.date}（纽约）的影响假设</h4>
          <label className="flex min-w-0 flex-col gap-2">处理选择<select required value={row.choice} className="h-10 min-w-0 rounded-md border bg-background px-3" onChange={event=>edit(index,{choice:event.target.value as CorrectionDraft["choice"]})}>
            <option value="">请选择，不自动沿用</option><option value="retain">暂按原记录比较（不消除来源差异）</option>
            <option value="replace" disabled={source.outside_common_coverage||!source.current.issuer.length&&!source.current.splits.length}>按当前报告替换为研究假设</option>
            <option value="cancel" disabled={source.outside_common_coverage||!!source.current.issuer.length||!!source.current.dividends.length||!!source.current.splits.length}>假设取消（两源本次均未报告）</option>
          </select></label>
          <label className="flex min-w-0 flex-col gap-2">本次选择的理由<Input required maxLength={1000} value={row.reason} onChange={event=>edit(index,{reason:event.target.value})}/></label>
          {row.choice==="replace"&&<div className="grid min-w-0 gap-3 sm:grid-cols-2">
            {!!source.current.issuer.length&&<><label className="flex min-w-0 flex-col gap-2">分红有效时刻（UTC）<Input required type="datetime-local" step="1" value={row.dividend_at} onChange={event=>edit(index,{dividend_at:event.target.value})}/></label>
              <label className="flex min-w-0 flex-col gap-2">支付时刻（UTC）<Input required type="datetime-local" step="1" value={row.pay_at} onChange={event=>edit(index,{pay_at:event.target.value})}/></label>
              <label className="flex min-w-0 flex-col gap-2">每份研究税额（USD）<Input required inputMode="decimal" autoComplete="off" maxLength={60} value={row.tax} onChange={event=>edit(index,{tax:event.target.value})}/></label></>}
            {!!source.current.splits.length&&<><label className="flex min-w-0 flex-col gap-2">拆分有效时刻（UTC）<Input required type="datetime-local" step="1" value={row.split_at} onChange={event=>edit(index,{split_at:event.target.value})}/></label>
              <label className="flex items-start gap-3 sm:col-span-2"><input type="checkbox" checked={row.ratio_ack} onChange={event=>edit(index,{ratio_ack:event.target.checked})}/>我将上方提供方分子/分母明确假设为新份额/旧份额；这不是发行人已核验的方向。</label></>}
          </div>}
        </div>;})}
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={ack} onChange={event=>setAck(event.target.checked)}/><span>已核对来源差异、金额单位与币种，明确时刻、税额及原税务说明仍适用；仅接受原报告覆盖加上述假设，不声称客观无其他事件。本次只计算影响，不批准历史更正、不恢复监测、不授权交易。</span></label>
        <Button disabled={locked||!ack}>计算假设影响，不批准更正</Button>
      </fieldset></form>}
      {expired&&<p role="status" className="text-sm">原预览期限已到。清除本地假设后，可在上方重新准备来源预览；刷新不会延长原期限。</p>}
      {data?.read_only&&<p role="status" className="text-sm">系统只读，不能提交新的比较。</p>}
    </>}
  </section>;
}
