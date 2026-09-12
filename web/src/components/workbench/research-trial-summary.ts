import DecimalJs from "decimal.js";
import type { ResearchTrial } from "../../server/research-queries";

const Decimal = DecimalJs.clone({ precision: 60 });
const unavailable = "未提供 / 不可用";
function decimal(value: unknown) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const parsed = new Decimal(value);
  return parsed.isFinite() ? parsed : null;
}
function money(value: unknown) { return decimal(value) ? `${value} CNY` : unavailable; }
function percent(value: unknown) { const number = decimal(value); return number ? `${number.mul(100).toFixed(2)}%` : unavailable; }
function method(trial: ResearchTrial) {
  try {
    const value: unknown = JSON.parse(trial.parameters_json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "研究方法版本未核实";
    const parameters = value as Record<string, unknown>;
    if (trial.plan_schema_version === "research-plan-v1" && !("schema_version" in parameters)
      && ["fixed_split", "repair_underweight"].includes(String(parameters.allocation))) return "v1 · 仅新增资金固定权重配置（不卖出再平衡）";
    if (trial.plan_schema_version === "research-plan-v2") {
      if (parameters.schema_version === "research-rotation-parameters-v1") return "v2 · 月度排名轮动研究";
      if (parameters.schema_version === "research-fixed-rebalance-parameters-v1") return "v2 · 月度固定权重再平衡研究";
    }
  } catch { /* A missing or malformed version must not acquire v2 semantics. */ }
  return "研究方法版本未核实";
}

export function researchTrialSummary(trial: ResearchTrial) {
  const fields: Array<[string, string]> = [
    ["研究初始资金", money(trial.initial_equity_cny)], ["研究追加投入", money(trial.contributions_cny)],
    ["研究期末净资产", money(trial.ending_nav_cny)], ["研究净利润", money(trial.profit_cny)],
    ["研究交易费用", money(trial.fees_cny)], ["研究换汇费用", money(trial.fx_fees_cny)], ["研究滑点成本", money(trial.slippage_cny)],
    ["现金舍入成本（负值为益）", money(trial.cash_rounding_cny)],
    ["期末现金比例", percent(trial.ending_cash_ratio)],
    ["买入换手率", percent(trial.buy_turnover_on_mean_observed_nav)], ["卖出换手率", percent(trial.sell_turnover_on_mean_observed_nav)],
    ["总换手率", percent(trial.total_turnover_on_mean_observed_nav)],
    ["研究收益率", percent(trial.twr)], ["同口径基准", percent(trial.benchmark_twr)], ["收益率差", percent(trial.excess_twr)], ["研究最大回撤", percent(trial.max_drawdown)],
    ["执行跳过 / 过期次数", typeof trial.execution_failure_count === "number" && Number.isSafeInteger(trial.execution_failure_count) && trial.execution_failure_count >= 0 ? String(trial.execution_failure_count) : unavailable],
  ];
  const counts = trial.monthly_evaluation_counts;
  return { method: method(trial), engine: trial.engine_version ?? unavailable, metrics: fields.map(([label, value]) => ({ label, value })),
    monthly: counts ? `月度评估：提出计划 ${counts.proposed} / 无需动作 ${counts.unchanged} / 阻断 ${counts.blocked}` : "月度评估计数：未提供；不视为零次阻断或无需动作。" };
}
