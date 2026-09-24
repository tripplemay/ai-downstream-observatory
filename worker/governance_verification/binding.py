"""Internal task authority requires an immutable human request and exact context."""

import re

from worker.orchestration.db import WorkbenchError, content_hash, instant
from .checker import CHECK_ID, strict_json
from .source import verify_context


COMMAND = "governance_verification_v2"
ACTOR = "system:governance-verifier-v2"


def request_binding(connection, command, *, verify_source=True):
    try:
        request = connection.execute("SELECT * FROM verification_requests WHERE id=?", (command["id"],)).fetchone()
        if request is None:
            raise ValueError("request")
        request = dict(request)
        payload = strict_json(command["payload_json"])
        expected = {"schema_version": "verification-request-v2", "verification_request_id": request["id"],
                    "portfolio_id": request["portfolio_id"], "check_id": CHECK_ID, "context_hash": request["context_hash"]}
        if (command["command_type"] != COMMAND or command["actor_id"] != ACTOR or payload != expected
                or content_hash(payload) != command["payload_hash"] or command["portfolio_id"] != request["portfolio_id"]
                or command["created_at"] != request["requested_at"] or request["check_id"] != CHECK_ID
                or not isinstance(request["requested_by"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", request["requested_by"])
                or re.match(r"system(?::|$)", request["requested_by"], re.IGNORECASE)):
            raise ValueError("command")
        context = strict_json(request["context_json"])
        verify_context(context, request["portfolio_id"], request["check_id"], request["context_hash"], verify_source=verify_source)
        audit = connection.execute("SELECT * FROM audit_events WHERE id=?", (request["audit_id"],)).fetchone()
        if (audit is None or audit["action"] != "request_verification" or audit["object_type"] != "verification_request"
                or audit["object_id"] != request["id"] or audit["portfolio_id"] != request["portfolio_id"]
                or audit["actor_id"] != request["requested_by"] or audit["created_at"] != request["requested_at"]
                or audit["ledger_revision"] is not None):
            raise ValueError("audit")
        proof = strict_json(audit["payload_json"])
        if (not isinstance(proof, dict) or set(proof) != {"actor_kind", "input", "result"} or proof["actor_kind"] != "human"
                or set(proof["input"]) != {"portfolio_id", "check_id", "expected_context_hash", "reason", "idempotency_key"}
                or proof["input"]["portfolio_id"] != request["portfolio_id"] or proof["input"]["check_id"] != CHECK_ID
                or proof["input"]["expected_context_hash"] != request["context_hash"]
                or proof["input"]["idempotency_key"] != command["idempotency_key"]
                or not isinstance(proof["input"]["reason"], str) or not 1 <= len(proof["input"]["reason"].strip()) <= 1000
                or proof["input"]["reason"] != proof["input"]["reason"].strip() or re.search(r"[\x00\x1c-\x1f\x85]", proof["input"]["reason"])
                or not isinstance(proof["input"]["idempotency_key"], str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", proof["input"]["idempotency_key"])
                or proof["result"] != {"request_id": request["id"], "check_id": CHECK_ID,
                                       "context_hash": request["context_hash"], "status": "queued"}):
            raise ValueError("human")
        return request, context
    except (ValueError, TypeError, KeyError, IndexError) as exc:
        raise WorkbenchError("VERIFICATION_REQUEST_INVALID") from exc


def job_binding(connection, job, lease, *, verify_source=True):
    command = connection.execute("SELECT * FROM command_requests WHERE id=?", (job["command_request_id"],)).fetchone()
    if command is None:
        raise WorkbenchError("VERIFICATION_JOB_BINDING_INVALID")
    request, context = request_binding(connection, command, verify_source=verify_source)
    attempt = connection.execute("SELECT * FROM job_attempts WHERE job_id=? AND attempt=? AND fencing_token=?",
                                 (job["id"], lease.attempt, lease.fencing_token)).fetchone()
    if (job["id"] != lease.job_id or job["job_type"] != COMMAND or job["scope"] != request["portfolio_id"]
            or job["period"] != request["requested_at"][:10] or job["input_version"] != request["id"] + ":" + command["payload_hash"]
            or job["max_attempts"] != 3 or job["attempt_count"] != lease.attempt or job["fencing_token"] != lease.fencing_token
            or job["status"] != "running" or job["lease_owner"] != lease.owner
            or attempt is None or attempt["status"] != "running" or attempt["finished_at"] is not None
            or attempt["error_json"] is not None or instant(attempt["started_at"]) < instant(request["requested_at"])):
        raise WorkbenchError("VERIFICATION_JOB_BINDING_INVALID")
    return request, context, dict(attempt)
