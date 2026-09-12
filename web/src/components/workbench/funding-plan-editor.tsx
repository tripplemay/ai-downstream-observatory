"use client";

import type { FundingPlan } from "@/server/funding/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const field = "flex min-w-0 flex-col gap-2 text-sm";
const select = "h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm";
type Accounts = { id: string; name: string }[];

export function emptyFundingPlan(): FundingPlan {
  return { schema_version: 2, title: "", timezone: "Asia/Shanghai", sources: [], tranches: [] };
}

function AccountOptions({ accounts }: { accounts: Accounts }) {
  return <><option value="">尚未指定账户</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</>;
}

export function FundingPlanEditor({ plan, persistedPlan, accounts, onChange }: { plan: FundingPlan; persistedPlan: FundingPlan | null; accounts: Accounts; onChange: (plan: FundingPlan) => void }) {
  function source(index: number, patch: Partial<FundingPlan["sources"][number]>) {
    onChange({ ...plan, sources: plan.sources.map((item, i) => i === index ? { ...item, ...patch } : item) });
  }
  function tranche(index: number, patch: Partial<FundingPlan["tranches"][number]>) {
    onChange({ ...plan, tranches: plan.tranches.map((item, i) => i === index ? { ...item, ...patch } : item) });
  }
  return <div className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={field}>计划名称<Input value={plan.title} maxLength={120} required onChange={event => onChange({ ...plan, title: event.target.value })} /></label>
      <label className={field}>计划日期时区<select className={select} value={plan.timezone} onChange={event => onChange({ ...plan, timezone: event.target.value })}>{[...new Set([plan.timezone, "Asia/Shanghai", "Asia/Hong_Kong", "America/New_York", "UTC"])].map(zone => <option key={zone}>{zone}</option>)}</select></label>
    </div>
    <div className="space-y-4"><h3 className="font-medium">资金来源计划</h3><p className="text-sm text-muted-foreground">每个来源分别填写期间和预计到账日。日期、金额均为计划，保存不会登记实际到账。</p>
      {plan.sources.map((item, index) => <fieldset key={item.id} className="min-w-0 space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm">资金来源 {index + 1}</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className={field}>来源名称<Input aria-label={`来源 ${index + 1} 名称`} value={item.label} maxLength={120} required onChange={event => source(index, { label: event.target.value })} /></label>
          <label className={field}>来源类型<select aria-label={`来源 ${index + 1} 类型`} className={select} value={item.kind} onChange={event => source(index, { kind: event.target.value as "initial" | "contribution" })}><option value="initial">初始资金计划</option><option value="contribution">新增投入计划</option></select></label>
          <label className={field}>预算原币金额<Input aria-label={`来源 ${index + 1} 预算`} value={item.planned_amount} inputMode="decimal" required onChange={event => source(index, { planned_amount: event.target.value })} /></label>
          <label className={field}>币种<select aria-label={`来源 ${index + 1} 币种`} className={select} value={item.currency} onChange={event => source(index, { currency: event.target.value })}>{[...new Set([item.currency, "CNY", "HKD", "USD"])].map(currency => <option key={currency}>{currency}</option>)}</select></label>
          <label className={field}>期间开始<Input aria-label={`来源 ${index + 1} 期间开始`} type="date" value={item.period_start} required onChange={event => source(index, { period_start: event.target.value })} /></label>
          <label className={field}>期间结束<Input aria-label={`来源 ${index + 1} 期间结束`} type="date" value={item.period_end} required onChange={event => source(index, { period_end: event.target.value })} /></label>
          <label className={field}>预计到账日期（可暂不指定）<Input aria-label={`来源 ${index + 1} 预计到账日期`} type="date" value={item.expected_arrival_date ?? ""} onChange={event => source(index, { expected_arrival_date: event.target.value || null })} /></label>
          <label className={field}>意向账户<select aria-label={`来源 ${index + 1} 意向账户`} className={select} value={item.account_id ?? ""} onChange={event => source(index, { account_id: event.target.value || null })}><AccountOptions accounts={accounts} /></select></label>
          <label className={field}>来源状态<select aria-label={`来源 ${index + 1} 状态`} className={select} value={item.status} onChange={event => source(index, { status: event.target.value as "planned" | "cancelled" })}><option value="planned">计划中</option><option value="cancelled">取消此计划</option></select></label>
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">来源标识 {item.id}</p>
        <Button type="button" variant="outline" disabled={persistedPlan?.sources.some(source => source.id === item.id) || plan.tranches.some(batch => batch.source_id === item.id)} onClick={() => onChange({ ...plan, sources: plan.sources.filter((_, i) => i !== index) })}>移除未保存来源 {index + 1}</Button>
        {persistedPlan?.sources.some(source => source.id === item.id) && <p className="text-xs text-muted-foreground">已保存来源须保留标识；不再投入时选择取消此计划。</p>}
      </fieldset>)}
      <Button type="button" variant="outline" disabled={plan.sources.length >= 100} onClick={() => onChange({ ...plan, sources: [...plan.sources, { id: crypto.randomUUID(), label: "", kind: "contribution", currency: "CNY", planned_amount: "0", period_start: "", period_end: "", expected_arrival_date: null, account_id: null, status: "planned" }] })}>添加资金来源</Button>
    </div>
    <div className="space-y-4"><h3 className="font-medium">投入批次</h3><p className="text-sm text-muted-foreground">到期只提示人工处理，不自动买入或延期。取消计划不会取消券商成交或释放真实预留。</p>
      {plan.tranches.map((item, index) => <fieldset key={item.id} className="min-w-0 space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm">投入批次 {index + 1}</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className={field}>批次名称<Input aria-label={`批次 ${index + 1} 名称`} maxLength={120} value={item.label} required onChange={event => tranche(index, { label: event.target.value })} /></label>
          <label className={field}>所属资金来源<select aria-label={`批次 ${index + 1} 来源`} className={select} value={item.source_id} required onChange={event => tranche(index, { source_id: event.target.value })}><option value="">请选择来源</option>{plan.sources.map(source => <option key={source.id} value={source.id}>{source.label || source.id} / {source.currency}</option>)}</select></label>
          <label className={field}>批次原币预算<Input aria-label={`批次 ${index + 1} 预算`} value={item.planned_amount} inputMode="decimal" required onChange={event => tranche(index, { planned_amount: event.target.value })} /></label>
          <label className={field}>意向账户<select aria-label={`批次 ${index + 1} 意向账户`} className={select} value={item.account_id ?? ""} onChange={event => tranche(index, { account_id: event.target.value || null })}><AccountOptions accounts={accounts} /></select></label>
          <label className={field}>最晚处理日期（可暂不指定）<Input aria-label={`批次 ${index + 1} 最晚处理日期`} type="date" value={item.invest_by ?? ""} onChange={event => tranche(index, { invest_by: event.target.value || null })} /></label>
          <label className={field}>批次状态<select aria-label={`批次 ${index + 1} 状态`} className={select} value={item.status} onChange={event => tranche(index, { status: event.target.value as "planned" | "cancelled" })}><option value="planned">计划中</option><option value="cancelled">取消此计划</option></select></label>
          <label className={`${field} sm:col-span-2 lg:col-span-3`}>未执行资金处理方式<Input aria-label={`批次 ${index + 1} 未执行处理方式`} value={item.unspent_action} maxLength={1000} required placeholder="写明保留现金、复核或另行延期的处理要求，不是下单指令" onChange={event => tranche(index, { unspent_action: event.target.value })} /></label>
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">批次标识 {item.id}</p>
        <Button type="button" variant="outline" disabled={persistedPlan?.tranches.some(tranche => tranche.id === item.id)} onClick={() => onChange({ ...plan, tranches: plan.tranches.filter((_, i) => i !== index) })}>移除未保存批次 {index + 1}</Button>
        {persistedPlan?.tranches.some(tranche => tranche.id === item.id) && <p className="text-xs text-muted-foreground">已保存批次须保留标识；取消仍需先核对活动执行事项。</p>}
      </fieldset>)}
      <Button type="button" variant="outline" disabled={!plan.sources.length || plan.tranches.length >= 500} onClick={() => onChange({ ...plan, tranches: [...plan.tranches, { id: crypto.randomUUID(), source_id: plan.sources[0].id, label: "", planned_amount: "0", account_id: null, invest_by: null, unspent_action: "", status: "planned" }] })}>添加投入批次</Button>
    </div>
  </div>;
}
