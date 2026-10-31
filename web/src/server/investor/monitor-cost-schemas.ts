import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ precision: 3 });
const decimalPattern = /^(0|[1-9][0-9]{0,37})(\.[0-9]{1,18})?$/;
const decimal = z.string().regex(decimalPattern).refine(value => value.replace(".", "").length <= 38);
function scaled(value: string) { if (!decimalPattern.test(value)) return null; const [whole, fraction = ""] = value.split("."); return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0")); }
const bps = decimal.refine(value => { const n = scaled(value); return n !== null && n < 10000n * 10n ** 18n; });
export const monitorCostValuesSchema = z.object({ commission_bps: bps, minimum_fee_cny: decimal, fx_bps: bps,
  slippage_bps: bps, maximum_cost_fraction: decimal.refine(value => { const n = scaled(value); return n !== null && n <= 10n ** 18n; }) }).strict();
export const monitorCostsIntentSchema = z.object({ action: z.literal("set_monitor_costs"), model_id: id, model_hash: hash,
  expected_cost_version: z.number().int().nonnegative().max(1000), costs: monitorCostValuesSchema.nullable(),
  validity_days: z.number().int().min(1).max(365).nullable(), acknowledged_research_only: z.literal(true),
}).strict();
export const monitorCostStateSchema = z.object({ model_id: id, model_hash: hash,
  status: z.enum(["unknown", "known", "expired", "pending", "unavailable"]), version: z.number().int().nonnegative().max(1000),
  costs: monitorCostValuesSchema.extend({ assumption_hash: hash }).nullable(),
  effective_from: instant.nullable(), valid_until: instant.nullable(), model_valid_until: instant,
  input_applied: z.boolean(), editable: z.boolean(), basis: z.literal("owner_research_assumptions_not_verified_broker_tariff"), trading_permission: z.literal(false),
}).strict().refine(value => (value.version === 0) === (value.effective_from === null)
  && (value.costs === null) === (value.valid_until === null)
  && (value.status !== "known" || value.costs !== null && value.input_applied));
export type MonitorCostValues = z.infer<typeof monitorCostValuesSchema>;
export type MonitorCostState = z.infer<typeof monitorCostStateSchema>;
