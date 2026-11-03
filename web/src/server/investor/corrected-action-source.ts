import type Database from "better-sqlite3";
import { hash } from "../ledger/service";
import { priceInstant as time } from "../market-price-source";
import { actionJson, actionRead } from "./action-source-proof";
import { actionDeadline, actionNyParts } from "./action-source-parsers";
import { checkNoNewActionCandidate } from "./action-maintenance-candidate";
import { readCorrectionConsentBaseline } from "./correction-consent";
import { readActionReviewPreviewWitness } from "./action-review-lineage";
import { readManagedActionComparisonBasis, readManagedActionCurrentCaptures, readManagedActionReportCaptures } from "./managed-action-source";
import { readRetainedMonitorHistory } from "./retained-monitor-history";
import { validateCorrectedActionSource } from "./kernel-contracts";

type Obj = Record<string, unknown>;
function check(value: unknown): asserts value { if (!value) throw new Error("CORRECTED_ACTION_SOURCE_INVALID"); }
function object(value: unknown): Obj { check(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function text(value: unknown): string { check(typeof value === "string"); return value; }
const minimum = (values: unknown[]) => values.map(time).reduce((a, b) => a < b ? a : b);

/** Heavy source preparation only, not a normal GET or VerifiedSourceReview. */
export function prepareCorrectedActionSource(db: Database.Database, workspace: string, actor: { id: string }, identifier: string, now: string) {
  return db.transaction(() => {
    const doc = readCorrectionConsentBaseline(db, workspace, actor, identifier, now);
    const request = actionRead(db, "investor_correction_impact_requests", doc.impact_request_id, workspace), body = object(actionJson(request.document_json).body);
    const witness = readActionReviewPreviewWitness(db, workspace, actor.id, body.preview_id, now);
    const before = readManagedActionComparisonBasis(db, workspace, witness.authority_id, now), policy = before.grant.doc;
    check(before.grant.current.id === witness.control_id && before.grant.current.content_hash === witness.control_hash);
    const leaves = db.prepare(`SELECT a.id FROM investor_action_authorities a WHERE a.workspace_id=? AND json_extract(a.document_json,'$.provider_symbol')=?
      AND NOT EXISTS(SELECT 1 FROM investor_action_review_confirmations c WHERE c.previous_authority_id=a.id) LIMIT 2`).all(workspace, policy.provider_symbol) as Obj[];
    check(leaves.length === 1 && leaves[0].id === witness.authority_id);
    const anchor = readManagedActionReportCaptures(db, workspace, witness.authority_id, object(doc.capture_refs), now);
    const current = readManagedActionCurrentCaptures(db, workspace, witness.authority_id, now);
    for (const kind of Object.keys(current.bindings)) for (const key of ["authority_id", "authority_hash", "control_id", "control_hash"])
      check(object(current.bindings[kind])[key] === object(anchor.bindings[kind])[key]);
    return assemble(db, workspace, actor, doc, witness, before, anchor, current, now, now);
  }).deferred();
}

/** Selected original reports are requalified now, never substituted for today's batches. */
export function replayCorrectedActionSource(db: Database.Database, workspace: string, actor: { id: string }, proof: Obj, now: string) {
  validateCorrectedActionSource(proof);
  return db.transaction(() => {
    const doc = readCorrectionConsentBaseline(db, workspace, actor, text(proof.confirmation_id), now);
    const request = actionRead(db, "investor_correction_impact_requests", doc.impact_request_id, workspace), body = object(actionJson(request.document_json).body);
    const witness = readActionReviewPreviewWitness(db, workspace, actor.id, body.preview_id, now);
    const before = readManagedActionComparisonBasis(db, workspace, witness.authority_id, now);
    const anchor = readManagedActionReportCaptures(db, workspace, witness.authority_id, object(doc.capture_refs), now);
    const current = readManagedActionReportCaptures(db, workspace, witness.authority_id, object(proof.current_captures), now);
    const result = assemble(db, workspace, actor, doc, witness, before, anchor, current, text(proof.checked_at), now, text(proof.source_valid_until));
    check(hash(result.proof) === hash(proof)); return result;
  }).deferred();
}

function assemble(db: Database.Database, workspace: string, actor: { id: string }, doc: Obj, witness: Obj,
  before: ReturnType<typeof readManagedActionComparisonBasis>, anchor: ReturnType<typeof readManagedActionReportCaptures>,
  current: ReturnType<typeof readManagedActionReportCaptures>, checked: string, now: string, sourceLimit?: string) {
  const baseline = object(doc.baseline), base = object(baseline.approved_facts), policy = before.grant.doc;
  check(time(doc.created_at) <= time(checked) && time(checked) <= time(now) && current.day === actionNyParts(checked).day);
  for (const value of Object.values(current.values)) check(time(value.row.created_at) <= time(checked));
  const candidate = checkNoNewActionCandidate(base, anchor.snapshots, current.snapshots, text(policy.provider_symbol), text(policy.listing_id));
  check(Array.isArray(doc.outstanding_new_report_dates) && doc.outstanding_new_report_dates.length === 0);
  const facts = { ...structuredClone(base), range_end: candidate.candidate_range_end }, history = readRetainedMonitorHistory(db, workspace, actor, text(doc.model_id), now);
  const maximum = minimum([doc.valid_until, history.proof.source_valid_until, policy.valid_until, ...before.limits, ...before.historicalLimits, ...current.limits]);
  const sourceUntil = sourceLimit ? time(sourceLimit) : maximum;
  check(time(now) < maximum && sourceUntil <= maximum);
  const sourceStamp = new Date(Number(sourceUntil / 1000n)).toISOString(), until = actionDeadline(checked, sourceStamp);
  check(time(checked) < time(until));
  const refs = Object.fromEntries(Object.entries(current.values).map(([key, value]) => [key, { capture_id: value.row.id, capture_hash: value.row.content_hash }]));
  const proof = { schema_version: "investor-corrected-action-source-proof-v1", workspace_id: workspace, model_id: doc.model_id,
    confirmation_id: doc.confirmation_id, confirmation_hash: hash(doc), original_head_id: history.proof.head_checkpoint_id,
    original_chain_hash: history.proof.checkpoint_chain_hash, authority_id: witness.authority_id, authority_hash: witness.authority_hash,
    control_id: witness.control_id, control_hash: witness.control_hash, base_facts_hash: hash(base), candidate_facts_hash: hash(facts),
    anchor_captures: doc.capture_refs, current_captures: refs, extension_hash: hash(candidate), previous_coverage_end: base.range_end,
    candidate_coverage_end: facts.range_end, source_day: current.day, knowledge_at: baseline.knowledge_at, checked_at: checked,
    source_valid_until: sourceStamp, valid_until: until, status: "corrected_report_basis_prepared_not_published",
    coverage_basis: "selected_two_source_reports_not_objective_absence", economic_correction_approved: true,
    current_source_eligibility_restored: false, handover_registered: false, maintenance_enabled: false, checkpoint_created: false,
    monitoring_resumed: false, trading_permission: false, provider_calls: 0, database_writes: 0, distribution: "private_owner_only_not_ai" };
  validateCorrectedActionSource(proof); return { proof, facts };
}
