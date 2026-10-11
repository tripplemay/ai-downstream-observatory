"""Fictional rule parameters, never a user portfolio or recommendation."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone

from tests.research.rotation_fixtures import dataset, fixed, plan
from worker.orchestration.db import content_hash, stamp


def policy_parameters(weights=None, schedule="first_decision_each_half_year"):
    result = fixed(weights)
    result.update(schema_version="research-fixed-rebalance-parameters-v2", rebalance=schedule,
        roles={listing: "growth" if listing == "CN:ALPHA" else "defensive" for listing in result["weights"]},
        class_drift_threshold="0.05", minimum_days_between_rebalances=30,
        contribution_mode="repair_underweight_without_sales", order_expiry="next_month_boundary")
    return result


def two_year_case():
    data, research_plan = dataset(), plan()
    session, settlement = deepcopy(data["sessions"][0]), deepcopy(data["settlements"][0])
    observations = deepcopy(data["observations"][:2])
    data.update(sessions=[], settlements=[], observations=[])
    at = datetime(2025, 1, 1, 7, tzinfo=timezone.utc)
    while at.year <= 2026:
        available = stamp(at + timedelta(minutes=1))
        data["sessions"].append({**session, "session_date": at.date().isoformat(), "close_at": stamp(at), "available_at": available})
        data["settlements"].append({**settlement, "session_date": at.date().isoformat(), "settled_at": stamp(at + timedelta(days=1, hours=2))})
        for row in observations:
            data["observations"].append({**row, "id": row["listing_id"] + ":" + at.date().isoformat(), "value": "10",
                "observed_at": stamp(at), "published_at": available, "ingested_at": available,
                "raw_hash": content_hash({"synthetic": True, "at": stamp(at), "listing": row["listing_id"]})})
        at += timedelta(days=1)
    research_plan["windows"]["train"] = {"start": "2025-01-05T00:00:00Z", "end": "2026-12-30T23:00:00Z"}
    research_plan["decision_times"] = [row["available_at"] for row in data["sessions"]]
    return data, research_plan
