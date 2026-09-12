import { CSV_DECIMAL_FIELDS, CSV_FACT_TYPES, csvMappingSchema, type CsvBinding, type CsvMapping } from "../../server/ledger/csv-schemas";

export { CSV_FACT_TYPES };
export type { CsvBinding, CsvMapping };
export type CsvFactType = typeof CSV_FACT_TYPES[number];
export type CsvFieldName = keyof CsvMapping["rules"][number]["fields"];
export type CsvBindingKind = CsvBinding["kind"];
export type CsvMappingDraft = Omit<CsvMapping, "effective_at"> & {
  effective_at: Omit<CsvMapping["effective_at"], "format"> & { format: CsvMapping["effective_at"]["format"] | "" };
};
export interface CsvRuleFields {
  required: readonly CsvFieldName[];
  optional: readonly CsvFieldName[];
  /** Each group requires at least one binding, not all of its fields. */
  one_of?: readonly (readonly CsvFieldName[])[];
}
export const CSV_RULE_FIELDS: Readonly<Record<CsvFactType, CsvRuleFields>> = {
  opening_cash: { required: ["currency", "amount"], optional: [] },
  opening_position: { required: ["currency", "listing_id", "quantity"], optional: ["cost_amount"] },
  deposit: { required: ["currency", "amount"], optional: [] },
  withdrawal: { required: ["currency", "amount"], optional: [] },
  buy: { required: ["currency", "listing_id", "quantity", "fee"], optional: ["price", "consideration"], one_of: [["price", "consideration"]] },
  sell: { required: ["currency", "listing_id", "quantity", "fee"], optional: ["price", "consideration"], one_of: [["price", "consideration"]] },
  settlement: { required: ["currency", "direction", "related_event_id", "amount"], optional: [] },
  dividend_accrual: { required: ["currency", "amount", "tax"], optional: ["listing_id"] },
  dividend_payment: { required: ["currency", "related_event_id", "amount"], optional: ["listing_id"] },
  dividend: { required: ["currency", "amount", "tax"], optional: ["listing_id"] },
  fee: { required: ["currency", "amount"], optional: [] },
  fx: { required: ["currency", "target_currency", "amount", "received_amount", "fee"], optional: ["target_account_id"] },
  transfer_out: { required: ["currency", "target_account_id", "amount", "fee"], optional: [] },
  transfer_in: { required: ["currency", "related_event_id", "amount"], optional: [] },
  split: { required: ["currency", "listing_id", "split_numerator", "split_denominator"], optional: [] },
};

const decimalFields = new Set<string>(CSV_DECIMAL_FIELDS);
const identifierFields = new Set(["listing_id", "target_account_id", "related_event_id"]);
const textFields = new Set(["currency", "target_currency", "direction"]);
const factTypes = new Set<string>(CSV_FACT_TYPES);
export const CSV_BUILDER_MAX_MAPPING_BYTES = 256 * 1024;

export function allowedCsvBindingKinds(field: string): CsvBindingKind[] {
  if (decimalFields.has(field)) return ["constant", "decimal"];
  if (identifierFields.has(field) || field === "account" || field === "event_type") return ["constant", "lookup"];
  if (field === "source_event_id") return ["column"];
  if (field === "reason") return ["constant", "column"];
  if (textFields.has(field)) return ["constant", "lookup", "column"];
  return [];
}

export function createEmptyCsvMappingDraft(accountId: string, headers: string[] = []): CsvMappingDraft {
  return {
    schema_version: "csv-import-mapping-v1", mapping_id: "", version: 1, title: "",
    dialect: { encoding: "utf-8", delimiter: ",", record_separator: "either" },
    expected_headers: [...headers], ignored_columns: [], account: { kind: "constant", value: accountId },
    event_type: { kind: "constant", value: "" }, source_id: "", source_event_id: null,
    reason: { kind: "constant", value: "" },
    effective_at: { column: "", format: "", trim: false, source_timezone: "" }, rules: [],
  };
}

export interface CsvColumnUsage { used: string[]; ignored: string[]; unused: string[]; missing: string[]; conflicts: string[] }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function draftBindings(value: Record<string, unknown>): unknown[] {
  const rules = Array.isArray(value.rules) ? value.rules : [];
  return [value.account, value.event_type, value.reason, value.source_event_id,
    ...rules.flatMap(rule => Object.values(object(object(rule)?.fields) ?? {}))];
}
export function csvColumnUsage(draft: unknown): CsvColumnUsage {
  const value = object(draft) ?? {}, headers = strings(value.expected_headers);
  const used = new Set<string>(), ignored = [...new Set(strings(value.ignored_columns))];
  const dateColumn = object(value.effective_at)?.column;
  if (typeof dateColumn === "string" && dateColumn) used.add(dateColumn);
  for (const raw of draftBindings(value)) {
    const binding = object(raw);
    if (binding && binding.kind !== "constant" && typeof binding.column === "string" && binding.column) used.add(binding.column);
  }
  return { used: [...used], ignored, unused: headers.filter(header => !used.has(header) && !ignored.includes(header)),
    missing: [...used].filter(header => !headers.includes(header)),
    conflicts: ignored.filter(header => used.has(header) || !headers.includes(header)) };
}

interface BoundedOptions<T> { items: T[]; truncated: boolean; total?: number; limit?: number }
export interface CsvBuilderContext {
  portfolio_id: string;
  account_id: string;
  headers: string[];
  accounts: BoundedOptions<{ id: string; portfolio_id: string }>;
  listings: BoundedOptions<{ id: string; currency: string }>;
}
export interface CsvBuilderIssue { code: string; path: string; message: string }
export type CsvBuilderResult = {
  ok: true; mapping: CsvMapping; usage: CsvColumnUsage; warnings: string[];
} | { ok: false; errors: CsvBuilderIssue[]; usage: CsvColumnUsage; warnings: string[] };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function outputs(binding: CsvBinding): string[] {
  return binding.kind === "constant" ? [binding.value] : binding.kind === "lookup" ? binding.entries.map(entry => entry.value) : [];
}
function validId(value: string): boolean { return value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value); }
function validDecimal(value: string): boolean {
  return /^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value) && value.replace(/[-.]/g, "").length <= 38;
}

/** Local structural validation only; the server must still preview every original CSV row. */
export function compileCsvMappingDraft(draft: unknown, context: CsvBuilderContext, previousMapping?: CsvMapping): CsvBuilderResult {
  const usage = csvColumnUsage(draft), errors: CsvBuilderIssue[] = [];
  const warnings = new Set(["CSV_SERVER_PREVIEW_REQUIRED", "CSV_BROKER_FORMAT_UNVERIFIED"]);
  const add = (code: string, path: string) => errors.push({ code, path, message: code });
  const fail = (): CsvBuilderResult => ({ ok: false, errors, usage, warnings: [...warnings] });
  try {
    const serialized = JSON.stringify(draft);
    if (!serialized || new TextEncoder().encode(serialized).byteLength > CSV_BUILDER_MAX_MAPPING_BYTES) {
      add("CSV_MAPPING_TOO_LARGE", ""); return fail();
    }
  } catch { add("CSV_MAPPING_INVALID", ""); return fail(); }
  const rawRules = object(draft)?.rules;
  if (Array.isArray(rawRules)) rawRules.forEach((rule, index) => {
    const type = object(rule)?.event_type;
    if (typeof type === "string" && !factTypes.has(type)) add("CSV_EVENT_TYPE_UNSUPPORTED", `rules.${index}.event_type`);
  });
  const parsed = csvMappingSchema.safeParse(draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add("CSV_MAPPING_INVALID", issue.path.join("."));
    return fail();
  }
  const mapping = parsed.data;
  if (!mapping.mapping_id.trim() || !mapping.title.trim()) add("CSV_MAPPING_INVALID", "mapping_id/title");
  if (!validId(mapping.source_id)) add("CSV_ID_INVALID", "source_id");
  if (!validId(context.account_id) || !validId(context.portfolio_id)) add("CSV_CONTEXT_INVALID", "context");
  if (JSON.stringify(mapping.expected_headers) !== JSON.stringify(context.headers)) add("CSV_HEADERS_CHANGED", "expected_headers");
  for (const field of ["expected_headers", "ignored_columns"] as const) {
    if (new Set(mapping[field]).size !== mapping[field].length) add("CSV_MAPPING_DUPLICATE_COLUMN", field);
  }
  if (usage.unused.length) add("CSV_UNMAPPED_COLUMN", "ignored_columns");
  if (usage.missing.length) add("CSV_COLUMN_NOT_FOUND", "expected_headers");
  if (usage.conflicts.length) add("CSV_IGNORED_COLUMN_INVALID", "ignored_columns");
  for (const [name, options] of [["accounts", context.accounts], ["listings", context.listings]] as const) {
    if (new Set(options.items.map(item => item.id)).size !== options.items.length) add("CSV_CONTEXT_AMBIGUOUS", `context.${name}`);
  }
  const selectedAccount = context.accounts.items.find(item => item.id === context.account_id);
  if (selectedAccount ? selectedAccount.portfolio_id !== context.portfolio_id : !context.accounts.truncated) add("CSV_ACCOUNT_OUT_OF_SCOPE", "account");
  else if (!selectedAccount) warnings.add("CSV_ACCOUNT_REQUIRES_SERVER_SCOPE_CHECK");

  const checkBinding = (field: string, binding: CsvBinding, at: string, required = false) => {
    if (!allowedCsvBindingKinds(field).includes(binding.kind)) add(decimalFields.has(field) ? "CSV_DECIMAL_RULE_REQUIRED" : identifierFields.has(field) ? "CSV_ID_MAPPING_REQUIRED" : "CSV_BINDING_KIND_INVALID", at);
    if (binding.kind === "lookup") {
      const keys = binding.entries.map(entry => binding.trim ? entry.input.trim() : entry.input);
      if (new Set(keys).size !== keys.length) add("CSV_LOOKUP_AMBIGUOUS", at);
    }
    if ((field === "fee" || field === "tax") && "empty" in binding && binding.empty === "omit") add("CSV_CHARGES_CANNOT_BE_OMITTED", at);
    else if (required && "empty" in binding && binding.empty === "omit") add("CSV_REQUIRED_FIELD_CANNOT_BE_OMITTED", at);
    for (const value of outputs(binding)) {
      if (!value.trim()) add("CSV_BINDING_VALUE_REQUIRED", at);
      if (decimalFields.has(field) && !validDecimal(value)) add("CSV_DECIMAL_RANGE_OR_SYNTAX", at);
      if (identifierFields.has(field) && !validId(value)) add("CSV_ID_INVALID", at);
      if ((field === "currency" || field === "target_currency") && !/^[A-Z]{3}$/.test(value)) add("CSV_CURRENCY_INVALID", at);
      if (field === "direction" && value !== "buy" && value !== "sell") add("CSV_DIRECTION_INVALID", at);
      if (field === "event_type" && !factTypes.has(value)) add("CSV_EVENT_TYPE_UNSUPPORTED", at);
      if (field === "account" && value !== context.account_id) add("CSV_ACCOUNT_OUT_OF_SCOPE", at);
      if (field === "target_account_id") {
        const target = context.accounts.items.find(item => item.id === value);
        if (target ? target.portfolio_id !== context.portfolio_id : !context.accounts.truncated) add("CSV_ACCOUNT_OUT_OF_SCOPE", at);
        else if (!target) warnings.add("CSV_ACCOUNT_REQUIRES_SERVER_SCOPE_CHECK");
      }
      if (field === "listing_id" && !context.listings.items.some(item => item.id === value)) {
        if (!context.listings.truncated) add("CSV_LISTING_CURRENCY_OR_SCOPE_INVALID", at);
        else warnings.add("CSV_LISTING_REQUIRES_SERVER_SCOPE_CHECK");
      }
    }
  };
  checkBinding("account", mapping.account, "account", true);
  checkBinding("event_type", mapping.event_type, "event_type", true);
  checkBinding("reason", mapping.reason, "reason", true);
  if (mapping.source_event_id) checkBinding("source_event_id", mapping.source_event_id, "source_event_id");
  else warnings.add("CSV_RELIABLE_SOURCE_ID_MISSING");
  const ruleTypes = mapping.rules.map(rule => rule.event_type);
  if (new Set(ruleTypes).size !== ruleTypes.length) add("CSV_MAPPING_DUPLICATE_RULE", "rules");
  for (const type of outputs(mapping.event_type)) if (!ruleTypes.includes(type as CsvFactType)) add("CSV_EVENT_RULE_MISSING", "event_type");
  mapping.rules.forEach((rule, index) => {
    const matrix = CSV_RULE_FIELDS[rule.event_type], at = `rules.${index}.fields`;
    const allowed = new Set([...matrix.required, ...matrix.optional]);
    for (const field of matrix.required) if (!rule.fields[field]) add(field === "fee" ? "CSV_EXPLICIT_FEE_REQUIRED" : field === "tax" ? "CSV_EXPLICIT_TAX_REQUIRED" : "CSV_REQUIRED_FIELD_MISSING", `${at}.${field}`);
    for (const group of matrix.one_of ?? []) if (!group.some(field => rule.fields[field])) add("CSV_ONE_OF_FIELDS_REQUIRED", `${at}.${group.join("|")}`);
    for (const [rawField, binding] of Object.entries(rule.fields)) {
      const field = rawField as CsvFieldName;
      if (!allowed.has(field)) add("CSV_EVENT_FIELD_NOT_ALLOWED", `${at}.${field}`);
      if (binding) checkBinding(field, binding, `${at}.${field}`, matrix.required.includes(field));
    }
    if (rule.event_type === "opening_position" && !rule.fields.cost_amount) warnings.add("CSV_OPENING_COST_UNKNOWN");
    if (rule.fields.listing_id && rule.fields.currency.kind === "constant") {
      const currency = rule.fields.currency.value;
      for (const id of outputs(rule.fields.listing_id)) {
        const listing = context.listings.items.find(item => item.id === id);
        if (listing && listing.currency !== currency) add("CSV_LISTING_CURRENCY_OR_SCOPE_INVALID", `${at}.listing_id`);
      }
    }
  });
  if (previousMapping) {
    const previous = csvMappingSchema.safeParse(previousMapping);
    if (!previous.success) add("CSV_PREVIOUS_MAPPING_INVALID", "mapping_id/version");
    else if (mapping.mapping_id === previous.data.mapping_id && (mapping.version < previous.data.version
      || mapping.version === previous.data.version && stableJson(mapping) !== stableJson(previous.data))) add("CSV_MAPPING_NEW_VERSION_REQUIRED", "version");
  }
  return errors.length ? fail() : { ok: true, mapping, usage, warnings: [...warnings] };
}

export function forkCsvMappingVersion(mapping: CsvMapping): CsvMappingDraft {
  const parsed = csvMappingSchema.parse(mapping);
  if (!Number.isSafeInteger(parsed.version + 1)) throw new Error("CSV_MAPPING_VERSION_EXHAUSTED");
  return { ...parsed, version: parsed.version + 1 };
}
