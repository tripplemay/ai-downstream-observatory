"""Receipt-qualified research monitoring; fenced metadata and removable derivatives."""

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, enqueue_job, enqueue_notification
from .data_evidence import _assert, _object, _owner, _audit
from .evidence_observation import blocked_observation, observation
from .implementation import implementation_hash
from .model_runtime import _clock, _latest, _next_poll, _period, _sealed
from .model_state import advance_evidence_model
from .monitor_admission import current_monitor_model, latest_monitor_evidence, monitor_evidence_document
from .fixed_policy import MONITOR_GAP
from .monitor_data import resolve_monitor_data
from .model_contracts import definition_schema
from .planned_funding_source import read_bound_planned_funding_monitor, read_planned_funding_monitor


JOB_TYPE = "investor_evidence_monitor"
ENGINE_VERSION = "investor-evidence-model-watcher-v2"
FIXED_ENGINE_VERSION = "investor-evidence-model-watcher-v3"
FUNDING_ENGINE_VERSION = "investor-evidence-model-watcher-v4"
SCHEMA = "investor-evidence-monitor.schema.json"
BLOCKED_TRANSITIONS = {
    "INVESTOR_MODEL_ACTION_RESTATEMENT_REQUIRED": "MONITOR_ACTION_RESTATEMENT_REQUIRED",
    "INVESTOR_MODEL_DIVIDEND_ENTITLEMENT_UNKNOWN": "MONITOR_ACTION_RESTATEMENT_REQUIRED",
    "INVESTOR_MODEL_CHECKPOINT_LIMIT_REQUIRES_RESTART": "MONITOR_CHECKPOINT_LIMIT_REQUIRES_RESTART",
}


def _validate_request(value):
    if value.get("schema_version") == "investor-evidence-monitor-request-v2":
        validate_contract(value, "investor-evidence-monitor-request-v2.schema.json")
    else:
        validate_contract(value, SCHEMA, fragment="$defs/request")


def _funding_at(db, workspace, binding, evaluated, checked):
    owner = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (workspace,)).fetchone()
    _assert(owner is not None)
    return read_bound_planned_funding_monitor(db, workspace, owner[0], binding, evaluated_at=evaluated, now=checked)


def _payload(db, table, key, identifier, maximum):
    row = db.execute("SELECT payload FROM " + table + " WHERE " + key + "=?", (identifier,)).fetchone()
    _assert(row is not None and isinstance(row[0], bytes) and 0 < len(row[0]) <= maximum)
    value = _object(row[0]); _assert(canonical_json(value).encode() == row[0])
    return value


def resolve_checkpoint(db, workspace, definition, checkpoint_id, now):
    if checkpoint_id is None: return None, None
    head = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?", (checkpoint_id, workspace, definition["model_id"])).fetchone()
    _assert(head is not None and 1 <= head["sequence"] <= 1000)
    headers = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? AND sequence<=? ORDER BY sequence", (workspace, definition["model_id"], head["sequence"])).fetchall()
    _assert(len(headers) == head["sequence"])
    previous = None
    expiry = definition["valid_until"]
    for index, header in enumerate(headers, 1):
        _assert(header["sequence"] == index and header["previous_hash"] == (content_hash(previous) if previous else None) and header["created_at"] <= now)
        if header["valid_until"] <= now: return None, "MONITOR_CHECKPOINT_SOURCE_EXPIRED"
        if db.execute("SELECT 1 FROM investor_monitor_payload_purges WHERE kind='checkpoint' AND entity_id=?", (header["id"],)).fetchone():
            return None, "MONITOR_CHECKPOINT_PAYLOAD_PURGED"
        row, document = monitor_evidence_document(db, workspace, definition["model_id"], header["input_id"], now)
        expiry = min(expiry, document["valid_until"])
        _assert(header["valid_until"] == expiry)
        from .action_checkpoint_replay import replay_checkpoint_monitor_source
        source = replay_checkpoint_monitor_source(db, workspace, definition, header, document, now)
        if source["unavailable_reason"]: return None, source["unavailable_reason"]
        from .monitor_costs import verify_settings
        verify_settings(db, workspace, definition, document["settings"], header["created_at"])
        stored = _payload(db, "investor_evidence_checkpoint_payloads", "checkpoint_id", header["id"], 4194304)
        funding = _funding_at(db, workspace, stored["funding_binding"], header["created_at"], now) if stored.get("schema_version") == "investor-evidence-model-checkpoint-v3" else None
        replay = advance_evidence_model(definition, source["projection"], previous, header["created_at"], input_hash=row["content_hash"],
            planned_funding=funding["request"] if funding else None)
        _assert(replay["checkpoint"] == stored and content_hash(stored) == header["content_hash"]
            and stored["projection_hash"] == header["projection_hash"] and stored["sequence"] == header["sequence"])
        previous = stored
    return previous, None


def _request_document(model, definition, control, source, previous, engine_version, funding=None):
    return {"schema_version": "investor-evidence-monitor-request-v2" if funding else "investor-evidence-monitor-request-v1", "engine_version": engine_version,
        "model_hash": model["content_hash"], "profile_hash": definition["profile_hash"], "control_id": control["id"],
        "input_hash": source["content_hash"], "checkpoint_hash": previous["content_hash"] if previous else None,
        **({"funding_binding": funding["request"]["binding"], "funding_context_hash": funding["context_hash"]} if funding else {})}


def discover_evidence_monitor_requests(db, *, limit=100, now=None):
    _assert(type(limit) is int and 1 <= limit <= 1000)
    at = _clock(now)
    with transaction(db):
        models = db.execute("""SELECT m.* FROM investor_models m JOIN investor_model_controls c ON c.model_id=m.id
          WHERE c.version=(SELECT MAX(version) FROM investor_model_controls WHERE model_id=m.id) AND c.enabled=1
          AND m.profile_id=(SELECT id FROM investor_profiles WHERE workspace_id=m.workspace_id ORDER BY version DESC LIMIT 1)
          AND m.plan_id=(SELECT plan_id FROM investor_plan_selections WHERE workspace_id=m.workspace_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
          AND json_extract(m.document_json,'$.data_mode')='reconstructed' AND json_extract(m.document_json,'$.valid_until')>?
          AND EXISTS(SELECT 1 FROM investor_monitor_evidence_inputs WHERE model_id=m.id)
          ORDER BY COALESCE((SELECT MAX(created_at) FROM investor_evidence_monitor_requests WHERE model_id=m.id),'') ASC,m.id LIMIT ?""", (at, limit)).fetchall()
        for model in models:
            try: _, definition, _ = current_monitor_model(db, model["workspace_id"], model["id"], at)
            except WorkbenchError as error:
                if str(error) in ("INVESTOR_DATA_MODEL_NOT_CURRENT", MONITOR_GAP): continue
                raise
            control = _latest(db, "investor_model_controls", model["id"], "version DESC")
            source = latest_monitor_evidence(db, model["workspace_id"], model["id"])
            _assert(control["enabled"] == 1 and control["created_at"] <= at and source["created_at"] <= at)
            previous = _latest(db, "investor_evidence_model_checkpoints", model["id"], "sequence DESC")
            _, document = monitor_evidence_document(db, model["workspace_id"], model["id"], source["id"], at)
            from .monitor_costs import current_settings
            try:
                if current_settings(db, model["workspace_id"], definition, document["settings"], at) != document["settings"]: continue
            except ValueError: continue
            projected = resolve_monitor_data(db, model["workspace_id"], definition, document, now=at)
            owner = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (model["workspace_id"],)).fetchone()
            try: funding = read_planned_funding_monitor(db, model["workspace_id"], owner[0], model["id"], now=at)
            except ValueError: continue
            period = "awaiting-evidence" if projected["unavailable_reason"] else _period(at)
            if funding and funding["projection"]["status"] == "expired": period = "awaiting-funding"
            engine = FUNDING_ENGINE_VERSION if funding else FIXED_ENGINE_VERSION if definition["schema_version"] == "investor-model-definition-v2" else ENGINE_VERSION
            key = content_hash({"model_hash": model["content_hash"], "control_id": control["id"], "input_id": source["id"], "engine_version": engine,
                **({"funding_context_hash": funding["context_hash"]} if funding else {})})
            if db.execute("SELECT 1 FROM investor_evidence_monitor_requests WHERE model_id=? AND period=? AND request_key=?", (model["id"], period, key)).fetchone(): continue
            request = _request_document(model, definition, control, source, previous, engine, funding); _validate_request(request)
            db.execute("INSERT INTO investor_evidence_monitor_requests(id,workspace_id,model_id,control_id,input_id,checkpoint_id,period,request_key,input_version,document_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (new_id("evidence-monitor-request"), model["workspace_id"], model["id"], control["id"], source["id"], previous["id"] if previous else None,
                period, key, content_hash(request), canonical_json(request), at))
        pending = db.execute("""SELECT r.* FROM investor_evidence_monitor_requests r LEFT JOIN job_runs j ON j.job_type=?
          AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.input_version
          WHERE j.id IS NULL ORDER BY r.created_at,r.rowid LIMIT ?""", (JOB_TYPE, limit)).fetchall()
        return [enqueue_job(db, JOB_TYPE, row["workspace_id"], row["id"], row["input_version"], max_attempts=2, now=at) for row in pending]


def _binding(db, job, now):
    with transaction(db, immediate=False):
        request = db.execute("SELECT * FROM investor_evidence_monitor_requests WHERE id=? AND workspace_id=?", (job["period"], job["scope"])).fetchone()
        _assert(request is not None and job["job_type"] == JOB_TYPE and job["command_request_id"] is None and job["input_version"] == request["input_version"])
        model = db.execute("SELECT * FROM investor_models WHERE id=? AND workspace_id=?", (request["model_id"], job["scope"])).fetchone()
        _assert(model is not None); definition = _sealed(model, definition_schema(_object(model["document_json"])))
        control = db.execute("SELECT * FROM investor_model_controls WHERE id=? AND model_id=? AND workspace_id=?", (request["control_id"], model["id"], job["scope"])).fetchone()
        source, document = monitor_evidence_document(db, job["scope"], model["id"], request["input_id"], now)
        previous = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND model_id=? AND workspace_id=?", (request["checkpoint_id"], model["id"], job["scope"])).fetchone()
        _assert(control is not None and (previous is None) == (request["checkpoint_id"] is None)
            and all(row["created_at"] <= request["created_at"] <= now for row in (model, control, source, previous) if row))
        stored_request = _object(request["document_json"]); _validate_request(stored_request)
        funded = stored_request["engine_version"] == FUNDING_ENGINE_VERSION
        _assert(funded or (definition["schema_version"] == "investor-model-definition-v2") == (stored_request["engine_version"] == FIXED_ENGINE_VERSION))
        original_funding = _funding_at(db, job["scope"], stored_request["funding_binding"], request["created_at"], now) if funded else None
        bound = _request_document(model, definition, control, source, previous, stored_request["engine_version"], original_funding)
        _assert(_object(request["document_json"]) == bound and content_hash(bound) == request["input_version"])
        current_control = _latest(db, "investor_model_controls", model["id"], "version DESC")
        current_source = latest_monitor_evidence(db, job["scope"], model["id"])
        current_checkpoint = _latest(db, "investor_evidence_model_checkpoints", model["id"], "sequence DESC")
        current = current_control["id"] == control["id"] and control["enabled"] == 1 and current_source["id"] == source["id"]
        current = current and (current_checkpoint["id"] if current_checkpoint else None) == request["checkpoint_id"]
        if current:
            from .monitor_costs import current_settings
            try: current = current_settings(db, job["scope"], definition, document["settings"], now) == document["settings"]
            except ValueError: current = False
        latest_funding = db.execute("SELECT id,content_hash FROM investor_funding_plans WHERE workspace_id=? ORDER BY version DESC LIMIT 1", (job["scope"],)).fetchone()
        funding = None
        if funded:
            current = current and latest_funding is not None and latest_funding["id"] == bound["funding_binding"]["funding_plan_id"] \
                and latest_funding["content_hash"] == bound["funding_binding"]["funding_plan_hash"]
            if current:
                funding = _funding_at(db, job["scope"], bound["funding_binding"], now, now)
                current = funding["context_hash"] == bound["funding_context_hash"]
        else:
            current = current and latest_funding is None
        try: current_monitor_model(db, job["scope"], model["id"], now)
        except WorkbenchError as error:
            if str(error) not in ("INVESTOR_DATA_MODEL_NOT_CURRENT", MONITOR_GAP): raise
            current = False
        projection, checkpoint, reason = None, None, None
        if current:
            rebuilt = resolve_monitor_data(db, job["scope"], definition, document, now=now)
            projection, reason = rebuilt["projection"], rebuilt["unavailable_reason"]
            if not reason: checkpoint, reason = resolve_checkpoint(db, job["scope"], definition, request["checkpoint_id"], now)
            if not reason and funding:
                if projection["funding_intent"] is not None: reason = "MONITOR_FUNDING_INTENTS_CONFLICT"
                elif funding["projection"]["status"] == "expired": reason = "MONITOR_FUNDING_PLAN_WINDOW_EXPIRED"
        expiry = min(document["valid_until"], definition["valid_until"], previous["valid_until"] if previous else definition["valid_until"])
        return request, definition, source, projection, checkpoint, previous, reason, current, expiry, funding


def prepare_evidence_monitor_job(db, job, lease, *, clock=None, stop_requested=None):
    clock = clock or (lambda: None)
    try:
        at = _clock(clock()); request, definition, source, projection, previous, previous_header, reason, current, expiry, funding = _binding(db, job, at)
        if not current: return {"result": {"code": "INVESTOR_MONITOR_SUPERSEDED", "live_advice_eligible": False}, "outcome": "skipped"}
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        implementation = implementation_hash()
        sparse = _object(request["document_json"])["engine_version"] in ("investor-evidence-model-watcher-v2", FIXED_ENGINE_VERSION, FUNDING_ENGINE_VERSION)
        result = None
        if not reason:
            try: result = advance_evidence_model(definition, projection, previous, at, input_hash=source["content_hash"], sparse=sparse,
                planned_funding=funding["request"] if funding else None)
            except WorkbenchError as error:
                if str(error) not in BLOCKED_TRANSITIONS: raise
                reason = BLOCKED_TRANSITIONS[str(error)]
        codes = [reason] if reason else result["assessment"]["reason_codes"]
    except Exception:
        raise WorkbenchError("INVESTOR_EVIDENCE_MONITOR_PREPARATION_FAILED") from None

    def commit(connection):
        try:
            now = _clock(clock())
            rebound = _binding(connection, job, now)
            if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
            rebound_reason = rebound[6]
            if rebound[7] and not rebound_reason and reason in BLOCKED_TRANSITIONS.values():
                try: advance_evidence_model(definition, rebound[3], rebound[4], at, input_hash=source["content_hash"], sparse=sparse,
                    planned_funding=funding["request"] if funding else None)
                except WorkbenchError as error:
                    if str(error) not in BLOCKED_TRANSITIONS: raise
                    rebound_reason = BLOCKED_TRANSITIONS[str(error)]
            if not rebound[7] or rebound_reason != reason or implementation_hash() != implementation:
                return JobCommit({"code": "INVESTOR_MONITOR_SUPERSEDED", "live_advice_eligible": False}, "skipped")
            if result and (result["assessment"]["next_review_at"] is None or instant(result["assessment"]["next_review_at"]) <= instant(now) or expiry <= now):
                return JobCommit({"code": "INVESTOR_MONITOR_SUPERSEDED", "live_advice_eligible": False}, "skipped")
            if result and funding and funding["projection"]["valid_until"] <= now:
                return JobCommit({"code": "INVESTOR_MONITOR_SUPERSEDED", "live_advice_eligible": False}, "skipped")
            checkpoint_id = None
            if result and result["checkpoint"] is not None:
                value = result["checkpoint"]
                if previous_header and content_hash(value) == previous_header["content_hash"]:
                    checkpoint_id = previous_header["id"]
                else:
                    checkpoint_id = new_id("evidence-model-checkpoint")
                    connection.execute("INSERT INTO investor_evidence_model_checkpoints(id,workspace_id,model_id,input_id,sequence,previous_hash,content_hash,projection_hash,created_at,valid_until) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (checkpoint_id, job["scope"], definition["model_id"], source["id"], value["sequence"], value["previous_hash"], content_hash(value), value["projection_hash"], value["created_at"], expiry))
                    connection.execute("INSERT INTO investor_evidence_checkpoint_payloads VALUES(?,?)", (checkpoint_id, canonical_json(value).encode()))
            next_check = min(_next_poll(now), definition["valid_until"], expiry, _clock(result["assessment"]["next_review_at"])) if result else None
            if next_check and funding: next_check = min(next_check, funding["projection"]["valid_until"])
            rendered = observation(definition, request, result, next_check) if result else blocked_observation(definition, request["input_version"], now, reason)
            # Calculation time and publication time are different evidence. Never
            # silently recalculate or move a computed result's as-of timestamp.
            run_id, observation_id = new_id("evidence-monitor-run"), new_id("evidence-model-observation")
            ref = {"schema_version": "investor-model-observation-ref-v1", "run_id": run_id, "outcome": rendered["outcome"],
                "profile_id": definition["profile_id"], "profile_version": definition["profile_version"], "input_version": request["input_version"], "published_at": now}
            validate_contract(ref, SCHEMA, fragment="$defs/observation_ref")
            payload = {"assessment": result["assessment"] if result else None, "observation": rendered}
            run = {"schema_version": "investor-evidence-monitor-run-v1", "request_id": request["id"], "model_id": definition["model_id"], "input_version": request["input_version"],
                "implementation_hash": implementation, "status": "blocked" if rendered["outcome"] == "insufficient_evidence" else rendered["outcome"], "reason_codes": codes,
                "projection_hash": content_hash(projection) if projection else None, "checkpoint_hash": content_hash(result["checkpoint"]) if result and result["checkpoint"] else None,
                "assessment_hash": result["assessment"]["result_hash"] if result else None, "observation_hash": content_hash(rendered), "payload_hash": content_hash(payload),
                "next_check_at": next_check, "created_at": now, "valid_until": max(now, expiry), "live_advice_eligible": False}
            validate_contract(run, SCHEMA, fragment="$defs/run")
            connection.execute("INSERT INTO investor_observations(id,workspace_id,profile_id,candidate_plan_id,outcome,document_json,content_hash,input_version,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (observation_id, job["scope"], definition["profile_id"], definition["plan_id"] if rendered["outcome"] != "insufficient_evidence" else None,
                rendered["outcome"], canonical_json(ref), content_hash(ref), request["input_version"], now))
            connection.execute("INSERT INTO investor_evidence_monitor_runs(id,workspace_id,model_id,request_id,job_id,observation_id,checkpoint_id,status,document_json,content_hash,created_at,valid_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (run_id, job["scope"], definition["model_id"], request["id"], job["id"], observation_id, checkpoint_id, run["status"], canonical_json(run), content_hash(run), now, run["valid_until"]))
            connection.execute("INSERT INTO investor_evidence_run_payloads VALUES(?,?)", (run_id, canonical_json(payload).encode()))
            connection.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (job["scope"],))
            enqueue_notification(connection, "investor-monitor:" + run_id, "investor.observation.changed",
                {"workspace_id": job["scope"], "model_id": definition["model_id"], "observation_id": observation_id, "outcome": rendered["outcome"], "live_advice_eligible": False}, now=now)
            return JobCommit({"monitor_run_id": run_id, "observation_id": observation_id, "status": run["status"], "live_advice_eligible": False})
        except Exception:
            raise WorkbenchError("INVESTOR_EVIDENCE_MONITOR_PUBLICATION_FAILED") from None
    return {"effect": commit}


def purge_monitor_payload(db, workspace, actor, kind, identifier, *, now=None):
    _assert(kind in ("checkpoint", "run")); at = _clock(now)
    table, payload_table, key = ("investor_evidence_model_checkpoints", "investor_evidence_checkpoint_payloads", "checkpoint_id") if kind == "checkpoint" else ("investor_evidence_monitor_runs", "investor_evidence_run_payloads", "run_id")
    with transaction(db):
        _owner(db, workspace, actor)
        row = db.execute("SELECT * FROM " + table + " WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone(); _assert(row is not None and row["created_at"] <= at, "INVESTOR_DATA_OUT_OF_SCOPE")
        previous = db.execute("SELECT * FROM investor_monitor_payload_purges WHERE kind=? AND entity_id=?", (kind, identifier)).fetchone()
        if previous:
            _assert(previous["created_at"] <= at, "INVESTOR_DATA_INVALID_CLOCK")
            return dict(previous)
        reason = "retention_expired"
        if row["valid_until"] > at:
            from .source_retention import monitor_payload_unavailable
            _assert(monitor_payload_unavailable(db, row, kind, at), "INVESTOR_DATA_PURGE_NOT_DUE")
            reason = "source_unavailable"
        audit = _audit(db, actor, "investor_purge_monitor_payload", "investor_monitor_payload", identifier, {"kind": kind, "reason": reason}, at)
        db.execute("INSERT INTO investor_monitor_payload_purges VALUES(?,?,?,?,?,?,?,?)", (kind, identifier, workspace, row["model_id"], reason, actor, at, audit))
        db.execute("DELETE FROM " + payload_table + " WHERE " + key + "=?", (identifier,))
        return dict(db.execute("SELECT * FROM investor_monitor_payload_purges WHERE kind=? AND entity_id=?", (kind, identifier)).fetchone())
