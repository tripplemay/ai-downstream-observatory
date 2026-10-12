import type { InvestorModelWatch, InvestorResearchTask } from "@/server/investor/schemas";
import type { InvestorPlan, InvestorState } from "@/server/investor/types";

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
export function formatResearchPercent(value: string | null): string { return value === null ? "未能计算" : formatFixed(value, 4) + "%"; }
export function currentResearchDisplay(task: InvestorResearchTask, nowMs: number): InvestorResearchTask {
  const until = task.study?.source_context?.valid_until;
  if (!until || Date.parse(until) > nowMs) return task;
  return { ...task, status: "outdated", reason_codes: ["REFERENCE_SOURCE_EXPIRED", ...task.reason_codes.filter(code => code !== "REFERENCE_SOURCE_EXPIRED")].slice(0, 40),
    study: null, registry: null };
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
  const gaps = [...localGaps, ...state.effective_gaps.filter(value => !codes.has(value.code))];
  // This display-only projection can invalidate, never promote or rewrite server history.
  return { plan, researchTask, modelWatch, gaps, stale: localGaps.length > 0,
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
