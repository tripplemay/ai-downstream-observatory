import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { canonical, hash } from "../ledger/service";
import { priceInstant as time } from "../market-price-source";
import { actionReviewInputSchema } from "./action-review-schemas";
import { actionAudit, actionJson, actionRead } from "./action-source-proof";
import { readManagedActionProgressRecord } from "./managed-action-source";
import { readActionReviewConfirmationReceipt, readActionReviewPreviewWitness } from "./action-review-lineage";
import { validateInvestorActionReviewDocument, validateInvestorActionReviewJob } from "./kernel-contracts";

type Obj = Record<string, unknown>;
const JOB = "investor_action_review";
function check(value: unknown, code = "INVALID"): asserts value { if (!value) throw new Error("ACTION_REVIEW_JOB_" + code); }
function workspace(db: Database.Database, actor: { id: string }) {
  const row = db.prepare("SELECT * FROM investor_workspaces WHERE owner_id=?").get(actor.id) as Obj | undefined;
  check(row && Number.isSafeInteger(row.revision), "WORKSPACE_REQUIRED"); return row;
}
function header(db: Database.Database, ws: Obj, actor: { id: string }, id: unknown, now: string) {
  const row = actionRead(db, "investor_action_review_job_requests", id, ws.id as string), doc = actionJson(row.document_json, 1048576);
  validateInvestorActionReviewJob("request", doc); const body = doc.body as Obj;
  check(canonical(doc) === row.document_json && hash(doc) === row.content_hash && row.actor_id === actor.id && doc.request_id === row.id);
  for (const key of ["workspace_id", "kind", "request_hash", "created_at", "valid_until"]) check(doc[key] === row[key]);
  check(Number.isSafeInteger(body.expected_revision) && body.expected_revision === row.expected_revision && body.idempotency_key === row.idempotency_key
    && hash(body) === row.request_hash && time(row.created_at) <= time(now) && time(row.valid_until) > time(row.created_at)
    && time(row.valid_until) - time(row.created_at) <= 300000000n);
  actionAudit(db, ws.id as string, row, "investor_enqueue_action_review", "investor_action_review_job_request");
  const grant = readManagedActionProgressRecord(db, ws.id as string, row.authority_id as string, now).grant;
  check(doc.provider_symbol === grant.doc.provider_symbol && grant.row.actor_id === actor.id);
  if (row.kind === "preview") check(body.authority_id === row.authority_id && row.preview_id === null);
  else {
    const preview = readActionReviewPreviewWitness(db, ws.id as string, actor.id, body.preview_id, now);
    check(preview.preview_id === row.preview_id && preview.authority_id === row.authority_id && preview.workspace_revision === row.expected_revision
      && time(row.valid_until) <= time(preview.valid_until));
  }
  return { row, doc, body };
}

/** Persist only explicit owner intent. The worker, not enqueueing, advances CAS. */
export function enqueueActionReviewJob(db: Database.Database, actor: { id: string }, raw: unknown, now = new Date().toISOString()) {
  const input = actionReviewInputSchema.parse(raw); time(now); assertWritableDatabase(db);
  if (input.kind === "confirmation") validateInvestorActionReviewDocument("submit", input.body);
  return db.transaction(() => {
    assertWritableDatabase(db); const ws = workspace(db, actor);
    const nonce = input.kind === "preview" ? input.idempotency_key : input.body.idempotency_key;
    const old = db.prepare("SELECT id,authority_id FROM investor_action_review_job_requests WHERE workspace_id=? AND idempotency_key=?").get(ws.id, nonce) as Obj | undefined;
    if (old) {
      const original = header(db, ws, actor, old.id, now), expected = input.kind === "preview"
        ? { authority_id: old.authority_id, expected_revision: input.expected_revision, idempotency_key: input.idempotency_key } : input.body;
      check(original.row.kind === input.kind && hash(expected) === original.row.request_hash
        && (input.kind !== "preview" || original.doc.provider_symbol === input.symbol), "DUPLICATE_CONFLICT");
      return original.doc;
    }
    const expected = input.kind === "preview" ? input.expected_revision : input.body.expected_revision;
    check(ws.revision === expected, "VERSION_CHANGED");
    const busy = db.prepare(`SELECT 1 FROM investor_action_review_job_requests r LEFT JOIN investor_action_review_job_results u ON u.request_id=r.id
      LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
      WHERE r.workspace_id=? AND r.valid_until>? AND u.id IS NULL AND (j.id IS NULL OR j.status IN ('queued','running','retry_queued')) LIMIT 1`).get(JOB, ws.id, now);
    check(!busy, "BUSY");
    let authorityId: unknown, previewId: unknown = null, until = new Date(Date.parse(now) + 300000).toISOString(), body: Obj;
    if (input.kind === "preview") {
      const rows = db.prepare(`SELECT a.id FROM investor_action_authorities a WHERE a.workspace_id=? AND json_extract(a.document_json,'$.provider_symbol')=?
        AND NOT EXISTS(SELECT 1 FROM investor_action_review_confirmations c WHERE c.previous_authority_id=a.id) ORDER BY a.id LIMIT 2`).all(ws.id, input.symbol) as Obj[];
      check(rows.length === 1, "RULE_UNAVAILABLE"); authorityId = rows[0].id;
      body = { authority_id: authorityId, expected_revision: expected, idempotency_key: nonce };
    } else {
      const preview = readActionReviewPreviewWitness(db, ws.id as string, actor.id, input.body.preview_id, now);
      check(preview.workspace_revision === expected, "VERSION_CHANGED");
      check(time(preview.created_at) <= time(now) && time(now) < time(preview.valid_until), "PREVIEW_EXPIRED");
      authorityId = preview.authority_id; previewId = preview.preview_id;
      if (time(until) > time(preview.valid_until)) until = preview.valid_until as string;
      body = structuredClone(input.body);
    }
    check(!db.prepare("SELECT 1 FROM investor_action_review_confirmations WHERE workspace_id=? AND previous_authority_id=?").get(ws.id, authorityId), "RULE_RETIRED");
    const grant = readManagedActionProgressRecord(db, ws.id as string, authorityId as string, now).grant;
    const leaves=db.prepare(`SELECT a.id FROM investor_action_authorities a WHERE a.workspace_id=? AND json_extract(a.document_json,'$.provider_symbol')=?
      AND NOT EXISTS(SELECT 1 FROM investor_action_review_confirmations c WHERE c.previous_authority_id=a.id) LIMIT 2`).all(ws.id,grant.doc.provider_symbol) as Obj[];
    check(leaves.length === 1 && leaves[0].id === authorityId,"RULE_UNAVAILABLE");
    const id = randomUUID(), digest = hash(body), audit = randomUUID();
    const doc = { schema_version: "investor-action-review-job-request-v1", request_id: id, workspace_id: ws.id,
      provider_symbol: grant.doc.provider_symbol, kind: input.kind, body, request_hash: digest, created_at: now, valid_until: until };
    validateInvestorActionReviewJob("request", doc); const hashed = hash(doc);
    db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,?,'investor_enqueue_action_review','investor_action_review_job_request',?,?,?)")
      .run(audit, actor.id, id, canonical({ content_hash: hashed }), now);
    db.prepare("INSERT INTO investor_action_review_job_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, ws.id, input.kind, authorityId, previewId,
      expected, nonce, digest, canonical(doc), hashed, actor.id, now, until, audit);
    assertWritableDatabase(db);
    return doc;
  }).immediate();
}

/** Header-only symbol discovery; ambiguity is not resolved by newest-wins. */
export function actionReviewSymbols(db:Database.Database,actor:{id:string},now=new Date().toISOString()) {
  const ws=workspace(db,actor);
  const rows=db.prepare(`SELECT a.id FROM investor_action_authorities a WHERE a.workspace_id=?
    AND NOT EXISTS(SELECT 1 FROM investor_action_review_confirmations c WHERE c.previous_authority_id=a.id) ORDER BY a.id LIMIT 1001`).all(ws.id) as Obj[];
  check(rows.length <= 1000);const groups=new Map<string,string[]>();
  for(const row of rows) {
    const symbol=readManagedActionProgressRecord(db,ws.id as string,row.id as string,now).grant.doc.provider_symbol as string;
    groups.set(symbol,[...(groups.get(symbol)??[]),row.id as string]);
  }
  return (["VT.US","BND.US"] as const).filter(symbol=>groups.get(symbol)?.length === 1);
}

/** Metadata-only durable status; preview facts/current admission are separate. */
export function readActionReviewJobStatus(db: Database.Database, actor: { id: string }, id: string | null = null, now = new Date().toISOString(), latest=true) {
  time(now);
  return db.transaction(() => {
    const ws = workspace(db, actor), selected = id ? { id } : latest ? db.prepare("SELECT id FROM investor_action_review_job_requests WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(ws.id) as Obj | undefined : undefined;
    const base = { workspace_id: ws.id, workspace_revision: ws.revision, checked_at: now, research_admitted: false, trading_permission: false, provider_calls: 0 };
    if (!selected) return { ...base, request: null };
    const { row, doc } = header(db, ws, actor, selected.id, now);
    const job = db.prepare("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?").get(JOB, ws.id, row.id, row.content_hash) as Obj | undefined;
    const result = db.prepare("SELECT * FROM investor_action_review_job_results WHERE request_id=? AND workspace_id=?").get(row.id, ws.id) as Obj | undefined;
    let status: string, code: unknown = null, resourceId: unknown = null, resourceHash: unknown = null, resourceUntil: unknown = null;
    if (job) check(job.command_request_id === null && job.max_attempts === 1 && [0, 1].includes(job.attempt_count as number) && time(job.created_at) >= time(row.created_at));
    if (result) {
      check(job && job.status === "succeeded" && job.attempt_count === 1 && job.lease_owner === null && job.lease_until === null);
      const output = actionJson(result.document_json); validateInvestorActionReviewJob("result", output);
      check(canonical(output) === result.document_json && hash(output) === result.content_hash && result.actor_id === actor.id && output.result_id === result.id);
      for (const key of ["request_id", "workspace_id", "job_id", "fencing_token", "kind", "outcome", "resource_id", "resource_hash", "code", "created_at"]) check(output[key] === result[key]);
      check(result.request_id === row.id && result.job_id === job.id && result.kind === row.kind && output.request_hash === row.content_hash && result.fencing_token === job.fencing_token);
      actionAudit(db, ws.id as string, result, "investor_finish_action_review", "investor_action_review_job_result");
      const attempt = db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1").get(job.id) as Obj | undefined;
      check(attempt && attempt.status === "succeeded" && attempt.fencing_token === job.fencing_token && attempt.error_json === null
        && time(attempt.started_at) <= time(result.created_at) && time(result.created_at) <= time(attempt.finished_at) && time(attempt.finished_at) <= time(now)
        && attempt.finished_at === job.updated_at && time(row.created_at) <= time(result.created_at));
      check(canonical(actionJson(job.result_json)) === canonical({ request_id: row.id, result_id: result.id, outcome: result.outcome, code: result.code, research_admitted: false }));
      status = result.outcome as string; code = result.code; resourceId = result.resource_id; resourceHash = result.resource_hash;
      if (status !== "rejected") {
        const resource = row.kind === "preview" ? readActionReviewPreviewWitness(db, ws.id as string, actor.id, resourceId, now)
          : readActionReviewConfirmationReceipt(db, ws.id as string, actor.id, resourceId, now);
        check(hash(resource) === resourceHash && resource.request_hash === row.request_hash && resource.workspace_revision === Number(row.expected_revision) + 1);
        if (status === "preview_ready") {
          resourceUntil = resource.valid_until;
          if (time(now) >= time(resource.valid_until)) status = "expired";
          else if (resource.workspace_revision !== ws.revision) status = "outdated";
        }
      }
    } else if (!job || job.status === "queued") {
      if (job) check(job.attempt_count === 0 && job.fencing_token === 0 && job.lease_owner === null && job.lease_until === null);
      status = time(now) >= time(row.valid_until) ? "expired" : "queued";
    } else if (job.status === "running") {
      check(job.attempt_count === 1 && typeof job.lease_owner === "string");
      status = time(now) < time(job.lease_until) ? "running" : "unknown";
    } else {
      check(["failed", "cancelled", "skipped"].includes(job.status as string)); status = "unknown";
    }
    const clientInput=row.kind === "preview" ? {kind:"preview",symbol:doc.provider_symbol,expected_revision:row.expected_revision,idempotency_key:row.idempotency_key}
      : {kind:"confirmation",body:doc.body};
    return { ...base, request: { id: row.id, kind: row.kind, symbol: doc.provider_symbol, intent_hash:hash(clientInput),created_at: row.created_at,
      valid_until: row.valid_until, status, code, resource_id: resourceId, resource_hash: resourceHash, resource_valid_until: resourceUntil } };
  }).deferred();
}

export function findActionReviewRequest(db:Database.Database,actor:{id:string},nonce:string) {
  const ws=workspace(db,actor),row=db.prepare("SELECT id FROM investor_action_review_job_requests WHERE workspace_id=? AND idempotency_key=?").get(ws.id,nonce) as Obj|undefined;
  return row?.id as string|undefined;
}
