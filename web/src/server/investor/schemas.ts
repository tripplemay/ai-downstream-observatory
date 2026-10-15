import { z } from "zod";
import { reconciliationIntentSchema } from "./reconciliation-schemas";
import { fundingPlanSchema } from "./funding-schemas";
import { tradeRecordingIntentSchema } from "./trade-recording-schemas";
import { cashRecordingIntentSchema } from "./cash-recording-schemas";

export const investorId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
export const investorHash = z.string().regex(/^[a-f0-9]{64}$/);
export const investorInstant = z.string().datetime({ precision: 3 });
const revision = z.number().int().nonnegative().safe();
const money = z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/);
export const investorProfileSchema = z.object({
  schema_version: z.literal("investor-profile-v1"),
  horizon_years: z.number().int().min(1).max(50),
  loss_tolerance: z.enum(["0.10", "0.20", "0.30", "0.40", "0.50"]).nullable(),
  liquidity_need: z.enum(["none_in_horizon", "planned_withdrawal", "uncertain"]),
  markets: z.array(z.enum(["CN", "HK", "US"])).min(1).max(3).refine(value => new Set(value).size === value.length),
  product_scope: z.literal("unleveraged_long_only_etfs"),
  research_direction: z.enum(["system_design", "diversified_base", "fixed_rebalance", "rotation"]).nullable(),
  exclusions: z.array(z.string().trim().min(1).max(100)).max(20),
  illustrative_budget_cny: money.nullable(),
  planned_annual_contribution_cny: money.nullable(),
}).strict();
export type InvestorProfile = z.infer<typeof investorProfileSchema>;

const researchDecimal = z.string().max(200).regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,120})?$/);
const researchDecline = z.string().max(126).regex(/^(?:-0(?:\.[0-9]{1,120})?|-1(?:\.0{1,120})?|0(?:\.0{1,120})?)$/);
const researchWeightPattern = /^(0\.[0-9]{1,8}|1(?:\.0{1,8})?)$/;
const researchWeights = z.record(investorId, z.string().regex(researchWeightPattern).refine(value => /[1-9]/.test(value)))
  .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 20 && Object.values(value).every(weight => researchWeightPattern.test(weight)) && Object.values(value).reduce((sum, weight) => {
    const [whole, fraction = ""] = weight.split(".");
    return sum + BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, "0"));
  }, 0n) === 100000000n);
const phaseProgress = z.object({ registered: revision.max(8), completed: revision.max(8) }).strict()
  .refine(value => value.completed <= value.registered);
export const researchRegistrySchema = z.object({
  experiment_id: investorId, manifest_hash: investorHash,
  phases: z.object({ train: phaseProgress, validation: phaseProgress, holdout: phaseProgress }).strict(),
  freeze_hash: investorHash.nullable(), prior_window_exposures: revision, exposure_watermark: revision,
  holdout_status: z.enum(["previously_exposed", "not_independently_verified"]),
  coverage: z.literal("local_investor_trials_only"), live_advice_eligible: z.literal(false),
}).strict().refine(value => (value.prior_window_exposures > 0) === (value.holdout_status === "previously_exposed")
  && value.phases.validation.registered <= 1 && value.phases.holdout.registered <= 1
  && (value.phases.validation.registered === 0 || value.freeze_hash !== null)
  && (value.phases.holdout.registered === 0 || value.phases.validation.completed === 1));
export const researchTaskSchema = z.object({
  id: investorId, profile_id: investorId, profile_version: revision.refine(value => value > 0), input_version: investorHash,
  engine_version: z.literal("investor-diversified-reference-v1"),
  status: z.enum(["queued", "running", "retrying", "blocked", "calculated", "failed", "outdated"]),
  created_at: investorInstant, completed_at: investorInstant.nullable(),
  reason_codes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)).max(40),
  registry: researchRegistrySchema.nullable(),
  study: z.object({ status: z.enum(["risk_options_ready", "reference_ready", "insufficient_evidence"]),
    qualification: z.enum(["synthetic_test_only", "owner_reviewed_reconstructed"]), result_hash: investorHash, implementation_hash: investorHash,
    phase_checks: z.array(z.object({ phase: z.enum(["train", "validation", "holdout"]),
      execution_failure_count: revision, benchmark_execution_failure_count: revision,
    }).strict()).max(3).refine(value => value.every((row, index) => row.phase === ["train", "validation", "holdout"][index])).optional(),
    source_context: z.object({ range_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), range_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      valid_until: investorInstant, basis: z.literal("owner_reviewed_historical_reconstruction"),
      listings: z.array(z.object({ listing_id: investorId, provider_symbol: z.string().min(1).max(100), market: z.enum(["CN", "HK", "US"]),
        role: z.enum(["growth", "defensive", "diversifier"]) }).strict()).min(1).max(20),
    }).strict().refine(value => value.range_start <= value.range_end
      && new Set(value.listings.map(row => row.listing_id)).size === value.listings.length).optional(),
    candidates: z.array(z.object({ parameters_hash: investorHash,
      weights: researchWeights,
      decision_rule: z.string().min(1).max(1000).optional(),
      train_net_twr: researchDecimal.nullable(), train_drawdown: researchDecline.nullable(), benchmark_net_twr: researchDecimal.nullable(),
      usable: z.boolean(), stresses: z.array(z.object({ id: investorId, label: z.string().min(1).max(300), portfolio_return: researchDecimal }).strict()).max(10),
    }).strict()).max(8).refine(value => new Set(value.map(row => row.parameters_hash)).size === value.length),
  }).strict().refine(value => (value.qualification === "owner_reviewed_reconstructed") === (value.source_context !== undefined)).nullable(), live_advice_eligible: z.literal(false),
}).strict().refine(value => (value.completed_at === null || value.completed_at >= value.created_at)
  && (value.status !== "calculated" || value.study !== null && value.completed_at !== null)
  && (value.status !== "blocked" || value.study === null && value.completed_at !== null && value.reason_codes.length > 0)
  && (value.study === null || value.status === "calculated" || value.status === "outdated")
  && (!value.study?.phase_checks || value.study.phase_checks.every(row => value.registry !== null && value.registry.phases[row.phase].completed > 0))
  && (value.study?.status !== "reference_ready" || !value.study.phase_checks || value.study.phase_checks.length === 3
    && value.study.phase_checks.every(row => row.execution_failure_count === 0 && row.benchmark_execution_failure_count === 0)));
export type InvestorResearchTask = z.infer<typeof researchTaskSchema>;

export const evidenceGapSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  title: z.string().min(1).max(200), detail: z.string().min(1).max(1500),
  affected_markets: z.array(z.enum(["CN", "HK", "US"])).max(3),
  action: z.string().min(1).max(300),
}).strict();
const derivedDecimal = z.string().max(200).regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,120})?$/);
const nonnegativeDerived = derivedDecimal.refine(value => !value.startsWith("-"));
const unitDecimal = z.string().max(125).regex(/^(?:0(?:\.[0-9]{1,120})?|1(?:\.0{1,120})?)$/);
const policyEvaluationSchema = z.object({ parameters_hash: investorHash, evaluation_timezone: z.string().min(1).max(100),
  review_period: z.string().regex(/^[0-9]{4}(?:-H[12])?$/), calendar_due: z.boolean(), cooldown_active: z.boolean(),
  new_funding: z.boolean(), new_cny_cash: z.boolean(), cash_repair_pending: z.boolean(),
  class_drift: z.array(z.object({ role: z.enum(["growth", "defensive", "diversifier"]), target_weight: unitDecimal,
    current_weight: unitDecimal, difference_weight: derivedDecimal, threshold_breached: z.boolean() }).strict()).min(1).max(3)
    .refine(rows => new Set(rows.map(row => row.role)).size === rows.length),
}).strict();
export const modelChangeSchema = z.object({
  assessment_hash: investorHash, model_nav_cny: nonnegativeDerived.refine(value => /[1-9]/.test(value)).nullable(), estimated_cost_cny: nonnegativeDerived.nullable(),
  hypothetical_cash_remaining_cny: nonnegativeDerived.nullable(),
  funding_status: z.enum(["none", "not_due", "hypothetical_due"]),
  allocation_method: z.enum(["none", "contribution_repair_without_sales", "band_rebalance_research_not_executable"]),
  policy_evaluation: policyEvaluationSchema.optional(),
  market_cutoffs: z.object({ CN: investorInstant.optional(), HK: investorInstant.optional(), US: investorInstant.optional() }).strict().refine(value => Object.keys(value).length > 0),
  constraints_not_checked: z.array(z.enum(["lot_size", "tradability", "actual_cash", "settlement", "tax", "account_permissions"])).length(6).refine(value => new Set(value).size === 6),
  changes: z.array(z.object({ listing_id: investorId, before_target_weight: unitDecimal, after_target_weight: unitDecimal,
    observed_model_weight: unitDecimal, current_model_value_cny: nonnegativeDerived, hypothetical_target_value_cny: nonnegativeDerived,
    difference_cny: derivedDecimal, within_band: z.boolean(), proposed_change_cny: derivedDecimal, remaining_target_difference_cny: derivedDecimal,
  }).strict()).max(20).refine(value => new Set(value.map(row => row.listing_id)).size === value.length),
}).strict();
export type InvestorModelChange = z.infer<typeof modelChangeSchema>;
export const observationSchema = z.object({
  schema_version: z.literal("investor-observation-v1"),
  outcome: z.enum(["observe", "decision_required", "insufficient_evidence"]),
  evaluated_at: investorInstant, data_cutoff: investorInstant.nullable(),
  profile_id: investorId, profile_version: revision.refine(value => value > 0),
  input_version: investorHash, gaps: z.array(evidenceGapSchema).max(40),
  reasons: z.array(z.string().min(1).max(1500)).max(20),
  next_review_at: investorInstant.nullable(), next_conditions: z.array(z.string().min(1).max(500)).min(1).max(20),
  monitoring: z.enum(["not_enabled", "active", "paused"]),
  model_change: modelChangeSchema.optional(),
  scope: z.literal("research_model"), live_advice_eligible: z.literal(false),
}).strict().refine(value => (value.outcome === "insufficient_evidence" ? value.gaps.length > 0 : value.gaps.length === 0 && value.data_cutoff !== null)
  && (value.data_cutoff === null || value.data_cutoff <= value.evaluated_at)
  && (value.next_review_at === null || value.next_review_at > value.evaluated_at));
export type InvestorObservation = z.infer<typeof observationSchema>;

export const fixedPolicyBindingSchema = z.object({ parameters: z.record(z.unknown()), evaluation_timezone: z.string().min(1).max(100) }).strict();
const referencePlanV1Schema = z.object({
  schema_version: z.literal("investor-reference-plan-v1"),
  profile_id: investorId, strategy_version: z.string().min(1).max(160),
  strategy_evidence: z.string().min(1).max(2000), input_version: investorHash,
  data_cutoff: investorInstant, created_at: investorInstant,
  valid_until: investorInstant, data_mode: z.enum(["live_observed", "synthetic", "reconstructed"]),
  reference_evidence: z.object({ request_id: investorId, run_id: investorId, source_input_id: investorId, experiment_id: investorId,
    manifest_hash: investorHash, result_hash: investorHash, selected_parameters_hash: investorHash,
    holdout_status: z.enum(["previously_exposed", "not_independently_verified"]), qualification: z.literal("owner_reviewed_reconstructed"),
  }).strict().optional(),
  targets: z.array(z.object({
    listing_id: investorId, symbol: z.string().min(1).max(40), name: z.string().min(1).max(200),
    market: z.enum(["CN", "HK", "US"]), currency: z.enum(["CNY", "HKD", "USD"]),
    weight: z.string().regex(/^(0\.[0-9]{1,8}|1(?:\.0{1,8})?)$/).refine(value => Number(value) > 0),
    role: z.string().min(1).max(500), overlap_summary: z.string().min(1).max(1000),
  }).strict()).min(1).max(20),
  estimated_cost: z.string().min(1).max(1000), risk_scenarios: z.array(z.string().min(1).max(1500)).min(1).max(10),
  benchmark_summary: z.string().min(1).max(2000), counterarguments: z.array(z.string().min(1).max(1500)).min(1).max(10),
  uncertainties: z.array(z.string().min(1).max(1500)).max(20),
  live_advice_eligible: z.literal(false),
}).strict();
export const referencePlanSchema = z.union([referencePlanV1Schema, referencePlanV1Schema.extend({
  schema_version: z.literal("investor-reference-plan-v2"), data_mode: z.literal("reconstructed"),
  reference_evidence: referencePlanV1Schema.shape.reference_evidence.unwrap(), fixed_policy: fixedPolicyBindingSchema,
}).strict()]).refine(value => (value.data_mode === "reconstructed") === (value.reference_evidence !== undefined)
  && value.valid_until > value.created_at && value.data_cutoff <= value.created_at
  && new Set(value.targets.map(target => target.listing_id)).size === value.targets.length
  && value.targets.reduce((sum, target) => {
    const [whole, fractional = ""] = target.weight.split(".");
    return sum + Number(whole) * 100000000 + Number(fractional.padEnd(8, "0"));
  }, 0) === 100000000, "REFERENCE_PLAN_INVALID");
export type ReferencePlan = z.infer<typeof referencePlanSchema>;

const acquisitionMarketSchema = z.object({
  market: z.enum(["CN", "HK", "US"]), target_count: revision.min(1).max(20), registered_count: revision.max(20), completed_count: revision.max(20),
  status: z.enum(["not_registered", "incomplete", "scheduled", "queued", "running", "lease_expired", "expired", "failed", "superseded", "missed_window", "partial", "no_events", "waiting_core", "input_registered"]),
  session_date: z.string().date().nullable(), scheduled_at: investorInstant.nullable(), latest_start_at: investorInstant.nullable(), stop_at: investorInstant.nullable(),
  lease_until: investorInstant.nullable(), valid_until: investorInstant.nullable(), completed_at: investorInstant.nullable(),
}).strict().refine(value => value.completed_count <= value.registered_count && value.registered_count <= value.target_count
  && (value.status !== "not_registered" || value.registered_count === 0)
  && (value.status !== "running" || value.lease_until !== null)
  && (!["waiting_core", "input_registered"].includes(value.status) || value.completed_count === value.target_count && value.completed_at !== null)
  && ((value.latest_start_at === null) === (value.stop_at === null))
  && (value.latest_start_at === null || value.scheduled_at !== null && value.scheduled_at <= value.latest_start_at && value.latest_start_at < value.stop_at!));
export const acquisitionSchema = z.object({
  model_id: investorId, checked_at: investorInstant, phase: z.enum(["initial_prices", "confirmed_close"]),
  status: z.enum(["visible", "paused", "outdated", "expired", "source_unavailable", "unavailable"]),
  markets: z.array(acquisitionMarketSchema).max(3).refine(rows => new Set(rows.map(row => row.market)).size === rows.length
    && rows.reduce((sum, row) => sum + row.target_count, 0) <= 20),
  evidence_scope: z.literal("task_metadata_only"), live_advice_eligible: z.literal(false),
}).strict().refine(value => (value.status === "visible") === (value.markets.length > 0)
  && value.markets.every(row => row.completed_at === null || row.completed_at <= value.checked_at)
  && value.markets.every(row => row.status !== "running" || row.lease_until! > value.checked_at)
  && value.markets.every(row => row.status !== "scheduled" || row.scheduled_at !== null && row.scheduled_at > value.checked_at)
  && value.markets.every(row => !["queued", "scheduled", "running"].includes(row.status) || row.valid_until !== null && row.valid_until > value.checked_at)
  && value.markets.every(row => value.phase !== "initial_prices" || row.latest_start_at === null && row.stop_at === null && row.status !== "input_registered"));
export type InvestorAcquisition = z.infer<typeof acquisitionSchema>;

export const modelWatchSchema = z.object({
  id: investorId, profile_id: investorId, plan_id: investorId, plan_hash: investorHash, valid_until: investorInstant, enabled: z.boolean(),
  status: z.enum(["awaiting_inputs", "awaiting_evaluation", "queued", "running", "retrying", "blocked", "synthetic_preview", "research_observe", "research_decision", "overdue", "paused", "outdated", "expired", "failed"]),
  created_at: investorInstant, completed_at: investorInstant.nullable(), next_check_at: investorInstant.nullable(),
  checkpoint_sequence: revision, initial_notional_cny: z.literal("10000"),
  evaluation_input_version: investorHash.optional(),
  model_nav_cny: nonnegativeDerived.refine(value => /[1-9]/.test(value)).nullable(),
  source_qualification: z.enum(["not_available", "synthetic_test_only", "owner_reviewed_reconstructed"]),
  acquisition: acquisitionSchema.optional(),
  live_advice_eligible: z.literal(false),
}).strict().refine(value => (value.completed_at === null || value.completed_at >= value.created_at)
  && (value.enabled ? value.status !== "paused" : value.status === "paused")
  && (value.model_nav_cny === null || value.checkpoint_sequence > 0 && (value.status === "synthetic_preview" && value.source_qualification === "synthetic_test_only"
    || ["research_observe", "research_decision"].includes(value.status) && value.source_qualification === "owner_reviewed_reconstructed"))
  && (!["synthetic_preview", "research_observe", "research_decision"].includes(value.status) || value.completed_at !== null)
  && (!["research_observe", "research_decision"].includes(value.status) || value.evaluation_input_version !== undefined));
export type InvestorModelWatch = z.infer<typeof modelWatchSchema>;

const envelope = z.object({ expected_revision: revision, idempotency_key: investorId });
const accountBookInputSchema = z.object({ name: z.string().trim().min(1).max(120), broker: z.string().trim().min(1).max(120),
  currency: z.enum(["CNY", "HKD", "USD"]) }).strict();
export const investorCommandSchema = z.discriminatedUnion("action", [
  envelope.extend({ action: z.literal("save_profile"), profile: investorProfileSchema }).strict(),
  envelope.extend({ action: z.literal("save_funding_plan"), funding_plan: fundingPlanSchema }).strict(),
  envelope.extend({ action: z.literal("compare_funding") }).strict(),
  envelope.extend({ action: z.literal("evaluate") }).strict(),
  envelope.extend({ action: z.literal("review"), observation_id: investorId,
    decision: z.enum(["accept_idea", "defer", "reject"]), note: z.string().trim().max(2000) }).strict(),
  envelope.extend({ action: z.literal("save_plan"), plan_id: investorId }).strict(),
  envelope.extend({ action: z.literal("set_monitoring"), model_id: investorId, enabled: z.boolean() }).strict(),
  envelope.extend({ action: z.literal("link_portfolio"), portfolio_id: investorId.nullable(), expected_ledger_revision: revision.nullable() }).strict(),
  envelope.extend({ action: z.literal("create_account_book"), book_name: z.string().trim().min(1).max(120), account: accountBookInputSchema }).strict(),
  envelope.extend({ action: z.literal("add_linked_account"), portfolio_id: investorId, expected_ledger_revision: revision, account: accountBookInputSchema }).strict(),
  reconciliationIntentSchema.extend(envelope.shape).strict(),
  tradeRecordingIntentSchema.extend(envelope.shape).strict(),
  cashRecordingIntentSchema.extend(envelope.shape).strict(),
]);
export type InvestorCommand = z.infer<typeof investorCommandSchema>;

export const investorReceiptSchema = z.object({ workspace_id: investorId, revision: revision.refine(value => value > 0),
  action: z.enum(["save_profile", "save_funding_plan", "compare_funding", "evaluate", "review", "save_plan", "set_monitoring", "link_portfolio", "create_account_book", "add_linked_account", "reconcile_linked_account", "record_linked_trade_fact", "record_linked_cash_fact"]), resource_id: investorId, audit_id: investorId }).strict();
