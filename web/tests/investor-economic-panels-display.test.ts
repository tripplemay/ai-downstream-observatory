import assert from "node:assert/strict";
import test from "node:test";
import * as risk from "../src/components/workbench/investor-risk-client";
import * as scenarios from "../src/server/investor/risk-scenarios";
import * as losses from "../src/server/investor/loss-scenarios";
import * as format from "../src/components/workbench/research-format";
import * as comparisonClient from "../src/components/workbench/investor-funded-comparison-client";
import * as analysisClient from "../src/components/workbench/investor-funded-analysis-client";
import { mountInvestorDisplay } from "./investor-display-fixture";
import { economicDisplayFixture, riskDisplayState } from "./investor-economic-display-fixture";
import { displayBinding as binding, displayBefore, displayUntil, displayFuture } from "./investor-display-state-fixture";

const before = Date.parse(displayBefore), until = Date.parse(displayUntil), comparisonLabel = "查看已登记的比较结果", analysisLabel = "查看完整窗口曲线与持有对照";
function mountRisk(t: { after: (fn: () => void) => void }) {
  const state = riskDisplayState(), commands: unknown[] = [];
  return { commands, state, ...mountInvestorDisplay(t, new URL("../src/components/workbench/investor-risk-panel.tsx", import.meta.url), "InvestorRiskPanel",
    { state, binding, disabled: false, onCommand: (intent: unknown) => commands.push(intent) }, {
      "@/components/ui/input": { Input: "Input" }, "@/server/investor/loss-scenarios": losses, "@/server/investor/risk-scenarios": scenarios,
      "./investor-risk-client": risk, "./research-format": format }, before) };
}
function mountComparison(t: { after: (fn: () => void) => void }) {
  const data = economicDisplayFixture();
  return { ...data, ...mountInvestorDisplay(t, new URL("../src/components/workbench/investor-funded-comparison-panel.tsx", import.meta.url), "InvestorFundedComparisonPanel",
    { state: data.state, binding, disabled: false, scopeLocked: false }, { "./investor-funded-comparison-client": comparisonClient,
      "./investor-funded-analysis-panel": { InvestorFundedAnalysisPanel: "InvestorFundedAnalysisPanel" } }, before) };
}
function mountAnalysis(t: { after: (fn: () => void) => void }, beforeParse?: () => Promise<void>) {
  const data = economicDisplayFixture();
  const parsing = new Set<ReturnType<typeof analysisClient.parseFundedAnalysis>>();
  const client = { ...analysisClient, parseFundedAnalysis: (...args: Parameters<typeof analysisClient.parseFundedAnalysis>) => {
    const result = (async () => { await beforeParse?.(); return analysisClient.parseFundedAnalysis(...args); })();
    parsing.add(result); void result.then(() => parsing.delete(result), () => parsing.delete(result));
    return result;
  } };
  const h = mountInvestorDisplay(t, new URL("../src/components/workbench/investor-funded-analysis-panel.tsx", import.meta.url), "InvestorFundedAnalysisPanel",
    { comparison: data.comparison, binding, parameters: data.parameters }, { "./investor-funded-analysis-client": client, "./research-format": format }, before);
  const finishParsing = async () => { await h.flush(); await Promise.allSettled([...parsing]); await h.flush(); };
  return { ...data, ...h, result: () => h.nodes().find(node => typeof node.type === "function" && node.type.name === "FundedAnalysisResults"),
    finishParsing, settle: async () => { await finishParsing();
      assert.ok(h.nodes().some(node => typeof node.type === "function" && node.type.name === "FundedAnalysisResults"),
        "Expected strictly parsed analysis result"); } };
}
test("risk source deadline retires only candidate evidence, not generic scenarios, risk answers or saved history; rollback cannot revive it", async t => {
  const h = mountRisk(t), original = JSON.stringify(h.state); await h.flush();
  assert.match(h.text(), /FICTIONAL_DISPLAY_SHOCK/); assert.equal(h.requests.length, 0);
  await h.advance(until); assert.doesNotMatch(h.text(), /FICTIONAL_DISPLAY_SHOCK/); assert.match(h.text(), /尚无当前有效/); assert.match(h.text(), /通用算术情景/);
  await h.advance(before, 1000); await h.wake(); assert.doesNotMatch(h.text(), /FICTIONAL_DISPLAY_SHOCK/);
  assert.equal(JSON.stringify(h.state), original); assert.equal(h.commands.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.state.profile!.document.loss_tolerance, null);
  assert.ok(h.nodes().filter(node => node.type === "input" && node.props.type === "radio").every(node => node.props.checked === false));
});
test("risk candidates cannot revive after a render-observed forward jump or postpone expiry by a pre-expiry rollback", async t => {
  const h = mountRisk(t); await h.flush(); h.setWall(until); await h.change({ disabled: false }); h.setWall(before); await h.change({ disabled: false });
  assert.doesNotMatch(h.text(), /FICTIONAL_DISPLAY_SHOCK/);
  const next = mountRisk(t); await next.flush(); await next.advance(before - 10000, 1000); assert.doesNotMatch(next.text(), /FICTIONAL_DISPLAY_SHOCK/);
  next.close(); assert.equal(next.timers.size, 0); assert.equal([...next.documentListeners.values()].every(rows => rows.size === 0), true);
});
test("comparison is explicit GET-only and retires economic amounts at the exact deadline, permanently across rollback and render jumps", async t => {
  for (const forward of [false, true]) {
    const h = mountComparison(t); await h.flush(); assert.equal(h.requests.length, 0); await h.click(comparisonLabel);
    await h.reply(0, { ...h.comparison, session_binding: binding }); assert.match(h.text(), /101.00 CNY/); assert.match(h.text(), /FICTIONAL_DISPLAY_ETF/);
    assert.ok(h.node("InvestorFundedAnalysisPanel"));
    if (forward) { h.setWall(until); await h.change({ disabled: false }); } else await h.advance(until);
    assert.doesNotMatch(h.text(), /101.00 CNY|FICTIONAL_DISPLAY_ETF/); assert.match(h.text(), /旧经济结果已隐藏/);
    h.setWall(before); await h.change({ disabled: false }); await h.wake(); assert.doesNotMatch(h.text(), /101.00 CNY/);
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, "GET"); h.close();
  }
});
test("comparison rejects late expired replies after rollback; only a strictly parsed newer result restores amounts after manual GET", async t => {
  const h = mountComparison(t); await h.flush(); await h.click(comparisonLabel); await h.advance(until); await h.advance(before, 1000);
  await h.reply(0, { ...h.comparison, session_binding: binding }); assert.doesNotMatch(h.text(), /101.00 CNY/); assert.match(h.text(), /未通过核验/);
  await h.click(comparisonLabel); await h.reply(1, { ...h.comparison, valid_until: displayFuture, session_binding: binding }); assert.match(h.text(), /101.00 CNY/);
  assert.equal(h.requests.every(row => row.method === "GET"), true); assert.equal(h.state.profile!.document.loss_tolerance, null);
});
test("comparison scope lock and obsolete callbacks/replies cannot start or poison a new binding", async t => {
  const h = mountComparison(t); await h.flush(); const old = h.button(comparisonLabel)!.props.onClick as () => void;
  await h.change({ disabled: true, scopeLocked: true }); old(); await h.flush(); assert.equal(h.requests.length, 0);
  await h.change({ disabled: false, scopeLocked: false }); await h.click(comparisonLabel);
  const other = "b".repeat(64); await h.change({ binding: other }); old(); await h.flush(); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.signal?.aborted, true);
  await h.click(comparisonLabel); await h.reply(0, {}, 401); await h.reply(1, { ...h.comparison, session_binding: other }); assert.match(h.text(), /101.00 CNY/);
  await h.change({ scopeLocked: true }); assert.doesNotMatch(h.text(), /101.00 CNY/); assert.equal(h.requests.length, 2);
});
test("comparison session invalidation clears data, cancels in-flight reads and disallows cached clicks", async t => {
  const h = mountComparison(t); await h.flush(); await h.click(comparisonLabel); await h.reply(0, { ...h.comparison, session_binding: binding });
  const old = h.button(comparisonLabel)!.props.onClick as () => void; await h.click(comparisonLabel); await h.invalidate();
  assert.equal(h.requests[1].options.signal?.aborted, true); await h.reply(1, { ...h.comparison, session_binding: binding }); old(); await h.flush();
  assert.doesNotMatch(h.text(), /101.00 CNY/); assert.equal(h.requests.length, 2); h.close();
  assert.equal([...h.windowListeners.values()].every(rows => rows.size === 0), true);
});
test("analysis consumes the real strict money/hash parser, stays manual GET-only, and expires without any parent render", async t => {
  const h = mountAnalysis(t); await h.flush(); assert.equal(h.requests.length, 0);
  const old = h.button(analysisLabel)!.props.onClick as () => void; await h.click(analysisLabel);
  await h.reply(0, { ...h.analysis, session_binding: binding }); await h.settle(); assert.deepEqual(h.result()!.props.data, h.analysis.analysis);
  await h.advance(until); assert.equal(h.result(), undefined); assert.match(h.text(), /旧曲线已隐藏/);
  await h.advance(before, 1000); await h.wake(); old(); await h.flush(); assert.equal(h.result(), undefined); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].method, "GET"); assert.equal(h.timers.size, 0);
});
test("analysis settlement waits for real parser completion, not a fixed number of event-loop turns", { timeout: 10000 }, async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = mountAnalysis(t, () => gate); await h.flush(); await h.click(analysisLabel);
  await h.reply(0, { ...h.analysis, session_binding: binding });
  for (let i = 0; i < 25; i++) await h.flush();
  assert.equal(h.result(), undefined);
  let completed = false;
  const settled = h.settle().then(() => { completed = true; });
  await h.flush(); assert.equal(completed, false); release(); await settled;
  assert.deepEqual(h.result()!.props.data, h.analysis.analysis);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, "GET");
  await h.advance(until); assert.equal(h.result(), undefined);
});
test("analysis render jump remains latched and stale click callbacks cannot read an expired comparison", async t => {
  const h = mountAnalysis(t); await h.flush(); const old = h.button(analysisLabel)!.props.onClick as () => void;
  h.setWall(until); await h.change({ binding }); h.setWall(before); await h.change({ binding }); old(); await h.flush();
  assert.equal(h.requests.length, 0); assert.equal(h.button(analysisLabel)!.props.disabled, true); assert.match(h.text(), /资料已到期/);
});
test("analysis expiry aborts pending reads; late results and obsolete identity 401 cannot restore curves or poison a new binding", async t => {
  const h = mountAnalysis(t); await h.flush(); await h.click(analysisLabel); await h.advance(before - 10000, 1000);
  assert.equal(h.requests[0].options.signal?.aborted, true); await h.reply(0, { ...h.analysis, session_binding: binding }); assert.equal(h.result(), undefined);
  const next = { ...h.comparison, checked_at: displayUntil, valid_until: displayFuture }; await h.change({ comparison: next });
  await h.click(analysisLabel); const other = "b".repeat(64); await h.change({ binding: other }); await h.click(analysisLabel);
  await h.reply(1, {}, 401); await h.reply(2, { ...h.analysis, checked_at: displayUntil, valid_until: displayFuture, session_binding: other });
  await h.settle(); assert.ok(h.result()); assert.equal(h.requests.length, 3);
});
test("analysis rejects inconsistent money and unknown response fields, but supports explicit retry and clears on path/session change", async t => {
  const h = mountAnalysis(t); await h.flush();
  const invalid = structuredClone(h.analysis); invalid.analysis!.candidate.daily[0].profit_cny = "999";
  for (const response of [{ ...invalid, session_binding: binding }, { ...h.analysis, session_binding: binding, unexpected: true }]) {
    await h.click(analysisLabel); await h.reply(h.requests.length - 1, response);
    await h.finishParsing(); assert.equal(h.result(), undefined); assert.match(h.text(), /未通过核验/);
  }
  await h.click(analysisLabel); await h.reply(2, { ...h.analysis, session_binding: binding }); await h.settle();
  (h.node("select")!.props.onChange as (event: unknown) => void)({ target: { value: "staged" } }); await h.flush(); assert.equal(h.result(), undefined);
  await h.click(analysisLabel); assert.match(h.requests[3].url, /path=staged/); await h.invalidate();
  assert.equal(h.requests[3].options.signal?.aborted, true); await h.reply(3, { ...h.analysis, path: "staged", session_binding: binding });
  assert.equal(h.result(), undefined); assert.equal(h.requests.length, 4); h.close(); assert.equal(h.timers.size, 0);
});
