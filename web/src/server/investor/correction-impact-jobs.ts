import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { canonical, hash } from "../ledger/service";
import { priceInstant as time } from "../market-price-source";
import { actionAudit, actionJson, actionRead } from "./action-source-proof";
import { readActionReviewPreviewWitness } from "./action-review-lineage";
import { correctionChangeFence } from "./correction-change-fence";
import { correctionImpactInputSchema, correctionImpactResponseSchema } from "./correction-impact-schemas";
import { validateActionCorrectionImpact, validateCorrectionImpactJob } from "./kernel-contracts";

type Obj = Record<string, unknown>;
const JOB = "investor_correction_impact";
function check(value: unknown, code = "INVALID"): asserts value { if (!value) throw new Error("CORRECTION_IMPACT_" + code); }
function workspace(db: Database.Database, actor: { id: string }) {
  const row = db.prepare("SELECT * FROM investor_workspaces WHERE owner_id=?").get(actor.id) as Obj | undefined;
  check(row && Number.isSafeInteger(row.revision), "WORKSPACE_REQUIRED"); return row;
}
function header(db: Database.Database, ws: Obj, actor: { id: string }, id: unknown, now: string) {
  const row = actionRead(db, "investor_correction_impact_requests", id, ws.id as string), doc = actionJson(row.document_json, 1048576);
  validateCorrectionImpactJob("request", doc); const body = doc.body as Obj;
  check(canonical(doc) === row.document_json && hash(doc) === row.content_hash && row.actor_id === actor.id && doc.request_id === row.id
    && hash(body) === row.request_hash && Number.isSafeInteger(body.expected_revision) && time(row.created_at) <= time(now)
    && time(row.valid_until) > time(row.created_at) && time(row.valid_until) - time(row.created_at) <= 300000000n);
  for (const key of ["workspace_id", "request_hash", "created_at", "valid_until"]) check(doc[key] === row[key]);
  for (const key of ["model_id", "preview_id", "expected_revision", "idempotency_key"]) check(body[key] === row[key]);
  actionAudit(db, ws.id as string, row, "investor_enqueue_correction_impact", "investor_correction_impact_request");
  const preview = readActionReviewPreviewWitness(db, ws.id as string, actor.id, row.preview_id, now);
  check(preview.workspace_revision === row.expected_revision && time(preview.created_at) <= time(row.created_at) && time(row.valid_until) <= time(preview.valid_until));
  return { row, doc, body, preview };
}

/** Short explicit intent only. No source/history calculation, approval or CAS advance. */
export function enqueueCorrectionImpact(db: Database.Database, actor: { id: string }, raw: unknown, now = new Date().toISOString()) {
  const body = correctionImpactInputSchema.parse(raw); validateActionCorrectionImpact("request", body); time(now); assertWritableDatabase(db);
  check(Buffer.byteLength(canonical(body)) <= 524288, "INPUT_INVALID");
  return db.transaction(() => {
    assertWritableDatabase(db); const ws = workspace(db, actor), digest = hash(body);
    const old = db.prepare("SELECT id,request_hash FROM investor_correction_impact_requests WHERE workspace_id=? AND idempotency_key=?").get(ws.id, body.idempotency_key) as Obj | undefined;
    if (old) { check(old.request_hash === digest, "DUPLICATE_CONFLICT"); return header(db, ws, actor, old.id, now).doc; }
    check(ws.revision === body.expected_revision, "VERSION_CHANGED");
    const preview = readActionReviewPreviewWitness(db, ws.id as string, actor.id, body.preview_id, now);
    check(preview.workspace_revision === body.expected_revision, "VERSION_CHANGED");
    check(time(preview.created_at) <= time(now) && time(now) < time(preview.valid_until), "EXPIRED");
    check(db.prepare("SELECT 1 FROM investor_models WHERE id=? AND workspace_id=?").get(body.model_id, ws.id), "MODEL_REQUIRED");
    check(!db.prepare(`SELECT 1 FROM investor_correction_impact_requests r LEFT JOIN investor_correction_impact_results u ON u.request_id=r.id
      LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
      WHERE r.workspace_id=? AND r.valid_until>? AND u.id IS NULL AND (j.id IS NULL OR j.status IN ('queued','running','retry_queued')) LIMIT 1`).get(JOB, ws.id, now), "BUSY");
    const until = [preview.valid_until as string, new Date(Date.parse(now) + 300000).toISOString()].sort()[0], id = randomUUID(), audit = randomUUID();
    const doc = { schema_version: "investor-correction-impact-job-request-v1", request_id: id, workspace_id: ws.id, body,
      request_hash: digest, created_at: now, valid_until: until };
    validateCorrectionImpactJob("request", doc); const hashed = hash(doc);
    db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,?,'investor_enqueue_correction_impact','investor_correction_impact_request',?,?,?)")
      .run(audit, actor.id, id, canonical({ content_hash: hashed }), now);
    db.prepare("INSERT INTO investor_correction_impact_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, ws.id, body.model_id, body.preview_id, body.expected_revision,
      body.idempotency_key, digest, canonical(doc), hashed, actor.id, now, until, audit); assertWritableDatabase(db); return doc;
  }).immediate();
}

/** GET reads immutable completed-work metadata/derived display only, never a replay. */
export function readCorrectionImpactResponse(db: Database.Database, actor: { id: string }, binding: string,
  selection: { request?: string; nonce?: string; preview?: string } = {}, now = new Date().toISOString()) {
  time(now);
  return db.transaction(() => {
    const ws = workspace(db, actor);
    const selected = selection.request ? { id: selection.request } : selection.nonce ? db.prepare("SELECT id FROM investor_correction_impact_requests WHERE workspace_id=? AND idempotency_key=?").get(ws.id, selection.nonce)
      : selection.preview ? db.prepare("SELECT id FROM investor_correction_impact_requests WHERE workspace_id=? AND preview_id=? ORDER BY rowid DESC LIMIT 1").get(ws.id, selection.preview) : undefined;
    let request: Obj | null = null, summary: Obj | null = null;
    if (selected) {
      const { row, body } = header(db, ws, actor, (selected as Obj).id, now);
      const job = db.prepare("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?").get(JOB, ws.id, row.id, row.content_hash) as Obj | undefined;
      const result = db.prepare("SELECT * FROM investor_correction_impact_results WHERE workspace_id=? AND request_id=?").get(ws.id, row.id) as Obj | undefined;
      let status = "queued", code: unknown = null;
      if (job) check(job.command_request_id === null && job.max_attempts === 1 && [0, 1].includes(job.attempt_count as number));
      if (result) {
        check(job && job.status === "succeeded" && job.attempt_count === 1 && job.lease_owner === null && job.lease_until === null);
        const doc = actionJson(result.document_json, 5242880); validateCorrectionImpactJob("result", doc);
        check(canonical(doc) === result.document_json && hash(doc) === result.content_hash && result.actor_id === actor.id && doc.result_id === result.id
          && doc.request_hash === row.content_hash && result.job_id === job.id && result.fencing_token === job.fencing_token);
        for (const key of ["request_id", "workspace_id", "job_id", "fencing_token", "outcome", "code", "created_at"]) check(doc[key] === result[key]);
        actionAudit(db, ws.id as string, result, "investor_finish_correction_impact", "investor_correction_impact_result");
        const attempt = db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1").get(job.id) as Obj | undefined;
        check(attempt && attempt.status === "succeeded" && attempt.fencing_token === job.fencing_token && attempt.error_json === null
          && time(attempt.started_at) <= time(result.created_at) && time(result.created_at) <= time(attempt.finished_at) && time(attempt.finished_at) <= time(now)
          && attempt.finished_at === job.updated_at && time(row.created_at) <= time(result.created_at));
        check(canonical(actionJson(job.result_json)) === canonical({ request_id: row.id, result_id: result.id, outcome: result.outcome, code: result.code, research_admitted: false }));
        status = result.outcome as string; code = result.code;
        if (status === "preview_ready") {
          const impact = doc.impact as Obj; validateActionCorrectionImpact("result", impact);
          check(impact.workspace_id === ws.id && impact.model_id === row.model_id && impact.preview_id === row.preview_id && impact.request_hash === row.request_hash
            && impact.workspace_revision === row.expected_revision && time(row.created_at) <= time(impact.checked_at) && time(impact.checked_at) <= time(result.created_at));
          if (time(now) >= time(impact.valid_until)) status = "expired";
          else if (ws.revision !== row.expected_revision || correctionChangeFence(db, ws.id as string, actor) !== doc.change_fence) status = "outdated";
          else {
            const comparison = impact.comparison as Obj, original = comparison.original as Obj, hypothetical = comparison.restated as Obj, delta = comparison.delta as Obj;
            const history = impact.original_history as { input_bindings: { created_at: string }[] };
            summary = { checked_at: impact.checked_at, valid_until: impact.valid_until, original_checkpoint_at: history.input_bindings.at(-1)!.created_at,
              original_valuation_cny: comparison.original_valuation_cny, hypothetical_valuation_cny: comparison.restated_valuation_cny, difference_cny: comparison.difference_cny,
              original_quantities: original.quantities, hypothetical_quantities: hypothetical.quantities, cash_delta: delta.cash_by_currency,
              receivable_delta: delta.receivables_by_currency, ignored_new_report_dates: impact.ignored_new_report_dates,
              basis: "stored_hypothetical_result_at_original_prices_not_current_nav", economic_correction_approved: false, monitoring_resumed: false, trading_permission: false };
          }
        }
      } else if (!job || job.status === "queued") {
        if (job) check(job.attempt_count === 0 && job.fencing_token === 0 && job.lease_owner === null && job.lease_until === null);
        if (time(now) >= time(row.valid_until)) status = "expired";
      } else if (job.status === "running") { check(job.attempt_count === 1); status = time(now) < time(job.lease_until) ? "running" : "unknown"; }
      else { check(["failed", "cancelled", "skipped"].includes(job.status as string)); status = "unknown"; }
      request = { id: row.id, model_id: row.model_id, preview_id: row.preview_id, intent_hash: hash(body), created_at: row.created_at, valid_until: row.valid_until, status, code };
    }
    let readOnly = false; try { assertWritableDatabase(db); } catch (error) { if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") readOnly = true; else throw error; }
    return correctionImpactResponseSchema.parse({ schema_version: "investor-correction-impact-response-v1", workspace_id: ws.id, workspace_revision: ws.revision,
      checked_at: now, refresh_after: new Date(Math.min(Date.parse(now) + 15000, summary ? Date.parse(summary.valid_until as string) : Infinity)).toISOString(),
      session_binding: binding, lookup_nonce: selection.nonce ?? null, read_only: readOnly, request, summary, summary_hash: summary ? hash(summary) : null,
      visibility: "private_owner_only_not_ai", provider_calls: 0, economic_correction_approved: false, trading_permission: false });
  }).deferred();
}
