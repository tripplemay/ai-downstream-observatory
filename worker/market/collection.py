"""Worker-owned network captures; manual imports cannot claim provider origin."""

from dataclasses import dataclass, field
from hashlib import sha256
import json

from worker.orchestration.db import (
    WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, stamp, transaction,
)
from worker.orchestration.jobs import assert_lease
from .contracts import validate_contract
from .providers.ecb import PARSER_VERSION, URLS, download_ecb_xml, parse_ecb_xml


SOURCE_ID = "provider:ecb:reference-fx"


@dataclass(frozen=True)
class PreparedCollection:
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


def collection_scope(payload):
    validate_contract(payload, "market-collect.schema.json")
    return "provider:ecb:fx:" + payload["feed"] + ":" + "-".join(sorted(payload["currencies"]))


def reserved_source(plan):
    return any(str(plan.get(key, "")).lower().startswith("provider:") for key in ("source_id", "scope"))


def _document(normalized, payload, batch_id, capture_id):
    rows = []
    source = normalized["source"]
    for record in normalized["records"]:
        rows.append({"id": "observation:" + content_hash([capture_id, record["rate_date"], record["currency"]]),
                     "batch_id": batch_id, "source_id": SOURCE_ID, "series_key": "FX:" + record["currency"],
                     "metric": "fx_cny_per_unit", "value": record["value_cny_per_unit"],
                     "unit": "CNY_per_unit_currency", "observed_at": record["rate_date"],
                     "ingested_at": source["retrieved_at"], "source_timezone": "Europe/Berlin",
                     "time_precision": "date", "price_basis": "not_applicable",
                     "revision_id": capture_id, "raw_hash": source["raw_sha256"],
                     "parser_version": PARSER_VERSION, "provenance": "live_observed"})
    return {"schema_version": "market-provider-batch-v1", "batch": {
        "id": batch_id, "source_id": SOURCE_ID, "scope": collection_scope(payload), "batch_type": "fx",
        "expected_pages": 1, "expected_rows": len(rows),
        "expected_publication_revision": payload["expected_publication_revision"],
        "source_mode": "provider_observed", "provider_capture_id": capture_id},
        "pages": [{"page_number": 1, "observations": rows}]}


def _request_payload(request):
    try:
        payload = json.loads(request["payload_json"])
        validate_contract(payload, "market-collect.schema.json")
        if (request["command_type"] != "market_collect" or not request["actor_id"].strip()
                or request["payload_hash"] != content_hash(payload)):
            raise WorkbenchError("PROVIDER_REQUEST_INVALID")
        return payload
    except (ValueError, TypeError, KeyError, AttributeError):
        raise WorkbenchError("INVALID_MARKET_COLLECT") from None


def _current_revision(connection, scope):
    row = connection.execute("SELECT revision FROM market_publications WHERE scope=?", (scope,)).fetchone()
    return row["revision"] if row else 0


def prepare_collection(connection, request, job, lease):
    """Fixed public download outside the writer transaction; no caller clock."""
    if connection.in_transaction:
        raise WorkbenchError("PROVIDER_NETWORK_INSIDE_TRANSACTION")
    assert_writable(connection)
    payload = _request_payload(request)
    if (job["id"] != lease.job_id or job["command_request_id"] != request["id"]
            or job["scope"] != request["portfolio_id"] or job["job_type"] != "market_collect"):
        raise WorkbenchError("PROVIDER_JOB_SCOPE_MISMATCH")
    assert_lease(connection, lease)
    if _current_revision(connection, collection_scope(payload)) != payload["expected_publication_revision"]:
        raise WorkbenchError("STALE_PUBLICATION_REVISION")
    try:
        downloaded = download_ecb_xml(payload["feed"])
        assert_lease(connection, lease)
        assert_writable(connection)
        if (downloaded["source_url"] != URLS[payload["feed"]] or downloaded["http_status"] != 200
                or downloaded["redirects_followed"] != 0
                or downloaded["completed_at"] != downloaded["retrieved_at"]):
            raise WorkbenchError("PROVIDER_TRANSPORT_INVALID")
        raw = downloaded["raw"]
        normalized = parse_ecb_xml(raw, feed=payload["feed"], retrieved_at=downloaded["retrieved_at"],
                                   currencies=payload["currencies"])
        batch_id, capture_id = new_id("batch"), new_id("capture")
        document = _document(normalized, payload, batch_id, capture_id)
        receipt = {"schema_version": "market-provider-capture-v1", "id": capture_id, "batch_id": batch_id,
                   "provider": "ecb", "capture_kind": "http_response_bytes", "command_request_id": request["id"],
                   "job_id": job["id"], "attempt": lease.attempt, "fencing_token": lease.fencing_token,
                   "request_hash": request["payload_hash"], "request_started_at": stamp(downloaded["started_at"]),
                   "received_at": stamp(downloaded["completed_at"]), "endpoint": downloaded["source_url"],
                   "response_status": downloaded["http_status"], "response_headers": downloaded["headers"],
                   "raw_sha256": downloaded["raw_sha256"], "raw_bytes": downloaded["raw_bytes"],
                   "parser_version": PARSER_VERSION, "normalized_hash": content_hash(normalized),
                   "document_hash": content_hash(document), "rate_kind": "reference_not_executable",
                   "publication_time_status": "not_supplied", "coverage_kind": "returned_feed_dates_not_historical_calendar"}
        prepared = PreparedCollection(raw, receipt, normalized, document)
        _verify_material(prepared, request, replay=False)
        return prepared
    except Exception as error:
        # No provider exception, response body, headers or cause escapes to the
        # generic job logger. Safe lease/restore failures retain their diagnosis.
        allowed = {"STALE_OR_EXPIRED_LEASE", "RESTORE_PENDING_REVIEW", "WORKBENCH_READ_ONLY"}
        code = str(error) if isinstance(error, WorkbenchError) and str(error) in allowed else "PROVIDER_COLLECTION_FAILED"
        raise WorkbenchError(code) from None


def _verify_material(prepared, request, replay):
    receipt, document, normalized = prepared.receipt, prepared.document, prepared.normalized
    if prepared.material_hash() != prepared._prepared_hash:
        raise WorkbenchError("PROVIDER_PREPARED_MUTATED")
    validate_contract(receipt, "market-provider-capture.schema.json")
    validate_contract(document, "market-provider-batch.schema.json")
    payload = _request_payload(request)
    if (not isinstance(prepared.raw, bytes) or sha256(prepared.raw).hexdigest() != receipt["raw_sha256"]
            or len(prepared.raw) != receipt["raw_bytes"] or content_hash(normalized) != receipt["normalized_hash"]
            or content_hash(document) != receipt["document_hash"] or request["id"] != receipt["command_request_id"]
            or request["payload_hash"] != receipt["request_hash"] or receipt["endpoint"] != URLS[payload["feed"]]
            or stamp(receipt["received_at"]) != receipt["received_at"]
            or stamp(receipt["request_started_at"]) != receipt["request_started_at"]
            or instant(receipt["received_at"]) < instant(receipt["request_started_at"])):
        raise WorkbenchError("PROVIDER_CAPTURE_HASH_OR_REQUEST_MISMATCH")
    if replay:
        parsed = parse_ecb_xml(prepared.raw, feed=payload["feed"], retrieved_at=receipt["received_at"],
                               currencies=payload["currencies"])
        if parsed != normalized:
            raise WorkbenchError("PROVIDER_NORMALIZATION_MISMATCH")
    source = normalized["source"]
    if (source["raw_sha256"] != receipt["raw_sha256"] or source["retrieved_at"] != receipt["received_at"]
            or source["parser_version"] != receipt["parser_version"]
            or document != _document(normalized, payload, receipt["batch_id"], receipt["id"])):
        raise WorkbenchError("PROVIDER_DOCUMENT_MISMATCH")
    return payload


def _capture_summary(receipt, receipt_hash):
    return {"id": receipt["id"], "receipt_hash": receipt_hash,
            **{key: receipt[key] for key in ("raw_sha256", "normalized_hash", "document_hash", "rate_kind", "capture_kind")}}


def verify_provider_capture(connection, batch_id, require_published=True, *, replay=True, known_at=None):
    """Check immutable capture and worker origin, never merely a source label.

    `replay=False` is limited to short, already prepared publication writes.
    Read-side callers also reparse the original bytes outside a write lock.
    """
    try:
        row = connection.execute("SELECT * FROM market_provider_captures WHERE batch_id=?", (batch_id,)).fetchone()
        if row is None:
            raise WorkbenchError("PROVIDER_CAPTURE_MISSING")
        request = connection.execute("SELECT * FROM command_requests WHERE id=?", (row["command_request_id"],)).fetchone()
        job = connection.execute("SELECT * FROM job_runs WHERE id=?", (row["job_id"],)).fetchone()
        attempt = connection.execute("SELECT * FROM job_attempts WHERE job_id=? AND attempt=?", (row["job_id"], row["attempt"])).fetchone()
        receipt = json.loads(row["receipt_json"])
        prepared = PreparedCollection(bytes(row["raw_body"]), receipt, json.loads(row["normalized_json"]), json.loads(row["document_json"]))
        _verify_material(prepared, request, replay=replay)
        if (row["receipt_hash"] != content_hash(receipt) or receipt["id"] != row["id"]
                or receipt["batch_id"] != batch_id or receipt["job_id"] != row["job_id"] or receipt["attempt"] != row["attempt"]
                or job["command_request_id"] != request["id"] or job["job_type"] != "market_collect"
                or job["scope"] != request["portfolio_id"] or attempt["fencing_token"] != receipt["fencing_token"]
                or job["attempt_count"] != receipt["attempt"] or job["fencing_token"] != receipt["fencing_token"]
                or instant(receipt["request_started_at"]) < instant(attempt["started_at"])
                or instant(receipt["received_at"]) > instant(row["created_at"])):
            raise WorkbenchError("PROVIDER_WORKER_BINDING_INVALID")
        if require_published:
            result = json.loads(job["result_json"])
            if (job["status"] != "succeeded" or attempt["status"] != "succeeded"
                    or _request_payload(request)["publish"] is not True or result.get("batch_status") != "published"
                    or result.get("capture_id") != row["id"] or result.get("receipt_hash") != row["receipt_hash"]
                    or result.get("batch_id") != batch_id or not isinstance(attempt["finished_at"], str)
                    or instant(row["created_at"]) > instant(attempt["finished_at"])
                    or instant(attempt["finished_at"]) > instant(job["updated_at"])
                    or (known_at is not None and instant(job["updated_at"]) > instant(known_at))):
                raise WorkbenchError("PROVIDER_JOB_NOT_COMMITTED")
        elif job["status"] not in ("running", "succeeded") or attempt["status"] not in ("running", "succeeded"):
            raise WorkbenchError("PROVIDER_JOB_NOT_COMMITTED")
        batch = connection.execute("SELECT * FROM market_batches WHERE id=?", (batch_id,)).fetchone()
        summary = _capture_summary(receipt, row["receipt_hash"])
        if batch is not None:
            validation = json.loads(batch["validation_json"])
            if (validation["plan"] != prepared.document["batch"] or batch["source_id"] != SOURCE_ID
                    or batch["scope"] != prepared.document["batch"]["scope"]):
                raise WorkbenchError("PROVIDER_BATCH_MISMATCH")
            pages = connection.execute("SELECT * FROM market_batch_pages WHERE batch_id=? ORDER BY page_number", (batch_id,)).fetchall()
            if pages and (len(pages) != 1 or pages[0]["page_number"] != 1
                          or json.loads(pages[0]["observations_json"]) != prepared.document["pages"][0]["observations"]
                          or pages[0]["payload_hash"] != content_hash(prepared.document["pages"][0]["observations"])
                          or pages[0]["received_at"] != receipt["received_at"]):
                raise WorkbenchError("PROVIDER_PAGE_MISMATCH")
            if batch["status"] in ("validated", "published"):
                from .batches import OBSERVATION_COLUMNS
                actual = [{key: value for key, value in dict(value).items() if value is not None} for value in connection.execute(
                    "SELECT " + ",".join("o." + key for key in OBSERVATION_COLUMNS) + " FROM market_observations o JOIN market_batch_members m ON m.observation_id=o.id WHERE m.batch_id=? ORDER BY o.id", (batch_id,))]
                expected = sorted(prepared.document["pages"][0]["observations"], key=lambda value: value["id"])
                if actual != expected or len(pages) != 1:
                    raise WorkbenchError("PROVIDER_OBSERVATION_MISMATCH")
                manifest = {"schema_version": "market-publication-v2", "plan": prepared.document["batch"],
                            "pages": [{key: pages[0][key] for key in ("page_number", "payload_hash", "received_at")}],
                            "observation_ids": [value["id"] for value in expected], "provider_capture": summary}
                if validation.get("manifest") != manifest or content_hash(manifest) != batch["manifest_hash"]:
                    raise WorkbenchError("PROVIDER_PUBLICATION_MANIFEST_INVALID")
            if require_published:
                event = connection.execute("SELECT * FROM market_publication_events WHERE batch_id=?", (batch_id,)).fetchone()
                if (batch["status"] != "published" or event is None or event["manifest_hash"] != batch["manifest_hash"]
                        or event["scope"] != batch["scope"] or result.get("manifest_hash") != batch["manifest_hash"]
                        or instant(event["published_at"]) < instant(receipt["received_at"])):
                    raise WorkbenchError("PROVIDER_PUBLICATION_NOT_COMMITTED")
        elif require_published:
            raise WorkbenchError("PROVIDER_BATCH_MISSING")
        return summary
    except (ValueError, TypeError, KeyError, IndexError, AttributeError) as error:
        raise WorkbenchError("PROVIDER_EVIDENCE_INVALID") from None


def persist_collection(connection, prepared, now=None):
    """Store originals with the batch so the existing encrypted DB backup covers both."""
    from .batches import stage_batch, stage_page, validate_batch, publish_batch
    receipt, current = prepared.receipt, stamp(now)
    with transaction(connection):
        request = connection.execute("SELECT * FROM command_requests WHERE id=?", (receipt["command_request_id"],)).fetchone()
        payload = _verify_material(prepared, request, replay=False)
        if _current_revision(connection, collection_scope(payload)) != payload["expected_publication_revision"]:
            raise WorkbenchError("STALE_PUBLICATION_REVISION")
        if instant(current) < instant(receipt["received_at"]):
            raise WorkbenchError("PROVIDER_COMMIT_BEFORE_RECEIPT")
        connection.execute("""INSERT INTO market_provider_captures
            (id,batch_id,command_request_id,job_id,attempt,raw_body,receipt_json,receipt_hash,normalized_json,document_json,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)""", (receipt["id"], receipt["batch_id"], receipt["command_request_id"],
            receipt["job_id"], receipt["attempt"], prepared.raw, canonical_json(receipt), content_hash(receipt),
            canonical_json(prepared.normalized), canonical_json(prepared.document), current))
        stage_batch(connection, prepared.document["batch"], now=receipt["request_started_at"])
        page = prepared.document["pages"][0]
        stage_page(connection, receipt["batch_id"], 1, page["observations"], now=receipt["received_at"])
        batch = validate_batch(connection, receipt["batch_id"], now=current)
        if batch["status"] != "validated":
            raise WorkbenchError("PROVIDER_BATCH_VALIDATION_FAILED")
        if payload["publish"]:
            publish_batch(connection, receipt["batch_id"], now=current)
            batch["status"] = "published"
        return {"batch_id": batch["id"], "batch_status": batch["status"], "manifest_hash": batch["manifest_hash"],
                "capture_id": receipt["id"], "receipt_hash": content_hash(receipt),
                "rate_kind": receipt["rate_kind"], "live_advice_eligible": False}


def source_verified(connection, batch_id, plan, known_at=None):
    batch = connection.execute("SELECT source_id,scope FROM market_batches WHERE id=?", (batch_id,)).fetchone()
    if plan.get("source_mode") == "provider_observed" or reserved_source(plan) or (batch and reserved_source(dict(batch))):
        if plan.get("source_mode") != "provider_observed":
            return False
        try:
            verify_provider_capture(connection, batch_id, known_at=known_at)
            return True
        except WorkbenchError:
            return False
    return plan.get("source_mode") == "manual_verified"
