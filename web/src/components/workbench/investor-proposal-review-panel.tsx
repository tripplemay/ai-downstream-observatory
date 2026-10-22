"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import type { ProposalReviewContext, ProposalReviewIntent } from "@/server/investor/proposal-review-schemas";
import type { ValuationScope } from "./investor-valuation-client";
import { useInvestorDisplayClock } from "./investor-display-clock";
import { buildProposalReview, parseProposalReview, proposalConsequences, proposalOperationLabels, proposalRiskMessage } from "./investor-proposal-review-client";

const field = "flex min-w-0 flex-col gap-2 text-sm", select = "h-11 w-full min-w-0 rounded-lg border bg-background px-3";
export function InvestorProposalReviewPanel({ scope, disabled, onCommand, onDraftLockChange }: {
  scope: ValuationScope; disabled: boolean; onCommand: (intent: Record<string, unknown>) => void; onDraftLockChange: (locked: boolean) => void;
}) {
  const key = JSON.stringify(scope), session = useSessionBoundary();
  const [reading, setReading] = useState<{ key: string; context: ProposalReviewContext } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [operation, setOperation] = useState(""), [note, setNote] = useState(""), [acknowledged, setAcknowledged] = useState(false);
  const active = useRef<AbortController | null>(null), epoch = useRef(0), alive = useRef(true), invalidated = useRef(false), submitting = useRef(false);
  const verified = session?.verified === true && session.sessionBinding === scope.binding && !invalidated.current;
  const current = useRef({ key, scope, verified, disabled }); current.current = { key, scope, verified, disabled };
  const context = verified && !disabled && reading?.key === key ? reading.context : null, selected = context?.selected;
  const clock = useInvestorDisplayClock(context?.checked_at ?? null, selected ? String(Date.parse(selected.expires_at)) : "");
  const clockNow = useRef(clock); clockNow.current = clock;
  const expired = !!selected && Date.parse(selected.expires_at) <= clock;
  function clear() { epoch.current++; active.current?.abort(); active.current = null; submitting.current = false;
    setReading(null); setBusy(false); setError(""); setOperation(""); setNote(""); setAcknowledged(false); }
  useEffect(() => {
    alive.current = true;
    const invalidate = () => { invalidated.current = true; clear(); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => { alive.current = false; epoch.current++; active.current?.abort(); window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); };
  }, []);
  useEffect(() => { clear(); }, [key]);
  useEffect(() => { if (!verified) clear(); }, [verified]);
  useEffect(() => { onDraftLockChange(verified && (busy || !!reading?.context.selected)); }, [verified, busy, reading, onDraftLockChange]);
  useEffect(() => () => onDraftLockChange(false), [onDraftLockChange]);
  useEffect(() => {
    if (!selected) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const navigate = (event: MouseEvent) => { if (event.target instanceof Element && event.target.closest("a[href]")
      && !window.confirm("清单复核草稿只保存在本页。离开不会撤回已受理指令或券商订单。确定离开吗？")) { event.preventDefault(); event.stopPropagation(); } };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [!!selected]);
  async function read(proposalId: string | null = null) {
    const start = current.current; if (start.key !== key || !start.verified || start.disabled || active.current) return;
    const controller = new AbortController(), sequence = ++epoch.current; active.current = controller;
    setBusy(true); setReading(null); setError(""); setOperation(""); setNote(""); setAcknowledged(false);
    const timer = setTimeout(() => controller.abort(), 20000);
    const valid = () => alive.current && !invalidated.current && epoch.current === sequence && current.current.key === start.key && current.current.verified && !current.current.disabled;
    try {
      const response = await fetch("/api/workbench/investor/proposal-review" + (proposalId ? "?proposal=" + encodeURIComponent(proposalId) : ""), {
        cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal, headers: { "X-Workbench-Session-Binding": start.scope.binding } });
      if (!valid()) return;
      if (response.status === 401) { window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT)); return; }
      if (!response.ok) throw new Error();
      const value = parseProposalReview(await response.json(), start.scope, proposalId);
      if (valid()) { setReading({ key: start.key, context: value }); submitting.current = false; }
    } catch { if (valid()) setError("清单未通过当前账本范围或证据核验。请重新核对账户资料；不把历史研究或旧批准当作现在可执行。"); }
    finally { controller.abort(); clearTimeout(timer); if (active.current === controller) { active.current = null; if (alive.current) setBusy(false); } }
  }
  function editable() { return current.current.key === key && current.current.verified && !current.current.disabled && !submitting.current; }
  function submit(event: FormEvent) {
    event.preventDefault(); if (!editable() || !context || !selected || busy || submitting.current) return;
    try {
      const input = buildProposalReview(context, operation, note, acknowledged, Math.max(clockNow.current, Date.now()));
      submitting.current = true; setReading(null); setOperation(""); setNote(""); setAcknowledged(false); onDraftLockChange(false); onCommand(input);
    } catch { setError("请选择当前允许的步骤并重新确认影响；到期或输入变化后须重新读取，不沿用旧的通过记录。"); }
  }
  const options = selected?.allowed_operations.filter(op => !expired || ["cancel_remainder", "expire"].includes(op)) ?? [];
  const chosen = operation as ProposalReviewIntent["operation"];
  return <section aria-label="账户级清单复核" className="min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6">
    <h2 className="text-lg font-semibold">账户级待审与执行前复核（可选）</h2>
    <p className="mt-3 text-sm text-muted-foreground">这里只核对本账本已生成的账户级清单，不把研究权重或“采纳思路”转成交易指令。全部门槛通过后仍由你明确批准，并自行在券商交易；系统不下单。</p>
    <Button className="mt-4" type="button" variant="outline" disabled={disabled || busy || !verified} onClick={() => void read()}>核对账户级待审清单</Button>
    {busy && <p role="status" className="mt-3 text-sm">正在只读核对清单、风控和预占，不提交订单。</p>}
    {error && <p role="alert" className="mt-3 break-words text-sm text-red-600">{error}</p>}
    {context && !context.proposals.length && <p className="mt-4 text-sm">当前没有待审或仍有剩余预占的账户级清单。研究方案仍可独立观察；这里不会补造目标、现金、策略准入或订单。</p>}
    {context && context.proposals.length > 0 && <label className={`${field} mt-4`}>选择整张账户级清单<select className={select} value={selected?.id ?? ""} disabled={busy || disabled || !verified} onChange={event => { if (editable()) void read(event.target.value || null); }}>
      <option value="">请按来源核对，不自动选择</option>{context.proposals.map(row => <option key={row.id} value={row.id}>{row.created_at} · {row.id.slice(0, 12)} · {row.has_active_reservations ? "存在剩余预占" : "未预占"}</option>)}</select></label>}
    {context && selected && <div className="mt-5 min-w-0 space-y-4">
      <p className="break-words rounded-lg border p-3 text-sm">本清单覆盖整个账本，不只限于上方选中的回录账户。核对时点 {context.checked_at}；清单有效期 {selected.expires_at}。提交时再次核对，不保证旧通过记录稍后仍有效。</p>
      {expired && <p role="status" className="text-sm text-amber-700">清单有效期已到，旧结果不能继续批准或执行。请重新读取，核对仍需释放的剩余预占。</p>}
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">{selected.items.map(item => <article key={item.id} className="min-w-0 break-words rounded-lg border p-3 text-sm">
        <h3 className="font-medium">{item.ticker} · {item.side === "buy" ? "买入" : "卖出"} {item.quantity}</h3><p className="mt-2">{item.account_name} · {item.market} · {item.currency}</p>
        <p className="mt-2">原清单限价 {item.limit_price} · 原预计费用 {item.estimated_fees} {item.currency}（不是实时价格）</p>
        {selected.reservations.filter(row => row.proposal_item_id === item.id).map(row => <p className="mt-2" key={row.id}>工作台预占：数量 {row.quantity}，金额 {row.amount} {row.currency} · {row.status === "active" ? "有效剩余" : "已释放或已核销"}，不是实际持仓或成交。</p>)}
      </article>)}</div>
      <div className="min-w-0 rounded-lg border p-3 text-sm"><p className="font-medium">本次只读复核：{selected.current_risk.status === "pass" ? "核对时通过" : "受阻"}（没有因此登记新批准或发送订单）</p>
        <ul className="mt-3 space-y-2">{selected.current_risk.checks.map((check, index) => <li key={index}>{proposalRiskMessage(check.code)}</li>)}</ul>
        <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">原始风控标识与版本</summary><p className="mt-2 break-all">{selected.current_risk.checks.map(check => check.code).join(" / ")}</p><p className="mt-2 break-all">政策 {selected.policy_version_id} · 策略 {selected.strategy_version_id}</p></details>
        {selected.recorded_risk && <p className="mt-3">最近记录风控：{selected.recorded_risk.created_at} · {selected.recorded_risk.status === "pass" ? "通过" : "受阻"} · {selected.recorded_risk.matches_current ? "与本次核对输入相同" : "输入已变化，不能沿用"}</p>}
        {selected.approval && <p className="mt-3">原人工批准：{selected.approval.created_at}。批准及预占不是成交。</p>}
        {selected.preparation && <p className="mt-3">最近执行前复核：{selected.preparation.created_at}。该记录不是订单，也不保证现在仍可执行。</p>}
      </div>
      <form onSubmit={submit} className="min-w-0 space-y-4"><fieldset className="min-w-0 space-y-4" disabled={disabled || busy || context.read_only}>
        <label className={field}>本次只执行哪一步<select className={select} required value={operation} onChange={event => { if (editable()) { setOperation(event.target.value); setAcknowledged(false); } }}>
          <option value="">请明确选择，不自动批准</option>{options.map(op => <option key={op} value={op}>{proposalOperationLabels[op]}</option>)}</select></label>
        {operation && <p className="rounded-lg border p-3 text-sm">{proposalConsequences[chosen]}</p>}
        <label className={field}>复核备注（可选）<textarea maxLength={1000} className="min-h-20 min-w-0 rounded-lg border bg-background p-3" value={note} onChange={event => { if (editable()) { setNote(event.target.value); setAcknowledged(false); } }} /></label>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} onChange={event => { if (editable()) setAcknowledged(event.target.checked); }} />我已核对整张清单、涉及账户和本步骤影响。系统不会向券商下单或撤单，不把批准、复核或预占当作成交。</label>
        <Button disabled={!operation || !acknowledged || !options.includes(chosen)}>确认此步骤，不发送券商订单</Button>
      </fieldset></form>
      <Button type="button" variant="outline" disabled={disabled || busy || !verified} onClick={() => { if (editable()) clear(); }}>关闭并清除本地复核草稿</Button>
    </div>}
  </section>;
}
