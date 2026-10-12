"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import { RECONCILIATION_BALANCES } from "@/server/ledger/reconciliation-schemas";
import type { ReconciliationContext } from "@/server/investor/reconciliation-schemas";
import { blankStatementCurrency, blankStatementDraft, buildReconciliationIntent, parseInvestorReconciliation, statementDayCutoff,
  STATEMENT_ZONES, type ReconciliationScope, type StatementDraft } from "./investor-reconciliation-client";

const field = "flex min-w-0 flex-col gap-2 text-sm", select = "h-11 w-full min-w-0 rounded-lg border bg-background px-3";
const balanceLabels = { cash_settled: "已结算现金", trade_receivable: "交易应收", trade_payable: "交易应付", dividend_receivable: "股息应收",
  transfer_in_transit: "资金在途", other_liability: "其他负债", cash_hold: "现金冻结", dividend_tax_payable: "股息税应付" };
const issueLabels: Record<string, string> = { balance_mismatch: "金额不一致", position_mismatch: "证券数量不一致", missing_statement_position: "原件缺少证券数量",
  missing_currency_coverage: "币种覆盖不完整", missing_statement_balance: "余额科目缺失", security_transit_mismatch: "证券在途不一致" };

export function InvestorReconciliationPanel({ scope, accountName, disabled, onCommand, onDraftLockChange }: {
  scope: ReconciliationScope; accountName: string; disabled: boolean; onCommand: (intent: Record<string, unknown>) => void; onDraftLockChange: (locked: boolean) => void;
}) {
  const session = useSessionBoundary(), key = JSON.stringify(scope);
  const [reading, setReading] = useState<{ key: string; context: ReconciliationContext } | null>(null), [draft, setDraft] = useState<StatementDraft | null>(null);
  const [drafting, setDrafting] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [currencyChoice, setCurrencyChoice] = useState(""), [listingChoice, setListingChoice] = useState("");
  const active = useRef<AbortController | null>(null), epoch = useRef(0), alive = useRef(true), invalidated = useRef(false);
  const verified = session?.verified === true && session.sessionBinding === scope.binding && !invalidated.current;
  const current = useRef({ scope, key, disabled, verified }); current.current = { scope, key, disabled, verified };
  const context = verified && !disabled && reading?.key === key ? reading.context : null;
  const refresh = useCallback(async () => {
    const start = current.current;
    if (start.disabled || !start.verified || active.current) return;
    const controller = new AbortController(), sequence = ++epoch.current;
    active.current = controller; setBusy(true); setReading(null); setError("");
    const valid = () => alive.current && !invalidated.current && sequence === epoch.current && current.current.key === start.key && current.current.verified && !current.current.disabled;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/workbench/investor/reconciliation?account=${encodeURIComponent(start.scope.accountId)}`,
        { cache: "no-store", credentials: "same-origin", redirect: "error", headers: { "X-Workbench-Session-Binding": start.scope.binding }, signal: controller.signal });
      if (!valid()) return;
      if (response.status === 401) { window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); return; }
      if (!response.ok) throw new Error("INVESTOR_RECONCILIATION_UNAVAILABLE");
      const value = parseInvestorReconciliation(await response.json(), start.scope);
      if (valid()) setReading({ key: start.key, context: value });
    } catch { if (valid()) setError("对账范围读取未通过核验。请先核对顶部状态与账户资料，再重读；不会使用旧范围提交。"); }
    finally { clearTimeout(timer); if (active.current === controller) { active.current = null; if (alive.current) setBusy(false); } }
  }, []);
  useEffect(() => {
    alive.current = true;
    const invalidate = () => { invalidated.current = true; epoch.current++; active.current?.abort(); setReading(null); setDraft(null); setDrafting(false); setError(""); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => { alive.current = false; epoch.current++; active.current?.abort(); window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); };
  }, []);
  useEffect(() => {
    epoch.current++; active.current?.abort(); active.current = null; setReading(null); setDraft(null); setDrafting(false); setError(""); setBusy(false);
    setCurrencyChoice(""); setListingChoice("");
  }, [key]);
  useEffect(() => {
    if (!verified) { epoch.current++; active.current?.abort(); active.current = null; setBusy(false); }
  }, [verified]);
  useEffect(() => {
    if (verified && !disabled && !drafting && !reading) void refresh();
    // Retry is explicit after a failed read; never loop on a 503 or lost response.
  }, [key, verified, disabled, drafting, refresh]);
  useEffect(() => { onDraftLockChange(drafting || verified && busy); }, [verified, drafting, busy, onDraftLockChange]);
  useEffect(() => () => onDraftLockChange(false), [onDraftLockChange]);
  useEffect(() => {
    if (!drafting) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => { const link = event.target instanceof Element && event.target.closest("a[href]");
      if (link && !window.confirm("独立对账草稿尚未提交，离开将丢失本地草稿。确定离开吗？")) { event.preventDefault(); event.stopPropagation(); } };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [drafting]);
  function edit(change: (value: StatementDraft) => StatementDraft) {
    setDraft(value => value ? { ...change(value), acknowledged: false } : value); setError("");
  }
  function submit(event: FormEvent) {
    event.preventDefault(); if (!context || !draft || disabled || busy || context.read_only) return;
    try {
      const intent = buildReconciliationIntent(context, draft);
      setDrafting(false); setDraft({ ...draft, acknowledged: false }); onDraftLockChange(false); onCommand(intent);
    } catch { setError("请填写独立资料编号、已结束的日期与时区、每个币种金额及全部证券/在途数量，并明确确认。未知项不能用零代替；解决旧差异需填写原因。单次资料上限为 32 KiB。"); }
  }
  const locked = disabled || busy || !verified || !context || context.read_only;
  return <section aria-label="独立对账" className="min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">3 · 独立对账</h2>
      <Button variant="outline" disabled={disabled || busy || drafting || !verified} onClick={() => void refresh()}>重读对账范围</Button></div>
    <p className="mt-3 text-sm text-muted-foreground">从券商账单或其他独立资料转录，不从本工具余额复制。只保存你的结构化转录及审计，不代表上传券商原件或券商直接认证；不会补现金、改持仓或批准交易。</p>
    {error && <p role="alert" className="mt-4 break-words text-sm text-red-600">{error}</p>}
    {!context && !error && <p role="status" className="mt-4 text-sm">正在核对当前账户与版本，不使用缓存金额。</p>}
    {context && <>
      <p className="mt-4 break-words text-sm">对账账户：{accountName} · 当前账本版本 {context.ledger_revision}</p>
      {context.history_status === "unavailable" ? <p role="status" className="mt-3 text-sm text-amber-700">旧对账原件或审计未通过复核，不显示旧匹配结果，也不能在这里解决旧差异。仍可提交新的独立资料；既有未决差异 {context.open_issue_count} 项不会自动清除。</p>
        : context.latest ? <div className="mt-3 rounded-xl border p-3 text-sm"><p>最近已保存对账：{context.latest.status === "matched" ? "本次资料匹配" : `本次资料有 ${context.latest.issue_count} 项差异`} · {context.latest.cutoff_at}</p>
          <p className="mt-2 text-xs text-muted-foreground">{context.latest.current_facts ? "对应当前账本版本。" : "账本版本已变化，旧结果不是当前匹配证明。"} 未决差异 {context.open_issue_count} 项；匹配也不代表净值已更新或可以交易。</p></div>
          : <p className="mt-3 text-sm">尚未保存该账户的独立对账。</p>}
      {!drafting && <Button className="mt-4" disabled={locked} onClick={() => { setDraft(value => value ?? blankStatementDraft(context)); setDrafting(true); setError(""); }}>{draft ? "继续核对本地草稿" : "录入独立资料"}</Button>}
      {drafting && draft && <form onSubmit={submit} className="mt-5 space-y-5"><fieldset disabled={locked} className="min-w-0 space-y-5">
        <div className="grid gap-4 sm:grid-cols-2"><label className={field}>独立资料编号或说明<Input value={draft.source} maxLength={500} required autoComplete="off" onChange={e => edit(v => ({ ...v, source: e.target.value }))} /></label>
          <label className={field}>账单截至日期（完整当地日）<Input type="date" value={draft.date} required onChange={e => edit(v => ({ ...v, date: e.target.value }))} /></label>
          <label className={field}>账单时区<select aria-label="账单时区" className={select} value={draft.zone} required onChange={e => edit(v => ({ ...v, zone: e.target.value }))}><option value="">请按原件选择</option>{STATEMENT_ZONES.map(zone => <option key={zone}>{zone}</option>)}</select></label></div>
        {draft.date && draft.zone && <p className="break-words text-xs text-muted-foreground">完整日边界（UTC）：{statementDayCutoff(draft.date, draft.zone) ?? "日期无效"}。若当日事实只有日期，必须等该地完整日结束；不伪造盘中时点。</p>}
        {draft.currencies.map((row, index) => <div key={row.currency} className="min-w-0 rounded-xl border p-4"><h3 className="font-medium">{row.currency} · 原件金额</h3>
          <label className={`${field} mt-3`}>已结算现金<Input inputMode="decimal" value={row.balances.cash_settled} required maxLength={80} autoComplete="off"
            onChange={e => edit(v => ({ ...v, currencies: v.currencies.map((r, i) => i === index ? { ...r, balances: { ...r.balances, cash_settled: e.target.value } } : r) }))} /></label>
          <label className="mt-4 flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={row.zeroOthers}
            onChange={e => edit(v => ({ ...v, currencies: v.currencies.map((r, i) => i === index ? { ...r, zeroOthers: e.target.checked } : r) }))} />我已核对该币种其他七项均为零（不包含证券持仓和证券在途）</label>
          {!row.zeroOthers && <div className="mt-4 grid gap-3 sm:grid-cols-2">{RECONCILIATION_BALANCES.filter(key => key !== "cash_settled").map(key => <label key={key} className={field}>{balanceLabels[key]}<Input inputMode="decimal" required maxLength={80} value={row.balances[key]} autoComplete="off"
            onChange={e => edit(v => ({ ...v, currencies: v.currencies.map((r, i) => i === index ? { ...r, balances: { ...r.balances, [key]: e.target.value } } : r) }))} /></label>)}</div>}
          <p className="mt-3 text-xs text-muted-foreground">应收、应付及冻结使用本系统带符号口径；不确定原件含义时先核对，不把未知项视作零。金额不使用千分位。</p></div>)}
        <div className="flex flex-wrap items-end gap-3"><label className={field}>原件另有币种<Input value={currencyChoice} maxLength={3} autoComplete="off" onChange={e => setCurrencyChoice(e.target.value.toUpperCase())} /></label>
          <Button type="button" variant="outline" disabled={draft.currencies.length >= 20 || !/^[A-Z]{3}$/.test(currencyChoice) || draft.currencies.some(row => row.currency === currencyChoice)}
            onClick={() => { edit(v => ({ ...v, currencies: [...v.currencies, blankStatementCurrency(currencyChoice)] })); setCurrencyChoice(""); }}>添加币种</Button></div>
        <div><h3 className="font-medium">证券数量（无此证券也请明确填 0）</h3>
          {!draft.positions.length && <p className="mt-2 text-sm text-muted-foreground">账本未记录非零证券。若原件另有持仓，请从下方明确添加；目录缺标的时先登记身份，不按名字猜测。</p>}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">{draft.positions.map((row, index) => { const listing = context.requirements.listings.find(item => item.id === row.listingId);
            return <label key={row.listingId} className={field}>{listing?.name} · {listing?.ticker} · {listing?.market} · {listing?.currency}<Input required inputMode="decimal" maxLength={80} value={row.quantity} autoComplete="off"
              onChange={e => edit(v => ({ ...v, positions: v.positions.map((r, i) => i === index ? { ...r, quantity: e.target.value } : r) }))} /></label>; })}</div>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row"><select aria-label="添加原件证券" className={select} value={listingChoice} onChange={e => setListingChoice(e.target.value)}><option value="">选择该私有账本的明确证券</option>
            {context.requirements.listings.filter(row => !draft.positions.some(item => item.listingId === row.id)).map(row => <option key={row.id} value={row.id}>{row.ticker} · {row.market} · {row.currency} · {row.name}</option>)}</select>
            <Button type="button" variant="outline" disabled={!listingChoice || draft.positions.length >= 100} onClick={() => { const listing = context.requirements.listings.find(row => row.id === listingChoice); if (!listing) return;
              edit(v => ({ ...v, positions: [...v.positions, { listingId: listing.id, quantity: "" }], currencies: v.currencies.some(row => row.currency === listing.currency) ? v.currencies : [...v.currencies, blankStatementCurrency(listing.currency)] })); setListingChoice(""); }}>添加证券</Button></div></div>
        {!!draft.transits.length && <div><h3 className="font-medium">证券转移在途数量</h3><div className="mt-3 grid gap-3 sm:grid-cols-2">{draft.transits.map((row, index) => { const transit = context.requirements.transits.find(value => value.transfer_event_id === row.transferId)!;
          const listing = context.requirements.listings.find(value => value.id === transit.listing_id);
          return <label key={row.transferId} className={field}>{transit.source_name} → {transit.target_name} · {listing?.ticker}<span className="break-all text-xs text-muted-foreground">转移记录 {row.transferId}</span>
            <Input required inputMode="decimal" value={row.quantity} maxLength={80} autoComplete="off" onChange={e => edit(v => ({ ...v, transits: v.transits.map((r, i) => i === index ? { ...r, quantity: e.target.value } : r) }))} /></label>; })}</div></div>}
        {!!context.open_issues.length && <details><summary className="cursor-pointer text-sm">明确处理旧差异（{context.open_issues.length} 项，不自动关闭）</summary><div className="mt-3 space-y-3">{context.open_issues.map(row => <label key={row.id} className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1" checked={draft.resolves.includes(row.id)} onChange={e => edit(v => ({ ...v, resolves: e.target.checked ? [...v.resolves, row.id] : v.resolves.filter(id => id !== row.id) }))} />
          <span className="min-w-0 break-words">{issueLabels[row.code] ?? row.code} · {row.cutoff_at}<span className="mt-1 block break-all text-xs text-muted-foreground">{row.id}</span></span></label>)}
          <label className={field}>解决原因（所选差异仅在新资料全部匹配后解决）<Input value={draft.resolutionReason} maxLength={500} required={draft.resolves.length > 0} autoComplete="off" onChange={e => edit(v => ({ ...v, resolutionReason: e.target.value }))} /></label></div></details>}
        <div className="rounded-xl border border-amber-500/40 p-4 text-sm"><h3 className="font-medium">提交前核对</h3><p className="mt-2">将保存 {draft.currencies.length} 个币种的 8 类金额、{draft.positions.length} 项证券、{draft.transits.length} 项在途和完整覆盖声明。没有从账本预填金额或数量。提交可能记录差异并更新对账状态，但不会修改金融事实。</p>
          <label className="mt-4 flex items-start gap-3"><input type="checkbox" className="mt-1" checked={draft.acknowledged} onChange={e => setDraft(v => v ? { ...v, acknowledged: e.target.checked } : v)} />我已逐项对照独立资料，确认币种、余额、持仓和在途覆盖完整；明确的零值确实为零。我理解这是人工转录，不是券商认证或交易批准。</label></div>
        <div className="flex flex-wrap gap-3"><Button disabled={locked || !draft.acknowledged}>保存独立资料并对账</Button><Button type="button" variant="outline" onClick={() => { setDrafting(false); setDraft(null); setError(""); }}>取消并清除草稿</Button></div>
      </fieldset></form>}
    </>}
    <Link className="mt-5 inline-block text-sm underline" href="/workbench/ledger">高级账本：原件、差异详情与估值</Link>
  </section>;
}
