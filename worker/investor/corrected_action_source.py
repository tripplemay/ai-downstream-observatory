"""Replay approved correction and current reports, never publish or enable a rule."""

from copy import deepcopy
from decimal import localcontext

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, instant, transaction
from . import correction_consent as consent, managed_actions as managed
from .action_correction_impact import _candidate, _ledger
from .action_review_draft import _changes, _draft_binding_hash, _prepare_action_review_draft
from .data_evidence import _fact_validation_scope
from .model_runtime import _clock
from .no_new_actions import check_no_new_action_extension
from .retained_monitor_history import read_retained_monitor_history
from .reviewed_actions import _historical_basis


SCHEMA = "investor-corrected-action-source.schema.json"


def _check(value, code="INVALID"):
    if not value: raise WorkbenchError("CORRECTED_ACTION_SOURCE_" + code)


def _replay_baseline(db, workspace, actor, identifier, at, stop_requested):
    managed._stopped(db, stop_requested)
    doc = consent._registered_correction_document(db, workspace, actor, identifier, at)
    baseline = doc["baseline"]; known = baseline["knowledge_at"]
    _check(instant(at) < instant(doc["valid_until"]), "EXPIRED")
    _, original, _, prior = consent._impact(db, workspace, actor, doc["impact_request_id"], at)
    request = original["body"]
    _, witness = consent.review._preview_header(db, workspace, actor, request["preview_id"])
    _check(instant(witness["created_at"]) <= instant(doc["created_at"]) < instant(witness["valid_until"]))
    authority, policy, control = managed._authority(db, workspace, witness["authority_id"], at)
    _check(policy["valid_from"] <= at < policy["valid_until"] and authority["content_hash"] == witness["authority_hash"]
        and control["id"] == witness["control_id"] and control["content_hash"] == witness["control_hash"], "CONTROL_CHANGED")
    anchor = managed._anchor(db, workspace, actor, policy["base_review_id"], policy["listing_review_id"], policy["anchor_captures"], at)
    _check(anchor["binding_hash"] == policy["anchor_binding_hash"] and anchor["base"]["review"]["content_hash"] == policy["base_review_hash"]
        and anchor["listing"]["review"]["content_hash"] == policy["listing_review_hash"]
        and instant(anchor["base"]["review"]["created_at"]) <= instant(authority["created_at"])
        and all(instant(value["capture"]["created_at"]) <= instant(authority["created_at"]) for value in anchor["values"].values()))
    before, previous, publication_id, limits = _historical_basis(db, workspace, actor, authority, policy, anchor, at)
    captures, report, current_limits = managed._captures(db, workspace, actor, policy["listing_review_id"], doc["capture_refs"], at)
    _check(all(report["bindings"][kind][key] == anchor["report"]["bindings"][kind][key]
        for kind in report["bindings"] for key in ("authority_id", "authority_hash", "control_id", "control_hash")))
    _check(all(instant(value["capture"]["created_at"]) <= instant(known)
        and instant(value["draft"]["source"]["retrieved_at"]) <= instant(known) for value in captures.values()))
    snapshots = {kind: value["draft"] for kind, value in captures.items()}
    history = read_retained_monitor_history(db, workspace, actor, doc["model_id"], now=at, stop_requested=stop_requested)
    strip = lambda value: {key: item for key, item in value.items() if key not in ("checked_at", "source_valid_until")}
    _check(strip(history["proof"]) == strip(baseline["original_history"]) and content_hash(history["definition"]) == baseline["model_hash"]
        and content_hash(history["head"]) == baseline["original_checkpoint_hash"] and content_hash(history["head_projection"]) == baseline["original_projection_hash"], "HISTORY_CHANGED")
    end = min(value["source"]["range_end"] for value in snapshots.values())
    changes = _changes(previous, snapshots, before["facts"]["range_end"], end)
    floor = max((v for c in captures.values() for v in (c["capture"]["created_at"], c["draft"]["source"]["retrieved_at"])), key=instant)
    maximum = _clock(min([instant(policy["valid_until"]), *anchor["limits"], *limits, *current_limits]))
    basis = _draft_binding_hash(workspace, actor, authority, control, before, previous, snapshots, report, publication_id, floor, maximum, changes)
    _check(basis == witness["draft_basis_hash"] == doc["draft_basis_hash"] and report["source_day"] == instant(known).astimezone(managed.ZONE).date().isoformat()
        and instant(at) < instant(maximum), "SOURCE_CHANGED")
    facts, changed = _candidate(before["facts"], changes, snapshots, request["decisions"], content_hash(request), known)
    _check(changed and all(row["choice"] != "retain" for row in request["decisions"]), "UNRESOLVED")
    affected = lambda row: row["listing_id"] == facts["listing_id"] and instant(row["ex_at"] if row["kind"] == "dividend_payment" else row["effective_at"]).astimezone(managed.ZONE).date().isoformat() in changed
    economics = lambda values: sorted(({key: value for key, value in row.items() if key != "known_at"} for row in values), key=lambda row: row["id"])
    cutoff = history["head"]["market_cutoffs"]["US"]
    _check(economics([row for row in history["original_actions"] if affected(row)]) == economics([row for row in _ledger(before["facts"], cutoff, known) if affected(row)]))
    corrected = [row for row in history["original_actions"] if not affected(row)] + [row for row in _ledger(facts, cutoff, known) if affected(row)]
    kernel = {"schema_version": "investor-action-restatement-kernel-input-v1", **{key: history[key] for key in (
        "definition", "origin", "head", "origin_projection", "head_projection", "original_actions")},
        "corrected_actions": sorted(corrected, key=lambda row: row["id"]), "corrected_coverage": history["head_projection"]["corporate_action_coverage"], "checked_at": known}
    result = {"request_hash": content_hash(request), "draft_basis_hash": basis, "source_changes_hash": content_hash(changes),
        "prior_facts_hash": content_hash(before["facts"]), "tax_assumption_hash": content_hash({"tax_assumption": facts["tax_assumption"]}),
        "ignored_new_report_dates": sorted({row["date"] for row in changes if row["disposition"] == "new_report"}),
        "original_history": history["proof"], "hypothetical_events": facts["events"], "comparison": consent.compare_action_restatement(kernel)}
    bundle = {"request": request, "facts": facts, "changed_days": changed, "kernel_input": kernel, "history": history, "result": result}
    consent._same_visible_economics(prior["impact"], bundle)
    earlier = deepcopy(kernel); earlier["checked_at"] = prior["impact"]["checked_at"]
    for action in earlier["corrected_actions"]:
        if affected(action): action["known_at"] = earlier["checked_at"]
    _check(content_hash(earlier) == prior["impact"]["kernel_input_hash"], "HISTORY_CHANGED")
    expected = consent._baseline(bundle, identifier, known)
    expected["original_history"] = baseline["original_history"]
    _check(expected == baseline, "BASELINE_CHANGED")
    managed._stopped(db, stop_requested)
    return doc, history, snapshots


def read_correction_consent_baseline(db, workspace, actor, identifier, *, now=None, stop_requested=None):
    """Full current-permission/source/history/math replay, not a metadata GET."""
    with transaction(db, immediate=False), _fact_validation_scope(), localcontext() as decimals:
        decimals.prec = 128
        return _replay_baseline(db, workspace, actor, identifier, _clock(now), stop_requested)[0]


def prepare_corrected_action_source(db, workspace, actor, identifier, *, now=None, stop_requested=None):
    """Internal source preparation; not a VerifiedSourceReview or publication."""
    at = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope(), localcontext() as decimals:
        decimals.prec = 128
        doc, history, anchor = _replay_baseline(db, workspace, actor, identifier, at, stop_requested)
        _, original, _, _ = consent._impact(db, workspace, actor, doc["impact_request_id"], at)
        _, witness = consent.review._preview_header(db, workspace, actor, original["body"]["preview_id"])
        _, context = _prepare_action_review_draft(db, workspace, actor, witness["authority_id"], now=at)
        leaves = db.execute("""SELECT a.id FROM investor_action_authorities a WHERE a.workspace_id=? AND json_extract(a.document_json,'$.provider_symbol')=?
          AND NOT EXISTS(SELECT 1 FROM investor_action_review_confirmations c WHERE c.previous_authority_id=a.id) LIMIT 2""",
            (workspace, context["policy"]["provider_symbol"])).fetchall()
        _check(len(leaves) == 1 and leaves[0]["id"] == witness["authority_id"], "SCOPE_CHANGED")
        base = doc["baseline"]["approved_facts"]
        candidate = check_no_new_action_extension(base, anchor, context["current"], symbol=context["policy"]["provider_symbol"], listing_id=context["policy"]["listing_id"])
        _check(not doc["outstanding_new_report_dates"], "NEW_REPORTS_REQUIRE_REVIEW")
        facts = {**deepcopy(base), "range_end": candidate["candidate_range_end"]}
        proof = {"schema_version": "investor-corrected-action-source-proof-v1", "workspace_id": workspace, "model_id": doc["model_id"],
            "confirmation_id": identifier, "confirmation_hash": content_hash(doc), "original_head_id": history["proof"]["head_checkpoint_id"],
            "original_chain_hash": history["proof"]["checkpoint_chain_hash"], "authority_id": witness["authority_id"], "authority_hash": witness["authority_hash"],
            "control_id": witness["control_id"], "control_hash": witness["control_hash"], "base_facts_hash": content_hash(base), "candidate_facts_hash": content_hash(facts),
            "anchor_captures": doc["capture_refs"], "current_captures": context["refs"], "extension_hash": content_hash(candidate),
            "previous_coverage_end": base["range_end"], "candidate_coverage_end": facts["range_end"], "source_day": context["report"]["source_day"],
            "knowledge_at": doc["baseline"]["knowledge_at"], "checked_at": at,
            "valid_until": min(doc["valid_until"], history["proof"]["source_valid_until"], context["maximum_valid_until"], managed._deadline(at, context["policy"]), key=instant),
            "status": "corrected_report_basis_prepared_not_published", "coverage_basis": managed.BASIS, "economic_correction_approved": True,
            **{key: False for key in ("current_source_eligibility_restored", "handover_registered", "maintenance_enabled", "checkpoint_created", "monitoring_resumed", "trading_permission")},
            "provider_calls": 0, "database_writes": 0, "distribution": "private_owner_only_not_ai"}
        _check(instant(at) < instant(proof["valid_until"]), "EXPIRED"); validate_contract(proof, SCHEMA)
        managed._stopped(db, stop_requested)
        return {"proof": proof, "facts": facts}
