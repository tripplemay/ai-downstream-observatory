"""Generic fictional capital and weekday calendars, not a personal plan or market evidence."""

from datetime import datetime, timedelta, timezone
from decimal import Decimal

from worker.orchestration.db import content_hash, stamp


def long_case(days=3300):
    if days < 30:
        raise ValueError("at least 30 synthetic sessions required")
    dates = []
    current = datetime(2010, 1, 4, tzinfo=timezone.utc)
    while len(dates) < days:
        if current.weekday() < 5:
            dates.append(current)
        current += timedelta(days=1)
    assets = [
        {"listing_id": "CN:EQUITY", "market": "CN", "currency": "CNY", "quantity_step": "100"},
        {"listing_id": "CN:BOND", "market": "CN", "currency": "CNY", "quantity_step": "100"},
        {"listing_id": "HK:EQUITY", "market": "HK", "currency": "HKD", "quantity_step": "100"},
        {"listing_id": "US:EQUITY", "market": "US", "currency": "USD", "quantity_step": "1"},
    ]
    for asset in assets:
        asset.update(tradable_from="2009-01-01T00:00:00Z", source_evidence="Synthetic asset lifecycle")
    sessions, observations, decisions = [], [], []
    previous_month = None
    for index, day in enumerate(dates):
        for market, hour in (("CN", 7), ("HK", 8), ("US", 21)):
            close = day.replace(hour=hour)
            sessions.append({"market": market, "session_date": day.date().isoformat(), "close_at": stamp(close),
                             "available_at": stamp(close + timedelta(minutes=1)), "trade_allowed": True})
        for asset_index, asset in enumerate(assets):
            hour = {"CN": 7, "HK": 8, "US": 21}[asset["market"]]
            close = day.replace(hour=hour)
            base = (Decimal("10"), Decimal("100"), Decimal("20"), Decimal("100"))[asset_index]
            growth = (Decimal("0.001"), Decimal("0.0002"), Decimal("0.002"), Decimal("0.003"))[asset_index]
            value = base + growth * index + Decimal(index % 17) / 1000
            observations.append({"id": "price:" + asset["listing_id"] + ":" + str(index), "batch_id": "synthetic:long",
                                 "source_id": "synthetic", "listing_id": asset["listing_id"], "series_key": asset["listing_id"],
                                 "metric": "close", "value": format(value, "f"), "unit": asset["currency"],
                                 "observed_at": stamp(close), "published_at": stamp(close + timedelta(minutes=1)),
                                 "ingested_at": "2026-01-01T00:00:00Z", "source_timezone": "UTC", "time_precision": "second",
                                 "price_basis": "unadjusted", "revision_id": "fixture-v1", "raw_hash": content_hash([asset_index, index]),
                                 "parser_version": "synthetic-long-v1", "provenance": "reconstructed"})
        for currency, base, step in (("USD", "6.8", "0.001"), ("HKD", "0.82", "0.0001")):
            rate = Decimal(base) + Decimal(step) * (index % 23)
            observations.append({"id": "fx:" + currency + ":" + str(index), "batch_id": "synthetic:long", "source_id": "synthetic",
                                 "series_key": "FX:" + currency, "metric": "fx_cny_per_unit", "value": format(rate, "f"),
                                 "unit": "CNY_per_unit_currency", "observed_at": stamp(day), "published_at": stamp(day),
                                 "ingested_at": "2026-01-01T00:00:00Z", "source_timezone": "UTC", "time_precision": "second",
                                 "price_basis": "not_applicable", "revision_id": "fixture-v1", "raw_hash": content_hash([currency, index]),
                                 "parser_version": "synthetic-long-v1", "provenance": "reconstructed"})
        if (day.year, day.month) != previous_month:
            decisions.append(stamp(day.replace(hour=22)))
            previous_month = (day.year, day.month)
    training_days = days - max(10, days // 22) * 2
    validation_days = (days - training_days) // 2
    windows = {}
    for name, begin, end in (("train", 0, training_days - 1),
                             ("validation", training_days, training_days + validation_days - 1),
                             ("holdout", training_days + validation_days, days - 1)):
        windows[name] = {"start": stamp(dates[begin]), "end": stamp(dates[end].replace(hour=23))}
    parameters = {"weights": {"CN:EQUITY": "0.3", "CN:BOND": "0.3", "HK:EQUITY": "0.2", "US:EQUITY": "0.2"},
                  "deployment_fraction": "1", "allocation": "repair_underweight"}
    plan = {"schema_version": "research-plan-v1", "hypothesis": "Synthetic long-window performance and accounting regression",
            "falsification": "Any changed result or PIT boundary invalidates the index optimization", "evaluation_timezone": "Asia/Shanghai",
            "windows": windows, "initial_capital_cny": "240000",
            "contributions": [{"at": stamp(datetime(year, 1, 1, tzinfo=timezone.utc)), "amount_cny": "36000"}
                              for year in range(dates[0].year + 1, dates[-1].year + 1)],
            "decision_times": decisions, "parameter_candidates": [parameters],
            "trial_budgets": {"train": 1, "validation": 1, "holdout": 1},
            "benchmark": {**parameters, "allocation": "fixed_split"},
            "execution": {"model": "next_session_close_fixed_quantity", "commission_bps": "2", "minimum_fee_cny": "3",
                          "slippage_bps": "8", "fx_bps": "10", "cash_quantum": "0.01", "max_fx_age_seconds": 604800,
                          "settlement_model": "prepaid_cash", "dividend_policy": "cash_in_original_currency"},
            "tax_coverage": "Synthetic no-dividend assets; not a real tax model",
            "evidence_requirements": {"status": "unapproved", "description": "Synthetic complexity regression; not S gate evidence"}}
    dataset = {"schema_version": "research-dataset-v1", "mode": "synthetic", "source_evidence": "Generated weekday-only calendars and prices, not actual exchanges",
               "license_scope": "Synthetic local tests", "historical_archive_verified": False, "corporate_actions_complete": True,
               "assets": assets, "sessions": sessions, "observations": observations, "actions": [], "publication_refs": []}
    return dataset, plan, parameters
