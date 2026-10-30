import assert from "node:assert/strict";
import test from "node:test";
import * as research from "../src/components/workbench/research-format";
import * as client from "../src/components/workbench/investor-client";
import * as schemas from "../src/server/investor/schemas";
import * as losses from "../src/server/investor/loss-scenarios";
import { acquisitionDeadlines } from "../src/components/workbench/investor-acquisition";
import { mountInvestorDisplay } from "./investor-display-fixture";
import { displayBinding as binding, displayBefore, displayUntil, displayFuture, displayState, historicalDisplayState } from "./investor-display-state-fixture";
import { blockedResearchDisplayState } from "./investor-research-blocker-fixture";
import { actionCostMethodology, reviewCostMethodology, settlementCostMethodology } from "../src/server/investor/reference-cost-methodology";

const before = Date.parse(displayBefore), until = Date.parse(displayUntil);
function validationHoldState() {
  const state = displayState();
  state.plan = null;
  state.research_task = schemas.researchTaskSchema.parse({ id: "fictional-validation-hold", profile_id: state.profile!.id,
    profile_version: state.profile!.version, input_version: "a".repeat(64), engine_version: "investor-diversified-reference-v1",
    status: "calculated", created_at: displayBefore, completed_at: displayBefore,
    reason_codes: ["SELECTED_CANDIDATE_FAILED_VALIDATION"], live_advice_eligible: false,
    registry: { experiment_id: "fictional-validation-experiment", manifest_hash: "b".repeat(64),
      phases: { train: { registered: 3, completed: 3 }, validation: { registered: 1, completed: 1 }, holdout: { registered: 0, completed: 0 } },
      freeze_hash: "c".repeat(64), prior_window_exposures: 0, exposure_watermark: 4, holdout_status: "not_independently_verified",
      coverage: "local_investor_trials_only", live_advice_eligible: false },
    study: { status: "insufficient_evidence", qualification: "owner_reviewed_reconstructed", result_hash: "d".repeat(64),
      implementation_hash: "e".repeat(64), candidates: [], source_context: { range_start: "2025-01-01", range_end: "2025-06-01",
        valid_until: displayUntil, basis: "owner_reviewed_historical_reconstruction",
        listings: [{ listing_id: "CN:ALPHA", provider_symbol: "501998.SH", market: "CN", role: "growth" }] },
      phase_checks: [{ phase: "train", execution_failure_count: 0, benchmark_execution_failure_count: 0 },
        { phase: "validation", execution_failure_count: 1, benchmark_execution_failure_count: 0 }] },
  });
  return state;
}
function mount(t: { after: (fn: () => void) => void }, state = displayState(), view = "overview") {
  const h = mountInvestorDisplay(t, new URL("../src/components/workbench/investor-workspace.tsx", import.meta.url), "InvestorWorkspace",
    { initial: state, initialSessionBinding: binding, view }, { "next/link": { default: "Link", __esModule: true },
      "lucide-react": Object.fromEntries(["ArrowRight", "CheckCircle2", "CircleHelp", "Clock3", "Eye", "ShieldCheck"].map(name => [name, name])),
      "@/components/ui/input": { Input: "Input" }, "@/components/session-boundary": { useSessionBoundary: () => null },
      "@/server/investor/schemas": schemas, "@/server/investor/loss-scenarios": losses, "./research-format": research, "./investor-client": client,
      ...Object.fromEntries(["account-workspace", "funding-panel", "funded-comparison-panel", "risk-panel", "ai-panel", "notifications-panel", "history-panel"]
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

test("reference and change cards fold only execution method, retaining cost, risk, counterevidence and dates without commands", async t => {
  const summary = "Fictional costs 12.37 CNY; price buffer 2%; FX buffer 1%.",
    methodology = actionCostMethodology + reviewCostMethodology + settlementCostMethodology;
  for (const view of ["overview", "plan"]) {
    const state = displayState(); state.plan!.document.estimated_cost = summary + methodology;
    const original = JSON.stringify(state), h = mount(t, state, view); await h.flush();
    const folds = h.nodes().filter(node => node.props["data-testid"] === "research-cost-methodology");
    assert.equal(folds.length, 2);
    for (const fold of folds) { assert.equal(!!fold.props.open, false); assert.match(h.words(fold), /执行方法与交收规则/); assert.ok(h.words(fold).endsWith(methodology)); }
    for (const title of ["当前参考组合", "变化卡 · 决定由你作出"]) {
      const card = h.card(title)!;
      const withoutMethod = folds.reduce((text, fold) => text.replace(h.words(fold), ""), h.words(card));
      assert.ok(withoutMethod.includes(summary)); assert.ok(!withoutMethod.includes(settlementCostMethodology));
      if (title === "当前参考组合") {
        for (const risk of state.plan!.document.risk_scenarios) assert.ok(withoutMethod.includes(risk));
        assert.ok(withoutMethod.includes(state.plan!.document.data_cutoff)); assert.ok(withoutMethod.includes(state.plan!.document.valid_until));
      } else for (const counterargument of state.plan!.document.counterarguments) assert.ok(withoutMethod.includes(counterargument));
    }
    assert.ok(h.button("暂缓")); assert.equal(h.requests.length, 0); assert.equal(JSON.stringify(state), original); h.close();
  }
});

test("unrecognized and legacy cost explanations remain fully visible instead of being truncated", async t => {
  const state = displayState(); state.plan!.document.estimated_cost = "Fictional estimated cost 12.37 CNY. Full unknown method and tax 3 CNY.";
  const h = mount(t, state); await h.flush();
  assert.equal(h.nodes().some(node => node.props["data-testid"] === "research-cost-methodology"), false);
  for (const title of ["当前参考组合", "变化卡 · 决定由你作出"]) assert.ok(h.words(h.card(title)).includes(state.plan!.document.estimated_cost));
  assert.equal(h.requests.length, 0);
});

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

test("actual plan and overview explain validation hold before technical details, with no final-plan save or automatic requests", async t => {
  for (const view of ["overview", "plan"]) {
    const h = mount(t, validationHoldState(), view); await h.flush();
    const reference = h.card("研究组合与历史参考"), progress = h.card("后台研究进度");
    assert.match(h.words(reference), /验证期未通过，未生成参考组合/);
    assert.match(h.words(reference), /另建研究版本/);
    assert.match(h.words(progress), /验证期：候选执行缺口 1 项，基准执行缺口 0 项/);
    assert.match(h.words(progress), /保留期尚未启动，不能显示为通过/);
    assert.doesNotMatch(h.words(reference), /先比较损失情景并补齐研究证据/);
    assert.equal(h.button("保存为观察中的研究方案"), undefined);
    assert.equal(h.requests.length, 0);
    await h.advance(until);
    assert.match(h.words(h.card("研究组合与历史参考")), /研究来源或输入已失效/);
    assert.doesNotMatch(h.words(h.card("后台研究进度")), /冻结候选的阶段执行检查|验证期：候选执行缺口/);
    assert.equal(h.requests.length, 0); h.close();
  }
});
test("all rejected train candidates show simulated execution counts without prompting risk escalation or a final-plan save", async t => {
  const state = validationHoldState(), task = state.research_task!;
  task.reason_codes = ["NO_CANDIDATE_WITHIN_CONFIRMED_RISK_BUDGET"];
  task.registry!.phases.validation = { registered: 0, completed: 0 };
  task.registry!.freeze_hash = null; task.registry!.exposure_watermark = 3;
  task.study!.phase_checks = [];
  task.study!.candidates = [{ parameters_hash: "f".repeat(64), weights: { "CN:ALPHA": "1" },
    train_net_twr: "0.01", train_drawdown: "-0.01", benchmark_net_twr: "0.02", usable: false, stresses: [],
    train_checks: { metrics_complete: true, execution_failure_count: 1, benchmark_execution_failure_count: 2 } }];
  for (const view of ["overview", "plan"]) {
    const h = mount(t, state, view); await h.flush();
    assert.match(h.words(h.card("研究组合与历史参考")), /训练模拟执行有缺口/);
    assert.match(h.words(h.card("后台研究进度")), /候选 1：候选模拟执行缺口 1 项，基准模拟执行缺口 2 项/);
    assert.match(h.text(), /提高风险预算不会修复执行缺口/);
    assert.equal(h.button("保存为观察中的研究方案"), undefined);
    assert.equal(h.requests.length, 0);
    await h.advance(until);
    assert.doesNotMatch(h.words(h.card("后台研究进度")), /训练候选与基准的执行证据/);
    assert.equal(h.requests.length, 0); h.close();
  }
});
test("the bound confirmed-risk blocker is actionable before the fold without rewriting original evidence or issuing a command", async t => {
  for (const view of ["overview", "plan"]) {
    const state = blockedResearchDisplayState(), original = JSON.stringify(state);
    const h = mount(t, state, view); await h.flush();
    assert.match(h.words(h.card("还缺哪些证据")), /训练模拟执行有缺口/);
    assert.doesNotMatch(h.words(h.card("还缺哪些证据")), /确认风险后完成/);
    assert.match(h.words(h.card("下一次复核")), /不通过提高风险或反复重跑/);
    assert.doesNotMatch(h.words(h.card("下一次复核")), /风险与流动性约束明确后复核/);
    assert.ok(h.nodes().some(node => node.type === "Link" && node.props.href === "/workbench/plan#research-execution-checks"));
    assert.equal(h.button("重新检查研究条件"), undefined);
    assert.equal(h.card("后台研究进度")!.props.id, "research-execution-checks");
    assert.match(h.text(), /Fictional historical generic research explanation/);
    assert.equal(JSON.stringify(state), original); assert.equal(h.requests.length, 0);
    await h.advance(until);
    assert.equal(h.nodes().some(node => node.type === "Link" && node.props.href === "/workbench/plan#research-execution-checks"), false);
    assert.match(h.words(h.card("下一次复核")), /已知期限已到/);
    assert.equal(JSON.stringify(state), original); assert.equal(h.requests.length, 0); h.close();
  }
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
  assert.equal(h.headline(), undefined); assert.equal(h.node("InvestorHistoryPanel")!.props.workspaceId, h.state.workspace_id); assert.equal(h.node("InvestorAiPanel"), undefined);
  assert.equal(h.node("InvestorHistoryPanel")!.props.disabled, false);
  assert.equal(h.button("刷新状态"), undefined);
  await h.invalidate(); assert.equal(h.node("InvestorHistoryPanel"), undefined); assert.doesNotMatch(h.text(), /Synthetic test observation only/); assert.equal(h.requests.length, 0);
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
test("subcent model deltas retain their direction and exact evidence while policy diagnostics stay behind the overview reference", async t => {
  const state = displayState();
  state.latest!.document.model_change = schemas.modelChangeSchema.parse({ assessment_hash: "f".repeat(64), model_nav_cny: "1000",
    estimated_cost_cny: "1", hypothetical_cash_remaining_cny: null, funding_status: "none", allocation_method: "band_rebalance_research_not_executable",
    market_cutoffs: { CN: displayBefore }, constraints_not_checked: ["lot_size", "tradability", "actual_cash", "settlement", "tax", "account_permissions"],
    policy_evaluation: { parameters_hash: "e".repeat(64), evaluation_timezone: "UTC", review_period: "2026-H1", calendar_due: true,
      cooldown_active: false, new_funding: false, new_cny_cash: false, cash_repair_pending: false,
      class_drift: [{ role: "growth", target_weight: "1", current_weight: "0.999999", difference_weight: "-0.000001", threshold_breached: false }] },
    changes: [{ listing_id: "fictional", before_target_weight: "1", after_target_weight: "1", observed_model_weight: "0.999999",
      current_model_value_cny: "999.999", hypothetical_target_value_cny: "1000", difference_cny: "0.001", within_band: false,
      proposed_change_cny: "0.001", remaining_target_difference_cny: "0" }] });
  const h = mount(t, state); await h.flush();
  assert.match(h.words(h.card("变化卡 · 决定由你作出")), /研究变化：\+<0.01/);
  assert.match(h.words(h.card("变化卡 · 决定由你作出")), /冻结容差仍按未舍入值判断，不自动放宽/);
  assert.match(h.words(h.card("变化卡 · 决定由你作出")), /研究变化 0.001 CNY/);
  const fold = h.nodes().find(node => node.props["data-testid"] === "overview-research-details")!;
  assert.match(h.words(fold), /本次低频规则复核/);
  assert.equal(!!fold.props.open, false);
  assert.ok(h.nodes().indexOf(h.card("当前参考组合")!) < h.nodes().indexOf(fold));
  assert.equal(h.headline(), "需要你做决定"); assert.equal(h.requests.length, 0);
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

test("qualified historical reference leads the plan page while confirmed risk remains mounted in a closed disclosure", async t => {
  for (const saved of [false, true]) {
    const state = historicalDisplayState(saved), original = JSON.stringify(state), h = mount(t, state, "plan"); await h.flush();
    const nodes = h.nodes(), reference = nodes.find(node => node.type === "section" && node.props.id === "research-reference-plan")!,
      risk = nodes.find(node => node.type === "InvestorRiskPanel")!;
    const fold = nodes.find(node => node.props["data-testid"] === "plan-risk-details")!;
    assert.ok(reference); assert.ok(risk); assert.ok(fold); assert.equal(!!fold.props.open, false);
    assert.ok(nodes.indexOf(reference) < nodes.indexOf(fold)); assert.ok(nodes.indexOf(fold) < nodes.indexOf(risk));
    assert.equal(risk.props.state, state); assert.equal(risk.props.binding, binding);
    const current = nodes.find(node => node.props["data-testid"] === "current-monitor-outcome")!;
    assert.equal(h.words(current), "当前监测：证据不足");
    assert.match(h.text(), saved ? /研究方案已保存，监测尚未就绪/ : /历史参考组合已生成/);
    assert.ok(h.nodes().some(node => node.type === "Link" && node.props.href === (saved ? "#research-model-watch" : "#research-reference-plan")));
    assert.equal(h.requests.length, 0); assert.equal(JSON.stringify(state), original); h.close();
  }
});
test("missing risk leads, while evidence expiry expands risk without moving the confirmed-risk form or submitting", async t => {
  const state = historicalDisplayState(); state.profile!.document.loss_tolerance = null;
  const h = mount(t, state, "plan"); await h.flush();
  assert.equal(h.nodes().find(node => node.props["data-testid"] === "plan-risk-details")!.props.open, true);
  assert.equal(h.nodes().some(node => node.props["data-testid"] === "current-monitor-outcome"), false);
  const nodes = h.nodes(), risk = nodes.find(node => node.type === "InvestorRiskPanel")!,
    reference = nodes.find(node => node.type === "section" && node.props.id === "research-reference-plan")!;
  assert.ok(risk); assert.ok(reference); assert.ok(nodes.indexOf(risk) < nodes.indexOf(reference));
  h.close();
  const ready = mount(t, historicalDisplayState(), "plan"); await ready.flush(); await ready.advance(until);
  assert.equal(ready.headline(), "证据不足"); assert.equal(ready.card("历史研究参考组合"), undefined);
  const expiredNodes = ready.nodes(), expiredFold = expiredNodes.find(node => node.props["data-testid"] === "plan-risk-details")!;
  const expiredReference = expiredNodes.find(node => node.type === "section" && node.props.id === "research-reference-plan")!;
  assert.ok(expiredReference); assert.ok(expiredFold); assert.equal(expiredFold.props.open, true);
  assert.ok(expiredNodes.indexOf(expiredReference) < expiredNodes.indexOf(expiredFold));
  assert.equal(ready.requests.length, 0);
});
test("main navigation is compact and never speculatively fetches other expensive research routes", async t => {
  const h = mount(t); await h.flush();
  const nav = h.nodes().find(node => node.type === "nav" && node.props["aria-label"] === "工作台主导航")!;
  assert.match(String(nav.props.className), /grid-cols-4/); assert.doesNotMatch(String(nav.props.className), /overflow-x-auto/);
  for (const href of ["/workbench", "/workbench/plan", "/workbench/observations", "/workbench/accounts"]) {
    const link = h.nodes().find(node => node.type === "Link" && node.props.href === href)!;
    assert.equal(link.props.prefetch, false); assert.match(String(link.props.className), /min-h-11/);
  }
  assert.equal(h.requests.length, 0);
});
