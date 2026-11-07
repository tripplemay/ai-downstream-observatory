import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";
import { parseStrictJson } from "../strict-json";
import { actionAudit, actionJson, actionRead, actionJobStartedByMillisecond } from "./action-source-proof";
import { readModelEpochRegistrationHeader } from "./model-epoch-registration";
import { readRegisteredModelEpoch } from "./registered-model-epoch";
import { auditedEpochInput, modelEpochActionBaseline, modelEpochSourceSettings, verifyModelEpochActionDescendant } from "./model-epoch-source";
import { replayModelEpochContinuation } from "./model-epoch-transition";
import { replayInvestorMonitorData } from "./monitor-source";
import { readEvidenceReference } from "./reference-evidence";
import { readBoundPlannedFundingMonitor } from "./planned-funding-source";
import type { PlannedFundingBinding } from "./planned-funding-monitor";
import { readInvestorSourceReview, type VerifiedSourceReview } from "./source-inputs";
import { modelAssessmentObservation, validateEpochContinuation, validateInvestorEvidenceMonitor, validateModelEpochContinuationSource, validateModelEpochSource } from "./kernel-contracts";
import { observationSchema } from "./schemas";

type Obj = Record<string, unknown>;
function check(value: unknown, code = "INVALID"): asserts value { if (!value) throw new Error("INVESTOR_EPOCH_CONTINUATION_" + code); }
function obj(value: unknown): Obj { check(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function rows(value: unknown): Obj[] { check(Array.isArray(value)); return value.map(obj); }
function text(value: unknown): string { check(typeof value === "string"); return value; }
const time = (value: unknown) => priceInstant(text(value));
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const ref = (row: Obj) => ({ id: row.id, content_hash: row.content_hash });
const minimum = (values: unknown[]) => values.map(text).reduce((a, b) => time(a) <= time(b) ? a : b);
const byId = (a: Obj, b: Obj) => text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0;
function milliseconds(value: unknown) { const at = time(value); check(at % 1000n === 0n); return new Date(Number(at / 1000n)).toISOString(); }

function sealed(db: Database.Database, workspace: string, actor: { id: string }, id: string, kind: "control" | "request" | "publication", now: string) {
  const [table, action, entity, maximum] = {
    control: ["investor_epoch_controls", "investor_control_epoch_continuation", "investor_epoch_control", 16384],
    request: ["investor_epoch_continuation_requests", "investor_request_epoch_continuation", "investor_epoch_continuation_request", 1179648],
    publication: ["investor_epoch_continuations", "investor_publish_epoch_continuation", "investor_epoch_continuation", 16384]
  }[kind] as [string, string, string, number];
  const row = actionRead(db, table, id, workspace), doc = actionJson(row.document_json, maximum);
  validateEpochContinuation(kind, doc); actionAudit(db, workspace, row, action, entity);
  check(row.actor_id === actor.id && canonical(doc) === row.document_json && hash(doc) === row.content_hash
    && ["workspace_id", "actor_id", "model_id", "created_at", "valid_until"].every(key => doc[key] === row[key])
    && obj(doc.epoch).id === row.epoch_id && time(row.created_at) <= time(now), "HEADER_CHANGED");
  return { row, doc };
}

/** Metadata authentication only; neither raw evidence nor current eligibility. */
export function readEpochControlHeader(db: Database.Database, workspace: string, actor: { id: string }, id: string, now: string) {
  const target = sealed(db, workspace, actor, id, "control", now);
  const root = readModelEpochRegistrationHeader(db, workspace, actor, text(target.row.epoch_id), now);
  const prefix = db.prepare("SELECT id FROM investor_epoch_controls WHERE epoch_id=? AND version<=? ORDER BY version LIMIT 1001").all(target.row.epoch_id, target.row.version) as Obj[];
  check(prefix.length === target.row.version && prefix.length <= 1000, "CONTROL_CHAIN_CHANGED");
  let priorClock = root.row.created_at;
  for (const [index, item] of prefix.entries()) {
    const { row, doc } = sealed(db, workspace, actor, text(item.id), "control", now), body = obj(doc.body);
    const checkpoint = actionRead(db, "investor_evidence_model_checkpoints", obj(body.expected_checkpoint).id, workspace);
    check(doc.control_id === row.id && row.epoch_id === root.row.id && row.model_id === root.model.id
      && doc.version === row.version && row.version === index + 1 && [0, 1].includes(row.enabled as number)
      && body.enabled === Boolean(row.enabled) && body.idempotency_key === row.idempotency_key && body.epoch_id === root.row.id
      && same(doc.epoch, root.record.epoch) && doc.registration_hash === root.row.content_hash && body.expected_registration_hash === root.row.content_hash
      && doc.workspace_revision === Number(body.expected_revision) + 1 && same(body.expected_checkpoint, ref(checkpoint))
      && checkpoint.model_id === root.model.id && time(checkpoint.created_at) <= time(row.created_at)
      && time(priorClock) <= time(row.created_at) && time(row.created_at) < time(row.valid_until) && time(row.valid_until) <= time(root.row.valid_until), "CONTROL_CHANGED");
    priorClock = row.created_at;
  }
  return target;
}

function readRequest(db: Database.Database, workspace: string, actor: { id: string }, id: string, now: string) {
  const { row, doc } = sealed(db, workspace, actor, id, "request", now);
  const control = readEpochControlHeader(db, workspace, actor, text(row.control_id), now);
  const root = readModelEpochRegistrationHeader(db, workspace, actor, text(row.epoch_id), now);
  const monitor = obj(doc.monitor_request), proof = obj(doc.source_proof), document = obj(doc.input);
  const previousInput = actionRead(db, "investor_monitor_evidence_inputs", row.previous_input_id, workspace);
  const previousCheckpoint = actionRead(db, "investor_evidence_model_checkpoints", row.previous_checkpoint_id, workspace);
  check(doc.request_id === id && same(doc.activation, ref(control.row)) && control.row.enabled === 1
    && control.row.epoch_id === row.epoch_id && row.model_id === root.model.id && control.row.model_id === root.model.id
    && same(doc.epoch, root.record.epoch) && same(document.epoch, doc.epoch) && doc.registration_hash === root.row.content_hash
    && same(doc.previous_input, ref(previousInput)) && same(doc.previous_checkpoint, ref(previousCheckpoint))
    && previousInput.model_id === row.model_id && previousCheckpoint.model_id === row.model_id
    && time(previousInput.created_at) <= time(row.created_at) && time(previousCheckpoint.created_at) <= time(row.created_at)
    && doc.request_key === row.request_key && doc.request_key === hash({ context_key: doc.context_key, workspace_revision: doc.workspace_revision })
    && hash(monitor) === row.input_version && monitor.continuation_request_id === id && same(monitor.epoch, doc.epoch) && same(monitor.activation, doc.activation)
    && monitor.input_hash === proof.input_hash && proof.input_hash === hash(document) && monitor.checkpoint_hash === obj(doc.previous_checkpoint).content_hash
    && monitor.control_id === obj(proof.model_control).id && proof.registration_hash === doc.registration_hash && same(proof.epoch, doc.epoch)
    && same(proof.previous_input, doc.previous_input) && same(proof.previous_checkpoint, doc.previous_checkpoint)
    && document.workspace_id === workspace && document.model_id === row.model_id && proof.workspace_id === workspace && proof.actor_id === actor.id && proof.model_id === row.model_id
    && proof.projection_hash === document.projection_hash && proof.checked_at === document.created_at && document.created_at === doc.created_at
    && time(control.row.created_at) <= time(doc.created_at) && time(doc.created_at) < time(doc.valid_until)
    && time(doc.valid_until) <= time(minimum([control.row.valid_until, proof.valid_until, doc.source_ceiling]))
    && time(doc.source_ceiling) <= time(root.row.valid_until), "REQUEST_CHANGED");
  return { row, doc };
}

/** Authenticates actual persisted IDs and successful fenced job, not its values. */
export function readEpochContinuationHeader(db: Database.Database, workspace: string, actor: { id: string }, id: string, now: string) {
  const { row, doc } = sealed(db, workspace, actor, id, "publication", now);
  const requested = readRequest(db, workspace, actor, text(row.request_id), now), request = requested.row, planned = requested.doc;
  const input = obj(planned.input), proof = obj(doc.source_proof), monitorDocument = obj(planned.monitor_request);
  const admitted = actionRead(db, "investor_monitor_evidence_inputs", row.input_id, workspace);
  const checkpoint = actionRead(db, "investor_evidence_model_checkpoints", row.checkpoint_id, workspace);
  const run = actionRead(db, "investor_evidence_monitor_runs", row.monitor_run_id, workspace);
  const monitor = actionRead(db, "investor_evidence_monitor_requests", request.id, workspace);
  const job = db.prepare("SELECT * FROM job_runs WHERE id=?").get(row.job_id) as Obj | undefined; check(job, "JOB_CHANGED");
  const attempt = db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=?").get(job.id, job.attempt_count) as Obj | undefined;
  check(doc.publication_id === id && doc.sequence === row.sequence && same(doc.request, ref(request)) && same(doc.activation, planned.activation) && same(doc.epoch, planned.epoch)
    && same(doc.previous_input, planned.previous_input) && same(doc.previous_checkpoint, planned.previous_checkpoint)
    && same(doc.input, ref(admitted)) && same(doc.checkpoint, ref(checkpoint)) && doc.monitor_run_id === run.id && doc.observation_id === run.observation_id && doc.job_id === job.id
    && doc.workspace_revision === Number(planned.workspace_revision) + 1 && doc.source_ceiling === planned.source_ceiling && doc.implementation_hash === planned.implementation_hash
    && admitted.document_json === canonical(input) && admitted.content_hash === hash(input) && admitted.actor_id === actor.id
    && admitted.created_at === input.created_at && admitted.valid_until === input.valid_until && admitted.source_qualification === "owner_reviewed_reconstructed"
    && [admitted, checkpoint, run, monitor].every(value => value.model_id === row.model_id)
    && job.job_type === "investor_evidence_monitor" && job.command_request_id === null && job.scope === workspace && job.period === request.id
    && job.input_version === request.input_version && job.status === "succeeded" && attempt && attempt.status === "succeeded" && attempt.fencing_token === job.fencing_token
    && time(request.created_at) <= time(job.created_at) && time(job.created_at) <= time(attempt.started_at) && actionJobStartedByMillisecond(text(attempt.started_at),text(doc.calculated_at))
    && time(doc.calculated_at) <= time(doc.created_at) && time(doc.created_at) <= time(attempt.finished_at) && time(attempt.finished_at) < time(doc.publication_deadline)
    && time(attempt.finished_at) <= time(now) && time(doc.publication_deadline) <= time(minimum([request.valid_until, proof.valid_until, row.valid_until]))
    && proof.checked_at === doc.calculated_at && proof.input_hash === admitted.content_hash && proof.projection_hash === input.projection_hash
    && same(proof.previous_input, planned.previous_input) && same(proof.previous_checkpoint, planned.previous_checkpoint)
    && same(proof.epoch, planned.epoch) && proof.registration_hash === planned.registration_hash
    && monitor.document_json === canonical(monitorDocument) && monitor.input_version === request.input_version
    && monitor.input_id === admitted.id && monitor.checkpoint_id === request.previous_checkpoint_id && monitor.created_at === request.created_at
    && monitor.period === "epoch-continuation:" + text(request.id) && monitor.request_key === request.input_version && monitor.control_id === monitorDocument.control_id
    && run.job_id === job.id && run.request_id === request.id && run.checkpoint_id === checkpoint.id && run.created_at === row.created_at && run.valid_until === row.valid_until, "PUBLICATION_CHANGED");
  check(same(actionJson(job.result_json), { publication_id: row.id, epoch_id: row.epoch_id, monitor_run_id: row.monitor_run_id,
    observation_id: doc.observation_id, checkpoint_id: row.checkpoint_id, status: "epoch_continuation_published", live_advice_eligible: false }), "JOB_CHANGED");
  actionAudit(db, workspace, { ...admitted, created_at: row.created_at }, "investor_admit_monitor_source", "investor_monitor_evidence_input");
  check(doc.checkpoint_reused ? same(doc.checkpoint, doc.previous_checkpoint)
    : checkpoint.input_id === admitted.id && checkpoint.previous_hash === obj(doc.previous_checkpoint).content_hash
      && checkpoint.projection_hash === input.projection_hash && checkpoint.created_at === doc.calculated_at && checkpoint.valid_until === row.valid_until, "CHECKPOINT_CHANGED");
  const runDocument = actionJson(run.document_json, 8192); validateInvestorEvidenceMonitor("run", runDocument);
  check(canonical(runDocument) === run.document_json && hash(runDocument) === run.content_hash && runDocument.request_id === request.id && runDocument.model_id === row.model_id
    && runDocument.input_version === request.input_version && runDocument.projection_hash === input.projection_hash && runDocument.checkpoint_hash === checkpoint.content_hash
    && runDocument.implementation_hash === doc.implementation_hash && runDocument.created_at === row.created_at && runDocument.valid_until === row.valid_until
    && runDocument.status === run.status && runDocument.next_check_at !== null, "RUN_CHANGED");
  return { row, doc, request, planned, admitted, checkpoint, run, runDocument, monitor, attempt };
}

function actionReviews(db: Database.Database, workspace: string, document: Obj, now: string) {
  const selected = new Map<string, VerifiedSourceReview>();
  for (const segment of rows(document.segments)) for (const reference of rows(obj(segment.snapshot).review_refs)) {
    const value = readInvestorSourceReview(db, workspace, reference, now); if (value.source.kind !== "actions") continue;
    const listing = text(value.facts.listing_id); check(!selected.has(listing) || same(selected.get(listing), value), "ACTION_SELECTION_CHANGED"); selected.set(listing, value);
  }
  return selected;
}

// Only the journal reader can supply a predecessor or recorded clock here.
function recordedSource(db: Database.Database, workspace: string, actor: { id: string }, root: ReturnType<typeof readRegisteredModelEpoch>, previousSource: Obj,
  previousRefs: Obj, planned: Obj, publication: Obj, now: string) {
  const definition = obj(obj(root.source.kernel_input).history).definition as Obj, evaluated = text(publication.calculated_at), document = obj(planned.input), frozen = text(document.created_at);
  const modelId = text(definition.model_id), previous = obj(obj(previousSource.candidate).checkpoint);
  const control = db.prepare("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? AND created_at<=? ORDER BY version DESC LIMIT 1").get(workspace, modelId, evaluated) as Obj | undefined;
  check(control && control.enabled === 1 && same({ id: control.id, content_hash: hash(control) }, root.source.epoch_definition.model_control), "RECORDED_CONTROL_CHANGED");
  const chosen = db.prepare("SELECT id,content_hash FROM investor_funding_plans WHERE workspace_id=? AND created_at<=? ORDER BY version DESC LIMIT 1").get(workspace, evaluated) as Obj | undefined;
  const binding = document.funding_binding ? obj(document.funding_binding) : null;
  check(Boolean(chosen) === Boolean(binding), "RECORDED_FUNDING_CHANGED");
  const funding = binding ? readBoundPlannedFundingMonitor(db, actor, workspace, binding as PlannedFundingBinding, evaluated, now) : null;
  if (binding) {
    const frozenFunding = readBoundPlannedFundingMonitor(db, actor, workspace, binding as PlannedFundingBinding, frozen, now);
    check(chosen && chosen.id === binding.funding_plan_id && chosen.content_hash === binding.funding_plan_hash
      && funding!.context_hash === frozenFunding.context_hash && frozenFunding.context_hash === document.funding_context_hash, "RECORDED_FUNDING_CHANGED");
  }
  const reference = readEvidenceReference(db, workspace, text(definition.plan_id), now); check(!reference.unavailable_reason, "REFERENCE_UNAVAILABLE");
  const rawDocument = auditedEpochInput(document), raw = replayInvestorMonitorData(db, workspace, definition, reference.document.targets as unknown as Obj[], rawDocument, now, evaluated);
  check(!raw.unavailable_reason && raw.projection && raw.catalog, raw.unavailable_reason ?? "SOURCE_UNAVAILABLE");
  check(rawDocument.schema_version === "investor-monitor-data-input-v4" && raw.projection.schema_version === "investor-monitor-data-projection-v2"
    && same(rawDocument.settings, modelEpochSourceSettings(db, workspace, definition, reference.document as unknown as Obj, now, frozen)), "SETTINGS_CHANGED");
  const economic = structuredClone(raw.projection); check(rows(economic.quality_gaps).length === 0 && time(evaluated) < time(economic.valid_until), "CURRENT_INPUTS_NOT_READY");
  const selected = actionReviews(db, workspace, rawDocument, now), anchors = actionReviews(db, workspace, obj(previousSource.input), now);
  check(same([...selected.keys()].sort(), [...anchors.keys()].sort()), "ACTION_SELECTION_CHANGED");
  for (const [listing, current] of selected) verifyModelEpochActionDescendant(db, workspace, actor, current.row.id,
    { new_review_id: modelEpochActionBaseline(db, workspace, anchors.get(listing)!.row.id, now) }, now);
  const targets = new Map(rows(definition.targets).map(row => [text(row.listing_id), row]));
  const historical = (row: Obj) => { const target = targets.get(text(row.listing_id)); check(target); return time(row.effective_at) <= time(obj(previous.market_cutoffs)[text(target.market)]); };
  const carry = rows(obj(obj(previousSource.projection).economic_projection).corporate_actions).filter(historical).sort(byId), indexed = new Map(carry.map(row => [text(row.id), row]));
  check(indexed.size === carry.length && same(Object.fromEntries(carry.map(row => [text(row.id), hash(row)])), previous.processed_actions), "PREVIOUS_LEDGER_CHANGED");
  const future: Obj[] = [], economics = (row: Obj) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "known_at"));
  for (const action of rows(economic.corporate_actions)) {
    if (!historical(action)) { future.push(action); continue; }
    const old = indexed.get(text(action.id)); check(old && same(economics(old), economics(action)) && time(old.known_at) <= time(action.known_at), "HISTORICAL_ACTION_CHANGED");
  }
  const ceiling = publication.source_ceiling; check(time(frozen) <= time(evaluated) && time(evaluated) <= time(now) && time(evaluated) < time(ceiling), "EXPIRED");
  economic.corporate_actions = [...carry, ...future].sort(byId);
  economic.valid_until = minimum([economic.valid_until, ceiling, ...(funding ? [funding.projection.valid_until] : [])]);
  for (const row of [...rows(economic.quotes), ...rows(economic.fx)]) row.valid_until = minimum([row.valid_until, ceiling]);
  const epoch = root.registration.epoch;
  const projection = { schema_version: "investor-monitor-data-projection-v4", epoch, knowledge_protocol: "approved_economic_restatement_and_recorded_carry_not_pit", economic_projection: economic };
  const rebuilt: Obj = { ...rawDocument, schema_version: "investor-monitor-data-input-v6", epoch, audited_projection_hash: rawDocument.projection_hash,
    audited_valid_until: rawDocument.valid_until, carry_hash: hash(carry), carry_count: carry.length, projection_hash: hash(projection), valid_until: minimum([rawDocument.valid_until, ceiling]),
    ...(funding ? { funding_binding: funding.request.binding, funding_context_hash: funding.context_hash } : {}) };
  validateModelEpochSource("input", rebuilt); validateModelEpochSource("projection", projection);
  const kernel = { schema_version: "investor-model-epoch-continuation-input-v1", definition, previous, projection, input_hash: hash(rebuilt), planned_funding: funding?.request ?? null, now: evaluated };
  const candidate = replayModelEpochContinuation(kernel, text(publication.implementation_hash));
  const proof = { schema_version: "investor-model-epoch-continuation-source-proof-v1", workspace_id: workspace, actor_id: actor.id, model_id: modelId,
    epoch, registration_hash: root.proof.registration_hash, previous_input: previousRefs.input, previous_checkpoint: previousRefs.checkpoint,
    model_control: { id: control.id, content_hash: hash(control) }, input_hash: hash(rebuilt), projection_hash: hash(projection), checked_at: evaluated,
    valid_until: economic.valid_until, status: "qualified_continuation_prepared_not_admitted", epoch_registration_verified: true, previous_state_verified: true, source_evidence_verified: true,
    continuation_admitted: false, current_source_eligibility_restored: false, checkpoint_created: false, monitoring_resumed: false, trading_permission: false,
    provider_calls: 0, database_writes: 0, distribution: "private_owner_only_not_ai" };
  validateModelEpochContinuationSource(proof);
  return { epoch_definition: root.source.epoch_definition, input: rebuilt, projection, proof, kernel_input: kernel, candidate };
}

function localDay(at: unknown, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(milliseconds(at)));
  const get = (key: string) => parts.find(part => part.type === key)!.value; return `${get("year")}-${get("month")}-${get("day")}`;
}
function contextKey(value: ReturnType<typeof recordedSource>, activation: unknown, at: unknown, implementation: unknown) {
  const economic = value.projection.economic_projection, zones: Record<string, string> = { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" };
  const reviews = new Set(rows(value.input.segments).flatMap(segment => rows(obj(segment.snapshot).review_refs).map(reference => canonical(reference))));
  const days = Object.fromEntries([...new Set(rows(economic.quotes).map(row => text(row.market)))].map(market => { check(zones[market]); return [market, localDay(at, zones[market])]; }));
  const fixed = value.kernel_input.definition.fixed_policy ? obj(value.kernel_input.definition.fixed_policy) : null;
  return hash({ epoch: value.input.epoch, activation, quotes: economic.quotes, fx: economic.fx, actions: economic.corporate_actions, reviews: [...reviews].sort(), settings: value.input.settings,
    days, policy_day: fixed ? localDay(at, text(fixed.evaluation_timezone)) : null, funding_binding: value.input.funding_binding ?? null,
    funding_context_hash: value.input.funding_context_hash ?? null, implementation_hash: implementation });
}

function payload(db: Database.Database, kind: "checkpoint" | "run", id: unknown) {
  const [table, column, maximum] = kind === "checkpoint" ? ["investor_evidence_checkpoint_payloads", "checkpoint_id", 4194304] : ["investor_evidence_run_payloads", "run_id", 1048576];
  check(!db.prepare("SELECT 1 FROM investor_monitor_payload_purges WHERE kind=? AND entity_id=?").get(kind, id), "PAYLOAD_PURGED");
  const row = db.prepare(`SELECT payload FROM ${table} WHERE ${column}=?`).get(id) as { payload: Buffer } | undefined;
  check(row && Buffer.isBuffer(row.payload) && row.payload.length > 0 && row.payload.length <= Number(maximum), "PAYLOAD_UNAVAILABLE");
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(row.payload), value = obj(parseStrictJson(raw)); check(canonical(value) === raw); return value;
}

/** Query-only independent full prefix replay. Historical verification is not
 * automatic resume, current-source selection, or authority to trade. */
export function readEpochContinuationChain(db: Database.Database, workspace: string, actor: { id: string }, epochId: string, now: string, publicationId?: string) {
  return db.transaction(() => {
    const root = readRegisteredModelEpoch(db, workspace, actor, epochId, now), definition = obj(obj(root.source.kernel_input).history).definition as Obj;
    let source: Obj = root.source, head = { input: obj(root.registration.input), checkpoint: obj(root.registration.checkpoint) }, last: Obj | null = null;
    let originalExpiry = root.registration.valid_until, readLimit = root.proof.read_valid_until;
    check(time(now) < time(readLimit), "SOURCE_EXPIRED");
    const target = publicationId ? readEpochContinuationHeader(db, workspace, actor, publicationId, now) : null;
    check(!target || target.row.epoch_id === epochId, "OUT_OF_SCOPE");
    const entries = db.prepare("SELECT id FROM investor_epoch_continuations WHERE epoch_id=? AND (? IS NULL OR sequence<=?) ORDER BY sequence LIMIT 1001").all(epochId, target?.row.sequence ?? null, target?.row.sequence ?? null) as Obj[];
    check(entries.length <= 1000 && (!target || entries.length === target.row.sequence), "CHAIN_CHANGED");
    for (const [index, entry] of entries.entries()) {
      const h = readEpochContinuationHeader(db, workspace, actor, text(entry.id), now), { row, doc, planned } = h;
      check(doc.sequence === index + 1 && same(doc.previous_publication, last) && same(doc.previous_input, head.input) && same(doc.previous_checkpoint, head.checkpoint), "CHAIN_CHANGED");
      const selected = db.prepare("SELECT id FROM investor_epoch_controls WHERE epoch_id=? AND created_at<=? ORDER BY version DESC LIMIT 1").get(epochId, doc.calculated_at) as Obj | undefined;
      check(selected?.id === obj(doc.activation).id && obj(planned.monitor_request).model_hash === hash(definition)
        && obj(planned.monitor_request).profile_hash === definition.profile_hash, "RECORDED_CONTEXT_CHANGED");
      check(time(row.created_at) <= time(now) && time(now) < time(row.valid_until)
        && time(doc.source_ceiling) <= time(minimum([originalExpiry, root.source.epoch_definition.valid_until])), "SOURCE_EXPIRED");
      const value = recordedSource(db, workspace, actor, root, source, head, planned, doc, now);
      check(same(value.input, planned.input) && same(value.proof, doc.source_proof)
        && contextKey(value, doc.activation, planned.created_at, planned.implementation_hash) === planned.context_key, "DERIVATION_CHANGED");
      const candidate = value.candidate, checkpoint = candidate.checkpoint;
      check(checkpoint && doc.checkpoint_reused === same(checkpoint, obj(source.candidate).checkpoint), "CHECKPOINT_CHANGED");
      check(hash(checkpoint) === obj(doc.checkpoint).content_hash && same(payload(db, "checkpoint", row.checkpoint_id), checkpoint), "CHECKPOINT_CHANGED");
      const expiry = minimum([originalExpiry, obj(planned.input).valid_until, doc.source_ceiling]); check(row.valid_until === expiry, "RETENTION_CHANGED");
      const originalInput = actionRead(db, "investor_monitor_evidence_inputs", h.checkpoint.input_id, workspace);
      check(h.checkpoint.sequence === checkpoint.sequence && h.checkpoint.previous_hash === checkpoint.previous_hash && h.checkpoint.created_at === checkpoint.created_at
        && h.checkpoint.projection_hash === checkpoint.projection_hash && originalInput.model_id === definition.model_id && originalInput.content_hash === checkpoint.input_hash
        && time(h.checkpoint.valid_until) >= time(expiry), "CHECKPOINT_CHANGED");
      check(candidate.monitor_request && h.runDocument.next_check_at === milliseconds(candidate.assessment.next_review_at)
        && time(doc.created_at) < time(h.runDocument.next_check_at), "RUN_CHANGED");
      const converted = modelAssessmentObservation({ action: "monitor", document: candidate.monitor_request.document, now: text(candidate.monitor_request.now) }, candidate.assessment);
      const rendered = observationSchema.parse({ ...converted, input_version: h.monitor.input_version, next_review_at: h.runDocument.next_check_at, monitoring: "active",
        gaps: converted.gaps.map(gap => ({ ...gap, affected_markets: [...gap.affected_markets].sort() })) });
      const retained = { assessment: candidate.assessment, observation: rendered };
      check(same(payload(db, "run", row.monitor_run_id), retained) && h.runDocument.payload_hash === hash(retained) && h.runDocument.observation_hash === hash(rendered)
        && h.runDocument.assessment_hash === candidate.assessment.result_hash && same(h.runDocument.reason_codes, candidate.assessment.reason_codes) && h.runDocument.status === rendered.outcome, "RUN_CHANGED");
      const observation = actionRead(db, "investor_observations", doc.observation_id, workspace);
      const expected = { schema_version: "investor-model-observation-ref-v1", run_id: row.monitor_run_id, outcome: rendered.outcome, profile_id: definition.profile_id,
        profile_version: definition.profile_version, input_version: h.runDocument.input_version, published_at: row.created_at };
      check(observation.document_json === canonical(expected) && observation.content_hash === hash(expected) && observation.profile_id === definition.profile_id
        && observation.candidate_plan_id === definition.plan_id && observation.created_at === row.created_at && observation.input_version === h.runDocument.input_version && observation.outcome === rendered.outcome, "OBSERVATION_CHANGED");
      source = value; head = { input: obj(doc.input), checkpoint: obj(doc.checkpoint) }; last = ref(row);
      originalExpiry = expiry; readLimit = minimum([readLimit, expiry]);
    }
    return { root, definition, source, head, last_publication: last, read_valid_until: readLimit, publication_count: entries.length };
  }).deferred();
}
