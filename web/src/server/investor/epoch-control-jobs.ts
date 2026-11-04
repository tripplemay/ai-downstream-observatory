import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { canonical, hash } from "../ledger/service";
import { priceInstant as time } from "../market-price-source";
import { actionAudit, actionJson, actionRead } from "./action-source-proof";
import { readModelEpochRegistrationHeader } from "./model-epoch-registration";
import { readEpochControlHeader } from "./epoch-continuation";
import { validateEpochContinuation, validateEpochControlJob } from "./kernel-contracts";
import { epochControlSubmitSchema, epochControlResponseSchema } from "./epoch-control-schemas";

type Obj=Record<string,unknown>;
const JOB="investor_epoch_control";
function check(value:unknown,code="INVALID"):asserts value{if(!value)throw new Error("EPOCH_CONTROL_"+code);}
function workspace(db:Database.Database,actor:{id:string}){
  const row=db.prepare("SELECT * FROM investor_workspaces WHERE owner_id=?").get(actor.id) as Obj|undefined;
  check(row&&Number.isSafeInteger(row.revision),"WORKSPACE_REQUIRED");return row;
}
function requestHeader(db:Database.Database,ws:Obj,actor:{id:string},id:unknown,now:string){
  const row=actionRead(db,"investor_epoch_control_requests",id,ws.id as string),doc=actionJson(row.document_json,16384);
  validateEpochControlJob("request",doc);const body=epochControlSubmitSchema.parse(doc.body);
  check(canonical(doc)===row.document_json&&hash(doc)===row.content_hash&&hash(body)===row.request_hash&&row.actor_id===actor.id
    &&doc.request_id===row.id&&["workspace_id","model_id","epoch_id","actor_id","created_at","valid_until","request_hash"].every(key=>doc[key]===row[key])
    &&body.epoch_id===row.epoch_id&&body.expected_revision===row.expected_revision&&body.idempotency_key===row.idempotency_key
    &&time(row.created_at as string)<=time(now)&&time(row.valid_until as string)>time(row.created_at as string)
    &&time(row.valid_until as string)-time(row.created_at as string)<=300000000n,"HEADER_CHANGED");
  actionAudit(db,ws.id as string,row,"investor_request_epoch_control","investor_epoch_control_request");
  const root=readModelEpochRegistrationHeader(db,ws.id as string,actor,row.epoch_id as string,now);
  const checkpoint=actionRead(db,"investor_evidence_model_checkpoints",body.expected_checkpoint.id,ws.id as string);
  check(root.model.id===row.model_id&&root.row.content_hash===body.expected_registration_hash&&time(root.row.created_at as string)<=time(row.created_at as string)
    &&time(row.valid_until as string)<=time(root.row.valid_until as string)&&checkpoint.model_id===row.model_id
    &&hash({id:checkpoint.id,content_hash:checkpoint.content_hash})===hash(body.expected_checkpoint),"HEADER_CHANGED");
  return {row,doc,body,root};
}

/** Save bounded owner intent only. No source qualification or activation in GET/POST. */
export function submitEpochControl(db:Database.Database,actor:{id:string},raw:unknown,now=new Date().toISOString()){
  const body=epochControlSubmitSchema.parse(raw);validateEpochContinuation("control_submit",body);time(now);assertWritableDatabase(db);
  return db.transaction(()=>{
    assertWritableDatabase(db);const ws=workspace(db,actor),digest=hash(body);
    const old=db.prepare("SELECT id,request_hash FROM investor_epoch_control_requests WHERE workspace_id=? AND idempotency_key=?").get(ws.id,body.idempotency_key) as Obj|undefined;
    if(old){check(old.request_hash===digest&&body.enabled,"DUPLICATE_CONFLICT");return requestHeader(db,ws,actor,old.id,now).doc;}
    const prior=db.prepare("SELECT id FROM investor_epoch_controls WHERE workspace_id=? AND idempotency_key=?").get(ws.id,body.idempotency_key) as Obj|undefined;
    if(prior){const value=readEpochControlHeader(db,ws.id as string,actor,prior.id as string,now);check(hash(value.doc.body)===digest,"DUPLICATE_CONFLICT");return value.doc;}
    check(ws.revision===body.expected_revision,"VERSION_CHANGED");
    const root=readModelEpochRegistrationHeader(db,ws.id as string,actor,body.epoch_id,now);
    const head=db.prepare("SELECT id,content_hash FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? ORDER BY sequence DESC LIMIT 1").get(ws.id,root.model.id);
    check(root.row.content_hash===body.expected_registration_hash&&hash(head)===hash(body.expected_checkpoint),"CHANGED");
    check(time(root.row.created_at as string)<=time(now)&&time(now)<time(root.row.valid_until as string),"EXPIRED");
    const id=randomUUID(),audit=randomUUID();
    if(!body.enabled){
      const version=Number((db.prepare("SELECT COALESCE(MAX(version),0)+1 n FROM investor_epoch_controls WHERE epoch_id=?").get(body.epoch_id) as {n:number}).n);
      const doc={schema_version:"investor-epoch-control-v1",control_id:id,workspace_id:ws.id,actor_id:actor.id,model_id:root.model.id,
        epoch:root.record.epoch,registration_hash:root.row.content_hash,version,workspace_revision:Number(ws.revision)+1,
        body,created_at:now,valid_until:root.row.valid_until,trading_permission:false};
      validateEpochContinuation("control",doc);const digest=hash(doc);
      db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,?,'investor_control_epoch_continuation','investor_epoch_control',?,?,?)").run(audit,actor.id,id,canonical({content_hash:digest}),now);
      db.prepare("INSERT INTO investor_epoch_controls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,ws.id,root.model.id,body.epoch_id,version,0,body.idempotency_key,canonical(doc),digest,actor.id,now,root.row.valid_until,audit);
      db.prepare("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?").run(ws.id);assertWritableDatabase(db);return doc;
    }
    check(!db.prepare(`SELECT 1 FROM investor_epoch_control_requests r LEFT JOIN investor_epoch_control_results u ON u.request_id=r.id
      LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
      WHERE r.workspace_id=? AND r.expected_revision=? AND r.valid_until>? AND u.id IS NULL AND (j.id IS NULL OR j.status IN ('queued','running')) LIMIT 1`).get(JOB,ws.id,ws.revision,now),"BUSY");
    const until=new Date(Math.min(Date.parse(root.row.valid_until as string),Date.parse(now)+300000)).toISOString();
    const doc={schema_version:"investor-epoch-control-request-v1",request_id:id,workspace_id:ws.id,model_id:root.model.id,epoch_id:body.epoch_id,actor_id:actor.id,
      body,request_hash:digest,created_at:now,valid_until:until,trading_permission:false};validateEpochControlJob("request",doc);const hashed=hash(doc);
    db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,?,'investor_request_epoch_control','investor_epoch_control_request',?,?,?)").run(audit,actor.id,id,canonical({content_hash:hashed}),now);
    db.prepare("INSERT INTO investor_epoch_control_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,ws.id,root.model.id,body.epoch_id,body.expected_revision,body.idempotency_key,digest,canonical(doc),hashed,actor.id,now,until,audit);
    assertWritableDatabase(db);return doc;
  }).immediate();
}

/** Historical request/control metadata only, not a source or current-value grant. */
export function readEpochControlResponse(db:Database.Database,actor:{id:string},binding:string,selection:{model?:string;nonce?:string},now=new Date().toISOString()){
  time(now);return db.transaction(()=>{
    const ws=workspace(db,actor);
    let selected:Obj|undefined,receipt=null,request=null;
    if(selection.nonce){
      selected=db.prepare("SELECT id,model_id FROM investor_epoch_control_requests WHERE workspace_id=? AND idempotency_key=?").get(ws.id,selection.nonce) as Obj|undefined;
      const pause=db.prepare("SELECT id,model_id FROM investor_epoch_controls WHERE workspace_id=? AND idempotency_key=?").get(ws.id,selection.nonce) as Obj|undefined;
      if(pause){const value=readEpochControlHeader(db,ws.id as string,actor,pause.id as string,now);const body=epochControlSubmitSchema.parse(value.doc.body);
        receipt={control_id:pause.id,intent_hash:hash(body),epoch_id:body.epoch_id,enabled:body.enabled};selected??=pause;}
      check(selected,"LOOKUP_MISSING");
    }
    const modelId=(selection.model??selected?.model_id) as string;check(typeof modelId==="string","INPUT_INVALID");
    const model=actionRead(db,"investor_models",modelId,ws.id as string);check(model,"OUT_OF_SCOPE");
    const latest=db.prepare("SELECT id FROM investor_model_epochs WHERE workspace_id=? AND model_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(ws.id,modelId) as Obj|undefined;
    let epoch=null;
    if(latest){
      const root=readModelEpochRegistrationHeader(db,ws.id as string,actor,latest.id as string,now);
      const control=db.prepare("SELECT id FROM investor_epoch_controls WHERE workspace_id=? AND epoch_id=? ORDER BY version DESC LIMIT 1").get(ws.id,latest.id) as Obj|undefined;
      const actual=control?readEpochControlHeader(db,ws.id as string,actor,control.id as string,now):null;
      const global=db.prepare("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1").get(ws.id,modelId) as Obj|undefined;
      const head=db.prepare("SELECT id,content_hash FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? ORDER BY sequence DESC LIMIT 1").get(ws.id,modelId);
      epoch={id:latest.id,registration_hash:root.row.content_hash,registered_at:root.row.created_at,valid_until:root.row.valid_until,checkpoint:head,
        enabled:actual?.row.enabled===1,control_id:actual?.row.id??null,control_version:actual?.row.version??0,
        global_control_matches:!!global&&global.enabled===1&&hash({id:global.id,content_hash:hash(global)})===hash(root.epoch.model_control)};
    }
    const pending=selection.nonce&&selected?.id?db.prepare("SELECT id FROM investor_epoch_control_requests WHERE id=? AND workspace_id=?").get(selected.id,ws.id)
      :db.prepare("SELECT id FROM investor_epoch_control_requests WHERE workspace_id=? AND model_id=? ORDER BY rowid DESC LIMIT 1").get(ws.id,modelId);
    if(pending){
      const {row,body}=requestHeader(db,ws,actor,(pending as Obj).id,now);
      const job=db.prepare("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?").get(JOB,ws.id,row.id,row.content_hash) as Obj|undefined;
      const result=db.prepare("SELECT * FROM investor_epoch_control_results WHERE request_id=? AND workspace_id=?").get(row.id,ws.id) as Obj|undefined;
      let status="queued",code=null;
      if(job)check(job.command_request_id===null&&job.max_attempts===1&&[0,1].includes(job.attempt_count as number));
      if(result){
        const doc=actionJson(result.document_json,16384);validateEpochControlJob("result",doc);
        check(job&&job.status==="succeeded"&&job.attempt_count===1&&job.lease_owner===null&&job.lease_until===null
          &&canonical(doc)===result.document_json&&hash(doc)===result.content_hash&&doc.request_hash===row.content_hash
          &&["workspace_id","actor_id","request_id","job_id","fencing_token","outcome","code","control_id","created_at"].every(key=>doc[key]===result[key])
          &&doc.result_id===result.id&&result.actor_id===actor.id&&result.job_id===job.id&&result.fencing_token===job.fencing_token,"RESULT_CHANGED");
        actionAudit(db,ws.id as string,result,"investor_finish_epoch_control","investor_epoch_control_result");
        const attempt=db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1").get(job.id) as Obj|undefined;
        check(attempt&&attempt.status==="succeeded"&&attempt.fencing_token===job.fencing_token&&attempt.error_json===null
          &&time(row.created_at as string)<=time(attempt.started_at as string)&&time(attempt.started_at as string)<=time(result.created_at as string)
          &&time(result.created_at as string)<=time(attempt.finished_at as string)&&attempt.finished_at===job.updated_at&&time(job.updated_at as string)<=time(now)
          &&hash(actionJson(job.result_json))===hash({request_id:row.id,result_id:result.id,outcome:result.outcome,code:result.code,trading_permission:false})
          &&time(doc.valid_until as string)<=time(row.valid_until as string),"RESULT_CHANGED");
        if(result.outcome==="applied"){
          const control=readEpochControlHeader(db,ws.id as string,actor,result.control_id as string,now);
          check(control.row.content_hash===doc.control_hash&&hash(control.doc.body)===hash(body)&&time(attempt.finished_at as string)<time(doc.valid_until as string),"RESULT_CHANGED");
          receipt={control_id:control.row.id,intent_hash:hash(body),epoch_id:body.epoch_id,enabled:true};
        }
        status=result.outcome as string;code=result.code;
      }else if(!job||job.status==="queued"){
        if(job)check(job.attempt_count===0&&job.fencing_token===0&&job.lease_owner===null&&job.lease_until===null);
        if(time(now)>=time(row.valid_until as string))status="expired";
      }else if(job.status==="running")status=time(now)<time(job.lease_until as string)?"running":"unknown";
      else{check(["failed","cancelled","skipped"].includes(job.status as string));status="unknown";}
      if(!result&&ws.revision!==row.expected_revision){status="superseded";code="EPOCH_CONTROL_CHANGED";}
      request={id:row.id,intent_hash:hash(body),epoch_id:row.epoch_id,created_at:row.created_at,valid_until:row.valid_until,status,code};
    }
    let readOnly=false;try{assertWritableDatabase(db);}catch(error){if(error instanceof Error&&error.message==="WORKBENCH_READ_ONLY")readOnly=true;else throw error;}
    return epochControlResponseSchema.parse({schema_version:"investor-epoch-control-response-v1",workspace_id:ws.id,workspace_revision:ws.revision,model_id:modelId,
      session_binding:binding,lookup_nonce:selection.nonce??null,checked_at:now,refresh_after:new Date(Date.parse(now)+15000).toISOString(),read_only:readOnly,
      epoch,request,receipt,visibility:"private_owner_only_not_ai",provider_calls:0,trading_permission:false});
  }).deferred();
}
