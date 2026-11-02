"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import { legacyTransitionAcknowledgements, type LegacyTransitionResponse } from "@/server/investor/legacy-transition-schemas";
import { useInvestorDisplayClock } from "./investor-display-clock";
import { buildLegacyTransitionConfirmation, legacyTransitionAttempt, legacyTransitionErrorText, parseLegacyTransitionResponse,
  readLegacyTransitionJson, type LegacyTransitionAttempt } from "./investor-legacy-transition-client";

const labels: Record<string, string> = { queued: "已受理，等待后台核对", running: "后台正在核对历史与原文", preview_ready: "兼容预览已准备",
  registered: "兼容确认与新来源已同时登记", rejected: "本次核对未通过，未登记兼容", expired: "请求或原确认期限已到",
  outdated: "工作区已变化，不能确认旧预览", unknown: "任务结果尚未核实，不自动重试" };
const explanations = ["保留原模型、份额、已处理事件与当时记录的获知时间，不重算或重置历史。",
  "以后每次使用仍须重新核验当前来源、身份和许可；本次不是永久数据批准。",
  "新增事件采用经审计的真实获知时间，不提前计入历史。",
  "资料缺口、陈旧行情或未知费用仍阻止当前建议；登记不等于监测已恢复。",
  "仅用于研究；不改变税务、策略、资金、监测开关或交易权限，不新增提供方请求。"];
const endpoint = "/api/workbench/investor/legacy-transition";
export function InvestorLegacyTransition({ workspaceId, binding, disabled, onScopeChange, onRefresh }: {
  workspaceId: string; binding: string; disabled: boolean; onScopeChange: (locked: boolean) => void; onRefresh: () => void;
}) {
  const session = useSessionBoundary(), scope = workspaceId + ":" + binding;
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [data, setData] = useState<LegacyTransitionResponse | null>(null);
  const [acks, setAcks] = useState<Record<string, boolean>>({}), [error, setError] = useState(""), [uncertain, setUncertain] = useState(false), [retryChecked, setRetryChecked] = useState(false);
  const alive = useRef(true), invalidated = useRef(false), epoch = useRef(0), active = useRef<AbortController | null>(null);
  const pending = useRef<LegacyTransitionAttempt | null>(null), tracking = useRef<string | null>(null), viewKey = useRef<string | null>(null);
  const verified = session?.verified === true && session.sessionBinding === binding && !invalidated.current;
  const current = useRef({ scope, verified, disabled }); current.current = { scope, verified, disabled };
  const now = useInvestorDisplayClock(data?.checked_at ?? null, [data?.view?.refresh_after, data?.view?.preview.valid_until].join("|"));
  function clear() {
    epoch.current++; active.current?.abort(); active.current = null; pending.current = null; tracking.current = null; viewKey.current = null;
    setData(null); setAcks({}); setUncertain(false); setRetryChecked(false); setOpen(false); setBusy(false);
  }
  useEffect(() => {
    alive.current = true; const invalidate = () => { invalidated.current = true; clear(); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => { alive.current = false; epoch.current++; active.current?.abort(); window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); };
  }, []);
  useEffect(() => { clear(); }, [scope]);
  useEffect(() => { if (!verified) clear(); }, [verified]);
  useEffect(() => { onScopeChange(verified && open); }, [verified, open, onScopeChange]);
  useEffect(() => () => onScopeChange(false), [onScopeChange]);
  useEffect(() => {
    if (!uncertain) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a[href]") && !window.confirm("原兼容请求仍待核实。离开后请先读取登记状态，不能推定提交失败。确定离开吗？")) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [uncertain]);
  async function exchange(attempt?: LegacyTransitionAttempt) {
    const start = current.current; if (!start.verified || active.current || attempt && start.disabled) return;
    const controller = new AbortController(), sequence = ++epoch.current; active.current = controller; setBusy(true); setError("");
    const valid = () => alive.current && !invalidated.current && sequence === epoch.current && current.current.scope === start.scope && current.current.verified;
    const recovery = pending.current, url = attempt ? endpoint : recovery ? `${endpoint}?nonce=${encodeURIComponent(recovery.nonce)}`
      : tracking.current ? `${endpoint}?request=${encodeURIComponent(tracking.current)}` : endpoint;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { method: attempt ? "POST" : "GET", credentials: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { "X-Workbench-Session-Binding": binding, ...(attempt ? { "Content-Type": "application/json" } : {}) }, ...(attempt ? { body: attempt.body } : {}) });
      if (!valid()) return;
      if (response.status === 401) { window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); return; }
      const raw = await readLegacyTransitionJson(response); if (!valid()) return;
      if (!response.ok) {
        if (attempt && [400, 403, 409, 413, 423].includes(response.status)) { pending.current = null; setUncertain(false); setRetryChecked(false); }
        throw new Error(raw && typeof raw === "object" && "error" in raw ? String(raw.error) : "LEGACY_TRANSITION_UNAVAILABLE");
      }
      const value = await parseLegacyTransitionResponse(raw, binding, workspaceId, Date.now(), attempt ?? recovery ?? undefined); if (!valid()) return;
      if (value.request) {
        if (!attempt && !recovery && tracking.current && value.request.id !== tracking.current) throw new Error("LEGACY_TRANSITION_RESPONSE_INVALID");
        tracking.current = value.request.id;
        if (attempt || recovery) { pending.current = null; setUncertain(false); setRetryChecked(false); }
      } else if (recovery && !attempt) setRetryChecked(true);
      const key = value.view?.preview.basis_hash + ":" + value.view?.preview.preview_id;
      if (viewKey.current !== key || !value.view) setAcks({}); viewKey.current = key; setData(value);
    } catch (error) {
      if (valid()) { setError(legacyTransitionErrorText(error)); setAcks({}); setData(value => value ? { ...value, view: null, preview_error: "LEGACY_TRANSITION_VIEW_UNAVAILABLE" } : null); }
    } finally { clearTimeout(timer); if (active.current === controller) { active.current = null; if (alive.current) setBusy(false); } }
  }
  useEffect(() => {
    if (!open || !verified || uncertain || !data?.request || !["queued", "running", "preview_ready"].includes(data.request.status)) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible" && !active.current && !pending.current) void exchange(); }, data.request.status === "preview_ready" ? 15000 : 2500);
    return () => clearInterval(timer);
  }, [open, verified, uncertain, data?.request?.id, data?.request?.status]);
  function send(intent: unknown) {
    if (current.current.disabled || !current.current.verified || active.current || pending.current || data?.read_only) return;
    const attempt = legacyTransitionAttempt(intent, binding, workspaceId); pending.current = attempt; setUncertain(true); setRetryChecked(false); setAcks({}); void exchange(attempt);
  }
  function prepare() {
    if (data?.model?.requires_transition) send({ kind: "preview", model_id: data.model.id, expected_revision: data.workspace_revision, idempotency_key: crypto.randomUUID() });
  }
  function submit(event: FormEvent) {
    event.preventDefault(); const start = current.current;
    if (!data?.view || start.disabled || !start.verified || active.current || pending.current) return;
    try {
      const intent = buildLegacyTransitionConfirmation(data, acks, crypto.randomUUID(), now);
      if (current.current.scope !== start.scope || !current.current.verified || current.current.disabled) return; send(intent);
    } catch (error) { setError(legacyTransitionErrorText(error)); }
  }
  const view = data?.view, stale = !view || now >= Date.parse(view.refresh_after) || now >= Date.parse(view.preview.valid_until);
  const locked = disabled || busy || !verified || !!data?.read_only || uncertain || stale;
  return <section aria-labelledby="legacy-transition-title" className="min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6">
    <h2 id="legacy-transition-title" className="font-semibold">旧观察方案接续</h2>
    <p className="mt-2 text-sm text-muted-foreground">仅旧版方案需要一次兼容确认，保留原历史，不重新配置组合。新事件审阅和无变化自动维护的边界不变。</p>
    {!open ? <Button className="mt-4" variant="outline" disabled={disabled || !verified} onClick={() => {
      if (current.current.disabled || !current.current.verified) return; onScopeChange(true); setOpen(true); void exchange();
    }}>检查是否需要兼容</Button> : <div className="mt-4 space-y-4">
      <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={busy || !verified} onClick={() => void exchange()}>核对受理状态</Button>
        <Button type="button" variant="ghost" disabled={busy || uncertain} onClick={() => { clear(); onScopeChange(false); onRefresh(); }}>完成并刷新工作台</Button></div>
      {busy && <p role="status" className="text-sm">正在核对受理记录与历史证据…</p>}
      {error && <p role="alert" className="break-words text-sm text-red-600">{error}</p>}
      {uncertain && <div role="status" className="space-y-2 rounded-xl border p-3 text-sm"><p>原请求仍待核实，不自动重试或创建新请求。请先核对受理状态。</p>
        <Button type="button" variant="outline" disabled={busy || disabled || !verified || !retryChecked} onClick={() => { if (pending.current) { setRetryChecked(false); void exchange(pending.current); } }}>以原请求重试</Button></div>}
      {data?.read_only && <p role="status" className="text-sm">系统当前只读，只能查看登记状态。</p>}
      {data?.request && <p role="status" className="text-sm">{labels[data.request.status]}。</p>}
      {data?.request?.status === "registered" && <p className="text-sm">原监测开关保持不变。当前行情、汇率和费用仍由工作台单独核验；系统没有下单。</p>}
      {data?.request?.code === "LEGACY_TRANSITION_RESTATEMENT_REQUIRED" && <p role="status" className="text-sm">历史存在不能原样承接的差异，需要另行核对影响范围，不能通过本入口重置。</p>}
      {data?.preview_error && <p role="status" className="text-sm">当前原文或依赖核对失败，已隐藏旧预览，不能确认。</p>}
      {data && !view && !uncertain && !busy && !["queued", "running"].includes(data.request?.status ?? "") && (
        data.model?.requires_transition ? <Button type="button" disabled={disabled || data.read_only || !verified} onClick={prepare}>准备一次兼容预览</Button>
          : <p className="text-sm">当前方案无需兼容，或没有可接续的旧版观察记录。无需重复确认。</p>)}
      {view && <form onSubmit={submit} className="space-y-4">
        <p className="text-sm">保留原 {view.preview.proof.checkpoint.sequence} 期观察记录及 {view.preview.proof.carry_count} 项已处理事件。原监测状态：{view.monitoring_enabled ? "启用" : "暂停"}，本次不改变。</p>
        {!!view.preview.proof.projection_quality_gaps.length && <p className="text-sm text-amber-700">仍有 {view.preview.proof.projection_quality_gaps.length} 项资料缺口；兼容登记不会解除这些缺口。</p>}
        <fieldset disabled={locked} className="space-y-3">{legacyTransitionAcknowledgements.map((key, index) => <label key={key} className="flex items-start gap-3 text-sm">
          <input type="checkbox" checked={acks[key] ?? false} onChange={event => setAcks(values => ({ ...values, [key]: event.target.checked }))} className="mt-1" />{explanations[index]}</label>)}
          <Button disabled={locked || !legacyTransitionAcknowledgements.every(key => acks[key])}>确认兼容并登记来源，不执行交易</Button>
        </fieldset>
        <p className="break-words text-xs text-muted-foreground">原确认截止 {view.preview.valid_until.replace("T", " ")}，刷新不延期。</p>
        {stale && <p role="status" className="text-sm">预览已到复核时间，请核对最新状态后再确认。</p>}
      </form>}
    </div>}
  </section>;
}
