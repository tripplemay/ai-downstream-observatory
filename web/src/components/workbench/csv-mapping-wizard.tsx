"use client";

import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CsvDialect } from "@/server/ledger/csv";
import type { CsvInspectionContext, CsvInspectionResponse, CsvInspectionValues } from "@/server/ledger/csv-inspection-types";
import { CSV_FACT_TYPES, type CsvBinding, type CsvMapping } from "@/server/ledger/csv-schemas";
import { allowedCsvBindingKinds, compileCsvMappingDraft, createEmptyCsvMappingDraft, CSV_RULE_FIELDS, csvColumnUsage, forkCsvMappingVersion, type CsvMappingDraft } from "./csv-mapping-builder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { assertCsvInspectionResponse } from "./csv-inspection-response";

interface Props {
  file: File | null; portfolioId: string; accountId: string; revision: number; disabled: boolean;
  previousMapping: CsvMapping | null;
  onApply: (mapping: string, contentHash: string) => boolean;
  onInvalidate: () => void; onBusyChange: (busy: boolean) => void;
}
const fieldClass = "flex min-w-0 flex-col gap-1.5 text-sm";
const selectClass = "h-10 w-full min-w-0 max-w-full rounded-md border bg-background px-2 text-sm";
const events: Record<string, string> = {
  opening_cash: "期初现金", opening_position: "期初持仓", deposit: "实际入金", withdrawal: "实际出金", buy: "买入", sell: "卖出", settlement: "成交结算",
  dividend_accrual: "分红应收（税额明确）", dividend_payment: "分红收款", dividend: "现金分红（税额明确）", fee: "独立费用", fx: "实际换汇", transfer_out: "现金内部转出", transfer_in: "现金内部转入", split: "拆合股",
};
const names: Record<string, string> = {
  account: "导入账户", event_type: "事件类型", reason: "核实依据", source_event_id: "可靠来源记录号", currency: "原币", listing_id: "已登记上市标识", target_account_id: "目标账户",
  target_currency: "收到币种", direction: "结算方向", related_event_id: "关联账本事件 ID", amount: "金额 / 分红毛额", quantity: "数量", cost_amount: "历史成本", price: "单价", consideration: "成交总额", fee: "明确费用", tax: "明确税额", received_amount: "实际收到金额", split_numerator: "拆合股分子", split_denominator: "拆合股分母",
};
const kindNames = { constant: "固定值（人工填写）", column: "文本列", lookup: "原值逐项对照", decimal: "数值列（明确格式）" };
const dateFormats = ["YYYY-MM-DD", "YYYY/MM/DD", "YYYYMMDD", "ISO8601_OFFSET"] as const;
const delimiterName = (value: string) => value === "," ? "逗号" : value === ";" ? "分号" : "制表符 TAB";
const errorText = (error: unknown) => error instanceof Error ? error.message : "CSV 检查失败";
const constant = (): CsvBinding => ({ kind: "constant", value: "" });
const DirectoryListPrefix = createContext("");
function newBinding(kind: CsvBinding["kind"]): CsvBinding {
  if (kind === "constant") return constant();
  if (kind === "lookup") return { kind, column: "", trim: false, entries: [] };
  if (kind === "column") return { kind, column: "", trim: false, empty: "reject" };
  return { kind, column: "", empty: "reject", format: { decimal_separator: ".", grouping_separator: "none", negative_style: "minus", allow_leading_plus: false, trim: false } };
}
function ColumnSelect({ label, headers, value, onChange }: { label: string; headers: string[]; value: string; onChange: (value: string) => void }) {
  return <label className={fieldClass}>{label}<select aria-label={label} className={selectClass} value={value} onChange={event => onChange(event.target.value)}><option value="">请选择原始列，不猜测</option>{headers.map((header, index) => <option key={header} value={header}>{index + 1}. {header}</option>)}</select></label>;
}
type ValuesReader = (column: string, trim: boolean, offset: number) => Promise<CsvInspectionValues>;
function MappingValue({ name, label, value, onChange, accountId }: { name: string; label: string; value: string; onChange: (value: string) => void; context: CsvInspectionContext; accountId: string }) {
  const prefix = useContext(DirectoryListPrefix);
  const choices = name === "event_type" ? CSV_FACT_TYPES.map(id => ({ id, label: `${events[id]} / ${id}` }))
    : name === "direction" ? [{ id: "buy", label: "买入结算" }, { id: "sell", label: "卖出结算" }]
    : name === "account" ? [{ id: accountId, label: accountId }] : null;
  if (choices) return <select aria-label={label} className={selectClass} value={value} onChange={event => onChange(event.target.value)}><option value="">请选择明确值</option>{choices.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select>;
  const list = name === "listing_id" ? "listings" : name === "target_account_id" ? "accounts" : name === "currency" || name === "target_currency" ? "currencies" : null;
  return <Input aria-label={label} value={value} list={list ? `${prefix}-${list}` : undefined} maxLength={2000} onChange={event => onChange(event.target.value)} placeholder={name === "related_event_id" ? "已入账事件的完整 ID，不是券商流水号" : "明确填写；未知不要填零"} />;
}

function BindingEditor({ path, name, binding, headers, context, accountId, onChange, getValues, optional = false }: {
  path: string; name: string; binding: CsvBinding | undefined; headers: string[]; context: CsvInspectionContext; accountId: string;
  onChange: (binding: CsvBinding | undefined) => void; getValues: ValuesReader; optional?: boolean;
}) {
  const [page, setPage] = useState(0), [values, setValues] = useState<CsvInspectionValues | null>(null), [error, setError] = useState("");
  const mounted = useRef(true), [loading, setLoading] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const lookupKey = binding?.kind === "lookup" ? JSON.stringify([binding.column, binding.trim]) : "";
  useEffect(() => { setValues(null); setPage(0); setError(""); }, [lookupKey]);
  const currentLookupKey = useRef(lookupKey); currentLookupKey.current = lookupKey;
  async function loadValues(offset: number) {
    if (binding?.kind !== "lookup" || !binding.column || loading) return;
    const key = lookupKey; setLoading(true); setError("");
    try { const result = await getValues(binding.column, binding.trim, offset); if (mounted.current && currentLookupKey.current === key) setValues(result); }
    catch (caught) { if (mounted.current && currentLookupKey.current === key) setError(errorText(caught)); }
    finally { if (mounted.current) setLoading(false); }
  }
  const visibleEntries = binding?.kind === "lookup" ? binding.entries.slice(page * 25, page * 25 + 25) : [];
  const label = `${path} · ${names[name] ?? name}`;
  return <div className="min-w-0 space-y-3 rounded-lg border p-3">
    <label className={fieldClass}>{label}{optional ? "（可不配置，保留未知）" : "（必填）"}<select aria-label={`${path} 映射方式`} className={selectClass} value={binding?.kind ?? ""} onChange={event => { setPage(0); setValues(null); onChange(event.target.value ? newBinding(event.target.value as CsvBinding["kind"]) : undefined); }}><option value="">未配置</option>{allowedCsvBindingKinds(name).map(kind => <option key={kind} value={kind}>{kindNames[kind]}</option>)}</select></label>
    {binding?.kind === "constant" && <MappingValue name={name} label={`${path} 固定值`} value={binding.value} onChange={value => onChange({ ...binding, value })} context={context} accountId={accountId} />}
    {binding && binding.kind !== "constant" && <ColumnSelect label={`${path} 原始列`} headers={headers} value={binding.column} onChange={column => onChange({ ...binding, column })} />}
    {binding && "trim" in binding && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={binding.trim} onChange={event => onChange({ ...binding, trim: event.target.checked })} />{path}：明确移除首尾空白</label>}
    {binding && "empty" in binding && <label className={fieldClass}>{path} 空值处理<select aria-label={`${path} 空值处理`} className={selectClass} value={binding.empty} onChange={event => onChange({ ...binding, empty: event.target.value as "reject" | "omit" })}><option value="reject">拒绝空值，不填零</option>{optional && !["fee", "tax"].includes(name) && <option value="omit">明确省略，保留未知</option>}</select></label>}
    {binding?.kind === "decimal" && <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2"><legend className="mb-2 text-xs">{path} 数值格式模板（必须按原文件确认）</legend>
      <label className={fieldClass}>小数符<select aria-label={`${path} 小数符`} className={selectClass} value={binding.format.decimal_separator} onChange={event => onChange({ ...binding, format: { ...binding.format, decimal_separator: event.target.value as "." | "," } })}><option value=".">.</option><option value=",">,</option></select></label>
      <label className={fieldClass}>千位分组符<select aria-label={`${path} 分组符`} className={selectClass} value={binding.format.grouping_separator} onChange={event => onChange({ ...binding, format: { ...binding.format, grouping_separator: event.target.value as typeof binding.format.grouping_separator } })}><option value="none">无</option><option value=",">,</option><option value=".">.</option><option value=" ">普通空格</option></select></label>
      <label className={fieldClass}>负数表示<select aria-label={`${path} 负数表示`} className={selectClass} value={binding.format.negative_style} onChange={event => onChange({ ...binding, format: { ...binding.format, negative_style: event.target.value as typeof binding.format.negative_style } })}><option value="minus">前置减号</option><option value="parentheses">括号</option><option value="either">二者均允许</option></select></label>
      <div className="space-y-2 text-xs"><label className="flex gap-2"><input type="checkbox" checked={binding.format.allow_leading_plus} onChange={event => onChange({ ...binding, format: { ...binding.format, allow_leading_plus: event.target.checked } })} />{path} 允许前置加号</label><label className="flex gap-2"><input type="checkbox" checked={binding.format.trim} onChange={event => onChange({ ...binding, format: { ...binding.format, trim: event.target.checked } })} />{path} 数值先去首尾空白</label></div>
      <p className="text-xs text-muted-foreground sm:col-span-2">保留原符号；不自动取绝对值、换单位、拆净额或清除货币符号。不支持百分比换算。</p>
    </fieldset>}
    {binding?.kind === "lookup" && <div className="space-y-3">
      <p className="text-xs text-muted-foreground">对照原值保留文本，证券代码不去前导零。未列出的原值会阻断，不自动丢行；对照值必须逐项选择。</p>
      {error && <p role="alert" className="break-all text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={!binding.column || loading} onClick={() => void loadValues(0)}>读取该列完整原值（分页）</Button><Button type="button" size="sm" variant="outline" onClick={() => { onChange({ ...binding, entries: [...binding.entries, { input: "", value: "" }] }); setPage(Math.floor(binding.entries.length / 25)); }}>手动增加对照</Button></div>
      {values && <div className="space-y-2 rounded border p-3 text-xs"><p>原值总数 {values.total}；本页 {values.items.length} 项，从 {values.offset + 1} 开始。以下不是截断样本。</p>{values.items.map((item, index) => <div key={`${values.offset}:${index}`} className="flex min-w-0 flex-wrap items-center gap-2"><pre className="max-h-24 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all">{item.value === "" ? "（空原值）" : item.value}</pre><span>{item.count} 行{item.formula_like ? " · 公式样式仅文本" : ""}</span><Button type="button" size="sm" variant="outline" disabled={!item.lookup_compatible || binding.entries.some(entry => (binding.trim ? entry.input.trim() : entry.input) === item.value)} onClick={() => { onChange({ ...binding, entries: [...binding.entries, { input: item.value, value: "" }] }); setPage(Math.floor(binding.entries.length / 25)); }}>加入待映射</Button>{!item.lookup_compatible && <span>超出当前对照键上限，不能截断后使用</span>}</div>)}{values.next_offset !== null && <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void loadValues(values.next_offset!)}>下一页完整原值</Button>}</div>}
      {visibleEntries.map((entry, index) => { const actual = page * 25 + index; return <div key={actual} className="grid min-w-0 gap-2 rounded border p-2 sm:grid-cols-[1fr_1fr_auto]"><label className={fieldClass}>原值 {actual + 1}<Input aria-label={`${path} 原值 ${actual + 1}`} value={entry.input} maxLength={256} onChange={event => onChange({ ...binding, entries: binding.entries.map((row, i) => i === actual ? { ...row, input: event.target.value } : row) })} /></label><label className={fieldClass}>映射为<MappingValue name={name} label={`${path} 对照值 ${actual + 1}`} value={entry.value} onChange={value => onChange({ ...binding, entries: binding.entries.map((row, i) => i === actual ? { ...row, value } : row) })} context={context} accountId={accountId} /></label><Button type="button" className="self-end" variant="outline" size="sm" onClick={() => { onChange({ ...binding, entries: binding.entries.filter((_, i) => i !== actual) }); setPage(Math.min(page, Math.max(0, Math.ceil((binding.entries.length - 1) / 25) - 1))); }}>删除</Button></div>; })}
      {!!binding.entries.length && <div className="flex flex-wrap items-center gap-2 text-xs"><Button type="button" variant="outline" size="sm" disabled={!page} onClick={() => setPage(page - 1)}>上一组对照</Button><span>已建 {binding.entries.length} 项对照 · 第 {page + 1} / {Math.ceil(binding.entries.length / 25)} 组</span><Button type="button" variant="outline" size="sm" disabled={(page + 1) * 25 >= binding.entries.length} onClick={() => setPage(page + 1)}>下一组对照</Button></div>}
    </div>}
  </div>;
}

export function CsvMappingWizard({ file, portfolioId, accountId, revision, disabled, previousMapping, onApply, onInvalidate, onBusyChange }: Props) {
  const directoryPrefix = useId();
  const [inspection, setInspection] = useState<CsvInspectionResponse | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [draft, setDraft] = useState<CsvMappingDraft>(() => createEmptyCsvMappingDraft(accountId));
  const [recordSeparator, setRecordSeparator] = useState<CsvDialect["record_separator"]>("either");
  const [acknowledged, setAcknowledged] = useState(false), [sourceChoice, setSourceChoice] = useState<"" | "none" | "column">("");
  const [attempted, setAttempted] = useState(false), [applied, setApplied] = useState(false);
  const [edited, setEdited] = useState(false);
  const context = JSON.stringify([portfolioId, accountId, revision]), active = useRef({ context, file }), sequence = useRef(0);
  active.current = { context, file };
  useEffect(() => {
    sequence.current++; setInspection(null); setDraft(createEmptyCsvMappingDraft(accountId)); setError(""); setBusy(false); setAcknowledged(false); setSourceChoice(""); setAttempted(false); setApplied(false); setEdited(false);
    return () => { sequence.current++; };
  }, [file, portfolioId, accountId, revision]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  const selected = inspection?.selected;
  const current = (token: number, capturedFile: File) => token === sequence.current && active.current.context === context && active.current.file === capturedFile;
  function change(next: CsvMappingDraft, edited = true) { setDraft(next); setEdited(edited); setAcknowledged(false); setApplied(false); onInvalidate(); }
  function allowReset() { return !edited || window.confirm("重新检查分隔符或换行规则会清除当前向导字段草稿。已保存证据不受影响。确定重新检查？"); }
  function restartInspection(dialect: "auto" | CsvDialect) { if (allowReset()) void inspect(dialect).catch(() => {}); }
  async function inspect(dialect: "auto" | CsvDialect, values?: { column: string; trim: boolean; offset: number; limit: number }) {
    if (!file || busy || disabled) throw new Error("请先选择 CSV 原文件与实际账户。");
    const original = file, token = ++sequence.current; setBusy(true); setError("");
    try {
      const data = new FormData(); data.set("file", original); data.set("portfolio_id", portfolioId); data.set("account_id", accountId); data.set("expected_revision", String(revision)); data.set("dialect", dialect === "auto" ? dialect : JSON.stringify(dialect));
      if (values) data.set("values", JSON.stringify(values));
      const response = await fetch("/api/workbench/csv/inspect", { method: "POST", body: data });
      let result: unknown;
      try { result = await response.json(); } catch { throw new Error(`检查响应不可解析（HTTP ${response.status}），未将检查结果用于映射。`); }
      if (!response.ok) throw new Error(result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : `CSV 检查失败（HTTP ${response.status}）`);
      if (!current(token, original)) throw new Error("CSV_INSPECTION_CONTEXT_CHANGED");
      assertCsvInspectionResponse(result);
      if (result.portfolio_id !== portfolioId || result.account_id !== accountId || result.ledger_revision !== revision || result.byte_length !== original.size) throw new Error("CSV_INSPECTION_RESPONSE_INVALID");
      const digest = await crypto.subtle.digest("SHA-256", await original.arrayBuffer());
      if (!current(token, original)) throw new Error("CSV_INSPECTION_CONTEXT_CHANGED");
      if ([...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("") !== result.content_hash) throw new Error("CSV_INSPECTION_FILE_HASH_MISMATCH");
      if (values) {
        if (!inspection || result.content_hash !== inspection.content_hash || !result.values || result.values.column !== values.column || result.values.trim !== values.trim || result.values.offset !== values.offset) throw new Error("CSV_VALUES_RESPONSE_MISMATCH");
      } else {
        setInspection(result); setSourceChoice(""); setAttempted(false);
        const next = createEmptyCsvMappingDraft(accountId, result.selected?.headers ?? []);
        if (result.selected) next.dialect = result.selected.dialect;
        change(next, false);
      }
      return result;
    } catch (caught) { if (current(token, original)) setError(errorText(caught)); throw caught; }
    finally { if (current(token, original)) setBusy(false); }
  }
  const getValues: ValuesReader = async (column, trim, offset) => {
    if (!selected) throw new Error("请先确认文件方言");
    return (await inspect(selected.dialect, { column, trim, offset, limit: 100 })).values!;
  };
  const compiled = useMemo(() => selected && inspection ? compileCsvMappingDraft(draft, { ...inspection.context, portfolio_id: portfolioId, account_id: accountId, headers: selected.headers }, previousMapping ?? undefined) : null, [draft, selected, inspection, portfolioId, accountId, previousMapping]);
  const usage = csvColumnUsage(draft);
  const updateEvent = (binding: CsvBinding | undefined) => {
    if (binding && binding.kind !== "constant" && binding.kind !== "lookup") return;
    const values = binding?.kind === "constant" ? [binding.value] : binding?.entries.map(entry => entry.value) ?? [];
    const types = CSV_FACT_TYPES.filter(type => values.includes(type));
    change({ ...draft, event_type: binding ?? { kind: "constant", value: "" }, rules: types.map(event_type => draft.rules.find(rule => rule.event_type === event_type) ?? { event_type, fields: { currency: constant() } }) });
  };
  function apply() {
    setAttempted(true);
    if (!inspection || !selected?.valid || !compiled?.ok || !acknowledged || !sourceChoice) return;
    if (onApply(JSON.stringify(compiled.mapping, null, 2), inspection.content_hash)) setApplied(true);
  }
  function loadKnownMapping() {
    if (!previousMapping || !selected || !allowReset()) return;
    if (JSON.stringify(previousMapping.expected_headers) !== JSON.stringify(selected.headers)
      || previousMapping.dialect.delimiter !== selected.dialect.delimiter || previousMapping.dialect.record_separator !== selected.dialect.record_separator) {
      setError("已有映射的表头或方言与本次检查不一致，不能自动套用。请明确建立匹配的新映射。"); return;
    }
    change(structuredClone(previousMapping)); setSourceChoice(previousMapping.source_event_id ? "column" : "none"); setError("");
  }
  return <DirectoryListPrefix.Provider value={directoryPrefix}><div className="min-w-0 space-y-4 rounded-lg border p-4" aria-busy={busy}>
    <datalist id={`${directoryPrefix}-listings`}>{inspection?.context.listings.items.map(row => <option key={row.id} value={row.id}>{row.ticker} {row.name} / {row.currency}</option>)}</datalist>
    <datalist id={`${directoryPrefix}-accounts`}>{inspection?.context.accounts.items.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</datalist>
    <datalist id={`${directoryPrefix}-currencies`}>{["CNY", "HKD", "USD"].map(id => <option key={id} value={id} />)}</datalist>
    <h3 className="font-semibold">可视化映射向导</h3>
    <p className="text-sm text-muted-foreground">检查原文件不保存附件、映射或批次，也不写账本。字段映射由你确认，系统不自动认定券商格式或交易含义。</p>
    {error && <p role="alert" className="break-all rounded border border-red-500/30 p-3 text-sm text-red-600">{error}</p>}
    <fieldset disabled={disabled || busy} className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-end gap-3"><label className={fieldClass}>允许的记录换行<select aria-label="CSV 记录换行" className={selectClass} value={recordSeparator} onChange={event => { if (!allowReset()) return; setRecordSeparator(event.target.value as CsvDialect["record_separator"]); setInspection(null); change(createEmptyCsvMappingDraft(accountId), false); }}><option value="either">CRLF 或 LF（两者允许）</option><option value="crlf">仅 CRLF</option><option value="lf">仅 LF</option></select></label><Button type="button" variant="outline" disabled={!file || !portfolioId || !accountId} onClick={() => restartInspection("auto")}>{busy ? "正在检查…" : "1. 检查文件与分隔符候选"}</Button></div>
      {inspection && <div className="min-w-0 space-y-3 text-sm"><p className="break-all">SHA-256：{inspection.content_hash} · {inspection.byte_length} bytes · UTF-8{inspection.bom ? " / BOM" : ""} · 未写入状态</p><p>必须明确选择分隔符；候选有效不表示交易含义正确。</p><div className="flex flex-wrap gap-2">{inspection.candidates.map(candidate => <Button type="button" variant="outline" key={candidate.dialect.delimiter} onClick={() => restartInspection({ ...candidate.dialect, record_separator: recordSeparator })}>{delimiterName(candidate.dialect.delimiter)} · {candidate.column_count} 列 / {candidate.row_count} 行{candidate.valid ? "" : " · 有错误"}</Button>)}</div></div>}
      {selected && inspection && <>
        <div className="space-y-2 rounded border p-3 text-sm"><p>已选 {delimiterName(selected.dialect.delimiter)}，{selected.headers.length} 列、{selected.row_count} 行；完整文件解析{selected.valid ? "通过" : "未通过"}。</p>{selected.header_location && <p>表头物理行 {selected.header_location.line_start}–{selected.header_location.line_end}；字节 [{selected.header_location.byte_start}, {selected.header_location.byte_end})。</p>}{selected.document_errors.map((issue, index) => <p key={index} className="break-all text-red-600">{JSON.stringify(issue)}</p>)}{!!selected.row_error_count && <p className="text-red-600">{selected.row_error_count} 行存在结构错误，不能生成可提交映射。</p>}{selected.row_errors.map((row, index) => <p key={index} className="break-all text-xs">记录 {row.record_number}：{row.errors.map(issue => issue.code).join(" / ")}</p>)}{selected.row_errors_truncated && <p>错误列表已截断，不代表只有以上错误。</p>}
          <details><summary className="cursor-pointer">按列查看有限样本（不是全部交易核对）</summary><div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">{selected.columns.map(column => <div className="min-w-0 rounded border p-3" key={column.header}><p className="break-all font-medium">{column.index}. {column.header}</p><p className="text-xs">空值 {column.empty_count}；原值种类 {column.distinct_count}</p>{column.samples.map((sample, index) => <div key={index} className="mt-2 text-xs"><pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all">{sample.value || "（空）"}</pre><span>记录 {sample.record_number}{sample.truncated ? " · 展示已截断，不能用于对照键" : ""}{sample.formula_like ? " · 公式样式仅文本" : ""}</span></div>)}</div>)}</div></details>
        </div>
        {selected.valid && <>
          {(inspection.context.accounts.truncated || inspection.context.listings.truncated) && <p className="rounded border border-amber-500/40 p-3 text-sm">标识选项已截断：账户 {inspection.context.accounts.items.length}/{inspection.context.accounts.total}、上市标识 {inspection.context.listings.items.length}/{inspection.context.listings.total}。可填写已知完整标识，最终仍由服务器核验；不按名称模糊匹配或自动建档。</p>}
          <h4 className="font-medium">2. 来源、时间与事件含义</h4>
          {previousMapping && <Button type="button" variant="outline" onClick={loadKnownMapping}>载入已有映射字段为草稿（仍须重新核对）</Button>}
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <label className={fieldClass}>映射标识<Input aria-label="向导映射标识" value={draft.mapping_id} maxLength={120} onChange={event => change({ ...draft, mapping_id: event.target.value })} /><Button type="button" size="sm" variant="outline" onClick={() => change({ ...draft, mapping_id: `csv-${crypto.randomUUID()}`, version: 1 })}>生成新的映射标识</Button></label>
            <label className={fieldClass}>版本（同标识版本不可覆盖）<Input aria-label="向导映射版本" type="number" min="1" step="1" value={Number.isFinite(draft.version) ? draft.version : ""} onChange={event => change({ ...draft, version: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>
            <label className={fieldClass}>映射标题<Input aria-label="向导映射标题" maxLength={256} value={draft.title} onChange={event => change({ ...draft, title: event.target.value })} /></label>
            <label className={fieldClass}>稳定来源标识（不是单笔流水号）<Input aria-label="向导来源标识" value={draft.source_id} maxLength={120} onChange={event => change({ ...draft, source_id: event.target.value })} /></label>
            <ColumnSelect label="向导实际日期列" headers={selected.headers} value={draft.effective_at.column} onChange={column => change({ ...draft, effective_at: { ...draft.effective_at, column } })} />
            <label className={fieldClass}>原始日期格式<select aria-label="向导日期格式" className={selectClass} value={draft.effective_at.format} onChange={event => change({ ...draft, effective_at: { ...draft.effective_at, format: event.target.value as typeof draft.effective_at.format } })}><option value="">请选择明确格式</option>{dateFormats.map(format => <option key={format}>{format}</option>)}</select></label>
            <label className={fieldClass}>来源时区（IANA 标识）<Input aria-label="向导来源时区" value={draft.effective_at.source_timezone} maxLength={80} onChange={event => change({ ...draft, effective_at: { ...draft.effective_at, source_timezone: event.target.value } })} placeholder="例如 Asia/Shanghai；按原始记录确认" /></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.effective_at.trim} onChange={event => change({ ...draft, effective_at: { ...draft.effective_at, trim: event.target.checked } })} />明确移除日期首尾空白</label>
          </div>
          <p className="text-xs text-muted-foreground">不合并日期/时间列，不支持 Excel 序列日期；ISO8601 必须有 Z 或明确偏移。日期精度不会伪装成成交秒时点。</p>
          <div className="grid min-w-0 gap-3 lg:grid-cols-2">{(["account", "event_type", "reason"] as const).map(name => <BindingEditor key={name} path={name} name={name} binding={draft[name]} headers={selected.headers} context={inspection.context} accountId={accountId} getValues={getValues} onChange={binding => { if (name === "event_type") updateEvent(binding); else change({ ...draft, [name]: binding ?? constant() }); }} />)}</div>
          <label className={fieldClass}>来源记录号处理<select aria-label="向导来源记录号处理" className={selectClass} value={sourceChoice} onChange={event => { const choice = event.target.value as typeof sourceChoice; setSourceChoice(choice); change({ ...draft, source_event_id: choice === "column" ? { kind: "column", column: "", trim: false, empty: "reject" } : null }); }}><option value="">请选择，不自动认定缺失</option><option value="column">来自可靠的原始记录号列</option><option value="none">原件没有可靠来源号，后续逐行人工核对</option></select></label>
          {sourceChoice === "column" && <BindingEditor path="source_event_id" name="source_event_id" binding={draft.source_event_id ?? undefined} headers={selected.headers} context={inspection.context} accountId={accountId} getValues={getValues} onChange={binding => { if (!binding) setSourceChoice(""); change({ ...draft, source_event_id: binding?.kind === "column" ? binding : null }); }} />}
          <h4 className="font-medium">3. 每类事件的经济字段</h4>
          {!draft.rules.length && <p className="text-sm text-muted-foreground">先明确事件固定值，或填完事件原值对照；再逐类配置以下字段。</p>}
          {draft.rules.map((rule, ruleIndex) => { const matrix = CSV_RULE_FIELDS[rule.event_type]; const fields = [...matrix.required, ...matrix.optional, ...(matrix.one_of?.flat() ?? [])].filter((value, index, all) => all.indexOf(value) === index); return <details key={rule.event_type} open className="min-w-0 rounded-lg border p-4"><summary className="cursor-pointer font-medium">{events[rule.event_type]} / {rule.event_type}</summary>{!!matrix.one_of?.length && <p className="mt-2 text-xs">以下组至少明确一项：{matrix.one_of.map(group => group.join(" / ")).join("；")}</p>}<div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-2">{fields.map(name => <BindingEditor key={`${rule.event_type}.${name}`} path={`${rule.event_type}.${name}`} name={name} binding={rule.fields[name as keyof typeof rule.fields]} optional={!matrix.required.includes(name)} headers={selected.headers} context={inspection.context} accountId={accountId} getValues={getValues} onChange={binding => { const fields = { ...rule.fields }; if (binding) fields[name as keyof typeof fields] = binding; else if (name === "currency") fields.currency = constant(); else delete fields[name as keyof typeof fields]; change({ ...draft, rules: draft.rules.map((row, index) => index === ruleIndex ? { ...row, fields } : row) }); }} />)}</div></details>; })}
          <p className="text-sm text-amber-600">未知费用/税不是零。当前通用映射不支持证券转移和新型分红税/公司行动事件；请使用对应专用入口，不改名伪装成入金或分红。</p>
          <h4 className="font-medium">4. 明确未使用列与映射版本</h4>
          <p className="text-sm text-muted-foreground">未用于任何字段的列必须明确忽略；被引用的列不能同时忽略。</p>
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">{selected.headers.filter(header => !usage.used.includes(header) || draft.ignored_columns.includes(header)).map(header => <label key={header} className="flex min-w-0 items-start gap-2 rounded border p-2 text-sm"><input type="checkbox" className="mt-1" checked={draft.ignored_columns.includes(header)} onChange={event => change({ ...draft, ignored_columns: event.target.checked ? [...draft.ignored_columns, header] : draft.ignored_columns.filter(value => value !== header) })} /><span className="break-all">明确忽略：{header}{usage.used.includes(header) ? "（已用于映射，须取消忽略）" : ""}</span></label>)}</div>
          {previousMapping && <div className="space-y-2 rounded border border-amber-500/40 p-3 text-sm"><p className="break-all">曾加载或提交的映射 {previousMapping.mapping_id} / v{previousMapping.version} 即使预览失败也可能已封存；同版本不得修改后覆盖。</p><Button type="button" variant="outline" size="sm" disabled={previousMapping.version >= Number.MAX_SAFE_INTEGER} onClick={() => { try { change({ ...draft, mapping_id: previousMapping.mapping_id, version: forkCsvMappingVersion(previousMapping).version }); } catch (caught) { setError(errorText(caught)); } }}>明确采用下一个映射版本</Button>{previousMapping.version >= Number.MAX_SAFE_INTEGER && <p>版本号已达上限，请明确新建映射标识。</p>}</div>}
          {attempted && compiled && !compiled.ok && <ul role="alert" className="space-y-1 rounded border border-red-500/30 p-3 text-sm text-red-600">{compiled.errors.map((issue, index) => <li key={index} className="break-all">{String(issue.path)}：{issue.message}（{issue.code}）</li>)}</ul>}
          {compiled?.warnings?.length ? <ul className="space-y-1 text-xs text-amber-600">{compiled.warnings.map((warning, index) => <li key={index}>{typeof warning === "string" ? warning : JSON.stringify(warning)}</li>)}</ul> : null}
          {compiled?.ok && <details className="rounded border p-3"><summary className="cursor-pointer text-sm">查看将提交的完整映射 JSON</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(compiled.mapping, null, 2)}</pre></details>}
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>我已确认分隔符、日期/数值格式、账户、来源和全部字段含义；这不是券商格式认证，也不替代下一步逐行交易核对。</span></label>
          {!sourceChoice && <p className="text-xs text-amber-600">还须明确来源记录号处理。</p>}
          <Button type="button" disabled={!acknowledged || !sourceChoice} onClick={apply}>5. 生成映射并用于下一步预览</Button>
          {applied && <p role="status" className="text-sm">映射已交给预览入口。尚未保存证据或入账；修改向导会使这份已生成映射失效。</p>}
        </>}
      </>}
    </fieldset>
  </div></DirectoryListPrefix.Provider>;
}
