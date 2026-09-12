"""Dispatch explicit authenticated command requests; never synthesize trades."""

import json
import sqlite3

from worker.market import ingest_document, persist_valuation, prepare_valuation
from worker.market.contracts import validate_contract
from worker.market.collection import prepare_collection, persist_collection
from worker.performance import persist_performance, prepare_performance
from worker.research import (
    freeze_candidate, persist_trial, prepare_trial, record_review, record_trial_failure,
    register_experiment, register_trial, review_context, unseal_holdout,
)
from .db import WorkbenchError, content_hash
from .evaluations import discover_due_cycles, monthly_request_binding
from .collections import (
    COLLECTION_TERMINAL_CODES, collection_request_binding, discover_due_collections,
)
from .external import publish_monthly
from .jobs import JobCommit, enqueue_job, enqueue_notification, run_one


RESEARCH_COMMANDS = ("research_register", "research_register_trial", "research_trial", "research_freeze",
                     "research_unseal", "research_ai_context", "research_ai_review")
CORE_COMMANDS = ("market_ingest", "market_collect", "valuation", "performance", *RESEARCH_COMMANDS, "monthly_evaluation")
PRICE_COMMANDS = ("market_collect_prices",)
SUPPORTED_COMMANDS = (*CORE_COMMANDS, *PRICE_COMMANDS)


def role_commands(role):
    if role == "core":
        return CORE_COMMANDS
    if role == "longport":
        return PRICE_COMMANDS
    raise WorkbenchError("INVALID_WORKER_ROLE")


def sync_requests(connection, limit=100, now=None, command_types=None):
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1000:
        raise WorkbenchError("INVALID_DISPATCH_LIMIT")
    supported = SUPPORTED_COMMANDS if command_types is None else command_types
    if (not isinstance(supported, tuple) or not supported
            or any(value not in SUPPORTED_COMMANDS for value in supported)):
        raise WorkbenchError("INVALID_DISPATCH_COMMANDS")
    placeholders = ",".join("?" for _ in supported)
    requests = connection.execute("""SELECT c.* FROM command_requests c
        LEFT JOIN job_runs j ON j.command_request_id=c.id
        WHERE c.command_type IN (""" + placeholders + """) AND j.id IS NULL
        AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.dedup_key='monthly-request-invalid:' || c.id
          AND o.topic='monthly_evaluation.discovery_blocked'
          AND json_extract(CASE WHEN json_valid(o.payload_json) THEN o.payload_json ELSE '{}' END,'$.code')='MONTHLY_EVALUATION_REQUEST_INVALID'
          AND json_extract(CASE WHEN json_valid(o.payload_json) THEN o.payload_json ELSE '{}' END,'$.command_request_id')=c.id
          AND json_extract(CASE WHEN json_valid(o.payload_json) THEN o.payload_json ELSE '{}' END,'$.portfolio_id')=c.portfolio_id)
        AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.dedup_key='collection-request-invalid:' || c.id
          AND o.topic='collection_schedule.request_invalid'
          AND json_extract(CASE WHEN json_valid(o.payload_json) THEN o.payload_json ELSE '{}' END,'$.command_request_id')=c.id
          AND json_extract(CASE WHEN json_valid(o.payload_json) THEN o.payload_json ELSE '{}' END,'$.portfolio_id')=c.portfolio_id)
        ORDER BY c.created_at,c.id LIMIT ?""", (*supported, limit)).fetchall()
    jobs = []
    for request in requests:
        if request["command_type"] == "monthly_evaluation":
            try:
                cycle, definition = monthly_request_binding(connection, request)
            except (ValueError, TypeError, KeyError):
                diagnostic = {"command_request_id": request["id"], "portfolio_id": request["portfolio_id"],
                              "code": "MONTHLY_EVALUATION_REQUEST_INVALID"}
                enqueue_notification(connection, "monthly-request-invalid:" + request["id"],
                                     "monthly_evaluation.discovery_blocked", diagnostic, now=now)
                continue
            jobs.append(enqueue_job(connection, request["command_type"], request["portfolio_id"],
                                    cycle["period"], request["id"] + ":" + request["payload_hash"],
                                    max_attempts=definition["max_attempts"],
                                    command_request_id=request["id"], now=now))
            continue
        if request["command_type"] == "market_collect":
            try:
                binding = collection_request_binding(connection, request)
            except WorkbenchError:
                enqueue_notification(connection, "collection-request-invalid:" + request["id"],
                                     "collection_schedule.request_invalid",
                                     {"command_request_id": request["id"], "portfolio_id": request["portfolio_id"],
                                      "code": "COLLECTION_BINDING_INVALID"}, now=now)
                continue
            if binding is not None:
                jobs.append(enqueue_job(connection, request["command_type"], request["portfolio_id"],
                                        binding["slot"]["period"], request["id"] + ":" + request["payload_hash"],
                                        max_attempts=binding["definition"]["max_attempts"],
                                        command_request_id=request["id"], now=now))
                continue
        jobs.append(enqueue_job(connection, request["command_type"], request["portfolio_id"],
                                request["created_at"][:10], request["id"] + ":" + request["payload_hash"],
                                command_request_id=request["id"], now=now))
    return jobs


def _research_scope(connection, portfolio_id, payload):
    if "experiment_id" in payload:
        found = connection.execute("SELECT 1 FROM research_experiments WHERE id=? AND portfolio_id=?",
                                   (payload["experiment_id"], portfolio_id)).fetchone()
        if found is None:
            raise WorkbenchError("RESEARCH_RESOURCE_OUT_OF_SCOPE")
    if "trial_id" in payload or "validation_trial_id" in payload:
        trial_id = payload.get("trial_id", payload.get("validation_trial_id"))
        found = connection.execute("""SELECT 1 FROM research_trials t JOIN research_experiments e ON e.id=t.experiment_id
            JOIN research_runs r ON r.id=t.run_id WHERE t.id=? AND e.portfolio_id=? AND r.portfolio_id=?""",
                                   (trial_id, portfolio_id, portfolio_id)).fetchone()
        if found is None:
            raise WorkbenchError("RESEARCH_RESOURCE_OUT_OF_SCOPE")
    if "run_id" in payload:
        found = connection.execute("""SELECT 1 FROM research_runs r JOIN research_trials t ON t.run_id=r.id
            JOIN research_experiments e ON e.id=t.experiment_id
            WHERE r.id=? AND r.portfolio_id=? AND e.portfolio_id=? AND r.environment='research'""",
                                   (payload["run_id"], portfolio_id, portfolio_id)).fetchone()
        if found is None:
            raise WorkbenchError("RESEARCH_RESOURCE_OUT_OF_SCOPE")


def _research_summary(trial_id, run):
    report = json.loads(run["result_json"]) if run["result_json"] else {}
    result = {"trial_id": trial_id, "research_run_id": run["id"], "status": run["status"],
              "live_advice_eligible": False}
    if report.get("result_hash"):
        result["result_hash"] = report["result_hash"]
    if report.get("error"):
        result["error"], result["code"] = report["error"], report.get("code")
    return JobCommit(result, "succeeded" if run["status"] == "succeeded" else "skipped" if run["status"] == "cancelled" else "failed")


def _research_error(error):
    return JobCommit({"error": type(error).__name__, "code": str(error), "live_advice_eligible": False}, "failed")


def _research_command(connection, request, payload, clock, job):
    command, portfolio_id, actor_id = request["command_type"], request["portfolio_id"], request["actor_id"]
    try:
        if not isinstance(actor_id, str) or not actor_id.strip():
            raise WorkbenchError("RESEARCH_AUTHENTICATED_ACTOR_REQUIRED")
        validate_contract({"command_type": command, "payload": payload}, "research-command.schema.json")
        if command != "research_register":
            _research_scope(connection, portfolio_id, payload)
    except ValueError as error:
        failed = _research_error(error)
        return {"result": failed.result, "outcome": failed.outcome}

    if command == "research_trial":
        def defer_failure(error):
            # Capturing the exception object explicitly also survives Python's
            # exception-variable cleanup before this deferred effect executes.
            def failed_trial(db, failure=error):
                _research_scope(db, portfolio_id, payload)
                run = record_trial_failure(db, payload["trial_id"], failure, now=clock())
                return _research_summary(payload["trial_id"], run)
            return {"effect": failed_trial}
        try:
            prepared = prepare_trial(connection, payload["trial_id"])
        except (ValueError, ArithmeticError) as error:
            return defer_failure(error)
        except Exception as error:
            if job["attempt_count"] >= job["max_attempts"]:
                return defer_failure(error)
            raise
        def persist(db):
            _research_scope(db, portfolio_id, payload)
            return _research_summary(payload["trial_id"], persist_trial(db, prepared, now=clock()))
        return {"effect": persist}

    if command == "research_ai_context":
        try:
            return {"result": review_context(connection, payload["run_id"])}
        except ValueError as error:
            failed = _research_error(error)
            return {"result": failed.result, "outcome": failed.outcome}

    def commit(db):
        try:
            if command != "research_register":
                _research_scope(db, portfolio_id, payload)
            if command == "research_register":
                result = register_experiment(db, payload["experiment_id"], portfolio_id, payload["plan"], payload["dataset"], actor_id, now=clock())
                return JobCommit({"experiment_id": result["id"], "plan_hash": result["plan_hash"],
                                  "dataset_hash": result["dataset_hash"], "live_advice_eligible": False})
            if command == "research_register_trial":
                # The authenticated request is itself immutable and idempotent;
                # no actor, implementation manifest, or prepared result comes
                # from an external or AI-generated payload.
                result = register_trial(db, payload["experiment_id"], payload["phase"], payload["parameters"], request["id"], actor_id, now=clock())
                return JobCommit({"trial_id": result["id"], "research_run_id": result["run_id"], "phase": result["phase"],
                                  "parameters_hash": result["parameters_hash"], "status": "queued", "live_advice_eligible": False})
            if command == "research_freeze":
                result = freeze_candidate(db, payload["experiment_id"], payload["validation_trial_id"], actor_id, payload["reason"], now=clock())
            elif command == "research_unseal":
                result = unseal_holdout(db, payload["experiment_id"], actor_id, payload["reason"], now=clock())
            elif command == "research_ai_review":
                result = record_review(db, payload["run_id"], payload["model"], payload["raw_output"], now=clock())
                return JobCommit({"ai_run_id": result["id"], "research_run_id": payload["run_id"], "status": result["status"],
                                  "investment_gate_passed": False, "output_executed": False},
                                 "succeeded" if result["status"] == "valid" else "failed")
            else:
                raise WorkbenchError("UNSUPPORTED_RESEARCH_COMMAND")
            return JobCommit({"experiment_id": result["experiment_id"], "event_id": result["id"],
                              "action": result["action"], "parameters_hash": result["parameters_hash"], "live_advice_eligible": False})
        except (ValueError, sqlite3.IntegrityError) as error:
            return _research_error(error)
    return {"effect": commit}


def command_handler(connection, clock=None, lease_seconds=300, stop_requested=None, role="core"):
    clock = (lambda: None) if clock is None else clock
    supported = role_commands(role)
    def handle(job, lease):
        if job["job_type"] not in supported:
            raise WorkbenchError("JOB_REQUIRES_DIFFERENT_WORKER_ROLE")
        request = connection.execute("SELECT * FROM command_requests WHERE id=?", (job["command_request_id"],)).fetchone()
        if request is None or request["portfolio_id"] != job["scope"] or request["command_type"] != job["job_type"]:
            raise WorkbenchError("COMMAND_JOB_SCOPE_MISMATCH")
        payload = json.loads(request["payload_json"])
        if content_hash(payload) != request["payload_hash"]:
            raise WorkbenchError("COMMAND_PAYLOAD_HASH_MISMATCH")
        if job["job_type"] == "monthly_evaluation":
            monthly_request_binding(connection, request)
            return publish_monthly(connection, job, lease, lease_seconds=lease_seconds, clock=clock,
                                   stop_requested=stop_requested)
        if job["job_type"] in RESEARCH_COMMANDS:
            return _research_command(connection, request, payload, clock, job)
        if job["job_type"] == "market_collect_prices":
            from worker.market.price_collection import prepare_price_collection, persist_price_collection
            if stop_requested is not None and stop_requested():
                raise WorkbenchError("WORKER_STOP_REQUESTED")
            prepared = prepare_price_collection(connection, request, job, lease)
            def persist(db):
                if stop_requested is not None and stop_requested():
                    raise WorkbenchError("WORKER_STOP_REQUESTED")
                return JobCommit(persist_price_collection(db, prepared, now=clock()))
            return {"effect": persist}
        if job["job_type"] == "market_collect":
            if stop_requested is not None and stop_requested():
                raise WorkbenchError("WORKER_STOP_REQUESTED")
            binding = collection_request_binding(connection, request)
            def terminal(error):
                return JobCommit({"code": str(error), "live_advice_eligible": False},
                                 "failed" if str(error) == "COLLECTION_BINDING_INVALID" else "skipped")
            try:
                prepared = prepare_collection(connection, request, job, lease, clock=clock)
            except WorkbenchError as error:
                if binding is None or str(error) not in COLLECTION_TERMINAL_CODES:
                    raise
                result = terminal(error)
                return {"result": result.result, "outcome": result.outcome}
            def persist(db):
                if stop_requested is not None and stop_requested():
                    raise WorkbenchError("WORKER_STOP_REQUESTED")
                try:
                    return JobCommit(persist_collection(db, prepared, now=clock(), job=job, lease=lease))
                except WorkbenchError as error:
                    if binding is None or str(error) not in COLLECTION_TERMINAL_CODES:
                        raise
                    return terminal(error)
            return {"effect": persist}
        if job["job_type"] == "performance":
            prepared = prepare_performance(connection, request["portfolio_id"], payload, now=clock())
            def persist(db):
                result = persist_performance(db, prepared, now=clock())
                return JobCommit({"performance_id": result["id"], "quality": result["quality"], "method": result["method"]})
            return {"effect": persist}
        if job["job_type"] == "valuation":
            if not isinstance(payload, dict) or set(payload) - {"cutoff_at", "rules", "mode"} or not {"cutoff_at", "rules"} <= set(payload):
                raise WorkbenchError("INVALID_VALUATION_COMMAND")
            prepared = prepare_valuation(connection, request["portfolio_id"], payload["cutoff_at"], payload["rules"],
                                         payload.get("mode", "as_known"), now=clock())
            def persist(db):
                result = persist_valuation(db, prepared, now=clock())
                return JobCommit({"valuation_id": result["id"], "quality": result["quality"], "nav_cny": result["nav_cny"]})
            return {"effect": persist}
        if job["job_type"] == "market_ingest":
            if not isinstance(payload, dict) or set(payload) != {"document", "publish"} or not isinstance(payload["publish"], bool):
                raise WorkbenchError("INVALID_MARKET_INGEST_COMMAND")
            validate_contract(payload["document"])
            def ingest(db):
                result = ingest_document(db, payload["document"], publish=payload["publish"], now=clock())
                outcome = "succeeded" if result["status"] in ("validated", "published") else result["status"]
                return JobCommit({"batch_id": result["id"], "batch_status": result["status"],
                                  "manifest_hash": result["manifest_hash"]}, outcome)
            return {"effect": ingest}
        raise WorkbenchError("UNSUPPORTED_WORKER_COMMAND")
    return handle


def run_pending_once(connection, owner, lease_seconds=300, clock=None, discovery_limit=100, stop_requested=None,
                     discovery_state=None, role="core", collection_discovery_limit=100, collection_discovery_state=None):
    clock = (lambda: None) if clock is None else clock
    supported = role_commands(role)
    if role == "longport" and (type(lease_seconds) is not int or lease_seconds < 180):
        raise WorkbenchError("PRICE_WORKER_LEASE_TOO_SHORT")
    if role == "core":
        discover_due_cycles(connection, limit=discovery_limit, now=clock(), state=discovery_state)
        discover_due_collections(connection, limit=collection_discovery_limit, now=clock(), state=collection_discovery_state)
    sync_requests(connection, now=clock(), command_types=supported)
    # One oldest-ready selection avoids starving periodic jobs behind a busy
    # ingestion stream while still excluding unsupported modules' jobs.
    return run_one(connection, owner, command_handler(connection, clock, lease_seconds, stop_requested, role),
                   job_type=supported, lease_seconds=lease_seconds, clock=clock)
