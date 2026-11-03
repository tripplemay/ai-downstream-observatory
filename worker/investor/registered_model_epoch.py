"""Journal-authorized first-epoch replay; current permissions, recorded economics."""

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, instant, transaction
from . import model_epoch_source as source, model_epoch_registration as registration, managed_actions as managed
from .data_evidence import _fact_validation_scope, _owner, _object
from .evidence_monitor_runtime import _payload
from .evidence_observation import observation
from .model_runtime import _clock
from .monitor_bootstrap import _source_settings
from .monitor_costs import current_settings
from .planned_funding_source import read_bound_planned_funding_monitor


def _check(value, code="INVALID"):
    if not value: raise WorkbenchError("INVESTOR_REGISTERED_MODEL_EPOCH_" + code)


def read_registered_model_epoch(db, workspace, actor, epoch_id, *, now=None, stop_requested=None):
    """Only actual immutable journal IDs authorize this recorded-context path.

    Receipt authentication does not make cached derived data trustworthy. Rebuild
    every selected original source and the corrected first state before returning
    it, even when quotes are no longer fresh for a new current evaluation.
    """
    checked = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor); managed._stopped(db, stop_requested)
        row, record = registration._header(db, workspace, actor, epoch_id, "registration")
        _check(instant(row["created_at"]) <= instant(checked) < instant(row["valid_until"]), "SOURCE_EXPIRED")
        job = db.execute("SELECT * FROM job_runs WHERE id=?", (record["job_id"],)).fetchone()
        attempt = db.execute("SELECT * FROM job_attempts WHERE job_id=? AND attempt=?", (job["id"], job["attempt_count"])).fetchone()
        _check(attempt is not None and attempt["status"] == "succeeded" and attempt["fencing_token"] == job["fencing_token"]
            and instant(job["created_at"]) <= instant(attempt["started_at"]) <= instant(record["calculated_at"])
            and instant(record["created_at"]) <= instant(attempt["finished_at"]) < instant(record["publication_deadline"])
            and instant(attempt["finished_at"]) <= instant(checked), "JOB_CHANGED")
        _check(_object(job["result_json"]) == {"epoch_id": epoch_id, "monitor_run_id": record["monitor_run_id"], "observation_id": record["observation_id"],
            "checkpoint_id": record["checkpoint"]["id"], "status": "epoch_registered_not_resumed", "live_advice_eligible": False}, "JOB_CHANGED")
        for kind, key in (("checkpoint", "checkpoint_id"), ("run", "monitor_run_id")):
            _check(not db.execute("SELECT 1 FROM investor_monitor_payload_purges WHERE kind=? AND entity_id=?", (kind, row[key])).fetchone(), "PAYLOAD_PURGED")
        _, request = registration._header(db, workspace, actor, row["request_id"], "request")
        _, preview = registration._header(db, workspace, actor, request["preview"]["id"], "preview")
        epoch, document = preview["epoch_definition"], preview["input"]
        calculated, frozen = record["calculated_at"], document["created_at"]
        refs = [{key: entry[key] for key in ("correction_id", "confirmation_hash", "handover_id", "handover_hash")} for entry in epoch["binding"]["corrections"]]
        basis = source._correction_basis(db, workspace, actor, row["model_id"], refs, checked, frozen, stop_requested)
        control = db.execute("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? AND created_at<=? ORDER BY version DESC LIMIT 1", (workspace, row["model_id"], calculated)).fetchone()
        _check(control is not None and control["enabled"] == 1 and instant(control["created_at"]) <= instant(frozen)
            and {"id": control["id"], "content_hash": content_hash(dict(control))} == epoch["model_control"], "RECORDED_CONTROL_CHANGED")
        funding_row = db.execute("SELECT id,content_hash FROM investor_funding_plans WHERE workspace_id=? AND created_at<=? ORDER BY version DESC LIMIT 1", (workspace, calculated)).fetchone()
        binding = document.get("funding_binding")
        _check((funding_row is None) == (binding is None), "RECORDED_FUNDING_CHANGED")
        funding = None
        if binding:
            _check(funding_row["id"] == binding["funding_plan_id"] and funding_row["content_hash"] == binding["funding_plan_hash"], "RECORDED_FUNDING_CHANGED")
            funding = read_bound_planned_funding_monitor(db, workspace, actor, binding, evaluated_at=calculated, now=checked)
            original = read_bound_planned_funding_monitor(db, workspace, actor, binding, evaluated_at=frozen, now=checked)
            _check(funding["context_hash"] == original["context_hash"] == document["funding_context_hash"], "RECORDED_FUNDING_CHANGED")
        _check(instant(checked) < min(instant(basis["maximum"]), instant(epoch["valid_until"]))
            and instant(epoch["valid_until"]) <= instant(basis["original_maximum"]), "SOURCE_EXPIRED")
        _check(basis["history"]["proof"]["head_checkpoint_id"] == epoch["original_head_id"], "ORIGINAL_HEAD_CHANGED")
        basis.update(control=epoch["model_control"], funding=funding)
        # Only the fee selection clock is historical. The research/reference and
        # raw dataset readers still receive checked, never frozen/calculated.
        settings = current_settings(db, workspace, basis["definition"], _source_settings(db, workspace, basis["model"], basis["definition"], basis["reference"], checked), frozen)
        raw = source.resolve_monitor_data(db, workspace, basis["definition"], source.audited_epoch_input(document), now=checked, evaluated_at=calculated)
        _check(raw["unavailable_reason"] is None, raw["unavailable_reason"] or "SOURCE_INVALID")
        prepared = source._assemble_evidence(db, workspace, actor, epoch_id, basis, raw, checked, frozen, calculated, settings, epoch["valid_until"])
        _check(prepared["epoch_definition"] == epoch and prepared["input"] == document and prepared["proof"] == record["source_proof"], "DERIVATION_CHANGED")
        result = prepared["candidate"]; checkpoint = result["checkpoint"]
        # Recompute all economics with this verifier. The historical implementation
        # hash is authenticated receipt metadata, not a claim to execute old code.
        assessment = {key: value for key, value in result["assessment"].items() if key != "result_hash"}
        assessment["implementation_hash"] = record["implementation_hash"]; assessment["result_hash"] = content_hash(assessment)
        result["assessment"] = assessment
        _check(checkpoint is not None and content_hash(checkpoint) == record["checkpoint"]["content_hash"], "CHECKPOINT_CHANGED")
        header = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?", (row["checkpoint_id"], workspace, row["model_id"])).fetchone()
        expected_expiry = min(document["valid_until"], epoch["valid_until"], db.execute("SELECT valid_until FROM investor_evidence_model_checkpoints WHERE id=?", (epoch["original_head_id"],)).fetchone()[0], key=instant)
        _check(header is not None and header["sequence"] == checkpoint["sequence"] and header["previous_hash"] == checkpoint["previous_hash"]
            and header["valid_until"] == row["valid_until"] == expected_expiry
            and _payload(db, "investor_evidence_checkpoint_payloads", "checkpoint_id", row["checkpoint_id"], 4194304) == checkpoint, "CHECKPOINT_CHANGED")
        rendered = observation(basis["definition"], {"input_version": content_hash(request["monitor_request"])}, result, None); rendered["monitoring"] = "paused"
        payload = {"assessment": result["assessment"], "observation": rendered}
        run = _object(db.execute("SELECT document_json FROM investor_evidence_monitor_runs WHERE id=?", (row["monitor_run_id"],)).fetchone()[0])
        _check(_payload(db, "investor_evidence_run_payloads", "run_id", row["monitor_run_id"], 1048576) == payload
            and run["payload_hash"] == content_hash(payload) and run["observation_hash"] == content_hash(rendered)
            and run["assessment_hash"] == result["assessment"]["result_hash"] and run["reason_codes"] == result["assessment"]["reason_codes"]
            and result["assessment"]["implementation_hash"] == record["implementation_hash"], "RUN_CHANGED")
        obs = db.execute("SELECT * FROM investor_observations WHERE id=? AND workspace_id=?", (record["observation_id"], workspace)).fetchone()
        expected_ref = {"schema_version": "investor-model-observation-ref-v1", "run_id": row["monitor_run_id"], "outcome": rendered["outcome"],
            "profile_id": basis["definition"]["profile_id"], "profile_version": basis["definition"]["profile_version"], "input_version": run["input_version"], "published_at": record["created_at"]}
        _check(obs is not None and _object(obs["document_json"]) == expected_ref and obs["content_hash"] == content_hash(expected_ref)
            and obs["outcome"] == rendered["outcome"] and obs["input_version"] == run["input_version"] and obs["created_at"] == record["created_at"]
            and obs["profile_id"] == basis["definition"]["profile_id"] and obs["candidate_plan_id"] == basis["definition"]["plan_id"], "OBSERVATION_CHANGED")
        proof = {"schema_version": "investor-model-epoch-replay-proof-v1", "workspace_id": workspace, "actor_id": actor, "model_id": row["model_id"],
            "epoch": record["epoch"], "registration_hash": row["content_hash"], "input": record["input"], "checkpoint": record["checkpoint"],
            "checked_at": checked, "evaluated_at": calculated, "read_valid_until": min(row["valid_until"], basis["maximum"], key=instant),
            "status": "registered_first_state_replayed_paused", "registered_bindings_verified": True, "source_evidence_verified": True, "checkpoint_replayed": True,
            "current_source_eligibility_restored": False, "monitoring_resumed": False, "trading_permission": False, "database_writes": 0, "provider_calls": 0, "distribution": "private_owner_only_not_ai"}
        validate_contract(proof, registration.SCHEMA, fragment="$defs/replay_proof")
        managed._stopped(db, stop_requested)
        return {"registration": record, "source": prepared, "proof": proof, "observation": rendered}
