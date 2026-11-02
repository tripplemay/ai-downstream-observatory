"""Distinct admitted knowledge bridge; original rows and current eligibility stay separate."""

from copy import deepcopy

from worker.market.contracts import validate_contract
from worker.orchestration.db import assert_writable, canonical_json, content_hash, new_id, transaction
from .data_evidence import _assert, _audit, _audit_binding, _fact_validation_scope, _object, _owner, resolve_review
from .legacy_action_transition import LEGACY, _audited_actions, _carry_actions, _check_unprocessed_history, _compare_original_input, _stop
from .legacy_transition_workflow import _confirmation_header, _revision, _verified_transition
from .model_runtime import _clock, _latest
from .monitor_admission import latest_monitor_evidence, monitor_evidence_document
from .monitor_data import validate_monitor_data_document


SCHEMA = "investor-legacy-transition-source.schema.json"


def _validate(value, kind):
    validate_contract(value, SCHEMA, fragment="$defs/" + kind)
    if "expected_revision" in value: _assert(type(value["expected_revision"]) is int, "VERSION_CONFLICT")


def audited_document(document):
    validate_monitor_data_document(document)
    _assert(document["schema_version"] == "investor-monitor-data-input-v5", "LEGACY_TRANSITION_PROTOCOL_REQUIRED")
    result = deepcopy(document)
    for key in ("transition", "audited_projection_hash", "audited_valid_until"): del result[key]
    result.update(schema_version="investor-monitor-data-input-v4", projection_hash=document["audited_projection_hash"], valid_until=document["audited_valid_until"])
    validate_monitor_data_document(result)
    return result


def _admission_header(db, workspace, actor, transition_id):
    _owner(db, workspace, actor)
    row = db.execute("SELECT * FROM investor_legacy_transition_admissions WHERE transition_id=? AND workspace_id=?", (transition_id, workspace)).fetchone()
    _assert(row is not None, "LEGACY_TRANSITION_ADMISSION_REQUIRED")
    doc = _object(row["document_json"]); _validate(doc, "admission")
    _assert(row["actor_id"] == actor and canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"]
        and doc["admission_id"] == row["id"] and all(doc[key] == row[key] for key in
            ("workspace_id", "workspace_revision", "model_id", "transition_id", "input_id", "request_hash", "created_at", "valid_until"))
        and content_hash(doc["request"]) == row["request_hash"] and doc["request"]["idempotency_key"] == row["idempotency_key"]
        and doc["request"]["expected_revision"] == doc["workspace_revision"] - 1
        and doc["request"]["transition_id"] == transition_id and doc["request"]["transition_hash"] == doc["transition_hash"],
        "LEGACY_TRANSITION_ADMISSION_INVALID")
    _audit_binding(db, row, "investor_register_legacy_transition_source", "investor_legacy_transition_admission", row["id"])
    receipt_row, receipt = _confirmation_header(db, workspace, actor, transition_id)
    source, root = monitor_evidence_document(db, workspace, row["model_id"], row["input_id"], row["created_at"])
    _assert(receipt["model_id"] == row["model_id"] and receipt_row["content_hash"] == doc["transition_hash"]
        and root["schema_version"] == "investor-monitor-data-input-v5" and root["transition"] == {"id": transition_id, "content_hash": receipt_row["content_hash"]}
        and source["content_hash"] == doc["input_hash"] and source["created_at"] == row["created_at"]
        and source["valid_until"] == row["valid_until"] <= receipt["valid_until"] and receipt["created_at"] <= row["created_at"],
        "LEGACY_TRANSITION_ADMISSION_INVALID")
    return row, doc


def _context(db, workspace, definition, reference, at, stop_requested=None):
    _validate(reference, "transition_ref")
    owner = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (workspace,)).fetchone()
    _assert(owner is not None, "LEGACY_TRANSITION_OUT_OF_SCOPE")
    row, receipt = _confirmation_header(db, workspace, owner[0], reference["id"])
    _assert(row["content_hash"] == reference["content_hash"] and receipt["model_id"] == definition["model_id"]
        and receipt["model_hash"] == content_hash(definition), "LEGACY_TRANSITION_BINDING_CHANGED")
    _, admission = _admission_header(db, workspace, owner[0], reference["id"])
    proof = _verified_transition(db, workspace, owner[0], reference["id"], at, stop_requested)
    return {**proof, "admission": admission}


def _action_references(db, workspace, proof, document, at):
    from .action_checkpoint_replay import checkpoint_action_review
    from .action_review_selection import check_action_review_extension, check_paused_checkpoint_extension, retired_action_review
    from .source_inputs import _review_kind
    selected = {}
    for segment in proof["candidate"]["document"]["segments"]:
        for ref in segment["snapshot"]["review_refs"]:
            if _review_kind(db, workspace, ref["review_id"]) == "actions":
                value = resolve_review(db, workspace, ref["review_id"], "actions", now=at)
                selected[value["facts"]["listing_id"]] = value
    for segment in document["segments"]:
        snapshot = segment["snapshot"]
        for ref in snapshot["review_refs"]:
            if _review_kind(db, workspace, ref["review_id"]) != "actions": continue
            prior = resolve_review(db, workspace, ref["review_id"], "actions", now=at)
            current = selected.get(prior["facts"]["listing_id"])
            _assert(current is not None, "LEGACY_TRANSITION_ACTION_SELECTION_CHANGED")
            if prior["review"]["id"] == current["review"]["id"]:
                _assert(prior == current, "LEGACY_TRANSITION_ACTION_SELECTION_CHANGED"); continue
            _assert(checkpoint_action_review(db, workspace, ref["review_id"], "actions", at) == prior,
                "LEGACY_TRANSITION_ACTION_SELECTION_CHANGED")
            extension = check_action_review_extension if retired_action_review(db, workspace, ref["review_id"], at) else check_paused_checkpoint_extension
            extension(db, workspace, prior, current, at, start_date=snapshot["range_start"], end_date=snapshot["range_end"])


def _derive(db, workspace, definition, proof, raw, at):
    receipt = proof["confirmation"]; document = raw["document"]; projection = raw["projection"]
    _assert(document["schema_version"] == "investor-monitor-data-input-v4" and projection["schema_version"] == "investor-monitor-data-projection-v2"
        and receipt["created_at"] <= document["created_at"] <= at < receipt["valid_until"], "LEGACY_TRANSITION_BINDING_CHANGED")
    if "admission" in proof:
        _assert(proof["admission"]["created_at"] <= document["created_at"], "LEGACY_TRANSITION_BINDING_CHANGED")
    _action_references(db, workspace, proof, document, at)
    actions = _audited_actions(db, workspace, definition, document, at)
    carry = _carry_actions(proof["ledger"], actions)
    _assert(content_hash(carry) == receipt["carry_hash"] and len(carry) == receipt["carry_count"], "LEGACY_TRANSITION_ACTION_CARRY_CHANGED")
    _check_unprocessed_history(definition, proof["checkpoint"], proof["ledger"], actions)
    values = {row["id"]: row for row in actions}
    bound = deepcopy(projection)
    for action in bound["corporate_actions"]:
        _assert(action == values.get(action["id"]), "LEGACY_TRANSITION_ACTION_CARRY_CHANGED")
        if action["id"] in proof["ledger"]: action["known_at"] = proof["ledger"][action["id"]]["action"]["known_at"]
    reference = {"id": receipt["confirmation_id"], "content_hash": content_hash(receipt)}
    bound.update(schema_version="investor-monitor-data-projection-v3", transition=reference,
        knowledge_protocol="owner_confirmed_legacy_accounting_carry_v1", valid_until=min(projection["valid_until"], receipt["valid_until"]))
    for row in [*bound["quotes"], *bound["fx"]]: row["valid_until"] = min(row["valid_until"], receipt["valid_until"])
    validate_contract(bound, "investor-monitor-data-projection-v3.schema.json")
    result = {**deepcopy(document), "schema_version": "investor-monitor-data-input-v5", "transition": reference,
        "audited_projection_hash": document["projection_hash"], "audited_valid_until": document["valid_until"],
        "projection_hash": content_hash(bound), "valid_until": min(document["valid_until"], receipt["valid_until"])}
    validate_monitor_data_document(result)
    return {"document": result, "projection": bound, "catalog": raw["catalog"], "content_hash": content_hash(result)}


def bind_transition_monitor_data(db, workspace, definition, reference, raw, at):
    with transaction(db, immediate=False), _fact_validation_scope():
        return _derive(db, workspace, definition, _context(db, workspace, definition, reference, at), raw, at)


def compare_transition_monitor_data(db, workspace, definition, document, *, now=None):
    from .monitor_data import compare_monitor_data
    at = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope():
        raw_document = audited_document(document)
        result = compare_monitor_data(db, workspace, definition, raw_document, now=at)
        if result["comparison_projection"] is None: return result
        raw = {"document": raw_document, "projection": result["comparison_projection"], "catalog": result["comparison_catalog"]}
        bound = bind_transition_monitor_data(db, workspace, definition, document["transition"], raw, at)
        _assert(bound["document"] == document, "LEGACY_TRANSITION_DERIVATION_CHANGED")
        return {"comparison_projection": bound["projection"], "comparison_catalog": bound["catalog"],
            "unavailable_reason": result["unavailable_reason"]}


def resolve_transition_monitor_data(db, workspace, definition, document, *, now=None, evaluated_at=None):
    at = _clock(now); evaluated = at if evaluated_at is None else _clock(evaluated_at)
    validate_monitor_data_document(document)
    _assert(document["created_at"] <= evaluated <= at, "LEGACY_TRANSITION_CLOCK_INVALID")
    result = compare_transition_monitor_data(db, workspace, definition, document, now=at)
    if result["comparison_projection"] is None:
        return {"document": document, "projection": None, "unavailable_reason": result["unavailable_reason"]}
    if result["comparison_projection"]["valid_until"] <= evaluated:
        return {"document": document, "projection": None, "unavailable_reason": "MONITOR_DATA_PROJECTION_EXPIRED"}
    return {"document": document, "projection": result["comparison_projection"], "catalog": result["comparison_catalog"],
        "content_hash": content_hash(document), "unavailable_reason": None}


def _root_plan(db, workspace, actor, request, at, stop_requested):
    _revision(db, workspace, actor, request["expected_revision"]); _stop(stop_requested)
    row, receipt = _confirmation_header(db, workspace, actor, request["transition_id"])
    _assert(row["content_hash"] == request["transition_hash"], "LEGACY_TRANSITION_BINDING_CHANGED")
    _assert(not db.execute("SELECT 1 FROM investor_legacy_transition_admissions WHERE transition_id=?", (row["id"],)).fetchone(),
        "LEGACY_TRANSITION_ALREADY_REGISTERED")
    source = latest_monitor_evidence(db, workspace, row["model_id"])
    head = _latest(db, "investor_evidence_model_checkpoints", row["model_id"], "sequence DESC")
    _assert(source is not None and source["id"] == receipt["legacy_input_id"] and head is not None and head["id"] == receipt["checkpoint"]["id"],
        "LEGACY_TRANSITION_ORIGINAL_INPUT_CHANGED")
    proof = _verified_transition(db, workspace, actor, row["id"], at, stop_requested)
    definition = _object(db.execute("SELECT document_json FROM investor_models WHERE id=? AND workspace_id=?", (row["model_id"], workspace)).fetchone()[0])
    return _derive(db, workspace, definition, proof, proof["candidate"], at)


def prepare_legacy_transition_source(db, workspace, actor, request, *, now=None, clock=None, stop_requested=None):
    assert_writable(db); _owner(db, workspace, actor); _validate(request, "request"); request = _object(canonical_json(request))
    digest = content_hash(request); at = _clock(clock() if clock else now); _stop(stop_requested)
    existing = db.execute("SELECT transition_id,request_hash FROM investor_legacy_transition_admissions WHERE workspace_id=? AND idempotency_key=?", (workspace, request["idempotency_key"])).fetchone()
    if existing:
        _assert(existing["request_hash"] == digest, "DUPLICATE_CONFLICT")
        def replay(connection):
            _assert(connection is db, "PREPARED_CONNECTION_CHANGED")
            return _admission_header(db, workspace, actor, existing["transition_id"])[1]
        return replay
    with transaction(db, immediate=False), _fact_validation_scope(): _root_plan(db, workspace, actor, request, at, stop_requested)
    def commit(connection):
        _assert(connection is db, "PREPARED_CONNECTION_CHANGED")
        with transaction(db), _fact_validation_scope():
            current = _clock(clock() if clock else now); _stop(stop_requested)
            concurrent = db.execute("SELECT transition_id,request_hash FROM investor_legacy_transition_admissions WHERE workspace_id=? AND idempotency_key=?", (workspace, request["idempotency_key"])).fetchone()
            if concurrent:
                _assert(concurrent["request_hash"] == digest, "DUPLICATE_CONFLICT")
                return _admission_header(db, workspace, actor, concurrent["transition_id"])[1]
            built = _root_plan(db, workspace, actor, request, current, stop_requested); document = built["document"]
            sealed = _clock(clock() if clock else now)
            _assert(at <= current <= sealed < document["valid_until"], "LEGACY_TRANSITION_SOURCE_EXPIRED")
            _stop(stop_requested); assert_writable(db); _revision(db, workspace, actor, request["expected_revision"])
            encoded = canonical_json(document); _assert(len(encoded.encode()) <= 1048576, "LEGACY_TRANSITION_SIZE_LIMIT")
            input_id = new_id("monitor-evidence-input"); input_audit = _audit(db, actor, "investor_admit_monitor_source", "investor_monitor_evidence_input",
                input_id, {"content_hash": built["content_hash"]}, current)
            db.execute("INSERT INTO investor_monitor_evidence_inputs(id,workspace_id,model_id,source_qualification,document_json,content_hash,actor_id,created_at,valid_until,audit_id) VALUES(?,?,?,'owner_reviewed_reconstructed',?,?,?,?,?,?)",
                (input_id, workspace, document["model_id"], encoded, built["content_hash"], actor, current, document["valid_until"], input_audit))
            identifier = new_id("legacy-transition-admission")
            doc = {"schema_version": "investor-legacy-transition-source-admission-v1", "admission_id": identifier, "workspace_id": workspace,
                "workspace_revision": request["expected_revision"] + 1, "model_id": document["model_id"], "transition_id": request["transition_id"],
                "transition_hash": request["transition_hash"], "input_id": input_id, "input_hash": built["content_hash"], "request": request, "request_hash": digest,
                "created_at": current, "valid_until": document["valid_until"], "monitor_source_registered": True, "monitoring_activated": False,
                "trading_permission": False, "raw_ai_sharing": False, "provider_calls": 0}
            _validate(doc, "admission"); hashed = content_hash(doc)
            audit = _audit(db, actor, "investor_register_legacy_transition_source", "investor_legacy_transition_admission", identifier, {"content_hash": hashed}, current)
            db.execute("INSERT INTO investor_legacy_transition_admissions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, document["model_id"],
                request["transition_id"], doc["workspace_revision"], request["idempotency_key"], digest, input_id, canonical_json(doc), hashed, actor, current, document["valid_until"], audit))
            db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (workspace,))
            return doc
    return commit


def admit_legacy_transition_source(db, workspace, actor, request, **kwargs):
    return prepare_legacy_transition_source(db, workspace, actor, request, **kwargs)(db)


def replay_approved_legacy_checkpoint(db, workspace, definition, checkpoint, document, now):
    if document["schema_version"] not in LEGACY: return None
    latest = latest_monitor_evidence(db, workspace, definition["model_id"])
    if latest is None: return None
    _, current = monitor_evidence_document(db, workspace, definition["model_id"], latest["id"], now)
    if current["schema_version"] != "investor-monitor-data-input-v5": return None
    proof = _context(db, workspace, definition, current["transition"], now)
    _assert(now < current["valid_until"] and checkpoint["sequence"] <= proof["confirmation"]["checkpoint"]["sequence"],
        "LEGACY_TRANSITION_CHECKPOINT_SCOPE_CHANGED")
    binding = proof["bindings"][checkpoint["sequence"] - 1]
    _assert({key: value for key, value in binding.items() if key != "input_hash"} == dict(checkpoint), "LEGACY_TRANSITION_CHECKPOINT_SCOPE_CHANGED")
    source, original = monitor_evidence_document(db, workspace, definition["model_id"], checkpoint["input_id"], now)
    _assert(original == document, "LEGACY_TRANSITION_ORIGINAL_INPUT_CHANGED")
    return _compare_original_input(db, workspace, definition, source, original, now)


def approved_legacy_refresh_context(db, workspace, definition, source, document, at):
    """Only the actual pre-transition intent may rebind a completed capture."""
    current = latest_monitor_evidence(db, workspace, definition["model_id"])
    if current is None: return False
    _, active = monitor_evidence_document(db, workspace, definition["model_id"], current["id"], at)
    if active["schema_version"] != "investor-monitor-data-input-v5": return False
    proof = _context(db, workspace, definition, active["transition"], at)
    _assert(source["id"] == proof["confirmation"]["legacy_input_id"] and source["content_hash"] == proof["confirmation"]["legacy_input_hash"]
        and at < active["valid_until"], "CONFIRMED_FEED_ACTION_PROTOCOL_REVIEW_REQUIRED")
    original = _compare_original_input(db, workspace, definition, source, document, at)
    _assert(original["unavailable_reason"] is None, "CONFIRMED_FEED_SOURCE_UNAVAILABLE")
    return True
