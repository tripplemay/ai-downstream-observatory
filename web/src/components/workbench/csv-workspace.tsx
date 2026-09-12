"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { LedgerCommand } from "@/server/ledger/service";
import type { CsvCandidateReview, CsvRowResolution } from "@/server/ledger/csv-review";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CsvMappingWizard } from "./csv-mapping-wizard";
import { csvMappingSchema, type CsvMapping } from "@/server/ledger/csv-schemas";
import { canClearCsvPreview, canRetryCsvConfirmation, csvContextDisposition, csvScopeKey, isCsvOperationCurrent, retainCsvConfirmedRefresh, sameCsvScope, shouldWarnCsvNavigation,
  type CsvContext, type CsvOperation, type CsvPendingConfirmation, type CsvScope } from "./csv-workspace-state";

interface Props {
  portfolioId: string; accountId: string; revision: number; onCommitted: () => void | Promise<void>;
  readOnly?: boolean;
  onScopeLockChange?: (locked: boolean) => void;
  onRestorePendingScope?: (scope: CsvScope) => void | Promise<void>;
}
interface CsvSource {
  record_number: number; line_start: number; line_end: number; byte_start: number; byte_end: number;
  cells: string[]; formula_columns?: number[]; warnings?: unknown[];
}
interface CsvPreview {
  id: string; account_id: string; attachment_id: string; status: string; parser_version: string;
  preview_hash: string; expected_revision: number; duplicate?: boolean;
  rows: { row: number; command: LedgerCommand | null; errors: string[]; source?: CsvSource; outcome?: unknown }[];
  csv?: {
    original_filename: string; content_hash: string; mapping_id: string; mapping_version: number;
    mapping_hash: string; mapping_attachment_id: string; parser_version: string; mapper_version: string;
    headers: string[]; document_errors: unknown[]; warnings: unknown[]; candidates: CsvCandidateReview[];
    review_hash: string; required_review_rows: number[]; broker_format_verified: false;
  };
}
interface ResolutionDraft { action: "" | CsvRowResolution["action"]; reason: string; event_id: string; prior_row: string }
const emptyDraft = (): ResolutionDraft => ({ action: "", reason: "", event_id: "", prior_row: "" });
const field = "flex min-w-0 flex-col gap-1.5 text-sm";
const selectClass = "h-10 w-full min-w-0 max-w-full rounded-md border bg-background px-3";
const textareaClass = "min-h-44 w-full min-w-0 max-w-full rounded-md border bg-background p-3 font-mono text-xs";
const PAGE_SIZE = 25, CANDIDATE_PAGE_SIZE = 20;
const CSV_MAX_BYTES = 4 * 1024 * 1024, MAPPING_MAX_BYTES = 256 * 1024;
const CONFIRM_MAX_BYTES = 5 * 1024 * 1024;

function describe(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "请求失败，请核对状态后重试。"; }
function linkOnly(outcome: unknown): boolean { return !!outcome && typeof outcome === "object" && "kind" in outcome && outcome.kind === "link_only"; }
async function responseJson(response: Response): Promise<unknown> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error(`服务器响应无法解析（HTTP ${response.status}），不能据此判断是否已提交。`); }
  if (!response.ok) throw new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : `请求失败（HTTP ${response.status}）`);
  return value;
}
function csvPreview(value: unknown, accountId: string): CsvPreview {
  const result = value as CsvPreview | null;
  if (!result || typeof result.id !== "string" || result.account_id !== accountId || result.parser_version !== "csv-v1" || !Array.isArray(result.rows) || !result.csv
    || !Array.isArray(result.csv.candidates) || !Array.isArray(result.csv.required_review_rows) || !Array.isArray(result.csv.headers)
    || !Array.isArray(result.csv.document_errors) || !Array.isArray(result.csv.warnings) || result.csv.broker_format_verified !== false) throw new Error("CSV_PREVIEW_RESPONSE_INVALID");
  return result;
}
function resolution(row: number, draft: ResolutionDraft | undefined, candidate: CsvCandidateReview | undefined): CsvRowResolution | null {
  if (!draft || !draft.reason.trim() || draft.reason.length > 2000 || !candidate) return null;
  if (draft.action === "record_distinct") return { row, action: draft.action, reason: draft.reason };
  if (draft.action === "link_existing" && candidate.exact_event_ids.includes(draft.event_id)) return { row, action: draft.action, event_id: draft.event_id, reason: draft.reason };
  const prior = Number(draft.prior_row);
  if (draft.action === "link_prior_row" && Number.isSafeInteger(prior) && prior > 0 && prior < row && candidate.exact_prior_rows.includes(prior)) return { row, action: draft.action, prior_row: prior, reason: draft.reason };
  return null;
}

function Candidates({ title, values, onPick }: { title: string; values: readonly (string | number)[]; onPick?: (value: string | number) => void }) {
  const [page, setPage] = useState(0);
  if (!values.length) return null;
  const pages = Math.ceil(values.length / CANDIDATE_PAGE_SIZE), current = Math.min(page, pages - 1);
  return <details className="rounded border p-3 text-xs">
    <summary className="cursor-pointer font-medium">{title}（{values.length} 项）</summary>
    <ul className="mt-2 space-y-2">{values.slice(current * CANDIDATE_PAGE_SIZE, (current + 1) * CANDIDATE_PAGE_SIZE).map(value => <li key={value} className="flex flex-wrap items-center gap-2"><code className="min-w-0 break-all">{value}</code>{onPick && <Button type="button" size="sm" variant="outline" onClick={() => onPick(value)}>选择此项关联</Button>}</li>)}</ul>
    {pages > 1 && <div className="mt-3 flex flex-wrap items-center gap-2"><Button type="button" size="sm" variant="outline" disabled={current === 0} onClick={() => setPage(current - 1)}>前一组候选</Button><span>{current + 1} / {pages} 组</span><Button type="button" size="sm" variant="outline" disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>后一组候选</Button></div>}
  </details>;
}

export function CsvWorkspace({ portfolioId, accountId, revision, onCommitted, readOnly = false, onScopeLockChange, onRestorePendingScope }: Props) {
  const [file, setFile] = useState<File | null>(null), [fileKey, setFileKey] = useState(0);
  const [mapping, setMapping] = useState(""), [mappingFilename, setMappingFilename] = useState("");
  const [mode, setMode] = useState<"wizard" | "advanced">("wizard");
  const [wizardBusy, setWizardBusy] = useState(false), [wizardHash, setWizardHash] = useState<string | null>(null);
  const [knownMapping, setKnownMapping] = useState<{ scope: string; mapping: CsvMapping } | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null), [originalBytes, setOriginalBytes] = useState<Uint8Array | null>(null);
  const [drafts, setDrafts] = useState<Record<number, ResolutionDraft>>({}), [acknowledged, setAcknowledged] = useState(false);
  const [page, setPage] = useState(0), [reviewOnly, setReviewOnly] = useState(false);
  const [busy, setBusy] = useState<"preview" | "confirm" | "mapping" | "status" | null>(null);
  const [pending, setPending] = useState<CsvPendingConfirmation | null>(null), [confirmation, setConfirmation] = useState<unknown>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const scope = csvScopeKey({ portfolioId, accountId }), context: CsvContext = { portfolioId, accountId, revision };
  const currentContext = useRef(context), previous = useRef(context), mounted = useRef(true), writeLocked = useRef(readOnly);
  const operation = useRef<CsvOperation | null>(null), ownCommit = useRef<{ scope: string; revision: number | null } | null>(null);
  const previewScope = useRef<string | null>(null);
  const requestNumber = useRef(0);
  const pendingPayload = pending?.payload ?? null;
  const pendingElsewhere = !!pending && !sameCsvScope(pending.context, context);
  currentContext.current = context;
  writeLocked.current = readOnly;

  useEffect(() => {
    const disposition = csvContextDisposition(previous.current, currentContext.current, pending);
    if (disposition === "unchanged") return;
    const scopeChanged = !sameCsvScope(previous.current, currentContext.current);
    previous.current = currentContext.current;
    if (disposition === "retain_pending") {
      if (scopeChanged) { operation.current = null; setBusy(null); }
      setNotice(pending && !sameCsvScope(pending.context, currentContext.current)
        ? "范围已改变，但原账户的未决确认仍保留。请恢复原账户核对状态，或明确放弃本页重试信息；不能在新账户覆盖该请求。"
        : "账本版本或账户选择已变化；原确认请求、批次和人工决定保持冻结。先核对状态，或重试完全相同的请求，不改写为当前版本。");
      return;
    }
    if (!scopeChanged && retainCsvConfirmedRefresh(ownCommit.current, currentContext.current)) {
      ownCommit.current = null;
      return;
    }
    ownCommit.current = null; operation.current = null; previewScope.current = null;
    setPreview(null); setOriginalBytes(null); setDrafts({}); setAcknowledged(false); setConfirmation(null); setPage(0); setReviewOnly(false); setBusy(null); setError("");
    setNotice(scopeChanged ? "账户范围已改变，请重新选择文件与映射。" : "账本版本已改变，旧预览已清除；如刚提交过确认，请先核对事实或重新上传同一原件。");
    if (scopeChanged) { setFile(null); setFileKey(key => key + 1); setMapping(""); setMappingFilename(""); }
  }, [scope, revision, pending]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current = null; }; }, []);
  useEffect(() => { setWizardHash(null); }, [file, scope, revision]);
  useEffect(() => { onScopeLockChange?.(!!busy || wizardBusy || !!pending); }, [busy, wizardBusy, pending, onScopeLockChange]);
  useEffect(() => () => { onScopeLockChange?.(false); }, [onScopeLockChange]);
  useEffect(() => {
    if (!pending) return;
    const warning = "确认可能已入账。原请求只保存在当前页面内存；离开或刷新后不能保证恢复。请先核对服务器状态。仍要离开？";
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const onLink = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement) || !shouldWarnCsvNavigation(link.href, window.location.href, link.target, link.hasAttribute("download"))) return;
      if (!window.confirm(warning)) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onLink, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", onLink, true); };
  }, [pending]);

  const candidates = useMemo(() => new Map(preview?.csv?.candidates.map(candidate => [candidate.row, candidate]) ?? []), [preview]);
  const required = useMemo(() => new Set(preview?.csv?.required_review_rows ?? []), [preview]);
  const onlyLinks = useMemo(() => new Set(preview?.rows.filter(row => linkOnly(row.outcome)).map(row => row.row) ?? []), [preview]);
  const readyRows = useMemo(() => (preview?.csv?.required_review_rows ?? []).flatMap(row => {
    if (onlyLinks.has(row) && drafts[row]?.action === "record_distinct") return [];
    const value = resolution(row, drafts[row], candidates.get(row)); return value ? [value] : [];
  }), [preview, drafts, candidates, onlyLinks]);
  const filteredRows = useMemo(() => preview?.rows.filter(row => !reviewOnly || required.has(row.row)) ?? [], [preview, reviewOnly, required]);
  const pages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE)), currentPage = Math.min(page, pages - 1);
  const visibleRows = filteredRows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const frozen = readOnly || !!busy || !!pendingPayload || preview?.status === "confirmed";
  const editFrozen = !!busy || wizardBusy || !!pendingPayload || !!preview;
  const invalidateWizard = useCallback(() => setWizardHash(null), []);
  const applyWizard = useCallback((text: string, hash: string) => {
    if (busy || pending || preview) return false;
    if (mapping.trim() && mapping !== text && !window.confirm("用刚核对的向导映射替换当前编辑区映射？已封存版本不会被覆盖。")) return false;
    setMapping(text); setMappingFilename(""); setWizardHash(hash); setError("");
    return true;
  }, [busy, pending, preview, mapping]);
  const canConfirm = !readOnly && !!preview?.csv && previewScope.current === scope && preview.account_id === accountId && preview.expected_revision === revision
    && preview.status === "preview" && !preview.csv.document_errors.length && preview.rows.length > 0
    && preview.rows.every(row => row.command && !row.errors.length && row.source && Array.isArray(row.source.cells)) && acknowledged && readyRows.length === required.size;
  const attachmentHref = (id: string) => `/api/workbench/attachments/${encodeURIComponent(id)}?portfolio=${encodeURIComponent(portfolioId)}`;
  const isCurrent = (token: CsvOperation) => mounted.current && isCsvOperationCurrent(token, operation.current, currentContext.current);
  const startOperation = (kind: CsvOperation["kind"]): CsvOperation => {
    const token = { id: ++requestNumber.current, kind, context: { ...currentContext.current } };
    operation.current = token; setBusy(kind); return token;
  };

  function clearPreview(abandonPending = false) {
    if (!canClearCsvPreview(pending, abandonPending)) return false;
    previewScope.current = null; ownCommit.current = null;
    setPreview(null); setOriginalBytes(null); setDrafts({}); setAcknowledged(false); setPage(0); setReviewOnly(false); setPending(null); setConfirmation(null); setError(""); setNotice("");
    return true;
  }
  function editAgain() {
    if (operation.current) return;
    if (pendingPayload && !window.confirm("确认响应失败不代表未入账。结束后会放弃仅存在本页内存中的原确认请求和人工选择；服务器批次和可能已入账的事实不会撤销。建议先核对状态。确定放弃本页重试信息？")) return;
    const wasElsewhere = pendingElsewhere;
    clearPreview(true);
    if (wasElsewhere) { setFile(null); setFileKey(key => key + 1); setMapping(""); setMappingFilename(""); }
  }
  async function restorePendingScope() {
    if (operation.current || !pending || !onRestorePendingScope) return;
    const token = startOperation("status"); setError("");
    try { await onRestorePendingScope({ portfolioId: pending.context.portfolioId, accountId: pending.context.accountId }); }
    catch (caught) { if (isCurrent(token)) setError(errorMessage(caught)); }
    finally { if (operation.current === token) { operation.current = null; setBusy(null); } }
  }
  function updateDraft(row: number, changes: Partial<ResolutionDraft>) {
    if (frozen) return;
    setDrafts(current => ({ ...current, [row]: { ...(current[row] ?? emptyDraft()), ...changes } }));
  }
  async function loadMapping(selected: File | null) {
    if (!selected || operation.current || wizardBusy || pending) return;
    const token = startOperation("mapping"); setError(""); clearPreview();
    try {
      if (selected.size > MAPPING_MAX_BYTES) throw new Error("映射 JSON 最大为 256 KiB。");
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await selected.arrayBuffer());
      if (!isCurrent(token)) return;
      setMapping(text); setMappingFilename(selected.name);
      setWizardHash(null);
      try { const parsed = csvMappingSchema.safeParse(JSON.parse(text)); if (parsed.success) setKnownMapping({ scope, mapping: parsed.data }); } catch { /* Server validates the original JSON, including duplicate keys. */ }
    } catch (caught) { if (isCurrent(token)) setError(errorMessage(caught)); }
    finally { if (operation.current === token) { operation.current = null; setBusy(null); } }
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operation.current || wizardBusy || !file || !mapping.trim() || pendingPayload || readOnly || (mode === "wizard" && !wizardHash)) return;
    const token = startOperation("preview"); clearPreview();
    let sent = false;
    try {
      if (!portfolioId || !accountId) throw new Error("请先选择实际组合和账户。");
      if (!file.size || file.size > CSV_MAX_BYTES) throw new Error("CSV 必须非空，且不超过 4 MiB。");
      if (new TextEncoder().encode(mapping).byteLength > MAPPING_MAX_BYTES) throw new Error("映射 JSON 最大为 256 KiB。");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isCurrent(token) || writeLocked.current) return;
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const contentHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
      if (!isCurrent(token) || writeLocked.current) return;
      if (mode === "wizard" && contentHash !== wizardHash) throw new Error("CSV_WIZARD_FILE_HASH_MISMATCH");
      const data = new FormData(); data.set("portfolio_id", portfolioId); data.set("account_id", accountId); data.set("expected_revision", String(revision)); data.set("mapping", mapping); data.set("file", file);
      try { const parsed = csvMappingSchema.safeParse(JSON.parse(mapping)); if (parsed.success) setKnownMapping({ scope, mapping: parsed.data }); } catch { /* Preserve raw JSON for authoritative server validation. */ }
      sent = true;
      const result = csvPreview(await responseJson(await fetch("/api/workbench/csv", { method: "POST", body: data })), accountId);
      if (!isCurrent(token)) return;
      if (result.csv!.content_hash !== contentHash) throw new Error("CSV_PREVIEW_FILE_HASH_MISMATCH");
      if (result.status !== "confirmed" && result.expected_revision !== revision) throw new Error("CSV_PREVIEW_REVISION_MISMATCH");
      previewScope.current = scope; setPreview(result); setOriginalBytes(bytes);
      setNotice(result.status === "confirmed" ? "该原件已有已确认批次，以下仅为审计，不重复新增事实。" : result.status === "invalid"
        ? "预览存在错误，未新增账本事实；原件与该映射版本已经封存。修改映射定义必须明确创建新版本，不能覆盖本次版本。"
        : "原件和映射已留存，尚未新增任何账本事实。请逐行核对后确认。");
    } catch (caught) { if (isCurrent(token)) setError(errorMessage(caught) + (sent ? " 预览响应失败不证明映射未封存；先以同一原件及映射重试核对，修改定义时明确使用新版本。" : "")); }
    finally { if (operation.current === token) { operation.current = null; setBusy(null); } }
  }
  async function committed(result: unknown, batch: CsvPreview, token: CsvOperation) {
    if (!isCurrent(token)) return;
    const endRevision = result && typeof result === "object" && "revision" in result && Number.isSafeInteger(result.revision) ? Number(result.revision) : null;
    ownCommit.current = { scope, revision: endRevision };
    setPreview({ ...batch, status: "confirmed" }); setConfirmation(result); setPending(null); setError("");
    setNotice("批次已确认。原件与逐行关联已留存；重复来源或人工关联行不会重复入账，账户需重新对账。");
    try { await Promise.resolve(onCommitted()); }
    catch { if (isCurrent(token)) setError("入账已确认，但页面刷新失败。请刷新工作台；不要据此重新记账。"); }
  }
  async function confirm() {
    if (operation.current || readOnly || !preview?.csv || previewScope.current !== scope
      || (pending ? !canRetryCsvConfirmation(pending, currentContext.current, preview, readOnly) : !canConfirm)) return;
    const batch = preview;
    const payload = pendingPayload ?? JSON.stringify({ action: "confirm_import", portfolio_id: portfolioId, batch_id: batch.id, preview_hash: batch.preview_hash, expected_revision: batch.expected_revision,
      csv_review: { acknowledge_unverified_mapping: true, review_hash: batch.csv!.review_hash, rows: readyRows } });
    if (new TextEncoder().encode(payload).byteLength > CONFIRM_MAX_BYTES) { setError("确认请求超过 5 MiB，请精简逐行原因或结束预览后拆分原件；尚未发送确认请求。"); return; }
    // Preserve the exact first request after any ambiguous transport or HTTP failure.
    const token = startOperation("confirm");
    setPending(pending ?? { context: { portfolioId, accountId, revision: batch.expected_revision }, batchId: batch.id, payload }); setError(""); setNotice("");
    try {
      const result = await responseJson(await fetch("/api/workbench", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }));
      if (!result || typeof result !== "object" || !("revision" in result) || !Number.isSafeInteger(result.revision) || Number(result.revision) < batch.expected_revision
        || !("receipts" in result) || !Array.isArray(result.receipts) || result.receipts.length !== batch.rows.length) throw new Error("CSV_CONFIRM_RESPONSE_INVALID");
      await committed(result, batch, token);
    } catch (caught) { if (isCurrent(token)) setError(`${errorMessage(caught)}。确认请求和人工选择已保留；可核对状态或重试完全相同的请求。`); }
    finally { if (operation.current === token) { operation.current = null; setBusy(null); } }
  }
  async function checkStatus() {
    if (operation.current || !preview || previewScope.current !== scope) return;
    const token = startOperation("status"), batch = preview; setError("");
    try {
      const value = csvPreview(await responseJson(await fetch(`/api/workbench?portfolio=${encodeURIComponent(portfolioId)}&batch=${encodeURIComponent(preview.id)}`, { cache: "no-store" })), accountId);
      if (!isCurrent(token)) return;
      if (value.id !== batch.id || value.preview_hash !== batch.preview_hash || value.csv!.content_hash !== batch.csv!.content_hash || value.csv!.mapping_hash !== batch.csv!.mapping_hash) throw new Error("CSV_STATUS_RESPONSE_MISMATCH");
      if (value.status === "confirmed") await committed({ status: "confirmed", batch_id: value.id, detail: "服务器确认该批次已提交；下方行结果是封存预检，不代表实际逐行 receipt。" }, value, token);
      else setNotice(`服务器批次状态：${value.status}。已保留原确认请求；版本冲突或预览失效时请结束预览后重新核对。`);
    } catch (caught) { if (isCurrent(token)) setError(errorMessage(caught)); }
    finally { if (operation.current === token) { operation.current = null; setBusy(null); } }
  }

  return <section className="min-w-0 rounded-xl border bg-card p-5 shadow-sm" aria-busy={!!busy || wizardBusy}>
    <h2 className="text-lg font-semibold">CSV 原件检查与映射导入</h2>
    <p className="mt-2 text-sm text-muted-foreground">不是已认证的券商格式。由你明确列名、数值格式、费用、时区和账户映射；系统不猜测交易含义，不代替独立对账。预览只保存证据，确认后才记账。</p>
    <p className="mt-2 break-all text-xs text-muted-foreground">当前账户 {accountId || "未选择"} · 账本版本 {revision}。仅支持 UTF-8 CSV；原文件字节、映射和行定位均保留。</p>
    {error && <div role="alert" className="mt-4 break-words rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">{error}</div>}
    {notice && <p role="status" className="mt-4 break-words rounded-lg border p-3 text-sm">{notice}</p>}
    {pending && <p className="mt-4 rounded-lg border border-amber-500/40 p-3 text-sm">未决请求仅在本页内存中。请先核对服务器状态再离开；浏览器后退/前进等同文档导航可能不弹出提示，强制刷新后也不能保证恢复。</p>}
    {readOnly && <p role="status" className="mt-4 rounded-lg border p-3 text-sm">恢复只读：可检查 CSV 与编辑本地映射，但不能保存预览或重试确认；仍可核对已保留批次的服务器状态、查看证据和下载原件。</p>}
    {pendingElsewhere && pending && <div role="alert" className="mt-4 space-y-3 rounded-lg border border-amber-500/40 p-3 text-sm">
      <p className="break-all">未决确认属于原组合 {pending.context.portfolioId} / 原账户 {pending.context.accountId}，批次 {pending.batchId}。当前范围不能覆盖或发送该请求。</p>
      <div className="flex flex-wrap gap-3">{onRestorePendingScope && <Button type="button" variant="outline" disabled={!!busy} onClick={() => void restorePendingScope()}>恢复原账户并核对未决确认</Button>}<Button type="button" variant="outline" disabled={!!busy} onClick={editAgain}>明确放弃本页未决请求信息</Button></div>
      <details><summary className="cursor-pointer">原确认请求（仅当前页面内存）</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{pending.payload}</pre></details>
    </div>}
    <form onSubmit={upload} className="mt-5 space-y-4">
      <fieldset disabled={editFrozen} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <label className={field}>CSV 原文件（最大 4 MiB）<Input key={`csv-${fileKey}`} type="file" accept=".csv,text/csv" aria-label="CSV 原文件" required onChange={event => { if (editFrozen || !clearPreview()) return; setFile(event.target.files?.[0] ?? null); }} />{file && <span className="break-all text-xs text-muted-foreground">{file.name} · {file.size} bytes</span>}</label>
        <div className="flex flex-wrap items-end gap-2"><Button type="button" variant={mode === "wizard" ? "default" : "outline"} onClick={() => { if (!editFrozen && clearPreview()) setMode("wizard"); }}>可视化映射向导</Button><Button type="button" variant={mode === "advanced" ? "default" : "outline"} onClick={() => { if (!editFrozen && clearPreview()) setMode("advanced"); }}>高级 JSON 编辑</Button></div>
        {mode === "advanced" && <><label className={field}>加载映射 JSON（可选，最大 256 KiB）<Input key={`mapping-${fileKey}`} type="file" accept=".json,application/json" aria-label="加载映射 JSON" onChange={event => void loadMapping(event.target.files?.[0] ?? null)} />{mappingFilename && <span className="break-all text-xs text-muted-foreground">已读取 {mappingFilename}；提交以下编辑区的完整文字。</span>}</label>
          <label className={`${field} sm:col-span-2`}>映射 JSON 内容<textarea className={textareaClass} aria-label="CSV 映射 JSON 内容" value={mapping} onChange={event => { if (editFrozen || !clearPreview()) return; setMapping(event.target.value); setWizardHash(null); }} maxLength={MAPPING_MAX_BYTES} required spellCheck={false} placeholder="粘贴经人工核对的 csv-import-mapping-v1 定义。账户、上市标识、费用和时间格式必须明确；不预置券商猜测模板。" /></label></>}
      </fieldset>
      <div hidden={mode !== "wizard"}><CsvMappingWizard file={file} portfolioId={portfolioId} accountId={accountId} revision={revision} disabled={!!busy || !!pendingPayload || !!preview || mode !== "wizard"} previousMapping={knownMapping?.scope === scope ? knownMapping.mapping : null} onApply={applyWizard} onInvalidate={invalidateWizard} onBusyChange={setWizardBusy} /></div>
      <p className="text-xs text-muted-foreground">同一映射标识和版本不可覆盖，失败预览也可能已封存映射。修改定义应明确创建新版本；已确认原件需要更正时走事实更正流程，不能换映射重复导入。</p>
      {mode === "wizard" && !wizardHash && <p className="text-sm text-muted-foreground">先在向导中核对并生成映射，才能保存预览。</p>}
      <Button disabled={readOnly || editFrozen || !file || !mapping.trim() || !portfolioId || !accountId || (mode === "wizard" && !wizardHash)}>{busy === "preview" ? "正在核验原件与账本…" : "保存证据并预览（不入账）"}</Button>
    </form>
    {preview?.csv && previewScope.current === scope && <div className="mt-5 space-y-4 border-t pt-5">
      <div className="space-y-2 text-sm"><p className="font-medium">批次 {preview.status} · {preview.rows.length} 行 · 依据账本版本 {preview.expected_revision}</p><p className="break-all">原件：{preview.csv.original_filename}</p><p className="break-all">映射：{preview.csv.mapping_id} / v{preview.csv.mapping_version} · {preview.csv.parser_version} · {preview.csv.mapper_version}</p>
        <div className="flex flex-wrap gap-4"><a className="underline" download href={attachmentHref(preview.attachment_id)}>下载 CSV 原件</a><a className="underline" download href={attachmentHref(preview.csv.mapping_attachment_id)}>下载已封存映射原件</a></div>
        <details><summary className="cursor-pointer">批次与完整校验标识</summary><dl className="mt-2 space-y-1 break-all font-mono text-xs"><div><dt>batch_id</dt><dd>{preview.id}</dd></div><div><dt>content_hash</dt><dd>{preview.csv.content_hash}</dd></div><div><dt>mapping_hash</dt><dd>{preview.csv.mapping_hash}</dd></div><div><dt>preview_hash</dt><dd>{preview.preview_hash}</dd></div><div><dt>review_hash</dt><dd>{preview.csv.review_hash}</dd></div></dl></details>
      </div>
      {preview.csv.document_errors.length > 0 && <div role="alert" className="space-y-2 rounded border border-red-500/40 p-3 text-sm"><p className="font-medium">文件级错误阻断整批确认</p>{preview.csv.document_errors.map((issue, index) => <pre key={index} className="whitespace-pre-wrap break-all text-xs">{describe(issue)}</pre>)}</div>}
      {preview.csv.warnings.length > 0 && <details className="rounded border border-amber-500/30 p-3 text-sm"><summary className="cursor-pointer">全部文件与映射警告（{preview.csv.warnings.length}）</summary>{preview.csv.warnings.map((warning, index) => <pre key={index} className="mt-2 whitespace-pre-wrap break-all text-xs">{describe(warning)}</pre>)}</details>}
      <div className="flex flex-wrap items-center gap-3 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={reviewOnly} onChange={event => { setReviewOnly(event.target.checked); setPage(0); }} />仅查看必须人工确认的行</label><span>已完整填写 {readyRows.length} / {required.size} 行；所有分页均须完成。</span></div>
      <div className="flex flex-wrap items-center gap-3 text-sm"><Button type="button" variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button><span>{currentPage + 1} / {pages} 页 · 当前筛选 {filteredRows.length} 行 · 每页 {PAGE_SIZE} 行</span><Button type="button" variant="outline" size="sm" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>
      {!filteredRows.length && <p className="text-sm text-muted-foreground">当前筛选下没有行；文件级错误仍须先解决。</p>}
      {visibleRows.map(row => {
        const candidate = candidates.get(row.row), draft = drafts[row.row] ?? emptyDraft(), source = row.source;
        let original: string | null = null;
        if (source && originalBytes && Number.isSafeInteger(source.byte_start) && Number.isSafeInteger(source.byte_end) && source.byte_start >= 0 && source.byte_end >= source.byte_start && source.byte_end <= originalBytes.length) {
          try { original = new TextDecoder("utf-8", { fatal: true }).decode(originalBytes.subarray(source.byte_start, source.byte_end)); } catch { original = null; }
        }
        return <article key={`${preview.id}:${row.row}`} className="min-w-0 space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap gap-2 text-sm"><h3 className="font-medium">数据行 {row.row}</h3><span>{row.errors.length ? "校验错误" : row.command ? row.command.fact.type : "未生成标准事实"}</span>{required.has(row.row) && <span className="rounded border border-amber-500/40 px-2">必须人工确认{resolution(row.row, drafts[row.row], candidate) ? " · 已填写" : " · 未完成"}</span>}</div>
          {source ? <>
            <p className="break-words text-xs text-muted-foreground">原文件记录 {source.record_number} · 物理行 {source.line_start}–{source.line_end} · 字节 [{source.byte_start}, {source.byte_end})，不含行尾分隔符</p>
            <details><summary className="cursor-pointer text-sm">原始记录与全部单元格（仅文本，不执行公式）</summary>{original !== null && <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border bg-muted/20 p-3 text-xs">{original}</pre>}<dl className="mt-3 space-y-2">{source.cells.map((cell, column) => <div key={column} className="min-w-0 rounded border p-2"><dt className="break-all text-xs font-medium">第 {column + 1} 列 · {preview.csv!.headers[column] ?? "超出表头"}</dt><dd><pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-all text-xs">{cell === "" ? "（空单元格）" : cell}</pre></dd></div>)}</dl></details>
            {!!source.formula_columns?.length && <p className="text-xs text-amber-600">含公式样式文本，原样展示且不执行：列 {source.formula_columns.join("、")}</p>}
            {source.warnings?.map((warning, index) => <pre key={index} className="whitespace-pre-wrap break-all text-xs text-amber-600">{describe(warning)}</pre>)}
          </> : <p className="text-xs text-amber-600">本行缺少原文定位；请下载原件核对，不以标准 JSON 代替原始证据。</p>}
          {row.errors.map((issue, index) => <p key={index} className="break-all text-sm text-red-600">{issue}</p>)}
          {onlyLinks.has(row.row) && <p className="rounded border border-amber-500/40 p-2 text-sm">只能关联已存在事实或精确相同的前行，不能新增入账。请核对预检中的原始阻断原因。</p>}
          {row.command && <details><summary className="cursor-pointer text-sm">完整标准事实与来源信息</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(row.command, null, 2)}</pre></details>}
          {row.outcome !== undefined && <details><summary className="cursor-pointer text-sm">封存的账本预检结果（非实际确认回执）</summary><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{describe(row.outcome)}</pre></details>}
          {candidate && <div className="space-y-2">{candidate.missing_source_id && <p className="text-xs text-amber-600">缺少可靠来源记录号；金额相同不证明是同一笔，也不能自动视为不同笔。</p>}
            <Candidates title="经济字段精确相同的已记录事实" values={candidate.exact_event_ids} onPick={!frozen && required.has(row.row) ? value => updateDraft(row.row, { action: "link_existing", event_id: String(value), prior_row: "" }) : undefined} />
            <Candidates title="仅疑似相同的已记录事实（不能直接关联）" values={candidate.possible_event_ids} />
            <Candidates title="经济字段精确相同的前序数据行" values={candidate.exact_prior_rows} onPick={!frozen && required.has(row.row) ? value => updateDraft(row.row, { action: "link_prior_row", prior_row: String(value), event_id: "" }) : undefined} />
            <Candidates title="仅疑似相同的前序数据行（不能直接关联）" values={candidate.possible_prior_rows} />
          </div>}
          {required.has(row.row) && <fieldset disabled={frozen} className="grid min-w-0 gap-3 rounded border border-amber-500/30 p-3 sm:grid-cols-2"><legend className="px-1 text-sm font-medium">此行人工决定</legend>
            <label className={field}>数据行 {row.row} 的处理<select aria-label={`数据行 ${row.row} 的处理`} className={selectClass} value={draft.action} onChange={event => updateDraft(row.row, { action: event.target.value as ResolutionDraft["action"], event_id: "", prior_row: "" })}><option value="">请选择，不自动判定</option>{!onlyLinks.has(row.row) && <option value="record_distinct">已核实为独立事实，按此行记录</option>}{!!candidate?.exact_event_ids.length && <option value="link_existing">关联精确相同的已有事实，不新增</option>}{!!candidate?.exact_prior_rows.length && <option value="link_prior_row">关联精确相同的前行，不新增</option>}</select></label>
            {draft.action === "link_existing" && <label className={field}>精确候选事实标识<Input aria-label={`数据行 ${row.row} 的关联事实`} value={draft.event_id} onChange={event => updateDraft(row.row, { event_id: event.target.value })} placeholder="从精确候选列表选择，或粘贴完整标识" maxLength={160} /></label>}
            {draft.action === "link_prior_row" && <label className={field}>精确候选前行序号<Input aria-label={`数据行 ${row.row} 的关联前行`} type="number" min="1" max={row.row - 1} step="1" value={draft.prior_row} onChange={event => updateDraft(row.row, { prior_row: event.target.value })} /></label>}
            <label className={`${field} sm:col-span-2`}>数据行 {row.row} 的核对依据 / 决定原因<textarea aria-label={`数据行 ${row.row} 的决定原因`} className="min-h-20 min-w-0 rounded-md border bg-background p-3 text-sm" value={draft.reason} maxLength={2000} onChange={event => updateDraft(row.row, { reason: event.target.value })} placeholder="说明你核对的原件、既存事实或为何是独立发生的另一笔；必填。" /></label>
          </fieldset>}
        </article>;
      })}
      {preview.status !== "confirmed" && <label className="flex items-start gap-2 rounded-lg border p-3 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} disabled={frozen} onChange={event => setAcknowledged(event.target.checked)} /><span>我已核对全部分页中的原文、映射与费用/时间/账户含义，知悉这是未获券商格式认证的高级通用映射；逐行决定由我本人作出。</span></label>}
      <div className="flex flex-wrap gap-3">{preview.status !== "confirmed" && <Button type="button" disabled={readOnly || !!busy || (!pendingPayload && !canConfirm)} onClick={() => void confirm()}>{busy === "confirm" ? "正在确认…" : pendingPayload ? "重试完全相同的确认请求" : "确认全部已核对行入账"}</Button>}<Button type="button" variant="outline" disabled={!!busy} onClick={() => void checkStatus()}>核对服务器批次状态</Button><Button type="button" variant="outline" disabled={!!busy} onClick={editAgain}>{preview.status === "confirmed" ? "结束审计展示，准备新预览" : "结束此预览，返回编辑"}</Button></div>
      {pendingPayload && <details className="rounded border p-3 text-sm"><summary className="cursor-pointer">已冻结的原确认请求（重试不改写）</summary><p className="mt-2">仅保存在当前页面内存；离开或刷新后不能保证恢复，不代表服务器尚未入账。</p><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{pendingPayload}</pre></details>}
      {confirmation !== null && <details className="rounded border p-3 text-sm"><summary className="cursor-pointer">本次确认结果与逐行关联</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(confirmation, null, 2)}</pre></details>}
      <p className="text-xs text-muted-foreground">任何关键错误、未完成的必填行或版本冲突都会阻断整批。疑似重复提示不保证穷尽所有重叠文件；确认响应丢失时不要自行换来源号或文件绕过去重。</p>
    </div>}
  </section>;
}
