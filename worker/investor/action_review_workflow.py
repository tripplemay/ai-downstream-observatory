"""Explicit, witnessed owner review; never a trading or monitor-admission API."""

from copy import deepcopy
from decimal import Decimal, localcontext

from worker.accounting import fact_decimal
from worker.accounting.decimal_math import canonical
from worker.market.contracts import validate_contract
from worker.orchestration.db import assert_writable, canonical_json, content_hash, instant, new_id, transaction
from . import managed_actions as managed
from .action_review_draft import _changes, _draft_binding_hash, _prepare_action_review_draft
from .data_evidence import _audit, _audit_binding, _fact_validation_scope, _object, _owner, review_source, store_source
from .model_runtime import _clock
from .reviewed_actions import _check, _historical_basis, _time, check_reviewed_action_append, preview_reviewed_action_successor


SCHEMA = "investor-action-review-workflow.schema.json"


def _validate(value, fragment):
    validate_contract(value, SCHEMA, fragment="$defs/" + fragment)
    if "expected_revision" in value:
        _check(type(value["expected_revision"]) is int, "REVISION_INVALID")


def _revision(db, workspace, actor, expected):
    _owner(db, workspace, actor)
    actual = db.execute("SELECT revision FROM investor_workspaces WHERE id=?", (workspace,)).fetchone()[0]
    _check(type(expected) is int and expected == actual, "VERSION_CONFLICT")


def _retired(db, workspace, authority_id):
    return db.execute("SELECT id FROM investor_action_review_confirmations WHERE workspace_id=? AND previous_authority_id=?", (workspace, authority_id)).fetchone() is not None


def _preview_header(db, workspace, actor, identifier):
    _owner(db, workspace, actor)
    row = db.execute("SELECT * FROM investor_action_review_previews WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    _check(row is not None, "PREVIEW_OUT_OF_SCOPE")
    doc = _object(row["document_json"]); _validate(doc, "preview")
    _check(canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"] and row["actor_id"] == actor
        and all(doc[key] == row[key] for key in ("workspace_id", "workspace_revision", "authority_id", "control_id", "request_hash", "created_at", "valid_until"))
        and doc["preview_id"] == row["id"] and doc["checked_at"] <= doc["created_at"] < doc["valid_until"], "PREVIEW_INVALID")
    _check(doc["request_hash"] == content_hash({"authority_id": row["authority_id"], "expected_revision": row["workspace_revision"] - 1,
        "idempotency_key": row["idempotency_key"]}), "PREVIEW_INVALID")
    _check((instant(doc["valid_until"]) - instant(doc["checked_at"])).total_seconds() <= 60, "PREVIEW_INVALID")
    _audit_binding(db, row, "investor_preview_action_review", "investor_action_review_preview", identifier)
    return row, doc


def _confirmation_header(db, workspace, actor, identifier):
    _owner(db, workspace, actor)
    row = db.execute("SELECT * FROM investor_action_review_confirmations WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    _check(row is not None, "CONFIRMATION_OUT_OF_SCOPE")
    doc = _object(row["document_json"]); _validate(doc, "confirmation")
    _check(canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"] and row["actor_id"] == actor
        and all(doc[key] == row[key] for key in ("workspace_id", "workspace_revision", "preview_id", "previous_authority_id", "new_authority_id", "new_review_id", "request_hash", "created_at"))
        and doc["confirmation_id"] == row["id"] and content_hash(doc["request"]) == row["request_hash"]
        and doc["request"]["idempotency_key"] == row["idempotency_key"], "CONFIRMATION_INVALID")
    _audit_binding(db, row, "investor_confirm_action_review", "investor_action_review_confirmation", identifier)
    _, preview = _preview_header(db, workspace, actor, row["preview_id"])
    _check(preview["workspace_revision"] == doc["request"]["expected_revision"] == doc["workspace_revision"] - 1
        and preview["authority_id"] == doc["previous_authority_id"] and preview["draft_basis_hash"] == doc["draft_basis_hash"]
        and preview["control_id"] == doc["previous_control_id"] and preview["control_hash"] == doc["previous_control_hash"]
        and preview["created_at"] <= doc["created_at"] < preview["valid_until"], "CONFIRMATION_INVALID")
    return row, doc


def _check_context(db, workspace, actor, draft, context, at):
    _owner(db, workspace, actor)
    _check(not _retired(db, workspace, draft["authority_id"]), "RULE_RETIRED")
    authority, policy, control = managed._authority(db, workspace, draft["authority_id"], at)
    _check(authority["content_hash"] == draft["authority_hash"] and policy == context["policy"]
        and control["id"] == draft["control_id"] and control["content_hash"] == draft["control_hash"], "DRAFT_CHANGED")
    _check(_time(at) < _time(context["maximum_valid_until"]) and at < draft["refresh_after"]
        and instant(at).astimezone(managed.ZONE).date().isoformat() == draft["source_report"]["source_day"], "PREVIEW_EXPIRED")
    head = db.execute("SELECT id FROM investor_action_publications WHERE authority_id=? AND status='published' ORDER BY sequence DESC LIMIT 1", (authority["id"],)).fetchone()
    _check((head[0] if head else None) == draft["previous_publication_id"], "DRAFT_CHANGED")
    managed._check_review_pins(db, workspace, context["anchor"]["pins"], at)
    managed._check_capture_headers(db, workspace, [context["anchor"]["report"], context["report"], *context["historical_reports"]], at)


def register_action_review_preview(db, workspace, actor, request, *, now=None):
    """Persist only an unapproved server-time witness, never source facts or consent."""
    assert_writable(db); _owner(db, workspace, actor); _validate(request, "preview_request")
    request = _object(canonical_json(request))
    digest, at = content_hash(request), _clock(now)
    old = db.execute("SELECT id,request_hash FROM investor_action_review_previews WHERE workspace_id=? AND idempotency_key=?", (workspace, request["idempotency_key"])).fetchone()
    if old:
        _check(old["request_hash"] == digest, "DUPLICATE_CONFLICT")
        return _preview_header(db, workspace, actor, old["id"])[1]
    _revision(db, workspace, actor, request["expected_revision"])
    _check(not _retired(db, workspace, request["authority_id"]), "RULE_RETIRED")
    draft, context = _prepare_action_review_draft(db, workspace, actor, request["authority_id"], now=at)
    with transaction(db):
        current = _clock(now)
        concurrent = db.execute("SELECT id,request_hash FROM investor_action_review_previews WHERE workspace_id=? AND idempotency_key=?", (workspace, request["idempotency_key"])).fetchone()
        if concurrent:
            _check(concurrent["request_hash"] == digest, "DUPLICATE_CONFLICT")
            return _preview_header(db, workspace, actor, concurrent["id"])[1]
        _revision(db, workspace, actor, request["expected_revision"]); _check_context(db, workspace, actor, draft, context, current)
        identifier = new_id("action-review-preview")
        doc = {"schema_version": "investor-action-review-preview-v1", "preview_id": identifier, "workspace_id": workspace,
            "workspace_revision": request["expected_revision"] + 1, "request_hash": digest,
            **{key: draft[key] for key in ("authority_id", "authority_hash", "control_id", "control_hash", "draft_basis_hash")},
            "checked_at": draft["checked_at"], "created_at": current, "valid_until": draft["refresh_after"],
            "approval_performed": False, "provider_calls": 0, "research_admitted": False, "trading_permission": False}
        _validate(doc, "preview"); hashed = content_hash(doc)
        audit = _audit(db, actor, "investor_preview_action_review", "investor_action_review_preview", identifier, {"content_hash": hashed}, current)
        db.execute("INSERT INTO investor_action_review_previews VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, request["authority_id"],
            draft["control_id"], doc["workspace_revision"], request["idempotency_key"], digest, canonical_json(doc), hashed, actor, current, doc["valid_until"], audit))
        db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (workspace,))
        return doc


def _verified_confirmation(db, workspace, actor, identifier, at):
    """Full original-byte, owner-answer and immutable control replay, not a receipt lookup."""
    _, doc = _confirmation_header(db, workspace, actor, identifier)
    _check(doc["created_at"] <= at, "CONFIRMATION_IN_FUTURE")
    old, policy, current_old = managed._authority(db, workspace, doc["previous_authority_id"], at)
    new, next_policy, _ = managed._authority(db, workspace, doc["new_authority_id"], at)
    _check(old["content_hash"] == doc["previous_authority_hash"] and new["content_hash"] == doc["new_authority_hash"]
        and current_old["enabled"] == 0 and next_policy["base_review_id"] == doc["new_review_id"]
        and all(policy[key] == next_policy[key] for key in ("listing_id", "provider_symbol", "listing_review_id", "listing_review_hash")), "CONFIRMATION_INPUTS_CHANGED")
    previous_control = db.execute("SELECT * FROM investor_action_controls WHERE id=? AND workspace_id=?", (doc["previous_control_id"], workspace)).fetchone()
    retired = db.execute("SELECT * FROM investor_action_controls WHERE id=? AND workspace_id=?", (doc["retired_control_id"], workspace)).fetchone()
    initial = db.execute("SELECT * FROM investor_action_controls WHERE authority_id=? AND version=1", (new["id"],)).fetchone()
    selected = db.execute("SELECT * FROM investor_action_controls WHERE id=? AND workspace_id=?", (doc["new_control_id"], workspace)).fetchone()
    _check(all(value is not None for value in (previous_control, retired, initial, selected)), "CONFIRMATION_INPUTS_CHANGED")
    for authority, control in ((old, previous_control), (old, retired), (new, initial), (new, selected)):
        managed._control(db, authority, control, at)
    _check(previous_control["content_hash"] == doc["previous_control_hash"] and retired["content_hash"] == doc["retired_control_hash"]
        and retired["enabled"] == 0 and retired["version"] == previous_control["version"] + int(bool(previous_control["enabled"]))
        and previous_control["created_at"] <= retired["created_at"] <= doc["created_at"]
        and initial["enabled"] == 0 and initial["created_at"] == selected["created_at"] == new["created_at"] == doc["created_at"]
        and selected["content_hash"] == doc["new_control_hash"] and selected["enabled"] == int(doc["request"]["enable_rule"])
        and selected["version"] == (2 if doc["request"]["enable_rule"] else 1), "CONFIRMATION_INPUTS_CHANGED")
    before = managed._anchor(db, workspace, actor, policy["base_review_id"], policy["listing_review_id"], policy["anchor_captures"], at)
    after = managed._anchor(db, workspace, actor, next_policy["base_review_id"], next_policy["listing_review_id"], next_policy["anchor_captures"], at)
    for bound_policy, anchor in ((policy, before), (next_policy, after)):
        _check(anchor["base"]["review"]["content_hash"] == bound_policy["base_review_hash"]
            and anchor["listing"]["review"]["content_hash"] == bound_policy["listing_review_hash"]
            and anchor["binding_hash"] == bound_policy["anchor_binding_hash"], "CONFIRMATION_INPUTS_CHANGED")
    _check(after["base"]["review"]["content_hash"] == doc["new_review_hash"]
        and after["base"]["review"]["created_at"] == after["base"]["source"]["created_at"] == doc["created_at"]
        and after["base"]["source"]["id"] != before["base"]["source"]["id"]
        and all(before["report"]["bindings"][kind][key] == after["report"]["bindings"][kind][key]
            for kind in before["report"]["bindings"] for key in ("authority_id", "authority_hash", "control_id", "control_hash")), "CONFIRMATION_INPUTS_CHANGED")
    prior, previous, publication_id, limits = _historical_basis(db, workspace, actor, old, policy, before, at)
    _check(publication_id == doc["previous_publication_id"] and prior["review"]["id"] == doc["previous_review_id"]
        and prior["review"]["content_hash"] == doc["previous_review_hash"], "CONFIRMATION_INPUTS_CHANGED")
    floor = max((value for capture in after["values"].values() for value in (capture["capture"]["created_at"], capture["draft"]["source"]["retrieved_at"])), key=instant)
    maximum = _clock(min([instant(policy["valid_until"]), *before["limits"], *after["limits"], *limits]))
    context = {"prior": prior, "current": after["snapshots"], "report": after["report"]}
    expected_facts = _new_facts(context, doc["request"]["new_events"], doc["preview_id"], floor)
    _check(expected_facts == after["base"]["facts"], "CONFIRMATION_FACTS_CHANGED")
    proof = check_reviewed_action_append(prior["facts"], expected_facts, previous, after["snapshots"], symbol=policy["provider_symbol"],
        listing_id=policy["listing_id"], knowledge_floor=floor, reviewed_at=doc["created_at"])
    _check(proof == doc["append_proof"], "CONFIRMATION_PROOF_CHANGED")
    changes = _changes(previous, after["snapshots"], prior["facts"]["range_end"], after["report"]["comparison"]["common_window"]["range_end"])
    binding = _draft_binding_hash(workspace, actor, old, previous_control, prior, previous, after["snapshots"], after["report"], publication_id, floor, maximum, changes)
    _check(binding == doc["draft_basis_hash"], "CONFIRMATION_DRAFT_CHANGED")
    return doc, before["base"], after["base"]


def resolve_action_review_confirmation(db, workspace, actor, identifier, *, now=None):
    with transaction(db, immediate=False), _fact_validation_scope():
        return _verified_confirmation(db, workspace, actor, identifier, _clock(now))[0]


def _confirmed_event_origins(db, workspace, review, at, seen=None):
    """Internal normal-resolver input. Only verified explicit lineage inherits time."""
    seen = set() if seen is None else seen
    _check(len(seen) < 256 and review["review"]["id"] not in seen, "SUCCESSION_LIMIT_OR_CYCLE")
    seen = seen | {review["review"]["id"]}
    row = db.execute("SELECT id FROM investor_action_review_confirmations WHERE workspace_id=? AND new_review_id=?", (workspace, review["review"]["id"])).fetchone()
    if row is None:
        return {event["id"]: {"original_review_id": review["review"]["id"], "original_review_hash": review["review"]["content_hash"],
            "known_at": review["review"]["created_at"]} for event in review["facts"]["events"]}
    doc, predecessor, current = _verified_confirmation(db, workspace, review["review"]["actor_id"], row["id"], at)
    _check(current["review"]["id"] == review["review"]["id"] and current["review"]["content_hash"] == review["review"]["content_hash"]
        and current["facts"] == review["facts"], "CONFIRMATION_INPUTS_CHANGED")
    origins = _confirmed_event_origins(db, workspace, predecessor, at, seen)
    for event in current["facts"]["events"]:
        if event["id"] not in origins:
            origins[event["id"]] = {"original_review_id": current["review"]["id"], "original_review_hash": current["review"]["content_hash"], "known_at": doc["created_at"]}
    _check(set(origins) == {event["id"] for event in current["facts"]["events"]}, "CONFIRMATION_INPUTS_CHANGED")
    return origins


def resolve_action_review_preview(db, workspace, actor, identifier, *, now=None):
    at = _clock(now)
    with transaction(db, immediate=False):
        _, doc = _preview_header(db, workspace, actor, identifier)
        _check(doc["created_at"] <= at < doc["valid_until"], "PREVIEW_EXPIRED")
        _revision(db, workspace, actor, doc["workspace_revision"])
        draft, context = _prepare_action_review_draft(db, workspace, actor, doc["authority_id"], now=at)
        _check(draft["draft_basis_hash"] == doc["draft_basis_hash"], "DRAFT_CHANGED")
        result = {"preview": doc, "draft": draft, "unchanged_tax_assumption": context["prior"]["facts"]["tax_assumption"], "visibility": "private_owner_only_not_ai"}
        _validate(result, "preview_view")
        return result


def _new_facts(context, answers, preview_id, floor):
    facts = deepcopy(context["prior"]["facts"]); old_end = facts["range_end"]
    facts["range_end"] = context["report"]["comparison"]["common_window"]["range_end"]
    issuer = {}
    for row in context["current"]["issuer"]["records"]:
        if row["ex_date"] > old_end: issuer.setdefault(row["ex_date"], []).append(row)
    splits = {row["date"]: row for row in context["current"]["splits"]["records"] if row["date"] > old_end}
    expected = {("dividend", day) for day in issuer} | {("split", day) for day in splits}
    received = {(row["type"], row["date"]) for row in answers}
    _check(len(received) == len(answers) and received == expected, "EVENT_ANSWERS_DIFFER")
    added = []
    with localcontext() as decimals:
        decimals.prec = 128
        for answer in answers:
            kind, day = answer["type"], answer["date"]
            _check(_time(answer["at"]).astimezone(managed.ZONE).date().isoformat() == day, "EVENT_DATE_DIFFERS")
            identity = "reviewed-action:" + content_hash({"preview_id": preview_id, "type": kind, "date": day})
            event = {"id": identity, "listing_id": facts["listing_id"], "type": kind, "at": answer["at"],
                "published_at": floor, "source_evidence": "explicit-owner-review:" + preview_id}
            if kind == "dividend":
                gross = sum((Decimal(row["distribution_amount"]) for row in issuer[day]), Decimal(0))
                fact_decimal(answer["tax_per_unit"])
                _time(answer["pay_at"])
                fact_decimal(canonical(gross))
                event.update(gross_per_unit=canonical(gross), tax_per_unit=answer["tax_per_unit"], pay_at=answer["pay_at"])
            else:
                source = splits[day]; ratio = Decimal(source["numerator"]) / Decimal(source["denominator"])
                _check(ratio * Decimal(source["denominator"]) == Decimal(source["numerator"]), "SPLIT_RATIO_NOT_EXACT")
                event["ratio"] = canonical(ratio)
                fact_decimal(event["ratio"])
            added.append(event)
    facts["events"].extend(sorted(added, key=lambda row: (instant(row["at"]), row["type"], row["id"])))
    return facts


def confirm_action_review(db, workspace, actor, request, *, now=None):
    """Explicit answers -> one atomic approval/retirement/lineage, never execution."""
    assert_writable(db); _owner(db, workspace, actor); _validate(request, "submit")
    request = _object(canonical_json(request))
    request_hash, at = content_hash(request), _clock(now)
    old = db.execute("SELECT id,request_hash FROM investor_action_review_confirmations WHERE workspace_id=? AND idempotency_key=?", (workspace, request["idempotency_key"])).fetchone()
    if old:
        _check(old["request_hash"] == request_hash, "DUPLICATE_CONFLICT")
        return _confirmation_header(db, workspace, actor, old["id"])[1]
    with transaction(db, immediate=False), _fact_validation_scope():
        _, witness = _preview_header(db, workspace, actor, request["preview_id"])
        _revision(db, workspace, actor, request["expected_revision"])
        _check(request["expected_revision"] == witness["workspace_revision"], "VERSION_CONFLICT")
        _check(witness["created_at"] <= at < witness["valid_until"], "PREVIEW_EXPIRED")
        draft, context = _prepare_action_review_draft(db, workspace, actor, witness["authority_id"], now=at)
        _check(draft["draft_basis_hash"] == witness["draft_basis_hash"], "DRAFT_CHANGED")
        _check(draft["status"] == "new_reported_actions", "SEPARATE_HISTORICAL_REVIEW_REQUIRED")
        facts = _new_facts(context, request["new_events"], witness["preview_id"], draft["knowledge_not_before"])
        proof = check_reviewed_action_append(context["prior"]["facts"], facts, context["previous"], context["current"],
            symbol=context["policy"]["provider_symbol"], listing_id=context["policy"]["listing_id"], knowledge_floor=draft["knowledge_not_before"], reviewed_at=at)
    with transaction(db), _fact_validation_scope():
        current = _clock(now)
        concurrent = db.execute("SELECT id,request_hash FROM investor_action_review_confirmations WHERE workspace_id=? AND idempotency_key=?", (workspace, request["idempotency_key"])).fetchone()
        if concurrent:
            _check(concurrent["request_hash"] == request_hash, "DUPLICATE_CONFLICT")
            return _confirmation_header(db, workspace, actor, concurrent["id"])[1]
        _revision(db, workspace, actor, request["expected_revision"])
        _check(current < witness["valid_until"], "PREVIEW_EXPIRED"); _check_context(db, workspace, actor, draft, context, current)
        identifier = new_id("action-review-confirmation")
        source = store_source(db, workspace, actor, "actions", {"title": "Explicitly reviewed action update", "reference": "investor-action-confirmation:" + identifier,
            "excerpt": "Owner-confirmed source report differences and explicit research timing/tax assumptions; not provider certification or trading permission."}, now=current)
        review = review_source(db, workspace, actor, source["id"], "approved", facts,
            "Explicit owner action review, not approval under the previous standing rule", context["maximum_valid_until"], now=current)
        prepared = managed.preview_authority(db, workspace, actor, review["id"], context["policy"]["listing_review_id"], context["refs"], now=current)
        policy = {**context["policy"], **{key: prepared[key] for key in ("base_review_id", "base_review_hash", "anchor_captures", "anchor_binding_hash")},
            "valid_from": current, "valid_until": context["maximum_valid_until"]}
        following = managed.register_authority(db, workspace, actor, policy, now=current)
        checked = preview_reviewed_action_successor(db, workspace, actor, context["authority"]["id"], following["id"], now=current)
        _check(checked["append_proof"] == proof, "DRAFT_CHANGED")
        retired = managed.set_authority_enabled(db, workspace, actor, context["authority"]["id"], False, now=current)
        control = managed.set_authority_enabled(db, workspace, actor, following["id"], request["enable_rule"], now=current)
        doc = {"schema_version": "investor-action-review-confirmation-v1", "confirmation_id": identifier, "workspace_id": workspace,
            "workspace_revision": request["expected_revision"] + 1, "preview_id": request["preview_id"], "request": deepcopy(request), "request_hash": request_hash,
            "draft_basis_hash": witness["draft_basis_hash"], "previous_authority_id": context["authority"]["id"], "previous_authority_hash": context["authority"]["content_hash"],
            "previous_control_id": context["control"]["id"], "previous_control_hash": context["control"]["content_hash"],
            "retired_control_id": retired["id"], "retired_control_hash": retired["content_hash"], "previous_publication_id": draft["previous_publication_id"],
            "previous_review_id": context["prior"]["review"]["id"], "previous_review_hash": context["prior"]["review"]["content_hash"],
            "new_review_id": review["id"], "new_review_hash": review["content_hash"], "new_authority_id": following["id"], "new_authority_hash": following["content_hash"],
            "new_control_id": control["id"], "new_control_hash": control["content_hash"], "append_proof": proof, "created_at": current,
            "monitor_data_readmission_required": True, "quarantine_cleared": False, "research_admitted": False, "trading_permission": False, "raw_ai_sharing": False, "provider_calls": 0}
        _validate(doc, "confirmation"); digest = content_hash(doc)
        audit = _audit(db, actor, "investor_confirm_action_review", "investor_action_review_confirmation", identifier, {"content_hash": digest}, current)
        db.execute("INSERT INTO investor_action_review_confirmations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, request["preview_id"],
            doc["previous_authority_id"], doc["new_authority_id"], review["id"], doc["workspace_revision"], request["idempotency_key"], request_hash,
            canonical_json(doc), digest, actor, current, audit))
        _check(_clock(now) < witness["valid_until"], "PREVIEW_EXPIRED")
        db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (workspace,))
        return doc
