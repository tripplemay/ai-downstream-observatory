"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import type { MarketReferenceState } from "@/server/market-references/queries";
import { assertMarketReceipt, assertMarketState, emptyMarketDraft, prepareMarketAttempt, type MarketDraft, type MarketPending } from "./market-reference-client";

const panel = "min-w-0 space-y-3 rounded-xl border bg-card p-4", control = "w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm", button = "rounded-md border px-3 py-2 text-sm disabled:opacity-40";
async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("MARKET_RESPONSE_INVALID");
  const decoder = new TextDecoder("utf-8", { fatal: true }); let raw = "", length = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > 4 * 1048576) { await reader.cancel(); throw new Error("MARKET_RESPONSE_TOO_LARGE"); } raw += decoder.decode(value, { stream: true }); }
    return JSON.parse(raw + decoder.decode());
  } catch { throw new Error(length > 4 * 1048576 ? "MARKET_RESPONSE_TOO_LARGE" : "MARKET_RESPONSE_INVALID"); }
  finally { reader.releaseLock(); }
}
function responseError(value: unknown) {
  const error = value && typeof value === "object" && "error" in value ? value.error : null;
  return new Error(typeof error === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(error) ? error : "MARKET_REQUEST_FAILED");
}
function safeError(failure: unknown, fallback: string) {
  return failure instanceof Error && /^[A-Z][A-Z0-9_]{0,100}$/.test(failure.message) ? failure.message : fallback;
}
export function MarketReferenceWorkspace({ initial, initialSessionBinding }: { initial: MarketReferenceState; initialSessionBinding: string }) {
  const boundary = useSessionBoundary(), [invalid, setInvalid] = useState(false), [stateBinding, setStateBinding] = useState(initialSessionBinding);
  const ready = stateBinding === initialSessionBinding && boundary?.verified === true && boundary.sessionBinding === initialSessionBinding && !invalid;
  const [selected, setSelected] = useState(initial.selected_portfolio_id), [data, setData] = useState<MarketReferenceState | null>(null), [draft, setDraft] = useState(emptyMarketDraft);
  const [pending, updatePending] = useState<MarketPending | null>(null), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [receipt, setReceipt] = useState<string | null>(null);
  const pendingRef = useRef<MarketPending | null>(null);
  const setPending = (value: MarketPending | null) => { pendingRef.current = value; updatePending(value); };
  const generation = useRef(0), busyRef = useRef(false), live = useRef({ ready, selected, readOnly: true }); live.current = { ready, selected, readOnly: data?.read_only !== false };
  const current = (token: number, scope: string | null) => generation.current === token && live.current.ready && live.current.selected === scope && document.visibilityState !== "hidden";
  const check401 = (response: Response, token: number, scope: string | null) => { if (response.status === 401) { if (current(token, scope)) window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); throw new Error("SESSION_CHANGED"); } };
  async function probe(token: number, scope: string | null) {
    try {
    const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store", redirect: "error" }); check401(response, token, scope);
    if (!response.ok) throw new Error("SESSION_UNAVAILABLE");
    const value = await readJson(response) as { authenticated?: unknown; session_binding?: unknown };
    if (value?.authenticated !== true || typeof value.session_binding !== "string" || !/^[a-f0-9]{64}$/.test(value.session_binding)) throw new Error("SESSION_UNAVAILABLE");
    if (value.session_binding !== initialSessionBinding) { if (current(token, scope)) window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); throw new Error("SESSION_CHANGED"); }
    } catch (failure) { if (current(token, scope)) setData(null); throw failure; }
  }
  async function load() {
    if (!live.current.ready || document.visibilityState === "hidden") return;
    const token = ++generation.current, scope = live.current.selected; busyRef.current = true; setBusy(true); setConfirmed(false); setData(null); setError("");
    try {
      await probe(token, scope); if (!current(token, scope)) return;
      const response = await fetch(`/api/workbench/market${scope ? `?portfolio=${encodeURIComponent(scope)}` : ""}`, { credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "X-Workbench-Session-Binding": initialSessionBinding } }); check401(response, token, scope);
      const value = await readJson(response); if (!response.ok) throw responseError(value); assertMarketState(value, scope, initialSessionBinding);
      await probe(token, scope); if (!current(token, scope)) return; setData(value); if (scope !== value.selected_portfolio_id) setSelected(value.selected_portfolio_id);
    } catch (failure) { if (current(token, scope)) { setData(null); setError(safeError(failure, "MARKET_READ_FAILED")); } }
    finally { if (generation.current === token) { busyRef.current = false; setBusy(false); } }
  }
  useEffect(() => { ++generation.current; setData(null); setConfirmed(false); busyRef.current = false; setBusy(false); if (ready) void load(); return () => { ++generation.current; };
    // Scope/session changes can only trigger a read, never a mutation retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, ready, initialSessionBinding]);
  useEffect(() => {
    if (stateBinding !== initialSessionBinding) { ++generation.current; setData(null); setPending(null); setDraft(emptyMarketDraft()); setReceipt(null); setConfirmed(false); setInvalid(false); setSelected(initial.selected_portfolio_id); setStateBinding(initialSessionBinding); }
  }, [initialSessionBinding, initial.selected_portfolio_id, stateBinding]);
  useEffect(() => {
    const hide = () => { ++generation.current; setData(null); setConfirmed(false); setReceipt(null); setError(""); busyRef.current = false; setBusy(false); };
    const visibility = () => { if (document.visibilityState === "hidden") hide(); };
    const invalidate = () => { live.current.ready = false; hide(); setInvalid(true); setDraft(emptyMarketDraft()); setPending(null); };
    window.addEventListener("blur", hide); window.addEventListener("pagehide", hide); window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate); document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("blur", hide); window.removeEventListener("pagehide", hide); window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  useEffect(() => {
    const atRisk = () => live.current.ready && (!!pendingRef.current || busyRef.current);
    const beforeUnload = (event: BeforeUnloadEvent) => { if (atRisk()) { event.preventDefault(); event.returnValue = ""; } };
    const navigate = (event: MouseEvent) => {
      if (!atRisk() || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
      const anchor = event.target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin === window.location.origin && destination.pathname === window.location.pathname && destination.search === window.location.search && destination.hash) return;
      if (!window.confirm("请求或未决重试只保存在本页内存；离开可能丢失原字节与幂等键，不会撤销已执行操作。确认离开？")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", beforeUnload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", navigate, true); };
  }, []);
  function edit(patch: Partial<MarketDraft>) { setDraft(value => ({ ...value, ...patch })); setConfirmed(false); setReceipt(null); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!confirmed || !data || data.read_only || !ready || busyRef.current) return;
    const scope = selected, token = ++generation.current; busyRef.current = true; setBusy(true); setConfirmed(false); setError(""); let sent = false;
    try {
      await probe(token, scope); if (!current(token, scope) || live.current.readOnly) return;
      const attempt = pending ?? await prepareMarketAttempt(data, draft, initialSessionBinding, crypto.randomUUID());
      if (!current(token, scope) || live.current.readOnly) return;
      if (attempt.portfolio !== scope || attempt.binding !== initialSessionBinding) throw new Error("SESSION_CHANGED");
      setPending(attempt); sent = true;
      const response = await fetch(attempt.endpoint, { method: "POST", credentials: "same-origin", redirect: "error", headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": initialSessionBinding }, body: attempt.body }); check401(response, token, scope);
      const value = await readJson(response); if (!response.ok) throw responseError(value); assertMarketReceipt(value, attempt);
      await probe(token, scope); if (!current(token, scope)) return;
      setReceipt(JSON.stringify(value, null, 2)); setPending(null); setDraft(emptyMarketDraft()); await load();
    } catch (failure) { if (current(token, scope)) { setError(`${safeError(failure, "MARKET_REQUEST_FAILED")}${sent ? "；原请求已保留，不自动重发。" : ""}`); if (!sent) setData(null); } }
    finally { if (generation.current === token) { busyRef.current = false; setBusy(false); } }
  }
  if (!ready) return <main className="p-6"><h1 className="text-xl font-semibold">市场资料与价格采集</h1><p className="mt-3 text-sm">会话待核对；未显示组合、原件或草稿。</p></main>;
  return <main className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
    <header className={panel}><h1 className="text-2xl font-semibold">市场资料与价格采集</h1><p className="text-sm text-muted-foreground">来源存储不是审核；人工映射和日历审核不是 provider 认证、账户可买权限或策略准入。SDK 投影不是网络原始响应，收市时间不是报价发布时间。不写交易或资金事实。</p><Link href="/workbench" target="_blank" rel="noopener noreferrer" className="text-sm underline">在新页核对工作台与任务结果</Link><p><Link href="/workbench/market/schedules" className="text-sm underline">ECB 周期参考汇率采集（人工保存与启停）</Link></p><p className="text-xs text-muted-foreground">未决请求仅保存在当前页内存，不是持久恢复记录；强制关闭、刷新或离开可能丢失原请求。</p></header>
    <section className={panel}><label>组合<select aria-label="市场资料组合" className={control} disabled={busy || !!pending || !data} value={selected ?? ""} onChange={event => { setDraft(emptyMarketDraft()); setReceipt(null); setConfirmed(false); setSelected(event.target.value); }}>{(data?.portfolios ?? []).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><button className={button} type="button" disabled={busy} onClick={() => void load()}>重新核对会话与资料</button>{data?.read_only && <p role="status">恢复/只读模式：允许查看和下载，不允许保存、审核或采集。</p>}{error && <p role="alert" className="break-all text-sm">{error}</p>}{!data && <p className="text-sm">资料未核对，写入已锁定；未决请求保留原字节，请人工刷新后再决定。</p>}</section>
    {data && <>
      <section className={panel}><h2 className="font-semibold">已登记目录标的</h2><p className="text-sm">映射必须逐项填写真实登记 ID；下列目录不证明交易权限。</p><div className="max-h-40 overflow-auto text-xs">{data.listings.map(row => <p key={row.id} className="break-all">{row.id} · {row.ticker} · {row.market}/{row.exchange}/{row.currency}</p>)}</div>{data.listings_truncated && <p>仅显示前 1000 条；不得把未显示项认定不存在。</p>}</section>
      <form className={panel} onSubmit={submit}><h2 className="font-semibold">显式资料命令</h2><fieldset disabled={busy || !!pending || data.read_only || !selected} className="space-y-3">
        <label>操作<select className={control} value={draft.action} onChange={event => { setDraft({ ...emptyMarketDraft(), action: event.target.value as MarketDraft["action"] }); setConfirmed(false); }}><option value="store_source">保存组合私有 JSON 来源（未审核）</option><option value="publish_reference">人工审核映射 / 日历新版本</option><option value="collect_prices">按明确版本请求价格采集</option></select></label>
        {draft.action === "store_source" && <label>来源说明 / 引用（不会抓取 URL）<input className={control} value={draft.reference} onChange={event => edit({ reference: event.target.value })} /></label>}
        {draft.action === "publish_reference" && <><label>来源原件<select className={control} value={draft.sourceId} onChange={event => edit({ sourceId: event.target.value })}><option value="">请显式选择</option>{data.sources.map(row => <option key={row.id} value={row.id}>{row.reference} · {row.id}</option>)}</select></label><label>该 kind / scope 当前版本（全新明确填 0）<input className={control} inputMode="numeric" value={draft.expectedVersion} onChange={event => edit({ expectedVersion: event.target.value })} /></label><label>逐项核实理由<input className={control} value={draft.reason} onChange={event => edit({ reason: event.target.value })} /></label><p className="text-xs">document 为 {"{kind:'mapping'|'calendar', facts:{...}}"}。有效期为 [valid_from, valid_to)；日历须覆盖范围内每个自然日并明确 full / half / closed，营业日 close_at 为 UTC 六位小数，同当地日期。无默认证券、日期或经济参数。</p></>}
        {draft.action === "collect_prices" && <p className="text-xs">填写 market-price-collect-v1：provider=longport，显式 mapping_version_ids / calendar_version_ids、start_date / end_date、expected_publication_revision、publish。单次同市场 1–4 个标的、最多 31 天，全部为已结束当地日期；需要专用价格 Worker 和独立凭据配置。publish=false 仅保存，不能通过旧 CLI 事后提权。</p>}
        <label>完整 JSON<textarea className={`${control} min-h-48 font-mono`} spellCheck={false} value={draft.raw} onChange={event => edit({ raw: event.target.value })} /></label>
      </fieldset>
      {pending && <div className="space-y-2 text-sm"><p>未决原请求已冻结；可能已执行。先核对版本 / 工作台任务，重试只重发同字节与幂等键。</p><details><summary>核对冻结请求</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{pending.body}</pre></details><button type="button" className={button} disabled={busy} onClick={() => { if (window.confirm("放弃本页重试记录不会撤销已执行操作；已核对服务端结果并确认放弃？")) { setPending(null); setConfirmed(false); setDraft(emptyMarketDraft()); } }}>显式放弃本页重试</button></div>}
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy || data.read_only || !selected} onChange={event => setConfirmed(event.target.checked)} />我已逐项核对当前组合、原件、版本、全部字段和操作影响；不是投资批准。</label><button className={button} disabled={busy || data.read_only || !confirmed || !selected}>{pending ? "人工重试完全相同请求" : "确认提交此命令"}</button></form>
      <section className={panel}><h2 className="font-semibold">原件与不可变版本</h2>{data.sources.map(row => <p key={row.id} className="break-all text-xs"><a className="underline" href={`/api/workbench/market?view=source&portfolio=${encodeURIComponent(selected!)}&id=${encodeURIComponent(row.id)}`}>{row.reference}</a> · {row.id} · SHA256 {row.content_hash} · {row.known_at}</p>)}{data.sources_truncated && <p>仅列最近 100 份原件；未显示不代表不存在。</p>}<div className="max-h-96 space-y-2 overflow-auto">{data.versions.map(row => <div key={row.id} className="rounded border p-2 text-xs"><p className="break-all">{row.kind} / {row.scope_key} · v{row.version} · {row.summary}</p><p className="break-all">version_id {row.id} · SHA256 {row.content_hash}</p><p className="break-all">{row.known_at} · audit {row.audit_id} · human_reviewed_not_provider_verified</p></div>)}</div>{data.versions_truncated && <p>仅列最近 100 个版本，历史仍保留。</p>}<details><summary>当前 CAS heads</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(data.heads, null, 2)}</pre></details></section>
      {receipt && <section className={panel}><h2>服务器回执（采集入队不代表已成功）</h2><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{receipt}</pre></section>}
    </>}
  </main>;
}
