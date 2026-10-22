"use client";

import React, { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { InvestorState } from "@/server/investor/types";
import { LOSS_LEVELS } from "@/server/investor/loss-scenarios";
import { projectRiskScenario } from "@/server/investor/risk-scenarios";
import { currentRiskCandidates, investorRiskIdentity, riskBudgetIntent, riskIllustrationCapital } from "./investor-risk-client";
import { formatResearchMoney, formatResearchPercent } from "./research-format";
import { useInvestorDisplayClock } from "./investor-display-clock";

function Scenario({ rate, capital, label }: { rate: string; capital: string | null; label: string }) {
  let row: ReturnType<typeof projectRiskScenario>;
  try { row = projectRiskScenario(rate, capital); }
  catch { return <div className="rounded-lg border p-3 text-sm"><p className="break-words font-medium">{label}</p><p className="mt-2">情景比例未通过核对，不展示金额结果。</p></div>; }
  return <div className="min-w-0 rounded-lg border p-3 text-sm"><p className="break-words font-medium">{label}</p>
    <p className="mt-2">组合比例变化 {formatResearchPercent(row.portfolio_return)}</p>
    {row.change_cny !== null && <><p className="mt-2 break-words">假设金额变动 {formatResearchMoney(row.change_cny)} CNY</p>
      <p className="mt-1 break-words text-muted-foreground">剩余 {formatResearchMoney(row.remaining_cny)} CNY</p></>}
    <p className="mt-2 text-xs text-muted-foreground">{row.recovery_gain === null ? "本金全损时，比例恢复幅度无定义。" : row.recovery_gain === "0" ? "未发生比例损失，无需恢复涨幅。" : `需上涨 ${formatResearchPercent(row.recovery_gain)} 才回到冲击前金额（不计追加与成本）。`}</p>
  </div>;
}

export function InvestorRiskPanel({ state, binding, disabled, onCommand }: {
  state: InvestorState; binding: string; disabled: boolean; onCommand: (intent: Record<string, unknown>) => void;
}) {
  const identity = investorRiskIdentity(state, binding), capital = riskIllustrationCapital(state), submitted = useRef(false);
  const [draft, setDraft] = useState({ identity, amount: capital ?? "", choice: "", acknowledged: false });
  const [error, setError] = useState(""), [sending, setSending] = useState(false);
  const until = state.research_task?.study?.source_context?.valid_until;
  const now = useInvestorDisplayClock(state.checked_at, until ? String(Date.parse(until)) : "");
  const currentDraft = draft.identity === identity ? draft : { identity, amount: capital ?? "", choice: "", acknowledged: false };
  useEffect(() => { setDraft({ identity, amount: capital ?? "", choice: "", acknowledged: false }); setError(""); setSending(false); submitted.current = false; }, [identity, capital]);
  // The parent stays locked for uncertain submissions; a definitive rejection unlocks retry.
  useEffect(() => { if (sending && !disabled) { setSending(false); submitted.current = false; } }, [disabled, sending]);
  if (!state.profile) return null;
  const amountValid = currentDraft.amount === "" || /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/.test(currentDraft.amount);
  const amount = amountValid && currentDraft.amount !== "" ? currentDraft.amount : null;
  const study = currentRiskCandidates(state, now);
  function update(change: Partial<Omit<typeof draft, "identity">>) { setDraft({ ...currentDraft, ...change }); setError(""); }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || sending || submitted.current || !amountValid) return;
    try {
      const intent = riskBudgetIntent(state, binding, currentDraft.identity, currentDraft.choice, currentDraft.acknowledged);
      submitted.current = true; setSending(true); setError(""); onCommand(intent);
    } catch { setError("请明确选择与当前记录不同的预算，并确认你理解它不是损失保证。"); }
  }
  return <section className="min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6" aria-labelledby="risk-review-title">
    <h2 id="risk-review-title" className="text-lg font-semibold">先看可能损失，再确认研究风险预算</h2>
    <p className="mt-2 text-sm">当前：{state.profile.document.loss_tolerance === null ? "尚未确认；系统不替你选择权重。" : `已记录 ${formatResearchPercent(state.profile.document.loss_tolerance)} 的研究预算；可在此重新核对。`}</p>
    <p className="mt-2 text-sm text-muted-foreground">不是止损承诺或损失上限。实际亏损可能更大；历史回撤、算术冲击与真实账户亏损分开。</p>
    {study?.candidates.length && study.candidates.every(candidate => !candidate.usable) ? <p className="mt-3 rounded-lg border border-amber-500/40 p-3 text-sm">当前候选的训练或基准证据不完整。先核对研究进度中的执行检查；不要仅为得到组合而提高风险预算。</p> : null}
    <label className="mt-4 flex max-w-md flex-col gap-2 text-sm">用于理解损失的假设组合金额（CNY，可留空）
      <Input inputMode="decimal" value={currentDraft.amount} disabled={disabled || sending} onChange={event => update({ amount: event.target.value })} />
      <span className="text-xs text-muted-foreground">{capital !== null ? "初始值来自当前计划的初始本金或示意预算，不加未来年度追加；可改作本次算术示意。" : "没有自动推定你的资产或投入金额；留空只看比例。"} 这里的编辑不保存金额、不改变资金计划或账户。</span>
    </label>
    {!amountValid && <p role="alert" className="mt-2 text-sm text-red-700">金额须为非负数，最多十二位整数、两位小数；当前不展示错误金额结果。</p>}
    <details className="mt-4" open={state.profile.document.loss_tolerance === null}><summary className="cursor-pointer text-sm font-medium">全组合下跌的通用算术情景（不是策略结果）</summary>
      <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-5">{LOSS_LEVELS.map(loss => <Scenario key={loss} rate={`-${(loss / 100).toFixed(2)}`} capital={amount} label={`假设下跌 ${loss}%`} />)}</div>
    </details>
    {study && <div className="mt-5 space-y-3"><h3 className="text-sm font-semibold">已登记候选的风险对照</h3>
      <p className="text-xs text-muted-foreground">{study.qualification === "synthetic_test_only" ? "合成数据软件测试，不是真实 ETF 研究。" : "所有者审阅的历史重建，来源/历史发布时间及许可未独立认证。"} 登记顺序不是收益排名；未通过候选仍保留。</p>
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">{study.candidates.map((candidate, index) => <article key={candidate.parameters_hash} className="min-w-0 rounded-xl border p-4">
        <h4 className="font-medium">登记候选 {index + 1} · {candidate.usable ? "训练计算可用，非策略准入" : "训练或基准有缺口，不能作为合格候选"}</h4>
        {candidate.train_drawdown !== null && <div className="mt-3"><Scenario rate={candidate.train_drawdown} capital={amount} label="将训练期单位最大回撤比例套用到假设金额" />
          <p className="mt-2 text-xs text-muted-foreground">不是原历史峰值的金额亏损、未来回撤上限或完整投入期表现。</p></div>}
        {candidate.stresses.length > 0 && <details className="mt-3"><summary className="cursor-pointer text-sm">冻结角色冲击情景</summary><div className="mt-2 space-y-2">{candidate.stresses.map(shock => <Scenario key={shock.id} rate={shock.portfolio_return} capital={amount} label={shock.label} />)}</div></details>}
      </article>)}</div>
      <p className="text-xs text-muted-foreground">角色冲击是输入中的人为假设，不含完整底层外汇穿透、概率、费用、税务或期间再平衡。失效来源不继续显示；完整多年联合压力与滚动风险仍需研究。</p>
    </div>}
    {!study && <p className="mt-4 rounded-lg border border-amber-500/30 p-3 text-sm">尚无当前有效的候选风险证据。上方只有算术示意，确认预算不会使数据或策略自动合格。</p>}
    <form className="mt-5 border-t pt-4" onSubmit={submit}><fieldset disabled={disabled || sending} className="min-w-0 space-y-4">
      <legend className="text-sm font-medium">你愿意用于后续研究筛选的阶段性损失预算</legend>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">{LOSS_LEVELS.map(loss => { const choice = (loss / 100).toFixed(2); return <label key={choice} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm">
        <input type="radio" name="risk-budget" value={choice} checked={currentDraft.choice === choice} onChange={() => update({ choice, acknowledged: false })} />约 {loss}%</label>; })}</div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={currentDraft.acknowledged} onChange={event => update({ acknowledged: event.target.checked })} />
        <span>我理解这是研究约束，不保证回撤不超过它，也不授权交易；无合格候选时应保持证据不足，而不是替我提高预算。</span></label>
      <p className="text-xs text-muted-foreground">确认只更新风险答案，并按新偏好重新排队研究。旧方案/观察绑定不升级，已有投入安排需重新核对；不自动选取候选或改变真实持仓。</p>
      {error && <p role="alert" className="text-sm">{error}</p>}
      <div className="flex flex-wrap gap-3"><Button type="submit" disabled={!currentDraft.choice || !currentDraft.acknowledged || !amountValid || currentDraft.choice === state.profile.document.loss_tolerance}>{sending ? "正在核对保存…" : "确认风险预算并重新研究"}</Button>
        <Button type="button" variant="outline" onClick={() => update({ choice: "", acknowledged: false })}>{state.profile.document.loss_tolerance === null ? "暂不确定，保持未确认" : "取消本次选择，保持原预算"}</Button></div>
    </fieldset></form>
  </section>;
}
