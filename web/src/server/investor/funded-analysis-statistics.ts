import { Decimal } from "../ledger/decimal";
import type { FundedAnalysisSeries } from "./funded-analysis-schemas";

type Point = FundedAnalysisSeries["daily"][number];
const decimalText = (value: Decimal) => value.isZero() ? "0" : value.toFixed();
const monthNumber = (period: string) => Number(period.slice(0, 4)) * 12 + Number(period.slice(5)) - 1;

/** Calendar month lags require all intervening observations, not a 365-day approximation. */
export function observedMonthlyRisk(daily: Point[], available: boolean) {
  const byMonth = new Map<string, Point>();
  for (const point of daily) byMonth.set(point.local_date.slice(0, 7), point);
  const monthly = [...byMonth].map(([period, point]) => ({ ...point, period }));
  const byNumber = new Map(monthly.map(row => [monthNumber(row.period), row]));
  const rolling: FundedAnalysisSeries["rolling"] = ([12, 36, 60] as const).map(months => {
    const windows: { from_at: string; to_at: string; return: string }[] = [];
    if (available) for (const end of monthly) {
      const n = monthNumber(end.period), start = byNumber.get(n - months);
      if (!start || !new Decimal(start.unit_nav).gt(0) || Array.from({ length: months + 1 }, (_, index) => n - months + index).some(key => !byNumber.has(key))) continue;
      windows.push({ from_at: start.at, to_at: end.at, return: decimalText(new Decimal(end.unit_nav).div(start.unit_nav).minus(1)) });
    }
    let worst: typeof windows[number] | null = null, best: typeof windows[number] | null = null;
    for (const window of windows) {
      if (!worst || new Decimal(window.return).lt(worst.return)) worst = window;
      if (!best || new Decimal(window.return).gt(best.return)) best = window;
    }
    const negative = windows.filter(row => new Decimal(row.return).lt(0)).length;
    return { months, status: windows.length ? "computed" : "insufficient_history", window_count: windows.length,
      negative_count: negative, negative_fraction: windows.length ? decimalText(new Decimal(negative).div(windows.length)) : null, worst, best };
  });
  return { monthly, rolling };
}
