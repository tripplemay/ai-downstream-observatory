"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import { parseStrictJson } from "@/server/strict-json";
import type { CollectionScheduleState } from "@/server/market-schedules/types";
import { assertCollectionReceipt, assertCollectionState, emptyCollectionDraft, prepareCollectionAttempt, type CollectionDraft, type CollectionPending } from "./collection-schedule-client";

const panel = "min-w-0 space-y-3 rounded-xl border bg-card p-4", field = "w-full rounded border bg-background px-3 py-2 text-sm", button = "rounded border px-3 py-2 text-sm disabled:opacity-40";
const safe = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.message) ? error.message : "COLLECTION_REQUEST_FAILED";
async function readJson(response: Response) {
  const reader = response.body?.getReader(); if (!reader) throw new Error("COLLECTION_RESPONSE_INVALID");
  let length = 0, text = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 4 * 1048576) { await reader.cancel(); throw new Error(); } text += decoder.decode(value, { stream: true }); } return parseStrictJson(text + decoder.decode()); }
  catch { throw new Error("COLLECTION_RESPONSE_INVALID"); } finally { reader.releaseLock(); }
}
function apiError(value: unknown) { return new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(value.error) ? value.error : "COLLECTION_REQUEST_FAILED"); }
export function CollectionScheduleWorkspace({ initialSessionBinding }: { initialSessionBinding: string }) {
  const boundary = useSessionBoundary(), [invalid, setInvalid] = useState(false), [binding, setBinding] = useState(initialSessionBinding);
  const ready = !invalid && binding === initialSessionBinding && boundary?.verified === true && boundary.sessionBinding === initialSessionBinding;
  const [selected, setSelected] = useState<string | null>(null), [data, setData] = useState<CollectionScheduleState | null>(null), [draft, setDraft] = useState(emptyCollectionDraft), [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [receipt, setReceipt] = useState<string | null>(null);
  const [pending, updatePending] = useState<CollectionPending | null>(null), pendingRef = useRef<CollectionPending | null>(null), busyRef = useRef(false), generation = useRef(0);
  const live = useRef({ ready, selected, readOnly: true }); live.current = { ready, selected, readOnly: data?.read_only !== false };
  const setPending = (value: CollectionPending | null) => { pendingRef.current = value; updatePending(value); };
  const current = (token: number, portfolio: string | null) => generation.current === token && live.current.ready && live.current.selected === portfolio && document.visibilityState !== "hidden";
  const check401 = (response: Response, token: number, portfolio: string | null) => { if (response.status === 401) { if (current(token, portfolio)) window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); throw new Error("SESSION_CHANGED"); } };
  async function probe(token: number, portfolio: string | null) {
    try {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store", redirect: "error" }); check401(response, token, portfolio);
      if (!response.ok) throw new Error("SESSION_UNAVAILABLE");
      const value = await readJson(response) as { authenticated?: unknown; session_binding?: unknown };
      if (value?.authenticated !== true || typeof value.session_binding !== "string" || !/^[a-f0-9]{64}$/.test(value.session_binding)) throw new Error("SESSION_UNAVAILABLE");
      if (value.session_binding !== initialSessionBinding) { if (current(token, portfolio)) window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); throw new Error("SESSION_CHANGED"); }
    } catch (failure) { if (current(token, portfolio)) setData(null); throw failure; }
  }
  async function load(cursor?: string) {
    if (!live.current.ready || document.visibilityState === "hidden") return;
    const portfolio = live.current.selected, token = ++generation.current; busyRef.current = true; setBusy(true); setData(null); setAck(false); setError("");
    try {
      await probe(token, portfolio); if (!current(token, portfolio)) return;
      const query = new URLSearchParams({ view: "collection_schedules" }); if (portfolio) query.set("portfolio", portfolio); if (cursor) query.set("cursor", cursor);
      const response = await fetch(`/api/workbench/market?${query}`, { credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "X-Workbench-Session-Binding": initialSessionBinding } }); check401(response, token, portfolio);
      const value = await readJson(response); if (!response.ok) throw apiError(value); assertCollectionState(value, portfolio, initialSessionBinding);
      await probe(token, portfolio); if (!current(token, portfolio)) return;
      setData(value); if (portfolio !== value.selected_portfolio_id) setSelected(value.selected_portfolio_id);
    } catch (failure) { if (current(token, portfolio)) { setData(null); setError(safe(failure)); } }
    finally { if (generation.current === token) { busyRef.current = false; setBusy(false); } }
  }
  useEffect(() => { ++generation.current; setData(null); setAck(false); busyRef.current = false; setBusy(false); if (ready) void load(); return () => { ++generation.current; };
    // Scope/session changes may only perform reads, never replay a mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, ready, initialSessionBinding]);
  useEffect(() => { if (binding !== initialSessionBinding) { live.current.ready = false; ++generation.current; setPending(null); setDraft(emptyCollectionDraft()); setReceipt(null); setError(""); setData(null); setSelected(null); setInvalid(false); setBinding(initialSessionBinding); } }, [binding, initialSessionBinding]);
  useEffect(() => {
    const hide = () => { ++generation.current; setData(null); setAck(false); setReceipt(null); setError(""); busyRef.current = false; setBusy(false); };
    const visibility = () => { if (document.visibilityState === "hidden") hide(); };
    const invalidate = () => { live.current.ready = false; hide(); setInvalid(true); setPending(null); setDraft(emptyCollectionDraft()); };
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
  const edit = (patch: Partial<CollectionDraft>) => { setDraft(value => ({ ...value, ...patch })); setAck(false); setReceipt(null); };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!ack || !data || data.read_only || !ready || busyRef.current) return;
    const token = ++generation.current, portfolio = selected; busyRef.current = true; setBusy(true); setAck(false); setError(""); let sent = false;
    try {
      await probe(token, portfolio); if (!current(token, portfolio) || live.current.readOnly) return;
      const attempt = pendingRef.current ?? await prepareCollectionAttempt(data, draft, initialSessionBinding, crypto.randomUUID());
      if (!current(token, portfolio) || live.current.readOnly) return;
      if (attempt.portfolio !== portfolio || attempt.binding !== initialSessionBinding) throw new Error("SESSION_CHANGED");
      setPending(attempt); sent = true;
      const response = await fetch("/api/workbench/market", { method: "POST", credentials: "same-origin", redirect: "error", headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": initialSessionBinding }, body: attempt.body }); check401(response, token, portfolio);
      const value = await readJson(response); if (!response.ok) throw apiError(value); assertCollectionReceipt(value, attempt);
      await probe(token, portfolio); if (!current(token, portfolio)) return;
      setReceipt(JSON.stringify(value, null, 2)); setPending(null); setDraft(emptyCollectionDraft()); await load();
    } catch (failure) { if (current(token, portfolio)) { setError(safe(failure) + (sent ? "；保留原请求，未自动重发。" : "")); if (!sent) setData(null); } }
    finally { if (generation.current === token) { busyRef.current = false; setBusy(false); } }
  }
  if (!ready) return <main className="p-6"><h1 className="text-xl font-semibold">ECB 周期参考汇率采集</h1><p>会话待核对；未显示组合或调度。</p></main>;
  return <main className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
    <header className={panel}><h1 className="text-2xl font-semibold">ECB 周期参考汇率采集</h1><p className="text-sm">仅显式授权固定 ECB daily 参考汇率采集与发布；不是执行换汇价、交易、策略准入或投资批准。源汇率日期不等于采集时间，采集成功不代表今日有新汇率。</p><Link href="/workbench/market" target="_blank" rel="noopener noreferrer" className="text-sm underline">在新页核对市场资料</Link><p className="text-xs">未决请求仅在当前页内存，强制刷新或关闭可能丢失；不会自动重发。</p></header>
    <section className={panel}><label>组合<select aria-label="采集调度组合" className={field} value={selected ?? ""} disabled={!data || busy || !!pending} onChange={e => { setSelected(e.target.value); setDraft(emptyCollectionDraft()); setReceipt(null); setAck(false); }}>{data?.portfolios.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button type="button" className={button} disabled={busy} onClick={() => void load()}>重新核对会话与调度</button>{error && <p role="alert" className="break-all">{error}</p>}{!data && <p>资料未复核，写入锁定；原未决请求仍保留。</p>}{data?.read_only && <p>恢复/只读模式：可读，不可保存或启停。</p>}</section>
    {data && <>
      {data.portfolios_truncated && <p>仅显示前 1000 个组合；目录不是完整账户或授权清单。</p>}
      {data.schedules.some(s => s.schedule_revision >= 1000) && <p role="status">有调度接近或到达控制链维护边界。CAS 1023 之后仅可执行保留的最后一次暂停；请核对具体调度，勿以新身份自动绕过。</p>}
      <form className={panel} onSubmit={submit}><h2 className="font-semibold">保存版本 / 显式启停</h2><fieldset disabled={busy || !!pending || data.read_only || !selected} className="space-y-3"><label>调度<select aria-label="目标采集调度" className={field} value={draft.scheduleId} onChange={e => { const item = data.schedules.find(s => s.id === e.target.value); edit({ scheduleId: e.target.value, operation: "save", definitionJson: item?.current_version.definition_json ?? "", reason: "" }); }}><option value="">新建（保存后暂停）</option>{data.schedules.map(s => <option key={s.id} value={s.id}>{s.scope_key} · v{s.current_version.version} / CAS{s.schedule_revision} · {s.status}</option>)}</select></label><label>操作<select aria-label="采集调度操作" className={field} value={draft.operation} onChange={e => edit({ operation: e.target.value as CollectionDraft["operation"] })}><option value="save">保存新版本，状态必为暂停</option><option value="enabled" disabled={!draft.scheduleId}>显式启用未来周期</option><option value="paused" disabled={!draft.scheduleId}>暂停未来与未提交周期发布</option></select></label>{draft.operation === "save" && <><p className="text-xs">完整 collection-schedule-v1 JSON：固定 provider=ecb / feed=daily / frequency=daily / timezone=UTC / publish=true / missed_policy=record_no_backfill；显式 currencies、start_date、end_date、trigger.hour/minute、deadline_seconds(60–86400)、max_attempts(1–5)。没有默认证券、币种或触发时间；币种集合改变必须另建调度。</p><textarea aria-label="采集调度定义" className={`${field} min-h-48 font-mono`} value={draft.definitionJson} onChange={e => edit({ definitionJson: e.target.value })} /></>}<label>操作理由<input aria-label="采集调度理由" className={field} value={draft.reason} onChange={e => edit({ reason: e.target.value })} /></label></fieldset>
        <p className="text-xs">启用不追认已经错过的触发；错过周期只留记录，不补抓历史 daily。同状态操作也追加新控制版本并结束上一授权区间；仅同一原请求重传不追加。暂停/保存新版本使旧排队及在途发布失去授权，不撤回已经发布的数据。控制链最多 1024 次；保存/启用只可用至 CAS 1023，最后一次仅保留给已启用调度暂停，耗尽后需人工维护，不能自动换身份绕过。</p>
        {pending && <div className="space-y-2 text-sm"><p>未决命令可能已完成。先刷新核对版本/状态；人工重试仍使用原始字节、CAS 和幂等键。</p><details><summary>冻结原请求</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{pending.body}</pre></details><button type="button" className={button} disabled={busy} onClick={() => { if (window.confirm("已核对服务端结果并确认放弃本页重试？不会撤销既有操作。")) { setPending(null); setAck(false); setDraft(emptyCollectionDraft()); } }}>显式放弃本页重试</button></div>}
        <label className="flex gap-2"><input type="checkbox" checked={ack} disabled={busy || data.read_only || !selected} onChange={e => setAck(e.target.checked)} />我已核对组合、币种集合、完整定义、状态、CAS 和理由，明确同意本次采集操作。</label><button className={button} disabled={!ack || busy || data.read_only || !selected}>{pending ? "人工重试完全相同命令" : "确认提交采集调度命令"}</button>
      </form>
      <section className={panel}><h2 className="font-semibold">当前调度与历史槽位</h2>{data.schedules.length === 0 && <p>尚无采集调度；不会自动创建或启用。</p>}{data.schedules.map(s => <div key={s.id} className="rounded border p-2 text-xs"><p>{s.scope_key} · {s.status} · v{s.current_version.version} / CAS{s.schedule_revision}</p><p>下一未来触发（UTC）：{s.next_trigger_at ?? "未启用 / 无未来触发"}</p><p className="break-all">schedule {s.id} · definition SHA256 {s.current_version.content_hash} · audit {s.last_audit_id}</p></div>)}{data.schedules_truncated && <p>仅显示最近 20 个调度；未显示不代表不存在。</p>}{data.slots.map(s => <article key={s.id} className="rounded border p-2 text-xs"><p>{s.period} · {s.scope_key} · {s.disposition === "missed" ? `未补跑：${s.reason_code}` : `已请求：${s.job?.status ?? "待调度 Worker 领取"}`}</p><p>计划 {s.scheduled_at} · 截止 {s.deadline_at}</p><p>源汇率日期：{s.capture?.rate_date ?? "暂无已验真发布"} · 采集完成：{s.capture?.received_at ?? "暂无"}（两者不是同一时间含义）</p>{s.capture?.rate_date && s.capture.rate_date !== s.period && <p>源汇率日期不同于该周期日期；不能视为本周期新汇率。</p>}<p className="break-all">授权 audit {s.authorization_audit_id} / CAS{s.authorization_revision} · command {s.command_request_id ?? "无"}</p><a className="underline" target="_blank" rel="noopener noreferrer" href={`/api/workbench/market?view=collection_slot&portfolio=${encodeURIComponent(s.portfolio_id)}&id=${encodeURIComponent(s.id)}`}>新页查看只读槽位证据</a></article>)}{data.next_cursor && <button type="button" className={button} disabled={busy} onClick={() => void load(data.next_cursor!)}>读取更早槽位</button>}</section>
      {receipt && <section className={panel}><h2>已核验服务器回执（不是采集成功证明）</h2><pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all text-xs">{receipt}</pre></section>}
    </>}
  </main>;
}
