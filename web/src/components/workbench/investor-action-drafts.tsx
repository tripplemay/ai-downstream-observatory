import * as React from "react";
import type { ActionDraftProgress } from "@/server/investor/action-draft-progress-schemas";

const statuses: Record<ActionDraftProgress["status"], string> = {
  not_configured: "尚未登记交叉核验来源", future: "采集声明尚未生效", disabled: "交叉核验采集声明已停用", expired: "采集声明已到复核期限",
  waiting_scheduler: "声明有效，尚无已登记请求", visible: "最近一批已登记请求", unavailable: "采集记录暂未通过完整核对",
};
const entries: Record<ActionDraftProgress["entries"][number]["status"], string> = {
  queued: "已排队，尚未尝试", running: "任务租约有效，等待提交", lease_expired: "租约已过期，结果未知，不重试",
  indeterminate_no_retry: "执行结果待核对，不重试", closed: "本次窗口已关闭，不补发", captured_draft: "草稿已保存，仍待资料核验",
  transport_failed: "采集失败，本日不重试", superseded: "原任务已关闭，未批准资料", retention_expired: "草稿保管期已结束，不再使用",
};
const reasons: Partial<Record<NonNullable<ActionDraftProgress["entries"][number]["reason_code"]>, string>> = {
  EODHD_CAPTURE_AUTH_FAILED: "来源鉴权或权限未通过", EODHD_CAPTURE_RATE_LIMITED: "来源请求受限", EODHD_CAPTURE_TIMEOUT: "采集超时",
  EODHD_CAPTURE_UNAVAILABLE: "来源服务不可用", EODHD_CAPTURE_RESPONSE_INVALID: "返回资料未通过封闭校验",
  EODHD_CAPTURE_ROUTE_FORBIDDEN: "网络目标未通过校验", EODHD_CAPTURE_TRANSPORT_FAILED: "传输未完成或结果无法确认",
};
function instant(value: string) { return value.replace("T", " ").replace(/\.000Z$/, " UTC").replace(/Z$/, " UTC"); }

export function InvestorActionDrafts({ value, nowMs }: { value: ActionDraftProgress; nowMs: number }) {
  const stale = Math.max(nowMs, Date.parse(value.checked_at)) >= Date.parse(value.refresh_after);
  return <section aria-labelledby="action-draft-progress-title" className="min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6">
    <div className="flex flex-wrap items-start justify-between gap-2"><h2 id="action-draft-progress-title" className="font-semibold">公司行动交叉核验进度</h2>
      <span className="text-xs text-muted-foreground">EODHD · 仅研究草稿</span></div>
    <p role="status" className="mt-3 text-sm font-medium">{stale ? "状态快照已到复核时间，请刷新状态" : statuses[value.status]}</p>
    <p className="mt-2 break-words text-xs text-muted-foreground">记录核对时间：{instant(value.checked_at)}。不据此证明采集服务在线。</p>
    {!stale && value.status === "future" && value.valid_from && <p className="mt-3 text-sm">采集声明生效：{instant(value.valid_from)}；生效后仍须等待纽约时间 01:00 后的正常调度，不保证此刻已启动。</p>}
    {!stale && value.status === "waiting_scheduler" && <p className="mt-3 text-sm">等待后台在合法窗口登记；没有将“声明已启用”当作“正在采集”。无需填写 JSON 或重复提交研究。</p>}
    {!stale && value.status === "visible" && <>
      <p className="mt-3 text-sm">最近登记的纽约日期：{value.latest_source_day}。以下是该批历史任务，不代表今天已有新资料。</p>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">{value.entries.map(row => <li key={row.symbol + row.kind} className="min-w-0 rounded-xl border p-3 text-sm">
        <h3 className="font-medium">{row.symbol} · {row.kind === "div" ? "分红" : "拆分"}</h3>
        <p className="mt-2">{entries[row.status]}</p>
        {row.qualification === "synthetic_test" && <p className="mt-2 text-xs">合成采集测试，不是真实来源结果。</p>}
        {row.reason_code && reasons[row.reason_code] && <p className="mt-2 text-xs">原因：{reasons[row.reason_code]}</p>}
      </li>)}</ul>
    </>}
    <p className="mt-3 text-xs text-muted-foreground">每日最多四个固定请求，未知结果不自动重试。这里只核对任务与回执元数据，不读取或展示行情原文；保存草稿不等于原文、公司行动完整性或研究准入已核验，空结果也不证明没有公司行动。不改变当前投资结论或交易权限。</p>
  </section>;
}
