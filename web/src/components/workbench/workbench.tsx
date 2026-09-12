"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import type { WorkbenchState } from "@/server/ledger/queries";
import type { ImportPreview } from "@/server/ledger/imports";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OperationsPanels } from "./operations-panels";
import { SecurityTransfers } from "./security-transfers";
import { CsvWorkspace } from "./csv-workspace";
import { DividendWorkspace } from "./dividend-workspace";
import type { CsvScope } from "./csv-workspace-state";

const field = "flex min-w-0 flex-col gap-1.5 text-sm";
const selectClass = "h-10 w-full min-w-0 max-w-full rounded-md border bg-background px-3";
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-xl border bg-card p-5 shadow-sm"><h2 className="mb-4 text-lg font-semibold">{title}</h2>{children}</section>;
}

export function Workbench({ initial }: { initial: WorkbenchState }) {
  const [state, setState] = useState(initial), [busy, setBusy] = useState(true), [error, setError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); setBusy(false); }, []);
  const [notice, setNotice] = useState(""), [preview, setPreview] = useState<ImportPreview | null>(null);
  const [rawImport, setRawImport] = useState("");
  const [csvAccount, setCsvAccount] = useState("");
  const [csvScopeLocked, setCsvScopeLocked] = useState(false);
  const selectedCsvAccount = state.accounts.some(account => account.id === csvAccount) ? csvAccount : state.accounts[0]?.id ?? "";
  const selected = state.selected;
  const accountName = (id: string) => state.accounts.find(a => a.id === id)?.name ?? id;
  const refresh = useCallback(async (portfolio = selected) => {
    const response = await fetch(`/api/workbench${portfolio ? `?portfolio=${encodeURIComponent(portfolio)}` : ""}`, { cache: "no-store" });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    setState(value);
  }, [selected]);
  const csvCommitted = useCallback(async () => { await refresh(); setPreview(null); }, [refresh]);
  const restoreCsvScope = useCallback(async (scope: CsvScope) => {
    await refresh(scope.portfolioId); setCsvAccount(scope.accountId); setPreview(null);
  }, [refresh]);
  async function mutate(body: unknown) {
    if (state.read_only) throw new Error("当前为恢复只读模式，核对完成前不能修改账本或提交任务。");
    const response = await fetch("/api/workbench", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value;
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>, action: (data: FormData) => Promise<void>) {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form);
    void perform(async () => { await action(data); form.reset(); });
  }

  return <div inert={!hydrated} aria-busy={busy} data-hydrated={hydrated} className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-medium text-muted-foreground">ETF / PORTFOLIO WORKBENCH</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">账户与投资账本</h1><p className="mt-2 text-sm text-muted-foreground">以真实资金和可追溯事实为起点。预算不是现金，入金不是盈利。</p></div><span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-sm">开发验证中 · 实盘建议未启用</span></header>
    {error && <div role="alert" className="break-words rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm">{error}</div>}
    {notice && <div role="status" className="rounded-lg border p-4 text-sm">{notice}</div>}
    {state.read_only && <div role="status" className="rounded-lg border border-amber-500/40 p-4 text-sm">恢复只读模式：允许查看记录与下载原件；全部写入和后台任务已锁定，需按恢复流程完成核对。</div>}
    <div className="grid gap-4 md:grid-cols-3"><Section title="当前资金计划"><p className="break-words text-xl font-semibold">{state.funding_summary.title ?? "尚未确认日期化计划"}</p><p className="mt-2 text-sm text-muted-foreground">{state.funding_summary.status === "confirmed_plan" ? `计划版本 ${state.funding_summary.version} · ${state.funding_summary.source_count} 个资金来源 · ${state.funding_summary.tranche_count} 个投入批次` : state.funding_summary.status === "not_configured" ? "尚无资金计划；请自行登记日期化预算并确认。" : "资金计划待核实；请检查当前版本与来源。"}</p><Link className="mt-3 inline-block text-sm underline" href="/workbench/funding">管理资金计划与投入批次</Link></Section><Section title="计划来源预算（非资产）">{state.funding_summary.totals.length ? state.funding_summary.totals.map(row => <p key={row.currency} className="break-all font-mono text-xl">{row.planned_amount} {row.currency}</p>) : <p className="text-xl">尚无已确认预算</p>}<p className="mt-2 text-sm text-muted-foreground">{state.funding_summary.period_start ? `${state.funding_summary.period_start} 至 ${state.funding_summary.period_end}。` : ""}仅汇总当前计划中未取消的来源，不含收益，不作跨币种折算。</p></Section><Section title="事实状态"><p className="text-3xl font-semibold">{state.accounts.length} 个账户</p><p className="mt-2 text-sm text-muted-foreground">账本版本 {state.revision} · 快照 {state.valuation_status}。本金与盈利分开，规划预算不计入余额。</p></Section></div>
    <Section title="组合工作区"><div className="flex flex-wrap gap-3">{state.portfolios.map(p => <Button key={p.id} variant={selected === p.id ? "default" : "outline"} disabled={busy || csvScopeLocked} onClick={() => { if (!csvScopeLocked) void perform(async () => { setPreview(null); await refresh(p.id); }); }}>{p.name}</Button>)}</div><form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={e => { if (csvScopeLocked) { e.preventDefault(); return; } submit(e, async data => { const result = await mutate({ action: "create_portfolio", name: data.get("name") }); await refresh(result.id); setNotice("组合已创建。尚无资金计划和现金；需另行录入并确认。"); }); }}><label className={field}>新组合名称<Input name="name" maxLength={120} required disabled={csvScopeLocked} placeholder="长期 ETF 组合" /></label><Button disabled={busy || csvScopeLocked}>建立空账本</Button></form>{csvScopeLocked && <p className="mt-3 text-sm text-muted-foreground">CSV 请求处理中或确认结果未决，暂不切换组合与导入账户；先核对原批次状态。</p>}</Section>
    {selected && <>
      <div className="grid gap-6 lg:grid-cols-2"><Section title="账户建档"><form className="grid gap-3 sm:grid-cols-2" onSubmit={e => submit(e, async data => { await mutate({ action: "create_account", portfolio_id: selected, name: data.get("name"), broker: data.get("broker"), currency: data.get("currency") }); await refresh(); setNotice("账户已建立，状态为待对账；市场权限仍需另行核实。"); })}><label className={field}>账户别名<Input name="name" maxLength={120} required placeholder="国内主账户" /></label><label className={field}>券商<Input name="broker" maxLength={120} required placeholder="国内券商 / 跨境券商" /></label><label className={field}>基础币种<select name="currency" className={selectClass}><option>CNY</option><option>HKD</option><option>USD</option></select></label><Button className="self-end" disabled={busy}>添加账户</Button></form><ul className="mt-5 space-y-2">{state.accounts.map(a => <li key={a.id} className="flex flex-wrap justify-between gap-2 border-t pt-2 text-sm"><span>{a.name} · {a.broker} · {a.base_currency}</span><span className="text-amber-600">{a.status === "reconciliation_required" ? "待对账" : a.status}</span></li>)}</ul></Section>
      <Section title="确认现金事实"><p className="mb-4 text-sm text-muted-foreground">只登记已经发生且可核实的金额。实际日期不可用计划日期代替；其他事件通过标准导入录入。</p><form className="grid gap-3 sm:grid-cols-2" onSubmit={e => submit(e, async data => { await mutate({ action: "record_fact", command: { portfolio_id: selected, expected_revision: state.revision, idempotency_key: crypto.randomUUID(), source_id: "manual", source_event_id: String(data.get("source_event_id")), effective_at: data.get("date"), time_precision: "date", source_timezone: "Asia/Shanghai", reason: data.get("reason"), fact: { type: data.get("type"), account_id: data.get("account"), currency: data.get("currency"), amount: data.get("amount") } } }); await refresh(); setPreview(null); setNotice("事实已入账，账户需重新对账。追加本金未计作盈利。"); })}><label className={field}>账户<select name="account" required className={selectClass}>{state.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label className={field}>事件<select name="type" className={selectClass}><option value="opening_cash">期初现金</option><option value="deposit">实际入金</option><option value="withdrawal">实际出金</option><option value="fee">实际费用</option></select></label><label className={field}>金额<Input name="amount" inputMode="decimal" required placeholder="例如 1000.00" /></label><label className={field}>原币<select name="currency" className={selectClass}><option>CNY</option><option>HKD</option><option>USD</option></select></label><label className={field}>实际日期（上海时区）<Input name="date" type="date" required /></label><label className={field}>来源记录号<Input name="source_event_id" required maxLength={120} /></label><label className={`${field} sm:col-span-2`}>核实依据 / 说明<Input name="reason" required maxLength={2000} placeholder="银行或券商流水记录" /></label><Button disabled={busy || !state.accounts.length} className="sm:col-span-2">确认已发生事实并入账</Button></form></Section></div>
      <Section title="原币余额与持仓"><p className="mb-3 text-sm text-muted-foreground">以下为分录投影，不是人民币总净资产。借方为正，应付款显示为负；成本未知不填造历史成本。</p><div className="overflow-x-auto"><table className="w-full min-w-[480px] text-left text-sm"><thead><tr className="border-b"><th className="p-2">账户</th><th className="p-2">币种</th><th className="p-2">科目</th><th className="p-2 text-right">原币金额</th></tr></thead><tbody>{state.balances.filter(b => ["cash_settled", "trade_receivable", "trade_payable", "dividend_receivable", "dividend_tax_payable", "other_liability", "transfer_in_transit"].includes(b.ledger_account)).map(b => <tr key={`${b.account_id}:${b.currency}:${b.ledger_account}`} className="border-b"><td className="p-2">{accountName(b.account_id)}</td><td className="p-2">{b.currency}</td><td className="p-2">{b.ledger_account}</td><td className="p-2 text-right font-mono">{b.balance}</td></tr>)}</tbody></table></div>{!state.balances.length && <p className="mt-4 text-sm text-muted-foreground">尚无资金事实。规划预算不会自动显示为余额。</p>}{state.positions.map(p => <p key={`${p.account_id}:${p.listing_id}`} className="mt-3 text-sm">{accountName(p.account_id)} / {p.ticker} {p.name}：{p.quantity} 份 · 成本 {p.cost_known ? `${p.cost_amount} ${p.currency}` : "未知"}</p>)}</Section>
      <fieldset disabled={busy} className="min-w-0 space-y-3"><label className={field}>CSV 导入账户<select aria-label="CSV 导入账户" className={selectClass} value={selectedCsvAccount} disabled={csvScopeLocked} onChange={event => { if (!csvScopeLocked) setCsvAccount(event.target.value); }}>{state.accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><CsvWorkspace portfolioId={selected} accountId={selectedCsvAccount} revision={state.revision} readOnly={state.read_only} onScopeLockChange={setCsvScopeLocked} onRestorePendingScope={restoreCsvScope} onCommitted={csvCommitted} /></fieldset>
      <Section title="标准 JSON 导入"><p className="mb-3 text-sm text-muted-foreground">先预览，再确认；任何关键错误阻断整批。此入口仅接受标准事实 JSON；CSV 请使用上方原件与映射入口，国内券商及跨境券商原生格式仍待样例核验。</p><form className="space-y-3" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void perform(async () => { const result = await mutate({ action: "preview_import", portfolio_id: selected, account_id: data.get("account"), raw: rawImport }); setPreview(result); await refresh(); }); }}><label className={field}>导入账户<select name="account" required className={selectClass}>{state.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label className={field}>标准事件数组<textarea aria-label="标准事件数组" className="min-h-40 rounded-md border bg-background p-3 font-mono text-xs" value={rawImport} onChange={e => setRawImport(e.target.value)} placeholder='[{"source_id":"broker", "source_event_id":"...", "effective_at":"2026-01-01", "time_precision":"date", "source_timezone":"Asia/Shanghai", "reason":"对账单", "fact":{"type":"deposit", "account_id":"...", "currency":"CNY", "amount":"1000"}}]' required /></label><Button disabled={busy || !state.accounts.length}>校验并预览（不入账）</Button></form>{preview && <div className="mt-4 space-y-3 rounded-lg border p-4"><p>批次状态：{preview.status} · {preview.rows.length} 行 · 依据账本版本 {preview.expected_revision}</p>{preview.rows.map(r => <p key={r.row} className="break-words text-sm">第 {r.row} 行：{r.errors.length ? r.errors.join("；") : `${r.command?.fact.type} / 校验通过`}</p>)}<Button disabled={busy || preview.status !== "preview"} onClick={() => void perform(async () => { await mutate({ action: "confirm_import", portfolio_id: selected, batch_id: preview.id, preview_hash: preview.preview_hash, expected_revision: preview.expected_revision }); setPreview(null); await refresh(); setNotice("整批事实已原子提交；重复来源不重复入账。"); })}>确认整批入账</Button></div>}</Section>
      <SecurityTransfers key={`${selected}:${state.revision}`} state={state} busy={busy} mutate={mutate} perform={perform} refresh={refresh} notice={setNotice} />
      <DividendWorkspace state={state} busy={busy} onCommitted={async () => { await refresh(); setPreview(null); }} />
      <OperationsPanels state={state} busy={busy} mutate={mutate} perform={perform} refresh={refresh} notice={setNotice} />
      <Section title="最近事实记录"><p className="mb-3 text-sm text-muted-foreground">展示最近 100 条原始记录（含冲销）；已记录事实不可原地覆盖。</p><div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left text-sm"><thead><tr className="border-b"><th className="p-2">版本</th><th className="p-2">实际日期</th><th className="p-2">账户</th><th className="p-2">事件</th><th className="p-2">记录时间</th></tr></thead><tbody>{state.events.map(e => <tr key={e.id} className="border-b"><td className="p-2">{e.ledger_revision}</td><td className="p-2">{e.effective_at}</td><td className="p-2">{accountName(e.account_id)}</td><td className="p-2">{e.event_type}</td><td className="p-2">{e.recorded_at}</td></tr>)}</tbody></table></div></Section>
    </>}
  </div>;
}
