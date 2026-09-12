import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { addCatalogEntrySchema, catalogDocumentSchema, etfProfileSchema, holdingsSnapshotSchema, publishEtfHoldingsSchema, publishEtfProfileSchema, securityIdSchema, storeCatalogSourceSchema } from "../src/server/catalog/schemas";
import type { HoldingsSnapshot } from "../src/server/catalog/types";

const envelope = { portfolio_id: "p", expected_catalog_revision: 0, idempotency_key: "catalog:1" };
const profile = {
  issuer: null, index_id: null, domicile: null, underlying_asset_class: "unknown",
  economic_regions: [], sectors: [], annual_expense_ratio: null, distribution: "unknown", replication: "unknown",
};
const golden = JSON.parse(readFileSync(new URL("../../tests/research/holdings-overlap-golden.json", import.meta.url), "utf8"));
const snapshot = golden.cases[0].snapshot_a as HoldingsSnapshot;
const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
for (const file of ["common", "holdings-disclosure"]) ajv.addSchema(JSON.parse(readFileSync(new URL(`../../contracts/v1/${file}.schema.json`, import.meta.url), "utf8")));
const validate = ajv.getSchema("https://etf-workbench.invalid/contracts/v1/holdings-disclosure.schema.json")!;

test("catalog commands are strict, independently versioned and cannot supply server knowledge or trading approval", () => {
  assert.equal(addCatalogEntrySchema.safeParse({ ...envelope, listing_id: "listing:1" }).success, true);
  for (const extra of [{ expected_revision: 0 }, { known_at: "2026-01-01T00:00:00Z" }, { approved: true }, { status: "active" }]) {
    assert.equal(addCatalogEntrySchema.safeParse({ ...envelope, listing_id: "listing:1", ...extra }).success, false);
  }
  for (const revision of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    assert.equal(addCatalogEntrySchema.safeParse({ ...envelope, listing_id: "listing:1", expected_catalog_revision: revision }).success, false);
  }
  const command = { ...envelope, listing_id: "listing:1", expected_profile_version: 0, source_id: "source:1", as_of: "2026-02-28", profile };
  assert.equal(publishEtfProfileSchema.safeParse(command).success, true);
  for (const as_of of ["2026-02-30", "0000-01-01", "20260101", "2026-1-01"]) assert.equal(publishEtfProfileSchema.safeParse({ ...command, as_of }).success, false);
});

test("profile unknown remains explicit and expense ratios preserve decimal source text", () => {
  assert.equal(etfProfileSchema.parse(profile).annual_expense_ratio, null);
  assert.equal(etfProfileSchema.parse({ ...profile, annual_expense_ratio: "0.00200", issuer: "合成发行人" }).annual_expense_ratio, "0.00200");
  for (const value of [0.002, "1e-3", "-0.1", "1.1", "0.0000000000000000001"]) {
    assert.equal(etfProfileSchema.safeParse({ ...profile, annual_expense_ratio: value }).success, false);
  }
  assert.equal(etfProfileSchema.safeParse({ ...profile, economic_regions: ["CN", "CN"] }).success, false);
  assert.equal(etfProfileSchema.safeParse({ ...profile, issuer: " " }).success, false);
  const missing = { ...profile } as Record<string, unknown>; delete missing.annual_expense_ratio;
  assert.equal(etfProfileSchema.safeParse(missing).success, false);
});

test("structured source is bounded JSON, never a path, URL fetch directive, class instance or lossy JS value", () => {
  assert.equal(storeCatalogSourceSchema.safeParse({ ...envelope, reference: "Synthetic source", document: { source: "https://example.invalid/not-fetched", value: "0.20", nested: [null, true, 2] } }).success, true);
  const circular: Record<string, unknown> = {}; circular.self = circular;
  const sparse = Array(2); sparse[1] = "x";
  const disguisedSparse = Array(2) as unknown[] & { extra?: string }; disguisedSparse[1] = "x"; disguisedSparse.extra = "x";
  const getter = Object.defineProperty({}, "secret", { enumerable: true, get: () => { throw new Error("MUST_NOT_INVOKE_GETTER"); } });
  for (const document of [null, [], "/private/path", { a: undefined }, { a: NaN }, { a: Infinity }, { a: 1n }, { a: () => 1 }, circular, { now: new Date() }, { a: sparse }, { a: disguisedSparse }, getter, JSON.parse('{"__proto__":{"x":1}}'), { nested: { constructor: "bad" } }]) {
    assert.equal(catalogDocumentSchema.safeParse(document).success, false);
  }
  let deep: unknown = "x"; for (let depth = 0; depth < 66; depth++) deep = { child: deep };
  assert.equal(catalogDocumentSchema.safeParse(deep).success, false);
  assert.equal(catalogDocumentSchema.safeParse({ text: "中".repeat(349526) }).success, false);
  assert.equal(catalogDocumentSchema.safeParse({ text: "a".repeat(1048565) }).success, true);
  assert.equal(catalogDocumentSchema.safeParse({ text: "a".repeat(1048566) }).success, false);
});

test("holdings JSON Schema and Zod accept all shared golden snapshots and enforce namespaced identity", () => {
  for (const item of golden.cases) for (const value of [item.snapshot_a, item.snapshot_b]) {
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.equal(holdingsSnapshotSchema.safeParse(value).success, true);
  }
  for (const id of ["Apple", "isin:US1", "ISIN:", "ISIN:含糊", "I".repeat(33) + ":X"]) assert.equal(securityIdSchema.safeParse(id).success, false);
  for (const id of ["ISIN:US0000000001", "FIGI:BBG000000001", "CUSTODIAN:EXCHANGE/TICKER", "Z:" + "a".repeat(160)]) assert.equal(securityIdSchema.safeParse(id).success, true);
});

test("disclosure semantics reject duplicate, incomplete-full claims and coverage mismatch without normalizing strings", () => {
  const { schema_version: ignored1, snapshot_id: ignored2, version: ignored3, known_at: ignored4, content_hash: ignored5, ...fields } = snapshot;
  void ignored1; void ignored2; void ignored3; void ignored4; void ignored5;
  const command = { ...envelope, ...fields, expected_holdings_version: 0, source_id: "s" };
  assert.equal(publishEtfHoldingsSchema.parse(command).coverage, "1.00");
  const invalid = [
    { coverage: "0.9" }, { complete: true, coverage: "0", items: [] },
    { items: [{ security_id: "ISIN:A", weight: "0.5" }, { security_id: "ISIN:A", weight: "0.5" }] },
    { complete: false, coverage: "1", items: [{ security_id: "ISIN:A", weight: "0.8" }, { security_id: "ISIN:B", weight: "0.3" }] },
    { items: [{ security_id: "ISIN:A", weight: 1 }] },
    { items: [{ security_id: "ISIN:A", weight: "1", name: "not-a-security-identifier" }] },
  ];
  for (const patch of invalid) assert.equal(publishEtfHoldingsSchema.safeParse({ ...command, ...patch }).success, false);
  assert.equal(publishEtfHoldingsSchema.safeParse({ ...command, complete: false, coverage: "0.00", items: [] }).success, true);
  assert.equal(publishEtfHoldingsSchema.safeParse({ ...command, complete: false, coverage: "0", items: Array.from({ length: 10001 }, (_, i) => ({ security_id: `ISIN:${i}`, weight: "0" })) }).success, false);
});

test("both contract validators reject malformed dates, excess precision, fields and financial JSON numbers", () => {
  for (const patch of [
    { known_at: "2026-01-10T00:00:00.0000001Z" }, { known_at: "2026-01-10T24:00:00Z" },
    { known_at: "2026-02-30T00:00:00Z" }, { known_at: "2026-01-10T00:00:00+00:00" },
    { as_of: "0000-01-01" }, { as_of: "2025-02-29" }, { coverage: 1 }, { coverage: "1.01" },
    { source_id: "not-in-pure-snapshot" }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.equal(validate({ ...snapshot, ...patch }), false, JSON.stringify(patch));
    assert.equal(holdingsSnapshotSchema.safeParse({ ...snapshot, ...patch }).success, false, JSON.stringify(patch));
  }
});
