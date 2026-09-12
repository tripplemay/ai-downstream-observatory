"""Atomic, worker-origin price batches with explicit reviewed reference proofs.

SDK projections are not HTTP originals, executable quotes, or historical
publication-time evidence. No account or investment authority is derived here.
"""

from dataclasses import dataclass, field
from hashlib import sha256
import json

from worker.orchestration.db import (
    WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, stamp, transaction,
)
from worker.orchestration.jobs import Lease, assert_lease
from .contracts import validate_contract
from .providers import longport
from .references import price_collection_scope, select_references, strict_object


SOURCE_ID = "provider:longport:prices"
PARSER_VERSION = "longport-price-collection-v1"


@dataclass(frozen=True)
class PreparedPriceCollection:
    raw: bytes
    receipt: dict
    normalized: dict
    document: dict
    _prepared_hash: str = field(init=False, repr=False)

    def __post_init__(self):
        object.__setattr__(self, "_prepared_hash", self.material_hash())

    def material_hash(self):
        return content_hash({"raw_sha256": sha256(self.raw).hexdigest(), "receipt": self.receipt,
                             "normalized": self.normalized, "document": self.document})


def _assert(value, code="PRICE_PROVIDER_EVIDENCE_INVALID"):
    if not value:
        raise WorkbenchError(code)


def _request_payload(request):
    try:
        payload = strict_object(request["payload_json"], maximum=16384)
        validate_contract(payload, "market-price-collect.schema.json")
        _assert(request["command_type"] == "market_collect_prices" and request["actor_id"].strip()
                and request["payload_hash"] == content_hash(payload))
        return payload
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, UnicodeError):
        raise WorkbenchError("INVALID_MARKET_PRICE_COLLECT") from None


def _revision(connection, scope):
    row = connection.execute("SELECT revision FROM market_publications WHERE scope=?", (scope,)).fetchone()
    return row["revision"] if row else 0


def _replay_projection(projection, selected, payload):
    request = longport._request(selected["mapping"], payload["start_date"], payload["end_date"], selected["expected_dates"])
    source = projection["source"]
    _assert(projection["request"] == request and isinstance(projection["candlesticks"], list)
            and 1 <= len(projection["candlesticks"]) <= 31)
    candles = []
    for row in projection["candlesticks"]:
        _assert(isinstance(row["volume"], str) and row["volume"].isascii() and row["volume"].isdigit()
                and len(row["volume"]) <= 19)
        candles.append({**row, "volume": int(row["volume"]), "timestamp": instant(row["timestamp"])})
    parsed = longport._normalize(candles, request=request, sdk_version=longport.SDK_VERSION,
                                call_started_at=source["call_started_at"], call_returned_at=source["call_returned_at"],
                                datetime_basis="runtime_utc_from_unix_timestamp", collector_runtime="isolated_official_sdk")
    _assert(parsed["projection"] == projection, "PRICE_PROVIDER_PROJECTION_MISMATCH")
    return parsed


def _normalized(portfolio_id, payload, references, selected, projections):
    _assert(len(projections) == len(selected))
    segments, previous = [], references["known_at"]
    for chosen, projection in zip(selected, projections):
        parsed = _replay_projection(projection, chosen, payload)
        _assert(instant(previous) <= instant(parsed["source"]["call_started_at"]), "PRICE_PROVIDER_CALL_ORDER_INVALID")
        previous = parsed["source"]["call_returned_at"]
        segments.append({"listing_id": chosen["mapping"]["listing_id"],
                         "mapping_version_id": chosen["mapping_version_id"],
                         "calendar_version_id": chosen["calendar_version_id"],
                         "projection_sha256": parsed["projection_sha256"], "records": parsed["records"]})
    return {"schema_version": "longport-price-batch-v1", "portfolio_id": portfolio_id,
            "market": references["market"], "start_date": payload["start_date"], "end_date": payload["end_date"],
            "references": references, "segments": segments}


def _document(normalized, payload, receipt):
    rows = []
    for segment in normalized["segments"]:
        for record in segment["records"]:
            rows.append({"id": "observation:" + content_hash([receipt["id"], record["listing_id"], record["observed_at"]]),
                         "batch_id": receipt["batch_id"], "source_id": SOURCE_ID,
                         "listing_id": record["listing_id"], "series_key": "PRICE:" + record["listing_id"],
                         "metric": "close", "value": record["value"], "unit": record["currency"],
                         "observed_at": record["observed_at"], "ingested_at": receipt["received_at"],
                         "source_timezone": record["source_timezone"], "time_precision": "date",
                         "price_basis": "unadjusted", "revision_id": receipt["id"], "raw_hash": receipt["raw_sha256"],
                         "parser_version": PARSER_VERSION, "provenance": "live_observed"})
    return {"schema_version": "market-price-provider-batch-v1", "batch": {
        "id": receipt["batch_id"], "source_id": SOURCE_ID,
        "scope": price_collection_scope(normalized["portfolio_id"], normalized["references"]), "batch_type": "prices",
        "expected_pages": 1, "expected_rows": len(rows), "source_mode": "provider_observed",
        "expected_publication_revision": payload["expected_publication_revision"], "provider_capture_id": receipt["id"]},
        "pages": [{"page_number": 1, "observations": rows}]}


def _selected_from_projections(references, projections):
    _assert(len(projections) == len(references["mappings"]) and 1 <= len(projections) <= 4)
    selected = []
    for proof, projection in zip(references["mappings"], projections):
        mapping = projection["request"]["mapping"]
        _assert(mapping["listing_id"] == proof["listing_id"])
        selected.append({"mapping": mapping, "mapping_version_id": proof["version_id"],
                         "calendar_version_id": proof["calendar_version_id"], "expected_dates": proof["expected_dates"]})
    return selected


def _verify_material(prepared, request, replay=True):
    _assert(prepared.material_hash() == prepared._prepared_hash, "PROVIDER_PREPARED_MUTATED")
    receipt, normalized = prepared.receipt, prepared.normalized
    validate_contract(receipt, "market-sdk-capture.schema.json")
    validate_contract(prepared.document, "market-price-provider-batch.schema.json")
    payload = _request_payload(request)
    references = normalized["references"]
    _assert(isinstance(prepared.raw, bytes) and 1 <= len(prepared.raw) <= longport.MAX_PROJECTION_BYTES
            and sha256(prepared.raw).hexdigest() == receipt["raw_sha256"] and len(prepared.raw) == receipt["raw_bytes"]
            and content_hash(normalized) == receipt["normalized_hash"]
            and content_hash(prepared.document) == receipt["document_hash"]
            and content_hash(references) == receipt["references_hash"]
            and references["binding_id"] == content_hash({k: v for k, v in references.items() if k != "binding_id"})
            and request["id"] == receipt["command_request_id"] and request["payload_hash"] == receipt["request_hash"]
            and references["known_at"] == receipt["request_started_at"]
            and stamp(receipt["received_at"]) == receipt["received_at"]
            and stamp(receipt["request_started_at"]) == receipt["request_started_at"]
            and instant(receipt["request_started_at"]) <= instant(receipt["received_at"]))
    raw = strict_object(prepared.raw.decode("utf-8"), maximum=longport.MAX_PROJECTION_BYTES)
    _assert(set(raw) == {"schema_version", "projections"} and raw["schema_version"] == "longport-batch-projection-v1"
            and canonical_json(raw).encode("utf-8") == prepared.raw)
    if replay:
        selected = _selected_from_projections(references, raw["projections"])
        expected = _normalized(request["portfolio_id"], payload, references, selected, raw["projections"])
        _assert(expected == normalized, "PRICE_PROVIDER_NORMALIZATION_MISMATCH")
    _assert(raw["projections"] and instant(raw["projections"][-1]["source"]["call_returned_at"]) <= instant(receipt["received_at"])
            and prepared.document == _document(normalized, payload, receipt))
    return payload


def _verify_references(connection, prepared, payload, portfolio_id, known_at, *, require_current=False):
    frozen = prepared.normalized["references"]
    original, selected = select_references(connection, portfolio_id, payload, frozen["known_at"])
    _assert(original == frozen, "PRICE_PROVIDER_REFERENCE_PROOF_MISMATCH")
    raw = strict_object(prepared.raw.decode("utf-8"), maximum=longport.MAX_PROJECTION_BYTES)
    _assert(selected == _selected_from_projections(frozen, raw["projections"]), "PRICE_PROVIDER_MAPPING_MISMATCH")
    current, _ = select_references(connection, portfolio_id, payload, known_at, require_current=require_current)
    _assert(current["heads"] == frozen["heads"], "STALE_MARKET_REFERENCE_VERSION")


def prepare_price_collection(connection, request, job, lease):
    if connection.in_transaction:
        raise WorkbenchError("PROVIDER_NETWORK_INSIDE_TRANSACTION")
    assert_writable(connection)
    payload = _request_payload(request)
    _assert(job["id"] == lease.job_id and job["command_request_id"] == request["id"]
            and job["scope"] == request["portfolio_id"] and job["job_type"] == "market_collect_prices",
            "PROVIDER_JOB_SCOPE_MISMATCH")
    assert_lease(connection, lease)
    started = stamp()
    with transaction(connection, immediate=False):
        references, selected = select_references(connection, request["portfolio_id"], payload, started, require_current=True)
        scope = price_collection_scope(request["portfolio_id"], references)
        _assert(_revision(connection, scope) == payload["expected_publication_revision"], "STALE_PUBLICATION_REVISION")
    try:
        projections = []
        for chosen in selected:
            assert_writable(connection)
            assert_lease(connection, lease)
            result = longport.collect_longport_candles(mapping=chosen["mapping"], start_date=payload["start_date"],
                                                       end_date=payload["end_date"], expected_dates=chosen["expected_dates"])
            assert_lease(connection, lease)
            assert_writable(connection)
            parsed = _replay_projection(result["projection"], chosen, payload)
            _assert(parsed == result, "PRICE_PROVIDER_PROJECTION_MISMATCH")
            projections.append(result["projection"])
        received = stamp()
        raw = canonical_json({"schema_version": "longport-batch-projection-v1", "projections": projections}).encode("utf-8")
        normalized = _normalized(request["portfolio_id"], payload, references, selected, projections)
        receipt = {"schema_version": "market-sdk-capture-v1", "id": new_id("capture"), "batch_id": new_id("batch"),
                   "provider": "longport", "capture_kind": "sdk_projection", "command_request_id": request["id"],
                   "job_id": job["id"], "attempt": lease.attempt, "fencing_token": lease.fencing_token,
                   "request_hash": request["payload_hash"], "request_started_at": started, "received_at": received,
                   "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw), "parser_version": PARSER_VERSION,
                   "sdk_version": longport.SDK_VERSION, "normalized_hash": content_hash(normalized),
                   "references_hash": content_hash(references), "rate_kind": "market_price_not_executable",
                   "publication_time_status": "not_supplied", "timestamp_semantics": "provider_bar_timestamp_not_confirmed_close",
                   "coverage_kind": "reviewed_calendar_exact_dates"}
        document = _document(normalized, payload, receipt)
        receipt["document_hash"] = content_hash(document)
        prepared = PreparedPriceCollection(raw, receipt, normalized, document)
        _verify_material(prepared, request)
        return prepared
    except Exception as error:
        allowed = {"STALE_OR_EXPIRED_LEASE", "RESTORE_PENDING_REVIEW", "WORKBENCH_READ_ONLY"}
        code = str(error) if isinstance(error, WorkbenchError) and str(error) in allowed else "PRICE_PROVIDER_COLLECTION_FAILED"
        raise WorkbenchError(code) from None


def persist_price_collection(connection, prepared, now=None):
    from .batches import stage_batch, stage_page, validate_batch, publish_batch
    receipt, current = prepared.receipt, stamp(now)
    with transaction(connection):
        request = connection.execute("SELECT * FROM command_requests WHERE id=?", (receipt["command_request_id"],)).fetchone()
        payload = _verify_material(prepared, request, replay=False)
        job = connection.execute("SELECT * FROM job_runs WHERE id=?", (receipt["job_id"],)).fetchone()
        _assert(job is not None, "PROVIDER_JOB_SCOPE_MISMATCH")
        lease = Lease(job["id"], job["lease_owner"], receipt["fencing_token"], receipt["attempt"], job["lease_until"])
        assert_lease(connection, lease, now=current)
        _verify_references(connection, prepared, payload, request["portfolio_id"], current, require_current=True)
        _assert(_revision(connection, prepared.document["batch"]["scope"]) == payload["expected_publication_revision"], "STALE_PUBLICATION_REVISION")
        _assert(instant(current) >= instant(receipt["received_at"]), "PROVIDER_COMMIT_BEFORE_RECEIPT")
        connection.execute("""INSERT INTO market_sdk_captures
            (id,batch_id,command_request_id,job_id,attempt,raw_body,receipt_json,receipt_hash,normalized_json,document_json,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)""", (receipt["id"], receipt["batch_id"], receipt["command_request_id"],
            receipt["job_id"], receipt["attempt"], prepared.raw, canonical_json(receipt), content_hash(receipt),
            canonical_json(prepared.normalized), canonical_json(prepared.document), current))
        stage_batch(connection, prepared.document["batch"], now=receipt["request_started_at"])
        stage_page(connection, receipt["batch_id"], 1, prepared.document["pages"][0]["observations"], now=receipt["received_at"])
        batch = validate_batch(connection, receipt["batch_id"], now=current)
        _assert(batch["status"] == "validated", "PROVIDER_BATCH_VALIDATION_FAILED")
        if payload["publish"]:
            publish_batch(connection, receipt["batch_id"], now=current)
            batch["status"] = "published"
        return {"batch_id": batch["id"], "batch_status": batch["status"], "manifest_hash": batch["manifest_hash"],
                "capture_id": receipt["id"], "receipt_hash": content_hash(receipt),
                "rate_kind": receipt["rate_kind"], "live_advice_eligible": False}


def verify_price_provider_capture(connection, batch_id, require_published=True, *, replay=True, known_at=None):
    from .collection import _verify_capture
    try:
        summary = _verify_capture(connection, batch_id, require_published, replay=replay, known_at=known_at,
                                  table="market_sdk_captures", prepared_type=PreparedPriceCollection,
                                  verify_material=_verify_material, request_payload=_request_payload,
                                  job_type="market_collect_prices", source_id=SOURCE_ID)
        row = connection.execute("SELECT * FROM market_sdk_captures WHERE batch_id=?", (batch_id,)).fetchone()
        request = connection.execute("SELECT * FROM command_requests WHERE id=?", (row["command_request_id"],)).fetchone()
        prepared = PreparedPriceCollection(bytes(row["raw_body"]), json.loads(row["receipt_json"]),
                                           json.loads(row["normalized_json"]), json.loads(row["document_json"]))
        _verify_references(connection, prepared, _request_payload(request), request["portfolio_id"], stamp(known_at))
        return summary
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, UnicodeError):
        raise WorkbenchError("PRICE_PROVIDER_EVIDENCE_INVALID") from None
