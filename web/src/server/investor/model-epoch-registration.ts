import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";
import { actionAudit, actionJson, actionRead } from "./action-source-proof";
import { validateInvestorEvidenceMonitor, validateInvestorModelDocument, validateModelEpochRegistration, validateModelEpochSource } from "./kernel-contracts";

type Obj = Record<string, unknown>;
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_MODEL_EPOCH_REGISTRATION_INVALID"); }
function obj(value: unknown): Obj { check(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
const text = (value: unknown) => { check(typeof value === "string"); return value; };
const time = (value: unknown) => priceInstant(text(value));
const same = (a: unknown, b: unknown) => hash(a) === hash(b);

/** Receipt authentication only. No cached payload, raw-source or current-state grant. */
export function readModelEpochRegistrationHeader(db: Database.Database, workspace: string, actor: { id: string }, epochId: string, now: string) {
  check((db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as Obj | undefined)?.owner_id === actor.id);
  function sealed(table: string, id: unknown, kind: "preview" | "request" | "registration") {
    const row = actionRead(db, table, id, workspace), doc = actionJson(row.document_json, kind === "preview" ? 1048576 : 16384);
    validateModelEpochRegistration(kind, doc);
    const [action, objectType] = { preview: ["investor_preview_model_epoch", "investor_model_epoch_preview"],
      request: ["investor_request_model_epoch", "investor_model_epoch_request"], registration: ["investor_register_model_epoch", "investor_model_epoch"] }[kind];
    actionAudit(db, workspace, row, action, objectType);
    check(row.actor_id === actor.id && canonical(doc) === row.document_json && hash(doc) === row.content_hash
      && ["workspace_id", "actor_id", "model_id", "created_at", "valid_until"].every(key => doc[key] === row[key]) && time(row.created_at) <= time(now));
    return { row, doc };
  }
  const registered = sealed("investor_model_epochs", epochId, "registration"), row = registered.row, record = registered.doc;
  const requested = sealed("investor_model_epoch_requests", row.request_id, "request"), request = requested.doc;
  const previewed = sealed("investor_model_epoch_previews", requested.row.preview_id, "preview"), preview = previewed.doc;
  const epoch = actionJson(row.definition_json, 131072), input = obj(preview.input), preparedProof = obj(preview.source_proof);
  validateModelEpochSource("definition", epoch); validateModelEpochSource("input", input);
  const ref = { id: epochId, content_hash: hash(epoch) };
  check(same(epoch, preview.epoch_definition) && canonical(epoch) === row.definition_json && hash(epoch) === row.definition_hash
    && epoch.epoch_id === epochId && epoch.workspace_id === workspace && epoch.actor_id === actor.id && epoch.model_id === row.model_id
    && previewed.row.epoch_id === epochId && preview.preview_id === previewed.row.id && preview.workspace_revision === previewed.row.workspace_revision
    && same(input.epoch, ref) && same(preparedProof.epoch, ref) && same(record.epoch, ref)
    && input.workspace_id === workspace && input.model_id === row.model_id && preparedProof.workspace_id === workspace && preparedProof.actor_id === actor.id
    && preparedProof.model_id === row.model_id && preparedProof.input_hash === hash(input) && preparedProof.projection_hash === input.projection_hash
    && epoch.created_at === input.created_at && input.created_at === preparedProof.checked_at
    && time(input.created_at) <= time(preview.created_at) && time(preview.created_at) < time(preview.valid_until) && time(preview.valid_until) <= time(preparedProof.valid_until));
  const body = obj(request.body), monitorDocument = obj(request.monitor_request); validateModelEpochRegistration("monitor_request", monitorDocument);
  check(request.request_id === requested.row.id && request.model_id === row.model_id && request.workspace_revision === requested.row.workspace_revision
    && same(request.preview, { id: previewed.row.id, content_hash: previewed.row.content_hash })
    && body.preview_id === previewed.row.id && body.expected_preview_hash === previewed.row.content_hash
    && body.expected_revision === preview.workspace_revision && request.workspace_revision === Number(preview.workspace_revision) + 1
    && body.idempotency_key === requested.row.idempotency_key && hash(body) === requested.row.request_hash
    && time(preview.created_at) <= time(request.created_at) && time(request.created_at) < time(request.valid_until) && request.valid_until === preview.valid_until
    && monitorDocument.epoch_request_id === requested.row.id && same(monitorDocument.epoch, ref) && monitorDocument.input_hash === hash(input)
    && monitorDocument.model_hash === epoch.model_hash && monitorDocument.checkpoint_hash === obj(epoch.binding).original_head_hash
    && monitorDocument.control_id === obj(epoch.model_control).id && hash(monitorDocument) === requested.row.input_version);
  const admitted = actionRead(db, "investor_monitor_evidence_inputs", row.input_id, workspace);
  const checkpoint = actionRead(db, "investor_evidence_model_checkpoints", row.checkpoint_id, workspace);
  const monitor = actionRead(db, "investor_evidence_monitor_requests", row.request_id, workspace);
  const run = actionRead(db, "investor_evidence_monitor_runs", row.monitor_run_id, workspace);
  const model = actionRead(db, "investor_models", row.model_id, workspace), definition = actionJson(model.document_json, 131072);
  validateInvestorModelDocument("definition", definition);
  check(hash(definition) === model.content_hash && epoch.model_hash === model.content_hash && definition.model_id === model.id
    && definition.profile_id === model.profile_id && definition.plan_id === model.plan_id && definition.created_at === model.created_at
    && monitorDocument.profile_hash === definition.profile_hash);
  const job = db.prepare("SELECT * FROM job_runs WHERE id=?").get(row.job_id) as Obj | undefined;
  check(job && job.status === "succeeded" && job.job_type === "investor_evidence_monitor" && job.command_request_id === null
    && job.scope === workspace && job.period === requested.row.id && job.input_version === requested.row.input_version);
  const attempt = db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=?").get(job.id, job.attempt_count) as Obj | undefined;
  check(attempt && attempt.status === "succeeded" && attempt.fencing_token === job.fencing_token
    && time(request.created_at) <= time(job.created_at) && time(job.created_at) <= time(attempt.started_at)
    && time(attempt.started_at) <= time(record.calculated_at) && time(record.created_at) <= time(attempt.finished_at)
    && time(attempt.finished_at) < time(record.publication_deadline) && time(attempt.finished_at) <= time(now));
  check(same(actionJson(job.result_json), { epoch_id: epochId, monitor_run_id: run.id, observation_id: record.observation_id,
    checkpoint_id: checkpoint.id, status: "epoch_registered_not_resumed", live_advice_eligible: false }));
  check(same(record.request, { id: requested.row.id, content_hash: requested.row.content_hash })
    && same(record.input, { id: admitted.id, content_hash: admitted.content_hash }) && same(record.checkpoint, { id: checkpoint.id, content_hash: checkpoint.content_hash })
    && record.monitor_run_id === run.id && record.job_id === job.id && record.observation_id === run.observation_id
    && record.workspace_revision === Number(request.workspace_revision) + 1
    && time(request.created_at) <= time(record.calculated_at) && time(record.calculated_at) <= time(record.created_at)
    && time(record.created_at) < time(record.publication_deadline)
    && [record.valid_until, request.valid_until, obj(record.source_proof).valid_until].every(value => time(record.publication_deadline) <= time(value))
    && canonical(input) === admitted.document_json && hash(input) === admitted.content_hash && admitted.actor_id === actor.id
    && admitted.created_at === input.created_at && admitted.valid_until === input.valid_until && admitted.source_qualification === "owner_reviewed_reconstructed"
    && [admitted,checkpoint,monitor,run].every(value => value.model_id === model.id)
    && checkpoint.input_id === admitted.id && checkpoint.projection_hash === input.projection_hash && checkpoint.previous_hash === obj(epoch.binding).original_head_hash
    && checkpoint.created_at === record.calculated_at && checkpoint.valid_until === row.valid_until
    && same(obj(record.source_proof).epoch, ref) && obj(record.source_proof).input_hash === admitted.content_hash
    && obj(record.source_proof).projection_hash === checkpoint.projection_hash && obj(record.source_proof).checked_at === record.calculated_at
    && obj(record.source_proof).original_head_id === epoch.original_head_id
    && monitor.document_json === canonical(monitorDocument) && monitor.input_version === requested.row.input_version
    && monitor.control_id === obj(epoch.model_control).id && monitor.input_id === admitted.id && monitor.checkpoint_id === epoch.original_head_id
    && monitor.created_at === request.created_at && run.request_id === requested.row.id && run.job_id === job.id && run.checkpoint_id === checkpoint.id
    && run.created_at === row.created_at && run.valid_until === row.valid_until);
  const audit = db.prepare("SELECT * FROM audit_events WHERE id=?").get(admitted.audit_id) as Obj | undefined;
  check(audit && audit.actor_id === actor.id && audit.action === "investor_admit_monitor_source" && audit.object_type === "investor_monitor_evidence_input"
    && audit.object_id === admitted.id && audit.created_at === row.created_at && same(actionJson(audit.payload_json), { content_hash: admitted.content_hash }));
  const runDocument = actionJson(run.document_json, 8192); validateInvestorEvidenceMonitor("run", runDocument);
  check(hash(runDocument) === run.content_hash && canonical(runDocument) === run.document_json && runDocument.request_id === monitor.id
    && runDocument.model_id === model.id && runDocument.input_version === monitor.input_version && runDocument.status === run.status
    && runDocument.projection_hash === checkpoint.projection_hash && runDocument.checkpoint_hash === checkpoint.content_hash
    && runDocument.implementation_hash === record.implementation_hash && runDocument.next_check_at === null
    && runDocument.created_at === row.created_at && runDocument.valid_until === row.valid_until);
  return { row, record, preview, request, epoch, input, admitted, checkpoint, monitor, monitorDocument, run, runDocument, model, definition };
}
