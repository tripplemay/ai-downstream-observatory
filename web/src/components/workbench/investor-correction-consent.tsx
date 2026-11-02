"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import { correctionConsentAcknowledgements, type CorrectionConsentResponse } from "@/server/investor/correction-consent-schemas";
import { readActionReviewJson } from "./investor-action-review-client";
import { buildConsentAttempt, consentErrorText, consentLabels, parseConsentResponse, type ConsentAttempt } from "./investor-correction-consent-client";
import { useInvestorDisplayClock } from "./investor-display-clock";

const states: Record<string, string> = { queued: "更正意图已受理，等待后台重新核验", running: "正在重新核对原件、历史与经济差额",
  confirmed: "历史更正基线已登记，当前监测尚未恢复", rejected: "本次更正未通过核验，没有登记基线", expired: "原请求期限已到，请核对登记状态", unknown: "结果尚未核实，不自动重试" };
export function InvestorCorrectionConsent({ workspaceId, binding, modelId, impactId = null, summaryHash = null, disabled, onGuardChange, onRegistered }:
  { workspaceId: string; binding: string; modelId: string; impactId?: string | null; summaryHash?: string | null; disabled: boolean;
    onGuardChange: (locked: boolean) => void; onRegistered?: () => void }) {
  const session = useSessionBoundary(), scope = { workspace: workspaceId, binding, model: modelId, impact: impactId }, key = [workspaceId, binding, modelId, impactId].join(":");
  const [data, setData] = useState<CorrectionConsentResponse | null>(null), [answers, setAnswers] = useState<Partial<Record<typeof correctionConsentAcknowledgements[number], boolean>>>({});
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState("");
  const live = useRef(true), invalid = useRef(false), epoch = useRef(0), active = useRef<AbortController | null>(null), pending = useRef<ConsentAttempt | null>(null), tracking = useRef<string | null>(null), reported = useRef<string | null>(null);
  const verified = session?.verified === true && session.sessionBinding === binding && !invalid.current;
  const current = useRef({ key, verified, disabled, eligible: false }); current.current = { key, verified, disabled, eligible: false };
  const callbacks = useRef({ onGuardChange, onRegistered }); callbacks.current = { onGuardChange, onRegistered };
  const now = useInvestorDisplayClock(data?.checked_at ?? null, [data?.refresh_after, data?.candidate?.valid_until].filter(Boolean).map(value => Date.parse(value!)).join("|"));
  const waiting = ["queued", "running"].includes(data?.request?.status ?? ""), dirty = Object.values(answers).some(Boolean);
  useEffect(() => { live.current = true; const clear = () => { invalid.current = true; epoch.current++; active.current?.abort(); pending.current = null; tracking.current = null;
    setData(null); setAnswers({}); setBusy(false); setUncertain(false); setError(""); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, clear); return () => { live.current = false; epoch.current++; active.current?.abort(); window.removeEventListener(SESSION_INVALIDATED_EVENT, clear); callbacks.current.onGuardChange(false); };
  }, []);
  useEffect(() => { if (!verified) { epoch.current++; active.current?.abort(); pending.current = null; tracking.current = null; setData(null); setAnswers({}); setBusy(false); setUncertain(false); } }, [verified]);
  useEffect(() => { setAnswers({}); }, [summaryHash]);
  useEffect(() => { callbacks.current.onGuardChange(verified && (uncertain || waiting || dirty || busy && !!pending.current)); }, [verified, busy, uncertain, waiting, dirty]);
  useEffect(() => { if (!data?.receipt || reported.current === data.receipt.confirmation_id) return;
    reported.current = data.receipt.confirmation_id; setAnswers({}); callbacks.current.onRegistered?.();
  }, [data?.receipt]);
  async function exchange(attempt?: ConsentAttempt) {
    const start = current.current; if (!live.current || invalid.current || !start.verified || active.current || attempt && start.disabled) return;
    const controller = new AbortController(), sequence = ++epoch.current; active.current = controller;
    if(attempt||pending.current||dirty||waiting)callbacks.current.onGuardChange(true); setBusy(true); setError("");
    const valid = () => live.current && !invalid.current && epoch.current === sequence && current.current.key === start.key && current.current.verified;
    const recovery = pending.current, selection = recovery ? `nonce=${encodeURIComponent(recovery.nonce)}` : tracking.current ? `request=${encodeURIComponent(tracking.current)}`
      : impactId ? `impact=${encodeURIComponent(impactId)}` : `model=${encodeURIComponent(modelId)}`;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/workbench/investor/correction-consent${attempt ? "" : "?" + selection}`, { method: attempt ? "POST" : "GET", credentials: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { "X-Workbench-Session-Binding": binding, ...(attempt ? { "Content-Type": "application/json" } : {}) }, ...(attempt ? { body: attempt.body } : {}) });
      if (!valid()) return; if (response.status === 401) { window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); return; }
      const raw = await readActionReviewJson(response); if (!valid()) return;
      if (!response.ok) { const code = raw && typeof raw === "object" && "error" in raw ? String(raw.error) : "";
        if (attempt && [400, 403, 409, 413, 423].includes(response.status) && code !== "CORRECTION_CONSENT_DUPLICATE_CONFLICT") { pending.current = null; setUncertain(false); }
        throw new Error(code);
      }
      const value = await parseConsentResponse(raw, scope, attempt ?? recovery ?? undefined, Date.now()); if (!valid()) return;
      if (value.request) { if (!attempt && !recovery && tracking.current && value.request.id !== tracking.current) throw new Error("CORRECTION_CONSENT_RESPONSE_INVALID");
        tracking.current = value.request.id; if (attempt || recovery) { pending.current = null; setUncertain(false); setAnswers({}); } }
      setData(value);
    } catch (cause) { if (valid()) { setError(consentErrorText(cause)); setAnswers({}); setData(value => value ? { ...value, candidate: null } : null); if (attempt || pending.current) setUncertain(pending.current !== null); } }
    finally { clearTimeout(timer); if (active.current === controller) active.current = null; if (valid()) setBusy(false); }
  }
  useEffect(() => { if (verified) void exchange(); /* Parent keys immutable scope. */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, verified]);
  useEffect(() => { if (!verified || busy || uncertain || !data || !waiting && !data.candidate) return;
    const timer = setTimeout(() => void exchange(), waiting ? 2500 : Math.max(1000, Date.parse(data.refresh_after) - Date.now() - 3000));
    return () => clearTimeout(timer); /* GET only; never repeat an intent automatically. */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verified, busy, uncertain, waiting, data]);
  const c = data?.candidate, fresh = !!data && now < Date.parse(data.refresh_after) && !!c && now < Date.parse(c.valid_until);
  const eligible = verified && !disabled && !busy && !uncertain && !waiting && !data?.read_only && fresh && c?.summary_hash === summaryHash && c?.all_differences_resolved === true;
  current.current.eligible = eligible;
  function submit(event: FormEvent) {
    event.preventDefault(); if (!live.current || invalid.current || !current.current.eligible || active.current || pending.current || !data) return;
    try { const attempt = buildConsentAttempt(data, scope, summaryHash, answers, crypto.randomUUID(),Date.now()); pending.current = attempt; callbacks.current.onGuardChange(true); setUncertain(true); void exchange(attempt); }
    catch (cause) { setError(consentErrorText(cause)); }
  }
  if (!verified || !impactId && !data?.request && !error) return null;
  return <section aria-labelledby="correction-consent-title" className="min-w-0 space-y-3 rounded-xl border p-4">
    <h3 id="correction-consent-title" className="font-semibold">确认历史更正，保留原观察</h3>
    <p className="text-sm text-muted-foreground">这是与影响比较分开的正式研究确认。后台会重新核对全部原件及差额；登记后仍不代表当前监测已恢复，不执行交易。</p>
    <Button type="button" variant="outline" disabled={busy} onClick={() => void exchange()}>核对更正登记状态</Button>
    {busy && <p role="status" className="text-sm">正在核对更正受理记录…</p>}{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {uncertain && <div role="status" className="space-y-2 text-sm"><p>原提交是否受理尚未核实。先核对原 nonce；只可明确重发同一请求，不会自动创建第二份。</p>
      <Button type="button" variant="outline" disabled={busy || disabled || !!data?.read_only} onClick={() => { if (pending.current&&!data?.read_only) void exchange(pending.current); }}>使用原更正请求重试</Button></div>}
    {data?.request && <p role="status" className="text-sm">{states[data.request.status]}。{data.request.status === "rejected" && <span className="mt-2 block">{consentErrorText(new Error(data.request.code ?? ""))}</span>}</p>}
    {data?.receipt && <div data-testid="correction-consent-receipt" className="space-y-2 rounded-xl bg-muted/40 p-3 text-sm">
      <p className="font-medium">已登记 · {data.receipt.created_at}</p><p>这只是历史登记收据，不包含经济载荷，不证明当前资料仍然合格。</p>
      <p>原观察、原起点和历史决定保留。下一步仍需合格更正来源及当前行情、汇率、费用和状态接续；本次没有写入监测检查点、开启维护或执行交易。</p>
    </div>}
    {c && !c.all_differences_resolved && <p role="status" className="text-sm">仍有“暂按原记录比较”的未解决差异。请先在上方修改假设并重新计算，不能把保留选择当作正式更正。</p>}
    {c && !fresh && <p role="status" className="text-sm">本次核验期限已到，已隐藏确认选项；刷新不会延长原比较期限。</p>}
    {fresh && c?.all_differences_resolved && summaryHash === c.summary_hash && <form onSubmit={submit} className="space-y-3"><fieldset disabled={!eligible} className="space-y-3">
      <legend className="mb-3 text-sm font-medium">请逐项确认，不自动沿用上一步同意</legend>
      {correctionConsentAcknowledgements.map(key => <label key={key} className="flex items-start gap-3 text-sm"><input type="checkbox" checked={answers[key] === true}
        onChange={event => { if (!current.current.eligible) return; callbacks.current.onGuardChange(true); setAnswers(value => ({ ...value, [key]: event.target.checked })); }} /><span>{consentLabels[key]}</span></label>)}
      <Button disabled={!eligible || !correctionConsentAcknowledgements.every(key => answers[key] === true)}>登记本次历史更正，不恢复监测或交易</Button>
    </fieldset></form>}
    {data?.read_only && <p role="status" className="text-sm">系统只读，只可核对登记状态。</p>}
  </section>;
}
