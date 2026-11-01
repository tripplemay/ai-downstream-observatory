"""Prepare an explicitly reviewed append; never authorize or publish a successor."""

from datetime import date, timedelta
from decimal import Decimal
import re

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, instant, transaction
from .action_reconciliation import TARGETS, _compare
from .data_evidence import validate_facts
from .no_new_actions import ZONE, _check_base_overlap, _groups, _snapshot, check_no_new_action_extension


def _check(value, code):
    if not value:
        raise WorkbenchError("INVESTOR_REVIEWED_ACTION_" + code)


def _time(value, code="SOURCE_TIME_INVALID"):
    _check(type(value) is str and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value), code)
    return instant(value)


def _source_history(previous, current, coverage_end):
    tail_start = (date.fromisoformat(coverage_end) + timedelta(days=1)).isoformat()
    for kind, day, fields in (("issuer", "ex_date", ("ex_date", "issuer_type_code")),
            ("dividends", "date", ("date",)), ("splits", "date", ("date",))):
        before, after = previous[kind], current[kind]
        _check(after["source"]["range_start"] >= before["source"]["range_start"]
            and after["source"]["range_end"] >= before["source"]["range_end"]
            and instant(after["source"]["retrieved_at"]) >= instant(before["source"]["retrieved_at"]), "SOURCE_RANGE_REGRESSION")
        _check(after["source"]["range_start"] <= tail_start, "HISTORY_WINDOW_GAP")
        start = max(before["source"]["range_start"], after["source"]["range_start"])
        _check(_groups(before["records"], day, fields, start, coverage_end)
            == _groups(after["records"], day, fields, start, coverage_end), "HISTORICAL_SOURCE_CORRECTION_REQUIRED")


def _fact_events(facts):
    for event in facts["events"]:
        day = instant(event["at"]).astimezone(ZONE).date().isoformat()
        _check(facts["range_start"] <= day <= facts["range_end"], "FACT_EVENT_OUTSIDE_REVIEW_RANGE")
        if event["type"] == "dividend":
            _check(instant(event["pay_at"]) >= instant(event["at"]), "PAYMENT_PRECEDES_ENTITLEMENT")
            _check(Decimal(0) <= Decimal(event["tax_per_unit"]) <= Decimal(event["gross_per_unit"]), "TAX_AMOUNT_INVALID")


def check_reviewed_action_append(previous_facts, reviewed_facts, previous, current, *, symbol, listing_id, knowledge_floor, reviewed_at):
    """Pure proof inputs require independent owner, source and publication bindings."""
    _check(symbol in TARGETS, "IDENTITY_DIFFERS")
    validate_facts("actions", previous_facts)
    validate_facts("actions", reviewed_facts)
    _fact_events(previous_facts)
    _fact_events(reviewed_facts)
    _check(previous_facts["listing_id"] == reviewed_facts["listing_id"] == listing_id, "IDENTITY_DIFFERS")
    prior_day, current_day = _snapshot(previous, symbol), _snapshot(current, symbol)
    _check(current_day >= prior_day, "CLOCK_REGRESSION")
    for snapshot in (previous, current):
        for draft in snapshot.values():
            _time(draft["source"]["retrieved_at"])
    # This verifies the old raw report overlap, not its owner/source authority.
    check_no_new_action_extension(previous_facts, previous, previous, symbol=symbol, listing_id=listing_id)
    old_end, new_end = previous_facts["range_end"], reviewed_facts["range_end"]
    _check(new_end > old_end, "MATERIAL_APPEND_REQUIRED")
    fixed = lambda facts: {key:value for key,value in facts.items() if key not in ("range_end", "events")}
    _check(fixed(previous_facts) == fixed(reviewed_facts), "HISTORICAL_FACTS_CHANGED")
    old_events, events = previous_facts["events"], reviewed_facts["events"]
    _check(len(events) >= len(old_events) and events[:len(old_events)] == old_events, "HISTORICAL_FACTS_CHANGED")
    added = events[len(old_events):]
    _check(added, "MATERIAL_APPEND_REQUIRED")
    _check(len({event["id"] for event in events}) == len(events), "DUPLICATE_EVENT_ID")
    floor, reviewed = _time(knowledge_floor, "KNOWLEDGE_FLOOR_INVALID"), _time(reviewed_at, "REVIEW_TIME_INVALID")
    _check(floor >= max(_time(draft["source"]["retrieved_at"]) for draft in current.values()), "KNOWLEDGE_FLOOR_INVALID")
    _check(floor <= reviewed, "REVIEW_PRECEDES_DATA")
    for event in added:
        day = instant(event["at"]).astimezone(ZONE).date().isoformat()
        _check(day > old_end, "HISTORICAL_CORRECTION_REQUIRED")
        _check(day <= new_end, "EVENT_OUTSIDE_REVIEW_RANGE")
        _check(instant(event["published_at"]) >= floor, "EARLIER_KNOWLEDGE_REQUIRES_EVIDENCE")
        _check(instant(event["published_at"]) <= reviewed, "KNOWLEDGE_AFTER_REVIEW")
    _source_history(previous, current, old_end)
    for kind, day in (("issuer", "ex_date"), ("dividends", "date"), ("splits", "date")):
        source = current[kind]
        _check(source["source"]["range_end"] >= new_end, "SOURCE_RANGE_INCOMPLETE")
        _check(not any(row[day] > new_end for row in source["records"]), "REPORT_OUTSIDE_REVIEW_RANGE")
    comparison = _compare(current["issuer"], current["dividends"], current["splits"], "USD")
    counts = comparison["counts"]
    _check(comparison["common_window"] is not None and all(counts[key] == 0 for key in (
        "record_date_differences", "record_date_unknown", "payment_date_differences", "payment_date_unknown",
        "issuer_only_dates", "provider_only_dates", "ambiguous_issuer_groups", "unsupported_issuer_groups",
        "reported_currency_mismatches")), "CURRENT_REPORTS_REQUIRE_SEPARATE_REVIEW")
    start = max(reviewed_facts["range_start"], *(draft["source"]["range_start"] for draft in current.values()))
    _check(start <= old_end, "HISTORY_WINDOW_GAP")
    _check_base_overlap(reviewed_facts, current, start, new_end)
    # These are local comparison subsets, not replacement source drafts or coverage claims.
    # Older rows may leave the rolling window; only new-date differences belong here.
    tail = {kind:{"source":current[kind]["source"], "records":[row for row in current[kind]["records"] if row[day] > old_end]}
        for kind,day in (("issuer", "ex_date"), ("dividends", "date"), ("splits", "date"))}
    new_comparison = _compare(tail["issuer"], tail["dividends"], tail["splits"], "USD")
    late = sum(instant(event["published_at"]) > instant(event["at"]) for event in added)
    result = {"status":"reviewed_append_prepared_only", "previous_facts_hash":content_hash(previous_facts),
        "reviewed_facts_hash":content_hash(reviewed_facts), "previous_snapshot_hash":content_hash(previous),
        "current_snapshot_hash":content_hash(current), "previous_coverage_end":old_end, "new_coverage_end":new_end,
        "added_event_count":len(added), "added_dividend_count":sum(event["type"] == "dividend" for event in added),
        "added_split_count":sum(event["type"] == "split" for event in added),
        "new_nominal_difference_count":new_comparison["counts"]["nominal_amount_differences"],
        "knowledge_basis":"current_complete_report_receipts_only", "late_knowledge_event_count":late,
        "continuation_timing_ready":late == 0, "requires_separate_knowledge_or_start":late > 0,
        "old_events_and_tax_assumption_unchanged":True, "owner_approval_verified":False, "source_authority_verified":False,
        "handover_registered":False, "research_admitted":False, "trading_permission":False,
        "provider_calls":0, "database_writes":0, "raw_amounts_or_tax_text_output":False}
    validate_contract(result, "investor-action-successor.schema.json", fragment="$defs/append_proof")
    return result


def _historical_basis(db, workspace, actor, authority, policy, anchor, at):
    """A quarantined rule may be authenticated for comparison, never current admission."""
    from . import managed_actions as managed
    head = db.execute("SELECT id FROM investor_action_publications WHERE authority_id=? AND status='published' ORDER BY sequence DESC LIMIT 1",
        (authority["id"],)).fetchone()
    if head is None:
        return anchor["base"], anchor["snapshots"], None, anchor["limits"]
    row, doc = managed._publication_header(db, workspace, head[0], at)
    prepared = managed._inputs(db, workspace, actor, policy, doc["capture_refs"], at)
    _check(instant(row["valid_until"]) > instant(at) and prepared["checked_hash"] == doc["checked_input_hash"]
        and prepared["valid_until"] == row["valid_until"]
        and prepared["candidate"]["candidate_facts_hash"] == doc["candidate_facts_hash"]
        and prepared["candidate"]["candidate_range_end"] == row["coverage_end"]
        and instant(prepared["current_capture_created_at"]) <= instant(row["created_at"])
        and all(instant(value["capture"]["created_at"]) <= instant(authority["created_at"]) for value in anchor["values"].values()),
        "HISTORICAL_PUBLICATION_INVALID")
    values, report, limits = managed._captures(db, workspace, actor, policy["listing_review_id"], doc["capture_refs"], at)
    _check(report == prepared["report"], "HISTORICAL_PUBLICATION_INVALID")
    return managed.managed_review_header(db, workspace, head[0], at), {key:value["draft"] for key,value in values.items()}, head[0], limits


def preview_reviewed_action_successor(db, workspace, actor, previous_authority_id, next_authority_id, *, now=None):
    """Verify existing manual review and raw bindings; do not retire or enable rules."""
    from datetime import timedelta
    from . import managed_actions as managed
    from .data_evidence import _fact_validation_scope, _owner
    from .model_runtime import _clock
    at = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor)
        _check(previous_authority_id != next_authority_id, "DISTINCT_AUTHORITIES_REQUIRED")
        old, old_policy, old_control = managed._authority(db, workspace, previous_authority_id, at)
        new, new_policy, new_control = managed._authority(db, workspace, next_authority_id, at)
        _check(new_control["version"] == 1 and new_control["enabled"] == 0, "NEW_AUTHORITY_MUST_REMAIN_UNSTARTED")
        _check(all(old_policy[key] == new_policy[key] for key in ("listing_id", "provider_symbol", "listing_review_id", "listing_review_hash")),
            "IDENTITY_DIFFERS")
        _check(old_policy["valid_from"] <= at < old_policy["valid_until"]
            and new_policy["valid_from"] <= at < new_policy["valid_until"], "AUTHORITY_EXPIRED")
        before = managed._anchor(db, workspace, actor, old_policy["base_review_id"], old_policy["listing_review_id"], old_policy["anchor_captures"], at)
        after = managed._anchor(db, workspace, actor, new_policy["base_review_id"], new_policy["listing_review_id"], new_policy["anchor_captures"], at)
        for authority,policy,value in ((old,old_policy,before), (new,new_policy,after)):
            _check(policy["base_review_hash"] == value["base"]["review"]["content_hash"]
                and policy["anchor_binding_hash"] == value["binding_hash"]
                and instant(value["base"]["review"]["created_at"]) <= instant(authority["created_at"])
                and all(instant(entry["capture"]["created_at"]) <= instant(authority["created_at"]) for entry in value["values"].values()),
                "AUTHORITY_INPUTS_CHANGED")
        _check(before["base"]["source"]["id"] != after["base"]["source"]["id"], "IMMUTABLE_OLD_REVIEW_SOURCE_REQUIRED")
        _check(all(before["report"]["bindings"][kind][key] == after["report"]["bindings"][kind][key]
            for kind in before["report"]["bindings"] for key in ("authority_id", "authority_hash", "control_id", "control_hash")),
            "SOURCE_AUTHORITY_CHANGED")
        prior, snapshots, prior_publication, limits = _historical_basis(db, workspace, actor, old, old_policy, before, at)
        floor = max((timestamp for value in after["values"].values()
            for timestamp in (value["capture"]["created_at"], value["draft"]["source"]["retrieved_at"])), key=instant)
        reviewed_at = after["base"]["review"]["created_at"]
        _check(max(instant(prior["review"]["created_at"]), instant(old["created_at"])) <= instant(reviewed_at) <= instant(at),
            "REVIEW_TIME_INVALID")
        proof = check_reviewed_action_append(prior["facts"], after["base"]["facts"], snapshots, after["snapshots"],
            symbol=new_policy["provider_symbol"], listing_id=new_policy["listing_id"], knowledge_floor=floor, reviewed_at=reviewed_at)
        deadline = _clock(min([instant(at) + timedelta(seconds=60), instant(old_policy["valid_until"]), instant(new_policy["valid_until"]),
            *before["limits"], *after["limits"], *limits]))
        result = {"status":"explicit_review_successor_prepared_not_registered", "checked_at":at, "refresh_after":deadline,
            "previous_authority_id":old["id"], "previous_authority_hash":old["content_hash"],
            "previous_control_id":old_control["id"], "previous_control_hash":old_control["content_hash"],
            "previous_control_enabled":bool(old_control["enabled"]), "previous_publication_id":prior_publication,
            "next_authority_id":new["id"], "next_authority_hash":new["content_hash"],
            "next_control_id":new_control["id"], "next_control_hash":new_control["content_hash"],
            "previous_manual_review_id":old_policy["base_review_id"], "next_manual_review_id":new_policy["base_review_id"],
            "next_manual_review_record_verified":True, "approval_performed_by_preview":False, "append_proof":proof,
            "source_control_and_raw_bindings_verified":True,
            "continuation_timing_ready":proof["continuation_timing_ready"],
            "requires_separate_knowledge_or_start":proof["requires_separate_knowledge_or_start"],
            "handover_registered":False, "next_rule_enabled":False, "quarantine_cleared":False,
            "provider_calls":0, "database_writes":0, "research_admitted":False, "trading_permission":False,
            "raw_amounts_or_tax_text_output":False}
        validate_contract(result, "investor-action-successor.schema.json", fragment="$defs/preview")
        return result
