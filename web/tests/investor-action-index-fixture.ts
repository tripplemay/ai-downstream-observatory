import { Decimal } from "../src/server/ledger/decimal";
import type { ContinuousDataset } from "../src/server/investor/continuous-market";
import type { ContinuousPlan } from "../src/server/investor/continuous-economics";

export function actionIndexFixture(version = 3, days = 90) {
  const start = Date.parse("2016-01-01T00:00:00Z"), stamp = (day: number, hour = 6, minute = 0) =>
    new Date(start + day * 86400000 + hour * 3600000 + minute * 60000).toISOString().replace(".000Z", "Z");
  const data: ContinuousDataset = { schema_version: "research-dataset-v2", mode: "synthetic", historical_archive_verified: false,
    corporate_actions_complete: true, assets: ["ALPHA", "BETA"].map(name => ({ listing_id: `CN:${name}`, market: "CN", currency: "CNY",
      quantity_step: "1", tradable_from: stamp(-1, 0) })), observations: [], sessions: [], settlements: [], actions: [] };
  for (let day = 0; day < days; day++) {
    const date = stamp(day).slice(0, 10), close = stamp(day), available = stamp(day, 6, 1);
    data.sessions.push({ market: "CN", session_date: date, close_at: close, available_at: available, trade_allowed: true });
    data.settlements.push({ market: "CN", session_date: date, settled_at: stamp(day, 7), published_at: stamp(day, 5), source_evidence: "fictional-settlement" });
    for (const [offset, asset] of data.assets.entries()) data.observations.push({ id: `quote:${asset.listing_id}:${day}`,
      listing_id: asset.listing_id, source_id: "fictional", series_key: asset.listing_id, metric: "close", value: String(10 + offset), unit: "CNY",
      observed_at: close, published_at: available, ingested_at: available, price_basis: "unadjusted", revision_id: "fictional",
      time_precision: "second", provenance: "reconstructed" });
    if (day > 1 && day % 7 === 0) for (const asset of data.assets) data.actions.unshift({ id: `dividend:${asset.listing_id}:${day}`,
      listing_id: asset.listing_id, type: "dividend", at: close, published_at: stamp(day - 1, 5), gross_per_unit: "0.1",
      tax_per_unit: "0.02", pay_at: stamp(day + 1), source_evidence: "fictional-action" });
  }
  data.actions.push({ id: "split:alpha", listing_id: "CN:ALPHA", type: "split", at: stamp(21), published_at: stamp(20, 5),
    ratio: "2", source_evidence: "fictional-split-before-same-time-dividend" });
  const plan: ContinuousPlan = { schema_version: `bounded-research-window-v${version}`, window: { start: stamp(0, 0), end: stamp(days - 1, 23, 59) },
    evaluation_timezone: "Asia/Shanghai", initial_capital_cny: "1000", contributions: [{ at: stamp(40, 6, 1), amount_cny: "100" }],
    decision_times: data.sessions.map(row => row.available_at), parameters: { schema_version: "research-fixed-rebalance-parameters-v2",
      weights: { "CN:ALPHA": "0.6", "CN:BETA": "0.4" }, roles: { "CN:ALPHA": "growth", "CN:BETA": "defensive" },
      rebalance: "first_decision_each_year", tolerance: { absolute_cny: "0.01", weight: "0.001" }, class_drift_threshold: "0.05",
      minimum_days_between_rebalances: 7, contribution_mode: "repair_underweight_without_sales", order_expiry: "next_month_boundary" },
    execution: { model: "next_session_close_bounded_fixed_quantity", settlement_model: "explicit_market_calendar",
      sale_proceeds: "convert_to_cny_at_fill_then_settle", max_fx_age_seconds: 172800, slippage_bps: "5", minimum_fee_cny: "0.01",
      commission_bps: "1", fx_bps: "0", cash_quantum: "0.01", buy_price_buffer_bps: "200", buy_fx_buffer_bps: "100",
      ...(version > 1 ? { order_action_policy: version > 2 ? "defer_known_else_cancel_batch_and_reassess" : "defer_known_scheduled_action_before_commit" } : {}),
      ...(version === 4 ? { buy_funding_policy: "declare_sales_then_freeze_buy_from_settled_cash" } : {}) }, tax_coverage: "fictional-known" };
  return { data, plan, releases: new Map<bigint, Decimal>() };
}
