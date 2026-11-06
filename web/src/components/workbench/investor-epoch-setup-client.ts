import {epochPreviewSubmitSchema,epochPreviewResponseSchema,type EpochPreviewResponse} from "@/server/investor/epoch-preview-schemas";
import {epochRegistrationAcknowledgements,epochRegistrationSubmitSchema,epochRegistrationResponseSchema,type EpochRegistrationResponse} from "@/server/investor/epoch-registration-schemas";
export type EpochSetupScope={workspace:string;model:string;binding:string};
export type EpochSetupKind="preview"|"registration";
export type EpochSetupAttempt={kind:EpochSetupKind;nonce:string;body:string;intent:Record<string,unknown>};
export const epochRegistrationLabels:Record<typeof epochRegistrationAcknowledgements[number],string>={
  separate_current_epoch:"本次单独登记更正后的研究阶段，不沿用旧阶段的授权。",
  displayed_source_and_correction_bindings:"已查看本次更正数量、资料区间和所对应的原历史。",
  reported_coverage_not_objective_absence:"接受已审阅来源的报告覆盖假设，不将其当作客观没有其他事件的保证。",
  economic_carry_not_point_in_time:"这是事后确认的经济结转，不美化为当时已知信息的回测。",
  preserve_original_model_and_history:"保留原模型、原起点和所有旧观察，不覆盖原历史。",
  no_strategy_cash_or_trading_change:"不改变策略、现金或交易权限；登记后仍须单独启用观察，交易由我决定。",
};
function check(v:unknown,code="EPOCH_SETUP_RESPONSE_INVALID"):asserts v{if(!v)throw new Error(code);}
function fresh(v:EpochPreviewResponse|EpochRegistrationResponse,s:EpochSetupScope,now:number){
  check(v.workspace_id===s.workspace&&v.model_id===s.model&&v.session_binding===s.binding&&!v.read_only,"EPOCH_SETUP_SCOPE_REQUIRED");
  check(now<Date.parse(v.refresh_after)&&Date.parse(v.checked_at)<=now+30000,"EPOCH_SETUP_EXPIRED");
}
const held=(v:EpochPreviewResponse|EpochRegistrationResponse)=>["queued","running","unknown"].includes(v.request?.status??"");
export function buildEpochSetupAttempt(kind:EpochSetupKind,p:EpochPreviewResponse,r:EpochRegistrationResponse,s:EpochSetupScope,
  answers:Record<string,boolean>,nonce:string,now=Date.now()):EpochSetupAttempt{
  fresh(p,s,now);fresh(r,s,now);check(!held(p)&&!held(r)&&!r.receipt,"EPOCH_SETUP_BUSY");
  check(p.workspace_revision===r.workspace_revision,"EPOCH_SETUP_CHANGED");
  const intent=kind==="preview"?epochPreviewSubmitSchema.parse({schema_version:"investor-epoch-preview-submit-v1",model_id:s.model,
    expected_model_hash:p.model_hash,expected_revision:p.workspace_revision,idempotency_key:nonce,acknowledged_preview_only:answers.preview===true})
    :(()=>{check(p.request?.status==="preview_ready"&&p.preview&&p.preview.workspace_revision===p.workspace_revision,"EPOCH_SETUP_CHANGED");
      check(now<Date.parse(p.preview.valid_until),"EPOCH_SETUP_EXPIRED");
      check(epochRegistrationAcknowledgements.every(k=>answers[k]===true),"EPOCH_SETUP_ACK_REQUIRED");
      return epochRegistrationSubmitSchema.parse({schema_version:"investor-model-epoch-submit-v1",preview_id:p.preview.id,expected_preview_hash:p.preview.content_hash,
        expected_revision:p.workspace_revision,idempotency_key:nonce,acknowledgements:Object.fromEntries(epochRegistrationAcknowledgements.map(k=>[k,true]))});})();
  return {kind,nonce,body:JSON.stringify(intent),intent};
}
const canonical=(v:unknown):string=>Array.isArray(v)?"["+v.map(canonical).join(",")+"]":v!==null&&typeof v==="object"
  ?"{"+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+":"+canonical(x)).join(",")+"}":JSON.stringify(v);
async function digest(v:unknown){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical(v))))].map(x=>x.toString(16).padStart(2,"0")).join("");}
export async function parseEpochSetupResponse(kind:EpochSetupKind,raw:unknown,s:EpochSetupScope,attempt?:EpochSetupAttempt,now=Date.now()){
  const value=kind==="preview"?epochPreviewResponseSchema.parse(raw):epochRegistrationResponseSchema.parse(raw);
  check(value.workspace_id===s.workspace&&value.model_id===s.model&&value.session_binding===s.binding
    &&Date.parse(value.checked_at)<=now+30000&&Date.parse(value.refresh_after)>now
    &&Date.parse(value.refresh_after)>Date.parse(value.checked_at)&&Date.parse(value.refresh_after)-Date.parse(value.checked_at)<=30000);
  if(attempt)check(attempt.kind===kind&&value.lookup_nonce===attempt.nonce&&value.request&&value.request.intent_hash===await digest(attempt.intent)
    &&(kind!=="registration"||"preview_id"in value.request&&value.request.preview_id===attempt.intent.preview_id));
  if(kind==="registration"){const r=value as EpochRegistrationResponse;check((r.request?.status==="registered")===(r.receipt!==null));}
  if(kind==="preview"){const p=value as EpochPreviewResponse;if(p.request?.status==="preview_ready")check(p.preview);}
  return value;
}
export function epochSetupErrorText(error:unknown){const code=error instanceof Error?error.message:"";
  if(code==="WORKBENCH_READ_ONLY")return "系统处于恢复只读状态，只能核对已有记录。";
  if(code.includes("EXPIRED"))return "本次资料或核验已到期，请先核对原请求，再重新准备。";
  if(code.includes("ACK_REQUIRED"))return "请逐项确认本次研究登记边界。";
  if(code.includes("CHANGED")||code.includes("VERSION"))return "工作区或资料已经变化，请重新核对，旧勾选不会继续使用。";
  if(code.includes("BUSY"))return "已有待处理或结果未知的原请求，请先核对，不会另建一份。";
  return "结果尚未核实。请核对原请求；不会自动重发、登记或启用观察。";
}
