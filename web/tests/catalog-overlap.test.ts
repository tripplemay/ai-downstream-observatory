import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Decimal } from "../src/server/ledger/decimal";
import { compareHoldings, disclosureHash } from "../src/server/catalog/overlap";
import type { HoldingsSnapshot } from "../src/server/catalog/types";

const golden = JSON.parse(readFileSync(new URL("../../tests/research/holdings-overlap-golden.json", import.meta.url), "utf8"));
const a: HoldingsSnapshot = golden.cases[0].snapshot_a, b: HoldingsSnapshot = golden.cases[0].snapshot_b;
const at = "2026-01-15T12:00:00Z";
const changed = (snapshot: HoldingsSnapshot, patch: Partial<HoldingsSnapshot>) => {
  const candidate = { ...snapshot, ...patch }; return { ...candidate, content_hash: disclosureHash(candidate) };
};

test("independent TS overlap matches all Python golden values, references and canonical hashes byte-for-byte", () => {
  for (const item of golden.cases) {
    assert.equal(disclosureHash(item.snapshot_a), item.snapshot_a.content_hash, item.name);
    assert.equal(disclosureHash(item.snapshot_b), item.snapshot_b.content_hash, item.name);
    assert.deepEqual(compareHoldings(item.snapshot_a, item.snapshot_b, item.comparison_at), item.expected_result, item.name);
  }
});

test("source item order is immaterial, decimal spelling and every identity/time field remain hash-bound", () => {
  assert.equal(disclosureHash({ ...a, items: [...a.items].reverse() }), a.content_hash);
  assert.equal(disclosureHash({ ...a, content_hash: null }), a.content_hash);
  for (const patch of [{ portfolio_id: "other" }, { listing_id: "other" }, { snapshot_id: "other" }, { version: 2 }, { known_at: "2026-01-11T00:00:00Z" }, { coverage: "1.0" }, { items: a.items.map(item => ({ ...item, weight: new Decimal(item.weight).toFixed() })) }]) {
    assert.notEqual(disclosureHash({ ...a, ...patch }), a.content_hash);
    assert.throws(() => compareHoldings({ ...a, ...patch }, b, at), /HASH_MISMATCH/);
  }
});

test("knowledge checks retain microseconds and do not invent market close or accept future disclosure dates", () => {
  const future = changed(a, { known_at: "2026-01-15T12:00:00.000001Z" });
  assert.throws(() => compareHoldings(future, b, at), /NOT_YET_KNOWN:A/);
  assert.equal(compareHoldings(future, b, "2026-01-15T12:00:00.000001Z").comparison_at, "2026-01-15T12:00:00.000001Z");
  assert.throws(() => compareHoldings(changed(a, { as_of: "2026-01-16" }), b, at), /FUTURE_DISCLOSURE_DATE:A/);
  for (const bad of ["2026-01-15", "2026-01-15T12:00:00+00:00", "2026-01-15T12:00:00.1234567Z", "0000-01-01T00:00:00Z"]) assert.throws(() => compareHoldings(a, b, bad), /INVALID_COMPARISON_AT/);
});

test("cross-portfolio disclosures and conflicting immutable versions cannot compare", () => {
  assert.throws(() => compareHoldings(a, changed(b, { portfolio_id: "private-other" }), at), /DISCLOSURE_PORTFOLIO_MISMATCH/);
  assert.throws(() => compareHoldings(a, changed(b, { snapshot_id: a.snapshot_id, version: a.version }), at), /DISCLOSURE_VERSION_CONFLICT/);
  assert.throws(() => compareHoldings({ ...a, items: [{ security_id: "Apple", weight: "1" }] }, b, at), /INVALID_DISCLOSURE_SHAPE/);
});

test("partial disclosure reports conservative uncertainty, never inferred holdings or exact current overlap", () => {
  const partial = changed(a, { complete: false, coverage: "0.30", items: [{ security_id: "ISIN:B", weight: "0.30" }] });
  const result = compareHoldings(partial, b, at);
  assert.equal(result.known_overlap, "0"); assert.equal(result.conservative_upper_bound, "0.7");
  assert.equal(result.quality, "lower_bound"); assert.equal(result.bound_scope, "the_two_disclosed_date_vectors");
  const dated = compareHoldings(changed(a, { as_of: "2025-12-30" }), b, at);
  assert.equal(dated.quality, "different_dates"); assert.deepEqual(dated.issues, ["DISCLOSURE_DATES_DIFFER"]);
  assert.deepEqual(partial.items, [{ security_id: "ISIN:B", weight: "0.30" }]);
});
