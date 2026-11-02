"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import type { ActionReviewView } from "@/server/investor/action-review-schemas";
import type { UnchangedRecoveryResponse } from "@/server/investor/unchanged-action-recovery-schemas";
import { actionReviewErrorText, readActionReviewJson, type ActionReviewAttempt } from "./investor-action-review-client";
import { parseRecoveryResponse, recoveryAttempt } from "./investor-action-recovery-client";
import { useInvestorDisplayClock } from "./investor-display-clock";

export function InvestorActionRecovery({ view, requestId, workspaceId, binding, disabled, onGuardChange }: {
  view: ActionReviewView; requestId: string; workspaceId: string; binding: string; disabled: boolean; onGuardChange: (locked: boolean) => void;
}) {
  const session = useSessionBoundary(), scope = `${workspaceId}:${binding}:${view.preview.preview_id}`;
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [data, setData] = useState<UnchangedRecoveryResponse | null>(null), [ack, setAck] = useState(false), [enable, setEnable] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const alive = useRef(true), invalidated = useRef(false), epoch = useRef(0), active = useRef<AbortController | null>(null);
  const pending = useRef<ActionReviewAttempt | null>(null), tracking = useRef(requestId);
  const verified = session?.verified === true && session.sessionBinding === binding && !invalidated.current;
  const current = useRef({ scope, verified, disabled, data, ack, enable }); current.current = { scope, verified, disabled, data, ack, enable };
  const now = useInvestorDisplayClock(data?.review.checked_at ?? null,
    [data?.review.refresh_after, data?.review.view?.refresh_after, view.preview.valid_until].filter(Boolean).map(value => Date.parse(value!)).join("|"));
  useEffect(() => {
    alive.current = true;
    const invalidate = () => {
      invalidated.current = true; epoch.current++; active.current?.abort(); active.current = null; pending.current = null;
      setOpen(false); setBusy(false); setData(null); setAck(false); setEnable(false); setUncertain(false); setError("");
    };
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => { alive.current = false; epoch.current++; active.current?.abort(); window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); };
  }, []);
  useEffect(() => {
    epoch.current++; active.current?.abort(); active.current = null; pending.current = null; tracking.current = requestId;
    setOpen(false); setBusy(false); setData(null); setAck(false); setEnable(false); setUncertain(false); setError("");
  }, [scope, requestId]);
  useEffect(() => { onGuardChange(verified && open); }, [verified, open, onGuardChange]);
  useEffect(() => () => onGuardChange(false), [onGuardChange]);
  useEffect(() => {
    if (verified) return;
    epoch.current++; active.current?.abort(); active.current = null; pending.current = null;
    setData(null); setAck(false); setEnable(false); setUncertain(false); setOpen(false); setBusy(false);
  }, [verified]);
  async function exchange(attempt?: ActionReviewAttempt) {
    const start = current.current;
    if (!start.verified || active.current || attempt && start.disabled) return;
    const sequence = ++epoch.current, controller = new AbortController(), original = pending.current;
    active.current = controller; setBusy(true); setError("");
    const valid = () => alive.current && !invalidated.current && sequence === epoch.current && current.current.scope === start.scope && current.current.verified;
    const base = "/api/workbench/investor/action-recovery";
    const url = attempt ? base : original ? `${base}?nonce=${encodeURIComponent(original.nonce)}` : `${base}?request=${encodeURIComponent(tracking.current)}`;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { method: attempt ? "POST" : "GET", credentials: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { "X-Workbench-Session-Binding": binding, ...(attempt ? { "Content-Type": "application/json" } : {}) }, ...(attempt ? { body: attempt.body } : {}) });
      if (!valid()) return;
      if (response.status === 401) { window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); return; }
      const raw = await readActionReviewJson(response); if (!valid()) return;
      if (!response.ok) {
        if (attempt && [400, 403, 409, 413, 423].includes(response.status)) { pending.current = null; setUncertain(false); }
        throw new Error(raw && typeof raw === "object" && "error" in raw ? String(raw.error) : "ACTION_RECOVERY_UNAVAILABLE");
      }
      const value = await parseRecoveryResponse(raw, binding, workspaceId, view, Date.now(), attempt ?? original ?? undefined); if (!valid()) return;
      if (value.review.request) {
        if (!attempt && !original && value.review.request.id !== tracking.current) throw new Error("ACTION_RECOVERY_RESPONSE_INVALID");
        tracking.current = value.review.request.id;
        if (attempt || original) { pending.current = null; setUncertain(false); setAck(false); setEnable(false); }
      }
      if (!value.recovery) { setAck(false); setEnable(false); }
      setData(value);
    } catch (error) {
      if (valid()) { setError(actionReviewErrorText(error)); setData(null); setAck(false); setEnable(false); }
    } finally { clearTimeout(timer); if (active.current === controller) { active.current = null; if (alive.current) setBusy(false); } }
  }
  useEffect(() => {
    const status = data?.review.request?.status;
    if (!open || !verified || uncertain || !status || !["queued", "running", "preview_ready"].includes(status)) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible" && !active.current && !pending.current) void exchange(); }, status === "preview_ready" ? 15000 : 2500);
    return () => clearInterval(timer);
  }, [open, verified, uncertain, data?.review.request?.id, data?.review.request?.status]);
  function submit(event: FormEvent) {
    event.preventDefault(); const state = current.current;
    if (!state.verified || state.disabled || active.current || pending.current || !state.data) return;
    try {
      const attempt = recoveryAttempt(state.data, state.ack, state.enable, crypto.randomUUID(), Date.now());
      pending.current = attempt; setUncertain(true); void exchange(attempt);
    } catch (error) { setError(actionReviewErrorText(error)); }
  }
  function close() {
    if (!current.current.verified || active.current || pending.current) return;
    epoch.current++; setOpen(false); setData(null); setAck(false); setEnable(false); setError(""); onGuardChange(false);
  }
  const fresh = data && now < Date.parse(data.review.refresh_after) && now < Date.parse(view.preview.valid_until);
  const recovery = fresh ? data.recovery : null, reviewed = fresh ? data.review.view : null, status = data?.review.request?.status;
  const locked = disabled || busy || !verified || uncertain || !fresh || !!data?.review.read_only;
  return <section className="min-w-0 space-y-3 rounded-xl border p-4" aria-label="无经济变化的维护恢复">
    {!open ? <Button type="button" variant="outline" disabled={disabled || !verified} onClick={() => {
      if (current.current.disabled || !current.current.verified) return; onGuardChange(true); setOpen(true); void exchange();
    }}>复核无变化维护恢复</Button> : <>
      <h3 className="font-medium">单独复核维护恢复</h3>
      <p className="text-sm">本入口保留原停止记录，不重试失败采集，不修改既有事件、研究税额或模型起点，也不下单。</p>
      <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={busy || !verified} onClick={() => void exchange()}>核对恢复受理状态</Button>
        <Button type="button" variant="ghost" disabled={busy || uncertain || !verified} onClick={close}>收起恢复复核</Button></div>
      {busy && <p role="status" className="text-sm">正在核对恢复依据与受理记录…</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {uncertain && <div role="status" className="space-y-2 text-sm"><p>原恢复提交仍待核实；连接失败不等于未受理，不会自动创建第二个请求。</p>
        <Button type="button" variant="outline" disabled={disabled || busy || !verified} onClick={() => { if (pending.current) void exchange(pending.current); }}>使用原恢复请求重试</Button></div>}
      {data?.review.read_only && <p role="status" className="text-sm">当前只读，不能登记恢复。</p>}
      {status === "confirmed" ? <p role="status" className="text-sm">维护接续已登记，原失败与历史保留。当前价格、汇率、费用和模型仍须独立准入；不代表监测已恢复，也未执行交易。</p>
        : status && ["queued", "running"].includes(status) ? <p role="status" className="text-sm">恢复请求已受理，等待后台核验；不自动重发。</p>
        : status && ["rejected", "expired", "outdated", "unknown"].includes(status) ? <p role="status" className="text-sm">本次恢复未获有效确认或结果未核实。请先核对受理状态，必要时收起后重新准备资料预览；原隔离仍有效。</p> : null}
      {recovery && reviewed && <form onSubmit={submit} className="space-y-3"><fieldset disabled={locked} className="min-w-0 space-y-3 text-sm">
        <p>原停止：{recovery.failure_code === "SOURCE_CAPTURE_TERMINAL_FAILURE" ? "单次采集终态失败" : "错过维护窗口"}；来源日 {recovery.failed_source_day}（纽约），记录于 {recovery.failed_at}。</p>
        <p>本次合格来源日 {reviewed.source_day}（纽约）；报告覆盖由 {reviewed.previous_coverage_end} 续至 {reviewed.candidate_coverage_end}。</p>
        <ul className="list-disc space-y-2 pl-5"><li>重叠记录与旧差异精确未变，两源均未报告新增行动；不保证客观不存在其他事件。</li>
          <li>经济事件、税务、知识时刻和既有历史不变；新规则默认关闭，当前监测另行核验。</li>
          <li>任何新增、更正、缺失、撤权或其他差异仍停止，不能借恢复入口解除。</li></ul>
        <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={ack} onChange={event => setAck(event.target.checked)}/>我已核对以上恢复边界，明确登记这次无经济变化接续；不是交易授权。</label>
        <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={enable} onChange={event => { setEnable(event.target.checked); setAck(false); }}/>另行选择：登记后启用新的有界维护规则。</label>
        <Button disabled={locked || !ack}>登记无变化维护接续</Button>
      </fieldset></form>}
      {!busy && !uncertain && status === "preview_ready" && !recovery && <p role="status" className="text-sm">尚无当前合格的恢复依据，或预览已到复核时间。不能沿用旧依据确认；请核对恢复状态，仍有缺口则收起并重新准备资料。</p>}
    </>}
  </section>;
}
