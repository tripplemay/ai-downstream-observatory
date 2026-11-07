import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { priceInstant as time } from "../market-price-source";
import { actionAudit, actionJson, actionRead } from "./action-source-proof";
import { actionNyParts } from "./action-source-parsers";
import { validateCorrectionConsent } from "./kernel-contracts";
import { readCorrectionImpactResponse } from "./correction-impact-jobs";
import { readActionReviewPreviewWitness, compareActionSourceChanges } from "./action-review-lineage";
import { readManagedActionComparisonBasis, readManagedActionReportCaptures, readManagedActionControlWitness } from "./managed-action-source";
import { readRegisteredCorrectionHistory } from "./retained-monitor-history";
import { correctionActionLedger, deriveCorrectionHypothesis } from "./action-correction-impact";
import { compareActionRestatement } from "./action-restatement-kernel";

type Obj = Record<string, unknown>;
function check(value: unknown): asserts value { if (!value) throw new Error("CORRECTION_CONSENT_INVALID"); }
function object(value: unknown): Obj { check(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function rows(value: unknown): Obj[] { check(Array.isArray(value)); return value.map(object); }
function text(value: unknown): string { check(typeof value === "string"); return value; }
const same = (a: unknown, b: unknown) => hash(a) === hash(b);

/** Internal document authentication, not source or economic qualification. */
function registeredCorrectionDocument(db: Database.Database, workspace: string, actor: { id: string }, id: string, now: string) {
  return db.transaction(() => {
    const owner = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as Obj | undefined; check(owner?.owner_id === actor.id);
    const row = actionRead(db, "investor_correction_consents", id, workspace), doc = actionJson(row.document_json, 8388608);
    validateCorrectionConsent("confirmation", doc);
    check(canonical(doc) === row.document_json && hash(doc) === row.content_hash && row.actor_id === actor.id && doc.confirmation_id === row.id && time(row.created_at) <= time(now));
    for (const key of ["workspace_id", "model_id", "request_id", "impact_request_id", "impact_result_id", "workspace_revision", "created_at", "valid_until"]) check(doc[key] === row[key]);
    actionAudit(db, workspace, row, "investor_confirm_correction", "investor_correction_consent");
    const request = actionRead(db, "investor_correction_consent_requests", doc.request_id, workspace), queued = actionJson(request.document_json, 32768);
    validateCorrectionConsent("request", queued);
    check(canonical(queued) === request.document_json && hash(queued) === request.content_hash && request.actor_id === actor.id && queued.request_id === request.id
      && same(queued.body, doc.request) && hash(queued.body) === request.request_hash && doc.request_hash === request.request_hash
      && Number(request.expected_revision) + 1 === doc.workspace_revision && time(request.created_at) <= time(doc.created_at) && time(doc.created_at) < time(request.valid_until));
    for (const key of ["workspace_id", "model_id", "request_hash", "created_at", "valid_until"]) check(queued[key] === request[key]);
    for (const key of ["impact_request_id", "expected_revision", "idempotency_key"]) check(object(queued.body)[key] === request[key]);
    check(time(request.valid_until) - time(request.created_at) <= 300000000n);
    actionAudit(db, workspace, request, "investor_enqueue_correction_consent", "investor_correction_consent_request");
    // The existing reader authenticates the entire completed hypothetical job,
    // even when its display is now outdated by this consent's new revision.
    readCorrectionImpactResponse(db, actor, "0".repeat(64), { request: text(doc.impact_request_id) }, now);
    const impactRequest = actionRead(db, "investor_correction_impact_requests", doc.impact_request_id, workspace);
    const impact = actionRead(db, "investor_correction_impact_results", doc.impact_result_id, workspace);
    const source = actionJson(impact.document_json, 5242880);
    check(impact.request_id === doc.impact_request_id && doc.impact_result_hash === impact.content_hash && object(queued.body).expected_result_hash === impact.content_hash
      && impact.outcome === "preview_ready" && impactRequest.actor_id === actor.id && impactRequest.model_id === row.model_id
      && impactRequest.expected_revision === request.expected_revision && time(impact.created_at) <= time(request.created_at)
      && time(request.valid_until) <= time(object(source.impact).valid_until));
    const baseline = object(doc.baseline), history = object(baseline.original_history);
    check(baseline.epoch_id === id && row.original_head_id === history.head_checkpoint_id && time(request.created_at) <= time(baseline.knowledge_at)
      && time(baseline.knowledge_at) <= time(doc.created_at) && doc.valid_until === doc.reviewed_source_valid_until
      && time(doc.valid_until) <= time(history.source_valid_until));
    const result = db.prepare("SELECT * FROM investor_correction_consent_results WHERE request_id=? AND workspace_id=?").get(request.id, workspace) as Obj | undefined;
    check(result); const output = actionJson(result.document_json, 32768); validateCorrectionConsent("result", output);
    check(canonical(output) === result.document_json && hash(output) === result.content_hash && result.actor_id === actor.id && output.result_id === result.id
      && output.request_hash === request.content_hash && result.confirmation_id === id && output.confirmation_hash === row.content_hash
      && output.outcome === "confirmed" && output.code === "CORRECTION_CONSENT_CONFIRMED");
    for (const key of ["request_id", "workspace_id", "job_id", "fencing_token", "outcome", "code", "confirmation_id", "created_at"]) check(output[key] === result[key]);
    actionAudit(db, workspace, result, "investor_finish_correction_consent", "investor_correction_consent_result");
    const job = db.prepare("SELECT * FROM job_runs WHERE id=?").get(result.job_id) as Obj | undefined;
    const attempt = db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1").get(result.job_id) as Obj | undefined;
    check(job && attempt && job.job_type === "investor_correction_consent" && job.scope === workspace && job.period === request.id
      && job.input_version === request.content_hash && job.command_request_id === null && job.status === "succeeded" && attempt.status === "succeeded"
      && job.attempt_count === 1 && job.max_attempts === 1 && job.fencing_token === result.fencing_token && attempt.fencing_token === result.fencing_token
      && job.lease_owner === null && job.lease_until === null && attempt.error_json === null
      && time(request.created_at) <= time(attempt.started_at) && time(attempt.started_at) <= time(row.created_at)
      && time(row.created_at) === time(result.created_at) && time(result.created_at) <= time(attempt.finished_at)
      && time(attempt.finished_at) === time(job.updated_at) && time(job.updated_at) <= time(now)
      && same(actionJson(job.result_json), { request_id: request.id, result_id: result.id, outcome: "confirmed", code: "CORRECTION_CONSENT_CONFIRMED", research_admitted: false }));
    return doc;
  }).deferred();
}

/** Historical metadata only; never expose the unqualified economic payload. */
export function readCorrectionConsentReceipt(db: Database.Database, workspace: string, actor: { id: string }, id: string, now: string) {
  const doc = registeredCorrectionDocument(db, workspace, actor, id, now);
  const value: Obj = { schema_version: "investor-correction-consent-receipt-v1", ...Object.fromEntries(
    ["confirmation_id", "workspace_id", "workspace_revision", "model_id", "impact_request_id", "impact_result_hash", "request_id", "created_at", "valid_until"].map(key => [key, doc[key]])),
    economic_correction_approved: true, baseline_registered: true, historical_registration_only: true, current_source_eligibility_restored: false,
    monitor_data_readmission_required: true, monitoring_resumed: false, checkpoint_created: false, trading_permission: false, source_values_included: false, provider_calls: 0 };
  validateCorrectionConsent("receipt", value); return value;
}

/** Expensive independent replay, not an HTTP GET or ordinary monitor baseline. */
export function readCorrectionConsentBaseline(db: Database.Database, workspace: string, actor: { id: string }, id: string, now: string) {
  return db.transaction(() => {
    const doc = registeredCorrectionDocument(db, workspace, actor, id, now), stored = object(doc.baseline), at = text(stored.knowledge_at);
    check(time(now) < time(doc.valid_until));
    const request = actionRead(db, "investor_correction_impact_requests", doc.impact_request_id, workspace), body = object(actionJson(request.document_json).body);
    const witness = readActionReviewPreviewWitness(db, workspace, actor.id, body.preview_id, now);
    check(time(witness.created_at) <= time(doc.created_at) && time(doc.created_at) < time(witness.valid_until));
    const before = readManagedActionComparisonBasis(db, workspace, witness.authority_id, now);
    const originalControl = readManagedActionControlWitness(db, workspace, witness.authority_id, witness.control_id, now);
    check(before.grant.row.content_hash === witness.authority_hash && originalControl.content_hash === witness.control_hash && time(originalControl.created_at) <= time(witness.checked_at));
    const captures = readManagedActionReportCaptures(db, workspace, witness.authority_id, object(doc.capture_refs), now);
    for (const value of Object.values(captures.values)) check(time(value.row.created_at) <= time(at) && time(value.draft.source.retrieved_at) <= time(at));
    const history = readRegisteredCorrectionHistory(db, workspace, actor, id, now);
    const strip = (value: Obj) => Object.fromEntries(Object.entries(value).filter(([key]) => !["checked_at", "source_valid_until"].includes(key)));
    check(same(strip(history.proof), strip(object(stored.original_history))) && hash(history.definition) === stored.model_hash
      && hash(history.head) === stored.original_checkpoint_hash && hash(history.head_projection) === stored.original_projection_hash);
    const end = ["issuer", "dividends", "splits"].map(kind => text(captures.snapshots[kind as "issuer" | "dividends" | "splits"].source.range_end)).sort()[0];
    const changes = compareActionSourceChanges(before.previous, captures.snapshots, text(before.prior.facts.range_end), end);
    const receipts = Object.values(captures.values).flatMap(value => [text(value.row.created_at), text(value.draft.source.retrieved_at)]);
    const floor = receipts.reduce((a, b) => time(a) >= time(b) ? a : b);
    const maximum = [before.grant.doc.valid_until, ...before.limits, ...before.historicalLimits, ...captures.limits].map(time).reduce((a, b) => a < b ? a : b);
    const basis = { workspace, owner: actor.id, authority_id: before.grant.row.id, authority_hash: before.grant.row.content_hash,
      control_id: originalControl.id, control_hash: originalControl.content_hash, publication_id: before.publicationId,
      previous_review_hash: before.prior.row.content_hash, previous_facts_hash: hash(before.prior.facts), previous_snapshot_hash: hash(before.previous),
      current_snapshot_hash: hash(captures.snapshots), current_bindings: captures.bindings, changes, knowledge_not_before: floor,
      maximum_valid_until: new Date(Number(maximum / 1000n)).toISOString() };
    check(hash(basis) === witness.draft_basis_hash && doc.draft_basis_hash === witness.draft_basis_hash
      && captures.day === actionNyParts(at).day && time(now) < maximum && time(now) < time(history.proof.source_valid_until));
    const { facts, changedDays } = deriveCorrectionHypothesis(before.prior.facts, changes, captures.snapshots, rows(body.decisions), hash(body), at);
    check(changedDays.size > 0 && rows(body.decisions).every(row => row.choice !== "retain"));
    for (const event of rows(facts.events)) if (changedDays.has(actionNyParts(event.at).day)) Object.assign(event, {
      id: "reviewed-correction:" + hash({ consent: id, hypothesis: event.id }), published_at: at, source_evidence: "explicit-owner-correction:" + id });
    check(same(facts, stored.approved_facts));
    const affected = (row: Obj) => row.listing_id === facts.listing_id && changedDays.has(actionNyParts(row.kind === "dividend_payment" ? row.ex_at : row.effective_at).day);
    const economics = (values: Obj[]) => values.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "known_at")))
      .sort((a, b) => text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0);
    const cutoff = object(history.head.market_cutoffs).US;
    check(same(economics(history.original_actions.filter(affected)), economics(correctionActionLedger(before.prior.facts, cutoff, at).filter(affected))));
    const sourceResult = actionJson(actionRead(db, "investor_correction_impact_results", doc.impact_result_id, workspace).document_json, 5242880);
    const hypothetical = object(sourceResult.impact), earlier = text(hypothetical.checked_at);
    const oldFacts = deriveCorrectionHypothesis(before.prior.facts, changes, captures.snapshots, rows(body.decisions), hash(body), earlier).facts;
    const originalActions = [...history.original_actions.filter(row => !affected(row)), ...correctionActionLedger(oldFacts, cutoff, earlier).filter(affected)]
      .sort((a, b) => text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0);
    const oldInput = { schema_version: "investor-action-restatement-kernel-input-v1", ...Object.fromEntries(
      ["definition", "origin", "head", "origin_projection", "head_projection", "original_actions"].map(key => [key, history[key as keyof typeof history]])),
      corrected_actions: originalActions, corrected_coverage: history.head_projection.corporate_action_coverage, checked_at: earlier };
    check(same(compareActionRestatement(oldInput), hypothetical.comparison) && hash(oldInput) === hypothetical.kernel_input_hash
      && same(oldFacts.events, hypothetical.hypothetical_events) && hypothetical.source_changes_hash === hash(changes)
      && hypothetical.prior_facts_hash === hash(before.prior.facts) && hypothetical.draft_basis_hash === witness.draft_basis_hash);
    const actions = [...history.original_actions.filter(row => !affected(row)), ...correctionActionLedger(facts, cutoff, at).filter(affected)]
      .sort((a, b) => text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0);
    check(hash(actions) === stored.corrected_actions_hash);
    const result = compareActionRestatement({ schema_version: "investor-action-restatement-kernel-input-v1", ...Object.fromEntries(
      ["definition", "origin", "head", "origin_projection", "head_projection", "original_actions"].map(key => [key, history[key as keyof typeof history]])),
      corrected_actions: actions, corrected_coverage: history.head_projection.corporate_action_coverage, checked_at: at });
    check(hash(result) === stored.comparison_hash && same(Object.fromEntries(
      (["original_valuation_cny", "restated_valuation_cny", "difference_cny", "delta"] as const).map(key => [key, result[key]])), stored.valuation_summary)
      && same(result.restated, stored.economics) && same(history.head.policy_state ?? null, stored.policy_state));
    return doc;
  }).deferred();
}
