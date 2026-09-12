"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WorkbenchState } from "@/server/ledger/queries";
import type { ResearchState } from "@/server/research-queries";
import { parseStrictJson } from "@/server/strict-json";
import { researchTrialSummary } from "./research-trial-summary";

const researchActions = [
  ["research_register", "登记实验与冻结数据"], ["research_register_trial", "登记一次试验"],
  ["research_trial", "运行已登记试验"], ["research_freeze", "冻结验证候选参数"],
  ["research_unseal", "人工解封留出窗口"], ["research_ai_context", "生成只读 AI 证据输入"],
  ["research_ai_review", "校验并留存 AI 审阅文本"],
] as const;
const governanceActions = [
  ["create_policy", "保存已确认的投资政策版本"], ["create_strategy", "保存策略参数版本"],
  ["approve_capability", "核验账户可买性"], ["activate_policy", "申请启用实盘建议"],
  ["create_proposal", "建立候选交易清单"], ["risk_check", "执行确定性风险检查"],
  ["approve_proposal", "人工批准清单并预占资源"], ["prepare_execution", "执行前重查版本与已预占资源"],
  ["record_execution_report", "登记券商回报（不入账）"], ["record_execution_fact", "录入已发生成交事实"],
  ["cancel_remainder", "取消未执行余量"], ["expire_proposal", "释放已到期清单"],
] as const;
const inputClass = "w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm";
const labelClass = "flex min-w-0 flex-col gap-2 text-sm";
const panelClass = "min-w-0 space-y-4 rounded-xl border bg-card p-5 shadow-sm";
function Evidence({ title, value }: { title: string; value: unknown }) {
  return <details className="min-w-0 rounded-md border p-3 text-sm"><summary className="cursor-pointer">{title}</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(value, null, 2)}</pre></details>;
}

export function DecisionWorkspace({ initial, mode }: { initial: WorkbenchState; mode: "research" | "governance" }) {
  const [workspace, setWorkspace] = useState(initial), [selected, setSelected] = useState(initial.selected);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [hydrated, setHydrated] = useState(false), [busy, setBusy] = useState(true);
  const [error, setError] = useState(""), [receipt, setReceipt] = useState<Record<string, unknown> | null>(null);
  const actions = mode === "research" ? researchActions : governanceActions;
  const [operation, setOperation] = useState<string>(actions[0][0]), [raw, setRaw] = useState("");
  const [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false);
  const attempt = useRef<{ semantic: string; key: string } | null>(null);

  async function readState(portfolio: string, signal?: AbortSignal) {
    const query = `?portfolio=${encodeURIComponent(portfolio)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`/api/workbench${query}&view=${mode}`, { cache: "no-store", signal });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "读取失败");
      const baseResponse = await fetch(`/api/workbench${query}`, { cache: "no-store", signal });
      const base = await baseResponse.json();
      if (!baseResponse.ok) throw new Error(base.error ?? "读取组合失败");
      if ((mode === "research" ? value.revision : value.ledger_revision) !== base.revision) continue;
      if (!signal?.aborted) { setData(value); setWorkspace(base); }
      return;
    }
    throw new Error("读取期间账本已变更，请刷新后重新核对；未混用不同账本版本。");
  }
  useEffect(() => {
    setHydrated(true);
    const controller = new AbortController();
    setData(null); setReceipt(null); setError(""); setConfirmed(false); setBusy(true);
    setRaw(""); setReason(""); attempt.current = null;
    if (selected) void readState(selected, controller.signal).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "读取失败");
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    else setBusy(false);
    return () => controller.abort();
    // Portfolio/mode are the request identity; edits must not cause another fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, mode]);

  async function refresh() {
    if (!selected) return;
    setBusy(true); setError(""); setConfirmed(false); setData(null);
    try { await readState(selected); }
    catch (error) { setError(error instanceof Error ? error.message : "刷新失败"); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !data || busy || workspace.read_only || !confirmed) return;
    setBusy(true); setError(""); setReceipt(null);
    try {
      const parsed = parseStrictJson(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("标准载荷必须为 JSON 对象");
      const payload = parsed as Record<string, unknown>;
      for (const key of ["actor", "actor_id", "kind", "portfolio_id", "expected_revision", "idempotency_key"]) {
        if (key in payload) throw new Error(`请勿在载荷中填写由服务端确定的字段：${key}`);
      }
      const semantic = JSON.stringify({ selected, operation, payload, reason: mode === "governance" ? reason : null });
      if (attempt.current?.semantic !== semantic) attempt.current = { semantic, key: crypto.randomUUID() };
      const envelope = { portfolio_id: selected, expected_revision: workspace.revision, idempotency_key: attempt.current.key };
      const body = mode === "research"
        ? { action: "enqueue_task", command: { ...envelope, command_type: operation, payload } }
        : { action: "governance", command: { operation, command: { ...payload, ...envelope, reason } } };
      const response = await fetch("/api/workbench", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "提交失败");
      setReceipt(result); setConfirmed(false); setData(null);
      await readState(selected);
    } catch (error) { setError(error instanceof Error ? error.message : "提交失败"); }
    finally { setBusy(false); }
  }

  const research = mode === "research" && data ? data as unknown as ResearchState : null;
  const rows = (key: string) => Array.isArray(data?.[key]) ? data[key] as Record<string, unknown>[] : [];
  return <div inert={!hydrated} data-hydrated={hydrated} aria-busy={busy} className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-8">
    <header><p className="text-sm text-muted-foreground">ETF / {mode === "research" ? "RESEARCH" : "GOVERNANCE"}</p><h1 className="mt-1 text-3xl font-semibold">{mode === "research" ? "策略研究与 AI 审阅" : "投资政策与执行审批"}</h1><p className="mt-2 text-sm text-muted-foreground">{mode === "research" ? "实验、模拟和真实账户分开；先登记假设和试验预算，再运行与验证。" : "政策版本、风险检查、人工确认、资源预占与实际成交分开记录。"}</p></header>
    <nav aria-label="工作台模块" className="flex flex-wrap gap-4 text-sm"><Link className="underline" href="/workbench">账户与账本</Link><Link className="underline" href="/workbench/funding">资金计划</Link><Link className="underline" href="/workbench/research">策略研究</Link><Link className="underline" href="/workbench/governance">政策与执行</Link></nav>
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">{mode === "research" ? "研究结果不授予实盘资格。训练、验证、留出各自重新开始，不是连续 10 年的实际业绩；AI 当前仅校验离线审阅文本，不会自动下单。" : "启用实盘建议前，D 决策、工程与策略准入证据须逐项独立核验；上传 PASS 声明不能替代受信测试记录。系统不连接券商自动下单。"}</div>
    {error && <div role="alert" className="break-all rounded-md border border-red-500/40 p-4 text-sm">{error}</div>}
    {workspace.read_only && <p role="status" className="rounded-md border p-4 text-sm">恢复只读模式：可刷新和查看历史；不能提交研究或审批命令。</p>}
    <section className={panelClass}><div className="flex flex-wrap items-end gap-3"><label className={`${labelClass} flex-1`}>当前组合<select className={inputClass} aria-label="当前组合" value={selected ?? ""} disabled={busy} onChange={event => setSelected(event.target.value)}><option value="" disabled>请先建立组合</option>{workspace.portfolios.map(portfolio => <option key={portfolio.id} value={portfolio.id}>{portfolio.name}</option>)}</select></label><Button variant="outline" disabled={busy || !selected} onClick={() => void refresh()}>刷新工作区</Button></div><p className="text-sm text-muted-foreground">账本版本 {workspace.revision}。切换组合不会复制资金、策略或审批。</p>{!selected && <Link href="/workbench" className="text-sm underline">前往建立空账本</Link>}</section>
    {research && <>
      <section className={panelClass}><h2 className="text-lg font-semibold">已登记实验</h2>{!research.experiments.length && <p className="text-sm text-muted-foreground">暂无实验，不预填策略或默认风险阈值。</p>}{research.experiments.map(experiment => <article className="space-y-2 border-t pt-3 text-sm" key={experiment.id}><h3 className="break-all font-medium">{experiment.id} · {experiment.mode}</h3><p>{experiment.hypothesis}</p><p className="break-all font-mono text-xs">计划 {experiment.plan_hash}<br />数据 {experiment.dataset_hash}</p><p>试验预算：{experiment.trial_budgets_json ?? "未提供"}</p></article>)}</section>
      <section className={panelClass}><h2 className="text-lg font-semibold">试验、资金与同口径基准</h2><p className="text-sm text-muted-foreground">v1 仅按固定权重安排新增资金；v2 按明确参数运行月度排名轮动或固定权重再平衡。以下资金、现金、费用和交易均属于研究模拟，不是账户到账、实际持仓或前向 / 实时策略表现。换手率以观察点净资产算术均值为分母；缺失指标不补零。</p>{!research.trials.length && <p className="text-sm text-muted-foreground">尚未登记或运行试验。</p>}{research.trials.map(trial => {
        const summary = researchTrialSummary(trial);
        return <article className="space-y-3 rounded-lg border p-4 text-sm" key={trial.id}><h3 className="break-all font-medium">{trial.phase} / #{trial.trial_number} / {trial.status}</h3><p className="font-medium">{summary.method}</p><p className="break-all font-mono text-xs">引擎 {summary.engine}<br />试验 {trial.id}<br />运行 {trial.run_id}</p><dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{summary.metrics.map(metric => <div className="min-w-0" key={metric.label}><dt className="text-muted-foreground">{metric.label}</dt><dd className="break-all">{metric.value}</dd></div>)}</dl><p role="status">{summary.monthly}</p><p className="text-xs text-muted-foreground">“提出计划”不等于成交或获批；阻断与执行跳过 / 过期是不同阶段，不能据收益率忽略。</p>{(trial.error || trial.error_code) && <p role="status" className="break-all">失败原因：{trial.error_code ?? trial.error}</p>}<Evidence title="原参数、研究摘要、结果哈希与 S 门槛（不等于通过）" value={trial} /></article>;
      })}</section>
      <section className={panelClass}><h2 className="text-lg font-semibold">冻结、解封与 AI 留档</h2><p className="text-sm text-muted-foreground">留出窗口须先冻结候选再由人解封，只允许一次留出试验。AI 的 valid 仅表示结构和引用校验，不表示策略有效。</p><Evidence title={`冻结/解封事件（${research.holdout_events.length}）`} value={research.holdout_events} /><Evidence title={`AI 审阅记录（${research.ai_reviews.length}）`} value={research.ai_reviews} /></section>
    </>}
    {mode === "governance" && data && <>
      <section className={panelClass}><h2 className="text-lg font-semibold">版本与准入证据</h2><div className="grid gap-3 sm:grid-cols-2"><Evidence title={`政策版本（${rows("policy_versions").length}）`} value={data.policy_versions} /><Evidence title={`策略版本（${rows("strategy_versions").length}）`} value={data.strategy_versions} /><Evidence title="有效期与激活记录" value={data.activations} /><Evidence title="账户权限与验证记录" value={{ capabilities: data.capabilities, verification_runs: data.verification_runs }} /></div></section>
      <section className={panelClass}><h2 className="text-lg font-semibold">交易清单、风险与人工确认</h2><p className="text-sm text-muted-foreground">清单和预占不是成交。风险检查通过后仍须人工批准；执行前重新核对账本、行情、政策和资源。</p><Evidence title={`候选清单（${rows("proposals").length}）`} value={data.proposals} /><Evidence title="清单明细与风险输入版本" value={{ items: data.proposal_items, risks: data.risk_checks }} /><Evidence title="人工审批记录" value={data.approvals} /></section>
      <section className={panelClass}><h2 className="text-lg font-semibold">预占与券商回报</h2><p className="text-sm text-muted-foreground">按账户/币种预占可用现金或持仓。券商回报留档与真实成交入账是两个动作；取消和到期只释放未执行余量。</p><Evidence title={`资源预占（${rows("reservations").length}）`} value={data.reservations} /><Evidence title="执行回报" value={data.execution_reports} /></section>
    </>}
    {selected && <section className={panelClass}><h2 className="text-lg font-semibold">{mode === "research" ? "提交研究命令" : "人工操作"}</h2><p className="text-sm text-muted-foreground">标准载荷模式。身份、组合、账本版本和幂等键由系统确定；留存原件请到“账户与账本”。不填写未经确认的资金或风险参数。</p>
      <form className="space-y-4" onSubmit={event => void submit(event)}>
        <fieldset disabled={busy || workspace.read_only || !data} className="min-w-0 space-y-4">
          <label className={labelClass}>操作<select className={inputClass} aria-label="操作" value={operation} onChange={event => { setOperation(event.target.value); setConfirmed(false); setReceipt(null); }}>{actions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className={labelClass}>标准载荷<textarea aria-label="标准载荷" className={`${inputClass} min-h-48 font-mono text-xs`} value={raw} onChange={event => { setRaw(event.target.value); setConfirmed(false); }} required placeholder={mode === "research" ? '{"trial_id":"已登记试验的标识"}；其他格式见 docs/research-implementation.md' : "填写所选操作字段，不含 portfolio_id/expected_revision/idempotency_key/reason；格式见治理接口说明。"} /></label>
          {mode === "governance" && <label className={labelClass}>人工操作依据<Input value={reason} onChange={event => { setReason(event.target.value); setConfirmed(false); }} maxLength={2000} required /></label>}
          <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required /><span>我已核对本次操作、来源与参数。确认只执行所选步骤，不授予 AI 自动交易或跳过准入检查的权限。</span></label>
          <Button disabled={!confirmed}>确认提交所选步骤</Button>
        </fieldset>
      </form>
      {receipt && <div role="status" className="space-y-3"><p className="text-sm">请求已留档。排队不等于成功、审批不等于成交；刷新查看最终状态。</p><Evidence title="本次服务端回执" value={receipt} /></div>}
    </section>}
    {selected && <section className={panelClass}><h2 className="text-lg font-semibold">最近后台任务</h2><p className="text-sm text-muted-foreground">任务由独立 Worker 执行，手动刷新查看终态；仅展示本组合最近 25 个请求。</p>{workspace.tasks.filter(task => mode !== "research" || task.command_type.startsWith("research_")).map(task => <article key={task.id} className="space-y-2 border-t pt-3 text-sm"><p>{task.command_type} · {task.status} · 尝试 {task.attempt_count ?? 0} 次</p><p className="break-all font-mono text-xs">{task.id}</p>{task.result_json && <Evidence title="任务结果" value={parseStrictJson(task.result_json)} />}</article>)}</section>}
  </div>;
}
