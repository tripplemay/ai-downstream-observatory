"""Small, generic synthetic fixtures, not a personal investment plan."""

from datetime import datetime, timedelta, timezone
from decimal import Decimal

from worker.accounting import canonical
from worker.orchestration.db import content_hash, stamp
from tests.research.fixtures import plan as old_plan


def parameters():
    return {"schema_version": "research-rotation-parameters-v1", "universe": ["CN:ALPHA", "CN:BETA"],
            "momentum_sessions": 2, "moving_average_sessions": 3, "top_n": 1, "target_fraction": "1",
            "signal_basis": "gross_total_return_index", "ranking_currency": "listing_currency",
            "weighting": "equal_top_n_slots", "eligibility": "strictly_above_moving_average",
            "momentum_floor": None, "rebalance": "first_decision_each_month", "tie_break": "listing_id_ascending",
            "insufficient_history": "ineligible", "missing_data": "block", "tolerance": {"absolute_cny": "0", "weight": "0"}}


def fixed(weights=None):
    return {"schema_version": "research-fixed-rebalance-parameters-v1", "weights": weights or {"CN:ALPHA": "0.5", "CN:BETA": "0.5"},
            "rebalance": "first_decision_each_month", "tolerance": {"absolute_cny": "0", "weight": "0"}}


def dataset():
    sessions, settlements, observations = [], [], []
    at = datetime(2025, 1, 1, 7, tzinfo=timezone.utc)
    while at <= datetime(2025, 6, 10, 7, tzinfo=timezone.utc):
        available = at + timedelta(minutes=1)
        sessions.append({"market": "CN", "session_date": at.date().isoformat(), "close_at": stamp(at),
                         "available_at": stamp(available), "trade_allowed": True})
        settlements.append({"market": "CN", "session_date": at.date().isoformat(),
                            "settled_at": stamp(at + timedelta(days=1, hours=2)),
                            "published_at": "2024-12-01T00:00:00Z", "source_evidence": "Synthetic explicit settlement calendar"})
        for listing in ("CN:ALPHA", "CN:BETA"):
            increasing = (listing == "CN:ALPHA") == (at.month % 2 == 1)
            value = Decimal("10") + Decimal(at.day) / 100 if increasing else Decimal("10")
            observations.append({"id": listing + ":" + at.date().isoformat(), "batch_id": "rotation:fixture", "source_id": "synthetic",
                                 "listing_id": listing, "series_key": listing, "metric": "close", "value": canonical(value),
                                 "unit": "CNY", "observed_at": stamp(at), "published_at": stamp(available), "ingested_at": stamp(available),
                                 "source_timezone": "UTC", "time_precision": "second", "price_basis": "unadjusted", "revision_id": "v1",
                                 "raw_hash": content_hash({"listing_id": listing, "at": stamp(at), "synthetic": True}),
                                 "parser_version": "rotation-fixture-v1", "provenance": "reconstructed"})
        at += timedelta(days=1)
    return {"schema_version": "research-dataset-v2", "mode": "synthetic", "source_evidence": "Generic synthetic rotation regression",
            "license_scope": "Locally generated test data only", "historical_archive_verified": False,
            "corporate_actions_complete": True, "publication_refs": [], "actions": [],
            "assets": [{"listing_id": listing, "market": "CN", "currency": "CNY", "quantity_step": "1",
                        "tradable_from": "2024-01-01T00:00:00Z", "source_evidence": "Synthetic lifecycle"}
                       for listing in ("CN:ALPHA", "CN:BETA")],
            "sessions": sessions, "settlements": settlements, "observations": observations}


def plan():
    result = old_plan()
    result.update(schema_version="research-plan-v2", hypothesis="Synthetic monthly rotation with explicit delayed settlement",
                  falsification="Reject performance that depends on same-close selection or unreceived sale proceeds",
                  initial_capital_cny="1200", contributions=[], parameter_candidates=[parameters()], benchmark=fixed())
    result["windows"] = {"train": {"start": "2025-01-05T00:00:00Z", "end": "2025-02-06T23:00:00Z"},
                         "validation": {"start": "2025-03-01T00:00:00Z", "end": "2025-04-06T23:00:00Z"},
                         "holdout": {"start": "2025-05-01T00:00:00Z", "end": "2025-06-06T23:00:00Z"}}
    result["decision_times"] = [row["available_at"] for row in dataset()["sessions"]]
    result["execution"].update(settlement_model="explicit_market_calendar", sale_proceeds="convert_to_cny_at_fill_then_settle")
    return result
