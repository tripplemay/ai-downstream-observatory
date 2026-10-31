"use client";

import React, { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { monitorCostValuesSchema, type MonitorCostState } from "@/server/investor/monitor-cost-schemas";

const fields = [
  ["commission_bps", "佣金估计（基点）"], ["minimum_fee_cny", "每笔最低费用估计（人民币）"],
  ["fx_bps", "换汇成本估计（基点）"], ["slippage_bps", "滑点估计（基点）"],
  ["maximum_cost_fraction", "最大调整成本 / 模型净资产（小数比例）"],
] as const;
export function InvestorMonitorCostPanel({ state, disabled, nowMs, onCommand, onEditingChange }: {
  state: MonitorCostState; disabled: boolean; nowMs: number;
  onCommand: (intent: Record<string, unknown>) => void; onEditingChange: (value: boolean) => void;
}) {
  const [editing, setEditing] = useState(false), [error, setError] = useState("");
  useEffect(() => { onEditingChange(editing); return () => onEditingChange(false); }, [editing, onEditingChange]);
  const expired = state.valid_until !== null && Date.parse(state.valid_until) <= nowMs;
  const blocked = disabled || !state.editable || Date.parse(state.model_valid_until) <= nowMs;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (blocked) return;
    const form = new FormData(event.currentTarget), parsed = monitorCostValuesSchema.safeParse(Object.fromEntries(fields.map(([key]) => [key, String(form.get(key) ?? "")])));
    const days = Number(form.get("validity_days"));
    if (!parsed.success || ![7, 30, 90, 365].includes(days) || form.get("acknowledged") !== "on") {
      setError("请逐项填写非负费用并选择有效期，确认仅作研究假设。基点须小于 10000，成本比例须为 0 至 1；未知项不能留空后当作零。"); return;
    }
    setError(""); setEditing(false);
    onCommand({ action: "set_monitor_costs", model_id: state.model_id, model_hash: state.model_hash, expected_cost_version: state.version,
      costs: parsed.data, validity_days: days, acknowledged_research_only: true });
  }
  return <section id="monitor-cost-assumptions" className="min-w-0 scroll-mt-24 rounded-2xl border bg-card p-5 shadow-sm md:p-6" aria-labelledby="monitor-cost-title">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="monitor-cost-title" className="font-semibold">研究监测费用假设</h2>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">只用于比较模型调整成本，不是券商费率认证，不授权交易。不会从历史研究费用或计划本金自动补值。</p></div>
      <Button variant="outline" disabled={blocked} onClick={() => { setError(""); setEditing(value => !value); }}>{editing ? "取消编辑" : state.version ? "修改监测费用假设" : "确认监测费用假设"}</Button></div>
    <p role="status" className="mt-3 text-sm">{state.status === "unavailable" ? "费用记录无法核验，暂不使用。" : expired ? "已确认的费用假设已到期，不自动续期；后台将按未知成本复核。" : state.status === "pending" ? "等待后台把费用假设应用到有效监测输入；旧调整结论不再作为当前依据。" : state.status === "known" ? "已应用明确确认的研究费用假设。" : "尚未单独确认费用。没有触发调整时仍可观察；需要比较调整成本时会明确阻断。"}</p>
    {!editing && state.costs && <details className="mt-3 text-sm"><summary className="cursor-pointer rounded-lg py-2">查看已确认假设及有效期</summary>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">{fields.map(([key, label]) => <div key={key} className="min-w-0 rounded-lg border p-3"><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 break-all font-mono">{state.costs![key]}</dd></div>)}</dl>
      <p className="mt-2 break-words text-xs text-muted-foreground">最晚有效至 {state.valid_until}；不超过当前模型有效期。换汇与滑点是简化研究缓冲，未认证税费和具体券商分段收费。</p>
    </details>}
    {editing && <form onSubmit={submit} className="mt-4"><fieldset disabled={blocked} className="grid min-w-0 gap-4 md:grid-cols-2">
      {fields.map(([key, label]) => <label key={key} className="flex min-w-0 flex-col gap-2 text-sm">{label}<Input name={key} required inputMode="decimal" defaultValue={state.costs?.[key] ?? ""} /></label>)}
      <label className="flex min-w-0 flex-col gap-2 text-sm">本次假设有效期<select name="validity_days" required defaultValue="" className="h-11 w-full rounded-lg border bg-background px-3"><option value="" disabled>请选择，不自动续期</option>{[7, 30, 90, 365].map(days => <option key={days} value={days}>{days} 天（受当前模型期限限制）</option>)}</select></label>
      <p className="text-xs text-muted-foreground md:col-span-2">1 基点 = 0.01%；最大成本比例用小数填写，例如 0.01 代表 1%，仅说明单位，不是推荐值。所有字段初次为空；真实税费未知时，不把此简化研究升级为可执行建议。</p>
      <label className="flex items-start gap-2 text-sm md:col-span-2"><input name="acknowledged" type="checkbox" required className="mt-1 h-4 w-4" /><span>我确认这些数值仅为本人研究假设，不是已核验的券商报价、费用上限保证或交易批准。</span></label>
      {error && <p role="alert" className="text-sm text-red-700 md:col-span-2">{error}</p>}
      <div className="flex flex-wrap gap-3 md:col-span-2"><Button type="submit">保存为研究监测假设</Button>{state.version > 0 && <Button type="button" variant="outline" onClick={() => {
        if (blocked) return; setEditing(false); onCommand({ action: "set_monitor_costs", model_id: state.model_id, model_hash: state.model_hash,
          expected_cost_version: state.version, costs: null, validity_days: null, acknowledged_research_only: true });
      }}>明确恢复为未知成本</Button>}</div>
    </fieldset></form>}
  </section>;
}
