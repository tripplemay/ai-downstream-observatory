import * as React from "react";
import type { ReactNode } from "react";
import type { ActionMaintenanceProgress, ActionMaintenanceEntry } from "@/server/investor/action-maintenance-progress-schemas";

const states:Record<ActionMaintenanceEntry["state"],string>={
  future:"维护规则尚未生效",disabled:"维护规则已停用",expired:"维护规则已到复核期限",waiting_sources:"等待资料与后台核对",
  waiting_next_window:"等待下一个正常维护窗口",coverage_recorded:"已登记覆盖续接",coverage_unchanged:"本次未扩大覆盖区间",
  needs_review:"需要复核，自动续接已停止",source_unavailable:"当前资料条件不足，不能继续采用",
};
const reasons:Record<NonNullable<ActionMaintenanceEntry["reason_code"]>,string>={
  NEW_REPORTED_ACTION:"来源报告了新公司行动",HISTORICAL_RECORDS_CHANGED:"既有记录出现更正或差异",CURRENT_SOURCE_UNAVAILABLE:"当前来源资料不完整",
  SOURCE_CAPTURE_TERMINAL_FAILURE:"采集未成功完成",MAINTENANCE_WINDOW_MISSED:"未在有效窗口内完成核对",AUTHORITY_INPUTS_CHANGED:"规则绑定的资料已变化",
  RULE_INPUTS_REJECTED:"输入未通过核对",SOURCE_PERMISSION_CHANGED:"来源使用许可或控制状态已变化",SOURCE_RETENTION_EXPIRED:"资料使用期限已到",
  SOURCE_PAYLOAD_PURGED:"原始资料已按规则清理",BASE_REVIEW_CHANGED:"原审阅已被新版本替代",BASE_REVIEW_EXPIRED:"原审阅已到复核期限",RULE_CONTROL_CHANGED:"规则启停版本已变化，等待新核对",
};
const instant=(value:string)=>value.replace("T"," ").replace(/\.000Z$/," UTC").replace(/Z$/," UTC");

export function InvestorActionMaintenance({value,nowMs,children}:{value:ActionMaintenanceProgress;nowMs:number;children?:ReactNode}) {
  const stale=Math.max(nowMs,Date.parse(value.checked_at))>=Date.parse(value.refresh_after);
  return <section aria-labelledby="action-maintenance-title" className="min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6">
    <h2 id="action-maintenance-title" className="font-semibold">研究资料自动维护</h2>
    <p role="status" className="mt-3 text-sm">{stale ? "状态快照已到复核时间，请刷新状态" : value.status === "not_configured" ? "尚未启用有界续接规则，需先完成来源与基准核验。" : value.status === "unavailable" ? "维护记录暂未通过核对，当前投资结论不因此改变。" : "只在既有记录未变、两源均未报告新行动时续接；异常时停止并提示复核。"}</p>
    {!stale && value.status === "visible" && <ul className="mt-4 grid gap-3 sm:grid-cols-2">{value.entries.map(row=><li key={row.symbol} className="min-w-0 rounded-xl border p-3 text-sm">
      <h3 className="font-medium">{row.symbol} · {states[row.state]}</h3>
      {row.reason_code && <p className="mt-2">原因：{reasons[row.reason_code]}。</p>}
      {row.coverage_end && <p className="mt-2">历史登记覆盖至 {row.coverage_end}；来源报告日期 {row.coverage_source_day}（纽约）。这不是当前行情日期。</p>}
      {row.coverage_recorded_at && <p className="mt-2 text-xs text-muted-foreground">该次续接登记：{instant(row.coverage_recorded_at)}</p>}
      {row.last_source_day && <p className="mt-2 text-xs text-muted-foreground">最近维护批次：{row.last_source_day}（纽约）{row.last_result_at ? `；结果登记：${instant(row.last_result_at)}`:"；尚无已登记结果"}。</p>}
      {row.state === "needs_review" && <p className="mt-2">需核对新事件或差异后另行审阅；刷新或重新启用不会清除阻断。</p>}
      {row.state === "future" && <p className="mt-2">生效时间：{instant(row.valid_from)}。{!row.enabled && "当前规则未启用，届时不会自动启用。"}</p>}
    </li>)}</ul>}
    <p className="mt-3 text-xs text-muted-foreground">仅列出工作区已登记的 VT/BND 固定规则，不代表整个组合资料齐备。覆盖依据是所选两源的报告范围，不保证客观不存在其他事件；续接不等于当日逐条人工审阅，也不改变税务、策略或交易权限。</p>
    <p className="mt-2 text-xs text-muted-foreground">记录核对时间：{instant(value.checked_at)}。此状态页只读元数据，不重放原文或证明服务在线；研究准入与当前行情仍单独核验。</p>
    {children && <details className="mt-4"><summary className="cursor-pointer rounded-lg text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">查看采集任务详情</summary><div className="mt-3 min-w-0">{children}</div></details>}
  </section>;
}
