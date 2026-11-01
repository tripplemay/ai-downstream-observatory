"""Private, unapproved changes from retained originals; no approval or provider I/O."""

from copy import deepcopy
from datetime import date, timedelta

from worker.market.contracts import validate_contract
from worker.orchestration.db import content_hash, instant, transaction
from . import managed_actions as managed
from .data_evidence import _fact_validation_scope, _owner
from .model_runtime import _clock
from .reviewed_actions import _check, _historical_basis, _source_history, _time


_FIELDS = {
    "issuer": ("ex_date", "issuer_type_code", "distribution_amount", "record_date", "pay_date"),
    "dividends": ("date", "value", "unadjusted_value", "reported_currency", "declaration_date", "record_date", "payment_date", "reported_period"),
    "splits": ("date", "numerator", "denominator"),
}


def _index(snapshot):
    result = {}
    for kind, fields in _FIELDS.items():
        groups, date_field = {}, "ex_date" if kind == "issuer" else "date"
        for row in snapshot[kind]["records"]:
            groups.setdefault(row[date_field], []).append({**{key: row[key] for key in fields}, "record_hash": content_hash(row)})
        result[kind] = {day: sorted(rows, key=lambda row: row["record_hash"]) for day, rows in groups.items()}
    return result


def _changes(previous, current, coverage_end, common_end):
    days, overlap = set(), {}
    previous_rows, current_rows = _index(previous), _index(current)
    for kind in _FIELDS:
        before, after = previous[kind]["source"], current[kind]["source"]
        overlap[kind] = max(before["range_start"], after["range_start"]), min(before["range_end"], after["range_end"], coverage_end)
        days.update(previous_rows[kind]); days.update(current_rows[kind])
    result = []
    for day in sorted(days):
        historical = day <= coverage_end
        before, after = {}, {}
        for kind in _FIELDS:
            inside = overlap[kind][0] <= day <= overlap[kind][1]
            before[kind] = previous_rows[kind].get(day, []) if historical and inside else []
            after[kind] = current_rows[kind].get(day, []) if not historical or inside else []
        if before == after:
            continue
        result.append({"date": day, "disposition": "historical_correction" if historical else "new_report",
            "outside_common_coverage": day > common_end, "previous": before, "current": after,
            "effective_at": None, "payment_at": None, "tax_per_unit": None})
    _check(len(result) <= 4096, "DRAFT_LIMIT")
    return result


def preview_action_review_draft(db, workspace, actor, authority_id, *, now=None):
    """Owner-only inspection. It must not require creating an approved review first."""
    at = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor)
        authority, policy, control = managed._authority(db, workspace, authority_id, at)
        _check(policy["valid_from"] <= at < policy["valid_until"], "AUTHORITY_EXPIRED")
        anchor = managed._anchor(db, workspace, actor, policy["base_review_id"], policy["listing_review_id"], policy["anchor_captures"], at)
        _check(anchor["base"]["review"]["content_hash"] == policy["base_review_hash"]
            and anchor["listing"]["review"]["content_hash"] == policy["listing_review_hash"]
            and anchor["listing"]["facts"]["listing_id"] == policy["listing_id"]
            and anchor["listing"]["facts"]["provider_symbol"] == policy["provider_symbol"]
            and anchor["binding_hash"] == policy["anchor_binding_hash"]
            and instant(anchor["base"]["review"]["created_at"]) <= instant(authority["created_at"])
            and all(instant(value["capture"]["created_at"]) <= instant(authority["created_at"]) for value in anchor["values"].values()),
            "AUTHORITY_INPUTS_CHANGED")
        prior, previous, publication_id, limits = _historical_basis(db, workspace, actor, authority, policy, anchor, at)
        day = instant(at).astimezone(managed.ZONE).date().isoformat()
        refs, failure = managed._current_refs(db, workspace, policy, day, at)
        _check(failure is None, "SOURCE_CAPTURE_TERMINAL_FAILURE")
        _check(refs is not None, "CURRENT_REPORTS_PENDING")
        values, report, current_limits = managed._captures(db, workspace, actor, policy["listing_review_id"], refs, at)
        _check(report["source_day"] == day and report["evidence_mode"] == "official_capture_replay", "CURRENT_REPORTS_NOT_QUALIFIED")
        _check(all(report["bindings"][kind][key] == anchor["report"]["bindings"][kind][key]
            for kind in report["bindings"] for key in ("authority_id", "authority_hash", "control_id", "control_hash")),
            "SOURCE_AUTHORITY_CHANGED")
        current = {kind: value["draft"] for kind, value in values.items()}
        floor = max((value for capture in values.values() for value in (capture["capture"]["created_at"], capture["draft"]["source"]["retrieved_at"])), key=instant)
        _check(_time(floor) <= instant(at), "REVIEW_PRECEDES_DATA")
        old_end = prior["facts"]["range_end"]
        tail_start = (date.fromisoformat(old_end) + timedelta(days=1)).isoformat()
        for kind in _FIELDS:
            before, after = previous[kind]["source"], current[kind]["source"]
            _check(after["range_start"] >= before["range_start"] and after["range_end"] >= before["range_end"]
                and _time(after["retrieved_at"]) >= _time(before["retrieved_at"]), "SOURCE_RANGE_REGRESSION")
            _check(after["range_start"] <= tail_start, "HISTORY_WINDOW_GAP")
        # Corrections remain visible for explicit review; all other window or
        # chronology failures still reject the draft instead of implying absence.
        try:
            _source_history(previous, current, old_end)
        except ValueError as error:
            if str(error) != "INVESTOR_REVIEWED_ACTION_HISTORICAL_SOURCE_CORRECTION_REQUIRED":
                raise
        common = report["comparison"]["common_window"]
        _check(common is not None and common["range_start"] <= old_end, "HISTORY_WINDOW_GAP")
        changes = _changes(previous, current, old_end, common["range_end"])
        historical = any(row["disposition"] == "historical_correction" for row in changes)
        status = "historical_correction_required" if historical else "new_reported_actions" if changes else "no_reported_changes"
        maximum_until = _clock(min([instant(policy["valid_until"]), *anchor["limits"], *limits, *current_limits]))
        deadline = _clock(min(instant(at) + timedelta(seconds=60), instant(maximum_until)))
        _check(at < deadline, "DRAFT_EXPIRED")
        basis = {"workspace": workspace, "owner": actor, "authority_id": authority_id, "authority_hash": authority["content_hash"],
            "control_id": control["id"], "control_hash": control["content_hash"], "publication_id": publication_id,
            "previous_review_hash": prior["review"]["content_hash"], "previous_facts_hash": content_hash(prior["facts"]),
            "previous_snapshot_hash": content_hash(previous), "current_snapshot_hash": content_hash(current),
            "current_bindings": report["bindings"], "changes": changes, "knowledge_not_before": floor, "maximum_valid_until": maximum_until}
        result = {"schema_version": "investor-action-review-draft-v1", "status": status, "checked_at": at, "refresh_after": deadline,
            "draft_basis_hash": content_hash(basis), "authority_id": authority_id, "authority_hash": authority["content_hash"],
            "control_id": control["id"], "control_hash": control["content_hash"], "rule_enabled": bool(control["enabled"]),
            "previous_publication_id": publication_id, "previous_coverage_end": old_end, "candidate_coverage_end": common["range_end"],
            "previous_tax_assumption_hash": content_hash({"tax_assumption": prior["facts"]["tax_assumption"]}),
            "knowledge_not_before": floor, "changes": changes, "source_report": deepcopy(report),
            "required_confirmations": ["ISSUER_AMOUNT_UNIT_AND_CURRENCY", "EFFECTIVE_AND_PAYMENT_INSTANTS", "EXPLICIT_TAX_AMOUNT",
                "COMPLETE_REPORTED_COVERAGE", "KNOWLEDGE_TIMING_PROTOCOL", "SEPARATE_MAINTENANCE_CONSENT"],
            "visibility": "private_owner_only_not_ai", "confirmation_supported": False, "approval_performed": False,
            "new_review_created": False, "new_rule_enabled": False, "quarantine_cleared": False,
            "research_admitted": False, "live_advice_eligible": False, "trading_permission": False, "provider_calls": 0, "database_writes": 0}
        validate_contract(result, "investor-action-review-draft.schema.json")
        return result
