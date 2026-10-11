"""Independent model watcher with frozen requests and lease-fenced publication.

Only synthetic snapshots can currently be admitted. Production checks missing
inputs but cannot publish synthetic results as actionable observations.
"""

from datetime import datetime, timezone

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, enqueue_job
from .implementation import implementation_hash
from .model_state import advance_model
from .runtime import _json, _milliseconds

JOB_TYPE = "investor_monitor"
ENGINE_VERSION = "investor-model-watcher-v1"
POLL_SECONDS = 900


def _clock(value):
    # Runtime datetime objects are wall clocks, not source evidence. Publish
    # metadata at millisecond precision without rounding any input timestamp.
    if isinstance(value, datetime): value = value.replace(microsecond=value.microsecond // 1000 * 1000)
    return _milliseconds(value)


def _sealed(row, schema=None):
    try:
        document = _json(row["document_json"])
        if content_hash(document) != row["content_hash"]: raise ValueError()
        if schema: validate_contract(document, schema)
        return document
    except Exception:
        raise WorkbenchError("INVESTOR_MODEL_EVIDENCE_INVALID") from None


def _latest(connection, table, model_id, order="created_at DESC,rowid DESC"):
    return connection.execute("SELECT * FROM " + table + " WHERE model_id=? ORDER BY " + order + " LIMIT 1", (model_id,)).fetchone()


def _period(now):
    return str(int(instant(now).timestamp()) // POLL_SECONDS)


def _next_poll(now):
    return datetime.fromtimestamp((int(_period(now)) + 1) * POLL_SECONDS, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def register_synthetic_snapshot(connection, workspace_id, model_id, snapshot, *, now=None):
    """Internal test adapter only; real API responses must never enter here."""
    validate_contract(snapshot, "investor-model-snapshot.schema.json")
    if snapshot["model_id"] != model_id: raise WorkbenchError("INVESTOR_MODEL_SNAPSHOT_OUT_OF_SCOPE")
    document, at = canonical_json(snapshot), _milliseconds(now)
    if len(document.encode()) > 1048576: raise WorkbenchError("INVESTOR_MODEL_SNAPSHOT_LIMIT")
    with transaction(connection):
        model = connection.execute("SELECT * FROM investor_models WHERE id=? AND workspace_id=?", (model_id, workspace_id)).fetchone()
        if model is None or _sealed(model, "investor-model-definition.schema.json")["data_mode"] != "synthetic":
            raise WorkbenchError("INVESTOR_MODEL_SYNTHETIC_REQUIRED")
        previous = connection.execute("SELECT * FROM investor_model_inputs WHERE model_id=? AND content_hash=?", (model_id, content_hash(snapshot))).fetchone()
        if previous: return dict(previous)
        identifier = new_id("model-input")
        connection.execute("INSERT INTO investor_model_inputs(id,workspace_id,model_id,source_qualification,document_json,content_hash,created_at) VALUES(?,?,?,'synthetic_test_only',?,?,?)",
                           (identifier, workspace_id, model_id, document, content_hash(snapshot), at))
        return dict(connection.execute("SELECT * FROM investor_model_inputs WHERE id=?", (identifier,)).fetchone())


def discover_monitor_requests(connection, *, limit=100, now=None):
    if type(limit) is not int or not 1 <= limit <= 1000: raise WorkbenchError("INVESTOR_MONITOR_DISCOVERY_LIMIT")
    at = _clock(now)
    with transaction(connection):
        models = connection.execute("""SELECT m.* FROM investor_models m
          JOIN investor_model_controls c ON c.model_id=m.id
          WHERE c.version=(SELECT MAX(version) FROM investor_model_controls WHERE model_id=m.id) AND c.enabled=1
          AND m.profile_id=(SELECT id FROM investor_profiles WHERE workspace_id=m.workspace_id ORDER BY version DESC LIMIT 1)
          AND m.plan_id=(SELECT plan_id FROM investor_plan_selections WHERE workspace_id=m.workspace_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
          AND json_extract(m.document_json,'$.valid_until')>?
          AND json_extract(m.document_json,'$.schema_version')!='investor-model-definition-v2'
          AND NOT EXISTS(SELECT 1 FROM investor_monitor_evidence_inputs WHERE model_id=m.id)
          ORDER BY COALESCE((SELECT MAX(created_at) FROM investor_monitor_requests WHERE model_id=m.id),'') ASC,m.id LIMIT ?""", (at, limit)).fetchall()
        for model in models:
            definition = _sealed(model, "investor-model-definition.schema.json")
            control = _latest(connection, "investor_model_controls", model["id"], "version DESC")
            source = _latest(connection, "investor_model_inputs", model["id"])
            previous = _latest(connection, "investor_model_checkpoints", model["id"], "sequence DESC")
            if any(instant(row["created_at"]) > instant(at) for row in (model, control, source, previous) if row):
                raise WorkbenchError("INVESTOR_MONITOR_CLOCK_REGRESSION")
            # A checkpoint advance must not retrigger itself within this period.
            # Missing input is checked once, then waits for a new source/control.
            period = _period(at) if source else "awaiting-input"
            key = content_hash({"model_hash": model["content_hash"], "control_id": control["id"], "input_id": source["id"] if source else None})
            if connection.execute("SELECT 1 FROM investor_monitor_requests WHERE model_id=? AND period=? AND request_key=?", (model["id"], period, key)).fetchone(): continue
            request = {"schema_version": "investor-monitor-request-v1", "engine_version": ENGINE_VERSION,
                       "model_hash": model["content_hash"], "profile_hash": definition["profile_hash"], "control_id": control["id"],
                       "input_hash": source["content_hash"] if source else None, "checkpoint_hash": previous["content_hash"] if previous else None}
            connection.execute("INSERT INTO investor_monitor_requests(id,workspace_id,model_id,control_id,input_id,checkpoint_id,period,request_key,input_version,document_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                               (new_id("monitor-request"), model["workspace_id"], model["id"], control["id"], source["id"] if source else None,
                                previous["id"] if previous else None, period, key, content_hash(request), canonical_json(request), at))
        pending = connection.execute("""SELECT r.* FROM investor_monitor_requests r LEFT JOIN job_runs j ON j.job_type=?
          AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.input_version
          WHERE j.id IS NULL ORDER BY r.created_at,r.rowid LIMIT ?""", (JOB_TYPE, limit)).fetchall()
        return [enqueue_job(connection, JOB_TYPE, row["workspace_id"], row["id"], row["input_version"], max_attempts=2, now=at) for row in pending]


def _binding(connection, job, now):
    request = connection.execute("SELECT * FROM investor_monitor_requests WHERE id=? AND workspace_id=?", (job["period"], job["scope"])).fetchone()
    if (request is None or job["job_type"] != JOB_TYPE or job["command_request_id"] is not None
            or job["input_version"] != request["input_version"]): raise WorkbenchError("INVESTOR_MONITOR_BINDING_INVALID")
    model = connection.execute("SELECT * FROM investor_models WHERE id=? AND workspace_id=?", (request["model_id"], job["scope"])).fetchone()
    definition = _sealed(model, "investor-model-definition.schema.json")
    plan = connection.execute("SELECT * FROM investor_reference_plans WHERE id=? AND workspace_id=?", (model["plan_id"], job["scope"])).fetchone()
    plan_document = _sealed(plan)
    if (definition["model_id"] != model["id"] or definition["profile_id"] != model["profile_id"] or definition["plan_id"] != model["plan_id"]
            or definition["created_at"] != model["created_at"] or definition["plan_hash"] != plan["content_hash"]
            or plan["profile_id"] != model["profile_id"] or plan_document["profile_id"] != model["profile_id"]
            or definition["valid_until"] != plan_document["valid_until"] or definition["data_mode"] != plan_document["data_mode"]
            or definition["targets"] != [{key: row[key] for key in ("listing_id", "market", "currency", "weight")} for row in plan_document["targets"]]):
        raise WorkbenchError("INVESTOR_MONITOR_BINDING_INVALID")
    profile = connection.execute("SELECT * FROM investor_profiles WHERE id=? AND workspace_id=?", (model["profile_id"], job["scope"])).fetchone()
    preferences = _sealed(profile, "investor-profile.schema.json")
    control = connection.execute("SELECT * FROM investor_model_controls WHERE id=? AND model_id=?", (request["control_id"], model["id"])).fetchone()
    source = connection.execute("SELECT * FROM investor_model_inputs WHERE id=? AND model_id=?", (request["input_id"], model["id"])).fetchone()
    previous = connection.execute("SELECT * FROM investor_model_checkpoints WHERE id=? AND model_id=?", (request["checkpoint_id"], model["id"])).fetchone()
    rows = [request, model, profile, control, source, previous, plan]
    if control is None or any(instant(row["created_at"]) > instant(now) for row in rows if row): raise WorkbenchError("INVESTOR_MONITOR_BINDING_INVALID")
    if any(instant(row["created_at"]) > instant(request["created_at"]) for row in rows[1:] if row): raise WorkbenchError("INVESTOR_MONITOR_BINDING_INVALID")
    if (source is None) != (request["input_id"] is None) or (previous is None) != (request["checkpoint_id"] is None): raise WorkbenchError("INVESTOR_MONITOR_BINDING_INVALID")
    bound = {"schema_version": "investor-monitor-request-v1", "engine_version": ENGINE_VERSION,
             "model_hash": model["content_hash"], "profile_hash": profile["content_hash"], "control_id": control["id"],
             "input_hash": source["content_hash"] if source else None, "checkpoint_hash": previous["content_hash"] if previous else None}
    if (_json(request["document_json"]) != bound or content_hash(bound) != request["input_version"]
            or definition["profile_hash"] != profile["content_hash"] or definition["profile_version"] != profile["version"]):
        raise WorkbenchError("INVESTOR_MONITOR_BINDING_INVALID")
    snapshot = _sealed(source, "investor-model-snapshot.schema.json") if source else None
    checkpoint = _sealed(previous, "investor-model-checkpoint.schema.json") if previous else None
    if checkpoint:
        ancestor = connection.execute("SELECT content_hash FROM investor_model_checkpoints WHERE model_id=? AND sequence=?", (model["id"], previous["sequence"] - 1)).fetchone()
        origin = connection.execute("SELECT content_hash FROM investor_model_inputs WHERE id=? AND model_id=?", (previous["input_id"], model["id"])).fetchone()
        if (checkpoint["model_id"] != model["id"] or checkpoint["sequence"] != previous["sequence"] or checkpoint["created_at"] != previous["created_at"]
                or checkpoint["input_hash"] != origin["content_hash"] or checkpoint["previous_hash"] != (ancestor["content_hash"] if ancestor else None)):
            raise WorkbenchError("INVESTOR_MONITOR_BINDING_INVALID")
    latest_source = _latest(connection, "investor_model_inputs", model["id"])
    latest_checkpoint = _latest(connection, "investor_model_checkpoints", model["id"], "sequence DESC")
    current_control = _latest(connection, "investor_model_controls", model["id"], "version DESC")
    latest_profile = connection.execute("SELECT id FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1", (job["scope"],)).fetchone()
    selection = connection.execute("SELECT plan_id FROM investor_plan_selections WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", (job["scope"],)).fetchone()
    current = (latest_profile["id"] == model["profile_id"] and selection and selection["plan_id"] == model["plan_id"]
               and current_control["id"] == control["id"] and control["enabled"] == 1
               and (latest_source["id"] if latest_source else None) == request["input_id"]
               and (latest_checkpoint["id"] if latest_checkpoint else None) == request["checkpoint_id"])
    if definition["data_mode"] == "reconstructed":
        from .reference_plan import reference_source_current
        validate_contract(plan_document, "investor-reference-plan.schema.json")
        current = current and reference_source_current(connection, job["scope"], model["plan_id"], now)
        current = current and not connection.execute("SELECT 1 FROM investor_monitor_evidence_inputs WHERE model_id=?", (model["id"],)).fetchone()
    return request, definition, preferences, snapshot, checkpoint, bool(current)


def prepare_monitor_job(connection, job, lease, *, clock=None, allow_synthetic=False, stop_requested=None):
    clock = (lambda: None) if clock is None else clock
    try:
        if type(allow_synthetic) is not bool: raise WorkbenchError("INVESTOR_MONITOR_TEST_SWITCH_INVALID")
        at = _clock(clock())
        request, definition, preferences, snapshot, previous, current = _binding(connection, job, at)
        if not current: return {"result": {"code": "INVESTOR_MONITOR_SUPERSEDED", "live_advice_eligible": False}, "outcome": "skipped"}
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        implementation = implementation_hash()
        result = None
        if definition["valid_until"] <= at: codes = ["REFERENCE_PLAN_EXPIRED"]
        elif snapshot is None: codes = ["MONITOR_DATASET_NOT_READY"]
        elif not allow_synthetic: codes = ["SYNTHETIC_MONITOR_DISABLED"]
        else:
            result = advance_model(definition, snapshot, previous, at)
            codes = ["SYNTHETIC_MONITOR_ONLY"]
    except Exception:
        raise WorkbenchError("INVESTOR_MONITOR_PREPARATION_FAILED") from None

    def commit(db):
        try:
            now = _clock(clock())
            bound, _, _, _, _, current = _binding(db, job, now)
            if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
            # An assessment is time-bound; a long wait never extends its validity.
            expired = result and result["assessment"]["outcome"] != "insufficient_evidence" and (result["assessment"]["next_review_at"] is None or instant(result["assessment"]["next_review_at"]) <= instant(now) or definition["valid_until"] <= now)
            if not current or implementation_hash() != implementation or expired:
                return JobCommit({"code": "INVESTOR_MONITOR_SUPERSEDED", "live_advice_eligible": False}, "skipped")
            checkpoint_id = None
            if result and result["checkpoint"] is not None:
                value = result["checkpoint"]
                checkpoint_id = new_id("model-checkpoint")
                db.execute("INSERT INTO investor_model_checkpoints(id,workspace_id,model_id,input_id,sequence,previous_hash,document_json,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                           (checkpoint_id, job["scope"], request["model_id"], request["input_id"], value["sequence"], value["previous_hash"], canonical_json(value), content_hash(value), value["created_at"]))
            observation_id, run_id = new_id("model-observation"), new_id("monitor-run")
            next_check = min(_next_poll(now), definition["valid_until"]) if snapshot else None
            observation = {"schema_version": "investor-observation-v1", "outcome": "insufficient_evidence", "evaluated_at": now,
                "data_cutoff": None, "profile_id": definition["profile_id"], "profile_version": definition["profile_version"],
                "input_version": request["input_version"], "gaps": [{"code": codes[0], "title": "持续监测输入未合格" if result is None else "仅有合成监测测试",
                  "detail": "后台已复核研究模型，但尚无可用于真实结论的完整行情和企业行动证据。合成结果仅验证软件，不作为无需调整或交易建议。",
                  "affected_markets": preferences["markets"], "action": "接入并验收真实监测数据；旧方案过期时先重新研究。"}],
                "reasons": ["研究模型与真实持仓分离；计划投入和采纳意见不会改变模型现金，也不会发出订单。"],
                "next_review_at": next_check if next_check and next_check > now else None, "next_conditions": ["行情及企业行动输入更新后复核", "研究方案或约束更新后复核"],
                "monitoring": "not_enabled", "scope": "research_model", "live_advice_eligible": False}
            run = {"schema_version": "investor-monitor-run-v1", "request_id": bound["id"], "model_id": definition["model_id"],
                   "input_version": request["input_version"], "implementation_hash": implementation,
                   "status": "synthetic_preview" if result else "blocked", "reason_codes": codes, "result": result,
                   "next_check_at": observation["next_review_at"], "created_at": now}
            encoded = canonical_json(run)
            if len(encoded.encode()) > 1048576: raise WorkbenchError("INVESTOR_MONITOR_RESULT_LIMIT")
            db.execute("INSERT INTO investor_observations(id,workspace_id,profile_id,candidate_plan_id,outcome,document_json,content_hash,input_version,created_at) VALUES(?,?,?,NULL,'insufficient_evidence',?,?,?,?)",
                       (observation_id, job["scope"], definition["profile_id"], canonical_json(observation), content_hash(observation), request["input_version"], now))
            db.execute("INSERT INTO investor_monitor_runs(id,workspace_id,model_id,request_id,job_id,observation_id,checkpoint_id,status,document_json,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                       (run_id, job["scope"], definition["model_id"], request["id"], job["id"], observation_id, checkpoint_id, run["status"], encoded, content_hash(run), now))
            db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (job["scope"],))
            return JobCommit({"monitor_run_id": run_id, "status": run["status"], "observation_id": observation_id, "live_advice_eligible": False})
        except Exception:
            raise WorkbenchError("INVESTOR_MONITOR_PUBLICATION_FAILED") from None
    return {"effect": commit}
