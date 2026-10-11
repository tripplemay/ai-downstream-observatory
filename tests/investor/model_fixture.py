"""Isolated cross-language synthetic model adapter, never a production feed."""

import argparse
from datetime import timedelta
from pathlib import Path
import tempfile

from tests.investor.fixtures import monitor_input
from worker.investor.model_runtime import discover_monitor_requests, prepare_monitor_job, register_synthetic_snapshot
from worker.orchestration.db import WorkbenchError, canonical_json, instant, open_database
from worker.orchestration.jobs import run_one
from worker.orchestration.runtime import command_handler


def snapshot_for_model(definition, now, previous=None, scenario="normal"):
    def date(hours): return (instant(now) + timedelta(hours=hours)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    base = monitor_input()
    prices, quotes = {"CNY": "100", "HKD": "125", "USD": "20"}, []
    offsets = {"CN": -6, "HK": -5, "US": -3}
    coverage = {}
    for target in definition["targets"]:
        row = next(row.copy() for row in base["quotes"] if row["market"] == target["market"])
        row.update(listing_id=target["listing_id"], currency=target["currency"], close=prices[target["currency"]],
                   observed_at=date(offsets[target["market"]]), known_at=now, expected_close_at=date(offsets[target["market"]]), valid_until=date(1))
        quotes.append(row)
        coverage[target["market"]] = {"from": previous["market_cutoffs"][target["market"]] if previous else row["observed_at"], "to": row["observed_at"], "complete": True}
    currencies = {row["currency"] for row in definition["targets"]} - {"CNY"}
    fx = [{**row, "observed_at": date(-2), "known_at": now, "valid_until": date(1)} for row in base["fx"] if row["currency"] in currencies]
    if scenario == "stale": quotes[-1]["expected_close_at"] = date(-1)
    return {"schema_version": "investor-model-snapshot-v1", "model_id": definition["model_id"], "source_qualification": "synthetic_test_only",
            "quotes": quotes, "fx": fx, "corporate_action_coverage": coverage, "corporate_actions": [],
            "funding_intent": {"id": "synthetic-planned-only", "amount_cny": "2000", "expected_at": now} if scenario == "due" else None,
            "policy": base["policy"], "quality_gaps": []}


def main():
    import json
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--mode", choices=("register", "compute", "core"), required=True)
    parser.add_argument("--now", required=True)
    parser.add_argument("--scenario", choices=("normal", "stale", "due"), default="normal")
    args = parser.parse_args()
    path, root = Path(args.db).resolve(strict=True), Path(tempfile.gettempdir()).resolve()
    if path.parent.parent != root or not path.parent.name.startswith(("etf-investor-synthetic-", "etf-browser-fixture-")) or path.name != "workbench.db":
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db = open_database(path)
    try:
        if db.execute("SELECT count(*) FROM portfolios").fetchone()[0] != 0: raise WorkbenchError("SYNTHETIC_EMPTY_FINANCIAL_DATABASE_REQUIRED")
        models = db.execute("SELECT * FROM investor_models").fetchall()
        if len(models) != 1: raise WorkbenchError("SYNTHETIC_SINGLE_MODEL_REQUIRED")
        model = models[0]
        if args.mode == "register":
            previous = db.execute("SELECT document_json FROM investor_model_checkpoints WHERE model_id=? ORDER BY sequence DESC LIMIT 1", (model["id"],)).fetchone()
            snapshot = snapshot_for_model(json.loads(model["document_json"]), args.now, json.loads(previous["document_json"]) if previous else None, args.scenario)
            register_synthetic_snapshot(db, model["workspace_id"], model["id"], snapshot, now=args.now)
        else:
            discover_monitor_requests(db, now=args.now)
            for _ in range(10):
                handler = command_handler(db, clock=lambda: args.now, role="core") if args.mode == "core" else lambda job, lease: prepare_monitor_job(db, job, lease, clock=lambda: args.now, allow_synthetic=True)
                if run_one(db, "synthetic-model", handler, job_type="investor_monitor", clock=lambda: args.now) is None: break
        print(canonical_json({"status": "synthetic_model_fixture_complete"}))
    finally:
        db.close()


if __name__ == "__main__": main()
