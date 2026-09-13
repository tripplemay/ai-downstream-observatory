import { z } from "zod";

export const reviewId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export const reviewHash = z.string().regex(/^[a-f0-9]{64}$/);
const label = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && [...value].every(character => character.length === 2 || character.charCodeAt(0) < 0xD800 || character.charCodeAt(0) > 0xDFFF));
export const reviewInstant = z.string().regex(/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine(value => {
  const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
});
const date = z.string().regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + "T00:00:00Z"); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const step = z.string().regex(/^(?=(?:[0-9]\.?){1,38}$)(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/).refine(value => /[1-9]/.test(value)).nullable();
export const listingIdentitySchema = z.object({ listing_id: reviewId, instrument_id: reviewId, market: z.enum(["CN", "HK", "US"]), exchange: label(40), ticker: label(40), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export const listingReviewFactsSchema = z.object({
  instrument_kind: z.enum(["ETF", "ETN", "equity", "fund", "other", "unknown"]), lifecycle_status: z.enum(["active", "suspended", "delisted", "unknown"]),
  quantity_step: step, price_step: step, source_effective_date: date.nullable(), fund_identifier: label(160).nullable(), share_class_identifier: label(160).nullable(),
  product_structure: z.object({ leverage: z.enum(["unleveraged", "leveraged", "unknown"]), direction: z.enum(["long_only", "inverse", "unknown"]) }).strict(),
  risk_classification: z.object({ index_id: label(160).nullable(), region: label(160).nullable(), sector: label(160).nullable() }).strict(),
}).strict();
export const publishListingReviewSchema = z.object({ portfolio_id: reviewId, listing_id: reviewId, expected_review_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1), expected_identity_hash: reviewHash, source_id: reviewId, source_hash: reviewHash, facts: listingReviewFactsSchema, review_until: reviewInstant, reason: label(2000), acknowledgement: z.literal(true), idempotency_key: reviewId }).strict();
export type PublishListingReviewCommand = z.infer<typeof publishListingReviewSchema>;
export type ListingReviewFacts = z.infer<typeof listingReviewFactsSchema>;
export type ListingIdentity = z.infer<typeof listingIdentitySchema>;
