import {randomUUID} from "node:crypto";
import type Database from "better-sqlite3";
import {canonical,hash} from "../ledger/service";
import {assertWritableDatabase} from "../workbench-db";
import {priceInstant as time} from "../market-price-source";
import {actionRead,actionJson,actionAudit,actionJobStartedByMillisecond} from "./action-source-proof";
import {validateEpochHistoryJob as validateHistory,validateEpochHistoryResolution as validate} from "./kernel-contracts";
import {historyResolutionSubmitSchema,historyUnknownReviewSchema} from "./epoch-history-resolution-schemas";
type Obj=Record<string,unknown>;
const JOB="investor_epoch_history",terminal=["succeeded","failed","skipped","cancelled"];
const jobFields=["id","job_type","scope","period","input_version","command_request_id","status","lease_owner","lease_until","fencing_token","attempt_count","max_attempts","not_before","created_at","updated_at","result_json"];
const attemptFields=["job_id","attempt","fencing_token","status","started_at","finished_at","error_json"];
const ref=(r:Obj)=>({id:r.id,content_hash:r.content_hash}),pick=(r:Obj,keys:string[])=>Object.fromEntries(keys.map(k=>[k,r[k]]));
function check(v:unknown,code="CHANGED"):asserts v{if(!v)throw new Error("HISTORY_RESOLUTION_"+code);}
function obj(v:unknown):Obj{check(v&&typeof v==="object"&&!Array.isArray(v));return v as Obj;}
function workspace(db:Database.Database,actor:{id:string}){const w=obj(db.prepare("SELECT * FROM investor_workspaces WHERE owner_id=?").get(actor.id));check(Number.isSafeInteger(w.revision));return w;}
function unknownState(db:Database.Database,w:Obj,actor:{id:string},slotId:unknown,now:string){
 const slot=actionRead(db,"investor_epoch_history_slots",slotId,w.id as string),batch=actionRead(db,"investor_epoch_history_requests",slot.request_id,w.id as string),doc=actionJson(batch.document_json,139264);validateHistory("request",doc);
 const p=obj(doc.plan),body=obj(doc.body),design={...p};delete design.checked_at;delete design.plan_hash;
 check(canonical(doc)===batch.document_json&&hash(doc)===batch.content_hash&&batch.actor_id===actor.id&&doc.request_id===batch.id&&hash(body)===batch.request_hash
  &&["workspace_id","model_id","actor_id","request_hash","authorized_calls","created_at","valid_until"].every(k=>doc[k]===batch[k])
  &&body.idempotency_key===batch.idempotency_key&&body.expected_revision===batch.expected_revision&&p.workspace_revision===batch.expected_revision
  &&p.workspace_id===w.id&&p.actor_id===actor.id&&p.model_id===batch.model_id&&obj(p.epoch).id===batch.epoch_id&&body.epoch_id===batch.epoch_id
  &&obj(p.activation).id===batch.activation_id&&obj(p.model_control).id===batch.control_id&&p.plan_hash===body.expected_plan_hash&&hash(design)===p.plan_hash
  &&p.planned_at===body.planned_at&&p.valid_until===batch.valid_until&&p.status==="download_confirmation_required"
  &&batch.authorized_calls===Math.min(Number(body.max_calls),(p.tiles as Obj[]).length)&&time(p.planned_at as string)<=time(p.checked_at as string)
  &&time(p.checked_at as string)<=time(batch.created_at as string)&&time(batch.created_at as string)<time(batch.valid_until as string)&&time(batch.created_at as string)<=time(now));
 actionAudit(db,w.id as string,batch,"investor_confirm_epoch_history","investor_epoch_history_request");
 const marker=actionRead(db,"investor_epoch_history_attempts",(db.prepare("SELECT id FROM investor_epoch_history_attempts WHERE slot_id=?").get(slot.id) as Obj|undefined)?.id,w.id as string);
 const reserved=actionJson(marker.document_json,4096);validateHistory("attempt",reserved);actionAudit(db,w.id as string,marker,"investor_reserve_epoch_history","investor_epoch_history_attempt");
 check(canonical(reserved)===marker.document_json&&hash(reserved)===marker.content_hash&&reserved.attempt_id===marker.id&&marker.slot_id===slot.id&&marker.model_id===batch.model_id&&marker.actor_id===actor.id
  &&reserved.job_id===marker.job_id&&reserved.fencing_token===marker.fencing_token&&reserved.created_at===marker.created_at&&reserved.valid_until===batch.valid_until
  &&hash(reserved.slot)===hash(ref(slot))&&hash(reserved.request)===hash(ref(batch))&&time(marker.created_at as string)<=time(now));
 const slots=db.prepare("SELECT * FROM investor_epoch_history_slots WHERE request_id=? ORDER BY slot_index").all(batch.id) as Obj[];
 check(slots.length===batch.authorized_calls);let done=true,available=time(batch.valid_until as string);const entries=slots.map((s,index)=>{
  const tile=(p.tiles as Obj[])[index];check(s.slot_index===index&&s.workspace_id===w.id&&s.model_id===batch.model_id&&s.actor_id===actor.id&&s.created_at===batch.created_at
   &&["listing_id","start_date","end_date"].every(k=>s[k]===tile[k])&&hash({schema_version:"investor-epoch-history-slot-v1",slot_id:s.id,request:ref(batch),index,tile})===s.content_hash);
  actionAudit(db,w.id as string,s,"investor_queue_epoch_history","investor_epoch_history_slot");
  const j=obj(db.prepare("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?").get(JOB,w.id,s.id,s.content_hash));
  check(j.command_request_id===null&&j.max_attempts===1&&[0,1].includes(j.attempt_count as number)&&Number.isSafeInteger(j.fencing_token));
  const a=db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1").get(j.id) as Obj|undefined,ended=terminal.includes(j.status as string)&&j.lease_owner===null&&j.lease_until===null;
  if(j.attempt_count){check(a&&time(j.created_at as string)<=time(a.started_at as string));const expired=j.status==="failed"&&a.status==="lease_expired"&&j.fencing_token===Number(a.fencing_token)+1;
   if(expired)check(hash(actionJson(a.error_json))===hash({code:"LEASE_EXPIRED"})&&hash(actionJson(j.result_json))===hash({code:"LEASE_EXPIRED"}));else check(a.fencing_token===j.fencing_token);
   if(ended)check((a.status===j.status||expired)&&a.finished_at===j.updated_at&&time(a.finished_at as string)<=time(now));
  }else check(!a);
  const u=db.prepare("SELECT * FROM investor_epoch_history_runs WHERE slot_id=?").get(s.id) as Obj|undefined;
  if(u){const d=actionJson(u.document_json,8192);validateHistory("run",d);actionAudit(db,w.id as string,u,"investor_finish_epoch_history","investor_epoch_history_run");
   check(canonical(d)===u.document_json&&hash(d)===u.content_hash&&d.run_id===u.id&&["job_id","attempt_id","capture_id","status","created_at"].every(k=>d[k]===u[k])
    &&obj(d.slot).id===u.slot_id&&d.code==="EPOCH_HISTORY_"+String(u.status).toUpperCase()&&time(u.created_at as string)<=time(now));}
  if(s.id===slot.id)check(marker.job_id===j.id&&a&&marker.fencing_token===a.fencing_token&&j.attempt_count===1&&actionJobStartedByMillisecond(a.started_at as string,marker.created_at as string)&&(!u||u.status==="transport_unknown")&&j.status!=="succeeded","NOT_UNKNOWN");
  done=done&&ended;if(time(j.updated_at as string)>available)available=time(j.updated_at as string);
  return {slot:ref(s),job:pick(j,jobFields),attempt:a?pick(a,attemptFields):null,run:u?ref(u):null};
 });
 const snapshot={batch:ref(batch),slot:ref(slot),attempt:ref(marker),jobs:entries},after=available+30000000n,millis=after/1000n+(after%1000n>0n?1n:0n);
 return {batch:snapshot.batch,slot:snapshot.slot,attempt:snapshot.attempt,state_hash:hash(snapshot),model_id:batch.model_id,
  available_after:new Date(Number(millis)).toISOString(),terminal:done};
}
export function readHistoryResolutionHeader(db:Database.Database,actor:{id:string},id:unknown,now:string){
 const w=workspace(db,actor),row=actionRead(db,"investor_epoch_history_resolutions",id,w.id as string),doc=actionJson(row.document_json,16384);validate("record",doc);const body=historyResolutionSubmitSchema.parse(doc.body);
 actionAudit(db,w.id as string,row,"investor_acknowledge_history_unknown","investor_history_resolution");const state=unknownState(db,w,actor,row.slot_id,now);
 check(canonical(doc)===row.document_json&&hash(doc)===row.content_hash&&doc.resolution_id===row.id&&hash(body)===row.request_hash
  &&["workspace_id","model_id","actor_id","request_hash","created_at"].every(k=>doc[k]===row[k])&&row.actor_id===actor.id&&body.model_id===row.model_id
  &&body.idempotency_key===row.idempotency_key&&body.expected_revision===row.expected_revision&&body.batch.id===row.batch_id&&body.slot.id===row.slot_id&&body.attempt.id===row.attempt_id
  &&["batch","slot","attempt","state_hash"].every(k=>hash(body[k as keyof typeof body])===hash(state[k as keyof typeof state]))&&state.terminal
  &&time(state.available_after)<=time(body.reviewed_at)&&time(body.reviewed_at)<=time(row.created_at as string)&&time(row.created_at as string)<time(body.valid_until)
  &&time(body.valid_until)>time(body.reviewed_at)&&time(body.valid_until)-time(body.reviewed_at)<=300000000n&&time(row.created_at as string)<=time(now));return {row,doc,body};
}
export function readHistoryUnknownReview(db:Database.Database,actor:{id:string},slotId:unknown,now:string){
 const w=workspace(db,actor),state=unknownState(db,w,actor,slotId,now),r=db.prepare("SELECT id FROM investor_epoch_history_resolutions WHERE workspace_id=? AND slot_id=?").get(w.id,slotId) as Obj|undefined;
 const resolution=r?readHistoryResolutionHeader(db,actor,r.id,now).row:null;
 return historyUnknownReviewSchema.parse({batch:state.batch,slot:state.slot,attempt:state.attempt,state_hash:state.state_hash,reviewed_at:now,valid_until:new Date(Date.parse(now)+300000).toISOString(),available_after:state.available_after,
  eligible:!resolution&&state.terminal&&time(state.available_after)<=time(now),resolution:resolution?{...ref(resolution),created_at:resolution.created_at}:null});
}
export function acknowledgeHistoryUnknown(db:Database.Database,actor:{id:string},raw:unknown,now?:string,clock?:()=>string){
 const start=now??new Date().toISOString(),sample=clock??(()=>now??new Date().toISOString());
 const body=historyResolutionSubmitSchema.parse(raw);validate("submit",body);time(start);assertWritableDatabase(db);
 return db.transaction(()=>{
  assertWritableDatabase(db);const w=workspace(db,actor),digest=hash(body),old=db.prepare("SELECT id,request_hash FROM investor_epoch_history_resolutions WHERE workspace_id=? AND idempotency_key=?").get(w.id,body.idempotency_key) as Obj|undefined;
  if(old){check(old.request_hash===digest,"DUPLICATE_CONFLICT");return readHistoryResolutionHeader(db,actor,old.id,start).doc;}
  check(w.revision===body.expected_revision,"VERSION_CHANGED");check(!db.prepare("SELECT 1 FROM investor_epoch_history_resolutions WHERE workspace_id=? AND slot_id=?").get(w.id,body.slot.id),"ALREADY_REVIEWED");
  check(!db.prepare("SELECT 1 FROM investor_epoch_history_intents WHERE workspace_id=? AND idempotency_key=? UNION ALL SELECT 1 FROM investor_epoch_history_requests WHERE workspace_id=? AND idempotency_key=?").get(w.id,body.idempotency_key,w.id,body.idempotency_key),"DUPLICATE_CONFLICT");
  const state=unknownState(db,w,actor,body.slot.id,start);
  check(body.model_id===state.model_id&&["batch","slot","attempt","state_hash"].every(k=>hash(body[k as keyof typeof body])===hash(state[k as keyof typeof state])));
  check(state.terminal&&time(state.available_after)<=time(body.reviewed_at),"WAIT_REQUIRED");
  const checked=sample();check(time(start)<=time(checked)&&time(body.reviewed_at)<=time(checked)&&time(checked)<time(body.valid_until)&&time(body.valid_until)-time(body.reviewed_at)<=300000000n,"EXPIRED");
  const id="history-resolution:"+randomUUID(),audit=randomUUID(),doc={schema_version:"investor-epoch-history-resolution-v1",resolution_id:id,workspace_id:w.id,model_id:body.model_id,actor_id:actor.id,body,request_hash:digest,created_at:checked,
   old_outcome_known:false,new_download_authorized:false,source_eligibility_restored:false,provider_calls:0,monitoring_resumed:false,trading_permission:false};validate("record",doc);const hashed=hash(doc);
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,?,'investor_acknowledge_history_unknown','investor_history_resolution',?,?,?)").run(audit,actor.id,id,canonical({content_hash:hashed}),checked);
  db.prepare("INSERT INTO investor_epoch_history_resolutions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,w.id,body.model_id,body.slot.id,body.attempt.id,body.batch.id,body.expected_revision,body.idempotency_key,digest,canonical(doc),hashed,actor.id,checked,audit);
  check(db.prepare("UPDATE investor_workspaces SET revision=revision+1 WHERE id=? AND revision=?").run(w.id,body.expected_revision).changes===1);assertWritableDatabase(db);
  const finished=sample();check(time(checked)<=time(finished)&&time(finished)<time(body.valid_until),"EXPIRED");return doc;
 }).immediate();
}
