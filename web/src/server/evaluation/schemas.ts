import { z } from "zod";
import { amount } from "../ledger/decimal";

const id = z.string().min(1).max(200).refine(value => value === value.trim() && !!value.trim(), "INVALID_IDENTIFIER");
const decimal = z.string().max(80).refine(value => { try { return amount(value).gte(0); } catch { return false; } }, "NONNEGATIVE_DECIMAL_REQUIRED");
const weight = decimal.refine(value => { try { return amount(value).lte(1); } catch { return false; } }, "WEIGHT_OUT_OF_RANGE");
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine(value => !value.startsWith("0000"), "MONTH_OUT_OF_RANGE");
export const evaluationScheduleSchema = z.object({
  schema_version: z.literal("evaluation-schedule-v1"), frequency: z.literal("monthly"), environment: z.literal("actual"),
  policy_version_id: id, strategy_version_id: id, activation_id: id,
  timezone: z.string().min(1).max(100).refine(value => { try { if (/^[+-]/.test(value)) return false; new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "INVALID_TIMEZONE"),
  start_month: month, end_month: month.nullable(),
  trigger: z.object({ day: z.number().int().min(1).max(28), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }).strict(),
  deadline_seconds: z.number().int().min(1).max(604800), max_attempts: z.number().int().min(1).max(5),
  targets: z.object({
    method: z.literal("manual_weight_targets_v1"), weight_basis: z.literal("portfolio_nav"),
    rows: z.array(z.object({ account_id: id, listing_id: id, currency: z.string().regex(/^[A-Z]{3}$/), weight }).strict()).min(1).max(100)
      .refine(rows => new Set(rows.map(row => JSON.stringify([row.account_id, row.listing_id]))).size === rows.length, "DUPLICATE_TARGET"),
    absolute_tolerance_cny: decimal, weight_tolerance: weight, tolerance_rule: z.literal("max_absolute_or_weight"),
    unlisted_strategy_positions: z.literal("block"), pending_activity: z.literal("block"),
    price_rule: z.literal("close_rounded_to_step"), quantity_rule: z.literal("floor_to_step"),
  }).strict(),
}).strict().refine(value => value.end_month === null || value.end_month >= value.start_month, "INVALID_MONTH_RANGE");
export type EvaluationScheduleDefinition = z.infer<typeof evaluationScheduleSchema>;
const envelope = z.object({ portfolio_id: id, expected_revision: z.number().int().safe().nonnegative(), idempotency_key: id, reason: z.string().trim().min(1).max(2000) });
export const saveScheduleSchema = envelope.extend({ expected_schedule_id: id.nullable(), expected_schedule_revision: z.number().int().safe().nonnegative(), definition_json: z.string().min(1).max(262144) }).strict();
export const setScheduleStatusSchema = envelope.extend({ schedule_id: id, expected_schedule_revision: z.number().int().safe().positive(), status: z.enum(["enabled", "paused"]) }).strict();
export const retryEvaluationSchema = envelope.extend({ cycle_id: id, expected_state_revision: z.number().int().safe().positive() }).strict();
export const evaluationQuerySchema = z.object({ portfolio_id: id.optional(), cursor: z.string().min(1).max(1024).optional(), limit: z.number().int().min(1).max(50).optional(), cycle_id: id.optional(), attempt_cursor: z.string().min(1).max(1024).optional() }).strict()
  .refine(value => value.cycle_id ? !value.cursor && !!value.portfolio_id : !value.attempt_cursor, "INVALID_QUERY_MODE");
