"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import type { ExecutionFollowupContext } from "@/server/investor/execution-followup-schemas";
import type { ReconciliationScope } from "./investor-reconciliation-client";
import { blankExecutionDraft, buildExecutionFollowup, executionDeviationMessage, executionUploadForm, parseExecutionEvidenceReceipt, parseExecutionFollowup,
  prepareExecutionUpload, type EvidenceUpload, type ExecutionDraft } from "./investor-execution-followup-client";

const field = "flex min-w-0 flex-col gap-2 text-sm", select = "h-11 w-full min-w-0 rounded-lg border bg-background px-3";
const statusLabels = { submitted: "已提交", partial: "部分成交回报", filled: "全部成交回报", cancelled: "已撤销", rejected: "已拒绝" };
function deviationDetails(codes: string[]) {
  return codes.length ? <div className="mt-2"><ul className="space-y-1">{codes.map(code => <li key={code}>{executionDeviationMessage(code)}</li>)}</ul>
    <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">原始偏离标识</summary><p className="mt-2 break-all">{codes.join(" / ")}</p></details></div>
    : <p className="mt-2">无已登记偏离；这不是交易合规认证。</p>;
}
export function InvestorExecutionFollowupPanel({ scope, disabled, onCommand, onDraftLockChange }: {
  scope: ReconciliationScope; disabled: boolean; onCommand: (intent: Record<string, unknown>) => void; onDraftLockChange: (locked: boolean) => void;
}) {
  const session = useSessionBoundary(), key = JSON.stringify(scope);
  const [reading, setReading] = useState<{ key: string; context: ExecutionFollowupContext } | null>(null);
  const [draft, setDraft] = useState<ExecutionDraft | null>(null), [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState<EvidenceUpload | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = useRef<AbortController | null>(null), epoch = useRef(0), alive = useRef(true), invalidated = useRef(false), submitting = useRef(false);
  const verified = session?.verified === true && session.sessionBinding === scope.binding && !invalidated.current;
  const current = useRef({ key, scope, verified, disabled }); current.current = { key, scope, verified, disabled };
  const context = verified && !disabled && reading?.key === key ? reading.context : null;
  function clear() {
    epoch.current++; active.current?.abort(); active.current = null; submitting.current = false;
    setReading(null); setDraft(null); setFile(null); setPending(null); setBusy(false); setError("");
  }
  useEffect(() => {
    alive.current = true;
    const invalidate = () => { invalidated.current = true; clear(); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => { alive.current = false; epoch.current++; active.current?.abort(); window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); };
  }, []);
  useEffect(() => { clear(); }, [key]);
  useEffect(() => { if (!verified) clear(); }, [verified]);
  useEffect(() => { onDraftLockChange(verified && (busy || draft !== null || pending !== null)); }, [verified, busy, draft, pending, onDraftLockChange]);
  useEffect(() => () => onDraftLockChange(false), [onDraftLockChange]);
  useEffect(() => {
    if (!draft && !pending) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => { if (event.target instanceof Element && event.target.closest("a[href]")
      && !window.confirm("执行跟进草稿或原件回执仍待核对。离开会丢失本地请求；已存证原件不会被删除。确定离开吗？")) { event.preventDefault(); event.stopPropagation(); } };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [draft !== null || pending !== null]);
  function valid(sequence: number, initialKey: string) {
    return alive.current && !invalidated.current && epoch.current === sequence && current.current.key === initialKey && current.current.verified && !current.current.disabled;
  }
  async function read(controller: AbortController, start: typeof current.current, sequence: number) {
    const response = await fetch(`/api/workbench/investor/execution-followup?account=${encodeURIComponent(start.scope.accountId)}`, {
      cache: "no-store", credentials: "same-origin", redirect: "error", headers: { "X-Workbench-Session-Binding": start.scope.binding }, signal: controller.signal });
    if (!valid(sequence, start.key)) return null;
    if (response.status === 401) { window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); return null; }
    if (!response.ok) throw new Error();
    const value = parseExecutionFollowup(await response.json(), start.scope);
    return valid(sequence, start.key) ? value : null;
  }
  async function begin(mode: ExecutionDraft["mode"] | null) {
    const start = current.current; if (!start.verified || start.disabled || active.current || draft || pending) return;
    const controller = new AbortController(), sequence = ++epoch.current;
    active.current = controller; setBusy(true); setReading(null); setError("");
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const value = await read(controller, start, sequence); if (!value) return;
      if (mode && (value.read_only || value.account_status === "disabled")) throw new Error();
      setReading({ key: start.key, context: value }); setDraft(mode ? blankExecutionDraft(mode) : null); submitting.current = false;
    } catch { if (valid(sequence, start.key)) setError("执行记录未通过当前范围核验。请先刷新账户资料；不会把旧清单或缺少回报当作可执行或已成交。"); }
    finally { controller.abort(); clearTimeout(timer); if (active.current === controller) { active.current = null; if (alive.current) setBusy(false); } }
  }
  function editable() { return current.current.key === key && current.current.verified && !current.current.disabled && !invalidated.current; }
  function edit(patch: Partial<ExecutionDraft>) { if (!editable()) return; setDraft(value => value ? { ...value, ...patch, acknowledged: false } : value); setError(""); }
  async function upload() {
    const start = current.current;
    if (start.key !== key || !start.verified || start.disabled || active.current || !context || !draft || !file && !pending) return;
    const controller = new AbortController(), sequence = ++epoch.current; active.current = controller; setBusy(true); setError("");
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const request = pending ?? await prepareExecutionUpload(context, file!, crypto.randomUUID());
      if (!valid(sequence, start.key)) return;
      setPending(request);
      const response = await fetch("/api/workbench/investor/execution-evidence", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { "X-Workbench-Session-Binding": start.scope.binding }, body: executionUploadForm(request), signal: controller.signal });
      if (!valid(sequence, start.key)) return;
      if (response.status === 401) { window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); return; }
      if (!response.ok) throw new Error();
      const receipt = parseExecutionEvidenceReceipt(await response.json(), request, start.scope.binding);
      if (!valid(sequence, start.key)) return;
      const updated = await read(controller, start, sequence);
      if (!updated || !updated.evidence.some(row => row.id === receipt.attachment_id && row.content_hash === receipt.content_hash)) throw new Error();
      setReading({ key: start.key, context: updated }); setPending(null); setFile(null);
      setDraft(value => value ? { ...value, evidence: receipt.attachment_id, acknowledged: false } : value);
    } catch { if (valid(sequence, start.key)) setError("原件上传尚未完成核对。只重试原文件和原请求；不要因此重复回录成交。取消草稿不会删除已存证原件。"); }
    finally { controller.abort(); clearTimeout(timer); if (active.current === controller) { active.current = null; if (alive.current) setBusy(false); } }
  }
  function submit(event: FormEvent) {
    event.preventDefault(); if (!editable() || !context || !draft || busy || pending || disabled || !verified || submitting.current) return;
    try {
      const input = buildExecutionFollowup(context, draft); submitting.current = true;
      setDraft(null); setReading(null); setFile(null); onDraftLockChange(false); onCommand(input);
    } catch { submitting.current = false; setError("请明确选择清单明细、同方向同证券的已入账成交及独立原件。回报须填写实际来源和数量，并重新确认；不从计划数量代填。"); }
  }
  const locked = !context || !verified || disabled || busy || !!pending || context.read_only || context.account_status === "disabled";
  const item = context?.items.find(row => row.id === draft?.item), fact = context?.facts.find(row => row.event_id === draft?.fact);
  return <section aria-label="人工执行跟进" className="min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6">
    <h2 className="text-lg font-semibold">2c · 清单与人工执行跟进（可选）</h2>
    <p className="mt-3 text-sm text-muted-foreground">这里只核对已存在的历史清单。它不是当前交易授权，不批准、不提交券商订单；无清单时不自动生成。先回录已发生成交，再由你明确关联；券商状态回报单独保存，不能代替成交或现金交收。</p>
    {error && <p role="alert" className="mt-4 break-words text-sm text-red-600">{error}</p>}
    {busy && <p role="status" className="mt-3 text-sm">正在核对记录或原件回执，不发出交易。</p>}
    {!draft && <div className="mt-4 flex flex-wrap gap-3"><Button variant="outline" disabled={disabled || busy || !verified} onClick={() => void begin(null)}>核对执行记录</Button>
      <Button variant="outline" disabled={disabled || busy || !verified} onClick={() => void begin("link")}>关联已入账成交</Button>
      <Button variant="outline" disabled={disabled || busy || !verified} onClick={() => void begin("report")}>登记券商状态回报</Button></div>}
    {context && !context.items.length && <p className="mt-4 text-sm">本账户没有可核对的既有清单。普通成交仍可在上方独立回录；研究方案、采纳思路或计划资金不会自动生成清单。</p>}
    {draft && context && <form onSubmit={submit} className="mt-5 space-y-4">
      <fieldset disabled={locked} className="min-w-0 space-y-4">
        <label className={field}>对应的历史清单明细<select className={select} required value={draft.item} onChange={event => edit({ item: event.target.value, fact: "" })}><option value="">请按原清单核对，不自动匹配</option>{context.items.map(row => <option key={row.id} value={row.id}>{row.ticker} · {row.market} · {row.side === "buy" ? "买入" : "卖出"} · 原数量 {row.quantity} · {row.created_at} · {row.id.slice(0, 8)}</option>)}</select></label>
        {item && <p className="break-words rounded-lg border p-3 text-sm">历史限价 {item.limit_price} {item.currency} · 原预计费用 {item.estimated_fees} · 原有效期 {item.expires_at}。仅复核历史，不代表现在仍可执行；不会代填实际成交价格或数量。</p>}
        {draft.mode === "link" ? <label className={field}>已经入账的实际成交<select className={select} required value={draft.fact} onChange={event => edit({ fact: event.target.value })}><option value="">请先选择清单，再核对已记事实</option>{context.facts.filter(row => item && row.listing_id === item.listing_id && row.side === item.side && row.currency === item.currency
          && (!row.link || row.link.proposal_item_id === item.id)).map(row => <option key={row.event_id} value={row.event_id}>{row.effective_at} · 数量 {row.quantity} · 本金 {row.consideration} {row.currency} · {row.source_id}/{row.source_event_id ?? "无编号"}{row.link ? " · 已关联" : ""}</option>)}</select></label>
          : <div className="grid gap-4 sm:grid-cols-2"><label className={field}>原回报状态<select className={select} required value={draft.status} onChange={event => edit({ status: event.target.value })}><option value="">请按原件选择</option>{Object.entries(statusLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
            <label className={field}>原回报数量（不是新增成交数量）<Input required inputMode="decimal" maxLength={80} value={draft.quantity} onChange={event => edit({ quantity: event.target.value })} /></label>
            <label className={field}>来源标识<Input required maxLength={120} value={draft.source} onChange={event => edit({ source: event.target.value })} /></label>
            <label className={field}>原回报唯一编号<Input required maxLength={120} value={draft.sourceEvent} onChange={event => edit({ sourceEvent: event.target.value })} /></label>
            <label className={`${field} sm:col-span-2`}>原回报说明<Input required maxLength={500} value={draft.reason} onChange={event => edit({ reason: event.target.value })} /></label></div>}
        <label className={field}>独立原件（关联时重核字节和账户范围）<select className={select} required value={draft.evidence} onChange={event => edit({ evidence: event.target.value })}><option value="">请核对确实支持本次记录的原件</option>{context.evidence.map(row => <option key={row.id} value={row.id}>{row.media_type === "text/csv" ? "CSV" : "JSON"} · {row.created_at} · {row.content_hash.slice(0, 16)} · {row.byte_size} 字节</option>)}</select></label>
      </fieldset>
      <div className="min-w-0 rounded-lg border p-3"><label className={field}>存证另一份 UTF-8 CSV / JSON 原件（最多 4 MiB）<Input key={pending?.idempotency_key ?? "new-execution-original"} type="file" accept=".csv,.json" disabled={disabled || busy || !!pending || !verified || context.read_only} onChange={event => { if (!editable()) return; setFile(event.target.files?.[0] ?? null); edit({}); }} /></label>
        <p className="mt-2 text-xs text-muted-foreground">保留原始字节，不解析或导入金融事实；没有券商格式认证。请勿上传密钥或 Token。原件不发送给 AI。</p>
        <Button className="mt-3" type="button" variant="outline" disabled={disabled || busy || !verified || context.read_only || !file && !pending} onClick={() => void upload()}>{pending ? "核对并重试原件上传原请求" : "仅存证此原件，不导入事实"}</Button>
      </div>
      <fieldset disabled={locked} className="min-w-0 space-y-4">
        {fact && draft.mode === "link" && <p className="break-words text-sm">所选已记事实：数量 {fact.quantity}，本金 {fact.consideration}，费用 {fact.fee} {fact.currency}。关联不重复入账、不自动结算；仅对剩余预占核销一次，并保留迟到、限价或版本偏离。</p>}
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={draft.acknowledged} onChange={event => { if (editable()) setDraft(value => value ? { ...value, acknowledged: event.target.checked } : value); }} />我已逐项核对清单、账户、证券、方向及独立原件。{draft.mode === "link" ? "只关联既有事实，不创建成交或交易批准。" : "这是状态回报，即使标为全部成交也不生成持仓、现金或核销预占。"}</label>
        <Button disabled={locked || !draft.acknowledged}>{draft.mode === "link" ? "确认关联已入账成交" : "仅保存券商状态回报"}</Button>
      </fieldset>
      <Button type="button" variant="outline" onClick={clear}>取消并清除本地草稿（不删除原件）</Button>
    </form>}
    {draft && !context && <div className="mt-4"><p role="status" className="text-sm">当前登录或范围待核对，不展示旧账户的执行资料。</p><Button type="button" variant="outline" className="mt-3" onClick={clear}>取消并清除本地草稿</Button></div>}
    {context && <details className="mt-5 min-w-0"><summary className="cursor-pointer text-sm">已登记的关联与回报（不是当前行动建议）</summary><div className="mt-3 space-y-3 break-words text-sm">
      {context.facts.filter(row => row.link).map(row => <article className="rounded-lg border p-3" key={row.event_id}><p>已记成交 {row.source_id}/{row.source_event_id ?? row.event_id} · 关联时间 {row.link!.recorded_at}</p><p className="mt-2">{row.link!.consumed ? "本次关联曾核销剩余预占，不代表现金已交收。" : "本次关联未核销预占；没有复活旧资源。"}</p>{deviationDetails(row.link!.deviations)}</article>)}
      {context.reports.map(row => <article className="rounded-lg border p-3" key={row.id}><p>{context.items.find(item => item.id === row.proposal_item_id)?.ticker} · {statusLabels[row.status]} · 回报数量 {row.reported_quantity} · {row.recorded_at}</p><p className="mt-2">来源 {row.source_id}/{row.source_event_id} · {row.reason}</p><p className="mt-2">非成交事实，不计持仓或收益。</p>{deviationDetails(row.deviations)}</article>)}
      {!context.reports.length && !context.facts.some(row => row.link) && <p>尚无已登记的执行关联或状态回报；不能据此推定没有在券商交易。</p>}
    </div></details>}
  </section>;
}
