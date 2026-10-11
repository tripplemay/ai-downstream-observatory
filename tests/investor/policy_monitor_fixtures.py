"""Fictional clock/valuation vectors, not receipts or real trading calendars."""

from copy import deepcopy
from datetime import timedelta

from tests.investor.fixtures import MONITOR_NOW, monitor_input
from worker.orchestration.db import instant, stamp
from worker.investor.policy_monitor import funding_identity


def empty_state():
    return {"last_review_at": None, "last_proposed_at": None, "last_funding_hash": None,
        "cash_cny_seen": None, "cash_repair_pending": False}


def document(now=MONITOR_NOW, *, initialized=True):
    value = monitor_input()
    value.update(schema_version="investor-model-monitor-v3", non_cash_assets_cny="0")
    value["policy"] = {key: item for key, item in value["policy"].items() if key not in ("weight_band", "absolute_band_cny")}
    state = empty_state()
    if initialized:
        state.update(last_review_at=stamp(instant(now) - timedelta(days=7)), cash_cny_seen="0")
    value["fixed_policy"] = {"parameters": {"schema_version": "research-fixed-rebalance-parameters-v2",
        "weights": deepcopy(value["after_weights"]), "roles": {"CN:ALPHA": "growth", "HK:BETA": "growth", "US:GAMMA": "defensive"},
        "rebalance": "first_decision_each_half_year", "tolerance": {"absolute_cny": "0", "weight": "0.001"},
        "class_drift_threshold": "0.05", "minimum_days_between_rebalances": 30,
        "contribution_mode": "repair_underweight_without_sales", "order_expiry": "next_month_boundary"},
        "evaluation_timezone": "Asia/Shanghai", "state": state}
    at = instant(now)
    for index, row in enumerate(value["quotes"]):
        observed = stamp(at - timedelta(hours=(16, 15, 3)[index]))
        row.update(observed_at=observed, expected_close_at=observed, known_at=stamp(at - timedelta(seconds=1)), valid_until=stamp(at + timedelta(days=1)))
    for row in value["fx"]:
        row.update(observed_at=stamp(at - timedelta(hours=2)), known_at=stamp(at - timedelta(seconds=1)), valid_until=stamp(at + timedelta(days=1)))
    return value


def vectors():
    result = []
    def add(name, value=None, now=MONITOR_NOW):
        value = document(now) if value is None else value
        result.append({"name": name, "request": {"action": "monitor", "document": value, "now": now}})
        return value
    add("initial-balanced", document(initialized=False))
    add("balanced")
    add("within-class-swap")["quantities"].update({"CN:ALPHA": "46", "HK:BETA": "24"})
    add("inclusive-class-threshold")["quantities"].update({"CN:ALPHA": "45", "US:GAMMA": "25"})
    add("below-class-threshold")["quantities"].update({"CN:ALPHA": "44.999", "US:GAMMA": "25.001"})
    value = add("cooldown-breach"); value["quantities"].update({"CN:ALPHA": "45", "US:GAMMA": "25"})
    value["fixed_policy"]["state"]["last_proposed_at"] = value["fixed_policy"]["state"]["last_review_at"]
    value = add("new-funding-bypasses-cooldown", deepcopy(value))
    value["funding_intent"] = {"id": "fictional-funding", "amount_cny": "2000", "expected_at": MONITOR_NOW}
    value = add("open-funding-keeps-anchor", deepcopy(value))
    value["fixed_policy"]["state"]["last_funding_hash"] = funding_identity(value["funding_intent"])
    equivalent = add("equivalent-funding-spelling-keeps-anchor", deepcopy(value))
    equivalent["funding_intent"].update(amount_cny="2000.00", expected_at=MONITOR_NOW.replace(".000Z", "Z"))
    value = add("changed-funding-renews-anchor", deepcopy(value)); value["funding_intent"]["amount_cny"] = "2001"
    value = add("new-model-cash-no-double-funding"); value["cash_cny"] = "1000"
    value["fixed_policy"]["state"]["last_proposed_at"] = value["fixed_policy"]["state"]["last_review_at"]
    value = add("open-model-cash-keeps-anchor", deepcopy(value))
    value["fixed_policy"]["state"].update(cash_cny_seen="1000", cash_repair_pending=True)
    value = add("foreign-cash-is-not-cny-repair"); value["non_cash_assets_cny"] = "1000"
    value = add("small-funding-within-tolerance"); value["funding_intent"] = {"id": "fictional-small", "amount_cny": "0.5", "expected_at": MONITOR_NOW}
    value = add("future-funding"); value["funding_intent"] = {"id": "fictional-future", "amount_cny": "2000", "expected_at": stamp(instant(MONITOR_NOW) + timedelta(minutes=15))}
    value = add("missing-costs"); value["quantities"].update({"CN:ALPHA": "45", "US:GAMMA": "25"}); value["policy"]["costs"] = None
    value = add("cost-cap", deepcopy(next(row for row in result if row["name"] == "inclusive-class-threshold")["request"]["document"])); value["policy"]["costs"]["maximum_cost_fraction"] = "0"
    add("stale-market")["quotes"][0]["observed_at"] = "2025-07-06T07:00:00.000Z"
    add("expired-exact-boundary")["quotes"][0]["valid_until"] = MONITOR_NOW
    now = "2025-06-30T16:00:00.000Z"
    value = document(now); value["fixed_policy"]["state"]["last_review_at"] = "2025-06-30T15:59:59.999999Z"
    add("local-half-year-boundary", value, now)
    value = deepcopy(value); value["fixed_policy"]["state"]["last_proposed_at"] = value["fixed_policy"]["state"]["last_review_at"]
    add("new-period-cooldown-not-consumed", value, now)
    now = "2025-12-31T16:00:00.000Z"
    value = document(now); value["fixed_policy"]["parameters"]["rebalance"] = "first_decision_each_year"
    value["fixed_policy"]["state"]["last_review_at"] = "2025-12-31T15:59:59.999999Z"
    add("local-year-boundary", value, now)
    now = "2025-03-10T04:00:00.000Z"
    value = document(now); value["fixed_policy"]["evaluation_timezone"] = "America/New_York"
    value["fixed_policy"]["parameters"]["minimum_days_between_rebalances"] = 2
    value["fixed_policy"]["state"].update(last_review_at="2025-03-08T05:00:00.000Z", last_proposed_at="2025-03-08T05:00:00.000Z")
    value["quantities"].update({"CN:ALPHA": "45", "US:GAMMA": "25"})
    add("dst-local-days-not-48-hours", value, now)
    return result
