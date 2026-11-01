"""Explicit research-cost assumptions; no inferred broker tariff or trade authority."""

from copy import deepcopy
from datetime import timedelta

from worker.market.contracts import validate_contract
from worker.orchestration.db import canonical_json, content_hash, instant, transaction
from worker.orchestration.jobs import enqueue_notification
from .data_evidence import _assert, _audit, _audit_binding, _object, _owner
from .model_runtime import _clock
from .monitor import _cost_rates


SCHEMA = "investor-monitor-costs.schema.json"


def _record(db, workspace, model, definition, row, at):
    _assert(row is not None, "INVESTOR_MONITOR_COSTS_INVALID")
    doc = _object(row["document_json"])
    validate_contract(doc, SCHEMA, fragment="$defs/record")
    _owner(db, workspace, row["actor_id"])
    _audit_binding(db, row, "investor_set_monitor_costs", "investor_monitor_cost_assumptions", row["id"])
    _assert(canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"] and doc["workspace_id"] == row["workspace_id"] == workspace
        and doc["model_id"] == row["model_id"] == model["id"] and doc["model_hash"] == model["content_hash"]
        and doc["profile_hash"] == definition["profile_hash"] and doc["plan_hash"] == definition["plan_hash"]
        and doc["version"] == row["version"] and model["created_at"] <= row["created_at"] == doc["created_at"] <= at
        and doc["effective_from"] == row["effective_from"] == _clock(instant(row["created_at"]) + timedelta(milliseconds=1))
        and doc["valid_until"] == row["valid_until"])
    _cost_rates(doc["costs"])
    if doc["costs"] is not None:
        values = {key: value for key, value in doc["costs"].items() if key != "assumption_hash"}
        _assert(doc["costs"]["assumption_hash"] == content_hash({"schema_version": "investor-owner-monitor-cost-values-v1", **values}))
    _assert(doc["costs"] is None and doc["valid_until"] is None or doc["costs"] is not None
        and doc["effective_from"] < doc["valid_until"] <= definition["valid_until"])
    return doc


def policy_at(db, workspace, definition, at):
    head = db.execute("SELECT * FROM investor_monitor_cost_assumptions WHERE workspace_id=? AND model_id=? AND effective_from<=? ORDER BY version DESC LIMIT 1",
        (workspace, definition["model_id"], at)).fetchone()
    if head is None: return None
    model = db.execute("SELECT * FROM investor_models WHERE id=? AND workspace_id=?", (definition["model_id"], workspace)).fetchone()
    _assert(model is not None and content_hash(definition) == model["content_hash"])
    rows = db.execute("SELECT * FROM investor_monitor_cost_assumptions WHERE model_id=? AND workspace_id=? AND version<=? ORDER BY version",
        (model["id"], workspace, head["version"])).fetchall()
    _assert(1 <= len(rows) == head["version"] <= 1000)
    previous = None
    for index, row in enumerate(rows, 1):
        doc = _record(db, workspace, model, definition, row, at)
        _assert(row["version"] == index and (previous is None or previous["effective_from"] <= row["created_at"]))
        previous = row
    known = doc["costs"] is not None and at < doc["valid_until"]
    return {"row": dict(head), "document": doc, "binding": {"id": head["id"], "content_hash": head["content_hash"]},
        "costs": doc["costs"] if known else None, "deadline": doc["valid_until"] if known else None}


def current_settings(db, workspace, definition, settings, at):
    selected = policy_at(db, workspace, definition, at)
    value = deepcopy(settings)
    if selected is not None:
        value["cost_assumptions"] = selected["binding"]
        value["policy"]["costs"] = deepcopy(selected["costs"])
    else:
        _assert("cost_assumptions" not in value, "INVESTOR_MONITOR_COSTS_INVALID")
    return value


def verify_settings(db, workspace, definition, settings, at):
    selected = policy_at(db, workspace, definition, at)
    if selected is None:
        _assert("cost_assumptions" not in settings, "INVESTOR_MONITOR_COSTS_INVALID")
        return None
    _assert(settings.get("cost_assumptions") == selected["binding"] and settings["policy"]["costs"] == selected["costs"],
        "INVESTOR_MONITOR_COSTS_CHANGED")
    return selected["deadline"]


def refresh_cost_inputs(db, *, limit=100, now=None, stop_requested=None):
    from .monitor_admission import admit_monitor_data, current_monitor_model, latest_monitor_evidence
    from .confirmed_feed import _windows
    from .monitor_data import resolve_monitor_data
    from worker.orchestration.db import WorkbenchError
    _assert(type(limit) is int and 1 <= limit <= 1000); at = _clock(now); refreshed = []
    rows = db.execute("""SELECT m.* FROM investor_models m JOIN investor_model_controls c ON c.model_id=m.id AND c.workspace_id=m.workspace_id
      JOIN investor_monitor_cost_assumptions a ON a.model_id=m.id AND a.workspace_id=m.workspace_id
      JOIN investor_monitor_evidence_inputs i ON i.model_id=m.id AND i.workspace_id=m.workspace_id
      WHERE c.version=(SELECT max(version) FROM investor_model_controls WHERE model_id=m.id) AND c.enabled=1 AND c.created_at<=?
        AND a.version=(SELECT max(version) FROM investor_monitor_cost_assumptions WHERE model_id=m.id AND effective_from<=?)
        AND i.id=(SELECT id FROM investor_monitor_evidence_inputs WHERE model_id=m.id ORDER BY created_at DESC,rowid DESC LIMIT 1)
        AND (json_extract(i.document_json,'$.settings.cost_assumptions.id') IS NOT a.id
          OR json_extract(i.document_json,'$.settings.cost_assumptions.content_hash') IS NOT a.content_hash
          OR json(json_extract(i.document_json,'$.settings.policy.costs')) IS NOT
            CASE WHEN a.valid_until>? THEN json(json_extract(a.document_json,'$.costs')) ELSE NULL END)
      ORDER BY m.created_at,m.id LIMIT ?""", (at, at, at, limit)).fetchall()
    for model in rows:
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        try:
            with transaction(db):
                _, definition, _ = current_monitor_model(db, model["workspace_id"], model["id"], at)
                head = latest_monitor_evidence(db, model["workspace_id"], model["id"])
                old = _object(head["document_json"])
                settings = current_settings(db, model["workspace_id"], definition, old["settings"], at)
                if settings == old["settings"]: continue
                original = resolve_monitor_data(db, model["workspace_id"], definition, old, now=at, evaluated_at=old["created_at"])
                _assert(original["unavailable_reason"] is None)
                actor = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (model["workspace_id"],)).fetchone()[0]
                knowledge = {"audited_action_knowledge": True} if old["schema_version"] == "investor-monitor-data-input-v4" else {}
                admitted = admit_monitor_data(db, model["workspace_id"], actor, model["id"],
                    [window for _, window in _windows(db, model["workspace_id"], old)], settings, now=at, **knowledge)
                _audit(db, actor, "investor_apply_monitor_costs", "investor_monitor_evidence_input", admitted["id"],
                    {"content_hash": admitted["content_hash"], "previous_input_id": head["id"], "previous_input_hash": head["content_hash"],
                        "cost_assumptions": settings["cost_assumptions"], "execution_authorized": False}, at)
                if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
                refreshed.append(admitted["id"])
        except ValueError as error:
            if str(error) in ("WORKER_STOP_REQUESTED", "WORKBENCH_READ_ONLY", "RESTORE_PENDING_REVIEW"): raise
            enqueue_notification(db, "monitor-cost-gap:" + model["id"], "investor.monitor_cost_gap",
                {"workspace_id": model["workspace_id"], "model_id": model["id"], "code": "MONITOR_COST_INPUT_NOT_READY"}, now=at)
    return refreshed
