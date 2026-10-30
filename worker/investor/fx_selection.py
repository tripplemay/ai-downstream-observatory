"""Current reviewed FX selection, without merging unrelated source authorities."""

from datetime import timedelta

from worker.accounting.decimal_math import decimal
from worker.orchestration.db import WorkbenchError, instant
from .data_evidence import validate_facts


MAX_REVIEWS = 128
MAX_ROWS = 100000
GAPS = {"INVESTOR_MONITOR_FX_SOURCE_INVALID", "INVESTOR_MONITOR_FX_SOURCE_LIMIT",
    "INVESTOR_MONITOR_FX_NOT_CURRENT", "INVESTOR_MONITOR_FX_AUTHORITY_AMBIGUOUS",
    "INVESTOR_MONITOR_FX_RESTATEMENT_REQUIRED"}


def _require(value, code="SOURCE_INVALID"):
    if not value:
        raise WorkbenchError("INVESTOR_MONITOR_FX_" + code)


def select_current_fx(reviews, currencies, *, at, max_age_seconds):
    """Consume resolved current owner reviews; this function supplies no approval.

    Legacy sources remain usable when uniquely current. Multiple sources require
    an explicitly reviewed append-only series and identical overlapping facts.
    The observation date, not the review date, determines the current tail.
    """
    _require(type(reviews) is list and len(reviews) <= MAX_REVIEWS, "SOURCE_LIMIT")
    _require(type(currencies) in (set, frozenset) and currencies <= {"HKD", "USD"})
    _require(type(max_age_seconds) is int and 1 <= max_age_seconds <= 604800)
    checked = instant(at)
    selected, rows_seen, ids = {}, 0, set()
    for currency in sorted(currencies):
        candidates, history = [], []
        for review in reviews:
            facts = review["facts"]
            if facts["currency"] != currency:
                continue
            rows_seen += len(facts["rows"])
            _require(rows_seen <= MAX_ROWS, "SOURCE_LIMIT")
            validate_facts("fx", facts)
            identifier = review["review"]["id"]
            _require(identifier not in ids)
            ids.add(identifier)
            known = instant(review["review"]["created_at"])
            _require(known <= checked < instant(review["review"]["valid_until"]))
            # Invalid/future facts do not become harmless because another review
            # happens to be fresh, or because the invalid tail would be excluded.
            _require(all(instant(row["assumed_available_at"]) <= known for row in facts["rows"]))
            history.append(review)
            tail = max(instant(row["observed_at"]) for row in facts["rows"])
            if tail + timedelta(seconds=max_age_seconds) <= checked:
                continue
            candidates.append((review, tail))
        _require(candidates, "NOT_CURRENT")
        if len(candidates) > 1:
            series = [row["facts"].get("monitor_series") for row, _ in candidates]
            _require(all(value is not None and value == series[0] for value in series), "AUTHORITY_AMBIGUOUS")
        series = candidates[0][0]["facts"].get("monitor_series")
        if series is not None:
            overlap = {}
            for review in history:
                if review["facts"].get("monitor_series") != series:
                    continue
                for row in review["facts"]["rows"]:
                    key = instant(row["observed_at"])
                    fact = decimal(row["value"]), instant(row["assumed_available_at"])
                    _require(key not in overlap or overlap[key] == fact, "RESTATEMENT_REQUIRED")
                    overlap[key] = fact
        latest = max(tail for _, tail in candidates)
        # Concordant duplicate tails do not change economics. Prefer the wider
        # retained history, then a stable receipt identity, never a newer review.
        eligible = [row for row, tail in candidates if tail == latest]
        chosen = min(eligible, key=lambda row: (-len(row["facts"]["rows"]), row["review"]["id"]))
        selected[currency] = chosen["review"]["id"]
    return selected
