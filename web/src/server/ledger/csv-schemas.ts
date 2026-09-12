import { z } from "zod";

const text = z.string().min(1).max(256), id = z.string().min(1).max(120);
const column = z.string().min(1).max(256);
const constant = z.object({ kind: z.literal("constant"), value: z.string().max(2000) }).strict();
const lookup = z.object({ kind: z.literal("lookup"), column, trim: z.boolean(), entries: z.array(z.object({ input: z.string().max(256), value: z.string().max(2000) }).strict()).min(1).max(10000) }).strict();
const cell = z.object({ kind: z.literal("column"), column, trim: z.boolean(), empty: z.enum(["reject", "omit"]) }).strict();
export const csvDecimalFormatSchema = z.object({ decimal_separator: z.enum([".", ","]), grouping_separator: z.enum(["none", ".", ",", " "]), negative_style: z.enum(["minus", "parentheses", "either"]), allow_leading_plus: z.boolean(), trim: z.boolean() }).strict().refine(value => value.decimal_separator !== value.grouping_separator, "CSV_AMBIGUOUS_DECIMAL_FORMAT");
const decimal = z.object({ kind: z.literal("decimal"), column, empty: z.enum(["reject", "omit"]), format: csvDecimalFormatSchema }).strict();
const binding = z.union([constant, lookup, cell, decimal]);
export const CSV_FACT_TYPES = ["opening_cash", "opening_position", "deposit", "withdrawal", "buy", "sell", "settlement", "dividend_accrual", "dividend_payment", "dividend", "fee", "fx", "transfer_out", "transfer_in", "split"] as const;
export const CSV_DECIMAL_FIELDS = ["amount", "quantity", "cost_amount", "price", "consideration", "fee", "tax", "received_amount", "split_numerator", "split_denominator"] as const;
const fields = z.object({
  currency: binding, listing_id: binding.optional(), target_account_id: binding.optional(), target_currency: binding.optional(), direction: binding.optional(), related_event_id: binding.optional(),
  amount: binding.optional(), quantity: binding.optional(), cost_amount: binding.optional(), price: binding.optional(), consideration: binding.optional(), fee: binding.optional(), tax: binding.optional(), received_amount: binding.optional(), split_numerator: binding.optional(), split_denominator: binding.optional(),
}).strict();
export const csvMappingSchema = z.object({
  schema_version: z.literal("csv-import-mapping-v1"), mapping_id: id, version: z.number().int().positive().safe(), title: text,
  dialect: z.object({ encoding: z.literal("utf-8"), delimiter: z.enum([",", ";", "\t"]), record_separator: z.enum(["crlf", "lf", "either"]) }).strict(),
  expected_headers: z.array(column).min(1).max(128), ignored_columns: z.array(column).max(128),
  account: z.union([constant, lookup]), event_type: z.union([constant, lookup]), source_id: id,
  source_event_id: cell.nullable(), reason: z.union([constant, cell]),
  effective_at: z.object({ column, format: z.enum(["YYYY-MM-DD", "YYYY/MM/DD", "YYYYMMDD", "ISO8601_OFFSET"]), trim: z.boolean(), source_timezone: z.string().min(1).max(80).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }) }).strict(),
  rules: z.array(z.object({ event_type: z.enum(CSV_FACT_TYPES), fields }).strict()).min(1).max(CSV_FACT_TYPES.length),
}).strict();
export type CsvMapping = z.infer<typeof csvMappingSchema>;
export type CsvBinding = z.infer<typeof binding>;
export type CsvDecimalFormat = z.infer<typeof csvDecimalFormatSchema>;
export const csvContextSchema = z.object({ portfolio_id: id, account_id: id,
  accounts: z.array(z.object({ id, portfolio_id: id }).strict()).min(1).max(1000),
  listings: z.array(z.object({ id, currency: z.string().regex(/^[A-Z]{3}$/) }).strict()).max(10000),
}).strict();
export type CsvImportContext = z.infer<typeof csvContextSchema>;
