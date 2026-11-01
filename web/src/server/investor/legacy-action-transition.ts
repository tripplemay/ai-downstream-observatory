import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { Decimal } from "../ledger/decimal";
import { priceInstant } from "../market-price-source";
import { parseStrictJson } from "../strict-json";
import { validateInvestorEvidenceCheckpoint, validateInvestorModelDocument, validateInvestorMonitorDataDocument, validateLegacyActionTransitionPreview, validateLegacyTransitionWorkflow } from "./kernel-contracts";
import { readLegacyTransitionInput } from "./action-checkpoint-replay";
import { transitionActionReview } from "./action-review-selection";
import { MANAGED_ACTION_PREFIX } from "./managed-action-source";
import { actionAvailabilityRefs, indexActionAvailability } from "./monitor-action-knowledge";
import { compareInvestorMonitorData } from "./monitor-source";
import { readEvidenceReference } from "./reference-evidence";
import { monitorCostsAt, verifyMonitorCostSettings } from "./monitor-costs";
import { replayEvidenceModel } from "./evidence-model-state";
import { readBoundPlannedFundingMonitor } from "./planned-funding-source";
import type { PlannedFundingBinding } from "./planned-funding-monitor";
import type { VerifiedSourceReview } from "./source-inputs";

type Obj = Record<string, unknown>;
type Ledger = Map<string, { action: Obj; input_id: string; input_hash: string }>;
const legacy = new Set(["investor-monitor-data-input-v1", "investor-monitor-data-input-v2", "investor-monitor-data-input-v3"]);
function check(value: unknown): asserts value { if (!value) throw new Error("LEGACY_TRANSITION_INVALID"); }
function text(value: unknown): string { check(typeof value === "string"); return value; }
function obj(value: unknown): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function rows(value: unknown): Obj[] { check(Array.isArray(value)); return value.map(obj); }
const time = (value: unknown) => priceInstant(text(value));
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function millis(value: unknown) { const at = time(value); check(at % 1000n === 0n); return new Date(Number(at / 1000n)).toISOString(); }
function earliest(values: unknown[]) { return millis(values.reduce((a,b) => time(a) < time(b) ? a : b)); }
function payload(db: Database.Database, id: unknown) {
  const row = db.prepare("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?").get(id) as { payload: Buffer } | undefined;
  check(row && Buffer.isBuffer(row.payload) && row.payload.length > 0 && row.payload.length <= 4194304);
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(row.payload), value = obj(parseStrictJson(raw));
  check(canonical(value) === raw); validateInvestorEvidenceCheckpoint(value); return value;
}
function originalChain(db: Database.Database, actor: { id: string }, workspace: string, definition: Obj, now: string, through: number | null = null) {
  check(through === null || Number.isInteger(through) && through >= 1 && through <= 1000);
  const headers = db.prepare("SELECT * FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? AND (? IS NULL OR sequence<=?) ORDER BY sequence LIMIT 1001")
    .all(workspace, definition.model_id, through, through) as Obj[];
  check(headers.length > 0 && headers.length <= 1000 && (through === null || headers.length === through));
  let previous: Obj | null = null, expiry = text(definition.valid_until);
  const ledger: Ledger = new Map(), bindings: Obj[] = [];
  for (const [index, header] of headers.entries()) {
    check(header.sequence === index + 1 && header.previous_hash === (previous ? hash(previous) : null)
      && time(header.created_at) <= time(now) && time(now) < time(header.valid_until)
      && !db.prepare("SELECT 1 FROM investor_monitor_payload_purges WHERE kind='checkpoint' AND entity_id=?").get(header.id));
    const source = readLegacyTransitionInput(db, actor, workspace, text(definition.model_id), text(header.input_id), now);
    check(source.projection && !source.unavailable_reason); expiry = earliest([expiry, source.document.valid_until]);
    check(header.valid_until === expiry);
    verifyMonitorCostSettings(db, workspace, definition, obj(source.document.settings), text(header.created_at));
    const stored = payload(db, header.id);
    const funding = stored.schema_version === "investor-evidence-model-checkpoint-v3" ? readBoundPlannedFundingMonitor(db, actor, workspace,
      stored.funding_binding as PlannedFundingBinding, text(header.created_at), now) : null;
    const replay = replayEvidenceModel(definition, source.projection, previous, text(header.created_at), text(source.row.content_hash), false, funding?.request ?? null);
    check(same(replay.checkpoint, stored) && hash(stored) === header.content_hash && stored.projection_hash === header.projection_hash
      && header.projection_hash === hash(source.projection));
    const processed = obj(stored.processed_actions);
    for (const action of rows(source.projection.corporate_actions)) {
      const id = text(action.id); check(processed[id] === hash(action));
      if (!ledger.has(id)) ledger.set(id, { action, input_id: text(source.row.id), input_hash: text(source.row.content_hash) });
    }
    check(same(Object.fromEntries([...ledger].map(([id,value]) => [id, hash(value.action)])), processed));
    bindings.push({ ...header, input_hash: source.row.content_hash }); previous = stored;
  }
  check(previous); return { previous, ledger, bindings };
}
function reviewKind(db: Database.Database, workspace: string, ref: Obj) {
  if (text(ref.review_id).startsWith(MANAGED_ACTION_PREFIX)) return "actions";
  const row = db.prepare("SELECT s.kind FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id AND s.workspace_id=r.workspace_id WHERE r.id=? AND r.workspace_id=?")
    .get(ref.review_id, workspace) as { kind: string } | undefined; check(row); return row.kind;
}
const reviewRef = (review: VerifiedSourceReview) => ({ review_id: review.row.id, review_hash: review.row.content_hash, source_id: review.source.id, source_hash: review.source.content_hash });
function candidateBindings(db: Database.Database, workspace: string, definition: Obj, original: Obj, candidate: Obj, now: string) {
  const before = rows(original.segments), after = rows(candidate.segments), actions = new Map<string, VerifiedSourceReview>();
  const settings = structuredClone(obj(original.settings)), selected = monitorCostsAt(db, workspace, definition, text(candidate.created_at));
  if (selected) { settings.cost_assumptions = selected.binding; obj(settings.policy).costs = selected.costs; }
  else check(!Object.hasOwn(settings, "cost_assumptions"));
  check(after.length === before.length && same(settings, candidate.settings));
  const deadline = verifyMonitorCostSettings(db, workspace, definition, obj(candidate.settings), now);
  for (const [index, segment] of before.entries()) {
    const snapshot = obj(segment.snapshot), reviews: VerifiedSourceReview[] = [];
    const refs = rows(snapshot.review_refs).map(ref => {
      if (reviewKind(db, workspace, ref) !== "actions") return ref;
      const current = transitionActionReview(db, workspace, ref, text(snapshot.range_start), text(snapshot.range_end), now);
      reviews.push(current); actions.set(current.row.id, current); return reviewRef(current);
    }).sort((a,b) => cmp(text(a.review_id), text(b.review_id)));
    const expected = { ...snapshot, schema_version: "investor-monitor-source-snapshot-v2", created_at: candidate.created_at,
      capture_refs: rows(snapshot.capture_refs).map(ref => snapshot.schema_version === "investor-data-snapshot-v1" ? { kind: "historical_sdk", ...ref } : ref),
      review_refs: refs, action_availability_refs: actionAvailabilityRefs(db, workspace, reviews, now, text(candidate.created_at)),
      publication_times: "reconstructed_prices_and_audited_action_review_times_not_point_in_time", use_scope: "monitor_only" };
    check(same(after[index].snapshot, expected));
  }
  return { reviews: [...actions.values()], cost_deadline: deadline };
}
function auditedActions(definition: Obj, document: Obj, reviews: VerifiedSourceReview[]) {
  const targets = new Map(rows(definition.targets).map(row => [text(row.listing_id), row]));
  const refs = rows(document.segments).flatMap(segment => rows(obj(segment.snapshot).action_availability_refs));
  const available = indexActionAvailability(reviews, refs, text(document.created_at)), result: Obj[] = [];
  for (const review of reviews) {
    const target = targets.get(text(review.facts.listing_id)); check(target);
    for (const event of rows(review.facts.events)) {
      const common = { listing_id: target.listing_id, known_at: available(review.row.id, event.id).known_at }, id = text(event.id);
      if (event.type === "split") result.push({ ...common, id: "split:" + id, kind: "split", effective_at: millis(event.at), ratio: event.ratio });
      else {
        result.push({ ...common, id: "ex:" + id, kind: "dividend_ex", effective_at: millis(event.at), currency: target.currency,
          net_per_unit: new Decimal(text(event.gross_per_unit)).sub(text(event.tax_per_unit)).toFixed(), entitlement_id: "entitlement:" + id,
          tax_assumption_hash: hash({ tax_assumption: review.facts.tax_assumption, tax_per_unit: event.tax_per_unit }) });
        result.push({ ...common, id: "pay:" + id, kind: "dividend_payment", effective_at: millis(event.pay_at), currency: target.currency,
          entitlement_id: "entitlement:" + id, ex_at: millis(event.at) });
      }
    }
  }
  check(result.length <= 20000 && new Set(result.map(row => row.id)).size === result.length);
  return result.sort((a,b) => cmp(text(a.id), text(b.id)));
}
function carryActions(ledger: Ledger, actions: Obj[]) {
  const current = new Map(actions.map(row => [text(row.id), row]));
  const economics = (value: Obj) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "known_at"));
  return [...ledger].sort(([a],[b]) => cmp(a,b)).map(([id,bound]) => {
    const replacement = current.get(id); check(replacement && same(economics(bound.action), economics(replacement)) && time(replacement.known_at) <= time(bound.action.known_at));
    return { id, original_input_id: bound.input_id, original_input_hash: bound.input_hash, original_action_hash: hash(bound.action),
      audited_action_hash: hash(replacement), recorded_known_at: bound.action.known_at, audited_known_at: replacement.known_at };
  });
}

/** The candidate is untrusted metadata. Every receipt and original state is independently replayed. */
export function readLegacyActionTransitionPreview(db: Database.Database, actor: { id: string }, workspace: string, modelId: string, rawCandidate: unknown, now: string) {
  return db.transaction(() => {
    const owner = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as { owner_id: string } | undefined;
    check(owner?.owner_id === actor.id);
    const model = db.prepare("SELECT * FROM investor_models WHERE workspace_id=? AND id=?").get(workspace, modelId) as Obj | undefined;
    const latest = db.prepare("SELECT * FROM investor_monitor_evidence_inputs WHERE workspace_id=? AND model_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(workspace, modelId) as Obj | undefined;
    const control = db.prepare("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1").get(workspace, modelId) as Obj | undefined;
    check(model && latest && control);
    const definition = obj(parseStrictJson(text(model.document_json))); validateInvestorModelDocument("definition", definition);
    check(hash(definition) === model.content_hash && definition.model_id === modelId);
    const original = readLegacyTransitionInput(db, actor, workspace, modelId, text(latest.id), now);
    check(original.projection && !original.unavailable_reason && legacy.has(text(original.document.schema_version)));
    const candidate = obj(structuredClone(rawCandidate)); validateInvestorMonitorDataDocument("input", candidate);
    check(candidate.schema_version === "investor-monitor-data-input-v4" && Buffer.byteLength(canonical(candidate)) <= 1048576
      && candidate.created_at === millis(candidate.created_at) && time(candidate.created_at) <= time(now)
      && time(now) - time(candidate.created_at) <= 300000000n
      && time(control.created_at) <= time(candidate.created_at) && time(latest.created_at) <= time(candidate.created_at));
    const chain = originalChain(db, actor, workspace, definition, now);
    check(chain.bindings.every(header => time(header.created_at) <= time(candidate.created_at)));
    const bound = candidateBindings(db, workspace, definition, original.document, candidate, now);
    const reference = readEvidenceReference(db, workspace, text(model.plan_id), now); check(!reference.unavailable_reason);
    const rebuilt = compareInvestorMonitorData(db, workspace, definition, reference.document.targets, candidate, now);
    const actions = auditedActions(definition, candidate, bound.reviews), carry = carryActions(chain.ledger, actions);
    const markets = new Map(rows(definition.targets).map(row => [text(row.listing_id), text(row.market)]));
    for (const action of actions) {
      const market = markets.get(text(action.listing_id)); check(market);
      check(chain.ledger.has(text(action.id)) || !(time(obj(chain.previous.initialized_at)[market]) < time(action.effective_at)
        && time(action.effective_at) <= time(obj(chain.previous.market_cutoffs)[market])));
    }
    const result = { schema_version: "investor-legacy-action-transition-preview-v1", workspace_id: workspace, model_id: modelId,
      model_hash: model.content_hash, control_hash: hash(control), legacy_input_id: latest.id, legacy_input_hash: latest.content_hash,
      settings_hash: hash(candidate.settings), checkpoint: { id: chain.bindings.at(-1)!.id, sequence: chain.previous.sequence,
        content_hash: hash(chain.previous), chain_hash: hash(chain.bindings), processed_actions_hash: hash(chain.previous.processed_actions) },
      audited_document_hash: hash(candidate), audited_projection_hash: hash(rebuilt.comparison_projection), carry_forward: carry,
      projection_quality_gaps: rebuilt.comparison_projection.quality_gaps, checked_at: candidate.created_at,
      source_valid_until: earliest([chain.bindings.at(-1)!.valid_until, original.document.valid_until, candidate.valid_until, definition.valid_until,
        ...(bound.cost_deadline === null ? [] : [bound.cost_deadline])]),
      status: "awaiting_explicit_protocol_confirmation", admission_performed: false, live_advice_eligible: false };
    check(time(now) < time(result.source_valid_until)); validateLegacyActionTransitionPreview(result); return result;
  }).deferred();
}

function transitionHeader(db: Database.Database, actor: { id: string }, workspace: string, identifier: string, kind: "preview" | "confirmation") {
  const table = kind === "preview" ? "investor_legacy_transition_previews" : "investor_legacy_transition_confirmations";
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND workspace_id=?`).get(identifier, workspace) as Obj | undefined;
  check(row && row.actor_id === actor.id && Buffer.byteLength(text(row.document_json)) <= 32768);
  const doc = obj(parseStrictJson(text(row.document_json))); validateLegacyTransitionWorkflow(kind, doc);
  check(canonical(doc) === row.document_json && hash(doc) === row.content_hash && doc[kind === "preview" ? "preview_id" : "confirmation_id"] === row.id
    && ["workspace_id", "workspace_revision", "model_id", "control_id", "request_hash", "created_at", "valid_until"].every(key => doc[key] === row[key]));
  const proof = kind === "preview" ? obj(doc.proof) : doc;
  check(proof.legacy_input_id === row.legacy_input_id && obj(proof.checkpoint).id === row.checkpoint_id);
  const audit = db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.audit_id) as Obj | undefined;
  check(audit && audit.actor_id === actor.id && audit.object_id === row.id && audit.created_at === row.created_at
    && audit.action === (kind === "preview" ? "investor_preview_legacy_transition" : "investor_confirm_legacy_transition")
    && audit.object_type === (kind === "preview" ? "investor_legacy_transition_preview" : "investor_legacy_transition_confirmation")
    && same(parseStrictJson(text(audit.payload_json)), { content_hash: row.content_hash }));
  return { row, doc };
}

/** Independently prove consent and its original ledger scope, never return current prices or admission authority. */
export function readLegacyTransitionConfirmation(db: Database.Database, actor: { id: string }, workspace: string, identifier: string, rawCandidate: unknown, now: string) {
  return db.transaction(() => {
    const owner = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as { owner_id: string } | undefined;
    check(owner?.owner_id === actor.id);
    const { row, doc } = transitionHeader(db, actor, workspace, identifier, "confirmation"), request = obj(doc.request);
    const { row: witnessRow, doc: witness } = transitionHeader(db, actor, workspace, text(row.preview_id), "preview"), proof = obj(witness.proof);
    check(doc.preview_id === row.preview_id && doc.preview_id === witness.preview_id && doc.preview_hash === witnessRow.content_hash
      && request.expected_preview_hash === witnessRow.content_hash && request.preview_id === witness.preview_id
      && hash(request) === row.request_hash && request.idempotency_key === row.idempotency_key
      && doc.workspace_revision === Number(witness.workspace_revision) + 1 && request.expected_revision === witness.workspace_revision
      && witness.model_id === doc.model_id && witness.control_id === doc.control_id
      && ["model_hash", "control_hash", "legacy_input_id", "legacy_input_hash", "checkpoint", "carry_hash", "carry_count"].every(key => same(doc[key], proof[key]))
      && witness.request_hash === hash({ model_id: witness.model_id, expected_revision: Number(witness.workspace_revision) - 1, idempotency_key: witnessRow.idempotency_key })
      && time(witness.checked_at) <= time(witness.created_at) && time(witness.created_at) <= time(doc.created_at)
      && time(doc.created_at) < time(witness.valid_until) && time(witness.valid_until) <= time(proof.source_valid_until)
      && time(witness.valid_until) - time(witness.checked_at) <= 300000000n
      && time(doc.created_at) <= time(now) && time(now) < time(doc.valid_until));
    check(Buffer.byteLength(text(witnessRow.candidate_json)) <= 1048576);
    const witnessedCandidate = obj(parseStrictJson(text(witnessRow.candidate_json))); validateInvestorMonitorDataDocument("input", witnessedCandidate);
    check(canonical(witnessedCandidate) === witnessRow.candidate_json && hash(witnessedCandidate) === proof.audited_document_hash
      && witnessedCandidate.projection_hash === proof.audited_projection_hash && witnessedCandidate.schema_version === "investor-monitor-data-input-v4"
      && witnessedCandidate.workspace_id === workspace && witnessedCandidate.model_id === doc.model_id && witnessedCandidate.created_at === witness.checked_at);
    const model = db.prepare("SELECT * FROM investor_models WHERE workspace_id=? AND id=?").get(workspace, doc.model_id) as Obj | undefined;
    const control = db.prepare("SELECT * FROM investor_model_controls WHERE id=? AND workspace_id=? AND model_id=?").get(doc.control_id, workspace, doc.model_id) as Obj | undefined;
    check(model && model.content_hash === doc.model_hash && control && hash(control) === doc.control_hash && time(control.created_at) <= time(doc.created_at));
    const definition = obj(parseStrictJson(text(model.document_json))); validateInvestorModelDocument("definition", definition);
    check(hash(definition) === model.content_hash && definition.model_id === model.id);
    const original = readLegacyTransitionInput(db, actor, workspace, text(model.id), text(doc.legacy_input_id), now);
    check(original.projection && !original.unavailable_reason && original.row.content_hash === doc.legacy_input_hash);
    const head = obj(doc.checkpoint), chain = originalChain(db, actor, workspace, definition, now, Number(head.sequence));
    check(same(head, { id: chain.bindings.at(-1)!.id, sequence: chain.previous.sequence, content_hash: hash(chain.previous),
      chain_hash: hash(chain.bindings), processed_actions_hash: hash(chain.previous.processed_actions) })
      && doc.valid_until === earliest([chain.bindings.at(-1)!.valid_until, original.document.valid_until, definition.valid_until]));
    const candidate = obj(structuredClone(rawCandidate)); validateInvestorMonitorDataDocument("input", candidate);
    check(candidate.schema_version === "investor-monitor-data-input-v4" && Buffer.byteLength(canonical(candidate)) <= 1048576
      && candidate.created_at === millis(candidate.created_at) && time(doc.created_at) <= time(candidate.created_at) && time(candidate.created_at) <= time(now));
    const bound = candidateBindings(db, workspace, definition, original.document, candidate, now);
    const reference = readEvidenceReference(db, workspace, text(model.plan_id), now); check(!reference.unavailable_reason);
    compareInvestorMonitorData(db, workspace, definition, reference.document.targets, candidate, now);
    const actions = auditedActions(definition, candidate, bound.reviews), carry = carryActions(chain.ledger, actions);
    check(hash(carry) === doc.carry_hash && carry.length === doc.carry_count);
    const markets = new Map(rows(definition.targets).map(target => [text(target.listing_id), text(target.market)]));
    for (const action of actions) {
      const market = markets.get(text(action.listing_id)); check(market);
      check(chain.ledger.has(text(action.id)) || !(time(obj(chain.previous.initialized_at)[market]) < time(action.effective_at)
        && time(action.effective_at) <= time(obj(chain.previous.market_cutoffs)[market])));
    }
    return structuredClone(doc);
  }).deferred();
}
