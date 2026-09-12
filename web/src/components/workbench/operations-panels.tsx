"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import type { WorkbenchState } from "@/server/ledger/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Decimal from "decimal.js";
import { parseStrictJson } from "@/server/strict-json";

interface Props {
  state: WorkbenchState; busy: boolean;
  mutate: (body: unknown) => Promise<Record<string, unknown>>;
  perform: (action: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
  notice: (message: string) => void;
}
const field = "flex min-w-0 flex-col gap-1.5 text-sm";
const select = "h-10 w-full min-w-0 max-w-full rounded-md border bg-background px-3";
const textarea = "min-h-36 w-full min-w-0 max-w-full rounded-md border bg-background p-3 font-mono text-xs";
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="min-w-0 rounded-xl border bg-card p-5 shadow-sm"><h2 className="mb-4 text-lg font-semibold">{title}</h2>{children}</section>;
}
function percentage(value: unknown) {
  if (typeof value !== "string") return "不可用";
  try { const number = new Decimal(value); return number.isFinite() ? `${number.mul(100).toFixed(2)}%` : "不可用"; }
  catch { return "不可用"; }
}
function PerformanceResult({ row, revision }: { row: WorkbenchState["performance"][number]; revision: number }) {
  if (row.stale_reasons.some(reason => reason.includes("METHOD_SUPERSEDED"))) return <article className="rounded-lg border border-amber-500/40 p-4 text-sm"><p>估值或绩效方法已更新，必须重新计算后使用。</p><p className="mt-2">{row.period_start} 至 {row.period_end} · {row.method_version}</p><p className="mt-2 text-muted-foreground">旧记录保留用于审计，不继续显示其收益率为有效结果。</p></article>;
  const result = JSON.parse(row.result_json) as { net_profit_cny: string | null; return: { value: string | null } | null; xirr: { status: string; rate: string | null }; drawdown: { max_drawdown: string | null } | null; assumptions: string[]; issues: string[]; attribution_quality?: string };
  return <article className="rounded-lg border p-4 text-sm"><p className="font-medium">{row.period_start} 至 {row.period_end}</p><p className="mt-1 text-muted-foreground">{row.method} · {row.quality} · 账本 {row.ledger_revision}{row.ledger_revision !== revision ? "（已变更，需重算）" : ""}</p>
    {row.stale_reasons.length > 0 && <p className="mt-2 break-all text-amber-600">仅供历史审计，当前输入已失效：{row.stale_reasons.join(" / ")}</p>}
    {result.attribution_quality && <p className="mt-2">分红与扣税归因：{result.attribution_quality === "complete" ? "完整" : "未完整确认，不能视为最终税前 / 税款拆分"}。归因状态与净资产、税后收益质量分别判断。</p>}
    <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div><dt className="text-muted-foreground">扣除期间净投入后的损益</dt><dd className="mt-1 font-mono">{result.net_profit_cny === null ? "不可用" : `${result.net_profit_cny} CNY`}</dd></div><div><dt className="text-muted-foreground">现金流中性收益</dt><dd className="mt-1 font-mono">{percentage(result.return?.value)}</dd></div><div><dt className="text-muted-foreground">期间 XIRR</dt><dd className="mt-1 font-mono">{result.xirr.status === "ok" ? percentage(result.xirr.rate) : `不可用 / ${result.xirr.status}`}</dd></div><div><dt className="text-muted-foreground">所选快照间最大回撤</dt><dd className="mt-1 font-mono">{percentage(result.drawdown?.max_drawdown)}</dd></div></dl>
    <details className="mt-3"><summary className="cursor-pointer">计算假设、逐段收益和证据</summary><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{JSON.stringify(JSON.parse(row.result_json), null, 2)}</pre></details>
  </article>;
}

export function OperationsPanels({ state, busy, mutate, perform, refresh, notice }: Props) {
  const [statement, setStatement] = useState("");
  const [taskPayload, setTaskPayload] = useState("");
  const [corrections, setCorrections] = useState("");
  const [flowFxEnabled, setFlowFxEnabled] = useState(false);
  const accountName = (id: string) => state.accounts.find(account => account.id === id)?.name ?? id;
  const envelope = () => ({ portfolio_id: state.selected, expected_revision: state.revision, idempotency_key: crypto.randomUUID() });
  function submit(event: FormEvent<HTMLFormElement>, run: (data: FormData) => Promise<void>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void perform(() => run(data));
  }
  return <>
    <Panel title="证券登记与标识">
      <p className="mb-4 text-sm text-muted-foreground">登记实际持有或研究的 ETF。市场、上市代码与币种分开保存；登记不代表券商可买，也不会自动启用交易权限。</p>
      <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={event => submit(event, async data => {
        const command = { ...envelope(), name: data.get("name"), market: data.get("market"), exchange: data.get("exchange"), ticker: data.get("ticker"), currency: data.get("currency"), asset_class: data.get("asset_class"), source_evidence: data.get("source_evidence") };
        await mutate({ action: "register_listing", command });
        await refresh(); notice("证券已登记为待核验，可使用上市标识导入真实持仓；没有创建交易建议。");
      })}>
        <label className={field}>ETF 名称<Input name="name" maxLength={200} required /></label>
        <label className={field}>上市市场<select name="market" aria-label="上市市场" className={select}><option value="CN">A 股</option><option value="HK">港股</option><option value="US">美股</option></select></label>
        <label className={field}>交易所<Input name="exchange" maxLength={40} required placeholder="按正式资料填写" /></label>
        <label className={field}>上市代码<Input name="ticker" maxLength={40} required /></label>
        <label className={field}>交易币种<select name="currency" aria-label="交易币种" className={select}><option>CNY</option><option>HKD</option><option>USD</option></select></label>
        <label className={field}>资产类别<select name="asset_class" aria-label="资产类别" className={select}><option value="unknown">待核验</option><option value="equity">权益</option><option value="bond">债券</option><option value="gold">黄金</option><option value="cash">现金类</option><option value="multi_asset">多资产</option></select></label>
        <label className={`${field} sm:col-span-2`}>来源与核实依据<Input name="source_evidence" maxLength={2000} required placeholder="基金或交易所资料，登记依据" /></label>
        <Button disabled={busy}>登记证券</Button>
      </form>
      <ul className="mt-4 divide-y">{state.listings.map(listing => <li key={listing.id} className="py-3 text-sm"><p>{listing.market} / {listing.exchange} / {listing.ticker} · {listing.name} · {listing.currency} · {listing.status}</p><p className="mt-1 break-all font-mono text-xs text-muted-foreground">上市标识：{listing.id}</p></li>)}</ul>
      {!state.listings.length && <p className="mt-4 text-sm text-muted-foreground">暂无已登记证券，不预置任何推荐名单。</p>}
    </Panel>
    <Panel title="对账原件与账户核验">
      <p className="mb-4 text-sm text-muted-foreground">粘贴独立券商对账单转换后的标准 JSON，原件将按内容哈希留存。应覆盖全部币种、结算及挂账科目（含零值）和全部持仓；不能用本系统余额替代独立对账依据。</p>
      <form className="space-y-3" onSubmit={event => submit(event, async data => {
        const attachment = await mutate({ action: "store_attachment", portfolio_id: state.selected, account_id: data.get("account"), raw: statement });
        await refresh(); notice(`原件已留存，尚未改变现金、持仓或对账状态。附件标识：${attachment.id}`);
      })}>
        <label className={field}>原件所属账户<select name="account" aria-label="原件所属账户" required className={select}>{state.accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
        <label className={field}>标准对账声明<textarea className={textarea} aria-label="标准对账声明" value={statement} onChange={event => setStatement(event.target.value)} required placeholder="按 docs/attachments-and-reconciliation.md 的标准声明填写；不要填写规划预算。" /></label>
        <Button disabled={busy || !state.accounts.length}>保存对账原件（不入账）</Button>
      </form>
      <form className="mt-5 grid gap-3 sm:grid-cols-2" onSubmit={event => submit(event, async data => {
        const attachment = state.attachments.find(row => `${row.account_id}/${row.id}` === data.get("attachment"));
        if (!attachment) throw new Error("请选择有效原件");
        const ids = String(data.get("resolved_ids") ?? "").split(/[\s,]+/).filter(Boolean);
        const result = await mutate({ action: "reconcile_account", command: { portfolio_id: state.selected, account_id: attachment.account_id, attachment_id: attachment.id, expected_revision: state.revision, ...(ids.length ? { resolves_issue_ids: ids, resolution_reason: String(data.get("reason") ?? "") } : {}) } });
        await refresh(); notice(result.account_activated ? "账户对账匹配。此结果不等于市场权限或策略交易授权。" : "对账结果已留档，请查看差异与未解决问题。");
      })}>
        <label className={`${field} sm:col-span-2`}>选择已留存原件<select name="attachment" aria-label="选择已留存原件" required className={select}><option value="">请选择对账原件</option>{state.attachments.map(row => <option key={`${row.id}:${row.account_id}`} value={`${row.account_id}/${row.id}`}>{accountName(row.account_id)} / {row.content_hash.slice(0, 12)} / {row.created_at}</option>)}</select></label>
        <label className={field}>本次显式解决的问题标识<Input name="resolved_ids" placeholder="可选，多个标识用逗号分隔" /></label>
        <label className={field}>解决依据<Input name="reason" maxLength={2000} placeholder="解决历史差异时必填" /></label>
        <Button disabled={busy || !state.attachments.length}>执行精确对账</Button>
      </form>
      <ul className="mt-4 space-y-2 text-sm">{state.reconciliation_issues.map(issue => <li key={issue.id} className="break-words rounded border border-amber-500/30 p-3"><p>{accountName(issue.account_id)} · {issue.issue_type}</p><p className="mt-1 font-mono text-xs">{issue.id}</p><p className="mt-1 font-mono text-xs">{issue.details_json}</p></li>)}</ul>
      <details className="mt-4 text-sm"><summary className="cursor-pointer">对账记录与原件下载</summary><ul className="mt-3 space-y-2">{state.reconciliations.map(row => <li key={row.id}>{accountName(row.account_id)} · {row.status} · 账本 {row.ledger_revision} · {row.created_at}</li>)}</ul><ul className="mt-3 space-y-2">{state.attachments.map(row => <li key={`${row.id}:${row.account_id}`}><a className="break-all underline" href={`/api/workbench/attachments/${encodeURIComponent(row.id)}?portfolio=${encodeURIComponent(state.selected ?? "")}`}>{accountName(row.account_id)} / {row.content_hash.slice(0, 16)} / {row.byte_size} bytes</a></li>)}</ul></details>
    </Panel>
    <Panel title="估值快照与后台任务">
      <p className="mb-4 text-sm text-muted-foreground">快照按截止时点、账本版本及行情来源保存，不等于实时净资产。任务成功只表示计算完成；数据阻断、估算和事后重述不会伪装成有效投资建议。</p>
      <div className="mb-4 flex flex-wrap items-center gap-3"><span className="text-sm">当前快照状态：{state.valuation_status}</span><Button variant="outline" disabled={busy} onClick={() => void perform(refresh)}>刷新任务和快照</Button></div>
      <div className="space-y-3">{state.valuations.map(value => <article key={value.id} className="rounded-lg border p-3 text-sm"><p className="font-medium">截止 {value.cutoff_at} · 账本 {value.ledger_revision} · {value.quality}{value.ledger_revision !== state.revision ? " · 账本已变更" : ""}</p><p className="mt-2">{value.stale_reasons.includes("VALUATION_METHOD_SUPERSEDED") ? "估值方法已更新，旧金额仅留档，需重新计算" : value.nav_cny === null ? "完整人民币净资产不可用" : `该时点人民币净资产：${value.nav_cny}`}</p><p className="mt-1 break-all font-mono text-xs">{value.method_version}</p>{value.stale_reasons.length > 0 && <p className="mt-2 break-all text-amber-600">需按当前输入重算：{value.stale_reasons.join(" / ")}</p>}<details className="mt-2"><summary className="cursor-pointer">数据质量与证据说明</summary><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{value.issues_json}</pre></details></article>)}</div>
      {!state.valuations.length && <p className="text-sm text-muted-foreground">尚无估值快照。需要真实账本、适用行情/汇率与经核实的数据质量规则。</p>}
      <details className="mt-5 rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">高级：提交标准数据 / 估值任务</summary>
        <p className="my-3 text-sm text-muted-foreground">支持市场批次、估值和绩效标准载荷。合成数据不能用于实际完整估值；approved 仅表示已核实本次估值规则，不授予策略或下单权限。任务由独立 Worker 执行。</p>
        <form className="space-y-3" onSubmit={event => submit(event, async data => {
          const payload = parseStrictJson(taskPayload);
          await mutate({ action: "enqueue_task", command: { ...envelope(), command_type: data.get("type"), payload } });
          await refresh(); notice("后台请求已留档并排队；尚未将任务结果标记为成功。");
        })}>
          <label className={field}>任务类型<select className={select} aria-label="任务类型" name="type"><option value="valuation">估值快照</option><option value="market_ingest">市场数据批次</option><option value="performance">历史绩效</option></select></label>
          <label className={field}>标准任务载荷<textarea className={textarea} aria-label="标准任务载荷" value={taskPayload} onChange={event => setTaskPayload(event.target.value)} required placeholder="契约与示例见 worker/orchestration/README.md 和 worker/market/README.md" /></label>
          <Button disabled={busy}>提交后台任务</Button>
        </form>
      </details>
      <ul className="mt-4 divide-y text-sm">{state.tasks.map(task => <li key={task.id} className="py-3"><p>{task.command_type} · {task.status} · 尝试 {task.attempt_count ?? 0} 次</p><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{task.id} / {task.created_at}</p>{task.result_json && <pre className="mt-2 whitespace-pre-wrap break-all text-xs">{task.result_json}</pre>}</li>)}</ul>
    </Panel>
    <Panel title="真实组合历史绩效">
      <p className="mb-4 text-sm text-muted-foreground">同一账本版本、同一已知/重述口径下连接估值快照。期间有资金流而缺少流前估值时明确使用 Dietz 估算；不把累计投入或汇率缺口计成盈利。</p>
      <form className="mb-4 grid gap-3 sm:grid-cols-2" onSubmit={event => submit(event, async data => {
        const flow_fx_rules = flowFxEnabled ? {
          schema_version: "flow-fx-rules-v1", approved: data.get("flow_fx_approved") === "on",
          approval_evidence: String(data.get("flow_fx_evidence") ?? ""), fx_scope: String(data.get("flow_fx_scope") ?? ""),
          max_fx_age_seconds: Number(data.get("flow_fx_max_age")), time_policy: "event_second_strict",
        } : undefined;
        await mutate({ action: "enqueue_task", command: { ...envelope(), command_type: "performance", payload: { valuation_ids: String(data.get("valuation_ids")).split(/[\s,]+/).filter(Boolean), evaluation_timezone: data.get("timezone"), ...(flow_fx_rules ? { flow_fx_rules } : {}) } } });
        await refresh(); notice("历史绩效计算已排队；快照日期、版本和输入质量将再次校验。");
      })}>
        <label className={`${field} sm:col-span-2`}>估值快照标识（至少两项，按时间从早到晚）<Input name="valuation_ids" required placeholder="从估值任务结果复制标识，用逗号分隔" /></label>
        <label className={field}>XIRR 评价时区<select name="timezone" aria-label="XIRR 评价时区" className={select}><option>Asia/Shanghai</option><option>Asia/Hong_Kong</option><option>America/New_York</option><option>UTC</option></select></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={flowFxEnabled} onChange={event => setFlowFxEnabled(event.target.checked)} />核算区间含外币入金或出金，填写逐笔汇率规则</label>
        {flowFxEnabled && <fieldset className="space-y-3 rounded-lg border p-4 sm:col-span-2" disabled={busy || state.read_only}>
          <legend className="px-1 text-sm font-medium">外部资金流的时点汇率</legend>
          <p className="text-sm text-muted-foreground">使用每笔事实发生时的参考汇率，不使用期末汇率或实际换汇成交价。仅有日期而无准确时刻的外币资金流仍会阻断；填规则不补造缺失行情，也不授予交易权限。</p>
          <label className={field}>资金流汇率发布范围<Input name="flow_fx_scope" maxLength={200} required placeholder="已核验汇率批次的 scope" /></label>
          <label className={field}>资金流汇率最长允许陈旧秒数<Input name="flow_fx_max_age" type="number" min="0" max="2592000" step="1" required /></label>
          <label className={field}>资金流汇率规则核验依据<Input name="flow_fx_evidence" maxLength={2048} required placeholder="来源、口径和允许陈旧范围的核验依据" /></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="flow_fx_approved" className="mt-1" /><span>我已核对本次数据质量规则。未核对或缺逐笔证据时，结果应标为不可用，不填默认汇率。</span></label>
        </fieldset>}
        <Button className="self-end" disabled={busy || state.valuations.length < 2}>计算历史绩效</Button>
      </form>
      <div className="space-y-3">{state.performance.map(row => <PerformanceResult key={row.id} row={row} revision={state.revision} />)}</div>
      {!state.performance.length && <p className="text-sm text-muted-foreground">暂无可发布的绩效计算，不展示默认 0% 或虚构年化收益。</p>}
    </Panel>
    <Panel title="事实更正与历史补录">
      <p className="mb-4 text-sm text-muted-foreground">更正必须关联原件、说明原因；系统追加冲销与替代记录并重放后续依赖，不直接修改历史记录。同日补录必须明确前后顺序，不自动猜测。</p>
      <details className="mb-4"><summary className="cursor-pointer text-sm">账户与最近事实标识（用于标准导入和更正）</summary><ul className="mt-3 space-y-2 text-sm">{state.accounts.map(account => <li key={account.id}>{account.name}：<code className="break-all text-xs">{account.id}</code></li>)}</ul><ul className="mt-3 space-y-2 text-sm">{state.events.map(event => <li key={event.id}>版本 {event.ledger_revision} / {event.event_type} / {event.effective_at}：<code className="break-all text-xs">{event.id}</code></li>)}</ul></details>
      <details><summary className="cursor-pointer text-sm font-medium">提交标准更正命令</summary>
        <form className="mt-4 space-y-3" onSubmit={event => submit(event, async data => {
          const changes = parseStrictJson(corrections);
          const result = await mutate({ action: "correct_ledger", command: { ...envelope(), attachment_id: data.get("attachment"), reason: data.get("reason"), changes } });
          await refresh(); notice(`更正已完成，账本版本 ${result.revision}。受影响账户需重新对账，既有估值与绩效需按新版本重算。`);
        })}>
          <label className={field}>更正原件<select name="attachment" aria-label="更正原件" required className={select}><option value="">选择已留存证据</option>{state.attachments.map(row => <option key={`${row.id}:${row.account_id}`} value={row.id}>{accountName(row.account_id)} / {row.content_hash.slice(0, 16)}</option>)}</select></label>
          <label className={field}>更正原因<Input name="reason" maxLength={2000} required /></label>
          <label className={field}>更正列表<textarea className={textarea} aria-label="更正列表" required value={corrections} onChange={event => setCorrections(event.target.value)} placeholder='[{"action":"void","event_id":"待撤销的实际事件标识"}]；replace/insert 格式见更正文档。' /></label>
          <Button disabled={busy || !state.attachments.length}>确认更正并重放账本</Button>
        </form>
      </details>
    </Panel>
  </>;
}
