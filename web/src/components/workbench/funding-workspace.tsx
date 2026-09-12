"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Decimal from "decimal.js";
import type { WorkbenchState } from "@/server/ledger/queries";
import type { FundingState } from "@/server/funding/service";
import type { FundingPlan } from "@/server/funding/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FundingPlanEditor, emptyFundingPlan } from "./funding-plan-editor";

const operations = [
  ["publish_plan", "保存资金计划新版本"], ["defer_tranche", "延期一个投入批次"],
  ["link_receipt", "匹配已经发生的到账事实"], ["unlink_receipt", "解除到账匹配"],
  ["link_execution", "关联现有执行事项"], ["unlink_execution", "解除执行关联"],
] as const;
const section = "min-w-0 space-y-4 rounded-xl border bg-card p-5 shadow-sm";
const field = "flex min-w-0 flex-col gap-2 text-sm";
const select = "h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm";
const Exact = Decimal.clone({ precision: 60 });
function plannedTotals(plan: FundingPlan) {
  try {
    const sums = new Map<string, InstanceType<typeof Exact>>();
    for (const source of plan.sources.filter(row => row.status === "planned")) {
      if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(source.planned_amount)) return null;
      sums.set(source.currency, (sums.get(source.currency) ?? new Exact(0)).add(source.planned_amount));
    }
    return [...sums].map(([currency, amount]) => `${amount.toFixed()} ${currency}`).join(" / ") || "未安排资金来源";
  } catch { return null; }
}
function Evidence({ title, value }: { title: string; value: unknown }) {
  return <details className="min-w-0 rounded-lg border p-3 text-sm"><summary className="cursor-pointer">{title}</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(value, null, 2)}</pre></details>;
}

export function FundingWorkspace({ initial }: { initial: WorkbenchState }) {
  const [selected, setSelected] = useState(initial.selected);
  const [data, setData] = useState<FundingState | null>(null);
  const [busy, setBusy] = useState(true), [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState(""), [receipt, setReceipt] = useState<unknown>(null);
  const [operation, setOperation] = useState<string>("publish_plan");
  const [draft, setDraft] = useState<FundingPlan>(emptyFundingPlan);
  const [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [shortfallAcknowledged, setShortfallAcknowledged] = useState(false);
  const attempt = useRef<{ signature: string; body: unknown } | null>(null);
  const locked = busy || !data || data.read_only;
  const accounts = data?.accounts ?? [];
  const accountName = (id: string) => accounts.find(account => account.id === id)?.name ?? id;

  async function load(portfolio: string, signal?: AbortSignal) {
    const response = await fetch(`/api/workbench?portfolio=${encodeURIComponent(portfolio)}&view=funding`, { cache: "no-store", signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "读取资金计划失败");
    if (body.portfolio_id !== portfolio) throw new Error("资金计划组合范围不匹配");
    if (!signal?.aborted) setData(body);
  }
  useEffect(() => {
    setHydrated(true);
    const controller = new AbortController();
    setData(null); setError(""); setReceipt(null); setConfirmed(false); setBusy(true);
    setDraft(emptyFundingPlan()); setReason(""); setShortfallAcknowledged(false); attempt.current = null;
    if (selected) void load(selected, controller.signal).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "读取失败");
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    else setBusy(false);
    return () => controller.abort();
  }, [selected]);
  async function refresh() {
    if (!selected) return;
    setBusy(true); setConfirmed(false); setShortfallAcknowledged(false); setData(null); setError("");
    try { await load(selected); }
    catch (error) { setError(error instanceof Error ? error.message : "刷新失败"); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || !selected || !data || !confirmed) return;
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? "");
    let payload: Record<string, unknown>;
    switch (operation) {
      case "publish_plan": payload = { plan: draft, acknowledge_shortfall: form.get("acknowledge_shortfall") === "on" }; break;
      case "defer_tranche": payload = { tranche_id: value("tranche_id"), invest_by: value("invest_by"), unspent_action: value("unspent_action") }; break;
      case "link_receipt": payload = { source_id: value("source_id"), ledger_event_id: value("ledger_event_id"), amount: value("amount") }; break;
      case "link_execution": payload = { tranche_id: value("tranche_id"), proposal_item_id: value("proposal_item_id"), expected_resources_hash: data.resources_hash }; break;
      default: payload = { link_id: value("link_id") };
    }
    const { expected_resources_hash: _, ...intent } = payload;
    const signature = JSON.stringify({ portfolio: selected, operation, payload: intent, reason });
    // A lost HTTP response must retry the same revision and key, not book another match.
    if (attempt.current?.signature !== signature) attempt.current = { signature, body: { action: "funding", command: { operation, command: {
      ...payload, portfolio_id: selected, expected_funding_revision: data.funding_revision,
      expected_ledger_revision: data.ledger_revision, idempotency_key: crypto.randomUUID(), reason,
    } } } };
    setBusy(true); setError(""); setReceipt(null);
    try {
      const response = await fetch("/api/workbench", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(attempt.current.body) });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 409 && ["FUNDING_VERSION_CONFLICT", "RESOURCE_CONFLICT"].includes(body.error)) {
          // These guards run after server deduplication: this attempt did not commit.
          attempt.current = null; setData(null);
          throw new Error(`${body.error}：请刷新最新计划和资源，再重新核对确认。`);
        }
        throw new Error(body.error ?? "资金计划操作失败");
      }
      setReceipt(body); setConfirmed(false); setShortfallAcknowledged(false); attempt.current = null; setData(null);
      await load(selected);
    } catch (error) { setConfirmed(false); setError(error instanceof Error ? error.message : "提交失败；请核对记录后使用同一内容重试"); }
    finally { setBusy(false); }
  }
  const activeReceiptLinks = data?.links.filter(row => row.kind === "receipt" && row.status !== "released") ?? [];
  const activeExecutionLinks = data?.links.filter(row => row.kind === "execution" && row.status !== "released") ?? [];
  const tranches = data?.tranches ?? [];
  return <div inert={!hydrated} data-hydrated={hydrated} aria-busy={busy} className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-8">
    <header><p className="text-sm text-muted-foreground">ETF / FUNDING</p><h1 className="mt-1 text-3xl font-semibold">资金计划与投入批次</h1><p className="mt-2 text-sm text-muted-foreground">预算、到账匹配、实际可用现金与执行预留分别核对。保存计划不产生资金或交易。</p></header>
    <nav aria-label="工作台模块" className="flex flex-wrap gap-4 text-sm"><Link href="/workbench" className="underline">账户与账本</Link><Link href="/workbench/research" className="underline">策略研究</Link><Link href="/workbench/governance" className="underline">政策与执行</Link></nav>
    {error && <p role="alert" className="break-all rounded-lg border border-red-500/40 p-4 text-sm">{error}</p>}
    {data?.read_only && <p role="status" className="rounded-lg border p-4 text-sm">当前为只读模式，只能查看计划与证据，不能保存版本或关联事实。</p>}
    <section className={section}><div className="flex flex-wrap items-end gap-3"><label className={`${field} flex-1`}>当前组合<select className={select} aria-label="当前组合" value={selected ?? ""} disabled={busy} onChange={event => setSelected(event.target.value)}><option value="" disabled>请先建立组合</option>{initial.portfolios.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><Button variant="outline" disabled={busy || !selected} onClick={() => void refresh()}>刷新资金计划</Button></div>{!selected && <Link href="/workbench" className="text-sm underline">前往建立空账本</Link>}{data && <p className="text-sm text-muted-foreground">计划版本 {data.funding_revision} / 账本版本 {data.ledger_revision} / {data.plan_status}。一个一致快照核对计划、事实和资源。</p>}</section>
    {data && <>
      {data.plan_status !== "confirmed_plan" && !data.plan && <p role="status" className="rounded-lg border border-amber-500/40 p-4 text-sm">尚无已确认的日期化资金计划。旧相对年度预算只保留历史，不自动补成实际日期或到账。</p>}
      <section className={section}><h2 className="text-lg font-semibold">来源预算与到账匹配</h2><p className="text-sm text-muted-foreground">“计划未安排”属于预算。“已匹配到账”是历史事实关联，不是当前现金；内部转账、卖出回款和分红不算新增本金。</p>{!data.sources.length && <p className="text-sm">暂无日期化资金来源。</p>}{data.sources.map(source => <article key={source.id} className="space-y-2 border-t pt-3 text-sm"><h3 className="font-medium">{source.label} · {source.currency} · {source.due_status}</h3><p>{source.period_start} 至 {source.period_end} · 预计到账 {source.expected_arrival_date ?? "尚未指定"}</p><dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div><dt className="text-muted-foreground">来源预算</dt><dd>{source.planned_amount}</dd></div><div><dt className="text-muted-foreground">已匹配到账</dt><dd>{source.matched_amount}</dd></div><div><dt className="text-muted-foreground">已安排批次预算</dt><dd>{source.assigned_amount}</dd></div><div><dt className="text-muted-foreground">计划未安排</dt><dd>{source.planned_unallocated}</dd></div></dl><Evidence title="来源、超计划到账与待核对信息" value={source} /></article>)}</section>
      <section className={section}>
        <h2 className="text-lg font-semibold">投入批次与截止处理</h2>
        {!tranches.length && <p className="text-sm text-muted-foreground">暂无投入批次，不默认全部立即买入。</p>}
        {tranches.map(batch => <article key={batch.id} className="space-y-2 border-t pt-3 text-sm">
          <h3 className="font-medium">{batch.label} · {batch.currency} · {batch.due_status}</h3>
          <p>计划预算 {batch.planned_amount} · 最晚处理 {batch.invest_by ?? "尚未指定"}</p>
          <p>当前关联预留 {batch.active_reservations} · 已关联成交金额 {batch.executed_amount}</p>
          <p>执行状态：{batch.execution_status}</p>
          {batch.budget_excess !== "0" && <p className="text-amber-600">已成交及活动预留超出本批次预算 {batch.budget_excess} {batch.currency}；需人工核对，不自动释放预留或撤单。</p>}
          <p>未执行处理：{batch.unspent_action}</p>
          {batch.needs_review_count > 0 && <p className="text-amber-600">有 {batch.needs_review_count} 项关联需重新核对。</p>}
          <Evidence title="批次标识和状态" value={batch} />
        </article>)}
      </section>
      <section className={section}>
        <h2 className="text-lg font-semibold">实际账户现金（与来源预算独立）</h2>
        <p className="text-sm text-muted-foreground">可用额已扣应付款、冻结和活动买入预留；不含未结算卖出款。存在余额不表示账户已对账或具备实盘权限。</p>
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm">
          <thead><tr className="border-b"><th className="p-2">账户 / 币种</th><th className="p-2">已结算现金</th><th className="p-2">交易应付款</th><th className="p-2">冻结</th><th className="p-2">活动预留</th><th className="p-2">可用额</th><th className="p-2">状态</th></tr></thead>
          <tbody>{data.account_cash.map(row => <tr key={`${row.account_id}:${row.currency}`} className="border-b"><td className="p-2">{row.account_name} / {row.currency}</td><td className="p-2 font-mono">{row.settled}</td><td className="p-2 font-mono">{row.trade_payable}</td><td className="p-2 font-mono">{row.cash_holds}</td><td className="p-2 font-mono">{row.active_reservations}</td><td className="p-2 font-mono">{row.available}</td><td className="p-2">{row.account_status}</td></tr>)}</tbody>
        </table></div>
        {!data.account_cash.length && <p className="text-sm text-muted-foreground">尚无现金记录；计划不会生成现金行。已建档账户 {accounts.length} 个。</p>}
        <Evidence title="账户金额组成、对账缺口和资源版本" value={{ accounts: data.account_cash, resources_hash: data.resources_hash }} />
      </section>
      {data.warnings.length > 0 && <Evidence title="需人工处理的提示" value={data.warnings} />}
    </>}
    {selected && <section className={section}><h2 className="text-lg font-semibold">人工计划操作</h2><p className="text-sm text-muted-foreground">每次保存都保留旧版本；关联只改变计划归属，不重记到账或成交。响应不确定时先核对历史，再以未修改的内容重试。</p>
      <form key={`${selected}:${operation}`} className="space-y-4" onSubmit={event => void submit(event)} onChange={event => {
        const name = event.target instanceof HTMLInputElement ? event.target.name : "";
        if (name !== "human_confirmation") setConfirmed(false);
        if (!["human_confirmation", "acknowledge_shortfall"].includes(name)) setShortfallAcknowledged(false);
      }}>
        <fieldset disabled={locked} className="min-w-0 space-y-4">
          <label className={field}>资金计划操作<select aria-label="资金计划操作" className={select} value={operation} onChange={event => { setOperation(event.target.value); setConfirmed(false); setReceipt(null); }}>
            {operations.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select></label>
          <div key={operation} className="space-y-4">
            {operation === "publish_plan" && <>
              <Button type="button" variant="outline" disabled={!data?.plan} onClick={() => { if (data?.plan) { setDraft(structuredClone(data.plan)); setConfirmed(false); setShortfallAcknowledged(false); } }}>基于当前版本编辑</Button>
              <FundingPlanEditor plan={draft} persistedPlan={data?.plan ?? null} accounts={accounts} onChange={plan => { setDraft(plan); setConfirmed(false); setShortfallAcknowledged(false); }} />
              <p className="text-sm">拟保存：{draft.sources.length} 个来源，{draft.tranches.length} 个批次；来源预算 {plannedTotals(draft) ?? "金额尚未正确填写"}。这不是资产净值。</p>
              <Evidence title="保存前核对：当前版本与拟保存版本" value={{ current: data?.plan, proposed: draft }} />
              <label className="flex items-start gap-2 text-sm"><input name="acknowledge_shortfall" type="checkbox" className="mt-1" checked={shortfallAcknowledged} onChange={event => setShortfallAcknowledged(event.target.checked)} /><span>如本次缩减预算造成与已到账或已安排金额不一致，我已核对并确认保留差额提示，不修改真实事实。</span></label>
            </>}
            {(operation === "defer_tranche" || operation === "link_execution") && <label className={field}>选择投入批次<select name="tranche_id" aria-label="选择投入批次" className={select} required defaultValue=""><option value="">请选择</option>{tranches.map(row => <option key={row.id} value={row.id}>{row.label} / {row.currency}</option>)}</select></label>}
            {operation === "defer_tranche" && <><label className={field}>新的最晚处理日期<Input name="invest_by" type="date" required /></label><label className={field}>延期期间未执行资金处理方式<Input name="unspent_action" maxLength={1000} required /></label><p className="text-sm text-muted-foreground">只新增计划版本，不延长既有审批或订单有效期。</p></>}
            {operation === "link_receipt" && <>
              <label className={field}>匹配到资金来源<select name="source_id" aria-label="匹配到资金来源" className={select} required defaultValue=""><option value="">请选择</option>{data?.sources.map(row => <option key={row.id} value={row.id}>{row.label} / {row.currency}</option>)}</select></label>
              <label className={field}>选择已发生到账事实<select name="ledger_event_id" aria-label="选择已发生到账事实" className={select} required defaultValue=""><option value="">请选择已入账的事实</option>{data?.matchable_facts.map(row => <option key={row.id} value={row.id}>{row.event_type} / {accountName(row.account_id)} / {row.effective_at} / {row.currency} {row.amount} / 未匹配 {row.remaining_amount}</option>)}</select></label>
              <label className={field}>本次匹配原币金额<Input name="amount" inputMode="decimal" required /></label><p className="text-sm text-muted-foreground">仅同币种匹配。初始资金可匹配期初现金或真实入金；年度追加只匹配入金，不挪用期初现金。缺事实请先到账本按原件录入。</p>
            </>}
            {operation === "link_execution" && <label className={field}>选择现有执行事项<select name="proposal_item_id" aria-label="选择现有执行事项" className={select} required defaultValue=""><option value="">请选择</option>{data?.execution_items.map(row => <option key={row.id} value={row.id}>{row.side} / {accountName(row.account_id)} / {row.currency} / {row.id}{row.linked_tranche_id ? " / 已有关联" : ""}</option>)}</select></label>}
            {(operation === "unlink_receipt" || operation === "unlink_execution") && <label className={field}>选择要解除的关联<select name="link_id" aria-label="选择要解除的关联" className={select} required defaultValue=""><option value="">请选择</option>{(operation === "unlink_receipt" ? activeReceiptLinks : activeExecutionLinks).map(row => <option key={row.id} value={row.id}>{row.id} / {row.status} / {row.currency} {row.amount ?? ""}</option>)}</select></label>}
          </div>
          <label className={field}>本次操作依据<Input value={reason} onChange={event => setReason(event.target.value)} required maxLength={2000} /></label>
          <label className="flex items-start gap-2 text-sm"><input name="human_confirmation" className="mt-1" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required /><span>我已核对当前组合、版本、金额、日期与来源。本次只保存计划或关联，不生成实际到账或交易。</span></label>
          <Button disabled={!confirmed}>确认资金计划操作</Button>
        </fieldset>
      </form>
      {receipt !== null && <div role="status" className="space-y-3 text-sm"><p>操作已保存，未产生新的现金或成交事实。</p><Evidence title="本次服务端回执" value={receipt} /></div>}
    </section>}
    {data && <section className={section}><h2 className="text-lg font-semibold">版本与关联历史</h2><Evidence title={`计划版本（${data.versions.length}）`} value={data.versions} /><Evidence title={`到账和执行关联（${data.links.length}）`} value={data.links} /><Evidence title="关联与解除的完整记录" value={data.link_history} /></section>}
  </div>;
}
