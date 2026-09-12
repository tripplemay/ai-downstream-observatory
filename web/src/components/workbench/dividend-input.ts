import type { Fact } from "@/server/ledger/engine";

export const DIVIDEND_ACTIONS = {
  dividend_accrual: "确认应收分红（税额可未知或暂估）",
  dividend: "税前金额与最终扣税均已确认的到账",
  dividend_net: "只知道实际到账净额",
  dividend_payment: "应收分红到账 / 退税到账",
  dividend_breakdown: "补充净额的税前与扣税拆分（不动现金）",
  dividend_tax_assessment: "更新累计扣税 / 最终确认（不动现金）",
  dividend_tax_payment: "实际补扣税款（减少现金）",
  corporate_action_notice: "登记待核实公司行动（不改金额或数量）",
  corporate_action_resolution: "确认公司行动已核实处理（不改金额或数量）",
} as const;
export type DividendAction = keyof typeof DIVIDEND_ACTIONS;
export function dividendInput(data: FormData, type: DividendAction, accountId: string) {
  const value = (key: string) => String(data.get(key) ?? "").trim();
  const fact: Fact = { type, account_id: accountId, currency: value("currency") };
  if (["dividend_accrual", "dividend", "dividend_net", "corporate_action_notice"].includes(type) && value("listing_id")) fact.listing_id = value("listing_id");
  if (["dividend_accrual", "dividend", "dividend_net", "dividend_payment", "dividend_tax_payment"].includes(type)) fact.amount = value("amount");
  if (["dividend_payment", "dividend_breakdown", "dividend_tax_assessment", "dividend_tax_payment", "corporate_action_resolution"].includes(type)) fact.related_event_id = value("related_event_id");
  if (["dividend_accrual", "dividend", "dividend_tax_assessment"].includes(type)) {
    const status = type === "dividend" ? "confirmed" : value("tax_status");
    if (!["unknown", "estimated", "confirmed"].includes(status) || (type === "dividend_tax_assessment" && status === "unknown")) throw new Error("请明确选择扣税确认状态。");
    fact.tax_status = status as Fact["tax_status"];
    if (status !== "unknown") fact.tax = value("tax");
  }
  if (type === "dividend_net") {
    if (!["final", "provisional"].includes(value("net_status"))) throw new Error("请明确选择净额是否最终确认。");
    fact.net_status = value("net_status") as Fact["net_status"];
  }
  if (type === "dividend_breakdown") { fact.gross_amount = value("gross_amount"); fact.tax = value("tax"); }
  if (["dividend_breakdown", "dividend_tax_assessment", "dividend_tax_payment", "corporate_action_notice", "corporate_action_resolution"].includes(type)) fact.evidence_reference = value("evidence_reference");
  if (type === "corporate_action_notice") fact.action_kind = value("action_kind") as Fact["action_kind"];
  if (type === "corporate_action_resolution") {
    fact.resolution = value("resolution") as Fact["resolution"];
    fact.supporting_event_ids = value("supporting_event_ids") ? value("supporting_event_ids").split(/\s+/) : [];
  }
  return { source_id: value("source_id"), source_event_id: value("source_event_id"), effective_at: value("effective_at"), time_precision: value("time_precision"), source_timezone: value("source_timezone"), reason: value("reason"), fact };
}
