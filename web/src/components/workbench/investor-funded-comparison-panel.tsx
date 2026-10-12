"use client";

import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { InvestorState } from "@/server/investor/types";
import type { FundedComparison } from "@/server/investor/funded-comparison-schemas";
import { fundedComparisonIdentity, parseFundedComparison } from "./investor-funded-comparison-client";
import { InvestorFundedAnalysisPanel } from "./investor-funded-analysis-panel";
import { useInvestorDisplayTime } from "./investor-display-clock";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";

const money = (value: string) => Number.isFinite(Number(value)) ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : "无法显示";
const percent = (value: string | null) => value === null ? "无法可靠计算" : Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : "无法显示";
const role = { growth: "增长", defensive: "防御", diversifier: "分散" };
const gaps: Record<string, string> = { FUNDED_COMPARISON_LEGACY_DIGEST_ONLY: "旧任务仅留存摘要，请重新登记比较。",
  FUNDED_COMPARISON_PAYLOAD_PURGED: "结果已按留存规则清理，不能恢复旧结果。", FUNDED_COMPARISON_REPLAY_FAILED: "独立核验未通过，未显示收益。",
  FUNDED_STUDY_CANDIDATE_FAILED: "该候选计算失败，未从比较中删去。", FUNDED_STUDY_EXECUTION_GAPS: "模拟成交或交收存在缺口，不能作为完整策略结论。" };

export function FundedComparisonResults({ value, binding }: { value: FundedComparison; binding?: string }) {
  return <div className="mt-4 space-y-4">
    <p className="text-sm">以下是回顾性重建研究，不是实际账户收益或未来预测。已核验经济字段，不代表来源已独立认证、策略有效或可直接交易。</p>
    {value.status === "partial" && <p role="alert" className="text-sm text-amber-700">部分候选失败或有执行缺口，全部登记候选仍列在下方；没有只挑收益好的结果。</p>}
    {value.candidates.map((candidate, index) => <article key={candidate.parameters_hash} className="min-w-0 rounded-xl border p-4">
      <h3 className="font-medium">冻结候选 {index + 1} · {candidate.rebalance === "first_decision_each_year" ? "年度" : "半年度"}复核</h3>
      <p className="mt-2 text-xs text-muted-foreground">序号按参数哈希排列，不是收益排名；新增资金优先补低配，不因每次追加卖出。</p>
      <details className="mt-3 text-sm"><summary className="cursor-pointer">查看研究 ETF 配置（非推荐或真实持仓）</summary><ul className="mt-2 space-y-1">{candidate.allocation.map(item => <li key={item.asset_id} className="break-words">{item.symbol} · {role[item.role]} · {percent(item.weight)} · {item.currency}</li>)}</ul></details>
      {candidate.reason_code && <p role="status" className="mt-3 text-sm">{gaps[candidate.reason_code] ?? "该候选需要复核，不能作为完整策略结论。"}</p>}
      {candidate.paths && <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-2">{(["immediate", "staged"] as const).map(path => {
        const p = candidate.paths![path];
        return <section key={path} className="min-w-0 rounded-lg bg-muted/40 p-4"><h4 className="text-sm font-semibold">{path === "immediate" ? "到账及时释放" : "预定三批释放（0 / 30 / 60 日）"}</h4>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            {[["假设累计本金", `${money(p.principal_cny)} CNY`], ["期末净资产", `${money(p.ending_nav_cny)} CNY`],
              ["扣已识别成本后的盈亏", `${money(p.profit_cny)} CNY`], ["期末待释放现金", `${money(p.ending_locked_cash_cny)} CNY`],
              ["时间加权收益 TWR", percent(p.twr)], ["单位净值年化", percent(p.annualized_unit_return)],
              ["资金加权年化 XIRR", p.xirr.status === "ok" ? percent(p.xirr.rate) : "无法可靠计算"],
              ["单位净值最大回撤", percent(p.max_drawdown)], ["期末现金比例", percent(p.ending_cash_ratio)],
              ["模拟执行缺口", String(p.execution_failure_count)]].map(([label, text]) => <React.Fragment key={label}><dt className="text-muted-foreground">{label}</dt><dd className="break-words text-right tabular-nums">{text}</dd></React.Fragment>)}
          </dl><p className="mt-3 text-xs text-muted-foreground">费用 {money(p.fees_cny)} · 换汇成本 {money(p.fx_fees_cny)} · 滑点 {money(p.slippage_cny)} CNY；税务覆盖依赖来源假设，未承诺全税费或持续盈利。</p>
          <p className="mt-2 text-xs text-muted-foreground">最深回撤后的恢复：{p.recovered_at ?? "窗口内未确认恢复，或无可确认回撤"}。新本金不被当作投资收益。</p>
        </section>;
      })}</div>}
      {binding && candidate.paths && <InvestorFundedAnalysisPanel comparison={value} binding={binding} parameters={candidate.parameters_hash} />}
    </article>)}
    <p className="text-xs text-muted-foreground">核验于 {value.checked_at} · 资料留存上限 {value.valid_until}；风险预算未确认时，不自动选取任何候选。</p>
  </div>;
}

export function InvestorFundedComparisonPanel({ state, binding, disabled, scopeLocked = disabled }: { state: InvestorState; binding: string; disabled: boolean; scopeLocked?: boolean }) {
  const identity = fundedComparisonIdentity(state, binding), controller = useRef<AbortController | null>(null);
  const current = useRef({ identity, disabled, scopeLocked }); current.current = { identity, disabled, scopeLocked };
  const invalidated = useRef(false);
  const [result, setResult] = useState<{ identity: string; value: FundedComparison } | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const { now, readNow } = useInvestorDisplayTime(state.checked_at, result?.value.valid_until ? String(Date.parse(result.value.valid_until)) : "");
  useEffect(() => { controller.current?.abort(); setResult(null); setError(""); setLoading(false); return () => controller.current?.abort(); }, [identity, scopeLocked]);
  useEffect(() => {
    const cancel = () => { invalidated.current = true; controller.current?.abort(); setResult(null); setError(""); setLoading(false); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, cancel);
    return () => window.removeEventListener(SESSION_INVALIDATED_EVENT, cancel);
  }, []);
  const eligible = !state.funded_study_unavailable && !!state.funded_study?.completed_at && ["calculated_unverified", "failed"].includes(state.funded_study.status) && state.funded_study.candidate_count > 0;
  const value = !invalidated.current && !scopeLocked && result?.identity === identity && result.value.valid_until && Date.parse(result.value.valid_until) > now ? result.value : null;
  if (!eligible) return null;
  async function load() {
    if (invalidated.current || current.current.identity !== identity || current.current.disabled || current.current.scopeLocked || loading
      || controller.current && !controller.current.signal.aborted) return;
    const requestIdentity = identity, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    setLoading(true); setError(""); setResult(null);
    const active = () => !invalidated.current && !abort.signal.aborted && controller.current === abort
      && current.current.identity === requestIdentity && !current.current.scopeLocked;
    try {
      const response = await fetch("/api/workbench/investor/funded-comparison", { cache: "no-store", credentials: "same-origin",
        headers: { "X-Workbench-Session-Binding": binding }, signal: abort.signal });
      if (!active()) return;
      if (response.status === 401) { invalidated.current = true; setResult(null); throw new Error("登录状态已变化，请重新登录后核对资料。"); }
      if (!response.ok) throw new Error(response.status === 429 ? "其他核验仍在进行，请稍后再试。" : "比较结果暂不可读，请刷新状态并核对来源。");
      const raw = await response.json();
      if (!active()) return;
      const parsed = parseFundedComparison(raw, state, binding, readNow());
      if (!["verified_retrospective", "partial"].includes(parsed.status)) throw new Error("比较条件或登记版本已变化，请先刷新状态。");
      if (active()) setResult({ identity: requestIdentity, value: parsed });
    } catch (error) { if (controller.current === abort && !abort.signal.aborted && current.current.identity === requestIdentity && !current.current.scopeLocked)
      setError(error instanceof Error && !error.message.includes("RESPONSE_INVALID") ? error.message : "资料已变化或未通过核验，请刷新状态。"); }
    finally { if (controller.current === abort) { controller.current = null; setLoading(false); } }
  }
  return <section className="min-w-0 rounded-2xl border bg-card p-5 md:p-6" aria-labelledby="funded-comparison-title">
    <h2 id="funded-comparison-title" className="font-semibold">长期投入 · 收益与损失比较</h2>
    <p className="mt-2 text-sm text-muted-foreground">按需独立核验所有冻结候选；不改变权重、风险答案、现金或持仓，不自动交易。</p>
    <Button className="mt-4" variant="outline" disabled={disabled || scopeLocked || invalidated.current || loading} onClick={() => void load()}>{loading ? "正在独立核验…" : "查看已登记的比较结果"}</Button>
    {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
    {value && <FundedComparisonResults value={value} binding={binding} />}
    {result && !value && !scopeLocked && <p role="status" className="mt-3 text-sm">资料已过期或版本变化，旧经济结果已隐藏。</p>}
  </section>;
}
