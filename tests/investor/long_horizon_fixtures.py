"""Fictional calendars and capital, never a personal investment projection."""

from copy import deepcopy
from datetime import timedelta
from tests.research.fixed_policy_fixtures import policy_parameters
from tests.research.rotation_fixtures import dataset, plan
from worker.orchestration.db import content_hash, instant, stamp


def long_input(days=100, start="2025-01-01T00:00:00Z"):
    data, old_plan = dataset(), plan()
    first = instant(start)
    session, settlement = deepcopy(data["sessions"][0]), deepcopy(data["settlements"][0])
    prices = deepcopy(data["observations"][:2])
    data.update(sessions=[], settlements=[], observations=[])
    for asset in data["assets"]:
        asset["tradable_from"] = stamp(first - timedelta(days=365))
    at = first.replace(hour=7)
    for _ in range(days):
        available = stamp(at + timedelta(minutes=1))
        data["sessions"].append({**session, "session_date": at.date().isoformat(), "close_at": stamp(at), "available_at": available})
        data["settlements"].append({**settlement, "session_date": at.date().isoformat(),
            "published_at": stamp(first - timedelta(days=1)), "settled_at": stamp(at + timedelta(days=1, hours=2))})
        for row in prices:
            data["observations"].append({**row, "id": row["listing_id"] + ":" + at.date().isoformat(), "value": "10",
                "observed_at": stamp(at), "published_at": available, "ingested_at": available,
                "raw_hash": content_hash({"synthetic": True, "at": stamp(at), "listing": row["listing_id"]})})
        at += timedelta(days=1)
    end = first + timedelta(days=days - 1, hours=15)
    continuous = {"schema_version": "investor-long-horizon-plan-v1", "window": {"start": stamp(first), "end": stamp(end)},
        "evaluation_timezone": "Asia/Shanghai", "parameters_frozen_at": stamp(first - timedelta(days=1)),
        "parameters": policy_parameters(), "initial_capital_cny": "1200", "contributions": [],
        "decision_times": [row["available_at"] for row in data["sessions"]],
        "funding_policy": {"method": "equal_tranches_on_frozen_local_day_offsets", "initial_offsets_days": [0], "contribution_offsets_days": [0, 30, 60]},
        "execution": old_plan["execution"], "tax_coverage": "Synthetic costs; only supplied dividend withholding is modeled"}
    return {"schema_version": "investor-long-horizon-input-v1", "dataset": data, "plan": continuous}


def foreign_input():
    document = long_input()
    data = document["dataset"]
    data["assets"][0]["currency"] = "USD"
    for row in data["observations"]:
        if row["listing_id"] == "CN:ALPHA":
            row["unit"] = "USD"
    template = deepcopy(data["observations"][0])
    template.pop("listing_id")
    for session in data["sessions"]:
        observed = instant(session["close_at"]) - timedelta(hours=1)
        data["observations"].append({**template, "id": "fx:" + session["session_date"], "series_key": "FX:USD",
            "metric": "fx_cny_per_unit", "value": "2", "unit": "CNY_per_unit_currency", "price_basis": "not_applicable",
            "observed_at": stamp(observed), "published_at": stamp(observed), "ingested_at": stamp(observed)})
    return document
