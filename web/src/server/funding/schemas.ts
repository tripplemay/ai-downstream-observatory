import { z } from "zod";
import { amount, exact } from "../ledger/decimal";

export const idSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "INVALID_DATE");
const money = z.string().superRefine((value, context) => {
  try { if (amount(value).lt(0)) context.addIssue({ code: z.ZodIssueCode.custom, message: "NONNEGATIVE_AMOUNT_REQUIRED" }); }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_DECIMAL" }); }
}).transform(value => exact(amount(value)));
const label = z.string().trim().min(1).max(120);
const source = z.object({
  id: idSchema, label, kind: z.enum(["initial", "contribution"]), currency: z.string().regex(/^[A-Z]{3}$/),
  planned_amount: money, period_start: date, period_end: date, expected_arrival_date: date.nullable(),
  account_id: idSchema.nullable(), status: z.enum(["planned", "cancelled"]),
}).strict();
const tranche = z.object({
  id: idSchema, source_id: idSchema, label, planned_amount: money,
  account_id: idSchema.nullable(), invest_by: date.nullable(),
  unspent_action: z.string().trim().min(1).max(1000), status: z.enum(["planned", "cancelled"]),
}).strict();
export const fundingPlanSchema = z.object({
  schema_version: z.literal(2), title: label,
  timezone: z.string().min(1).max(80).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }),
  sources: z.array(source).max(100), tranches: z.array(tranche).max(500),
}).strict();
export const fundingEnvelope = z.object({
  portfolio_id: idSchema, expected_funding_revision: z.number().int().nonnegative().safe(),
  expected_ledger_revision: z.number().int().nonnegative().safe(),
  idempotency_key: z.string().min(1).max(160), reason: z.string().trim().min(1).max(2000),
}).strict();
export const publishSchema = fundingEnvelope.extend({ plan: fundingPlanSchema, acknowledge_shortfall: z.boolean() }).strict();
export const deferSchema = fundingEnvelope.extend({ tranche_id: idSchema, invest_by: date, unspent_action: z.string().trim().min(1).max(1000) }).strict();
export const receiptSchema = fundingEnvelope.extend({ source_id: idSchema, ledger_event_id: idSchema, amount: money }).strict();
export const executionSchema = fundingEnvelope.extend({ tranche_id: idSchema, proposal_item_id: idSchema, expected_resources_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const unlinkSchema = fundingEnvelope.extend({ link_id: idSchema }).strict();
export type FundingPlan = z.infer<typeof fundingPlanSchema>;
export type FundingEnvelope = z.infer<typeof fundingEnvelope>;
export type FundingActor = { id: string; kind: "human" | "ai" | "strategy" | "worker" };
export type FundingOptions = { now?: string };
