"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import type { InvestorState } from "@/server/investor/types";
import type { InvestorAccountWorkspace } from "@/server/investor/account-schemas";
import { HoldingsDecimal, type InvestorHoldings, type HoldingsGapCode } from "@/server/investor/holdings-schemas";
import { parseInvestorHoldings } from "./investor-holdings-client";
import { formatResearchMoney, formatResearchPercent } from "./research-format";

const gapLabels: Record<HoldingsGapCode, string> = {
  ACCOUNT_BOOK_NOT_LINKED: "先显式关联自己的账本；研究参考组合不等于你的持仓。",
  ACCOUNT_BOOK_EMPTY: "账本没有账户，先建档；不会自动生成资金或持仓。",
  HOLDINGS_CAPACITY_REVIEW_REQUIRED: "记录规模超过本页复核范围，需先做容量验收；不截取部分账户冒充整个组合。",
  RECONCILIATION_REQUIRED: "全部账户都需要独立对账，包括停用账户；CSV 导入成功不等于对账完成。",
  RECONCILIATION_EVIDENCE_INVALID: "对账记录或审计证明未通过核验，需重新检查独立原始资料。",
  RECONCILIATION_SOURCE_UNAVAILABLE: "无法读取并核验原始对账附件；不会使用缓存余额替代。",
  RECONCILIATION_FACTS_CHANGED: "对账后有新的账户事实，先重新对账；旧快照不再代表当前账本。",
  RECONCILIATION_MISMATCH: "账户记录与独立对账资料不一致，先解决差异。",
  VALUATION_REQUIRED: "对账完成后，还需生成完整的人民币估值。",
  VALUATION_NOT_COMPLETE: "最新估值有缺项，不能只用已知部分作为整个组合净值。",
  VALUATION_NONPOSITIVE_NAV: "最新净值不是正数，不能计算目标权重偏差。",
  VALUATION_NOT_CURRENT: "最新估值不是当前账本版本的重述估值，需核对后重新估值。",
  VALUATION_EVIDENCE_INVALID: "估值来源、项目或总额未通过复核，不能展示为已核对净值。",
  VALUATION_CUTOFF_NOT_RECONCILED: "估值日期超出已对账范围，先补齐对应日期的对账。",
  REFERENCE_NOT_READY: "尚无有效参考方案；可以先查看已经核对的记录快照。",
  REFERENCE_NOT_REAL_DATA: "演示研究不能用于真实账户目标对照，需补齐可复核的研究数据。",
  REFERENCE_EVIDENCE_INVALID: "参考方案或证券身份的证据未通过复核，暂不计算目标偏差。",
  REFERENCE_IDENTITY_REQUIRED: "需在行情参考资料中绑定研究 ETF 与账本证券，并完成有效身份审查；不按名称猜测。",
  REFERENCE_IDENTITY_AMBIGUOUS: "证券身份映射不唯一，先消除冲突，不能重复分配同一资产。",
};
const categoryLabels = { cash_settled: "已结算现金", trade_receivable: "交易应收", trade_payable: "交易应付", dividend_receivable: "股息应收",
  dividend_tax_payable: "股息税应付", transfer_in_transit: "资金在途", other_liability: "其他负债", security: "证券" };
type Reading = { value: InvestorHoldings; key: string; observedMono: number; observedWall: number };
const percent = (value: string) => formatResearchPercent(value);

export function InvestorHoldingsPanel({ state, accounts, binding, disabled }: {
  state: InvestorState; accounts: InvestorAccountWorkspace; binding: string; disabled: boolean;
}) {
  const session = useSessionBoundary();
  const book = accounts.books.find(row => row.id === accounts.link?.document.portfolio_id);
  const key = JSON.stringify([binding, state.workspace_id, state.revision, book?.id, book?.ledger_revision,
    accounts.link?.id, accounts.link?.version, accounts.accounts.map(row => row.id).sort(), state.plan?.id, state.plan?.content_hash]);
  const [reading, setReading] = useState<Reading | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [clock, setClock] = useState({ wall: 0, mono: 0 });
  const active = useRef<AbortController | null>(null), sequence = useRef(0), alive = useRef(true), invalidated = useRef(false);
  const verified = session?.verified === true && session.sessionBinding === binding && !invalidated.current;
  const enabled = verified && !disabled;
  const current = useRef({ key, enabled, state, accounts, book }); current.current = { key, enabled, state, accounts, book };
  const refresh = useCallback(async () => {
    const context = current.current;
    if (!context.enabled || active.current || document.visibilityState === "hidden") return;
    const controller = new AbortController(), epoch = ++sequence.current;
    active.current = controller; setBusy(true); setError(""); setReading(null);
    const timer = setTimeout(() => controller.abort(), 15000);
    const valid = () => alive.current && !invalidated.current && current.current.enabled && current.current.key === context.key && sequence.current === epoch;
    try {
      const response = await fetch("/api/workbench/investor/holdings", { cache: "no-store", credentials: "same-origin", redirect: "error",
        headers: { "X-Workbench-Session-Binding": binding }, signal: controller.signal });
      if (!valid()) return;
      if (response.status === 401) { window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); return; }
      if (!response.ok) throw new Error("INVESTOR_HOLDINGS_UNAVAILABLE");
      const value = parseInvestorHoldings(await response.json(), { binding, workspace: context.state.workspace_id, revision: context.state.revision,
        portfolio: context.book?.id ?? null, linkId: context.book ? context.accounts.link!.id : null,
        linkVersion: context.book ? context.accounts.link!.version : null, ledgerRevision: context.book?.ledger_revision ?? null,
        accountIds: context.accounts.accounts.map(row => row.id), plan: context.state.plan });
      if (!valid()) return;
      const observedWall = Date.now(), observedMono = performance.now();
      setClock({ wall: observedWall, mono: observedMono }); setReading({ value, key: context.key, observedWall, observedMono });
    } catch {
      if (valid()) { setReading(null); setError("持仓对照未通过核验。请先点击上方“核对账户资料”，再复核对照；不显示旧数字，也不重复导入。"); }
    } finally {
      clearTimeout(timer);
      if (active.current === controller) { active.current = null; if (alive.current) setBusy(false); }
    }
  }, [binding]);
  useEffect(() => {
    alive.current = true;
    const invalidate = () => { invalidated.current = true; sequence.current++; active.current?.abort(); active.current = null; setReading(null); setError(""); setBusy(false); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => { alive.current = false; sequence.current++; active.current?.abort(); window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); };
  }, []);
  useEffect(() => {
    sequence.current++; active.current?.abort(); active.current = null; setReading(null); setBusy(false); setError("");
    if (!enabled) return;
    void refresh();
    const interval = setInterval(() => void refresh(), 30000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", visible); sequence.current++; active.current?.abort(); active.current = null; };
  }, [key, enabled, refresh]);
  useEffect(() => {
    if (!enabled || !reading?.value.comparison) return;
    const timer = setInterval(() => setClock({ wall: Date.now(), mono: performance.now() }), 1000);
    return () => clearInterval(timer);
  }, [enabled, reading]);
  const value = enabled && !busy && reading?.key === key ? reading.value : null;
  const snapshot = value?.snapshot;
  // A backward wall-clock adjustment must not prolong a reference comparison's lifetime.
  const now = reading ? Math.max(clock.wall, reading.observedWall + Math.max(0, clock.mono - reading.observedMono),
    Date.parse(reading.value.checked_at) + Math.max(0, clock.mono - reading.observedMono)) : 0;
  const comparison = value?.comparison && Date.parse(value.comparison.valid_until) > now ? value.comparison : null;
  return <section className="min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6" aria-label="真实组合对照">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">4 · 真实组合对照</h2>
      <Button variant="outline" disabled={!enabled || busy} onClick={() => void refresh()}>复核对照</Button></div>
    <p className="mt-3 text-sm text-muted-foreground">分母是整个账本的人民币净值，包含现金、其他证券、应收应付与在途资产，不只看目标 ETF。读取不会入账、估值或下单。</p>
    {error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}
    {!value && !error && <p role="status" className="mt-4 text-sm">{disabled ? "账户资料正在核验或导入尚未结束；暂停数字对照。" : "正在复核当前登录、账本与来源，不显示缓存持仓。"}</p>}
    {value && value.gaps.length > 0 && <ul aria-label="持仓对照待办" className="mt-4 space-y-2 text-sm">{value.gaps.map(code => <li key={code}>{gapLabels[code]}</li>)}</ul>}
    {snapshot && <>
      <div className="mt-5 rounded-xl border p-4"><h3 className="font-medium">已核对的记录快照（非实时账户同步）</h3>
        <p className="mt-2 text-2xl font-semibold tabular-nums">¥ {formatResearchMoney(snapshot.nav_cny)}</p><p className="mt-1 text-sm">人民币净值，不是投资盈利</p>
        <p className="mt-3 break-words text-xs text-muted-foreground">估值截止：{snapshot.cutoff_at} · 账本版本 {value.ledger_revision} · 覆盖 {snapshot.reconciliations.length} 个账户</p>
        <p className="mt-2 text-sm text-muted-foreground">按你提供的独立对账资料复核已记录事实，不是券商直接认证；未回录交易、未记录变化及截止日后的价格变化不在该快照内。</p></div>
      <h3 className="mt-5 font-medium">整个组合构成</h3>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">{snapshot.components.map(row => <li key={row.key} className="min-w-0 rounded-xl border p-3 text-sm">
        <p className="break-words font-medium">{row.category === "security" ? `${row.name} · ${row.ticker}` : `${categoryLabels[row.category]} · ${row.currency}`}</p>
        <p className="mt-2 tabular-nums">¥ {formatResearchMoney(row.value_cny)} · {percent(row.weight)}</p>
        {row.category === "security" && <p className="mt-2 break-words text-xs text-muted-foreground">已入持仓 {row.settled_quantity} · 证券转移在途 {row.transit_quantity}（已计入一次）</p>}
      </li>)}</ul>
      {comparison && <div className="mt-6"><h3 className="font-medium">与研究目标的算术偏差</h3>
        <p className="mt-2 text-sm text-muted-foreground">正值表示高于目标，负值表示低于目标。不是买卖数量、择时信号或交易建议；调整仍需你自行决定。</p>
        <p className="mt-2 text-sm">目标以外的净资产：¥ {formatResearchMoney(comparison.outside_target_value_cny)}（含现金和负债，可为负数）</p>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">{comparison.rows.map(row => <li key={row.research_listing_id} className="min-w-0 rounded-xl border p-3 text-sm">
          <p className="font-medium">{row.symbol}</p><p className="mt-2 tabular-nums">目标 {percent(row.target_weight)} · 实际 {percent(row.actual_weight)}</p>
          <p className="mt-2 tabular-nums">偏差 {new HoldingsDecimal(row.difference_weight).mul(100).toFixed(2)} 个百分点 · ¥ {formatResearchMoney(row.difference_cny)}</p>
        </li>)}</ul><p className="mt-3 break-words text-xs text-muted-foreground">参考对照有效至：{comparison.valid_until}；记录快照并不因此成为实时行情。</p></div>}
      {value.comparison && !comparison && <p role="status" className="mt-5 text-sm">参考对照已到期，已隐藏目标偏差。记录快照仍仅代表其截止日期；请复核对照。</p>}
      <details className="mt-5 text-xs"><summary className="cursor-pointer">查看复核依据</summary><div className="mt-3 space-y-2 break-all">
        <p>估值记录：{snapshot.valuation_id} · 生成于 {snapshot.created_at}</p><p>证据摘要：{snapshot.evidence_hash}</p>
        {snapshot.reconciliations.map(row => <p key={row.account_id}>账户 {row.account_id} · 对账记录 {row.run_id} · 截止 {row.cutoff_at}</p>)}
      </div></details>
    </>}
    <div className="mt-5 flex flex-wrap gap-4 text-sm"><Link className="underline" href="/workbench/ledger">高级账本：独立对账与估值</Link>
      <Link className="underline" href="/workbench/market">行情参考：证券身份映射</Link><Link className="underline" href="/workbench/market/listings">证券身份审查</Link></div>
  </section>;
}
