import Decimal from "decimal.js";
import { parseStrictJson } from "@/server/strict-json";
import { actionReviewAcknowledgements, actionReviewInputSchema, actionReviewResponseSchema, actionReviewSubmitSchema,
  type ActionReviewResponse, type ActionReviewView } from "@/server/investor/action-review-schemas";

export type ActionReviewDraft = { type:"dividend"|"split";date:string;at:string;pay_at:string;tax_per_unit:string };
export type ActionReviewAttempt = { body:string;nonce:string;binding:string;workspace:string;intent:unknown };
const Exact=Decimal.clone({precision:128});
function requireValue(value:unknown,code="ACTION_REVIEW_RESPONSE_INVALID"):asserts value {if(!value)throw new Error(code);}
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(value!==null&&typeof value==="object")return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function digest(value:unknown) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical(value))))].map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
const ny=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"});
function nyDay(at:string) {const parts=ny.formatToParts(new Date(at));return ["year","month","day"].map(key=>parts.find(row=>row.type===key)!.value).join("-");}
function utcInput(value:string) {
  requireValue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value),"ACTION_REVIEW_TIME_REQUIRED");
  return value+(value.length===16?":00Z":"Z");
}
export function blankActionReviewDrafts(view:ActionReviewView):ActionReviewDraft[] {
  const entries:ActionReviewDraft[]=[];
  for(const row of view.changes)if(row.disposition==="new_report") {
    if(row.current.issuer.length)entries.push({type:"dividend",date:row.date,at:"",pay_at:"",tax_per_unit:""});
    if(row.current.splits.length)entries.push({type:"split",date:row.date,at:"",pay_at:"",tax_per_unit:""});
  }
  return entries;
}
export function buildActionReviewConfirmation(view:ActionReviewView,drafts:ActionReviewDraft[],acknowledged:boolean,enable:boolean,nonce:string,now=Date.now()) {
  requireValue(view.confirmation_supported && acknowledged,"ACTION_REVIEW_ACK_REQUIRED");
  requireValue(now<Date.parse(view.refresh_after)&&now<Date.parse(view.preview.valid_until),"ACTION_REVIEW_VIEW_STALE");
  const expected=blankActionReviewDrafts(view),key=(row:ActionReviewDraft)=>row.type+":"+row.date;
  requireValue(drafts.length===expected.length&&new Set(drafts.map(key)).size===drafts.length&&expected.every(row=>drafts.some(other=>key(other)===key(row))),"ACTION_REVIEW_EVENTS_CHANGED");
  const events=drafts.map(row=>{
    const at=utcInput(row.at);requireValue(nyDay(at)===row.date,"ACTION_REVIEW_TIME_REQUIRED");
    if(row.type==="split")return {type:"split" as const,date:row.date,at};
    const source=view.changes.find(change=>change.date===row.date)!.current.issuer,pay=utcInput(row.pay_at);
    const gross=source.reduce((sum,item)=>sum.plus(item.distribution_amount),new Exact(0));
    requireValue(nyDay(pay)===source[0].pay_date&&Date.parse(pay)>=Date.parse(at),"ACTION_REVIEW_TIME_REQUIRED");
    requireValue(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(row.tax_per_unit)&&new Exact(row.tax_per_unit).lte(gross),"ACTION_REVIEW_TAX_REQUIRED");
    return {type:"dividend" as const,date:row.date,at,pay_at:pay,tax_per_unit:row.tax_per_unit};
  });
  const body=actionReviewSubmitSchema.parse({schema_version:"investor-action-review-submit-v1",preview_id:view.preview.preview_id,
    expected_revision:view.preview.workspace_revision,idempotency_key:nonce,new_events:events,
    acknowledgements:Object.fromEntries(actionReviewAcknowledgements.map(key=>[key,true])),enable_rule:enable});
  return {kind:"confirmation" as const,body};
}
export function actionReviewAttempt(intent:unknown,binding:string,workspace:string):ActionReviewAttempt {
  const value=actionReviewInputSchema.parse(intent);
  return {body:JSON.stringify(value),nonce:value.kind==="preview"?value.idempotency_key:value.body.idempotency_key,binding,workspace,intent:value};
}
export async function parseActionReviewResponse(raw:unknown,binding:string,workspace:string,now=Date.now(),attempt?:ActionReviewAttempt):Promise<ActionReviewResponse> {
  const value=actionReviewResponseSchema.parse(raw);
  requireValue(value.session_binding===binding&&value.workspace_id===workspace);
  requireValue(Date.parse(value.checked_at)<=now+30000&&Date.parse(value.refresh_after)>now&&Date.parse(value.refresh_after)>Date.parse(value.checked_at),"ACTION_REVIEW_RESPONSE_STALE");
  requireValue(new Set(value.symbols).size===value.symbols.length);
  if(attempt) {
    requireValue(attempt.binding===binding&&attempt.workspace===workspace&&value.lookup_nonce===attempt.nonce);
    if(value.request)requireValue(value.request.intent_hash===await digest(attempt.intent));
  }
  if(value.view) {
    const view=value.view,request=value.request;
    requireValue(request?.status==="preview_ready"&&request.kind==="preview"&&request.resource_id===view.preview.preview_id
      &&request.symbol===view.provider_symbol&&view.preview.workspace_id===workspace&&view.preview.workspace_revision===value.workspace_revision
      &&view.preview.workspace_revision>0&&value.preview_error===null&&value.symbols.includes(view.provider_symbol));
    requireValue(request.resource_hash===await digest(view.preview)&&request.resource_valid_until===view.preview.valid_until);
    requireValue(Date.parse(view.refresh_after)>now&&Date.parse(view.preview.valid_until)>now&&Date.parse(view.checked_at)<=Date.parse(value.checked_at)
      &&Date.parse(view.refresh_after)<=Date.parse(view.preview.valid_until));
    if(view.confirmation_supported)requireValue(view.status==="new_reported_actions"&&view.changes.length>0
      &&view.changes.every(row=>row.disposition==="new_report"&&!row.outside_common_coverage));
  }
  return value;
}
export async function readActionReviewJson(response:Response) {
  requireValue(response.body);const reader=response.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});let size=0,raw="";
  try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>4194304){void reader.cancel().catch(()=>{});throw new Error("ACTION_REVIEW_RESPONSE_INVALID");}raw+=decoder.decode(value,{stream:true});}
    raw+=decoder.decode();return parseStrictJson(raw);
  }finally{reader.releaseLock();}
}
export function actionReviewErrorText(error:unknown) {
  const code=error&&typeof error==="object"&&"message" in error?String(error.message):"";
  const messages:Record<string,string>={ACTION_REVIEW_ACK_REQUIRED:"请核对全部说明并明确确认；自动维护需要另行选择。",
    ACTION_REVIEW_TIME_REQUIRED:"请填写有效和支付研究时刻（UTC），并确保换算后的纽约日期与来源日期一致。",
    ACTION_REVIEW_TAX_REQUIRED:"请明确填写每份研究税额，范围为零至发行人毛额；不会自动填零。",
    ACTION_REVIEW_VIEW_STALE:"预览已到复核时间，请先重新读取状态；不会延长原确认期限。",
    ACTION_REVIEW_JOB_VERSION_CHANGED:"工作区版本已变化，请重新准备预览并核对，原同意不会沿用。",
    ACTION_REVIEW_JOB_BUSY:"已有任务正在处理，请先核对受理状态。",
    ACTION_REVIEW_JOB_RULE_UNAVAILABLE:"暂时无法定位唯一维护规则，不会采用最新记录覆盖其他来源。",
    ACTION_REVIEW_JOB_PREVIEW_EXPIRED:"原确认期限已到，请重新准备并明确确认。",WORKBENCH_READ_ONLY:"系统当前只读，不能提交审阅。"};
  return messages[code]??"未能核对最新状态。不使用旧预览，也不把连接失败当作未受理；请先核对受理状态。";
}
