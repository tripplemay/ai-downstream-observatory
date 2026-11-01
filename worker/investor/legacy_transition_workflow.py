"""Explicit accounting-compatibility consent, not admission or model activation."""

from copy import deepcopy
from datetime import timedelta

from worker.market.contracts import validate_contract
from worker.orchestration.db import assert_writable, canonical_json, content_hash, instant, new_id, transaction
from .data_evidence import _assert, _audit, _audit_binding, _fact_validation_scope, _object, _owner
from .legacy_action_transition import (_audited_actions, _carry_actions, _check_unprocessed_history,
    _compare_original_input, _original_chain, _prepare_legacy_action_transition, _stop)
from .model_runtime import _clock, _latest
from .monitor_admission import current_monitor_model, monitor_evidence_document
from .monitor_data import build_monitor_data, check_reference_listing_identity, validate_monitor_data_document


SCHEMA = "investor-legacy-transition-workflow.schema.json"
PROTOCOL = "preserve_original_processed_action_knowledge_v1"


def _validate(value, fragment):
    validate_contract(value, SCHEMA, fragment="$defs/" + fragment)
    if "expected_revision" in value: _assert(type(value["expected_revision"]) is int, "VERSION_CONFLICT")


def _revision(db, workspace, actor, expected):
    _owner(db, workspace, actor)
    _assert(type(expected) is int and db.execute("SELECT revision FROM investor_workspaces WHERE id=?", (workspace,)).fetchone()[0] == expected,
        "VERSION_CONFLICT")


def _compact(preview):
    keys = ("model_hash", "control_hash", "legacy_input_id", "legacy_input_hash", "settings_hash", "checkpoint",
        "audited_document_hash", "audited_projection_hash", "projection_quality_gaps", "source_valid_until")
    return {**{key: preview[key] for key in keys}, "carry_hash": content_hash(preview["carry_forward"]), "carry_count": len(preview["carry_forward"])}


def _basis(plan):
    # Dataset/source-evidence hashes include the construction clock. Bind the
    # complete raw-source manifests instead; the planner replays their bytes.
    document = deepcopy(plan["candidate"])
    for key in ("created_at", "projection_hash"): del document[key]
    for segment in document["segments"]:
        del segment["snapshot"]["created_at"]; del segment["dataset_hash"]
    proof = _compact(plan["preview"])
    for key in ("audited_document_hash", "audited_projection_hash"): del proof[key]
    return content_hash({"candidate": document, "proof": proof})


def _preview_header(db, workspace, actor, identifier):
    _owner(db, workspace, actor)
    row = db.execute("SELECT * FROM investor_legacy_transition_previews WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    _assert(row is not None, "LEGACY_TRANSITION_PREVIEW_OUT_OF_SCOPE")
    doc, candidate = _object(row["document_json"]), _object(row["candidate_json"])
    _validate(doc, "preview"); validate_monitor_data_document(candidate)
    _assert(row["actor_id"] == actor and content_hash(doc) == row["content_hash"] and canonical_json(doc) == row["document_json"]
        and canonical_json(candidate) == row["candidate_json"] and doc["preview_id"] == row["id"]
        and all(doc[key] == row[key] for key in ("workspace_id", "workspace_revision", "model_id", "control_id", "request_hash", "created_at", "valid_until"))
        and candidate["schema_version"] == "investor-monitor-data-input-v4" and candidate["workspace_id"] == workspace
        and candidate["model_id"] == doc["model_id"] and candidate["created_at"] == doc["checked_at"]
        and content_hash(candidate) == doc["proof"]["audited_document_hash"] and candidate["projection_hash"] == doc["proof"]["audited_projection_hash"]
        and doc["proof"]["legacy_input_id"] == row["legacy_input_id"] and doc["proof"]["checkpoint"]["id"] == row["checkpoint_id"],
        "LEGACY_TRANSITION_PREVIEW_INVALID")
    _assert(doc["request_hash"] == content_hash({"model_id": doc["model_id"], "expected_revision": row["workspace_revision"] - 1,
        "idempotency_key": row["idempotency_key"]}) and doc["checked_at"] <= doc["created_at"] < doc["valid_until"]
        and doc["valid_until"] <= min(doc["proof"]["source_valid_until"], _clock(instant(doc["checked_at"]) + timedelta(minutes=5))),
        "LEGACY_TRANSITION_PREVIEW_INVALID")
    _audit_binding(db, row, "investor_preview_legacy_transition", "investor_legacy_transition_preview", identifier)
    return row, doc, candidate


def _confirmation_header(db, workspace, actor, identifier):
    _owner(db, workspace, actor)
    row = db.execute("SELECT * FROM investor_legacy_transition_confirmations WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    _assert(row is not None, "LEGACY_TRANSITION_CONFIRMATION_OUT_OF_SCOPE")
    doc = _object(row["document_json"]); _validate(doc, "confirmation")
    _assert(row["actor_id"] == actor and canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"]
        and doc["confirmation_id"] == row["id"] and doc["checkpoint"]["id"] == row["checkpoint_id"]
        and all(doc[key] == row[key] for key in ("workspace_id", "workspace_revision", "model_id", "preview_id", "control_id", "legacy_input_id", "request_hash", "created_at", "valid_until"))
        and content_hash(doc["request"]) == row["request_hash"] and doc["request"]["idempotency_key"] == row["idempotency_key"],
        "LEGACY_TRANSITION_CONFIRMATION_INVALID")
    _, witness, _ = _preview_header(db, workspace, actor, row["preview_id"])
    _assert(doc["preview_hash"] == content_hash(witness) == doc["request"]["expected_preview_hash"]
        and doc["request"]["preview_id"] == witness["preview_id"]
        and doc["workspace_revision"] - 1 == doc["request"]["expected_revision"] == witness["workspace_revision"]
        and doc["model_id"] == witness["model_id"] and doc["control_id"] == witness["control_id"]
        and all(doc[key] == witness["proof"][key] for key in ("model_hash", "control_hash", "legacy_input_id", "legacy_input_hash", "checkpoint", "carry_hash", "carry_count"))
        and witness["created_at"] <= doc["created_at"] < witness["valid_until"] and doc["created_at"] < doc["valid_until"],
        "LEGACY_TRANSITION_CONFIRMATION_INVALID")
    _audit_binding(db, row, "investor_confirm_legacy_transition", "investor_legacy_transition_confirmation", identifier)
    return row, doc


def _already_confirmed(db, workspace, model_id):
    _assert(not db.execute("SELECT 1 FROM investor_legacy_transition_confirmations WHERE workspace_id=? AND model_id=?", (workspace, model_id)).fetchone(),
        "LEGACY_TRANSITION_ALREADY_CONFIRMED")


def _fresh_plan(db, workspace, actor, witness, at, stop_requested):
    _assert(witness["created_at"] <= at < witness["valid_until"], "LEGACY_TRANSITION_PREVIEW_EXPIRED")
    _revision(db, workspace, actor, witness["workspace_revision"])
    plan = _prepare_legacy_action_transition(db, workspace, actor, witness["model_id"], now=at, stop_requested=stop_requested)
    control = _latest(db, "investor_model_controls", witness["model_id"], "version DESC")
    _assert(control["id"] == witness["control_id"] and _basis(plan) == witness["basis_hash"], "LEGACY_TRANSITION_BASIS_CHANGED")
    return plan


def prepare_legacy_transition_preview(db, workspace, actor, request, *, now=None, clock=None, stop_requested=None):
    assert_writable(db); _owner(db, workspace, actor); _validate(request, "preview_request"); request = _object(canonical_json(request))
    digest = content_hash(request); at = _clock(clock() if clock else now); _stop(stop_requested)
    existing = db.execute("SELECT id,request_hash FROM investor_legacy_transition_previews WHERE workspace_id=? AND idempotency_key=?", (workspace, request["idempotency_key"])).fetchone()
    if existing:
        _assert(existing["request_hash"] == digest, "DUPLICATE_CONFLICT")
        def replay(connection):
            _assert(connection is db, "PREPARED_CONNECTION_CHANGED")
            return _preview_header(db, workspace, actor, existing["id"])[1]
        return replay
    with transaction(db, immediate=False):
        _revision(db, workspace, actor, request["expected_revision"]); _already_confirmed(db, workspace, request["model_id"])
        plan = _prepare_legacy_action_transition(db, workspace, actor, request["model_id"], now=at, stop_requested=stop_requested)
        control = dict(_latest(db, "investor_model_controls", request["model_id"], "version DESC"))
    def commit(connection):
        _assert(connection is db, "PREPARED_CONNECTION_CHANGED")
        with transaction(db), _fact_validation_scope():
            current = _clock(clock() if clock else now); _stop(stop_requested)
            concurrent = db.execute("SELECT id,request_hash FROM investor_legacy_transition_previews WHERE workspace_id=? AND idempotency_key=?", (workspace, request["idempotency_key"])).fetchone()
            if concurrent:
                _assert(concurrent["request_hash"] == digest, "DUPLICATE_CONFLICT")
                return _preview_header(db, workspace, actor, concurrent["id"])[1]
            _revision(db, workspace, actor, request["expected_revision"]); _already_confirmed(db, workspace, request["model_id"])
            fresh = _prepare_legacy_action_transition(db, workspace, actor, request["model_id"], now=current, stop_requested=stop_requested)
            _assert(_basis(fresh) == _basis(plan) and dict(_latest(db, "investor_model_controls", request["model_id"], "version DESC")) == control,
                "LEGACY_TRANSITION_BASIS_CHANGED")
            sealed = _clock(clock() if clock else now)
            deadline = min(plan["preview"]["source_valid_until"], _clock(instant(at) + timedelta(minutes=5)))
            _assert(at <= current <= sealed < deadline, "LEGACY_TRANSITION_PREVIEW_EXPIRED")
            _stop(stop_requested); assert_writable(db)
            identifier = new_id("legacy-transition-preview")
            doc = {"schema_version": "investor-legacy-transition-witness-v1", "preview_id": identifier, "workspace_id": workspace,
                "workspace_revision": request["expected_revision"] + 1, "model_id": request["model_id"], "control_id": control["id"],
                "request_hash": digest, "comparison_hash": content_hash(plan["preview"]), "basis_hash": _basis(plan), "proof": _compact(plan["preview"]),
                "checked_at": at, "created_at": sealed, "valid_until": deadline, "approval_performed": False,
                "research_admitted": False, "trading_permission": False, "provider_calls": 0}
            _validate(doc, "preview"); hashed = content_hash(doc); encoded = canonical_json(doc); candidate = canonical_json(plan["candidate"])
            _assert(len(encoded.encode()) <= 32768 and len(candidate.encode()) <= 1048576, "LEGACY_TRANSITION_SIZE_LIMIT")
            audit = _audit(db, actor, "investor_preview_legacy_transition", "investor_legacy_transition_preview", identifier, {"content_hash": hashed}, sealed)
            db.execute("INSERT INTO investor_legacy_transition_previews VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, request["model_id"], control["id"],
                doc["proof"]["legacy_input_id"], doc["proof"]["checkpoint"]["id"], doc["workspace_revision"], request["idempotency_key"], digest,
                candidate, encoded, hashed, actor, sealed, deadline, audit))
            db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (workspace,))
            return doc
    return commit


def register_legacy_transition_preview(db, workspace, actor, request, **kwargs):
    return prepare_legacy_transition_preview(db, workspace, actor, request, **kwargs)(db)


def resolve_legacy_transition_preview(db, workspace, actor, identifier, *, now=None, stop_requested=None):
    with transaction(db, immediate=False), _fact_validation_scope():
        _, witness, _ = _preview_header(db, workspace, actor, identifier)
        _fresh_plan(db, workspace, actor, witness, _clock(now), stop_requested)
        return witness


def _receipt_expiry(db, workspace, model_id, proof, at):
    _, document = monitor_evidence_document(db, workspace, model_id, proof["legacy_input_id"], at)
    head = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?",
        (proof["checkpoint"]["id"], workspace, model_id)).fetchone()
    _, definition, _ = current_monitor_model(db, workspace, model_id, at)
    _assert(head is not None and head["content_hash"] == proof["checkpoint"]["content_hash"], "LEGACY_TRANSITION_CHECKPOINT_CHAIN_CHANGED")
    # Consent is not an initial fee quote. Later owner cost receipts and pauses
    # are checked separately by ordinary consumers, never frozen by this TTL.
    return min(head["valid_until"], document["valid_until"], definition["valid_until"])


def prepare_legacy_transition_confirmation(db, workspace, actor, request, *, now=None, clock=None, stop_requested=None):
    assert_writable(db); _owner(db, workspace, actor); _validate(request, "submit"); request = _object(canonical_json(request))
    digest = content_hash(request); at = _clock(clock() if clock else now); _stop(stop_requested)
    existing = db.execute("SELECT id,request_hash FROM investor_legacy_transition_confirmations WHERE workspace_id=? AND idempotency_key=?", (workspace, request["idempotency_key"])).fetchone()
    if existing:
        _assert(existing["request_hash"] == digest, "DUPLICATE_CONFLICT")
        def replay(connection):
            _assert(connection is db, "PREPARED_CONNECTION_CHANGED")
            return _confirmation_header(db, workspace, actor, existing["id"])[1]
        return replay
    with transaction(db, immediate=False), _fact_validation_scope():
        _, witness, _ = _preview_header(db, workspace, actor, request["preview_id"])
        _assert(content_hash(witness) == request["expected_preview_hash"], "LEGACY_TRANSITION_PREVIEW_CHANGED")
        _assert(witness["workspace_revision"] == request["expected_revision"], "VERSION_CONFLICT")
        _already_confirmed(db, workspace, witness["model_id"]); _fresh_plan(db, workspace, actor, witness, at, stop_requested)
    def commit(connection):
        _assert(connection is db, "PREPARED_CONNECTION_CHANGED")
        with transaction(db), _fact_validation_scope():
            current = _clock(clock() if clock else now); _stop(stop_requested)
            concurrent = db.execute("SELECT id,request_hash FROM investor_legacy_transition_confirmations WHERE workspace_id=? AND idempotency_key=?", (workspace, request["idempotency_key"])).fetchone()
            if concurrent:
                _assert(concurrent["request_hash"] == digest, "DUPLICATE_CONFLICT")
                return _confirmation_header(db, workspace, actor, concurrent["id"])[1]
            _already_confirmed(db, workspace, witness["model_id"]); _fresh_plan(db, workspace, actor, witness, current, stop_requested)
            expiry = _receipt_expiry(db, workspace, witness["model_id"], witness["proof"], current)
            sealed = _clock(clock() if clock else now)
            _assert(at <= current <= sealed < min(expiry, witness["valid_until"]), "LEGACY_TRANSITION_PREVIEW_EXPIRED")
            _stop(stop_requested); assert_writable(db)
            identifier = new_id("legacy-transition-confirmation"); proof = witness["proof"]
            doc = {"schema_version": "investor-legacy-transition-confirmation-v1", "confirmation_id": identifier, "workspace_id": workspace,
                "workspace_revision": request["expected_revision"] + 1, "model_id": witness["model_id"], "preview_id": witness["preview_id"],
                "preview_hash": content_hash(witness), "control_id": witness["control_id"],
                **{key: proof[key] for key in ("model_hash", "control_hash", "legacy_input_id", "legacy_input_hash", "checkpoint", "carry_hash", "carry_count")},
                "protocol": PROTOCOL, "request": request, "request_hash": digest, "created_at": sealed, "valid_until": expiry,
                "monitor_data_readmission_required": True, "research_admitted": False, "monitoring_activated": False,
                "trading_permission": False, "raw_ai_sharing": False, "provider_calls": 0}
            _validate(doc, "confirmation"); hashed = content_hash(doc); encoded = canonical_json(doc)
            _assert(len(encoded.encode()) <= 32768, "LEGACY_TRANSITION_SIZE_LIMIT")
            audit = _audit(db, actor, "investor_confirm_legacy_transition", "investor_legacy_transition_confirmation", identifier, {"content_hash": hashed}, sealed)
            db.execute("INSERT INTO investor_legacy_transition_confirmations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, witness["model_id"],
                witness["preview_id"], witness["control_id"], proof["legacy_input_id"], proof["checkpoint"]["id"], doc["workspace_revision"], request["idempotency_key"],
                digest, encoded, hashed, actor, sealed, expiry, audit))
            db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (workspace,))
            return doc
    return commit


def confirm_legacy_transition(db, workspace, actor, request, **kwargs):
    return prepare_legacy_transition_confirmation(db, workspace, actor, request, **kwargs)(db)


def _verified_transition(db, workspace, actor, identifier, at, stop_requested=None):
    from .confirmed_feed import _refresh_action_windows, _windows
    from .monitor_costs import current_settings
    _, doc = _confirmation_header(db, workspace, actor, identifier)
    _assert(doc["created_at"] <= at < doc["valid_until"], "LEGACY_TRANSITION_CONFIRMATION_EXPIRED")
    model, definition, reference = current_monitor_model(db, workspace, doc["model_id"], at)
    source, original = monitor_evidence_document(db, workspace, doc["model_id"], doc["legacy_input_id"], at)
    control = db.execute("SELECT * FROM investor_model_controls WHERE id=? AND workspace_id=? AND model_id=?", (doc["control_id"], workspace, doc["model_id"])).fetchone()
    _assert(model["content_hash"] == doc["model_hash"] and source["content_hash"] == doc["legacy_input_hash"]
        and control is not None and content_hash(dict(control)) == doc["control_hash"] and control["created_at"] <= doc["created_at"],
        "LEGACY_TRANSITION_ORIGINAL_INPUT_CHANGED")
    previous, ledger, bindings = _original_chain(db, workspace, definition, at, stop_requested, through_sequence=doc["checkpoint"]["sequence"])
    head = doc["checkpoint"]
    _assert(head == {"id": bindings[-1]["id"], "sequence": previous["sequence"], "content_hash": content_hash(previous),
        "chain_hash": content_hash(bindings), "processed_actions_hash": content_hash(previous["processed_actions"])},
        "LEGACY_TRANSITION_CHECKPOINT_CHAIN_CHANGED")
    replay = _compare_original_input(db, workspace, definition, source, original, at)
    _assert(replay["unavailable_reason"] is None, replay["unavailable_reason"] or "LEGACY_TRANSITION_ORIGINAL_INPUT_CHANGED")
    _assert(doc["valid_until"] == _receipt_expiry(db, workspace, doc["model_id"], {"legacy_input_id": source["id"], "checkpoint": head}, at),
        "LEGACY_TRANSITION_CONFIRMATION_INVALID")
    windows = _windows(db, workspace, original); _refresh_action_windows(db, workspace, definition, windows, at); _stop(stop_requested)
    candidate = build_monitor_data(db, workspace, definition, [window for _, window in windows], current_settings(db, workspace, definition, original["settings"], at),
        now=at, audited_action_knowledge=True)
    check_reference_listing_identity(reference["targets"], candidate["catalog"])
    actions = _audited_actions(db, workspace, definition, candidate["document"], at)
    carry = _carry_actions(ledger, actions); _check_unprocessed_history(definition, previous, ledger, actions)
    _assert(content_hash(carry) == doc["carry_hash"] and len(carry) == doc["carry_count"], "LEGACY_TRANSITION_ACTION_CARRY_CHANGED")
    _stop(stop_requested)
    return {"confirmation": doc, "checkpoint": previous, "ledger": ledger, "candidate": candidate}


def resolve_legacy_transition_confirmation(db, workspace, actor, identifier, *, now=None, stop_requested=None):
    """Recheck current original bytes and accounting scope, not current NAV/advice."""
    with transaction(db, immediate=False), _fact_validation_scope():
        return _verified_transition(db, workspace, actor, identifier, _clock(now), stop_requested)["confirmation"]
