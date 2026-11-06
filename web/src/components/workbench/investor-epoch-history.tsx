"use client";
import {useEffect,useRef,useState,type FormEvent} from "react";
import {Button} from "@/components/ui/button";
import {useSessionBoundary} from "@/components/session-boundary";
import {SESSION_INVALIDATED_EVENT} from "@/components/session-boundary-state";
import {historyAcknowledgements,type HistoryWorkflowResponse} from "@/server/investor/epoch-history-schemas";
import {readActionReviewJson} from "./investor-action-review-client";
import {useInvestorDisplayClock} from "./investor-display-clock";
import {buildHistoryAttempt,parseHistoryResponse,historyError,historyLabels,type HistoryAttempt} from "./investor-epoch-history-client";
const labels:Record<string,string>={queued:"已受理，等待后台处理",running:"后台处理中",plan_ready:"历史缺口摘要已准备",download_queued:"已登记有界下载，具体结果见下方",rejected:"本次未通过，未建立新下载",
 expired:"原准备已到期",outdated:"工作区或来源已变化",unknown:"结果未知，不自动再发",collected:"原件已保存",already_available:"资料已有，无需新请求",superseded:"条件变化，未执行",blocked_predecessor:"前项未成功，已停止"};
export function InvestorEpochHistory({workspaceId,modelId,binding,disabled,onGuardChange,onChanged}:{workspaceId:string;modelId:string;binding:string;disabled:boolean;onGuardChange:(v:boolean)=>void;onChanged:()=>void}){
 const session=useSessionBoundary(),key=[workspaceId,modelId,binding].join(":"),scope={workspace:workspaceId,model:modelId,binding};
 const [value,setValue]=useState<HistoryWorkflowResponse|null>(null),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState(""),[answers,setAnswers]=useState<Record<string,boolean>>({}),[calls,setCalls]=useState(1);
 const live=useRef(true),invalid=useRef(false),generation=useRef(0),active=useRef<AbortController|null>(null),pending=useRef<HistoryAttempt|null>(null),tracked=useRef<HistoryAttempt|null>(null),reported=useRef<string|null>(null);
 const verified=session?.verified===true&&session.sessionBinding===binding&&!invalid.current;
 const current=useRef({key,verified,disabled,value,answers,calls});current.current={key,verified,disabled,value,answers,calls};
 const cb=useRef({onGuardChange,onChanged});cb.current={onGuardChange,onChanged};
 const clock=useInvestorDisplayClock(value?.checked_at??null,[value?.refresh_after,value?.preview?.valid_until,value?.epoch?.valid_until].filter(Boolean).join("|"));
 const waiting=["queued","running"].includes(value?.request?.status??"")||!!value?.download?.slots.some(s=>["queued","running"].includes(s.status)),dirty=Object.values(answers).some(Boolean)||calls!==1;
 useEffect(()=>{live.current=true;const clear=()=>{invalid.current=true;generation.current++;active.current?.abort();pending.current=tracked.current=null;setValue(null);setAnswers({});setBusy(false);setUncertain(false);};
  window.addEventListener(SESSION_INVALIDATED_EVENT,clear);return()=>{live.current=false;generation.current++;active.current?.abort();window.removeEventListener(SESSION_INVALIDATED_EVENT,clear);cb.current.onGuardChange(false);};},[]);
 useEffect(()=>{generation.current++;active.current?.abort();active.current=null;pending.current=tracked.current=null;reported.current=null;invalid.current=false;setValue(null);setAnswers({});setCalls(1);setBusy(false);setUncertain(false);setError("");},[key]);
 useEffect(()=>{if(!verified){generation.current++;active.current?.abort();pending.current=tracked.current=null;setValue(null);setAnswers({});setBusy(false);setUncertain(false);}},[verified]);
 useEffect(()=>{cb.current.onGuardChange(verified&&(busy&&!!pending.current||uncertain||waiting||dirty));},[verified,busy,uncertain,waiting,dirty]);
 useEffect(()=>{if(!verified||busy||uncertain||waiting||dirty||!value?.download)return;const sig=JSON.stringify(value.download);if(reported.current!==sig){reported.current=sig;cb.current.onChanged();}},[verified,busy,uncertain,waiting,dirty,value]);
 async function exchange(attempt?:HistoryAttempt){
  const start=current.current;if(!live.current||invalid.current||!start.verified||active.current||attempt&&start.disabled)return;
  const recovery=pending.current,retained=attempt??recovery??tracked.current,controller=new AbortController(),seq=++generation.current;
  active.current=controller;setBusy(true);setError("");const valid=()=>live.current&&!invalid.current&&generation.current===seq&&current.current.key===start.key&&current.current.verified;
  const timer=setTimeout(()=>controller.abort(),15000),query=retained?"nonce="+encodeURIComponent(retained.nonce):"model="+encodeURIComponent(modelId);
  try{const response=await fetch("/api/workbench/investor/epoch-history"+(attempt?"":"?"+query),{method:attempt?"POST":"GET",credentials:"same-origin",redirect:"error",cache:"no-store",signal:controller.signal,
    headers:{"X-Workbench-Session-Binding":binding,...(attempt?{"Content-Type":"application/json"}:{})},...(attempt?{body:attempt.body}:{})});
   if(!valid())return;if(response.status===401){window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT));return;}const raw=await readActionReviewJson(response);if(!valid())return;
   if(!response.ok){const code=raw&&typeof raw==="object"&&"error"in raw?String(raw.error):"";if(attempt&&[400,403,409,413,423].includes(response.status)&&!code.includes("DUPLICATE_CONFLICT")){pending.current=null;setUncertain(false);}throw new Error(code);}
   const next=await parseHistoryResponse(raw,scope,retained??undefined,Date.now());if(!valid())return;
   if(attempt||recovery){tracked.current=(attempt??recovery)!;pending.current=null;setUncertain(false);setAnswers({});}
   else if(start.value&&(start.value.preview?.content_hash!==next.preview?.content_hash||start.value.workspace_revision!==next.workspace_revision||next.request?.status!=="plan_ready")){setAnswers({});setCalls(1);}
   setValue(next);
  }catch(e){if(valid()){setError(historyError(e));setAnswers({});if(attempt||pending.current)setUncertain(pending.current!==null);
   // A failed GET is not evidence that in-flight data work has stopped.
   if(attempt&&!pending.current){setValue(null);setCalls(1);cb.current.onChanged();}}}
  finally{clearTimeout(timer);if(active.current===controller)active.current=null;if(valid())setBusy(false);}
 }
 useEffect(()=>{if(verified)void exchange(); // eslint-disable-next-line react-hooks/exhaustive-deps
 },[key,verified]);
 useEffect(()=>{if(!verified||busy||uncertain||error||!value)return;const timer=setTimeout(()=>void exchange(),waiting?2500:Math.max(1000,Date.parse(value.refresh_after)-Date.now()-3000));return()=>clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[verified,busy,uncertain,error,waiting,value]);
 const eligible=verified&&!disabled&&!busy&&!uncertain&&!error&&!value?.read_only&&!!value&&clock<Date.parse(value.refresh_after)&&!!value.epoch?.enabled&&!waiting;
 function submit(action:"prepare"|"confirm",event:FormEvent){event.preventDefault();const c=current.current;if(!eligible||!live.current||invalid.current||active.current||pending.current||c.key!==key||!c.verified||c.disabled||c.value!==value||c.answers!==answers||c.calls!==calls||!value)return;
  if(action==="prepare"?answers.prepare!==true:!historyAcknowledgements.every(k=>answers[k]===true))return;
  try{const attempt=buildHistoryAttempt(action,value,scope,answers,calls,crypto.randomUUID(),Date.now());pending.current=attempt;setUncertain(true);cb.current.onGuardChange(true);void exchange(attempt);}catch(e){setError(historyError(e));}}
 const change=(ack:string,checked:boolean)=>{const c=current.current;if(!eligible||!live.current||invalid.current||c.disabled||!c.verified||c.key!==key||c.value!==value||c.answers!==answers)return;cb.current.onGuardChange(true);setAnswers(v=>({...v,[ack]:checked}));};
 if(!verified)return null;
 const ready=value?.request?.status==="plan_ready"&&value.preview?.plan_status==="download_confirmation_required"&&clock<Date.parse(value.preview.valid_until);
 const unknown=value?.download?.slots.some(s=>s.status==="unknown");
 return <section aria-labelledby="epoch-history-title" className="min-w-0 space-y-4 rounded-xl border p-4">
  <h3 id="epoch-history-title" className="font-semibold">补齐中断期间的历史收盘</h3>
  <p className="text-sm">先查看缺口摘要，再单独确认有限下载。无需填写来源编号或 JSON；下载成功仍不等于当前资料齐备或恢复观察。</p>
  <Button type="button" variant="outline" disabled={busy} onClick={()=>void exchange()}>核对历史回补进度</Button>
  {busy&&<p role="status" className="text-sm">正在核对回补记录…</p>}{error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
  {uncertain&&<div role="status" className="space-y-2 text-sm"><p>原提交尚未核实。先核对原请求，不自动重发或另建下载。</p><Button type="button" variant="outline" disabled={busy||disabled||!!value?.read_only} onClick={()=>{if(pending.current)void exchange(pending.current);}}>明确重试原请求</Button></div>}
  {value?.request&&<p role="status" className="text-sm">{labels[value.request.status]}。</p>}
  {value&&!value.epoch?.enabled&&<p className="text-sm">请先单独启用研究阶段；本页不会自动启用。</p>}
  {value?.preview&&!value.download&&<div className="min-w-0 space-y-2 rounded-lg bg-muted/40 p-3 text-sm"><h4 className="font-medium">历史缺口摘要</h4>
   <p>应有 {value.preview.expected_date_count} 个证券交易日，已保留 {value.preview.retained_date_count} 个，缺失 {value.preview.missing_date_count} 个；共 {value.preview.total_tiles} 个缺失块。</p>
   <p>相关旧回调记录 {value.preview.prior_callback_count} 份，保留原结果，不推断是否成功联网。</p>
   {value.preview.plan_status==="no_missing_past_closes"?<p>没有需要下载的过去收盘。当前行情、汇率及公司行动仍需独立核对。</p>:value.preview.plan_status==="overlap_review_required"?<p>保留原件存在无法自动选择的重叠，需要先复核；不通过重复下载掩盖歧义。</p>:<>
    <p>本次最多下载前 {Math.min(calls,value.preview.total_tiles)} 块，每块不超过 31 个自然日，不请求当前市场当地日期。</p>
    <ul className="space-y-1">{value.preview.tiles.slice(0,calls).map((t,i)=><li key={i} className="break-words">{t.symbol}：{t.start_date} 至 {t.end_date}，{t.expected_date_count} 个交易日</li>)}</ul>
    <p>本次最晚确认：{value.preview.valid_until}。后台仍将重新核验，不承诺本次能恢复监测。</p>
   </>}
  </div>}
  {value?.download&&<div className="min-w-0 space-y-2 text-sm"><h4 className="font-medium">最近下载批次</h4><ul className="space-y-2">{value.download.slots.map(s=><li key={s.index} className="break-words">{s.symbol} · {s.start_date} 至 {s.end_date}：{labels[s.status]}。{s.reserved?"已有持久调用预留，不据此推断网络结果。":"未登记调用预留。"}</li>)}</ul>
   {unknown&&<p role="status">存在未知历史请求，需要明确复核。不会用新编号绕过或自动再发。</p>}
   <p>采集记录只是历史元数据；请回总览核对独立研究状态，交易仍由你决定。</p></div>}
  <form onSubmit={e=>submit("prepare",e)}><fieldset disabled={!eligible} className="min-w-0 space-y-3"><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 shrink-0" checked={answers.prepare===true} onChange={e=>change("prepare",e.target.checked)}/><span>本次只准备历史缺口摘要，不下载、不启用或交易。</span></label><Button disabled={!eligible||answers.prepare!==true}>准备历史缺口摘要</Button></fieldset></form>
  {ready&&<form onSubmit={e=>submit("confirm",e)}><fieldset disabled={!eligible||!!unknown} className="min-w-0 space-y-3"><legend className="mb-2 font-medium">查看摘要后，明确确认下载</legend>
   <label className="flex flex-wrap items-center gap-3 text-sm">本次调用上限<select className="rounded border bg-background p-2" value={calls} onChange={e=>{const c=current.current;if(eligible&&!unknown&&live.current&&!invalid.current&&c.verified&&!c.disabled&&c.key===key&&c.value===value&&c.calls===calls){cb.current.onGuardChange(true);setCalls(Number(e.target.value));setAnswers({});}}}>{[1,2,3,4].filter(n=>n<=Math.max(1,value!.preview!.total_tiles)).map(n=><option key={n} value={n}>{n} 次</option>)}</select></label>
   {historyAcknowledgements.map(ack=><label key={ack} className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 shrink-0" checked={answers[ack]===true} onChange={e=>change(ack,e.target.checked)}/><span>{historyLabels[ack]}</span></label>)}
   <Button className="h-auto max-w-full whitespace-normal" disabled={!eligible||!!unknown||!historyAcknowledgements.every(k=>answers[k]===true)}>确认有界历史下载，不交易</Button>
  </fieldset></form>}
  {value?.read_only&&<p role="status" className="text-sm">系统只读，只能核对已有记录。</p>}
 </section>;
}
