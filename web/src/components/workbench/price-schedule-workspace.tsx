"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import { parseStrictJson } from "@/server/strict-json";
import { PRICE_MARKET_ZONES } from "@/server/price-schedules/schemas";
import type { PriceCollectionScheduleState, PriceCollectionSlotDetail, PriceCollectionSlotView } from "@/server/price-schedules/types";
import { assertPriceScheduleState, assertPriceScheduleDetail, assertPriceScheduleReceipt, emptyPriceScheduleDraft, draftFromDefinition,
  preparePriceScheduleAttempt, type PriceScheduleDraft, type PriceSchedulePending } from "./price-schedule-client";

const panel = "min-w-0 space-y-3 rounded-xl border bg-card p-4 [overflow-wrap:anywhere]";
const field = "w-full min-w-0 max-w-full rounded border bg-background px-3 py-2 text-sm";
const button = "max-w-full whitespace-normal rounded border px-3 py-2 text-sm [overflow-wrap:anywhere] disabled:opacity-40";
const safe = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.message) ? error.message : "PRICE_SCHEDULE_REQUEST_FAILED";
async function readJson(response: Response) {
  const reader = response.body?.getReader(); if (!reader) throw new Error("PRICE_SCHEDULE_RESPONSE_INVALID");
  const decoder = new TextDecoder("utf-8", { fatal: true }); let length = 0, raw = "";
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength;
      if (length > 4 * 1048576) { void reader.cancel().catch(() => {}); throw new Error(); } raw += decoder.decode(value, { stream: true }); }
    return parseStrictJson(raw + decoder.decode());
  } catch { throw new Error("PRICE_SCHEDULE_RESPONSE_INVALID"); } finally { reader.releaseLock(); }
}
function apiError(value: unknown) { return new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(value.error) ? value.error : "PRICE_SCHEDULE_REQUEST_FAILED"); }
function SlotEvidence({ slot }: { slot: PriceCollectionSlotView }) {
  return <div className="space-y-2 text-sm"><p>目标价格日期 D：{slot.period} · {slot.disposition} · 原因：{slot.reason_code ?? "无"}</p>
    <p>计划触发 UTC：{slot.scheduled_at} · 截止 UTC：{slot.deadline_at}</p><p>实际接收 UTC：{slot.capture?.received_at ?? "暂无已验真发布"}</p>
    <p>任务：{slot.job?.status ?? "无任务"} · attempt {slot.job?.attempt_count ?? 0} / {slot.job?.max_attempts ?? "无"} · 发布：{slot.capture?.status ?? "暂无已验真发布"}</p>
    <p>请求 {slot.command_request_id ?? "无"} · publication CAS {slot.expected_publication_revision ?? "无"}</p>
    <p>冻结版本 {slot.schedule_version_id} · 授权 audit {slot.authorization_audit_id} / CAS {slot.authorization_revision}</p>
    <p>capture {slot.capture?.id ?? "无"} · batch {slot.capture?.batch_id ?? "无"} · receipt SHA256 {slot.capture?.receipt_hash ?? "无"}</p>
    <p>引用 SHA256 {slot.reference_binding_hash}</p></div>;
}
export function PriceScheduleWorkspace({ initialSessionBinding }: { initialSessionBinding: string }) {
  const boundary = useSessionBoundary(), [invalid, setInvalid] = useState(false), [binding, setBinding] = useState(initialSessionBinding);
  const ready = !invalid && binding === initialSessionBinding && boundary?.verified === true && boundary.sessionBinding === initialSessionBinding;
  const [portfolio, setPortfolio] = useState<string | null>(null), [slotId, setSlotId] = useState<string | null>(null);
  const [data, setData] = useState<PriceCollectionScheduleState | null>(null), [detail, setDetail] = useState<PriceCollectionSlotDetail | null>(null);
  const [draft, setDraft] = useState(emptyPriceScheduleDraft), [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [receipt, setReceipt] = useState<string | null>(null);
  const [pending, updatePending] = useState<PriceSchedulePending | null>(null), pendingRef = useRef<PriceSchedulePending | null>(null);
  const generation = useRef(0), busyRef = useRef(false), live = useRef({ ready, portfolio, slotId, readOnly: true });
  live.current = { ready, portfolio, slotId, readOnly: data?.read_only !== false || detail?.read_only === true };
  const setPending = (value: PriceSchedulePending | null) => { pendingRef.current = value; updatePending(value); };
  const current = (token: number, p: string | null, s: string | null) => token === generation.current && live.current.ready && live.current.portfolio === p && live.current.slotId === s && document.visibilityState !== "hidden";
  const invalidateIfCurrent = (token: number, p: string | null, s: string | null) => { if (current(token, p, s)) window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); };
  const check401 = (response: Response, token: number, p: string | null, s: string | null) => { if (response.status === 401) { invalidateIfCurrent(token, p, s); throw new Error("SESSION_CHANGED"); } };
  const checkBinding = (value: unknown, token: number, p: string | null, s: string | null) => {
    if (value && typeof value === "object" && "session_binding" in value && typeof value.session_binding === "string" && /^[a-f0-9]{64}$/.test(value.session_binding) && value.session_binding !== initialSessionBinding) {
      invalidateIfCurrent(token, p, s); throw new Error("SESSION_CHANGED");
    }
  };
  async function probe(token: number, p: string | null, s: string | null) {
    try {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store", redirect: "error" }); check401(response, token, p, s);
      if (!response.ok) throw new Error("SESSION_UNAVAILABLE");
      const value = await readJson(response) as { authenticated?: unknown; session_binding?: unknown };
      if (value?.authenticated !== true || typeof value.session_binding !== "string" || !/^[a-f0-9]{64}$/.test(value.session_binding)) throw new Error("SESSION_UNAVAILABLE");
      checkBinding(value, token, p, s);
    } catch (failure) { if (current(token, p, s)) { live.current.readOnly = true; setData(null); setDetail(null); } throw failure; }
  }
  async function load(cursor?: string) {
    if (!live.current.ready || document.visibilityState === "hidden") return;
    const p = live.current.portfolio, s = live.current.slotId, token = ++generation.current;
    busyRef.current = true; live.current.readOnly = true; setBusy(true); setData(null); setDetail(null); setAck(false); setError("");
    try {
      await probe(token, p, s); if (!current(token, p, s)) return;
      const query = new URLSearchParams(); if (p) query.set("portfolio", p); if (cursor) query.set("cursor", cursor);
      const options = { credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "X-Workbench-Session-Binding": initialSessionBinding } } as const;
      const response = await fetch(`/api/workbench/price-schedules?${query}`, options); check401(response, token, p, s);
      const value = await readJson(response); checkBinding(value, token, p, s); if (!response.ok) throw apiError(value);
      const verified = await assertPriceScheduleState(value, p, null, initialSessionBinding); if (!current(token, p, s)) return;
      let slotDetail: PriceCollectionSlotDetail | null = null;
      if (s) {
        if (!p) throw new Error("PRICE_SCHEDULE_RESPONSE_INVALID");
        const response = await fetch(`/api/workbench/price-schedules?${new URLSearchParams({ portfolio: p, slot: s })}`, options); check401(response, token, p, s);
        const value = await readJson(response); checkBinding(value, token, p, s); if (!response.ok) throw apiError(value);
        slotDetail = await assertPriceScheduleDetail(value, p, s, initialSessionBinding);
      }
      if (!current(token, p, s)) return; await probe(token, p, s); if (!current(token, p, s)) return;
      setData(verified); setDetail(slotDetail); if (p !== verified.selected_portfolio_id) setPortfolio(verified.selected_portfolio_id);
    } catch (failure) { if (current(token, p, s)) { setData(null); setDetail(null); setError(safe(failure)); } }
    finally { if (generation.current === token) { busyRef.current = false; setBusy(false); } }
  }
  useEffect(() => {
    ++generation.current; setData(null); setDetail(null); setAck(false); busyRef.current = false; setBusy(false);
    if (ready) void load(); return () => { ++generation.current; };
    // Reads only: navigation never creates, enables, discovers, or retries work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolio, slotId, ready, initialSessionBinding]);
  useEffect(() => {
    if (binding !== initialSessionBinding) {
      live.current.ready = false; ++generation.current; setData(null); setDetail(null); setPending(null); setDraft(emptyPriceScheduleDraft()); setAck(false); setReceipt(null); setError("");
      setPortfolio(null); setSlotId(null); setInvalid(false); setBinding(initialSessionBinding);
    }
  }, [binding, initialSessionBinding]);
  useEffect(() => {
    if (boundary?.sessionBinding !== initialSessionBinding) { ++generation.current; setData(null); setDetail(null); setPending(null); setDraft(emptyPriceScheduleDraft()); setAck(false); setReceipt(null); setError(""); }
  }, [boundary?.sessionBinding, initialSessionBinding]);
  useEffect(() => {
    const hide = () => { ++generation.current; live.current.readOnly = true; setData(null); setDetail(null); setAck(false); setReceipt(null); setError(""); busyRef.current = false; setBusy(false); };
    const visibility = () => { if (document.visibilityState === "hidden") hide(); };
    const invalidate = () => { live.current.ready = false; hide(); setInvalid(true); setPending(null); setDraft(emptyPriceScheduleDraft()); };
    const atRisk = () => live.current.ready && (!!pendingRef.current || busyRef.current);
    const beforeUnload = (event: BeforeUnloadEvent) => { if (atRisk()) { event.preventDefault(); event.returnValue = ""; } };
    const navigate = (event: MouseEvent) => {
      if (!atRisk() || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !(event.target instanceof Element)) return;
      const a = event.target.closest("a[href]"); if (!(a instanceof HTMLAnchorElement) || a.hasAttribute("download") || (a.target && a.target !== "_self")) return;
      const url = new URL(a.href, window.location.href); if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;
      if (!window.confirm("未决原请求仅保存在本页内存；离开可能丢失原字节与幂等键，不会撤销已执行操作。确认离开？")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("blur", hide); window.addEventListener("pagehide", hide); document.addEventListener("visibilitychange", visibility); window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate); window.addEventListener("beforeunload", beforeUnload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("blur", hide); window.removeEventListener("pagehide", hide); document.removeEventListener("visibilitychange", visibility); window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", navigate, true); };
  }, []);
  const chooseScope = (p: string | null, s: string | null = null) => {
    if (busyRef.current || p === live.current.portfolio && s === live.current.slotId) return;
    if (pendingRef.current && !window.confirm("切换将清除本页原请求与幂等键，但不会撤销已执行操作。已核对服务端并确认继续？")) return;
    ++generation.current; live.current = { ...live.current, portfolio: p, slotId: s, readOnly: true };
    setData(null); setDetail(null); setDraft(emptyPriceScheduleDraft()); setAck(false); setPending(null); setReceipt(null); setError(""); setPortfolio(p); setSlotId(s);
  };
  const edit = (patch: Partial<PriceScheduleDraft>) => { setDraft(value => ({ ...value, ...patch })); setAck(false); setReceipt(null); };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!ready || !ack || !data || data.read_only || live.current.readOnly || busyRef.current || !portfolio || slotId) return;
    const p = portfolio, s = slotId, token = ++generation.current; busyRef.current = true; setBusy(true); setAck(false); setError(""); let sent = false;
    try {
      await probe(token, p, s); if (!current(token, p, s) || live.current.readOnly) return;
      const attempt = pendingRef.current ?? await preparePriceScheduleAttempt(data, draft, initialSessionBinding, crypto.randomUUID());
      if (!current(token, p, s) || live.current.readOnly) return;
      if (attempt.portfolio !== p || attempt.binding !== initialSessionBinding) throw new Error("SESSION_CHANGED");
      setPending(attempt); sent = true;
      const response = await fetch("/api/workbench/price-schedules", { method: "POST", credentials: "same-origin", redirect: "error", headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": initialSessionBinding }, body: attempt.body }); check401(response, token, p, s);
      const value = await readJson(response); checkBinding(value, token, p, s); if (!response.ok) throw apiError(value);
      const verified = assertPriceScheduleReceipt(value, attempt); if (!current(token, p, s)) return; await probe(token, p, s); if (!current(token, p, s)) return;
      setReceipt(JSON.stringify(verified, null, 2)); setPending(null); setDraft(emptyPriceScheduleDraft()); await load();
    } catch (failure) { if (current(token, p, s)) setError(safe(failure) + (sent ? "；原请求保留，未自动重发。" : "")); }
    finally { if (generation.current === token) { busyRef.current = false; setBusy(false); } }
  }
  if (!ready) return <main className="p-6"><h1 className="text-xl font-semibold">每日价格采集计划</h1><p>会话待核对；未显示组合、授权计划或私有历史。</p></main>;
  const locked = busy || !!pending || data?.read_only !== false || !portfolio;
  const selectedSchedule = data?.schedules.find(row => row.id === draft.scheduleId);
  const candidates = data?.reference_candidates.filter(row => row.market === draft.market) ?? [];
  return <main className="mx-auto max-w-5xl space-y-5 p-4 md:p-6" aria-busy={busy}>
    <header className={panel}><h1 className="text-2xl font-semibold">每日价格采集计划</h1><p>固定 LongPort daily、publish=true；由独立配置并启用的 provider Worker 采集。人审映射/日历不是 provider 认证、账户可买权限、策略准入或交易授权。</p>
      <p>价格日期 D 与触发时间不同：在市场时区的下一日 D+1 触发。实际接收时间如实记录，不回填为收盘或触发时间。保存永远暂停，读取/刷新不创建、不启用、不重试任务。</p>
      <p>只授权明确的有限日期范围。DST 不存在/重复本地时刻、相邻截止窗口重叠或引用覆盖不足由服务端拒绝；错过窗口只留记录，不补抓历史。</p>
      <Link href="/workbench/market" target="_blank" rel="noopener noreferrer" className="text-sm underline">在新页核对市场资料与人工引用</Link><p className="text-xs">未决原请求只保存在本页内存；导航、强制刷新或关闭会丢失，不会撤销已提交操作。</p></header>
    <section className={panel}><label>组合<select aria-label="价格采集组合" className={field} value={portfolio ?? ""} disabled={!data || busy} onChange={event => chooseScope(event.target.value)}>{data?.portfolios.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <button type="button" className={button} disabled={busy} onClick={() => void load()}>刷新会话、计划与历史</button>{busy && <p role="status">正在核对会话与采集证据。</p>}{error && <p role="alert">{error}</p>}
      {!data && <p>资料未复核，写入锁定。</p>}{data?.read_only && <p>恢复/只读模式：计划和历史可读，不能保存或启停。</p>}{data?.portfolios_truncated && <p>组合清单已截断；未显示不代表不存在。</p>}</section>
    {data && <>{!portfolio && <p>请先通过工作台创建组合；此页不自动创建组合。</p>}
      {!slotId && <form className={panel} onSubmit={submit}><h2 className="font-semibold">保存暂停版本 / 单独启停</h2><fieldset disabled={locked} className="space-y-3">
        <label>计划<select aria-label="价格采集计划" className={field} value={draft.scheduleId} onChange={event => { if (event.target.value === draft.scheduleId) return; const row = data.schedules.find(item => item.id === event.target.value); setDraft(row ? draftFromDefinition(row.id, row.current_version.definition) : emptyPriceScheduleDraft()); setAck(false); setReceipt(null); }}><option value="">新建（保存后暂停）</option>{data.schedules.map(row => <option key={row.id} value={row.id}>{row.scope_key} · v{row.current_version.version} / CAS {row.schedule_revision} · {row.status}</option>)}</select></label>
        <label>操作<select aria-label="价格采集操作" className={field} value={draft.operation} onChange={event => edit({ operation: event.target.value as PriceScheduleDraft["operation"] })}><option value="save">保存新版本并暂停</option><option value="enabled" disabled={!draft.scheduleId}>显式启用未来有限日期</option><option value="paused" disabled={!draft.scheduleId}>暂停未来与在途发布</option></select></label>
        {draft.operation === "save" && <><label>市场<select aria-label="采集市场" className={field} value={draft.market} onChange={event => edit({ market: event.target.value as PriceScheduleDraft["market"], mappingIds: [], calendarIds: [] })}><option value="">请明确选择</option><option value="CN">CN</option><option value="HK">HK</option><option value="US">US</option></select></label><p>匹配时区：{draft.market ? PRICE_MARKET_ZONES[draft.market] : "未选择"}</p>
          {(["mapping", "calendar"] as const).map(kind => <fieldset key={kind} className="min-w-0 space-y-2 rounded border p-3"><legend>{kind === "mapping" ? "显式选择完整挂牌映射（1–4 个）" : "显式选择覆盖全部交易所的日历"}</legend>
            {candidates.filter(row => row.kind === kind).map(row => { const selected = kind === "mapping" ? draft.mappingIds : draft.calendarIds; return <label key={row.id} className="flex min-w-0 gap-2"><input type="checkbox" aria-label={`引用 ${row.id}`} checked={selected.includes(row.id)} onChange={event => edit({ [kind === "mapping" ? "mappingIds" : "calendarIds"]: event.target.checked ? [...selected, row.id] : selected.filter(value => value !== row.id) })} /><span className="min-w-0">{row.provider_symbol ?? row.exchange} · {row.listing_id ?? "日历"} · v{row.version} · {row.id}<br />覆盖 {row.range_start} 至 {row.range_end ?? "无显式终日"}（{kind === "mapping" ? "映射终日不含" : "日历终日含"}）· SHA256 {row.content_hash}<br />human_reviewed_not_provider_verified</span></label>; })}
            {!candidates.some(row => row.kind === kind) && <p>没有当前已核引用；请先人工审核，不自动使用最新未核版本。</p>}
            {(kind === "mapping" ? draft.mappingIds : draft.calendarIds).filter(value => !candidates.some(row => row.id === value && row.kind === kind)).map(value => <p key={value}>已选择引用不再是当前候选：{value} <button type="button" className={button} onClick={() => edit({ [kind === "mapping" ? "mappingIds" : "calendarIds"]: (kind === "mapping" ? draft.mappingIds : draft.calendarIds).filter(id => id !== value) })}>移除此失效引用</button></p>)}</fieldset>)}
          {data.reference_candidates_truncated && <p>已核引用候选已截断；未显示不是未存在，不能据此省略所需日历。</p>}
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">{([
            ["startDate", "目标价格起日 D（含）", "date", undefined, undefined], ["endDate", "目标价格止日 D（含，必填）", "date", undefined, undefined],
            ["hour", "D+1 本地触发小时", "number", 0, 23], ["minute", "D+1 本地触发分钟", "number", 0, 59], ["deadline", "截止窗口秒数", "number", 60, 86400], ["maxAttempts", "最大尝试次数", "number", 1, 5],
          ] as const).map(([key, label, type, min, max]) => <label key={key}>{label}<input aria-label={label} className={field} type={type} min={min} max={max} step={type === "number" ? 1 : undefined} value={draft[key]} onChange={event => edit({ [key]: event.target.value })} required /></label>)}</div>
        </>}
        {selectedSchedule && <div><p>当前 {selectedSchedule.status} · v{selectedSchedule.current_version.version} / CAS {selectedSchedule.schedule_revision} · 引用 {selectedSchedule.reference_status}</p><p>已保存目标日期 {selectedSchedule.current_version.definition.start_date} 至 {selectedSchedule.current_version.definition.end_date}；D+1 {selectedSchedule.current_version.definition.trigger_local.hour}:{String(selectedSchedule.current_version.definition.trigger_local.minute).padStart(2, "0")} {selectedSchedule.current_version.definition.timezone}</p></div>}
        <label>操作理由<textarea aria-label="价格采集理由" className={field} value={draft.reason} maxLength={2000} onChange={event => edit({ reason: event.target.value })} required /></label>
      </fieldset><p>保存或暂停会结束旧授权，阻止旧排队/在途任务继续发布，不撤销已有发布。引用新版本不会自动替换或重新启用。保存回执、排队、闭市跳过均不是价格采集成功。</p>
      {pending && <div><p>未决请求可能已完成；请先刷新核对。人工重试仅发送原始字节、CAS、引用与幂等键。</p><details><summary>冻结原请求</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{pending.body}</pre></details><button type="button" className={button} disabled={busy} onClick={() => { if (window.confirm("已核对服务端并确认放弃本页原请求？不会撤销已执行操作。")) { setPending(null); setDraft(emptyPriceScheduleDraft()); setAck(false); } }}>放弃本页重试信息</button></div>}
      <label className="flex gap-2"><input type="checkbox" aria-label="确认价格采集授权" checked={ack} disabled={busy || data.read_only || !portfolio} onChange={event => setAck(event.target.checked)} />我已核对组合、完整挂牌/日历引用、有限目标日期、D+1 本地触发、DST、截止与 CAS，并明确同意本次操作。</label>
      <button className={button} disabled={!ack || busy || data.read_only || !portfolio}>{pending ? "人工重试完全相同命令" : "确认提交价格采集计划"}</button></form>}
      {receipt && <section className={panel}><h2>已核验命令回执（不是采集成功）</h2><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{receipt}</pre></section>}
      {!slotId && <section className={panel}><h2 className="font-semibold">计划版本与下一次触发</h2>{data.schedules.length === 0 && <p>尚无计划；不会自动创建或启用。</p>}{data.schedules.map(row => <article className={panel} key={row.id}><p>{row.scope_key} · {row.status} · v{row.current_version.version} / CAS {row.schedule_revision}</p><p>下一目标价格日期 D：{row.next_target_date ?? "无未来授权触发"}</p><p>下一触发 UTC：{row.next_trigger_at ?? "无未来授权触发"}</p><p>引用状态 {row.reference_status} · 版本 SHA256 {row.current_version.content_hash}</p><p>当前版本 {row.current_version.id} · audit {row.last_audit_id}</p><details><summary>已保存有限定义与引用绑定</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{row.current_version.definition_json}{"\n"}{row.current_version.reference_binding_json}</pre></details></article>)}{data.schedules_truncated && <p>仅显示最近 20 个计划；未显示不代表不存在。</p>}</section>}
      <section className={panel}><h2 className="font-semibold">不可变槽位与实际历史</h2><p>skipped / blocked / missed 保留原原因，不以新请求补写成功。requested 只代表已请求；只有核验后的 capture/publication 才显示已发布。</p>
        {slotId && <button type="button" className={button} disabled={busy} onClick={() => chooseScope(portfolio)}>返回本组合槽位列表</button>}
        {detail ? <article className={panel}><h3>槽位 {detail.slot.id}</h3><SlotEvidence slot={detail.slot} /><h4>原授权定义 v{detail.version.version}</h4><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{detail.version.definition_json}</pre><h4>尝试历史</h4>{detail.attempts.length === 0 && <p>没有尝试；不等于成功。</p>}{detail.attempts.map(row => <p key={row.attempt}>attempt {row.attempt} · {row.status} · {row.started_at} 至 {row.finished_at ?? "未结束"} · {row.error_code ?? "无错误码"}</p>)}</article>
          : <>{data.slots.length === 0 && <p>暂无槽位；读取不会触发发现。</p>}{data.slots.map(row => <article className={panel} key={row.id}><h3>槽位 {row.id}</h3><SlotEvidence slot={row} /><button type="button" className={button} disabled={busy} onClick={() => chooseScope(portfolio, row.id)}>读取槽位 {row.id}</button></article>)}{data.next_cursor && <button type="button" className={button} disabled={busy} onClick={() => void load(data.next_cursor!)}>读取更早槽位</button>}</>}
      </section></>}
  </main>;
}
