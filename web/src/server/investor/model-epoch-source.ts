import type Database from "better-sqlite3";
import { hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";
import { actionJson, actionRead } from "./action-source-proof";
import { actionNyParts } from "./action-source-parsers";
import { correctionActionLedger } from "./action-correction-impact";
import { readCorrectionConsentBaseline } from "./correction-consent";
import { readRegisteredCorrectionHistory } from "./retained-monitor-history";
import { readActionReviewConfirmation } from "./action-review-lineage";
import { readManagedActionAnchorContext, MANAGED_ACTION_PREFIX } from "./managed-action-source";
import { readInvestorSourceReview, readInvestorResearchSource } from "./source-inputs";
import { readEvidenceReference } from "./reference-evidence";
import { monitorCostsAt } from "./monitor-costs";
import { readBoundPlannedFundingMonitor, readPlannedFundingMonitor } from "./planned-funding-source";
import { replayInvestorMonitorData } from "./monitor-source";
import { replayCorrectedModelEpoch } from "./model-epoch-transition";
import { validateModelEpochSource, validateInvestorMonitorDataDocument } from "./kernel-contracts";
import { readModelEpochRegistrationHeader } from "./model-epoch-registration";
import type { PlannedFundingBinding } from "./planned-funding-monitor";

type Obj = Record<string, unknown>;
function check(value: unknown, code = "INVALID"): asserts value { if (!value) throw new Error("INVESTOR_MODEL_EPOCH_SOURCE_" + code); }
function obj(value: unknown): Obj { check(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function rows(value: unknown): Obj[] { check(Array.isArray(value)); return value.map(obj); }
function text(value: unknown): string { check(typeof value === "string"); return value; }
const time = (value: unknown) => priceInstant(text(value));
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const minimum = (values: unknown[]) => values.map(text).reduce((a, b) => time(a) <= time(b) ? a : b);
const byId = (a: Obj, b: Obj) => text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0;

function baseReview(db: Database.Database, workspace: string, identifier: string, now: string) {
  if (!identifier.startsWith(MANAGED_ACTION_PREFIX)) return identifier;
  const publication = actionJson(actionRead(db, "investor_action_publications", identifier, workspace).document_json);
  const context = readManagedActionAnchorContext(db, workspace, publication.authority_id, now);
  return text(context.grant.doc.base_review_id);
}
function descendant(db: Database.Database, workspace: string, actor: { id: string }, identifier: string, handover: Obj, now: string) {
  const seen = new Set<string>();
  for (let i = 0; i < 256; i++) {
    identifier = baseReview(db, workspace, identifier, now);
    if (identifier === handover.new_review_id) return;
    check(!seen.has(identifier), "ACTION_LINEAGE_CHANGED"); seen.add(identifier);
    const row = db.prepare("SELECT id FROM investor_action_review_confirmations WHERE workspace_id=? AND new_review_id=?").get(workspace, identifier) as Obj | undefined;
    check(row, "ACTION_LINEAGE_CHANGED"); const doc = readActionReviewConfirmation(db, workspace, actor.id, row.id, now);
    identifier = text(doc.previous_review_id);
  }
  check(false, "ACTION_LINEAGE_LIMIT");
}

function settings(db: Database.Database, workspace: string, definition: Obj, reference: Obj, now: string, metadataAt = now) {
  const evidence = obj(reference.reference_evidence), request = actionRead(db, "investor_research_requests", evidence.request_id, workspace);
  const run = actionJson(actionRead(db, "investor_research_runs", evidence.run_id, workspace).document_json), parameters = obj(obj(run.result).selected_parameters);
  const source = readInvestorResearchSource(db, workspace, request as Parameters<typeof readInvestorResearchSource>[2], now);
  check(source && !source.unavailable_reason && source.payload && hash(parameters) === evidence.selected_parameters_hash);
  const execution = obj(obj(source.payload.plan).execution), tolerance = obj(parameters.tolerance), maximum = execution.max_fx_age_seconds;
  check(typeof maximum === "number" && Number.isSafeInteger(maximum));
  const selected = monitorCostsAt(db, workspace, definition, metadataAt);
  return { policy: { version: "investor-monitor-bootstrap-quality-v3", weight_band: tolerance.weight, absolute_band_cny: tolerance.absolute_cny,
    max_fx_age_seconds: Math.min(604800, maximum), costs: selected?.costs ?? null }, funding_intent: null, max_quote_age_seconds: 604800,
    ...(selected ? { cost_assumptions: selected.binding } : {}) };
}

export function auditedEpochInput(document: Obj) {
  validateModelEpochSource("input", document); const raw = structuredClone(document);
  for (const key of ["epoch", "audited_projection_hash", "audited_valid_until", "carry_hash", "carry_count", "funding_binding", "funding_context_hash"]) delete raw[key];
  Object.assign(raw, { schema_version: "investor-monitor-data-input-v4", projection_hash: document.audited_projection_hash, valid_until: document.audited_valid_until });
  validateInvestorMonitorDataDocument("input", raw); return raw;
}

/** Independent current-permission/source replay of a preview, not registration,
 * an HTTP DTO or an ordinary monitor input/checkpoint reader. */
export function replayModelEpochSource(db: Database.Database, workspace: string, actor: { id: string }, rawEpoch: unknown, rawInput: unknown, now: string, implementationHash: string) {
  return derive(db, workspace, actor, rawEpoch, rawInput, now, implementationHash).source;
}

/** The recorded clock is available only through an actual authenticated journal. */
export function replayRegisteredModelEpochSource(db: Database.Database, workspace: string, actor: { id: string }, epochId: string, now: string) {
  return db.transaction(() => {
    const recorded = readModelEpochRegistrationHeader(db, workspace, actor, epochId, now);
    return derive(db, workspace, actor, recorded.epoch, recorded.input, now, text(recorded.record.implementation_hash), recorded);
  }).deferred();
}

function derive(db: Database.Database, workspace: string, actor: { id: string }, rawEpoch: unknown, rawInput: unknown, now: string, implementationHash: string,
  recorded?: ReturnType<typeof readModelEpochRegistrationHeader>) {
  validateModelEpochSource("definition", rawEpoch); validateModelEpochSource("input", rawInput);
  return db.transaction(() => {
    check((db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as Obj | undefined)?.owner_id === actor.id);
    const epoch = obj(rawEpoch), document = obj(rawInput), frozen = text(document.created_at), at = time(now), modelId = text(epoch.model_id);
    const calculated = recorded ? text(recorded.record.calculated_at) : now;
    check(time(frozen) <= time(calculated) && time(calculated) <= at);
    check(epoch.workspace_id === workspace && epoch.actor_id === actor.id && modelId === document.model_id && epoch.created_at === frozen && time(frozen) <= at
      && same(document.epoch, { id: epoch.epoch_id, content_hash: hash(epoch) }), "EPOCH_CHANGED");
    const model = actionRead(db, "investor_models", modelId, workspace), reference = readEvidenceReference(db, workspace, text(model.plan_id), now);
    check(reference && !reference.unavailable_reason);
    const refs = rows(obj(epoch.binding).corrections), corrections: Obj[] = [], handovers = new Map<string, Obj>(), seen = new Set<string>();
    let history: ReturnType<typeof readRegisteredCorrectionHistory> | null = null, maximum = text(reference.document.valid_until), originalMaximum = maximum;
    for (const ref of refs) {
      const id = text(ref.correction_id); check(!seen.has(id), "CORRECTION_SCOPE"); seen.add(id);
      const doc = readCorrectionConsentBaseline(db, workspace, actor, id, now), current = readRegisteredCorrectionHistory(db, workspace, actor, id, now);
      const handover = readActionReviewConfirmation(db, workspace, actor.id, ref.handover_id, now), baseline = obj(doc.baseline), facts = obj(baseline.approved_facts);
      check(hash(doc) === ref.confirmation_hash && hash(handover) === ref.handover_hash && handover.schema_version === "investor-corrected-action-handover-confirmation-v1"
        && obj(handover.request).correction_id === doc.confirmation_id && obj(handover.request).expected_correction_hash === hash(doc)
        && obj(handover.source_proof).model_id === modelId && doc.model_id === modelId && time(handover.created_at) <= time(frozen), "CORRECTION_CHANGED");
      if (history) check(same(history, current), "HISTORY_CHANGED"); history = current;
      const listing = text(facts.listing_id); check(!handovers.has(listing) && Array.isArray(doc.outstanding_new_report_dates) && doc.outstanding_new_report_dates.length === 0, "CORRECTION_SCOPE");
      const request = obj(actionJson(actionRead(db, "investor_correction_impact_requests", doc.impact_request_id, workspace).document_json).body);
      const days = new Set(rows(request.decisions).map(row => text(row.date)));
      const affected = (row: Obj) => row.listing_id === listing && days.has(actionNyParts(row.ex_at ?? row.effective_at).day);
      const ledger = [...history.original_actions.filter(row => !affected(row)), ...correctionActionLedger(facts, obj(history.head.market_cutoffs).US, text(baseline.knowledge_at)).filter(affected)].sort(byId);
      check(hash(ledger) === baseline.corrected_actions_hash, "CORRECTION_CHANGED");
      corrections.push({ baseline, corrected_actions: ledger, confirmation_hash: ref.confirmation_hash, handover_id: ref.handover_id, handover_hash: ref.handover_hash, handover_at: handover.created_at });
      handovers.set(listing, handover); maximum = minimum([maximum, doc.valid_until, handover.source_valid_until, history.proof.source_valid_until]);
      originalMaximum = minimum([originalMaximum, doc.valid_until, handover.source_valid_until, obj(baseline.original_history).source_valid_until]);
    }
    check(history && same(history.definition, actionJson(model.document_json)));
    const definition = history.definition, head = db.prepare("SELECT id,content_hash FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? ORDER BY sequence DESC LIMIT 1").get(workspace, modelId) as Obj | undefined;
    if (!recorded) check(head && head.id === history.proof.head_checkpoint_id && head.content_hash === hash(history.head), "LATEST_HEAD_CHANGED");
    else check(epoch.original_head_id === history.proof.head_checkpoint_id, "ORIGINAL_HEAD_CHANGED");
    const control = (recorded ? db.prepare("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? AND created_at<=? ORDER BY version DESC LIMIT 1").get(workspace, modelId, calculated)
      : db.prepare("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1").get(workspace, modelId)) as Obj | undefined;
    check(control && time(control.created_at) <= time(frozen), "CONTROL_CHANGED");
    let funding: ReturnType<typeof readPlannedFundingMonitor> = null;
    if (recorded) {
      check(control.enabled === 1, "RECORDED_CONTROL_CHANGED");
      const selected = db.prepare("SELECT id,content_hash FROM investor_funding_plans WHERE workspace_id=? AND created_at<=? ORDER BY version DESC LIMIT 1").get(workspace, calculated) as Obj | undefined;
      check(Boolean(selected) === Boolean(document.funding_binding), "RECORDED_FUNDING_CHANGED");
      if (selected) {
        const binding = obj(document.funding_binding);
        check(binding.funding_plan_id === selected.id && binding.funding_plan_hash === selected.content_hash, "RECORDED_FUNDING_CHANGED");
        funding = readBoundPlannedFundingMonitor(db, actor, workspace, binding as PlannedFundingBinding, calculated, now);
        check(funding.context_hash === document.funding_context_hash, "RECORDED_FUNDING_CHANGED");
      }
    } else funding = readPlannedFundingMonitor(db, actor, workspace, modelId, now);
    const frozenFunding = funding ? readBoundPlannedFundingMonitor(db, actor, workspace, funding.request.binding, frozen, now) : null;
    check((funding?.context_hash ?? null) === (frozenFunding?.context_hash ?? null), "FUNDING_CHANGED");
    const rawDocument = auditedEpochInput(document), raw = replayInvestorMonitorData(db, workspace, definition, reference.document.targets as unknown as Obj[], rawDocument, now, calculated);
    check(!raw.unavailable_reason && raw.projection && raw.catalog, raw.unavailable_reason ?? "CURRENT_INPUTS_NOT_READY");
    check(same(rawDocument.settings, settings(db, workspace, definition, reference.document as unknown as Obj, now, recorded ? frozen : now)), "SETTINGS_CHANGED");
    const originalProjection = raw.projection; check(Array.isArray(originalProjection.quality_gaps) && originalProjection.quality_gaps.length === 0 && time(calculated) < time(originalProjection.valid_until), "CURRENT_INPUTS_NOT_READY");
    const selected = new Map<string, ReturnType<typeof readInvestorSourceReview>>();
    for (const segment of rows(document.segments)) for (const ref of rows(obj(segment.snapshot).review_refs)) {
      const source = readInvestorSourceReview(db, workspace, ref, now); if (source.source.kind !== "actions") continue;
      const listing = text(source.facts.listing_id);
      check(!selected.has(listing) || same(selected.get(listing), source), "ACTION_SELECTION_CHANGED"); selected.set(listing, source);
    }
    for (const [listing, handover] of handovers) {
      const source = selected.get(listing), asset = raw.catalog[listing];
      check(source && asset?.market === "US" && asset.currency === "USD", "ACTION_SELECTION_CHANGED");
      descendant(db, workspace, actor, text(source.row.id), handover, now);
    }
    const changed = new Set(corrections.map(entry => text(obj(obj(entry.baseline).approved_facts).listing_id)));
    const carry = [...history.original_actions.filter(row => !changed.has(text(row.listing_id))), ...corrections.flatMap(entry =>
      rows(entry.corrected_actions).filter(row => row.listing_id === obj(obj(entry.baseline).approved_facts).listing_id))].sort(byId);
    const indexed = new Map(carry.map(row => [text(row.id), row])), targets = new Map(rows(definition.targets).map(row => [text(row.listing_id), row])), future: Obj[] = [];
    const economics = (row: Obj) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "known_at"));
    for (const action of rows(originalProjection.corporate_actions)) {
      const target = targets.get(text(action.listing_id)); check(target);
      if (time(action.effective_at) > time(obj(history.head.market_cutoffs)[text(target.market)])) { future.push(action); continue; }
      const old = indexed.get(text(action.id)); check(old && same(economics(old), economics(action)) && time(old.known_at) <= time(action.known_at), "HISTORICAL_ACTION_CHANGED");
    }
    const ceiling = text(epoch.valid_until); check(at < time(ceiling) && at < time(maximum) && time(ceiling) <= time(recorded ? originalMaximum : maximum), "EXPIRED");
    const economic = structuredClone(originalProjection); economic.corporate_actions = [...carry, ...future].sort(byId);
    economic.valid_until = minimum([economic.valid_until, ceiling, ...(funding ? [funding.projection.valid_until] : [])]);
    for (const row of [...rows(economic.quotes), ...rows(economic.fx)]) row.valid_until = minimum([row.valid_until, ceiling]);
    const kernel: Obj = { schema_version: "investor-model-epoch-transition-input-v1", epoch_id: epoch.epoch_id,
      history: { definition: history.definition, origin: history.origin, head: history.head, origin_projection: history.origin_projection,
        head_projection: history.head_projection, original_actions: history.original_actions, corrected_coverage: history.head_projection.corporate_action_coverage },
      corrections, projection: economic, input_hash: hash(rawDocument), planned_funding: funding?.request ?? null, now: calculated };
    const first = replayCorrectedModelEpoch(kernel, implementationHash);
    const rebuiltEpoch = { schema_version: "investor-model-epoch-definition-v1", epoch_id: epoch.epoch_id, workspace_id: workspace, actor_id: actor.id,
      model_id: modelId, model_hash: hash(definition), model_control: { id: control.id, content_hash: hash(control) }, original_head_id: history.proof.head_checkpoint_id,
      binding: first.epoch_binding, created_at: frozen, valid_until: ceiling, purpose: "private_economic_epoch_basis_not_trading_authority" };
    check(same(rebuiltEpoch, epoch), "EPOCH_CHANGED");
    const ref = { id: epoch.epoch_id, content_hash: hash(epoch) }, projection = { schema_version: "investor-monitor-data-projection-v4", epoch: ref,
      knowledge_protocol: "approved_economic_restatement_and_recorded_carry_not_pit", economic_projection: economic };
    const rebuiltInput = { ...rawDocument, schema_version: "investor-monitor-data-input-v6", epoch: ref, audited_projection_hash: rawDocument.projection_hash,
      audited_valid_until: rawDocument.valid_until, carry_hash: hash(carry), carry_count: carry.length, projection_hash: hash(projection), valid_until: minimum([rawDocument.valid_until, ceiling]),
      ...(funding ? { funding_binding: funding.request.binding, funding_context_hash: funding.context_hash } : {}) };
    check(same(rebuiltInput, document), "DERIVATION_CHANGED"); validateModelEpochSource("projection", projection);
    Object.assign(kernel, { projection, input_hash: hash(document) }); const candidate = replayCorrectedModelEpoch(kernel, implementationHash);
    const proof = { schema_version: "investor-model-epoch-source-proof-v1", workspace_id: workspace, actor_id: actor.id, model_id: modelId, epoch: ref,
      input_hash: hash(document), projection_hash: hash(projection), original_head_id: epoch.original_head_id, original_chain_hash: history.proof.checkpoint_chain_hash,
      checked_at: calculated, valid_until: economic.valid_until, status: "qualified_sources_prepared_not_registered", coverage_basis: "selected_reports_and_owner_assumptions_not_objective_absence",
      source_evidence_verified: true, epoch_registered: false, current_source_eligibility_restored: false, checkpoint_created: false, monitoring_resumed: false, trading_permission: false,
      provider_calls: 0, database_writes: 0, distribution: "private_owner_only_not_ai" };
    validateModelEpochSource("proof", proof);
    return { source: { epoch_definition: rebuiltEpoch, input: rebuiltInput, projection, proof, kernel_input: kernel, candidate }, read_valid_until: minimum([maximum, ceiling]) };
  }).deferred();
}
