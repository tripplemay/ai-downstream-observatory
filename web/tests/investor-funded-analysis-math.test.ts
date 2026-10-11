import assert from "node:assert/strict";
import test from "node:test";
import { Decimal } from "../src/server/ledger/decimal";
import { analyzeFundedTrace } from "../src/server/investor/funded-analysis-math";
import { observedMonthlyRisk } from "../src/server/investor/funded-analysis-statistics";
import { fundedAnalysisPointSchema } from "../src/server/investor/funded-analysis-schemas";
import { continuousPerformance } from "../src/server/investor/continuous-performance";
import { economicInstant } from "../src/server/investor/continuous-market";
import type { runContinuousEconomics } from "../src/server/investor/continuous-economics";

type Trace = ReturnType<typeof runContinuousEconomics>;
function trace(values: [string, string, string?][], zone = "UTC") {
  const curve = values.map(([at, unit, principal = "100"]) => ({ at, unit_nav: unit, principal_cny: principal, nav_cny: new Decimal(unit).times(principal).toFixed(),
    profit_cny: new Decimal(unit).minus(1).times(principal).toFixed(), cash_cny: "0", locked_cash_cny: "0" }));
  const last = curve.at(-1)!;
  return { curve, ...continuousPerformance(economicInstant(curve[0].at), economicInstant(last.at), new Decimal(curve[0].nav_cny), new Decimal(last.nav_cny), [], curve, zone),
    ending_nav_cny: last.nav_cny, profit_cny: last.profit_cny, fees_cny: "0", fx_fees_cny: "0", slippage_cny: "0", cash_rounding_cny: "0",
    ending_cash_ratio: "0", execution_failure_count: 0 } as unknown as Trace;
}
test("intraday trough is preserved in risk even when daily close recovers, and latest equal peak is used", () => {
  const result = analyzeFundedTrace(trace([["2024-01-01T00:00:00Z", "1"], ["2024-01-02T01:00:00Z", "1"], ["2024-01-02T02:00:00Z", "0.5"],
    ["2024-01-02T03:00:00Z", "1"], ["2024-01-03T00:00:00Z", "1"]]), "UTC");
  assert.equal(result.daily.length, 3); assert.equal(result.full_observation_count, 5);
  assert.ok(result.daily.every(row => row.drawdown === "0")); assert.equal(result.risk.max_drawdown, "-0.5");
  assert.equal(result.risk.peak_at, "2024-01-02T01:00:00Z"); assert.equal(result.risk.trough_at, "2024-01-02T02:00:00Z");
  assert.equal(result.risk.recovered_at, "2024-01-02T03:00:00Z"); assert.equal(result.risk.recovery_days, 0);
  assert.equal(result.risk.longest_underwater?.duration_days, 0);
});
test("longest underwater interval is not necessarily the worst trough recovery, and can remain ongoing", () => {
  const result = analyzeFundedTrace(trace([["2024-01-01T00:00:00Z", "1"], ["2024-01-02T00:00:00Z", "0.5"], ["2024-01-03T00:00:00Z", "1"],
    ["2024-01-04T00:00:00Z", "0.8"], ["2024-01-10T00:00:00Z", "0.9"]]), "UTC");
  assert.equal(result.risk.recovery_days, 1); assert.equal(result.risk.longest_underwater?.duration_days, 7);
  assert.equal(result.risk.longest_underwater?.ongoing, true); assert.equal(result.risk.longest_underwater?.recovered_at, null);
});
test("new principal does not erase unit drawdown and cash is not invented by chart compression", () => {
  const result = analyzeFundedTrace(trace([["2024-01-01T00:00:00Z", "1"], ["2024-01-02T00:00:00Z", "0.5", "300"], ["2024-01-03T00:00:00Z", "0.5", "300"]]), "UTC");
  assert.equal(result.daily[1].nav_cny, "150"); assert.equal(result.daily[1].principal_cny, "300"); assert.equal(result.daily[1].profit_cny, "-150");
  assert.equal(result.risk.max_drawdown, "-0.5"); assert.equal(result.risk.recovered_at, null);
  const corrupted = trace([["2024-01-01T00:00:00Z", "1"], ["2024-01-02T00:00:00Z", "1"]]);
  corrupted.curve[1].locked_cash_cny = "1"; assert.throws(() => analyzeFundedTrace(corrupted, "UTC"), /ACCOUNTING_INVALID/);
});
test("recovery days follow local calendar across DST, rather than rounded elapsed hours", () => {
  const zone = "America/New_York";
  const result = analyzeFundedTrace(trace([["2024-03-09T17:00:00Z", "1"], ["2024-03-10T16:00:00Z", "0.5"], ["2024-03-11T16:00:00Z", "1"]], zone), zone);
  assert.equal(result.risk.recovery_days, 1); assert.equal(result.risk.longest_underwater?.duration_days, 2);
  assert.deepEqual(result.daily.map(row => row.local_date), ["2024-03-09", "2024-03-10", "2024-03-11"]);
});
test("rolling losses use complete month-key lags and overlapping sample counts, not probabilities or missing-month repairs", () => {
  const values: [string, string][] = Array.from({ length: 14 }, (_, i) => {
    const date = new Date(Date.UTC(2023, i + 1, 0, 12)); return [date.toISOString(), i < 12 ? "1" : i === 12 ? "0.5" : "1.25"];
  });
  const result = analyzeFundedTrace(trace(values), "UTC"), rolling = result.rolling[0];
  assert.equal(rolling.window_count, 2); assert.equal(rolling.negative_count, 1); assert.equal(rolling.negative_fraction, "0.5");
  assert.equal(rolling.worst?.return, "-0.5"); assert.equal(rolling.best?.return, "0.25");
  assert.equal(rolling.worst?.from_at, "2023-01-31T12:00:00.000Z"); assert.equal(rolling.worst?.to_at, "2024-01-31T12:00:00.000Z");
  assert.equal(observedMonthlyRisk(result.daily.filter(row => row.local_date.slice(0, 7) !== "2023-06"), true).rolling[0].window_count, 0);
  assert.ok(observedMonthlyRisk(result.daily, false).rolling.every(row => row.status === "insufficient_history"));
  const leap = analyzeFundedTrace(trace([["2024-02-28T00:00:00Z", "1"], ["2024-02-29T00:00:00Z", "0.5"], ["2024-03-01T00:00:00Z", "1"]]), "UTC");
  assert.equal(leap.monthly[0].local_date, "2024-02-29"); assert.equal(leap.risk.longest_underwater?.duration_days, 2);
});
test("invalid calendar timestamps, reversed observations and incorrect claimed recovery fail closed", () => {
  const valid = analyzeFundedTrace(trace([["2024-01-01T00:00:00Z", "1"], ["2024-01-02T00:00:00Z", "1"]]), "UTC").daily[0];
  assert.equal(fundedAnalysisPointSchema.safeParse({ ...valid, at: "2024-02-30T00:00:00Z" }).success, false);
  assert.equal(fundedAnalysisPointSchema.safeParse({ ...valid, local_date: "2024-02-30" }).success, false);
  const reversed = trace([["2024-01-01T00:00:00Z", "1"], ["2024-01-02T00:00:00Z", "1"]]);
  reversed.curve.reverse(); assert.throws(() => analyzeFundedTrace(reversed, "UTC"), /CHRONOLOGY_INVALID/);
  const wrong = trace([["2024-01-01T00:00:00Z", "1"], ["2024-01-02T00:00:00Z", "0.5"]]);
  wrong.recovered_at = "2024-01-02T01:00:00Z"; assert.throws(() => analyzeFundedTrace(wrong, "UTC"), /RECOVERY_INVALID/);
});
