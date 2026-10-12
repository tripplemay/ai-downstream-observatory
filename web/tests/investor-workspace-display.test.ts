import assert from "node:assert/strict";
import test from "node:test";
import * as research from "../src/components/workbench/research-format";
import * as client from "../src/components/workbench/investor-client";
import * as schemas from "../src/server/investor/schemas";
import * as losses from "../src/server/investor/loss-scenarios";
import { acquisitionDeadlines } from "../src/components/workbench/investor-acquisition";
import { mountInvestorDisplay } from "./investor-display-fixture";
import { displayBinding as binding, displayBefore, displayUntil, displayFuture, displayState } from "./investor-display-state-fixture";

const before = Date.parse(displayBefore), until = Date.parse(displayUntil);
function mount(t: { after: (fn: () => void) => void }, state = displayState(), view = "overview") {
  const h = mountInvestorDisplay(t, new URL("../src/components/workbench/investor-workspace.tsx", import.meta.url), "InvestorWorkspace",
    { initial: state, initialSessionBinding: binding, view }, { "next/link": { default: "Link", __esModule: true },
      "lucide-react": Object.fromEntries(["ArrowRight", "CheckCircle2", "CircleHelp", "Clock3", "Eye", "ShieldCheck"].map(name => [name, name])),
      "@/components/ui/input": { Input: "Input" }, "@/components/session-boundary": { useSessionBoundary: () => null },
      "@/server/investor/schemas": schemas, "@/server/investor/loss-scenarios": losses, "./research-format": research, "./investor-client": client,
      ...Object.fromEntries(["account-workspace", "funding-panel", "funded-comparison-panel", "risk-panel", "ai-panel", "notifications-panel"]
        .map(name => { const component = "Investor" + name.split("-").map(value => value[0].toUpperCase() + value.slice(1)).join("");
          return ["./investor-" + name, { [component]: component }]; })),
      "./investor-acquisition": { acquisitionDeadlines, InvestorAcquisitionPanel: "InvestorAcquisitionPanel" },
    }, before);
  return { ...h, state,
    fundingLock: async (value: boolean) => { (h.node("InvestorFundingPanel")!.props.onEditingChange as (value: boolean) => void)(value); await h.flush(); },
    card: (title: string) => h.nodes().find(node => node.type === "section" && h.words(node).startsWith(title)),
    headline: () => h.nodes().filter(node => node.type === "h2").map(node => h.words(node)).find(text => ["继续观察", "需要你做决定", "证据不足"].includes(text)),
  };
}

test("actual workspace invalidates the current headline, card, actions and AI at review expiry while reads are locked; history stays visible", async t => {
  const h = mount(t); await h.flush(); assert.equal(h.headline(), "需要你做决定"); assert.ok(h.button("采纳思路"));
  const oldClick = h.button("采纳思路")!.props.onClick as () => void;
  await h.fundingLock(true); await h.advance(until);
  assert.equal(h.headline(), "证据不足"); assert.equal(h.card("变化卡 · 决定由你作出"), undefined);
  assert.equal(h.button("采纳思路"), undefined); assert.equal(h.node("InvestorAiPanel")!.props.disabled, true);
  assert.match(h.words(h.card("下一次复核")), /已知期限已到/);
  assert.match(h.words(h.card("最近观察")), /需要你做决定/); assert.match(h.words(h.card("最近观察")), /Synthetic test observation only/);
  assert.equal(h.requests.length, 0); await h.advance(before, 1000); await h.wake(); assert.equal(h.headline(), "证据不足");
  await h.fundingLock(false); oldClick(); await h.flush(); assert.equal(h.requests.length, 0); assert.match(h.text(), /这条观察已失效/);
  assert.equal(h.button("刷新状态")!.props.disabled, false); assert.equal(h.button("重新检查研究条件")!.props.disabled, false);
});
test("plan expiry applies to observe and decision modes without a successful GET; expired synthetic references cannot be saved", async t => {
  for (const outcome of ["observe", "decision_required"] as const) {
    const h = mount(t, displayState(outcome, "plan")); await h.flush(); await h.fundingLock(true);
    await h.advance(until); assert.equal(h.headline(), "证据不足"); assert.equal(h.button("采纳思路"), undefined);
    assert.equal(h.node("InvestorAiPanel")!.props.disabled, true); assert.match(h.words(h.card("研究组合与历史参考")), /历史方案，不能用于当前行动/);
    await h.fundingLock(false); assert.equal(h.button("保存为观察中的研究方案")!.props.disabled, true);
    assert.equal(h.requests.length, 0); assert.match(h.words(h.card("最近观察")), new RegExp(outcome === "observe" ? "继续观察" : "需要你做决定")); h.close();
  }
});
test("watch expiry hides NAV and invalidates the same main conclusion; pre-expiry rollback does not delay the boundary", async t => {
  const h = mount(t, displayState("observe", "watch")); await h.flush(); assert.equal(h.headline(), "继续观察");
  assert.match(h.words(h.card("持续观察")), /12,345.67/); await h.fundingLock(true);
  await h.advance(before - 10000, 1000); assert.equal(h.headline(), "证据不足");
  assert.match(h.words(h.card("持续观察")), /复核已到期/); assert.doesNotMatch(h.words(h.card("持续观察")), /12,345.67/);
  assert.equal(h.node("InvestorAiPanel")!.props.disabled, true); assert.equal(h.requests.length, 0);
});
test("failed manual refresh cannot revive expired advice; a newer strictly parsed server observation can restore current display, using only GET", async t => {
  const h = mount(t); await h.flush(); await h.advance(until); await h.click("刷新状态"); assert.equal(h.requests[0].method, "GET");
  await h.fail(0); assert.equal(h.headline(), "证据不足"); assert.equal(h.button("采纳思路"), undefined);
  const next = { ...h.state.latest!, id: "fictional-current-observation", content_hash: "b".repeat(64), document: { ...h.state.latest!.document,
    outcome: "observe" as const, evaluated_at: displayUntil, next_review_at: displayFuture, reasons: ["Fictional newer verified observation"] } };
  const state = { ...h.state, checked_at: displayUntil, latest: next, observations: [next, ...h.state.observations], effective_outcome: "observe" as const };
  client.parseInvestorState({ ...state, session_binding: binding }, binding);
  await h.click("刷新状态"); await h.reply(1, { ...state, session_binding: binding });
  assert.equal(h.headline(), "继续观察"); assert.equal(h.node("InvestorAiPanel")!.props.disabled, false);
  assert.match(h.words(h.card("最近观察")), /需要你做决定/); assert.equal(h.requests.every(row => row.method === "GET"), true);
});
test("observation-only navigation remains historical after expiry, and session invalidation still clears every record and subscription", async t => {
  const h = mount(t, displayState(), "observations"); await h.flush(); await h.advance(until);
  assert.equal(h.headline(), undefined); assert.match(h.words(h.card("每次观察与人工决定")), /需要你做决定/); assert.equal(h.node("InvestorAiPanel"), undefined);
  await h.invalidate(); assert.doesNotMatch(h.text(), /Synthetic test observation only/); assert.equal(h.requests.length, 0);
  h.close(); assert.equal([...h.windowListeners.values()].every(rows => rows.size === 0), true);
  assert.equal([...h.documentListeners.values()].every(rows => rows.size === 0), true); assert.equal(h.timers.size, 0);
});
test("overview prioritizes decisions, evidence gaps and the reference before closed but mounted research details", async t => {
  const h = mount(t); await h.flush();
  const nodes = h.nodes(), card = (title: string) => nodes.find(node => node.type === "section" && h.words(node).startsWith(title));
  const fold = nodes.find(node => node.type === "details" && node.props["data-testid"] === "overview-research-details");
  assert.ok(fold); assert.equal(!!fold.props.open, false);
  const decision = card("变化卡 · 决定由你作出"), reference = card("当前参考组合");
  assert.ok(decision); assert.ok(reference);
  assert.ok(nodes.indexOf(decision) < nodes.indexOf(reference));
  assert.ok(nodes.indexOf(reference) < nodes.indexOf(fold));
  assert.match(h.words(fold), /风险、投入与研究详情/);
  for (const name of ["InvestorRiskPanel", "InvestorFundingPanel", "InvestorFundedComparisonPanel"]) {
    const child = h.node(name); assert.ok(child);
    if (name !== "InvestorFundingPanel") assert.equal(child.props.binding, binding);
  }
  assert.equal(h.node("InvestorRiskPanel")!.props.state, h.state);
  assert.equal(h.node("InvestorFundingPanel")!.props.state, h.state.funding);
  assert.equal(h.node("InvestorFundedComparisonPanel")!.props.state, h.state);
  await h.fundingLock(true);
  assert.equal(h.button("采纳思路")!.props.disabled, true);
  assert.equal(h.node("InvestorRiskPanel")!.props.disabled, true);
  await h.advance(until);
  const expiredNodes = h.nodes(), gap = expiredNodes.find(node => node.type === "section" && h.words(node).startsWith("还缺哪些证据"));
  const expiredReference = expiredNodes.find(node => node.type === "section" && h.words(node).startsWith("当前参考组合"));
  assert.ok(gap); assert.ok(expiredReference);
  assert.ok(expiredNodes.indexOf(gap) < expiredNodes.indexOf(expiredReference));
  assert.equal(h.button("采纳思路"), undefined);
  assert.equal(h.requests.length, 0);
  await h.invalidate();
  assert.equal(h.nodes().some(node => node.props["data-testid"] === "overview-research-details"), false);
  assert.equal(h.node("InvestorFundingPanel"), undefined);
});
test("plan keeps full risk and economic panels visible without the overview fold or implicit commands", async t => {
  const h = mount(t, displayState(), "plan"); await h.flush();
  assert.equal(h.nodes().some(node => node.props["data-testid"] === "overview-research-details"), false);
  const nodes = h.nodes(), risk = h.node("InvestorRiskPanel"), reference = nodes.find(node => node.type === "section" && h.words(node).startsWith("当前参考组合")), funding = h.node("InvestorFundingPanel");
  assert.ok(risk); assert.ok(reference); assert.ok(funding);
  assert.ok(nodes.indexOf(risk) < nodes.indexOf(reference));
  assert.ok(nodes.indexOf(reference) < nodes.indexOf(funding));
  assert.equal(risk.props.state, h.state); assert.equal(risk.props.binding, binding);
  assert.equal(funding.props.state, h.state.funding);
  assert.equal(h.node("InvestorFundedComparisonPanel")!.props.state, h.state);
  assert.equal(h.requests.length, 0);
});
