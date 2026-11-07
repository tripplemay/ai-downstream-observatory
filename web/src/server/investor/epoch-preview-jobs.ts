import {randomUUID} from "node:crypto";
import type Database from "better-sqlite3";
import {assertWritableDatabase} from "../workbench-db";
import {canonical,hash} from "../ledger/service";
import {priceInstant as time} from "../market-price-source";
import {actionAudit,actionJson,actionRead,actionJobStartedByMillisecond} from "./action-source-proof";
import {validateEpochPreviewJob,validateInvestorModelDocument,validateModelEpochRegistration} from "./kernel-contracts";
import {epochPreviewSubmitSchema,epochPreviewResponseSchema} from "./epoch-preview-schemas";

type Obj=Record<string,unknown>;
const JOB="investor_epoch_preview";
function check(value:unknown,code="INVALID"):asserts value{if(!value)throw new Error("EPOCH_PREVIEW_"+code);}
function object(value:unknown):Obj{check(value&&typeof value==="object"&&!Array.isArray(value));return value as Obj;}
function workspace(db:Database.Database,actor:{id:string}){
  const row=db.prepare("SELECT * FROM investor_workspaces WHERE owner_id=?").get(actor.id) as Obj|undefined;
  check(row&&Number.isSafeInteger(row.revision),"WORKSPACE_REQUIRED");return row;
}
function modelHeader(db:Database.Database,ws:Obj,id:unknown,now:string){
  const row=actionRead(db,"investor_models",id,ws.id as string),doc=actionJson(row.document_json,131072);
  validateInvestorModelDocument("definition",doc);
  check(canonical(doc)===row.document_json&&hash(doc)===row.content_hash&&doc.model_id===row.id
    &&["profile_id","plan_id","created_at"].every(key=>doc[key]===row[key])&&time(row.created_at as string)<=time(now),"MODEL_CHANGED");
  return {row,doc};
}
function requestHeader(db:Database.Database,ws:Obj,actor:{id:string},id:unknown,now:string){
  const row=actionRead(db,"investor_epoch_preview_requests",id,ws.id as string),doc=actionJson(row.document_json,16384);
  validateEpochPreviewJob("request",doc);const body=epochPreviewSubmitSchema.parse(doc.body);
  check(canonical(doc)===row.document_json&&hash(doc)===row.content_hash&&row.actor_id===actor.id&&doc.request_id===row.id
    &&hash(body)===row.request_hash&&["workspace_id","model_id","actor_id","request_hash","created_at","valid_until"].every(k=>doc[k]===row[k])
    &&body.model_id===row.model_id&&body.expected_revision===row.expected_revision&&body.idempotency_key===row.idempotency_key
    &&time(row.created_at as string)<=time(now)&&time(row.valid_until as string)>time(row.created_at as string)
    &&time(row.valid_until as string)-time(row.created_at as string)<=300000000n,"HEADER_CHANGED");
  actionAudit(db,ws.id as string,row,"investor_request_epoch_preview","investor_epoch_preview_request");
  const model=modelHeader(db,ws,row.model_id,now);
  check(model.row.content_hash===body.expected_model_hash&&time(row.valid_until as string)<=time(model.doc.valid_until as string),"MODEL_CHANGED");
  return {row,doc,body,model};
}
export function submitEpochPreview(db:Database.Database,actor:{id:string},raw:unknown,now=new Date().toISOString()){
  const body=epochPreviewSubmitSchema.parse(raw);validateEpochPreviewJob("submit",body);time(now);assertWritableDatabase(db);
  return db.transaction(()=>{
    assertWritableDatabase(db);const ws=workspace(db,actor),digest=hash(body);
    const old=db.prepare("SELECT id,request_hash FROM investor_epoch_preview_requests WHERE workspace_id=? AND idempotency_key=?").get(ws.id,body.idempotency_key) as Obj|undefined;
    if(old){check(old.request_hash===digest,"DUPLICATE_CONFLICT");return requestHeader(db,ws,actor,old.id,now).doc;}
    check(ws.revision===body.expected_revision,"VERSION_CHANGED");const model=modelHeader(db,ws,body.model_id,now);
    check(model.row.content_hash===body.expected_model_hash,"MODEL_CHANGED");check(time(now)<time(model.doc.valid_until as string),"EXPIRED");
    check(!db.prepare("SELECT 1 FROM investor_model_epochs WHERE workspace_id=? AND model_id=?").get(ws.id,body.model_id),"ALREADY_REGISTERED");
    check(!db.prepare("SELECT 1 FROM investor_epoch_preview_requests r LEFT JOIN investor_epoch_preview_results u ON u.request_id=r.id "
      +"LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash "
      +"WHERE r.workspace_id=? AND r.expected_revision=? AND r.valid_until>? AND u.id IS NULL AND (j.id IS NULL OR j.status IN ('queued','running')) LIMIT 1")
      .get(JOB,ws.id,body.expected_revision,now),"BUSY");
    const id="epoch-preview-request:"+randomUUID(),audit=randomUUID(),until=new Date(Math.min(Date.parse(model.doc.valid_until as string),Date.parse(now)+300000)).toISOString();
    const doc={schema_version:"investor-epoch-preview-request-v1",request_id:id,workspace_id:ws.id,model_id:body.model_id,actor_id:actor.id,
      body,request_hash:digest,created_at:now,valid_until:until,trading_permission:false};
    validateEpochPreviewJob("request",doc);const hashed=hash(doc);
    db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,?,'investor_request_epoch_preview','investor_epoch_preview_request',?,?,?)")
      .run(audit,actor.id,id,canonical({content_hash:hashed}),now);
    db.prepare("INSERT INTO investor_epoch_preview_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id,ws.id,body.model_id,body.expected_revision,body.idempotency_key,digest,canonical(doc),hashed,actor.id,now,until,audit);
    assertWritableDatabase(db);return doc;
  }).immediate();
}
/** Completed-work metadata only; no raw replay or current-value/source grant. */
export function readEpochPreviewResponse(db:Database.Database,actor:{id:string},binding:string,selection:{model?:string;nonce?:string},now=new Date().toISOString()){
  time(now);return db.transaction(()=>{
    const ws=workspace(db,actor);let selected:Obj|undefined;
    if(selection.nonce){selected=db.prepare("SELECT id,model_id FROM investor_epoch_preview_requests WHERE workspace_id=? AND idempotency_key=?").get(ws.id,selection.nonce) as Obj|undefined;check(selected,"LOOKUP_MISSING");}
    const model=modelHeader(db,ws,selection.model??selected?.model_id,now);
    selected??=db.prepare("SELECT id FROM investor_epoch_preview_requests WHERE workspace_id=? AND model_id=? ORDER BY rowid DESC LIMIT 1").get(ws.id,model.row.id) as Obj|undefined;
    let request=null,preview=null;
    if(selected){
      const {row,body}=requestHeader(db,ws,actor,selected.id,now);check(row.model_id===model.row.id,"OUT_OF_SCOPE");
      const job=db.prepare("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?").get(JOB,ws.id,row.id,row.content_hash) as Obj|undefined;
      const result=db.prepare("SELECT * FROM investor_epoch_preview_results WHERE request_id=? AND workspace_id=?").get(row.id,ws.id) as Obj|undefined;
      let status="queued",code=null;
      if(job)check(job.command_request_id===null&&job.max_attempts===1&&[0,1].includes(job.attempt_count as number),"JOB_CHANGED");
      if(result){
        const doc=actionJson(result.document_json,16384);validateEpochPreviewJob("result",doc);
        check(job&&job.status==="succeeded"&&job.attempt_count===1&&job.lease_owner===null&&job.lease_until===null
          &&canonical(doc)===result.document_json&&hash(doc)===result.content_hash&&doc.result_id===result.id&&result.actor_id===actor.id
          &&doc.request_hash===row.content_hash&&result.job_id===job.id&&result.fencing_token===job.fencing_token
          &&["request_id","workspace_id","model_id","actor_id","job_id","fencing_token","outcome","code","preview_id","created_at"].every(k=>doc[k]===result[k])
          &&time(doc.valid_until as string)<=time(row.valid_until as string),"RESULT_CHANGED");
        actionAudit(db,ws.id as string,result,"investor_finish_epoch_preview","investor_epoch_preview_result");
        const attempt=db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1").get(job.id) as Obj|undefined;
        const expected=Object.fromEntries(["request_id","result_id","outcome","code","preview_id","trading_permission"].map(k=>[k,doc[k]]));
        check(attempt&&attempt.status==="succeeded"&&attempt.fencing_token===job.fencing_token&&attempt.error_json===null
          &&time(row.created_at as string)<=time(attempt.started_at as string)&&actionJobStartedByMillisecond(attempt.started_at as string,result.created_at as string)
          &&time(result.created_at as string)<=time(attempt.finished_at as string)&&attempt.finished_at===job.updated_at&&time(job.updated_at as string)<=time(now)
          &&canonical(actionJson(job.result_json))===canonical(expected),"RESULT_CHANGED");
        status=result.outcome as string;code=result.code;
        if(status==="preview_ready"){
          check(time(attempt.finished_at as string)<time(doc.valid_until as string),"RESULT_CHANGED");
          const p=actionRead(db,"investor_model_epoch_previews",result.preview_id,ws.id as string),value=actionJson(p.document_json,1048576);
          validateModelEpochRegistration("preview",value);actionAudit(db,ws.id as string,p,"investor_preview_model_epoch","investor_model_epoch_preview");
          const epoch=object(value.epoch_definition),input=object(value.input),proof=object(value.source_proof),ref={id:epoch.epoch_id,content_hash:hash(epoch)};
          check(hash(value)===p.content_hash&&canonical(value)===p.document_json&&doc.preview_hash===p.content_hash&&p.actor_id===actor.id
            &&value.preview_id===p.id&&["workspace_id","model_id","actor_id","workspace_revision","created_at","valid_until"].every(k=>value[k]===p[k])
            &&p.model_id===row.model_id&&p.workspace_revision===Number(row.expected_revision)+1&&epoch.model_id===p.model_id&&epoch.actor_id===actor.id
            &&epoch.workspace_id===ws.id&&epoch.epoch_id===p.epoch_id&&epoch.model_hash===model.row.content_hash&&input.workspace_id===ws.id&&input.model_id===p.model_id
            &&proof.workspace_id===ws.id&&proof.actor_id===actor.id&&proof.model_id===p.model_id&&hash(input.epoch)===hash(ref)&&hash(proof.epoch)===hash(ref)
            &&proof.input_hash===hash(input)&&proof.projection_hash===input.projection_hash&&epoch.created_at===input.created_at&&input.created_at===proof.checked_at
            &&time(row.created_at as string)<=time(input.created_at as string)&&time(input.created_at as string)<=time(p.created_at as string)
            &&time(p.created_at as string)<=time(result.created_at as string)&&time(doc.valid_until as string)<=time(p.valid_until as string)
            &&time(p.valid_until as string)<=time(proof.valid_until as string),"PREVIEW_CHANGED");
          preview={id:p.id,content_hash:p.content_hash,workspace_revision:p.workspace_revision,created_at:p.created_at,valid_until:doc.valid_until,
            original_head_id:epoch.original_head_id,corrections:(object(epoch.binding).corrections as Obj[]).map(c=>Object.fromEntries(["correction_id","confirmation_hash","handover_id","handover_hash"].map(k=>[k,c[k]]))),
            ranges:(input.segments as Obj[]).map(s=>({start_date:object(s.snapshot).range_start,end_date:object(s.snapshot).range_end})),
            historical_metadata_only:true,current_source_eligibility_restored:false,epoch_registered:false,monitoring_resumed:false};
          if(time(now)>=time(doc.valid_until as string))status="expired";
          else if(ws.revision!==p.workspace_revision)status="outdated";
        }
      }else if(!job||job.status==="queued"){
        if(job)check(job.attempt_count===0&&job.fencing_token===0&&job.lease_owner===null&&job.lease_until===null,"JOB_CHANGED");
        if(time(now)>=time(row.valid_until as string))status="expired";
      }else if(job.status==="running")status=time(now)<time(job.lease_until as string)?"running":"unknown";
      else{check(["failed","cancelled","skipped"].includes(job.status as string),"JOB_CHANGED");status="unknown";}
      if(!result&&ws.revision!==row.expected_revision)status="outdated";
      request={id:row.id,intent_hash:hash(body),model_id:row.model_id,created_at:row.created_at,valid_until:row.valid_until,status,code};
    }
    let readOnly=false;try{assertWritableDatabase(db);}catch(error){if(error instanceof Error&&error.message==="WORKBENCH_READ_ONLY")readOnly=true;else throw error;}
    return epochPreviewResponseSchema.parse({schema_version:"investor-epoch-preview-response-v1",workspace_id:ws.id,workspace_revision:ws.revision,model_id:model.row.id,model_hash:model.row.content_hash,
      session_binding:binding,lookup_nonce:selection.nonce??null,checked_at:now,refresh_after:new Date(Date.parse(now)+15000).toISOString(),read_only:readOnly,request,preview,
      visibility:"private_owner_only_not_ai",provider_calls:0,trading_permission:false});
  }).deferred();
}
