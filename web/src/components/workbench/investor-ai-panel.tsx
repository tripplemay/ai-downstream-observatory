"use client";

import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { InvestorState } from "@/server/investor/types";
import type { AiExplanationStatus } from "@/server/investor/ai-explanation-schemas";
import { parseInvestorAiExplanation } from "./investor-ai-client";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import { useInvestorDisplayTime } from "./investor-display-clock";

export function InvestorAiPanel({ state, binding, disabled }: { state: InvestorState; binding: string; disabled: boolean }) {
  const identity = JSON.stringify([binding, state.workspace_id, state.revision, state.latest?.id, state.model_watch?.evaluation_input_version]);
  const [result, setResult] = useState<{ identity: string; value: AiExplanationStatus } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null), generation = useRef(0), submitted = useRef(false), invalidated = useRef(false);
  const current = !disabled && !invalidated.current && result?.identity === identity ? result.value : null;
  const { now, readNow } = useInvestorDisplayTime(state.checked_at, current?.valid_until ? String(Date.parse(current.valid_until)) : "");
  const scope = useRef({ identity, disabled }); scope.current = { identity, disabled };
  const observationId = state.latest?.id ?? null;
  async function request(generate: boolean) {
    if (scope.current.identity !== identity || scope.current.disabled || invalidated.current || generate && (submitted.current || busy)) return;
    const current = result?.identity === identity ? result.value : null;
    if (generate && (current?.status !== "available" || !current.binding_hash || !current.observation_id
      || Date.parse(current.valid_until!) <= readNow())) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const sequence = ++generation.current, timer = setTimeout(() => abort.abort(), generate ? 45000 : 15000);
    if (generate) submitted.current = true; setBusy(true); setError("");
    try {
      const response = await fetch("/api/workbench/investor/ai-explanation", { method: generate ? "POST" : "GET", cache: "no-store", credentials: "same-origin", redirect: "error", signal: abort.signal,
        headers: { "X-Workbench-Session-Binding": binding, ...(generate ? { "Content-Type": "application/json" } : {}) },
        ...(generate ? { body: JSON.stringify({ observation_id: current!.observation_id, binding_hash: current!.binding_hash }) } : {}) });
      if (generation.current !== sequence || invalidated.current || abort.signal.aborted) return;
      if (response.status === 401) { invalidated.current = true; setResult(null); throw new Error("SESSION_CHANGED"); }
      if (!response.ok) throw new Error("INVESTOR_AI_UNAVAILABLE");
      const raw = await response.json();
      if (generation.current !== sequence || invalidated.current || abort.signal.aborted) return;
      const value = parseInvestorAiExplanation(raw, binding, observationId, readNow());
      if (generation.current === sequence && !invalidated.current) {
        if (!generate && value.status === "available") submitted.current = false;
        setResult({ identity, value });
      }
    } catch {
      if (generation.current === sequence && !invalidated.current) { setResult(null); setError(generate ? "解释请求未能核对；不自动重试，也不改变规则结论。可以重新核对状态。" : "解释条件暂时无法核对，继续查看规则说明。"); }
    } finally { clearTimeout(timer); if (generation.current === sequence) setBusy(false); }
  }
  useEffect(() => {
    generation.current++; controller.current?.abort(); submitted.current = false; setResult(null); setError(""); setBusy(false);
    if (!disabled && observationId) void request(false);
    return () => { generation.current++; controller.current?.abort(); };
  }, [identity, disabled]);
  useEffect(() => {
    const cancel = () => { invalidated.current = true; generation.current++; controller.current?.abort(); setResult(null); setBusy(false); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, cancel);
    return () => window.removeEventListener(SESSION_INVALIDATED_EVENT, cancel);
  }, []);
  const valid = current && (current.status === "blocked" || Date.parse(current.valid_until!) > Math.max(now, Date.now())) ? current : null;
  const pending = valid?.status === "queued" || valid?.status === "running";
  const pollable = pending || valid?.status === "complete";
  useEffect(() => {
    if (!pollable || disabled || busy || invalidated.current) return;
    // Status polling is read-only; it cannot create a paid request.
    const timer = setTimeout(() => void request(false), pending ? 5000 : 15000);
    return () => clearTimeout(timer);
  }, [pollable, pending, disabled, busy, identity, result]);
  const reason = valid?.reason_code;
  const detail = current && !valid ? "本次解释已到期，正文不再显示；请刷新工作台并核对当前观察，不会自动重新生成。"
    : reason === "INVESTOR_AI_SOURCE_SHARING_NOT_APPROVED" ? "数据来源尚未确认外部 AI 用途；不会向网关发送数据。"
    : reason === "INVESTOR_AI_NO_CURRENT_OBSERVATION" || reason === "INVESTOR_AI_NO_QUALIFIED_MONITOR" ? "尚无当前有效、已核验的研究模型观察；AI 不补造结论。"
    : reason === "INVESTOR_AI_CONFIG_UNAVAILABLE" || reason === "INVESTOR_AI_CONSENT_NOT_CURRENT" ? "私有网关配置或限期共享许可尚未就绪；继续使用规则说明。"
    : reason === "INVESTOR_AI_RUNTIME_UNAVAILABLE" ? "独立 AI 后台尚未启用；继续使用规则说明，不会登记付费请求。"
    : reason === "INVESTOR_AI_OUTCOME_UNKNOWN" ? "此请求已登记可能外发，但未能确认结果或费用。不会因重启、刷新或再次点击自动重发；规则结论保持不变。"
    : reason === "INVESTOR_AI_RESULT_PURGED" ? "解释文本已经清理；请求记录保留，不会自动重新计费生成。"
    : valid?.status === "failed" ? "本次解释未通过核验，不自动重试；规则结论保持不变。" : "只解释已核验的研究模型比例和策略触发原因，不发送资金、风险答案、真实持仓、账户或原始行情。";
  return <section className="mt-4 min-w-0 rounded-xl border p-4" aria-label="在线 AI 解释">
    <h3 className="text-sm font-semibold">在线 AI 解释 · 不改变策略结论</h3><p className="mt-2 text-sm text-muted-foreground">{detail}</p>
    {valid?.status === "complete" && valid.review && <div className="mt-3 space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">生成文本尚未经人工验证，不能视为投资建议或交易批准。有效至 {valid.valid_until}；后台版本变化后须重新核对。</p>
      <p className="whitespace-pre-wrap break-words">{valid.review.reason}</p>
      {valid.review.inferences.map((row, index) => <p className="whitespace-pre-wrap break-words" key={index}>推断：{row.text}</p>)}
      {valid.review.risks.map((text, index) => <p className="whitespace-pre-wrap break-words" key={index}>风险 / 反证：{text}</p>)}
      {valid.review.unknowns.map((text, index) => <p className="whitespace-pre-wrap break-words" key={index}>尚不确定：{text}</p>)}
      <details><summary className="cursor-pointer">本次核对的派生指标</summary><ul className="mt-2 space-y-1">{valid.review.facts.map(row => <li className="break-words" key={row.evidence_id}>{row.metric}：{row.value} · {row.as_of}</li>)}</ul></details>
    </div>}
    {valid?.status === "available" && <><p className="mt-3 text-xs text-muted-foreground">提交后由后台处理，关闭页面或退出登录不会撤销已提交的请求；暂停监测或撤回共享许可将使未发送的请求失效。</p><Button className="mt-3" type="button" disabled={busy || submitted.current || disabled} onClick={() => void request(true)}>解释本次观察（单次调用）</Button></>}
    {valid?.status === "queued" && <p className="mt-3 text-sm" role="status">请求已登记，等待后台核验和处理；尚未登记外发。无需保持此页面打开。</p>}
    {valid?.status === "running" && <p className="mt-3 text-sm">解释正在生成。核对状态不会重新调用网关。</p>}
    {(!valid || valid.status !== "available") && <Button className="mt-3" type="button" variant="outline" disabled={busy || disabled} onClick={() => void request(false)}>核对解释状态</Button>}
    {busy && <p role="status" className="mt-2 text-sm">正在核对…</p>}{error && <p role="alert" className="mt-2 text-sm">{error}</p>}
  </section>;
}
