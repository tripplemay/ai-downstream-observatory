"""Scoped metadata admission; never copy quotes, enable a model or trade."""

from worker.market.contracts import validate_contract
from worker.orchestration.db import canonical_json, content_hash, instant, new_id, transaction
from .data_evidence import _assert, _audit, _audit_binding, _object, _owner
from .model_runtime import _sealed
from .monitor_data import build_monitor_data, check_reference_listing_identity, resolve_monitor_data, validate_monitor_data_document
from .reference_plan import reference_source_current
from .runtime import _milliseconds
from .source_inputs import source_unavailable_reason
from .fixed_policy import SUFFIX, MONITOR_GAP
from .model_contracts import definition_schema, reference_schema, validate_definition, definition_basis


def current_monitor_model(db, workspace_id, model_id, checked):
    row = db.execute("SELECT * FROM investor_models WHERE id=? AND workspace_id=?", (model_id, workspace_id)).fetchone()
    _assert(row is not None, "INVESTOR_DATA_OUT_OF_SCOPE")
    definition = _sealed(row, definition_schema(_object(row["document_json"]))); validate_definition(definition)
    latest = db.execute("SELECT * FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1", (workspace_id,)).fetchone()
    selected = db.execute("SELECT plan_id FROM investor_plan_selections WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", (workspace_id,)).fetchone()
    plan = db.execute("SELECT * FROM investor_reference_plans WHERE id=? AND workspace_id=?", (row["plan_id"], workspace_id)).fetchone()
    _assert(plan is not None and latest is not None and selected is not None, "INVESTOR_DATA_MODEL_NOT_CURRENT")
    _sealed(latest, "investor-profile.schema.json")
    reference = _sealed(plan, reference_schema(_object(plan["document_json"])))
    _assert(latest["id"] == row["profile_id"] and selected[0] == row["plan_id"]
        and definition["model_id"] == row["id"] and definition["profile_id"] == row["profile_id"] and definition["plan_id"] == row["plan_id"]
        and definition["created_at"] == row["created_at"] and definition["profile_version"] == latest["version"]
        and definition["profile_hash"] == latest["content_hash"] and definition["plan_hash"] == plan["content_hash"]
        and reference["profile_id"] == row["profile_id"] and reference["data_mode"] == "reconstructed"
        and definition["valid_until"] == reference["valid_until"]
        and definition["targets"] == [{key: target[key] for key in ("listing_id", "market", "currency", "weight")} for target in reference["targets"]]
        and definition["data_mode"] == "reconstructed" and instant(row["created_at"]) <= instant(checked) < instant(definition["valid_until"])
        and latest["created_at"] <= checked and plan["created_at"] <= checked
        and reference_source_current(db, workspace_id, row["plan_id"], checked), "INVESTOR_DATA_MODEL_NOT_CURRENT")
    fixed = definition["schema_version"] == "investor-model-definition-v2"
    _assert(definition["target_definition_hash"] == content_hash(definition_basis(definition))
        and fixed == (reference["schema_version"] == "investor-reference-plan-v2")
        and (not fixed or definition["fixed_policy"] == reference["fixed_policy"]), "INVESTOR_DATA_MODEL_NOT_CURRENT")
    _assert(not reference["strategy_version"].endswith(SUFFIX) or fixed, MONITOR_GAP)
    return row, definition, reference


def latest_monitor_evidence(db, workspace_id, model_id):
    return db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE workspace_id=? AND model_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", (workspace_id, model_id)).fetchone()


def monitor_evidence_document(db, workspace_id, model_id, input_id, checked):
    row = db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE id=? AND workspace_id=? AND model_id=?", (input_id, workspace_id, model_id)).fetchone()
    _assert(row is not None, "INVESTOR_DATA_OUT_OF_SCOPE")
    document = _object(row["document_json"])
    validate_monitor_data_document(document)
    _assert(content_hash(document) == row["content_hash"] and document["created_at"] == row["created_at"] <= checked
        and document["valid_until"] == row["valid_until"] and document["workspace_id"] == workspace_id and document["model_id"] == model_id
        and document["source_qualification"] == row["source_qualification"] == "owner_reviewed_reconstructed")
    _owner(db, workspace_id, row["actor_id"])
    _audit_binding(db, row, "investor_admit_monitor_source", "investor_monitor_evidence_input", input_id)
    return row, document


def admit_monitor_data(db, workspace_id, actor_id, model_id, windows, settings, *, now=None, audited_action_knowledge=False):
    _owner(db, workspace_id, actor_id)
    checked = _milliseconds(now)
    _, definition, reference = current_monitor_model(db, workspace_id, model_id, checked)
    candidate = build_monitor_data(db, workspace_id, definition, windows, settings, now=checked, audited_action_knowledge=audited_action_knowledge)
    check_reference_listing_identity(reference["targets"], candidate["catalog"])
    _assert(not candidate["projection"]["quality_gaps"] and candidate["projection"]["valid_until"] > checked, "INVESTOR_DATA_MONITOR_INPUTS_NOT_CURRENT")
    document, digest = candidate["document"], candidate["content_hash"]
    encoded = canonical_json(document)
    _assert(len(encoded.encode()) <= 1048576, "INVESTOR_DATA_ADMISSION_LIMIT")
    with transaction(db):
        _owner(db, workspace_id, actor_id)
        current = _milliseconds(now)
        _, rebound, reference = current_monitor_model(db, workspace_id, model_id, current)
        _assert(rebound == definition and candidate["projection"]["valid_until"] > current, "INVESTOR_DATA_MODEL_NOT_CURRENT")
        rebuilt = resolve_monitor_data(db, workspace_id, rebound, document, now=current)
        _assert(rebuilt["unavailable_reason"] is None, rebuilt["unavailable_reason"] or "INVESTOR_DATA_EVIDENCE_INVALID")
        check_reference_listing_identity(reference["targets"], rebuilt["catalog"])
        current = _milliseconds(now)
        _assert(rebuilt["projection"]["valid_until"] > current, "INVESTOR_DATA_MONITOR_INPUTS_NOT_CURRENT")
        for segment in document["segments"]:
            reason = source_unavailable_reason(db, workspace_id, {"snapshot": segment["snapshot"], "valid_until": document["valid_until"]}, current)
            _assert(reason is None, reason or "INVESTOR_DATA_EVIDENCE_INVALID")
        previous = latest_monitor_evidence(db, workspace_id, model_id)
        if previous:
            _, prior = monitor_evidence_document(db, workspace_id, model_id, previous["id"], current)
            signature = lambda value: {"target": value["target_definition_hash"], "settings": value["settings"], "valid_until": value["valid_until"],
                "windows": [{key: entry for key, entry in row["snapshot"].items() if key != "created_at"} for row in value["segments"]]}
            if signature(prior) == signature(document):
                replay = resolve_monitor_data(db, workspace_id, definition, prior, now=current)
                if replay["unavailable_reason"] is None:
                    return dict(previous)
        identifier = new_id("monitor-evidence-input")
        audit = _audit(db, actor_id, "investor_admit_monitor_source", "investor_monitor_evidence_input", identifier, {"content_hash": digest}, checked)
        db.execute("INSERT INTO investor_monitor_evidence_inputs(id,workspace_id,model_id,source_qualification,document_json,content_hash,actor_id,created_at,valid_until,audit_id) VALUES(?,?,?,'owner_reviewed_reconstructed',?,?,?,?,?,?)",
            (identifier, workspace_id, model_id, encoded, digest, actor_id, checked, document["valid_until"], audit))
        db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (workspace_id,))
        return dict(db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE id=?", (identifier,)).fetchone())
