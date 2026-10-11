import type Database from "better-sqlite3";
import { hash } from "../ledger/service";
import { Decimal } from "../ledger/decimal";
import { parseStrictJson } from "../strict-json";
import { priceInstant } from "../market-price-source";
import { getInvestorState } from "./service";
import { readEvidenceMonitorRun } from "./evidence-monitor";
import { readInvestorSourceReview } from "./source-inputs";
import { aiLimitations, aiMonitorContextSchema, type AiMonitorContext } from "./ai-explanation-schemas";

type Obj = Record<string, unknown>;
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_AI_EVIDENCE_INVALID"); }
function obj(value: unknown): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function text(value: unknown): string { check(typeof value === "string"); return value; }
function rows(value: unknown): Obj[] { check(Array.isArray(value)); return value.map(obj); }
const time = (value: unknown) => priceInstant(text(value));
function sealed(row: Obj) { const value = obj(parseStrictJson(text(row.document_json))); check(hash(value) === row.content_hash); return value; }
export type PreparedAiExplanation = { context: AiMonitorContext; context_hash: string; binding_hash: string; workspace_id: string;
  observation_id: string; valid_until: string; rights_review_hashes: string[] };

/** Full local replay first; only a closed ratio/code allowlist may leave this function. */
export function prepareInvestorAiExplanation(db: Database.Database, actor: { id: string }, now: string): PreparedAiExplanation {
  return db.transaction(() => {
    const state = getInvestorState(db, actor, now);
    if (!state.workspace_id || !state.latest || !state.profile || !state.plan || !state.model_watch
      || !["observe", "decision_required"].includes(state.effective_outcome)
      || !["research_observe", "research_decision"].includes(state.model_watch.status)
      || !state.model_watch.enabled || state.effective_gaps.length)
      throw new Error("INVESTOR_AI_NO_CURRENT_OBSERVATION");
    const workspace = state.workspace_id, raw = db.prepare("SELECT * FROM investor_observations WHERE id=? AND workspace_id=?")
      .get(state.latest.id, workspace) as Obj | undefined;
    check(raw); const ref = sealed(raw);
    if (ref.schema_version !== "investor-model-observation-ref-v1") throw new Error("INVESTOR_AI_NO_QUALIFIED_MONITOR");
    const verified = readEvidenceMonitorRun(db, workspace, text(ref.run_id), now);
    check(!verified.unavailable_reason && verified.row.observation_id === state.latest.id && verified.model.id === state.model_watch.id
      && verified.model.plan_id === state.plan.id && verified.request.input_version === state.model_watch.evaluation_input_version
      && hash(verified.observation) === state.latest.content_hash);
    const observation = verified.observation, change = observation.model_change;
    check(change && change.changes.length && observation.next_review_at && observation.data_cutoff
      && observation.outcome !== "insufficient_evidence" && observation.monitoring === "active");
    const sourceRows = new Map<string, Obj>(), snapshots: Obj[] = [], deadlines: string[] = [
      text(verified.run.valid_until), text(verified.definition.valid_until), observation.next_review_at,
    ];
    const addSource = (row: Obj, monitor: boolean) => {
      const id = text(row.id); if (sourceRows.has(id)) return;
      const document = sealed(row); check(time(row.created_at) <= time(now) && time(document.valid_until) > time(now));
      sourceRows.set(id, row); deadlines.push(text(document.valid_until));
      snapshots.push(...(monitor ? rows(document.segments).map(segment => obj(segment.snapshot)) : [obj(document.snapshot)]));
    };
    const reference = db.prepare("SELECT i.* FROM investor_evidence_inputs i JOIN investor_reference_evidence e ON e.evidence_input_id=i.id AND e.workspace_id=i.workspace_id WHERE e.plan_id=? AND e.workspace_id=?")
      .get(state.plan.id, workspace) as Obj | undefined;
    check(reference); addSource(reference, false);
    const inputIds = new Set([text(verified.request.input_id)]);
    if (verified.request.checkpoint_id !== null) {
      const prior = db.prepare("SELECT sequence FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?")
        .get(verified.request.checkpoint_id, workspace, verified.model.id) as { sequence: number } | undefined;
      check(prior && Number.isSafeInteger(prior.sequence) && prior.sequence > 0 && prior.sequence <= 1000);
      const headers = db.prepare("SELECT input_id FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? AND sequence<=? ORDER BY sequence")
        .all(workspace, verified.model.id, prior.sequence) as { input_id: string }[];
      check(headers.length === prior.sequence); headers.forEach(row => inputIds.add(row.input_id));
    }
    for (const id of inputIds) {
      const source = db.prepare("SELECT * FROM investor_monitor_evidence_inputs WHERE id=? AND workspace_id=? AND model_id=?")
        .get(id, workspace, verified.model.id) as Obj | undefined;
      check(source); addSource(source, true);
    }
    const rights = new Map<string, string>();
    for (const snapshot of snapshots) {
      const refs = new Map(rows(snapshot.review_refs).map(ref => [text(ref.review_id), ref]));
      const captures = rows(snapshot.capture_refs); check(captures.length > 0);
      for (const ref of captures) {
        const confirmed = snapshot.schema_version === "investor-monitor-price-snapshot-v1" && ref.kind === "confirmed_sdk";
        const captureRights = (confirmed ? db.prepare("SELECT DISTINCT rights_review_id FROM investor_confirmed_targets WHERE capture_id=? AND workspace_id=?")
          : db.prepare("SELECT rights_review_id FROM investor_price_captures WHERE id=? AND workspace_id=?")).all(ref.capture_id, workspace) as { rights_review_id: string }[];
        check(captureRights.length > 0 && captureRights.every(row => refs.has(row.rights_review_id)));
        for (const capture of captureRights) {
          if (rights.has(capture.rights_review_id)) continue;
          const review = readInvestorSourceReview(db, workspace, refs.get(capture.rights_review_id)!, now);
          check(review.source.kind === "rights" && time(review.facts.valid_from) <= time(now) && time(review.facts.valid_until) > time(now));
          if (!Array.isArray(review.facts.uses) || !review.facts.uses.includes("external_ai"))
            throw new Error("INVESTOR_AI_SOURCE_SHARING_NOT_APPROVED");
          rights.set(review.row.id, review.row.content_hash); deadlines.push(review.row.valid_until, text(review.facts.valid_until));
        }
      }
    }
    check(rights.size > 0);
    const asOf = observation.evaluated_at;
    const maximum = change.changes.reduce((largest, row) => Decimal.max(largest, new Decimal(row.after_target_weight).sub(row.observed_model_weight).abs()), new Decimal(0));
    const fact = (name: string, value: string) => ({ evidence_id: "derived:" + name, metric: "model." + name, value, as_of: asOf });
    const ratio = (value: Decimal) => value.toDecimalPlaces(18, Decimal.ROUND_HALF_EVEN).toFixed();
    const evidence = [fact("max_abs_target_gap", ratio(maximum)), fact("target_change_count", String(change.changes.filter(row => !new Decimal(row.before_target_weight).eq(row.after_target_weight)).length))];
    if (change.estimated_cost_cny !== null && change.model_nav_cny !== null && new Decimal(change.model_nav_cny).gt(0))
      evidence.push(fact("estimated_cost_ratio", ratio(new Decimal(change.estimated_cost_cny).div(change.model_nav_cny))));
    const context = aiMonitorContextSchema.parse({ schema_version: "ai-monitor-context-v1", deterministic_outcome: observation.outcome,
      evaluated_at: asOf, evidence, trigger_codes: [...new Set(rowsOrCodes(verified.run.reason_codes))].sort(), limitations: aiLimitations,
      strategy_gates: { investment_gate_passed: false, live_advice_eligible: false } });
    const validUntil = deadlines.reduce((earliest, value) => time(value) < time(earliest) ? value : earliest);
    check(time(validUntil) > time(now));
    const contextHash = hash(context), binding = { schema_version: "investor-ai-binding-v1", workspace_id: workspace, revision: state.revision,
      profile_id: state.profile.id, profile_hash: state.profile.content_hash, plan_id: state.plan.id, plan_hash: state.plan.content_hash,
      model_id: verified.model.id, model_hash: verified.model.content_hash, observation_id: state.latest.id, reference_hash: raw.content_hash,
      observation_hash: state.latest.content_hash, run_hash: verified.row.content_hash, request_hash: verified.request.input_version,
      sources: [...sourceRows.values()].map(row => ({ id: row.id, hash: row.content_hash })).sort((a,b) => text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0),
      rights: [...rights].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0), context_hash: contextHash, valid_until: validUntil };
    return { context, context_hash: contextHash, binding_hash: hash(binding), workspace_id: workspace, observation_id: state.latest.id,
      valid_until: validUntil, rights_review_hashes: [...rights.values()].sort() };
  }).deferred();
}
function rowsOrCodes(value: unknown): string[] { check(Array.isArray(value)); return value.map(text); }
