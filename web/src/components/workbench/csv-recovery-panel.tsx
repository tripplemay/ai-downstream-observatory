"use client";

import { useEffect, useRef, useState } from "react";
import { useSessionBoundary } from "@/components/session-boundary";
import { Button } from "@/components/ui/button";
import type { CsvConfirmationRecoveryDetailResponse, CsvConfirmationRecoveryListResponse, CsvConfirmationRecoverySelector } from "@/server/ledger/csv-confirmation-recovery-types";
import { parseCsvRecoveryDetail, parseCsvRecoveryList } from "./csv-recovery-client";

const message = (error: unknown) => error instanceof Error ? error.message : "恢复记录查询失败";

export function invalidateCsvSession() {
  window.dispatchEvent(new Event("workbench:session-invalidated"));
}

async function readResponse(response: Response): Promise<unknown> {
  if (response.status === 401) { invalidateCsvSession(); throw new Error("登录会话已失效，请重新登录。旧会话请求不会自动恢复到新会话。"); }
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error("恢复响应无法解析，请稍后重新查询；未发送任何确认。"); }
  if (!response.ok) throw new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : `HTTP ${response.status}`);
  return value;
}

export async function verifyCsvSession(binding: string): Promise<void> {
  if (!binding) throw new Error("CSV_RECOVERY_SESSION_REQUIRED");
  const value = await readResponse(await fetch("/api/auth/session", { cache: "no-store" }));
  if (!value || typeof value !== "object" || !("authenticated" in value) || value.authenticated !== true || !("session_binding" in value) || value.session_binding !== binding) {
    invalidateCsvSession(); throw new Error("CSV_RECOVERY_SESSION_CHANGED");
  }
}

export async function fetchCsvRecovery(selector: CsvConfirmationRecoverySelector, binding: string): Promise<CsvConfirmationRecoveryDetailResponse> {
  const params = new URLSearchParams("id" in selector ? { id: selector.id } : { batch: selector.batch_id, payload_hash: selector.payload_hash });
  const value = await readResponse(await fetch(`/api/workbench/csv/recovery?${params}`, { cache: "no-store" }));
  try { return await parseCsvRecoveryDetail(value, binding); }
  catch (error) { if (message(error) === "CSV_RECOVERY_SESSION_CHANGED") invalidateCsvSession(); throw error; }
}

interface Props {
  disabled: boolean;
  refreshKey: number;
  onRestore: (detail: CsvConfirmationRecoveryDetailResponse) => Promise<boolean>;
  onBusyChange: (busy: boolean) => void;
}

export function CsvRecoveryPanel({ disabled, refreshKey, onRestore, onBusyChange }: Props) {
  const session = useSessionBoundary();
  const binding = session?.sessionBinding ?? "", verified = session?.verified === true;
  const [list, setList] = useState<CsvConfirmationRecoveryListResponse | null>(null);
  const [cursor, setCursor] = useState<string | null>(null), [history, setHistory] = useState<(string | null)[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const generation = useRef(0), mounted = useRef(true), request = useRef(false);
  const active = useRef({ binding, verified }); active.current = { binding, verified };
  const current = (token: number) => mounted.current && token === generation.current && active.current.verified && active.current.binding === binding;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    generation.current++; request.current = false; setBusy(false); setList(null); setCursor(null); setHistory([]); setError("");
  }, [binding]);
  useEffect(() => {
    if (!verified) { generation.current++; request.current = false; setBusy(false); setList(null); return; }
    const token = ++generation.current;
    request.current = true; setBusy(true); setList(null); setError("");
    const query = new URLSearchParams({ limit: "20", ...(cursor ? { cursor } : {}) });
    void (async () => {
      try {
        const value = await readResponse(await fetch(`/api/workbench/csv/recovery?${query}`, { cache: "no-store" }));
        const result = parseCsvRecoveryList(value, binding);
        if (current(token)) setList(result);
      } catch (caught) {
        if (current(token)) { setError(message(caught)); if (message(caught) === "CSV_RECOVERY_SESSION_CHANGED") invalidateCsvSession(); }
      } finally { if (current(token)) { request.current = false; setBusy(false); } }
    })();
    return () => { generation.current++; };
  }, [binding, verified, cursor, reload, refreshKey]);
  async function restore(id: string) {
    if (disabled || request.current || !verified) return;
    const token = ++generation.current; request.current = true; setBusy(true); setError("");
    try {
      const detail = await fetchCsvRecovery({ id }, binding);
      if (!current(token) || detail.attempt.id !== id) return;
      await onRestore(detail);
    } catch (caught) { if (current(token)) setError(message(caught)); }
    finally { if (current(token)) { request.current = false; setBusy(false); } }
  }
  return <section className="mt-4 min-w-0 space-y-3 rounded-lg border p-4" aria-busy={busy}>
    <h3 className="font-semibold">本登录会话的确认恢复记录</h3>
    <p className="text-sm text-muted-foreground">已被服务器接收并封存的原确认请求，可在后退、前进或刷新后查询。恢复仅读取，不自动提交；未到达服务器的请求不会凭空出现在这里。浏览器不保存完整请求。</p>
    <p className="text-xs text-muted-foreground">记录是尝试，不是入账证明。批次可能由另一次人工确认完成，以核验后的实际回执为准。退出或会话失效后，新登录不会自动取得旧会话请求。</p>
    {error && <p role="alert" className="break-all text-sm text-red-600">{error}</p>}
    <Button type="button" variant="outline" size="sm" disabled={busy || !verified} onClick={() => setReload(value => value + 1)}>{busy ? "正在核对恢复记录…" : "重新查询服务器恢复记录"}</Button>
    {list?.read_only && <p className="text-sm text-amber-600">恢复只读模式：可查看原请求与回执，仍不能重试入账。</p>}
    {list && !list.attempts.length && <p className="text-sm">本页未发现已封存尝试；这不证明某个在途请求尚未入账。仍须核对对应批次和账本。</p>}
    {list?.attempts.map(item => <article key={item.id} className="min-w-0 space-y-2 rounded border p-3 text-sm">
      <p className="break-all">组合 {item.portfolio_id} / 账户 {item.account_id}</p>
      <p className="break-all">批次 {item.batch_id} · 批次当前状态 {item.batch_status}</p>
      <p className="break-all text-xs text-muted-foreground">尝试 {item.id} · {item.created_at} · {item.payload_bytes} bytes · 原 revision {item.expected_revision} / 当前 {item.current_revision}</p>
      <Button type="button" variant="outline" size="sm" disabled={disabled || busy} onClick={() => void restore(item.id)}>恢复到本页并核对（不提交）</Button>
    </article>)}
    {(history.length > 0 || list?.next_cursor) && <div className="flex flex-wrap items-center gap-3 text-sm">
      <Button type="button" variant="outline" size="sm" disabled={busy || !history.length} onClick={() => { setCursor(history.at(-1) ?? null); setHistory(values => values.slice(0, -1)); }}>前一页恢复记录</Button>
      <span>第 {history.length + 1} 页，每页最多 20 条；不自动跨页加载原请求。</span>
      <Button type="button" variant="outline" size="sm" disabled={busy || !list?.next_cursor} onClick={() => { if (list?.next_cursor) { setHistory(values => [...values, cursor]); setCursor(list.next_cursor); } }}>后一页恢复记录</Button>
    </div>}
  </section>;
}
