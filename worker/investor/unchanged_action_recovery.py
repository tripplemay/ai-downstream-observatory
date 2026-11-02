"""Explicit unchanged-source recovery proofs; never retry a source or clear history."""

from copy import deepcopy

from worker.market.contracts import validate_contract
from worker.orchestration.db import content_hash, instant
from .no_new_actions import check_no_new_action_extension
from .reviewed_actions import _check


SCHEMA = "investor-unchanged-action-recovery.schema.json"
SUBMIT = "investor-unchanged-action-recovery-submit-v1"
CONFIRMATION = "investor-unchanged-action-recovery-confirmation-v1"
RECOVERABLE_FAILURES = {"SOURCE_CAPTURE_TERMINAL_FAILURE", "MAINTENANCE_WINDOW_MISSED"}


def is_recovery(document):
    return document.get("schema_version") in (SUBMIT, CONFIRMATION)


def failure_witness(db, workspace, authority_id, at):
    from . import managed_actions as managed
    row = db.execute("SELECT id FROM investor_action_publications WHERE workspace_id=? AND authority_id=? AND status='blocked' ORDER BY sequence DESC LIMIT 1",
        (workspace, authority_id)).fetchone()
    _check(row is not None, "RECOVERY_REQUIRES_ORIGINAL_FAILURE")
    publication, doc = managed._publication_header(db, workspace, row["id"], at)
    _check(publication["status"] == "blocked" and publication["created_at"] <= at, "RECOVERY_FAILURE_INVALID")
    _check(doc["failure_code"] in RECOVERABLE_FAILURES, "RECOVERY_UNSUPPORTED_FAILURE")
    return {"failed_publication_id": publication["id"], "failed_publication_hash": publication["content_hash"],
        "failed_source_day": publication["source_day"], "failed_at": publication["created_at"], "failure_code": doc["failure_code"]}


def recovery_facts(previous_facts, previous, current, *, symbol, listing_id):
    candidate = check_no_new_action_extension(previous_facts, previous, current, symbol=symbol, listing_id=listing_id)
    _check(candidate["status"] == "eligible_candidate_only", "RECOVERY_COVERAGE_MUST_ADVANCE")
    facts = deepcopy(previous_facts)
    facts["range_end"] = candidate["candidate_range_end"]
    _check(content_hash(facts) == candidate["candidate_facts_hash"], "RECOVERY_FACTS_CHANGED")
    return facts, candidate


def check_unchanged_action_recovery(previous_facts, reviewed_facts, previous, current, *, symbol, listing_id, knowledge_floor, reviewed_at, failure):
    """Pure comparison. Failure/header ownership and raw sources need separate replay."""
    _check(failure["failure_code"] in RECOVERABLE_FAILURES, "RECOVERY_UNSUPPORTED_FAILURE")
    facts, candidate = recovery_facts(previous_facts, previous, current, symbol=symbol, listing_id=listing_id)
    _check(facts == reviewed_facts, "RECOVERY_FACTS_CHANGED")
    _check(candidate["current_source_day"] > failure["failed_source_day"], "RECOVERY_REQUIRES_LATER_SOURCE_DAY")
    floor = max(instant(draft["source"]["retrieved_at"]) for draft in current.values())
    _check(instant(failure["failed_at"]) < floor <= instant(knowledge_floor) <= instant(reviewed_at), "RECOVERY_TIME_INVALID")
    proof = {"status": "unchanged_recovery_prepared_only", "previous_facts_hash": content_hash(previous_facts),
        "reviewed_facts_hash": content_hash(facts), "previous_snapshot_hash": content_hash(previous), "current_snapshot_hash": content_hash(current),
        "previous_coverage_end": previous_facts["range_end"], "new_coverage_end": facts["range_end"],
        "added_event_count": 0, "added_dividend_count": 0, "added_split_count": 0, "new_nominal_difference_count": 0,
        "knowledge_basis": "current_complete_report_receipts_only", "late_knowledge_event_count": 0,
        "continuation_timing_ready": True, "requires_separate_knowledge_or_start": False,
        "old_events_and_tax_assumption_unchanged": True, "owner_approval_verified": False, "source_authority_verified": False,
        "handover_registered": False, "research_admitted": False, "trading_permission": False,
        "provider_calls": 0, "database_writes": 0, "raw_amounts_or_tax_text_output": False, **failure}
    validate_contract(proof, SCHEMA, fragment="$defs/proof")
    return proof
