"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { catalogWorkspace, catalogDetail, compareCatalog } from "@/server/catalog/queries";
import { parseStrictJson } from "@/server/strict-json";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseHoldingsDraft, percentRatio, profileFromForm } from "./catalog-input";

type State = ReturnType<typeof catalogWorkspace>;
type Detail = ReturnType<typeof catalogDetail>;
type Comparison = ReturnType<typeof compareCatalog>;
type Selection = { listing_id: string; profile_version_id?: string; holdings_version_id?: string };
type Attempt = { action: string; command: Record<string, unknown> };
class CatalogRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const panel = "min-w-0 space-y-4 rounded-xl border bg-card p-5 shadow-sm";
const field = "flex min-w-0 flex-col gap-2 text-sm";
const selectClass = "h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm";
const textareaClass = "min-h-36 w-full min-w-0 rounded-md border bg-background p-3 font-mono text-xs";
const operations = [["add_entry", "加入研究目录"], ["store_source", "保留结构化来源"], ["publish_profile", "保存资料新版本"], ["publish_holdings", "保存持仓披露新版本"]] as const;
function Evidence({ title, value }: { title: string; value: unknown }) {
  return <details className="min-w-0 rounded-lg border p-3 text-sm"><summary className="cursor-pointer">{title}</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(value, null, 2)}</pre></details>;
}
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const body = await response.json();
  if (!response.ok) throw new CatalogRequestError(`${body.error ?? "请求失败"}${response.status === 409 ? "：目录已变化，请刷新后重新核对。" : ""}`, response.status);
  return body as T;
}

export function CatalogWorkspace({ initial }: { initial: State }) {
  const [state, setState] = useState(initial), [selected, setSelected] = useState(initial.selected_portfolio_id);
  const [market, setMarket] = useState(""), [search, setSearch] = useState(""), [busy, setBusy] = useState(false);
  const [appliedFilters, setAppliedFilters] = useState({ market: "", query: "" });
  const [hydrated, setHydrated] = useState(false), [error, setError] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null), [selections, setSelections] = useState<Selection[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null), [operation, setOperation] = useState<string>("add_entry");
  const [attempt, setAttempt] = useState<Attempt | null>(null), [confirmed, setConfirmed] = useState(false), [receipt, setReceipt] = useState<unknown>(null);
  const [uncertain, setUncertain] = useState(false), [holdingsText, setHoldingsText] = useState("[]");
  const generation = useRef(0);
  const editor = useRef<HTMLFormElement>(null);
  const locked = busy || state.read_only || !selected || selected !== state.selected_portfolio_id;

  function clearPreview() { setAttempt(null); setConfirmed(false); setUncertain(false); }
  function pendingResolved() {
    if (!uncertain) return true;
    setError("上次保存结果不确定。请先用原请求重试，或明确放弃跟踪后再切换、刷新或编辑。");
    return false;
  }
  async function load(portfolio: string, options: { market?: string; query?: string; cursor?: string } = {}) {
    const token = ++generation.current;
    const query = new URLSearchParams({ portfolio, limit: "20" });
    if (options.market) query.set("market", options.market);
    if (options.query) query.set("query", options.query);
    if (options.cursor) query.set("cursor", options.cursor);
    setBusy(true); setError("");
    try {
      const next = await request<State>(`/api/workbench/catalog?${query}`);
      if (token !== generation.current) return;
      if (next.selected_portfolio_id !== portfolio) throw new Error("目录组合范围不匹配");
      if (!options.cursor) setAppliedFilters({ market: options.market ?? "", query: options.query ?? "" });
      setState(previous => options.cursor ? { ...next, rows: [...previous.rows, ...next.rows] } : next);
    } catch (error) { if (token === generation.current) setError(error instanceof Error ? error.message : "读取目录失败"); }
    finally { if (token === generation.current) setBusy(false); }
  }
  useEffect(() => { setHydrated(true); return () => { generation.current++; }; }, []);
  useEffect(() => {
    if (!uncertain) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uncertain]);
  function switchPortfolio(value: string) {
    if (!pendingResolved()) return;
    setSelected(value); setMarket(""); setSearch(""); setAppliedFilters({ market: "", query: "" }); setDetail(null); setComparison(null); setSelections([]); setReceipt(null); setHoldingsText("[]"); clearPreview();
    setState(previous => ({ ...previous, selected_portfolio_id: null, rows: [], next_cursor: null }));
    void load(value);
  }
  function refresh() {
    if (!selected || !pendingResolved()) return;
    setDetail(null); setComparison(null); setSelections([]); clearPreview(); void load(selected, { market, query: search });
  }
  async function openDetail(listing: string) {
    if (!selected || busy || !pendingResolved()) return;
    const token = ++generation.current;
    setBusy(true); setError(""); setDetail(null); setHoldingsText("[]"); clearPreview();
    try {
      const next = await request<Detail>(`/api/workbench/catalog?${new URLSearchParams({ view: "detail", portfolio: selected, listing })}`);
      if (token !== generation.current) return;
      if (next.portfolio_id !== selected || next.listing_id !== listing || next.catalog_revision !== state.catalog_revision) throw new Error("目录版本已变化，请刷新后核对资料。");
      setDetail(next);
    } catch (error) { if (token === generation.current) setError(error instanceof Error ? error.message : "读取资料失败"); }
    finally { if (token === generation.current) setBusy(false); }
  }
  async function compare() {
    if (!selected || selections.length < 2 || busy) return;
    const token = ++generation.current;
    setBusy(true); setError(""); setComparison(null);
    try {
      const result = await request<Comparison>("/api/workbench/catalog", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "compare", command: { portfolio_id: selected, expected_catalog_revision: state.catalog_revision, selections } }) });
      if (token === generation.current) setComparison(result);
    } catch (error) { if (token === generation.current) setError(error instanceof Error ? error.message : "比较失败"); }
    finally { if (token === generation.current) setBusy(false); }
  }
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (locked || !selected || !pendingResolved()) return;
    setError(""); setReceipt(null); clearPreview();
    try {
      const form = new FormData(event.currentTarget), value = (key: string) => String(form.get(key) ?? "").trim();
      let command: Record<string, unknown>;
      if (operation === "add_entry") command = { listing_id: value("listing_id") };
      else if (operation === "store_source") command = { reference: value("reference"), document: parseStrictJson(value("document")) };
      else {
        if (!detail || detail.portfolio_id !== selected) throw new Error("请先打开本组合的标的资料");
        const base = { listing_id: detail.listing_id, source_id: value("source_id"), as_of: value("as_of") };
        command = operation === "publish_profile"
          ? { ...base, expected_profile_version: detail.profile?.version ?? 0, profile: profileFromForm(form) }
          : { ...base, expected_holdings_version: detail.holdings?.version ?? 0, weight_basis: "net_assets_long_only", complete: form.get("complete") === "on", ...parseHoldingsDraft(holdingsText) };
        if (command.complete && command.coverage !== "1") throw new Error("完整披露必须明确确认且权重合计恰好为 1");
      }
      setAttempt({ action: operation, command: { ...command, portfolio_id: selected, expected_catalog_revision: state.catalog_revision, idempotency_key: crypto.randomUUID() } });
    } catch (error) { setError(error instanceof Error ? error.message : "资料格式错误"); }
  }
  async function commit() {
    if (!attempt || !confirmed || locked || !selected) return;
    setBusy(true); setError("");
    try {
      const result = await request<unknown>("/api/workbench/catalog", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(attempt) });
      setReceipt(result); clearPreview(); editor.current?.reset(); setHoldingsText("[]"); setDetail(null); setSelections([]); setComparison(null);
      await load(selected, appliedFilters);
    } catch (error) {
      setConfirmed(false);
      if (error instanceof CatalogRequestError && error.status < 500) clearPreview();
      else setUncertain(true);
      setError(error instanceof Error ? error.message : "响应不确定，请核对后以相同预览重试。");
    } finally { setBusy(false); }
  }
  const publication = operation === "publish_profile" || operation === "publish_holdings";
  const ready = state.selected_portfolio_id === selected;
  const comparisonName = (id: string) => { const row = comparison?.rows.find(value => value.listing_id === id); return row ? `${row.ticker} / ${row.name}` : id; };
  let coverage = "尚未正确填写";
  try { coverage = percentRatio(parseHoldingsDraft(holdingsText).coverage); } catch { /* The explicit preview reports the validation error. */ }
  return <div inert={!hydrated} data-hydrated={hydrated} aria-busy={busy} className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-8">
    <header><p className="text-sm text-muted-foreground">ETF / CATALOG</p><h1 className="mt-1 text-3xl font-semibold">ETF 标的与持仓比较</h1><p className="mt-2 text-sm text-muted-foreground">按组合保留来源和历史版本，区分披露覆盖与未知敞口。加入目录、保存资料或比较均不等于投资准入。</p></header>
    <nav aria-label="工作台模块" className="flex flex-wrap gap-4 text-sm"><Link className="underline" href="/workbench">账户与账本</Link><Link className="underline" href="/workbench/funding">资金计划</Link><Link className="underline" href="/workbench/research">策略研究</Link><Link className="underline" href="/workbench/governance">政策与执行</Link></nav>
    {error && <p role="alert" className="break-all rounded-lg border border-red-500/40 p-4 text-sm">{error}</p>}
    {state.read_only && <p role="status" className="rounded-lg border p-4 text-sm">当前为恢复只读模式，不能保存目录、来源或资料版本。</p>}
    <section className={panel}><div className="flex flex-wrap items-end gap-3"><label className={`${field} flex-1`}>当前组合<select aria-label="当前组合" className={selectClass} value={selected ?? ""} disabled={busy} onChange={event => switchPortfolio(event.target.value)}><option value="" disabled>请先建立组合</option>{state.portfolios.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><Button variant="outline" disabled={busy || !selected} onClick={refresh}>刷新目录</Button></div>
      {!selected ? <Link href="/workbench" className="text-sm underline">前往建立空组合</Link> : <p className="text-sm text-muted-foreground">研究目录版本 {ready ? state.catalog_revision : "读取中"}；与账本版本独立。资料不会跨组合共享。</p>}
      <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); refresh(); }}><label className={field}>上市市场<select aria-label="上市市场" className={selectClass} value={market} disabled={busy} onChange={event => setMarket(event.target.value)}><option value="">全部市场</option><option value="CN">A 股</option><option value="HK">港股</option><option value="US">美股</option></select></label><label className={`${field} flex-1`}>标的名称或代码<Input value={search} onChange={event => setSearch(event.target.value)} maxLength={100} disabled={busy} /></label><Button type="submit" disabled={busy || !selected}>筛选目录</Button></form>
    </section>
    {ready && selected && <section className={panel}><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">本组合研究目录</h2><Button disabled={busy || selections.length < 2} onClick={() => void compare()}>比较已选 {selections.length} / 4</Button></div>
      {!state.rows.length && <p className="text-sm text-muted-foreground">暂无匹配标的。可先在账本登记证券标识，再加入此组合目录；不会自动引入市场清单。</p>}
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">{state.rows.map(row => <article key={row.listing_id} className="min-w-0 space-y-3 rounded-lg border p-4 text-sm"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words font-semibold">{row.name}</h3><p className="break-all text-muted-foreground">{row.market} / {row.exchange} / {row.ticker} / {row.currency}</p></div><label className="flex shrink-0 items-center gap-2"><input type="checkbox" aria-label={`比较 ${row.ticker}`} disabled={busy || (selections.length >= 4 && !selections.some(value => value.listing_id === row.listing_id))} checked={selections.some(value => value.listing_id === row.listing_id)} onChange={event => { setComparison(null); setSelections(previous => event.target.checked ? [...previous, { listing_id: row.listing_id, ...(row.profile ? { profile_version_id: row.profile.id } : {}), ...(row.holdings ? { holdings_version_id: row.holdings.snapshot_id } : {}) }] : previous.filter(value => value.listing_id !== row.listing_id)); }} />比较</label></div>
        <dl className="grid grid-cols-2 gap-3"><div><dt className="text-muted-foreground">跟踪指数</dt><dd className="break-all">{row.profile?.profile.index_id ?? "未知"}</dd></div><div><dt className="text-muted-foreground">基金年费率</dt><dd>{percentRatio(row.profile?.profile.annual_expense_ratio)}</dd></div><div><dt className="text-muted-foreground">持仓披露覆盖</dt><dd>{percentRatio(row.holdings?.coverage)}{row.holdings ? row.holdings.complete ? " / 声明完整" : " / 部分披露" : ""}</dd></div><div><dt className="text-muted-foreground">披露日期</dt><dd>{row.holdings?.as_of ?? "未知"}</dd></div></dl>
        <p className="text-muted-foreground">类型记录：{row.instrument_class}；挂牌记录：{row.status}。均不代表真实 ETF 核验或账户交易许可。</p><Button variant="outline" disabled={busy} onClick={() => void openDetail(row.listing_id)}>查看 {row.ticker} 资料</Button>
      </article>)}</div>
      {state.next_cursor && <Button variant="outline" disabled={busy} onClick={() => { if (selected && state.next_cursor) void load(selected, { ...appliedFilters, cursor: state.next_cursor }); }}>继续加载目录</Button>}
    </section>}
    {comparison && <section className={panel}>
      <h2 className="text-lg font-semibold">所选资料与披露比较</h2>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">{comparison.rows.map(row => <article key={row.listing_id} className="min-w-0 space-y-2 rounded-lg border p-3 text-sm"><h3 className="break-words font-medium">{row.ticker} / {row.name}</h3><p>交易币种 {row.currency}；底层资产 {row.profile?.profile.underlying_asset_class ?? "unknown"}</p><p className="break-all">指数 {row.profile?.profile.index_id ?? "未知"}</p><p>年费率 {percentRatio(row.profile?.profile.annual_expense_ratio)}；注册地 {row.profile?.profile.domicile ?? "未知"}</p><p className="break-words">地区标签 {row.profile?.profile.economic_regions.join(", ") || "未知"}；行业标签 {row.profile?.profile.sectors.join(", ") || "未知"}</p><p>资料日期 {row.profile?.as_of ?? "未知"}；分配 {row.profile?.profile.distribution ?? "unknown"} / 复制 {row.profile?.profile.replication ?? "unknown"}</p></article>)}</div>
      <p className="text-sm text-muted-foreground">已知重叠是下界；保守上界可能宽松。异日期结果仅描述两份历史披露，不表示当前同日重叠。未知持仓不会归一化为零风险；地区与行业标签不是加权敞口。</p>
      {comparison.pairs.map((pair, index) => <article key={index} className="space-y-2 rounded-lg border p-4 text-sm"><h3 className="break-all font-medium">{comparisonName(pair.listing_a)} 与 {comparisonName(pair.listing_b)}</h3>{pair.overlap ? <><p>已知重叠 {percentRatio(pair.overlap.known_overlap)} — 保守上界 {percentRatio(pair.overlap.conservative_upper_bound)}</p><p>披露覆盖 {percentRatio(pair.overlap.coverage_a)} / {percentRatio(pair.overlap.coverage_b)}；未覆盖 {percentRatio(pair.overlap.uncovered_a)} / {percentRatio(pair.overlap.uncovered_b)}</p><p>披露日期 {pair.overlap.snapshot_a.as_of} / {pair.overlap.snapshot_b.as_of}；{pair.overlap.quality === "exact" ? "同日完整披露的精确重叠" : pair.overlap.quality === "different_dates" ? "异日期历史向量，不能当作当前精确值" : "部分披露的上下界"}</p><Evidence title="共同证券与计算绑定" value={pair.overlap} /></> : <p>缺少可比较的持仓披露：未知，不输出零重叠。</p>}</article>)}<Evidence title="比较的精确版本与资料字段" value={comparison} />
    </section>}
    {detail && <section className={panel}><h2 className="text-lg font-semibold">{detail.name} · 资料与历史版本</h2><p className="break-all text-sm text-muted-foreground">{detail.listing_id}；地区、行业仅为研究标签，不是加权集中度证据。</p>{detail.profile && <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">{Object.entries({ 发行人: detail.profile.profile.issuer, 跟踪指数: detail.profile.profile.index_id, 注册地: detail.profile.profile.domicile, 底层资产: detail.profile.profile.underlying_asset_class, 经济地区: detail.profile.profile.economic_regions.join(", ") || null, 行业: detail.profile.profile.sectors.join(", ") || null, 基金年费率: percentRatio(detail.profile.profile.annual_expense_ratio), 分配方式: detail.profile.profile.distribution, 复制方式: detail.profile.profile.replication, 资料日期: detail.profile.as_of }).map(([key, value]) => <div key={key}><dt className="text-muted-foreground">{key}</dt><dd className="break-words">{value ?? "未知"}</dd></div>)}</dl>}
      <h3 className="font-medium">账户范围核验</h3><p className="text-sm text-muted-foreground">有效证据覆盖不等于实盘可下单，仍需账户对账、价格、费用、政策和人工审批。</p>{detail.account_capabilities.map(row => <p key={row.account_id} className="break-all text-sm">{row.account_name}：买入 {row.buy} / 卖出 {row.sell}</p>)}{!detail.account_capabilities.length && <p className="text-sm">尚无账户，账户可买性未知。</p>}
      <Evidence title="历次资料版本" value={detail.profile_versions} /><Evidence title="历次持仓披露摘要" value={detail.holdings_versions} />
      {(detail.profile_versions_truncated || detail.holdings_versions_truncated || detail.sources_truncated) && <p className="text-sm text-amber-600">此处每类最多展示最近 100 条，存在被截断的历史记录；不是完整历史。持仓列表仅展示摘要，不包含全部证券行。</p>}
      {detail.account_capabilities_truncated && <p className="text-sm text-amber-600">仅展示前 1000 个账户，账户范围摘要已截断。</p>}
      <h3 className="font-medium">本组合保留的结构化来源</h3>{detail.sources.map(source => <div key={source.id} className="min-w-0 space-y-1 text-sm"><p className="break-all">{source.reference} · {source.known_at}</p><a className="break-all underline" href={`/api/workbench/catalog?${new URLSearchParams({ view: "source", portfolio: selected!, source: source.id })}`}>下载来源 {source.id}</a></div>)}
    </section>}
    {selected && <section className={panel}><h2 className="text-lg font-semibold">维护研究目录</h2><p className="text-sm text-muted-foreground">仅保存本组合研究资料。来源是人工提交的结构化 JSON，不会自动抓取链接或认证为基金官方原件。未知项留空，不猜测费率或暴露。</p>
      <form ref={editor} key={`${selected}:${operation}:${detail?.listing_id ?? "none"}`} onSubmit={prepare} onChange={clearPreview} className="space-y-4"><fieldset disabled={locked || uncertain} className="min-w-0 space-y-4"><label className={field}>目录操作<select aria-label="目录操作" className={selectClass} value={operation} onChange={event => { setOperation(event.target.value); clearPreview(); }}>
        {operations.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      {operation === "add_entry" && <><label className={field}>已有证券标识<Input name="listing_id" list="catalog-identities" maxLength={160} required /></label><datalist id="catalog-identities">{state.identity_options.map(row => <option key={row.listing_id} value={row.listing_id}>{row.market} / {row.ticker} / {row.name}</option>)}</datalist><p className="text-sm text-muted-foreground">{state.identity_options_truncated ? "选择提示已截断；可以输入完整 listing ID。" : "仅显示已有证券标识，不表示完整市场清单。"}未登记标识请先前往账户与账本登记。</p></>}
      {operation === "store_source" && <><label className={field}>来源说明或引用<Input name="reference" maxLength={2000} required /></label><label className={field}>结构化来源 JSON<textarea aria-label="结构化来源 JSON" name="document" className={textareaClass} required placeholder={'{"source": "Synthetic example only"}'} /></label></>}
      {publication && (!detail ? <p role="status" className="text-sm">请先在目录中点击“查看资料”，选择要保存版本的标的。</p> : <><p className="break-all text-sm">本次标的：{detail.name} / {detail.ticker}；当前资料版本 {detail.profile?.version ?? 0} / 持仓版本 {detail.holdings?.version ?? 0}</p><div className="grid gap-4 sm:grid-cols-2"><label className={field}>引用结构化来源<select name="source_id" aria-label="引用结构化来源" className={selectClass} required defaultValue=""><option value="">请选择已保留来源</option>{detail.sources.map(row => <option key={row.id} value={row.id}>{row.reference} / {row.id}</option>)}</select></label><label className={field}>资料或披露日期<Input name="as_of" type="date" required /></label></div>
        {operation === "publish_profile" ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[["issuer", "发行人"], ["index_id", "跟踪指数标识"], ["domicile", "基金注册地"], ["economic_regions", "经济地区标签（英文逗号分隔）"], ["sectors", "行业标签（英文逗号分隔）"], ["annual_expense_ratio", "年费率比例（例如 0.002，未知留空）"]].map(([name, label]) => <label key={name} className={field}>{label}<Input name={name} maxLength={name === "annual_expense_ratio" ? 40 : 200} /></label>)}<label className={field}>底层资产类别<select name="underlying_asset_class" className={selectClass} defaultValue="unknown">{["unknown", "equity", "fixed_income", "commodity", "multi_asset", "cash", "other"].map(value => <option key={value}>{value}</option>)}</select></label><label className={field}>分配方式<select name="distribution" className={selectClass} defaultValue="unknown">{["unknown", "accumulating", "distributing", "mixed"].map(value => <option key={value}>{value}</option>)}</select></label><label className={field}>复制方式<select name="replication" className={selectClass} defaultValue="unknown">{["unknown", "physical", "synthetic", "mixed"].map(value => <option key={value}>{value}</option>)}</select></label></div>
        : <><label className={field}>持仓权重 JSON<textarea aria-label="持仓权重 JSON" className={textareaClass} value={holdingsText} onChange={event => setHoldingsText(event.target.value)} /></label><p className="text-sm">已披露权重合计：{coverage}。只支持多头净资产权重，不按名称合并、不自动归一化。</p><p className="break-all text-xs text-muted-foreground">格式：{`[{"security_id":"ISIN:SYNTHETIC1","weight":"0.25"}]`}。该标识仅为虚构格式示例。</p><label className="flex items-start gap-2 text-sm"><input name="complete" type="checkbox" className="mt-1" /><span>原件明确为完整持仓披露，权重总和为 1。否则保留为部分披露。</span></label></>}
      </>)}
      {operation === "publish_profile" && <p className="text-sm text-muted-foreground">资料版本是完整记录，不是局部补丁。空白或 unknown 会作为未知保存；请逐项核对预览和历史版本。</p>}
      <Button type="submit" disabled={publication && !detail}>预览目录变更</Button></fieldset></form>
      {attempt && <div className="space-y-4 rounded-lg border p-4"><h3 className="font-medium">保存前核对</h3><Evidence title="拟保存的完整命令与版本" value={attempt} />{uncertain && <p className="text-sm">上次响应未确认。原请求和幂等键仍被保留；请先重试或核对后明确放弃跟踪。编辑、切换标的和页内刷新不能静默丢弃它。离开页面或强制重载可能丢失此预览，操作前务必核对服务器记录。</p>}<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} /><span>我已核对组合、标的、日期、来源及披露覆盖。本次仅保存研究记录，不授予交易权限。</span></label><div className="flex flex-wrap gap-3"><Button disabled={locked || !confirmed} onClick={() => void commit()}>{uncertain ? "以相同请求重试" : "确认保存目录记录"}</Button>{uncertain && <Button variant="outline" disabled={busy} onClick={clearPreview}>已核对记录，放弃跟踪此请求</Button>}</div></div>}
      {receipt !== null && <Evidence title="目录操作回执" value={receipt} />}
    </section>}
  </div>;
}
