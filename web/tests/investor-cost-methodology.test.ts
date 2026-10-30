import assert from "node:assert/strict";
import test from "node:test";
import { actionCostMethodology, reviewCostMethodology, settlementCostMethodology, splitResearchCostMethodology } from "../src/server/investor/reference-cost-methodology";

test("only recognized trailing execution methodology folds, never costs, buffers or unknown text", () => {
  const summary = "Fictional fee 12.37 CNY; slippage 5 bps; price buffer 2%; FX buffer 1%.";
  for (const methodology of [actionCostMethodology, actionCostMethodology + reviewCostMethodology,
    actionCostMethodology + reviewCostMethodology + settlementCostMethodology, settlementCostMethodology]) {
    const value = summary + methodology, parts = splitResearchCostMethodology(value);
    assert.deepEqual(parts, { summary, methodology });
    assert.equal(parts.summary + parts.methodology, value);
  }
  for (const value of [summary, summary + actionCostMethodology + " Additional tax 3 CNY.",
    actionCostMethodology, "", summary + actionCostMethodology.replace("整批", "未知规则")])
    assert.deepEqual(splitResearchCostMethodology(value), { summary: value, methodology: null });
});

test("shared method prose preserves the original canonical reference bytes", () => {
  assert.equal(actionCostMethodology, "已知公司行动落在决策与预定成交之间时，整批暂不建单，等下一预定评估重新计算；等待仍承担现金机会成本，未知行动仍可取消已建订单。");
  assert.equal(reviewCostMethodology, "新行动取消尚未成交的整批订单后，仅在预定时点以新价格重新评估并保留替代链；原始取消仍展示，未解决复核或其他执行失败阻止准入。");
  assert.equal(settlementCostMethodology, "卖出时只登记尚未冻结的买入意图；完整交收后，在预定决策点按当时现金和目标冻结新买单。未完成或失败意图阻止准入，不重复计入预计卖款。");
});
