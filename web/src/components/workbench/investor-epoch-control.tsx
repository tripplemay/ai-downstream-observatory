"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import { epochControlAcknowledgements, type EpochControlResponse } from "@/server/investor/epoch-control-schemas";
import { readActionReviewJson } from "./investor-action-review-client";
import { useInvestorDisplayClock } from "./investor-display-clock";
import { buildEpochControlAttempt, parseEpochControlResponse, epochControlErrorText, epochControlLabels, type EpochControlAttempt } from "./investor-epoch-control-client";

const states:Record<string,string>={queued:"启用意图已受理，尚未启用",running:"后台正在重新核验当前资料和连续状态",applied:"启用请求已处理，以当前阶段开关为准",
  rejected:"本次启用未通过，未恢复研究观察",expired:"原请求已到期，请核对处理结果",unknown:"处理结果未知，不自动重试",superseded:"旧意图已被后续研究记录取代，不代表该作业已完成；须按当前开关重新确认"};
export function InvestorEpochControl({workspaceId,modelId,binding,disabled,onGuardChange,onChanged}:{workspaceId:string;modelId:string;binding:string;disabled:boolean;onGuardChange:(value:boolean)=>void;onChanged:()=>void}){
  const session=useSessionBoundary(),scope={workspace:workspaceId,model:modelId,binding},key=[workspaceId,modelId,binding].join(":");
  const [data,setData]=useState<EpochControlResponse|null>(null),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState("");
  const [answers,setAnswers]=useState<Partial<Record<typeof epochControlAcknowledgements[number],boolean>>>({});
  const live=useRef(true),invalid=useRef(false),generation=useRef(0),active=useRef<AbortController|null>(null),pending=useRef<EpochControlAttempt|null>(null),tracking=useRef<string|null>(null),reported=useRef<string|null>(null);
  const verified=session?.verified===true&&session.sessionBinding===binding&&!invalid.current;
  const current=useRef({key,verified,disabled,data,answers});current.current={key,verified,disabled,data,answers};
  const callbacks=useRef({onGuardChange,onChanged});callbacks.current={onGuardChange,onChanged};
  const now=useInvestorDisplayClock(data?.checked_at??null,[data?.refresh_after,data?.epoch?.valid_until].filter(Boolean).map(value=>Date.parse(value!)).join("|"));
  const waiting=["queued","running"].includes(data?.request?.status??""),dirty=Object.values(answers).some(Boolean);
  useEffect(()=>{
    live.current=true;const clear=()=>{invalid.current=true;generation.current++;active.current?.abort();pending.current=null;tracking.current=null;setData(null);setAnswers({});setBusy(false);setUncertain(false);};
    window.addEventListener(SESSION_INVALIDATED_EVENT,clear);return()=>{live.current=false;generation.current++;active.current?.abort();window.removeEventListener(SESSION_INVALIDATED_EVENT,clear);callbacks.current.onGuardChange(false);};
  },[]);
  useEffect(()=>{if(!verified){generation.current++;active.current?.abort();pending.current=null;tracking.current=null;setData(null);setAnswers({});setBusy(false);setUncertain(false);}},[verified]);
  useEffect(()=>{generation.current++;active.current?.abort();active.current=null;pending.current=null;tracking.current=null;reported.current=null;invalid.current=false;
    setData(null);setAnswers({});setBusy(false);setUncertain(false);setError("");},[key]);
  useEffect(()=>{callbacks.current.onGuardChange(verified&&(uncertain||dirty||waiting||busy&&!!pending.current));},[verified,busy,uncertain,dirty,waiting]);
  useEffect(()=>{
    if(!verified||!data||busy||uncertain||dirty||waiting)return;
    // Control acceptance and its later observation are separate publications.
    const marker=[data.workspace_revision,data.epoch?.id,data.epoch?.control_id,data.epoch?.checkpoint.id,data.epoch?.checkpoint.content_hash].join(":");
    if(reported.current===marker)return;reported.current=marker;callbacks.current.onChanged();
  },[data,verified,busy,uncertain,dirty,waiting]);
  async function exchange(attempt?:EpochControlAttempt){
    const start=current.current;if(!live.current||invalid.current||!start.verified||active.current||attempt&&start.disabled)return;
    const controller=new AbortController(),sequence=++generation.current;active.current=controller;setBusy(true);setError("");
    if(attempt)callbacks.current.onGuardChange(true);
    const valid=()=>live.current&&!invalid.current&&sequence===generation.current&&current.current.key===start.key&&current.current.verified;
    const recovery=pending.current,selection=recovery?`nonce=${encodeURIComponent(recovery.nonce)}`:tracking.current?`nonce=${encodeURIComponent(tracking.current)}`:`model=${encodeURIComponent(modelId)}`;
    const timer=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch(`/api/workbench/investor/epoch-control${attempt?"":"?"+selection}`,{method:attempt?"POST":"GET",credentials:"same-origin",redirect:"error",cache:"no-store",signal:controller.signal,
        headers:{"X-Workbench-Session-Binding":binding,...(attempt?{"Content-Type":"application/json"}:{})},...(attempt?{body:attempt.body}:{})});
      if(!valid())return;if(response.status===401){window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT));return;}
      const raw=await readActionReviewJson(response);if(!valid())return;
      if(!response.ok){const code=raw&&typeof raw==="object"&&"error"in raw?String(raw.error):"";
        if(attempt&&[400,403,409,413,423].includes(response.status)&&code!=="EPOCH_CONTROL_DUPLICATE_CONFLICT"){pending.current=null;setUncertain(false);}throw new Error(code);}
      const value=await parseEpochControlResponse(raw,scope,attempt??recovery??undefined,Date.now());if(!valid())return;
      if(attempt||recovery){tracking.current=(attempt??recovery)!.nonce;pending.current=null;setUncertain(false);setAnswers({});}
      setAnswers({});setData(value);
    }catch(cause){if(valid()){setError(epochControlErrorText(cause));setAnswers({});setData(null);if(attempt||pending.current)setUncertain(pending.current!==null);}}
    finally{clearTimeout(timer);if(active.current===controller)active.current=null;if(valid())setBusy(false);}
  }
  useEffect(()=>{if(verified)void exchange();/* Parent keys immutable owner scope. */ // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,verified]);
  useEffect(()=>{if(!verified||busy||uncertain||!data||dirty)return;const timer=setTimeout(()=>void exchange(),waiting?2500:Math.max(1000,Date.parse(data.refresh_after)-Date.now()-3000));
    return()=>clearTimeout(timer);/* GET only; no automatic POST retry. */ // eslint-disable-next-line react-hooks/exhaustive-deps
  },[verified,busy,uncertain,data,waiting,dirty]);
  const e=data?.epoch,fresh=!!data&&now<Date.parse(data.refresh_after)&&!!e&&now<Date.parse(e.valid_until);
  const eligible=verified&&!disabled&&!busy&&!uncertain&&!data?.read_only&&fresh;
  const enableBlocked=waiting||data?.request?.status==="unknown";
  function submit(enabled:boolean,event?:FormEvent){
    event?.preventDefault();if(!live.current||invalid.current||!eligible||active.current||pending.current||current.current.key!==key||current.current.data!==data||current.current.answers!==answers||current.current.disabled||!current.current.verified||!data)return;
    try{const attempt=buildEpochControlAttempt(data,scope,enabled,answers,crypto.randomUUID(),Date.now());pending.current=attempt;setUncertain(true);callbacks.current.onGuardChange(true);void exchange(attempt);}
    catch(cause){setError(epochControlErrorText(cause));}
  }
  if(!verified)return null;
  return <section aria-labelledby="epoch-control-title" className="min-w-0 space-y-3 rounded-xl border p-4">
    <h3 id="epoch-control-title" className="font-semibold">本研究阶段的持续观察</h3>
    <p className="text-sm">重新启用须由后台核验当前资料；暂停只停本阶段，不重写历史或更改模型总开关，不采集新来源、不自动交易。</p>
    <Button type="button" variant="outline" disabled={busy} onClick={()=>void exchange()}>核对观察开关</Button>
    {busy&&<p role="status" className="text-sm">正在核对受理记录…</p>}{error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
    {uncertain&&<div role="status" className="space-y-2 text-sm"><p>原提交结果尚未核实。先核对原请求；不会另建一份或自动重试。</p>
      <Button type="button" variant="outline" disabled={busy||disabled||!!data?.read_only} onClick={()=>{if(pending.current)void exchange(pending.current);}}>明确重试原请求</Button></div>}
    {data&&!e&&<p role="status" className="text-sm">尚无已登记的当前研究阶段。需先核对更正与当前资料，不能用旧阶段或维护授权代替启用。</p>}
    {e&&<div className="space-y-2 text-sm"><p>登记时间：{e.registered_at}</p><details><summary className="cursor-pointer text-xs text-muted-foreground">查看研究阶段编号</summary><p className="mt-2 break-all text-xs">{e.id}</p></details>
      <p role="status">{e.enabled?"本阶段开关已启用；是否有当前结论仍取决于完整资料核验。":"本阶段尚未启用或已暂停；不将历史状态当作当前结论。"}</p>
      {!fresh&&<p role="status">本次核验或研究阶段已到期，不能据旧界面启用；后台仍须通过期限检查。</p>}
      {!e.global_control_matches&&<p role="status">模型总开关或其版本已变化，需要重新建立研究阶段；这里不会自动改回总开关。</p>}
      {data?.request&&<p role="status">{states[data.request.status]}。{data.request.status==="rejected"&&epochControlErrorText(new Error(data.request.code??""))}</p>}
      {(e.enabled||enableBlocked)&&<Button type="button" variant="outline" disabled={!eligible} onClick={()=>submit(false)}>{waiting?"取消待启用并暂停本阶段":"暂停本研究阶段"}</Button>}
      {!e.enabled&&e.global_control_matches&&<form onSubmit={event=>submit(true,event)} className="space-y-3"><fieldset disabled={!eligible||enableBlocked} className="space-y-3">
        <legend className="mb-2 text-sm font-medium">单独确认本阶段的研究观察</legend>
        {epochControlAcknowledgements.map(ack=><label key={ack} className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 shrink-0" checked={answers[ack]===true}
          onChange={event=>{if(!live.current||invalid.current||!eligible||enableBlocked||current.current.disabled||!current.current.verified||current.current.key!==key||current.current.data!==data||current.current.answers!==answers)return;
            callbacks.current.onGuardChange(true);setAnswers(value=>({...value,[ack]:event.target.checked}));}}/><span>{epochControlLabels[ack]}</span></label>)}
        <Button disabled={!eligible||enableBlocked||!epochControlAcknowledgements.every(key=>answers[key]===true)}>重新核验并启用研究观察</Button>
      </fieldset></form>}
    </div>}
    {data?.read_only&&<p role="status" className="text-sm">系统只读，只能核对已有记录。</p>}
  </section>;
}
