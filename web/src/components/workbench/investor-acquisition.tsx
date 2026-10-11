import * as React from "react";
import type { InvestorAcquisition } from "@/server/investor/schemas";

type Market = InvestorAcquisition["markets"][number];
const labels = { CN: "A 股", HK: "港股", US: "美股" };
const statuses: Record<Market["status"], string> = {
  not_registered: "尚无已登记采集任务", incomplete: "登记或输入核对尚未完整", scheduled: "已登记待启动窗口", queued: "等待采集 worker 领取",
  running: "任务租约有效，采集尚未提交", lease_expired: "任务租约已过期，不能证明仍在采集", expired: "采集依据已到期", failed: "采集或提交失败",
  superseded: "这次任务已被新输入或控制版本替代", missed_window: "已错过本次启动窗口", partial: "仅收到部分确认事件", no_events: "没有收到确认事件",
  waiting_core: "任务已完成，等待 core 核对全部价格、分红与汇率", input_registered: "core 已登记监测输入，仍需独立复核质量与策略",
};
const hidden = { paused: "观察已暂停；不展示旧任务为当前采集。", outdated: "约束已变化；旧采集不代表新模型正在运行。",
  expired: "参考策略已到期；需重新研究。", source_unavailable: "参考来源已失效；采集状态不能替代来源资格。",
  unavailable: "采集任务记录未通过核对；不影响独立研究核验，也不能证明行情合格。" };
function instant(value: string) { return value.replace("T", " ").replace(/\.000Z$/, " UTC").replace(/Z$/, " UTC"); }

export function currentAcquisitionDisplay(value: InvestorAcquisition, nowMs: number, modelValidUntil: string): InvestorAcquisition {
  const at = Math.max(nowMs, Date.parse(value.checked_at));
  if (value.status !== "visible") return value;
  if (Date.parse(modelValidUntil) <= at) return { ...value, status: "expired", markets: [] };
  return { ...value, markets: value.markets.map(row => {
    if (!["scheduled", "queued", "running"].includes(row.status)) return row;
    if (row.valid_until && Date.parse(row.valid_until) <= at) return { ...row, status: "expired" };
    if (row.status === "running") return row.lease_until && Date.parse(row.lease_until) <= at ? { ...row, status: "lease_expired" } : row;
    if (row.latest_start_at && Date.parse(row.latest_start_at) < at) return { ...row, status: "missed_window" };
    return row.status === "scheduled" && row.scheduled_at && Date.parse(row.scheduled_at) <= at ? { ...row, status: "queued" } : row;
  }) };
}
export function acquisitionDeadlines(value: InvestorAcquisition | undefined, modelValidUntil?: string): number[] {
  return [...(modelValidUntil ? [modelValidUntil] : []), ...value?.markets.flatMap(row =>
    [row.scheduled_at, row.stop_at, row.lease_until, row.valid_until].filter((at): at is string => at !== null)) ?? []]
    .map(Date.parse).concat(value?.markets.flatMap(row => row.latest_start_at ? [Date.parse(row.latest_start_at) + 1] : []) ?? [])
    .filter(Number.isFinite);
}
export function InvestorAcquisitionPanel({ value, nowMs, modelValidUntil }: { value: InvestorAcquisition; nowMs: number; modelValidUntil: string }) {
  const current = currentAcquisitionDisplay(value, nowMs, modelValidUntil);
  return <section aria-label="行情采集进度" className="mt-4 min-w-0 rounded-xl border p-3">
    <h3 className="text-sm font-medium">{value.phase === "initial_prices" ? "首份监测价格补采" : "按市场收盘持续采集"}</h3>
    {current.status !== "visible" ? <p role="status" className="mt-2 text-sm">{hidden[current.status]}</p> : <ul className="mt-2 grid gap-3 sm:grid-cols-3">
      {current.markets.map(row => <li key={row.market} className="min-w-0 rounded-lg border p-3 text-sm">
        <p className="font-medium">{labels[row.market]} · 已登记 {row.registered_count}/{row.target_count} 个目标</p>
        <p role="status" className="mt-2">{statuses[row.status]}</p>
        {value.phase === "initial_prices" && <p className="mt-1 text-xs text-muted-foreground">任务完成 {row.completed_count}/{row.target_count}；不等于行情已合格。</p>}
        {row.session_date && <p className="mt-1 text-xs">目标交易日：{row.session_date}</p>}
        {row.scheduled_at && <p className="mt-1 break-words text-xs">登记启动时间：{instant(row.scheduled_at)}</p>}
        {row.latest_start_at && <p className="mt-1 break-words text-xs">最迟启动：{instant(row.latest_start_at)}</p>}
        {row.stop_at && <p className="mt-1 break-words text-xs">登记采集截止：{instant(row.stop_at)}</p>}
        {row.status === "running" && row.lease_until && <p className="mt-1 break-words text-xs">租约截止：{instant(row.lease_until)}</p>}
        {row.completed_at && <p className="mt-1 break-words text-xs">最近任务提交：{instant(row.completed_at)}</p>}
        {row.status === "not_registered" && <p className="mt-1 text-xs">待核对资料或后台调度；未推测下次时间。</p>}
        {["missed_window", "partial", "no_events", "lease_expired", "failed"].includes(row.status) && <p className="mt-1 text-xs">本次不会自动重放；等待后续合法窗口与后台核对。</p>}
      </li>)}
    </ul>}
    <p className="mt-3 text-xs text-muted-foreground">这是已登记任务的只读进度，不是 worker 在线、行情完整或无需调整的证明。行情质量与策略结论独立核验；不自动下单。</p>
  </section>;
}
