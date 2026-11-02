import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { canonical, hash } from "../ledger/service";
import { priceInstant as time } from "../market-price-source";
import { actionAudit, actionJson, actionRead } from "./action-source-proof";
import { validateLegacyTransitionJob, validateLegacyTransitionWorkflow, validateInvestorModelDocument, validateInvestorMonitorDataDocument } from "./kernel-contracts";
import { readLegacyTransitionPreviewWitness, readLegacyTransitionRegistrationReceipt } from "./legacy-action-transition";
import { legacyTransitionInputSchema } from "./legacy-transition-schemas";

type Obj = Record<string, unknown>;
const JOB = "investor_legacy_transition";
function check(value: unknown, code = "INVALID"): asserts value { if (!value) throw new Error("LEGACY_TRANSITION_JOB_" + code); }
function workspace(db: Database.Database, actor: { id: string }) {
  const ws = db.prepare("SELECT * FROM investor_workspaces WHERE owner_id=?").get(actor.id) as Obj | undefined;
  check(ws && Number.isSafeInteger(ws.revision), "WORKSPACE_REQUIRED"); return ws;
}
function header(db: Database.Database, ws: Obj, actor: { id: string }, id: unknown, now: string) {
  const row = actionRead(db, "investor_legacy_transition_job_requests", id, ws.id as string), doc = actionJson(row.document_json, 32768);
  validateLegacyTransitionJob("request", doc); const body = doc.body as Obj;
  check(canonical(doc) === row.document_json && hash(doc) === row.content_hash && row.actor_id === actor.id && doc.request_id === row.id);
  for (const key of ["workspace_id", "model_id", "kind", "request_hash", "created_at", "valid_until"]) check(doc[key] === row[key]);
  check(Number.isSafeInteger(body.expected_revision) && body.expected_revision === row.expected_revision && body.idempotency_key === row.idempotency_key
    && hash(body) === row.request_hash && time(row.created_at as string) <= time(now)
    && time(row.valid_until as string) > time(row.created_at as string) && time(row.valid_until as string) - time(row.created_at as string) <= 300000000n);
  check(db.prepare("SELECT id FROM investor_models WHERE id=? AND workspace_id=?").get(row.model_id, ws.id));
  actionAudit(db, ws.id as string, row, "investor_enqueue_legacy_transition", "investor_legacy_transition_job_request");
  if (row.kind === "preview") check(body.model_id === row.model_id && row.preview_id === null);
  else {
    const witness = readLegacyTransitionPreviewWitness(db, actor, ws.id as string, body.preview_id as string);
    check(witness.preview_id === row.preview_id && witness.model_id === row.model_id && witness.workspace_revision === row.expected_revision
      && hash(witness) === body.expected_preview_hash && time(witness.created_at as string) <= time(row.created_at as string)
      && time(row.valid_until as string) <= time(witness.valid_until as string));
  }
  return { row, doc, body };
}

/** Header discovery only. This never qualifies raw sources or starts a migration. */
export function legacyTransitionModel(db: Database.Database, actor: { id: string }, now: string) {
  const ws = workspace(db, actor);
  const model = db.prepare(`SELECT m.* FROM investor_models m WHERE m.workspace_id=? AND m.plan_id=
    (SELECT plan_id FROM investor_plan_selections WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1)`)
    .get(ws.id, ws.id) as Obj | undefined;
  if (!model) return null;
  const definition = actionJson(model.document_json); validateInvestorModelDocument("definition", definition);
  check(canonical(definition) === model.document_json && hash(definition) === model.content_hash && definition.model_id === model.id
    && time(model.created_at as string) <= time(now));
  if (definition.data_mode !== "reconstructed") return null;
  const input = db.prepare("SELECT * FROM investor_monitor_evidence_inputs WHERE workspace_id=? AND model_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1")
    .get(ws.id, model.id) as Obj | undefined;
  if (!input) return null;
  const doc = actionJson(input.document_json, 1048576); validateInvestorMonitorDataDocument("input", doc);
  check(canonical(doc) === input.document_json && hash(doc) === input.content_hash && doc.workspace_id === ws.id && doc.model_id === model.id
    && doc.created_at === input.created_at && doc.valid_until === input.valid_until && input.actor_id === actor.id
    && time(input.created_at as string) <= time(now));
  actionAudit(db, ws.id as string, input, "investor_admit_monitor_source", "investor_monitor_evidence_input");
  const hasHead = !!db.prepare("SELECT 1 FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=?").get(ws.id, model.id);
  const confirmed = !!db.prepare("SELECT 1 FROM investor_legacy_transition_confirmations WHERE workspace_id=? AND model_id=?").get(ws.id, model.id);
  return { id: model.id as string, requires_transition: hasHead && !confirmed
    && ["investor-monitor-data-input-v1", "investor-monitor-data-input-v2", "investor-monitor-data-input-v3"].includes(doc.schema_version as string) };
}

/** Enqueueing is a short explicit intent write, not source or monitoring approval. */
export function enqueueLegacyTransitionJob(db: Database.Database, actor: { id: string }, raw: unknown, now = new Date().toISOString()) {
  const input = legacyTransitionInputSchema.parse(raw); time(now); assertWritableDatabase(db);
  const body = input.kind === "preview" ? { model_id: input.model_id, expected_revision: input.expected_revision, idempotency_key: input.idempotency_key } : input.body;
  validateLegacyTransitionWorkflow(input.kind === "preview" ? "preview_request" : "submit", body);
  return db.transaction(() => {
    assertWritableDatabase(db); const ws = workspace(db, actor), nonce = body.idempotency_key;
    const old = db.prepare("SELECT id FROM investor_legacy_transition_job_requests WHERE workspace_id=? AND idempotency_key=?").get(ws.id, nonce) as Obj | undefined;
    if (old) {
      const original = header(db, ws, actor, old.id, now);
      check(original.row.kind === input.kind && original.row.request_hash === hash(body), "DUPLICATE_CONFLICT"); return original.doc;
    }
    check(ws.revision === body.expected_revision, "VERSION_CHANGED");
    const busy = db.prepare(`SELECT 1 FROM investor_legacy_transition_job_requests r LEFT JOIN investor_legacy_transition_job_results u ON u.request_id=r.id
      LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
      WHERE r.workspace_id=? AND r.valid_until>? AND u.id IS NULL AND (j.id IS NULL OR j.status IN ('queued','running','retry_queued')) LIMIT 1`).get(JOB, ws.id, now);
    check(!busy, "BUSY");
    let modelId: string, previewId: string | null = null, until = new Date(Date.parse(now) + 300000).toISOString();
    if (input.kind === "preview") {
      const model = legacyTransitionModel(db, actor, now);
      check(model?.id === input.model_id && model.requires_transition, "MODEL_UNAVAILABLE"); modelId = input.model_id;
    } else {
      const witness = readLegacyTransitionPreviewWitness(db, actor, ws.id as string, input.body.preview_id);
      check(witness.workspace_revision === body.expected_revision, "VERSION_CHANGED"); check(hash(witness) === input.body.expected_preview_hash, "PREVIEW_CHANGED");
      check(time(witness.created_at as string) <= time(now) && time(now) < time(witness.valid_until as string), "PREVIEW_EXPIRED");
      modelId = witness.model_id as string; previewId = witness.preview_id as string;
      if (time(until) > time(witness.valid_until as string)) until = witness.valid_until as string;
    }
    check(!db.prepare("SELECT 1 FROM investor_legacy_transition_confirmations WHERE workspace_id=? AND model_id=?").get(ws.id, modelId), "ALREADY_CONFIRMED");
    const id = randomUUID(), digest = hash(body), audit = randomUUID();
    const doc = { schema_version: "investor-legacy-transition-job-request-v1", request_id: id, workspace_id: ws.id,
      model_id: modelId, kind: input.kind, body, request_hash: digest, created_at: now, valid_until: until };
    validateLegacyTransitionJob("request", doc); const hashed = hash(doc);
    db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,?,'investor_enqueue_legacy_transition','investor_legacy_transition_job_request',?,?,?)")
      .run(audit, actor.id, id, canonical({ content_hash: hashed }), now);
    db.prepare("INSERT INTO investor_legacy_transition_job_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, ws.id, input.kind, modelId, previewId,
      body.expected_revision, nonce, digest, canonical(doc), hashed, actor.id, now, until, audit);
    assertWritableDatabase(db); return doc;
  }).immediate();
}

export function readLegacyTransitionJobStatus(db: Database.Database, actor: { id: string }, id: string | null, now: string, latest = true) {
  time(now);
  return db.transaction(() => {
    const ws = workspace(db, actor), selected = id ? { id } : latest ? db.prepare("SELECT id FROM investor_legacy_transition_job_requests WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(ws.id) as Obj | undefined : undefined;
    const base = { workspace_id: ws.id, workspace_revision: ws.revision, checked_at: now, current_advice_certified: false,
      monitoring_activated: false, trading_permission: false, provider_calls: 0 };
    if (!selected) return { ...base, request: null };
    const { row, doc, body } = header(db, ws, actor, selected.id, now);
    const job = db.prepare("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?").get(JOB, ws.id, row.id, row.content_hash) as Obj | undefined;
    const result = db.prepare("SELECT * FROM investor_legacy_transition_job_results WHERE request_id=? AND workspace_id=?").get(row.id, ws.id) as Obj | undefined;
    let status: string, code: unknown = null, resourceId: unknown = null, resourceHash: unknown = null, resourceUntil: unknown = null;
    if (job) check(job.command_request_id === null && job.max_attempts === 1 && [0, 1].includes(job.attempt_count as number) && time(job.created_at as string) >= time(row.created_at as string));
    if (result) {
      check(job && job.status === "succeeded" && job.attempt_count === 1 && job.lease_owner === null && job.lease_until === null);
      const output = actionJson(result.document_json); validateLegacyTransitionJob("result", output);
      check(canonical(output) === result.document_json && hash(output) === result.content_hash && result.actor_id === actor.id && output.result_id === result.id);
      for (const key of ["request_id", "workspace_id", "job_id", "fencing_token", "kind", "outcome", "resource_id", "resource_hash", "code", "created_at"]) check(output[key] === result[key]);
      check(result.request_id === row.id && result.job_id === job.id && result.kind === row.kind && output.request_hash === row.content_hash && result.fencing_token === job.fencing_token);
      actionAudit(db, ws.id as string, result, "investor_finish_legacy_transition", "investor_legacy_transition_job_result");
      const attempt = db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1").get(job.id) as Obj | undefined;
      check(attempt && attempt.status === "succeeded" && attempt.fencing_token === job.fencing_token && attempt.error_json === null
        && time(attempt.started_at as string) <= time(result.created_at as string) && time(result.created_at as string) <= time(attempt.finished_at as string)
        && time(attempt.finished_at as string) <= time(now) && attempt.finished_at === job.updated_at && time(row.created_at as string) <= time(result.created_at as string));
      check(canonical(actionJson(job.result_json)) === canonical({ request_id: row.id, result_id: result.id, outcome: result.outcome,
        code: result.code, monitor_source_registered: result.outcome === "registered" }));
      status = result.outcome as string; code = result.code; resourceId = result.resource_id; resourceHash = result.resource_hash;
      if (status !== "rejected") {
        check(time(result.created_at as string) < time(row.valid_until as string));
        if (row.kind === "preview") {
          const witness = readLegacyTransitionPreviewWitness(db, actor, ws.id as string, resourceId as string);
          check(hash(witness) === resourceHash && witness.request_hash === row.request_hash && witness.model_id === row.model_id
            && witness.workspace_revision === Number(row.expected_revision) + 1 && time(row.created_at as string) <= time(witness.created_at as string)
            && time(witness.created_at as string) <= time(result.created_at as string)); resourceUntil = witness.valid_until;
          if (time(now) >= time(witness.valid_until as string)) status = "expired";
          else if (witness.workspace_revision !== ws.revision) status = "outdated";
        } else {
          const receipt = readLegacyTransitionRegistrationReceipt(db, actor, ws.id as string, resourceId as string);
          check(hash(receipt.admission) === resourceHash && receipt.confirmation.request_hash === row.request_hash && receipt.confirmation.preview_id === row.preview_id
            && receipt.confirmation.model_id === row.model_id && receipt.confirmation.workspace_revision === Number(row.expected_revision) + 1
            && receipt.admission.workspace_revision === Number(row.expected_revision) + 2
            && hash(receipt.admission.request) === hash({ transition_id: receipt.confirmation.confirmation_id, transition_hash: hash(receipt.confirmation),
              expected_revision: receipt.confirmation.workspace_revision, idempotency_key: "legacy-source:" + hash(body.idempotency_key) })
            && time(row.created_at as string) <= time(receipt.confirmation.created_at as string) && time(receipt.admission.created_at as string) <= time(result.created_at as string));
        }
      }
    } else if (!job || job.status === "queued") {
      if (job) check(job.attempt_count === 0 && job.fencing_token === 0 && job.lease_owner === null && job.lease_until === null);
      status = time(now) >= time(row.valid_until as string) ? "expired" : "queued";
    } else if (job.status === "running") {
      check(job.attempt_count === 1 && typeof job.lease_owner === "string"); status = time(now) < time(job.lease_until as string) ? "running" : "unknown";
    } else { check(["failed", "cancelled", "skipped"].includes(job.status as string)); status = "unknown"; }
    const input = row.kind === "preview" ? { kind: "preview", ...body } : { kind: "confirmation", body };
    return { ...base, request: { id: row.id, kind: row.kind, model_id: doc.model_id, intent_hash: hash(input), created_at: row.created_at,
      valid_until: row.valid_until, status, code, resource_id: resourceId, resource_hash: resourceHash, resource_valid_until: resourceUntil } };
  }).deferred();
}

export function findLegacyTransitionRequest(db: Database.Database, actor: { id: string }, nonce: string) {
  const ws = workspace(db, actor), row = db.prepare("SELECT id FROM investor_legacy_transition_job_requests WHERE workspace_id=? AND idempotency_key=?").get(ws.id, nonce) as Obj | undefined;
  return row?.id as string | undefined;
}
