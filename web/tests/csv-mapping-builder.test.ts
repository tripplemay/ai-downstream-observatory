import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, revision } from "../src/server/ledger/service";
import { previewJsonImport } from "../src/server/ledger/imports";
import { mapCsvImport, type CsvImportContext } from "../src/server/ledger/csv-mapping";
import { csvMappingSchema, type CsvDecimalFormat } from "../src/server/ledger/csv-schemas";
import { CSV_BUILDER_MAX_MAPPING_BYTES, CSV_FACT_TYPES, CSV_RULE_FIELDS, allowedCsvBindingKinds, compileCsvMappingDraft,
  createEmptyCsvMappingDraft, csvColumnUsage, forkCsvMappingVersion,
  type CsvBinding, type CsvBuilderContext, type CsvFactType, type CsvFieldName, type CsvMapping, type CsvMappingDraft } from "../src/components/workbench/csv-mapping-builder";

const context: CsvBuilderContext = {
  portfolio_id: "synthetic-portfolio", account_id: "synthetic-account", headers: ["date", "source", "unused"],
  accounts: { items: [{ id: "synthetic-account", portfolio_id: "synthetic-portfolio" }, { id: "synthetic-target", portfolio_id: "synthetic-portfolio" }], truncated: false },
  listings: { items: [{ id: "synthetic-listing", currency: "CNY" }], truncated: false },
};
const fullContext = (ctx: CsvBuilderContext): CsvImportContext => ({ portfolio_id: ctx.portfolio_id, account_id: ctx.account_id, accounts: ctx.accounts.items, listings: ctx.listings.items });
const constant = (value: string): CsvBinding => ({ kind: "constant", value });
const column = (name: string): Extract<CsvBinding, { kind: "column" }> => ({ kind: "column", column: name, trim: false, empty: "reject" });
const format: CsvDecimalFormat = { decimal_separator: ".", grouping_separator: "none", negative_style: "minus", allow_leading_plus: false, trim: false };
const numeric = (name: string): CsvBinding => ({ kind: "decimal", column: name, empty: "reject", format: { ...format } });
const lookup = (name: string, input: string, value: string): CsvBinding & { kind: "lookup" } => ({ kind: "lookup", column: name, trim: false, entries: [{ input, value }] });
const values: Record<CsvFieldName, string> = {
  currency: "CNY", listing_id: "synthetic-listing", target_account_id: "synthetic-target", target_currency: "USD", direction: "buy", related_event_id: "synthetic-existing-event",
  amount: "10", quantity: "2", cost_amount: "10", price: "5", consideration: "10", fee: "0.10", tax: "1", received_amount: "1.30", split_numerator: "2", split_denominator: "1",
};
function draft(type: CsvFactType = "deposit"): CsvMappingDraft {
  const value = createEmptyCsvMappingDraft(context.account_id, context.headers);
  value.mapping_id = "SYNTHETIC-VISUAL-MAPPING"; value.title = "Synthetic explicit generic mapping";
  value.source_id = "SYNTHETIC-NOT-BROKER"; value.event_type = { kind: "constant", value: type };
  value.source_event_id = column("source"); value.reason = { kind: "constant", value: "Synthetic fixture only" };
  value.effective_at = { column: "date", format: "YYYY-MM-DD", trim: false, source_timezone: "Asia/Shanghai" };
  value.ignored_columns = ["unused"];
  const fields: CsvMapping["rules"][number]["fields"] = { currency: constant("CNY") };
  for (const name of CSV_RULE_FIELDS[type].required) fields[name] = constant(values[name]);
  for (const group of CSV_RULE_FIELDS[type].one_of ?? []) fields[group[0]] = constant(values[group[0]]);
  value.rules = [{ event_type: type, fields }];
  return value;
}
function compiled(value: unknown, ctx = context, previous?: CsvMapping): CsvMapping {
  const result = compileCsvMappingDraft(value, ctx, previous);
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.warnings.includes("CSV_SERVER_PREVIEW_REQUIRED"));
  assert.ok(result.warnings.includes("CSV_BROKER_FORMAT_UNVERIFIED"));
  return result.mapping;
}
function rejected(value: unknown, code: string, ctx = context, previous?: CsvMapping): void {
  const result = compileCsvMappingDraft(value, ctx, previous);
  assert.equal(result.ok, false, code);
  if (!result.ok) assert.ok(result.errors.some(issue => issue.code === code), JSON.stringify(result));
}

test("empty draft uses only selected account and copied headers; it does not invent facts, lookup entries or ignored columns", () => {
  const headers = ["code", "fee", "tax"];
  const empty = createEmptyCsvMappingDraft("account-from-props", headers);
  headers.push("later");
  assert.deepEqual(empty.account, { kind: "constant", value: "account-from-props" });
  assert.deepEqual(empty.expected_headers, ["code", "fee", "tax"]);
  assert.deepEqual(empty.ignored_columns, []); assert.deepEqual(empty.rules, []);
  assert.deepEqual(empty.event_type, { kind: "constant", value: "" });
  assert.equal(empty.source_id, ""); assert.equal(empty.mapping_id, ""); assert.equal(empty.effective_at.column, "");
  assert.equal(empty.effective_at.format, ""); assert.equal(empty.effective_at.source_timezone, "");
  assert.deepEqual(csvColumnUsage(empty).unused, ["code", "fee", "tax"]);
  rejected(empty, "CSV_MAPPING_INVALID");
  assert.equal(JSON.stringify(empty).includes('"fee":'), false);
  assert.equal(JSON.stringify(empty).includes('"tax":'), false);
});

test("binding kind catalog covers every existing shape and rejects new unsupported fields", () => {
  for (const field of ["account", "event_type", "listing_id", "target_account_id", "related_event_id"]) assert.deepEqual(allowedCsvBindingKinds(field), ["constant", "lookup"]);
  for (const field of ["amount", "quantity", "cost_amount", "price", "consideration", "fee", "tax", "received_amount", "split_numerator", "split_denominator"]) assert.deepEqual(allowedCsvBindingKinds(field), ["constant", "decimal"]);
  for (const field of ["currency", "target_currency", "direction"]) assert.deepEqual(allowedCsvBindingKinds(field), ["constant", "lookup", "column"]);
  assert.deepEqual(allowedCsvBindingKinds("reason"), ["constant", "column"]);
  assert.deepEqual(allowedCsvBindingKinds("source_event_id"), ["column"]);
  assert.deepEqual(allowedCsvBindingKinds("market_value"), []);
  assert.deepEqual(allowedCsvBindingKinds("__proto__"), []);
});

test("all 15 rule matrices compile to the existing standard mapper without invented fields", () => {
  assert.deepEqual(Object.keys(CSV_RULE_FIELDS), [...CSV_FACT_TYPES]); assert.equal(CSV_FACT_TYPES.length, 15);
  for (const type of CSV_FACT_TYPES) {
    const value = draft(type), mapping = compiled(value);
    assert.deepEqual(mapping, value);
    const result = mapCsvImport(Buffer.from("date,source,unused\n2026-01-02,SYNTHETIC-1,Not interpreted"), mapping, fullContext(context));
    assert.equal(result.can_preview, true, `${type}: ${JSON.stringify(result.rows.flatMap(row => row.errors))}`);
    assert.equal(result.standard_rows?.[0].fact.type, type);
    assert.equal(result.broker_format_verified, false);
    for (const field of CSV_RULE_FIELDS[type].required.filter(field => field !== "currency")) {
      const missing = structuredClone(value); delete missing.rules[0].fields[field];
      rejected(missing, field === "fee" ? "CSV_EXPLICIT_FEE_REQUIRED" : field === "tax" ? "CSV_EXPLICIT_TAX_REQUIRED" : "CSV_REQUIRED_FIELD_MISSING");
    }
  }
});

test("optional trade consideration and unknown opening cost stay explicit", () => {
  const trade = draft("buy"); delete trade.rules[0].fields.price;
  rejected(trade, "CSV_ONE_OF_FIELDS_REQUIRED");
  trade.rules[0].fields.consideration = constant("10"); compiled(trade);
  const opening = compileCsvMappingDraft(draft("opening_position"), context);
  assert.ok(opening.ok); assert.ok(opening.warnings.includes("CSV_OPENING_COST_UNKNOWN"));
  const withCost = draft("opening_position"); withCost.rules[0].fields.cost_amount = constant("0");
  assert.equal(compileCsvMappingDraft(withCost, context).warnings.includes("CSV_OPENING_COST_UNKNOWN"), false);
  const extra = draft(); extra.rules[0].fields.quantity = constant("1");
  rejected(extra, "CSV_EVENT_FIELD_NOT_ALLOWED");
});

test("all new security-transfer and company-action types are explicitly unsupported, not silently mapped", () => {
  for (const type of ["security_in", "security_out", "security_transfer_out", "security_transfer_in", "security_transfer_return", "dividend_net", "dividend_breakdown", "dividend_tax_assessment", "dividend_tax_payment", "corporate_action_notice", "corporate_action_resolution"]) {
    const value = draft(); value.event_type = { kind: "constant", value: type };
    rejected(value, "CSV_EVENT_TYPE_UNSUPPORTED");
    rejected({ ...draft(), rules: [{ event_type: type, fields: { currency: constant("CNY") } }] }, "CSV_EVENT_TYPE_UNSUPPORTED");
  }
  const unsupportedField = draft();
  rejected({ ...unsupportedField, rules: [{ ...unsupportedField.rules[0], fields: { ...unsupportedField.rules[0].fields, tax_status: constant("confirmed") } }] }, "CSV_MAPPING_INVALID");
});

test("used and unused columns are global across every rule and must be explicitly accounted for", () => {
  const value = draft(); value.ignored_columns = [];
  assert.deepEqual(csvColumnUsage(value), { used: ["date", "source"], ignored: [], unused: ["unused"], missing: [], conflicts: [] });
  rejected(value, "CSV_UNMAPPED_COLUMN");
  value.ignored_columns = ["unused"]; compiled(value);
  value.ignored_columns.push("source"); rejected(value, "CSV_IGNORED_COLUMN_INVALID");
  value.ignored_columns = ["unused", "nonexistent"]; rejected(value, "CSV_IGNORED_COLUMN_INVALID");
  value.ignored_columns = ["unused", "unused"]; rejected(value, "CSV_MAPPING_DUPLICATE_COLUMN");
  value.ignored_columns = ["unused"]; value.effective_at.column = "not-found"; rejected(value, "CSV_COLUMN_NOT_FOUND");
  value.effective_at.column = "date"; value.expected_headers.reverse(); rejected(value, "CSV_HEADERS_CHANGED");
  value.expected_headers = ["date", "source", "unused", "unused"]; rejected(value, "CSV_MAPPING_DUPLICATE_COLUMN");
  const two = draft(); two.rules.push({ event_type: "withdrawal", fields: { currency: constant("CNY"), amount: numeric("unused") } });
  two.ignored_columns = []; assert.deepEqual(csvColumnUsage(two).unused, []); compiled(two);
});

test("lookup identity never uses display names or converts leading-zero codes; all binding shapes work together", () => {
  const headers = ["date", "source", "event", "account", "code", "currency", "quantity", "price", "fee", "note"];
  const value = draft("buy"); value.expected_headers = headers; value.ignored_columns = [];
  value.account = lookup("account", "A", context.account_id); value.event_type = lookup("event", "BUY", "buy");
  value.reason = column("note"); value.rules[0].fields = {
    currency: lookup("currency", "RMB", "CNY"), listing_id: lookup("code", "000001", "synthetic-listing"),
    quantity: numeric("quantity"), price: numeric("price"), fee: numeric("fee"),
  };
  const mapping = compiled(value, { ...context, headers });
  const input = "2026-01-02,SYNTHETIC-BUY,BUY,A,000001,RMB,2,5.125,0.000000000000000001,=SUM(A1:A2)";
  const mapped = mapCsvImport(Buffer.from(headers.join(",") + "\n" + input), mapping, fullContext(context));
  assert.equal(mapped.can_preview, true);
  assert.equal(mapped.standard_rows![0].fact.listing_id, "synthetic-listing");
  assert.equal(mapped.rows[0].cells[4], "000001");
  assert.equal(mapped.standard_rows![0].fact.fee, "0.000000000000000001");
  assert.equal(mapped.standard_rows![0].reason, "=SUM(A1:A2)");
  const unlisted = mapCsvImport(Buffer.from(headers.join(",") + "\n" + input.replace(",000001,", ",1,")), mapping, fullContext(context));
  assert.equal(unlisted.can_preview, false); assert.equal(unlisted.standard_rows, null);
  assert.ok(unlisted.rows[0].errors.some(error => error.code === "CSV_VALUE_NOT_MAPPED"));
  const before = JSON.stringify(value); compiled(value, { ...context, headers }); assert.equal(JSON.stringify(value), before);
});

test("single-account mapping, explicit cross-account target and truncated server catalogs fail closed without false rejection", () => {
  const value = draft(); value.account = { kind: "lookup", column: "unused", trim: false, entries: [{ input: "A", value: context.account_id }, { input: "B", value: "synthetic-target" }] }; value.ignored_columns = [];
  rejected(value, "CSV_ACCOUNT_OUT_OF_SCOPE");
  value.account.entries[1].value = context.account_id; compiled(value);
  value.account.trim = true; value.account.entries[1].input = " A "; rejected(value, "CSV_LOOKUP_AMBIGUOUS");
  const transfer = draft("transfer_out"); compiled(transfer);
  transfer.rules[0].fields.target_account_id = constant("not-in-first-page"); rejected(transfer, "CSV_ACCOUNT_OUT_OF_SCOPE");
  const truncated = { ...context, accounts: { ...context.accounts, truncated: true } };
  assert.ok(compileCsvMappingDraft(transfer, truncated).warnings.includes("CSV_ACCOUNT_REQUIRES_SERVER_SCOPE_CHECK"));
  compiled(transfer, truncated);
  const foreign = { ...context, accounts: { items: [...context.accounts.items, { id: "not-in-first-page", portfolio_id: "foreign" }], truncated: true } };
  rejected(transfer, "CSV_ACCOUNT_OUT_OF_SCOPE", foreign);
  const buy = draft("buy"); buy.rules[0].fields.listing_id = constant("not-in-first-page");
  rejected(buy, "CSV_LISTING_CURRENCY_OR_SCOPE_INVALID");
  const truncatedListings = { ...context, listings: { items: [], truncated: true } };
  compiled(buy, truncatedListings);
  assert.ok(compileCsvMappingDraft(buy, truncatedListings).warnings.includes("CSV_LISTING_REQUIRES_SERVER_SCOPE_CHECK"));
  assert.equal(mapCsvImport(Buffer.from("date,source,unused\n2026-01-02,S1,x"), compiled(buy, truncatedListings), fullContext(context)).can_preview, false);
  rejected(draft("buy"), "CSV_LISTING_CURRENCY_OR_SCOPE_INVALID", { ...context, listings: { items: [{ id: "synthetic-listing", currency: "USD" }], truncated: false } });
  rejected(draft(), "CSV_CONTEXT_AMBIGUOUS", { ...context, accounts: { items: [context.accounts.items[0], context.accounts.items[0]], truncated: false } });
});

test("decimal constants remain exact and declared formats do not introduce abs, sign inversion or default charges", () => {
  for (const invalid of ["", " ", "01", "+1", "1e3", "NaN", "Infinity", "1,000", "1.2.3", "=1+2", "0.1234567890123456789", "9".repeat(39)]) {
    const value = draft(); value.rules[0].fields.amount = constant(invalid); rejected(value, "CSV_DECIMAL_RANGE_OR_SYNTAX");
  }
  const signed = draft(); signed.rules[0].fields.amount = constant("-123.123456789012345678");
  assert.deepEqual(compiled(signed).rules[0].fields.amount, constant("-123.123456789012345678"));
  const value = draft(); value.rules[0].fields.amount = numeric("unused"); value.ignored_columns = [];
  const amount = value.rules[0].fields.amount; assert.equal(amount.kind, "decimal");
  if (amount.kind !== "decimal") return;
  amount.format = { ...format, decimal_separator: ",", grouping_separator: " ", negative_style: "parentheses" };
  const result = mapCsvImport(Buffer.from('date,source,unused\n2026-01-02,S1,"(1 234,56)"'), compiled(value), fullContext(context));
  assert.equal(result.standard_rows![0].fact.amount, "-1234.56");
  amount.format.grouping_separator = ","; rejected(value, "CSV_MAPPING_INVALID");
  const withTransform = draft();
  rejected({ ...withTransform, rules: [{ event_type: "deposit", fields: { ...withTransform.rules[0].fields, amount: { kind: "decimal", column: "unused", empty: "reject", format, abs: true } } }] }, "CSV_MAPPING_INVALID");
  for (const [type, field] of [["buy", "fee"], ["dividend", "tax"]] as const) {
    const charges = draft(type); charges.rules[0].fields[field] = { kind: "decimal", column: "unused", empty: "omit", format }; charges.ignored_columns = [];
    rejected(charges, "CSV_CHARGES_CANNOT_BE_OMITTED");
    charges.rules[0].fields[field] = constant("0"); charges.ignored_columns = ["unused"];
    assert.deepEqual(compiled(charges).rules[0].fields[field], constant("0"));
  }
});

test("field binding constraints, date format and timezone require explicit valid choices", () => {
  const price = draft("buy"); price.rules[0].fields.price = column("unused"); price.ignored_columns = [];
  rejected(price, "CSV_DECIMAL_RULE_REQUIRED");
  const listing = draft("buy"); listing.rules[0].fields.listing_id = column("unused"); listing.ignored_columns = [];
  rejected(listing, "CSV_ID_MAPPING_REQUIRED");
  const currency = draft(); currency.rules[0].fields.currency = numeric("unused"); currency.ignored_columns = [];
  rejected(currency, "CSV_BINDING_KIND_INVALID");
  const optionalAmount = draft(); optionalAmount.rules[0].fields.amount = { kind: "decimal", column: "unused", empty: "omit", format }; optionalAmount.ignored_columns = [];
  rejected(optionalAmount, "CSV_REQUIRED_FIELD_CANNOT_BE_OMITTED");
  for (const timezone of ["", "Guess/BrokerLocal", "+99:00"]) {
    const value = draft(); value.effective_at.source_timezone = timezone; rejected(value, "CSV_MAPPING_INVALID");
  }
  const date = draft(); date.effective_at.format = ""; rejected(date, "CSV_MAPPING_INVALID");
  for (const dateFormat of ["YYYY-MM-DD", "YYYY/MM/DD", "YYYYMMDD", "ISO8601_OFFSET"] as const) {
    date.effective_at.format = dateFormat; compiled(date);
  }
  const id = draft("split"); id.rules[0].fields.listing_id = constant("Security display name"); rejected(id, "CSV_ID_INVALID");
  const direction = draft("settlement"); direction.rules[0].fields.direction = constant("auto"); rejected(direction, "CSV_DIRECTION_INVALID");
});

test("same mapping identity/version cannot change; fork is independent and must remain safe integer", () => {
  const original = compiled(draft()); compiled(original, context, original);
  const orderOnly = { ...original, dialect: { record_separator: original.dialect.record_separator, delimiter: original.dialect.delimiter, encoding: original.dialect.encoding } };
  compiled(orderOnly, context, original);
  for (const change of [(value: CsvMapping) => { value.title += " edited"; }, (value: CsvMapping) => { value.rules[0].fields.amount = constant("20"); }, (value: CsvMapping) => { value.effective_at.trim = true; }]) {
    const edited = structuredClone(original); change(edited); rejected(edited, "CSV_MAPPING_NEW_VERSION_REQUIRED", context, original);
  }
  const fork = forkCsvMappingVersion(original); fork.rules[0].fields.amount = constant("20");
  assert.equal(fork.version, 2); assert.equal(original.version, 1); assert.deepEqual(original.rules[0].fields.amount, constant("10"));
  const second = compiled(fork, context, original); rejected(original, "CSV_MAPPING_NEW_VERSION_REQUIRED", context, second);
  assert.throws(() => forkCsvMappingVersion({ ...original, version: Number.MAX_SAFE_INTEGER }), /CSV_MAPPING_VERSION_EXHAUSTED/);
});

test("strict size and schema limits cannot be bypassed by unknown flags or invalid imported drafts", () => {
  rejected({ ...draft(), approved: true, broker_format_verified: true }, "CSV_MAPPING_INVALID");
  rejected({ ...draft(), title: "x".repeat(CSV_BUILDER_MAX_MAPPING_BYTES) }, "CSV_MAPPING_TOO_LARGE");
  rejected({ ...draft(), version: Number.NaN }, "CSV_MAPPING_INVALID");
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  rejected(cyclic, "CSV_MAPPING_INVALID");
  const missingRule = draft(); missingRule.event_type = lookup("unused", "SELL", "sell"); missingRule.ignored_columns = [];
  rejected(missingRule, "CSV_EVENT_RULE_MISSING");
  const duplicate = draft(); duplicate.rules.push(duplicate.rules[0]); rejected(duplicate, "CSV_MAPPING_DUPLICATE_RULE");
  const noSource = draft(); noSource.source_event_id = null; noSource.ignored_columns.push("source");
  const result = compileCsvMappingDraft(noSource, context); assert.ok(result.ok); assert.ok(result.warnings.includes("CSV_RELIABLE_SOURCE_ID_MISSING"));
});

test("compiled synthetic deposit and buy receive real ledger dry-run without creating facts or balances", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "csv-builder-preview-")), filename = path.join(dataDir, "workbench.db");
  migrateWorkbench(filename); const db = openWorkbench(filename), actor = { id: "SYNTHETIC-CSV-BUILDER" }, now = "2026-02-01T00:00:00.000Z";
  try {
    const portfolio = createPortfolio(db, actor, "Synthetic builder preview only", now);
    const account = createAccount(db, actor, portfolio, "Synthetic account", "Synthetic broker", "CNY", now);
    db.prepare("INSERT INTO instruments(id,name,created_at) VALUES('synthetic-i','Synthetic instrument',?)").run(now);
    db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('synthetic-listing','synthetic-i','CN','SSE','000001','CNY',?)").run(now);
    const ctx = { ...context, portfolio_id: portfolio, account_id: account, accounts: { items: [{ id: account, portfolio_id: portfolio }], truncated: false } };
    const value = draft(); value.account = { kind: "constant", value: account };
    value.event_type = { kind: "lookup", column: "unused", trim: false, entries: [{ input: "DEPOSIT", value: "deposit" }, { input: "BUY", value: "buy" }] };
    value.ignored_columns = []; value.rules[0].fields.amount = constant("1000.50"); value.rules.push(draft("buy").rules[0]);
    const mapping = compiled(value, ctx); csvMappingSchema.parse(mapping);
    const result = mapCsvImport(Buffer.from("date,source,unused\n2026-01-01,S1,DEPOSIT\n2026-01-02,S2,BUY"), mapping, fullContext(ctx));
    assert.equal(result.can_preview, true);
    const preview = previewJsonImport(db, actor, portfolio, account, JSON.stringify(result.standard_rows), now, { dataDir });
    assert.equal(preview.status, "preview"); assert.equal(preview.rows.length, 2);
    assert.ok(preview.rows.every(row => row.errors.length === 0));
    assert.equal(revision(db, portfolio), 0);
    for (const table of ["ledger_events", "account_projections"]) assert.equal((db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n, 0);
    // Original CSV retention and confirmation belong to the existing server import pipeline, not this builder.
  } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("builder runtime import graph stays browser-safe and does not pull in the server mapper", () => {
  const file = path.resolve("src/components/workbench/csv-mapping-builder.ts");
  const source = readFileSync(file, "utf8"), schemas = readFileSync(path.resolve("src/server/ledger/csv-schemas.ts"), "utf8");
  assert.deepEqual([...source.matchAll(/from "([^"]+)"/g)].map(match => match[1]), ["../../server/ledger/csv-schemas"]);
  assert.deepEqual([...schemas.matchAll(/from "([^"]+)"/g)].map(match => match[1]), ["zod"]);
  assert.doesNotMatch(source, /node:|server-only|\bBuffer\b|require\s*\(|import\s*\(/);
});
