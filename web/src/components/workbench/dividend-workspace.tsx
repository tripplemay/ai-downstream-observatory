"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { WorkbenchState } from "@/server/ledger/queries";
import type { DividendWorkspaceState } from "@/server/ledger/dividend-queries";
import type { ImportPreview } from "@/server/ledger/imports";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DIVIDEND_ACTIONS, dividendInput, type DividendAction } from "./dividend-input";

const field = "flex min-w-0 flex-col gap-1.5 text-sm";
const selectClass = "h-10 w-full min-w-0 max-w-full rounded-md border bg-background px-3";
const qualityName = (value: string) => ({ complete: "完整", provisional: "暂估 / 未完全确认", blocked: "阻断" }[value] ?? value);

export function DividendWorkspace({ state, busy: parentBusy, onCommitted }: { state: WorkbenchState; busy: boolean; onCommitted: () => Promise<void> }) {
  const [account, setAccount] = useState(""), [type, setType] = useState<DividendAction>("dividend_accrual");
  const [precision, setPrecision] = useState("date"), [taxStatus, setTaxStatus] = useState(""), [resolution, setResolution] = useState("");
  const [view, setView] = useState<DividendWorkspaceState | null>(null), [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [receipt, setReceipt] = useState("");
  const generation = useRef(0), confirmation = useRef<string | null>(null);
  const accountId = state.accounts.some(row => row.id === account) ? account : state.accounts[0]?.id ?? "";
  const scope = `${state.selected}:${accountId}`, context = `${scope}:${state.revision}`;
  const currentContext = useRef(context); currentContext.current = context;
  const locked = busy || parentBusy || state.read_only;
  async function request(url: string, body?: string) {
    const response = await fetch(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value;
  }
  const viewUrl = `/api/workbench?view=dividends&portfolio=${encodeURIComponent(state.selected ?? "")}&account=${encodeURIComponent(accountId)}&revision=${state.revision}`;
  useEffect(() => { setReceipt(""); }, [scope]);
  useEffect(() => {
    const token = ++generation.current;
    setView(null); setPreview(null); confirmation.current = null; setError(""); setBusy(false);
    if (!state.selected || !accountId) return;
    void request(viewUrl).then(value => { if (generation.current === token) setView(value); })
      .catch(reason => { if (generation.current === token) setError(reason.message); });
    return () => { generation.current++; };
  }, [context, viewUrl, state.selected, accountId]);
  function invalidatePreview() { setPreview(null); confirmation.current = null; }
  async function perform(action: (valid: () => boolean) => Promise<void>) {
    const token = generation.current, captured = context;
    const valid = () => token === generation.current && captured === currentContext.current;
    setBusy(true); setError("");
    try { await action(valid); } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { if (valid()) setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget); invalidatePreview(); setReceipt("");
    void perform(async valid => {
      const command = dividendInput(data, type, accountId);
      const value = await request("/api/workbench", JSON.stringify({ action: "preview_import", portfolio_id: state.selected, account_id: accountId, raw: JSON.stringify([command]) })) as ImportPreview;
      if (!valid()) return;
      setPreview(value);
      confirmation.current = JSON.stringify({ action: "confirm_import", portfolio_id: state.selected, batch_id: value.id, preview_hash: value.preview_hash, expected_revision: value.expected_revision });
    });
  }
  const root = ["dividend_accrual", "dividend", "dividend_net", "corporate_action_notice"].includes(type);
  const hasAmount = ["dividend_accrual", "dividend", "dividend_net", "dividend_payment", "dividend_tax_payment"].includes(type);
  const hasTaxStatus = type === "dividend_accrual" || type === "dividend_tax_assessment";
  const hasTax = type === "dividend" || type === "dividend_breakdown" || (hasTaxStatus && ["estimated", "confirmed"].includes(taxStatus));
  return <section className="min-w-0 rounded-xl border bg-card p-5 shadow-sm">
    <h2 className="text-lg font-semibold">分红、扣税与公司行动</h2>
    <p className="mt-2 text-sm text-muted-foreground">只记已发生并可核实的事实。未知税额不是零税；确认累计税款不代表现金已补扣或退回。合并、清算、返还资本等先隔离核查，不自动归为普通分红。</p>
    {error && <p role="alert" className="mt-3 break-words text-sm text-red-600">{error}</p>}
    {receipt && <p role="status" className="mt-3 break-words text-sm">{receipt}</p>}
    <label className={`${field} mt-4`}>分红核算账户<select className={selectClass} value={accountId} disabled={busy || parentBusy} onChange={event => setAccount(event.target.value)}>{state.accounts.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
    {view && <div className="my-4 rounded-lg border p-3 text-sm"><p className="font-medium">整个组合的事实质量（不替代行情与估值检查）</p><p className="mt-2">净资产：{qualityName(view.quality.nav_quality)} · 税后收益：{qualityName(view.quality.performance_quality)} · 分红归因：{qualityName(view.quality.attribution_quality)}</p><p className="mt-1 text-xs text-muted-foreground">仅知最终净额时，净资产可完整，但税前分红 / 税款归因仍待拆分。暂定净额即使已拆分，也须另行最终税额确认。</p></div>}
    <form onSubmit={submit} onChange={invalidatePreview} className="mt-4">
      <fieldset disabled={locked || !accountId} className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className={`${field} sm:col-span-2`}>分红 / 公司行动事件<select className={selectClass} value={type} onChange={event => { setType(event.target.value as DividendAction); setTaxStatus(""); setResolution(""); }}>
          {Object.entries(DIVIDEND_ACTIONS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label className={field}>事实原币<select name="currency" className={selectClass}><option>CNY</option><option>HKD</option><option>USD</option></select></label>
        {root ? <label className={field}>关联证券（可留空，币种须相同）<select name="listing_id" className={selectClass} defaultValue=""><option value="">未指定证券</option>{state.listings.map(row => <option key={row.id} value={row.id}>{row.market} / {row.ticker} / {row.currency}</option>)}</select></label>
          : <label className={`${field} sm:col-span-2`}>原始分红 / 公司行动通知事件 ID<Input name="related_event_id" required maxLength={200} placeholder="粘贴下方根事件 ID；不要填上一笔扣税确认的 ID" /></label>}
        {hasAmount && <label className={field}>{type === "dividend_net" ? "本次实际到账净额" : type === "dividend_payment" ? "本次实际到账 / 退税金额" : type === "dividend_tax_payment" ? "本次实际补扣税款" : "税前分红总额"}<Input name="amount" inputMode="decimal" required maxLength={80} /></label>}
        {type === "dividend_breakdown" && <label className={field}>原始净额对应的税前总额<Input name="gross_amount" inputMode="decimal" required maxLength={80} /></label>}
        {hasTaxStatus && <label className={field}>累计税额确认状态<select name="tax_status" required className={selectClass} value={taxStatus} onChange={event => setTaxStatus(event.target.value)}><option value="" disabled>请明确选择</option>{type === "dividend_accrual" && <option value="unknown">未知（不填写税额）</option>}<option value="estimated">暂估</option><option value="confirmed">已最终确认</option></select></label>}
        {hasTax && <label className={field}>累计扣税总额（确认免税才填 0）<Input name="tax" inputMode="decimal" required maxLength={80} /></label>}
        {type === "dividend_net" && <label className={field}>净额状态<select name="net_status" required className={selectClass} defaultValue=""><option value="" disabled>请明确选择</option><option value="final">最终净额已核实</option><option value="provisional">暂定净额，可能继续调整</option></select></label>}
        {type === "corporate_action_notice" && <label className={field}>公司行动类型<select name="action_kind" required className={selectClass} defaultValue=""><option value="" disabled>选择通知类型</option><option value="dividend_entitlement">分红权益待确认</option><option value="merger">合并 / 换股</option><option value="liquidation">清算</option><option value="return_of_capital">返还资本</option><option value="other">其他需人工核算事项</option></select></label>}
        {type === "corporate_action_resolution" && <><label className={field}>核实结论<select name="resolution" required className={selectClass} value={resolution} onChange={event => setResolution(event.target.value)}><option value="" disabled>请明确选择</option><option value="not_applicable">核实不适用于本账户</option><option value="recorded">实际经济影响已另行记录</option></select></label>{resolution === "recorded" && <label className={`${field} sm:col-span-2`}>实际经济事实事件 ID（空格或换行分隔）<textarea name="supporting_event_ids" required className="min-h-24 rounded border bg-background p-2 font-mono text-xs" /></label>}<p className="text-sm text-muted-foreground sm:col-span-2">此结论只记录人工核实结果，不自动证明税务或复杂公司行动处理正确；相关经济分录仍需单独核实和录入。</p></>}
        {["dividend_breakdown", "dividend_tax_assessment", "dividend_tax_payment", "corporate_action_notice", "corporate_action_resolution"].includes(type) && <label className={`${field} sm:col-span-2`}>核实凭证引用<Input name="evidence_reference" required maxLength={2000} /></label>}
        <label className={field}>事实时间精度<select name="time_precision" className={selectClass} value={precision} onChange={event => setPrecision(event.target.value)}><option value="date">只有日期</option><option value="second">有 UTC 秒级时点</option></select></label>
        <label className={field}>{precision === "date" ? "事实日期" : "事实 UTC 时点（以 Z 结尾）"}<Input key={precision} name="effective_at" type={precision === "date" ? "date" : "text"} required placeholder={precision === "second" ? "2026-01-02T06:30:00Z" : undefined} /></label>
        <label className={field}>来源时区（IANA）<Input name="source_timezone" required defaultValue="Asia/Shanghai" maxLength={100} /></label>
        <label className={field}>来源系统标识<Input name="source_id" required defaultValue="manual-dividend" maxLength={200} /></label>
        <label className={field}>来源记录号<Input name="source_event_id" required maxLength={200} /></label>
        <label className={`${field} sm:col-span-2`}>事实依据 / 说明<Input name="reason" required maxLength={2000} /></label>
        <p className="text-sm text-muted-foreground sm:col-span-2">预览仅保存原件和校验记录，不保留模拟分录。下面再次确认后才入账；修改字段、账户或账本版本须重新预览。</p>
        <Button className="sm:col-span-2" disabled={locked || !accountId}>预览分红 / 公司行动事实（不入账）</Button>
      </fieldset>
    </form>
    {preview && <div className="mt-4 space-y-3 rounded-lg border p-4 text-sm"><p>预览状态：{preview.status} · 账本版本 {preview.expected_revision}</p>
      {preview.rows.map(row => <div key={row.row}>{row.errors.length ? <p role="alert" className="break-words">{row.errors.join("；")}</p> : <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(row.command, null, 2)}</pre>}</div>)}
      <Button disabled={locked || preview.status !== "preview"} onClick={() => void perform(async valid => {
        const body = confirmation.current;
        if (!body) throw new Error("请重新预览。");
        await request("/api/workbench", body);
        if (!valid()) return;
        setReceipt(`批次 ${preview.id} 已确认入账；请重新对账及估值。`); invalidatePreview();
        await onCommitted();
      })}>确认上述分红 / 公司行动事实入账</Button>
      <p className="text-xs text-muted-foreground">响应丢失不能视为失败；可重试同一批次，发送内容保持不变，不重复入账。版本冲突时重新加载账户后再预览。</p>
    </div>}
    <div className="mt-5 border-t pt-4"><h3 className="font-medium">当前账户的有效根事件</h3><p className="mt-1 text-sm text-muted-foreground">每页最多 100 条；包含已结清记录。应付税款以负数表示，不能再次当作可用现金。</p>
      {view?.rows.length === 0 && <p className="mt-3 text-sm">尚无分红或公司行动事实。</p>}
      {view?.rows.map(row => <div key={row.id} className="mt-3 break-words rounded-lg border p-3 text-sm"><p>{row.event_type} · {row.effective_at} · {row.command.fact.currency}</p><p className="mt-1 break-all font-mono text-xs">{row.id}</p>
        {row.dividend ? <><p className="mt-2">税前 {row.dividend.gross_amount ?? "未知"} · 累计扣税 {row.dividend.tax_status === "unknown" ? "未知" : row.dividend.tax}（{row.dividend.tax_status}）</p><p>净现金 {row.dividend.net_cash} · 应收 {row.dividend.receivable} · 应付税款 {row.dividend.tax_payable}</p>{row.dividend.net_status && <p>原始净额状态 {row.dividend.net_status} · 最终税额确认 {row.dividend.assessment_confirmed ? "已记录" : "无独立确认"}</p>}</>
          : <p className="mt-2">{row.command.fact.action_kind} · {row.resolution ? "已有核实结论；以质量时点证据为准" : "待核实，阻断净资产与收益确认"}</p>}
      </div>)}
      {view?.next_cursor !== null && view?.next_cursor !== undefined && <Button className="mt-3" variant="outline" disabled={busy || parentBusy} onClick={() => void perform(async valid => { const value = await request(`${viewUrl}&before=${view.next_cursor}`) as DividendWorkspaceState; if (valid()) setView(value); })}>查看更早的 100 条根事件</Button>}
      {view && <Button className="ml-2 mt-3" variant="outline" disabled={busy || parentBusy} onClick={() => void perform(async valid => { const value = await request(viewUrl); if (valid()) setView(value); })}>重新加载最新记录</Button>}
    </div>
  </section>;
}
