import { epochControlAcknowledgements, epochControlResponseSchema, epochControlSubmitSchema,
  type EpochControlResponse, type EpochControlSubmit } from "@/server/investor/epoch-control-schemas";

export type EpochControlScope={workspace:string;model:string;binding:string};
export type EpochControlAttempt={intent:EpochControlSubmit;body:string;nonce:string};
export const epochControlLabels:Record<typeof epochControlAcknowledgements[number],string>={
  current_epoch_seen:"我已查看当前研究阶段和登记时间，不沿用旧阶段的启用。",
  continuous_research_only:"允许后台用已授权来源持续核验本研究阶段；缺数据时停止给出结论。",
  preserve_history_and_human_trading:"保留原起点和历史；不改变策略、资金或交易权限，每次交易仍由我决定。",
};
function check(value:unknown,code="EPOCH_CONTROL_RESPONSE_INVALID"):asserts value{if(!value)throw new Error(code);}
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(",")}]`:value!==null&&typeof value==="object"
  ?`{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`:JSON.stringify(value);
async function digest(value:unknown){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical(value))))].map(x=>x.toString(16).padStart(2,"0")).join("");}
export function buildEpochControlAttempt(value:EpochControlResponse,scope:EpochControlScope,enabled:boolean,
  answers:Partial<Record<typeof epochControlAcknowledgements[number],boolean>>,nonce:string,now=Date.now()):EpochControlAttempt{
  const e=value.epoch;
  check(value.workspace_id===scope.workspace&&value.model_id===scope.model&&value.session_binding===scope.binding&&!value.read_only&&e,"EPOCH_CONTROL_SCOPE_REQUIRED");
  check(now<Math.min(Date.parse(value.refresh_after),Date.parse(e.valid_until)),"EPOCH_CONTROL_EXPIRED");
  if(enabled){
    check(e.global_control_matches&&!e.enabled&&!["queued","running","unknown"].includes(value.request?.status??""),"EPOCH_CONTROL_CHANGED");
    check(epochControlAcknowledgements.every(key=>answers[key]===true),"EPOCH_CONTROL_ACK_REQUIRED");
  }
  const intent=epochControlSubmitSchema.parse({schema_version:"investor-epoch-control-submit-v1",epoch_id:e.id,expected_registration_hash:e.registration_hash,
    expected_checkpoint:e.checkpoint,expected_revision:value.workspace_revision,idempotency_key:nonce,enabled,
    acknowledgements:enabled?answers:Object.fromEntries(epochControlAcknowledgements.map(key=>[key,true]))});
  return {intent,body:JSON.stringify(intent),nonce};
}
export async function parseEpochControlResponse(raw:unknown,scope:EpochControlScope,attempt?:EpochControlAttempt,now=Date.now()):Promise<EpochControlResponse>{
  const value=epochControlResponseSchema.parse(raw);
  check(value.workspace_id===scope.workspace&&value.model_id===scope.model&&value.session_binding===scope.binding
    &&Date.parse(value.checked_at)<=now+30000&&Date.parse(value.refresh_after)>now
    &&Date.parse(value.refresh_after)>Date.parse(value.checked_at)&&Date.parse(value.refresh_after)-Date.parse(value.checked_at)<=30000);
  if(value.epoch)check((value.epoch.control_id===null)===(value.epoch.control_version===0)&&(!value.epoch.enabled||value.epoch.control_id!==null));
  if(value.request)check((value.request.status==="applied")===(value.receipt?.enabled===true)&&(!value.receipt||value.receipt.epoch_id===value.request.epoch_id));
  if(attempt){
    check(value.lookup_nonce===attempt.nonce);
    const intentHash=await digest(attempt.intent);
    if(attempt.intent.enabled&&value.request)check(value.request.intent_hash===intentHash&&value.request.epoch_id===attempt.intent.epoch_id);
    else check(value.receipt&&value.receipt.intent_hash===intentHash&&value.receipt.enabled===attempt.intent.enabled&&value.receipt.epoch_id===attempt.intent.epoch_id);
  }
  return value;
}
export function epochControlErrorText(error:unknown){
  const code=error instanceof Error?error.message:"";
  const messages:Record<string,string>={
    EPOCH_CONTROL_ACK_REQUIRED:"请逐项确认本次研究观察边界。",
    EPOCH_CONTROL_EXPIRED:"资料或核验期限已到，先核对原请求，再重新准备。",
    EPOCH_CONTROL_CHANGED:"研究阶段、来源或开关已改变，不能沿用本次启用。",
    EPOCH_CONTROL_VERSION_CHANGED:"工作区已变化，请重新核对，不会自动套用旧确认。",
    EPOCH_CONTROL_BUSY:"已有待核验的启用请求；可以暂停，但不会重复启用。",
    EPOCH_CONTROL_SOURCE_UNAVAILABLE:"当前来源或连续状态核验未通过，未启用研究观察。",
    WORKBENCH_READ_ONLY:"当前为恢复只读模式，只能核对已有记录。",
  };
  return messages[code]??"结果尚未核实。请先核对原请求；不会自动重发、推断启用或执行交易。";
}
