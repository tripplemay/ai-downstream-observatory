import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { canonical, hash } from "../ledger/service";
import { priceInstant as time } from "../market-price-source";
import { actionAudit, actionJson, actionRead } from "./action-source-proof";
import { readCorrectionImpactResponse } from "./correction-impact-jobs";
import { readCorrectionConsentReceipt } from "./correction-consent";
import { validateCorrectionConsent } from "./kernel-contracts";
import { correctionConsentResponseSchema, correctionConsentSubmitSchema } from "./correction-consent-schemas";

type Obj = Record<string, unknown>;
const JOB = "investor_correction_consent";
function check(value: unknown, code = "INVALID"): asserts value { if (!value) throw new Error("CORRECTION_CONSENT_" + code); }
function workspace(db: Database.Database, actor: { id: string }) {
  const row = db.prepare("SELECT * FROM investor_workspaces WHERE owner_id=?").get(actor.id) as Obj | undefined;
  check(row && Number.isSafeInteger(row.revision), "WORKSPACE_REQUIRED"); return row;
}
function header(db: Database.Database, ws: Obj, actor: { id: string }, id: unknown, now: string) {
  const row = actionRead(db, "investor_correction_consent_requests", id, ws.id as string), doc = actionJson(row.document_json, 32768);
  validateCorrectionConsent("request", doc); const body = correctionConsentSubmitSchema.parse(doc.body);
  check(canonical(doc) === row.document_json && hash(doc) === row.content_hash && row.actor_id === actor.id && doc.request_id === row.id
    && hash(body) === row.request_hash && time(row.created_at) <= time(now) && time(row.created_at) < time(row.valid_until)
    && time(row.valid_until) - time(row.created_at) <= 300000000n);
  for (const key of ["workspace_id", "model_id", "request_hash", "created_at", "valid_until"]) check(doc[key] === row[key]);
  for (const key of ["impact_request_id", "expected_revision", "idempotency_key"] as const) check(body[key] === row[key]);
  actionAudit(db, ws.id as string, row, "investor_enqueue_correction_consent", "investor_correction_consent_request");
  readCorrectionImpactResponse(db, actor, "0".repeat(64), { request: body.impact_request_id }, now);
  const impact = db.prepare("SELECT * FROM investor_correction_impact_results WHERE request_id=? AND workspace_id=?").get(body.impact_request_id, ws.id) as Obj | undefined;
  const source = actionRead(db, "investor_correction_impact_requests", body.impact_request_id, ws.id as string);
  check(impact && impact.outcome === "preview_ready" && impact.content_hash === body.expected_result_hash && source.model_id === row.model_id
    && source.expected_revision === row.expected_revision && time(impact.created_at) <= time(row.created_at)
    && time(row.valid_until) <= time((actionJson(impact.document_json, 5242880).impact as Obj).valid_until));
  return { row, doc, body };
}
function candidate(db: Database.Database, ws: Obj, actor: { id: string }, id: string, now: string) {
  const value = readCorrectionImpactResponse(db, actor, "0".repeat(64), { request: id }, now);
  if (!value.summary || value.request?.status !== "preview_ready") return null;
  const result = db.prepare("SELECT content_hash FROM investor_correction_impact_results WHERE request_id=? AND workspace_id=?").get(id, ws.id) as Obj;
  const request = actionRead(db, "investor_correction_impact_requests", id, ws.id as string);
  const body = actionJson(request.document_json).body as { decisions: { choice: string }[] };
  return { impact_request_id: id, impact_result_hash: result.content_hash, model_id: value.request.model_id, preview_id: value.request.preview_id,
    workspace_revision: ws.revision, summary_hash: value.summary_hash, valid_until: value.summary.valid_until,
    all_differences_resolved: body.decisions.length > 0 && body.decisions.every(row => row.choice !== "retain") };
}

/** Bounded owner intent only; actual source/history/economic replay belongs to core. */
export function enqueueCorrectionConsent(db: Database.Database, actor: { id: string }, raw: unknown, now = new Date().toISOString()) {
  const body = correctionConsentSubmitSchema.parse(raw); validateCorrectionConsent("submit", body); time(now); assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db); const ws = workspace(db, actor), digest = hash(body);
    const old = db.prepare("SELECT id,request_hash FROM investor_correction_consent_requests WHERE workspace_id=? AND idempotency_key=?").get(ws.id, body.idempotency_key) as Obj | undefined;
    if (old) { check(old.request_hash === digest, "DUPLICATE_CONFLICT"); return header(db, ws, actor, old.id, now).doc; }
    check(ws.revision === body.expected_revision, "VERSION_CHANGED");
    const current = candidate(db, ws, actor, body.impact_request_id, now);
    check(current && current.impact_result_hash === body.expected_result_hash, "CHANGED");
    check(current.all_differences_resolved, "UNRESOLVED"); check(time(now) < time(current.valid_until), "EXPIRED");
    check(!db.prepare("SELECT 1 FROM investor_correction_consents WHERE workspace_id=? AND impact_request_id=?").get(ws.id, body.impact_request_id), "ALREADY_CONFIRMED");
    check(!db.prepare(`SELECT 1 FROM investor_correction_consent_requests r LEFT JOIN investor_correction_consent_results u ON u.request_id=r.id
      LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
      WHERE r.workspace_id=? AND r.valid_until>? AND u.id IS NULL AND (j.id IS NULL OR j.status IN ('queued','running','retry_queued')) LIMIT 1`).get(JOB, ws.id, now), "BUSY");
    const id = randomUUID(), audit = randomUUID(), until = [current.valid_until, new Date(Date.parse(now) + 300000).toISOString()].sort()[0];
    const doc = { schema_version: "investor-correction-consent-request-v1", request_id: id, workspace_id: ws.id, model_id: current.model_id,
      body, request_hash: digest, created_at: now, valid_until: until };
    validateCorrectionConsent("request", doc); const encoded = canonical(doc), hashed = hash(doc);
    check(Buffer.byteLength(encoded) <= 32768, "INPUT_INVALID");
    db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,?,'investor_enqueue_correction_consent','investor_correction_consent_request',?,?,?)")
      .run(audit, actor.id, id, canonical({ content_hash: hashed }), now);
    db.prepare("INSERT INTO investor_correction_consent_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, ws.id, current.model_id, body.impact_request_id,
      body.expected_revision, body.idempotency_key, digest, encoded, hashed, actor.id, now, until, audit); assertWritableDatabase(db); return doc;
  }).immediate();
}

/** Reads bounded completed-work metadata only, never the raw replay or baseline. */
export function readCorrectionConsentResponse(db: Database.Database, actor: { id: string }, binding: string,
  selection: { request?: string; nonce?: string; impact?: string; model?: string }, now = new Date().toISOString()) {
  time(now);
  return db.transaction(() => {
    const ws = workspace(db, actor);
    const selected = selection.request ? { id: selection.request } : selection.nonce ? db.prepare("SELECT id FROM investor_correction_consent_requests WHERE workspace_id=? AND idempotency_key=?").get(ws.id, selection.nonce)
      : selection.impact ? db.prepare("SELECT id FROM investor_correction_consent_requests WHERE workspace_id=? AND impact_request_id=? ORDER BY rowid DESC LIMIT 1").get(ws.id, selection.impact)
      : selection.model ? db.prepare("SELECT id FROM investor_correction_consent_requests WHERE workspace_id=? AND model_id=? ORDER BY rowid DESC LIMIT 1").get(ws.id, selection.model) : undefined;
    let request: Obj | null = null, receipt: Obj | null = null;
    if (selected) {
      const { row, body } = header(db, ws, actor, (selected as Obj).id, now);
      const job = db.prepare("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?").get(JOB, ws.id, row.id, row.content_hash) as Obj | undefined;
      const result = db.prepare("SELECT * FROM investor_correction_consent_results WHERE workspace_id=? AND request_id=?").get(ws.id, row.id) as Obj | undefined;
      let status = "queued", code: unknown = null;
      if (job) check(job.command_request_id === null && job.max_attempts === 1 && [0, 1].includes(job.attempt_count as number));
      if (result) {
        check(job && job.status === "succeeded" && job.attempt_count === 1 && job.lease_owner === null && job.lease_until === null);
        const doc = actionJson(result.document_json, 32768); validateCorrectionConsent("result", doc);
        check(canonical(doc) === result.document_json && hash(doc) === result.content_hash && result.actor_id === actor.id && doc.result_id === result.id
          && doc.request_hash === row.content_hash && result.job_id === job.id && result.fencing_token === job.fencing_token);
        for (const key of ["request_id", "workspace_id", "job_id", "fencing_token", "outcome", "code", "confirmation_id", "created_at"]) check(doc[key] === result[key]);
        actionAudit(db, ws.id as string, result, "investor_finish_correction_consent", "investor_correction_consent_result");
        const attempt = db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1").get(job.id) as Obj | undefined;
        check(attempt && attempt.status === "succeeded" && attempt.fencing_token === job.fencing_token && attempt.error_json === null
          && time(row.created_at) <= time(attempt.started_at) && time(attempt.started_at) <= time(result.created_at)
          && time(result.created_at) <= time(attempt.finished_at) && time(attempt.finished_at) === time(job.updated_at) && time(job.updated_at) <= time(now)
          && canonical(actionJson(job.result_json)) === canonical({ request_id: row.id, result_id: result.id, outcome: result.outcome, code: result.code, research_admitted: false }));
        status = result.outcome as string; code = result.code;
        if (status === "confirmed") receipt = readCorrectionConsentReceipt(db, ws.id as string, actor, result.confirmation_id as string, now);
      } else if (!job || job.status === "queued") {
        if (job) check(job.attempt_count === 0 && job.fencing_token === 0 && job.lease_owner === null && job.lease_until === null);
        if (time(now) >= time(row.valid_until)) status = "expired";
      } else if (job.status === "running") { check(job.attempt_count === 1); status = time(now) < time(job.lease_until) ? "running" : "unknown"; }
      else { check(["failed", "cancelled", "skipped"].includes(job.status as string)); status = "unknown"; }
      request = { id: row.id, model_id: row.model_id, impact_request_id: row.impact_request_id, intent_hash: hash(body), created_at: row.created_at, valid_until: row.valid_until, status, code };
    }
    const current = !request && selection.impact ? candidate(db, ws, actor, selection.impact, now) : null;
    let readOnly = false; try { assertWritableDatabase(db); } catch (error) { if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") readOnly = true; else throw error; }
    return correctionConsentResponseSchema.parse({ schema_version: "investor-correction-consent-response-v1", workspace_id: ws.id, workspace_revision: ws.revision,
      checked_at: now, refresh_after: new Date(Math.min(Date.parse(now) + 15000, current ? Date.parse(current.valid_until) : Infinity)).toISOString(),
      session_binding: binding, lookup_nonce: selection.nonce ?? null, read_only: readOnly, candidate: current, request, receipt,
      visibility: "private_owner_only_not_ai", provider_calls: 0, trading_permission: false });
  }).deferred();
}
