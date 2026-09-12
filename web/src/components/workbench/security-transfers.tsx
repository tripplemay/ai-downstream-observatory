"use client";

import { useState, type FormEvent } from "react";
import type { WorkbenchState } from "@/server/ledger/queries";
import type { Fact } from "@/server/ledger/engine";
import type { ImportPreview } from "@/server/ledger/imports";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { securityTransferListing } from "./security-transfer-input";

type TransferType = "security_in" | "security_out" | "security_transfer_out" | "security_transfer_in" | "security_transfer_return";
interface Props {
  state: WorkbenchState; busy: boolean;
  mutate: (body: unknown) => Promise<unknown>;
  perform: (action: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>; notice: (value: string) => void;
}
const field = "flex min-w-0 flex-col gap-1.5 text-sm";
const selectClass = "h-10 w-full min-w-0 max-w-full rounded-md border bg-background px-3";

export function SecurityTransfers({ state, busy, mutate, perform, refresh, notice }: Props) {
  const [type, setType] = useState<TransferType>("security_in");
  const [precision, setPrecision] = useState<"date" | "second">("date");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const external = type === "security_in" || type === "security_out";
  const receiving = type === "security_transfer_in" || type === "security_transfer_return";
  const locked = busy || state.read_only;
  const accountName = (id: string) => state.accounts.find(a => a.id === id)?.name ?? id;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget), value = (name: string) => String(data.get(name) ?? "").trim();
    setPreview(null);
    void perform(async () => {
      const lot = state.security_transits.find(row => row.transfer_event_id === value("transfer"));
      const listing = securityTransferListing(state, receiving, receiving ? value("transfer") : value("listing"));
      if (!listing || (receiving && !lot)) throw new Error("请先选择已核实证券或尚未完成的转仓批次。");
      const account = receiving ? (type === "security_transfer_in" ? lot!.target_account_id : lot!.source_account_id) : value("account");
      const fact: Fact = { type, account_id: account, listing_id: listing.id, currency: listing.currency, quantity: value("quantity") };
      const effective_at = value("effective_at"), source_timezone = value("source_timezone");
      if (external) {
        fact.market_value = value("market_value");
        fact.value_evidence = { schema_version: "security-transfer-value-v1", reference: value("reference"), effective_at, time_precision: precision, source_timezone };
        if (type === "security_in" && value("cost_amount")) fact.cost_amount = value("cost_amount");
      } else if (receiving) fact.related_event_id = lot!.transfer_event_id;
      else fact.target_account_id = value("target");
      const raw = JSON.stringify([{ source_id: "manual-security-transfer", source_event_id: value("source_event_id"), effective_at, time_precision: precision, source_timezone, reason: value("reason"), fact }]);
      setPreview(await mutate({ action: "preview_import", portfolio_id: state.selected, account_id: account, raw }) as ImportPreview);
    });
  }
  return <section className="rounded-xl border bg-card p-5 shadow-sm">
    <h2 className="mb-4 text-lg font-semibold">证券转入与转出</h2>
    <p className="mb-4 text-sm text-muted-foreground">仅记录已核实事实，不向券商下单。外部转入/转出按当时确认市值计本金流，不计现金；内部转仓在接收前仍归原账户所有，但不能卖出。在途与已到账持仓分开显示。</p>
    <form onSubmit={submit} onChange={() => setPreview(null)}>
      <fieldset disabled={locked} className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className={field}>证券转移事件<select className={selectClass} value={type} onChange={e => setType(e.target.value as TransferType)}>
          <option value="security_in">组合外部转入</option><option value="security_out">转出到组合外部</option><option value="security_transfer_out">组合内账户转出（在途）</option><option value="security_transfer_in">确认目标账户接收</option><option value="security_transfer_return">确认退回原账户</option>
        </select></label>
        {receiving ? <label className={field}>待完成转仓批次<select name="transfer" required className={selectClass} defaultValue=""><option value="" disabled>选择尚未完成的批次</option>{state.security_transits.map(lot => <option key={lot.transfer_event_id} value={lot.transfer_event_id}>{accountName(lot.source_account_id)} → {accountName(lot.target_account_id)} / {lot.ticker} / 剩余 {lot.quantity} / {lot.transfer_event_id}</option>)}</select></label> : <>
          <label className={field}>记账账户<select name="account" required className={selectClass} defaultValue=""><option value="" disabled>选择实际账户</option>{state.accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          <label className={field}>证券与原币<select name="listing" required className={selectClass} defaultValue=""><option value="" disabled>选择已建档证券</option>{state.listings.map(listing => <option key={listing.id} value={listing.id}>{listing.market} / {listing.ticker} / {listing.name} / {listing.currency}</option>)}</select></label>
        </>}
        {type === "security_transfer_out" && <label className={field}>目标账户<select name="target" required className={selectClass} defaultValue=""><option value="" disabled>选择组合内另一账户</option>{state.accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}
        <label className={field}>本次数量<Input name="quantity" inputMode="decimal" required maxLength={80} /></label>
        {external && <><label className={field}>本次数量的原币市值总额（非单价）<Input name="market_value" inputMode="decimal" required maxLength={80} /></label><label className={`${field} sm:col-span-2`}>转移时点市值的核实依据<Input name="reference" required maxLength={2000} placeholder="已核实的券商转仓凭证 / 估值记录编号" /></label></>}
        {type === "security_in" && <label className={field}>历史成本总额（未知请留空）<Input name="cost_amount" inputMode="decimal" maxLength={80} placeholder="留空不是零成本" /></label>}
        <label className={field}>实际时间精度<select className={selectClass} value={precision} onChange={e => setPrecision(e.target.value as "date" | "second")}><option value="date">只有日期{external ? "（该外部流涉及期间收益将阻断）" : ""}</option><option value="second">有 UTC 秒级时点</option></select></label>
        <label className={field}>{precision === "date" ? "实际日期" : "实际 UTC 时点（以 Z 结尾）"}<Input key={precision} name="effective_at" type={precision === "date" ? "date" : "text"} required placeholder={precision === "second" ? "2026-01-02T06:30:00Z" : undefined} /></label>
        <label className={field}>来源时区（IANA）<Input name="source_timezone" defaultValue="Asia/Shanghai" required maxLength={100} /></label>
        <label className={field}>来源记录号<Input name="source_event_id" required maxLength={200} /></label>
        <label className={`${field} sm:col-span-2`}>事实说明<Input name="reason" required maxLength={2000} /></label>
        <p className="text-sm text-muted-foreground sm:col-span-2">市值时间与事件时间必须相同。仅有日期的外部证券流不推断盘中时点；费用单独记账。预览将冻结本次事实，修改字段后必须重新预览。</p>
        <Button className="sm:col-span-2" disabled={locked || !state.accounts.length || (!receiving && !state.listings.length) || (receiving && !state.security_transits.length)}>预览证券事实（不入账）</Button>
      </fieldset>
    </form>
    {preview && <div className="mt-4 space-y-3 rounded-lg border p-4">
      <p className="text-sm">预览状态：{preview.status} · 账本版本 {preview.expected_revision}</p>
      {preview.rows.map(row => <div key={row.row} className="text-sm">{row.errors.length ? <p role="alert" className="break-words">{row.errors.join("；")}</p> : <><p>{row.command?.fact.type} · {accountName(row.command!.fact.account_id)} · {row.command?.fact.quantity} 份 · {row.command?.fact.currency}</p><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border p-3 text-xs">{JSON.stringify(row.command?.fact, null, 2)}</pre></>}</div>)}
      <Button disabled={locked || preview.status !== "preview"} onClick={() => void perform(async () => {
        await mutate({ action: "confirm_import", portfolio_id: state.selected, batch_id: preview.id, preview_hash: preview.preview_hash, expected_revision: preview.expected_revision });
        setPreview(null); await refresh(); notice("证券事实已入账；需重新对账并生成估值。转入市值未计作盈利。");
      })}>确认上述证券事实入账</Button>
      <p className="text-xs text-muted-foreground">确认响应丢失时，可重试同一预览批次，不会重复入账；账本版本冲突时请重新预览。</p>
    </div>}
    <div className="mt-5 border-t pt-4"><h3 className="font-medium">尚未完成的证券在途</h3><p className="mt-1 text-sm text-muted-foreground">以下是数量与携带成本，不是估值或目标账户可卖余额。</p>
      {!state.security_transits.length && <p className="mt-3 text-sm">无未完成证券转仓。</p>}
      {state.security_transits.map(lot => <div key={lot.transfer_event_id} className="mt-3 break-words rounded-lg border p-3 text-sm"><p>{accountName(lot.source_account_id)} → {accountName(lot.target_account_id)} / {lot.ticker} {lot.name}</p><p>{lot.quantity} 份 · 携带成本 {lot.cost_known ? `${lot.cost_amount} ${lot.currency}` : "未知"}</p><p className="mt-1 break-all font-mono text-xs">{lot.transfer_event_id}</p></div>)}
    </div>
  </section>;
}
