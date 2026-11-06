import {randomUUID} from "node:crypto";
import type Database from "better-sqlite3";
import {assertWritableDatabase} from "../workbench-db";
import {canonical,hash} from "../ledger/service";
import {priceInstant as time} from "../market-price-source";
import {actionRead,actionJson,actionAudit,actionJobStartedByMillisecond} from "./action-source-proof";
import {readModelEpochRegistrationHeader} from "./model-epoch-registration";
import {readEpochControlHeader} from "./epoch-continuation";
import {correctionChangeFence} from "./correction-change-fence";
import {validateEpochHistoryJob as validateHistory,validateEpochHistoryWorkflow as validate} from "./kernel-contracts";
import {historyWorkflowSubmitSchema,historyWorkflowResponseSchema,historyWorkflowReviewResponseSchema} from "./epoch-history-schemas";
import {readHistoryUnknownReview,readHistoryResolutionHeader} from "./epoch-history-resolution";
type Obj=Record<string,unknown>;
const JOB="investor_epoch_history_workflow",HISTORY="investor_epoch_history";
function check(v:unknown,code="INVALID"):asserts v{if(!v)throw new Error("HISTORY_WORKFLOW_"+code);}
function obj(v:unknown):Obj{check(v&&typeof v==="object"&&!Array.isArray(v));return v as Obj;}
const ref=(r:Obj)=>({id:r.id,content_hash:r.content_hash});
function workspace(db:Database.Database,actor:{id:string}){const r=db.prepare("SELECT * FROM investor_workspaces WHERE owner_id=?").get(actor.id) as Obj|undefined;check(r&&Number.isSafeInteger(r.revision),"WORKSPACE_REQUIRED");return r;}
function fence(db:Database.Database,w:string,actor:{id:string}){
 const value:Obj={sources:correctionChangeFence(db,w,actor)};let count=0;
 for(const [key,table] of [["controls","investor_epoch_controls"],["requests","investor_epoch_continuation_requests"],["publications","investor_epoch_continuations"]]){
  const rows=db.prepare(`SELECT id,content_hash FROM ${table} WHERE workspace_id=? ORDER BY rowid LIMIT ?`).all(w,100001-count);count+=rows.length;check(count<=100000,"FENCE_LIMIT");value[key]=rows;
 }check(Buffer.byteLength(canonical(value))<=33554432,"FENCE_LIMIT");return hash(value);
}
function epoch(db:Database.Database,w:Obj,actor:{id:string},model:unknown,now:string){
 actionRead(db,"investor_models",model,w.id as string);
 const latest=db.prepare("SELECT id FROM investor_model_epochs WHERE workspace_id=? AND model_id=? ORDER BY rowid DESC LIMIT 1").get(w.id,model) as Obj|undefined;
 if(!latest)return null;
 const root=readModelEpochRegistrationHeader(db,w.id as string,actor,latest.id as string,now);
 const c=db.prepare("SELECT id FROM investor_epoch_controls WHERE workspace_id=? AND epoch_id=? ORDER BY version DESC LIMIT 1").get(w.id,latest.id) as Obj|undefined;
 const control=c?readEpochControlHeader(db,w.id as string,actor,c.id as string,now):null;
 const global=db.prepare("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1").get(w.id,model) as Obj|undefined;
 return {root,control,enabled:!!control&&control.row.enabled===1&&time(control.row.created_at as string)<=time(now)&&time(now)<time(control.row.valid_until as string)
  &&!!global&&global.enabled===1&&hash({id:global.id,content_hash:hash(global)})===hash(root.epoch.model_control)};
}
function intentHeader(db:Database.Database,w:Obj,actor:{id:string},id:unknown,now:string){
 const row=actionRead(db,"investor_epoch_history_intents",id,w.id as string),doc=actionJson(row.document_json,16384);validate("request",doc);const body=historyWorkflowSubmitSchema.parse(doc.body);
 check(canonical(doc)===row.document_json&&hash(doc)===row.content_hash&&row.actor_id===actor.id&&doc.request_id===row.id&&hash(body)===row.request_hash
  &&["workspace_id","model_id","epoch_id","actor_id","request_hash","created_at","valid_until"].every(k=>doc[k]===row[k])
  &&body.model_id===row.model_id&&body.action===row.action&&body.expected_revision===row.expected_revision&&body.idempotency_key===row.idempotency_key
  &&(body.action==="confirm"?body.preview_id:null)===row.preview_id&&time(row.created_at as string)<=time(now)
  &&time(row.valid_until as string)>time(row.created_at as string)&&time(row.valid_until as string)-time(row.created_at as string)<=300000000n,"HEADER_CHANGED");
 actionAudit(db,w.id as string,row,"investor_request_history_workflow","investor_history_workflow_request");
 const root=readModelEpochRegistrationHeader(db,w.id as string,actor,row.epoch_id as string,now);
 check(root.row.model_id===row.model_id&&root.row.content_hash===doc.registration_hash&&root.model.content_hash===doc.model_hash
  &&time(root.row.created_at as string)<=time(row.created_at as string)&&time(row.valid_until as string)<=time(root.row.valid_until as string),"HEADER_CHANGED");return {row,doc,body};
}
function completed(db:Database.Database,w:Obj,actor:{id:string},id:unknown,now:string){
 const row=actionRead(db,"investor_epoch_history_results",id,w.id as string),doc=actionJson(row.document_json,139264);validate("result",doc);
 const original=intentHeader(db,w,actor,row.request_id,now),r=original.row;
 const job=obj(db.prepare("SELECT * FROM job_runs WHERE id=?").get(row.job_id)),attempt=obj(db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1").get(row.job_id));
 const result=Object.fromEntries(["request_id","result_id","outcome","code","history_request","provider_calls","trading_permission"].map(k=>[k,doc[k]]));
 check(canonical(doc)===row.document_json&&hash(doc)===row.content_hash&&doc.result_id===row.id&&doc.request_hash===r.content_hash&&row.actor_id===actor.id
  &&["request_id","workspace_id","model_id","epoch_id","actor_id","job_id","fencing_token","outcome","code","created_at"].every(k=>doc[k]===row[k])
  &&job.job_type===JOB&&job.scope===w.id&&job.period===r.id&&job.input_version===r.content_hash&&job.status==="succeeded"&&job.command_request_id===null
  &&job.max_attempts===1&&job.attempt_count===1&&job.fencing_token===row.fencing_token&&job.lease_owner===null&&job.lease_until===null
  &&attempt.status==="succeeded"&&attempt.error_json===null&&attempt.fencing_token===job.fencing_token&&attempt.finished_at===job.updated_at
  &&time(r.created_at as string)<=time(attempt.started_at as string)&&actionJobStartedByMillisecond(attempt.started_at as string,row.created_at as string)
  &&time(row.created_at as string)<=time(attempt.finished_at as string)&&time(attempt.finished_at as string)<=time(now)
  &&hash(actionJson(job.result_json))===hash(result)&&time(doc.valid_until as string)<=time(r.valid_until as string),"RESULT_CHANGED");
 actionAudit(db,w.id as string,row,"investor_finish_history_workflow","investor_history_workflow_result");
 check(row.outcome!=="rejected"?doc.code==="HISTORY_WORKFLOW_"+String(row.outcome).toUpperCase():!["HISTORY_WORKFLOW_PLAN_READY","HISTORY_WORKFLOW_DOWNLOAD_QUEUED"].includes(doc.code as string),"RESULT_CHANGED");
 if(row.outcome!=="rejected")check(time(attempt.finished_at as string)<time(doc.valid_until as string),"RESULT_CHANGED");
 if(row.outcome==="plan_ready"){
  const p=obj(doc.plan),design={...p};delete design.checked_at;delete design.plan_hash;
  check(r.action==="prepare"&&doc.history_request===null&&hash(design)===p.plan_hash&&p.workspace_id===w.id&&p.actor_id===actor.id&&p.model_id===r.model_id
   &&obj(p.epoch).id===r.epoch_id&&p.registration_hash===original.doc.registration_hash&&p.model_hash===original.doc.model_hash&&p.workspace_revision===r.expected_revision
   &&p.planned_at===r.created_at&&p.valid_until===doc.valid_until&&p.source_fence===doc.source_fence
   &&time(p.planned_at as string)<=time(p.checked_at as string)&&time(p.checked_at as string)<=time(row.created_at as string),"PLAN_CHANGED");
 }else if(row.outcome==="download_queued")check(r.action==="confirm"&&doc.plan===null&&doc.history_request!==null,"RESULT_CHANGED");
 else check(doc.plan===null&&doc.history_request===null&&doc.source_fence===null,"RESULT_CHANGED");
 return {row,doc,original};
}
function batchHeader(db:Database.Database,w:Obj,actor:{id:string},id:unknown,now:string){
 const row=actionRead(db,"investor_epoch_history_requests",id,w.id as string),doc=actionJson(row.document_json,139264);validateHistory("request",doc);
 const p=obj(doc.plan),body=obj(doc.body),design={...p};delete design.checked_at;delete design.plan_hash;
 check(canonical(doc)===row.document_json&&hash(doc)===row.content_hash&&doc.request_id===row.id&&row.actor_id===actor.id&&hash(body)===row.request_hash
  &&["workspace_id","model_id","actor_id","request_hash","authorized_calls","created_at","valid_until"].every(k=>doc[k]===row[k])
  &&body.idempotency_key===row.idempotency_key&&body.expected_revision===row.expected_revision&&p.workspace_revision===row.expected_revision
  &&p.workspace_id===w.id&&p.actor_id===actor.id&&p.model_id===row.model_id&&obj(p.epoch).id===row.epoch_id&&body.epoch_id===row.epoch_id
  &&obj(p.activation).id===row.activation_id&&obj(p.model_control).id===row.control_id&&p.plan_hash===body.expected_plan_hash&&hash(design)===p.plan_hash
  &&p.planned_at===body.planned_at&&p.valid_until===row.valid_until&&p.status==="download_confirmation_required"
  &&row.authorized_calls===Math.min(Number(body.max_calls),(p.tiles as Obj[]).length)&&time(p.checked_at as string)<=time(row.created_at as string)
  &&time(row.created_at as string)<time(row.valid_until as string)&&time(row.created_at as string)<=time(now),"BATCH_CHANGED");
 actionAudit(db,w.id as string,row,"investor_confirm_epoch_history","investor_epoch_history_request");return {row,doc,plan:p,body};
}
const tileView=(t:Obj)=>({symbol:t.symbol,market:t.market,start_date:t.start_date,end_date:t.end_date,expected_date_count:(t.expected_dates as unknown[]).length});
function batchView(db:Database.Database,w:Obj,actor:{id:string},id:unknown,now:string,includeReview=false){
 const {row,plan}=batchHeader(db,w,actor,id,now),slots=db.prepare("SELECT * FROM investor_epoch_history_slots WHERE request_id=? ORDER BY slot_index").all(row.id) as Obj[];
 check(slots.length===row.authorized_calls,"BATCH_CHANGED");
 const values=slots.map((s,index)=>{
  const tile=(plan.tiles as Obj[])[index];check(s.slot_index===index&&s.workspace_id===w.id&&s.model_id===row.model_id&&s.actor_id===actor.id&&s.created_at===row.created_at
   &&["listing_id","start_date","end_date"].every(k=>s[k]===tile[k])&&hash({schema_version:"investor-epoch-history-slot-v1",slot_id:s.id,request:ref(row),index,tile})===s.content_hash,"SLOT_CHANGED");
  actionAudit(db,w.id as string,s,"investor_queue_epoch_history","investor_epoch_history_slot");
  const job=obj(db.prepare("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?").get(HISTORY,w.id,s.id,s.content_hash));
  check(job.command_request_id===null&&job.max_attempts===1&&[0,1].includes(job.attempt_count as number),"JOB_CHANGED");
  const marker=db.prepare("SELECT * FROM investor_epoch_history_attempts WHERE slot_id=?").get(s.id) as Obj|undefined;
  if(marker){const d=actionJson(marker.document_json,4096);validateHistory("attempt",d);actionAudit(db,w.id as string,marker,"investor_reserve_epoch_history","investor_epoch_history_attempt");
   check(hash(d)===marker.content_hash&&canonical(d)===marker.document_json&&d.attempt_id===marker.id&&marker.workspace_id===w.id&&marker.model_id===row.model_id&&marker.actor_id===actor.id
    &&d.job_id===job.id&&marker.job_id===job.id&&d.fencing_token===marker.fencing_token&&hash(d.slot)===hash(ref(s))&&hash(d.request)===hash(ref(row))&&d.created_at===marker.created_at&&d.valid_until===row.valid_until
    &&time(marker.created_at as string)<=time(now),"ATTEMPT_CHANGED");}
  const run=db.prepare("SELECT * FROM investor_epoch_history_runs WHERE slot_id=?").get(s.id) as Obj|undefined;
  let status="queued";
  if(run){const d=actionJson(run.document_json,8192);validateHistory("run",d);actionAudit(db,w.id as string,run,"investor_finish_epoch_history","investor_epoch_history_run");
   const expected=["collected","already_available"].includes(run.status as string)?"succeeded":run.status==="transport_unknown"?"failed":"skipped";
   const attempt=obj(db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1").get(job.id));
   check(hash(d)===run.content_hash&&canonical(d)===run.document_json&&d.run_id===run.id&&run.actor_id===actor.id&&run.workspace_id===w.id&&run.model_id===row.model_id
    &&["job_id","attempt_id","capture_id","status","created_at"].every(k=>d[k]===run[k])&&run.job_id===job.id&&hash(d.slot)===hash(ref(s))&&hash(d.request)===hash(ref(row))
    &&d.code==="EPOCH_HISTORY_"+String(run.status).toUpperCase()&&d.valid_until===row.valid_until&&d.attempt_id===(marker?.id??null)&&job.status===expected&&job.attempt_count===1
    &&d.fencing_token===job.fencing_token&&attempt.fencing_token===job.fencing_token&&attempt.status===expected&&attempt.finished_at===job.updated_at&&attempt.error_json===null
    &&actionJobStartedByMillisecond(attempt.started_at as string,run.created_at as string)&&time(run.created_at as string)<=time(attempt.finished_at as string)&&time(attempt.finished_at as string)<=time(now)
    &&hash(actionJson(job.result_json))===hash({run_id:run.id,code:d.code,trading_permission:false}),"RUN_CHANGED");
   if(marker)check(marker.fencing_token===job.fencing_token,"ATTEMPT_CHANGED");
   if(run.capture_id){const capture=actionRead(db,"investor_price_captures",run.capture_id,w.id as string);check(capture.receipt_hash===d.receipt_hash&&capture.qualification==="isolated_official_sdk"&&time(capture.created_at as string)<=time(run.created_at as string),"CAPTURE_CHANGED");}
   status=run.status==="transport_unknown"?"unknown":run.status as string;
  }else if(job.status==="running")status=time(now)<time(job.lease_until as string)?"running":"unknown";
  else if(job.status==="queued"&&job.attempt_count===0&&!marker)status="queued";
  else{check(["failed","skipped","cancelled"].includes(job.status as string),"JOB_CHANGED");status="unknown";}
  const review=includeReview&&status==="unknown"&&marker?readHistoryUnknownReview(db,actor,s.id,now):null;
  if(review?.resolution)status="acknowledged_unknown";
  return {...tileView(tile),index,reserved:!!marker,status,...(includeReview?{review}:{})};
 });return {id:row.id,content_hash:row.content_hash,created_at:row.created_at,valid_until:row.valid_until,slots:values,historical_metadata_only:true};
}
export function submitHistoryWorkflow(db:Database.Database,actor:{id:string},raw:unknown,now=new Date().toISOString()){
 const body=historyWorkflowSubmitSchema.parse(raw);validate("submit",body);time(now);assertWritableDatabase(db);
 return db.transaction(()=>{
  assertWritableDatabase(db);const w=workspace(db,actor),digest=hash(body),old=db.prepare("SELECT id,request_hash FROM investor_epoch_history_intents WHERE workspace_id=? AND idempotency_key=?").get(w.id,body.idempotency_key) as Obj|undefined;
  if(old){check(old.request_hash===digest,"DUPLICATE_CONFLICT");return intentHeader(db,w,actor,old.id,now).doc;}
  check(!db.prepare("SELECT 1 FROM investor_epoch_history_resolutions WHERE workspace_id=? AND idempotency_key=?").get(w.id,body.idempotency_key),"DUPLICATE_CONFLICT");
  check(w.revision===body.expected_revision,"VERSION_CHANGED");const e=epoch(db,w,actor,body.model_id,now);check(e?.enabled,"ACTIVATION_REQUIRED");
  let until=Math.min(Date.parse(e.root.row.valid_until as string),Date.parse(now)+300000);
  if(body.action==="confirm"){
   const p=completed(db,w,actor,body.preview_id,now),plan=obj(p.doc.plan);
   check(p.row.outcome==="plan_ready"&&p.row.content_hash===body.expected_preview_hash&&p.row.model_id===body.model_id&&p.row.epoch_id===e.root.row.id
    &&plan.workspace_revision===body.expected_revision&&plan.status==="download_confirmation_required","PREVIEW_CHANGED");
   check(time(now)<time(p.doc.valid_until as string),"EXPIRED");check(plan.source_fence===fence(db,w.id as string,actor),"SOURCE_CHANGED");
   check(!db.prepare("SELECT 1 FROM investor_epoch_history_intents WHERE workspace_id=? AND preview_id=?").get(w.id,body.preview_id),"PREVIEW_CHANGED");
   until=Math.min(until,Date.parse(p.doc.valid_until as string));
  }
  check(!db.prepare("SELECT 1 FROM investor_epoch_history_intents r LEFT JOIN investor_epoch_history_results u ON u.request_id=r.id LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash WHERE r.workspace_id=? AND r.expected_revision=? AND r.valid_until>? AND u.id IS NULL AND (j.id IS NULL OR j.status IN ('queued','running')) LIMIT 1")
   .get(JOB,w.id,w.revision,now),"BUSY");
  const id="history-workflow-request:"+randomUUID(),audit=randomUUID(),expires=new Date(until).toISOString();
  const doc={schema_version:"investor-epoch-history-workflow-request-v1",request_id:id,workspace_id:w.id,model_id:body.model_id,model_hash:e.root.model.content_hash,
   epoch_id:e.root.row.id,registration_hash:e.root.row.content_hash,actor_id:actor.id,body,request_hash:digest,created_at:now,valid_until:expires,trading_permission:false};validate("request",doc);const hashed=hash(doc);
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,?,'investor_request_history_workflow','investor_history_workflow_request',?,?,?)").run(audit,actor.id,id,canonical({content_hash:hashed}),now);
  db.prepare("INSERT INTO investor_epoch_history_intents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,w.id,body.model_id,e.root.row.id,body.action,body.expected_revision,body.action==="confirm"?body.preview_id:null,
   body.idempotency_key,digest,canonical(doc),hashed,actor.id,now,expires,audit);assertWritableDatabase(db);return doc;
 }).immediate();
}
export function readHistoryWorkflowResponse(db:Database.Database,actor:{id:string},binding:string,selection:{model?:string;nonce?:string},now=new Date().toISOString(),includeReview=false){
 time(now);return db.transaction(()=>{
  const w=workspace(db,actor);let selected:Obj|undefined;
  if(selection.nonce){selected=db.prepare("SELECT id,model_id FROM investor_epoch_history_intents WHERE workspace_id=? AND idempotency_key=?").get(w.id,selection.nonce) as Obj|undefined;check(selected,"LOOKUP_MISSING");}
  const model=selection.model??selected?.model_id,e=epoch(db,w,actor,model,now);
  selected??=db.prepare("SELECT id FROM investor_epoch_history_intents WHERE workspace_id=? AND model_id=? ORDER BY rowid DESC LIMIT 1").get(w.id,model) as Obj|undefined;
  let request=null,preview=null,download=null;
  if(selected){const original=intentHeader(db,w,actor,selected.id,now),{row,body}=original;check(row.model_id===model,"OUT_OF_SCOPE");
   const job=db.prepare("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?").get(JOB,w.id,row.id,row.content_hash) as Obj|undefined;
   const result=db.prepare("SELECT id FROM investor_epoch_history_results WHERE request_id=?").get(row.id) as Obj|undefined;
   let status="queued",code=null,prepared:ReturnType<typeof completed>|null=null;
   if(job)check(job.command_request_id===null&&job.max_attempts===1&&[0,1].includes(job.attempt_count as number),"JOB_CHANGED");
   if(result){const v=completed(db,w,actor,result.id,now);status=v.row.outcome as string;code=v.row.code;
    if(status==="plan_ready")prepared=v;
    if(status==="download_queued"){
     check(body.action==="confirm","RESULT_CHANGED");const prior=completed(db,w,actor,body.preview_id,now),batch=batchHeader(db,w,actor,obj(v.doc.history_request).id,now);
     check(prior.row.outcome==="plan_ready"&&prior.row.content_hash===body.expected_preview_hash&&hash(ref(batch.row))===hash(v.doc.history_request)
      &&batch.row.epoch_id===row.epoch_id&&batch.row.model_id===row.model_id&&batch.body.idempotency_key===body.idempotency_key&&batch.body.expected_plan_hash===obj(prior.doc.plan).plan_hash
      &&batch.body.max_calls===body.max_calls&&hash(batch.body.acknowledgements)===hash(body.acknowledgements),"RESULT_CHANGED");
     prepared=prior;download=batchView(db,w,actor,batch.row.id,now,includeReview);
    }
   }else if(!job||job.status==="queued"){if(job)check(job.attempt_count===0&&job.fencing_token===0&&job.lease_owner===null&&job.lease_until===null,"JOB_CHANGED");if(time(now)>=time(row.valid_until as string))status="expired";}
   else if(job.status==="running")status=time(now)<time(job.lease_until as string)?"running":"unknown";
   else{check(["failed","skipped","cancelled"].includes(job.status as string),"JOB_CHANGED");status="unknown";}
   if(body.action==="confirm"&&!prepared)prepared=completed(db,w,actor,body.preview_id,now);
   if(prepared?.row.outcome==="plan_ready"){
    const p=obj(prepared.doc.plan);preview={id:prepared.row.id,content_hash:prepared.row.content_hash,workspace_revision:p.workspace_revision,valid_until:prepared.doc.valid_until,plan_status:p.status,
     expected_date_count:p.expected_date_count,retained_date_count:p.retained_date_count,missing_date_count:p.missing_date_count,total_tiles:(p.tiles as Obj[]).length,tiles:(p.tiles as Obj[]).slice(0,4).map(tileView),
     prior_callback_count:(p.prior_attempts as unknown[]).length,historical_metadata_only:true};
    if(status==="plan_ready"){if(time(now)>=time(prepared.doc.valid_until as string))status="expired";else if(w.revision!==p.workspace_revision||!e?.enabled||p.source_fence!==fence(db,w.id as string,actor))status="outdated";}
   }
   if(!result&&w.revision!==row.expected_revision)status="outdated";
   request={id:row.id,action:row.action,intent_hash:hash(body),created_at:row.created_at,valid_until:row.valid_until,status,code};
  }
  if(!download&&e){const b=db.prepare("SELECT id FROM investor_epoch_history_requests WHERE workspace_id=? AND model_id=? AND epoch_id=? ORDER BY rowid DESC LIMIT 1").get(w.id,model,e.root.row.id) as Obj|undefined;if(b)download=batchView(db,w,actor,b.id,now,includeReview);}
  let readOnly=false;try{assertWritableDatabase(db);}catch(error){if(error instanceof Error&&error.message==="WORKBENCH_READ_ONLY")readOnly=true;else throw error;}
  return (includeReview?historyWorkflowReviewResponseSchema:historyWorkflowResponseSchema).parse({schema_version:includeReview?"investor-epoch-history-workflow-response-v2":"investor-epoch-history-workflow-response-v1",workspace_id:w.id,workspace_revision:w.revision,model_id:model,session_binding:binding,lookup_nonce:selection.nonce??null,
   checked_at:now,refresh_after:new Date(Date.parse(now)+15000).toISOString(),read_only:readOnly,epoch:e?{id:e.root.row.id,enabled:e.enabled,valid_until:e.root.row.valid_until}:null,request,preview,download,
   visibility:"private_owner_only_not_ai",provider_calls:0,current_source_eligibility_restored:false,monitoring_resumed:false,trading_permission:false,...(includeReview?{resolution_result:null}:{})});
 }).deferred();
}
export function readHistoryResolutionResponse(db:Database.Database,actor:{id:string},binding:string,nonce:string,now=new Date().toISOString()){
 return db.transaction(()=>{const w=workspace(db,actor),found=db.prepare("SELECT id FROM investor_epoch_history_resolutions WHERE workspace_id=? AND idempotency_key=?").get(w.id,nonce) as Obj|undefined;
  check(found,"LOOKUP_MISSING");const {row,body}=readHistoryResolutionHeader(db,actor,found.id,now),value=readHistoryWorkflowResponse(db,actor,binding,{model:row.model_id as string},now,true);
  return historyWorkflowReviewResponseSchema.parse({...value,lookup_nonce:nonce,resolution_result:{id:row.id,content_hash:row.content_hash,created_at:row.created_at,nonce,intent_hash:hash(body),old_outcome_known:false,new_download_authorized:false}});
 }).deferred();
}
