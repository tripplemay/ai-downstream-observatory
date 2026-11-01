import type Database from "better-sqlite3";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import common from "../../../../contracts/v1/common.schema.json";
import issuerAuthoritySchema from "../../../../contracts/v1/investor-issuer-authority.schema.json";
import issuerSchema from "../../../../contracts/v1/investor-issuer-capture.schema.json";
import issuerScheduleSchema from "../../../../contracts/v1/investor-issuer-schedule.schema.json";
import eodhdSchema from "../../../../contracts/v1/investor-eodhd-source.schema.json";
import maintenanceSchema from "../../../../contracts/v1/investor-action-maintenance.schema.json";
import { canonical, hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";
import { parseStrictJson } from "../strict-json";
import { actionAddDays, actionCheck as check, actionDeadline, actionNyParts, actionObject as object,
  actionSha, actionText, eodhdActionUrl, eodhdActionWindow, issuerDistributionUrl,
  replayEodhdActionDraft, replayIssuerActionDraft } from "./action-source-parsers";
import type { ActionObject as Obj } from "./action-source-parsers";

const schemas = { issuerAuthority:issuerAuthoritySchema, issuer:issuerSchema, issuerSchedule:issuerScheduleSchema,
  eodhd:eodhdSchema, maintenance:maintenanceSchema };
type Schema = keyof typeof schemas;
export type ActionSourceKind = "issuer"|"eodhd";
const ajv = new Ajv2020({strict:true,strictRequired:false}); addFormats(ajv); ajv.addSchema(common);
for (const schema of Object.values(schemas)) ajv.addSchema(schema);
export function actionJson(value: unknown, maximum=32768): Obj {
  check(typeof value === "string" && Buffer.byteLength(value) <= maximum); return object(parseStrictJson(value));
}
export function actionRead(db: Database.Database, table: string, id: unknown, workspace: string): Obj {
  const row=db.prepare(`SELECT * FROM ${table} WHERE id=? AND workspace_id=?`).get(id,workspace) as Obj|undefined;check(row);return row;
}
export function actionSeal(row:Obj, schema:Schema, fragment:string|null, now:string):Obj {
  const doc=actionJson(row.document_json), validate=ajv.getSchema(schemas[schema].$id+(fragment ? "#/$defs/"+fragment : ""));
  check(validate?.(doc) && canonical(doc) === row.document_json && hash(doc) === row.content_hash
    && priceInstant(row.created_at) <= priceInstant(now));return doc;
}
export function actionAudit(db:Database.Database, workspace:string, row:Obj, action:string, kind:string, payload?:Obj) {
  const owner=db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as Obj|undefined;
  const event=db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.audit_id) as Obj|undefined;
  check(owner?.owner_id === row.actor_id && event && event.actor_id === row.actor_id && event.action === action
    && event.object_type === kind && event.object_id === row.id && event.created_at === row.created_at);
  check(hash(actionJson(event.payload_json)) === hash(payload ?? {content_hash:row.content_hash}));
}
export function actionMillis(at:unknown):string {
  const text=actionText(at);priceInstant(text);check(/\.\d{3}Z$/.test(text));return text;
}
function control(db:Database.Database,workspace:string,row:Obj,authority:Obj,kind:ActionSourceKind,now:string) {
  const doc=actionSeal(row,kind,"control",now);
  actionAudit(db,workspace,row,`investor_control_${kind}_authority`,`investor_${kind}_control`);
  check(row.workspace_id === workspace && row.actor_id === authority.actor_id && row.authority_id === doc.authority_id
    && doc.authority_id === authority.id && doc.authority_hash === authority.content_hash && row.version === doc.version
    && [0,1].includes(row.enabled as number) && doc.enabled === !!row.enabled && doc.created_at === row.created_at
    && priceInstant(authority.created_at) <= priceInstant(row.created_at));return doc;
}
export function readActionSourceAuthority(db:Database.Database,workspace:string,id:unknown,kind:ActionSourceKind,now:string) {
  check(kind === "issuer" || kind === "eodhd");
  const row=actionRead(db,`investor_${kind}_authorities`,id,workspace),doc=actionSeal(row,kind === "issuer" ? "issuerAuthority":"eodhd",kind === "issuer" ? null:"policy",now);
  actionAudit(db,workspace,row,`investor_register_${kind}_authority`,`investor_${kind}_authority`);
  check(priceInstant(doc.valid_from) < priceInstant(doc.valid_until));
  let current:Obj;
  if(kind === "eodhd") {
    actionMillis(doc.valid_from);actionMillis(doc.valid_until);
    const controls=db.prepare("SELECT * FROM investor_eodhd_controls WHERE authority_id=? ORDER BY version LIMIT 1001").all(id) as Obj[];
    check(controls.length > 0 && controls.length <= 1000);let previous=row.created_at;
    controls.forEach((entry,index)=>{control(db,workspace,entry,row,kind,now);check(entry.version === index+1
      && priceInstant(previous) <= priceInstant(entry.created_at) && (index !== 0 || entry.enabled === 0));previous=entry.created_at;});
    current=controls.at(-1)!;
  } else {
    current=object(db.prepare("SELECT * FROM investor_issuer_controls WHERE authority_id=? AND workspace_id=? ORDER BY version DESC LIMIT 1").get(id,workspace));
    control(db,workspace,current,row,kind,now);issuerDistributionUrl(doc.fund_id,doc.has_distribution_yield);
  }
  return {row,doc,current};
}
export function actionSourceActive(grant:ReturnType<typeof readActionSourceAuthority>,at:string) {
  return grant.current.enabled === 1 && priceInstant(grant.doc.valid_from) <= priceInstant(at) && priceInstant(at) < priceInstant(grant.doc.valid_until);
}
function retainedTenYears(at:unknown) {
  const date=new Date(actionMillis(at)),month=date.getUTCMonth();date.setUTCFullYear(date.getUTCFullYear()+10);
  if(date.getUTCMonth() !== month) date.setUTCDate(0);return date.toISOString();
}
function jobProof(db:Database.Database,workspace:string,capture:Obj,receipt:Obj,request:Obj,now:string,jobId:unknown,period:unknown,type:string) {
  const job=object(db.prepare("SELECT * FROM job_runs WHERE id=?").get(jobId));
  const attempt=object(db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1").get(jobId));
  check(job.job_type === type && job.scope === workspace && job.period === period && job.input_version === request.content_hash
    && job.command_request_id === null && job.attempt_count === 1 && job.max_attempts === 1 && attempt.attempt === 1
    && job.status === "succeeded" && attempt.status === "succeeded" && job.fencing_token === attempt.fencing_token
    && job.fencing_token === receipt.fencing_token);
  const started=priceInstant(attempt.started_at)/1000n*1000n, finished=priceInstant(attempt.finished_at)/1000n*1000n;
  check(started <= priceInstant(capture.created_at) && priceInstant(capture.created_at) <= finished && finished <= priceInstant(now));
  check(hash(actionJson(job.result_json)) === hash({capture_id:capture.id,code:receipt.reason_code,research_admitted:false}));return {job,attempt};
}
function scheduledIssuerProof(db:Database.Database,workspace:string,capture:Obj,request:Obj,requested:Obj,parent:Obj,now:string) {
  const scheduled=db.prepare("SELECT * FROM investor_issuer_schedule_requests WHERE issuer_request_id=? AND workspace_id=?").get(request.id,workspace) as Obj|undefined;
  if(!scheduled) return;
  const doc=actionSeal(scheduled,"issuerSchedule","request",now);
  actionAudit(db,workspace,scheduled,"investor_schedule_issuer_capture","investor_issuer_schedule_request");
  const schedule=actionRead(db,"investor_issuer_schedules",scheduled.schedule_id,workspace),policy=actionSeal(schedule,"issuerSchedule","policy",now);
  actionAudit(db,workspace,schedule,"investor_register_issuer_schedule","investor_issuer_schedule");
  const original=actionRead(db,"investor_issuer_schedule_controls",scheduled.control_id,workspace),enabled=actionSeal(original,"issuerSchedule","control",now);
  actionAudit(db,workspace,original,"investor_control_issuer_schedule","investor_issuer_schedule_control");
  for(const key of ["workspace_id","schedule_id","control_id","issuer_request_id","created_at","valid_until"])check(doc[key] === scheduled[key]);
  check(schedule.authority_id === policy.authority_id && schedule.authority_id === request.authority_id
    && policy.authority_hash === requested.authority_hash && scheduled.actor_id === request.actor_id && schedule.actor_id === request.actor_id
    && original.actor_id === request.actor_id && original.schedule_id === schedule.id && original.enabled === 1
    && enabled.schedule_id === schedule.id && enabled.schedule_hash === schedule.content_hash && enabled.version === original.version
    && enabled.enabled === true && enabled.created_at === original.created_at && doc.schedule_hash === schedule.content_hash
    && doc.control_hash === original.content_hash && doc.issuer_request_hash === request.content_hash
    && priceInstant(schedule.created_at) <= priceInstant(original.created_at) && priceInstant(original.created_at) <= priceInstant(scheduled.created_at)
    && scheduled.created_at === request.created_at && priceInstant(policy.valid_from) <= priceInstant(scheduled.created_at)
    && priceInstant(scheduled.created_at) < priceInstant(policy.valid_until) && actionNyParts(scheduled.created_at).hour >= Number(policy.run_after_hour)
    && priceInstant(parent.valid_from) <= priceInstant(policy.valid_from) && priceInstant(policy.valid_until) <= priceInstant(parent.valid_until)
    && scheduled.valid_until === actionDeadline(scheduled.created_at,policy.valid_until)
    && requested.end_date === request.issuer_day && requested.start_date === actionAddDays(request.issuer_day,1-Number(policy.lookback_days)));
  const result=object(db.prepare("SELECT * FROM investor_issuer_schedule_results WHERE request_id=? AND workspace_id=?").get(scheduled.id,workspace));
  const resultDoc=actionSeal(result,"issuerSchedule","result",now);
  actionAudit(db,workspace,result,"investor_finish_issuer_schedule","investor_issuer_schedule_result");
  for(const key of ["workspace_id","request_id","job_id","capture_id","created_at"]) check(resultDoc[key] === result[key]);
  check(result.actor_id === request.actor_id && result.request_id === scheduled.id && result.capture_id === capture.id && resultDoc.status === "captured"
    && result.created_at === capture.created_at && resultDoc.request_hash === scheduled.content_hash && resultDoc.capture_hash === capture.content_hash);
  jobProof(db,workspace,capture,{fencing_token:resultDoc.fencing_token,reason_code:"ISSUER_DRAFT_CAPTURED"},scheduled,now,result.job_id,scheduled.id,"investor_issuer_capture");
}

/** Authenticate retained receipt metadata even after permission expiry; not raw admission. */
export function readActionCaptureHeader(db:Database.Database,workspace:string,id:unknown,kind:ActionSourceKind,now:string) {
  check(kind === "issuer" || kind === "eodhd");
  const row=actionRead(db,`investor_${kind}_captures`,id,workspace),doc=actionSeal(row,kind,kind === "issuer" ? "result":"capture",now);
  actionAudit(db,workspace,row,`investor_finish_${kind}_capture`,`investor_${kind}_capture`);
  const request=actionRead(db,`investor_${kind}_requests`,row.request_id,workspace),requested=actionSeal(request,kind,"request",now);
  actionAudit(db,workspace,request,kind === "issuer" ? "investor_start_issuer_capture":"investor_schedule_eodhd_capture",`investor_${kind}_request`);
  const grant=readActionSourceAuthority(db,workspace,request.authority_id,kind,now);
  const original=actionRead(db,`investor_${kind}_controls`,request.control_id,workspace);control(db,workspace,original,grant.row,kind,now);
  for(const key of ["workspace_id","request_id","qualification","status","raw_sha256","raw_bytes","created_at","retain_until"])check(row[key] === doc[key]);
  check(doc.capture_id === row.id && doc.request_hash === request.content_hash && row.actor_id === request.actor_id
    && row.actor_id === grant.row.actor_id && original.enabled === 1 && requested.authority_id === grant.row.id
    && requested.control_id === original.id && requested.authority_hash === grant.row.content_hash && requested.control_hash === original.content_hash
    && requested.created_at === request.created_at && priceInstant(grant.row.created_at) <= priceInstant(original.created_at)
    && priceInstant(original.created_at) <= priceInstant(request.created_at) && priceInstant(request.created_at) <= priceInstant(row.created_at)
    && priceInstant(grant.doc.valid_from) <= priceInstant(request.created_at) && priceInstant(request.created_at) < priceInstant(grant.doc.valid_until)
    && row.status === "captured" && row.qualification === `isolated_fixed_${kind === "issuer" ? "issuer":"eodhd"}_https`);
  const day=actionNyParts(request.created_at);
  let attempt:Obj|null=null;
  if(kind === "issuer") {
    for(const key of ["authority_id","control_id","request_key","fund_id","issuer_day"])check(requested[key] === request[key]);
    check(request.fund_id === grant.doc.fund_id && request.issuer_day === day.day && doc.parser_version === "vanguard-distributions-draft-v1");
    const retain=[priceInstant(grant.doc.valid_until),priceInstant(row.created_at)+BigInt(grant.doc.retention_days as number)*86400000000n].reduce((a,b)=>a<b?a:b);
    check(priceInstant(row.retain_until) === retain);scheduledIssuerProof(db,workspace,row,request,requested,grant.doc,now);
  } else {
    const parameters=object(requested.parameters);
    for(const key of ["authority_id","control_id","source_day","created_at","valid_until"])check(requested[key] === request[key]);
    check(request.kind === parameters.kind && request.symbol === parameters.symbol
      && request.source_day === day.day && day.hour >= 1 && request.valid_until === actionDeadline(request.created_at,grant.doc.valid_until)
      && hash(eodhdActionWindow(request.created_at)) === hash({start_date:parameters.start_date,end_date:parameters.end_date})
      && doc.job_id === row.job_id && doc.fencing_token === row.fencing_token && doc.parser_version === "eodhd-action-draft-v1"
      && row.retain_until === retainedTenYears(row.created_at));
    attempt=jobProof(db,workspace,row,doc,request,now,row.job_id,request.id,"investor_eodhd_capture").attempt;
  }
  check(priceInstant(row.created_at) < priceInstant(row.retain_until));
  const purge=db.prepare(`SELECT * FROM investor_${kind}_purges WHERE capture_id=? AND workspace_id=?`).get(row.id,workspace) as Obj|undefined;
  if(purge) {
    const event=object(db.prepare("SELECT * FROM audit_events WHERE id=?").get(purge.audit_id));
    const owner=object(db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace));
    check(purge.actor_id === owner.owner_id && priceInstant(purge.created_at) <= priceInstant(now)
      && (purge.reason === "retention_expired" || kind === "issuer" && purge.reason === "authority_no_longer_active")
      && event.actor_id === purge.actor_id && event.action === `investor_purge_${kind}_capture`
      && event.object_type === `investor_${kind}_capture` && event.object_id === row.id && event.created_at === purge.created_at
      && hash(actionJson(event.payload_json)) === hash({reason:purge.reason}));
  }
  return {row,doc,request,requested,grant,original,attempt,purge};
}

export function replayActionSourceCapture(db:Database.Database,workspace:string,id:unknown,kind:ActionSourceKind,now:string) {
  const header=readActionCaptureHeader(db,workspace,id,kind,now),{row,doc,request,requested,grant,original,purge,attempt}=header;
  check(actionSourceActive(grant,now) && grant.current.id === original.id && !purge && priceInstant(now) < priceInstant(row.retain_until));
  const payload=object(db.prepare(`SELECT * FROM investor_${kind}_payloads WHERE workspace_id=? AND raw_sha256=?`).get(workspace,row.raw_sha256));
  check(Buffer.isBuffer(payload.payload) && payload.raw_bytes === row.raw_bytes && payload.payload.length === row.raw_bytes
    && payload.payload.length > 0 && payload.payload.length <= (kind === "issuer" ? 1048576:262144) && actionSha(payload.payload) === row.raw_sha256);
  const raw=payload.payload,transport=object(doc.transport),before=kind === "issuer" ? request.created_at:attempt!.started_at;
  check(transport.raw_bytes === row.raw_bytes && transport.raw_sha256 === row.raw_sha256 && transport.http_status === 200
    && transport.redirects_followed === 0 && transport.retrieved_at === transport.completed_at
    && priceInstant(before) <= priceInstant(transport.started_at) && priceInstant(transport.started_at) <= priceInstant(transport.completed_at)
    && priceInstant(transport.completed_at) <= priceInstant(row.created_at)+1000n);
  let draft;
  if(kind === "issuer") {
    const mapping={fund_id:grant.doc.fund_id,has_distribution_yield:grant.doc.has_distribution_yield};
    check(hash(transport.request) === hash(mapping) && transport.source_url === issuerDistributionUrl(mapping.fund_id,mapping.has_distribution_yield));
    const headers=object(transport.headers);
    check(Object.values(headers).every(text=>typeof text === "string" && [...text].length <= 1024 && [...text].every(char=>char.codePointAt(0)! >= 32 && char.codePointAt(0) !== 127)));
    const parts=actionText(headers["content-type"]).split(";"),charset=parts.slice(1).filter(part=>/^\s*charset\s*=/i.test(part));
    check(parts[0].trim().toLowerCase() === "application/json" && charset.length <= 1
      && (!charset.length || /^\s*charset\s*=\s*(?:"(?:utf-8|utf8)"|utf-8|utf8)\s*$/i.test(charset[0])));
    if(headers["content-length"] !== undefined)check(/^[0-9]{1,7}$/.test(actionText(headers["content-length"])) && Number(headers["content-length"]) === raw.length);
    draft=replayIssuerActionDraft(raw,{...mapping,start_date:requested.start_date,end_date:requested.end_date,retrieved_at:transport.retrieved_at});
  } else {
    const parameters=object(requested.parameters);
    check(hash(transport.request) === hash(parameters) && transport.url_without_credentials === eodhdActionUrl(parameters));
    draft=replayEodhdActionDraft(raw,{...parameters,retrieved_at:transport.retrieved_at});
  }
  check(hash(draft) === doc.draft_hash);
  return {...header,draft,binding:{capture_id:row.id,capture_hash:row.content_hash,raw_sha256:row.raw_sha256,raw_bytes:row.raw_bytes,
    qualification:row.qualification,retain_until:row.retain_until,authority_id:grant.row.id,authority_hash:grant.row.content_hash,
    control_id:original.id,control_hash:original.content_hash}};
}
