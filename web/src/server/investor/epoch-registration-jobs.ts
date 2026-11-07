import {randomUUID} from "node:crypto";
import type Database from "better-sqlite3";
import {assertWritableDatabase} from "../workbench-db";
import {canonical,hash} from "../ledger/service";
import {priceInstant as time} from "../market-price-source";
import {actionRead,actionJson,actionAudit} from "./action-source-proof";
import {validateModelEpochRegistration,validateInvestorModelDocument} from "./kernel-contracts";
import {readEpochPreviewResponse} from "./epoch-preview-jobs";
import {readModelEpochRegistrationHeader} from "./model-epoch-registration";
import {epochRegistrationSubmitSchema,epochRegistrationResponseSchema} from "./epoch-registration-schemas";
type Obj=Record<string,unknown>;
function check(value:unknown,code="INVALID"):asserts value{if(!value)throw new Error("EPOCH_REGISTRATION_"+code);}
function obj(value:unknown):Obj{check(value&&typeof value==="object"&&!Array.isArray(value));return value as Obj;}
function workspace(db:Database.Database,actor:{id:string}){
  const row=db.prepare("SELECT * FROM investor_workspaces WHERE owner_id=?").get(actor.id) as Obj|undefined;
  check(row&&Number.isSafeInteger(row.revision),"WORKSPACE_REQUIRED");return row;
}
function sealed(db:Database.Database,ws:Obj,actor:{id:string},id:unknown,kind:"preview"|"request",now:string){
  const row=actionRead(db,kind==="preview"?"investor_model_epoch_previews":"investor_model_epoch_requests",id,ws.id as string);
  const doc=actionJson(row.document_json,kind==="preview"?1048576:16384);validateModelEpochRegistration(kind,doc);
  check(hash(doc)===row.content_hash&&canonical(doc)===row.document_json&&row.actor_id===actor.id
    &&["workspace_id","model_id","actor_id","workspace_revision","created_at","valid_until"].every(k=>doc[k]===row[k])
    &&time(row.created_at as string)<=time(now),"HEADER_CHANGED");
  actionAudit(db,ws.id as string,row,kind==="preview"?"investor_preview_model_epoch":"investor_request_model_epoch",
    kind==="preview"?"investor_model_epoch_preview":"investor_model_epoch_request");
  return {row,doc};
}
function requestHeader(db:Database.Database,ws:Obj,actor:{id:string},id:unknown,now:string){
  const saved=sealed(db,ws,actor,id,"request",now),{row,doc}=saved,body=epochRegistrationSubmitSchema.parse(doc.body);
  const p=sealed(db,ws,actor,row.preview_id,"preview",now),epoch=obj(p.doc.epoch_definition),input=obj(p.doc.input),proof=obj(p.doc.source_proof),monitor=obj(doc.monitor_request);
  validateModelEpochRegistration("monitor_request",monitor);
  const model=actionRead(db,"investor_models",row.model_id,ws.id as string),definition=actionJson(model.document_json,131072);validateInvestorModelDocument("definition",definition);
  check(doc.request_id===row.id&&p.doc.preview_id===p.row.id&&p.row.model_id===row.model_id&&p.row.epoch_id===epoch.epoch_id
    &&hash(body)===row.request_hash&&body.idempotency_key===row.idempotency_key&&body.preview_id===p.row.id
    &&body.expected_preview_hash===p.row.content_hash&&body.expected_revision===p.row.workspace_revision&&row.workspace_revision===Number(body.expected_revision)+1
    &&hash(doc.preview)===hash({id:p.row.id,content_hash:p.row.content_hash})&&time(p.row.created_at as string)<=time(row.created_at as string)
    &&time(row.created_at as string)<time(row.valid_until as string)&&row.valid_until===p.row.valid_until
    &&canonical(definition)===model.document_json&&hash(definition)===model.content_hash&&definition.model_id===model.id
    &&["profile_id","plan_id","created_at"].every(k=>definition[k]===model[k])&&epoch.model_hash===model.content_hash
    &&epoch.model_id===row.model_id&&epoch.actor_id===actor.id&&epoch.workspace_id===ws.id
    &&hash(input.epoch)===hash({id:epoch.epoch_id,content_hash:hash(epoch)})&&hash(proof.epoch)===hash(input.epoch)
    &&proof.input_hash===hash(input)&&proof.projection_hash===input.projection_hash
    &&monitor.epoch_request_id===row.id&&hash(monitor.epoch)===hash(input.epoch)&&monitor.input_hash===hash(input)
    &&monitor.model_hash===model.content_hash&&monitor.profile_hash===definition.profile_hash&&monitor.control_id===obj(epoch.model_control).id
    &&monitor.checkpoint_hash===obj(epoch.binding).original_head_hash&&hash(monitor)===row.input_version,"HEADER_CHANGED");
  return {...saved,body,preview:p};
}
export function submitEpochRegistration(db:Database.Database,actor:{id:string},raw:unknown,now=new Date().toISOString()){
  const body=epochRegistrationSubmitSchema.parse(raw);validateModelEpochRegistration("submit",body);time(now);assertWritableDatabase(db);
  return db.transaction(()=>{
    assertWritableDatabase(db);const ws=workspace(db,actor),digest=hash(body);
    const old=db.prepare("SELECT id,request_hash FROM investor_model_epoch_requests WHERE workspace_id=? AND idempotency_key=?").get(ws.id,body.idempotency_key) as Obj|undefined;
    if(old){check(old.request_hash===digest,"DUPLICATE_CONFLICT");return requestHeader(db,ws,actor,old.id,now).doc;}
    check(ws.revision===body.expected_revision,"VERSION_CHANGED");const p=sealed(db,ws,actor,body.preview_id,"preview",now);
    const view=readEpochPreviewResponse(db,actor,"0".repeat(64),{model:p.row.model_id as string},now);
    check(view.request?.status==="preview_ready"&&view.preview?.id===body.preview_id&&view.preview.content_hash===body.expected_preview_hash
      &&view.workspace_revision===body.expected_revision,"PREVIEW_CHANGED");
    check(time(now)<time(view.preview.valid_until)&&time(now)<time(p.row.valid_until as string),"EXPIRED");
    check(!db.prepare("SELECT 1 FROM investor_model_epochs WHERE workspace_id=? AND model_id=?").get(ws.id,p.row.model_id),"ALREADY_REGISTERED");
    check(!db.prepare("SELECT 1 FROM investor_model_epoch_requests WHERE workspace_id=? AND preview_id=?").get(ws.id,p.row.id),"PREVIEW_CHANGED");
    const epoch=obj(p.doc.epoch_definition),model=actionRead(db,"investor_models",p.row.model_id,ws.id as string),definition=actionJson(model.document_json,131072);
    const id="model-epoch-request:"+randomUUID(),audit=randomUUID();
    const monitor={schema_version:"investor-evidence-monitor-request-v3",engine_version:"investor-evidence-model-watcher-epoch-v1",
      model_hash:epoch.model_hash,profile_hash:definition.profile_hash,control_id:obj(epoch.model_control).id,input_hash:obj(p.doc.source_proof).input_hash,
      checkpoint_hash:obj(epoch.binding).original_head_hash,epoch:obj(p.doc.input).epoch,epoch_request_id:id};
    validateModelEpochRegistration("monitor_request",monitor);const version=hash(monitor);
    const doc={schema_version:"investor-model-epoch-request-v1",request_id:id,workspace_id:ws.id,actor_id:actor.id,model_id:p.row.model_id,
      workspace_revision:Number(body.expected_revision)+1,preview:{id:p.row.id,content_hash:p.row.content_hash},body,monitor_request:monitor,
      created_at:now,valid_until:p.row.valid_until,trading_permission:false};
    validateModelEpochRegistration("request",doc);
    db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,?,'investor_request_model_epoch','investor_model_epoch_request',?,?,?)")
      .run(audit,actor.id,id,canonical({content_hash:hash(doc)}),now);
    db.prepare("INSERT INTO investor_model_epoch_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,ws.id,p.row.model_id,p.row.id,doc.workspace_revision,body.idempotency_key,digest,version,canonical(doc),hash(doc),actor.id,now,p.row.valid_until,audit);
    const stamp=now.slice(0,-1)+"000Z";
    db.prepare("INSERT INTO job_runs(id,command_request_id,job_type,scope,period,input_version,status,max_attempts,not_before,created_at,updated_at) VALUES(?,NULL,'investor_evidence_monitor',?,?,?,'queued',2,?,?,?)")
      .run("job:"+randomUUID(),ws.id,id,version,stamp,stamp,stamp);
    db.prepare("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?").run(ws.id);
    assertWritableDatabase(db);return doc;
  }).immediate();
}
export function readEpochRegistrationResponse(db:Database.Database,actor:{id:string},binding:string,selection:{model?:string;nonce?:string},now=new Date().toISOString()){
  time(now);return db.transaction(()=>{
    const ws=workspace(db,actor);
    const selected=selection.nonce?db.prepare("SELECT id,model_id FROM investor_model_epoch_requests WHERE workspace_id=? AND idempotency_key=?").get(ws.id,selection.nonce) as Obj|undefined
      :db.prepare("SELECT id,model_id FROM investor_model_epoch_requests WHERE workspace_id=? AND model_id=? ORDER BY rowid DESC LIMIT 1").get(ws.id,selection.model) as Obj|undefined;
    if(selection.nonce)check(selected,"LOOKUP_MISSING");
    const modelId=selection.model??selected?.model_id as string;actionRead(db,"investor_models",modelId,ws.id as string);
    let request=null,receipt=null;
    if(selected){
      const {row,body}=requestHeader(db,ws,actor,selected.id,now);check(row.model_id===modelId,"OUT_OF_SCOPE");
      const job=db.prepare("SELECT * FROM job_runs WHERE job_type='investor_evidence_monitor' AND scope=? AND period=? AND input_version=?").get(ws.id,row.id,row.input_version) as Obj|undefined;
      check(job&&job.command_request_id===null&&job.max_attempts===2&&Number.isInteger(job.attempt_count)&&Number(job.attempt_count)>=0&&Number(job.attempt_count)<=2,"JOB_CHANGED");
      const epoch=db.prepare("SELECT id FROM investor_model_epochs WHERE workspace_id=? AND request_id=?").get(ws.id,row.id) as Obj|undefined;
      let status="queued";
      if(epoch){const saved=readModelEpochRegistrationHeader(db,ws.id as string,actor,epoch.id as string,now);
        const attempt=db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=?").get(job.id,job.attempt_count) as Obj|undefined;
        check(saved.row.request_id===row.id&&saved.row.job_id===job.id&&job.status==="succeeded"&&job.lease_owner===null&&job.lease_until===null
          &&attempt?.status==="succeeded"&&attempt.error_json===null&&attempt.finished_at===job.updated_at,"RESULT_CHANGED");
        status="registered";receipt={epoch_id:saved.row.id,registration_hash:saved.row.content_hash,registered_at:saved.row.created_at,valid_until:saved.row.valid_until,
          historical_registration_only:true,monitoring_resumed:false,current_source_eligibility_restored:false,trading_permission:false};
      }else if(["queued","retry_queued"].includes(job.status as string)){if(time(now)>=time(row.valid_until as string))status="expired";}
      else if(job.status==="running")status=time(now)<time(job.lease_until as string)?"running":"unknown";
      else{check(["failed","cancelled","skipped","partial"].includes(job.status as string),"RESULT_CHANGED");status="unknown";}
      if(!epoch&&ws.revision!==row.workspace_revision)status="outdated";
      request={id:row.id,intent_hash:hash(body),preview_id:row.preview_id,created_at:row.created_at,valid_until:row.valid_until,status};
    }
    let readOnly=false;try{assertWritableDatabase(db);}catch(e){if(e instanceof Error&&e.message==="WORKBENCH_READ_ONLY")readOnly=true;else throw e;}
    return epochRegistrationResponseSchema.parse({schema_version:"investor-epoch-registration-response-v1",workspace_id:ws.id,workspace_revision:ws.revision,model_id:modelId,
      session_binding:binding,lookup_nonce:selection.nonce??null,checked_at:now,refresh_after:new Date(Date.parse(now)+15000).toISOString(),read_only:readOnly,request,receipt,
      visibility:"private_owner_only_not_ai",provider_calls:0,trading_permission:false});
  }).deferred();
}
