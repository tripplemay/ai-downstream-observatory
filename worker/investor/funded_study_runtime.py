"""Durable private comparisons; unverified economics never become published advice."""

import math
import re

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job, heartbeat
from .funded_history import calculate_funded_history, prepare_funded_history
from .funded_study_input import prepare_funded_study_inputs
from .funding_plan import funding_timeline
from .implementation import implementation_hash
from .runtime import _json, _milliseconds
from .source_inputs import latest_input, resolve_evidence_input


JOB_TYPE = "investor_funded_study"
CONTRACT = "investor-funded-study.schema.json"
DENIALS = {"economics_independently_replayed": False, "parameters_independently_preregistered": False,
           "actual_arrivals_confirmed": False, "execution_authorized": False, "live_advice_eligible": False}


def _check(value):
    if not value:
        raise WorkbenchError("INVESTOR_FUNDED_STUDY_BINDING_INVALID")


def sync_funded_study_requests(db, *, limit=100, now=None):
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise WorkbenchError("INVESTOR_FUNDED_STUDY_DISCOVERY_LIMIT")
    rows = db.execute("""SELECT r.* FROM investor_funded_study_requests r LEFT JOIN job_runs j
        ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.input_version
        WHERE j.id IS NULL ORDER BY r.created_at,r.rowid LIMIT ?""", (JOB_TYPE, limit)).fetchall()
    return [enqueue_job(db, JOB_TYPE, row["workspace_id"], row["id"], row["input_version"], max_attempts=2, now=now) for row in rows]


def _audit(db, audit_id, owner, workspace, action, created):
    event = db.execute("SELECT * FROM audit_events WHERE id=?", (audit_id,)).fetchone()
    _check(event is not None and event["actor_id"] == owner and event["action"] == "investor_" + action
           and event["object_type"] == "investor_workspace" and event["object_id"] == workspace
           and event["portfolio_id"] is None and event["ledger_revision"] is None and event["created_at"] == created)
    value = _json(event["payload_json"])
    _check(set(value) == {"input", "result"})
    return value


def _binding(db, job, now, *, header_only=False):
    row = db.execute("SELECT * FROM investor_funded_study_requests WHERE id=? AND workspace_id=?", (job["period"], job["scope"])).fetchone()
    _check(row is not None and job["job_type"] == JOB_TYPE and job["command_request_id"] is None and job["input_version"] == row["input_version"])
    request = _json(row["document_json"])
    validate_contract(request, CONTRACT)
    _check(content_hash(request) == row["input_version"] and request["workspace_id"] == row["workspace_id"]
           and request["profile_id"] == row["profile_id"] and request["funding_plan_id"] == row["funding_plan_id"]
           and request["evidence_input_id"] == row["evidence_input_id"] and request["comparison_declared_at"] == row["created_at"] <= now)
    workspace = db.execute("SELECT * FROM investor_workspaces WHERE id=?", (row["workspace_id"],)).fetchone()
    _check(workspace is not None and workspace["owner_id"] == row["actor_id"])
    audit = _audit(db, row["audit_id"], row["actor_id"], row["workspace_id"], "compare_funding", row["created_at"])
    command = audit["input"]
    _check(set(command) == {"action", "expected_revision", "idempotency_key"} and command["action"] == "compare_funding"
           and type(command["expected_revision"]) is int and 0 <= command["expected_revision"] < workspace["revision"]
           and isinstance(command["idempotency_key"], str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", command["idempotency_key"])
           and audit["result"] == {"request_id": row["id"], "input_version": row["input_version"], "execution_authorized": False})
    profile = db.execute("SELECT * FROM investor_profiles WHERE id=? AND workspace_id=?", (row["profile_id"], row["workspace_id"])).fetchone()
    funding = db.execute("SELECT * FROM investor_funding_plans WHERE id=? AND workspace_id=?", (row["funding_plan_id"], row["workspace_id"])).fetchone()
    _check(profile is not None and funding is not None and profile["created_at"] <= row["created_at"] and funding["created_at"] <= row["created_at"])
    preferences, plan = _json(profile["document_json"]), _json(funding["document_json"])
    validate_contract(preferences, "investor-profile.schema.json")
    funding_timeline(plan)
    _check(content_hash(preferences) == profile["content_hash"] == request["profile_hash"] == funding["profile_hash"]
           and funding["profile_id"] == profile["id"] and content_hash(plan) == funding["content_hash"] == request["funding_plan_hash"]
           and plan["horizon_years"] <= preferences["horizon_years"] and funding["actor_id"] == workspace["owner_id"])
    saved = _audit(db, funding["audit_id"], workspace["owner_id"], workspace["id"], "save_funding_plan", funding["created_at"])
    _check(set(saved["input"]) == {"action", "expected_revision", "idempotency_key", "funding_plan"}
           and saved["input"]["action"] == "save_funding_plan" and saved["input"]["funding_plan"] == plan
           and type(saved["input"]["expected_revision"]) is int and 0 <= saved["input"]["expected_revision"] < workspace["revision"]
           and saved["result"] == {"funding_plan_id": funding["id"], "version": funding["version"], "profile_id": profile["id"],
               "profile_hash": profile["content_hash"], "actual_arrivals_confirmed": False, "execution_authorized": False})
    current_profile = db.execute("SELECT id FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1", (workspace["id"],)).fetchone()
    current_funding = db.execute("SELECT id FROM investor_funding_plans WHERE workspace_id=? ORDER BY version DESC LIMIT 1", (workspace["id"],)).fetchone()
    head = latest_input(db, workspace["id"])
    current = current_profile["id"] == row["profile_id"] and current_funding["id"] == row["funding_plan_id"] \
        and (head["id"] if head else None) == request["source_head_id"] and (head["content_hash"] if head else None) == request["input_hash"]
    prepared = None
    if request["evidence_input_id"] is not None:
        _check(request["source_head_id"] == request["evidence_input_id"])
        source = resolve_evidence_input(db, workspace["id"], request["evidence_input_id"], now=now, header_only=header_only, allow_unavailable=True)
        _check(source["row"]["content_hash"] == request["input_hash"] and source["row"]["created_at"] <= row["created_at"])
        if source.get("unavailable_reason"):
            current = False
        elif not header_only:
            snapshot = source["document"]["snapshot"]
            prepared = prepare_funded_study_inputs(plan, {"created_at": source["row"]["created_at"],
                "range_start": snapshot["range_start"], "range_end": snapshot["range_end"], "payload": source["payload"]}, row["created_at"], preferences)
            _check(all(prepared[key] == request[key] for key in ("historical_start_date", "candidate_hashes", "reason_codes")))
    else:
        _check(request["historical_start_date"] is None and request["candidate_hashes"] == []
               and request["reason_codes"] == ["FUNDED_STUDY_REVIEWED_SOURCE_REQUIRED"])
    return row, request, prepared, current


def prepare_funded_study_job(db, job, lease, *, clock=None, stop_requested=None):
    clock = (lambda: None) if clock is None else clock
    now = lambda: _milliseconds(clock())
    row, request, prepared, current = _binding(db, job, now())
    if not current:
        return {"result": {"code": "FUNDED_STUDY_BINDING_CHANGED", "live_advice_eligible": False}, "outcome": "skipped"}
    implementation = implementation_hash()
    duration = math.ceil((instant(job["lease_until"]) - instant(job["heartbeat_at"])).total_seconds())
    _check(1 <= duration <= 3600)
    last = instant(now())

    def pulse(force=False):
        nonlocal lease, last
        at = now()
        if stop_requested and stop_requested():
            raise WorkbenchError("WORKER_STOP_REQUESTED")
        if instant(at) < last:
            raise WorkbenchError("INVESTOR_FUNDED_STUDY_CLOCK_REGRESSION")
        if not force and (instant(at) - last).total_seconds() < min(10, duration / 3):
            return
        with transaction(db):
            assert_lease(db, lease, at)
            _, _, _, still_current = _binding(db, job, at, header_only=True)
            if not still_current:
                raise WorkbenchError("INVESTOR_FUNDED_STUDY_SUPERSEDED")
            lease = heartbeat(db, lease, duration, now=at)
        last = instant(at)

    pulse(True)
    candidates, retained = [], {}
    for document in (prepared["inputs"] if prepared else []):
        pulse(True)
        projection, _ = prepare_funded_history(document)
        candidate = {"parameters_hash": content_hash(document["context"]["parameters"]), "input_hash": content_hash(document),
                     "projection_hash": content_hash(projection), "result_hash": None, "status": "failed", "reason_code": "FUNDED_STUDY_CANDIDATE_FAILED"}
        try:
            result = calculate_funded_history(document, progress=pulse)
            candidate.update(result_hash=result["result_hash"])
            retained[candidate["parameters_hash"]] = canonical_json(result).encode("utf-8")
            if result["comparison"]["status"] == "computed":
                candidate.update(status="calculated_unverified", reason_code=None)
            else:
                candidate["reason_code"] = "FUNDED_STUDY_EXECUTION_GAPS"
        except (ValueError, ArithmeticError) as error:
            code = str(error)
            if code.startswith(("WORKER_", "STALE_", "INVESTOR_FUNDED_STUDY_")):
                raise
            candidate["reason_code"] = code if re.fullmatch(r"(?:INVESTOR|INVALID_RESEARCH|CONTRACT)_[A-Z_]{1,55}", code) else "FUNDED_STUDY_CANDIDATE_FAILED"
        candidates.append(candidate)
    failed = any(value["status"] == "failed" for value in candidates)
    status = "blocked" if request["reason_codes"] else "failed" if failed else "calculated_unverified"
    reasons = request["reason_codes"] or ["FUNDED_STUDY_CANDIDATE_FAILED" if failed else "FUNDED_STUDY_ECONOMIC_REPLAY_REQUIRED"]

    def commit(connection):
        at = now()
        _, rebound, _, still_current = _binding(connection, job, at, header_only=True)
        if not still_current or implementation_hash() != implementation or rebound != request:
            return JobCommit({"code": "FUNDED_STUDY_BINDING_CHANGED", "live_advice_eligible": False}, "skipped")
        assert_lease(connection, lease, at)
        run_id = new_id("funded-study-run")
        run = {"schema_version": "investor-funded-study-run-v1", "request_id": row["id"], "input_version": row["input_version"],
               "implementation_hash": implementation, "created_at": at, "status": status, "reason_codes": reasons, "candidates": candidates, **DENIALS}
        validate_contract(run, CONTRACT, fragment="$defs/run")
        connection.execute("INSERT INTO investor_funded_study_runs(id,request_id,workspace_id,job_id,status,document_json,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?)",
            (run_id, row["id"], row["workspace_id"], job["id"], status, canonical_json(run), content_hash(run), at))
        if retained:
            source = resolve_evidence_input(connection, row["workspace_id"], request["evidence_input_id"], now=at, header_only=True)
            expiry = source["document"]["valid_until"]
            for candidate in candidates:
                if candidate["parameters_hash"] not in retained:
                    continue
                connection.execute("INSERT INTO investor_funded_result_headers VALUES(?,?,?,?,?,?,?)",
                    (run_id, candidate["parameters_hash"], row["workspace_id"], candidate["input_hash"], candidate["result_hash"], at, expiry))
                connection.execute("INSERT INTO investor_funded_result_payloads VALUES(?,?,?)",
                    (run_id, candidate["parameters_hash"], retained[candidate["parameters_hash"]]))
        connection.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (row["workspace_id"],))
        return JobCommit({"request_id": row["id"], "status": status, "economics_independently_replayed": False, "live_advice_eligible": False})
    return {"effect": commit}
