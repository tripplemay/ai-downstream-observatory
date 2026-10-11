"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import { TRADE_RECORDING_ZONES, type TradeRecordingContext } from "@/server/investor/trade-recording-schemas";
import { blankTradeRecordingDraft, buildTradeRecordingIntent, parseTradeRecordingContext, type TradeRecordingDraft } from "./investor-trade-recording-client";
import type { ReconciliationScope } from "./investor-reconciliation-client";

const field = "flex min-w-0 flex-col gap-2 text-sm", select = "h-11 w-full min-w-0 rounded-lg border bg-background px-3";
export function InvestorTradeRecordingPanel({ scope, accountName, disabled, onCommand, onDraftLockChange }: {
  scope: ReconciliationScope; accountName: string; disabled: boolean; onCommand: (intent: Record<string, unknown>) => void; onDraftLockChange: (locked: boolean) => void;
}) {
  const session = useSessionBoundary(), key = JSON.stringify(scope);
  const [reading, setReading] = useState<{ key: string; context: TradeRecordingContext } | null>(null), [draft, setDraft] = useState<TradeRecordingDraft | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = useRef<AbortController | null>(null), epoch = useRef(0), alive = useRef(true), invalidated = useRef(false), submitting = useRef(false);
  const verified = session?.verified === true && session.sessionBinding === scope.binding && !invalidated.current;
  const current = useRef({ key, scope, verified, disabled }); current.current = { key, scope, verified, disabled };
  const context = verified && !disabled && reading?.key === key ? reading.context : null;
  useEffect(() => {
    alive.current = true;
    const invalidate = () => { invalidated.current = true; epoch.current++; active.current?.abort(); setReading(null); setDraft(null); setBusy(false); setError(""); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => { alive.current = false; epoch.current++; active.current?.abort(); window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); };
  }, []);
  useEffect(() => {
    epoch.current++; active.current?.abort(); active.current = null; submitting.current = false;
    setReading(null); setDraft(null); setBusy(false); setError("");
  }, [key]);
  useEffect(() => {
    if (!verified) { epoch.current++; active.current?.abort(); active.current = null; setReading(null); setDraft(null); setBusy(false); setError(""); }
  }, [verified]);
  useEffect(() => { onDraftLockChange(verified && (busy || draft !== null)); }, [verified, busy, draft, onDraftLockChange]);
  useEffect(() => () => onDraftLockChange(false), [onDraftLockChange]);
  useEffect(() => {
    if (!draft) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => { const link = event.target instanceof Element && event.target.closest("a[href]");
      if (link && !window.confirm("成交或交收草稿尚未提交，离开会丢失本地草稿。确定离开吗？")) { event.preventDefault(); event.stopPropagation(); } };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [draft !== null]);
  async function begin(mode: TradeRecordingDraft["mode"]) {
    const start = current.current;
    if (!start.verified || start.disabled || active.current || draft) return;
    const controller = new AbortController(), sequence = ++epoch.current;
    active.current = controller; setBusy(true); setError(""); setReading(null);
    const valid = () => alive.current && !invalidated.current && sequence === epoch.current && current.current.key === start.key && current.current.verified && !current.current.disabled;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/workbench/investor/trade-recording?account=${encodeURIComponent(start.scope.accountId)}`, {
        cache: "no-store", credentials: "same-origin", redirect: "error", headers: { "X-Workbench-Session-Binding": start.scope.binding }, signal: controller.signal });
      if (!valid()) return;
      if (response.status === 401) { window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); return; }
      if (!response.ok) throw new Error();
      const value = parseTradeRecordingContext(await response.json(), start.scope);
      if (!valid()) return;
      if (value.read_only || value.account_status === "disabled") throw new Error();
      setReading({ key: start.key, context: value }); setDraft(blankTradeRecordingDraft(mode)); submitting.current = false;
    } catch { if (valid()) setError("当前账户或版本未通过核验。请核对顶部状态与账户资料后重试，不使用旧范围入账。"); }
    finally { clearTimeout(timer); if (active.current === controller) { active.current = null; if (alive.current) setBusy(false); } }
  }
  function edit(patch: Partial<TradeRecordingDraft>) { setDraft(value => value ? { ...value, ...patch, acknowledged: false } : value); setError(""); }
  function submit(event: FormEvent) {
    event.preventDefault(); if (!context || !draft || busy || disabled || invalidated.current || submitting.current) return;
    try {
      const input = buildTradeRecordingIntent(context, draft); submitting.current = true;
      // The parent owns the immutable request and unknown-response recovery from this point on.
      setDraft(null); setReading(null); onDraftLockChange(false); onCommand(input);
    } catch { submitting.current = false; setError("请逐项核对实际日期、时区、来源编号和金额。数量与金额须为正；费用未知不能填零；卖出本金须大于费用。必须明确确认，不能将计划当作成交。"); }
  }
  const locked = disabled || busy || !verified || !context || context.read_only || context.account_status === "disabled";
  const listing = context?.listings.find(row => row.id === draft?.listing), parent = context?.unsettled_trades.find(row => row.event_id === draft?.related);
  return <section aria-label="人工成交回录" className="min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6">
    <h2 className="text-lg font-semibold">2b · 直接回录已发生的成交或交收</h2>
    <p className="mt-3 text-sm text-muted-foreground">你在券商自行交易后，可逐笔转录。这里不生成委托，不验证券商成交，也不绑定策略执行报告。成交只记录证券及应收应付；现金变化须另有实际交收资料。</p>
    {error && <p role="alert" className="mt-4 break-words text-sm text-red-600">{error}</p>}
    {busy && <p role="status" className="mt-4 text-sm">正在核对账户与版本，不读取行情或预填成交金额。</p>}
    {!draft && <div className="mt-4 flex flex-wrap gap-3"><Button variant="outline" disabled={disabled || busy || !verified} onClick={() => void begin("trade")}>录入已发生成交</Button>
      <Button variant="outline" disabled={disabled || busy || !verified} onClick={() => void begin("settlement")}>录入实际交收</Button></div>}
    {draft && context && <form onSubmit={submit} className="mt-5 space-y-5"><fieldset disabled={locked} className="min-w-0 space-y-5">
      <p className="break-words text-sm">账户：{accountName} · 账本版本 {context.ledger_revision} · {draft.mode === "trade" ? "已发生成交" : "实际现金交收"}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {draft.mode === "trade" ? <>
          <label className={field}>实际成交方向<select className={select} value={draft.side} required onChange={e => edit({ side: e.target.value })}><option value="">请按成交资料选择</option><option value="buy">买入</option><option value="sell">卖出</option></select></label>
          <label className={field}>证券（不按名称猜测身份）<select className={select} value={draft.listing} required onChange={e => edit({ listing: e.target.value })}><option value="">请选择已登记的证券</option>{context.listings.map(row => <option key={row.id} value={row.id}>{row.ticker} · {row.market} · {row.currency} · {row.name}</option>)}</select></label>
          <label className={field}>实际成交数量<Input value={draft.quantity} inputMode="decimal" required maxLength={21} autoComplete="off" onChange={e => edit({ quantity: e.target.value })} /></label>
          <label className={field}>成交本金（不含费用）{listing && <span>{listing.currency}</span>}<Input value={draft.consideration} inputMode="decimal" required maxLength={21} autoComplete="off" onChange={e => edit({ consideration: e.target.value })} /></label>
          <label className={field}>实际费用总额（已核对无费用才填 0）<Input value={draft.fee} inputMode="decimal" required maxLength={21} autoComplete="off" onChange={e => edit({ fee: e.target.value })} /></label>
        </> : <>
          <label className={`${field} sm:col-span-2`}>关联的未完成交收成交<select className={select} value={draft.related} required onChange={e => edit({ related: e.target.value })}><option value="">按来源编号及成交记录核对</option>{context.unsettled_trades.map(row => <option key={row.event_id} value={row.event_id}>{row.direction === "buy" ? "买入付款" : "卖出收款"} · {row.currency} · {row.effective_at} · {row.source_id} / {row.source_event_id ?? "无外部编号"} · {row.event_id}</option>)}</select></label>
          <label className={field}>本次实际交收现金（正数，允许分次）{parent && <span>{parent.currency} · {parent.direction === "buy" ? "付款" : "收款"}</span>}<Input value={draft.payment} inputMode="decimal" required maxLength={21} autoComplete="off" onChange={e => edit({ payment: e.target.value })} /></label>
          {!context.unsettled_trades.length && <p className="text-sm">没有可在此回录的未完成交收成交。特殊带符号交收请在高级账本处理；不自动生成关联成交。</p>}
        </>}
        <label className={field}>{draft.mode === "trade" ? "实际成交日期" : "实际交收日期"}<Input type="date" value={draft.date} required onChange={e => edit({ date: e.target.value })} /></label>
        <label className={field}>资料时区<select className={select} value={draft.zone} required onChange={e => edit({ zone: e.target.value })}><option value="">请按原始资料选择</option>{TRADE_RECORDING_ZONES.map(zone => <option key={zone}>{zone}</option>)}</select></label>
        <label className={field}>来源标识（与后续 CSV 保持一致）<Input value={draft.source} required maxLength={120} autoComplete="off" onChange={e => edit({ source: e.target.value })} /></label>
        <label className={field}>原始成交或交收唯一编号<Input value={draft.sourceEvent} required maxLength={120} autoComplete="off" onChange={e => edit({ sourceEvent: e.target.value })} /></label>
        <label className={`${field} sm:col-span-2`}>独立资料编号或说明<Input value={draft.reference} required maxLength={500} autoComplete="off" onChange={e => edit({ reference: e.target.value })} /></label>
      </div>
      <p className="text-xs text-muted-foreground">来源标识与唯一编号须以字母或数字开头，仅用字母、数字及 . _ : -；中文说明填写在“独立资料编号或说明”。来源、编号、日期精度和事实需与后续导入一致，不能靠换编号规避重复检查。</p>
      <div className="rounded-xl border border-amber-500/40 p-4 text-sm"><h3 className="font-medium">逐项复核后才入账</h3>
        <p className="mt-2 break-words">{draft.mode === "trade" ? `${draft.side === "buy" ? "买入" : draft.side === "sell" ? "卖出" : "未选方向"} · ${listing?.ticker ?? "未选证券"} · ${listing?.currency ?? "未选币种"}；数量 ${draft.quantity || "未填"}，不含费本金 ${draft.consideration || "未填"}，费用 ${draft.fee || "未填"}。不会改动已结算现金。`
          : `${parent?.direction === "buy" ? "付款" : parent?.direction === "sell" ? "收款" : "未选成交"} · ${parent?.currency ?? "未选币种"}；本次现金 ${draft.payment || "未填"}。不会改动证券数量。`}</p>
        <p className="mt-2">日期 {draft.date || "未填"} · 时区 {draft.zone || "未填"} · 来源 {draft.source || "未填"} / {draft.sourceEvent || "未填"}。仅按日期记录，不伪造盘中时刻。入账后须重新独立对账和估值；重复来源可能复用原事实。</p>
        <label className="mt-4 flex items-start gap-3"><input type="checkbox" className="mt-1" checked={draft.acknowledged} onChange={e => setDraft(value => value ? { ...value, acknowledged: e.target.checked } : value)} />我已核对以上事实确已发生，币种、金额、费用和来源准确；这不是投资计划、委托下单、券商认证或交易批准。</label>
      </div>
      <div className="flex flex-wrap gap-3"><Button disabled={locked || !draft.acknowledged}>{draft.mode === "trade" ? "确认回录已发生成交" : "确认回录实际交收"}</Button>
        <Button type="button" variant="outline" onClick={() => { setDraft(null); setReading(null); setError(""); }}>取消并清除草稿</Button></div>
    </fieldset></form>}
    {draft && !context && <div className="mt-4"><p role="status" className="text-sm">当前范围待核对，暂停旧草稿提交，不展示缓存成交金额。</p>
      <Button type="button" variant="outline" className="mt-3" onClick={() => { setDraft(null); setReading(null); setError(""); }}>取消并清除草稿</Button></div>}
    <Link className="mt-5 inline-block text-sm underline" href="/workbench/ledger">高级账本：登记缺失证券、补齐历史、修正错误及重新估值</Link>
  </section>;
}
