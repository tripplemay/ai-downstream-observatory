"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import type { HistoryQuery, InvestorHistory } from "@/server/investor/history-schemas";
import { historyUrl, parseInvestorHistory } from "./investor-history-client";

const labels = { observe: "继续观察", decision_required: "需要人工决策", insufficient_evidence: "证据不足" };
const decisions = { accept_idea: "采纳思路", defer: "暂缓", reject: "拒绝" };
function Decision({ row }: { row: InvestorHistory["decisions"][number] }) {
  return <p className="mt-3 break-words border-t pt-3 text-sm">你的决定：{decisions[row.decision]} · {row.note || "无备注"}
    <time className="mt-1 block text-xs text-muted-foreground">{row.created_at} · 审阅记录，非交易批准或成交</time></p>;
}
export function InvestorHistoryPanel({ workspaceId, binding, disabled, observationId = null }: {
  workspaceId: string | null; binding: string; disabled: boolean; observationId?: string | null;
}) {
  const session = useSessionBoundary(), identity = JSON.stringify([workspaceId, binding, observationId]);
  const [result, setResult] = useState<{ identity: string; value: InvestorHistory } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const invalidated = useRef(false), alive = useRef(true), generation = useRef(0), active = useRef<AbortController | null>(null), initialRead = useRef("");
  const verified = session?.verified === true && session.sessionBinding === binding && !invalidated.current;
  const current = useRef({ identity, workspaceId, binding, observationId, verified, disabled }); current.current = { identity, workspaceId, binding, observationId, verified, disabled };
  function clear() { generation.current++; active.current?.abort(); active.current = null; setResult(null); setBusy(false); setError(""); initialRead.current = ""; }
  async function load(cursor?: string | null) {
    const start = current.current;
    if (start.identity !== identity || !start.verified || start.disabled || active.current) return;
    const query: HistoryQuery = { ...(start.observationId ? { observation: start.observationId } : {}), ...(cursor ? { cursor } : {}) };
    const controller = new AbortController(), sequence = ++generation.current; active.current = controller; setBusy(true); setError("");
    const timer = setTimeout(() => controller.abort(), 20000);
    const valid = () => alive.current && !invalidated.current && sequence === generation.current && current.current.identity === start.identity && current.current.verified && !current.current.disabled;
    try {
      const response = await fetch(historyUrl(query), { cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal,
        headers: { "X-Workbench-Session-Binding": start.binding } });
      if (!valid()) return;
      if (response.status === 401) { window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); return; }
      if (!response.ok) throw new Error();
      const value = parseInvestorHistory(await response.json(), start.binding, start.workspaceId, query);
      if (valid()) setResult({ identity: start.identity, value });
    } catch { if (valid()) { setResult(null); setError("历史记录暂未通过核对，或所选记录不属于当前工作区。请刷新记录；没有读取结果不代表没有决定或无需调整。"); } }
    finally { controller.abort(); clearTimeout(timer); if (active.current === controller) { active.current = null; if (alive.current) setBusy(false); } }
  }
  useEffect(() => {
    alive.current = true;
    const invalidate = () => { invalidated.current = true; clear(); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => { alive.current = false; generation.current++; active.current?.abort(); window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); };
  }, []);
  useEffect(() => { clear(); }, [identity, verified]);
  useEffect(() => {
    if (disabled) { generation.current++; active.current?.abort(); active.current = null; setBusy(false); return; }
    if (verified && initialRead.current !== identity) { initialRead.current = identity; void load(); }
  }, [identity, verified, disabled]);
  const page = verified && !disabled && result?.identity === identity ? result.value : null;
  return <section aria-label="观察归档" className="min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6">
    <h2 className="text-lg font-semibold">{observationId ? "这次观察与完整人工决定" : "每次观察与人工决定"}</h2>
    <p className="mt-3 text-sm text-muted-foreground">这里只回看历史记录，不代表现在仍可行动。历史状态、缺口和复核条件不替代总览的当前核验；没有交易或采纳入口。</p>
    <p className="mt-2 text-xs text-muted-foreground">每页最多 20 条，按记录时间从新到旧排列；同一时刻按实际写入先后排列。翻页固定归档范围；刷新记录后才纳入新观察和新决定。不显示历史模型金额、权重或原始行情。</p>
    <div className="mt-4 flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={disabled || busy || !verified} onClick={() => void load()}>刷新记录</Button>
      {observationId && <Link className="self-center text-sm underline" href="/workbench/observations">返回观察归档</Link>}
      <Link className="self-center text-sm underline" href="/workbench">查看当前总览</Link></div>
    {busy && <p role="status" className="mt-3 text-sm">正在只读核对历史记录…</p>}
    {error && verified && !disabled && <p role="alert" className="mt-3 break-words text-sm text-red-600">{error}</p>}
    {page && <div className="mt-5 space-y-4">
      {page.entries.length === 0 && <p className="text-sm">尚无观察记录。保存研究偏好即可开始，不需要创建券商账户。</p>}
      {page.entries.map(row => <article key={row.id} id={`research-observation-${row.id}`} className="min-w-0 break-words rounded-xl border p-4">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium">记录时状态：{labels[row.recorded_outcome]}</h3><time className="text-xs text-muted-foreground">{row.evaluated_at}</time></div>
        {row.read_outcome !== row.recorded_outcome && <p className="mt-3 text-sm">当前历史读取：{labels[row.read_outcome]}。原状态保留，不恢复旧建议。</p>}
        <p className="mt-2 text-xs text-muted-foreground">约束 v{row.profile_version} · 可核对的数据截止 {row.data_cutoff ?? "未知或当前不可用"}</p>
        <ul className="mt-3 space-y-2 text-sm">{row.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
        <details className="mt-3 text-sm"><summary className="cursor-pointer">可核对的历史条件、缺口与输入版本</summary><div className="mt-3 space-y-3">
          <p>可核对的复核期限：{row.next_review_at ?? "按条件复核，未登记或当前无法核对固定时刻"}（不是现在的排程）</p>
          <p className="text-xs text-muted-foreground">来源失效时仅展示仍可核对的缺口，不补造已不可用的历史数值或条件。</p>
          <ul className="space-y-1">{row.next_conditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul>
          {row.gaps.map(gap => <div key={gap.code}><p className="font-medium">{gap.title}</p><p>{gap.detail}</p><p>下一步：{gap.action}</p></div>)}
          <p className="break-all text-xs text-muted-foreground">原输入版本：{row.input_version}</p>
        </div></details>
        {page.mode === "observations" && <>{row.latest_decision ? <Decision row={row.latest_decision} /> : <p className="mt-3 text-sm">这份归档范围内尚无人工决定记录；不能据此推定没有在券商交易。</p>}
          <Link className="mt-3 inline-block text-sm underline" href={`/workbench/observations?observation=${encodeURIComponent(row.id)}#research-observation-${encodeURIComponent(row.id)}`}>{row.more_decisions ? "查看这次观察的全部人工决定" : "查看这次观察与决定详情"}</Link></>}
      </article>)}
      {page.mode === "decisions" && <div className="min-w-0 rounded-xl border p-4"><h3 className="font-medium">按本次观察核对的人工决定</h3>{page.decisions.map(row => <Decision key={row.id} row={row} />)}
        {page.decisions.length === 0 && <p className="mt-3 text-sm">这份归档范围内尚无人工决定记录，不代表没有交易。</p>}</div>}
      <div className="flex flex-wrap items-center gap-3"><Button type="button" variant="outline" disabled={busy || !page.previous_cursor} onClick={() => void load(page.previous_cursor)}>较新记录</Button>
        <Button type="button" variant="outline" disabled={busy || !page.next_cursor} onClick={() => void load(page.next_cursor)}>更早记录</Button>
        <p className="text-xs text-muted-foreground">本页核对：{page.checked_at} · {page.mode === "decisions" ? "人工决定" : "观察"}归档</p></div>
    </div>}
  </section>;
}
