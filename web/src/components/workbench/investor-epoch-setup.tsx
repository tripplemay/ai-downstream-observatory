"use client";
import {useEffect,useRef,useState,type FormEvent} from "react";
import {Button} from "@/components/ui/button";
import {useSessionBoundary} from "@/components/session-boundary";
import {SESSION_INVALIDATED_EVENT} from "@/components/session-boundary-state";
import type {EpochPreviewResponse} from "@/server/investor/epoch-preview-schemas";
import {epochRegistrationAcknowledgements,type EpochRegistrationResponse} from "@/server/investor/epoch-registration-schemas";
import {readActionReviewJson} from "./investor-action-review-client";
import {useInvestorDisplayClock} from "./investor-display-clock";
import {buildEpochSetupAttempt,parseEpochSetupResponse,epochSetupErrorText,epochRegistrationLabels,type EpochSetupAttempt,type EpochSetupKind} from "./investor-epoch-setup-client";
const states:Record<string,string>={queued:"请求已受理，等待后台核验",running:"后台正在独立核验资料",preview_ready:"资料预览已准备，尚未登记研究阶段",
  registered:"研究阶段已登记，尚未启用观察",rejected:"资料准备未通过，未登记或启用",expired:"原请求或预览已到期",outdated:"原请求已被后续版本取代",unknown:"原请求结果未知，不自动重试"};
export function InvestorEpochSetup({workspaceId,modelId,binding,disabled,onGuardChange,onChanged}:{workspaceId:string;modelId:string;binding:string;disabled:boolean;onGuardChange:(v:boolean)=>void;onChanged:()=>void}){
  const session=useSessionBoundary(),scope={workspace:workspaceId,model:modelId,binding},key=[workspaceId,modelId,binding].join(":");
  const [p,setP]=useState<EpochPreviewResponse|null>(null),[r,setR]=useState<EpochRegistrationResponse|null>(null),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState("");
  const [answers,setAnswers]=useState<Record<string,boolean>>({});
  const live=useRef(true),invalid=useRef(false),generation=useRef(0),active=useRef<AbortController|null>(null),pending=useRef<EpochSetupAttempt|null>(null);
  const tracking=useRef<Partial<Record<EpochSetupKind,EpochSetupAttempt>>>({}),reported=useRef<string|null>(null);
  const verified=session?.verified===true&&session.sessionBinding===binding&&!invalid.current;
  const current=useRef({key,verified,disabled,p,r,answers});current.current={key,verified,disabled,p,r,answers};
  const callbacks=useRef({onGuardChange,onChanged});callbacks.current={onGuardChange,onChanged};
  const clock=useInvestorDisplayClock(p?.checked_at??r?.checked_at??null,[p?.refresh_after,p?.preview?.valid_until,r?.refresh_after,r?.request?.valid_until].filter(Boolean).map(v=>Date.parse(v!)).join("|"));
  const waiting=[p?.request?.status,r?.request?.status].some(s=>s==="queued"||s==="running"),dirty=Object.values(answers).some(Boolean);
  useEffect(()=>{live.current=true;const clear=()=>{invalid.current=true;generation.current++;active.current?.abort();pending.current=null;tracking.current={};setP(null);setR(null);setAnswers({});setBusy(false);setUncertain(false);};
    window.addEventListener(SESSION_INVALIDATED_EVENT,clear);return()=>{live.current=false;generation.current++;active.current?.abort();window.removeEventListener(SESSION_INVALIDATED_EVENT,clear);callbacks.current.onGuardChange(false);};},[]);
  useEffect(()=>{if(!verified){generation.current++;active.current?.abort();pending.current=null;tracking.current={};setP(null);setR(null);setAnswers({});setBusy(false);setUncertain(false);}},[verified]);
  useEffect(()=>{generation.current++;active.current?.abort();active.current=null;pending.current=null;tracking.current={};reported.current=null;invalid.current=false;setP(null);setR(null);setAnswers({});setBusy(false);setUncertain(false);setError("");},[key]);
  useEffect(()=>{callbacks.current.onGuardChange(verified&&(busy&&!!pending.current||uncertain||waiting||dirty));},[verified,busy,uncertain,waiting,dirty]);
  useEffect(()=>{if(verified&&r?.receipt&&!uncertain&&!busy&&reported.current!==r.receipt.epoch_id){reported.current=r.receipt.epoch_id;callbacks.current.onChanged();}},[verified,r,uncertain,busy]);
  async function exchange(kind:EpochSetupKind,attempt?:EpochSetupAttempt){
    const start=current.current;if(!live.current||invalid.current||!start.verified||active.current||attempt&&start.disabled)return;
    const recovery=pending.current;if(recovery&&recovery.kind!==kind)return;
    const retained=attempt??recovery??tracking.current[kind];
    const controller=new AbortController(),sequence=++generation.current;active.current=controller;setBusy(true);setError("");
    const valid=()=>live.current&&!invalid.current&&generation.current===sequence&&current.current.key===start.key&&current.current.verified;
    const selection=retained?"nonce="+encodeURIComponent(retained.nonce):"model="+encodeURIComponent(modelId);
    const timer=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch("/api/workbench/investor/epoch-"+kind+(attempt?"":"?"+selection),{method:attempt?"POST":"GET",credentials:"same-origin",redirect:"error",cache:"no-store",signal:controller.signal,
        headers:{"X-Workbench-Session-Binding":binding,...(attempt?{"Content-Type":"application/json"}:{})},...(attempt?{body:attempt.body}:{})});
      if(!valid())return;if(response.status===401){window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT));return;}
      const raw=await readActionReviewJson(response);if(!valid())return;
      if(!response.ok){const code=raw&&typeof raw==="object"&&"error"in raw?String(raw.error):"";
        if(attempt&&[400,403,409,413,423].includes(response.status)&&!code.includes("DUPLICATE_CONFLICT")){pending.current=null;setUncertain(false);}throw new Error(code);}
      const value=await parseEpochSetupResponse(kind,raw,scope,retained,Date.now());if(!valid())return;
      if(attempt||recovery){tracking.current[kind]=(attempt??recovery)!;pending.current=null;setUncertain(false);}
      setAnswers({});if(kind==="preview")setP(value as EpochPreviewResponse);else setR(value as EpochRegistrationResponse);
    }catch(e){if(valid()){setError(epochSetupErrorText(e));setAnswers({});if(kind==="preview")setP(null);else setR(null);if(attempt||pending.current)setUncertain(pending.current!==null);}}
    finally{clearTimeout(timer);if(active.current===controller)active.current=null;if(valid())setBusy(false);}
  }
  useEffect(()=>{if(verified)void exchange("preview"); // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,verified]);
  useEffect(()=>{if(!verified||busy||uncertain||dirty||error||!p)return;
    if(!r||!r.receipt&&!["queued","running","unknown"].includes(r.request?.status??"")&&p.request?.status==="preview_ready"&&p.workspace_revision!==r.workspace_revision)void exchange("registration");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[verified,busy,uncertain,dirty,error,p,r]);
  useEffect(()=>{if(!verified||busy||uncertain||dirty||!p||!r)return;
    const kind:EpochSetupKind=["queued","running"].includes(r.request?.status??"")?"registration"
      :["queued","running"].includes(p.request?.status??"")?"preview":Date.parse(r.refresh_after)<=Date.parse(p.refresh_after)?"registration":"preview";
    const timer=setTimeout(()=>void exchange(kind),waiting?2500:Math.max(1000,Math.min(Date.parse(p.refresh_after),Date.parse(r.refresh_after))-Date.now()-3000));
    return()=>clearTimeout(timer); // eslint-disable-next-line react-hooks/exhaustive-deps
  },[verified,busy,uncertain,dirty,waiting,p,r]);
  const fresh=!!p&&!!r&&clock<Math.min(Date.parse(p.refresh_after),Date.parse(r.refresh_after));
  const held=waiting||p?.request?.status==="unknown"||r?.request?.status==="unknown";
  const eligible=verified&&!disabled&&!busy&&!uncertain&&fresh&&!p?.read_only&&!r?.read_only&&!held&&!r?.receipt;
  function submit(kind:EpochSetupKind,event:FormEvent){
    event.preventDefault();const c=current.current;
    if(!live.current||invalid.current||!eligible||active.current||pending.current||c.key!==key||!c.verified||c.disabled||c.p!==p||c.r!==r||c.answers!==answers||!p||!r)return;
    try{const attempt=buildEpochSetupAttempt(kind,p,r,scope,answers,crypto.randomUUID(),Date.now());pending.current=attempt;setUncertain(true);callbacks.current.onGuardChange(true);void exchange(kind,attempt);}
    catch(e){setError(epochSetupErrorText(e));}
  }
  const change=(ack:string,checked:boolean)=>{const c=current.current;if(!eligible||!live.current||invalid.current||c.disabled||!c.verified||c.key!==key||c.p!==p||c.r!==r||c.answers!==answers)return;callbacks.current.onGuardChange(true);setAnswers(v=>({...v,[ack]:checked}));};
  if(!verified)return null;
  return <section aria-labelledby="epoch-setup-title" className="min-w-0 space-y-4 rounded-xl border p-4">
    <h3 id="epoch-setup-title" className="font-semibold">更正后，接续一个研究阶段</h3>
    <p className="text-sm">用于已明确确认历史更正和来源接续之后。系统准备资料，你查看并单独确认；不需填写来源编号或 JSON，不重写旧观察、不自动交易。</p>
    <Button type="button" variant="outline" disabled={busy} onClick={()=>void exchange(pending.current?.kind??"preview")}>核对阶段准备进度</Button>
    {busy&&<p role="status" className="text-sm">正在核对阶段记录…</p>}{error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
    {uncertain&&<div role="status" className="space-y-2 text-sm"><p>原提交尚未核实。先核对原请求，不另建一份、不自动重发。</p>
      <Button type="button" variant="outline" disabled={busy||disabled||!!p?.read_only||!!r?.read_only} onClick={()=>{if(pending.current)void exchange(pending.current.kind,pending.current);}}>明确重试原请求</Button></div>}
    {p?.request&&<p role="status" className="text-sm">资料准备：{states[p.request.status]}。{p.request.status==="rejected"&&"请先检查来源、更正和有效收盘是否齐备。"}</p>}
    {r?.request&&<p role="status" className="text-sm">阶段登记：{states[r.request.status]}。</p>}
    {r?.receipt?<div className="space-y-2 text-sm"><p>登记时间：{r.receipt.registered_at}。这是历史登记收据，不是当前行情或已恢复监测。</p><a className="underline" href="/workbench">返回总览核对并单独启用研究观察</a></div>:<>
      {p?.preview&&<div className="min-w-0 space-y-2 rounded-xl bg-muted/40 p-3 text-sm"><h4 className="font-medium">本次准备摘要</h4>
        <p>已绑定 {p.preview.corrections.length} 份已确认更正。保留原模型、起点与历史；以下仅为准备记录，不是当前来源资格或净值。</p>
        <ul>{p.preview.ranges.map((v,i)=><li key={i}>资料区间 {i+1}：{v.start_date} 至 {v.end_date}</li>)}</ul>
        <p>本次预览最晚确认时间：{p.preview.valid_until}；正式提交后后台仍须重新核验。</p>
        <details><summary className="cursor-pointer text-xs">可选：核对绑定编号</summary><p className="break-all text-xs">原历史头：{p.preview.original_head_id}</p>
          {p.preview.corrections.map(c=><p key={c.correction_id} className="break-all text-xs">更正：{c.correction_id}；来源接续：{c.handover_id}</p>)}</details>
      </div>}
      <form onSubmit={e=>submit("preview",e)} className="space-y-3"><fieldset disabled={!eligible} className="min-w-0 space-y-3">
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 shrink-0" checked={answers.preview===true} onChange={e=>change("preview",e.target.checked)}/><span>本次只核验并准备研究资料，不登记、启用观察或交易。</span></label>
        <Button className="h-auto max-w-full whitespace-normal" disabled={!eligible||answers.preview!==true}>核验更正后的阶段资料</Button>
      </fieldset></form>
      {p?.request?.status==="preview_ready"&&p.preview&&<form onSubmit={e=>submit("registration",e)} className="space-y-3"><fieldset disabled={!eligible||clock>=Date.parse(p.preview.valid_until)} className="min-w-0 space-y-3">
        <legend className="mb-2 font-medium">查看摘要后，明确登记边界</legend>
        {epochRegistrationAcknowledgements.map(ack=><label key={ack} className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 shrink-0" checked={answers[ack]===true} onChange={e=>change(ack,e.target.checked)}/><span>{epochRegistrationLabels[ack]}</span></label>)}
        <Button className="h-auto max-w-full whitespace-normal" disabled={!eligible||clock>=Date.parse(p.preview.valid_until)||!epochRegistrationAcknowledgements.every(k=>answers[k]===true)}>确认登记研究阶段，不启用观察</Button>
      </fieldset></form>}
    </>}
    {(p?.read_only||r?.read_only)&&<p role="status" className="text-sm">系统只读，只能核对已有准备和登记记录。</p>}
  </section>;
}
