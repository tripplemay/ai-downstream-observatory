"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { FundedComparison } from "@/server/investor/funded-comparison-schemas";
import type { FundedAnalysisData, FundedAnalysisSeries, FundedPathAnalysis } from "@/server/investor/funded-analysis-schemas";
import { parseFundedAnalysis } from "./investor-funded-analysis-client";
import { formatResearchMoney, formatResearchPercent } from "./research-format";
import { useInvestorDisplayTime } from "./investor-display-clock";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";

function WealthChart({ data, metric }: { data: FundedAnalysisData; metric: "wealth" | "profit" | "drawdown" }) {
  const host = useRef<HTMLDivElement | null>(null), [width, setWidth] = useState(900);
  useEffect(() => {
    if (!host.current) return;
    const element = host.current, update = () => setWidth(Math.max(220, Math.floor(element.getBoundingClientRect().width)));
    update(); const observer = new ResizeObserver(update); observer.observe(element); return () => observer.disconnect();
  }, []);
  const bottom = width < 600 ? 185 : 225, right = width - 25;
  const lines = useMemo(() => {
    const curves = metric === "wealth" ? [
      { label: "候选净资产", color: "#2563eb", points: data.candidate.daily, key: "nav_cny" },
      { label: "累计本金", color: "#64748b", points: data.candidate.daily, key: "principal_cny" },
      { label: "待释放现金", color: "#b45309", points: data.candidate.daily, key: "locked_cash_cny" },
      { label: "持有对照净资产", color: "#15803d", points: data.baseline.daily, key: "nav_cny" },
    ] : [
      { label: metric === "profit" ? "候选盈亏" : "候选单位回撤", color: "#2563eb", points: data.candidate.daily, key: metric === "profit" ? "profit_cny" : "drawdown" },
      { label: metric === "profit" ? "持有对照盈亏" : "持有对照单位回撤", color: "#15803d", points: data.baseline.daily, key: metric === "profit" ? "profit_cny" : "drawdown" },
    ];
    const values = curves.flatMap(line => line.points.map(point => point[line.key as keyof typeof point]).filter(value => value !== null).map(Number));
    const low = Math.min(0, ...values), high = Math.max(0, ...values), range = high - low || 1;
    const first = Date.parse(data.candidate.daily[0].local_date), last = Date.parse(data.candidate.daily.at(-1)!.local_date), span = last - first || 1;
    return { low, high, available: values.length > 0, curves: curves.map(line => ({ ...line, coordinates: line.points.filter(point => point[line.key as keyof typeof point] !== null)
      .map(point => `${55 + (Date.parse(point.local_date) - first) / span * (right - 55)},${bottom - (Number(point[line.key as keyof typeof point]) - low) / range * (bottom - 30)}`).join(" ") })) };
  }, [data, metric, bottom, right]);
  const tick = (value: number) => metric === "drawdown" ? `${(value * 100).toFixed(1)}%` : value.toLocaleString("zh-CN", { maximumFractionDigits: 0, notation: Math.abs(value) >= 10000 ? "compact" : "standard" });
  return <div ref={host} className="min-w-0">{!lines.available ? <p role="status" className="mt-3 text-sm">没有可核验的回撤序列，不绘制零回撤。</p> : <svg role="img" aria-label={metric === "wealth" ? "整个历史窗口的本金、候选净资产、待释放现金与持有对照曲线" : metric === "profit" ? "扣已识别成本后的累计盈亏曲线，追加本金不是收益" : "日末单位回撤曲线，精确最深回撤按所有估值点计算"} viewBox={`0 0 ${width} ${bottom + 35}`} className="mt-3 w-full rounded-lg border bg-background">
    <line x1="55" x2={right} y1={bottom} y2={bottom} stroke="currentColor" opacity=".2" /><line x1="55" x2={right} y1="30" y2="30" stroke="currentColor" opacity=".1" />
    <text x="8" y="30" fontSize="11" fill="currentColor">{tick(lines.high)}</text><text x="8" y={bottom} fontSize="11" fill="currentColor">{tick(lines.low)}</text>
    {lines.curves.map(line => <polyline key={line.label} points={line.coordinates} fill="none" stroke={line.color} strokeWidth="2" strokeDasharray={line.label.includes("对照") ? "6 4" : line.label === "累计本金" ? "2 4" : undefined} vectorEffect="non-scaling-stroke" />)}
    <text x="55" y={bottom + 22} fontSize="11" fill="currentColor">{data.candidate.daily[0].local_date}</text><text x={right} y={bottom + 22} textAnchor="end" fontSize="11" fill="currentColor">{data.candidate.daily.at(-1)!.local_date}</text>
  </svg>}<div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs">{lines.curves.map(line => <span key={line.label} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: line.color }} />{line.label}</span>)}</div></div>;
}
function RiskTable({ series, label }: { series: FundedAnalysisSeries; label: string }) {
  const risk = series.risk;
  return <section className="min-w-0 rounded-lg border p-3"><h5 className="text-sm font-medium">{label}</h5>
    <p className="mt-2 text-sm">全估值点最大单位回撤 {formatResearchPercent(risk.max_drawdown)}</p>
    <p className="mt-1 break-words text-xs text-muted-foreground">峰值 {risk.peak_at ?? "未确认"} · 谷底 {risk.trough_at ?? "未确认"}</p>
    <p className="mt-1 text-xs">谷底恢复至原峰值：{risk.recovered_at ? `${risk.recovery_days} 个当地日历日` : risk.trough_at ? "窗口内尚未恢复" : "无可确认回撤"}</p>
    {risk.longest_underwater && <p className="mt-1 text-xs">最长峰下区间 {risk.longest_underwater.duration_days} 日{risk.longest_underwater.ongoing ? "，截至窗口末仍持续" : "，已恢复"}</p>}
    <div className="mt-3 space-y-2">{series.rolling.map(window => <div key={window.months} className="rounded border p-2 text-xs">
      <p>{window.months / 12} 年滚动月末对照 · {window.window_count} 个重叠窗口</p>
      <p className="mt-1">{window.status === "insufficient_history" ? "没有完整观测窗口，不补造结果" : `最差 ${formatResearchPercent(window.worst!.return)} · 最好 ${formatResearchPercent(window.best!.return)} · 亏损 ${window.negative_count} 次（样本占比 ${formatResearchPercent(window.negative_fraction)}）`}</p>
      {window.worst && <p className="mt-1 break-words text-muted-foreground">最差起止 {window.worst.from_at} 至 {window.worst.to_at}</p>}
    </div>)}</div>
  </section>;
}
export function FundedAnalysisResults({ data }: { data: FundedAnalysisData }) {
  const [metric, setMetric] = useState<"wealth" | "profit" | "drawdown">("wealth"), [index, setIndex] = useState(data.candidate.daily.length - 1);
  const point = data.candidate.daily[Math.min(index, data.candidate.daily.length - 1)];
  return <div className="mt-4 min-w-0 space-y-4">
    <p className="text-xs text-muted-foreground">持有对照沿用相同权重、资金流、分批、行情、FX、交易单位、分红与成本，只关闭周期/偏离买卖再平衡；新增人民币现金仍优先补低配。它是本次回顾性反事实，不是过去预注册的独立基准，也不保证比候选差。</p>
    <div className="flex flex-wrap gap-2" aria-label="历史曲线指标">{([['wealth', '资产与本金'], ['profit', '累计盈亏'], ['drawdown', '单位回撤']] as const).map(([value, label]) => <Button key={value} variant={metric === value ? "default" : "outline"} size="sm" onClick={() => setMetric(value)}>{label}</Button>)}</div>
    <WealthChart data={data} metric={metric} />
    <p className="text-xs text-muted-foreground">覆盖整个窗口，共 {data.candidate.daily.length} 个已观测当地日末点；不是每一天都有报价，不插值、不拼接重启账户。全部 {data.candidate.full_observation_count} 个估值点用于风险；图中连线仅便于阅读，不是成交价。</p>
    <label className="flex flex-col gap-2 text-sm">查看候选某个估值日：{point.local_date}<input type="range" min="0" max={data.candidate.daily.length - 1} value={index} onChange={event => setIndex(Number(event.target.value))} /></label>
    <p className="break-words text-sm">净资产 {formatResearchMoney(point.nav_cny)} · 本金 {formatResearchMoney(point.principal_cny)} · 盈亏 {formatResearchMoney(point.profit_cny)} · 待释放 {formatResearchMoney(point.locked_cash_cny)} CNY</p>
    <p className="text-sm">候选减持有对照：期末净资产 {formatResearchMoney(data.comparison.ending_nav_difference_cny)} CNY · TWR 差 {formatResearchPercent(data.comparison.twr_difference)}。</p>
    <p className="text-xs text-muted-foreground">持有对照期末盈亏 {formatResearchMoney(data.baseline.summary.profit_cny)} CNY；费用 {formatResearchMoney(data.baseline.summary.fees_cny)}、换汇成本 {formatResearchMoney(data.baseline.summary.fx_fees_cny)}、滑点 {formatResearchMoney(data.baseline.summary.slippage_cny)} CNY。{data.baseline.summary.execution_review ? "原始撤单 / 跳过 / 到期" : "执行缺口"} {data.baseline.summary.execution_failure_count} 项，不把未成交当作策略有效。</p>
    {data.baseline.summary.execution_review && <p className="text-xs text-muted-foreground">持有对照未解决执行缺口 {data.baseline.summary.execution_review.terminal_failure_count} 项；公司行动撤单 {data.baseline.summary.execution_review.cancellations} 项，其中已解决 {data.baseline.summary.execution_review.resolved_cancellations} 项；未完成复核 {data.baseline.summary.execution_review.unresolved_reviews} 项。</p>}
    {data.baseline.summary.cash_intent_review && <p className="text-xs text-muted-foreground">持有对照交收后买入意图：未完成 {data.baseline.summary.cash_intent_review.pending_intents} 项，失败 {data.baseline.summary.cash_intent_review.failed_intents} 项；与候选使用相同的资金和交收规则。</p>}
    <div className="grid min-w-0 gap-3 lg:grid-cols-2"><RiskTable series={data.candidate} label="候选风险" /><RiskTable series={data.baseline} label="持有对照风险" /></div>
    <p className="text-xs text-muted-foreground">滚动结果是相隔 12/36/60 个月的已观测月末单位净值之比，不是未来亏损概率；重叠窗口不独立。历史最差值和恢复时间都不是未来保证。资料、税费与策略资格仍需单独验收。</p>
  </div>;
}
export function InvestorFundedAnalysisPanel({ comparison, binding, parameters }: { comparison: FundedComparison; binding: string; parameters: string }) {
  const [path, setPath] = useState<"immediate" | "staged">("immediate"), [result, setResult] = useState<{ identity: string; value: FundedPathAnalysis } | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const identity = JSON.stringify([binding, comparison.workspace_id, comparison.workspace_revision, comparison.profile_id, comparison.funding_plan_id,
    comparison.request_id, comparison.input_version, comparison.run_id, comparison.valid_until, parameters, path]);
  const current = useRef(identity); current.current = identity;
  const controller = useRef<AbortController | null>(null), invalidated = useRef(false);
  const { now, readNow } = useInvestorDisplayTime(comparison.checked_at, comparison.valid_until ? String(Date.parse(comparison.valid_until)) : "");
  const expired = !comparison.valid_until || Date.parse(comparison.valid_until) <= now;
  useEffect(() => { controller.current?.abort(); setResult(null); setLoading(false); setError(""); return () => controller.current?.abort(); }, [identity]);
  useEffect(() => { if (expired) { controller.current?.abort(); controller.current = null; setResult(null); setLoading(false); } }, [expired]);
  useEffect(() => {
    const cancel = () => { invalidated.current = true; controller.current?.abort(); controller.current = null; setResult(null); setError(""); setLoading(false); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, cancel);
    return () => window.removeEventListener(SESSION_INVALIDATED_EVENT, cancel);
  }, []);
  async function load() {
    if (invalidated.current || current.current !== identity || !comparison.valid_until
      || Date.parse(comparison.valid_until) <= readNow() || loading
      || controller.current && !controller.current.signal.aborted) return;
    const abort = new AbortController(), captured = identity; controller.current = abort; setLoading(true); setError(""); setResult(null);
    const timer = setTimeout(() => abort.abort(), 75000);
    try {
      const response = await fetch(`/api/workbench/investor/funded-analysis?candidate=${encodeURIComponent(parameters)}&path=${path}`, {
        cache: "no-store", credentials: "same-origin", signal: abort.signal, headers: { "X-Workbench-Session-Binding": binding } });
      if (abort.signal.aborted || invalidated.current || controller.current !== abort || current.current !== captured) return;
      if (response.status === 401) { invalidated.current = true; setResult(null); throw new Error("登录状态已变化，请重新登录后核对资料。"); }
      if (!response.ok) throw new Error(response.status === 429 ? "其他核验仍在运行，请稍后再试。" : "曲线资料暂不可核验，请刷新状态。");
      const text = await response.text();
      if (abort.signal.aborted || invalidated.current || controller.current !== abort || current.current !== captured) return;
      if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) throw new Error("FUNDED_ANALYSIS_RESPONSE_INVALID");
      let value: FundedPathAnalysis;
      try { value = await parseFundedAnalysis(JSON.parse(text), comparison, binding, parameters, path, readNow()); }
      catch { throw new Error("FUNDED_ANALYSIS_RESPONSE_INVALID"); }
      if (!abort.signal.aborted && !invalidated.current && controller.current === abort && current.current === captured
        && Date.parse(value.valid_until!) > readNow()) setResult({ identity: captured, value });
    } catch (error) { if (controller.current === abort && current.current === captured) setError(abort.signal.aborted ? "核验已超时或取消，请核对当前资料后重试。" : error instanceof Error && !error.message.includes("RESPONSE_INVALID") ? error.message : "曲线版本或金额未通过核验，未显示旧结果。"); }
    finally { clearTimeout(timer); if (controller.current === abort) { controller.current = null; setLoading(false); } }
  }
  return <div className="mt-4 min-w-0 border-t pt-4"><h4 className="text-sm font-semibold">沿时间看本金、收益与风险</h4>
    <div className="mt-3 flex flex-wrap items-end gap-3"><label className="flex flex-col gap-2 text-sm">查看资金释放路径（不改变已保存安排）<select value={path} onChange={event => setPath(event.target.value as typeof path)} className="h-10 max-w-full rounded border bg-background px-3"><option value="immediate">到账及时释放</option><option value="staged">预定三批释放</option></select></label>
      <Button variant="outline" disabled={loading || expired || invalidated.current} onClick={() => void load()}>{loading ? "正在重建曲线…" : "查看完整窗口曲线与持有对照"}</Button></div>
    {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
    {expired && <p role="status" className="mt-3 text-sm">资料已到期，旧曲线已隐藏；请刷新工作台并核对新的比较版本。</p>}
    {!expired && !invalidated.current && result?.identity === identity && result.value.analysis && Date.parse(result.value.valid_until!) > now && <FundedAnalysisResults key={identity} data={result.value.analysis} />}
  </div>;
}
