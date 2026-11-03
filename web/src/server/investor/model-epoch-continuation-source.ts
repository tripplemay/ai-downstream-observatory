import type Database from "better-sqlite3";
import { Decimal } from "../ledger/decimal";
import { hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";
import { readEpochContinuationChain } from "./epoch-continuation";
import { auditedEpochInput, modelEpochActionBaseline, modelEpochSourceSettings, verifyModelEpochActionDescendant } from "./model-epoch-source";
import { readInvestorSourceReview, type VerifiedSourceReview } from "./source-inputs";
import { readEvidenceReference } from "./reference-evidence";
import { readBoundPlannedFundingMonitor, readPlannedFundingMonitor } from "./planned-funding-source";
import { replayInvestorMonitorData } from "./monitor-source";
import { replayModelEpochContinuation } from "./model-epoch-transition";
import { transitionActionReview } from "./action-review-selection";
import { validateModelEpochContinuationSource, validateModelEpochSource } from "./kernel-contracts";

type Obj = Record<string, unknown>;
function check(value: unknown, code = "INVALID"): asserts value { if (!value) throw new Error("INVESTOR_MODEL_EPOCH_CONTINUATION_SOURCE_" + code); }
function obj(value: unknown): Obj { check(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function rows(value: unknown): Obj[] { check(Array.isArray(value)); return value.map(obj); }
function text(value: unknown): string { check(typeof value === "string"); return value; }
const time = (value: unknown) => priceInstant(text(value));
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const minimum = (values: unknown[]) => values.map(text).reduce((a, b) => time(a) <= time(b) ? a : b);
const byId = (a: Obj, b: Obj) => text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0;

function actions(db: Database.Database, workspace: string, document: Obj, now: string, requireCurrent = false) {
  const values = new Map<string, VerifiedSourceReview>();
  for (const segment of rows(document.segments)) {
    const snapshot = obj(segment.snapshot);
    for (const ref of rows(snapshot.review_refs)) {
      const value = readInvestorSourceReview(db, workspace, ref, now); if (value.source.kind !== "actions") continue;
      const listing = text(value.facts.listing_id);
      check(!values.has(listing) || same(values.get(listing), value), "ACTION_SELECTION_CHANGED");
      if (requireCurrent) check(transitionActionReview(db, workspace, ref, text(snapshot.range_start), text(snapshot.range_end), now).row.id === value.row.id, "ACTION_SELECTION_CHANGED");
      values.set(listing, value);
    }
  }
  return values;
}

/** Same bounded selection rules as core, recomputed independently in Node. */
function currentFx(db: Database.Database, workspace: string, targets: Obj[], settings: Obj, now: string) {
  const currencies = [...new Set(targets.map(row => text(row.currency)).filter(row => row !== "CNY"))].sort();
  if (!currencies.length) return [];
  const refs = db.prepare(`SELECT r.id review_id,r.content_hash review_hash,r.source_id,s.content_hash source_hash
    FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id AND s.workspace_id=r.workspace_id
    WHERE r.workspace_id=? AND s.kind='fx' AND r.decision='approved' AND r.created_at<=? AND r.valid_until>?
      AND r.version=(SELECT max(version) FROM investor_data_reviews WHERE source_id=r.source_id)
      AND (NOT EXISTS(SELECT 1 FROM investor_fx_publications p WHERE p.workspace_id=r.workspace_id AND (p.usd_review_id=r.id OR p.hkd_review_id=r.id))
        OR EXISTS(SELECT 1 FROM investor_fx_publications p JOIN investor_fx_authorities a ON a.id=p.authority_id AND a.workspace_id=p.workspace_id
          JOIN investor_fx_controls c ON c.id=json_extract(p.document_json,'$.control_id') AND c.authority_id=a.id
          WHERE p.workspace_id=r.workspace_id AND (p.usd_review_id=r.id OR p.hkd_review_id=r.id)
            AND p.id=(SELECT id FROM investor_fx_publications head WHERE head.authority_id=p.authority_id AND head.status='published' ORDER BY head.sequence DESC LIMIT 1)
            AND c.enabled=1 AND c.version=(SELECT max(version) FROM investor_fx_controls WHERE authority_id=a.id)
            AND c.created_at<=? AND json_extract(a.document_json,'$.valid_from')<=? AND json_extract(a.document_json,'$.valid_until')>?))
    ORDER BY r.created_at DESC,r.id LIMIT 129`).all(workspace, now, now, now, now, now) as Obj[];
  check(refs.length <= 128, "FX_SOURCE_LIMIT");
  const reviews = refs.map(ref => readInvestorSourceReview(db, workspace, ref, now)), age = obj(settings.policy).max_fx_age_seconds;
  check(typeof age === "number" && Number.isSafeInteger(age) && age >= 1 && age <= 604800);
  let count = 0; const selected: string[] = [];
  for (const currency of currencies) {
    const history = reviews.filter(value => value.facts.currency === currency), tails = new Map<VerifiedSourceReview, bigint>();
    for (const review of history) {
      const facts = rows(review.facts.rows); count += facts.length; check(count <= 100000, "FX_SOURCE_LIMIT");
      check(facts.every(row => time(row.assumed_available_at) <= time(review.row.created_at)), "FX_SOURCE_INVALID");
      tails.set(review, facts.map(row => time(row.observed_at)).reduce((a, b) => a > b ? a : b));
    }
    const candidates = history.filter(review => tails.get(review)! + BigInt(age) * 1000000n > time(now)); check(candidates.length, "FX_NOT_CURRENT");
    const series = candidates[0].facts.monitor_series;
    if (candidates.length > 1) check(series && candidates.every(review => same(review.facts.monitor_series ?? null, series)), "FX_AUTHORITY_AMBIGUOUS");
    if (series) {
      const overlap = new Map<bigint, Obj>();
      for (const review of history.filter(value => same(value.facts.monitor_series ?? null, series))) for (const row of rows(review.facts.rows)) {
        const key = time(row.observed_at), old = overlap.get(key);
        check(!old || new Decimal(text(old.value)).eq(text(row.value)) && time(old.assumed_available_at) === time(row.assumed_available_at), "FX_RESTATEMENT_REQUIRED");
        overlap.set(key, row);
      }
    }
    const tail = candidates.map(review => tails.get(review)!).reduce((a, b) => a > b ? a : b);
    const eligible = candidates.filter(review => tails.get(review) === tail).sort((a, b) => rows(b.facts.rows).length - rows(a.facts.rows).length
      || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
    selected.push(eligible[0].row.id);
  }
  return selected.sort();
}

/** Current preparation only. The actual full chain supplies the predecessor. */
export function replayModelEpochContinuationSource(db: Database.Database, workspace: string, actor: { id: string }, epochId: string, rawInput: unknown, now: string, implementationHash: string) {
  validateModelEpochSource("input", rawInput);
  return db.transaction(() => {
    const document = obj(rawInput), frozen = text(document.created_at), at = time(now); check(time(frozen) <= at);
    const chain = readEpochContinuationChain(db, workspace, actor, epochId, now), saved = chain.root, root = saved.source, prior = chain.source, record = chain.head;
    const definition = chain.definition, previous = obj(obj(prior.candidate).checkpoint);
    const modelId = text(definition.model_id), epoch = obj(saved.registration.epoch);
    check(same(document.epoch, epoch), "EPOCH_CHANGED");
    const head = db.prepare("SELECT id,content_hash,input_id FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? ORDER BY sequence DESC LIMIT 1").get(workspace, modelId) as Obj | undefined;
    const latest = db.prepare("SELECT id,content_hash FROM investor_monitor_evidence_inputs WHERE workspace_id=? AND model_id=? ORDER BY rowid DESC LIMIT 1").get(workspace, modelId) as Obj | undefined;
    check(head && latest && head.id === record.checkpoint.id && head.content_hash === hash(previous) && same(latest, record.input), "LATEST_HEAD_CHANGED");
    const control = db.prepare("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1").get(workspace, modelId) as Obj | undefined;
    check(control && control.enabled === 1 && time(control.created_at) <= time(frozen)
      && same({ id: control.id, content_hash: hash(control) }, root.epoch_definition.model_control), "CONTROL_CHANGED");
    const funding = readPlannedFundingMonitor(db, actor, workspace, modelId, now);
    check(same(funding?.request.binding ?? null, obj(prior.input).funding_binding ?? null), "FUNDING_PLAN_CHANGED");
    const frozenFunding = funding ? readBoundPlannedFundingMonitor(db, actor, workspace, funding.request.binding, frozen, now) : null;
    check((funding?.context_hash ?? null) === (frozenFunding?.context_hash ?? null), "FUNDING_CONTEXT_CHANGED");
    const reference = readEvidenceReference(db, workspace, text(definition.plan_id), now); check(!reference.unavailable_reason);
    const rawDocument = auditedEpochInput(document), raw = replayInvestorMonitorData(db, workspace, definition, reference.document.targets as unknown as Obj[], rawDocument, now);
    check(!raw.unavailable_reason && raw.projection && raw.catalog, raw.unavailable_reason ?? "CURRENT_INPUTS_NOT_READY");
    check(same(rawDocument.settings, modelEpochSourceSettings(db, workspace, definition, reference.document as unknown as Obj, now)), "SETTINGS_CHANGED");
    const economic = structuredClone(raw.projection);
    check(Array.isArray(economic.quality_gaps) && !economic.quality_gaps.length && at < time(economic.valid_until), "CURRENT_INPUTS_NOT_READY");
    const selected = actions(db, workspace, rawDocument, now, true), anchors = actions(db, workspace, obj(prior.input), now);
    check(same([...selected.keys()].sort(), [...anchors.keys()].sort()), "ACTION_SELECTION_CHANGED");
    for (const [listing, current] of selected) verifyModelEpochActionDescendant(db, workspace, actor, current.row.id,
      { new_review_id: modelEpochActionBaseline(db, workspace, anchors.get(listing)!.row.id, now) }, now);
    const selectedFx = new Set<string>();
    for (const segment of rows(rawDocument.segments)) for (const ref of rows(obj(segment.snapshot).review_refs)) {
      const value = readInvestorSourceReview(db, workspace, ref, now); if (value.source.kind === "fx") selectedFx.add(value.row.id);
    }
    check(same([...selectedFx].sort(), currentFx(db, workspace, rows(definition.targets), obj(rawDocument.settings), now)), "FX_SELECTION_CHANGED");
    const targets = new Map(rows(definition.targets).map(row => [text(row.listing_id), row]));
    const historical = (row: Obj) => { const target = targets.get(text(row.listing_id)); check(target); return time(row.effective_at) <= time(obj(previous.market_cutoffs)[text(target.market)]); };
    const carry = rows(obj(obj(prior.projection).economic_projection).corporate_actions).filter(historical).sort(byId), indexed = new Map(carry.map(row => [text(row.id), row]));
    check(indexed.size === carry.length && same(Object.fromEntries(carry.map(row => [text(row.id), hash(row)])), previous.processed_actions), "PREVIOUS_LEDGER_CHANGED");
    const future: Obj[] = [], economics = (row: Obj) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "known_at"));
    for (const action of rows(economic.corporate_actions)) {
      if (!historical(action)) { future.push(action); continue; }
      const old = indexed.get(text(action.id)); check(old && same(economics(old), economics(action)) && time(old.known_at) <= time(action.known_at), "HISTORICAL_ACTION_CHANGED");
    }
    const ceiling = minimum([chain.read_valid_until, root.epoch_definition.valid_until]); check(at < time(ceiling), "EXPIRED");
    economic.corporate_actions = [...carry, ...future].sort(byId);
    economic.valid_until = minimum([economic.valid_until, ceiling, ...(funding ? [funding.projection.valid_until] : [])]);
    for (const row of [...rows(economic.quotes), ...rows(economic.fx)]) row.valid_until = minimum([row.valid_until, ceiling]);
    const projection = { schema_version: "investor-monitor-data-projection-v4", epoch, knowledge_protocol: "approved_economic_restatement_and_recorded_carry_not_pit", economic_projection: economic };
    const rebuilt = { ...rawDocument, schema_version: "investor-monitor-data-input-v6", epoch, audited_projection_hash: rawDocument.projection_hash,
      audited_valid_until: rawDocument.valid_until, carry_hash: hash(carry), carry_count: carry.length, projection_hash: hash(projection), valid_until: minimum([rawDocument.valid_until, ceiling]),
      ...(funding ? { funding_binding: funding.request.binding, funding_context_hash: funding.context_hash } : {}) };
    validateModelEpochSource("projection", projection); check(same(rebuilt, document), "DERIVATION_CHANGED");
    const kernel = { schema_version: "investor-model-epoch-continuation-input-v1", definition, previous, projection, input_hash: hash(document), planned_funding: funding?.request ?? null, now };
    const candidate = replayModelEpochContinuation(kernel, implementationHash);
    const proof = { schema_version: "investor-model-epoch-continuation-source-proof-v1", workspace_id: workspace, actor_id: actor.id, model_id: modelId,
      epoch, registration_hash: saved.proof.registration_hash, previous_input: record.input, previous_checkpoint: record.checkpoint,
      model_control: { id: control.id, content_hash: hash(control) }, input_hash: hash(document), projection_hash: hash(projection), checked_at: now,
      valid_until: economic.valid_until, status: "qualified_continuation_prepared_not_admitted", epoch_registration_verified: true, previous_state_verified: true, source_evidence_verified: true,
      continuation_admitted: false, current_source_eligibility_restored: false, checkpoint_created: false, monitoring_resumed: false, trading_permission: false,
      provider_calls: 0, database_writes: 0, distribution: "private_owner_only_not_ai" };
    validateModelEpochContinuationSource(proof);
    return { epoch_definition: root.epoch_definition, input: rebuilt, projection, proof, kernel_input: kernel, candidate };
  }).deferred();
}
