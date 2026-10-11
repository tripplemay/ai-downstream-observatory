"""Read current or frozen private-plan versions without changing financial facts."""

import re

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, instant, transaction
from .data_evidence import _owner
from .funding_plan import funding_timeline
from .model_runtime import _sealed
from .monitor_admission import current_monitor_model
from .model_contracts import definition_basis, definition_schema, validate_definition
from .planned_funding_monitor import CONTRACT, planned_funding_context_hash, project_planned_funding_monitor
from .runtime import _json, _milliseconds


def _check(value):
    if not value:
        raise WorkbenchError("INVESTOR_PLANNED_FUNDING_SOURCE_INVALID")


def read_bound_planned_funding_monitor(db, workspace_id, actor_id, binding, *, evaluated_at, now=None):
    """Replay a specified version; current model/source admission is a separate gate.

    Later plans, profile changes and a paused model must not rewrite old calendar
    assumptions. This reader does not make an old market result currently usable.
    """
    try:
        validate_contract(binding, CONTRACT, fragment="$defs/binding")
        validate_contract(evaluated_at, CONTRACT, fragment="$defs/instant")
        if now is not None:
            validate_contract(now, CONTRACT, fragment="$defs/instant")
        at, checked = _milliseconds(evaluated_at), _milliseconds(now)
    except ValueError:
        raise WorkbenchError("INVESTOR_PLANNED_FUNDING_SOURCE_INVALID") from None
    _check(instant(at) <= instant(checked))
    with transaction(db, immediate=False):
        _owner(db, workspace_id, actor_id)
        ws = db.execute("SELECT * FROM investor_workspaces WHERE id=?", (workspace_id,)).fetchone()
        model = db.execute("SELECT * FROM investor_models WHERE workspace_id=? AND id=?", (workspace_id, binding["model_id"])).fetchone()
        _check(model is not None and model["content_hash"] == binding["model_hash"] and model["created_at"] == binding["model_created_at"])
        definition = _sealed(model, definition_schema(_json(model["document_json"])))
        validate_definition(definition)
        _check(definition["model_id"] == model["id"] and definition["profile_id"] == model["profile_id"]
            and definition["plan_id"] == model["plan_id"] and definition["created_at"] == model["created_at"]
            and definition["profile_hash"] == binding["profile_hash"] and definition["data_mode"] == "reconstructed"
            and definition["target_definition_hash"] == content_hash(definition_basis(definition))
            and instant(model["created_at"]) <= instant(at))
        row = db.execute("SELECT * FROM investor_funding_plans WHERE workspace_id=? AND id=?", (workspace_id, binding["funding_plan_id"])).fetchone()
        _check(row is not None and row["content_hash"] == binding["funding_plan_hash"] and row["created_at"] == binding["plan_declared_at"])
        history = db.execute("SELECT count(*),max(created_at) FROM investor_funding_plans WHERE workspace_id=? AND version<=?",
            (workspace_id, row["version"])).fetchone()
        _check(history[0] == row["version"] and history[1] == row["created_at"] and row["actor_id"] == actor_id
            and row["profile_id"] == model["profile_id"] and row["profile_hash"] == definition["profile_hash"]
            and instant(row["created_at"]) <= instant(at))
        plan = _sealed(row, "investor-funding-plan.schema.json")
        funding_timeline(plan)
        profile = db.execute("SELECT * FROM investor_profiles WHERE id=? AND workspace_id=?", (row["profile_id"], workspace_id)).fetchone()
        _check(profile is not None and instant(profile["created_at"]) <= instant(row["created_at"]))
        preferences = _sealed(profile, "investor-profile.schema.json")
        _check(profile["content_hash"] == row["profile_hash"] and profile["version"] == definition["profile_version"]
            and plan["horizon_years"] <= preferences["horizon_years"])
        event = db.execute("SELECT * FROM audit_events WHERE id=?", (row["audit_id"],)).fetchone()
        _check(event is not None and event["actor_id"] == actor_id and event["action"] == "investor_save_funding_plan"
            and event["object_type"] == "investor_workspace" and event["object_id"] == workspace_id
            and event["portfolio_id"] is None and event["ledger_revision"] is None and event["created_at"] == row["created_at"])
        audit = _json(event["payload_json"])
        _check(isinstance(audit, dict) and set(audit) == {"input", "result"})
        command = audit["input"]
        _check(isinstance(command, dict) and set(command) == {"action", "expected_revision", "idempotency_key", "funding_plan"}
            and command["action"] == "save_funding_plan" and content_hash(command["funding_plan"]) == content_hash(plan)
            and type(command["expected_revision"]) is int and 0 <= command["expected_revision"] < ws["revision"]
            and isinstance(command["idempotency_key"], str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", command["idempotency_key"])
            and content_hash(audit["result"]) == content_hash({"funding_plan_id": row["id"], "version": row["version"], "profile_id": row["profile_id"],
                "profile_hash": row["profile_hash"], "actual_arrivals_confirmed": False, "execution_authorized": False}))
        request = {"schema_version": "investor-planned-funding-monitor-v1", "funding_plan": plan,
            "binding": {"funding_plan_id": row["id"], "funding_plan_hash": row["content_hash"], "profile_hash": row["profile_hash"],
                "model_id": model["id"], "model_hash": model["content_hash"], "model_created_at": model["created_at"], "plan_declared_at": row["created_at"]},
            "evaluated_at": at}
        _check(request["binding"] == binding)
        return {"request": request, "projection": project_planned_funding_monitor(request), "context_hash": planned_funding_context_hash(request)}


def read_planned_funding_monitor(db, workspace_id, actor_id, model_id, *, now=None):
    at = _milliseconds(now)
    with transaction(db, immediate=False):
        _owner(db, workspace_id, actor_id)
        model, definition, _ = current_monitor_model(db, workspace_id, model_id, at)
        selected = db.execute("SELECT created_at FROM investor_plan_selections WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", (workspace_id,)).fetchone()
        _check(selected is not None and instant(selected["created_at"]) <= instant(at))
        control = db.execute("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1",
            (workspace_id, model_id)).fetchone()
        _check(control is not None and control["enabled"] == 1 and instant(control["created_at"]) <= instant(at))
        row = db.execute("SELECT * FROM investor_funding_plans WHERE workspace_id=? ORDER BY version DESC LIMIT 1", (workspace_id,)).fetchone()
        if row is None:
            return None
        binding = {"funding_plan_id": row["id"], "funding_plan_hash": row["content_hash"], "profile_hash": definition["profile_hash"],
            "model_id": model_id, "model_hash": model["content_hash"], "model_created_at": model["created_at"], "plan_declared_at": row["created_at"]}
        return read_bound_planned_funding_monitor(db, workspace_id, actor_id, binding, evaluated_at=at, now=at)
