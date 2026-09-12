from datetime import datetime, timedelta, timezone

from worker.orchestration.db import content_hash, stamp


def dataset():
    sessions, observations = [], []
    for day in range(1, 14):
        at = datetime(2025, 1, day, 7, tzinfo=timezone.utc)
        available = at + timedelta(minutes=1)
        sessions.append({"market": "CN", "session_date": at.date().isoformat(), "close_at": stamp(at),
                         "available_at": stamp(available), "trade_allowed": True})
        observations.append({"id": "price:" + str(day), "batch_id": "research:fixture", "source_id": "synthetic",
                             "listing_id": "CN:TEST", "series_key": "CN:TEST", "metric": "close", "value": "10" if day == 1 else "20",
                             "unit": "CNY", "observed_at": stamp(at), "published_at": stamp(available),
                             "ingested_at": "2026-01-01T00:00:00Z", "source_timezone": "UTC", "time_precision": "second",
                             "price_basis": "unadjusted", "revision_id": "v1", "raw_hash": content_hash({"day": day}),
                             "parser_version": "fixture-v1", "provenance": "reconstructed"})
    return {"schema_version": "research-dataset-v1", "mode": "synthetic", "source_evidence": "Synthetic regression fixture",
            "license_scope": "Locally generated test data only", "historical_archive_verified": False,
            "corporate_actions_complete": True,
            "assets": [{"listing_id": "CN:TEST", "market": "CN", "currency": "CNY", "quantity_step": "1",
                        "tradable_from": "2024-01-01T00:00:00Z", "source_evidence": "Synthetic lifecycle"}],
            "sessions": sessions, "observations": observations, "actions": [], "publication_refs": []}


def parameters(fraction="1"):
    return {"weights": {"CN:TEST": "1"}, "deployment_fraction": fraction, "allocation": "repair_underweight"}


def plan():
    decisions = [session["available_at"] for session in dataset()["sessions"]]
    return {"schema_version": "research-plan-v1", "hypothesis": "New cash can repair target underweights without selling",
            "falsification": "Reject claimed improvement if costs or unmatched cashflows explain it", "evaluation_timezone": "UTC",
            "windows": {"train": {"start": "2025-01-02T00:00:00Z", "end": "2025-01-05T23:00:00Z"},
                        "validation": {"start": "2025-01-06T00:00:00Z", "end": "2025-01-09T23:00:00Z"},
                        "holdout": {"start": "2025-01-10T00:00:00Z", "end": "2025-01-13T23:00:00Z"}},
            "initial_capital_cny": "100", "contributions": [], "decision_times": decisions,
            "parameter_candidates": [parameters(), parameters("0.5")], "trial_budgets": {"train": 2, "validation": 2, "holdout": 1},
            "benchmark": {"weights": {"CN:TEST": "1"}, "deployment_fraction": "1", "allocation": "fixed_split"},
            "execution": {"model": "next_session_close_fixed_quantity", "commission_bps": "0", "minimum_fee_cny": "0",
                          "slippage_bps": "0", "fx_bps": "0", "cash_quantum": "0.01", "max_fx_age_seconds": 2592000,
                          "settlement_model": "prepaid_cash", "dividend_policy": "cash_in_original_currency"},
            "tax_coverage": "Synthetic examples; only supplied withholding actions are modeled",
            "evidence_requirements": {"status": "unapproved", "description": "No S-01 to S-10 admission is claimed"}}
