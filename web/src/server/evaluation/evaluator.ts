import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { amount, Decimal } from "../ledger/decimal";
import { canonical, hash, revision } from "../ledger/service";
import { readJsonAttachment } from "../ledger/attachments";
import { parseStrictJson } from "../strict-json";
import { activation, verifyGateEvidence, type GovernanceOptions } from "../governance/core";
import { isGovernanceClientError } from "../governance/errors";
import { currentPublications, requireValuation, evaluateRisk, evaluationListing, evaluationCapability, evaluationObservation,
  type Position, type SecurityTransit, type RiskResult, type ProposalContext, type ProposalRow } from "../governance/risk";
import { evaluationScheduleSchema, type EvaluationScheduleDefinition } from "./schemas";
import { verifyEvaluationAuthorization } from "./service";
import { compareManualTargets, type TargetMeasurement, type TargetComparison, type EvaluationItem } from "./targets";

export interface EvaluationLease { job_id: string; owner: string; fencing_token: number; attempt: number }
export interface EvaluationCycle {
  id: string; portfolio_id: string; strategy_version_id: string; policy_version_id: string;
  period: string; status: string; schedule_version_id: string; environment: string; strategy_key: string;
  scheduled_at: string; cutoff_at: string; knowledge_at: string; deadline_at: string; created_at: string; state_revision: number;
}
export interface EvaluationJob {
  id: string; command_request_id: string; job_type: string; scope: string; period: string; status: string;
  lease_owner: string | null; lease_until: string | null; fencing_token: number; attempt_count: number;
}
export interface EvaluationBinding {
  cycle: EvaluationCycle; job: EvaluationJob; job_attempt_id: string; started_at: string;
  definition: EvaluationScheduleDefinition; schedule_id: string; schedule_revision: number;
  authorization: ReturnType<typeof verifyEvaluationAuthorization>;
  version: { id: string; schedule_id: string; definition_json: string; content_hash: string; created_at: string };
}
export interface PreparedEvaluation {
  binding: EvaluationBinding; input_manifest: Record<string, unknown>; input_hash: string;
  outcome: "unchanged" | "proposed" | "blocked"; reason_codes: string[];
  comparisons: TargetComparison[]; candidate_items: EvaluationItem[];
  valuation_id: string | null; expires_at: string | null; risk: RiskResult | null;
}
const METHOD = "manual_weight_targets_v1";
const actor = { id: "system:monthly-evaluation", kind: "strategy" as const };
const at = (value: string) => {
  const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw new Error("EVALUATION_TIME_INVALID"); return parsed;
};
export const evaluationStamp = (value: string): string => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match || new Date(at(value)).toISOString().slice(0, 19) !== match[1]) throw new Error("EVALUATION_TIME_INVALID");
  return `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z`;
};
const known = (value: unknown, boundary: string) => {
  if (typeof value !== "string" || evaluationStamp(value) > evaluationStamp(boundary)) throw new Error("EVALUATION_INPUT_KNOWN_AFTER_CUTOFF");
};

export function assertEvaluationLease(db: Database.Database, lease: EvaluationLease, now: string): EvaluationJob {
  if (!lease.job_id || !lease.owner || !Number.isSafeInteger(lease.fencing_token) || lease.fencing_token < 1 || !Number.isSafeInteger(lease.attempt) || lease.attempt < 1) throw new Error("EVALUATION_LEASE_INVALID");
  const job = db.prepare("SELECT * FROM job_runs WHERE id=?").get(lease.job_id) as EvaluationJob | undefined;
  if (!job || job.job_type !== "monthly_evaluation" || job.status !== "running" || job.lease_owner !== lease.owner
    || job.fencing_token !== lease.fencing_token || job.attempt_count !== lease.attempt || !job.lease_until || evaluationStamp(job.lease_until) <= evaluationStamp(now)) throw new Error("STALE_OR_EXPIRED_LEASE");
  return job;
}

export function evaluationBinding(db: Database.Database, lease: EvaluationLease, now: string): EvaluationBinding {
  const job = assertEvaluationLease(db, lease, now);
  const request = db.prepare("SELECT * FROM command_requests WHERE id=?").get(job.command_request_id) as { portfolio_id: string; command_type: string; payload_json: string; payload_hash: string } | undefined;
  if (!request || request.command_type !== "monthly_evaluation" || request.portfolio_id !== job.scope) throw new Error("EVALUATION_REQUEST_INVALID");
  const payload = parseStrictJson(request.payload_json) as { cycle_id?: unknown };
  if (!payload || typeof payload !== "object" || Object.keys(payload).length !== 1 || typeof payload.cycle_id !== "string" || hash(payload) !== request.payload_hash) throw new Error("EVALUATION_REQUEST_INVALID");
  const cycle = db.prepare("SELECT * FROM evaluation_cycles WHERE id=? AND portfolio_id=?").get(payload.cycle_id, job.scope) as EvaluationCycle | undefined;
  const link = db.prepare("SELECT * FROM evaluation_cycle_requests WHERE command_request_id=?").get(job.command_request_id) as { cycle_id: string; generation: number } | undefined;
  const generation = db.prepare("SELECT MAX(generation) AS n FROM evaluation_cycle_requests WHERE cycle_id=?").get(payload.cycle_id) as { n: number };
  if (!cycle || cycle.status !== "running" || cycle.environment !== "actual" || job.period !== cycle.period || !link || link.cycle_id !== cycle.id || link.generation !== generation.n) throw new Error("EVALUATION_CYCLE_NOT_RUNNING");
  const attempt = db.prepare("SELECT id,started_at FROM job_attempts WHERE job_id=? AND attempt=? AND fencing_token=? AND status='running'").get(job.id, lease.attempt, lease.fencing_token) as { id: string; started_at: string } | undefined;
  if (!attempt || evaluationStamp(attempt.started_at) > evaluationStamp(now)) throw new Error("STALE_OR_EXPIRED_LEASE");
  const version = db.prepare("SELECT * FROM evaluation_schedule_versions WHERE id=?").get(cycle.schedule_version_id) as EvaluationBinding["version"] | undefined;
  if (!version || createHash("sha256").update(version.definition_json, "utf8").digest("hex") !== version.content_hash) throw new Error("EVALUATION_DEFINITION_INVALID");
  const definition = evaluationScheduleSchema.parse(parseStrictJson(version.definition_json));
  const schedule = db.prepare("SELECT * FROM evaluation_schedules WHERE id=? AND portfolio_id=?").get(version.schedule_id, cycle.portfolio_id) as { strategy_key: string } | undefined;
  const head = db.prepare("SELECT * FROM evaluation_schedule_heads WHERE schedule_id=?").get(version.schedule_id) as { status: string; current_version_id: string; revision: number } | undefined;
  if (!schedule || schedule.strategy_key !== cycle.strategy_key || !head || head.status !== "enabled" || head.current_version_id !== version.id
    || definition.policy_version_id !== cycle.policy_version_id || definition.strategy_version_id !== cycle.strategy_version_id) throw new Error("EVALUATION_SCHEDULE_NOT_ENABLED");
  const authorization = verifyEvaluationAuthorization(db, { portfolio_id: cycle.portfolio_id, cycle_id: cycle.id });
  known(authorization.authorized_at, now); known(authorization.original_authorized_at, cycle.knowledge_at);
  return { cycle, job, job_attempt_id: attempt.id, started_at: attempt.started_at, definition, schedule_id: version.schedule_id, schedule_revision: head.revision, version, authorization };
}

/** Read-only snapshot plus deterministic computation; no proposal, result or job mutation. */
export function prepareMonthlyEvaluation(db: Database.Database, lease: EvaluationLease, options: GovernanceOptions = {}): PreparedEvaluation {
  const now = evaluationStamp(options.now ?? new Date().toISOString()), riskNow = new Date(now).toISOString();
  const binding = evaluationBinding(db, lease, now), { cycle, definition } = binding, portfolio = cycle.portfolio_id;
  const riskKnowledge = new Date(cycle.knowledge_at).toISOString();
  const input: Record<string, unknown> = { schema_version: "monthly-evaluation-input-v1", method: METHOD,
    cycle, schedule_id: binding.schedule_id, schedule_revision: binding.schedule_revision, definition: binding.version, authorization: binding.authorization,
    job_attempt_id: binding.job_attempt_id, evaluated_at: binding.started_at, release_hash: options.releaseHash ?? process.env.WORKBENCH_RELEASE_SHA256 ?? null };
  const result: PreparedEvaluation = { binding, input_manifest: input, input_hash: "", outcome: "blocked", reason_codes: [], comparisons: [], candidate_items: [], valuation_id: null, expires_at: null, risk: null };
  const all = (sql: string, ...params: (string | number)[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];
  try {
    if (evaluationStamp(now) >= evaluationStamp(cycle.deadline_at)) throw new Error("EVALUATION_DEADLINE_MISSED");
    if (evaluationStamp(cycle.scheduled_at) > now || evaluationStamp(cycle.cutoff_at) !== evaluationStamp(cycle.scheduled_at) || evaluationStamp(cycle.knowledge_at) !== evaluationStamp(cycle.scheduled_at)) throw new Error("EVALUATION_TIME_INVALID");
    known(binding.version.created_at, cycle.knowledge_at);
    const active = activation(db, portfolio, definition.activation_id, riskNow);
    const original = activation(db, portfolio, definition.activation_id, riskKnowledge);
    input.activation = active;
    if (active.policy.id !== cycle.policy_version_id || active.strategy.id !== cycle.strategy_version_id || active.row.id !== original.row.id
      || active.strategy.value.algorithm !== "manual_target_v1" || active.strategy.value.evaluation_frequency !== "monthly") throw new Error("EVALUATION_GOVERNANCE_MISMATCH");
    const policy = active.policy.value, strategy = active.strategy.value;
    known((active.policy as unknown as { created_at: string }).created_at, cycle.knowledge_at);
    known((active.strategy as unknown as { created_at: string }).created_at, cycle.knowledge_at);
    known((active.row as unknown as { created_at: string }).created_at, cycle.knowledge_at);
    known(active.row.valid_from, cycle.knowledge_at);
    if (active.row.valid_to && evaluationStamp(active.row.valid_to) <= now) throw new Error("EVALUATION_AUTHORIZATION_EXPIRED");
    const gateAttachments = JSON.parse(active.row.evidence_json).gate_attachments;
    verifyGateEvidence(db, actor, portfolio, gateAttachments, active.policy, active.strategy, options, riskKnowledge);
    const gateEvidence: unknown[] = []; input.gate_evidence = gateEvidence;
    for (const gate of ["G-01", "G-03", "G-04"] as const) {
      const original = readJsonAttachment(db, actor, portfolio, gateAttachments[gate], options);
      const evidence = parseStrictJson(original.bytes.toString("utf8")) as { reviewed_at: string; valid_until: string; verification_ids?: string[]; research_run_id?: string };
      known(original.attachment.created_at, cycle.knowledge_at); known(evidence.reviewed_at, cycle.knowledge_at);
      if (evaluationStamp(evidence.valid_until) <= now) throw new Error("EVALUATION_AUTHORIZATION_EXPIRED");
      gateEvidence.push({ gate, attachment: original.attachment });
      for (const id of evidence.verification_ids ?? []) {
        const verification = db.prepare("SELECT * FROM governance_verification_runs WHERE id=? AND portfolio_id=?").get(id, portfolio) as { recorded_at: string; executed_at: string; job_id: string; execution_manifest_json: string };
        known(verification.recorded_at, cycle.knowledge_at); known(verification.executed_at, cycle.knowledge_at);
        const execution = parseStrictJson(verification.execution_manifest_json) as { started_at: string; finished_at: string };
        known(execution.started_at, cycle.knowledge_at); known(execution.finished_at, cycle.knowledge_at);
        const job = db.prepare("SELECT created_at,updated_at FROM job_runs WHERE id=?").get(verification.job_id) as { created_at: string; updated_at: string };
        known(job.created_at, cycle.knowledge_at); known(job.updated_at, cycle.knowledge_at);
        gateEvidence.push({ verification, job });
      }
      if (evidence.research_run_id) {
        const research = db.prepare("SELECT id,created_at,completed_at FROM research_runs WHERE id=? AND portfolio_id=?").get(evidence.research_run_id, portfolio) as { created_at: string; completed_at: string };
        known(research.created_at, cycle.knowledge_at); known(research.completed_at, cycle.knowledge_at); gateEvidence.push({ research });
      }
    }
    const totalWeight = definition.targets.rows.reduce((sum, row) => sum.add(amount(row.weight)), amount("0"));
    if (totalWeight.gt(Decimal.min(amount(strategy.budget_weight), amount(policy.limits.strategy_weight)))) throw new Error("EVALUATION_TARGET_BUDGET_EXCEEDED");
    const recorded = all("SELECT recorded_at FROM ledger_events WHERE portfolio_id=?", portfolio);
    const head = { count: recorded.length, recorded_at: recorded.reduce<string | null>((latest, row) => {
      const value = evaluationStamp(String(row.recorded_at)); return latest === null || value > latest ? value : latest;
    }, null) };
    input.ledger_head = { ...head, revision: revision(db, portfolio) };
    if (head.recorded_at) known(head.recorded_at, cycle.knowledge_at);
    const accounts = all("SELECT * FROM accounts WHERE portfolio_id=? ORDER BY id", portfolio); input.accounts = accounts;
    const capabilities = all("SELECT c.* FROM account_capabilities c JOIN accounts a ON a.id=c.account_id WHERE a.portfolio_id=? ORDER BY c.id", portfolio); input.capabilities = capabilities;
    const reconciliations = all("SELECT * FROM reconciliation_runs WHERE portfolio_id=? ORDER BY id", portfolio); input.reconciliations = reconciliations;
    input.reconciliation_issues = all("SELECT i.* FROM reconciliation_issues i JOIN reconciliation_runs r ON r.id=i.run_id WHERE r.portfolio_id=? ORDER BY i.id", portfolio);
    for (const account of accounts) known(account.created_at, cycle.knowledge_at);
    for (const row of capabilities) known(row.recorded_at, cycle.knowledge_at);
    for (const row of reconciliations) known(row.created_at, cycle.knowledge_at);
    const positions = all("SELECT p.* FROM position_projections p JOIN accounts a ON a.id=p.account_id WHERE a.portfolio_id=? ORDER BY p.account_id,p.listing_id", portfolio) as unknown as Position[];
    const transits = all("SELECT p.* FROM security_transit_projections p JOIN accounts a ON a.id=p.source_account_id WHERE a.portfolio_id=? ORDER BY p.transfer_event_id", portfolio) as unknown as SecurityTransit[];
    input.positions = positions; input.security_transits = transits;
    const reservations = all("SELECT * FROM reservations WHERE portfolio_id=? ORDER BY id", portfolio); input.reservations = reservations;
    const proposals = all("SELECT * FROM proposals WHERE portfolio_id=? AND environment='actual' ORDER BY id", portfolio); input.proposals = proposals;
    const approvals = all("SELECT a.* FROM approval_events a JOIN proposals p ON p.id=a.proposal_id WHERE p.portfolio_id=? AND p.environment='actual' ORDER BY a.id", portfolio); input.approvals = approvals;
    // Current mutable reservation state cannot reconstruct an earlier pending state.
    for (const row of reservations) { known(row.created_at, cycle.knowledge_at); known(row.updated_at, cycle.knowledge_at); }
    for (const row of [...proposals, ...approvals]) known(row.created_at, cycle.knowledge_at);
    const pending = proposals.filter(row => evaluationStamp(String(row.expires_at)) > evaluationStamp(cycle.knowledge_at)
      && !approvals.some(event => event.proposal_id === row.id && ["reject", "cancel_remainder", "expire"].includes(String(event.action))));
    input.pending_proposals = pending;
    if (reservations.some(row => row.status === "active") || pending.length) throw new Error("EVALUATION_PENDING_ACTIVITY");
    const targetKeys = new Set(definition.targets.rows.map(row => JSON.stringify([row.account_id, row.listing_id])));
    for (const row of [...positions, ...transits.map(row => ({ ...row, account_id: row.source_account_id }))]) {
      if (!amount(row.quantity).isZero() && strategy.universe.includes(row.listing_id) && !targetKeys.has(JSON.stringify([row.account_id, row.listing_id]))) throw new Error("EVALUATION_TARGET_SCOPE_INCOMPLETE");
    }
    const publications = currentPublications(db, policy, riskKnowledge); input.publications = publications;
    for (const publication of publications) known(publication.published_at, cycle.knowledge_at);
    const valuationId = db.prepare("SELECT id FROM valuation_runs WHERE portfolio_id=? AND ledger_revision=? AND quality='complete' AND julianday(created_at)<=julianday(?) AND julianday(cutoff_at)<=julianday(?) ORDER BY cutoff_at DESC,created_at DESC,id DESC LIMIT 1")
      .get(portfolio, revision(db, portfolio), cycle.knowledge_at, cycle.cutoff_at) as { id: string } | undefined;
    if (!valuationId) throw new Error("EVALUATION_ELIGIBLE_VALUATION_REQUIRED");
    const valuation = requireValuation(db, portfolio, valuationId.id, policy, publications, riskNow); result.valuation_id = valuation.id; input.valuation = valuation;
    known(valuation.created_at, cycle.knowledge_at); known(valuation.cutoff_at, cycle.cutoff_at);
    const valuationManifest = parseStrictJson(valuation.market_manifest) as { rules?: { expected_sessions?: Record<string, string> } };
    const valuationItems = all("SELECT * FROM valuation_items WHERE run_id=? ORDER BY id", valuation.id); input.valuation_items = valuationItems;
    const vector: unknown[] = []; input.valuation_price_vector = vector;
    // A shared session is insufficient: NAV and target values must consume one price/FX vector.
    for (const item of valuationItems) {
      const evidence = parseStrictJson(String(item.evidence_json)) as { price_observation_id?: string; fx_observation_id?: string };
      const checkVector = (scope: string | undefined, series: string, metric: string, expected: string | undefined) => {
        if (!scope) throw new Error("EVALUATION_VALUATION_PRICE_VECTOR_MISMATCH");
        const selected = evaluationObservation(db, publications, scope, series, metric, policy, riskKnowledge);
        known((selected as unknown as { ingested_at: string }).ingested_at, cycle.knowledge_at);
        if (selected.published_at) known(selected.published_at, cycle.knowledge_at);
        if (selected.time_precision === "second") known(selected.observed_at, cycle.cutoff_at);
        vector.push(selected);
        if (!expected || selected.id !== expected) throw new Error("EVALUATION_VALUATION_PRICE_VECTOR_MISMATCH");
      };
      if (item.listing_id) {
        const listing = evaluationListing(db, String(item.listing_id), policy, riskKnowledge);
        checkVector(policy.price_scope_by_market[listing.market], listing.id, "close", evidence.price_observation_id);
      }
      if (item.currency !== "CNY") checkVector(policy.fx_scope, `FX:${item.currency}`, "fx_cny_per_unit", evidence.fx_observation_id);
    }
    const observations: unknown[] = [], listings: unknown[] = [], permissions: unknown[] = [];
    input.observations = observations; input.listings = listings; input.permissions = permissions;
    const rows: TargetMeasurement[] = [];
    for (const target of definition.targets.rows) {
      if (!policy.account_ids.includes(target.account_id) || !strategy.universe.includes(target.listing_id)) throw new Error("EVALUATION_TARGET_SCOPE_INCOMPLETE");
      const info = evaluationListing(db, target.listing_id, policy, riskKnowledge); listings.push(info);
      known(info.verified_at, cycle.knowledge_at);
      if (info.currency !== target.currency) throw new Error("INVALID_LISTING_CURRENCY");
      for (const side of ["buy", "sell"]) {
        const capability = evaluationCapability(db, target.account_id, info, side, riskKnowledge); permissions.push(capability);
        const interval = capability as unknown as { valid_from: string; valid_to: string | null };
        known(interval.valid_from, cycle.knowledge_at);
        if (interval.valid_to && evaluationStamp(interval.valid_to) <= now) throw new Error("EVALUATION_AUTHORIZATION_EXPIRED");
        const evidence = readJsonAttachment(db, actor, portfolio, capability.evidence_id, { ...options, accountId: target.account_id });
        known(evidence.attachment.created_at, cycle.knowledge_at); permissions.push({ evidence: evidence.attachment });
      }
      const observe = (metric: string) => {
        const value = evaluationObservation(db, publications, policy.price_scope_by_market[info.market], info.id, metric, policy, riskKnowledge);
        known((value as unknown as { ingested_at: string }).ingested_at, cycle.knowledge_at);
        if (value.published_at) known(value.published_at, cycle.knowledge_at);
        if (value.time_precision === "second") known(value.observed_at, cycle.cutoff_at);
        observations.push(value); return value;
      };
      const close = observe("close"), spread = observe("spread_bps"), premium = observe("premium_bps"), turnover = observe("turnover"), volume = observe("volume");
      if (close.unit !== info.currency || spread.unit !== "bps" || premium.unit !== "bps" || turnover.unit !== info.currency || volume.unit !== "shares"
        || !amount(close.value).gt(0) || !amount(volume.value).gt(0)) throw new Error("MARKET_UNITS_INVALID");
      if (amount(spread.value).lt(0) || amount(spread.value).gt(policy.execution.max_spread_bps) || amount(premium.value).abs().gt(policy.execution.max_premium_bps)
        || amount(turnover.value).lt(policy.execution.min_turnover)) throw new Error("EXECUTION_LIQUIDITY_BLOCKED");
      const session = close.time_precision === "date" ? close.observed_at : new Intl.DateTimeFormat("en-CA", { timeZone: close.source_timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(close.observed_at));
      if (valuationManifest.rules?.expected_sessions?.[info.market] !== session) throw new Error("EVALUATION_SESSION_EVIDENCE_MISSING");
      const fx = target.currency === "CNY" ? null : evaluationObservation(db, publications, policy.fx_scope, `FX:${target.currency}`, "fx_cny_per_unit", policy, riskKnowledge);
      if (fx && (fx.unit !== "CNY_per_unit_currency" || !amount(fx.value).gt(0))) throw new Error("INVALID_FX_RATE");
      if (fx) { known((fx as unknown as { ingested_at: string }).ingested_at, cycle.knowledge_at); if (fx.published_at) known(fx.published_at, cycle.knowledge_at); if (fx.time_precision === "second") known(fx.observed_at, cycle.cutoff_at); observations.push(fx); }
      const settled = positions.filter(row => row.account_id === target.account_id && row.listing_id === target.listing_id).reduce((sum, row) => sum.add(amount(row.quantity)), amount("0"));
      const transit = transits.filter(row => row.source_account_id === target.account_id && row.listing_id === target.listing_id).reduce((sum, row) => sum.add(amount(row.quantity)), amount("0"));
      rows.push({ ...target, settled_quantity: settled.toFixed(), transit_quantity: transit.toFixed(), close: close.value, fx_cny: fx?.value ?? "1", quantity_step: info.quantity_step!, price_step: info.price_step! });
    }
    input.measurements = rows;
    const comparison = compareManualTargets({ nav_cny: valuation.nav_cny!, rows, absolute_tolerance_cny: definition.targets.absolute_tolerance_cny,
      weight_tolerance: definition.targets.weight_tolerance, fee_rate_bps: policy.execution.fee_rate_bps, minimum_fee_by_currency: policy.execution.minimum_fee_by_currency });
    result.comparisons = comparison.comparisons; result.candidate_items = comparison.items;
    if (comparison.blockers.length) { input.target_blockers = comparison.blockers; throw new Error(comparison.blockers[0].code); }
    const expiry = new Date(Math.min(at(cycle.deadline_at), at(binding.started_at) + policy.execution.proposal_ttl_seconds * 1000)).toISOString(); result.expires_at = expiry;
    const context: ProposalContext = { activation_id: definition.activation_id, valuation_id: valuation.id, publications };
    const virtual: ProposalRow = { id: `evaluation:${cycle.id}`, portfolio_id: portfolio, environment: "actual", policy_version_id: active.policy.id, strategy_version_id: active.strategy.id,
      ledger_revision: revision(db, portfolio), market_manifest: canonical(context), input_hash: hash({ cycle: cycle.id, definition_hash: binding.version.content_hash, context, items: comparison.items }), expires_at: expiry, created_at: binding.started_at };
    const risk = evaluateRisk(db, actor, virtual, comparison.items.map((item, i) => ({ ...item, id: `evaluation-item:${i}`, proposal_id: virtual.id })), context, options, riskNow);
    input.risk_input_hash = risk.input_hash; result.risk = risk;
    if (risk.status !== "pass") { result.reason_codes = risk.checks.map(check => check.code); }
    else { result.outcome = comparison.items.length ? "proposed" : "unchanged"; result.reason_codes = [comparison.items.length ? "EXPLICIT_TARGET_DIFFERENCES" : "EXPLICIT_TARGETS_WITHIN_TOLERANCE"]; }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const safe = message.startsWith("EVALUATION_") && /^[A-Z_]+$/.test(message) || isGovernanceClientError(message);
    result.reason_codes = [safe ? message : "EVALUATION_INPUT_INVALID"];
  }
  input.outcome = result.outcome; input.reason_codes = result.reason_codes;
  if (Buffer.byteLength(canonical(input), "utf8") > 16 * 1024 * 1024) throw new Error("EVALUATION_INPUT_TOO_LARGE");
  result.input_hash = hash(input);
  return result;
}
