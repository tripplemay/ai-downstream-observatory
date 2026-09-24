"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import type { CsvBackgroundCandidateKind, CsvBackgroundCandidatesPage, CsvBackgroundListPage, CsvBackgroundPreviewPage,
  CsvBackgroundReceiptsPage, CsvBackgroundRowItem, CsvBackgroundRowsPage, CsvBackgroundSummary } from "@/server/csv-background/query-types";
import { csvMappingSchema, type CsvMapping } from "@/server/ledger/csv-schemas";
import { CsvMappingWizard } from "./csv-mapping-wizard";
import { shouldWarnCsvNavigation, type CsvScope } from "./csv-workspace-state";
import { backgroundReviewDraft, backgroundReviewResolution, type CsvBackgroundReviewDraft } from "./csv-background-review";
import { fetchCsvBackground, prepareCsvBackgroundPreview, prepareCsvBackgroundConfirmation,
  prepareCsvBackgroundCancellation, sendCsvBackground } from "./csv-background-client";

interface Props {
  portfolioId: string; accountId: string; revision: number; readOnly?: boolean;
  onCommitted: () => void | Promise<void>; onScopeLockChange?: (locked: boolean) => void;
  onRestorePendingScope?: (scope: CsvScope) => void | Promise<void>;
}
type Prepared = Awaited<ReturnType<typeof prepareCsvBackgroundPreview>> | Awaited<ReturnType<typeof prepareCsvBackgroundConfirmation>> | Awaited<ReturnType<typeof prepareCsvBackgroundCancellation>>;
interface Pending { prepared: Prepared; kind: "preview" | "confirm" | "cancel"; binding: string; portfolioId: string; accountId: string; revision: number; contentHash?: string }
interface Operation { epoch: number; controller: AbortController; binding: string }
interface Pager { cursor: string | undefined; back: (string | undefined)[] }
const firstPage = (): Pager => ({ cursor: undefined, back: [] });
const field = "flex min-w-0 flex-col gap-1.5 text-sm";
const selectClass = "h-10 w-full min-w-0 max-w-full rounded-md border bg-background px-3";
const terminal = new Set(["succeeded", "failed", "partial", "skipped", "cancelled", "expired"]);
const candidateNames: Record<CsvBackgroundCandidateKind, string> = { exact_event_ids: "完全相同的已有事实", possible_event_ids: "可能相同的已有事实", exact_prior_rows: "完全相同的前行", possible_prior_rows: "可能相同的前行" };
const message = (error: unknown) => error instanceof Error ? error.message : "CSV_BACKGROUND_REQUEST_FAILED";
const describe = (value: unknown) => JSON.stringify(value, null, 2);

function Pagination({ pager, next, disabled, label, onPage }: { pager: Pager; next: string | null; disabled: boolean; label: string; onPage: (page: Pager) => void }) {
  return <div className="flex flex-wrap items-center gap-2 text-xs"><Button type="button" variant="outline" size="sm" disabled={disabled || !pager.back.length}
    onClick={() => onPage({ cursor: pager.back.at(-1), back: pager.back.slice(0, -1) })}>上一页{label}</Button><span>第 {pager.back.length + 1} 页 · 服务器分页</span>
    <Button type="button" variant="outline" size="sm" disabled={disabled || !next} onClick={() => { if (next) onPage({ cursor: next, back: [...pager.back, pager.cursor] }); }}>下一页{label}</Button></div>;
}

export function CsvBackgroundWorkspace({ portfolioId, accountId, revision, readOnly = false, onCommitted, onScopeLockChange, onRestorePendingScope }: Props) {
  const session = useSessionBoundary();
  const current = useRef({ portfolioId, accountId, revision, session, readOnly }); current.current = { portfolioId, accountId, revision, session, readOnly };
  const identity = JSON.stringify([portfolioId, accountId, revision, session?.sessionBinding ?? ""]);
  const previous = useRef(identity), epoch = useRef(0), mounted = useRef(true), active = useRef<Operation | null>(null), invalidated = useRef(false);
  const priorContext = useRef({ portfolioId, accountId, binding: session?.sessionBinding });
  const verifiedBefore = useRef(session?.verified);
  if (verifiedBefore.current && !session?.verified) { epoch.current++; active.current?.controller.abort(); active.current = null; }
  verifiedBefore.current = session?.verified;
  if (previous.current !== identity) { previous.current = identity; epoch.current++; active.current?.controller.abort(); active.current = null; }
  const [displayIdentity, setDisplayIdentity] = useState(identity);
  const [file, setFile] = useState<File | null>(null), [fileKey, setFileKey] = useState(0), [mapping, setMapping] = useState("");
  const [mode, setMode] = useState<"wizard" | "advanced">("wizard"), [wizardHash, setWizardHash] = useState<string | null>(null);
  const [previousMapping, setPreviousMapping] = useState<CsvMapping | null>(null), [wizardBusy, setWizardBusy] = useState(false);
  const [previewAck, setPreviewAck] = useState(false), [reviewAck, setReviewAck] = useState(false), [confirmAck, setConfirmAck] = useState(false), [retryAck, setRetryAck] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null), pendingRef = useRef<Pending | null>(null); pendingRef.current = pending;
  const [list, setList] = useState<CsvBackgroundListPage | null>(null), [listPager, setListPager] = useState(firstPage);
  const [selected, setSelected] = useState(""), [status, setStatus] = useState<CsvBackgroundSummary | null>(null);
  const [metadata, setMetadata] = useState<CsvBackgroundPreviewPage | null>(null), [rows, setRows] = useState<CsvBackgroundRowsPage | null>(null), [rowsPager, setRowsPager] = useState(firstPage);
  const [reviewVerified, setReviewVerified] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false), [drafts, setDrafts] = useState<Record<number, CsvBackgroundReviewDraft>>({});
  const [candidateTarget, setCandidateTarget] = useState<CsvBackgroundRowItem | null>(null), [candidates, setCandidates] = useState<CsvBackgroundCandidatesPage | null>(null), [candidatePager, setCandidatePager] = useState(firstPage);
  const [receipts, setReceipts] = useState<CsvBackgroundReceiptsPage | null>(null), [receiptsPager, setReceiptsPager] = useState(firstPage);
  const [cancelReason, setCancelReason] = useState(""), [serverReadOnly, setServerReadOnly] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const lastCommitted = useRef<string | null>(null), expectedFileHash = useRef<{ request: string; hash: string } | null>(null);
  const privateVisible = !!session?.verified && !invalidated.current && displayIdentity === identity;
  const jobActive = !!status && !terminal.has(status.status);
  const locked = busy || wizardBusy || !!pending || jobActive;
  const mutationDisabled = !privateVisible || !portfolioId || !accountId || readOnly || serverReadOnly || busy || wizardBusy || !!pending;
  const pendingElsewhere = !!pending && (pending.portfolioId !== portfolioId || pending.accountId !== accountId);

  function clearReview() {
    setReviewVerified(false);
    setMetadata(null); setRows(null); setRowsPager(firstPage()); setCandidates(null); setCandidateTarget(null); setCandidatePager(firstPage());
    setReceipts(null); setReceiptsPager(firstPage()); setDrafts({}); setReviewAck(false); setConfirmAck(false); setCancelReason("");
  }
  function clearPrivate(keepPending = false) {
    setFile(null); setFileKey(value => value + 1); setMapping(""); setPreviousMapping(null); setWizardHash(null); setWizardBusy(false);
    setPreviewAck(false); setRetryAck(false); setList(null); setListPager(firstPage()); setSelected(""); setStatus(null); clearReview();
    setBusy(false); setError(""); setNotice(""); setServerReadOnly(false); expectedFileHash.current = null; lastCommitted.current = null;
    if (!keepPending) { pendingRef.current = null; setPending(null); }
  }
  useEffect(() => {
    const sameScope = priorContext.current.portfolioId === portfolioId && priorContext.current.accountId === accountId && priorContext.current.binding === session?.sessionBinding;
    priorContext.current = { portfolioId, accountId, binding: session?.sessionBinding };
    if (!sameScope) clearPrivate(!!pendingRef.current && pendingRef.current.binding === session?.sessionBinding);
    else { clearReview(); setBusy(false); setWizardHash(null); setPreviewAck(false); setRetryAck(false); }
    setDisplayIdentity(identity);
  }, [identity]); // Scope/revision changes never transfer reviewed data or late results.
  useEffect(() => {
    mounted.current = true;
    const invalidate = () => { invalidated.current = true; epoch.current++; active.current?.controller.abort(); active.current = null; clearPrivate(); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => { mounted.current = false; epoch.current++; active.current?.controller.abort(); active.current = null; window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); };
  }, []);
  useEffect(() => { if (!session?.verified) setBusy(false); }, [session?.verified]);
  useEffect(() => { onScopeLockChange?.(privateVisible && locked); }, [onScopeLockChange, locked, privateVisible]);
  useEffect(() => () => onScopeLockChange?.(false), [onScopeLockChange]);
  useEffect(() => {
    if (!privateVisible || !locked) return;
    const warning = "已授权的后台任务在离页或退出后仍会继续；离开不会取消任务。本页未决请求原字节和复核草稿将丢失。仍要离开？";
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const link = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !(event.target instanceof Element)) return;
      const anchor = event.target.closest("a[href]");
      if (anchor instanceof HTMLAnchorElement && shouldWarnCsvNavigation(anchor.href, window.location.href, anchor.target, anchor.hasAttribute("download")) && !window.confirm(warning)) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", link, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", link, true); };
  }, [locked, privateVisible]);

  function isCurrent(token: Operation) { return mounted.current && !invalidated.current && token === active.current && token.epoch === epoch.current
    && current.current.session?.verified === true && current.current.session.sessionBinding === token.binding; }
  function start(): Operation | null {
    if (active.current || !session?.verified || invalidated.current) return null;
    const token = { epoch: epoch.current, controller: new AbortController(), binding: session.sessionBinding };
    active.current = token; setBusy(true); setError(""); return token;
  }
  function finish(token: Operation) { if (active.current === token) { active.current = null; setBusy(false); } }
  async function request(token: Operation, query: Parameters<typeof fetchCsvBackground>[0], expected?: CsvBackgroundSummary, expectedRow?: CsvBackgroundRowItem) {
    const value = await fetchCsvBackground(query, { sessionBinding: token.binding, signal: token.controller.signal, isCurrent: () => isCurrent(token), expected, expectedRow });
    if (!isCurrent(token)) throw new Error("CSV_BACKGROUND_STALE_OPERATION");
    setServerReadOnly(value.read_only); return value;
  }
  async function readList(token: Operation, pager = firstPage()) {
    const value = await request(token, { portfolio_id: portfolioId, cursor: pager.cursor, limit: 10 });
    if (value.view !== "list") throw new Error("CSV_BACKGROUND_RESPONSE_INVALID");
    setList(value); setListPager(pager);
  }
  async function readDetail(token: Operation, id: string) {
    setReviewVerified(false);
    const value = await request(token, { portfolio_id: portfolioId, request_id: id, view: "status" });
    if (value.view !== "status" || value.item.account_id !== accountId) throw new Error("CSV_BACKGROUND_SCOPE_MISMATCH");
    setStatus(value.item);
    if (!value.item.result) return;
    const meta = await request(token, { portfolio_id: portfolioId, request_id: id, view: "preview" }, value.item);
    if (meta.view !== "preview" || meta.preview.account_id !== accountId || meta.result_hash !== value.item.result_hash) throw new Error("CSV_BACKGROUND_RESPONSE_INVALID");
    if (expectedFileHash.current?.request === id && expectedFileHash.current.hash !== meta.preview.content_hash) throw new Error("CSV_BACKGROUND_FILE_HASH_MISMATCH");
    const page = await request(token, { portfolio_id: portfolioId, request_id: id, view: "rows", limit: 25, review_only: false }, value.item);
    if (page.view !== "rows" || page.result_hash !== meta.result_hash || page.review_hash !== meta.review_hash) throw new Error("CSV_BACKGROUND_RESPONSE_INVALID");
    setMetadata(meta); setRows(page); setRowsPager(firstPage()); setReviewOnly(false); setReviewVerified(true);
    if (value.item.operation === "confirm" && value.item.result.batch_status === "confirmed" && value.item.result.receipts_hash && lastCommitted.current !== value.item.result_hash) {
      lastCommitted.current = value.item.result_hash;
      setNotice("服务器已独立核验确认结果；实际回执另行分页读取。任务受理响应与 stdout 不作为入账成功证据。");
      try { await onCommitted(); } catch { if (isCurrent(token)) setError("已核验实际确认结果，但账户刷新失败；不要因此重复提交。"); }
    }
  }
  async function refresh(id = selected, pager = listPager) {
    const token = start(); if (!token) return;
    try { await readList(token, pager); if (id) await readDetail(token, id); }
    catch (caught) { if (isCurrent(token)) setError(message(caught)); } finally { finish(token); }
  }
  useEffect(() => { if (privateVisible && portfolioId && accountId) void refresh(selected, firstPage()); }, [identity, privateVisible, portfolioId, accountId]);
  async function selectTask(item: CsvBackgroundSummary) {
    if (active.current || pending || item.account_id !== accountId || item.request_id === selected) return;
    if (Object.keys(drafts).length && !window.confirm("切换任务将清除本页人工复核草稿；不会取消后台任务。继续？")) return;
    clearReview(); setPreviewAck(false); setStatus(null); setSelected(item.request_id); expectedFileHash.current = null;
    const token = start(); if (!token) return;
    try { await readDetail(token, item.request_id); } catch (caught) { if (isCurrent(token)) setError(message(caught)); } finally { finish(token); }
  }
  async function pageRows(pager: Pager, filter = reviewOnly) {
    if (!metadata) return; const token = start(); if (!token) return;
    try {
      const value = await request(token, { portfolio_id: portfolioId, request_id: selected, view: "rows", limit: 25, review_only: filter, cursor: pager.cursor }, status ?? undefined);
      if (value.view !== "rows" || value.result_hash !== metadata.result_hash || value.review_hash !== metadata.review_hash) throw new Error("CSV_BACKGROUND_RESPONSE_INVALID");
      setRows(value); setRowsPager(pager); setReviewOnly(filter); setCandidates(null); setCandidateTarget(null); setCandidatePager(firstPage());
    } catch (caught) { if (isCurrent(token)) setError(message(caught)); } finally { finish(token); }
  }
  async function pageCandidates(row: CsvBackgroundRowItem, kind: CsvBackgroundCandidateKind, pager = firstPage()) {
    if (!metadata) return; const token = start(); if (!token) return;
    try {
      const value = await request(token, { portfolio_id: portfolioId, request_id: selected, view: "candidates", row: row.row, kind, limit: 20, cursor: pager.cursor }, status ?? undefined, row);
      if (value.view !== "candidates" || value.result_hash !== metadata.result_hash || value.review_hash !== metadata.review_hash || value.total !== row.candidate_counts[kind]) throw new Error("CSV_BACKGROUND_RESPONSE_INVALID");
      setCandidates(value); setCandidateTarget(row); setCandidatePager(pager);
    } catch (caught) { if (isCurrent(token)) setError(message(caught)); } finally { finish(token); }
  }
  async function pageReceipts(pager = firstPage()) {
    if (!status?.result?.receipts_hash || !metadata) return; const token = start(); if (!token) return;
    try {
      const value = await request(token, { portfolio_id: portfolioId, request_id: selected, view: "receipts", limit: 25, cursor: pager.cursor }, status);
      if (value.view !== "receipts" || value.result_hash !== metadata.result_hash || value.receipts_hash !== status.result.receipts_hash) throw new Error("CSV_BACKGROUND_RESPONSE_INVALID");
      setReceipts(value); setReceiptsPager(pager);
    } catch (caught) { if (isCurrent(token)) setError(message(caught)); } finally { finish(token); }
  }
  async function deliver(token: Operation, value: Pending) {
    if (!isCurrent(token) || current.current.readOnly || serverReadOnly) return;
    pendingRef.current = value; setPending(value); setRetryAck(false);
    const receipt = await sendCsvBackground(value.prepared, { sessionBinding: value.binding, signal: token.controller.signal,
      isCurrent: () => isCurrent(token) && !current.current.readOnly && !serverReadOnly });
    if (!isCurrent(token)) return;
    pendingRef.current = null; setPending(null); setPreviewAck(false); setConfirmAck(false); setReviewAck(false);
    setNotice(value.kind === "cancel" ? "已核验取消请求回执；最终状态以只读查询为准，已经完成的事实不会撤回。" : "已核验任务受理回执（不代表执行成功）。退出或关闭后已授权任务仍继续；刷新只查询，不执行或重试。");
    clearReview(); setSelected(receipt.request_id); setStatus(null);
    if (value.contentHash) expectedFileHash.current = { request: receipt.request_id, hash: value.contentHash };
    await readList(token); await readDetail(token, receipt.request_id);
  }
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (mutationDisabled || jobActive || !previewAck || !file || !mapping.trim() || (mode === "wizard" && !wizardHash)) return;
    const token = start(); if (!token) return;
    try {
      if (!file.size || file.size > 4 * 1024 * 1024 || new TextEncoder().encode(mapping).length > 256 * 1024) throw new Error("CSV_OR_MAPPING_TOO_LARGE");
      const bytes = await file.arrayBuffer(); if (!isCurrent(token)) return;
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
      if (!isCurrent(token) || current.current.readOnly || serverReadOnly) return;
      if (mode === "wizard" && hash !== wizardHash) throw new Error("CSV_WIZARD_FILE_HASH_MISMATCH");
      const prepared = await prepareCsvBackgroundPreview({ portfolioId, accountId, revision, file, mapping, idempotencyKey: crypto.randomUUID(), acknowledge: true });
      if (!isCurrent(token)) return;
      await deliver(token, { prepared, kind: "preview", portfolioId, accountId, revision, binding: token.binding, contentHash: hash });
    } catch (caught) { if (isCurrent(token)) setError(`${message(caught)}${pendingRef.current ? "。原请求保留；先只读核对历史，再决定是否原样重试。" : ""}`); } finally { finish(token); }
  }
  const resolutions = metadata ? Object.values(drafts).flatMap(draft => { const value = backgroundReviewResolution(draft, metadata.review_hash); return value ? [value] : []; }).sort((a, b) => a.row - b.row) : [];
  const confirmReady = reviewVerified && !!metadata && !!status?.result && metadata.preview.batch_status === "preview" && metadata.preview.row_count > 0
    && metadata.preview.expected_revision === revision && metadata.preview.current_revision === revision && !metadata.preview.error_count && !metadata.preview.document_errors.length
    && resolutions.length === metadata.preview.required_review_count && reviewAck && confirmAck;
  async function confirm() {
    if (mutationDisabled || !confirmReady || !metadata) return; const token = start(); if (!token) return;
    try {
      const payloadText = JSON.stringify({ action: "confirm_import", portfolio_id: portfolioId, batch_id: metadata.batch_id, preview_hash: metadata.preview_hash,
        expected_revision: metadata.preview.expected_revision, csv_review: { acknowledge_unverified_mapping: true, review_hash: metadata.review_hash, rows: resolutions } });
      const prepared = await prepareCsvBackgroundConfirmation({ portfolioId, accountId, idempotencyKey: crypto.randomUUID(), payloadText, acknowledge: true });
      if (!isCurrent(token)) return;
      await deliver(token, { prepared, kind: "confirm", portfolioId, accountId, revision, binding: token.binding });
    } catch (caught) { if (isCurrent(token)) setError(`${message(caught)}${pendingRef.current ? "。原确认字节与幂等键保留，仅可手动原样重试。" : ""}`); } finally { finish(token); }
  }
  async function cancel() {
    if (mutationDisabled || !status || terminal.has(status.status) || !cancelReason.trim()) return; const token = start(); if (!token) return;
    try {
      const prepared = await prepareCsvBackgroundCancellation({ portfolioId, requestId: selected, reason: cancelReason });
      if (!isCurrent(token)) return;
      await deliver(token, { prepared, kind: "cancel", portfolioId, accountId, revision, binding: token.binding });
    } catch (caught) { if (isCurrent(token)) setError(`${message(caught)}${pendingRef.current ? "。原取消理由保留，不自动重试。" : ""}`); } finally { finish(token); }
  }
  async function retry() {
    if (!pending || pendingElsewhere || !retryAck || readOnly || serverReadOnly || !privateVisible) return;
    const token = start(); if (!token || pending.binding !== token.binding) { if (token) finish(token); return; }
    try { await deliver(token, pending); } catch (caught) { if (isCurrent(token)) setError(`${message(caught)}。原请求保留；不会自动提交。`); } finally { finish(token); }
  }
  function clearPage() {
    if (busy || wizardBusy) return;
    if ((pending || jobActive || Object.keys(drafts).length) && !window.confirm("仅清除本页文件、原样重试信息和复核草稿，不取消或撤回任何后台任务。已授权任务仍继续，新会话只能查询受限任务历史。继续？")) return;
    epoch.current++; clearPrivate(); setDisplayIdentity(identity);
  }
  async function loadMapping(value: File | null) {
    if (!value || mutationDisabled) return; const token = start(); if (!token) return;
    try {
      if (value.size > 256 * 1024) throw new Error("CSV_MAPPING_TOO_LARGE");
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await value.arrayBuffer()); if (!isCurrent(token)) return;
      setMapping(text); setWizardHash(null); setPreviewAck(false);
      try { const parsed = csvMappingSchema.safeParse(JSON.parse(text)); if (parsed.success) setPreviousMapping(parsed.data); } catch { /* Keep exact text for strict server validation. */ }
    } catch (caught) { if (isCurrent(token)) setError(message(caught)); } finally { finish(token); }
  }
  const applyMapping = useCallback((text: string, hash: string) => {
    if (active.current || pendingRef.current || invalidated.current || !current.current.session?.verified || current.current.readOnly) return false;
    setMapping(text); setWizardHash(hash); setPreviewAck(false); return true;
  }, []);
  const invalidateMapping = useCallback(() => setWizardHash(null), []);
  function draft(row: CsvBackgroundRowItem, patch: Partial<CsvBackgroundReviewDraft>) {
    if (mutationDisabled || !metadata || !row.requires_review) return;
    setDrafts(values => ({ ...values, [row.row]: { ...(values[row.row] ?? backgroundReviewDraft(row, metadata.review_hash)), ...patch } })); setConfirmAck(false);
  }

  if (!privateVisible) return <section aria-label="后台 CSV 导入"><p role="status">正在复核登录会话与账户范围；旧文件、草稿和查询结果不会显示。</p></section>;
  return <section aria-label="后台 CSV 导入" aria-busy={busy || wizardBusy} className="min-w-0 space-y-4 rounded-xl border bg-card p-5 shadow-sm">
    <h2 className="text-lg font-semibold">后台 CSV 导入</h2>
    <p className="text-sm text-muted-foreground">检查与映射向导不入账。预览与确认分别明确授权后台执行；一经受理，关闭页面或退出不会取消任务。GET、刷新和历史查询不会执行任务，也不会自动 POST。券商原生格式尚未核验。</p>
    {(readOnly || serverReadOnly) && <p role="status">恢复只读：允许查询任务和分页证据，所有后台提交、重试与取消均已禁用。</p>}
    {error && <p role="alert" className="break-all rounded border border-red-500/40 p-3 text-sm">{error}</p>}
    {notice && <p role="status" className="break-words rounded border p-3 text-sm">{notice}</p>}
    <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy || wizardBusy} onClick={() => void refresh()}>刷新任务与状态（只读）</Button><Button type="button" variant="outline" disabled={busy || wizardBusy} onClick={clearPage}>清除本页（不取消任务）</Button></div>
    {pending && <div className="space-y-3 rounded border border-amber-500/50 p-3 text-sm"><p>响应未决：{pending.kind} 原请求、原文件字节与幂等键仅保留在本页内存。不要换参数猜测重发。服务器已授权的任务不会因清页或退出撤销。</p>
      {pendingElsewhere ? <Button type="button" variant="outline" disabled={busy || !onRestorePendingScope} onClick={() => void onRestorePendingScope?.({ portfolioId: pending.portfolioId, accountId: pending.accountId })}>恢复原请求账户</Button> : <><label className="flex items-start gap-2"><input aria-label="确认原样重试" type="checkbox" checked={retryAck} disabled={busy || readOnly || serverReadOnly} onChange={event => setRetryAck(event.target.checked)} />我已只读核对任务，明确按原字节与原幂等键重试，不修改授权。</label><Button type="button" disabled={!retryAck || busy || readOnly || serverReadOnly} onClick={() => void retry()}>原样重试未决请求</Button></>}
    </div>}
    <form onSubmit={upload} className="space-y-4">
      <fieldset disabled={mutationDisabled || jobActive} className="min-w-0 space-y-4">
        <legend className="font-medium">1. 原始文件与映射</legend>
        <label className={field}>CSV 原件（非空，最多 4 MiB）<Input key={fileKey} aria-label="后台 CSV 原件" type="file" accept=".csv,text/csv" onChange={event => { setFile(event.target.files?.[0] ?? null); setWizardHash(null); setPreviewAck(false); }} /></label>
        <label className={field}>映射方式<select aria-label="后台 CSV 映射方式" className={selectClass} value={mode} onChange={event => { setMode(event.target.value as typeof mode); setPreviewAck(false); }}><option value="wizard">只读检查与映射向导</option><option value="advanced">高级：原始映射 JSON</option></select></label>
        {mode === "wizard" && <CsvMappingWizard key={identity} file={file} portfolioId={portfolioId} accountId={accountId} revision={revision} disabled={mutationDisabled || jobActive} previousMapping={previousMapping} onApply={applyMapping} onInvalidate={invalidateMapping} onBusyChange={setWizardBusy} />}
        {mode === "advanced" && <><label className={field}>映射 JSON 文件（最多 256 KiB）<Input aria-label="后台 CSV 映射文件" type="file" accept=".json,application/json" onChange={event => void loadMapping(event.target.files?.[0] ?? null)} /></label><label className={field}>原始映射 JSON<textarea aria-label="后台 CSV 原始映射" className="min-h-44 min-w-0 rounded border bg-background p-3 font-mono text-xs" value={mapping} onChange={event => { setMapping(event.target.value); setWizardHash(null); setPreviewAck(false); }} /></label></>}
        {wizardHash && <p className="break-all font-mono text-xs">已核对 CSV SHA-256：{wizardHash}</p>}
        <label className="flex items-start gap-2 text-sm"><input aria-label="授权后台预览" type="checkbox" checked={previewAck} onChange={event => setPreviewAck(event.target.checked)} />明确授权后台生成预览（不是入账）；关闭或退出后仍继续。</label>
        <Button disabled={mutationDisabled || jobActive || !previewAck || !file || !mapping.trim() || (mode === "wizard" && !wizardHash)}>提交后台预览</Button>
      </fieldset>
    </form>
    <div className="space-y-3 rounded border p-3"><h3 className="font-medium">2. 本人任务历史（跨会话受限摘要）</h3><p className="text-xs text-muted-foreground">不恢复旧会话原始请求、CSV 文件或原样重试授权。成功预览可重新逐页复核并新建明确确认授权。</p>
      {!list ? <p>尚未读取任务。</p> : <>{!list.items.length && <p>本页没有任务。</p>}{list.items.map(item => <div key={item.request_id} className="flex min-w-0 flex-wrap items-center gap-2 rounded border p-2 text-xs"><code className="min-w-0 flex-1 break-all">{item.operation} · {item.status} · {item.request_id}<br />账户 {item.account_id} · {item.created_at}</code><Button type="button" variant="outline" size="sm" disabled={busy || !!pending || item.account_id !== accountId} onClick={() => void selectTask(item)}>{selected === item.request_id ? "当前任务" : "核对任务"}</Button>{item.account_id !== accountId && <span>请选择对应导入账户后查看</span>}</div>)}<Pagination pager={listPager} next={list.next_cursor} disabled={busy} label="任务" onPage={pager => void refresh("", pager)} /></>}
    </div>
    {status && <div className="space-y-3 rounded border p-3 text-sm"><h3 className="font-medium">任务状态：{status.status}</h3><p className="break-all">请求 {status.request_id} · {status.operation} · 到期 {status.expires_at}</p><p>{status.result ? "已核验服务器结果" : "尚无已核验执行结果；queued / running 不是完成"} · 尝试 {status.job?.attempt_count ?? 0} / {status.job?.max_attempts ?? "-"}</p>
      {status.attempts.map(item => <p key={item.attempt} className="break-all text-xs">尝试 {item.attempt} · {item.status} · {item.started_at} → {item.finished_at ?? "进行中"} · {item.error_code ?? "无公开错误码"}</p>)}
      {!terminal.has(status.status) && <div className="space-y-2"><label className={field}>取消理由（不撤销已经完成的事实）<Input aria-label="后台 CSV 取消理由" value={cancelReason} maxLength={1000} disabled={mutationDisabled} onChange={event => setCancelReason(event.target.value)} /></label><Button type="button" variant="outline" disabled={mutationDisabled || !cancelReason.trim()} onClick={() => void cancel()}>明确取消此后台任务</Button></div>}
    </div>}
    {metadata && <div className="space-y-4 rounded border p-3"><h3 className="font-medium">3. 完整证据复核与确认授权</h3>
      <p className="text-sm">原件 {metadata.preview.original_filename} · {metadata.preview.row_count} 行 · 错误 {metadata.preview.error_count} · 必须人工决定 {metadata.preview.required_review_count} 行 · 当前批次 {metadata.preview.batch_status}</p>
      <p className="text-sm">预览账本版本 {metadata.preview.expected_revision} · 服务器当前版本 {metadata.preview.current_revision} · 本页版本 {revision}。版本变化必须重新核对，不能改写旧授权。</p>
      <details><summary className="cursor-pointer text-sm">文件、映射与复核标识</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{describe(metadata)}</pre></details>
      <div className="flex flex-wrap gap-4 text-sm"><a className="underline" download href={`/api/workbench/attachments/${encodeURIComponent(metadata.preview.attachment_id)}?portfolio=${encodeURIComponent(portfolioId)}`}>下载 CSV 原件</a><a className="underline" download href={`/api/workbench/attachments/${encodeURIComponent(metadata.preview.mapping_attachment_id)}?portfolio=${encodeURIComponent(portfolioId)}`}>下载已封存映射原件</a></div>
      <p className="break-all font-mono text-xs">CSV SHA-256 {metadata.preview.content_hash}<br />映射原字节 SHA-256 {metadata.preview.mapping_attachment_hash}</p><p className="text-xs">下载使用既有附件授权，不创建任务，也不恢复旧会话原确认请求。</p>
      {!!metadata.preview.document_errors.length && <p role="alert" className="break-all text-sm">文档错误：{describe(metadata.preview.document_errors)}</p>}
      {!!metadata.preview.warnings.length && <p className="break-all text-sm">警告：{metadata.preview.warnings.join("；")}</p>}
      <label className="flex gap-2 text-sm"><input aria-label="只看必须复核行" type="checkbox" checked={reviewOnly} disabled={busy} onChange={event => void pageRows(firstPage(), event.target.checked)} />只看必须人工复核的行（服务器过滤）</label>
      {rows && <><p className="text-xs">符合过滤条件共 {rows.total} 行，本页 {rows.items.length} 行；不是全量加载后切片。</p>{rows.items.map(row => <article key={row.row} className="min-w-0 space-y-3 rounded border p-3 text-sm"><h4 className="font-medium">第 {row.row} 行 · {row.requires_review ? "必须人工决定" : "无必填决定"}{row.missing_source_id ? " · 缺少可靠来源记录号" : ""}</h4>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{describe({ source: row.source, command: row.command, outcome: row.outcome, errors: row.errors })}</pre>
        <div className="flex flex-wrap gap-2">{(Object.keys(candidateNames) as CsvBackgroundCandidateKind[]).map(kind => <Button key={kind} type="button" variant="outline" size="sm" disabled={busy || !row.candidate_counts[kind]} onClick={() => void pageCandidates(row, kind)}>{candidateNames[kind]}（{row.candidate_counts[kind]}）</Button>)}</div>
        {row.requires_review && <fieldset disabled={mutationDisabled || metadata.preview.batch_status !== "preview"} className="space-y-2"><label className={field}>第 {row.row} 行人工决定<select aria-label={`第 ${row.row} 行人工决定`} value={drafts[row.row]?.action ?? ""} className={selectClass} onChange={event => draft(row, { action: event.target.value as CsvBackgroundReviewDraft["action"], picked: null })}><option value="">请选择，不能自动去重</option>{row.outcome.kind !== "link_only" && <option value="record_distinct">确认是另一笔独立事实</option>}{row.candidate_counts.exact_event_ids > 0 && <option value="link_existing">关联完全相同的已有事实（从候选页选择）</option>}{row.candidate_counts.exact_prior_rows > 0 && <option value="link_prior_row">关联完全相同的前行（从候选页选择）</option>}</select></label><label className={field}>第 {row.row} 行核对理由<Input aria-label={`第 ${row.row} 行核对理由`} maxLength={2000} value={drafts[row.row]?.reason ?? ""} onChange={event => draft(row, { reason: event.target.value })} /></label>{drafts[row.row]?.picked && <p className="break-all text-xs">已选经核验候选：{String(drafts[row.row].picked!.value)}</p>}</fieldset>}
      </article>)}<Pagination pager={rowsPager} next={rows.next_cursor} disabled={busy} label="记录" onPage={pager => void pageRows(pager)} /></>}
      {candidates && candidateTarget && <div className="space-y-2 rounded border p-3 text-xs"><h4>第 {candidates.row} 行 · {candidateNames[candidates.kind]} · 总数 {candidates.total}</h4><p>可能相同仅供核对，不可直接关联；必须选择完全相同候选并给出人工理由。</p>{candidates.items.map(value => <div key={value} className="flex min-w-0 flex-wrap items-center gap-2"><code className="min-w-0 flex-1 break-all">{value}</code>{candidateTarget.requires_review && ["exact_event_ids", "exact_prior_rows"].includes(candidates.kind) && <Button type="button" size="sm" variant="outline" disabled={mutationDisabled || metadata.preview.batch_status !== "preview"} onClick={() => draft(candidateTarget, { action: candidates.kind === "exact_event_ids" ? "link_existing" : "link_prior_row", picked: { kind: candidates.kind, value } })}>选择此完全相同候选</Button>}</div>)}<Pagination pager={candidatePager} next={candidates.next_cursor} disabled={busy} label="候选" onPage={pager => void pageCandidates(candidateTarget, candidates.kind, pager)} /></div>}
      <p className="text-sm">已完整填写人工决定 {resolutions.length} / {metadata.preview.required_review_count}；草稿仅在内存中绑定当前 review_hash，不转移到其他任务或会话。</p>
      <fieldset disabled={mutationDisabled || metadata.preview.batch_status !== "preview"} className="space-y-3 text-sm"><label className="flex items-start gap-2"><input aria-label="确认完整复核 CSV" type="checkbox" checked={reviewAck} onChange={event => { setReviewAck(event.target.checked); setConfirmAck(false); }} />我已完整核对原始记录、映射、金额、日期与重复候选，理解映射未经真实券商格式验证；分页展示不是人工复核证明。</label><label className="flex items-start gap-2"><input aria-label="授权后台确认" type="checkbox" checked={confirmAck} onChange={event => setConfirmAck(event.target.checked)} />另行明确授权后台按这些人工决定整批原子确认；关闭或退出后仍继续，GET 不会执行。</label><Button type="button" disabled={mutationDisabled || !confirmReady} onClick={() => void confirm()}>提交后台确认授权</Button></fieldset>
      {status?.operation === "confirm" && status.result?.receipts_hash && <Button type="button" variant="outline" disabled={busy} onClick={() => void pageReceipts()}>读取实际回执（分页）</Button>}
      {receipts && <div className="space-y-3"><p className="break-all text-xs">实际回执共 {receipts.total} 行 · receipts_hash {receipts.receipts_hash}</p>{receipts.items.map(item => <pre key={item.row} className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-xs">{describe(item)}</pre>)}<Pagination pager={receiptsPager} next={receipts.next_cursor} disabled={busy} label="回执" onPage={pager => void pageReceipts(pager)} /></div>}
    </div>}
  </section>;
}
