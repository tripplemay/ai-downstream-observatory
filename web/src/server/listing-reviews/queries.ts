import type Database from "better-sqlite3";
import { z } from "zod";
import { canonical, hash } from "../ledger/service";
import { referenceReadOnly } from "../market-references/service";
import { currentListingIdentity, listingReviewClock, readListingReviewVersion, reviewedListingAt } from "./service";
import { reviewId } from "./schemas";
import type { ListingReviewPublic, ListingReviewState, ReviewedListing } from "./types";
const query = z.object({ portfolio_id: reviewId.optional(), listing_id: reviewId.optional(), cursor: z.string().min(1).max(1024).optional(), limit: z.number().int().min(1).max(50).optional() }).strict();
const cursorSchema = z.object({ portfolio: reviewId, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), after: reviewId }).strict();
function publicReview(proof: ReviewedListing): ListingReviewPublic | null {
  return proof.document && proof.row && proof.proof_hash ? { document: proof.document, content_hash: proof.row.content_hash, audit_id: proof.row.audit_id, proof_hash: proof.proof_hash, quality: proof.quality, issues: proof.issues } : null;
}
export function getListingReviewState(db: Database.Database, raw: unknown = {}, options: { now?: string } = {}): ListingReviewState {
  const parsed = query.safeParse(raw); if (!parsed.success) throw new Error("LISTING_REVIEW_INVALID_QUERY");
  const input = parsed.data, now = listingReviewClock(options);
  return db.transaction((): ListingReviewState => {
    const allPortfolios = db.prepare("SELECT id,name FROM portfolios ORDER BY created_at,id LIMIT 1001").all() as { id: string; name: string }[];
    const portfolios = allPortfolios.slice(0, 1000), portfolio = input.portfolio_id ?? (portfolios.length ? portfolios[0].id : null);
    const empty = { schema_version: "listing-review-state-v1" as const, portfolios, portfolios_truncated: allPortfolios.length > 1000, selected_portfolio_id: portfolio, selected_listing_id: input.listing_id ?? null, catalog_revision: 0, read_only: referenceReadOnly(db), checked_at: now, resource_hash: hash({ portfolio }), rows: [], next_cursor: null, selected: null, sources: [], sources_truncated: false, history: [], history_truncated: false };
    if (!portfolio) { if (input.listing_id || input.cursor) throw new Error("LISTING_REVIEW_INVALID_QUERY"); return empty; }
    if (!db.prepare("SELECT 1 FROM portfolios WHERE id=?").get(portfolio)) throw new Error("LISTING_REVIEW_PORTFOLIO_NOT_FOUND");
    const revision = (db.prepare("SELECT revision FROM catalog_heads WHERE portfolio_id=?").get(portfolio) as { revision: number } | undefined)?.revision ?? 0;
    let after = "";
    if (input.cursor) {
      try {
        const decoded = Buffer.from(input.cursor, "base64url").toString("utf8"), cursor = cursorSchema.parse(JSON.parse(decoded));
        if (Buffer.from(canonical(cursor)).toString("base64url") !== input.cursor || cursor.portfolio !== portfolio) throw new Error();
        if (cursor.revision !== revision) throw new Error("LISTING_REVIEW_CURSOR_STALE"); after = cursor.after;
      } catch (error) { if (error instanceof Error && error.message === "LISTING_REVIEW_CURSOR_STALE") throw error; throw new Error("LISTING_REVIEW_INVALID_QUERY"); }
    }
    const limit = input.limit ?? 20;
    const candidates = db.prepare("SELECT listing_id FROM catalog_entries WHERE portfolio_id=? AND listing_id>? ORDER BY listing_id LIMIT ?").all(portfolio, after, limit + 1) as { listing_id: string }[];
    const view = (listing: string) => {
      const proof = reviewedListingAt(db, { portfolio_id: portfolio, listing_id: listing, knowledge_at: now, now });
      const head = db.prepare("SELECT revision,updated_at FROM listing_review_heads WHERE portfolio_id=? AND listing_id=?").get(portfolio, listing) as { revision: number; updated_at: string } | undefined;
      const name = (db.prepare("SELECT i.name FROM instruments i JOIN listings l ON l.instrument_id=i.id WHERE l.id=?").get(listing) as { name: string }).name;
      return { identity: proof.identity, identity_hash: hash(proof.identity), name, review_revision: head?.revision ?? 0, quality: proof.quality, issues: proof.issues, current: publicReview(proof) };
    };
    const rows = candidates.slice(0, limit).map(row => view(row.listing_id)), selected = input.listing_id ? view(input.listing_id) : null;
    const sourcesAll = db.prepare("SELECT id,portfolio_id,reference,content_hash,known_at,created_by FROM market_reference_sources WHERE portfolio_id=? AND known_at<=? ORDER BY known_at DESC,id DESC LIMIT 101").all(portfolio, now) as ListingReviewState["sources"];
    const sources = sourcesAll.slice(0, 100);
    const ids = input.listing_id ? db.prepare("SELECT id FROM listing_review_versions WHERE portfolio_id=? AND listing_id=? AND known_at<=? ORDER BY revision DESC LIMIT 21").all(portfolio, input.listing_id, now) as { id: string }[] : [];
    const history = ids.slice(0, 20).map(({ id }) => {
      const proof = readListingReviewVersion(db, portfolio, input.listing_id!, id);
      // History is labelled by its own revision, even when multiple versions share known_at.
      return { document: proof.document, content_hash: proof.row.content_hash, audit_id: proof.row.audit_id, proof_hash: proof.proof_hash, quality: "blocked" as const, issues: ["LISTING_REVIEW_HISTORICAL_NOT_CURRENT_AUTHORIZATION"] };
    });
    if (input.listing_id) currentListingIdentity(db, portfolio, input.listing_id);
    return { ...empty, catalog_revision: revision, rows, selected, sources, sources_truncated: sourcesAll.length > 100, history, history_truncated: ids.length > 20,
      resource_hash: hash({ portfolio, revision, rows, selected, sources, history: history.map(row => row.content_hash) }),
      next_cursor: candidates.length > limit ? Buffer.from(canonical({ portfolio, revision, after: candidates[limit - 1].listing_id })).toString("base64url") : null };
  })();
}
