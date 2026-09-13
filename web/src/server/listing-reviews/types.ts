import type { ReferenceSource } from "../market-references/service";
import type { ListingIdentity, ListingReviewFacts } from "./schemas";
export type { ListingIdentity, ListingReviewFacts, PublishListingReviewCommand } from "./schemas";
export type ListingReviewDocument = {
  schema_version: "listing-review-v1"; id: string; portfolio_id: string; listing_id: string; revision: number;
  source_id: string; source_hash: string; source_known_at: string; identity_snapshot: ListingIdentity; identity_hash: string;
  known_at: string; created_by: string; review_until: string; reason: string; review_basis: "human_reviewed_not_provider_verified"; facts: ListingReviewFacts;
};
export type ListingReviewRow = Omit<ListingReviewDocument, "schema_version" | "identity_snapshot" | "review_basis" | "facts"> & { identity_json: string; facts_json: string; document_json: string; content_hash: string; audit_id: string };
export type ListingReviewReceipt = Pick<ListingReviewDocument, "id" | "portfolio_id" | "listing_id" | "revision" | "identity_hash" | "source_id" | "source_hash" | "known_at" | "review_until" | "review_basis"> & { content_hash: string; audit_id: string };
export type ReviewedListing = { portfolio_id: string; listing_id: string; knowledge_at: string; checked_at: string; quality: "complete" | "blocked"; issues: string[]; row: ListingReviewRow | null; document: ListingReviewDocument | null; source: ReferenceSource | null; identity: ListingIdentity; proof_hash: string | null };
export type ListingReviewPublic = { document: ListingReviewDocument; content_hash: string; audit_id: string; proof_hash: string; quality: "complete" | "blocked"; issues: string[] };
export type ListingReviewState = {
  schema_version: "listing-review-state-v1"; portfolios: { id: string; name: string }[]; portfolios_truncated: boolean;
  selected_portfolio_id: string | null; selected_listing_id: string | null; catalog_revision: number; read_only: boolean; checked_at: string; resource_hash: string;
  rows: { identity: ListingIdentity; identity_hash: string; name: string; review_revision: number; quality: "complete" | "blocked"; issues: string[]; current: ListingReviewPublic | null }[];
  next_cursor: string | null;
  selected: { identity: ListingIdentity; identity_hash: string; name: string; review_revision: number; current: ListingReviewPublic | null; quality: "complete" | "blocked"; issues: string[] } | null;
  sources: Omit<ReferenceSource, "content_text">[]; sources_truncated: boolean;
  history: ListingReviewPublic[]; history_truncated: boolean;
};
