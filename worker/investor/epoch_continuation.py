"""Explicit epoch activation, retained-chain replay and fenced ongoing research.

No provider I/O, inferred funds, trade execution or historical observation edits.
Prepared source objects never authorize admission: only this actual journal does.
"""

from datetime import timedelta
from zoneinfo import ZoneInfo

from worker.market.contracts import validate_contract
from worker.market.providers.longport import _MARKETS
from worker.orchestration.db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job, enqueue_notification
from . import managed_actions as managed, model_epoch_registration as registration, model_epoch_continuation_source as source, model_epoch_source as epoch_source
from .correction_change_fence import correction_change_fence
from .data_evidence import _audit, _audit_binding, _fact_validation_scope, _object, _owner
from .evidence_monitor_runtime import _payload
from .evidence_observation import observation
from .implementation import implementation_hash
from .model_runtime import _clock
from .monitor_bootstrap import _source_settings
from .monitor_costs import current_settings
from .planned_funding_source import read_bound_planned_funding_monitor
from .registered_model_epoch import read_registered_model_epoch


SCHEMA = "investor-epoch-continuation.schema.json"
JOB_TYPE = "investor_evidence_monitor"
PREFIX = "epoch-continuation-request:"
ACKS = ("current_epoch_seen", "continuous_research_only", "preserve_history_and_human_trading")


def _check(value, code="INVALID"):
    if not value: raise WorkbenchError("INVESTOR_EPOCH_CONTINUATION_" + code)


def _validate(value, kind): validate_contract(value, SCHEMA, fragment="$defs/" + kind)
def _ref(row): return {"id": row["id"], "content_hash": row["content_hash"]}


def _seal(db, workspace, actor, identifier, kind):
    _owner(db, workspace, actor)
    table, action, entity = {
        "control": ("investor_epoch_controls", "investor_control_epoch_continuation", "investor_epoch_control"),
        "request": ("investor_epoch_continuation_requests", "investor_request_epoch_continuation", "investor_epoch_continuation_request"),
        "publication": ("investor_epoch_continuations", "investor_publish_epoch_continuation", "investor_epoch_continuation")}[kind]
    row = db.execute("SELECT * FROM " + table + " WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    _check(row is not None and row["actor_id"] == actor, "OUT_OF_SCOPE")
    doc = _object(row["document_json"]); _validate(doc, kind); _audit_binding(db, row, action, entity, identifier)
    _check(canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"]
        and all(doc[key] == row[key] for key in ("workspace_id", "actor_id", "model_id", "created_at", "valid_until"))
        and doc["epoch"]["id"] == row["epoch_id"], "HEADER_CHANGED")
    return row, doc


def _control(db, workspace, actor, identifier):
    row, doc = _seal(db, workspace, actor, identifier, "control")
    root, epoch = registration._header(db, workspace, actor, row["epoch_id"], "registration")
    _check(doc["control_id"] == identifier and doc["version"] == row["version"] and doc["body"]["enabled"] == bool(row["enabled"])
        and doc["body"]["idempotency_key"] == row["idempotency_key"] and doc["body"]["epoch_id"] == root["id"]
        and doc["epoch"] == epoch["epoch"] and doc["registration_hash"] == root["content_hash"] == doc["body"]["expected_registration_hash"]
        and doc["workspace_revision"] == doc["body"]["expected_revision"] + 1 and instant(root["created_at"]) <= instant(row["created_at"])
        and instant(row["valid_until"]) <= instant(root["valid_until"]), "CONTROL_CHANGED")
    return row, doc


def _request(db, workspace, actor, identifier):
    row, doc = _seal(db, workspace, actor, identifier, "request")
    control, activation = _control(db, workspace, actor, row["control_id"])
    root, epoch = registration._header(db, workspace, actor, row["epoch_id"], "registration")
    monitor, proof, document = (doc[key] for key in ("monitor_request", "source_proof", "input"))
    _check(doc["request_id"] == identifier and doc["activation"] == _ref(control) and control["enabled"] == 1
        and control["epoch_id"] == row["epoch_id"] and doc["epoch"] == epoch["epoch"] == document["epoch"]
        and doc["registration_hash"] == root["content_hash"] and doc["previous_input"]["id"] == row["previous_input_id"]
        and doc["previous_checkpoint"]["id"] == row["previous_checkpoint_id"] and doc["request_key"] == row["request_key"]
        and doc["request_key"] == content_hash({"context_key": doc["context_key"], "workspace_revision": doc["workspace_revision"]})
        and content_hash(monitor) == row["input_version"] and monitor["continuation_request_id"] == identifier
        and monitor["epoch"] == doc["epoch"] and monitor["activation"] == doc["activation"]
        and monitor["input_hash"] == proof["input_hash"] == content_hash(document)
        and monitor["checkpoint_hash"] == doc["previous_checkpoint"]["content_hash"] and monitor["control_id"] == proof["model_control"]["id"]
        and proof["registration_hash"] == doc["registration_hash"] and proof["epoch"] == doc["epoch"]
        and proof["previous_input"] == doc["previous_input"] and proof["previous_checkpoint"] == doc["previous_checkpoint"]
        and document["workspace_id"] == workspace and document["model_id"] == row["model_id"]
        and proof["workspace_id"] == workspace and proof["actor_id"] == actor and proof["model_id"] == row["model_id"]
        and proof["projection_hash"] == document["projection_hash"] and proof["checked_at"] == document["created_at"] == doc["created_at"]
        and instant(control["created_at"]) <= instant(doc["created_at"]) < instant(doc["valid_until"])
        and instant(doc["valid_until"]) <= min(instant(control["valid_until"]), instant(proof["valid_until"]), instant(doc["source_ceiling"]))
        and instant(doc["source_ceiling"]) <= instant(root["valid_until"]), "REQUEST_CHANGED")
    return row, doc


def publication_header(db, workspace, actor, identifier):
    """Metadata authentication only; source/payload replay is a separate step."""
    row, doc = _seal(db, workspace, actor, identifier, "publication")
    request, planned = _request(db, workspace, actor, row["request_id"])
    admitted = db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE id=? AND workspace_id=? AND model_id=?", (row["input_id"], workspace, row["model_id"])).fetchone()
    checkpoint = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?", (row["checkpoint_id"], workspace, row["model_id"])).fetchone()
    run = db.execute("SELECT * FROM investor_evidence_monitor_runs WHERE id=? AND workspace_id=? AND model_id=?", (row["monitor_run_id"], workspace, row["model_id"])).fetchone()
    monitor = db.execute("SELECT * FROM investor_evidence_monitor_requests WHERE id=?", (request["id"],)).fetchone()
    job = db.execute("SELECT * FROM job_runs WHERE id=?", (row["job_id"],)).fetchone()
    _check(all(item is not None for item in (admitted, checkpoint, run, monitor, job)), "PUBLICATION_CHANGED")
    attempt = db.execute("SELECT * FROM job_attempts WHERE job_id=? AND attempt=?", (job["id"], job["attempt_count"])).fetchone()
    _check(doc["publication_id"] == identifier and doc["sequence"] == row["sequence"] and doc["request"] == _ref(request)
        and doc["activation"] == planned["activation"] and doc["epoch"] == planned["epoch"]
        and doc["previous_input"] == planned["previous_input"] and doc["previous_checkpoint"] == planned["previous_checkpoint"]
        and doc["input"] == _ref(admitted) and doc["checkpoint"] == _ref(checkpoint) and doc["monitor_run_id"] == run["id"]
        and doc["observation_id"] == run["observation_id"] and doc["job_id"] == job["id"]
        and doc["workspace_revision"] == planned["workspace_revision"] + 1 and doc["source_ceiling"] == planned["source_ceiling"]
        and doc["implementation_hash"] == planned["implementation_hash"]
        and admitted["document_json"] == canonical_json(planned["input"]) and admitted["content_hash"] == content_hash(planned["input"])
        and admitted["actor_id"] == actor and admitted["created_at"] == planned["input"]["created_at"] and admitted["valid_until"] == planned["input"]["valid_until"]
        and job["job_type"] == JOB_TYPE and job["command_request_id"] is None and job["scope"] == workspace
        and job["period"] == request["id"] and job["input_version"] == request["input_version"] and job["status"] == "succeeded"
        and attempt is not None and attempt["status"] == "succeeded" and attempt["fencing_token"] == job["fencing_token"]
        and instant(request["created_at"]) <= instant(job["created_at"]) <= instant(attempt["started_at"]) <= instant(doc["calculated_at"])
        <= instant(doc["created_at"]) <= instant(attempt["finished_at"]) < instant(doc["publication_deadline"])
        and instant(doc["publication_deadline"]) <= min(instant(request["valid_until"]), instant(doc["source_proof"]["valid_until"]), instant(row["valid_until"]))
        and doc["source_proof"]["checked_at"] == doc["calculated_at"] and doc["source_proof"]["input_hash"] == admitted["content_hash"]
        and doc["source_proof"]["previous_input"] == planned["previous_input"] and doc["source_proof"]["previous_checkpoint"] == planned["previous_checkpoint"]
        and doc["source_proof"]["epoch"] == planned["epoch"] and doc["source_proof"]["registration_hash"] == planned["registration_hash"]
        and monitor["document_json"] == canonical_json(planned["monitor_request"]) and monitor["input_version"] == request["input_version"]
        and monitor["input_id"] == admitted["id"] and monitor["checkpoint_id"] == request["previous_checkpoint_id"]
        and monitor["workspace_id"] == workspace and monitor["model_id"] == row["model_id"] and monitor["created_at"] == request["created_at"]
        and monitor["period"] == "epoch-continuation:" + request["id"] and monitor["request_key"] == request["input_version"]
        and monitor["control_id"] == planned["monitor_request"]["control_id"]
        and run["job_id"] == job["id"] and run["request_id"] == request["id"] and run["checkpoint_id"] == checkpoint["id"]
        and run["created_at"] == row["created_at"] and run["valid_until"] == row["valid_until"], "PUBLICATION_CHANGED")
    _check(_object(job["result_json"]) == _job_result(row, doc), "JOB_CHANGED")
    _audit_binding(db, {**dict(admitted), "created_at": row["created_at"]}, "investor_admit_monitor_source", "investor_monitor_evidence_input", admitted["id"])
    _check(doc["checkpoint_reused"] and doc["checkpoint"] == doc["previous_checkpoint"] or not doc["checkpoint_reused"]
        and checkpoint["input_id"] == admitted["id"] and checkpoint["previous_hash"] == doc["previous_checkpoint"]["content_hash"]
        and checkpoint["projection_hash"] == planned["input"]["projection_hash"] and checkpoint["created_at"] == doc["calculated_at"]
        and checkpoint["valid_until"] == row["valid_until"], "CHECKPOINT_CHANGED")
    run_doc = _object(run["document_json"]); validate_contract(run_doc, "investor-evidence-monitor.schema.json", fragment="$defs/run")
    _check(canonical_json(run_doc) == run["document_json"] and content_hash(run_doc) == run["content_hash"]
        and run_doc["request_id"] == request["id"] and run_doc["model_id"] == row["model_id"] and run_doc["input_version"] == request["input_version"]
        and run_doc["projection_hash"] == planned["input"]["projection_hash"] and run_doc["checkpoint_hash"] == checkpoint["content_hash"]
        and run_doc["implementation_hash"] == doc["implementation_hash"] and run_doc["created_at"] == row["created_at"]
        and run_doc["valid_until"] == row["valid_until"] and run_doc["status"] == run["status"] and run_doc["next_check_at"] is not None, "RUN_CHANGED")
    return row, doc


def _job_result(row, doc):
    return {"publication_id": row["id"], "epoch_id": row["epoch_id"], "monitor_run_id": row["monitor_run_id"], "observation_id": doc["observation_id"],
        "checkpoint_id": row["checkpoint_id"], "status": "epoch_continuation_published", "live_advice_eligible": False}


def _key(value, activation, at, implementation=None):
    economic = value["projection"]["economic_projection"]
    reviews = {canonical_json(ref) for segment in value["input"]["segments"] for ref in segment["snapshot"]["review_refs"]}
    days = {market: instant(at).astimezone(ZoneInfo(_MARKETS[market][0])).date().isoformat() for market in {row["market"] for row in economic["quotes"]}}
    fixed = value["kernel_input"]["definition"].get("fixed_policy")
    policy_day = instant(at).astimezone(ZoneInfo(fixed["evaluation_timezone"])).date().isoformat() if fixed else None
    return content_hash({"epoch": value["input"]["epoch"], "activation": activation, "quotes": economic["quotes"], "fx": economic["fx"],
        "actions": economic["corporate_actions"], "reviews": sorted(reviews), "settings": value["input"]["settings"], "days": days, "policy_day": policy_day,
        "funding_binding": value["input"].get("funding_binding"), "funding_context_hash": value["input"].get("funding_context_hash"), "implementation_hash": implementation or implementation_hash()})


def _fence(db, workspace, actor):
    value = {"sources": correction_change_fence(db, workspace, actor)}; count = 0
    for name, table in (("controls", "investor_epoch_controls"), ("requests", "investor_epoch_continuation_requests"), ("publications", "investor_epoch_continuations")):
        rows = db.execute("SELECT id,content_hash FROM " + table + " WHERE workspace_id=? ORDER BY rowid LIMIT ?", (workspace, 100001 - count)).fetchall()
        count += len(rows); _check(count <= 100000, "FENCE_LIMIT"); value[name] = [dict(row) for row in rows]
    _check(len(canonical_json(value).encode()) <= 33554432, "FENCE_LIMIT")
    return content_hash(value)


def _revision(db, workspace, actor, expected): registration._revision(db, workspace, actor, expected)


def set_epoch_continuation_control(db, workspace, actor, body, *, owner_interaction=False, now=None, clock=None, stop_requested=None):
    _validate(body, "control_submit"); _check(owner_interaction is True, "OWNER_INTERACTION_REQUIRED")
    at = _clock(now); assert_writable(db)
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor); managed._stopped(db, stop_requested)
        existing = db.execute("SELECT id FROM investor_epoch_controls WHERE workspace_id=? AND idempotency_key=?", (workspace, body["idempotency_key"])).fetchone()
        if existing:
            _, prior = _control(db, workspace, actor, existing["id"]); _check(prior["body"] == body, "IDEMPOTENCY_CONFLICT"); return prior
        _revision(db, workspace, actor, body["expected_revision"])
        root, record = registration._header(db, workspace, actor, body["epoch_id"], "registration")
        head = db.execute("SELECT id,content_hash FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? ORDER BY sequence DESC LIMIT 1", (workspace, root["model_id"])).fetchone()
        _check(root["content_hash"] == body["expected_registration_hash"] and head is not None and _ref(head) == body["expected_checkpoint"], "HEAD_CHANGED")
        if body["enabled"]:
            source.prepare_model_epoch_continuation(db, workspace, actor, root["id"], now=at, stop_requested=stop_requested)
        fence = _fence(db, workspace, actor)
    with transaction(db):
        current = _clock(clock() if clock else at); assert_writable(db); _revision(db, workspace, actor, body["expected_revision"])
        managed._stopped(db, stop_requested)
        _check(instant(at) <= instant(current) < instant(root["valid_until"]) and _fence(db, workspace, actor) == fence, "SOURCE_CHANGED")
        version = db.execute("SELECT COALESCE(MAX(version),0)+1 FROM investor_epoch_controls WHERE epoch_id=?", (root["id"],)).fetchone()[0]
        identifier = new_id("epoch-control")
        doc = {"schema_version": "investor-epoch-control-v1", "control_id": identifier, "workspace_id": workspace, "actor_id": actor, "model_id": root["model_id"],
            "epoch": record["epoch"], "registration_hash": root["content_hash"], "version": version, "workspace_revision": body["expected_revision"] + 1,
            "body": body, "created_at": current, "valid_until": root["valid_until"], "trading_permission": False}
        _validate(doc, "control"); digest = content_hash(doc); audit = _audit(db, actor, "investor_control_epoch_continuation", "investor_epoch_control", identifier, {"content_hash": digest}, current)
        db.execute("INSERT INTO investor_epoch_controls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, root["model_id"], root["id"], version, int(body["enabled"]),
            body["idempotency_key"], canonical_json(doc), digest, actor, current, root["valid_until"], audit))
        db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (workspace,))
        return doc


def discover_epoch_continuations(db, *, limit=100, now=None, stop_requested=None):
    _check(type(limit) is int and 1 <= limit <= 1000); at = _clock(now); assert_writable(db)
    # Older migration-prefix fixtures do not acquire the new engine implicitly.
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investor_epoch_controls'").fetchone(): return []
    rows = db.execute("""SELECT c.id,c.workspace_id,c.actor_id,c.epoch_id FROM investor_epoch_controls c
      WHERE c.enabled=1 AND c.version=(SELECT MAX(version) FROM investor_epoch_controls WHERE epoch_id=c.epoch_id)
        AND c.created_at<=? AND c.valid_until>? ORDER BY c.created_at,c.id LIMIT ?""", (at, at, limit)).fetchall()
    result = []
    for row in rows:
        managed._stopped(db, stop_requested)
        try:
            with transaction(db, immediate=False), _fact_validation_scope():
                control, activation = _control(db, row["workspace_id"], row["actor_id"], row["id"])
                value = source.prepare_model_epoch_continuation(db, row["workspace_id"], row["actor_id"], row["epoch_id"], now=at, stop_requested=stop_requested)
                context_key = _key(value, _ref(control), at)
                latest = db.execute("SELECT r.id,r.document_json FROM investor_epoch_continuations p JOIN investor_epoch_continuation_requests r ON r.id=p.request_id WHERE p.epoch_id=? ORDER BY p.sequence DESC LIMIT 1", (row["epoch_id"],)).fetchone()
                if latest and _object(latest["document_json"])["context_key"] == context_key:
                    result.append(latest["id"]); continue
                revision = db.execute("SELECT revision FROM investor_workspaces WHERE id=?", (row["workspace_id"],)).fetchone()[0]
                key = content_hash({"context_key": context_key, "workspace_revision": revision})
                prior = db.execute("SELECT id FROM investor_epoch_continuation_requests WHERE epoch_id=? AND request_key=?", (row["epoch_id"], key)).fetchone()
                if prior: result.append(prior["id"]); continue
                previous = value["proof"]["previous_checkpoint"]
                head = db.execute("SELECT valid_until FROM investor_evidence_model_checkpoints WHERE id=?", (previous["id"],)).fetchone()
                chain = read_epoch_continuation_chain(db, row["workspace_id"], row["actor_id"], row["epoch_id"], now=at, stop_requested=stop_requested)
                ceiling = min(value["epoch_definition"]["valid_until"], chain["read_valid_until"], control["valid_until"], head["valid_until"], key=instant)
                valid = min(ceiling, value["proof"]["valid_until"], _clock(instant(at) + timedelta(minutes=10)), key=instant)
                _check(instant(at) < instant(valid), "CURRENT_INPUTS_NOT_READY")
                fence = _fence(db, row["workspace_id"], row["actor_id"])
            with transaction(db):
                managed._stopped(db, stop_requested); _revision(db, row["workspace_id"], row["actor_id"], revision)
                _check(_fence(db, row["workspace_id"], row["actor_id"]) == fence, "SOURCE_CHANGED")
                identifier = new_id("epoch-continuation-request"); definition = value["kernel_input"]["definition"]
                monitor = {"schema_version": "investor-evidence-monitor-request-v4", "engine_version": "investor-evidence-model-watcher-epoch-continuation-v1",
                    "continuation_request_id": identifier, "epoch": value["input"]["epoch"], "activation": _ref(control), "model_hash": content_hash(definition),
                    "profile_hash": definition["profile_hash"], "control_id": value["proof"]["model_control"]["id"], "input_hash": content_hash(value["input"]), "checkpoint_hash": previous["content_hash"]}
                doc = {"schema_version": "investor-epoch-continuation-request-v1", "request_id": identifier, "workspace_id": row["workspace_id"], "actor_id": row["actor_id"], "model_id": definition["model_id"],
                    "epoch": value["input"]["epoch"], "registration_hash": activation["registration_hash"], "activation": _ref(control),
                    "previous_input": value["proof"]["previous_input"], "previous_checkpoint": previous, "workspace_revision": revision, "context_key": context_key, "request_key": key,
                    "input": value["input"], "source_proof": value["proof"], "source_ceiling": ceiling, "implementation_hash": implementation_hash(),
                    "monitor_request": monitor, "created_at": at, "valid_until": valid, "trading_permission": False}
                _validate(doc, "request"); digest = content_hash(doc); audit = _audit(db, row["actor_id"], "investor_request_epoch_continuation", "investor_epoch_continuation_request", identifier, {"content_hash": digest}, at)
                db.execute("INSERT INTO investor_epoch_continuation_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, row["workspace_id"], definition["model_id"], row["epoch_id"], control["id"],
                    doc["previous_input"]["id"], previous["id"], key, content_hash(monitor), canonical_json(doc), digest, row["actor_id"], at, valid, audit))
                enqueue_job(db, JOB_TYPE, row["workspace_id"], identifier, content_hash(monitor), max_attempts=2, now=at)
                result.append(identifier)
        except (WorkbenchError, ValueError) as error:
            if stop_requested and stop_requested(): raise
            # Never turn failure into unchanged advice. The independent current
            # reader still checks freshness/permissions; diagnostic is metadata.
            with transaction(db):
                enqueue_notification(db, "epoch-continuation-gap:" + row["id"] + ":" + at[:10], "investor.epoch_continuation_gap",
                    {"workspace_id": row["workspace_id"], "epoch_id": row["epoch_id"], "code": "EPOCH_CURRENT_INPUTS_NOT_READY", "live_advice_eligible": False}, now=at)
    return result


def _recorded_source(db, workspace, actor, root, prior_source, previous_refs, planned, publication, checked, stop_requested):
    definition = root["source"]["kernel_input"]["history"]["definition"]
    evaluated, frozen = publication["calculated_at"], planned["input"]["created_at"]
    model, _, reference = epoch_source.current_monitor_model(db, workspace, definition["model_id"], checked)
    control = db.execute("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? AND created_at<=? ORDER BY version DESC LIMIT 1", (workspace, definition["model_id"], evaluated)).fetchone()
    _check(control is not None and control["enabled"] == 1 and _ref({"id": control["id"], "content_hash": content_hash(dict(control))}) == root["source"]["epoch_definition"]["model_control"], "RECORDED_CONTROL_CHANGED")
    chosen = db.execute("SELECT id,content_hash FROM investor_funding_plans WHERE workspace_id=? AND created_at<=? ORDER BY version DESC LIMIT 1", (workspace, evaluated)).fetchone()
    binding, funding = planned["input"].get("funding_binding"), None
    _check((chosen is None) == (binding is None), "RECORDED_FUNDING_CHANGED")
    if binding:
        _check(binding["funding_plan_id"] == chosen["id"] and binding["funding_plan_hash"] == chosen["content_hash"], "RECORDED_FUNDING_CHANGED")
        funding = read_bound_planned_funding_monitor(db, workspace, actor, binding, evaluated_at=evaluated, now=checked)
        frozen_funding = read_bound_planned_funding_monitor(db, workspace, actor, binding, evaluated_at=frozen, now=checked)
        _check(funding["context_hash"] == frozen_funding["context_hash"] == planned["input"]["funding_context_hash"], "RECORDED_FUNDING_CHANGED")
    basis = {"saved": root, "previous_source": prior_source, "previous_refs": previous_refs, "definition": definition,
        "previous": prior_source["candidate"]["checkpoint"], "reference": reference, "model": model, "funding": funding,
        "control": root["source"]["epoch_definition"]["model_control"]}
    settings = current_settings(db, workspace, definition, _source_settings(db, workspace, model, definition, reference, checked), frozen)
    raw = source.resolve_monitor_data(db, workspace, definition, epoch_source.audited_epoch_input(planned["input"]), now=checked, evaluated_at=evaluated)
    _check(raw["unavailable_reason"] is None, raw["unavailable_reason"] or "SOURCE_UNAVAILABLE")
    return source._assemble_evidence(db, workspace, actor, basis, raw, checked, evaluated, settings, publication["source_ceiling"], stop_requested)


def read_epoch_continuation_chain(db, workspace, actor, epoch_id, *, now=None, publication_id=None, stop_requested=None):
    checked = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor); managed._stopped(db, stop_requested)
        root = read_registered_model_epoch(db, workspace, actor, epoch_id, now=checked, stop_requested=stop_requested)
        definition = root["source"]["kernel_input"]["history"]["definition"]
        previous, refs, last, limit = root["source"], {key: root["registration"][key] for key in ("input", "checkpoint")}, None, root["proof"]["read_valid_until"]
        original_expiry = root["registration"]["valid_until"]
        _check(instant(checked) < instant(limit), "SOURCE_EXPIRED")
        headers = []
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investor_epoch_continuations'").fetchone():
            target = publication_header(db, workspace, actor, publication_id)[0] if publication_id is not None else None
            if target: _check(target["epoch_id"] == epoch_id, "OUT_OF_SCOPE")
            headers = db.execute("SELECT id FROM investor_epoch_continuations WHERE epoch_id=? AND (? IS NULL OR sequence<=?) ORDER BY sequence LIMIT 1001", (epoch_id, target["sequence"] if target else None, target["sequence"] if target else None)).fetchall()
            _check(len(headers) <= 1000 and (target is None or len(headers) == target["sequence"]), "CHAIN_CHANGED")
        for index, head in enumerate(headers, 1):
            managed._stopped(db, stop_requested); row, doc = publication_header(db, workspace, actor, head["id"])
            _, planned = _request(db, workspace, actor, row["request_id"])
            _check(doc["sequence"] == index and doc["previous_publication"] == last and doc["previous_input"] == refs["input"] and doc["previous_checkpoint"] == refs["checkpoint"], "CHAIN_CHANGED")
            selected = db.execute("SELECT id FROM investor_epoch_controls WHERE epoch_id=? AND created_at<=? ORDER BY version DESC LIMIT 1", (epoch_id, doc["calculated_at"])).fetchone()
            finished = db.execute("SELECT finished_at FROM job_attempts WHERE job_id=? AND status='succeeded' ORDER BY attempt DESC LIMIT 1", (doc["job_id"],)).fetchone()
            _check(selected is not None and selected["id"] == doc["activation"]["id"] and finished is not None and instant(finished[0]) <= instant(checked)
                and planned["monitor_request"]["model_hash"] == content_hash(definition)
                and planned["monitor_request"]["profile_hash"] == definition["profile_hash"], "RECORDED_CONTEXT_CHANGED")
            _check(instant(row["created_at"]) <= instant(checked) < instant(row["valid_until"])
                and instant(doc["source_ceiling"]) <= min(instant(original_expiry), instant(root["source"]["epoch_definition"]["valid_until"])), "SOURCE_EXPIRED")
            for kind, identifier in (("checkpoint", row["checkpoint_id"]), ("run", row["monitor_run_id"])):
                _check(not db.execute("SELECT 1 FROM investor_monitor_payload_purges WHERE kind=? AND entity_id=?", (kind, identifier)).fetchone(), "PAYLOAD_PURGED")
            value = _recorded_source(db, workspace, actor, root, previous, refs, planned, doc, checked, stop_requested)
            _check(value["input"] == planned["input"] and value["proof"] == doc["source_proof"] and _key(value, doc["activation"], planned["created_at"], planned["implementation_hash"]) == planned["context_key"], "DERIVATION_CHANGED")
            candidate = value["candidate"]; checkpoint = candidate["checkpoint"]
            _check(checkpoint is not None and doc["checkpoint_reused"] == (checkpoint == previous["candidate"]["checkpoint"]), "CHECKPOINT_CHANGED")
            assessment = {key: item for key, item in candidate["assessment"].items() if key != "result_hash"}
            assessment["implementation_hash"] = doc["implementation_hash"]; assessment["result_hash"] = content_hash(assessment); candidate["assessment"] = assessment
            _check(content_hash(checkpoint) == doc["checkpoint"]["content_hash"] and _payload(db, "investor_evidence_checkpoint_payloads", "checkpoint_id", row["checkpoint_id"], 4194304) == checkpoint, "CHECKPOINT_CHANGED")
            expiry = min(original_expiry, planned["input"]["valid_until"], doc["source_ceiling"], key=instant)
            _check(row["valid_until"] == expiry, "RETENTION_CHANGED")
            stored = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE id=?", (row["checkpoint_id"],)).fetchone()
            original_input = db.execute("SELECT content_hash FROM investor_monitor_evidence_inputs WHERE id=? AND workspace_id=? AND model_id=?", (stored["input_id"], workspace, definition["model_id"])).fetchone()
            _check(stored["sequence"] == checkpoint["sequence"] and stored["previous_hash"] == checkpoint["previous_hash"] and stored["created_at"] == checkpoint["created_at"]
                and stored["projection_hash"] == checkpoint["projection_hash"] and original_input is not None and original_input["content_hash"] == checkpoint["input_hash"]
                and instant(stored["valid_until"]) >= instant(expiry), "CHECKPOINT_CHANGED")
            run = _object(db.execute("SELECT document_json FROM investor_evidence_monitor_runs WHERE id=?", (row["monitor_run_id"],)).fetchone()[0])
            rendered = observation(definition, {"input_version": content_hash(planned["monitor_request"])}, candidate, run["next_check_at"])
            _check(run["next_check_at"] == _clock(instant(candidate["assessment"]["next_review_at"])) and instant(doc["created_at"]) < instant(run["next_check_at"]), "RUN_CHANGED")
            payload = {"assessment": candidate["assessment"], "observation": rendered}
            _check(_payload(db, "investor_evidence_run_payloads", "run_id", row["monitor_run_id"], 1048576) == payload
                and run["payload_hash"] == content_hash(payload) and run["observation_hash"] == content_hash(rendered)
                and run["assessment_hash"] == candidate["assessment"]["result_hash"] and run["reason_codes"] == candidate["assessment"]["reason_codes"]
                and run["status"] == rendered["outcome"], "RUN_CHANGED")
            obs = db.execute("SELECT * FROM investor_observations WHERE id=? AND workspace_id=?", (doc["observation_id"], workspace)).fetchone()
            expected = {"schema_version": "investor-model-observation-ref-v1", "run_id": row["monitor_run_id"], "outcome": rendered["outcome"],
                "profile_id": definition["profile_id"], "profile_version": definition["profile_version"], "input_version": run["input_version"], "published_at": row["created_at"]}
            _check(obs is not None and obs["document_json"] == canonical_json(expected) and obs["content_hash"] == content_hash(expected)
                and obs["profile_id"] == definition["profile_id"] and obs["candidate_plan_id"] == definition["plan_id"] and obs["created_at"] == row["created_at"]
                and obs["input_version"] == run["input_version"] and obs["outcome"] == rendered["outcome"], "OBSERVATION_CHANGED")
            previous, refs, last = value, {key: doc[key] for key in ("input", "checkpoint")}, _ref(row)
            original_expiry, limit = expiry, min(limit, expiry, key=instant)
        managed._stopped(db, stop_requested)
        return {"root": root, "definition": definition, "source": previous, "head": refs, "last_publication": last,
            "read_valid_until": limit, "publication_count": len(headers)}


def prepare_epoch_continuation_job(db, job, lease, *, clock=None, stop_requested=None):
    clock = clock or (lambda: None); at = _clock(clock()); assert_writable(db)
    with transaction(db, immediate=False), _fact_validation_scope():
        live = assert_lease(db, lease, at)
        _check(live["id"] == job["id"] and live["job_type"] == JOB_TYPE and live["command_request_id"] is None
            and all(live[key] == job[key] for key in ("scope", "period", "input_version")), "JOB_CHANGED")
        owner = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (job["scope"],)).fetchone(); _check(owner is not None, "OUT_OF_SCOPE")
        workspace, actor = job["scope"], owner[0]; row, request = _request(db, workspace, actor, job["period"])
        _check(row["input_version"] == job["input_version"] and instant(request["created_at"]) <= instant(at), "REQUEST_CHANGED")
        managed._stopped(db, stop_requested)
        obsolete = _obsolete(db, row, request, at)
        if obsolete: return {"result": {"status": "epoch_continuation_obsolete", "reason": obsolete, "live_advice_eligible": False}, "outcome": "skipped"}
        value = source.replay_model_epoch_continuation(db, workspace, actor, row["epoch_id"], request["input"], now=at, stop_requested=stop_requested)
        _check(value["proof"]["previous_input"] == request["previous_input"] and value["proof"]["previous_checkpoint"] == request["previous_checkpoint"], "HEAD_CHANGED")
        _check(_key(value, request["activation"], request["created_at"]) == request["context_key"], "SOURCE_CHANGED")
        result = value["candidate"]; checkpoint = result["checkpoint"]
        _check(checkpoint is not None and result["assessment"]["outcome"] != "insufficient_evidence" and result["assessment"]["next_review_at"] is not None, "CURRENT_INPUTS_NOT_READY")
        previous = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE id=?", (row["previous_checkpoint_id"],)).fetchone()
        expiry = min(request["input"]["valid_until"], previous["valid_until"], request["source_ceiling"], key=instant)
        deadline = min(expiry, request["valid_until"], result["assessment"]["next_review_at"], value["proof"]["valid_until"], key=instant)
        _check(instant(at) < instant(deadline), "CURRENT_INPUTS_NOT_READY")
        chain = read_epoch_continuation_chain(db, workspace, actor, row["epoch_id"], now=at, stop_requested=stop_requested)
        reused = checkpoint == chain["source"]["candidate"]["checkpoint"]
        fence, implementation = _fence(db, workspace, actor), implementation_hash()
    def commit(connection):
        _check(connection is db, "PREPARED_CONNECTION_CHANGED"); assert_writable(db)
        with transaction(db):
            published = _clock(clock()); assert_lease(db, lease, published); managed._stopped(db, stop_requested)
            _revision(db, workspace, actor, request["workspace_revision"])
            _check(instant(at) <= instant(published) < instant(deadline) and implementation_hash() == implementation and _fence(db, workspace, actor) == fence, "PUBLICATION_CHANGED")
            identifier, input_id = new_id("epoch-continuation"), new_id("monitor-evidence-input")
            checkpoint_id = previous["id"] if reused else new_id("evidence-model-checkpoint")
            run_id, observation_id = new_id("evidence-monitor-run"), new_id("evidence-model-observation")
            doc = {"schema_version": "investor-epoch-continuation-publication-v1", "publication_id": identifier, "workspace_id": workspace, "actor_id": actor, "model_id": row["model_id"],
                "epoch": request["epoch"], "sequence": chain["publication_count"] + 1, "request": _ref(row), "activation": request["activation"],
                "previous_input": request["previous_input"], "previous_checkpoint": request["previous_checkpoint"], "previous_publication": chain["last_publication"],
                "input": {"id": input_id, "content_hash": content_hash(value["input"])}, "checkpoint": {"id": checkpoint_id, "content_hash": content_hash(checkpoint)}, "checkpoint_reused": reused,
                "monitor_run_id": run_id, "observation_id": observation_id, "job_id": job["id"], "implementation_hash": implementation, "source_proof": value["proof"], "source_ceiling": request["source_ceiling"],
                "workspace_revision": request["workspace_revision"] + 1, "calculated_at": at, "created_at": published, "publication_deadline": deadline, "valid_until": expiry,
                "monitoring_resumed": True, "historical_observations_rewritten": False, "provider_calls": 0, "trading_permission": False, "distribution": "private_owner_only_not_ai"}
            _validate(doc, "publication"); digest = content_hash(doc); audit = _audit(db, actor, "investor_publish_epoch_continuation", "investor_epoch_continuation", identifier, {"content_hash": digest}, published)
            db.execute("INSERT INTO investor_epoch_continuations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, row["model_id"], row["epoch_id"], doc["sequence"], row["id"], input_id, checkpoint_id, run_id,
                job["id"], canonical_json(doc), digest, actor, published, expiry, audit))
            audit = _audit(db, actor, "investor_admit_monitor_source", "investor_monitor_evidence_input", input_id, {"content_hash": content_hash(value["input"])}, published)
            db.execute("INSERT INTO investor_monitor_evidence_inputs VALUES(?,?,?,'owner_reviewed_reconstructed',?,?,?,?,?,?)", (input_id, workspace, row["model_id"], canonical_json(value["input"]), content_hash(value["input"]), actor,
                value["input"]["created_at"], value["input"]["valid_until"], audit))
            monitor = request["monitor_request"]
            db.execute("INSERT INTO investor_evidence_monitor_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)", (row["id"], workspace, row["model_id"], monitor["control_id"], input_id, previous["id"],
                "epoch-continuation:" + row["id"], row["input_version"], row["input_version"], canonical_json(monitor), row["created_at"]))
            if not reused:
                db.execute("INSERT INTO investor_evidence_model_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?)", (checkpoint_id, workspace, row["model_id"], input_id, checkpoint["sequence"], checkpoint["previous_hash"],
                    content_hash(checkpoint), checkpoint["projection_hash"], checkpoint["created_at"], expiry))
                db.execute("INSERT INTO investor_evidence_checkpoint_payloads VALUES(?,?)", (checkpoint_id, canonical_json(checkpoint).encode()))
            definition = value["kernel_input"]["definition"]; next_check = _clock(instant(result["assessment"]["next_review_at"]))
            rendered = observation(definition, {"input_version": row["input_version"]}, result, next_check)
            ref = {"schema_version": "investor-model-observation-ref-v1", "run_id": run_id, "outcome": rendered["outcome"], "profile_id": definition["profile_id"], "profile_version": definition["profile_version"],
                "input_version": row["input_version"], "published_at": published}
            payload = {"assessment": result["assessment"], "observation": rendered}
            run = {"schema_version": "investor-evidence-monitor-run-v1", "request_id": row["id"], "model_id": row["model_id"], "input_version": row["input_version"], "implementation_hash": implementation,
                "status": rendered["outcome"], "reason_codes": result["assessment"]["reason_codes"], "projection_hash": content_hash(value["projection"]), "checkpoint_hash": content_hash(checkpoint),
                "assessment_hash": result["assessment"]["result_hash"], "observation_hash": content_hash(rendered), "payload_hash": content_hash(payload), "next_check_at": next_check, "created_at": published, "valid_until": expiry, "live_advice_eligible": False}
            validate_contract(ref, "investor-evidence-monitor.schema.json", fragment="$defs/observation_ref"); validate_contract(run, "investor-evidence-monitor.schema.json", fragment="$defs/run")
            db.execute("INSERT INTO investor_observations VALUES(?,?,?,?,?,?,?,?,?)", (observation_id, workspace, definition["profile_id"], definition["plan_id"], rendered["outcome"], canonical_json(ref), content_hash(ref), row["input_version"], published))
            db.execute("INSERT INTO investor_evidence_monitor_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (run_id, workspace, row["model_id"], row["id"], job["id"], observation_id, checkpoint_id, rendered["outcome"], canonical_json(run), content_hash(run), published, expiry))
            db.execute("INSERT INTO investor_evidence_run_payloads VALUES(?,?)", (run_id, canonical_json(payload).encode()))
            enqueue_notification(db, "epoch-continuation:" + identifier, "investor.observation.changed", {"workspace_id": workspace, "model_id": row["model_id"], "observation_id": observation_id, "outcome": rendered["outcome"], "live_advice_eligible": False}, now=published)
            managed._stopped(db, stop_requested); _check(instant(_clock(clock())) < instant(deadline), "PUBLICATION_EXPIRED")
            db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (workspace,))
            return JobCommit(_job_result({"id": identifier, "epoch_id": row["epoch_id"], "monitor_run_id": run_id, "checkpoint_id": checkpoint_id}, doc))
    return {"effect": commit}


def assert_epoch_continuation_finalization(db, job, lease, result, outcome, finished):
    assert_lease(db, lease, finished); _check(type(result) is dict, "FINALIZATION_CHANGED")
    if outcome == "skipped":
        owner = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (job["scope"],)).fetchone(); _check(owner is not None, "OUT_OF_SCOPE")
        request_row, request = _request(db, job["scope"], owner[0], job["period"])
        reason = _obsolete(db, request_row, request, finished)
        _check(reason is not None and result == {"status": "epoch_continuation_obsolete", "reason": reason, "live_advice_eligible": False}
            and not db.execute("SELECT 1 FROM investor_epoch_continuations WHERE job_id=? OR request_id=?", (job["id"], job["period"])).fetchone(), "FINALIZATION_CHANGED")
        return
    _check(outcome == "succeeded", "FINALIZATION_CHANGED")
    row = db.execute("SELECT * FROM investor_epoch_continuations WHERE request_id=? AND job_id=? AND workspace_id=?", (job["period"], job["id"], job["scope"])).fetchone()
    _check(row is not None, "FINALIZATION_CHANGED"); doc = _object(row["document_json"]); _validate(doc, "publication")
    _check(content_hash(doc) == row["content_hash"] and result == _job_result(row, doc)
        and instant(doc["created_at"]) <= instant(finished) < instant(doc["publication_deadline"]), "PUBLICATION_EXPIRED")
    _revision(db, job["scope"], doc["actor_id"], doc["workspace_revision"])


def _obsolete(db, row, request, at):
    if instant(at) >= instant(row["valid_until"]): return "REQUEST_EXPIRED"
    if db.execute("SELECT revision FROM investor_workspaces WHERE id=?", (row["workspace_id"],)).fetchone()[0] != request["workspace_revision"]: return "WORKSPACE_CHANGED"
    control = db.execute("SELECT id FROM investor_epoch_controls WHERE epoch_id=? ORDER BY version DESC LIMIT 1", (row["epoch_id"],)).fetchone()
    if control is None or control["id"] != row["control_id"]: return "CONTROL_CHANGED"
    if request["implementation_hash"] != implementation_hash(): return "IMPLEMENTATION_CHANGED"
    head = db.execute("SELECT id,content_hash FROM investor_evidence_model_checkpoints WHERE model_id=? AND workspace_id=? ORDER BY sequence DESC LIMIT 1", (row["model_id"], row["workspace_id"])).fetchone()
    latest = db.execute("SELECT id,content_hash FROM investor_monitor_evidence_inputs WHERE model_id=? AND workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", (row["model_id"], row["workspace_id"])).fetchone()
    if head is None or latest is None or _ref(head) != request["previous_checkpoint"] or _ref(latest) != request["previous_input"]: return "HEAD_CHANGED"
    return None
