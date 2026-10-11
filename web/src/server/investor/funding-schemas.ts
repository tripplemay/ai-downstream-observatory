import { z } from "zod";

const money = z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/);
const calendarDate = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).refine(value => {
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const date = calendarDate.refine(value => /^(19|20|21)[0-9]{2}-/.test(value));
export function fundingCents(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
export function fundingMoney(value: bigint) {
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}
function anniversary(value: string, years: number) {
  return `${Number(value.slice(0, 4)) + years}${value.slice(4)}`;
}
export const fundingPlanSchema = z.object({
  schema_version: z.literal("investor-funding-plan-v1"), start_date: date,
  horizon_years: z.number().int().min(1).max(10),
  evaluation_timezone: z.enum(["Asia/Shanghai", "Asia/Hong_Kong", "America/New_York"]),
  initial_capital_cny: money, annual_contribution_cny: money, first_annual_date: date.nullable(),
  entry_method: z.enum(["immediate", "three_tranches_60_days"]),
  actual_arrivals_confirmed: z.literal(false), execution_authorized: z.literal(false), live_advice_eligible: z.literal(false),
}).strict().superRefine((plan, context) => {
  const end = anniversary(plan.start_date, plan.horizon_years), initial = fundingCents(plan.initial_capital_cny), annual = fundingCents(plan.annual_contribution_cny);
  const minimum = plan.entry_method === "immediate" ? 1n : 3n;
  if (!calendarDate.safeParse(end).success || initial < minimum || (annual !== 0n && annual < minimum)
    || (annual === 0n) !== (plan.first_annual_date === null)
    || plan.first_annual_date !== null && (plan.first_annual_date < plan.start_date || plan.first_annual_date >= end)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "INVESTOR_FUNDING_INPUT_INVALID" }); return;
  }
  if (plan.first_annual_date !== null) for (let year = 0; year <= 10; year++) {
    const at = anniversary(plan.first_annual_date, year);
    if (at >= end) break;
    if (!calendarDate.safeParse(at).success) context.addIssue({ code: z.ZodIssueCode.custom, message: "INVESTOR_FUNDING_ANNUAL_DATE_INVALID" });
  }
});
export type InvestorFundingPlan = z.infer<typeof fundingPlanSchema>;

export function fundingTimeline(raw: InvestorFundingPlan) {
  const plan = fundingPlanSchema.parse(raw), end = anniversary(plan.start_date, plan.horizon_years);
  const arrivals = [{ lot_id: "initial", arrival_date: plan.start_date, amount_cny: fundingMoney(fundingCents(plan.initial_capital_cny)) }];
  if (plan.first_annual_date !== null) for (let year = 0; year <= 10; year++) {
    const at = anniversary(plan.first_annual_date, year);
    if (at >= end) break;
    arrivals.push({ lot_id: `annual:${at}`, arrival_date: at, amount_cny: fundingMoney(fundingCents(plan.annual_contribution_cny)) });
  }
  const offsets = plan.entry_method === "immediate" ? [0] : [0, 30, 60];
  const lots = arrivals.map(lot => {
    const amount = fundingCents(lot.amount_cny), tranche = amount / BigInt(offsets.length);
    return { ...lot, tranches: offsets.map((offset, index) => {
      const at = new Date(lot.arrival_date + "T00:00:00.000Z"); at.setUTCDate(at.getUTCDate() + offset);
      const release_date = at.toISOString().slice(0, 10);
      return { release_date, amount_cny: fundingMoney(index === offsets.length - 1 ? amount - tranche * BigInt(index) : tranche), within_horizon: release_date < end };
    }) };
  });
  return { horizon_end_exclusive: end, total_planned_principal_cny: fundingMoney(arrivals.reduce((sum, lot) => sum + fundingCents(lot.amount_cny), 0n)), lots };
}

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const record = z.object({ id, version: z.number().int().positive().safe(), profile_id: id, profile_hash: hash,
  content_hash: hash, created_at: z.string().datetime({ precision: 3 }), document: fundingPlanSchema,
  timeline: z.object({ horizon_end_exclusive: calendarDate, total_planned_principal_cny: z.string().regex(/^[0-9]{1,14}\.[0-9]{2}$/),
    lots: z.array(z.object({ lot_id: id, arrival_date: calendarDate, amount_cny: money,
      tranches: z.array(z.object({ release_date: calendarDate, amount_cny: money, within_horizon: z.boolean() }).strict()).min(1).max(3),
    }).strict()).min(1).max(11),
  }).strict(),
}).strict();
export const fundingStateSchema = z.object({ status: z.enum(["not_configured", "planned", "requires_review", "unavailable"]),
  plan: record.nullable(), actual_cash_linked: z.literal(false), execution_authorized: z.literal(false), live_advice_eligible: z.literal(false),
}).strict().refine(value => ["planned", "requires_review"].includes(value.status) === (value.plan !== null));
export type InvestorFundingState = z.infer<typeof fundingStateSchema>;
export function emptyFundingState(status: "not_configured" | "unavailable" = "not_configured"): InvestorFundingState {
  return { status, plan: null, actual_cash_linked: false, execution_authorized: false, live_advice_eligible: false };
}
