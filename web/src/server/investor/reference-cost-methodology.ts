export const actionCostMethodology = "已知公司行动落在决策与预定成交之间时，整批暂不建单，等下一预定评估重新计算；等待仍承担现金机会成本，未知行动仍可取消已建订单。";
export const reviewCostMethodology = "新行动取消尚未成交的整批订单后，仅在预定时点以新价格重新评估并保留替代链；原始取消仍展示，未解决复核或其他执行失败阻止准入。";
export const settlementCostMethodology = "卖出时只登记尚未冻结的买入意图；完整交收后，在预定决策点按当时现金和目标冻结新买单。未完成或失败意图阻止准入，不重复计入预计卖款。";

export function splitResearchCostMethodology(value: string) {
  let summary = value;
  const methods: string[] = [];
  // Only exact known methodology suffixes fold; amounts and unknown prose stay visible.
  for (const method of [settlementCostMethodology, reviewCostMethodology, actionCostMethodology]) {
    if (summary.endsWith(method)) { summary = summary.slice(0, -method.length); methods.unshift(method); }
  }
  return summary ? { summary, methodology: methods.join("") || null } : { summary: value, methodology: null };
}
