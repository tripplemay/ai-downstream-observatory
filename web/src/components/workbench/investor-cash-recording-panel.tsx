"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import { TRADE_RECORDING_ZONES } from "@/server/investor/trade-recording-schemas";
import type { CashRecordingContext } from "@/server/investor/cash-recording-schemas";
import { blankCashRecordingDraft, buildCashRecordingIntent, parseCashRecordingContext, type CashRecordingDraft } from "./investor-cash-recording-client";
import type { ReconciliationScope } from "./investor-reconciliation-client";

const field = "flex min-w-0 flex-col gap-2 text-sm", select = "h-11 w-full min-w-0 rounded-lg border bg-background px-3";
export function InvestorCashRecordingPanel({ scope, accountName, disabled, onCommand, onDraftLockChange }: {
  scope: ReconciliationScope; accountName: string; disabled: boolean; onCommand: (intent: Record<string, unknown>) => void; onDraftLockChange: (locked: boolean) => void;
}) {
  const session = useSessionBoundary(), key = JSON.stringify(scope);
  const [reading, setReading] = useState<{ key: string; context: CashRecordingContext } | null>(null), [draft, setDraft] = useState<CashRecordingDraft | null>(null);
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
  useEffect(() => { if (!verified) { epoch.current++; active.current?.abort(); active.current = null; setReading(null); setDraft(null); setBusy(false); setError(""); } }, [verified]);
  useEffect(() => { onDraftLockChange(verified && (busy || draft !== null)); }, [verified, busy, draft, onDraftLockChange]);
  useEffect(() => () => onDraftLockChange(false), [onDraftLockChange]);
  useEffect(() => {
    if (!draft) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => { const link = event.target instanceof Element && event.target.closest("a[href]");
      if (link && !window.confirm("资金回录草稿尚未提交，离开会丢失本地草稿。确定离开吗？")) { event.preventDefault(); event.stopPropagation(); } };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [draft !== null]);
  async function begin() {
    const start = current.current;
    if (!start.verified || start.disabled || active.current || draft) return;
    const controller = new AbortController(), sequence = ++epoch.current;
    active.current = controller; setBusy(true); setError(""); setReading(null);
    const valid = () => alive.current && !invalidated.current && sequence === epoch.current && current.current.key === start.key && current.current.verified && !current.current.disabled;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/workbench/investor/cash-recording?account=${encodeURIComponent(start.scope.accountId)}`, {
        cache: "no-store", credentials: "same-origin", redirect: "error", headers: { "X-Workbench-Session-Binding": start.scope.binding }, signal: controller.signal });
      if (!valid()) return;
      if (response.status === 401) { window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); return; }
      if (!response.ok) throw new Error();
      const value = parseCashRecordingContext(await response.json(), start.scope);
      if (!valid()) return;
      if (value.read_only || value.account_status === "disabled") throw new Error();
      setReading({ key: start.key, context: value }); setDraft(blankCashRecordingDraft()); submitting.current = false;
    } catch { if (valid()) setError("当前账户或版本未通过核验。请核对顶部状态与账户资料后重试，不使用旧范围入账。"); }
    finally { clearTimeout(timer); if (active.current === controller) { active.current = null; if (alive.current) setBusy(false); } }
  }
  function edit(change: Partial<CashRecordingDraft>) { setDraft(value => value ? { ...value, ...change, acknowledged: false } : value); setError(""); }
  function submit(event: FormEvent) {
    event.preventDefault(); if (!context || !draft || busy || disabled || !alive.current || invalidated.current || submitting.current
      || current.current.key !== key || !current.current.verified || current.current.disabled) return;
    try {
      const intent = buildCashRecordingIntent(context, draft); submitting.current = true;
      setDraft(null); setReading(null); onDraftLockChange(false); onCommand(intent);
    } catch { submitting.current = false; setError("请按独立资料核对外部入金/出金方向、币种、正数金额（最多两位小数）、实际日期、时区和唯一来源编号，并明确确认。计划、内部划拨和成交交收不能在此当作入金或出金。"); }
  }
  const locked = disabled || busy || !verified || !context || context.read_only || context.account_status === "disabled";
  return <section aria-label="人工资金回录" className="min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6">
    <h2 className="text-lg font-semibold">2a · 回录已发生的外部入金或出金</h2>
    <p className="mt-3 text-sm text-muted-foreground">少量资金记录可直接填写，不必准备 CSV。仅转录已发生的组合外部资金流；不会发起转账，不读取计划金额，也不会将预算确认为到账。</p>
    <details className="mt-3 text-sm text-muted-foreground"><summary className="cursor-pointer">哪些记录不应在这里填写</summary><p className="mt-2">账本内账户互转、换汇、成交交收和费用应使用各自事实，不能再次算作外部本金。金额填写独立资料中的资金本金，不混入手续费；费用或期初余额资料不完整时先通过高级账本核对，不反推或补造现金。</p></details>
    {error && <p role="alert" className="mt-4 break-words text-sm text-red-600">{error}</p>}
    {busy && <p role="status" className="mt-4 text-sm">正在核对账户与版本，不读取或预填资金金额。</p>}
    {!draft && <Button className="mt-4" variant="outline" disabled={disabled || busy || !verified} onClick={() => void begin()}>录入已到账或已转出资金</Button>}
    {draft && context && <form onSubmit={submit} className="mt-5 space-y-5"><fieldset disabled={locked} className="min-w-0 space-y-5">
      <p className="break-words text-sm">账户：{accountName} · 账本版本 {context.ledger_revision} · 非转账指令</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={field}>已发生的资金方向<select aria-label="已发生的资金方向" className={select} value={draft.direction} required onChange={event => edit({ direction: event.target.value })}><option value="">请按实际记录选择</option><option value="deposit">外部入金（已到账）</option><option value="withdrawal">外部出金（已转出）</option></select></label>
        <label className={field}>实际资金币种<select aria-label="实际资金币种" className={select} value={draft.currency} required onChange={event => edit({ currency: event.target.value })}><option value="">请按原件选择</option>{context.allowed_currencies.map(currency => <option key={currency}>{currency}</option>)}</select></label>
        <label className={field}>实际资金本金（不含费用）<Input inputMode="decimal" required value={draft.amount} maxLength={15} autoComplete="off" onChange={event => edit({ amount: event.target.value })} /></label>
        <label className={field}>实际资金日期<Input type="date" required value={draft.date} onChange={event => edit({ date: event.target.value })} /></label>
        <label className={field}>资金资料时区<select aria-label="资金资料时区" className={select} required value={draft.zone} onChange={event => edit({ zone: event.target.value })}><option value="">请按原件选择</option>{TRADE_RECORDING_ZONES.map(zone => <option key={zone}>{zone}</option>)}</select></label>
        <label className={field}>资金来源标识（与后续 CSV 保持一致）<Input required value={draft.source} maxLength={120} autoComplete="off" onChange={event => edit({ source: event.target.value })} /></label>
        <label className={field}>原始资金流水唯一编号<Input required value={draft.sourceEvent} maxLength={120} autoComplete="off" onChange={event => edit({ sourceEvent: event.target.value })} /></label>
        <label className={field}>资金独立资料编号或说明<Input required value={draft.reference} maxLength={500} autoComplete="off" onChange={event => edit({ reference: event.target.value })} /></label>
      </div>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={draft.acknowledged} onChange={event => setDraft(value => value ? { ...value, acknowledged: event.target.checked } : value)} />我已核对独立资料：这是已发生的外部资金本金，不是计划、内部划拨、成交交收或费用；我确认方向、币种、金额、日期和来源编号正确。</label>
      <div className="flex flex-wrap gap-3"><Button disabled={locked || !draft.acknowledged}>保存已发生的资金事实</Button><Button type="button" variant="outline" onClick={() => { setDraft(null); setReading(null); setError(""); }}>取消并清除资金草稿</Button></div>
    </fieldset></form>}
  </section>;
}
