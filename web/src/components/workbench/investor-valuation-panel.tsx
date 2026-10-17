"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import type { ValuationContext } from "@/server/investor/valuation-schemas";
import { blankValuationDraft, buildValuationIntent, parseValuationContext, type ValuationDraft, type ValuationScope } from "./investor-valuation-client";

const field = "flex min-w-0 flex-col gap-2 text-sm", select = "h-11 w-full min-w-0 rounded-lg border bg-background px-3";
const marketLabels = { CN: "A 股", HK: "港股", US: "美股" };
const taskLabels = { queued: "已排队", running: "计算中", succeeded: "后台计算已结束", partial: "后台仅完成部分", failed: "任务失败",
  skipped: "任务已停止，请核对输入版本", retry_queued: "后台等待重试", cancelled: "任务已取消" };
export function InvestorValuationPanel({ scope, disabled, onCommand, onDraftLockChange }: { scope: ValuationScope; disabled: boolean;
  onCommand: (intent: Record<string, unknown>) => void; onDraftLockChange: (locked: boolean) => void }) {
  const session = useSessionBoundary(), key = JSON.stringify(scope);
  const [reading, setReading] = useState<{ key: string; context: ValuationContext } | null>(null), [draft, setDraft] = useState<ValuationDraft | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = useRef<AbortController | null>(null), sequence = useRef(0), alive = useRef(true), invalidated = useRef(false), submitting = useRef(false);
  const verified = session?.verified === true && session.sessionBinding === scope.binding && !invalidated.current;
  const current = useRef({ key, scope, verified, disabled, draft }); current.current = { key, scope, verified, disabled, draft };
  const context = verified && !disabled && reading?.key === key ? reading.context : null;
  useEffect(() => {
    alive.current = true;
    const invalidate = () => { invalidated.current = true; sequence.current++; active.current?.abort(); setReading(null); setDraft(null); setBusy(false); setError(""); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => { alive.current = false; sequence.current++; active.current?.abort(); window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); };
  }, []);
  useEffect(() => { sequence.current++; active.current?.abort(); active.current = null; submitting.current = false; setReading(null); setDraft(null); setBusy(false); setError(""); }, [key]);
  useEffect(() => { if (!verified) { sequence.current++; active.current?.abort(); active.current = null; setReading(null); setDraft(null); setBusy(false); setError(""); } }, [verified]);
  useEffect(() => { onDraftLockChange(verified && (busy || draft !== null)); }, [verified, busy, draft, onDraftLockChange]);
  useEffect(() => () => onDraftLockChange(false), [onDraftLockChange]);
  useEffect(() => {
    if (!draft) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => { if (event.target instanceof Element && event.target.closest("a[href]")
      && !window.confirm("估值草稿尚未提交，离开会清除本地草稿。确定离开吗？")) { event.preventDefault(); event.stopPropagation(); } };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [draft !== null]);
  async function refresh() {
    const start = current.current;
    if (!start.verified || start.disabled || active.current || draft) return;
    const controller = new AbortController(), epoch = ++sequence.current; active.current = controller; setBusy(true); setError(""); setReading(null);
    const valid = () => alive.current && !invalidated.current && sequence.current === epoch && current.current.key === start.key && current.current.verified && !current.current.disabled;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/workbench/investor/valuation", { cache: "no-store", credentials: "same-origin", redirect: "error",
        headers: { "X-Workbench-Session-Binding": start.scope.binding }, signal: controller.signal });
      if (!valid()) return;
      if (response.status === 401) { window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); return; }
      if (!response.ok) throw new Error();
      const value = parseValuationContext(await response.json(), start.scope); if (!valid()) return;
      setReading({ key: start.key, context: value });
    } catch { if (valid()) setError("估值准备资料未通过核验。请先刷新顶部状态并核对账户；不会自动重提估值。"); }
    finally { clearTimeout(timer); controller.abort(); if (active.current === controller) { active.current = null; if (alive.current) setBusy(false); } }
  }
  function edit(change: Partial<ValuationDraft>) { setDraft(value => value ? { ...value, ...change, acknowledged: false } : value); setError(""); }
  function submit(event: FormEvent) {
    event.preventDefault(); if (!context || !draft || busy || disabled || submitting.current || !alive.current || invalidated.current || !current.current.verified
      || current.current.disabled || current.current.key !== key || current.current.draft !== draft) return;
    try { const intent = buildValuationIntent(context, draft); submitting.current = true; setDraft(null); setReading(null); onDraftLockChange(false); onCommand(intent); }
    catch { submitting.current = false; setError("请核对已发布来源、当地预期交易日、汇率时效、独立资料说明，并确认公司行动记录完整。不完整时先补数据，不勾选通过。"); }
  }
  const locked = disabled || busy || !verified || !context || context.read_only;
  const pendingTask = context?.task && ["queued", "running", "retry_queued"].includes(context.task.status);
  return <section aria-label="组合估值" className="min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6">
    <h2 className="text-lg font-semibold">4 · 对账后生成组合估值</h2>
    <p className="mt-3 text-sm text-muted-foreground">覆盖关联账本的全部账户，不只当前选中的账户。核对资料后提交后台估值，无需 JSON；不会改现金、持仓、策略或交易权限。</p>
    <Button className="mt-4" variant="outline" disabled={disabled || busy || !!draft || !verified} onClick={() => void refresh()}>核对估值准备情况与任务</Button>
    {busy && <p role="status" className="mt-3 text-sm">正在核对全部账户、独立对账与可用行情来源。</p>}
    {error && <p role="alert" className="mt-3 break-words text-sm text-red-600">{error}</p>}
    {context && <div className="mt-4 min-w-0 space-y-4 text-sm">
      {context.task && <p role="status">最近任务：{taskLabels[context.task.status]}。任务结束不等于估值完整；请点击下方“复核对照”独立复核结果。</p>}
      {context.gaps.length > 0 ? <p role="status">估值尚未就绪：全部账户（含停用账户）必须通过独立原件对账，且对账后没有新事实。先完成或修复上方各账户对账，再核对准备情况。</p> : <>
        <p className="break-words">共同估值截至：{context.cutoff_at} · 账本版本 {context.ledger_revision} · {context.accounts.length} 个账户。这是各账户已核对范围的最早截至时点，不是实时余额。</p>
        {!draft && <Button disabled={locked || !!pendingTask} onClick={() => { setDraft(blankValuationDraft(context)); setError(""); }}>选择来源并确认本次估值</Button>}
      </>}
      {draft && <form className="min-w-0 space-y-5" onSubmit={submit}><fieldset disabled={locked} className="min-w-0 space-y-5">
        {draft.prices.map((price, index) => <div key={price.market} className="grid min-w-0 gap-4 sm:grid-cols-2">
          <label className={field}>{marketLabels[price.market]}价格来源<select aria-label={`${marketLabels[price.market]}价格来源`} className={select} required value={price.scope} onChange={event => edit({ prices: draft.prices.map((row, i) => i === index ? { ...row, scope: event.target.value } : row) })}><option value="">请选择，不自动认证</option>{context.sources.filter(row => row.batch_type === "prices" && row.markets.includes(price.market)).map(row => <option key={row.scope} value={row.scope}>{row.scope} · v{row.revision} · {row.mode === "provider_observed" ? "采集回执已核验" : "人工来源声明（非供应商认证）"}</option>)}</select></label>
          <label className={field}>{marketLabels[price.market]}预期最近交易日<Input type="date" required value={price.session} onChange={event => edit({ prices: draft.prices.map((row, i) => i === index ? { ...row, session: event.target.value } : row) })} /></label>
        </div>)}
        {context.currencies.some(currency => currency !== "CNY") && <div className="grid min-w-0 gap-4 sm:grid-cols-2"><label className={field}>汇率来源<select aria-label="汇率来源" className={select} required value={draft.fxScope} onChange={event => edit({ fxScope: event.target.value })}><option value="">请选择</option>{context.sources.filter(row => row.batch_type === "fx").map(row => <option key={row.scope} value={row.scope}>{row.scope} · v{row.revision} · {row.mode === "provider_observed" ? "采集回执已核验" : "人工来源声明"}</option>)}</select></label>
          <label className={field}>允许的汇率最大时效<select aria-label="允许的汇率最大时效" className={select} required value={draft.fxAge} onChange={event => edit({ fxAge: event.target.value })}><option value="">请核对研究口径后选择</option>{[[86400, "1 天"], [259200, "3 天"], [604800, "7 天"], [2592000, "30 天"]].map(([seconds, label]) => <option key={seconds} value={seconds}>{label}</option>)}</select></label></div>}
        <p className="text-muted-foreground">来源仅列出本用户在本账本提交且已发布、可核验的价格/汇率。无可选项时先补齐行情；不使用演示数据、猜测价格或默认汇率。</p>
        {context.listings.length > 0 && <p className="break-words">需核查公司行动的历史标的：{context.listings.map(row => `${row.ticker} (${marketLabels[row.market]})`).join("、")}。为覆盖共同截至时点，包含曾记账标的；不表示它们当前仍持有。</p>}
        <label className={field}>本次规则核查的独立资料编号或说明<Input required maxLength={500} autoComplete="off" value={draft.reference} onChange={event => edit({ reference: event.target.value })} /></label>
        <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={draft.acknowledged} onChange={event => setDraft(value => value ? { ...value, acknowledged: event.target.checked } : value)} />我已核查截至上述时点的来源、当地交易日及汇率口径；涉及标的的分红、拆并股等公司行动已完整入账。不确定时先补资料；本次仅请求估值，不认证供应商、不批准交易。</label>
        <div className="flex flex-wrap gap-3"><Button disabled={locked || !draft.acknowledged || !!pendingTask}>提交本次组合估值</Button><Button type="button" variant="outline" onClick={() => { setDraft(null); setError(""); }}>取消估值草稿</Button></div>
      </fieldset></form>}
    </div>}
  </section>;
}
