import {historyWorkflowSubmitSchema,historyWorkflowResponseSchema,historyAcknowledgements,type HistoryWorkflowResponse} from "@/server/investor/epoch-history-schemas";
export type HistoryScope={workspace:string;model:string;binding:string};
export type HistoryAttempt={nonce:string;body:string;intent:Record<string,unknown>};
export const historyLabels:Record<typeof historyAcknowledgements[number],string>={historical_not_live:"这是事后下载的历史资料，不将漏过的日期记作当时在线取得。",
 old_attempts_unchanged:"保留原采集记录及未知结果，不把本次下载当作重试旧回调。",bounded_download_only:"只下载本页选定上限内的缺失块；遇到未知结果停止，不自动再发。",no_trading:"本次只补研究资料，不改变策略、资金、监测开关或交易权限。"};
function check(v:unknown,code="HISTORY_RESPONSE_INVALID"):asserts v{if(!v)throw new Error(code);}
const canonical=(v:unknown):string=>Array.isArray(v)?"["+v.map(canonical).join(",")+"]":v!==null&&typeof v==="object"?"{"+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+":"+canonical(x)).join(",")+"}":JSON.stringify(v);
async function hash(v:unknown){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical(v))))].map(x=>x.toString(16).padStart(2,"0")).join("");}
export function buildHistoryAttempt(action:"prepare"|"confirm",value:HistoryWorkflowResponse,scope:HistoryScope,answers:Record<string,boolean>,maxCalls:number,nonce:string,now=Date.now()):HistoryAttempt{
 check(value.workspace_id===scope.workspace&&value.model_id===scope.model&&value.session_binding===scope.binding&&!value.read_only,"HISTORY_SCOPE_REQUIRED");
 check(Date.parse(value.checked_at)<=now+30000&&now<Date.parse(value.refresh_after),"HISTORY_EXPIRED");
 check(value.epoch?.enabled&&now<Date.parse(value.epoch.valid_until),"HISTORY_ACTIVATION_REQUIRED");
 check(!["queued","running"].includes(value.request?.status??"")&&!value.download?.slots.some(s=>["queued","running"].includes(s.status)),"HISTORY_BUSY");
 const shared={schema_version:"investor-epoch-history-workflow-submit-v1",action,model_id:scope.model,expected_revision:value.workspace_revision,idempotency_key:nonce};
 const intent=historyWorkflowSubmitSchema.parse(action==="prepare"?{...shared,acknowledged_plan_only:answers.prepare===true}:(()=>{
  check(value.request?.status==="plan_ready"&&value.preview&&value.preview.plan_status==="download_confirmation_required"&&value.preview.workspace_revision===value.workspace_revision,"HISTORY_CHANGED");
  check(now<Date.parse(value.preview.valid_until),"HISTORY_EXPIRED");check(!value.download?.slots.some(s=>s.status==="unknown"),"HISTORY_REVIEW_REQUIRED");
  check(historyAcknowledgements.every(k=>answers[k]===true),"HISTORY_ACK_REQUIRED");
  return {...shared,preview_id:value.preview.id,expected_preview_hash:value.preview.content_hash,max_calls:maxCalls,acknowledgements:Object.fromEntries(historyAcknowledgements.map(k=>[k,true]))};})());
 return {nonce,body:JSON.stringify(intent),intent};
}
export async function parseHistoryResponse(raw:unknown,scope:HistoryScope,attempt?:HistoryAttempt,now=Date.now()){
 const value=historyWorkflowResponseSchema.parse(raw);
 check(value.workspace_id===scope.workspace&&value.model_id===scope.model&&value.session_binding===scope.binding&&Date.parse(value.checked_at)<=now+30000
  &&Date.parse(value.refresh_after)>now&&Date.parse(value.refresh_after)>Date.parse(value.checked_at)&&Date.parse(value.refresh_after)-Date.parse(value.checked_at)<=30000);
 if(attempt)check(value.lookup_nonce===attempt.nonce&&value.request&&value.request.action===attempt.intent.action&&value.request.intent_hash===await hash(attempt.intent));
 if(value.request?.status==="plan_ready")check(value.preview&&value.preview.workspace_revision===value.workspace_revision);
 if(value.request?.status==="download_queued")check(value.download);
 if(value.preview)check(value.preview.retained_date_count+value.preview.missing_date_count===value.preview.expected_date_count
  &&value.preview.tiles.length===Math.min(4,value.preview.total_tiles)&&value.preview.tiles.every(t=>t.start_date<=t.end_date));
 return value;
}
export function historyError(error:unknown){const code=error instanceof Error?error.message:"";
 if(code==="WORKBENCH_READ_ONLY")return "系统只读，只能核对已有记录。";
 if(code.includes("ACK_REQUIRED"))return "请逐项确认本次历史下载边界。";
 if(code.includes("ACTIVATION"))return "请先单独启用研究阶段，再准备历史缺口。";
 if(code.includes("REVIEW_REQUIRED"))return "存在结果未知的历史请求，需要先明确复核；不会自动再发。";
 if(code.includes("EXPIRED"))return "本次准备已到期，请核对原记录后重新准备。";
 if(code.includes("CHANGED")||code.includes("VERSION"))return "资料或工作区已变化，请重新核对；原勾选不继续使用。";
 if(code.includes("BUSY"))return "已有待处理工作，请先核对原任务。";
 return "原提交尚未核实。请核对原请求，不会自动重发或另建下载。";
}
