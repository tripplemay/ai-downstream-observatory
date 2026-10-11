"use client";

import React, { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fundingPlanSchema, type InvestorFundingPlan, type InvestorFundingState } from "@/server/investor/funding-schemas";
import type { InvestorProfileVersion } from "@/server/investor/types";
import type { FundedStudyTask } from "@/server/investor/funded-study-schemas";

const studyLabels = { queued: "已登记，等待后台处理", running: "正在比较所有冻结候选", retrying: "正在重试，保留原尝试记录",
  blocked: "长期比较条件尚未满足", calculated_unverified: "后台计算完成，等待独立经济核验", failed: "本次比较失败，未发布收益结论", outdated: "偏好、投入计划或来源已变化，旧任务不再适用" };
const gapLabels: Record<string, string> = { FUNDED_STUDY_REVIEWED_SOURCE_REQUIRED: "需要已审阅的真实研究来源；零散行情和合成测试不够。",
  FUNDED_STUDY_LIQUIDITY_REVIEW_REQUIRED: "投资期内的用款安排尚需核对，不能套用只投入不取款的比较。",
  FUNDED_STUDY_EXCLUSIONS_REQUIRE_QUALIFIED_UNIVERSE: "产品排除项需要先绑定合格目录，不会忽略你的排除要求。",
  FUNDED_STUDY_UNIVERSE_OUTSIDE_ALLOWED_MARKETS: "来源含有未获允许的市场，不自动扩大研究范围。",
  FUNDED_STUDY_HORIZON_OUTSIDE_STRATEGY_SCOPE: "你的投资期限不符合冻结策略的适用范围，需要另行研究。",
  FUNDED_STUDY_ENHANCEMENT_EVIDENCE_REQUIRED: "轮动研究证据尚未就绪，不把固定配置比较当成已完成轮动策略。",
  FUNDED_STUDY_FULL_HORIZON_NOT_COVERED: "历史资料不足以覆盖整段投入期限；不会截短期限或拼接重启账户。",
  FUNDED_STUDY_TIMEZONE_CONFLICT: "投入计划与冻结策略的日历时区不同，需要核对后再比较。",
  FUNDED_STUDY_FIXED_POLICY_V2_REQUIRED: "来源尚未包含完整的低频策略候选，不套用旧规则。",
  FUNDED_STUDY_DUPLICATE_CANDIDATES: "冻结候选有重复，需重新核对研究登记。",
  FUNDED_STUDY_INPUT_UNSUPPORTED: "冻结来源或资金路径未通过连续计算的输入检查。",
  FUNDED_STUDY_ECONOMIC_REPLAY_REQUIRED: "尚未完成独立经济重放，暂不展示财富路径、收益或排名。",
  FUNDED_STUDY_CANDIDATE_FAILED: "至少一项候选未完成计算，不能只留下成功或高收益候选。",
  FUNDED_STUDY_BINDING_CHANGED: "请按当前偏好、投入计划和有效来源重新登记比较。",
  REFERENCE_SOURCE_EXPIRED: "来源已过期，需要新的有效资料。", REFERENCE_SOURCE_NO_LONGER_CURRENT: "来源已更新或撤回，不继续使用旧输入。",
  REFERENCE_SOURCE_PAYLOAD_PURGED: "来源载荷已按保留规则删除，不恢复旧价格。" };

export function InvestorFundingPanel({ state, profile, disabled, onCommand, onEditingChange, study = null, studyUnavailable = false }: {
  state: InvestorFundingState; profile: InvestorProfileVersion; disabled: boolean;
  onCommand: (intent: Record<string, unknown>) => void; onEditingChange: (editing: boolean) => void;
  study?: FundedStudyTask | null; studyUnavailable?: boolean;
}) {
  const [editing, setEditing] = useState(false), [error, setError] = useState("");
  const [draft, setDraft] = useState<InvestorFundingPlan | null>(null);
  useEffect(() => { onEditingChange(editing); return () => onEditingChange(false); }, [editing, onEditingChange]);
  const document = state.plan?.document;
  const formDocument = draft ?? document;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled) return;
    const form = new FormData(event.currentTarget), annual = String(form.get("annual") ?? "");
    const parsed = fundingPlanSchema.safeParse({ schema_version: "investor-funding-plan-v1",
      start_date: String(form.get("start") ?? ""), horizon_years: Number(form.get("horizon")),
      evaluation_timezone: String(form.get("timezone")), initial_capital_cny: String(form.get("initial") ?? ""),
      annual_contribution_cny: annual, first_annual_date: /^0(?:\.0{1,2})?$/.test(annual) ? null : String(form.get("first") ?? ""),
      entry_method: String(form.get("entry")), actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false });
    if (!parsed.success || parsed.data.horizon_years > profile.document.horizon_years) {
      setError("请核对金额、真实日历日期和投资期限。首笔年度追加须位于计划期内；分三批时每笔至少 0.03 元。闰日不能静默改成其他年度日期。"); return;
    }
    setError(""); setDraft(parsed.data); setEditing(false); onCommand({ action: "save_funding_plan", funding_plan: parsed.data });
  }
  const field = "flex min-w-0 flex-col gap-2 text-sm", select = "h-11 w-full rounded-lg border bg-background px-3";
  return <section className="min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6" aria-labelledby="funding-plan-title">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="funding-plan-title" className="font-semibold">长期投入安排</h2>
      <p className="mt-2 text-sm text-muted-foreground">可选的私有研究计划，不需要先建账户；预计到账不是账户现金，也不是收益。</p></div>
      {state.status !== "unavailable" && <Button variant="outline" disabled={disabled} onClick={() => { setError(""); setEditing(value => !value); }}>{editing ? "取消编辑" : document ? "修改投入安排" : "填写投入安排"}</Button>}</div>
    {state.status === "unavailable" && <p role="alert" className="mt-4 text-sm">投入记录未通过证据核验，暂不展示或覆盖；其他研究资料仍可使用。</p>}
    {state.status === "requires_review" && <p role="status" className="mt-4 text-sm text-amber-700">研究约束已更新。这是旧版投入计划，需重新核对保存，不自动沿用为当前研究输入。</p>}
    {document && !editing && <div className="mt-4 space-y-3 text-sm">
      <p>计划期：{document.start_date} 至 {state.plan!.timeline.horizon_end_exclusive}（不含结束日） · {document.evaluation_timezone}</p>
      <p className="break-words">计划本金合计：{state.plan!.timeline.total_planned_principal_cny} CNY · {document.entry_method === "immediate" ? "到账日全部释放为研究可用资金" : "每笔按第 0 / 30 / 60 个自然日分三批释放"}</p>
      <details><summary className="cursor-pointer">查看 {state.plan!.timeline.lots.length} 笔计划到账及批次</summary><div className="mt-3 space-y-3">{state.plan!.timeline.lots.map(lot => <article key={lot.lot_id} className="rounded-lg border p-3">
        <p className="break-words">{lot.lot_id === "initial" ? "初始计划" : "年度追加"}：{lot.arrival_date} · {lot.amount_cny} CNY</p>
        {lot.tranches.map(tranche => <p key={tranche.release_date} className="mt-1 break-words text-xs text-muted-foreground">{tranche.release_date} · {tranche.amount_cny} CNY{tranche.within_horizon ? "" : "（释放日在计划期外）"}</p>)}
      </article>)}</div></details>
      <p className="text-xs text-muted-foreground">只列计划本金，没有预测收益。批次释放不等于买入成交，60 日不是成交保证。历史比较不代表预期收益，也不会替你选择权重或交易。</p>
      <Button variant="outline" disabled={disabled || state.status !== "planned" || studyUnavailable || !!study && ["queued", "running", "retrying"].includes(study.status)}
        onClick={() => onCommand({ action: "compare_funding" })}>比较及时投入与有限分期</Button>
      <p className="text-xs text-muted-foreground">自动绑定当前偏好、投入版本与审阅来源；只按完整日历覆盖选历史窗口，不按收益选起点。</p>
    </div>}
    {studyUnavailable && <p role="alert" className="mt-4 text-sm">投入比较记录未通过证据核验，暂不展示或覆盖；其他研究功能不受影响。</p>}
    {study && !editing && <div role="status" className="mt-4 space-y-2 rounded-xl border p-4 text-sm">
      <p className="font-medium">{studyLabels[study.status]}</p>
      <p className="text-xs text-muted-foreground">登记于 {study.created_at} · {study.candidate_count} 项冻结候选{study.historical_start_date && study.status !== "outdated" ? ` · 历史起点 ${study.historical_start_date}` : ""}</p>
      {study.reason_codes.map(code => <p key={code}>{gapLabels[code] ?? "本次输入或后台任务需要复核，未发布收益结论。"}</p>)}
      <p className="text-xs text-muted-foreground">仅登记回顾性探索，不冒充过去预注册的试验；不确认实际到账，不写入账户现金或真实持仓。</p>
    </div>}
    {!document && state.status === "not_configured" && !editing && <p className="mt-4 text-sm text-muted-foreground">尚未填写，不影响先研究参考组合；系统不会从其他资料推定你的到账日期。</p>}
    {editing && <form onSubmit={submit} className="mt-4"><fieldset disabled={disabled} className="grid min-w-0 gap-4 md:grid-cols-2">
      <label className={field}>计划开始日期<Input name="start" type="date" required defaultValue={formDocument?.start_date ?? ""} /></label>
      <label className={field}>投入研究期限（年）<Input name="horizon" type="number" min="1" max={Math.min(10, profile.document.horizon_years)} step="1" required defaultValue={formDocument?.horizon_years ?? Math.min(10, profile.document.horizon_years)} /><span className="text-xs text-muted-foreground">当前连续资金研究上限 10 年，且不超过你的投资期限。</span></label>
      <label className={field}>初始计划本金（人民币）<Input name="initial" inputMode="decimal" required defaultValue={formDocument?.initial_capital_cny ?? profile.document.illustrative_budget_cny ?? ""} /></label>
      <label className={field}>每年计划追加（人民币，无追加填 0）<Input name="annual" inputMode="decimal" required defaultValue={formDocument?.annual_contribution_cny ?? profile.document.planned_annual_contribution_cny ?? ""} /></label>
      <label className={field}>第一次年度追加日期<Input name="first" type="date" defaultValue={formDocument?.first_annual_date ?? ""} /><span className="text-xs text-muted-foreground">此后每年同月同日；年度金额为 0 时不使用此日期。</span></label>
      <label className={field}>计划日历时区<select name="timezone" className={select} defaultValue={formDocument?.evaluation_timezone ?? "Asia/Shanghai"}>{[...new Set(["Asia/Shanghai", "Asia/Hong_Kong", "America/New_York", ...(formDocument ? [formDocument.evaluation_timezone] : [])])].map(zone => <option key={zone}>{zone}</option>)}</select></label>
      <label className={`${field} md:col-span-2`}>资金进入路径<select name="entry" className={select} defaultValue={formDocument?.entry_method ?? "immediate"}><option value="immediate">到账后及时投入研究</option><option value="three_tranches_60_days">预定三批，60 个自然日内全部释放</option></select><span className="text-xs text-muted-foreground">两种路径均不是买点预测；保存不授权交易，也不改变参考权重或模型 NAV。</span></label>
      {error && <p role="alert" className="text-sm text-red-700 md:col-span-2">{error}</p>}
      <div className="md:col-span-2"><Button type="submit">保存私有投入计划</Button></div>
    </fieldset></form>}
  </section>;
}
