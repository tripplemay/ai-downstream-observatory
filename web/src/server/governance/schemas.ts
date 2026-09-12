import { z } from "zod";
import { amount } from "../ledger/decimal";

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(2000);
const decimal = z.string().max(80).refine(value => { try { amount(value); return true; } catch { return false; } }, "INVALID_DECIMAL");
const positive = decimal.refine(value => amount(value).gt(0), "POSITIVE_REQUIRED");
const nonnegative = decimal.refine(value => amount(value).gte(0), "NONNEGATIVE_REQUIRED");
const weight = positive.refine(value => amount(value).lte(1), "WEIGHT_OUT_OF_RANGE");
const markets = z.enum(["CN", "HK", "US"]);
const unique = (values: string[]) => values.length === new Set(values).size;
const ids = z.array(id).min(1).max(200).refine(unique, "DUPLICATE_IDS");
const currency = z.string().regex(/^[A-Z]{3}$/);
const instant = z.string().datetime({ offset: false });
export const commandEnvelope = z.object({ portfolio_id: id, expected_revision: z.number().int().safe().nonnegative(), idempotency_key: id, reason: text });

export const policySchema = z.object({
  schema_version: z.literal(1), mandate_version: id, approved_decisions: z.array(z.enum(["D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-07", "D-08"])).min(8).max(8).refine(unique),
  account_ids: ids, listing_ids: ids,
  allocation: z.object({ core: nonnegative, strategy: nonnegative, defensive: nonnegative }).strict().refine(value => amount(value.core).add(value.strategy).add(value.defensive).eq(1), "ALLOCATION_MUST_SUM_TO_ONE"),
  limits: z.object({ listing_weight: weight, index_weight: weight, market_weight: weight, currency_weight: weight, region_weight: weight, sector_weight: weight, strategy_weight: weight, min_cash_weight: nonnegative.refine(value => amount(value).lt(1)), max_order_cny: positive }).strict(),
  execution: z.object({
    proposal_ttl_seconds: z.number().int().min(1).max(604800), max_price_age_seconds: z.number().int().min(1).max(604800), max_valuation_age_seconds: z.number().int().min(1).max(604800), max_reconciliation_age_seconds: z.number().int().min(1).max(2678400),
    price_buffer_bps: nonnegative, max_price_deviation_bps: nonnegative, fee_rate_bps: nonnegative, max_fee_bps: positive,
    minimum_fee_by_currency: z.record(currency, nonnegative), max_spread_bps: nonnegative, max_premium_bps: nonnegative,
    min_turnover: positive, max_participation: weight,
  }).strict(),
  price_scope_by_market: z.object({ CN: id.optional(), HK: id.optional(), US: id.optional() }).strict(), fx_scope: id,
  benchmark: id, evaluation_window: text, contribution_rule: text, emergency_rule: text, review_after: instant,
  ai_mode: z.enum(["not_required", "required_block_on_missing"]),
}).strict().superRefine((value, context) => {
  if (amount(value.limits.strategy_weight).gt(amount(value.allocation.strategy))) context.addIssue({ code: "custom", message: "STRATEGY_WEIGHT_EXCEEDS_ALLOCATION" });
  if (amount(value.execution.fee_rate_bps).gt(amount(value.execution.max_fee_bps))) context.addIssue({ code: "custom", message: "FEE_BOUNDS_INVALID" });
  for (const name of ["price_buffer_bps", "max_price_deviation_bps", "max_fee_bps", "max_spread_bps", "max_premium_bps"] as const) if (amount(value.execution[name]).gt(10000)) context.addIssue({ code: "custom", message: "BPS_OUT_OF_RANGE" });
});
export type Policy = z.infer<typeof policySchema>;
export const strategySchema = z.object({
  schema_version: z.literal(1), strategy_key: id, algorithm: z.literal("manual_target_v1"),
  universe: ids, budget_weight: weight, evaluation_frequency: z.enum(["daily", "weekly", "monthly", "quarterly"]),
  benchmark: id, economic_rationale: text, invalidation_conditions: text,
  admission_thresholds: z.object({ min_out_of_sample_observations: z.number().int().positive(), min_forward_observations: z.number().int().positive(), min_trades: z.number().int().positive(), max_drawdown: weight, min_net_excess_return: decimal }).strict(),
}).strict();
export type Strategy = z.infer<typeof strategySchema>;
export const createPolicySchema = commandEnvelope.extend({ policy: policySchema }).strict();
export const createStrategySchema = commandEnvelope.extend({ strategy: strategySchema }).strict();
export const activationSchema = commandEnvelope.extend({ policy_version_id: id, strategy_version_id: id, valuation_id: id, gate_attachments: z.object({ "G-01": id, "G-03": id, "G-04": id }).strict() }).strict();
export const evidenceSchema = z.object({
  schema_version: z.literal(1), kind: z.literal("governance_gate_evidence"), portfolio_id: id, gate: z.enum(["G-01", "G-03", "G-04"]),
  policy_hash: z.string().regex(/^[a-f0-9]{64}$/), strategy_hash: z.string().regex(/^[a-f0-9]{64}$/), source_mode: z.literal("manual_verified"),
  reviewed_at: instant, valid_until: instant, checks: z.array(z.object({ id, status: z.literal("pass"), evidence: text }).strict()).min(1).max(100),
  verification_ids: z.array(id).max(100).optional(),
  research_run_id: id.optional(), metrics: z.object({ out_of_sample_observations: z.number().int().nonnegative(), forward_observations: z.number().int().nonnegative(), trades: z.number().int().nonnegative(), max_drawdown: nonnegative, net_excess_return: decimal }).strict().optional(),
}).strict();
export const proposalItemSchema = z.object({ account_id: id, listing_id: id, side: z.enum(["buy", "sell"]), currency, quantity: positive, limit_price: positive, estimated_fees: nonnegative }).strict();
export const proposalSchema = commandEnvelope.extend({ activation_id: id, valuation_id: id, expires_at: instant, items: z.array(proposalItemSchema).min(1).max(100), ai_run_id: id.optional() }).strict();
export const proposalRefSchema = commandEnvelope.extend({ proposal_id: id }).strict();
export const approvalSchema = proposalRefSchema.extend({ risk_run_id: id, expected_input_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const prepareSchema = proposalRefSchema.extend({ approval_id: id }).strict();
export const executionReportSchema = proposalRefSchema.extend({ proposal_item_id: id, source_id: id, source_event_id: id, status: z.enum(["submitted", "partial", "filled", "cancelled", "rejected"]), attachment_id: id, reported_quantity: nonnegative }).strict();
export const executionFactSchema = proposalRefSchema.extend({ proposal_item_id: id, attachment_id: id, command: z.unknown() }).strict();
export const capabilitiesSchema = z.object({ currencies: z.array(currency).min(1).refine(unique), listing_ids: ids, buy: z.boolean(), sell: z.boolean(), cash_holds_exclude_workbench_reservations: z.literal(true), cash_holds_exclude_trade_payables: z.literal(true) }).strict();
export const capabilityCommandSchema = commandEnvelope.extend({ account_id: id, market: markets, valid_until: instant, attachment_id: id, rules: capabilitiesSchema }).strict();
