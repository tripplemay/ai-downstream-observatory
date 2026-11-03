import { hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";
import { compareActionRestatement } from "./action-restatement-kernel";
import { EvidenceCheckpointLimitRequired, replayEvidenceModel } from "./evidence-model-state";
import { replayEvidenceAssessment } from "./evidence-model-assessment";
import { validateModelEpochCheckpoint, validateModelEpochTransition } from "./kernel-contracts";

type Obj = Record<string, unknown>;
function check(value: unknown, code: string): asserts value { if (!value) throw new Error("INVESTOR_MODEL_EPOCH_" + code); }
function obj(value: unknown): Obj { check(value && typeof value === "object" && !Array.isArray(value), "OBJECT"); return value as Obj; }
function text(value: unknown): string { check(typeof value === "string", "TEXT"); return value; }
function rows(value: unknown): Obj[] { check(Array.isArray(value), "ROWS"); return value.map(obj); }
const time = (value: unknown) => priceInstant(text(value));
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const proof = (value: Obj) => Object.fromEntries(Object.entries(value).filter(([key]) => !["checked_at", "source_valid_until"].includes(key)));
const actions = (value: Obj[]) => Object.fromEntries(value.map(row => [text(row.id), hash(row)]));
const byId = (a: Obj, b: Obj) => text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0;

/** Unpublished arithmetic only: the caller must independently authenticate the
 * retained prefix, registered consents/handovers and actual current sources. */
export function replayCorrectedModelEpoch(raw: unknown, implementationHash: string) {
  validateModelEpochTransition("input", raw); check(/^[a-f0-9]{64}$/.test(implementationHash), "IMPLEMENTATION_HASH");
  const value = obj(raw), history = obj(value.history), corrections = rows(value.corrections), projection = obj(value.projection);
  const definition = obj(history.definition), head = obj(history.head), origin = obj(history.origin), at = time(value.now);
  const targets = Object.fromEntries(rows(definition.targets).map(row => [text(row.listing_id), row]));
  const original = rows(history.original_actions), oldHashes = actions(original), bindings: Obj[] = [], selected: Obj[] = [];
  const listings = new Set<string>(), identifiers = new Set<string>(), handovers = new Set<string>();
  const first = obj(obj(corrections[0].baseline).original_history), inputBindings = rows(first.input_bindings);
  check(first.model_id === definition.model_id && first.model_hash === hash(definition) && first.head_checkpoint_sequence === head.sequence
    && inputBindings.length === head.sequence && inputBindings.every((row, index) => row.sequence === index + 1)
    && first.origin_checkpoint_id === inputBindings[0].checkpoint_id && first.head_checkpoint_id === inputBindings.at(-1)!.checkpoint_id
    && first.original_actions_hash === hash([...original].sort(byId)) && inputBindings[0].checkpoint_hash === hash(origin)
    && inputBindings.at(-1)!.checkpoint_hash === hash(head) && inputBindings[0].input_hash === origin.input_hash
    && inputBindings.at(-1)!.input_hash === head.input_hash && inputBindings[0].projection_hash === origin.projection_hash
    && inputBindings.at(-1)!.projection_hash === head.projection_hash, "HISTORY_BINDING");
  for (const correction of corrections) {
    const baseline = obj(correction.baseline), listing = text(obj(baseline.approved_facts).listing_id), known = text(baseline.knowledge_at);
    check(Object.hasOwn(targets, listing) && !listings.has(listing) && !identifiers.has(text(baseline.epoch_id))
      && !handovers.has(text(correction.handover_id)), "CORRECTION_SCOPE");
    listings.add(listing); identifiers.add(text(baseline.epoch_id)); handovers.add(text(correction.handover_id));
    const registered = obj(baseline.original_history);
    check(time(head.created_at) <= time(known) && time(known) <= time(correction.handover_at) && time(correction.handover_at) < at
      && registered.checked_at === known && at < time(registered.source_valid_until), "CORRECTION_CLOCK");
    check(same(proof(registered), proof(first)) && baseline.model_hash === hash(definition) && baseline.original_checkpoint_hash === hash(head)
      && baseline.original_projection_hash === hash(history.head_projection) && same(baseline.policy_state, head.policy_state ?? null), "BASELINE_BINDING");
    const ledger = rows(correction.corrected_actions);
    check(hash(ledger) === baseline.corrected_actions_hash && same(actions(ledger.filter(row => row.listing_id !== listing)),
      actions(original.filter(row => row.listing_id !== listing))), "CORRECTION_SCOPE");
    check(ledger.filter(row => oldHashes[text(row.id)] !== hash(row)).every(row => row.known_at === known), "CORRECTION_KNOWLEDGE");
    const compared = compareActionRestatement({ schema_version: "investor-action-restatement-kernel-input-v1", ...history, corrected_actions: ledger, checked_at: known });
    check(Number(compared.changed_action_count) > 0, "CORRECTION_EMPTY");
    const summary = obj(baseline.valuation_summary);
    check(hash(compared) === baseline.comparison_hash && same(compared.restated, baseline.economics)
      && same(Object.fromEntries(Object.keys(summary).map(key => [key, compared[key as keyof typeof compared]])), summary), "BASELINE_ARITHMETIC");
    selected.push(...ledger.filter(row => row.listing_id === listing));
    bindings.push({ correction_id: baseline.epoch_id, baseline_hash: hash(baseline), confirmation_hash: correction.confirmation_hash,
      handover_id: correction.handover_id, handover_hash: correction.handover_hash, handover_at: correction.handover_at,
      knowledge_at: known, listing_id: listing, corrected_actions_hash: baseline.corrected_actions_hash });
  }
  const combined = [...original.filter(row => !listings.has(text(row.listing_id))), ...selected].sort(byId);
  const known = bindings.map(row => text(row.knowledge_at)).reduce((a, b) => time(a) > time(b) ? a : b);
  const restated = compareActionRestatement({ schema_version: "investor-action-restatement-kernel-input-v1", ...history, corrected_actions: combined, checked_at: known });
  const bridge: Obj = { ...structuredClone(head), ...structuredClone(obj(restated.restated)) };
  const boundary = bindings.map(row => time(row.handover_at)).reduce((a, b) => a > b ? a : b, time(head.created_at)), cutoffs = obj(head.market_cutoffs);
  const quotes = rows(projection.quotes);
  check(quotes.length === Object.keys(targets).length && same(quotes.map(row => row.listing_id).sort(), Object.keys(targets).sort())
    && quotes.every(row => row.market === targets[text(row.listing_id)].market), "QUOTE_SCOPE");
  check(quotes.every(row => time(row.observed_at) > boundary && time(row.observed_at) > time(cutoffs[text(row.market)])), "NEXT_CLOSE_REQUIRED");
  const historical = rows(projection.corporate_actions).filter(row => Object.hasOwn(targets, text(row.listing_id))
    && time(row.effective_at) <= time(cutoffs[text(targets[text(row.listing_id)].market)]));
  check(Object.keys(actions(historical)).length === historical.length && same(actions(historical), actions(combined)), "CURRENT_LEDGER_BINDING");
  const binding = { schema_version: "investor-model-epoch-binding-v1", epoch_id: value.epoch_id, model_hash: hash(definition), origin_hash: hash(origin),
    original_head_hash: hash(head), original_chain_hash: first.checkpoint_chain_hash, bridge_hash: hash(bridge), combined_actions_hash: hash(combined),
    corrections: bindings.sort((a, b) => text(a.correction_id) < text(b.correction_id) ? -1 : text(a.correction_id) > text(b.correction_id) ? 1 : 0) };
  check(Number(head.sequence) < 1000, "CHECKPOINT_LIMIT_REQUIRES_CONTINUATION");
  const advanced = replayEvidenceModel(definition, projection, bridge, text(value.now), text(value.input_hash), false, value.planned_funding);
  let assessment = replayEvidenceAssessment(advanced.document, text(value.now), implementationHash) as Obj;
  let checkpoint: Obj | null = null, request: Obj | null = null;
  if (assessment.outcome !== "insufficient_evidence") {
    checkpoint = { ...advanced.checkpoint, schema_version: "investor-evidence-model-checkpoint-v4", previous_hash: hash(head), epoch_binding: binding };
    validateModelEpochCheckpoint(checkpoint);
    const document = { ...advanced.document, model_state_hash: hash(checkpoint) };
    const final = replayEvidenceAssessment(document, text(value.now), implementationHash) as Obj;
    check(final.outcome === assessment.outcome, "ASSESSMENT_CHANGED"); assessment = final;
    request = { action: "monitor", document, now: value.now };
  }
  return result(binding, checkpoint, request, assessment);
}

function result(binding: Obj, checkpoint: Obj | null, request: Obj | null, assessment: Obj) {
  const result = { schema_version: "investor-model-epoch-transition-result-v1", epoch_binding: binding, checkpoint, monitor_request: request, assessment,
    registered_bindings_verified: false, source_evidence_verified: false, checkpoint_created: false, state_published: false, monitoring_resumed: false,
    historical_observations_rewritten: false, historical_strategy_results_recomputed: false, trading_permission: false,
    provider_calls: 0, database_writes: 0, visibility: "private_owner_only_not_ai" };
  validateModelEpochTransition("result", result); return result;
}

/** Pure continuation only. Registration/source/full predecessor qualification is
 * required separately; the ordinary legacy reader never accepts v4. */
export function replayModelEpochContinuation(raw: unknown, implementationHash: string) {
  validateModelEpochTransition("continuation_input", raw); check(/^[a-f0-9]{64}$/.test(implementationHash), "IMPLEMENTATION_HASH");
  const value = obj(raw), definition = obj(value.definition), previous = obj(value.previous), projection = obj(value.projection), binding = obj(previous.epoch_binding);
  const targets = Object.fromEntries(rows(definition.targets).map(row => [text(row.listing_id), row]));
  check(binding.model_hash === hash(definition), "CONTINUATION_BINDING");
  const cutoffs = obj(previous.market_cutoffs), historical = rows(projection.corporate_actions).filter(row => Object.hasOwn(targets, text(row.listing_id))
    && time(row.effective_at) <= time(cutoffs[text(targets[text(row.listing_id)].market)]));
  check(Object.keys(actions(historical)).length === historical.length && same(actions(historical), previous.processed_actions), "CURRENT_LEDGER_BINDING");
  const adapter = structuredClone(previous); delete adapter.epoch_binding;
  adapter.schema_version = previous.funding_binding ? "investor-evidence-model-checkpoint-v3"
    : definition.schema_version === "investor-model-definition-v2" ? "investor-evidence-model-checkpoint-v2" : "investor-evidence-model-checkpoint-v1";
  let advanced: ReturnType<typeof replayEvidenceModel>;
  try { advanced = replayEvidenceModel(definition, projection, adapter, text(value.now), text(value.input_hash), true, value.planned_funding); }
  catch (error) { if (error instanceof EvidenceCheckpointLimitRequired) check(false, "CHECKPOINT_LIMIT_REQUIRES_CONTINUATION"); throw error; }
  let assessment = replayEvidenceAssessment(advanced.document, text(value.now), implementationHash) as Obj;
  let checkpoint: Obj | null = null, request: Obj | null = null;
  if (assessment.outcome !== "insufficient_evidence") {
    checkpoint = same(advanced.checkpoint, adapter) ? structuredClone(previous) : {
      ...advanced.checkpoint, schema_version: "investor-evidence-model-checkpoint-v4", previous_hash: hash(previous), epoch_binding: structuredClone(binding) };
    validateModelEpochCheckpoint(checkpoint);
    const document = { ...advanced.document, model_state_hash: hash(checkpoint) };
    const final = replayEvidenceAssessment(document, text(value.now), implementationHash) as Obj;
    check(final.outcome === assessment.outcome, "ASSESSMENT_CHANGED"); assessment = final;
    request = { action: "monitor", document, now: value.now };
  }
  return result(structuredClone(binding), checkpoint, request, assessment);
}

export function verifyCorrectedModelEpochArithmetic(value: unknown, result: unknown, implementationHash: string) {
  validateModelEpochTransition("result", result);
  const calculated = replayCorrectedModelEpoch(value, implementationHash);
  check(same(calculated, result), "RESULT_REPLAY_MISMATCH"); return calculated;
}

export function verifyModelEpochContinuationArithmetic(value: unknown, result: unknown, implementationHash: string) {
  validateModelEpochTransition("result", result);
  const calculated = replayModelEpochContinuation(value, implementationHash);
  check(same(calculated, result), "RESULT_REPLAY_MISMATCH"); return calculated;
}
