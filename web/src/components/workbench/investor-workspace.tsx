"use client";

import Link from "next/link";
import { InvestorHistoryPanel } from "./investor-history-panel";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, CircleHelp, Clock3, Eye, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import { useSessionBoundary } from "@/components/session-boundary";
import type { InvestorProfile } from "@/server/investor/schemas";
import { investorProfileSchema } from "@/server/investor/schemas";
import type { InvestorModelChange, InvestorModelWatch, InvestorResearchTask, ReferencePlan } from "@/server/investor/schemas";
import type { InvestorPlan, InvestorState } from "@/server/investor/types";
import { parseInvestorState, verifyInvestorReceipt } from "./investor-client";
import { illustrateLossScenarios } from "@/server/investor/loss-scenarios";
import { canResumeInvestorWatch, currentInvestorDisplay, currentModelWatchDisplay, currentResearchDisplay, investorPollInterval, formatResearchMoney, formatResearchMoneyDelta, formatResearchPercent, researchTaskStatus } from "./research-format";
import { InvestorAccountWorkspace } from "./investor-account-workspace";
import { InvestorFundingPanel } from "./investor-funding-panel";
import { InvestorFundedComparisonPanel } from "./investor-funded-comparison-panel";
import { InvestorRiskPanel } from "./investor-risk-panel";
import { InvestorAiPanel } from "./investor-ai-panel";
import { InvestorNotificationsPanel } from "./investor-notifications-panel";
import { acquisitionDeadlines, InvestorAcquisitionPanel } from "./investor-acquisition";
import { useInvestorDisplayClock } from "./investor-display-clock";
import type { ResearchExecutionReview } from "@/server/investor/research-execution";

export type InvestorView = "overview" | "plan" | "observations" | "accounts";
const panel = "min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6";
const field = "flex min-w-0 flex-col gap-2 text-sm";
const select = "h-11 w-full rounded-lg border bg-background px-3";
const labels = { observe: "继续观察", decision_required: "需要你做决定", insufficient_evidence: "证据不足" };
const marketLabels = { CN: "A 股", HK: "港股", US: "美股" };
const roleLabels = { growth: "成长", defensive: "防守", diversifier: "分散" };
const decisionLabels = { accept_idea: "采纳思路", defer: "暂缓", reject: "拒绝" };
function ExecutionReviewDetails({ review }: { review: ResearchExecutionReview }) {
  return <div className="text-xs text-muted-foreground">{(["strategy", "benchmark"] as const).map(side => <p key={side}>
    {side === "strategy" ? "候选" : "基准"}：最终执行缺口 {review[side].terminal_failure_count} 项；
    公司行动撤单 {review[side].cancellations} 项，其中已解决 {review[side].resolved_cancellations} 项；
    待解决复核 {review[side].unresolved_reviews} 项。
  </p>)}</div>;
}
const errorLabels: Record<string, string> = {
  INVESTOR_PROPOSAL_CONTEXT_CONFLICT: "清单、风控、预占或账本关联已变化。请重新核对，不沿用旧草稿批准。",
  INVESTOR_PROPOSAL_SELECTION_INVALID: "所选清单不属于当前完整核对范围，请重新读取。",
  INVESTOR_PROPOSAL_OPERATION_BLOCKED: "当前清单不允许执行该步骤。请重新核对风控和有效期；不会自动批准或下单。",
  INVESTOR_PROPOSAL_CAPACITY_REQUIRES_REVIEW: "待审记录超出简化入口的完整核对上限，请通过高级入口复核，不截断后视为全部。",
  INVESTOR_MONITOR_FIXED_POLICY_UNSUPPORTED: "此旧版方案未绑定有状态监测规则，请重新研究并保存新版方案；不会套用旧规则。",
  INVESTOR_VERSION_CONFLICT: "内容已更新，请重新读取后核对，再提交新的决定。",
  INVESTOR_OBSERVATION_NOT_CURRENT: "这条观察已失效，请刷新状态并核对新评估；旧记录仍保留，不能继续作为当前决定依据。",
  INVESTOR_PROFILE_CHANGED: "约束已更新，请先查看当前版本。",
  INVESTOR_INPUT_INVALID: "请检查投资期限、市场范围和预算格式。",
  INVESTOR_FUNDING_HORIZON_CONFLICT: "投入计划期限超过当前投资期限，请核对后重新保存。",
  INVESTOR_RESPONSE_INVALID: "返回内容未通过核验，不能作为保存成功的证明。请核对或重试原请求。",
  INVESTOR_UNAVAILABLE: "研究工作区暂时不可用，请稍后重试。",
  WORKBENCH_READ_ONLY: "恢复只读模式，暂不能保存或提交研究任务。",
  INVESTOR_PLAN_SOURCE_UNAVAILABLE: "方案来源已过期或变化，请更新研究证据；旧记录仍保留。",
  INVESTOR_ACCOUNT_OUT_OF_SCOPE: "该账本不能核验为你的私有账本，请重新核对账户资料。",
  INVESTOR_ACCOUNT_INPUT_INVALID: "账本与版本字段不一致，请刷新后重新选择。",
  INVESTOR_LEDGER_VERSION_CONFLICT: "账本事实已更新，请刷新账户资料并重新核对。",
  INVESTOR_ACCOUNT_CAPACITY_REQUIRES_REVIEW: "账户资料超过本页安全读取上限，需先在高级入口复核范围。",
  INVESTOR_RECONCILIATION_CONTEXT_CONFLICT: "关联、账本事实或账户状态已更新。请重新核对范围，不要提交旧版本草稿。",
  INVESTOR_TRADE_CONTEXT_CONFLICT: "成交回录范围已变化。请刷新账户资料，重新核对事实后再回录。",
  INVESTOR_EXECUTION_CONTEXT_CONFLICT: "清单、预占、原件或账户范围已变化。请重新核对；不会沿用旧草稿关联。",
  INVESTOR_EXECUTION_SELECTION_INVALID: "所选成交、清单或原件不匹配。请核对同一账户、证券、币种及方向，不自动猜测关联。",
  INVESTOR_EXECUTION_FACT_ALREADY_LINKED: "该成交已有其他清单或原件关联，请先复核历史，不能再次核销预占。",
  INVESTOR_EXECUTION_REPORT_DUPLICATE_CONFLICT: "同一来源的回报编号已有不同内容。请核对原件，不更换编号重复登记。",
  INVESTOR_EXECUTION_CAPACITY_REQUIRES_REVIEW: "执行记录超出简化入口的完整核对上限，请在高级入口复核；不会截断后称为全部记录。",
  INVESTOR_CASH_CONTEXT_CONFLICT: "资金回录范围已变化。请刷新状态与账户资料，再核对已发生事实。",
  INVESTOR_VALUATION_CONTEXT_CONFLICT: "账户、对账或行情版本已变化。请重新核对估值准备情况；不会换用新数据继续计算。",
  INVESTOR_VALUATION_CAPACITY_REQUIRES_REVIEW: "全账本资料超过简化入口安全范围，请先做容量复核，不截取部分资料估值。",
  INVESTOR_VALUATION_RECONCILIATION_REQUIRED: "全部账户必须先通过独立对账，包括停用账户；新的事实需要重新对账。",
  INVESTOR_VALUATION_INPUT_INVALID: "请核对共同估值时点、各市场来源、交易日和汇率时效。",
  INVESTOR_VALUATION_SOURCE_UNAVAILABLE: "所选来源未通过本用户、本账本的发布证据核验，请补齐来源后重试。",
  INVESTOR_CASH_CAPACITY_REQUIRES_REVIEW: "资金资料超过简化入口安全范围，请使用高级账本复核，不截取部分记录。",
  INVESTOR_CASH_ACCOUNT_DISABLED: "账户已停用，不能通过资金回录绕过停用限制。",
  INVESTOR_CASH_INPUT_INVALID: "请核对实际资金方向、币种、正数金额、日期及独立来源。计划投入不是已发生事实。",
  INVESTOR_CASH_SOURCE_SUPERSEDED: "该来源已被修正，不能再次入账。请核对原记录与修正链。",
  INVESTOR_CASH_SOURCE_DUPLICATE_CONFLICT: "相同资金来源编号已有不同事实。请核对原件，不要换编号重复入账。",
  INVESTOR_CASH_CHRONOLOGY_REQUIRES_REVIEW: "该资金日期早于已记事实，请通过高级账本复核历史顺序，不在此插入旧资金。",
  INVESTOR_TRADE_CAPACITY_REQUIRES_REVIEW: "回录资料超过安全读取上限，请先在高级账本复核。",
  INVESTOR_TRADE_ACCOUNT_DISABLED: "账户已停用，不能通过成交回录绕过停用限制。",
  INVESTOR_TRADE_INPUT_INVALID: "回录事实无效。请核对证券身份、币种、实际日期、数量、本金和费用。",
  INVESTOR_TRADE_SOURCE_SUPERSEDED: "原来源事实已被修正，不能再次入账。请在高级账本核对原记录与修正链。",
  INVESTOR_TRADE_SOURCE_DUPLICATE_CONFLICT: "同一来源编号已有不同事实。不要换编号重复入账，请核对原件并修正。",
  INVESTOR_TRADE_CHRONOLOGY_REQUIRES_REVIEW: "该事实早于已记录事实，请通过高级账本复核时间顺序，不在此插入旧成交。",
  INVESTOR_TRADE_POSITION_HISTORY_REQUIRED: "卖出数量超过账本已记录持仓，或历史成本资料不足。请先补齐历史，不自动生成持仓。",
  INVESTOR_TRADE_SETTLEMENT_REVIEW_REQUIRED: "交收与关联成交不一致，或金额超过未完成交收余额。请核对实际原件，不自动调整金额。",
  INVESTOR_RECONCILIATION_INPUT_INVALID: "独立资料或旧差异处理不完整，请核对金额、证券身份、截止日期和解决原因。",
  INVESTOR_RECONCILIATION_CUTOFF_UNSUPPORTED: "该截止时点早于已记录事实，或日期不完整。请选择覆盖这些事实的独立资料，不会伪造历史对账。",
  INVESTOR_RECONCILIATION_CAPACITY_REQUIRES_REVIEW: "独立资料超过简化入口安全上限，请使用高级账本核对，不会截断记录。",
};
function Card({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return <section id={id} tabIndex={id ? -1 : undefined} className={id ? `${panel} scroll-mt-24` : panel}><h2 className="mb-4 text-lg font-semibold">{title}</h2>{children}</section>;
}
function ReferencePlanCard({ plan, task, disabled, onSave }: { plan: InvestorPlan | null; task: InvestorResearchTask | null; disabled: boolean; onSave: () => void }) {
  const empty = task ? researchTaskStatus(task) : null;
  return <Card title={plan?.document.data_mode === "reconstructed" ? "历史研究参考组合" : plan?.quality === "current" ? "当前参考组合" : "研究组合与历史参考"}>
    {plan ? <>
      <p className="text-sm">研究参考 · {plan.quality !== "current" ? "历史方案，不能用于当前行动" : plan.saved_for_observation ? "已保存观察" : "待保存"} · 非实际持仓</p>
      <p className="mt-2 break-words text-xs text-muted-foreground">历史数据截止 {plan.document.data_cutoff} · 来源最晚有效至 {plan.document.valid_until}</p>
      {plan.document.data_mode === "reconstructed" && <p className="mt-3 rounded-lg border border-amber-500/40 p-3 text-sm">探索性历史重建：保留期独立性未验证，不是当前行情或已验证盈利策略。保存只登记模型观察，仍需有效行情才能形成监测结论。</p>}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">{plan.document.targets.map(target => <article key={target.listing_id} className="min-w-0 rounded-xl border p-4">
        <div className="flex justify-between gap-3"><div className="min-w-0"><h3 className="break-words font-medium">{target.name}</h3><p className="mt-1 text-xs text-muted-foreground">{target.symbol} · {marketLabels[target.market]} · {target.currency}</p></div><span className="shrink-0 font-mono font-semibold">{formatResearchPercent(target.weight)}</span></div>
        <p className="mt-2 text-sm">{target.role}</p><p className="mt-2 text-xs text-muted-foreground">{target.overlap_summary}</p>
      </article>)}</div>
      <p className="mt-4 text-sm">{plan.document.estimated_cost}</p>
      {plan.document.risk_scenarios.map((item, index) => <p className="mt-2 break-words text-sm text-muted-foreground" key={index}>{item}</p>)}
      <p className="mt-3 break-words text-sm">基准：{plan.document.benchmark_summary}</p>
      <Button className="mt-4" disabled={disabled || plan.quality !== "current" || plan.saved_for_observation} onClick={onSave}>{plan.saved_for_observation ? "已保存为观察方案" : "保存为观察中的研究方案"}</Button>
      <details className="mt-4 text-sm"><summary className="cursor-pointer">策略依据、反对理由与未确认事项</summary><div className="mt-3 space-y-2 break-words text-muted-foreground"><p>{plan.document.strategy_evidence}</p>{[...plan.document.counterarguments, ...plan.document.uncertainties].map((item, index) => <p key={index}>{item}</p>)}</div></details>
    </> : <div className="flex min-h-36 flex-col items-start justify-center gap-3"><Eye className="h-7 w-7 text-muted-foreground" /><h3 className="font-medium">{empty?.title ?? "暂不展示确定权重"}</h3><p className="max-w-lg text-sm text-muted-foreground">{empty?.detail ?? "先比较损失情景并补齐研究证据，再形成可保存的 ETF 参考方案。不要求你先建立账本，也不以示例替代真实研究。"}</p>{empty && <p className="max-w-lg text-sm">下一步：{empty.action}</p>}</div>}
  </Card>;
}
function ResearchTask({ task: storedTask, nowMs }: { task: InvestorResearchTask; nowMs: number }) {
  const task = currentResearchDisplay(storedTask, nowMs);
  const reconstructed = task.study?.qualification === "owner_reviewed_reconstructed";
  const context = task.study?.source_context;
  const presentation = researchTaskStatus(task);
  const phaseLabels = { train: "训练期", validation: "验证期", holdout: "保留期" };
  return <Card title="后台研究进度" id="research-execution-checks"><p role="status" className="text-sm font-medium">{presentation.title}</p>
    <div aria-label="研究结论与下一步" className="mt-3 rounded-lg border border-amber-500/40 p-3 text-sm">
      <p>{presentation.detail}</p><p className="mt-2">下一步：{presentation.action}</p>
    </div>
    <p className="mt-2 text-xs text-muted-foreground">约束 v{task.profile_version} · {task.engine_version} · {task.completed_at ?? task.created_at}</p>
    <p className="mt-2 text-sm text-muted-foreground">这是研究计算任务，不是交易指令；任务完成也不代表持续监测已启用。</p>
    {task.registry && <div className="mt-3 rounded-lg border p-3 text-sm">
      <p>训练 {task.registry.phases.train.completed}/{task.registry.phases.train.registered} · 验证 {task.registry.phases.validation.completed}/{task.registry.phases.validation.registered} · 保留期 {task.registry.phases.holdout.completed}/{task.registry.phases.holdout.registered}</p>
      <p className="mt-2 text-xs text-muted-foreground">{task.registry.freeze_hash ? "候选已按训练证据冻结，后期失败不会改选。" : "尚未冻结候选。"} {task.registry.holdout_status === "previously_exposed" ? "发现与既有本地试验重叠的保留窗口，不能当作独立验证。" : "尚未独立核验保留期未曝光。"} 登记仅覆盖本工具的本地研究，不证明策略有效。</p>
    </div>}
    {task.study && <div className="mt-4 space-y-3">
      {!!task.study.phase_checks?.length && <section aria-label="已完成阶段的执行检查" className="rounded-lg border p-3 text-sm">
        <h3 className="font-semibold">冻结候选的阶段执行检查</h3>
        <ul className="mt-2 space-y-2">{task.study.phase_checks.map(row => <li key={row.phase}>
          {phaseLabels[row.phase]}：候选{row.execution_review ? "原始撤单 / 跳过 / 到期" : "执行缺口"} {row.execution_failure_count} 项，基准{row.execution_review ? "原始撤单 / 跳过 / 到期" : "执行缺口"} {row.benchmark_execution_failure_count} 项。
          {row.execution_review && <ExecutionReviewDetails review={row.execution_review} />}
        </li>)}</ul>
        <p className="mt-2 text-xs text-muted-foreground">缺口包含模拟订单跳过、到期或部署失败，不是实际交易或亏损金额。汇总不能断言具体成交失败原因；没有缺口也不等于风险检查通过。</p>
        {task.registry?.phases.holdout.registered === 0 && <p className="mt-2 text-xs text-muted-foreground">保留期尚未启动，不能显示为通过。</p>}
      </section>}
      {task.study.candidates.some(candidate => candidate.train_checks) && <section aria-label="训练候选执行检查" className="rounded-lg border p-3 text-sm">
        <h3 className="font-semibold">训练候选与基准的执行证据</h3>
        <ul className="mt-2 space-y-2">{task.study.candidates.map((candidate, index) => candidate.train_checks && <li key={candidate.parameters_hash}>
          候选 {index + 1}：候选{candidate.train_checks.execution_review ? "原始撤单 / 跳过 / 到期" : "模拟执行缺口"} {candidate.train_checks.execution_failure_count} 项，基准{candidate.train_checks.execution_review ? "原始撤单 / 跳过 / 到期" : "模拟执行缺口"} {candidate.train_checks.benchmark_execution_failure_count} 项；
          {candidate.train_checks.metrics_complete ? "训练指标已计算。" : "训练指标仍有缺失。"}
          {candidate.train_checks.execution_review && <ExecutionReviewDetails review={candidate.train_checks.execution_review} />}
        </li>)}</ul>
        <p className="mt-2 text-xs text-muted-foreground">这是已登记训练结果的只读汇总，不是实际交易失败。订单跳过、到期或部署失败都可能构成缺口，汇总不推断具体原因；提高风险预算不会修复执行缺口。</p>
      </section>}
      <p className="rounded-lg border border-amber-500/40 p-3 text-sm">{reconstructed ? "来源经所有者审阅的历史重建研究：行情可回溯，但发布时间、历史 ETF 目录及使用权限不是独立认证。候选不是实盘持仓；后台观察状态见持续观察卡。" : "合成数据软件测试，仅用于验证计算和交互，不是真实 ETF 研究或可采用的个人组合。"}{task.status === "outdated" ? " 输入已更新，以下仅保留历史证据。" : ""}</p>
      {context && <p className="text-xs text-muted-foreground">研究区间 {context.range_start} 至 {context.range_end} · 来源最晚有效至 {context.valid_until} · 采用记录的费用与税假设，非账户实扣结果。</p>}
      <h3 className="text-sm font-semibold">{task.study.status === "risk_options_ready" ? "先比较损失情景，尚未选择权重" : "训练期候选对照，不等于最终组合"}</h3>
      <p className="text-xs text-muted-foreground">以下为训练窗口的扣费后时间加权收益和最大回撤，不是未来收益预测、十年收益或最大损失保证；未通过计算的候选不能作为风险选项。</p>
      <div className="grid gap-3 lg:grid-cols-3">{task.study.candidates.map((candidate, index) => <article key={candidate.parameters_hash} className="min-w-0 rounded-xl border p-4">
        <h4 className="text-sm font-semibold">{reconstructed ? "研究候选" : "测试候选"} {index + 1}{candidate.usable ? "" : " · 证据不完整"}</h4>
        {candidate.decision_rule && <p className="mt-3 break-words text-sm text-muted-foreground">{candidate.decision_rule}</p>}
        <ul className="mt-3 space-y-1 text-sm" aria-label={`候选 ${index + 1} 配置`}>{Object.entries(candidate.weights).map(([id, weight]) => {
          const asset = context?.listings.find(value => value.listing_id === id);
          return <li key={id} className="flex justify-between gap-3"><span className="min-w-0 break-all">{asset ? `${asset.provider_symbol} · ${marketLabels[asset.market]} · ${roleLabels[asset.role]}` : id}</span><span className="shrink-0">{formatResearchPercent(weight)}</span></li>;
        })}</ul>
        <dl className="mt-3 space-y-2 text-sm"><div>训练期扣费后收益：{formatResearchPercent(candidate.train_net_twr)}</div><div>同口径基准收益：{formatResearchPercent(candidate.benchmark_net_twr)}</div><div>训练期最大回撤：{formatResearchPercent(candidate.train_drawdown)}</div></dl>
        {candidate.stresses.map(stress => <p key={stress.id} className="mt-3 break-words text-sm">假设情景「{stress.label}」：{formatResearchPercent(stress.portfolio_return)}</p>)}
        <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">权重与输入标识</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify(candidate.weights, null, 2)}</pre></details>
      </article>)}</div>
    </div>}
    <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">任务证据</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify({ request_id: task.id, input_version: task.input_version, reason_codes: task.reason_codes, result_hash: task.study?.result_hash ?? null, registry: task.registry }, null, 2)}</pre></details>
  </Card>;
}
function ModelWatch({ watch: storedWatch, disabled, onToggle, nowMs }: { watch: InvestorModelWatch; disabled: boolean; onToggle: () => void; nowMs: number }) {
  const watch = currentModelWatchDisplay(storedWatch, nowMs);
  const states = { awaiting_inputs: "观察任务已登记，等待合格行情", awaiting_evaluation: "监测输入已登记，等待后台复核", queued: "后台复核已排队", running: "后台正在复核模型",
    retrying: "复核尚未完成，等待重试", blocked: "监测证据不足，不能判断是否调整", synthetic_preview: "合成模型复核完成，仅用于软件测试",
    research_observe: "参考模型复核完成，继续观察", research_decision: "参考模型出现变化，等待你审阅",
    overdue: "复核已到期，旧结论不能继续使用", paused: "已暂停后台观察", outdated: "约束或输入已变化，等待重新复核",
    expired: "参考策略已过期，需重新研究", failed: "后台复核失败，不能当作无需调整" };
  return <Card title="持续观察"><div className="flex flex-wrap items-start justify-between gap-3"><div>
    <p role="status" className="text-sm font-medium">{states[watch.status]}</p>
    <p className="mt-2 text-xs text-muted-foreground">最后复核：{watch.completed_at ?? "尚未完成"} · 下一次：{watch.next_check_at ?? "输入更新后"}</p>
  </div><Button variant="outline" disabled={disabled} onClick={onToggle}>{watch.enabled ? "暂停观察任务" : "恢复观察任务"}</Button></div>
    {watch.acquisition && <InvestorAcquisitionPanel value={watch.acquisition} nowMs={nowMs} modelValidUntil={watch.valid_until} />}
    {watch.model_nav_cny !== null && <p className="mt-3 rounded-lg border border-amber-500/40 p-3 text-sm">{watch.source_qualification === "owner_reviewed_reconstructed" ? "历史重建参考模型估值" : "合成测试估值"} {formatResearchMoney(watch.model_nav_cny)} CNY · 归一化起点 10,000 CNY · 检查点 {watch.checkpoint_sequence}。不是你的本金、账户资产或扣费后收益。</p>}
    <p className="mt-3 text-sm text-muted-foreground">研究模型与真实账户独立；保存方案登记观察任务，不代表行情已合格。分红和拆分独立处理，计划投入和采纳建议不会自动改变持仓或生成交易。</p>
  </Card>;
}
function PolicyReview({ value }: { value: NonNullable<InvestorModelChange["policy_evaluation"]> }) {
  return <Card title="本次低频规则复核"><p className="text-sm">复核周期 {value.review_period} · {value.evaluation_timezone}。
    {value.cooldown_active ? "研究建议仍在冷却期内；新资金修复可独立复核。" : "不在研究建议冷却期内。"}</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-3">{value.class_drift.map(row => <div key={row.role} className="min-w-0 rounded-lg border p-3 text-sm">
      <p className="font-medium">{roleLabels[row.role]}资产</p><p className="mt-2">目标 {(Number(row.target_weight) * 100).toFixed(2)}% · 模型 {(Number(row.current_weight) * 100).toFixed(2)}%</p>
      <p className="mt-1">偏离 {(Number(row.difference_weight) * 100).toFixed(2)} 个百分点</p><p className="mt-1 text-xs text-muted-foreground">{row.threshold_breached ? "达到冻结类别阈值，需结合周期、冷却和成本判断" : "未达到冻结类别阈值"}</p>
    </div>)}</div><p className="mt-3 text-xs text-muted-foreground">仅核对参考模型，不证明实际持仓已调整；周期复核不强迫交易，单证券金额容差不替代类别阈值。</p></Card>;
}
function ModelChange({ change, plan }: { change: InvestorModelChange; plan: ReferencePlan | null }) {
  const small = change.changes.some(row => [row.proposed_change_cny, row.remaining_target_difference_cny].some(value => formatResearchMoneyDelta(value).includes("<")));
  return <div className="mt-4 space-y-3 rounded-xl border p-4">
    <h3 className="text-sm font-semibold">模型变化对照 · 非真实持仓</h3>
    <p className="text-xs text-muted-foreground">{change.funding_status === "hypothetical_due" ? "计划投入到复核日期，尚未确认为到账现金。" : "金额来自研究模型，不是你的账户资产。"}
      {change.allocation_method === "contribution_repair_without_sales" ? " 本次先补低配，不卖出高配资产；修复后可能仍有偏离。" : " 不构成可执行交易清单。"}</p>
    <p className="text-sm">模型估值：{formatResearchMoney(change.model_nav_cny)} CNY · 变化成本估算：{change.estimated_cost_cny === null ? "缺少证据" : formatResearchMoney(change.estimated_cost_cny) + " CNY"}</p>
    {small && <div className="rounded-lg border border-amber-500/40 p-3 text-sm" role="note">
      <p>部分模型差值小于分币显示精度，不是零。+&lt;0.01 / -&lt;0.01 表示正 / 负方向且绝对值小于 0.01 CNY。冻结容差仍按未舍入值判断，不自动放宽；这不证明值得调整或满足最小交易单位。</p>
      <details className="mt-2"><summary className="cursor-pointer">查看未舍入的模型差值</summary><ul className="mt-2 space-y-2 break-all">{change.changes.map(row => <li key={row.listing_id}>
        {plan?.targets.find(target => target.listing_id === row.listing_id)?.name ?? row.listing_id}：研究变化 {row.proposed_change_cny} CNY；剩余目标差值 {row.remaining_target_difference_cny} CNY。
      </li>)}</ul></details>
    </div>}
    <div className="grid gap-3 sm:grid-cols-2">{change.changes.map(row => <div key={row.listing_id} className="min-w-0 rounded-lg border p-3 text-sm">
      <h4 className="break-words font-medium">{plan?.targets.find(target => target.listing_id === row.listing_id)?.name ?? row.listing_id}</h4>
      <p className="mt-2">目标权重：{(Number(row.before_target_weight) * 100).toFixed(2)}% → {(Number(row.after_target_weight) * 100).toFixed(2)}%</p>
      <p className="mt-1 break-words">研究变化：{formatResearchMoneyDelta(row.proposed_change_cny)} CNY</p>
      <p className="mt-1 break-words text-xs text-muted-foreground">距理想目标仍差 {formatResearchMoneyDelta(row.remaining_target_difference_cny)} CNY；正数是低配，负数是高配。</p>
    </div>)}</div>
    <p className="text-xs text-muted-foreground">分别核对市场收盘：{Object.entries(change.market_cutoffs).map(([market, cutoff]) => `${marketLabels[market as keyof typeof marketLabels]} ${cutoff}`).join(" / ")}</p>
    <p className="text-xs text-muted-foreground">尚未验证交易单位、可交易性、真实现金、交收、税务或账户权限；采纳思路不会提交交易。</p>
  </div>;
}
function ProfileForm({ initial, disabled, onSave }: { initial: InvestorProfile | null; disabled: boolean; onSave: (profile: InvestorProfile) => void }) {
  const [markets, setMarkets] = useState(initial?.markets ?? []);
  const [budget, setBudget] = useState(initial?.illustrative_budget_cny ?? "");
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? ""), nullable = (key: string) => value(key) || null;
    const result = investorProfileSchema.safeParse({ schema_version: "investor-profile-v1", horizon_years: Number(value("horizon")),
      loss_tolerance: nullable("loss"), liquidity_need: value("liquidity"), markets,
      product_scope: "unleveraged_long_only_etfs", research_direction: nullable("direction"),
      exclusions: value("exclusions").split(/[\n,，]/).map(s => s.trim()).filter(Boolean),
      illustrative_budget_cny: nullable("budget"), planned_annual_contribution_cny: nullable("annual") });
    if (!result.success) { setError("请填写期限、流动性安排并至少选择一个市场。预算只能填写非负金额，最多两位小数。"); return; }
    setError(""); onSave(result.data);
  }
  return <form onSubmit={submit} className="space-y-5">
    <div><h2 className="text-xl font-semibold">用几个问题确定研究边界</h2><p className="mt-2 text-sm text-muted-foreground">不用先建券商账户、登记现金或上传流水。未确认的风险问题会保留为缺口，不代替你作答。</p></div>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <fieldset disabled={disabled} className="grid min-w-0 gap-4 md:grid-cols-2">
      <label className={field}>1. 预计投资多少年？<Input className="h-11" name="horizon" type="number" min="1" max="50" step="1" required defaultValue={initial?.horizon_years ?? ""} placeholder="填写投资期限" /></label>
      <label className={field}>2. 可承受的阶段性损失<select className={select} name="loss" defaultValue={initial?.loss_tolerance ?? ""}><option value="">暂不确定，先看损失情景</option>{[10, 20, 30, 40, 50].map(n => <option key={n} value={(n / 100).toFixed(2)}>约 {n}%</option>)}</select><span className="text-xs text-muted-foreground">这是研究风险预算，不保证实际回撤不会超过它。</span></label>
      <label className={field}>3. 投资期内是否需要用款？<select className={select} name="liquidity" required defaultValue={initial?.liquidity_need ?? ""}><option value="" disabled>请选择</option><option value="none_in_horizon">投资期内不动用这笔资金</option><option value="planned_withdrawal">有预计用款计划</option><option value="uncertain">暂不确定</option></select></label>
      <div className={field}><span>4. 允许研究的市场</span><div className="flex min-h-11 flex-wrap items-center gap-5">{(["CN", "HK", "US"] as const).map(market => <label key={market} className="flex items-center gap-2"><input type="checkbox" checked={markets.includes(market)} onChange={e => setMarkets(previous => e.target.checked ? [...previous, market] : previous.filter(m => m !== market))} className="h-4 w-4" />{marketLabels[market]}</label>)}</div><span className="text-xs text-muted-foreground">首版只研究非杠杆、非反向 ETF，不据此确认券商可买性。</span></div>
      <details className="rounded-xl border p-4 md:col-span-2"><summary className="cursor-pointer text-sm font-medium">可选：研究方向与排除项</summary><div className="mt-4 grid gap-4 md:grid-cols-2"><label className={field}>策略由系统设计<select className={select} name="direction" defaultValue={initial?.research_direction ?? "system_design"}><option value="system_design">由系统以组合长期扣费后回报和风险控制为目标设计</option><option value="diversified_base">以分散配置为基准，再比较优化策略</option><option value="fixed_rebalance">只研究固定配置与再平衡</option><option value="rotation">重点比较轮动策略</option><option value="">暂不确定</option></select></label><label className={field}>排除的产品或主题<Input name="exclusions" maxLength={2000} defaultValue={initial?.exclusions.join(", ") ?? ""} placeholder="使用逗号分隔，可留空" /></label></div></details>
      <details className="rounded-xl border p-4 md:col-span-2"><summary className="cursor-pointer text-sm font-medium">可选：计划投入金额，仅作示意</summary><div className="mt-4 grid gap-4 md:grid-cols-2"><label className={field}>初始研究预算（人民币）<Input name="budget" inputMode="decimal" value={budget} onChange={event => setBudget(event.target.value)} placeholder="可留空" /></label><label className={field}>计划每年追加（人民币）<Input name="annual" inputMode="decimal" defaultValue={initial?.planned_annual_contribution_cny ?? ""} placeholder="可留空" /></label></div><p className="mt-3 text-xs text-muted-foreground">金额不会决定目标权重，不写入账户余额、到账事实或盈利统计。日期化投入安排保留在账户资料中。</p></details>
    </fieldset>
    <section aria-label="阶段性损失情景" className="rounded-xl border bg-muted/30 p-4">
      <h3 className="font-medium">先看损失意味着什么，再决定风险范围</h3>
      <p className="mt-2 text-xs text-muted-foreground">下列仅是假设整个组合同时下跌的算术示意，不是策略回测、发生概率或最大损失预测。恢复幅度不计新增投入、税费、汇率与通胀；追加资金不是已亏本金的投资回报。</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{illustrateLossScenarios(budget || null).map(s => <div key={s.loss_percent} className="rounded-lg border bg-background p-3"><p className="font-semibold">组合下跌 {s.loss_percent}%</p><p className="mt-2 text-xs">需上涨 {s.recovery_gain_percent}% 才回到原值</p>{s.loss_cny !== null && <><p className="mt-2 break-all text-xs">示意损失 {s.loss_cny} CNY</p><p className="mt-1 break-all text-xs text-muted-foreground">剩余 {s.remaining_cny} CNY</p></>}</div>)}</div>
      <p className="mt-3 text-xs text-muted-foreground">可在上方可选金额中填写研究预算查看对应金额。暂不选择损失上限也可以保存偏好；系统不会据此代填风险授权。</p>
    </section>
    <div className="flex flex-wrap items-center gap-3"><Button disabled={disabled} className="h-11">保存偏好并检查研究条件<ArrowRight className="ml-2 h-4 w-4" /></Button><p className="text-xs text-muted-foreground">仅创建私有研究约束，不授权交易。</p></div>
  </form>;
}

export function InvestorWorkspace({ initial, initialSessionBinding, view = "overview", historyObservationId = null }: { initial: InvestorState; initialSessionBinding: string; view?: InvestorView; historyObservationId?: string | null }) {
  const boundary = useSessionBoundary();
  const [data, setData] = useState<InvestorState | null>(initial), [editing, setEditing] = useState(initial.profile === null);
  const [busy, setBusy] = useState(true), [hydrated, setHydrated] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [pending, setPending] = useState<{ body: string; binding: string; workspace: string | null } | null>(null);
  const alive = useRef(true), invalidated = useRef(false), generation = useRef(0);
  const accountScope = useRef(false), [accountScopeLocked, setAccountScopeLocked] = useState(false);
  const lockAccountScope = useCallback((value: boolean) => { accountScope.current = value; setAccountScopeLocked(value); }, []);
  const note = useRef<HTMLTextAreaElement>(null);
  function invalidate() { invalidated.current = true; generation.current++; setData(null); setPending(null); setError("登录状态已变化，请重新登录后查看。"); setBusy(false); }
  useEffect(() => {
    alive.current = true; setHydrated(true); setBusy(false);
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => { alive.current = false; generation.current++; window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); };
  }, []);
  useEffect(() => {
    if (!pending) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (target && !window.confirm("本次提交仍待核对。离开后请先读取最新记录，不能推定提交失败。确定离开吗？")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", beforeUnload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", navigate, true); };
  }, [pending]);
  const sessionVerified = boundary === null || (boundary.verified && boundary.sessionBinding === initialSessionBinding);
  const baseLocked = busy || !sessionVerified || !data || data.read_only || pending !== null || invalidated.current;
  const comparisonScopeLocked = !sessionVerified || !data || data.read_only || pending !== null || invalidated.current || editing || !!error;
  const locked = baseLocked || accountScopeLocked;
  async function request(init: RequestInit) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/workbench/investor", { ...init, signal: controller.signal });
      if (response.status === 401) return { response, value: null };
      const value: unknown = await response.json();
      return { response, value };
    } finally { clearTimeout(timer); }
  }
  async function load(sequence: number) {
    const { response, value } = await request({ cache: "no-store", credentials: "same-origin", redirect: "error", headers: { "X-Workbench-Session-Binding": initialSessionBinding } });
    if (response.status === 401) { invalidate(); return false; }
    if (!response.ok) throw new Error("INVESTOR_UNAVAILABLE");
    const state = parseInvestorState(value, initialSessionBinding);
    if (!alive.current || invalidated.current || generation.current !== sequence || accountScope.current) return false;
    setData(state); return true;
  }
  async function refresh(clearError = true) {
    if (busy || !sessionVerified || invalidated.current || accountScope.current) return;
    const sequence = ++generation.current; setBusy(true); if (clearError) setError("");
    try { await load(sequence); } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "INVESTOR_UNAVAILABLE"); }
    finally { if (alive.current && sequence === generation.current) setBusy(false); }
  }
  useEffect(() => {
    if (view === "observations" || busy || pending || editing || accountScopeLocked || !sessionVerified || invalidated.current) return;
    const interval = investorPollInterval(data);
    if (interval === null) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(false); }, interval);
    return () => clearInterval(timer);
  }, [view, busy, pending, editing, accountScopeLocked, sessionVerified, data?.profile?.id, data?.plan?.id, data?.revision, data?.research_task?.id, data?.research_task?.status, data?.funded_study?.id, data?.funded_study?.status, data?.model_watch?.id, data?.model_watch?.enabled, data?.model_watch?.status,
    data?.model_watch?.acquisition?.status, data?.model_watch?.acquisition?.markets.map(row => row.status).join("|")]);
  const acquisitionClockKey = [...acquisitionDeadlines(data?.model_watch?.acquisition, data?.model_watch?.valid_until),
    ...[data?.model_watch?.next_check_at, data?.plan?.document.valid_until, data?.research_task?.study?.source_context?.valid_until, data?.latest?.document.next_review_at]
      .filter((value): value is string => !!value).map(Date.parse)].join("|");
  const displayNow = useInvestorDisplayClock(data?.checked_at ?? null, acquisitionClockKey);
  const displayClock = useRef(displayNow);
  displayClock.current = Math.max(displayClock.current, displayNow);
  async function send(attempt: NonNullable<typeof pending>) {
    const sequence = ++generation.current; setBusy(true); setError(""); setNotice("");
    try {
      if (!sessionVerified || invalidated.current) return;
      const { response, value: body } = await request({ method: "POST", credentials: "same-origin", redirect: "error",
        headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": attempt.binding }, body: attempt.body });
      if (!alive.current || invalidated.current || generation.current !== sequence) return;
      if (response.status === 401) { invalidate(); return; }
      if (!response.ok) {
        if ([400, 403, 409, 413, 423].includes(response.status)) setPending(null);
        const code = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "INVESTOR_UNAVAILABLE";
        throw new Error(code);
      }
      const receipt = verifyInvestorReceipt(body, attempt);
      if (!alive.current || invalidated.current || generation.current !== sequence) return;
      setPending(null);
      const recordedTrade = receipt.action === "record_linked_trade_fact";
      const recordedCash = receipt.action === "record_linked_cash_fact";
      const requestedValuation = receipt.action === "request_linked_valuation";
      setNotice(requestedValuation ? "估值请求已受理，正在核对状态；尚不代表结果完整或可交易。" : recordedCash ? "资金回录已受理，正在核对最新状态；不是新的转账操作，重复来源可能复用原事实。" : recordedTrade ? "人工回录已受理，正在核对最新状态；系统没有下单，重复来源可能复用原事实。" : "记录已保存，正在核对最新状态；这不是成交或交易批准。");
      if (await load(sequence)) { setEditing(false); setNotice(requestedValuation ? "估值已排队；核对估值任务结束后，在下方重新核对持仓对照。只有独立复核通过的完整结果才展示净值。" : recordedCash ? "资金事实已保存或复用原记录；未发起转账或确认计划资金。请重新独立对账，并核对估值版本。" : recordedTrade ? "人工事实回录已保存或复用原记录；系统没有下单或验证券商成交。请重新独立对账，并核对估值版本。" : "记录已保存；不代表已成交或已批准交易。"); }
    } catch (e) { if (alive.current && !invalidated.current) setError(e instanceof Error ? e.message : "INVESTOR_UNAVAILABLE"); }
    finally { if (alive.current && sequence === generation.current) setBusy(false); }
  }
  function command(intent: Record<string, unknown>, fromAccounts = false) {
    if ((fromAccounts ? baseLocked : locked) || !data) return;
    if (intent.action === "review" && currentInvestorDisplay(data, Math.max(displayClock.current, Date.now())).outcome !== "decision_required") {
      setError("INVESTOR_OBSERVATION_NOT_CURRENT"); return;
    }
    if (fromAccounts) lockAccountScope(false);
    const attempt = { body: JSON.stringify({ ...intent, expected_revision: data.revision, idempotency_key: crypto.randomUUID() }),
      binding: initialSessionBinding, workspace: data.workspace_id };
    setPending(attempt); void send(attempt);
  }
  const display = data ? currentInvestorDisplay(data, displayNow) : null;
  const latest = data?.latest, profile = data?.profile, plan = display?.plan ?? null;
  const currentOutcome = display?.outcome === "not_started" ? null : display?.outcome ?? null;
  const policyReview = currentOutcome !== "insufficient_evidence" && latest?.document.model_change?.policy_evaluation
    ? <PolicyReview value={latest.document.model_change.policy_evaluation} /> : null;
  const title = view === "plan" ? "组合方案" : view === "observations" ? "观察记录" : view === "accounts" ? "账户资料" : "ETF 投资工作台";
  const riskPanel = data && <InvestorRiskPanel state={data} binding={initialSessionBinding} disabled={locked || editing} onCommand={command} />;
  const researchDetails = data && profile && <>
    <InvestorFundingPanel key={`${profile.id}:${data.funding.plan?.id ?? data.funding.status}`} state={data.funding} profile={profile}
      study={data.funded_study} studyUnavailable={data.funded_study_unavailable}
      disabled={baseLocked || editing} onCommand={intent => command(intent, true)} onEditingChange={lockAccountScope} />
    <InvestorFundedComparisonPanel state={data} binding={initialSessionBinding} disabled={baseLocked || editing} scopeLocked={comparisonScopeLocked} />
    {data.research_task && <ResearchTask task={data.research_task} nowMs={displayNow} />}
  </>;
  const evidenceGaps = display && display.gaps.length > 0 && <Card title="还缺哪些证据"><div className="grid gap-3 lg:grid-cols-2">{display.gaps.map(gap => <div key={gap.code} className="rounded-xl border p-4"><h3 className="flex items-center gap-2 text-sm font-semibold"><CircleHelp className="h-4 w-4 shrink-0 text-amber-600" />{gap.title}</h3><p className="mt-2 text-sm text-muted-foreground">{gap.detail}</p><p className="mt-3 text-xs">下一步：{gap.action}</p>{gap.affected_markets.length > 0 && <p className="mt-2 text-xs text-muted-foreground">影响：{gap.affected_markets.map(m => marketLabels[m]).join(" / ")}</p>}</div>)}</div></Card>;
  return <div inert={!hydrated} aria-busy={busy} data-hydrated={hydrated} className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[.2em] text-muted-foreground">ETF / RESEARCH & OBSERVATION</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">策略形成参考组合，系统解释变化，你决定是否在券商交易。</p></div><div className="flex flex-wrap items-center gap-3"><InvestorNotificationsPanel workspaceId={data?.workspace_id ?? null} binding={initialSessionBinding} disabled={!sessionVerified || !data || accountScopeLocked || pending !== null || invalidated.current} readOnly={data?.read_only ?? true} revision={data?.revision ?? 0} />{view !== "observations" && <Button variant="outline" disabled={busy || accountScopeLocked || !sessionVerified || invalidated.current} onClick={() => void refresh()}>刷新状态</Button>}<span className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs"><ShieldCheck className="h-4 w-4" />研究模式 · 不自动交易</span></div></header>
    <nav aria-label="工作台主导航" className="flex gap-1 overflow-x-auto rounded-xl border bg-muted/40 p-1">{([["overview", "/workbench", "总览"], ["plan", "/workbench/plan", "组合方案"], ["observations", "/workbench/observations", "观察记录"], ["accounts", "/workbench/accounts", "账户资料"]] as const).map(([key, href, label]) => <Link key={key} href={href} aria-current={view === key ? "page" : undefined} className={`shrink-0 rounded-lg px-3 py-2.5 text-sm sm:px-4 ${view === key ? "bg-background font-semibold shadow-sm" : "text-muted-foreground hover:bg-background"}`}>{label}</Link>)}</nav>
    {error && <div role="alert" className="break-words rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm">{errorLabels[error] ?? "操作未完成，请重新核对研究记录。"}</div>}
    {notice && <div role="status" className="rounded-xl border p-4 text-sm">{notice}</div>}
    {data?.read_only && <div role="status" className="rounded-xl border border-amber-500/40 p-4 text-sm">恢复只读模式：可查看证据，暂不能保存偏好、复核或记录决定。</div>}
    {plan?.document.data_mode === "synthetic" && <div role="status" className="rounded-xl border border-amber-500/40 p-4 text-sm">合成数据测试方案，仅验证软件流程，不是真实 ETF 研究、持仓或投资建议。</div>}
    {pending && <Card title="这次提交仍待核对"><p className="text-sm">可能已经保存，不能因响应丢失创建另一条记录。重试会发送相同请求，不重复执行。</p><div className="mt-3 flex flex-wrap gap-3"><Button disabled={busy} onClick={() => void send(pending)}>核对并重试原请求</Button><Button variant="outline" disabled={busy} onClick={() => void refresh()}>只读取最新记录</Button></div></Card>}
    {!data && <Card title="研究资料暂不可显示"><p className="text-sm text-muted-foreground">请重新登录并核对工作区。当前没有从缓存推断投资结论。</p><Link href="/login" className="mt-4 inline-block underline">前往登录</Link></Card>}
    {data && view === "accounts" ? <InvestorAccountWorkspace state={data} binding={initialSessionBinding} disabled={baseLocked} onCommand={intent => command(intent, true)} onScopeLockChange={lockAccountScope} /> : data && <>
      {(editing || !profile) && view !== "observations" && <section className={panel}><ProfileForm key={profile?.id ?? "first"} initial={profile?.document ?? null} disabled={locked} onSave={document => command({ action: "save_profile", profile: document })} /></section>}
      {view !== "observations" && profile && <>
        <section className={`min-w-0 rounded-2xl border p-5 md:p-7 ${currentOutcome === "decision_required" ? "border-blue-500/30 bg-blue-500/5" : currentOutcome === "observe" ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5"}`}>
          <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm text-muted-foreground">今天的研究结论</p><h2 className="mt-2 text-2xl font-semibold">{currentOutcome ? labels[currentOutcome] : "等待首次评估"}</h2><p className="mt-2 max-w-3xl text-sm">{(currentOutcome === "insufficient_evidence" && (display?.stale || latest?.document.outcome !== "insufficient_evidence") ? display?.gaps[0]?.detail : display?.researchBlocker?.detail ?? latest?.document.reasons[0]) ?? "尚无可复核的研究评估，不能据此判断是否需要调整。"}</p></div>
            {display?.researchBlocker ? <Button asChild variant="outline" className="h-11"><Link href="/workbench/plan#research-execution-checks">查看研究检查</Link></Button>
              : <Button variant="outline" disabled={locked} onClick={() => command({ action: "evaluate" })}>重新检查研究条件</Button>}
          </div>
          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 border-t pt-4 text-xs text-muted-foreground"><span>研究参考 · 非实际持仓</span><span>{latest?.document.data_cutoff ? `数据截止：${latest.document.data_cutoff}` : data.research_task?.study?.source_context ? `历史研究截止：${data.research_task.study.source_context.range_end}（非当前行情）` : "数据截止：尚无合格数据"}</span><span>约束版本：{profile.version}</span><span>币种：人民币为研究预算口径</span></div>
        </section>
        {currentOutcome === "decision_required" && latest && <Card title="变化卡 · 决定由你作出"><p className="text-sm">仅记录你的审阅意见，不批准交易、不预占资金，也不代表成交。</p>{latest.document.model_change && <ModelChange change={latest.document.model_change} plan={plan?.document ?? null} />}{plan && <div className="mt-3 space-y-2 text-sm"><p>成本：{plan.document.estimated_cost}</p>{plan.document.counterarguments.map((s, i) => <p key={i}>反对理由：{s}</p>)}</div>}<label className="mt-4 flex flex-col gap-2 text-sm">审阅备注（可选）<textarea ref={note} maxLength={2000} className="min-h-20 rounded-lg border bg-background p-3" /></label><div className="mt-4 flex flex-wrap gap-3">{(["accept_idea", "defer", "reject"] as const).map(decision => <Button key={decision} variant={decision === "accept_idea" ? "default" : "outline"} disabled={locked} onClick={() => command({ action: "review", observation_id: latest.id, decision, note: note.current?.value ?? "" })}>{decisionLabels[decision]}</Button>)}</div></Card>}
        {view !== "overview" && policyReview}
        {view === "overview" ? evidenceGaps : riskPanel}
        <ReferencePlanCard plan={plan} task={display?.researchTask ?? null} disabled={locked} onSave={() => plan && command({ action: "save_plan", plan_id: plan.id })} />
        {view === "overview" ? <details data-testid="overview-research-details" className="min-w-0 rounded-2xl border bg-card shadow-sm">
          <summary className="cursor-pointer rounded-2xl p-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring md:p-6">
            <span className="font-semibold">风险、投入与研究详情</span>
            <span className="mt-2 block text-sm text-muted-foreground">{profile.document.loss_tolerance ? "已记录损失承受范围" : "风险范围尚未确认"} · 按需展开，或前往组合方案查看完整研究</span>
          </summary>
          <div className="flex min-w-0 flex-col gap-6 p-3 pt-0 md:p-5 md:pt-0">{policyReview}{riskPanel}{researchDetails}</div>
        </details> : researchDetails}
        {data.model_watch && <ModelWatch watch={data.model_watch} nowMs={displayNow} disabled={locked || !data.model_watch.enabled && !canResumeInvestorWatch(data, displayNow)}
          onToggle={() => command({ action: "set_monitoring", model_id: data.model_watch!.id, enabled: !data.model_watch!.enabled })} />}
        {view !== "overview" && evidenceGaps}
        <div className="grid gap-6 lg:grid-cols-2"><Card title="你的研究边界"><dl className="space-y-3 text-sm"><div className="flex justify-between gap-3"><dt className="text-muted-foreground">投资期限</dt><dd>{profile.document.horizon_years} 年</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">损失承受范围</dt><dd>{profile.document.loss_tolerance ? `约 ${Number(profile.document.loss_tolerance) * 100}%` : "尚未确认"}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">研究市场</dt><dd>{profile.document.markets.map(m => marketLabels[m]).join(" / ")}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">计划初始预算</dt><dd>{profile.document.illustrative_budget_cny ? `${profile.document.illustrative_budget_cny} CNY（非现金）` : "未填写"}</dd></div></dl><Button className="mt-4" variant="outline" disabled={locked} onClick={() => setEditing(value => !value)}>{editing ? "收起编辑" : "修改研究偏好"}</Button></Card>
          <Card title="下一次复核"><div className="flex items-start gap-3"><Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" /><div className="space-y-2 text-sm">{display?.stale ? <><p role="status">已知期限已到，等待核对新评估。请刷新状态；旧观察仅作历史记录。</p><p className="text-xs text-muted-foreground">没有成功核对的新结果，不代表后台已完成复核或无需调整。</p></> : <>{display?.researchBlocker ? <p>{display.researchBlocker.action}</p> : latest?.document.next_conditions.map((condition, i) => <p key={i}>{condition}</p>)}<p className="text-xs text-muted-foreground">{latest?.document.monitoring === "active" ? `持续监测 · ${latest.document.next_review_at ?? "等待数据更新"}` : "持续监测尚未启用，不把手动检查当作后台已运行。"}</p></>}</div></div></Card>
        </div>
        <Card title="策略解释与反证"><div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm">规则结论由确定性核验产生；AI 仅提供单独标注的解释与反证，不生成价格或替你批准交易。</p>{display?.stale && <p role="status" className="mt-3 text-sm">当前观察已到期，停止展示旧 AI 正文与生成入口；刷新并核对新观察后再请求解释。</p>}<InvestorAiPanel state={data} binding={initialSessionBinding} disabled={locked || editing || !!display?.stale} /><details className="mt-4 text-sm"><summary className="cursor-pointer">查看已记录输入版本与历史证据</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify({ profile_hash: profile.content_hash, observation: latest }, null, 2)}</pre></details></div></div></Card>
      </>}
      {view === "observations" && <InvestorHistoryPanel workspaceId={data.workspace_id} binding={initialSessionBinding} disabled={!sessionVerified || pending !== null || invalidated.current} observationId={historyObservationId} />}
      {view === "overview" && profile && <Card title="最近观察">{data.observations.length === 0 ? <p className="text-sm text-muted-foreground">尚无观察记录。先保存研究偏好，不需要创建真实账户。</p> : <div className="space-y-3">{data.observations.slice(0, 3).map(row => <article key={row.id} id={`research-observation-${row.id}`} className="rounded-xl border p-4"><div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-semibold">{labels[row.document.outcome]}</h3><time className="text-xs text-muted-foreground">{row.document.evaluated_at}</time></div><p className="mt-2 text-sm text-muted-foreground">{row.document.reasons[0]}</p><p className="mt-2 text-xs text-muted-foreground">约束 v{row.document.profile_version} · 数据截止 {row.document.data_cutoff ?? "未知"}</p>{data.decisions.filter(decision => decision.observation_id === row.id).map(decision => <p key={decision.id} className="mt-3 border-t pt-3 text-sm">你的决定：{decisionLabels[decision.decision]} · {decision.note || "无备注"} <span className="text-xs text-muted-foreground">（审阅记录，非成交）</span></p>)}</article>)}</div>}<p className="mt-3 text-xs text-muted-foreground">总览只展示近期摘要与部分决定，完整历史请进入观察归档。</p><Link className="mt-4 inline-block text-sm underline" href="/workbench/observations">查看观察归档</Link></Card>}
    </>}
    <footer className="flex flex-wrap justify-between gap-3 border-t pt-4 text-xs text-muted-foreground"><span>研究参考、实际持仓和可执行待审结果分开。投资不保证持续盈利。</span><Link href="/workbench/ledger" className="underline">高级账本与运营入口</Link></footer>
  </div>;
}
