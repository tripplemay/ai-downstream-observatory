import { createHash } from "node:crypto";
import { Decimal } from "../ledger/decimal";
import { catalogInstantSchema, holdingsSnapshotSchema } from "./schemas";
import type { HoldingsOverlap, HoldingsReference, HoldingsSnapshot } from "./types";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value), "utf8").digest("hex");
const exact = (value: Decimal) => value.isZero() ? "0" : value.toFixed();
const compareId = (a: { security_id: string }, b: { security_id: string }) => a.security_id < b.security_id ? -1 : a.security_id > b.security_id ? 1 : 0;

function checked(snapshot: unknown): HoldingsSnapshot {
  const result = holdingsSnapshotSchema.safeParse(snapshot);
  if (!result.success) throw new Error("INVALID_DISCLOSURE_SHAPE");
  return result.data;
}

/** Check source arithmetic without trusting its claimed hash; null is allowed while constructing a snapshot. */
export function disclosureHash(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !Object.hasOwn(snapshot, "content_hash")) throw new Error("INVALID_DISCLOSURE_SHAPE");
  const validated = checked({ ...snapshot, content_hash: "0".repeat(64) });
  const { content_hash: ignored, ...payload } = validated;
  void ignored;
  return hash({ ...payload, items: [...payload.items].sort(compareId) });
}

function instant(value: string): { micros: bigint; normalized: string } {
  if (!catalogInstantSchema.safeParse(value).success) throw new Error("INVALID_COMPARISON_AT");
  const second = value.slice(0, 19), fractional = (value.match(/\.([0-9]+)Z$/)?.[1] ?? "").padEnd(6, "0");
  return { micros: BigInt(new Date(`${second}Z`).getTime()) * 1000n + BigInt(fractional), normalized: `${second}.${fractional}Z` };
}

function reference(snapshot: HoldingsSnapshot): HoldingsReference {
  const { snapshot_id, portfolio_id, listing_id, version, as_of, known_at, content_hash, complete } = snapshot;
  return { snapshot_id, portfolio_id, listing_id, version, as_of, known_at, content_hash, complete };
}

/** Bounds apply to the two disclosed date vectors, not today's inferred portfolio. */
export function compareHoldings(snapshotA: unknown, snapshotB: unknown, comparisonAt: string): HoldingsOverlap {
  const at = instant(comparisonAt);
  const snapshots = [snapshotA, snapshotB].map((raw, index) => {
    const label = index === 0 ? "A" : "B", snapshot = checked(raw);
    if (snapshot.as_of > comparisonAt.slice(0, 10)) throw new Error(`FUTURE_DISCLOSURE_DATE:${label}`);
    if (instant(snapshot.known_at).micros > at.micros) throw new Error(`DISCLOSURE_NOT_YET_KNOWN:${label}`);
    if (disclosureHash(snapshot) !== snapshot.content_hash) throw new Error(`DISCLOSURE_HASH_MISMATCH:${label}`);
    return snapshot;
  });
  const [a, b] = snapshots;
  if (a.portfolio_id !== b.portfolio_id) throw new Error("DISCLOSURE_PORTFOLIO_MISMATCH");
  if (a.snapshot_id === b.snapshot_id && a.version === b.version && a.content_hash !== b.content_hash) throw new Error("DISCLOSURE_VERSION_CONFLICT");
  const weightsA = new Map(a.items.map(item => [item.security_id, new Decimal(item.weight)]));
  const weightsB = new Map(b.items.map(item => [item.security_id, new Decimal(item.weight)]));
  const common = [...weightsA.keys()].filter(id => weightsB.has(id)).sort().map(id => {
    const left = weightsA.get(id)!, right = weightsB.get(id)!;
    return { security_id: id, weight_a: exact(left), weight_b: exact(right), overlap_weight: exact(Decimal.min(left, right)) };
  });
  const overlap = common.reduce((sum, item) => sum.plus(item.overlap_weight), new Decimal(0));
  const coverageA = new Decimal(a.coverage), coverageB = new Decimal(b.coverage);
  const uncoveredA = new Decimal(1).minus(coverageA), uncoveredB = new Decimal(1).minus(coverageB);
  const sameDate = a.as_of === b.as_of;
  const issues: string[] = [];
  if (!sameDate) issues.push("DISCLOSURE_DATES_DIFFER");
  if (!a.complete) issues.push("PARTIAL_DISCLOSURE:A");
  if (!b.complete) issues.push("PARTIAL_DISCLOSURE:B");
  const result: Omit<HoldingsOverlap, "binding_id"> = {
    schema_version: "holdings-overlap-v1", method_version: "holdings-overlap-v1",
    portfolio_id: a.portfolio_id, comparison_at: at.normalized, weight_basis: "net_assets_long_only",
    snapshot_a: reference(a), snapshot_b: reference(b),
    known_overlap: exact(overlap), coverage_a: exact(coverageA), coverage_b: exact(coverageB),
    uncovered_a: exact(uncoveredA), uncovered_b: exact(uncoveredB),
    conservative_upper_bound: exact(Decimal.min(1, overlap.plus(uncoveredA).plus(uncoveredB))),
    quality: !sameDate ? "different_dates" : a.complete && b.complete ? "exact" : "lower_bound",
    same_date: sameDate, bound_scope: "the_two_disclosed_date_vectors", common_holdings: common,
    issues: issues.sort(),
  };
  return { ...result, binding_id: hash(result) };
}
