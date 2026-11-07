"""Explicit correction consent and frozen economic baseline, never current admission."""

from copy import deepcopy
from datetime import timedelta

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job
from . import action_review_workflow as review, correction_impact_jobs as impact_jobs, managed_actions as managed
from .action_correction_impact import _ledger, _prepare_action_correction_impact
from .action_restatement_kernel import compare_action_restatement
from .correction_change_fence import correction_change_fence
from .data_evidence import _audit, _audit_binding, _object, _owner, validate_facts
from .implementation import implementation_hash
from .model_runtime import _clock


SCHEMA = "investor-correction-consent.schema.json"
JOB_TYPE = "investor_correction_consent"
ACKS = ("exact_stored_impact_seen", "explicit_historical_restatement", "selected_report_differences_accepted",
    "tax_and_instants_are_research_assumptions", "preserve_original_history_and_strategy", "new_epoch_not_current_nav", "separate_current_readmission_no_trading")


def _check(value, code="INVALID"):
    if not value: raise WorkbenchError("CORRECTION_CONSENT_" + code)


def _validate(value, kind): validate_contract(value, SCHEMA, fragment="$defs/" + kind)


def _impact(db, workspace, actor, identifier, at):
    request, doc = impact_jobs.request_header(db, workspace, actor, identifier, at)
    row = db.execute("SELECT * FROM investor_correction_impact_results WHERE request_id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    _check(row is not None, "IMPACT_REQUIRED"); result = _object(row["document_json"]); impact_jobs._validate(result, "result")
    _check(canonical_json(result) == row["document_json"] and content_hash(result) == row["content_hash"] and row["actor_id"] == actor
        and result["result_id"] == row["id"] and result["request_hash"] == request["content_hash"]
        and all(result[key] == row[key] for key in ("request_id", "workspace_id", "job_id", "fencing_token", "outcome", "code", "created_at")))
    _audit_binding(db, row, "investor_finish_correction_impact", "investor_correction_impact_result", row["id"])
    job = db.execute("SELECT * FROM job_runs WHERE id=?", (row["job_id"],)).fetchone()
    attempt = db.execute("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1", (row["job_id"],)).fetchone()
    _check(job is not None and attempt is not None and job["job_type"] == impact_jobs.JOB_TYPE and job["scope"] == workspace
        and job["period"] == request["id"] and job["input_version"] == request["content_hash"] and job["command_request_id"] is None
        and job["status"] == attempt["status"] == "succeeded" and job["max_attempts"] == job["attempt_count"] == 1
        and job["fencing_token"] == attempt["fencing_token"] == row["fencing_token"] and job["lease_owner"] is None and job["lease_until"] is None
        and instant(request["created_at"]) <= instant(attempt["started_at"]) <= instant(row["created_at"])
        <= instant(attempt["finished_at"]) == instant(job["updated_at"]) <= instant(at)
        and attempt["error_json"] is None and _object(job["result_json"]) == {"request_id": request["id"], "result_id": row["id"],
            "outcome": row["outcome"], "code": row["code"], "research_admitted": False})
    _check(result["outcome"] == "preview_ready" and result["code"] == "CORRECTION_IMPACT_READY", "IMPACT_REQUIRED")
    value = result["impact"]
    _check(value["workspace_id"] == workspace and value["model_id"] == request["model_id"] and value["preview_id"] == request["preview_id"]
        and value["workspace_revision"] == request["expected_revision"] and value["request_hash"] == request["request_hash"]
        and instant(request["created_at"]) <= instant(value["checked_at"]) <= instant(row["created_at"]) < instant(value["valid_until"]))
    return request, doc, row, result


def request_header(db, workspace, actor, identifier, at):
    _owner(db, workspace, actor)
    row = db.execute("SELECT * FROM investor_correction_consent_requests WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    _check(row is not None, "OUT_OF_SCOPE"); doc = _object(row["document_json"]); _validate(doc, "request"); body = doc["body"]
    _check(canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"] and row["actor_id"] == actor
        and doc["request_id"] == row["id"] and content_hash(body) == row["request_hash"]
        and all(doc[key] == row[key] for key in ("workspace_id", "model_id", "request_hash", "created_at", "valid_until"))
        and all(body[key] == row[key] for key in ("impact_request_id", "expected_revision", "idempotency_key"))
        and type(body["expected_revision"]) is int and instant(row["created_at"]) <= instant(at)
        and 0 < (instant(row["valid_until"]) - instant(row["created_at"])).total_seconds() <= 300)
    _audit_binding(db, row, "investor_enqueue_correction_consent", "investor_correction_consent_request", row["id"])
    source, _, result, value = _impact(db, workspace, actor, body["impact_request_id"], at)
    _check(source["model_id"] == row["model_id"] and source["expected_revision"] == row["expected_revision"]
        and result["content_hash"] == body["expected_result_hash"] and instant(result["created_at"]) <= instant(row["created_at"])
        and instant(row["valid_until"]) <= instant(value["impact"]["valid_until"]))
    return row, doc


def enqueue_correction_consent(db, workspace, actor, body, *, now=None):
    _owner(db, workspace, actor); _validate(body, "submit"); body = _object(canonical_json(body))
    _check(type(body["expected_revision"]) is int and len(canonical_json(body).encode()) <= 32768, "INPUT_INVALID")
    at, digest = _clock(now), content_hash(body)
    with transaction(db):
        old = db.execute("SELECT id,request_hash FROM investor_correction_consent_requests WHERE workspace_id=? AND idempotency_key=?", (workspace, body["idempotency_key"])).fetchone()
        if old:
            _check(old["request_hash"] == digest, "DUPLICATE_CONFLICT"); return request_header(db, workspace, actor, old["id"], at)[1]
        review._revision(db, workspace, actor, body["expected_revision"])
        source, _, result, value = _impact(db, workspace, actor, body["impact_request_id"], at)
        _check(result["content_hash"] == body["expected_result_hash"] and source["expected_revision"] == body["expected_revision"], "CHANGED")
        _check(at < value["impact"]["valid_until"], "EXPIRED")
        _check(not db.execute("SELECT 1 FROM investor_correction_consents WHERE workspace_id=? AND impact_request_id=?", (workspace, source["id"])).fetchone(), "ALREADY_CONFIRMED")
        busy = db.execute("""SELECT 1 FROM investor_correction_consent_requests r LEFT JOIN investor_correction_consent_results u ON u.request_id=r.id
          LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
          WHERE r.workspace_id=? AND r.valid_until>? AND u.id IS NULL AND (j.id IS NULL OR j.status IN ('queued','running','retry_queued')) LIMIT 1""", (JOB_TYPE, workspace, at)).fetchone()
        _check(not busy, "BUSY")
        until = min(value["impact"]["valid_until"], _clock(instant(at) + timedelta(minutes=5)))
        identifier = new_id("correction-consent-request")
        doc = {"schema_version": "investor-correction-consent-request-v1", "request_id": identifier, "workspace_id": workspace,
            "model_id": source["model_id"], "body": body, "request_hash": digest, "created_at": at, "valid_until": until}
        _validate(doc, "request"); hashed = content_hash(doc)
        audit = _audit(db, actor, "investor_enqueue_correction_consent", "investor_correction_consent_request", identifier, {"content_hash": hashed}, at)
        db.execute("INSERT INTO investor_correction_consent_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, source["model_id"], source["id"],
            body["expected_revision"], body["idempotency_key"], digest, canonical_json(doc), hashed, actor, at, until, audit))
        return doc


def _registered_correction_document(db, workspace, actor, identifier, at):
    """Internal registration authentication, not economic/source qualification."""
    _owner(db, workspace, actor); at = _clock(at)
    row = db.execute("SELECT * FROM investor_correction_consents WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    _check(row is not None, "OUT_OF_SCOPE"); doc = _object(row["document_json"]); _validate(doc, "confirmation")
    _check(len(row["document_json"].encode()) <= 8388608 and canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"]
        and row["actor_id"] == actor and doc["confirmation_id"] == row["id"] and row["created_at"] <= at
        and all(doc[key] == row[key] for key in ("workspace_id", "model_id", "request_id", "impact_request_id", "impact_result_id", "workspace_revision", "created_at", "valid_until")))
    _audit_binding(db, row, "investor_confirm_correction", "investor_correction_consent", identifier)
    request, queued = request_header(db, workspace, actor, row["request_id"], at)
    _, _, result, _ = _impact(db, workspace, actor, row["impact_request_id"], at)
    _check(doc["request"] == queued["body"] and doc["request_hash"] == request["request_hash"]
        and row["workspace_revision"] == request["expected_revision"] + 1 and request["created_at"] <= row["created_at"] < request["valid_until"]
        and doc["impact_result_id"] == result["id"] and doc["impact_result_hash"] == result["content_hash"]
        and doc["valid_until"] == doc["reviewed_source_valid_until"] <= doc["baseline"]["original_history"]["source_valid_until"]
        and doc["baseline"]["epoch_id"] == row["id"] and row["original_head_id"] == doc["baseline"]["original_history"]["head_checkpoint_id"]
        and request["created_at"] <= doc["baseline"]["knowledge_at"] <= row["created_at"])
    result = db.execute("SELECT * FROM investor_correction_consent_results WHERE request_id=? AND workspace_id=?", (request["id"], workspace)).fetchone()
    _check(result is not None, "RESULT_REQUIRED"); output = _object(result["document_json"]); _validate(output, "result")
    _check(canonical_json(output) == result["document_json"] and content_hash(output) == result["content_hash"] and result["actor_id"] == actor
        and output["result_id"] == result["id"] and output["request_hash"] == request["content_hash"]
        and output["confirmation_hash"] == row["content_hash"] and result["confirmation_id"] == identifier
        and output["outcome"] == "confirmed" and output["code"] == "CORRECTION_CONSENT_CONFIRMED"
        and all(output[key] == result[key] for key in ("request_id", "workspace_id", "job_id", "fencing_token", "outcome", "code", "confirmation_id", "created_at")))
    _audit_binding(db, result, "investor_finish_correction_consent", "investor_correction_consent_result", result["id"])
    job = db.execute("SELECT * FROM job_runs WHERE id=?", (result["job_id"],)).fetchone()
    attempt = db.execute("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1", (result["job_id"],)).fetchone()
    _check(job is not None and attempt is not None and job["job_type"] == JOB_TYPE and job["scope"] == workspace
        and job["period"] == request["id"] and job["input_version"] == request["content_hash"] and job["command_request_id"] is None
        and job["status"] == attempt["status"] == "succeeded" and job["attempt_count"] == job["max_attempts"] == 1
        and job["fencing_token"] == attempt["fencing_token"] == result["fencing_token"] and job["lease_owner"] is None and job["lease_until"] is None
        and instant(request["created_at"]) <= instant(attempt["started_at"]) <= instant(row["created_at"])
        == instant(result["created_at"]) <= instant(attempt["finished_at"]) == instant(job["updated_at"]) <= instant(at)
        and attempt["error_json"] is None and _object(job["result_json"]) == {"request_id": request["id"], "result_id": result["id"],
            "outcome": "confirmed", "code": "CORRECTION_CONSENT_CONFIRMED", "research_admitted": False})
    return doc


def read_correction_consent_receipt(db, workspace, actor, identifier, *, now=None):
    """Historical metadata only, including after expiry/withdrawal; no source values."""
    doc = _registered_correction_document(db, workspace, actor, identifier, _clock(now))
    result = {"schema_version": "investor-correction-consent-receipt-v1", **{key: doc[key] for key in (
        "confirmation_id", "workspace_id", "workspace_revision", "model_id", "impact_request_id", "impact_result_hash", "request_id", "created_at", "valid_until")},
        "economic_correction_approved": True, "baseline_registered": True, "historical_registration_only": True,
        "current_source_eligibility_restored": False, "monitor_data_readmission_required": True, "monitoring_resumed": False,
        "checkpoint_created": False, "trading_permission": False, "source_values_included": False, "provider_calls": 0}
    _validate(result, "receipt"); return result


def discover_correction_consents(db, *, limit=100, now=None, stop_requested=None):
    _check(type(limit) is int and 1 <= limit <= 1000, "LIMIT_INVALID"); at = _clock(now); result = []
    managed._stopped(db, stop_requested)
    # A pre-v63 historical component fixture has no new consent capability.
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investor_correction_consent_requests'").fetchone(): return result
    rows = db.execute("""SELECT id,workspace_id,actor_id FROM investor_correction_consent_requests r WHERE NOT EXISTS(
      SELECT 1 FROM job_runs j WHERE j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id) ORDER BY created_at,id LIMIT ?""", (JOB_TYPE, limit)).fetchall()
    for selected in rows:
        managed._stopped(db, stop_requested)
        with transaction(db):
            row, _ = request_header(db, selected["workspace_id"], selected["actor_id"], selected["id"], at)
            result.append(enqueue_job(db, JOB_TYPE, row["workspace_id"], row["id"], row["content_hash"], max_attempts=1, now=at))
    return result


def _same_visible_economics(before, bundle):
    after = bundle["result"]
    keys = ("request_hash", "draft_basis_hash", "source_changes_hash", "prior_facts_hash", "tax_assumption_hash", "ignored_new_report_dates")
    _check(all(before[key] == after[key] for key in keys), "CHANGED")
    a, b = before["original_history"], after["original_history"]
    _check({key: value for key, value in a.items() if key not in ("checked_at", "source_valid_until")}
        == {key: value for key, value in b.items() if key not in ("checked_at", "source_valid_until")}, "CHANGED")
    # Current raw/source qualification already succeeded. Only pure arithmetic
    # uses the old comparison clock to authenticate the entire recorded result.
    original = deepcopy(bundle["kernel_input"]); original["checked_at"] = before["checked_at"]
    for action in original["corrected_actions"]:
        day = instant(action["ex_at"] if action["kind"] == "dividend_payment" else action["effective_at"]).astimezone(managed.ZONE).date().isoformat()
        if action["listing_id"] == bundle["facts"]["listing_id"] and day in bundle["changed_days"]: action["known_at"] = before["checked_at"]
    _check(compare_action_restatement(original) == before["comparison"], "CHANGED")
    _check([{key: value for key, value in row.items() if key != "published_at"} for row in before["hypothetical_events"]]
        == [{key: value for key, value in row.items() if key != "published_at"} for row in after["hypothetical_events"]], "CHANGED")


def _baseline(bundle, identifier, at):
    facts = deepcopy(bundle["facts"]); changed = bundle["changed_days"]
    _check(changed and all(row["choice"] != "retain" for row in bundle["request"]["decisions"]), "UNRESOLVED")
    zone = managed.ZONE
    for event in facts["events"]:
        if instant(event["at"]).astimezone(zone).date().isoformat() in changed:
            event.update(id="reviewed-correction:" + content_hash({"consent": identifier, "hypothesis": event["id"]}),
                published_at=at, source_evidence="explicit-owner-correction:" + identifier)
    validate_facts("actions", facts)
    kernel = deepcopy(bundle["kernel_input"]); listing = facts["listing_id"]
    affected = lambda row: row["listing_id"] == listing and instant(row["ex_at"] if row["kind"] == "dividend_payment" else row["effective_at"]).astimezone(zone).date().isoformat() in changed
    actions = [row for row in kernel["original_actions"] if not affected(row)]
    actions.extend(row for row in _ledger(facts, kernel["head"]["market_cutoffs"]["US"], at) if affected(row))
    kernel.update(corrected_actions=sorted(actions, key=lambda row: row["id"]), checked_at=at)
    comparison = compare_action_restatement(kernel)
    for key in ("delta", "difference_cny", "original_valuation_cny", "restated_valuation_cny"):
        _check(comparison[key] == bundle["result"]["comparison"][key], "CHANGED")
    result = {"schema_version": "investor-approved-restatement-baseline-v1", "epoch_id": identifier,
        "model_hash": content_hash(kernel["definition"]), "original_history": bundle["history"]["proof"], "approved_facts": facts,
        "corrected_actions_hash": content_hash(kernel["corrected_actions"]), "economics": comparison["restated"],
        "policy_state": deepcopy(kernel["head"].get("policy_state")), "original_checkpoint_hash": content_hash(kernel["head"]),
        "original_projection_hash": content_hash(kernel["head_projection"]), "comparison_hash": content_hash(comparison),
        "valuation_summary": {key: comparison[key] for key in ("original_valuation_cny", "restated_valuation_cny", "difference_cny", "delta")}, "knowledge_at": at,
        "status": "approved_baseline_requires_new_current_data_protocol"}
    _validate(result, "baseline"); return result


def _error(error):
    code = str(error)
    if code in managed.STOP: raise error
    if "EXPIRED" in code: return "CORRECTION_CONSENT_EXPIRED"
    if "UNRESOLVED" in code: return "CORRECTION_CONSENT_UNRESOLVED"
    if any(key in code for key in ("VERSION", "CHANGED", "SCOPE", "ALREADY")): return "CORRECTION_CONSENT_CHANGED"
    return "CORRECTION_CONSENT_SOURCE_UNAVAILABLE"


def prepare_correction_consent_job(db, job, lease, *, clock=None, stop_requested=None):
    clock = (lambda: None) if clock is None else clock
    at = _clock(clock()); managed._stopped(db, stop_requested); assert_lease(db, lease, at)
    raw = db.execute("SELECT actor_id FROM investor_correction_consent_requests WHERE id=? AND workspace_id=?", (job["period"], job["scope"])).fetchone()
    _check(raw is not None, "OUT_OF_SCOPE"); row, doc = request_header(db, job["scope"], raw["actor_id"], job["period"], at)
    _check(job["job_type"] == JOB_TYPE and job["command_request_id"] is None and job["input_version"] == row["content_hash"] and job["max_attempts"] == job["attempt_count"] == 1)
    implementation, prepared, failure = implementation_hash(), None, None
    try:
        _check(at < row["valid_until"], "EXPIRED")
        with transaction(db, immediate=False):
            source, original, prior_row, prior = _impact(db, row["workspace_id"], row["actor_id"], row["impact_request_id"], at)
            _check(prior["implementation_hash"] == implementation, "IMPLEMENTATION_CHANGED")
            _check(prior["change_fence"] == correction_change_fence(db, row["workspace_id"], row["actor_id"]), "CHANGED")
            bundle = _prepare_action_correction_impact(db, row["workspace_id"], row["actor_id"], original["body"], now=at, stop_requested=stop_requested)
            bundle["request"] = original["body"]; _same_visible_economics(prior["impact"], bundle)
            identifier = new_id("correction-consent")
            baseline = _baseline(bundle, identifier, at)
            prepared = {"baseline": baseline, "bundle": bundle, "identifier": identifier, "prior_row": dict(prior_row),
                "fence": correction_change_fence(db, row["workspace_id"], row["actor_id"])}
    except ValueError as error: failure = _error(error)

    def commit(connection):
        _check(connection is db, "CONNECTION_CHANGED"); current = _clock(clock()); managed._stopped(db, stop_requested); assert_lease(db, lease, current)
        selected, selected_doc = request_header(db, row["workspace_id"], row["actor_id"], row["id"], current)
        _check(selected["content_hash"] == row["content_hash"] and selected_doc == doc, "CHANGED")
        ready, code, confirmation = prepared, failure, None
        if ready:
            try:
                _check(current < min(row["valid_until"], ready["bundle"]["result"]["valid_until"]), "EXPIRED")
                _check(implementation_hash() == implementation, "IMPLEMENTATION_CHANGED")
                review._revision(db, row["workspace_id"], row["actor_id"], row["expected_revision"])
                _check(correction_change_fence(db, row["workspace_id"], row["actor_id"]) == ready["fence"], "CHANGED")
                _check(not db.execute("SELECT 1 FROM investor_correction_consents WHERE impact_request_id=?", (row["impact_request_id"],)).fetchone(), "ALREADY_CONFIRMED")
                _check(instant(current).astimezone(managed.ZONE).date().isoformat()
                    == ready["bundle"]["context"]["report"]["source_day"], "SOURCE_DAY_CHANGED")
            except ValueError as error: ready, code = None, _error(error)
        if ready:
            # Knowledge starts at the actual replay after explicit owner intent,
            # not at the earlier hypothetical result or a historical event date.
            _check(row["created_at"] <= at <= current, "CLOCK_REGRESSION")
            identifier, bundle = ready["identifier"], ready["bundle"]
            source_until = min(bundle["history"]["proof"]["source_valid_until"], bundle["context"]["maximum_valid_until"], key=instant)
            confirmation = {"schema_version": "investor-correction-consent-confirmation-v1", "confirmation_id": identifier,
                "workspace_id": row["workspace_id"], "workspace_revision": row["expected_revision"] + 1, "model_id": row["model_id"],
                "impact_request_id": row["impact_request_id"], "impact_result_id": ready["prior_row"]["id"], "impact_result_hash": ready["prior_row"]["content_hash"],
                "request_id": row["id"], "request": doc["body"], "request_hash": row["request_hash"], "created_at": current,
                "valid_until": source_until, "reviewed_source_valid_until": source_until, "baseline": ready["baseline"],
                "capture_refs": bundle["context"]["refs"], "draft_basis_hash": bundle["draft"]["draft_basis_hash"],
                "outstanding_new_report_dates": bundle["result"]["ignored_new_report_dates"], "economic_correction_approved": True,
                "source_basis": "selected_reports_and_explicit_owner_hypotheses_not_objective_absence",
                "monitor_data_readmission_required": True, **{key: False for key in ("checkpoint_created", "state_published", "monitoring_resumed",
                    "historical_observations_rewritten", "historical_strategy_results_recomputed", "trading_permission", "raw_ai_sharing")}, "provider_calls": 0}
            _validate(confirmation, "confirmation"); encoded, hashed = canonical_json(confirmation), content_hash(confirmation)
            _check(len(encoded.encode()) <= 8388608, "BASELINE_SIZE_LIMIT")
            sealed = _clock(clock()); managed._stopped(db, stop_requested); assert_lease(db, lease, sealed)
            _check(current <= sealed < min(row["valid_until"], bundle["result"]["valid_until"], source_until), "EXPIRED")
            audit = _audit(db, row["actor_id"], "investor_confirm_correction", "investor_correction_consent", identifier, {"content_hash": hashed}, current)
            db.execute("INSERT INTO investor_correction_consents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, row["workspace_id"], row["model_id"], row["id"],
                row["impact_request_id"], ready["prior_row"]["id"], ready["baseline"]["original_history"]["head_checkpoint_id"], row["expected_revision"] + 1,
                encoded, hashed, row["actor_id"], current, confirmation["valid_until"], audit))
            db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (row["workspace_id"],))
        identifier = new_id("correction-consent-result"); outcome = "confirmed" if confirmation else "rejected"
        code = "CORRECTION_CONSENT_CONFIRMED" if confirmation else code
        result = {"schema_version": "investor-correction-consent-result-v1", "result_id": identifier, "request_id": row["id"], "workspace_id": row["workspace_id"],
            "request_hash": row["content_hash"], "job_id": job["id"], "fencing_token": lease.fencing_token, "outcome": outcome, "code": code,
            "confirmation_id": confirmation["confirmation_id"] if confirmation else None, "confirmation_hash": content_hash(confirmation) if confirmation else None, "created_at": current}
        _validate(result, "result"); hashed = content_hash(result)
        audit = _audit(db, row["actor_id"], "investor_finish_correction_consent", "investor_correction_consent_result", identifier, {"content_hash": hashed}, current)
        db.execute("INSERT INTO investor_correction_consent_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, row["id"], row["workspace_id"], job["id"], lease.fencing_token,
            outcome, code, result["confirmation_id"], canonical_json(result), hashed, row["actor_id"], current, audit))
        return JobCommit({"request_id": row["id"], "result_id": identifier, "outcome": outcome, "code": code, "research_admitted": False})
    return {"effect": commit}
