import { z } from "zod";
import { Decimal } from "../ledger/decimal";

export const catalogIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export const catalogDateSchema = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !value.startsWith("0000-") && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "INVALID_DATE");
export const catalogInstantSchema = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/).refine(value => {
  const date = new Date(value);
  return !value.startsWith("0000-") && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}, "INVALID_INSTANT");
export const catalogFractionSchema = z.string().regex(/^-?(?=(?:[0-9]\.?){1,38}$)(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/).refine(value => {
  try { const number = new Decimal(value); return number.gte(0) && number.lte(1); } catch { return false; }
}, "FRACTION_OUT_OF_RANGE");
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, "NONBLANK_TEXT_REQUIRED");
const labels = z.array(text(80)).max(64).refine(value => new Set(value).size === value.length, "DUPLICATE_LABEL");

export const etfProfileSchema = z.object({
  issuer: text(200).nullable(), index_id: text(200).nullable(), domicile: text(80).nullable(),
  underlying_asset_class: z.enum(["equity", "fixed_income", "commodity", "multi_asset", "cash", "other", "unknown"]),
  economic_regions: labels, sectors: labels,
  annual_expense_ratio: catalogFractionSchema.nullable(),
  distribution: z.enum(["accumulating", "distributing", "mixed", "unknown"]),
  replication: z.enum(["physical", "synthetic", "mixed", "unknown"]),
}).strict();

export const securityIdSchema = z.string().max(193).regex(/^[A-Z][A-Z0-9_]{0,31}:[A-Za-z0-9._:/-]{1,160}$/);
const holding = z.object({ security_id: securityIdSchema, weight: catalogFractionSchema }).strict();
const holdingsFields = {
  weight_basis: z.literal("net_assets_long_only"), complete: z.boolean(),
  coverage: catalogFractionSchema, items: z.array(holding).max(10000),
};
function checkHoldings(value: { complete: boolean; coverage: string; items: { security_id: string; weight: string }[] }, context: z.RefinementCtx) {
  const ids = new Set<string>(); let total = new Decimal(0);
  for (const item of value.items) {
    if (ids.has(item.security_id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `DUPLICATE_SECURITY_ID:${item.security_id}` });
    ids.add(item.security_id);
    try { total = total.plus(item.weight); } catch { return; }
  }
  if (total.gt(1)) context.addIssue({ code: z.ZodIssueCode.custom, message: "DISCLOSURE_COVERAGE_EXCEEDS_ONE" });
  try {
    if (!total.eq(value.coverage)) context.addIssue({ code: z.ZodIssueCode.custom, message: "DISCLOSURE_COVERAGE_MISMATCH" });
  } catch { return; }
  if (value.complete && (ids.size === 0 || !total.eq(1))) context.addIssue({ code: z.ZodIssueCode.custom, message: "COMPLETE_DISCLOSURE_REQUIRES_FULL_COVERAGE" });
}

export const holdingsSnapshotSchema = z.object({
  schema_version: z.literal("holdings-disclosure-v1"), snapshot_id: catalogIdSchema,
  portfolio_id: catalogIdSchema, listing_id: catalogIdSchema, version: z.number().int().positive().safe(),
  as_of: catalogDateSchema, known_at: catalogInstantSchema, ...holdingsFields,
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine(checkHoldings);

export const catalogEnvelope = z.object({
  portfolio_id: catalogIdSchema, expected_catalog_revision: z.number().int().nonnegative().safe(),
  idempotency_key: catalogIdSchema,
}).strict();
export const addCatalogEntrySchema = catalogEnvelope.extend({ listing_id: catalogIdSchema }).strict();

export const catalogDocumentSchema = z.custom<Record<string, unknown>>(value => value !== null && typeof value === "object" && !Array.isArray(value), "JSON_OBJECT_REQUIRED").superRefine((value, context) => {
  const ancestors = new Set<object>(); let nodes = 0;
  function visit(node: unknown, depth: number): boolean {
    if (++nodes > 100000 || depth > 64) return false;
    if (node === null || typeof node === "string" || typeof node === "boolean") return true;
    if (typeof node === "number") return Number.isFinite(node);
    if (typeof node !== "object" || ancestors.has(node)) return false;
    if (!Array.isArray(node) && Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null) return false;
    ancestors.add(node);
    const keys = Reflect.ownKeys(node);
    const valid = keys.every(key => {
      if (Array.isArray(node) && key === "length") return true;
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) return false;
      if (Array.isArray(node) && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= node.length)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(node, key)!;
      return descriptor.enumerable && "value" in descriptor && visit(descriptor.value, depth + 1);
    }) && (!Array.isArray(node) || keys.length === node.length + 1);
    ancestors.delete(node); return valid;
  }
  try {
    if (!visit(value, 0) || Buffer.byteLength(JSON.stringify(value), "utf8") > 1048576) throw new Error("invalid");
  } catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_CATALOG_JSON_DOCUMENT" }); }
});
export const storeCatalogSourceSchema = catalogEnvelope.extend({ reference: text(2000), document: catalogDocumentSchema }).strict();
export const publishEtfProfileSchema = catalogEnvelope.extend({
  listing_id: catalogIdSchema, expected_profile_version: z.number().int().nonnegative().safe(),
  source_id: catalogIdSchema, as_of: catalogDateSchema, profile: etfProfileSchema,
}).strict();
export const publishEtfHoldingsSchema = catalogEnvelope.extend({
  listing_id: catalogIdSchema, expected_holdings_version: z.number().int().nonnegative().safe(),
  source_id: catalogIdSchema, as_of: catalogDateSchema, ...holdingsFields,
}).strict().superRefine(checkHoldings);
