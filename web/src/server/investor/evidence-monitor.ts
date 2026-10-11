import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { priceInstant } from "../market-price-source";
import { modelAssessmentObservation, validateInvestorEvidenceCheckpoint, validateInvestorEvidenceMonitor, validateInvestorModelDocument, validateInvestorMonitorDataDocument } from "./kernel-contracts";
import { EvidenceActionRestatement, EvidenceCheckpointLimitRequired, replayEvidenceModel } from "./evidence-model-state";
import { replayEvidenceAssessment } from "./evidence-model-assessment";
import { readInvestorMonitorEvidenceSource } from "./monitor-source";
import { readEvidenceReference } from "./reference-evidence";
import { modelWatchSchema, observationSchema, type InvestorObservation } from "./schemas";
import type { InvestorObservationRecord, InvestorProfileVersion } from "./types";
import { readBoundPlannedFundingMonitor } from "./planned-funding-source";
import type { PlannedFundingBinding } from "./planned-funding-monitor";

type Obj = Record<string, unknown>;
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_EVIDENCE_INVALID"); }
function obj(value: unknown): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function text(value: unknown): string { check(typeof value === "string"); return value; }
const time = (value: unknown) => priceInstant(text(value));
function millis(value: unknown) { const at = time(value); check(at % 1000n === 0n); return new Date(Number(at / 1000n)).toISOString(); }
const earliest = (...values: unknown[]) => millis(values.reduce((a, b) => time(a) < time(b) ? a : b));
const nextPoll = (value: unknown) => new Date(Number((time(value) / 900000000n + 1n) * 900000n)).toISOString();
function sealed(row: Obj) { const value = obj(parseStrictJson(text(row.document_json))); check(hash(value) === row.content_hash); return value; }
function payload(db: Database.Database, table: string, key: string, id: unknown, maximum: number) {
  const row = db.prepare(`SELECT payload FROM ${table} WHERE ${key}=?`).get(id) as { payload: Buffer } | undefined;
  check(row && Buffer.isBuffer(row.payload) && row.payload.length > 0 && row.payload.length <= maximum);
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(row.payload), value = obj(parseStrictJson(raw)); check(canonical(value) === raw); return value;
}
function fundingAt(db: Database.Database, workspace: string, binding: unknown, evaluated: string, checked: string) {
  const owner = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as { owner_id: string } | undefined;
  check(owner);
  return readBoundPlannedFundingMonitor(db, { id: owner.owner_id }, workspace, binding as PlannedFundingBinding, evaluated, checked);
}
function requestFunding(db: Database.Database, workspace: string, bound: Obj, evaluated: string, checked: string) {
  return bound.engine_version === "investor-evidence-model-watcher-v4" ? fundingAt(db, workspace, bound.funding_binding, evaluated, checked) : null;
}
function currentFundingReason(db: Database.Database, workspace: string, bound: Obj, now: string) {
  const latest = db.prepare("SELECT id,content_hash FROM investor_funding_plans WHERE workspace_id=? ORDER BY version DESC LIMIT 1").get(workspace) as Obj | undefined;
  if (bound.engine_version !== "investor-evidence-model-watcher-v4") return latest ? "MONITOR_FUNDING_PLAN_CHANGED" : null;
  const binding = obj(bound.funding_binding);
  if (!latest || latest.id !== binding.funding_plan_id || latest.content_hash !== binding.funding_plan_hash) return "MONITOR_FUNDING_PLAN_CHANGED";
  try {
    const funding = requestFunding(db, workspace, bound, now, now)!;
    if (funding.projection.status === "expired") return "MONITOR_FUNDING_PLAN_WINDOW_EXPIRED";
    return funding.context_hash === bound.funding_context_hash ? null : "MONITOR_FUNDING_CONTEXT_CHANGED";
  } catch { return "MONITOR_FUNDING_EVIDENCE_INVALID"; }
}
function blocked(definition: Obj, inputVersion: string, at: string, code: string, next: string | null = null): InvestorObservation {
  const limit = code === "MONITOR_CHECKPOINT_LIMIT_REQUIRES_RESTART";
  const funding = code.startsWith("MONITOR_FUNDING_");
  const fundingDetail = code === "MONITOR_FUNDING_INTENTS_CONFLICT" ? "保存的年度计划与监测输入中另一笔投入意图同时存在；不能猜测是否同一笔资金或将二者相加。"
    : code === "MONITOR_FUNDING_PLAN_WINDOW_EXPIRED" ? "投入计划的研究窗口已结束；停止使用旧批次形成新调整建议。"
      : "计划版本、年度批次或保存证据需重新核验；不能继续把旧观察显示为无需调整。";
  return observationSchema.parse({ schema_version: "investor-observation-v1", outcome: "insufficient_evidence", evaluated_at: at, data_cutoff: null,
    profile_id: definition.profile_id, profile_version: definition.profile_version, input_version: inputVersion,
    gaps: [{ code, title: funding ? "投入计划需要复核" : limit ? "连续模型达到安全重放上限" : "监测来源或连续模型需复核",
      detail: funding ? fundingDetail : limit ? "新的有效收盘或企业行动需要推进状态，但已达到重放上限；不丢弃前序证据，不自动重置或拼接收益。" : "来源不再有效或连续状态未能核验；不提供旧估值，也不把缺少结论当作无需调整。",
      affected_markets: [...new Set((definition.targets as Obj[]).map(row => text(row.market)))].sort(),
      action: funding ? "核对当前投入计划并等待后台重新核验；保存计划或审阅决定均不会成交。" : limit ? "需要重新审阅有效参考方案并明确建立独立观察起点；不能用新报价延长旧来源许可。" : "补齐来源；涉及历史修订或保留期中断时需明确重述或重新建立观察起点。" }],
    reasons: ["研究模型与真实账户独立；计划资金和审阅决定不会自动改变持仓或发出订单。"], next_review_at: next,
    next_conditions: ["来源或监测输入更新后复核", "参考方案与连续模型状态完成复核"], monitoring: "not_enabled", scope: "research_model", live_advice_eligible: false });
}
function render(request: Obj, monitorDocument: Obj, assessment: Obj, next: string | null) {
  const converted = modelAssessmentObservation({ action: "monitor", document: monitorDocument, now: text(assessment.evaluated_at) }, assessment);
  return observationSchema.parse({ ...converted, input_version: request.input_version, next_review_at: next, monitoring: "active",
    gaps: converted.gaps.map(row => ({ ...row, affected_markets: [...row.affected_markets].sort() })) });
}

function currentReason(db: Database.Database, workspace: string, model: Obj, definition: Obj, now: string, bound: Obj) {
  const profile = db.prepare("SELECT id,content_hash FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1").get(workspace) as Obj | undefined;
  const selected = db.prepare("SELECT plan_id FROM investor_plan_selections WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(workspace) as Obj | undefined;
  if (!profile || profile.id !== model.profile_id || profile.content_hash !== definition.profile_hash || selected?.plan_id !== model.plan_id) return "MONITOR_PROFILE_OR_PLAN_CHANGED";
  if (time(definition.valid_until) <= time(now)) return "REFERENCE_PLAN_EXPIRED";
  return readEvidenceReference(db, workspace, text(model.plan_id), now).unavailable_reason ?? currentFundingReason(db, workspace, bound, now);
}

export function readEvidenceCheckpoint(db: Database.Database, workspace: string, model: Obj, definition: Obj, id: unknown, now: string) {
  if (id === null) return { checkpoint: null, unavailable_reason: null };
  const head = db.prepare("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?").get(id, workspace, model.id) as Obj | undefined;
  check(head && Number.isSafeInteger(head.sequence) && (head.sequence as number) >= 1 && (head.sequence as number) <= 1000);
  const headers = db.prepare("SELECT * FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? AND sequence<=? ORDER BY sequence").all(workspace, model.id, head.sequence) as Obj[];
  check(headers.length === head.sequence); let previous: Obj | null = null;
  let expiry = text(definition.valid_until);
  for (const [index,header] of headers.entries()) {
    check(header.sequence === index + 1 && header.previous_hash === (previous ? hash(previous) : null) && time(header.created_at) <= time(now));
    if (time(header.valid_until) <= time(now)) return { checkpoint: null, unavailable_reason: "MONITOR_CHECKPOINT_SOURCE_EXPIRED" };
    if (db.prepare("SELECT 1 FROM investor_monitor_payload_purges WHERE kind='checkpoint' AND entity_id=?").get(header.id)) return { checkpoint: null, unavailable_reason: "MONITOR_CHECKPOINT_PAYLOAD_PURGED" };
    const source = readInvestorMonitorEvidenceSource(db, workspace, text(model.id), text(header.input_id), now, text(header.created_at));
    if (!source.projection) return { checkpoint: null, unavailable_reason: source.unavailable_reason };
    expiry = earliest(expiry, source.document.valid_until);
    check(header.valid_until === expiry);
    const stored = payload(db, "investor_evidence_checkpoint_payloads", "checkpoint_id", header.id, 4194304); validateInvestorEvidenceCheckpoint(stored);
    const funding = stored.schema_version === "investor-evidence-model-checkpoint-v3" ? fundingAt(db, workspace, stored.funding_binding, text(header.created_at), now) : null;
    const replayed = replayEvidenceModel(definition, source.projection, previous, text(header.created_at), text(source.row.content_hash), false, funding?.request ?? null);
    check(hash(replayed.checkpoint) === header.content_hash && hash(stored) === header.content_hash && stored.projection_hash === header.projection_hash && stored.sequence === header.sequence);
    previous = stored;
  }
  return { checkpoint: previous, unavailable_reason: null };
}

/** Validate retained receipts and replay state before exposing any derivative. */
export function readEvidenceMonitorRun(db: Database.Database, workspace: string, runId: string, now: string) {
  try {
    const row = db.prepare(`SELECT u.*,j.status job_status,j.job_type,j.scope job_scope,j.period job_period,j.input_version job_input,j.command_request_id
      FROM investor_evidence_monitor_runs u JOIN job_runs j ON j.id=u.job_id WHERE u.id=? AND u.workspace_id=?`).get(runId, workspace) as Obj | undefined;
    check(row && row.job_status === "succeeded" && row.job_type === "investor_evidence_monitor" && row.command_request_id === null && row.job_scope === workspace && time(row.created_at) <= time(now));
    const run = sealed(row); validateInvestorEvidenceMonitor("run", run);
    check(run.request_id === row.request_id && run.model_id === row.model_id && run.status === row.status && run.created_at === row.created_at && run.valid_until === row.valid_until);
    const request = db.prepare("SELECT * FROM investor_evidence_monitor_requests WHERE id=? AND workspace_id=? AND model_id=?").get(row.request_id, workspace, row.model_id) as Obj | undefined;
    const model = db.prepare("SELECT * FROM investor_models WHERE id=? AND workspace_id=?").get(row.model_id, workspace) as Obj | undefined;
    check(request && model); const definition = sealed(model), bound = obj(parseStrictJson(text(request.document_json)));
    validateInvestorModelDocument("definition", definition); validateInvestorEvidenceMonitor("request", bound);
    check(bound.engine_version === "investor-evidence-model-watcher-v4" || (definition.schema_version === "investor-model-definition-v2") === (bound.engine_version === "investor-evidence-model-watcher-v3"));
    check(hash(bound) === request.input_version && request.input_version === run.input_version && request.id === row.job_period && request.input_version === row.job_input
      && bound.model_hash === model.content_hash && bound.profile_hash === definition.profile_hash && bound.control_id === request.control_id
      && definition.model_id === model.id && definition.profile_id === model.profile_id && definition.plan_id === model.plan_id && definition.created_at === model.created_at
      && time(request.created_at) <= time(row.created_at));
    const originalFunding = requestFunding(db, workspace, bound, text(request.created_at), now);
    if (originalFunding) check(originalFunding.context_hash === bound.funding_context_hash);
    const control = db.prepare("SELECT * FROM investor_model_controls WHERE id=? AND workspace_id=? AND model_id=?").get(request.control_id, workspace, model.id) as Obj | undefined;
    const input = db.prepare("SELECT * FROM investor_monitor_evidence_inputs WHERE id=? AND workspace_id=? AND model_id=?").get(request.input_id, workspace, model.id) as Obj | undefined;
    check(control && input && bound.input_hash === input.content_hash && control.enabled === 1
      && [model.created_at, control.created_at, input.created_at].every(value => time(value) <= time(request.created_at)));
    const obs = db.prepare("SELECT * FROM investor_observations WHERE id=? AND workspace_id=?").get(row.observation_id, workspace) as Obj | undefined;
    check(obs); const ref = sealed(obs); validateInvestorEvidenceMonitor("observation_ref", ref);
    check(ref.run_id === row.id && ref.outcome === obs.outcome && ref.profile_id === model.profile_id && ref.profile_version === definition.profile_version
      && ref.input_version === request.input_version && obs.input_version === request.input_version && ref.published_at === row.created_at && obs.created_at === row.created_at
      && (obs.candidate_plan_id === (obs.outcome === "insufficient_evidence" ? null : model.plan_id)));
    const unavailable = currentReason(db, workspace, model, definition, now, bound)
      ?? (time(row.valid_until) <= time(now) ? "MONITOR_RESULT_SOURCE_EXPIRED" : null)
      ?? (db.prepare("SELECT 1 FROM investor_monitor_payload_purges WHERE kind='run' AND entity_id=?").get(row.id) ? "MONITOR_RESULT_PAYLOAD_PURGED" : null);
    const unavailableResult = (reason: string) => ({ row, model, definition, request, run, observation: blocked(definition, text(request.input_version), text(row.created_at), reason), unavailable_reason: reason });
    if (unavailable) return unavailableResult(unavailable);
    const source = readInvestorMonitorEvidenceSource(db, workspace, text(model.id), text(request.input_id), now, text(row.created_at));
    const priorHeader = request.checkpoint_id === null ? null : db.prepare("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?").get(request.checkpoint_id, workspace, model.id) as Obj | undefined;
    check(request.checkpoint_id === null || priorHeader && time(priorHeader.created_at) <= time(request.created_at));
    check(bound.checkpoint_hash === (priorHeader?.content_hash ?? null));
    const expiry = earliest(input.valid_until, definition.valid_until, priorHeader?.valid_until ?? definition.valid_until);
    check(row.valid_until === (time(expiry) > time(row.created_at) ? expiry : row.created_at));
    const previous = source.projection ? readEvidenceCheckpoint(db, workspace, model, definition, request.checkpoint_id, now) : { checkpoint: null, unavailable_reason: source.unavailable_reason };
    const retained = payload(db, "investor_evidence_run_payloads", "run_id", row.id, 1048576);
    check(Object.keys(retained).sort().join() === "assessment,observation" && hash(retained) === run.payload_hash);
    let verified: InvestorObservation;
    if (retained.assessment !== null) {
      if (!source.projection || previous.unavailable_reason) return unavailableResult(previous.unavailable_reason ?? source.unavailable_reason!);
      const assessment = obj(retained.assessment); check(assessment.implementation_hash === run.implementation_hash && assessment.result_hash === run.assessment_hash && time(assessment.evaluated_at) <= time(row.created_at));
      const evaluated = millis(assessment.evaluated_at);
      const sparse = bound.engine_version !== "investor-evidence-model-watcher-v1";
      const funding = requestFunding(db, workspace, bound, evaluated, now);
      if (funding) check(funding.context_hash === bound.funding_context_hash && funding.projection.valid_until !== null
        && time(funding.projection.valid_until) > time(row.created_at));
      const replay = replayEvidenceModel(definition, source.projection, previous.checkpoint, evaluated, text(input.content_hash), sparse, funding?.request ?? null);
      const independent = replayEvidenceAssessment(replay.document, evaluated, text(run.implementation_hash));
      check(hash(independent) === hash(assessment) && hash(assessment.reason_codes) === hash(run.reason_codes)
        && hash(source.projection) === run.projection_hash && time(assessment.evaluated_at) >= time(request.created_at)
        && assessment.next_review_at !== null && time(assessment.next_review_at) > time(row.created_at)
        && run.next_check_at === earliest(nextPoll(row.created_at), definition.valid_until, expiry, assessment.next_review_at,
          ...(funding ? [funding.projection.valid_until] : [])));
      verified = render(request, replay.document, assessment, run.next_check_at as string | null);
      check(hash(verified) === run.observation_hash && hash(retained.observation) === run.observation_hash
        && row.status === (verified.outcome === "insufficient_evidence" ? "blocked" : verified.outcome));
      const expected = verified.outcome === "insufficient_evidence" ? null : replay.checkpoint;
      check(run.checkpoint_hash === (expected ? hash(expected) : null));
      if (expected) {
        if (hash(expected) === bound.checkpoint_hash) {
          check(sparse && row.checkpoint_id === request.checkpoint_id);
        } else {
          const checkpoint = db.prepare("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?").get(row.checkpoint_id, workspace, model.id) as Obj | undefined;
          check(checkpoint && checkpoint.content_hash === hash(expected) && checkpoint.input_id === input.id && checkpoint.previous_hash === bound.checkpoint_hash
            && checkpoint.projection_hash === run.projection_hash && checkpoint.sequence === expected.sequence && checkpoint.valid_until === expiry && time(checkpoint.created_at) === time(assessment.evaluated_at));
          const stored = payload(db, "investor_evidence_checkpoint_payloads", "checkpoint_id", row.checkpoint_id, 4194304); check(hash(stored) === hash(expected));
        }
      } else check(row.checkpoint_id === null);
    } else {
      let reason = previous.unavailable_reason ?? source.unavailable_reason;
      const funding = requestFunding(db, workspace, bound, text(row.created_at), now);
      if (funding) check(funding.context_hash === bound.funding_context_hash);
      if (!reason && funding) {
        if (source.projection?.funding_intent !== null) reason = "MONITOR_FUNDING_INTENTS_CONFLICT";
        else if (funding.projection.status === "expired") reason = "MONITOR_FUNDING_PLAN_WINDOW_EXPIRED";
      }
      if (!reason && source.projection) {
        try { replayEvidenceModel(definition, source.projection, previous.checkpoint, text(row.created_at), text(input.content_hash), bound.engine_version !== "investor-evidence-model-watcher-v1", funding?.request ?? null); }
        catch (error) { if (!(error instanceof EvidenceActionRestatement) && !(error instanceof EvidenceCheckpointLimitRequired)) throw error; reason = error.message; }
      }
      check(reason && row.status === "blocked" && row.checkpoint_id === null && run.assessment_hash === null && run.checkpoint_hash === null);
      verified = blocked(definition, text(request.input_version), text(row.created_at), reason);
      check(hash(verified) === run.observation_hash && hash(retained.observation) === run.observation_hash && hash(run.reason_codes) === hash([reason])
        && run.next_check_at === null && run.projection_hash === (source.projection ? hash(source.projection) : null));
    }
    return { row, model, definition, request, run, observation: verified, unavailable_reason: null };
  } catch { throw new Error("INVESTOR_EVIDENCE_INVALID"); }
}

export function readEvidenceObservationRecord(db: Database.Database, workspace: string, row: Obj, now: string): InvestorObservationRecord {
  const ref = sealed(row); validateInvestorEvidenceMonitor("observation_ref", ref);
  const read = readEvidenceMonitorRun(db, workspace, text(ref.run_id), now); check(read.row.observation_id === row.id);
  return { id: text(row.id), candidate_plan_id: read.observation.outcome === "insufficient_evidence" ? null : text(row.candidate_plan_id), content_hash: hash(read.observation), document: read.observation };
}

export function readEvidenceModelWatch(db: Database.Database, workspace: string, model: Obj, definition: Obj, profile: InvestorProfileVersion, now: string, referenceAvailable: boolean) {
  const input = db.prepare("SELECT * FROM investor_monitor_evidence_inputs WHERE workspace_id=? AND model_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(workspace, model.id) as Obj | undefined;
  if (!input) return null;
  const admission = sealed(input); validateInvestorMonitorDataDocument("input", admission);
  check(admission.workspace_id === workspace && admission.model_id === model.id && admission.created_at === input.created_at && admission.valid_until === input.valid_until);
  const control = db.prepare("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1").get(workspace, model.id) as Obj | undefined;
  check(control && [0,1].includes(control.enabled as number) && Number.isSafeInteger(control.version) && Number(control.version) >= 1
    && [model.created_at,input.created_at,control.created_at].every(value => time(value) <= time(now)));
  const request = db.prepare(`SELECT r.*,j.id job_id,j.status job_status,j.created_at job_created_at,j.lease_until,j.attempt_count,u.id run_id FROM investor_evidence_monitor_requests r
    LEFT JOIN job_runs j ON j.job_type='investor_evidence_monitor' AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.input_version AND j.command_request_id IS NULL
    LEFT JOIN investor_evidence_monitor_runs u ON u.request_id=r.id AND u.job_id=j.id WHERE r.model_id=? AND r.workspace_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get(model.id, workspace) as Obj | undefined;
  let status = "awaiting_evaluation", completed: unknown = null, next: unknown = null, nav: unknown = null, sequence = 0;
  if (request) {
    const bound = obj(parseStrictJson(text(request.document_json))); validateInvestorEvidenceMonitor("request", bound);
    check(bound.engine_version === "investor-evidence-model-watcher-v4" || (definition.schema_version === "investor-model-definition-v2") === (bound.engine_version === "investor-evidence-model-watcher-v3"));
    check(hash(bound) === request.input_version && bound.model_hash === model.content_hash && bound.profile_hash === definition.profile_hash
      && bound.control_id === request.control_id && time(request.created_at) <= time(now)
      && request.job_id && ["queued","retry_queued","running","succeeded","partial","failed","skipped","cancelled"].includes(String(request.job_status))
      && time(request.created_at) <= time(request.job_created_at) && time(request.job_created_at) <= time(now));
    const originalFunding = requestFunding(db, workspace, bound, text(request.created_at), now);
    if (originalFunding) check(originalFunding.context_hash === bound.funding_context_hash);
    const frozenControl = db.prepare("SELECT * FROM investor_model_controls WHERE id=? AND workspace_id=? AND model_id=?").get(request.control_id, workspace, model.id) as Obj | undefined;
    const frozenInput = db.prepare("SELECT * FROM investor_monitor_evidence_inputs WHERE id=? AND workspace_id=? AND model_id=?").get(request.input_id, workspace, model.id) as Obj | undefined;
    const frozenCheckpoint = request.checkpoint_id === null ? null : db.prepare("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?").get(request.checkpoint_id, workspace, model.id) as Obj | undefined;
    check(frozenControl && frozenInput && frozenControl.enabled === 1 && bound.input_hash === frozenInput.content_hash
      && (request.checkpoint_id === null || frozenCheckpoint) && bound.checkpoint_hash === (frozenCheckpoint?.content_hash ?? null)
      && [model,frozenControl,frozenInput,...(frozenCheckpoint ? [frozenCheckpoint] : [])].every(row => time(row.created_at) <= time(request.created_at)));
    status = ["failed","partial","cancelled"].includes(String(request.job_status)) ? "failed" : request.job_status === "running" && request.lease_until && time(request.lease_until) > time(now) ? "running" : Number(request.attempt_count ?? 0) > 0 ? "retrying" : "queued";
    if (request.run_id) {
      const read = readEvidenceMonitorRun(db, workspace, text(request.run_id), now);
      completed = read.row.created_at; next = read.run.next_check_at; status = read.unavailable_reason ? "outdated" : read.row.status === "observe" ? "research_observe" : read.row.status === "decision_required" ? "research_decision" : "blocked";
      nav = read.observation.model_change?.model_nav_cny ?? null;
      if (read.row.checkpoint_id) sequence = Number((db.prepare("SELECT sequence FROM investor_evidence_model_checkpoints WHERE id=?").get(read.row.checkpoint_id) as Obj).sequence);
    } else if (["succeeded","skipped"].includes(String(request.job_status))) status = "outdated";
    if (request.input_id !== input.id || bound.input_hash !== input.content_hash || request.control_id !== control.id) status = "outdated";
    if (currentFundingReason(db, workspace, bound, now)) status = "outdated";
  }
  if (next && status !== "outdated" && time(next) <= time(now)) status = "overdue";
  if (!referenceAvailable || definition.profile_id !== profile.id || definition.profile_hash !== profile.content_hash) status = "outdated";
  else if (time(definition.valid_until) <= time(now)) status = "expired";
  if (!control.enabled) status = "paused";
  return modelWatchSchema.parse({ id: model.id, profile_id: definition.profile_id, plan_id: model.plan_id, plan_hash: definition.plan_hash, valid_until: definition.valid_until,
    enabled: control.enabled === 1, status, created_at: model.created_at, completed_at: completed, next_check_at: next,
    checkpoint_sequence: sequence, initial_notional_cny: "10000", model_nav_cny: ["research_observe","research_decision"].includes(status) ? nav : null,
    ...(request ? { evaluation_input_version: request.input_version } : {}),
    source_qualification: "owner_reviewed_reconstructed", live_advice_eligible: false });
}
