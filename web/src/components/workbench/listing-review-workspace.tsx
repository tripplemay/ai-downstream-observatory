"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import { parseStrictJson } from "@/server/strict-json";
import type { ListingReviewState } from "@/server/listing-reviews/types";
import { assertListingReviewReceipt, assertListingReviewState, emptyListingReviewDraft, prepareListingReviewAttempt, type ListingReviewDraft, type ListingReviewPending } from "./listing-review-client";
const panel = "min-w-0 space-y-3 rounded-xl border bg-card p-4", field = "w-full rounded border bg-background px-3 py-2 text-sm", button = "rounded border px-3 py-2 text-sm disabled:opacity-40";
const safe = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.message) ? error.message : "LISTING_REVIEW_REQUEST_FAILED";
async function readJson(response: Response) {
  const reader = response.body?.getReader(); if (!reader) throw new Error("LISTING_REVIEW_RESPONSE_INVALID");
  let size = 0, raw = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4 * 1048576) { void reader.cancel().catch(() => {}); throw new Error(); } raw += decoder.decode(value, { stream: true }); } return parseStrictJson(raw + decoder.decode()); }
  catch { throw new Error("LISTING_REVIEW_RESPONSE_INVALID"); } finally { reader.releaseLock(); }
}
function apiError(value: unknown) { return new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(value.error) ? value.error : "LISTING_REVIEW_REQUEST_FAILED"); }
export function ListingReviewWorkspace({ initialSessionBinding }: { initialSessionBinding: string }) {
  const boundary = useSessionBoundary(), [invalid, setInvalid] = useState(false), [binding, setBinding] = useState(initialSessionBinding);
  const ready = !invalid && binding === initialSessionBinding && boundary?.verified === true && boundary.sessionBinding === initialSessionBinding;
  const [portfolio, setPortfolio] = useState<string | null>(null), [listing, setListing] = useState<string | null>(null), [listingInput, setListingInput] = useState("");
  const [data, setData] = useState<ListingReviewState | null>(null), [draft, setDraft] = useState(emptyListingReviewDraft), [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [receipt, setReceipt] = useState<string | null>(null);
  const [pending, updatePending] = useState<ListingReviewPending | null>(null), pendingRef = useRef<ListingReviewPending | null>(null), busyRef = useRef(false), generation = useRef(0);
  const live = useRef({ ready, portfolio, listing, readOnly: true }); live.current = { ready, portfolio, listing, readOnly: data?.read_only !== false };
  const setPending = (value: ListingReviewPending | null) => { pendingRef.current = value; updatePending(value); };
  const current = (token: number, p: string | null, l: string | null) => generation.current === token && live.current.ready && live.current.portfolio === p && live.current.listing === l && document.visibilityState !== "hidden";
  const check401 = (response: Response, token: number, p: string | null, l: string | null) => { if (response.status === 401) { if (current(token, p, l)) window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); throw new Error("SESSION_CHANGED"); } };
  const checkBinding = (value: unknown, token: number, p: string | null, l: string | null) => {
    if (value && typeof value === "object" && "session_binding" in value && typeof value.session_binding === "string" && /^[a-f0-9]{64}$/.test(value.session_binding) && value.session_binding !== initialSessionBinding) {
      if (current(token, p, l)) window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); throw new Error("SESSION_CHANGED");
    }
  };
  async function probe(token: number, p: string | null, l: string | null) {
    try {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store", redirect: "error" }); check401(response, token, p, l);
      if (!response.ok) throw new Error("SESSION_UNAVAILABLE"); const value = await readJson(response) as { authenticated?: unknown; session_binding?: unknown };
      if (value?.authenticated !== true || typeof value.session_binding !== "string" || !/^[a-f0-9]{64}$/.test(value.session_binding)) throw new Error("SESSION_UNAVAILABLE");
      if (value.session_binding !== initialSessionBinding) { if (current(token, p, l)) window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); throw new Error("SESSION_CHANGED"); }
    } catch (failure) { if (current(token, p, l)) { live.current.readOnly = true; setData(null); } throw failure; }
  }
  async function load(cursor?: string) {
    if (!live.current.ready || document.visibilityState === "hidden") return;
    const p = live.current.portfolio, l = live.current.listing, token = ++generation.current;
    busyRef.current = true; live.current.readOnly = true; setBusy(true); setData(null); setAck(false); setError("");
    try {
      await probe(token, p, l); if (!current(token, p, l)) return;
      const query = new URLSearchParams(); if (p) query.set("portfolio", p); if (l) query.set("listing", l); if (cursor) query.set("cursor", cursor);
      const response = await fetch(`/api/workbench/listing-reviews?${query}`, { credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "X-Workbench-Session-Binding": initialSessionBinding } }); check401(response, token, p, l);
      const value = await readJson(response); checkBinding(value, token, p, l); if (!response.ok) throw apiError(value); assertListingReviewState(value, p, l, initialSessionBinding);
      await probe(token, p, l); if (!current(token, p, l)) return;
      setData(value); if (p !== value.selected_portfolio_id) setPortfolio(value.selected_portfolio_id);
    } catch (failure) { if (current(token, p, l)) { setData(null); setError(safe(failure)); } }
    finally { if (generation.current === token) { busyRef.current = false; setBusy(false); } }
  }
  useEffect(() => { ++generation.current; setData(null); setAck(false); busyRef.current = false; setBusy(false); if (ready) void load(); return () => { ++generation.current; };
    // Scope changes perform reads only; pending mutations are never replayed automatically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolio, listing, ready, initialSessionBinding]);
  useEffect(() => { if (binding !== initialSessionBinding) { live.current.ready = false; ++generation.current; setPending(null); setDraft(emptyListingReviewDraft()); setReceipt(null); setData(null); setError(""); setPortfolio(null); setListing(null); setListingInput(""); setInvalid(false); setBinding(initialSessionBinding); } }, [binding, initialSessionBinding]);
  useEffect(() => {
    const hide = () => { ++generation.current; live.current.readOnly = true; setData(null); setAck(false); setReceipt(null); setError(""); busyRef.current = false; setBusy(false); };
    const visibility = () => { if (document.visibilityState === "hidden") hide(); };
    const invalidate = () => { live.current.ready = false; hide(); setInvalid(true); setPending(null); setDraft(emptyListingReviewDraft()); setListingInput(""); };
    const atRisk = () => live.current.ready && (!!pendingRef.current || busyRef.current);
    const beforeUnload = (event: BeforeUnloadEvent) => { if (atRisk()) { event.preventDefault(); event.returnValue = ""; } };
    const navigate = (event: MouseEvent) => {
      if (!atRisk() || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !(event.target instanceof Element)) return;
      const anchor = event.target.closest("a[href]"); if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
      const url = new URL(anchor.href, window.location.href); if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;
      if (!window.confirm("未决审核请求仅在本页内存；离开可能丢失原字节和幂等键，不会撤销已完成审核。确认离开？")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("blur", hide); window.addEventListener("pagehide", hide); document.addEventListener("visibilitychange", visibility); window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate); window.addEventListener("beforeunload", beforeUnload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("blur", hide); window.removeEventListener("pagehide", hide); document.removeEventListener("visibilitychange", visibility); window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", navigate, true); };
  }, []);
  const edit = (patch: Partial<ListingReviewDraft>) => { setDraft(value => ({ ...value, ...patch })); setAck(false); setReceipt(null); };
  const chooseListing = (id: string | null) => { if (busyRef.current || pendingRef.current) return; setListing(id); setListingInput(id ?? ""); setDraft(emptyListingReviewDraft()); setAck(false); setReceipt(null); };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!ack || !data || !data.selected || data.read_only || live.current.readOnly || !ready || busyRef.current) return;
    const p = portfolio, l = listing, token = ++generation.current; busyRef.current = true; setBusy(true); setAck(false); setError(""); let sent = false;
    try {
      await probe(token, p, l); if (!current(token, p, l) || live.current.readOnly) return;
      const attempt = pendingRef.current ?? prepareListingReviewAttempt(data, draft, initialSessionBinding, crypto.randomUUID());
      if (attempt.portfolio !== p || attempt.listing !== l || attempt.binding !== initialSessionBinding) throw new Error("SESSION_CHANGED");
      setPending(attempt); sent = true;
      const response = await fetch("/api/workbench/listing-reviews", { method: "POST", credentials: "same-origin", redirect: "error", headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": initialSessionBinding }, body: attempt.body }); check401(response, token, p, l);
      const value = await readJson(response); checkBinding(value, token, p, l); if (!response.ok) throw apiError(value); await assertListingReviewReceipt(value, attempt);
      if (!current(token, p, l)) return; await probe(token, p, l); if (!current(token, p, l)) return;
      setReceipt(JSON.stringify(value, null, 2)); setPending(null); setDraft(emptyListingReviewDraft()); await load();
    } catch (failure) { if (current(token, p, l)) setError(safe(failure) + (sent ? "；原请求保留，未自动重发。" : "")); }
    finally { if (generation.current === token) { busyRef.current = false; setBusy(false); } }
  }
  const enumField = (label: string, key: keyof ListingReviewDraft, options: string[]) => <label>{label}<select aria-label={label} className={field} value={draft[key]} onChange={event => edit({ [key]: event.target.value })}><option value="">请选择（无默认）</option>{options.map(option => <option key={option} value={option}>{option}</option>)}</select></label>;
  const textField = (label: string, key: keyof ListingReviewDraft) => <label>{label}<input aria-label={label} className={field} value={draft[key]} onChange={event => edit({ [key]: event.target.value })} /></label>;
  if (!ready) return <main className="p-6"><h1 className="text-xl font-semibold">证券身份与挂牌状态人审</h1><p>会话待核对；未显示组合、来源或审核资料。</p></main>;
  return <main className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
    <header className={panel}><h1 className="text-2xl font-semibold">证券身份与挂牌状态人审</h1><p className="text-sm">按原件人工核实组合私有版本，不改全局证券或历史账本。不是行情供应商认证、账户可买性、策略准入或投资批准。整只基金分类标签不是持仓穿透；杠杆、反向及未知结构仍阻断。</p><p className="text-sm">路径：先登记全局证券，再显式加入本组合目录，保存来源 JSON 原件后进行审核；不会自动创建目录成员或补全缺失事实。</p><div className="flex flex-wrap gap-4 text-sm underline"><Link href="/workbench" target="_blank" rel="noopener noreferrer">新页登记证券</Link><Link href="/workbench/catalog" target="_blank" rel="noopener noreferrer">新页核对组合目录</Link><Link href="/workbench/market" target="_blank" rel="noopener noreferrer">新页保存与下载市场来源</Link></div><p className="text-xs">未决请求仅在本页内存。强制刷新/关闭可能丢失原字节与幂等键；不会自动重发。</p></header>
    <section className={panel}><label>组合<select aria-label="身份审核组合" className={field} value={portfolio ?? ""} disabled={!data || busy || !!pending} onChange={event => { setPortfolio(event.target.value); chooseListing(null); }}>{data?.portfolios.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><button type="button" className={button} disabled={busy} onClick={() => void load()}>重新核对会话与身份审核</button>{error && <p role="alert" className="break-all">{error}</p>}{!data && <p>资料尚未复核；写入锁定，未决原请求仍保留。</p>}{data?.read_only && <p>恢复/只读模式：只能读取，不能审核发布。</p>}</section>
    {data && <><section className={panel}><h2 className="font-semibold">本组合已登记目录</h2>{data.rows.length === 0 && <p>此页没有目录成员；请先显式加入组合目录。</p>}{data.rows.map(row => <div className="rounded border p-2 text-sm" key={row.identity.listing_id}><p>{row.name} · {row.identity.market}/{row.identity.exchange}/{row.identity.ticker} · {row.identity.currency} · review CAS {row.review_revision}</p><p>{row.quality}：{row.issues.join(" / ") || "本次人审资料完整，不代表允许下单"}</p><button type="button" className={button} disabled={busy || !!pending} onClick={() => chooseListing(row.identity.listing_id)}>选择 {row.identity.ticker}</button></div>)}{data.next_cursor && <button type="button" className={button} disabled={busy} onClick={() => void load(data.next_cursor!)}>读取下一页目录</button>}<label>直接输入已加入目录的完整 listing ID<input aria-label="审核证券ID" className={field} value={listingInput} disabled={busy || !!pending} onChange={event => { setListingInput(event.target.value); setAck(false); }} /></label><button type="button" className={button} disabled={busy || !!pending || !listingInput} onClick={() => chooseListing(listingInput)}>读取指定证券</button>{data.portfolios_truncated && <p>组合选择仅列前 1000 项。</p>}</section>
      {data.selected && <><section className={panel}><h2>待审核身份快照</h2><pre className="overflow-auto text-xs">{JSON.stringify(data.selected.identity, null, 2)}</pre><p className="break-all text-xs">identity SHA256 {data.selected.identity_hash} · review CAS {data.selected.review_revision}</p><p className="text-sm">全局代码/币种/挂牌身份改变将使旧确认冲突；刷新后必须重新人工核对，不能自动换绑。</p>{data.selected.current && <details><summary>当前人审版本与缺口</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(data.selected.current, null, 2)}</pre></details>}</section>
      <form className={panel} onSubmit={submit}><h2 className="font-semibold">显式发布新的人审版本</h2><fieldset className="space-y-3" disabled={busy || !!pending || data.read_only}><label>来源 ID<input aria-label="审核来源ID" list="listing-review-sources" className={field} value={draft.sourceId} onChange={event => edit({ sourceId: event.target.value, sourceHash: data.sources.find(source => source.id === event.target.value)?.content_hash ?? "" })} /><datalist id="listing-review-sources">{data.sources.map(source => <option key={source.id} value={source.id}>{source.reference} · {source.known_at}</option>)}</datalist></label>{textField("来源原字节 SHA256", "sourceHash")}<p className="text-xs">仅列最近 100 份同组合来源；未显示可手填已保存的完整 ID/hash，服务器重新核对私有作用域与原件。存储不等于审核，引用地址不会自动下载。</p>{data.sources_truncated && <p>来源列表已截断，不代表其余原件不存在。</p>}
        <div className="grid gap-3 md:grid-cols-2">{enumField("证券种类", "instrumentKind", ["ETF", "ETN", "equity", "fund", "other", "unknown"])}{enumField("挂牌生命周期", "lifecycleStatus", ["active", "suspended", "delisted", "unknown"])}{enumField("杠杆结构", "leverage", ["unleveraged", "leveraged", "unknown"])}{enumField("方向结构", "direction", ["long_only", "inverse", "unknown"])}{textField("数量步长（空白为未知）", "quantityStep")}{textField("价格步长（空白为未知）", "priceStep")}{textField("来源生效日期 YYYY-MM-DD（可空）", "effectiveDate")}{textField("审核失效时刻 UTC，含六位小数", "reviewUntil")}{textField("基金标识（可空）", "fundId")}{textField("份额类别标识（可空）", "shareClassId")}{textField("整只基金指数分类（可空）", "indexId")}{textField("整只基金区域分类（可空）", "region")}{textField("整只基金行业分类（可空）", "sector")}</div><p className="text-xs">非空步长必须正数精确十进制；未知可以记录但会阻断。来源生效日期不得晚于审核时市场当地日，不会倒填知识时间。失效时刻必须明确；没有默认有效期。</p>{textField("本次人工核实理由", "reason")}</fieldset>
        {pending && <div className="space-y-2 text-sm"><p>未决请求可能已经完成。先只读刷新核对；人工重试仍使用原 identity hash、CAS、字节和幂等键。</p><details><summary>冻结原审核请求</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{pending.body}</pre></details><button type="button" className={button} disabled={busy} onClick={() => { if (window.confirm("已核对服务端并确认放弃本页重试？不会撤销已经生效的人审。")) { setPending(null); setAck(false); setDraft(emptyListingReviewDraft()); } }}>显式放弃本页审核重试</button></div>}
        <label className="flex gap-2"><input type="checkbox" checked={ack} disabled={busy || data.read_only} onChange={event => setAck(event.target.checked)} />我已逐项核对本组合、证券身份、来源原件、产品结构、分类、步长、期限与理由；这是人审资料而非交易授权。</label><button className={button} disabled={!ack || busy || data.read_only}>{pending ? "人工重试完全相同审核" : "确认发布人审版本"}</button>
      </form><section className={panel}><h2>历史版本（不是当前授权）</h2>{data.history.map(item => <details key={item.document.id}><summary>revision {item.document.revision} · {item.document.known_at} · {item.document.facts.lifecycle_status}</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(item, null, 2)}</pre></details>)}{data.history_truncated && <p>仅显示最近 20 个人审版本，未删除历史。</p>}</section></>}
      {receipt && <section className={panel}><h2>原文与身份 hash 已核验的审核回执</h2><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{receipt}</pre></section>}
    </>}
  </main>;
}
