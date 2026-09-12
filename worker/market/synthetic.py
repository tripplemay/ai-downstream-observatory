"""Explicit synthetic fixtures, never a live source adapter."""

from worker.orchestration.db import content_hash, stamp


def synthetic_document(batch_id, listing_id, currency="CNY", price="10", scope="synthetic:CN",
                       expected_publication_revision=0, observed_at=None):
    observed = stamp(observed_at)
    raw = {"listing_id": listing_id, "price": price, "observed_at": observed}
    return {"schema_version": "market-batch-v1", "batch": {
        "id": batch_id, "source_id": "synthetic", "batch_type": "prices", "scope": scope,
        "expected_pages": 1, "expected_rows": 1, "expected_publication_revision": expected_publication_revision,
        "source_mode": "synthetic"}, "pages": [{"page_number": 1, "observations": [{
            "id": batch_id + ":row:1", "batch_id": batch_id, "source_id": "synthetic",
            "listing_id": listing_id, "series_key": listing_id, "metric": "close", "value": price,
            "unit": currency, "observed_at": observed, "ingested_at": observed, "source_timezone": "UTC",
            "time_precision": "second", "price_basis": "unadjusted", "revision_id": "synthetic-v1",
            "raw_hash": content_hash(raw), "parser_version": "synthetic-v1", "provenance": "reconstructed"
        }]}]}
