"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import type { EvaluationState } from "@/server/evaluation/types";
import { assertEvaluationReceipt, assertEvaluationState, emptyEvaluationDraft, evaluationProposalId, evaluationTemplate,
  EvaluationRequestGate, prepareEvaluationAttempt, sealEvaluationAttempt, type EvaluationAction, type EvaluationDraft, type EvaluationPending } from "./evaluation-client";

const panel = "min-w-0 space-y-4 rounded-xl border bg-card p-5", input = "w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm";
const labels = { save_schedule: "保存新版本（始终暂停）", enable: "启用未来周期评估", pause: "暂停后续评估", retry_evaluation: "重试原周期" } as const;
const statusLabels: Record<string, string> = { enabled: "已启用", paused: "已暂停", pending: "等待执行", running: "执行中", completed: "已完成", blocked: "被阻断", failed: "失败", succeeded: "成功" };
const outcomeLabels = { unchanged: "无需调整（证据限定）", proposed: "已生成候选，仍待人工审批", blocked: "被阻断" };

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("EVALUATION_RESPONSE_INVALID");
  const decoder = new TextDecoder("utf-8", { fatal: true }); let raw = "", bytes = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength;
    if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("EVALUATION_RESPONSE_TOO_LARGE"); }
    raw += decoder.decode(next.value, { stream: true }); }
  return JSON.parse(raw + decoder.decode());
}
function responseError(value: unknown): Error {
  const code = value && typeof value === "object" && "error" in value ? value.error : null;
  return new Error(typeof code === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(code) ? code : "EVALUATION_REQUEST_FAILED");
}
function Evidence({ title, raw }: { title: string; raw: string }) {
  return <details className="min-w-0 rounded-md border p-3 text-sm"><summary className="cursor-pointer">{title}</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{raw}</pre></details>;
}

export function EvaluationWorkspace({ initial, initialSessionBinding }: { initial: EvaluationState; initialSessionBinding: string }) {
  const [sessionInvalid, setSessionInvalid] = useState(false);
  const [probeFailed, setProbeFailed] = useState(false);
  const [stateBinding, setStateBinding] = useState(initialSessionBinding);
  const boundary = useSessionBoundary(), sessionReady = stateBinding === initialSessionBinding && !sessionInvalid && !probeFailed && boundary?.verified === true && boundary.sessionBinding === initialSessionBinding;
  const [portfolios, setPortfolios] = useState(initial.portfolios), [selected, setSelected] = useState(initial.selected_portfolio_id);
  const [data, setData] = useState<EvaluationState | null>(null), [draft, setDraft] = useState<EvaluationDraft>(emptyEvaluationDraft);
  const [confirmed, setConfirmed] = useState(false), [pending, setPending] = useState<EvaluationPending | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const gate = useRef(new EvaluationRequestGate()), busyRef = useRef(false), live = useRef({ selected, sessionReady, readOnly: true });
  live.current = { selected, sessionReady, readOnly: data?.read_only !== false };
  const verified = () => live.current.sessionReady && document.visibilityState !== "hidden";
  const isCurrent = (token: number, portfolio: string | null) => gate.current.current(token) && live.current.selected === portfolio && verified();

  function rejectChangedSession(response: Response, token: number, portfolio: string | null) {
    if (response.status !== 401) return;
    if (isCurrent(token, portfolio)) window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT));
    throw new Error("SESSION_CHANGED");
  }
  async function probe(token: number, portfolio: string | null) {
    try {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store", redirect: "error", headers: { Accept: "application/json" } });
      rejectChangedSession(response, token, portfolio);
      if (response.status !== 200) throw new Error("SESSION_UNAVAILABLE");
      const value = await readJson(response) as { authenticated?: unknown; session_binding?: unknown };
      if (value?.authenticated !== true || typeof value.session_binding !== "string" || !/^[a-f0-9]{64}$/.test(value.session_binding)) throw new Error("SESSION_UNAVAILABLE");
      if (value.session_binding !== initialSessionBinding) {
        if (isCurrent(token, portfolio)) window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); throw new Error("SESSION_CHANGED");
      }
    } catch (failure) {
      if (isCurrent(token, portfolio)) setProbeFailed(true);
      throw failure;
    }
  }
  async function load(query: { cycleId?: string; cursor?: string; attemptCursor?: string } = {}) {
    if (!verified()) return;
    const portfolio = live.current.selected, token = gate.current.next();
    busyRef.current = true; setBusy(true); setConfirmed(false); setError(""); setData(null);
    try {
      await probe(token, portfolio); if (!isCurrent(token, portfolio)) return;
      const parameters = new URLSearchParams({ limit: "20" });
      if (portfolio) parameters.set("portfolio", portfolio);
      if (query.cycleId) parameters.set("cycle", query.cycleId);
      if (query.cursor) parameters.set("cursor", query.cursor);
      if (query.attemptCursor) parameters.set("attempt_cursor", query.attemptCursor);
      const response = await fetch(`/api/workbench/evaluations?${parameters}`, { credentials: "same-origin", cache: "no-store", redirect: "error" });
      rejectChangedSession(response, token, portfolio);
      const value = await readJson(response); if (!response.ok) throw responseError(value);
      assertEvaluationState(value, { portfolioId: portfolio ?? undefined, cycleId: query.cycleId });
      await probe(token, portfolio); if (!isCurrent(token, portfolio)) return;
      setData(value); setPortfolios(value.portfolios);
      if (value.selected_portfolio_id !== portfolio) setSelected(value.selected_portfolio_id);
    } catch (failure) { if (isCurrent(token, portfolio)) setError(failure instanceof Error ? failure.message : "EVALUATION_READ_FAILED"); }
    finally { if (gate.current.current(token)) { busyRef.current = false; setBusy(false); } }
  }

  useEffect(() => {
    if (stateBinding === initialSessionBinding) return;
    gate.current.invalidate(); setConfirmed(false); setPending(null); setReceipt(null); setData(null); setDraft(emptyEvaluationDraft());
    setPortfolios(initial.portfolios); setSelected(initial.selected_portfolio_id); setSessionInvalid(false); setProbeFailed(false); setStateBinding(initialSessionBinding);
    // Never render retained state under a replacement page/session binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionBinding, stateBinding]);
  useEffect(() => {
    gate.current.invalidate(); busyRef.current = false; setBusy(false); setConfirmed(false); setData(null);
    if (sessionReady) void load();
    return () => { gate.current.invalidate(); busyRef.current = false; };
    // A new verified session/scope is the only automatic GET trigger. Never automatically POST.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, sessionReady, initialSessionBinding]);
  useEffect(() => {
    const clearConfirmation = () => { gate.current.invalidate(); busyRef.current = false; setBusy(false); setConfirmed(false); setData(null); };
    const hide = () => { if (document.visibilityState === "hidden") clearConfirmation(); };
    const invalidate = () => { setSessionInvalid(true); clearConfirmation(); setPending(null); setReceipt(null); setDraft(emptyEvaluationDraft()); };
    window.addEventListener("blur", clearConfirmation); window.addEventListener("pagehide", clearConfirmation);
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate); document.addEventListener("visibilitychange", hide);
    return () => { window.removeEventListener("blur", clearConfirmation); window.removeEventListener("pagehide", clearConfirmation);
      window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); document.removeEventListener("visibilitychange", hide); };
  }, []);

  function edit(patch: Partial<EvaluationDraft>) { setDraft(value => ({ ...value, ...patch })); setConfirmed(false); setReceipt(null); setError(""); }
  function chooseAction(action: EvaluationAction, scheduleId = "", cycleId = "") {
    if (pending || busyRef.current) return;
    setDraft({ ...emptyEvaluationDraft(), action, scheduleId, cycleId }); setConfirmed(false); setReceipt(null); setError("");
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || !data || data.read_only || !verified() || busyRef.current) return;
    let attempt: EvaluationPending;
    try { attempt = pending ?? prepareEvaluationAttempt(data, draft, initialSessionBinding, crypto.randomUUID()); }
    catch (failure) { setConfirmed(false); setError(failure instanceof Error && failure.name !== "ZodError" ? failure.message : "请填写全部必需字段与非空理由"); return; }
    if (attempt.portfolioId !== selected || attempt.sessionBinding !== initialSessionBinding) { setConfirmed(false); setError("SESSION_CHANGED"); return; }
    const portfolio = selected, token = gate.current.next(); busyRef.current = true; setBusy(true); setError(""); setConfirmed(false);
    let sent = false;
    try {
      await probe(token, portfolio); if (!isCurrent(token, portfolio) || live.current.readOnly) return;
      attempt = await sealEvaluationAttempt(attempt);
      if (!isCurrent(token, portfolio) || live.current.readOnly) return;
      // Freeze once, before the network write. Unknown responses can only replay these exact bytes/key.
      setPending(attempt); sent = true;
      const response = await fetch("/api/workbench/evaluations", { method: "POST", credentials: "same-origin", redirect: "error",
        headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": initialSessionBinding }, body: attempt.body });
      rejectChangedSession(response, token, portfolio);
      const value = await readJson(response);
      if (!response.ok) throw responseError(value);
      await assertEvaluationReceipt(value, attempt);
      await probe(token, portfolio); if (!isCurrent(token, portfolio)) return;
      setReceipt(JSON.stringify(value, null, 2)); setPending(null); setDraft(emptyEvaluationDraft());
      await load();
    } catch (failure) {
      if (isCurrent(token, portfolio)) setError(`${failure instanceof Error ? failure.message : "EVALUATION_REQUEST_FAILED"}${sent ? "；不自动重发。请先刷新核对，或人工重试原请求。" : ""}`);
    } finally { if (gate.current.current(token)) { busyRef.current = false; setBusy(false); } }
  }

  const writeLocked = busy || !sessionReady || !data || data.read_only;
  const schedule = data?.schedules.find(row => row.id === draft.scheduleId);
  const detail = data?.detail, currentCycle = detail?.cycle.id === draft.cycleId ? detail.cycle : data?.cycles.find(row => row.id === draft.cycleId);
  if (!sessionReady) return <section className={panel} role="status"><h1 className="text-xl font-semibold">月度策略评估</h1><p className="text-sm">会话尚未匹配并复核，组合目录、草稿与回执保持隐藏。</p>
    {probeFailed && !sessionInvalid && <Button type="button" variant="outline" onClick={() => setProbeFailed(false)}>重新核对会话（保留未决请求）</Button>}
    {(sessionInvalid || (boundary?.verified && boundary.sessionBinding !== initialSessionBinding)) && <Button type="button" variant="outline" onClick={() => window.location.reload()}>重新载入匹配的会话页面</Button>}</section>;
  return <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-1 md:p-4" aria-busy={busy}>
    <header><p className="text-sm text-muted-foreground">ETF / MONTHLY EVALUATIONS</p><h1 className="mt-1 text-3xl font-semibold">月度策略评估</h1><p className="mt-2 text-sm text-muted-foreground">显式目标、独立调度授权与固定周期证据。只生成候选，不自动审批、预占资金、下单或入账。</p></header>
    <nav aria-label="工作台模块" className="flex flex-wrap gap-4 text-sm"><Link className="underline" href="/workbench">账户与账本</Link><Link className="underline" href="/workbench/governance">政策与执行审批</Link><Link className="underline" href="/workbench/research">策略研究</Link></nav>
    <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">先取得政策、策略及实盘建议准入的有效批准，再登记调度定义；保存版本始终暂停，另行人工启用才授权未来触发。没有已批准参数时保持空白，不提供默认投资方案。“无需调整”只表示本次完整证据与批准容差内不需要动作，不保证盈利。</p>
    {error && <p role="alert" className="break-all rounded-md border border-red-500/40 p-4 text-sm">{error}</p>}
    {!sessionReady && <p role="status">会话尚未复核，不能读取或提交。</p>}
    {data?.read_only && <p role="status" className="rounded-md border p-4 text-sm">当前为只读模式：可查看与分页读取，禁止保存、启停和重试。</p>}
    <section className={panel}><div className="flex flex-wrap items-end gap-3"><label className="min-w-0 flex-1 space-y-2 text-sm">当前组合<select aria-label="当前组合" className={input} value={selected ?? ""} disabled={busy || !!pending || !sessionReady} onChange={event => {
      gate.current.invalidate(); setConfirmed(false); setData(null); setReceipt(null); setDraft(emptyEvaluationDraft()); setSelected(event.target.value);
    }}><option value="" disabled>尚无组合</option>{portfolios.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><Button type="button" variant="outline" disabled={busy || !sessionReady} onClick={() => void load()}>刷新并重新核对</Button></div>
      <p className="text-sm text-muted-foreground">账本版本：{data?.ledger_revision ?? "未复核"}。刷新、换组合和窗口失焦会清除本次确认；返回窗口后请刷新。不会自动重发命令。</p>
      {!selected && <Link className="text-sm underline" href="/workbench">前往建立空组合</Link>}</section>
    {data && <section className={panel}><h2 className="text-lg font-semibold">调度当前版本</h2>{!data.schedules.length && <p className="text-sm text-muted-foreground">尚无调度。不会自动建立资金、目标权重或授权。</p>}
      {data.schedules.map(row => <article key={row.id} className="min-w-0 space-y-3 border-t pt-4 text-sm"><h3 className="break-all font-medium">{row.strategy_key} · {statusLabels[row.status]} · v{row.current_version.version}</h3>
        <p className="break-all">调度 {row.id} · CAS {row.schedule_revision}<br />版本 {row.current_version.id}<br />人工审计 {row.last_audit_id} · {row.updated_at}</p>
        <p>{row.current_version.definition.start_month} — {row.current_version.definition.end_month ?? "无结束月"}；{row.current_version.definition.timezone} 每月 {row.current_version.definition.trigger.day} 日 {String(row.current_version.definition.trigger.hour).padStart(2, "0")}:{String(row.current_version.definition.trigger.minute).padStart(2, "0")}</p>
        <p className="break-all font-mono text-xs">原文 SHA256 {row.current_version.content_hash}</p><Evidence title="已批准输入的调度原文（不代表周期已通过）" raw={row.current_version.definition_json} />
        <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={!!writeLocked || !!pending} onClick={() => { chooseAction("save_schedule", row.id); setDraft({ ...emptyEvaluationDraft(), scheduleId: row.id, definitionJson: row.current_version.definition_json }); }}>编辑为新的暂停版本</Button>
          <Button type="button" variant="outline" disabled={!!writeLocked || !!pending} onClick={() => chooseAction(row.status === "enabled" ? "pause" : "enable", row.id)}>{row.status === "enabled" ? "选择暂停" : "选择启用"}</Button></div>
      </article>)}{data.schedules_truncated && <p role="status">仅显示前 100 个调度；当前界面不能编辑未显示项。</p>}</section>}
    {data && <section className={panel}><h2 className="text-lg font-semibold">周期与独立重试</h2>{!data.cycles.length && <p className="text-sm text-muted-foreground">尚无周期。启用不会补造过去月份；可信后台在未来触发后建立周期。</p>}
      {data.cycles.map(row => <article key={row.id} className="space-y-2 border-t pt-3 text-sm"><h3>{row.period} · {statusLabels[row.status]} · {row.outcome ? outcomeLabels[row.outcome] : "尚无最终结论"}</h3><p className="break-all font-mono text-xs">{row.id}</p><p>状态版本 {row.state_revision} · 截止 {row.deadline_at}</p><Button type="button" variant="outline" disabled={busy} onClick={() => void load({ cycleId: row.id })}>查看周期证据</Button></article>)}
      <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={busy} onClick={() => void load()}>最新周期</Button><Button type="button" variant="outline" disabled={busy || !data.next_cursor} onClick={() => void load({ cursor: data.next_cursor! })}>更早周期</Button></div>
    </section>}
    {detail && <section className={panel}><h2 className="text-lg font-semibold">周期详情 · {detail.cycle.period}</h2><dl className="grid gap-3 break-all text-sm sm:grid-cols-2">
      <div><dt>周期 / 状态版本</dt><dd>{detail.cycle.id} / {detail.cycle.state_revision}</dd></div><div><dt>原调度版本</dt><dd>{detail.cycle.schedule_version_id}</dd></div>
      <div><dt>原触发时间</dt><dd>{detail.cycle.scheduled_at}</dd></div><div><dt>经济截止（cutoff）</dt><dd>{detail.cycle.cutoff_at}</dd></div><div><dt>已知截止（knowledge）</dt><dd>{detail.cycle.knowledge_at}</dd></div>
      <div><dt>重试截止</dt><dd>{detail.cycle.deadline_at}</dd></div><div><dt>终态尝试</dt><dd>{detail.cycle.terminal_attempt_id ?? "尚无"}</dd></div></dl>
      <p className="text-sm">重试保留原周期、版本、数据截止和已知截止，不使用新日期改写旧结论；还需当前授权有效、旧任务已终止且未过截止。已完成周期不能重开。暂停不会撤销已有提案或预留。</p>
      <Button type="button" variant="outline" disabled={!!writeLocked || !!pending || !["blocked", "failed"].includes(detail.cycle.status)} onClick={() => chooseAction("retry_evaluation", "", detail.cycle.id)}>选择重试此周期</Button>
      {detail.attempts.map(row => { const proposal = evaluationProposalId(row.result_json); return <article key={row.id} className="min-w-0 space-y-3 border-t pt-4 text-sm"><h3>尝试 #{row.attempt} · {statusLabels[row.status]}</h3><p className="break-all">{row.id}<br />{row.created_at} — {row.completed_at}</p><p className="break-all font-mono text-xs">输入 {row.input_hash}<br />结果 {row.result_hash}</p><Evidence title="输入证据与授权引用" raw={row.input_manifest_json} /><Evidence title="结果、阻断原因与风险证据" raw={row.result_json} />{proposal && <p className="break-all">候选提案 {proposal} · <Link className="underline" href={`/workbench/governance?portfolio=${encodeURIComponent(selected ?? "")}&proposal=${encodeURIComponent(proposal)}`}>前往政策与执行页核对（按此 ID 查找；不自动批准）</Link></p>}</article>; })}
      {!detail.attempts.length && <p className="text-sm text-muted-foreground">尚无领域尝试记录；排队不等于执行成功。</p>}
      <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={busy} onClick={() => void load({ cycleId: detail.cycle.id })}>最新尝试</Button><Button type="button" variant="outline" disabled={busy || !detail.next_attempt_cursor} onClick={() => void load({ cycleId: detail.cycle.id, attemptCursor: detail.next_attempt_cursor! })}>更早尝试</Button></div>
      <Evidence title="人类重试 / 系统发现请求与任务状态" raw={JSON.stringify({ requests: detail.requests, jobs: detail.jobs }, null, 2)} />{detail.requests_truncated && <p role="status">请求仅显示最新 100 条，未把截断视为完整历史。</p>}
    </section>}
    {selected && <section className={panel}><h2 className="text-lg font-semibold">显式人工操作</h2>
      {pending && <div role="status" className="space-y-3 rounded-md border border-amber-500/50 p-4 text-sm"><p>已保留本页的冻结请求。它不代表成功；刷新可核对调度与周期，重试只能使用原字节、原版本和原幂等键。离开或重载本页不会自动恢复或重发，请先核对服务端审计。</p><Evidence title="冻结原请求（含原 CAS 与幂等键）" raw={pending.body} /><Button type="button" variant="outline" disabled={busy} onClick={() => {
        if (!window.confirm("仅丢弃本页请求副本，不撤销服务端可能已发生的保存、启停或排队。请先刷新核对。确定继续？")) return;
        setPending(null); setConfirmed(false); setDraft(emptyEvaluationDraft()); setData(null); setReceipt(null);
      }}>明确丢弃本页副本（不撤销操作）</Button></div>}
      <form className="space-y-4" onSubmit={event => void submit(event)}><fieldset disabled={!!writeLocked || !!pending} className="min-w-0 space-y-4">
        <label className="block space-y-2 text-sm">操作<select aria-label="评估操作" className={input} value={draft.action} onChange={event => chooseAction(event.target.value as EvaluationAction)}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {draft.action !== "retry_evaluation" && <label className="block space-y-2 text-sm">调度<select aria-label="操作调度" className={input} value={draft.scheduleId} onChange={event => edit({ scheduleId: event.target.value, definitionJson: "" })}><option value="">{draft.action === "save_schedule" ? "新策略调度（预期版本 0）" : "请选择当前调度"}</option>{data?.schedules.map(row => <option key={row.id} value={row.id}>{row.strategy_key} · v{row.current_version.version} · CAS {row.schedule_revision}</option>)}</select></label>}
        {draft.action === "save_schedule" && <><p className="text-sm text-muted-foreground">原文严格 JSON，所有政策/策略/激活 ID、账户、证券、币种、权重、容差、时间及期限均须明确填写。空结构不能通过验证。编辑旧定义须自行核对起始月与有效批准。</p><Button type="button" variant="outline" onClick={() => edit({ definitionJson: evaluationTemplate() })}>载入空结构（无投资数值默认值）</Button><label className="block space-y-2 text-sm">调度定义原文<textarea aria-label="调度定义原文" className={`${input} min-h-80 font-mono text-xs`} value={draft.definitionJson} onChange={event => edit({ definitionJson: event.target.value })} placeholder="粘贴已核对的 evaluation-schedule-v1 定义，或载入空结构后完整填写" /></label></>}
        {draft.action === "retry_evaluation" && <label className="block space-y-2 text-sm">原周期<Input aria-label="重试周期 ID" readOnly value={draft.cycleId} placeholder="请先查看周期证据，再选择重试" /></label>}
        <label className="block space-y-2 text-sm">本次人工操作理由<Input aria-label="评估操作理由" value={draft.reason} maxLength={2000} onChange={event => edit({ reason: event.target.value })} /></label>
      </fieldset>
        <p className="break-all text-sm">{pending ? "重试冻结原请求，不更新其 CAS 或参数。" : `${labels[draft.action]}；账本 CAS ${data?.ledger_revision ?? "未复核"}；${draft.action === "retry_evaluation" ? `原周期状态 CAS ${currentCycle?.state_revision ?? "未选择"}` : `调度 CAS ${schedule?.schedule_revision ?? (draft.scheduleId ? "未加载" : 0)}`}`}</p>
        <label className="flex items-start gap-2 text-sm"><input aria-label="确认评估操作" type="checkbox" className="mt-1" checked={confirmed} disabled={!!writeLocked} onChange={event => setConfirmed(event.target.checked)} /><span>我已核对当前组合、原文 / 目标版本、理由、截止时间和本次操作。保存仅暂停；启用只授权未来评估；重试不改变原数据截止。任何候选仍须另行人类审批。</span></label>
        <Button disabled={!!writeLocked || !confirmed} type="submit">{pending ? "人工重试冻结原请求" : labels[draft.action]}</Button>
      </form>
      {receipt && <div role="status" className="space-y-3"><p className="text-sm">服务端已返回并校验本次操作回执。保存、授权或排队不等于周期成功，也不等于成交。</p><Evidence title="已校验回执" raw={receipt} /></div>}
    </section>}
  </div>;
}
