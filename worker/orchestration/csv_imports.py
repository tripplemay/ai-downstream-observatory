"""Bounded fixed CSV publisher; only independently checked database receipts commit."""

from datetime import timedelta
from decimal import Decimal
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

from .db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, stamp
from .jobs import ExternalCommit, assert_lease


CSV_COMMANDS = ("csv_import_preview_v1", "csv_import_confirm_v1")
CSV_TERMINAL_CODES = {"CSV_BACKGROUND_EVIDENCE_INVALID", "CSV_BACKGROUND_EXPIRED", "CSV_BACKGROUND_CANCELLED"}
CHILD_TERMINAL_CODES = {"VERSION_CONFLICT", "PREVIEW_HASH_MISMATCH", "CSV_BACKGROUND_EVIDENCE_INVALID", "CSV_BACKGROUND_EXPIRED",
                        "CSV_BACKGROUND_CANCELLED", "CSV_FILE_ALREADY_CONFIRMED", "IMPORT_HAS_ERRORS", "CSV_REVIEW_HASH_MISMATCH",
                        "CSV_IMPORT_CONTEXT_CHANGED", "CSV_IMPORT_METHOD_CHANGED", "CSV_REVIEW_INVALID", "CSV_REVIEW_CONFLICT",
                        "CSV_REVIEW_ROWS_MISMATCH", "CSV_REVIEW_LINK_NOT_EXACT", "CSV_ROW_REQUIRES_LINK", "CSV_SOURCE_LINK_CONFLICT"}
CSV_TERMINAL_CODES |= CHILD_TERMINAL_CODES
DEPLOYED_PUBLISHER = Path("/app/worker-bridge/csv-background.mjs")
LOCAL_PUBLISHER = Path(__file__).resolve().parents[2] / "web/dist/csv-background.mjs"
RESULT_KEYS = {"schema_version", "request_id", "operation", "input_hash", "batch_id", "preview_hash",
               "expected_revision", "batch_status", "row_count", "error_count", "review_hash",
               "required_review_count", "confirmed_revision", "receipts_hash"}
TIMING_PREFIX = "CSV_TRANSACTION_TIMING "
TIMING_KEYS = {"schema_version", "outcome", "transaction_call_us", "begin_to_callback_us", "callback_us", "finalize_tail_us"}
CHILD_ERROR_PATTERN = r"(?:CSV|IMPORT)_[A-Z0-9_]{1,100}|VERSION_CONFLICT|PREVIEW_HASH_MISMATCH|STALE_OR_EXPIRED_LEASE|WORKBENCH_READ_ONLY|RESTORE_PENDING_REVIEW"


def _require(condition):
    if not condition:
        raise WorkbenchError("CSV_BACKGROUND_EVIDENCE_INVALID")


def _same(left, right):
    return canonical_json(left) == canonical_json(right)


def _utc(value):
    _require(isinstance(value, str) and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z", value))
    return instant(value)


def _trim(value):
    return value.strip("\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")


def _json(raw, maximum=5 * 1024 * 1024):
    _require(isinstance(raw, str) and 0 < len(raw.encode("utf-8")) <= maximum)
    def pairs(items):
        result = {}
        for key, value in items:
            _require(key not in result)
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=pairs)
    def check(item, depth=0):
        _require(depth <= 64)
        if isinstance(item, str):
            item.encode("utf-8")
        elif isinstance(item, (int, float)) and not isinstance(item, bool):
            _require(math.isfinite(item) and abs(item) <= 9007199254740991)
        elif isinstance(item, dict):
            for key, child in item.items():
                key.encode("utf-8")
                check(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                check(child, depth + 1)
    check(value)
    return value


def _id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", value) is not None


def _digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def _integer(value, maximum=9007199254740991):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= maximum and int(value) == value


def csv_request_binding(connection, command):
    """Authenticate durable human delegation, without reading auth.sqlite or live sessions."""
    try:
        row = connection.execute("SELECT * FROM csv_background_requests WHERE command_request_id=?", (command["id"],)).fetchone()
        _require(row is not None)
        row = dict(row)
        _require(all(_id(row[key]) for key in ("id", "portfolio_id", "account_id", "idempotency_key", "command_request_id", "approval_audit_id")))
        _require(re.fullmatch(r"[\x21-\x7e]{1,160}", row["actor_id"]) is not None and not re.match(r"system(?::|$)", row["actor_id"], re.I))
        _require(_digest(row["session_hash"]) and _digest(row["input_hash"]) and _integer(row["expected_revision"]))
        _require(stamp(row["created_at"]) == row["created_at"] and stamp(instant(row["created_at"]) + timedelta(seconds=900)) == row["expires_at"])
        _require(connection.execute("SELECT 1 FROM accounts WHERE id=? AND portfolio_id=?", (row["account_id"], row["portfolio_id"])).fetchone())
        data = _json(row["input_json"], 1572864)
        _require(canonical_json(data) == row["input_json"] and content_hash({key: row[key] for key in ("operation", "portfolio_id", "account_id", "expected_revision")} | {"input": data}) == row["input_hash"])
        confirmation = None
        if row["operation"] == "preview":
            _require(set(data) == {"filename", "mapping", "csv_sha256"} and _digest(data["csv_sha256"]))
            _require(isinstance(data["filename"], str) and 1 <= len(data["filename"].encode("utf-16-le")) // 2 <= 200 and not re.search(r"[\x00-\x1f\x7f]", data["filename"]))
            _require(isinstance(row["csv_bytes"], bytes) and 0 < len(row["csv_bytes"]) <= 4 * 1024 * 1024 and sha256(row["csv_bytes"]).hexdigest() == data["csv_sha256"])
            _json(data["mapping"], 256 * 1024)
            _require(row["confirmation_attempt_id"] is None and row["batch_id"] is None)
        else:
            _require(row["operation"] == "confirm" and set(data) == {"payload_hash"} and _digest(data["payload_hash"]) and row["csv_bytes"] is None)
            _require(_id(row["confirmation_attempt_id"]) and _id(row["batch_id"]))
            attempt = connection.execute("SELECT * FROM csv_confirmation_attempts WHERE id=?", (row["confirmation_attempt_id"],)).fetchone()
            _require(attempt and all(attempt[key] == row[key] for key in ("actor_id", "session_hash", "portfolio_id", "account_id", "batch_id", "expected_revision")))
            _require(attempt["payload_hash"] == data["payload_hash"] == sha256(attempt["payload_text"].encode()).hexdigest() and _utc(attempt["created_at"]) <= _utc(row["created_at"]))
            confirmation = _json(attempt["payload_text"].removeprefix("\ufeff"))
            _require(set(confirmation) in ({"action", "portfolio_id", "batch_id", "preview_hash", "expected_revision"}, {"action", "portfolio_id", "batch_id", "preview_hash", "expected_revision", "csv_review"}))
            _require(confirmation["action"] == "confirm_import" and _integer(confirmation["expected_revision"]) and _digest(confirmation["preview_hash"])
                     and all(confirmation[key] == row[key] for key in ("portfolio_id", "batch_id", "expected_revision")) and confirmation["preview_hash"] == attempt["preview_hash"])
            batch = connection.execute("SELECT * FROM import_batches WHERE id=?", (row["batch_id"],)).fetchone()
            _require(batch and all(batch[key] == row[key] for key in ("portfolio_id", "account_id", "expected_revision")) and batch["parser_version"] == "csv-v1" and batch["preview_hash"] == confirmation["preview_hash"])
        payload = {"schema_version": "csv-background-command-v1", "request_id": row["id"], "input_hash": row["input_hash"]}
        _require(command["id"] == row["id"] == row["command_request_id"] == command["idempotency_key"] and command["actor_id"] == "system:csv-background"
                 and command["command_type"] == "csv_import_" + row["operation"] + "_v1" and command["portfolio_id"] == row["portfolio_id"]
                 and command["created_at"] == row["created_at"] and command["payload_json"] == canonical_json(payload) and command["payload_hash"] == content_hash(payload))
        audit = connection.execute("SELECT * FROM audit_events WHERE id=?", (row["approval_audit_id"],)).fetchone()
        _require(audit and all(audit[key] == row[key] for key in ("actor_id", "portfolio_id", "created_at")) and audit["ledger_revision"] == row["expected_revision"]
                 and audit["action"] == "request_csv_background" and audit["object_type"] == "csv_background_request" and audit["object_id"] == row["id"])
        approval = {"actor_kind": "human", "input": {key: row[key] for key in ("portfolio_id", "account_id", "operation", "idempotency_key", "expected_revision", "input_hash", "session_hash")}
                    | {"acknowledge_background_execution": True}, "result": {"request_id": row["id"], "operation": row["operation"], "input_hash": row["input_hash"], "status": "queued"}}
        _require(canonical_json(_json(audit["payload_json"])) == canonical_json(approval))
        return {"row": row, "input": data, "confirmation": confirmation}
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, RecursionError):
        raise WorkbenchError("CSV_BACKGROUND_EVIDENCE_INVALID") from None


def _job_binding(connection, job):
    command = connection.execute("SELECT * FROM command_requests WHERE id=?", (job["command_request_id"],)).fetchone()
    _require(command is not None)
    binding = csv_request_binding(connection, command)
    row = binding["row"]
    _require(job["job_type"] == command["command_type"] and job["scope"] == row["portfolio_id"] and job["period"] == row["created_at"][:10]
             and job["input_version"] == row["id"] + ":" + command["payload_hash"] and job["max_attempts"] == 3 and _utc(job["created_at"]) >= _utc(row["created_at"]))
    return binding


def _active(connection, lease, now):
    assert_writable(connection)
    job = assert_lease(connection, lease, now)
    binding = _job_binding(connection, job)
    row = binding["row"]
    if not instant(row["created_at"]) <= instant(now) < instant(row["expires_at"]):
        raise WorkbenchError("CSV_BACKGROUND_EXPIRED")
    if connection.execute("SELECT 1 FROM csv_background_cancellations WHERE request_id=?", (row["id"],)).fetchone():
        raise WorkbenchError("CSV_BACKGROUND_CANCELLED")
    attempt = connection.execute("SELECT * FROM job_attempts WHERE job_id=? AND attempt=?", (lease.job_id, lease.attempt)).fetchone()
    _require(attempt and attempt["fencing_token"] == lease.fencing_token and attempt["status"] == "running" and _utc(row["created_at"]) <= _utc(attempt["started_at"]) <= _utc(now))
    return binding | {"job": job}


def _attachment(connection, request, identity, media):
    row = connection.execute("SELECT * FROM attachments WHERE id=?", (identity,)).fetchone()
    _require(row and _digest(row["content_hash"]) and _integer(row["byte_size"], 4 * 1024 * 1024) and row["media_type"] == media)
    suffix = "csv" if media == "text/csv" else "json"
    _require(row["storage_key"] == "attachments/" + row["content_hash"] + "." + suffix)
    audits = connection.execute("SELECT payload_json FROM audit_events WHERE action='store_attachment' AND object_type='attachment' AND object_id=? AND portfolio_id=?", (identity, request["portfolio_id"])).fetchall()
    evidence = {"account_id": request["account_id"], "content_hash": row["content_hash"], "byte_size": row["byte_size"], "media_type": media, "storage_key": row["storage_key"]}
    _require(any(_same(_json(a["payload_json"]), evidence) for a in audits))
    root = Path(os.environ.get("WORKBENCH_DATA_DIR", ""))
    _require(root.is_absolute() and root.is_dir() and not root.is_symlink())
    directory = root.resolve() / "attachments"
    before = directory.lstat()
    _require(stat.S_ISDIR(before.st_mode) and stat.S_IMODE(before.st_mode) == 0o700 and not directory.is_symlink())
    fd = os.open(directory / (row["content_hash"] + "." + suffix), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        _require(stat.S_ISREG(metadata.st_mode) and metadata.st_size == row["byte_size"] and stat.S_IMODE(metadata.st_mode) == 0o600)
        with os.fdopen(fd, "rb", closefd=False) as stream:
            body = stream.read(row["byte_size"] + 1)
        _require(len(body) == row["byte_size"] and sha256(body).hexdigest() == row["content_hash"])
        after = directory.lstat()
        _require(before.st_dev == after.st_dev and before.st_ino == after.st_ino and not directory.is_symlink())
        body.decode("utf-8")
        return body
    finally:
        os.close(fd)


def _batch_evidence(connection, request, result):
    batch = connection.execute("SELECT * FROM import_batches WHERE id=?", (result["batch_id"],)).fetchone()
    _require(batch and all(batch[key] == request[key] for key in ("portfolio_id", "account_id", "expected_revision")) and batch["parser_version"] == "csv-v1" and batch["preview_hash"] == result["preview_hash"])
    record = connection.execute("SELECT * FROM csv_import_manifests WHERE batch_id=?", (batch["id"],)).fetchone()
    _require(record)
    manifest = _json(record["manifest_json"], 128 * 1024 * 1024)
    _require(manifest["schema_version"] == "csv-ledger-preview-v1" and content_hash(manifest) == record["content_hash"])
    mapping = connection.execute("SELECT * FROM csv_mapping_versions WHERE id=?", (manifest["mapping_version_id"],)).fetchone()
    _require(mapping and mapping["id"] == record["mapping_version_id"] == batch["mapping_version"] and all(mapping[key] == request[key] for key in ("portfolio_id", "account_id"))
             and mapping["mapping_key"] == manifest["mapping_id"] and mapping["version"] == manifest["mapping_version"] and mapping["content_hash"] == manifest["mapping_hash"])
    rows = []
    for row in connection.execute("SELECT * FROM import_rows WHERE batch_id=? ORDER BY row_number LIMIT 10001", (batch["id"],)):
        raw = _json(row["raw_json"])
        rows.append({"row": row["row_number"], "source": raw["source"], "outcome": raw["outcome"], "command": _json(row["normalized_json"]) if row["normalized_json"] else None, "errors": _json(row["errors_json"])})
    _require(len(rows) <= 10000 and len(rows) == batch["row_count"] == result["row_count"] and batch["error_count"] == result["error_count"]
             and content_hash(rows) == manifest["rows_hash"] and content_hash(manifest["context"]) == manifest["context_hash"]
             and content_hash(manifest["candidates"]) == manifest["review_hash"] == result["review_hash"] and len(manifest["required_review_rows"]) == result["required_review_count"])
    _require(content_hash({"schema_version": "csv-ledger-preview-v1", "portfolio_id": request["portfolio_id"], "account_id": request["account_id"], "expected_revision": request["expected_revision"], "manifest_hash": content_hash(manifest)}) == batch["preview_hash"])
    csv = _attachment(connection, request, batch["attachment_id"], "text/csv")
    _require(manifest["attachment_id"] == batch["attachment_id"] and manifest["content_hash"] == batch["content_hash"] == sha256(csv).hexdigest())
    pinned = _json(_attachment(connection, request, mapping["attachment_id"], "application/json").decode())
    uploaded = _json(_attachment(connection, request, manifest["mapping_attachment_id"], "application/json").decode())
    _require(content_hash(pinned) == content_hash(uploaded) == manifest["mapping_hash"] and canonical_json(pinned) == mapping["definition_json"])
    return batch, manifest, rows


def _economic(command):
    fact = dict(command["fact"])
    for key in ("amount", "quantity", "price", "consideration", "cost_amount", "fee", "tax", "gross_amount", "received_amount", "split_numerator", "split_denominator", "market_value"):
        if key in fact:
            _require(isinstance(fact[key], str) and re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", fact[key]))
            _require(len(fact[key].replace("-", "").replace(".", "").lstrip("0")) <= 38 and (len(fact[key].split(".")[1]) if "." in fact[key] else 0) <= 18)
            value = format(Decimal(fact[key]), "f")
            fact[key] = value.rstrip("0").rstrip(".") if "." in value else value
            if fact[key] == "-0":
                fact[key] = "0"
    if fact["type"] in ("buy", "sell", "fx", "transfer_out"):
        fact.setdefault("fee", "0")
    if fact["type"] in ("dividend", "dividend_accrual"):
        fact.setdefault("tax_status", "confirmed" if "tax" in fact else "unknown")
    if fact.get("value_evidence", {}).get("time_precision") == "second":
        evidence = {key: value for key, value in fact["value_evidence"].items() if key != "source_timezone"}
        evidence["effective_at"] = instant(evidence["effective_at"]).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        fact["value_evidence"] = evidence
    result = {key: command[key] for key in ("portfolio_id", "effective_at", "time_precision")}
    if command["time_precision"] == "second":
        result["effective_at"] = instant(command["effective_at"]).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    else:
        result["source_timezone"] = command["source_timezone"]
    return content_hash(result | {"fact": fact})


def _confirmed(connection, request, result, batch, manifest, rows, confirmation):
    _require(result["batch_id"] == request["batch_id"] and result["batch_status"] == batch["status"] == "confirmed")
    audits = connection.execute("SELECT * FROM audit_events WHERE action='confirm_import' AND object_id=? AND portfolio_id=?", (batch["id"], request["portfolio_id"])).fetchall()
    _require(len(audits) == 1)
    old = _json(audits[0]["payload_json"], 32 * 1024 * 1024)
    head = connection.execute("SELECT revision FROM ledger_heads WHERE portfolio_id=?", (request["portfolio_id"],)).fetchone()
    _require(head and _integer(head["revision"]) and _integer(old["revision"]) and old["revision"] <= head["revision"])
    review = confirmation.get("csv_review")
    _require(isinstance(review, dict) and set(review) == {"acknowledge_unverified_mapping", "review_hash", "rows"} and review["acknowledge_unverified_mapping"] is True)
    _require(review["review_hash"] == manifest["review_hash"] and isinstance(review["rows"], list) and len(review["rows"]) <= 10000)
    required = manifest["required_review_rows"]
    candidates = {row["row"]: row for row in manifest["candidates"]}
    _require(len(set(required)) == len(required) and len(candidates) == len(manifest["candidates"])
             and all(_integer(row) and row > 0 and row in candidates for row in required))
    resolutions = {}
    for resolution in review["rows"]:
        _require(isinstance(resolution, dict) and _integer(resolution.get("row")) and resolution["row"] > 0
                 and resolution["row"] in required and resolution["row"] not in resolutions and isinstance(resolution.get("reason"), str)
                 and _trim(resolution["reason"]) and 1 <= len(resolution["reason"].encode("utf-16-le")) // 2 <= 2000)
        fields = {"row", "action", "reason"}
        if resolution["action"] == "link_existing":
            fields.add("event_id")
            _require(isinstance(resolution.get("event_id"), str) and 1 <= len(resolution["event_id"].encode("utf-16-le")) // 2 <= 160
                     and resolution["event_id"] in candidates[resolution["row"]]["exact_event_ids"])
        elif resolution["action"] == "link_prior_row":
            fields.add("prior_row")
            _require(_integer(resolution.get("prior_row")) and 0 < resolution["prior_row"] < resolution["row"]
                     and resolution["prior_row"] in candidates[resolution["row"]]["exact_prior_rows"])
        else:
            _require(resolution["action"] == "record_distinct")
        _require(set(resolution) == fields)
        resolutions[resolution["row"]] = resolution
    _require(len(resolutions) == len(required))
    review = review | {"rows": sorted(review["rows"], key=lambda row: row["row"])}
    _require(content_hash(review) == old["csv_review_hash"] == content_hash(old["csv_review"]) and old["manifest_hash"] == content_hash(manifest)
             and _integer(old["revision"]) and old["revision"] == result["confirmed_revision"] == batch["confirmed_revision"] == audits[0]["ledger_revision"] and old["revision"] >= request["expected_revision"]
             and content_hash(old["receipts"]) == result["receipts_hash"] and len(old["receipts"]) == len(rows))
    outcomes = connection.execute("SELECT * FROM csv_import_outcomes WHERE batch_id=? ORDER BY row_number LIMIT 10001", (batch["id"],)).fetchall()
    _require(len(outcomes) == len(rows))
    for row, outcome, receipt in zip(rows, outcomes, old["receipts"]):
        stored = _json(outcome["result_json"])
        _require(set(stored) == {"receipt", "resolution"} and _same(stored["receipt"], receipt) and _same(stored["resolution"], resolutions.get(row["row"])) and outcome["row_number"] == row["row"])
        _require(set(receipt) in ({"event_id", "revision", "audit_id", "warnings"}, {"event_id", "revision", "audit_id", "warnings", "duplicate"}) and _id(receipt["event_id"]) and _id(receipt["audit_id"]) and _integer(receipt["revision"])
                 and isinstance(receipt["warnings"], list) and len(receipt["warnings"]) <= 16 and all(isinstance(warning, str) and len(warning) <= 128 for warning in receipt["warnings"])
                 and ("duplicate" not in receipt or type(receipt["duplicate"]) is bool) and outcome["duplicate"] == int(receipt.get("duplicate", False)) and outcome["event_id"] == receipt["event_id"])
        event = connection.execute("SELECT * FROM ledger_events WHERE id=?", (receipt["event_id"],)).fetchone()
        audit = connection.execute("SELECT * FROM audit_events WHERE id=?", (receipt["audit_id"],)).fetchone()
        _require(event and audit and all(event[key] == request[key] for key in ("portfolio_id", "account_id")) and event["ledger_revision"] == receipt["revision"] <= result["confirmed_revision"]
                 and audit["portfolio_id"] == request["portfolio_id"] and _economic(_json(event["payload_json"])) == _economic(row["command"]))
        _require((audit["action"] == "record_fact" and audit["object_id"] == event["id"]) or (audit["action"] == "link_csv_row" and _json(audit["payload_json"])["event_id"] == event["id"]))


def committed_csv_job(connection, lease):
    """Independent read-only binding, raw attachment and actual ledger receipt checks."""
    job = connection.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()
    if job is None or job["status"] != "succeeded":
        return None
    try:
        _require(job["job_type"] in CSV_COMMANDS and job["fencing_token"] == lease.fencing_token and job["attempt_count"] == lease.attempt and job["lease_owner"] is None and job["lease_until"] is None)
        binding = _job_binding(connection, job)
        request = binding["row"]
        record = connection.execute("SELECT * FROM csv_background_results WHERE request_id=?", (request["id"],)).fetchone()
        _require(record and record["job_id"] == job["id"])
        result = _json(record["result_json"], 65536)
        _require(set(result) == RESULT_KEYS and result["schema_version"] == "csv-background-result-v1" and result["request_id"] == request["id"] and _integer(result["expected_revision"]) and all(result[key] == request[key] for key in ("operation", "input_hash", "expected_revision"))
                 and result["batch_id"] == record["batch_id"] and _id(result["batch_id"]) and _digest(result["preview_hash"]) and _digest(result["review_hash"])
                 and _integer(result["row_count"], 10000) and _integer(result["error_count"], 10001) and _integer(result["required_review_count"], 10000)
                 and canonical_json(result) == record["result_json"] and content_hash(result) == record["result_hash"])
        envelope = {"schema_version": "csv-background-job-result-v1", "request_id": request["id"], "operation": request["operation"], "batch_id": result["batch_id"], "result_hash": record["result_hash"]}
        attempt = connection.execute("SELECT * FROM job_attempts WHERE id=?", (record["job_attempt_id"],)).fetchone()
        _require(attempt and attempt["job_id"] == job["id"] and attempt["attempt"] == lease.attempt and attempt["fencing_token"] == lease.fencing_token and attempt["status"] == "succeeded"
                 and attempt["finished_at"] == job["updated_at"] == record["completed_at"] and job["result_json"] == canonical_json(envelope)
                 and stamp(record["completed_at"]) == record["completed_at"]
                 and _utc(request["created_at"]) <= _utc(attempt["started_at"]) <= _utc(record["completed_at"]) < _utc(request["expires_at"])
                 and instant(record["completed_at"]) < instant(lease.lease_until))
        _require(not connection.execute("SELECT 1 FROM csv_background_cancellations WHERE request_id=?", (request["id"],)).fetchone())
        batch, manifest, rows = _batch_evidence(connection, request, result)
        if request["operation"] == "preview":
            _require(result["batch_status"] == ("invalid" if batch["error_count"] else "preview") and result["confirmed_revision"] is None and result["receipts_hash"] is None
                     and manifest["content_hash"] == binding["input"]["csv_sha256"] and manifest["mapping_hash"] == content_hash(_json(binding["input"]["mapping"])))
            audits = connection.execute("SELECT * FROM audit_events WHERE actor_id=? AND portfolio_id=? AND object_id=? AND action IN ('preview_csv_import','repeat_csv_upload')",
                                        (request["actor_id"], request["portfolio_id"], batch["id"])).fetchall()
            found = False
            for audit in audits:
                if not _utc(attempt["started_at"]) <= _utc(audit["created_at"]) <= _utc(record["completed_at"]):
                    continue
                payload = _json(audit["payload_json"])
                if audit["action"] == "preview_csv_import":
                    found |= manifest["original_filename"] == binding["input"]["filename"] and payload.get("manifest_hash") == content_hash(manifest) and payload.get("preview_hash") == batch["preview_hash"]
                else:
                    found |= payload.get("original_filename") == binding["input"]["filename"] and payload.get("attachment_id") == manifest["attachment_id"]
            _require(found)
        else:
            _require(_integer(result["confirmed_revision"]) and _digest(result["receipts_hash"]))
            _confirmed(connection, request, result, batch, manifest, rows, binding["confirmation"])
        return dict(job)
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, RecursionError, OSError):
        raise WorkbenchError("CSV_BACKGROUND_RECEIPT_INVALID") from None


def _timing_diagnostic(raw):
    """Strict diagnostic transport only; never evidence of a financial commit."""
    try:
        if not 0 < len(raw) <= 4096:
            return None, ""
        lines = raw.decode("ascii").removesuffix("\n").split("\n")
        if not 1 <= len(lines) <= 2:
            return None, ""
        timing, code = None, ""
        for line in lines:
            if line.startswith(TIMING_PREFIX) and timing is None:
                if not raw.endswith(b"\n"):
                    return None, ""
                value = _json(line[len(TIMING_PREFIX):], 4096)
                if not isinstance(value, dict) or set(value) != TIMING_KEYS or value["schema_version"] != "csv-transaction-timing-v1" or value["outcome"] not in ("returned", "threw"):
                    return None, ""
                if type(value["transaction_call_us"]) is not int or not _integer(value["transaction_call_us"]):
                    return None, ""
                parts = [value[key] for key in ("begin_to_callback_us", "callback_us", "finalize_tail_us")]
                if all(part is None for part in parts):
                    if value["outcome"] != "threw":
                        return None, ""
                elif not all(type(part) is int and _integer(part) for part in parts) or sum(parts) != value["transaction_call_us"]:
                    return None, ""
                timing = value
            elif not code and re.fullmatch(CHILD_ERROR_PATTERN, line):
                code = line
            else:
                return None, ""
        return timing, code
    except (ValueError, TypeError, UnicodeError, RecursionError):
        return None, ""


def _report_timing(raw):
    timing, _ = _timing_diagnostic(raw)
    message = TIMING_PREFIX + canonical_json(timing) if timing is not None else "CSV_TRANSACTION_TIMING_MISSING"
    try:
        print(message, file=sys.stderr, flush=True)
    except Exception:
        pass


def _publisher_argv(lease, timing=False):
    script = DEPLOYED_PUBLISHER if DEPLOYED_PUBLISHER.is_file() else LOCAL_PUBLISHER
    node = shutil.which("node")
    if not script.is_file() or node is None:
        raise WorkbenchError("CSV_BACKGROUND_PUBLISHER_UNAVAILABLE")
    return [node, str(script), "--job-id", lease.job_id, "--lease-owner", lease.owner,
            "--fencing-token", str(lease.fencing_token), "--attempt", str(lease.attempt)] + (["--timing"] if timing else [])


def _stop(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=2)
    except ProcessLookupError:
        process.wait(timeout=2)


def publish_csv(connection, job, lease, clock=None, *, process_factory=None, monotonic=None, sleep=None,
                max_run_seconds=120, stop_requested=None):
    if connection.in_transaction:
        raise WorkbenchError("EXTERNAL_COMMIT_REQUIRES_NO_TRANSACTION")
    if job["job_type"] not in CSV_COMMANDS or job["id"] != lease.job_id:
        raise WorkbenchError("EXTERNAL_COMMIT_JOB_TYPE_INVALID")
    if isinstance(max_run_seconds, bool) or not isinstance(max_run_seconds, (int, float)) or not 0 < max_run_seconds <= 120:
        raise WorkbenchError("INVALID_EXTERNAL_BRIDGE_TIMEOUT")
    clock = (lambda: None) if clock is None else clock
    monotonic = time.monotonic if monotonic is None else monotonic
    sleep = time.sleep if sleep is None else sleep
    process_factory = subprocess.Popen if process_factory is None else process_factory
    now = stamp(clock())
    active = _active(connection, lease, now)
    if (instant(active["job"]["lease_until"]) - instant(now)).total_seconds() < 150:
        raise WorkbenchError("CSV_BACKGROUND_INSUFFICIENT_LEASE")
    if stop_requested is not None and stop_requested():
        raise WorkbenchError("CSV_BACKGROUND_INTERRUPTED")
    database = next((row[2] for row in connection.execute("PRAGMA database_list") if row[1] == "main"), None)
    if not database:
        raise WorkbenchError("EXTERNAL_COMMIT_REQUIRES_FILE_DATABASE")
    data_dir = os.environ.get("WORKBENCH_DATA_DIR")
    if not data_dir or not Path(data_dir).is_absolute():
        raise WorkbenchError("CSV_BACKGROUND_DATA_DIR_REQUIRED")
    timing = os.environ.get("WORKBENCH_CSV_TRANSACTION_TIMING") == "1"
    argv = _publisher_argv(lease, timing=timing)
    with tempfile.TemporaryDirectory(prefix="workbench-csv-worker-") as temporary:
        environment = {"PATH": str(Path(argv[0]).parent) + os.pathsep + os.defpath, "HOME": temporary,
                       "TMPDIR": temporary, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TZ": "UTC",
                       "WORKBENCH_DB_PATH": str(Path(database).resolve()), "WORKBENCH_DATA_DIR": data_dir}
        process = process_factory(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                  env=environment, cwd=temporary, shell=False, start_new_session=True)
        diagnostic = bytearray()
        stderr = getattr(process, "stderr", None)
        if stderr is not None:
            os.set_blocking(stderr.fileno(), False)
        def drain():
            if stderr is not None:
                while len(diagnostic) <= 4096:
                    try:
                        chunk = os.read(stderr.fileno(), 4097 - len(diagnostic))
                    except BlockingIOError:
                        return
                    if not chunk:
                        return
                    diagnostic.extend(chunk)
                    if len(diagnostic) > 4096:
                        raise WorkbenchError("CSV_BACKGROUND_OUTPUT_LIMIT")
        started = monotonic()
        try:
            while process.poll() is None:
                drain()
                if stop_requested is not None and stop_requested():
                    raise WorkbenchError("CSV_BACKGROUND_INTERRUPTED")
                if monotonic() - started >= max_run_seconds:
                    raise WorkbenchError("CSV_BACKGROUND_TIMEOUT")
                if committed_csv_job(connection, lease) is not None:
                    _stop(process)
                    return ExternalCommit()
                _active(connection, lease, stamp(clock()))
                sleep(0.2)
            drain()
            if committed_csv_job(connection, lease) is None:
                if timing:
                    _, code = _timing_diagnostic(diagnostic)
                else:
                    try:
                        code = diagnostic.decode("ascii").removesuffix("\n")
                    except UnicodeDecodeError:
                        code = ""
                if re.fullmatch(CHILD_ERROR_PATTERN, code):
                    raise WorkbenchError(code)
                raise WorkbenchError("CSV_BACKGROUND_DID_NOT_COMMIT")
            return ExternalCommit()
        except BaseException:
            _stop(process)
            if committed_csv_job(connection, lease) is not None:
                return ExternalCommit()
            raise
        finally:
            if timing:
                try:
                    drain()
                except Exception:
                    diagnostic.clear()
                _report_timing(diagnostic)
            if stderr is not None:
                stderr.close()
