"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import type { InvestorInbox, InvestorNotice } from "@/server/investor/notification-schemas";
import { parseInvestorInbox, verifyInvestorNoticeReceipt } from "./investor-notifications-client";

const labels = { observe: "继续观察", decision_required: "需要人工决策", insufficient_evidence: "证据不足" };
export function InvestorNotificationsPanel({ workspaceId, binding, disabled, readOnly, revision }: {
  workspaceId: string | null; binding: string; disabled: boolean; readOnly: boolean; revision: number;
}) {
  const identity = JSON.stringify([workspaceId, binding]);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<{ identity: string; value: InvestorInbox } | null>(null);
  const generation = useRef(0), controller = useRef<AbortController | null>(null), invalidated = useRef(false), inFlight = useRef(false);
  async function load(notice?: InvestorNotice) {
    if (disabled || invalidated.current || inFlight.current || notice && readOnly) return;
    inFlight.current = true;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const sequence = ++generation.current, timer = setTimeout(() => abort.abort(), 15000); setBusy(true); setError("");
    const headers = { "X-Workbench-Session-Binding": binding };
    const active = () => sequence === generation.current && !invalidated.current;
    const unauthorized = () => {
      if (!active()) return;
      invalidated.current = true; setResult(null); setOpen(false);
      window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT, { detail: { reason: "unauthenticated" } }));
    };
    try {
      if (notice) {
        const response = await fetch("/api/workbench/investor/notifications", { method: "POST", credentials: "same-origin", redirect: "error", signal: abort.signal,
          headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ notice_id: notice.id, publication_hash: notice.publication_hash }) });
        if (!active()) return;
        if (response.status === 401) { unauthorized(); return; }
        if (!response.ok) throw new Error();
        verifyInvestorNoticeReceipt(await response.json(), binding, notice);
        if (!active()) return;
      }
      const response = await fetch("/api/workbench/investor/notifications", { cache: "no-store", credentials: "same-origin", redirect: "error", signal: abort.signal, headers });
      if (!active()) return;
      if (response.status === 401) { unauthorized(); return; }
      if (!response.ok) throw new Error();
      const value = parseInvestorInbox(await response.json(), binding, workspaceId);
      if (sequence === generation.current && !invalidated.current) setResult({ identity, value });
    } catch {
      if (sequence === generation.current && !invalidated.current) {
        setResult(null); setError(notice ? "已读标记尚未核对，不能推定失败。请刷新通知确认；再次点击只重试同一消息，不触发研究或交易。" : "通知暂时无法核对，请查看观察记录；不会据此改变当前组合结论。");
      }
    } finally { clearTimeout(timer); if (sequence === generation.current) { inFlight.current = false; setBusy(false); } }
  }
  useEffect(() => {
    generation.current++; controller.current?.abort(); inFlight.current = false; setResult(null); setError(""); setBusy(false);
    if (!disabled && workspaceId) void load();
    return () => { generation.current++; controller.current?.abort(); };
  }, [identity, disabled, revision]);
  useEffect(() => {
    const cancel = () => { invalidated.current = true; generation.current++; controller.current?.abort(); inFlight.current = false; setResult(null); setError(""); setBusy(false); setOpen(false); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, cancel);
    return () => { window.removeEventListener(SESSION_INVALIDATED_EVENT, cancel); generation.current++; controller.current?.abort(); };
  }, []);
  useEffect(() => {
    if (disabled || invalidated.current || busy || !workspaceId) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60000);
    return () => clearInterval(timer);
  }, [identity, disabled, busy, result, workspaceId]);
  const current = !disabled && !invalidated.current && result?.identity === identity ? result.value : null;
  return <Dialog open={open && !disabled && !invalidated.current} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button type="button" variant="outline" disabled={disabled || invalidated.current}>
      <Bell className="mr-2 h-4 w-4" />研究通知{current && `（最近未读 ${current.visible_unread_count}）`}
    </Button></DialogTrigger>
    <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] min-w-0 overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>研究通知</DialogTitle><DialogDescription>只报告已发布记录，不自动交易或向外部发送。通知是历史发布提示，不是当前有效结论；标记已读不代表采纳或成交。</DialogDescription></DialogHeader>
      <div className="min-w-0 space-y-3">
      {!workspaceId && <p className="text-sm">保存研究偏好后，已发布的监测结果将在这里出现。</p>}
      {current?.entries.length === 0 && <p className="text-sm">尚无已发布的模型监测通知；不会把空列表解释成无需调整。</p>}
      {current?.entries.map(notice => <article key={notice.id} className="min-w-0 rounded-lg border p-3">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-medium">研究观察已发布 · 记录状态：{labels[notice.recorded_outcome]}</h3><span className="text-xs text-muted-foreground">{notice.read_at ? "已读" : "未读"}</span></div>
        <time className="mt-2 block break-words text-xs text-muted-foreground">{notice.published_at}</time>
        <div className="mt-3 flex flex-wrap items-center gap-4"><Link className="text-sm underline" href={`/workbench/observations#research-observation-${encodeURIComponent(notice.observation_id)}`} onNavigate={() => setOpen(false)}>查看观察记录</Link>
          {!notice.read_at && <Button type="button" variant="outline" size="sm" disabled={busy || disabled || readOnly || current.read_only} onClick={() => void load(notice)}>标记已读</Button>}</div>
      </article>)}
      {current?.has_more && <p className="text-xs text-muted-foreground">仅显示最近 20 条通知，未读数量也只针对这 20 条；更早观察保留在观察记录中。</p>}
      {(readOnly || current?.read_only) && <p className="text-xs text-muted-foreground">恢复只读模式，可查看记录，不能标记已读。</p>}
      {busy && <p role="status" className="text-sm">正在核对通知…</p>}{error && <p role="alert" className="text-sm">{error}</p>}
      {workspaceId && <Button type="button" variant="outline" disabled={busy || disabled || invalidated.current} onClick={() => void load()}>刷新通知</Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
