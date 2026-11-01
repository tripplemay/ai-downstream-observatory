"""Pure candidate checks for a bounded standing rule, not authority or publication."""

from copy import deepcopy
from datetime import date, timedelta
from decimal import Decimal, localcontext
from zoneinfo import ZoneInfo

from worker.orchestration.db import WorkbenchError, content_hash, instant
from .action_reconciliation import TARGETS, _compare
from .data_evidence import validate_facts


ZONE = ZoneInfo("America/New_York")


def _check(value, code):
    if not value:
        raise WorkbenchError("INVESTOR_DATA_ACTION_MAINTENANCE_" + code)


def _snapshot(value, symbol):
    _check(type(value) is dict and set(value) == {"issuer", "dividends", "splits"}, "SNAPSHOT_INVALID")
    for draft in value.values():
        _check(type(draft) is dict and all(draft.get(key) is False for key in
            ("owner_reviewed", "corporate_actions_complete", "research_admitted")), "DRAFT_REQUIRED")
        _check(type(draft.get("source")) is dict and type(draft.get("records")) is list and len(draft["records"]) <= 2048,
            "SNAPSHOT_INVALID")
    issuer = value["issuer"]["source"]
    _check(issuer.get("provider") == "vanguard_issuer" and issuer.get("requested_fund_id") == TARGETS[symbol], "IDENTITY_DIFFERS")
    for key, kind in (("dividends", "div"), ("splits", "splits")):
        source = value[key]["source"]
        _check(source.get("provider") == "eodhd" and source.get("requested_symbol") == symbol and source.get("kind") == kind,
            "IDENTITY_DIFFERS")
    days = {instant(draft["source"]["retrieved_at"]).astimezone(ZONE).date() for draft in value.values()}
    _check(len(days) == 1, "SOURCE_DAYS_DIFFER")
    return next(iter(days))


def _groups(records, day_key, key_fields, start, end):
    result = {}
    for row in records:
        if start <= row[day_key] <= end:
            key = tuple(row[field] for field in key_fields)
            _check(key not in result, "AMBIGUOUS_RECORDS")
            result[key] = row
    return result


def _check_base_overlap(base, anchor, start, end):
    reviewed_dividends, reviewed_splits = {}, {}
    for event in base["events"]:
        day = instant(event["at"]).astimezone(ZONE).date().isoformat()
        if not start <= day <= end:
            continue
        if event["type"] == "dividend":
            reviewed_dividends.setdefault(day, []).append(event)
        else:
            _check(day not in reviewed_splits, "AMBIGUOUS_REVIEWED_SPLITS")
            reviewed_splits[day] = event
    issued = {}
    for row in anchor["issuer"]["records"]:
        if start <= row["ex_date"] <= end:
            issued.setdefault(row["ex_date"], []).append(row)
    _check(set(reviewed_dividends) == set(issued), "BASE_DISTRIBUTIONS_DIFFER")
    for day, events in reviewed_dividends.items():
        rows = issued[day]
        pay_days = {instant(event["pay_at"]).astimezone(ZONE).date().isoformat() for event in events}
        _check(len(pay_days) == 1 and pay_days == {row["pay_date"] for row in rows}, "BASE_PAYMENT_DATES_DIFFER")
        with localcontext() as context:
            context.prec = 128
            gross = sum((Decimal(event["gross_per_unit"]) for event in events), Decimal(0))
            amount = sum((Decimal(row["distribution_amount"]) for row in rows), Decimal(0))
        _check(gross == amount, "BASE_AMOUNTS_DIFFER")
    splits = _groups(anchor["splits"]["records"], "date", ("date",), start, end)
    _check(set(reviewed_splits) == {key[0] for key in splits}, "BASE_SPLITS_DIFFER")
    for (day,), row in splits.items():
        with localcontext() as context:
            context.prec = 128
            _check(Decimal(reviewed_splits[day]["ratio"]) * Decimal(row["denominator"]) == Decimal(row["numerator"]),
                "BASE_SPLIT_RATIO_DIFFERS")
    return len(issued), len(splits)


def check_no_new_action_extension(base_facts, anchor, current, *, symbol, listing_id):
    """Inputs must be exact resolver outputs; result is insufficient to publish facts."""
    _check(symbol in TARGETS, "IDENTITY_DIFFERS")
    validate_facts("actions", base_facts)
    _check(base_facts["listing_id"] == listing_id, "IDENTITY_DIFFERS")
    anchor_day = _snapshot(anchor, symbol)
    current_day = _snapshot(current, symbol)
    _check(current_day >= anchor_day, "CLOCK_REGRESSION")
    base_end = base_facts["range_end"]
    end = min(draft["source"]["range_end"] for draft in current.values())
    anchor_end = min(draft["source"]["range_end"] for draft in anchor.values())
    _check(end >= anchor_end >= base_end, "RANGE_REGRESSION")
    start = max(base_facts["range_start"], *(draft["source"]["range_start"] for draft in anchor.values()))
    _check(start <= base_end, "BASE_OVERLAP_MISSING")
    comparison = _compare(anchor["issuer"], anchor["dividends"], anchor["splits"], "USD")
    counts = comparison["counts"]
    _check(comparison["common_window"] is not None, "BASE_OVERLAP_MISSING")
    _check(all(counts[key] == 0 for key in ("record_date_differences", "record_date_unknown", "payment_date_differences",
        "payment_date_unknown", "issuer_only_dates", "provider_only_dates", "ambiguous_issuer_groups",
        "unsupported_issuer_groups", "reported_currency_mismatches")), "ANCHOR_NON_NOMINAL_DIFFERENCES")
    distribution_dates, split_dates = _check_base_overlap(base_facts, anchor, start, base_end)
    tail_start = (date.fromisoformat(base_end) + timedelta(days=1)).isoformat()
    for name, day_field, key_fields in (("issuer", "ex_date", ("ex_date", "issuer_type_code")),
            ("dividends", "date", ("date",)), ("splits", "date", ("date",))):
        old, new = anchor[name], current[name]
        _check(new["source"]["range_start"] >= old["source"]["range_start"]
            and new["source"]["range_end"] >= old["source"]["range_end"]
            and instant(new["source"]["retrieved_at"]) >= instant(old["source"]["retrieved_at"]), "RANGE_REGRESSION")
        _check(new["source"]["range_start"] <= tail_start, "HISTORY_WINDOW_GAP")
        # A reported new event stops the rule even if another source has not
        # yet reached that date; the common cutoff must not hide it.
        _check(not any(row[day_field] > base_end for row in old["records"] + new["records"]), "NEW_REPORTED_ACTION")
        overlap_start = max(old["source"]["range_start"], new["source"]["range_start"])
        _check(_groups(old["records"], day_field, key_fields, overlap_start, base_end)
            == _groups(new["records"], day_field, key_fields, overlap_start, base_end), "HISTORICAL_RECORDS_CHANGED")
    candidate = deepcopy(base_facts)
    candidate["range_end"] = end
    _check({key:value for key,value in candidate.items() if key != "range_end"}
        == {key:value for key,value in base_facts.items() if key != "range_end"}, "BASE_FACTS_CHANGED")
    return {"status": "eligible_candidate_only" if end > base_end else "no_coverage_advance",
        "base_facts_hash": content_hash(base_facts), "candidate_facts_hash": content_hash(candidate),
        "range_start": base_facts["range_start"], "previous_range_end": base_end, "candidate_range_end": end,
        "anchor_source_day": anchor_day.isoformat(), "current_source_day": current_day.isoformat(),
        "overlap_distribution_dates": distribution_dates, "overlap_split_dates": split_dates,
        "registered_nominal_difference_count": counts["nominal_amount_differences"],
        "coverage_basis": "selected_two_source_reports_not_objective_absence",
        "authority_and_publication_not_verified": True, "old_events_and_tax_assumption_unchanged": True,
        "owner_reviewed_today": False, "corporate_actions_complete": False, "research_admitted": False,
        "trading_permission": False, "source_calls": 0, "database_writes": 0, "market_values_output": False}
