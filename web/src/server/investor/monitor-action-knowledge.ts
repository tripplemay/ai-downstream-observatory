import type Database from "better-sqlite3";
import { hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";
import { validateInvestorActionAvailability } from "./kernel-contracts";
import { MANAGED_ACTION_PREFIX, readManagedActionOrigin } from "./managed-action-source";
import type { VerifiedSourceReview } from "./source-inputs";

type Obj = Record<string, unknown>;
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_EVIDENCE_INVALID"); }
function text(value: unknown): string { check(typeof value === "string"); return value; }
function events(value: unknown): Obj[] { check(Array.isArray(value)); return value as Obj[]; }
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Independent origin derivation, not a worker summary or a source approval. */
export function actionAvailabilityRefs(db: Database.Database, workspace: string, reviews: VerifiedSourceReview[], now: string, frozen: string) {
  const result: Obj[] = [];
  for (const review of reviews) {
    const origin = review.row.id.startsWith(MANAGED_ACTION_PREFIX) ? readManagedActionOrigin(db, workspace, review, now) : review;
    check(priceInstant(origin.row.created_at) <= priceInstant(review.row.created_at) && priceInstant(review.row.created_at) <= priceInstant(frozen));
    for (const event of events(review.facts.events)) result.push({ review_id: review.row.id, review_hash: review.row.content_hash,
      event_id: event.id, event_hash: hash(event), original_review_id: origin.row.id, original_review_hash: origin.row.content_hash, known_at: origin.row.created_at });
  }
  check(result.length <= 10000);
  result.sort((a,b) => cmp(text(a.review_id),text(b.review_id)) || cmp(text(a.event_id),text(b.event_id)));
  indexActionAvailability(reviews, result, frozen);
  return result;
}

/** Binding checks only; the receipt reader must independently derive all refs. */
export function indexActionAvailability(reviews: VerifiedSourceReview[], refs: Obj[], frozen: string) {
  check(refs.length <= 10000);
  const result = new Map<string, Obj>(), expected = new Set<string>();
  const key = (review: unknown, event: unknown) => JSON.stringify([text(review), text(event)]);
  for (const ref of refs) {
    validateInvestorActionAvailability(ref);
    const id = key(ref.review_id, ref.event_id); check(!result.has(id)); result.set(id, ref);
  }
  for (const review of reviews) for (const event of events(review.facts.events)) {
    const id = key(review.row.id, event.id), ref = result.get(id); check(ref && !expected.has(id)); expected.add(id);
    check(ref.review_hash === review.row.content_hash && ref.event_hash === hash(event)
      && priceInstant(event.published_at) <= priceInstant(ref.known_at) && priceInstant(ref.known_at) <= priceInstant(review.row.created_at)
      && priceInstant(review.row.created_at) <= priceInstant(frozen));
  }
  check(result.size === expected.size);
  return (review: string, event: unknown) => { const ref = result.get(key(review,event)); check(ref); return ref; };
}
