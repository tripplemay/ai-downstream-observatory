import type { InvestorModelWatch, InvestorResearchTask } from "@/server/investor/schemas";
import type { InvestorPlan, InvestorState } from "@/server/investor/types";
import { executionChecksUsable } from "@/server/investor/research-execution";
export { splitResearchCostMethodology } from "@/server/investor/reference-cost-methodology";

function formatFixed(value: string | null, scale: number): string {
  if (value === null) return "未能计算";
  if (value.length > 200 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,120})?$/.test(value)) throw new Error("INVESTOR_DISPLAY_DECIMAL_INVALID");
  const negative = value.startsWith("-"), [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  let cents = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0").slice(0, scale));
  const remaining = fraction.slice(scale);
  if (remaining[0] > "5" || (remaining[0] === "5" && (/[1-9]/.test(remaining.slice(1)) || cents % 2n === 1n))) cents += 1n;
  const digits = cents.toString().padStart(3, "0"), integer = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (negative && cents !== 0n ? "-" : "") + integer + "." + digits.slice(-2);
}
export function formatResearchMoney(value: string | null): string { return formatFixed(value, 2); }
export function formatResearchMoneyDelta(value: string): string {
  const formatted = formatResearchMoney(value);
  return formatted === "0.00" && /[1-9]/.test(value) ? (value.startsWith("-") ? "-" : "+") + "<0.01" : formatted;
}
export function formatResearchPercent(value: string | null): string { return value === null ? "未能计算" : formatFixed(value, 4) + "%"; }
export function currentResearchDisplay(task: InvestorResearchTask, nowMs: number): InvestorResearchTask {
  const until = task.study?.source_context?.valid_until;
  if (!until || Date.parse(until) > nowMs) return task;
  return { ...task, status: "outdated", reason_codes: ["REFERENCE_SOURCE_EXPIRED", ...task.reason_codes.filter(code => code !== "REFERENCE_SOURCE_EXPIRED")].slice(0, 40),
    study: null, registry: null };
}
export function researchTaskStatus(task: InvestorResearchTask) {
  if (task.status === "outdated") return { title: "研究来源或输入已失效", detail: "以下仅保留历史证据，不能继续作为当前结论。",
    action: "更新来源或约束后重新核对，不自动重跑旧研究。" };
  const phase = task.reason_codes.includes("SELECTED_CANDIDATE_FAILED_VALIDATION") ? "验证期"
    : task.reason_codes.includes("SELECTED_CANDIDATE_FAILED_HOLDOUT") ? "保留期" : null;
  if (task.status === "calculated" && task.study?.status === "insufficient_evidence" && phase) {
    return { title: `${phase}未通过，未生成参考组合`,
      detail: "冻结候选未通过预先登记的执行与风险检查。计算完成不等于策略通过，也不是行情数据尚未就绪。",
      action: "先核对下方阶段检查。需要改进时另建研究版本，保留原结果和已曝光窗口；不会改选候选或自动启用监测。" };
  }
  if (task.status === "calculated" && task.study?.status === "insufficient_evidence"
    && task.reason_codes.includes("NO_CANDIDATE_WITHIN_CONFIRMED_RISK_BUDGET")
    && task.study.candidates.length > 0 && task.study.candidates.every(candidate => !candidate.usable)) {
    const gaps = task.study.candidates.some(candidate => candidate.train_checks && !executionChecksUsable(candidate.train_checks));
    const fundingGap = task.study.candidates.some(candidate => candidate.train_checks?.cash_intent_review
      && [candidate.train_checks.cash_intent_review.strategy, candidate.train_checks.cash_intent_review.benchmark]
        .some(row => row.failed_intents > 0 || row.pending_intents > 0));
    return { title: fundingGap ? "交收后买入意图未完成，未生成参考组合" : gaps ? "训练模拟执行有缺口，未生成参考组合" : "训练或基准证据不完整，未生成参考组合",
      detail: "候选尚未具备完整的训练与基准证据，不能据此判定你的风险预算过低；这也不是行情数据尚未接入。",
      action: "先核对下方训练检查与缺口原因，不通过提高风险或反复重跑来绕过。旧记录保留，不自动启动验证、保留期或监测。" };
  }
  if (task.status === "calculated") {
    if (task.study?.status === "risk_options_ready") return { title: task.study.qualification === "synthetic_test_only" ? "测试候选已计算，等待确认风险范围" : "候选已计算，等待确认风险范围",
      detail: "当前只有训练期比较，尚未选择最终权重。", action: "先比较损失情景，再决定自己的研究风险范围。" };
    if (task.study?.status === "reference_ready" && task.study.qualification === "synthetic_test_only")
      return { title: "合成测试计算通过，不能作为真实参考组合", detail: "只验证软件计算与交互，不是真实 ETF 研究或个人投资组合。",
        action: "接入并核验真实研究证据，不把软件测试结果作为投资结论。" };
    if (task.study?.status === "reference_ready") return { title: "历史参考计算已通过，不代表实盘验证",
      detail: "通过本次研究规则不证明未来盈利、保留期独立性或当前可交易性。", action: "核对来源和假设；保存仅登记研究观察，不执行交易。" };
    return { title: "计算完成，研究证据仍不足", detail: "尚未形成通过研究规则的参考组合。",
      action: "核对任务证据与研究约束，不以示例或反复重跑替代验证。" };
  }
  const titles = { queued: "研究任务已排队", running: "正在计算研究方案", retrying: "计算尚未完成，等待技术重试",
    blocked: "输入检查已完成，仍缺少研究证据", failed: "研究计算失败，不能推定无需调整" };
  return { title: titles[task.status], detail: "任务完成前不展示确定组合，也不代表持续监测已启用。",
    action: task.status === "failed" ? "核对后台故障与原请求状态，不重复提交来绕过失败。" : "系统保留任务状态；你无需建立真实账本或提交交易。" };
}
export function currentPlanDisplay(plan: InvestorPlan | null | undefined, nowMs: number): InvestorPlan | null {
  if (!plan) return null;
  if (Date.parse(plan.document.valid_until) > nowMs) return plan;
  return plan.document.data_mode === "reconstructed" ? null : { ...plan, quality: plan.quality === "current" ? "expired" : plan.quality };
}
export function currentModelWatchDisplay(watch: InvestorModelWatch, nowMs: number): InvestorModelWatch {
  if (!watch.enabled) return watch;
  if (Date.parse(watch.valid_until) <= nowMs) return { ...watch, status: "expired", model_nav_cny: null };
  if (["research_observe", "research_decision", "synthetic_preview"].includes(watch.status)
    && watch.next_check_at !== null && Date.parse(watch.next_check_at) <= nowMs) return { ...watch, status: "overdue", model_nav_cny: null };
  return watch;
}
function currentResearchBlocker(state: InvestorState, task: InvestorResearchTask | null, now: number) {
  const profile = state.profile, observation = state.latest?.document, study = task?.study;
  if (!profile?.document.loss_tolerance || state.effective_outcome !== "insufficient_evidence" || state.plan || state.model_watch?.enabled
    || task?.status !== "calculated" || !task.completed_at || Date.parse(task.completed_at) > now
    || task.profile_id !== profile.id || task.profile_version !== profile.version
    || observation?.outcome !== "insufficient_evidence" || observation.profile_id !== profile.id
    || observation.profile_version !== profile.version || observation.input_version !== task.input_version
    || study?.qualification !== "owner_reviewed_reconstructed" || study.status !== "insufficient_evidence"
    || !study.source_context || Date.parse(study.source_context.valid_until) <= now
    || !task.reason_codes.includes("RECONSTRUCTED_RESEARCH_ONLY")
    || state.effective_gaps.some(gap => gap.code.startsWith("REFERENCE_SOURCE_") || gap.code === "REFERENCE_PLAN_SOURCE_CHANGED"
      || gap.code === "RISK_BUDGET_UNCONFIRMED")
    || !state.effective_gaps.some(gap => gap.code === "RECONSTRUCTED_RESEARCH_ONLY")) return null;
  const phase = task.reason_codes.includes("SELECTED_CANDIDATE_FAILED_VALIDATION") ? "validation"
    : task.reason_codes.includes("SELECTED_CANDIDATE_FAILED_HOLDOUT") ? "holdout" : null;
  const phaseFailed = phase && !!task.registry?.freeze_hash && task.registry.phases[phase].completed === 1
    && study.phase_checks?.some(check => check.phase === phase);
  const trainIncomplete = task.reason_codes.includes("NO_CANDIDATE_WITHIN_CONFIRMED_RISK_BUDGET")
    && study.candidates.length > 0 && study.candidates.every(candidate => !candidate.usable)
    && task.registry?.phases.train.completed === study.candidates.length;
  return (phase ? phaseFailed : trainIncomplete) ? researchTaskStatus(task) : null;
}
export function currentInvestorDisplay(state: InvestorState, nowMs: number) {
  const now = Math.max(nowMs, Date.parse(state.checked_at));
  const plan = currentPlanDisplay(state.plan, now);
  const researchTask = state.research_task ? currentResearchDisplay(state.research_task, now) : null;
  const modelWatch = state.model_watch ? currentModelWatchDisplay(state.model_watch, now) : null;
  const localGaps: InvestorState["effective_gaps"] = [];
  const gap = (code: string, title: string, detail: string) => localGaps.push({ code, title, detail,
    affected_markets: state.profile?.document.markets ?? [], action: "刷新状态并用有效证据重新复核；旧观察仍保留为历史记录。" });
  if (state.plan?.quality === "current" && Date.parse(state.plan.document.valid_until) <= now)
    gap("REFERENCE_PLAN_NOT_CURRENT", "参考方案已到期", "本页已知参考来源期限已到，旧方案不能继续作为当前研究依据。请刷新并核对新研究证据。");
  if (state.latest?.document.outcome !== "insufficient_evidence" && state.latest?.document.next_review_at
    && Date.parse(state.latest.document.next_review_at) <= now)
    gap("MONITOR_REVIEW_OVERDUE", "复核已到期", "本页尚未核对到按期的新评估，旧结论与变化卡停止作为当前依据；不能把没有新结果当作无需调整。");
  if (state.research_task?.study?.source_context && Date.parse(state.research_task.study.source_context.valid_until) <= now)
    gap("REFERENCE_SOURCE_EXPIRED", "研究来源已到期", "本页研究来源期限已到，旧候选停止作为当前依据。请刷新并核对来源。");
  if (modelWatch?.enabled && ["expired", "overdue"].includes(modelWatch.status) && modelWatch.status !== state.model_watch?.status)
    gap("MONITOR_NOT_CURRENT", "观察结论已到期", "本页已知监测期限已到，旧估值和规则结论不能继续使用。请刷新核对后台是否已有合格的新评估。");
  const codes = new Set(localGaps.map(value => value.code));
  const researchBlocker = localGaps.length ? null : currentResearchBlocker(state, researchTask, now);
  const gaps = [...localGaps, ...state.effective_gaps.filter(value => !codes.has(value.code)).map(value =>
    value.code === "RECONSTRUCTED_RESEARCH_ONLY" && researchBlocker ? { ...value, ...researchBlocker } : value)];
  // This display-only projection can invalidate, never promote or rewrite server history.
  return { plan, researchTask, modelWatch, gaps, researchBlocker, stale: localGaps.length > 0,
    outcome: localGaps.length ? "insufficient_evidence" as const : state.effective_outcome };
}
export function investorPollInterval(state: InvestorState | null): number | null {
  if (!state?.profile) return null;
  if (state.funded_study && ["queued", "running", "retrying"].includes(state.funded_study.status)
    || state.research_task && ["queued", "running", "retrying"].includes(state.research_task.status)
    || state.model_watch?.enabled && (["awaiting_inputs", "awaiting_evaluation", "queued", "running", "retrying"].includes(state.model_watch.status)
      || state.model_watch.acquisition?.status === "visible" && state.model_watch.acquisition.markets.some(row => ["queued", "running", "waiting_core"].includes(row.status)))) return 5000;
  return state.research_task?.status === "blocked" && !state.plan ? 15000 : 60000;
}
export function canResumeInvestorWatch(state: InvestorState, nowMs = Date.parse(state.checked_at)): boolean {
  return !!state.model_watch && state.model_watch.profile_id === state.profile?.id
    && Date.parse(state.model_watch.valid_until) > Math.max(nowMs, Date.parse(state.checked_at))
    && !state.effective_gaps.some(gap => gap.code.startsWith("REFERENCE_SOURCE_") || gap.code === "REFERENCE_PLAN_SOURCE_CHANGED"
      || gap.code === "INVESTOR_MONITOR_FIXED_POLICY_UNSUPPORTED");
}
