"""Explicit corrected-source succession, never a current epoch or trading approval."""

from copy import deepcopy

from worker.market.contracts import validate_contract
from worker.orchestration.db import assert_writable, canonical_json, content_hash, instant, new_id, transaction
from . import action_review_workflow as review, managed_actions as managed
from .action_review_draft import _changes, _draft_binding_hash, _prepare_action_review_draft
from .corrected_action_source import prepare_corrected_action_source, replay_corrected_action_source
from .correction_change_fence import correction_change_fence
from .data_evidence import _audit, _fact_validation_scope, _object, _owner, review_source, store_source
from .implementation import implementation_hash
from .model_runtime import _clock
from .reviewed_actions import _check


SCHEMA = "investor-corrected-action-handover.schema.json"
SUBMIT = "investor-corrected-action-handover-submit-v1"
CONFIRMATION = "investor-corrected-action-handover-confirmation-v1"
ACKS = ("confirmed_historical_baseline", "current_report_differences_seen", "unchanged_tax_and_event_assumptions",
    "reported_coverage_not_objective_absence", "separate_new_maintenance_choice", "new_epoch_still_required_no_trading")


def prepare_handover(db, workspace, actor, body, *, now=None, clock=None):
    assert_writable(db); _owner(db, workspace, actor); validate_contract(body, SCHEMA, fragment="$defs/submit")
    body = _object(canonical_json(body)); digest = content_hash(body); at = _clock(clock() if clock else now)
    old = db.execute("SELECT id,request_hash FROM investor_action_review_confirmations WHERE workspace_id=? AND idempotency_key=?", (workspace, body["idempotency_key"])).fetchone()
    if old:
        _check(old["request_hash"] == digest, "DUPLICATE_CONFLICT")
        def retry(connection):
            _check(connection is db, "PREPARED_CONNECTION_CHANGED")
            return review._confirmation_header(db, workspace, actor, old["id"])[1]
        return retry
    with transaction(db, immediate=False), _fact_validation_scope():
        review._revision(db, workspace, actor, body["expected_revision"])
        _, witness = review._preview_header(db, workspace, actor, body["preview_id"])
        _check(witness["workspace_revision"] == body["expected_revision"] and witness["created_at"] <= at < witness["valid_until"], "PREVIEW_EXPIRED")
        source = prepare_corrected_action_source(db, workspace, actor, body["correction_id"], now=at)
        proof = source["proof"]
        _check(proof["confirmation_hash"] == body["expected_correction_hash"] and proof["authority_id"] == witness["authority_id"], "CORRECTION_CHANGED")
        draft, context = _prepare_action_review_draft(db, workspace, actor, witness["authority_id"], now=at)
        _check(draft["draft_basis_hash"] == witness["draft_basis_hash"], "DRAFT_CHANGED")
        _check(draft["status"] == "historical_correction_required" and context["refs"] == proof["current_captures"], "CORRECTION_CHANGED")
        review._check_context(db, workspace, actor, draft, context, at)
        fence, implementation = correction_change_fence(db, workspace, actor), implementation_hash()

    def commit(connection):
        _check(connection is db, "PREPARED_CONNECTION_CHANGED")
        with transaction(db), _fact_validation_scope():
            current = _clock(clock() if clock else now)
            old = db.execute("SELECT id,request_hash FROM investor_action_review_confirmations WHERE workspace_id=? AND idempotency_key=?", (workspace, body["idempotency_key"])).fetchone()
            if old:
                _check(old["request_hash"] == digest, "DUPLICATE_CONFLICT")
                return review._confirmation_header(db, workspace, actor, old["id"])[1]
            review._revision(db, workspace, actor, body["expected_revision"])
            _check(instant(at) <= instant(current) < min(instant(witness["valid_until"]), instant(proof["valid_until"])), "PREVIEW_EXPIRED")
            _check(implementation_hash() == implementation and correction_change_fence(db, workspace, actor) == fence, "SOURCE_CHANGED")
            review._check_context(db, workspace, actor, draft, context, current)
            identifier = new_id("corrected-action-handover")
            stored = store_source(db, workspace, actor, "actions", {"title": "Explicit corrected-source handover", "reference": "investor-corrected-action-handover:" + identifier,
                "excerpt": "Previously confirmed historical correction and current unchanged selected reports; no new tax assumption or monitoring/trading approval."}, now=current)
            approved = review_source(db, workspace, actor, stored["id"], "approved", source["facts"],
                "Separate explicit corrected-source succession; previous observations and quarantine remain", proof["source_valid_until"], now=current)
            policy = {**context["policy"], "base_review_id": approved["id"], "base_review_hash": approved["content_hash"],
                "anchor_captures": context["refs"], "valid_from": current, "valid_until": proof["source_valid_until"],
                "anchor_binding_hash": content_hash({"base_review_hash": approved["content_hash"], "listing_review_hash": context["policy"]["listing_review_hash"], "bindings": context["report"]["bindings"]})}
            # Raw replay already completed outside the writer. This private
            # insertion is fenced above; no caller-prepared policy is accepted.
            validate_contract(policy, managed.SCHEMA, fragment="$defs/authority")
            following_id = new_id("actions-authority"); hashed = content_hash(policy)
            audit = _audit(db, actor, "investor_register_action_maintenance", "investor_action_authority", following_id, {"content_hash": hashed}, current)
            db.execute("INSERT INTO investor_action_authorities VALUES(?,?,?,?,?,?,?,?,?,?)", (following_id, workspace, policy["listing_id"], approved["id"], policy["listing_review_id"], canonical_json(policy), hashed, actor, current, audit))
            following = dict(db.execute("SELECT * FROM investor_action_authorities WHERE id=?", (following_id,)).fetchone())
            managed._insert_control(db, workspace, actor, following, None, False, current)
            retired = managed.set_authority_enabled(db, workspace, actor, context["authority"]["id"], False, now=current)
            control = managed.set_authority_enabled(db, workspace, actor, following_id, body["enable_rule"], now=current)
            doc = {"schema_version": CONFIRMATION, "confirmation_id": identifier, "workspace_id": workspace,
                "workspace_revision": body["expected_revision"] + 1, "preview_id": body["preview_id"], "request": deepcopy(body), "request_hash": digest,
                "draft_basis_hash": witness["draft_basis_hash"], "previous_authority_id": context["authority"]["id"], "previous_authority_hash": context["authority"]["content_hash"],
                "previous_control_id": context["control"]["id"], "previous_control_hash": context["control"]["content_hash"],
                "retired_control_id": retired["id"], "retired_control_hash": retired["content_hash"], "previous_publication_id": draft["previous_publication_id"],
                "previous_review_id": context["prior"]["review"]["id"], "previous_review_hash": context["prior"]["review"]["content_hash"],
                "new_review_id": approved["id"], "new_review_hash": approved["content_hash"], "new_authority_id": following_id, "new_authority_hash": following["content_hash"],
                "new_control_id": control["id"], "new_control_hash": control["content_hash"], "source_proof": proof, "source_valid_until": proof["source_valid_until"],
                "created_at": current, "monitor_data_readmission_required": True, "quarantine_cleared": False, "research_admitted": False,
                "trading_permission": False, "raw_ai_sharing": False, "provider_calls": 0}
            validate_contract(doc, SCHEMA, fragment="$defs/confirmation"); hashed = content_hash(doc)
            audit = _audit(db, actor, "investor_confirm_action_review", "investor_action_review_confirmation", identifier, {"content_hash": hashed}, current)
            db.execute("INSERT INTO investor_action_review_confirmations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, body["preview_id"], doc["previous_authority_id"],
                following_id, approved["id"], doc["workspace_revision"], body["idempotency_key"], digest, canonical_json(doc), hashed, actor, current, audit))
            _check(_clock(clock() if clock else now) < min(witness["valid_until"], proof["valid_until"]), "PREVIEW_EXPIRED")
            db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (workspace,))
            return doc
    return commit


def verified_handover(db, workspace, actor, identifier, at):
    """Full original-byte handover replay; historical proof is not today's admission."""
    _, doc = review._confirmation_header(db, workspace, actor, identifier)
    _check(doc["schema_version"] == CONFIRMATION and doc["created_at"] <= at, "CONFIRMATION_INPUTS_CHANGED")
    # Reuse the common control/anchor authentication, not its append economics.
    return review._verified_confirmation_context(db, workspace, actor, doc, at, corrected=True)


def compare_handover_contexts(db, workspace, actor, doc, old, policy, next_policy, previous_control, before, after, prior, previous, publication_id, limits, at):
    source = replay_corrected_action_source(db, workspace, actor, doc["source_proof"], now=at); proof = source["proof"]
    _check(doc["request"]["correction_id"] == proof["confirmation_id"] and doc["request"]["expected_correction_hash"] == proof["confirmation_hash"]
        and proof["authority_id"] == old["id"] and proof["authority_hash"] == old["content_hash"]
        and proof["control_id"] == previous_control["id"] and proof["control_hash"] == previous_control["content_hash"], "CONFIRMATION_INPUTS_CHANGED")
    _check(publication_id == doc["previous_publication_id"] and prior["review"]["id"] == doc["previous_review_id"] and prior["review"]["content_hash"] == doc["previous_review_hash"]
        and source["facts"] == after["base"]["facts"] and proof["current_captures"] == next_policy["anchor_captures"]
        and doc["source_valid_until"] == proof["source_valid_until"] == next_policy["valid_until"] == after["base"]["review"]["valid_until"]
        and proof["checked_at"] <= doc["created_at"] < proof["valid_until"] and next_policy["valid_from"] == doc["created_at"], "CONFIRMATION_INPUTS_CHANGED")
    mutable = {"base_review_id", "base_review_hash", "anchor_captures", "anchor_binding_hash", "valid_from", "valid_until"}
    _check({k: v for k, v in policy.items() if k not in mutable} == {k: v for k, v in next_policy.items() if k not in mutable}, "CONFIRMATION_INPUTS_CHANGED")
    floor = max((v for c in after["values"].values() for v in (c["capture"]["created_at"], c["draft"]["source"]["retrieved_at"])), key=instant)
    _, _, capture_limits = managed._captures(db, workspace, actor, policy["listing_review_id"], proof["current_captures"], at)
    maximum = _clock(min([instant(policy["valid_until"]), *before["limits"], *limits, *capture_limits]))
    changes = _changes(previous, after["snapshots"], prior["facts"]["range_end"], after["report"]["comparison"]["common_window"]["range_end"])
    basis = _draft_binding_hash(workspace, actor, old, previous_control, prior, previous, after["snapshots"], after["report"], publication_id, floor, maximum, changes)
    _check(basis == doc["draft_basis_hash"], "CONFIRMATION_INPUTS_CHANGED")
    return doc, before["base"], after["base"]
