"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionBoundary } from "@/components/session-boundary";
import { SESSION_INVALIDATED_EVENT } from "@/components/session-boundary-state";
import type { InvestorState } from "@/server/investor/types";
import type { InvestorAccountWorkspace as AccountData } from "@/server/investor/account-schemas";
import type { CsvScope } from "./csv-workspace-state";
import { CsvBackgroundWorkspace } from "./csv-background-workspace";
import { parseInvestorAccounts } from "./investor-accounts-client";
import { InvestorHoldingsPanel } from "./investor-holdings-panel";
import { InvestorReconciliationPanel } from "./investor-reconciliation-panel";
import { InvestorTradeRecordingPanel } from "./investor-trade-recording-panel";

const panel = "min-w-0 rounded-2xl border bg-card p-5 shadow-sm md:p-6";
const field = "flex min-w-0 flex-col gap-2 text-sm";
const select = "h-11 w-full min-w-0 rounded-lg border bg-background px-3";
const statusNames = { active: "对账状态为可用（不等于可交易）", reconciliation_required: "待独立对账", disabled: "已停用" };
function AccountFields() {
  return <><label className={field}>账户别名<Input name="name" required maxLength={120} autoComplete="off" /></label>
    <label className={field}>券商名称<Input name="broker" required maxLength={120} autoComplete="off" /></label>
    <label className={field}>基础币种<select name="currency" className={select}><option>CNY</option><option>HKD</option><option>USD</option></select></label></>;
}

export function InvestorAccountWorkspace({ state, binding, disabled, onCommand, onScopeLockChange }: {
  state: InvestorState; binding: string; disabled: boolean; onCommand: (intent: Record<string, unknown>) => void; onScopeLockChange: (locked: boolean) => void;
}) {
  const session = useSessionBoundary();
  const [data, setData] = useState<AccountData | null>(null), [error, setError] = useState("");
  const [dataValid, setDataValid] = useState(false);
  const [reconciliationLocked, setReconciliationLocked] = useState(false);
  const [tradeLocked, setTradeLocked] = useState(false);
  const [busy, setBusy] = useState(false), [csvLocked, setCsvLocked] = useState(false), [accountId, setAccountId] = useState(""), [bookChoice, setBookChoice] = useState("");
  const active = useRef<AbortController | null>(null), epoch = useRef(0), alive = useRef(true), invalidated = useRef(false);
  const current = useRef({ state, session }); current.current = { state, session };
  const verified = session?.verified === true && session.sessionBinding === binding && !invalidated.current;
  const fresh = !!data && data.workspace_id === state.workspace_id && data.workspace_revision === state.revision;
  const visible = verified && fresh && dataValid;
  const retained = fresh && !invalidated.current;
  const book = retained ? data.books.find(row => row.id === data.link?.document.portfolio_id) : undefined;
  const selectedAccount = retained ? data.accounts.find(row => row.id === accountId) : undefined;
  const locked = disabled || busy || csvLocked || reconciliationLocked || tradeLocked || !visible || data.read_only;

  const refresh = useCallback(async () => {
    const context = current.current;
    if (!context.session?.verified || context.session.sessionBinding !== binding || invalidated.current) return;
    active.current?.abort();
    const controller = new AbortController(), sequence = ++epoch.current;
    active.current = controller; setBusy(true); setError("");
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/workbench/investor/accounts", { cache: "no-store", credentials: "same-origin", redirect: "error",
        headers: { "X-Workbench-Session-Binding": binding }, signal: controller.signal });
      if (!alive.current || invalidated.current || sequence !== epoch.current || !current.current.session?.verified
        || current.current.session.sessionBinding !== binding || current.current.state.revision !== context.state.revision) return;
      if (response.status === 401) {
        window.dispatchEvent(new CustomEvent(SESSION_INVALIDATED_EVENT));
        throw new Error("INVESTOR_ACCOUNT_RESPONSE_INVALID");
      }
      if (!response.ok) throw new Error("INVESTOR_ACCOUNTS_UNAVAILABLE");
      const result = parseInvestorAccounts(await response.json(), { binding, workspace: context.state.workspace_id, revision: context.state.revision });
      if (!alive.current || invalidated.current || sequence !== epoch.current || !current.current.session?.verified
        || current.current.session.sessionBinding !== binding || current.current.state.revision !== context.state.revision) return;
      setData(result);
      setDataValid(true);
      setAccountId(previous => result.accounts.some(row => row.id === previous) ? previous : result.accounts[0]?.id ?? "");
      setBookChoice(previous => result.books.some(row => row.id === previous) ? previous : "");
    } catch (failure) {
      if (alive.current && !invalidated.current && sequence === epoch.current) {
        // Keep the CSV component mounted after a failed refresh: its unresolved request must survive.
        setError("账户资料读取未通过核验。请先刷新顶部研究状态，再核对账户；不要因刷新失败重复导入。");
        setDataValid(false);
        throw failure;
      }
    } finally {
      clearTimeout(timer);
      if (active.current === controller) { active.current = null; if (alive.current) setBusy(false); }
    }
  }, [binding]);
  useEffect(() => {
    alive.current = true;
    const invalidate = () => { invalidated.current = true; epoch.current++; active.current?.abort(); setData(null); setDataValid(false); setAccountId(""); setBookChoice(""); setError(""); setBusy(false); };
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => { alive.current = false; epoch.current++; active.current?.abort(); window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate); };
  }, []);
  useEffect(() => {
    if (!verified) { epoch.current++; active.current?.abort(); setBusy(false); return; }
    if (!csvLocked && !reconciliationLocked && !tradeLocked) void refresh().catch(() => {});
    return () => { epoch.current++; active.current?.abort(); };
  }, [verified, state.workspace_id, state.revision, refresh]);
  useEffect(() => { onScopeLockChange(verified && (busy || csvLocked || reconciliationLocked || tradeLocked)); }, [verified, busy, csvLocked, reconciliationLocked, tradeLocked, onScopeLockChange]);
  useEffect(() => () => onScopeLockChange(false), [onScopeLockChange]);

  function submitAccount(event: FormEvent<HTMLFormElement>, createBook: boolean) {
    event.preventDefault(); if (locked || !state.profile) return;
    const form = new FormData(event.currentTarget), account = { name: String(form.get("name") ?? ""), broker: String(form.get("broker") ?? ""), currency: String(form.get("currency") ?? "") };
    if (createBook) onCommand({ action: "create_account_book", book_name: String(form.get("book_name") ?? ""), account });
    else if (book) onCommand({ action: "add_linked_account", portfolio_id: book.id, expected_ledger_revision: book.ledger_revision, account });
  }
  async function restoreScope(scope: CsvScope) {
    if (!book || scope.portfolioId !== book.id || !data?.accounts.some(row => row.id === scope.accountId))
      throw new Error("恢复请求不属于当前关联账本。请保留原请求，先在正确账本中核对，不会自动更换关联。");
    await refresh(); setAccountId(scope.accountId);
  }
  return <>
    <section className={panel}><h2 className="text-lg font-semibold">账户导入是可选的</h2><p className="mt-3 text-sm text-muted-foreground">不导入账户也能研究和观察参考组合。这里先建档、再预览流水；只有你明确确认导入，已发生的事实才会入账。不会连接券商下单。</p>
      <ol className="mt-4 grid gap-3 text-sm sm:grid-cols-3"><li className="rounded-xl border p-3">1 · 选择私有账本与账户</li><li className="rounded-xl border p-3">2 · 导入流水或逐笔回录已发生事实</li><li className="rounded-xl border p-3">3 · 录入独立资料，对账后看对照</li></ol>
      {!state.profile && <p className="mt-4 text-sm">先在<Link className="underline" href="/workbench">总览</Link>保存研究偏好；账户仍可不建立。</p>}
      {error && <p role="alert" className="mt-4 break-words text-sm text-red-600">{error}</p>}
      <Button className="mt-4" variant="outline" disabled={!verified || busy || csvLocked || reconciliationLocked || tradeLocked || disabled} onClick={() => void refresh().catch(() => {})}>核对账户资料</Button>
      {!visible && <p role="status" className="mt-3 text-sm text-muted-foreground">正在核对当前登录与研究版本；不显示缓存中的账户资料。</p>}
    </section>
    {retained && state.profile && <div hidden={!verified} inert={!verified} style={{ display: verified ? undefined : "none" }} className="flex min-w-0 flex-col gap-6">
      {!dataValid && <p role="status" className="rounded-xl border p-4 text-sm">以下仅保留上次读取的账户范围，以免丢失未决导入请求；新的建档、关联和确认操作暂停，先核对当前资料。</p>}
      <section className={panel}><h2 className="text-lg font-semibold">1 · 关联自己的账本</h2><p className="mt-2 text-sm text-muted-foreground">仅列出创建审计能确认属于当前用户的账本；不会自动关联第一个账本。关联本身不是持仓、余额或交易权限确认。</p>
        {book && <p className="mt-4 rounded-lg border p-3 text-sm">当前：{book.name} · 账本版本 {book.ledger_revision} · 关联版本 {data.link?.version}</p>}
        <div className="mt-4 flex flex-col gap-3 sm:flex-row"><label className={`${field} flex-1`}>已有私有账本<select aria-label="已有私有账本" className={select} value={bookChoice} disabled={locked} onChange={event => setBookChoice(event.target.value)}><option value="">请选择，不自动关联</option>{data.books.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
          <Button className="self-end" disabled={locked || !bookChoice} onClick={() => { const choice = data.books.find(row => row.id === bookChoice); if (choice) onCommand({ action: "link_portfolio", portfolio_id: choice.id, expected_ledger_revision: choice.ledger_revision }); }}>关联所选账本</Button>
          {book && <Button className="self-end" variant="outline" disabled={locked} onClick={() => onCommand({ action: "link_portfolio", portfolio_id: null, expected_ledger_revision: null })}>解除关联（保留账本）</Button>}
        </div>
        <details className="mt-5" open={!book && data.books.length === 0}><summary className="cursor-pointer text-sm">新建空账本与首个账户</summary><form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={event => submitAccount(event, true)}><fieldset disabled={locked} className="contents"><label className={field}>账本名称<Input name="book_name" required maxLength={120} autoComplete="off" /></label><AccountFields /><Button className="sm:col-span-2" disabled={locked}>仅建档并关联，不生成现金或持仓</Button></fieldset></form></details>
        {book && <details className="mt-4"><summary className="cursor-pointer text-sm">添加另一个账户</summary><form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={event => submitAccount(event, false)}><fieldset disabled={locked} className="contents"><AccountFields /><Button disabled={locked}>添加待对账账户</Button></fieldset></form></details>}
      </section>
      {book && <section className={panel}><h2 className="text-lg font-semibold">2 · 从券商导出的 CSV 核对已发生事实</h2><p className="mt-2 text-sm text-muted-foreground">先读取少量样本确认列含义，再校验整份文件和重复记录，最后由你确认。原生券商格式尚未认证，不猜费用、日期或数量；少量成交也可在下方逐笔回录。</p>
        <label className={`${field} mt-4`}>导入账户<select aria-label="账户导入目标" className={select} value={accountId} disabled={locked} onChange={event => setAccountId(event.target.value)}>{data.accounts.map(row => <option key={row.id} value={row.id}>{row.name} · {row.base_currency}{row.status === "disabled" ? " · 已停用" : ""}</option>)}</select></label>
        {selectedAccount && <p className="mt-2 text-xs text-muted-foreground">{selectedAccount.broker} · {statusNames[selectedAccount.status]}</p>}
        {selectedAccount?.status === "disabled" ? <p className="mt-4 text-sm">该账户已停用，先通过高级账本核对状态，不在这里绕过停用限制。</p> : selectedAccount ? <div className="mt-5 min-w-0"><CsvBackgroundWorkspace portfolioId={book.id} accountId={selectedAccount.id} revision={book.ledger_revision}
          readOnly={disabled || reconciliationLocked || tradeLocked || data.read_only || !dataValid}
          readOnlyMessage={data.read_only ? undefined : tradeLocked ? "成交或交收草稿尚未结束，暂停 CSV 提交；不会取消已受理任务。" : reconciliationLocked ? "独立对账草稿或范围核对尚未结束，暂停 CSV 提交；不会取消已受理任务。" : disabled || !dataValid ? "当前资料或提交仍待核对，暂停新的 CSV 操作；不会推定先前请求失败。" : undefined}
          onScopeLockChange={setCsvLocked} onRestorePendingScope={restoreScope} onCommitted={refresh} /></div> : <p className="mt-4 text-sm">先添加一个账户，再检查 CSV 小样。</p>}
      </section>}
      {book && selectedAccount && selectedAccount.status !== "disabled" && data.link && <InvestorTradeRecordingPanel scope={{ binding, workspace: state.workspace_id, revision: state.revision,
        portfolio: book.id, ledgerRevision: book.ledger_revision, linkId: data.link.id, linkVersion: data.link.version, accountId: selectedAccount.id,
        accountRowVersion: selectedAccount.row_version }} accountName={selectedAccount.name} disabled={disabled || busy || csvLocked || reconciliationLocked || !visible}
        onCommand={onCommand} onDraftLockChange={setTradeLocked} />}
      {book && selectedAccount && data.link && <InvestorReconciliationPanel scope={{ binding, workspace: state.workspace_id, revision: state.revision,
        portfolio: book.id, ledgerRevision: book.ledger_revision, linkId: data.link.id, linkVersion: data.link.version, accountId: selectedAccount.id,
        accountRowVersion: selectedAccount.row_version }} accountName={selectedAccount.name} disabled={disabled || busy || csvLocked || tradeLocked || !visible}
        onCommand={onCommand} onDraftLockChange={setReconciliationLocked} />}
      <InvestorHoldingsPanel state={state} accounts={data} binding={binding} disabled={disabled || busy || csvLocked || reconciliationLocked || tradeLocked || !visible} />
    </div>}
  </>;
}
