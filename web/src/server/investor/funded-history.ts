import { hash } from "../ledger/service";
import { Decimal } from "../ledger/decimal";
import { fundingPlanSchema, fundingTimeline, type InvestorFundingPlan } from "./funding-schemas";
import { validateFundedHistoryDocument } from "./kernel-contracts";

type ObjectValue = Record<string, unknown>;
export type FundedHistoryInput = {
  schema_version: "investor-funded-history-input-v1" | "investor-funded-history-input-v2" | "investor-funded-history-input-v3"; funding_plan: InvestorFundingPlan; historical_start_date: string;
  dataset: ObjectValue; context: { parameters_recorded_at: string; comparison_declared_at: string; information_cutoff_at: string;
    parameters: ObjectValue; decision_times: string[]; execution: ObjectValue; tax_coverage: string };
};
function invalid(): never { throw new Error("INVESTOR_FUNDED_HISTORY_INVALID"); }
function requireTrue(value: unknown): asserts value { if (!value) invalid(); }
function micros(text: string) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(text);
  requireTrue(match);
  const ms = Date.parse(match[1] + "Z");
  requireTrue(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === match[1]);
  return BigInt(ms) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
function stamp(ms: number) { return new Date(ms).toISOString().replace(/Z$/, "000Z"); }
function midnight(text: string, timezone: string) {
  const utc = Date.parse(text + "T00:00:00.000Z");
  requireTrue(Number.isFinite(utc) && new Date(utc).toISOString().slice(0, 10) === text);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = (at: number) => Object.fromEntries(formatter.formatToParts(at).filter(row => row.type !== "literal").map(row => [row.type, Number(row.value)]));
  const offsets = new Set<number>();
  for (const hours of [-48, -24, 0, 24, 48]) {
    const at = utc + hours * 3600000, p = parts(at);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at);
  }
  const candidates = [...offsets].map(offset => utc - offset).filter(at => {
    const p = parts(at); return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}` === text
      && p.hour === 0 && p.minute === 0 && p.second === 0;
  });
  requireTrue(candidates.length === 1);
  return candidates[0];
}

export function fundingHistoryProjection(raw: FundedHistoryInput) {
  validateFundedHistoryDocument("input", raw);
  const funding = fundingPlanSchema.parse(raw.funding_plan), original = fundingTimeline(funding), anchor = raw.historical_start_date;
  requireTrue(anchor.slice(4) === funding.start_date.slice(4));
  const translation_years = Number(anchor.slice(0, 4)) - Number(funding.start_date.slice(0, 4));
  const translated = (text: string) => `${Number(text.slice(0, 4)) + translation_years}${text.slice(4)}`;
  const timeline = fundingTimeline({ ...funding, start_date: anchor, entry_method: "three_tranches_60_days",
    first_annual_date: funding.first_annual_date === null ? null : translated(funding.first_annual_date) });
  requireTrue(timeline.lots.length === original.lots.length && timeline.total_planned_principal_cny === original.total_planned_principal_cny);
  const projection = { schema_version: "investor-funding-history-projection-v1", funding_plan_hash: hash(funding), historical_start_date: anchor,
    translation_years, window: { start: stamp(midnight(anchor, funding.evaluation_timezone)),
      end: stamp(midnight(timeline.horizon_end_exclusive, funding.evaluation_timezone) - 1) },
    evaluation_timezone: funding.evaluation_timezone, preferred_path: funding.entry_method === "immediate" ? "immediate" : "staged",
    total_assumed_principal_cny: timeline.total_planned_principal_cny,
    lots: timeline.lots.map((historical, index) => {
      const planned = original.lots[index];
      requireTrue(translated(planned.arrival_date) === historical.arrival_date && planned.amount_cny === historical.amount_cny);
      return { lot_id: planned.lot_id, planned_arrival_date: planned.arrival_date, historical_arrival_date: historical.arrival_date,
        arrival_at: stamp(midnight(historical.arrival_date, funding.evaluation_timezone)), amount_cny: historical.amount_cny,
        staged_releases: historical.tranches.map(row => ({ at: stamp(midnight(row.release_date, funding.evaluation_timezone)),
          amount_cny: row.amount_cny, within_window: row.within_horizon })) };
    }) };
  validateFundedHistoryDocument("projection", projection);
  return projection;
}

export function prepareFundedHistory(raw: FundedHistoryInput) {
  const projection = fundingHistoryProjection(raw), context = raw.context;
  const bounded = raw.schema_version === "investor-funded-history-input-v2";
  const eventReview = raw.schema_version === "investor-funded-history-input-v3";
  requireTrue(new Decimal(context.execution.cash_quantum as string).eq("0.01"));
  const cutoff = micros(context.information_cutoff_at), start = micros(projection.window.start), end = micros(projection.window.end);
  requireTrue(micros(context.parameters_recorded_at) <= micros(context.comparison_declared_at)
    && micros(context.comparison_declared_at) <= cutoff && end <= cutoff);
  let previous: bigint | null = null;
  for (const at of context.decision_times.map(micros)) {
    requireTrue(start <= at && at < end && (previous === null || previous < at)); previous = at;
  }
  const rows = (key: string) => raw.dataset[key] as ObjectValue[];
  for (const row of rows("observations")) {
    const available = row.published_at ?? row.assumed_available_at;
    requireTrue(typeof available === "string" && micros(available) <= cutoff && micros(row.ingested_at as string) <= cutoff);
  }
  for (const row of rows("sessions")) requireTrue(micros(row.available_at as string) <= cutoff);
  for (const key of ["actions", "settlements"]) for (const row of rows(key)) {
    requireTrue(micros(row.published_at as string) <= cutoff);
    if (row.ingested_at !== undefined) requireTrue(micros(row.ingested_at as string) <= cutoff);
  }
  const intervals: [bigint, bigint][] = [];
  for (const [close, available] of rows("sessions").map(row => [micros(row.close_at as string), micros(row.available_at as string)] as const)
    .filter(([close, available]) => close < available).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
    const last = intervals.at(-1);
    if (last && close <= last[1]) last[1] = available > last[1] ? available : last[1]; else intervals.push([close, available]);
  }
  let slot = 0;
  for (const at of context.decision_times.map(micros)) {
    while (slot < intervals.length && intervals[slot][1] <= at) slot++;
    requireTrue(slot === intervals.length || at < intervals[slot][0]);
  }
  const input = { schema_version: eventReview ? "investor-long-horizon-input-v4" : bounded ? "investor-long-horizon-input-v3" : "investor-long-horizon-input-v2", dataset: raw.dataset,
    plan: { schema_version: eventReview ? "investor-long-horizon-plan-v4" : bounded ? "investor-long-horizon-plan-v3" : "investor-long-horizon-plan-v2", study_basis: "retrospective_exploratory", ...context,
      window: projection.window, evaluation_timezone: projection.evaluation_timezone, initial_capital_cny: projection.lots[0].amount_cny,
      contributions: projection.lots.slice(1).map(lot => ({ at: lot.arrival_at, amount_cny: lot.amount_cny })),
      funding_policy: { method: "equal_tranches_on_frozen_local_day_offsets", initial_offsets_days: [0, 30, 60], contribution_offsets_days: [0, 30, 60] } } };
  validateFundedHistoryDocument("continuous_input", input);
  return { projection, input };
}

/** Binding/calendar/principal checks only; NOT independent economic replay or publication eligibility. */
export function verifyFundedHistoryBinding(raw: FundedHistoryInput, result: ObjectValue) {
  validateFundedHistoryDocument("result", result);
  const { projection, input } = prepareFundedHistory(raw);
  requireTrue(result.schema_version === (raw.schema_version === "investor-funded-history-input-v3" ? "investor-funded-history-result-v3" : raw.schema_version === "investor-funded-history-input-v2"
    ? "investor-funded-history-result-v2" : "investor-funded-history-result-v1"));
  const sealed = (object: ObjectValue) => { const { result_hash, ...body } = object; requireTrue(hash(body) === result_hash); };
  sealed(result);
  requireTrue(result.input_hash === hash(raw) && hash(result.projection) === hash(projection));
  const comparison = result.comparison as ObjectValue; sealed(comparison);
  requireTrue(comparison.input_hash === hash(input) && comparison.dataset_hash === hash(raw.dataset)
    && comparison.plan_hash === hash(input.plan) && comparison.parameters_hash === hash(raw.context.parameters)
    && comparison.evaluation_timezone === projection.evaluation_timezone && comparison.data_mode === raw.dataset.mode
    && hash(comparison.window) === hash(projection.window));
  for (const key of ["parameters_recorded_at", "comparison_declared_at", "information_cutoff_at"] as const)
    requireTrue(comparison[key] === raw.context[key]);
  const numeric = (text: string) => new Decimal(text).toFixed();
  const initial = projection.lots.filter(lot => lot.arrival_at === projection.window.start).reduce((sum, lot) => sum.plus(lot.amount_cny), new Decimal(0));
  const principal = new Decimal(projection.total_assumed_principal_cny);
  for (const name of ["immediate", "staged"]) {
    const run = (comparison.runs as Record<string, ObjectValue>)[name];
    requireTrue(initial.eq(run.initial_equity_cny as string) && principal.minus(initial).eq(run.contributions_cny as string)
      && principal.eq(run.principal_cny as string) && new Decimal(run.ending_nav_cny as string).minus(principal).eq(run.profit_cny as string));
    const expected = projection.lots.map((lot, index) => ({ lot_id: index === 0 ? "initial" : `contribution:${String(index).padStart(4, "0")}`,
      arrival_at: lot.arrival_at, amount_cny: numeric(lot.amount_cny), tranches: name === "staged"
        ? lot.staged_releases.map(row => ({ ...row, amount_cny: numeric(row.amount_cny) }))
        : [{ at: lot.arrival_at, amount_cny: numeric(lot.amount_cny), within_window: true }] }));
    requireTrue(hash(run.funding_schedule) === hash(expected));
  }
  return { input_hash: result.input_hash as string, projection_hash: hash(projection), comparison_hash: comparison.result_hash as string,
    economics_independently_replayed: false as const, publication_eligible: false as const };
}
