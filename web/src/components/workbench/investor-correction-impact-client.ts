import Decimal from "decimal.js";
import type { ActionReviewView } from "@/server/investor/action-review-schemas";
import { correctionAcknowledgements, correctionImpactInputSchema, correctionImpactResponseSchema, correctionRatioDirection,
  type CorrectionImpactInput, type CorrectionImpactResponse } from "@/server/investor/correction-impact-schemas";

export type CorrectionDraft = {date:string;choice:""|"retain"|"replace"|"cancel";reason:string;dividend_at:string;pay_at:string;tax:string;split_at:string;ratio_ack:boolean};
export type CorrectionAttempt = {intent:CorrectionImpactInput;body:string;nonce:string};
const Exact=Decimal.clone({precision:128});
function check(value:unknown,code="CORRECTION_IMPACT_RESPONSE_INVALID"):asserts value {if(!value)throw new Error(code);}
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(",")}]`:value!==null&&typeof value==="object"
  ?`{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`:JSON.stringify(value);
async function digest(value:unknown){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical(value))))].map(x=>x.toString(16).padStart(2,"0")).join("");}
export function blankCorrectionDrafts(view:ActionReviewView):CorrectionDraft[]{return view.changes.filter(row=>row.disposition==="historical_correction")
  .map(row=>({date:row.date,choice:"",reason:"",dividend_at:"",pay_at:"",tax:"",split_at:"",ratio_ack:false}));}
const ny=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"});
const day=(at:string)=>{const parts=ny.formatToParts(new Date(at));return ["year","month","day"].map(key=>parts.find(row=>row.type===key)!.value).join("-");};
function utc(value:string){check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value),"CORRECTION_IMPACT_TIME_REQUIRED");return value+(value.length===16?":00Z":"Z");}
export function buildCorrectionAttempt(view:ActionReviewView,modelId:string,drafts:CorrectionDraft[],ack:boolean,nonce:string,now=Date.now()):CorrectionAttempt {
  check(view.status==="historical_correction_required"&&ack,"CORRECTION_IMPACT_ACK_REQUIRED");
  check(now<Date.parse(view.preview.valid_until),"CORRECTION_IMPACT_EXPIRED");
  const changes=view.changes.filter(row=>row.disposition==="historical_correction");
  check(drafts.length===changes.length&&new Set(drafts.map(row=>row.date)).size===drafts.length&&changes.every(row=>drafts.some(other=>other.date===row.date)),"CORRECTION_IMPACT_ANSWERS_REQUIRED");
  const decisions=drafts.map(row=>{
    const source=changes.find(change=>change.date===row.date)!;check(row.choice&&row.reason.trim()&&!source.outside_common_coverage,"CORRECTION_IMPACT_ANSWERS_REQUIRED");
    const events:CorrectionImpactInput["decisions"][number]["events"]=[];
    if(row.choice==="cancel")check(!source.current.issuer.length&&!source.current.dividends.length&&!source.current.splits.length,"CORRECTION_IMPACT_ANSWERS_REQUIRED");
    if(row.choice==="replace"){
      if(source.current.issuer.length){const at=utc(row.dividend_at),pay=utc(row.pay_at);check(day(at)===row.date&&day(pay)===source.current.issuer[0].pay_date&&Date.parse(pay)>=Date.parse(at),"CORRECTION_IMPACT_TIME_REQUIRED");
        check(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(row.tax),"CORRECTION_IMPACT_TAX_REQUIRED");
        const gross=source.current.issuer.reduce((sum,item)=>sum.plus(item.distribution_amount),new Exact(0));check(new Exact(row.tax).lte(gross),"CORRECTION_IMPACT_TAX_REQUIRED");
        events.push({type:"dividend",at,pay_at:pay,tax_per_unit:row.tax});}
      if(source.current.splits.length){const at=utc(row.split_at);check(day(at)===row.date&&row.ratio_ack,"CORRECTION_IMPACT_RATIO_REQUIRED");events.push({type:"split",at,ratio_direction:correctionRatioDirection});}
      check(events.length>0,"CORRECTION_IMPACT_ANSWERS_REQUIRED");
    }
    return {date:row.date,choice:row.choice,reason:row.reason.trim(),events};
  });
  const intent=correctionImpactInputSchema.parse({schema_version:"investor-action-correction-impact-request-v1",model_id:modelId,preview_id:view.preview.preview_id,
    expected_revision:view.preview.workspace_revision,idempotency_key:nonce,acknowledgements:Object.fromEntries(correctionAcknowledgements.map(key=>[key,true])),decisions});
  return {intent,body:JSON.stringify(intent),nonce};
}
export async function parseCorrectionResponse(raw:unknown,scope:{workspace:string;binding:string;model:string;preview:string},attempt?:CorrectionAttempt,now=Date.now()):Promise<CorrectionImpactResponse>{
  const value=correctionImpactResponseSchema.parse(raw);check(value.workspace_id===scope.workspace&&value.session_binding===scope.binding);
  check(Date.parse(value.checked_at)<=now+30000&&Date.parse(value.refresh_after)>now,"CORRECTION_IMPACT_RESPONSE_STALE");
  if(attempt)check(value.lookup_nonce===attempt.nonce);
  if(value.request){check(value.request.model_id===scope.model&&value.request.preview_id===scope.preview);
    if(attempt)check(value.lookup_nonce===attempt.nonce&&value.request.intent_hash===await digest(attempt.intent));}
  if(value.summary){check(value.request?.status==="preview_ready"&&value.summary_hash===await digest(value.summary)&&Date.parse(value.summary.valid_until)>now
    &&Date.parse(value.summary.checked_at)<=Date.parse(value.checked_at));}
  else check(value.summary_hash===null);
  return value;
}
export function correctionErrorText(error:unknown){const code=error instanceof Error?error.message:"";const messages:Record<string,string>={
  CORRECTION_IMPACT_ACK_REQUIRED:"请逐项核对并明确接受这只是影响假设，不是更正批准。",CORRECTION_IMPACT_ANSWERS_REQUIRED:"请为每个历史日期选择处理假设并填写理由；缺失资料不能直接取消。",
  CORRECTION_IMPACT_TIME_REQUIRED:"请明确填写 UTC 时刻，纽约有效日及支付日须与来源一致。",CORRECTION_IMPACT_TAX_REQUIRED:"请明确填写零至发行人毛额之间的每份税额；未知时不要填零。",
  CORRECTION_IMPACT_RATIO_REQUIRED:"请明确填写拆分时刻并核对新旧份额方向假设。",CORRECTION_IMPACT_EXPIRED:"原预览期限已到，请重新准备资料预览。",
  CORRECTION_IMPACT_VERSION_CHANGED:"工作区或来源已有更新，请重新核对资料后准备新比较。",CORRECTION_IMPACT_BUSY:"已有比较任务，先核对原请求状态。",
  WORKBENCH_READ_ONLY:"系统当前只读，不能提交新的比较。"};return messages[code]??"未能核实本次比较。连接失败不代表未受理，请先核对受理状态；不会自动重发。";}
