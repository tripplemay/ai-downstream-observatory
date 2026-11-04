import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { priceInstant } from "../market-price-source";
import { modelAssessmentObservation, validateInvestorEvidenceMonitor, validateModelEpochCheckpoint, validateModelEpochRegistration } from "./kernel-contracts";
import { readModelEpochRegistrationHeader } from "./model-epoch-registration";
import { modelEpochSourceSettings, replayRegisteredModelEpochSource } from "./model-epoch-source";
import { modelWatchSchema, observationSchema } from "./schemas";
import type { InvestorProfileVersion } from "./types";
import { monitorCostsAt } from "./monitor-costs";
import { readBoundPlannedFundingMonitor } from "./planned-funding-source";
import type { PlannedFundingBinding } from "./planned-funding-monitor";
import { readEpochContinuationChain, readEpochContinuationHeader, readEpochControlHeader } from "./epoch-continuation";
import { readEvidenceReference } from "./reference-evidence";
import { assertCurrentEpochSourceSelection } from "./current-epoch-sources";

type Obj = Record<string, unknown>;
function check(value: unknown, code = "INVALID"): asserts value { if (!value) throw new Error("INVESTOR_REGISTERED_MODEL_EPOCH_" + code); }
function obj(value: unknown): Obj { check(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
const text = (value: unknown) => { check(typeof value === "string"); return value; };
const time = (value: unknown) => priceInstant(text(value));
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const minimum = (values: unknown[]) => values.map(text).reduce((a, b) => time(a) <= time(b) ? a : b);
function payload(db: Database.Database, table: string, column: string, id: unknown, maximum: number) {
  const row = db.prepare(`SELECT payload FROM ${table} WHERE ${column}=?`).get(id) as { payload: Buffer } | undefined;
  check(row && Buffer.isBuffer(row.payload) && row.payload.length > 0 && row.payload.length <= maximum, "PAYLOAD_UNAVAILABLE");
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(row.payload), value = obj(parseStrictJson(raw)); check(canonical(value) === raw); return value;
}
function owner(db: Database.Database, workspace: string) {
  const row = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as Obj | undefined; check(row); return { id: text(row.owner_id) };
}

/** Independent retained-byte/state verification, authorized only by real journal ID. */
export function readRegisteredModelEpoch(db: Database.Database, workspace: string, actor: { id: string }, epochId: string, now: string) {
  return db.transaction(() => {
    const h = readModelEpochRegistrationHeader(db, workspace, actor, epochId, now);
    check(time(h.row.created_at) <= time(now) && time(now) < time(h.row.valid_until), "SOURCE_EXPIRED");
    for (const [kind, id] of [["checkpoint", h.checkpoint.id], ["run", h.run.id]])
      check(!db.prepare("SELECT 1 FROM investor_monitor_payload_purges WHERE kind=? AND entity_id=?").get(kind, id), "PAYLOAD_PURGED");
    const derived = replayRegisteredModelEpochSource(db, workspace, actor, epochId, now), prepared = derived.source;
    check(same(prepared.epoch_definition, h.epoch) && same(prepared.input, h.input) && same(prepared.proof, h.record.source_proof), "DERIVATION_CHANGED");
    const result = prepared.candidate, checkpoint = result.checkpoint; check(checkpoint, "CHECKPOINT_CHANGED"); validateModelEpochCheckpoint(checkpoint);
    const original = db.prepare("SELECT valid_until FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?").get(h.epoch.original_head_id, workspace, h.model.id) as Obj | undefined;
    check(original); const expiry = minimum([h.input.valid_until, h.epoch.valid_until, original.valid_until]);
    check(h.checkpoint.sequence === checkpoint.sequence && h.checkpoint.previous_hash === checkpoint.previous_hash && h.checkpoint.valid_until === expiry
      && hash(checkpoint) === h.checkpoint.content_hash && same(payload(db, "investor_evidence_checkpoint_payloads", "checkpoint_id", h.checkpoint.id, 4194304), checkpoint), "CHECKPOINT_CHANGED");
    check(result.monitor_request); const monitor = obj(result.monitor_request);
    const converted = modelAssessmentObservation({ action: "monitor", document: monitor.document, now: text(monitor.now) }, result.assessment);
    const rendered = observationSchema.parse({ ...converted, input_version: h.monitor.input_version, next_review_at: null, monitoring: "paused",
      gaps: converted.gaps.map(row => ({ ...row, affected_markets: [...row.affected_markets].sort() })) });
    const retained = { assessment: result.assessment, observation: rendered };
    check(same(payload(db, "investor_evidence_run_payloads", "run_id", h.run.id, 1048576), retained)
      && hash(retained) === h.runDocument.payload_hash && hash(rendered) === h.runDocument.observation_hash
      && result.assessment.result_hash === h.runDocument.assessment_hash && same(result.assessment.reason_codes, h.runDocument.reason_codes), "RUN_CHANGED");
    const obs = db.prepare("SELECT * FROM investor_observations WHERE id=? AND workspace_id=?").get(h.record.observation_id, workspace) as Obj | undefined;
    check(obs); const ref = obj(parseStrictJson(text(obs.document_json))); validateInvestorEvidenceMonitor("observation_ref", ref);
    const expected = { schema_version: "investor-model-observation-ref-v1", run_id: h.run.id, outcome: rendered.outcome, profile_id: h.definition.profile_id,
      profile_version: h.definition.profile_version, input_version: h.monitor.input_version, published_at: h.row.created_at };
    check(same(ref, expected) && hash(ref) === obs.content_hash && canonical(ref) === obs.document_json && obs.outcome === rendered.outcome
      && obs.input_version === h.monitor.input_version && obs.created_at === h.row.created_at && obs.profile_id === h.definition.profile_id && obs.candidate_plan_id === h.definition.plan_id, "OBSERVATION_CHANGED");
    const proof = { schema_version: "investor-model-epoch-replay-proof-v1", workspace_id: workspace, actor_id: actor.id, model_id: h.model.id,
      epoch: h.record.epoch, registration_hash: h.row.content_hash, input: h.record.input, checkpoint: h.record.checkpoint, checked_at: now,
      evaluated_at: h.record.calculated_at, read_valid_until: minimum([h.row.valid_until, derived.read_valid_until]),
      status: "registered_first_state_replayed_paused", registered_bindings_verified: true, source_evidence_verified: true, checkpoint_replayed: true,
      current_source_eligibility_restored: false, monitoring_resumed: false, trading_permission: false, database_writes: 0, provider_calls: 0, distribution: "private_owner_only_not_ai" };
    validateModelEpochRegistration("replay_proof", proof);
    return { registration: h.record, source: prepared, proof, observation: rendered };
  }).deferred();
}

function blocked(h: ReturnType<typeof readModelEpochRegistrationHeader>, code: string) {
  const pending = code === "MONITOR_EPOCH_CONTINUATION_NOT_ENABLED";
  return observationSchema.parse({ schema_version: "investor-observation-v1", outcome: "insufficient_evidence", evaluated_at: h.record.calculated_at, data_cutoff: null,
    profile_id: h.definition.profile_id, profile_version: h.definition.profile_version, input_version: h.monitor.input_version,
    gaps: [{ code, title: pending ? "首个接续状态已核验，连续更新待接通" : "接续研究资料需要核验", detail: pending
      ? "已独立重放首个登记状态，但连续资料更新和后续评估尚未启用；保留已记录观察，不将其显示为当前无需调整。"
      : "已登记首个状态不代表持续监测已恢复。当前资料已不齐或状态未能独立重放，不展示旧估值，也不把缺少结论当作无需调整。",
      affected_markets: [...new Set((h.definition.targets as Obj[]).map(row => text(row.market)))].sort(), action: "核对当前来源与连续更新状态；原观察和人工决定保留，不授权交易。" }],
    reasons: ["来源核验、当前数据和持续更新是独立条件，不能借历史登记替代。"], next_review_at: null,
    next_conditions: ["所选来源可读且状态重放通过", "当前有效收盘和连续更新就绪"], monitoring: "paused", scope: "research_model", live_advice_eligible: false });
}

/** Ordinary DTO adapter: current gaps never expose a retained NAV as current. */
export function readModelEpochMonitorRun(db: Database.Database, workspace: string, epochId: string, now: string) {
  const actor = owner(db, workspace), h = readModelEpochRegistrationHeader(db, workspace, actor, epochId, now);
  let observation, reason: string | null = null;
  try {
    const replay = readRegisteredModelEpoch(db, workspace, actor, epochId, now);
    const latest = db.prepare("SELECT id FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? ORDER BY sequence DESC LIMIT 1").get(workspace, h.model.id) as Obj | undefined;
    const control = db.prepare("SELECT id FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1").get(workspace, h.model.id) as Obj | undefined;
    const funding = db.prepare("SELECT id,content_hash FROM investor_funding_plans WHERE workspace_id=? ORDER BY version DESC LIMIT 1").get(workspace) as Obj | undefined;
    const binding = h.input.funding_binding ? obj(h.input.funding_binding) : null;
    const currentFunding = binding && funding && funding.id === binding.funding_plan_id && funding.content_hash === binding.funding_plan_hash
      ? readBoundPlannedFundingMonitor(db, actor, workspace, binding as PlannedFundingBinding, now, now) : null;
    const costs = monitorCostsAt(db, workspace, h.definition, now), settings = obj(h.input.settings);
    if (latest?.id !== h.checkpoint.id) reason = "MONITOR_EPOCH_CONTINUATION_NOT_VERIFIED";
    else if (control?.id !== obj(h.epoch.model_control).id) reason = "MONITOR_EPOCH_CONTROL_CHANGED";
    else if (Boolean(funding) !== Boolean(binding) || funding && (funding.id !== binding?.funding_plan_id || funding.content_hash !== binding?.funding_plan_hash)) reason = "MONITOR_FUNDING_PLAN_CHANGED";
    else if (currentFunding?.projection.status === "expired") reason = "MONITOR_FUNDING_PLAN_WINDOW_EXPIRED";
    else if (currentFunding && currentFunding.context_hash !== h.input.funding_context_hash) reason = "MONITOR_FUNDING_CONTEXT_CHANGED";
    else if (!same(costs?.binding ?? null, settings.cost_assumptions ?? null) || !same(costs?.costs ?? null, obj(settings.policy).costs)) reason = "MONITOR_COST_ASSUMPTIONS_CHANGED";
    else if (time(now) >= time(replay.source.proof.valid_until) || time(now) >= time(replay.source.candidate.assessment.next_review_at)) reason = "MONITOR_EPOCH_CURRENT_DATA_NOT_READY";
    // Registration explicitly records monitoring_resumed=false. A verified
    // historical first state alone is not a current keep-observing conclusion.
    reason ??= "MONITOR_EPOCH_CONTINUATION_NOT_ENABLED";
    observation = blocked(h, reason);
  } catch { reason = "MONITOR_EPOCH_REPLAY_UNAVAILABLE"; observation = blocked(h, reason); }
  return { row: h.run, model: h.model, definition: h.definition, request: h.monitor, run: h.runDocument, observation, unavailable_reason: reason };
}

function currentEpochReason(db: Database.Database, workspace: string, actor: { id: string }, chain: ReturnType<typeof readEpochContinuationChain>,
  publication: ReturnType<typeof readEpochContinuationHeader>, now: string) {
  const definition = chain.definition, modelId = text(definition.model_id), source = chain.source, document = obj(source.input);
  const latest = db.prepare("SELECT id FROM investor_epoch_continuations WHERE workspace_id=? AND epoch_id=? ORDER BY sequence DESC LIMIT 1").get(workspace, publication.row.epoch_id) as Obj | undefined;
  if (latest?.id !== publication.row.id) return "MONITOR_EPOCH_RUN_SUPERSEDED";
  const checkpoint = db.prepare("SELECT id,content_hash FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? ORDER BY sequence DESC LIMIT 1").get(workspace, modelId);
  const input = db.prepare("SELECT id,content_hash FROM investor_monitor_evidence_inputs WHERE workspace_id=? AND model_id=? ORDER BY rowid DESC LIMIT 1").get(workspace, modelId);
  if (!same(checkpoint, chain.head.checkpoint) || !same(input, chain.head.input)) return "MONITOR_EPOCH_CONTINUATION_NOT_VERIFIED";
  const activation = db.prepare("SELECT id FROM investor_epoch_controls WHERE workspace_id=? AND epoch_id=? ORDER BY version DESC LIMIT 1").get(workspace, publication.row.epoch_id) as Obj | undefined;
  if (!activation) return "MONITOR_EPOCH_CONTINUATION_NOT_ENABLED";
  const active = readEpochControlHeader(db, workspace, actor, text(activation.id), now);
  if (!active.row.enabled) return "MONITOR_EPOCH_CONTINUATION_PAUSED";
  if (active.row.id !== obj(publication.doc.activation).id || time(active.row.valid_until) <= time(now)) return "MONITOR_EPOCH_ACTIVATION_CHANGED";
  const control = db.prepare("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1").get(workspace, modelId) as Obj | undefined;
  if (!control || time(control.created_at) > time(now)) return "MONITOR_EPOCH_CONTROL_CHANGED";
  if (!control.enabled) return "MONITOR_EPOCH_MONITORING_PAUSED";
  if (!same({ id: control.id, content_hash: hash(control) }, chain.root.source.epoch_definition.model_control)) return "MONITOR_EPOCH_CONTROL_CHANGED";
  const profile = db.prepare("SELECT * FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1").get(workspace) as Obj | undefined;
  const selected = db.prepare("SELECT plan_id,created_at FROM investor_plan_selections WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(workspace) as Obj | undefined;
  if (!profile || profile.id !== definition.profile_id || profile.content_hash !== definition.profile_hash || profile.version !== definition.profile_version
    || time(profile.created_at) > time(now) || !selected || selected.plan_id !== definition.plan_id || time(selected.created_at) > time(now)) return "MONITOR_EPOCH_REFERENCE_CHANGED";
  const latestFunding = db.prepare("SELECT id,content_hash FROM investor_funding_plans WHERE workspace_id=? ORDER BY version DESC LIMIT 1").get(workspace) as Obj | undefined;
  const binding = document.funding_binding ? obj(document.funding_binding) : null;
  if (Boolean(latestFunding) !== Boolean(binding) || latestFunding && (latestFunding.id !== binding?.funding_plan_id || latestFunding.content_hash !== binding?.funding_plan_hash)) return "MONITOR_FUNDING_PLAN_CHANGED";
  if (binding) {
    const funding = readBoundPlannedFundingMonitor(db, actor, workspace, binding as PlannedFundingBinding, now, now);
    if (funding.projection.status === "expired") return "MONITOR_FUNDING_PLAN_WINDOW_EXPIRED";
    if (funding.context_hash !== document.funding_context_hash) return "MONITOR_FUNDING_CONTEXT_CHANGED";
  }
  const costs = monitorCostsAt(db, workspace, definition, now), settings = obj(document.settings);
  if (!same(costs?.binding ?? null, settings.cost_assumptions ?? null) || !same(costs?.costs ?? null, obj(settings.policy).costs)) return "MONITOR_COST_ASSUMPTIONS_CHANGED";
  if ([definition.valid_until, chain.read_valid_until, obj(source.proof).valid_until, publication.runDocument.next_check_at].some(deadline => time(now) >= time(deadline))) return "MONITOR_EPOCH_CURRENT_DATA_NOT_READY";
  const reference = readEvidenceReference(db, workspace, text(definition.plan_id), now);
  if (reference.unavailable_reason || reference.row.content_hash !== definition.plan_hash) return "MONITOR_EPOCH_REFERENCE_CHANGED";
  if (!same(settings, modelEpochSourceSettings(db, workspace, definition, reference.document as unknown as Obj, now))) return "MONITOR_EPOCH_CURRENT_SETTINGS_CHANGED";
  try {
    assertCurrentEpochSourceSelection(db, workspace, reference.document.targets as unknown as Obj[], definition, document, obj(obj(source.projection).economic_projection), now);
  } catch { return "MONITOR_EPOCH_CURRENT_SOURCE_SELECTION_CHANGED"; }
  return null;
}

/** Actual retained replay plus independent current selection, in one snapshot. */
export function readEpochContinuationRun(db: Database.Database, workspace: string, runId: string, now: string) {
  return db.transaction(() => {
    const actor = owner(db, workspace);
    const p = db.prepare("SELECT id,epoch_id FROM investor_epoch_continuations WHERE monitor_run_id=? AND workspace_id=?").get(runId, workspace) as Obj | undefined; check(p);
    const publication = readEpochContinuationHeader(db, workspace, actor, text(p.id), now);
    const h = readModelEpochRegistrationHeader(db, workspace, actor, text(p.epoch_id), now);
    let reason: string | null = null, observation;
    try {
      const chain = readEpochContinuationChain(db, workspace, actor, text(p.epoch_id), now, text(p.id));
      check(same(chain.definition, h.definition) && chain.last_publication?.id === p.id);
      reason = currentEpochReason(db, workspace, actor, chain, publication, now);
      if (!reason) {
        const candidate = obj(chain.source.candidate), request = obj(candidate.monitor_request);
        const converted = modelAssessmentObservation({ action: "monitor", document: request.document, now: text(request.now) }, candidate.assessment);
        const nextCost = db.prepare("SELECT effective_from FROM investor_monitor_cost_assumptions WHERE workspace_id=? AND model_id=? AND effective_from>? ORDER BY effective_from,version LIMIT 1")
          .get(workspace, h.model.id, now) as Obj | undefined;
        const expiry = minimum([publication.runDocument.next_check_at, chain.read_valid_until, obj(chain.source.proof).valid_until, h.definition.valid_until,
          ...(nextCost ? [nextCost.effective_from] : [])]);
        observation = observationSchema.parse({ ...converted, input_version: publication.monitor.input_version, next_review_at: expiry, monitoring: "active",
          gaps: converted.gaps.map(gap => ({ ...gap, affected_markets: [...gap.affected_markets].sort() })) });
      }
    } catch { reason = "MONITOR_EPOCH_REPLAY_UNAVAILABLE"; }
    observation ??= observationSchema.parse({ ...blocked(h, reason!), input_version: publication.monitor.input_version, evaluated_at: publication.doc.calculated_at,
      reasons: ["当前权限、启用控制、来源选择或连续状态未能完整核验，隐藏历史净值和变化；不将缺少结论当作无需调整。"] });
    return { row: publication.run, model: h.model, definition: h.definition, request: publication.monitor, run: publication.runDocument, observation, unavailable_reason: reason };
  }).deferred();
}

export function readModelEpochWatch(db: Database.Database, workspace: string, model: Obj, definition: Obj, profile: InvestorProfileVersion, now: string, referenceAvailable: boolean) {
  const epoch = db.prepare("SELECT id FROM investor_model_epochs WHERE workspace_id=? AND model_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(workspace, model.id) as Obj | undefined;
  check(epoch);
  const continuation = db.prepare("SELECT monitor_run_id FROM investor_epoch_continuations WHERE workspace_id=? AND epoch_id=? ORDER BY sequence DESC LIMIT 1").get(workspace, epoch.id) as Obj | undefined;
  const read = continuation ? readEpochContinuationRun(db, workspace, text(continuation.monitor_run_id), now) : readModelEpochMonitorRun(db, workspace, text(epoch.id), now);
  check(same(read.definition, definition));
  const control = db.prepare("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1").get(workspace, model.id) as Obj | undefined;
  check(control && [0, 1].includes(control.enabled as number) && time(control.created_at) <= time(now));
  const input = db.prepare("SELECT id FROM investor_monitor_evidence_inputs WHERE workspace_id=? AND model_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(workspace, model.id) as Obj | undefined;
  const activation = db.prepare("SELECT enabled FROM investor_epoch_controls WHERE workspace_id=? AND epoch_id=? ORDER BY version DESC LIMIT 1").get(workspace, epoch.id) as Obj | undefined;
  const enabled = control.enabled === 1 && (!activation || activation.enabled === 1);
  let status = read.unavailable_reason ? read.unavailable_reason === "MONITOR_EPOCH_CONTINUATION_NOT_ENABLED" ? "blocked" : "outdated"
    : read.observation.outcome === "observe" ? "research_observe" : read.observation.outcome === "decision_required" ? "research_decision" : "blocked";
  if (!referenceAvailable || definition.profile_id !== profile.id || definition.profile_hash !== profile.content_hash || input?.id !== read.request.input_id) status = "outdated";
  if (time(definition.valid_until) <= time(now)) status = "expired";
  if (!enabled) status = "paused";
  return modelWatchSchema.parse({ id: model.id, profile_id: definition.profile_id, plan_id: model.plan_id, plan_hash: definition.plan_hash, valid_until: definition.valid_until,
    enabled, status, created_at: model.created_at, completed_at: read.row.created_at, next_check_at: read.observation.next_review_at,
    checkpoint_sequence: Number((db.prepare("SELECT sequence FROM investor_evidence_model_checkpoints WHERE id=?").get(read.row.checkpoint_id) as Obj).sequence),
    initial_notional_cny: "10000", model_nav_cny: ["research_observe", "research_decision"].includes(status) ? read.observation.model_change?.model_nav_cny ?? null : null,
    evaluation_input_version: read.request.input_version, source_qualification: "owner_reviewed_reconstructed", live_advice_eligible: false });
}
