"""Explicit owner intent and fenced first-epoch publication, not resumed monitoring."""

from datetime import timedelta

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job
from . import model_epoch_source as source, managed_actions as managed
from .correction_change_fence import correction_change_fence
from .data_evidence import _audit, _audit_binding, _fact_validation_scope, _object, _owner
from .evidence_observation import observation
from .implementation import implementation_hash
from .model_runtime import _clock
from .monitor_admission import latest_monitor_evidence


SCHEMA = "investor-model-epoch-registration.schema.json"
JOB_TYPE = "investor_evidence_monitor"
ENGINE = "investor-evidence-model-watcher-epoch-v1"
ACKS = ("separate_current_epoch", "displayed_source_and_correction_bindings", "reported_coverage_not_objective_absence",
    "economic_carry_not_point_in_time", "preserve_original_model_and_history", "no_strategy_cash_or_trading_change")


def _check(value, code):
    if not value: raise WorkbenchError("INVESTOR_MODEL_EPOCH_REGISTRATION_" + code)


def _validate(value, kind): validate_contract(value, SCHEMA, fragment="$defs/" + kind)


def _revision(db, workspace, actor, expected):
    _owner(db, workspace, actor)
    _check(type(expected) is int and db.execute("SELECT revision FROM investor_workspaces WHERE id=?", (workspace,)).fetchone()[0] == expected, "VERSION_CONFLICT")


def _header(db, workspace, actor, identifier, kind):
    """Authenticate immutable receipts, not current raw-source eligibility."""
    _owner(db, workspace, actor)
    table = {"preview": "investor_model_epoch_previews", "request": "investor_model_epoch_requests", "registration": "investor_model_epochs"}[kind]
    row = db.execute("SELECT * FROM " + table + " WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    _check(row is not None and row["actor_id"] == actor, "OUT_OF_SCOPE")
    doc = _object(row["document_json"]); _validate(doc, kind)
    _check(content_hash(doc) == row["content_hash"] and canonical_json(doc) == row["document_json"]
        and all(doc[key] == row[key] for key in ("workspace_id", "actor_id", "model_id", "created_at", "valid_until")), "HEADER_CHANGED")
    action, object_type = {"preview": ("investor_preview_model_epoch", "investor_model_epoch_preview"),
        "request": ("investor_request_model_epoch", "investor_model_epoch_request"),
        "registration": ("investor_register_model_epoch", "investor_model_epoch")}[kind]
    _audit_binding(db, row, action, object_type, identifier)
    if kind == "preview":
        epoch, document, proof = doc["epoch_definition"], doc["input"], doc["source_proof"]
        _check(doc["preview_id"] == identifier and doc["workspace_revision"] == row["workspace_revision"]
            and epoch["epoch_id"] == row["epoch_id"] and document["epoch"] == proof["epoch"] == {"id": row["epoch_id"], "content_hash": content_hash(epoch)}
            and epoch["model_id"] == document["model_id"] == proof["model_id"] == row["model_id"]
            and all(item["workspace_id"] == workspace and item["actor_id"] == actor for item in (epoch, proof))
            and document["workspace_id"] == workspace and proof["input_hash"] == content_hash(document)
            and proof["projection_hash"] == document["projection_hash"] and epoch["created_at"] == document["created_at"] == proof["checked_at"]
            and document["created_at"] <= doc["created_at"] < doc["valid_until"] <= proof["valid_until"], "PREVIEW_CHANGED")
    elif kind == "request":
        preview_row, preview = _header(db, workspace, actor, row["preview_id"], "preview")
        monitor = doc["monitor_request"]
        _check(doc["request_id"] == identifier and doc["workspace_revision"] == row["workspace_revision"]
            and doc["preview"] == {"id": preview_row["id"], "content_hash": preview_row["content_hash"]}
            and content_hash(doc["body"]) == row["request_hash"] and doc["body"]["idempotency_key"] == row["idempotency_key"]
            and doc["body"]["preview_id"] == preview_row["id"] and doc["body"]["expected_preview_hash"] == preview_row["content_hash"]
            and doc["body"]["expected_revision"] == preview["workspace_revision"] == doc["workspace_revision"] - 1
            and doc["model_id"] == preview["model_id"] and preview["created_at"] <= doc["created_at"] < doc["valid_until"] == preview["valid_until"]
            and monitor["epoch_request_id"] == identifier and monitor["epoch"] == preview["input"]["epoch"]
            and monitor["input_hash"] == preview["source_proof"]["input_hash"] and monitor["model_hash"] == preview["epoch_definition"]["model_hash"]
            and monitor["checkpoint_hash"] == preview["epoch_definition"]["binding"]["original_head_hash"]
            and monitor["control_id"] == preview["epoch_definition"]["model_control"]["id"] and content_hash(monitor) == row["input_version"], "REQUEST_CHANGED")
    else:
        request_row, request = _header(db, workspace, actor, row["request_id"], "request")
        _, preview = _header(db, workspace, actor, request_row["preview_id"], "preview")
        epoch = _object(row["definition_json"]); source._validate(epoch, "definition")
        admitted = db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE id=? AND workspace_id=? AND model_id=?", (row["input_id"], workspace, row["model_id"])).fetchone()
        checkpoint = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?", (row["checkpoint_id"], workspace, row["model_id"])).fetchone()
        run = db.execute("SELECT * FROM investor_evidence_monitor_runs WHERE id=? AND workspace_id=? AND model_id=?", (row["monitor_run_id"], workspace, row["model_id"])).fetchone()
        monitor = db.execute("SELECT * FROM investor_evidence_monitor_requests WHERE id=? AND workspace_id=? AND model_id=?", (row["request_id"], workspace, row["model_id"])).fetchone()
        job = db.execute("SELECT * FROM job_runs WHERE id=?", (row["job_id"],)).fetchone()
        _check(all(item is not None for item in (admitted, checkpoint, run, monitor, job)), "REGISTRATION_CHANGED")
        _check(epoch == preview["epoch_definition"] and canonical_json(epoch) == row["definition_json"] and content_hash(epoch) == row["definition_hash"]
            and doc["epoch"] == preview["input"]["epoch"] and doc["request"] == {"id": request_row["id"], "content_hash": request_row["content_hash"]}
            and doc["input"] == {"id": admitted["id"], "content_hash": admitted["content_hash"]}
            and doc["checkpoint"] == {"id": checkpoint["id"], "content_hash": checkpoint["content_hash"]}
            and doc["monitor_run_id"] == run["id"] and doc["observation_id"] == run["observation_id"] and doc["job_id"] == job["id"]
            and doc["workspace_revision"] == request["workspace_revision"] + 1 and doc["calculated_at"] == checkpoint["created_at"] == doc["source_proof"]["checked_at"]
            and instant(request["created_at"]) <= instant(doc["calculated_at"]) <= instant(doc["created_at"]) < instant(doc["publication_deadline"])
            and instant(doc["publication_deadline"]) <= min(instant(doc["valid_until"]), instant(doc["source_proof"]["valid_until"]), instant(request["valid_until"]))
            and admitted["document_json"] == canonical_json(preview["input"]) and admitted["content_hash"] == content_hash(preview["input"])
            and admitted["actor_id"] == actor and admitted["created_at"] == preview["input"]["created_at"]
            and admitted["valid_until"] == preview["input"]["valid_until"] and admitted["source_qualification"] == "owner_reviewed_reconstructed"
            and checkpoint["input_id"] == admitted["id"] and checkpoint["projection_hash"] == preview["input"]["projection_hash"]
            and checkpoint["previous_hash"] == epoch["binding"]["original_head_hash"] and checkpoint["valid_until"] == row["valid_until"]
            and doc["source_proof"]["epoch"] == doc["epoch"] and doc["source_proof"]["input_hash"] == admitted["content_hash"]
            and doc["source_proof"]["projection_hash"] == checkpoint["projection_hash"] and doc["source_proof"]["original_head_id"] == epoch["original_head_id"]
            and monitor["document_json"] == canonical_json(request["monitor_request"]) and monitor["input_version"] == request_row["input_version"]
            and monitor["input_id"] == admitted["id"] and monitor["checkpoint_id"] == epoch["original_head_id"]
            and monitor["control_id"] == epoch["model_control"]["id"] and monitor["created_at"] == request["created_at"]
            and job["status"] == "succeeded" and job["job_type"] == JOB_TYPE and job["command_request_id"] is None
            and job["scope"] == workspace and job["period"] == request_row["id"] and job["input_version"] == request_row["input_version"]
            and run["job_id"] == job["id"] and run["request_id"] == request_row["id"] and run["checkpoint_id"] == checkpoint["id"]
            and run["created_at"] == row["created_at"] and run["valid_until"] == row["valid_until"], "REGISTRATION_CHANGED")
        audit = db.execute("SELECT * FROM audit_events WHERE id=?", (admitted["audit_id"],)).fetchone()
        _check(audit is not None and audit["actor_id"] == actor and audit["action"] == "investor_admit_monitor_source"
            and audit["object_type"] == "investor_monitor_evidence_input" and audit["object_id"] == admitted["id"]
            and audit["created_at"] == row["created_at"] and _object(audit["payload_json"]) == {"content_hash": admitted["content_hash"]}, "REGISTRATION_CHANGED")
        run_doc = _object(run["document_json"]); validate_contract(run_doc, "investor-evidence-monitor.schema.json", fragment="$defs/run")
        _check(content_hash(run_doc) == run["content_hash"] and canonical_json(run_doc) == run["document_json"]
            and run_doc["request_id"] == request_row["id"] and run_doc["model_id"] == row["model_id"] and run_doc["input_version"] == request_row["input_version"]
            and run_doc["projection_hash"] == checkpoint["projection_hash"] and run_doc["checkpoint_hash"] == checkpoint["content_hash"]
            and run_doc["created_at"] == row["created_at"] and run_doc["valid_until"] == row["valid_until"] and run_doc["status"] == run["status"]
            and run_doc["implementation_hash"] == doc["implementation_hash"] and run_doc["next_check_at"] is None, "REGISTRATION_CHANGED")
    return row, doc


def prepare_model_epoch_preview(db, workspace, actor, model_id, references, windows, *, expected_revision, owner_interaction=False, now=None, clock=None, stop_requested=None):
    """Prepare normal source bytes outside the writer; never accept caller settings."""
    assert_writable(db); _owner(db, workspace, actor)
    _check(owner_interaction is True, "OWNER_INTERACTION_REQUIRED")
    at = _clock(clock() if clock else now)
    with transaction(db, immediate=False), _fact_validation_scope():
        _revision(db, workspace, actor, expected_revision); managed._stopped(db, stop_requested)
        value = source.prepare_model_epoch_source(db, workspace, actor, model_id, new_id("model-epoch"), references, windows, now=at, stop_requested=stop_requested)
        control = db.execute("SELECT enabled FROM investor_model_controls WHERE id=? AND workspace_id=? AND model_id=?", (value["epoch_definition"]["model_control"]["id"], workspace, model_id)).fetchone()
        _check(control is not None and control["enabled"] == 1, "MODEL_NOT_ENABLED")
        _check(value["candidate"]["checkpoint"] is not None and value["candidate"]["assessment"]["outcome"] != "insufficient_evidence", "CURRENT_INPUTS_NOT_READY")
        previous = latest_monitor_evidence(db, workspace, model_id)
        _check(previous is not None, "CURRENT_INPUTS_NOT_READY")
        fence, implementation = correction_change_fence(db, workspace, actor), implementation_hash()

    def commit(connection):
        _check(connection is db, "PREPARED_CONNECTION_CHANGED"); assert_writable(db)
        with transaction(db):
            current = _clock(clock() if clock else now); _revision(db, workspace, actor, expected_revision); managed._stopped(db, stop_requested)
            _check(instant(at) <= instant(current) < instant(value["proof"]["valid_until"]), "PREVIEW_EXPIRED")
            _check(correction_change_fence(db, workspace, actor) == fence and implementation_hash() == implementation, "SOURCE_CHANGED")
            identifier = new_id("model-epoch-preview")
            expiry = _clock(min(instant(value["proof"]["valid_until"]), instant(at) + timedelta(minutes=10)))
            _check(instant(current) < instant(expiry), "PREVIEW_EXPIRED")
            doc = {"schema_version": "investor-model-epoch-preview-v1", "preview_id": identifier, "workspace_id": workspace, "actor_id": actor, "model_id": model_id,
                "workspace_revision": expected_revision + 1, "epoch_definition": value["epoch_definition"], "input": value["input"], "source_proof": value["proof"],
                "previous_input_id": previous["id"], "change_fence": fence, "implementation_hash": implementation, "created_at": current, "valid_until": expiry,
                "epoch_registered": False, "trading_permission": False}
            _validate(doc, "preview"); encoded, digest = canonical_json(doc), content_hash(doc)
            _check(len(encoded.encode()) <= 1048576, "PREVIEW_LIMIT")
            audit = _audit(db, actor, "investor_preview_model_epoch", "investor_model_epoch_preview", identifier, {"content_hash": digest}, current)
            db.execute("INSERT INTO investor_model_epoch_previews VALUES(?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, model_id, value["epoch_definition"]["epoch_id"], expected_revision + 1,
                encoded, digest, actor, current, expiry, audit))
            _check(instant(_clock(clock() if clock else now)) < instant(expiry), "PREVIEW_EXPIRED")
            db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (workspace,))
            return doc
    return commit


def register_model_epoch_preview(db, workspace, actor, model_id, references, windows, **options):
    return prepare_model_epoch_preview(db, workspace, actor, model_id, references, windows, **options)(db)


def enqueue_model_epoch_registration(db, workspace, actor, body, *, now=None):
    assert_writable(db); _owner(db, workspace, actor); _validate(body, "submit")
    body = _object(canonical_json(body)); digest = content_hash(body); at = _clock(now)
    with transaction(db):
        _owner(db, workspace, actor)
        old = db.execute("SELECT id,request_hash FROM investor_model_epoch_requests WHERE workspace_id=? AND idempotency_key=?", (workspace, body["idempotency_key"])).fetchone()
        if old:
            _check(old["request_hash"] == digest, "DUPLICATE_CONFLICT")
            return _header(db, workspace, actor, old["id"], "request")[1]
        _revision(db, workspace, actor, body["expected_revision"])
        row, preview = _header(db, workspace, actor, body["preview_id"], "preview")
        _check(row["content_hash"] == body["expected_preview_hash"] and preview["workspace_revision"] == body["expected_revision"], "PREVIEW_CHANGED")
        _check(preview["created_at"] <= at < preview["valid_until"] and preview["implementation_hash"] == implementation_hash(), "PREVIEW_EXPIRED")
        epoch = preview["epoch_definition"]; identifier = new_id("model-epoch-request")
        model = db.execute("SELECT document_json FROM investor_models WHERE id=? AND workspace_id=?", (preview["model_id"], workspace)).fetchone()
        monitor = {"schema_version": "investor-evidence-monitor-request-v3", "engine_version": ENGINE, "model_hash": epoch["model_hash"],
            "profile_hash": _object(model[0])["profile_hash"], "control_id": epoch["model_control"]["id"], "input_hash": preview["source_proof"]["input_hash"],
            "checkpoint_hash": epoch["binding"]["original_head_hash"], "epoch": preview["input"]["epoch"], "epoch_request_id": identifier}
        doc = {"schema_version": "investor-model-epoch-request-v1", "request_id": identifier, "workspace_id": workspace, "actor_id": actor,
            "model_id": preview["model_id"], "workspace_revision": body["expected_revision"] + 1, "preview": {"id": row["id"], "content_hash": row["content_hash"]},
            "body": body, "monitor_request": monitor, "created_at": at, "valid_until": preview["valid_until"], "trading_permission": False}
        _validate(doc, "request"); hashed, version = content_hash(doc), content_hash(monitor)
        audit = _audit(db, actor, "investor_request_model_epoch", "investor_model_epoch_request", identifier, {"content_hash": hashed}, at)
        db.execute("INSERT INTO investor_model_epoch_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, preview["model_id"], row["id"], doc["workspace_revision"],
            body["idempotency_key"], digest, version, canonical_json(doc), hashed, actor, at, doc["valid_until"], audit))
        enqueue_job(db, JOB_TYPE, workspace, identifier, version, max_attempts=2, now=at)
        db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (workspace,))
        return doc


def prepare_model_epoch_registration_job(db, job, lease, *, clock=None, stop_requested=None):
    """All retained source replay is before the short lease-checked write effect."""
    clock = clock or (lambda: None); at = _clock(clock()); assert_writable(db)
    with transaction(db, immediate=False), _fact_validation_scope():
        live = assert_lease(db, lease, at)
        _check(live["id"] == job["id"] and all(live[key] == job[key] for key in ("job_type", "scope", "period", "input_version", "command_request_id"))
            and live["job_type"] == JOB_TYPE and live["command_request_id"] is None, "JOB_CHANGED")
        owner = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (job["scope"],)).fetchone()
        _check(owner is not None, "OUT_OF_SCOPE"); workspace, actor = job["scope"], owner[0]
        row, request = _header(db, workspace, actor, job["period"], "request")
        _, preview = _header(db, workspace, actor, row["preview_id"], "preview")
        _check(row["input_version"] == job["input_version"] and request["created_at"] <= at < request["valid_until"], "REQUEST_EXPIRED")
        _revision(db, workspace, actor, request["workspace_revision"]); managed._stopped(db, stop_requested)
        _check(preview["implementation_hash"] == implementation_hash() and latest_monitor_evidence(db, workspace, row["model_id"])["id"] == preview["previous_input_id"], "SOURCE_CHANGED")
        value = source.replay_model_epoch_source(db, workspace, actor, preview["epoch_definition"], preview["input"], now=at, stop_requested=stop_requested)
        _check(request["monitor_request"]["profile_hash"] == value["kernel_input"]["history"]["definition"]["profile_hash"], "REQUEST_CHANGED")
        result = value["candidate"]; checkpoint = result["checkpoint"]; assessment = result["assessment"]
        _check(checkpoint is not None and assessment["outcome"] != "insufficient_evidence" and assessment["next_review_at"] is not None, "CURRENT_INPUTS_NOT_READY")
        previous = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?", (preview["epoch_definition"]["original_head_id"], workspace, row["model_id"])).fetchone()
        expiry = min(preview["input"]["valid_until"], value["epoch_definition"]["valid_until"], previous["valid_until"], key=instant)
        deadline = min(expiry, request["valid_until"], assessment["next_review_at"], value["proof"]["valid_until"], key=instant)
        _check(instant(at) < instant(deadline), "CURRENT_INPUTS_NOT_READY")
        fence, implementation = correction_change_fence(db, workspace, actor), implementation_hash()

    def commit(connection):
        _check(connection is db, "PREPARED_CONNECTION_CHANGED"); assert_writable(db)
        with transaction(db):
            current = _clock(clock()); assert_lease(db, lease, current); _revision(db, workspace, actor, request["workspace_revision"])
            managed._stopped(db, stop_requested)
            _check(instant(at) <= instant(current) < instant(deadline), "PUBLICATION_EXPIRED")
            _check(implementation_hash() == implementation and correction_change_fence(db, workspace, actor) == fence, "SOURCE_CHANGED")
            epoch = value["epoch_definition"]; document = value["input"]; definition = value["kernel_input"]["history"]["definition"]
            input_id, checkpoint_id = new_id("monitor-evidence-input"), new_id("evidence-model-checkpoint")
            run_id, observation_id = new_id("evidence-monitor-run"), new_id("evidence-model-observation")
            registration = {"schema_version": "investor-model-epoch-registration-v1", "epoch": document["epoch"],
                "request": {"id": row["id"], "content_hash": row["content_hash"]}, "workspace_id": workspace, "actor_id": actor, "model_id": row["model_id"],
                "workspace_revision": request["workspace_revision"] + 1, "input": {"id": input_id, "content_hash": content_hash(document)},
                "checkpoint": {"id": checkpoint_id, "content_hash": content_hash(checkpoint)}, "monitor_run_id": run_id, "observation_id": observation_id,
                "job_id": job["id"], "implementation_hash": implementation, "source_proof": value["proof"], "calculated_at": at, "created_at": current, "publication_deadline": deadline, "valid_until": expiry,
                "source_registered": True, "first_state_published": True, "monitoring_resumed": False, "historical_observations_rewritten": False,
                "trading_permission": False, "provider_calls": 0, "distribution": "private_owner_only_not_ai"}
            _validate(registration, "registration"); digest = content_hash(registration)
            audit = _audit(db, actor, "investor_register_model_epoch", "investor_model_epoch", epoch["epoch_id"], {"content_hash": digest}, current)
            db.execute("INSERT INTO investor_model_epochs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (epoch["epoch_id"], workspace, row["model_id"], row["id"], input_id, checkpoint_id, run_id, job["id"],
                canonical_json(epoch), content_hash(epoch), canonical_json(registration), digest, actor, current, expiry, audit))
            audit = _audit(db, actor, "investor_admit_monitor_source", "investor_monitor_evidence_input", input_id, {"content_hash": content_hash(document)}, current)
            db.execute("INSERT INTO investor_monitor_evidence_inputs VALUES(?,?,?,'owner_reviewed_reconstructed',?,?,?,?,?,?)", (input_id, workspace, row["model_id"],
                canonical_json(document), content_hash(document), actor, document["created_at"], document["valid_until"], audit))
            monitor = request["monitor_request"]
            db.execute("INSERT INTO investor_evidence_monitor_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)", (row["id"], workspace, row["model_id"], monitor["control_id"], input_id,
                previous["id"], "epoch-registration:" + row["id"], row["input_version"], row["input_version"], canonical_json(monitor), request["created_at"]))
            db.execute("INSERT INTO investor_evidence_model_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?)", (checkpoint_id, workspace, row["model_id"], input_id, checkpoint["sequence"],
                checkpoint["previous_hash"], content_hash(checkpoint), checkpoint["projection_hash"], checkpoint["created_at"], expiry))
            db.execute("INSERT INTO investor_evidence_checkpoint_payloads VALUES(?,?)", (checkpoint_id, canonical_json(checkpoint).encode()))
            rendered = observation(definition, {"input_version": row["input_version"]}, result, None)
            # The first state is real, but scheduled continuation and its readers
            # still need their distinct protocol. Do not report monitoring active.
            rendered["monitoring"] = "paused"
            ref = {"schema_version": "investor-model-observation-ref-v1", "run_id": run_id, "outcome": rendered["outcome"], "profile_id": definition["profile_id"],
                "profile_version": definition["profile_version"], "input_version": row["input_version"], "published_at": current}
            validate_contract(ref, "investor-evidence-monitor.schema.json", fragment="$defs/observation_ref")
            payload = {"assessment": assessment, "observation": rendered}
            run = {"schema_version": "investor-evidence-monitor-run-v1", "request_id": row["id"], "model_id": row["model_id"], "input_version": row["input_version"],
                "implementation_hash": implementation, "status": rendered["outcome"], "reason_codes": assessment["reason_codes"], "projection_hash": content_hash(value["projection"]),
                "checkpoint_hash": content_hash(checkpoint), "assessment_hash": assessment["result_hash"], "observation_hash": content_hash(rendered), "payload_hash": content_hash(payload),
                "next_check_at": None, "created_at": current, "valid_until": expiry, "live_advice_eligible": False}
            validate_contract(run, "investor-evidence-monitor.schema.json", fragment="$defs/run")
            db.execute("INSERT INTO investor_observations(id,workspace_id,profile_id,candidate_plan_id,outcome,document_json,content_hash,input_version,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (observation_id, workspace, definition["profile_id"], definition["plan_id"], rendered["outcome"], canonical_json(ref), content_hash(ref), row["input_version"], current))
            db.execute("INSERT INTO investor_evidence_monitor_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (run_id, workspace, row["model_id"], row["id"], job["id"], observation_id, checkpoint_id,
                rendered["outcome"], canonical_json(run), content_hash(run), current, expiry))
            db.execute("INSERT INTO investor_evidence_run_payloads VALUES(?,?)", (run_id, canonical_json(payload).encode()))
            managed._stopped(db, stop_requested)
            _check(instant(_clock(clock())) < instant(deadline), "PUBLICATION_EXPIRED")
            db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (workspace,))
            return JobCommit({"epoch_id": epoch["epoch_id"], "monitor_run_id": run_id, "observation_id": observation_id,
                "checkpoint_id": checkpoint_id, "status": "epoch_registered_not_resumed", "live_advice_eligible": False})
    return {"effect": commit}


def assert_model_epoch_finalization(db, job, lease, result, outcome, finished):
    """Final runner clock gate; no source BLOB replay inside the writer."""
    assert_lease(db, lease, finished)
    _check(outcome == "succeeded" and type(result) is dict, "FINALIZATION_CHANGED")
    row = db.execute("SELECT * FROM investor_model_epochs WHERE request_id=? AND workspace_id=? AND job_id=?", (job["period"], job["scope"], job["id"])).fetchone()
    _check(row is not None, "FINALIZATION_CHANGED")
    doc = _object(row["document_json"]); _validate(doc, "registration")
    _check(content_hash(doc) == row["content_hash"] and doc["epoch"]["id"] == row["id"] == result.get("epoch_id")
        and doc["checkpoint"]["id"] == row["checkpoint_id"] == result.get("checkpoint_id")
        and doc["monitor_run_id"] == row["monitor_run_id"] == result.get("monitor_run_id")
        and doc["observation_id"] == result.get("observation_id") and doc["job_id"] == job["id"]
        and result.get("status") == "epoch_registered_not_resumed" and result.get("live_advice_eligible") is False, "FINALIZATION_CHANGED")
    _check(instant(doc["created_at"]) <= instant(finished) < instant(doc["publication_deadline"]), "PUBLICATION_EXPIRED")
    _revision(db, job["scope"], doc["actor_id"], doc["workspace_revision"])
