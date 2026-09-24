"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import { parseStrictJson } from "@/server/strict-json";
import type { VerificationState } from "@/server/verifications/types";
import { assertVerificationReceipt, assertVerificationState, prepareVerificationRequest, readVerificationArtifact, type VerificationPending } from "./verification-client";

const panel = "min-w-0 space-y-3 rounded-xl border bg-card p-4 [overflow-wrap:anywhere]";
const field = "w-full min-w-0 max-w-full rounded border bg-background px-3 py-2 text-sm";
const button = "max-w-full whitespace-normal rounded border px-3 py-2 text-sm [overflow-wrap:anywhere] disabled:opacity-40";
const safe = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.message) ? error.message : "VERIFICATION_REQUEST_FAILED";
async function readJson(response: Response) {
  const reader = response.body?.getReader(); if (!reader) throw new Error("VERIFICATION_RESPONSE_INVALID");
  const decoder = new TextDecoder("utf-8", { fatal: true }); let size = 0, raw = "";
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > 4 * 1048576) { void reader.cancel().catch(() => {}); throw new Error(); } raw += decoder.decode(value, { stream: true }); }
    return parseStrictJson(raw + decoder.decode());
  } catch { throw new Error("VERIFICATION_RESPONSE_INVALID"); }
  finally { reader.releaseLock(); }
}
function apiError(value: unknown) {
  return new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(value.error)
    ? value.error : "VERIFICATION_REQUEST_FAILED");
}

export function VerificationWorkspace({ initialSessionBinding }: { initialSessionBinding: string }) {
  const boundary = useSessionBoundary(), [invalid, setInvalid] = useState(false), [binding, setBinding] = useState(initialSessionBinding);
  const ready = !invalid && binding === initialSessionBinding && boundary?.verified === true && boundary.sessionBinding === initialSessionBinding;
  const [portfolio, setPortfolio] = useState<string | null>(null), [requestId, setRequestId] = useState<string | null>(null);
  const [data, setData] = useState<VerificationState | null>(null), [reason, setReason] = useState(""), [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [receipt, setReceipt] = useState<string | null>(null);
  const [pending, updatePending] = useState<VerificationPending | null>(null), pendingRef = useRef<VerificationPending | null>(null);
  const generation = useRef(0), busyRef = useRef(false), live = useRef({ ready, portfolio, requestId, readOnly: true });
  const downloads = useRef(new Set<string>());
  live.current = { ready, portfolio, requestId, readOnly: data?.read_only !== false };
  const setPending = (value: VerificationPending | null) => { pendingRef.current = value; updatePending(value); };
  const current = (token: number, p: string | null, r: string | null) => generation.current === token && live.current.ready && live.current.portfolio === p && live.current.requestId === r && document.visibilityState !== "hidden";
  const invalidateIfCurrent = (token: number, p: string | null, r: string | null) => { if (current(token, p, r)) window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); };
  const check401 = (response: Response, token: number, p: string | null, r: string | null) => {
    if (response.status === 401) { invalidateIfCurrent(token, p, r); throw new Error("SESSION_CHANGED"); }
  };
  const checkBinding = (value: unknown, token: number, p: string | null, r: string | null) => {
    if (value && typeof value === "object" && "session_binding" in value && typeof value.session_binding === "string"
      && /^[a-f0-9]{64}$/.test(value.session_binding) && value.session_binding !== initialSessionBinding) {
      invalidateIfCurrent(token, p, r); throw new Error("SESSION_CHANGED");
    }
  };
  async function probe(token: number, p: string | null, r: string | null) {
    try {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store", redirect: "error" }); check401(response, token, p, r);
      if (!response.ok) throw new Error("SESSION_UNAVAILABLE");
      const value = await readJson(response) as { authenticated?: unknown; session_binding?: unknown };
      if (value?.authenticated !== true || typeof value.session_binding !== "string" || !/^[a-f0-9]{64}$/.test(value.session_binding)) throw new Error("SESSION_UNAVAILABLE");
      checkBinding(value, token, p, r);
    } catch (failure) { if (current(token, p, r)) { live.current.readOnly = true; setData(null); } throw failure; }
  }
  async function load(cursor?: string) {
    if (!live.current.ready || document.visibilityState === "hidden") return;
    const p = live.current.portfolio, r = live.current.requestId, token = ++generation.current;
    busyRef.current = true; live.current.readOnly = true; setBusy(true); setData(null); setAck(false); setError("");
    try {
      await probe(token, p, r); if (!current(token, p, r)) return;
      const query = new URLSearchParams(); if (p) query.set("portfolio", p); if (r) query.set("request", r); if (cursor) query.set("cursor", cursor);
      const response = await fetch(`/api/workbench/verifications?${query}`, { credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "X-Workbench-Session-Binding": initialSessionBinding } }); check401(response, token, p, r);
      const value = await readJson(response); checkBinding(value, token, p, r); if (!response.ok) throw apiError(value);
      const verified = await assertVerificationState(value, p, r, initialSessionBinding);
      if (!current(token, p, r)) return; await probe(token, p, r); if (!current(token, p, r)) return;
      setData(verified); if (p !== verified.selected_portfolio_id) setPortfolio(verified.selected_portfolio_id);
    } catch (failure) { if (current(token, p, r)) { setData(null); setError(safe(failure)); } }
    finally { if (generation.current === token) { busyRef.current = false; setBusy(false); } }
  }
  useEffect(() => {
    ++generation.current; setData(null); setAck(false); busyRef.current = false; setBusy(false);
    if (ready) void load(); return () => { ++generation.current; };
    // Scope/session transitions only read; they never create or retry a check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolio, requestId, ready, initialSessionBinding]);
  useEffect(() => {
    if (binding !== initialSessionBinding) {
      live.current.ready = false; ++generation.current; setData(null); setPending(null); setReason(""); setAck(false); setReceipt(null); setError("");
      setPortfolio(null); setRequestId(null); setInvalid(false); setBinding(initialSessionBinding);
    }
  }, [binding, initialSessionBinding]);
  useEffect(() => {
    if (boundary?.sessionBinding !== initialSessionBinding) {
      ++generation.current; setData(null); setPending(null); setReason(""); setAck(false); setReceipt(null); setError("");
    }
  }, [boundary?.sessionBinding, initialSessionBinding]);
  useEffect(() => {
    const revokeDownloads = () => { for (const url of downloads.current) URL.revokeObjectURL(url); downloads.current.clear(); };
    const hide = () => { ++generation.current; revokeDownloads(); live.current.readOnly = true; setData(null); setAck(false); setReceipt(null); setError(""); busyRef.current = false; setBusy(false); };
    const visibility = () => { if (document.visibilityState === "hidden") hide(); };
    const invalidate = () => { live.current.ready = false; hide(); setInvalid(true); setPending(null); setReason(""); };
    window.addEventListener("blur", hide); window.addEventListener("pagehide", hide); document.addEventListener("visibilitychange", visibility); window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => { revokeDownloads(); window.removeEventListener("blur", hide); window.removeEventListener("pagehide", hide); document.removeEventListener("visibilitychange", visibility); window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); };
  }, []);
  const chooseScope = (p: string | null, r: string | null = null) => {
    if (busyRef.current) return;
    ++generation.current; live.current = { ...live.current, portfolio: p, requestId: r, readOnly: true };
    setData(null); setReason(""); setAck(false); setPending(null); setReceipt(null); setError(""); setPortfolio(p); setRequestId(r);
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!ready || !ack || !data || data.read_only || live.current.readOnly || busyRef.current || !portfolio) return;
    const p = portfolio, r = requestId, token = ++generation.current; busyRef.current = true; setBusy(true); setAck(false); setError(""); let sent = false;
    try {
      await probe(token, p, r); if (!current(token, p, r) || live.current.readOnly) return;
      const attempt = pendingRef.current ?? prepareVerificationRequest(data, reason, initialSessionBinding, crypto.randomUUID());
      if (attempt.portfolio !== p || attempt.binding !== initialSessionBinding) throw new Error("SESSION_CHANGED");
      setPending(attempt); sent = true;
      const response = await fetch("/api/workbench/verifications", { method: "POST", credentials: "same-origin", redirect: "error",
        headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": initialSessionBinding }, body: attempt.body }); check401(response, token, p, r);
      const value = await readJson(response); checkBinding(value, token, p, r); if (!response.ok) throw apiError(value);
      const verified = assertVerificationReceipt(value, attempt);
      if (!current(token, p, r)) return; await probe(token, p, r); if (!current(token, p, r)) return;
      setReceipt(JSON.stringify(verified, null, 2)); setPending(null); setReason(""); await load();
    } catch (failure) { if (current(token, p, r)) setError(safe(failure) + (sent ? "；原请求保留，未自动重发。" : "")); }
    finally { if (generation.current === token) { busyRef.current = false; setBusy(false); } }
  }
  async function downloadArtifact(artifactId: string, expectedHash: string) {
    if (!ready || !data || busyRef.current || !portfolio) return;
    const p = portfolio, r = requestId, token = ++generation.current; busyRef.current = true; setBusy(true); setAck(false); setError("");
    try {
      await probe(token, p, r); if (!current(token, p, r)) return;
      const query = new URLSearchParams({ portfolio: p, artifact: artifactId });
      const response = await fetch(`/api/workbench/verifications?${query}`, { credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { "X-Workbench-Session-Binding": initialSessionBinding } }); check401(response, token, p, r);
      checkBinding({ session_binding: response.headers.get("x-workbench-session-binding") }, token, p, r);
      if (!response.ok) throw apiError(await readJson(response));
      const blob = await readVerificationArtifact(response, expectedHash, initialSessionBinding);
      if (!current(token, p, r)) return; await probe(token, p, r); if (!current(token, p, r)) return;
      const url = URL.createObjectURL(blob); downloads.current.add(url);
      const link = document.createElement("a"); link.href = url; link.download = "verification-artifact.json";
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => { URL.revokeObjectURL(url); downloads.current.delete(url); }, 1000);
    } catch (failure) { if (current(token, p, r)) setError(safe(failure)); }
    finally { if (generation.current === token) { busyRef.current = false; setBusy(false); } }
  }
  if (!ready) return <main className="p-6"><h1 className="text-xl font-semibold">受控工程子检查</h1><p>会话待核对；未显示组合、请求或私有工件。</p></main>;
  return <main className="mx-auto max-w-5xl space-y-5 p-4 md:p-6" aria-busy={busy}>
    <header className={panel}><h1 className="text-2xl font-semibold">受控工程子检查</h1><p>仅运行固定的合成现金追加中性检查 E-02.cash-contribution-neutrality.v1，由受控 Worker 产生真实执行结果；不能上传或填写 PASS。</p>
      <p>数据为 synthetic，范围为 engineering_subcheck。通过不代表完整 E-02、G-03、G-04、策略准入或生产验收；不会下单、入账或使用个人投资参数。</p>
      <p className="text-sm">打开页面和刷新只读取状态，不会自动创建或重试检查。切换组合会清空草稿与重试信息；关闭或强制刷新可能丢失这些内存记录，但不撤销已经提交的任务。</p></header>
    <section className={panel}><label>组合<select aria-label="工程检查组合" className={field} value={portfolio ?? ""} disabled={!data || busy}
      onChange={event => chooseScope(event.target.value)}>{data?.portfolios.map(row => <option key={row.id} value={row.id}>{row.name} · {row.base_currency}</option>)}</select></label>
      <button type="button" className={button} disabled={busy} onClick={() => void load()}>刷新会话、任务与工件</button>
      {busy && <p role="status">正在核对会话与证据，请稍候。</p>}
      {error && <p role="alert" className="break-all">{error}</p>}{!data && <p>资料尚未复核；写入锁定。</p>}{data?.read_only && <p>恢复/只读模式：可以读取任务与工件，不能创建检查。</p>}</section>
    {data && <><section className={panel}><h2 className="font-semibold">固定检查与执行上下文</h2><p>{data.check.id} · {data.check.suite_version}</p>
      <p>来源：{data.check.data_provenance} · 范围：{data.check.acceptance_scope} · gate_eligible=false</p>
      <p className="text-xs">context SHA256：{data.check.context_hash ?? "未就绪"}</p>
      {!data.check.available && <p>检查暂不可用：源码或运行包未就绪，不能创建任务。</p>}{data.check.issues.length > 0 && <p>{data.check.issues.join(" / ")}</p>}
      {!data.selected_portfolio_id && <p>请先在工作台建立组合；此页不会自动创建组合。</p>}</section>
      <form className={panel} onSubmit={submit}><h2 className="font-semibold">显式请求合成检查</h2><label>请求理由<textarea aria-label="工程检查请求理由" className={field} value={reason} maxLength={1000}
        disabled={busy || !!pending || data.read_only || !data.check.available || !portfolio} onChange={event => { setReason(event.target.value); setAck(false); setReceipt(null); }} /></label>
        {pending && <div className="space-y-2 text-sm"><p>请求结果尚未核对，可能已经入队。先刷新任务；人工重试只发送原 context hash、原字节和幂等键，不自动换用新源码。</p>
          <details><summary>冻结的原请求</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{pending.body}</pre></details>
          <button type="button" className={button} disabled={busy} onClick={() => { if (window.confirm("已核对服务端并放弃本页重试？这不会撤销已经入队的任务。")) { setPending(null); setReason(""); setAck(false); } }}>放弃本页重试信息</button></div>}
        <label className="flex gap-2"><input type="checkbox" checked={ack} disabled={busy || data.read_only || !data.check.available || !portfolio} onChange={event => setAck(event.target.checked)} />我确认只请求此固定合成工程子检查，已核对组合、上下文与理由；这不是投资批准。</label>
        <button className={button} disabled={!ack || busy || data.read_only || !data.check.available || !data.check.context_hash || !portfolio}>{pending ? "人工重试完全相同请求" : "确认请求合成检查"}</button>
      </form>
      {receipt && <section className={panel}><h2>服务端排队回执（不是执行通过）</h2><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{receipt}</pre></section>}
      <section className={panel}><h2 className="font-semibold">本组合检查请求与实际执行结果</h2>{requestId && <button type="button" className={button} disabled={busy} onClick={() => chooseScope(portfolio)}>返回本组合请求列表</button>}
        {data.requests.length === 0 && <p>没有检查请求；不会自动运行。</p>}{data.requests.map(row => <article className={panel} key={row.id}>
          <p>请求 {row.id}</p><p>{row.requested_at} · {row.requested_by} · job {row.job_status}</p><p className="text-xs">请求 context SHA256：{row.context_hash}</p>
          {row.evidence_issues.length > 0 && <p role="status">证据缺口：{row.evidence_issues.join(" / ")}</p>}
          {!row.execution ? <p>暂无已核验的执行结果；排队/任务状态不等于检查通过。</p> : <div className="space-y-2">
            <p>真实执行结果：{row.execution.status} · attempt {row.execution.attempt}</p><p>{row.execution.started_at} 至 {row.execution.finished_at}</p>
            <p>controlled_runner · synthetic · engineering_subcheck · gate_eligible=false</p>
            <p>{row.execution.current_runtime_match === true ? "执行源码与当前运行版本一致。" : row.execution.current_runtime_match === false ? "历史执行源码与当前运行版本不一致，不能冒充当前验证。" : "当前运行版本一致性未确认。"}</p>
            <p className="text-xs">工件 SHA256：{row.execution.artifact_sha256}</p>
            <details><summary>查看已核验的原始结果 JSON</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(row.execution.result, null, 2)}</pre></details>
            <button type="button" className={button} disabled={busy} onClick={() => void downloadArtifact(row.execution!.artifact_id, row.execution!.artifact_sha256)}>下载私有执行原件（JSON 附件，不执行）</button>
          </div>}
          {!requestId && <button type="button" className={button} disabled={busy} onClick={() => chooseScope(portfolio, row.id)}>读取请求 {row.id}</button>}
        </article>)}{data.next_cursor && <button type="button" className={button} disabled={busy} onClick={() => void load(data.next_cursor!)}>读取下一页检查请求</button>}
      </section>
    </>}
  </main>;
}
