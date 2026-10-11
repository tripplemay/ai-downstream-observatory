"""Actual default roles on an owned test DB, invented past-day transport only."""

import argparse
from datetime import datetime
from decimal import Decimal
import json
from pathlib import Path
import tempfile
from unittest.mock import patch
from zoneinfo import ZoneInfo

from worker.investor import data_evidence
from worker.investor.monitor_data import resolve_monitor_data
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, canonical_json, instant, open_database
from worker.orchestration.runtime import run_pending_once
from worker.investor.initial_prices import discover_initial_prices, JOB_TYPE
from worker.orchestration.jobs import claim_job

NOW = "2026-01-03T12:00:03.000Z"


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--db", required=True)
    parser.add_argument("--mode", choices=("discover", "claim", "collect", "failed", "complete"), default="complete"); args = parser.parse_args()
    filename = Path(args.db).resolve(strict=True)
    if filename.name != "workbench.db" or filename.parent.parent != Path(tempfile.gettempdir()).resolve() or not filename.parent.name.startswith("etf-investor-synthetic-"):
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db = open_database(filename)
    try:
        models = db.execute("SELECT * FROM investor_models").fetchall()
        if len(models) != 1 or db.execute("SELECT 1 FROM investor_monitor_evidence_inputs").fetchone():
            raise WorkbenchError("SYNTHETIC_SINGLE_EMPTY_MODEL_REQUIRED")
        model = models[0]
        owner = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (model["workspace_id"],)).fetchone()
        if not owner or owner[0] != "synthetic-investor": raise WorkbenchError("SYNTHETIC_OWNER_REQUIRED")
        financial = ("portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports")
        if any(db.execute("SELECT count(*) FROM " + table).fetchone()[0] for table in financial):
            raise WorkbenchError("SYNTHETIC_EMPTY_FINANCIAL_DATABASE_REQUIRED")
        if args.mode in ("discover", "claim"):
            discover_initial_prices(db, now=NOW)
            if args.mode == "claim": claim_job(db, "fictional-acquisition-lease", job_type=JOB_TYPE, lease_seconds=300, now=NOW)
            print(canonical_json({"stubbed_sdk_calls": 0, "real_provider_called": False, "real_gateway_called": False})); return
        def collect(request):
            if args.mode == "failed": raise WorkbenchError("FICTIONAL_TRANSPORT_FAILURE")
            candles = [{"timestamp": datetime.fromisoformat(day).replace(tzinfo=ZoneInfo(longport._MARKETS[request["mapping"]["market"]][0])),
                "open": Decimal("10"), "high": Decimal("12"), "low": Decimal("9"), "close": Decimal("11.25"),
                "turnover": Decimal("11250"), "volume": 1000, "trade_session": 0} for day in request["expected_dates"]]
            return longport._normalize(candles, request=request, sdk_version=longport.SDK_VERSION, call_started_at=NOW, call_returned_at=NOW,
                datetime_basis="runtime_utc_from_unix_timestamp", collector_runtime="isolated_official_sdk")
        with patch.object(longport, "_collect_isolated", side_effect=collect) as sdk, \
                patch.object(data_evidence, "_milliseconds", side_effect=lambda value=None: NOW if value is None else value), \
                patch.object(data_evidence, "instant", side_effect=lambda value=None: instant(NOW if value is None else value)):
            for _ in json.loads(model["document_json"])["targets"]:
                job = run_pending_once(db, "fictional-initial-provider", role="longport", clock=lambda: NOW)
                if not job or job["status"] != ("failed" if args.mode == "failed" else "succeeded"): raise WorkbenchError("SYNTHETIC_INITIAL_COLLECTION_FAILED")
            calls = sdk.call_count
            if db.execute("SELECT 1 FROM investor_monitor_evidence_inputs").fetchone(): raise WorkbenchError("SYNTHETIC_EARLY_INPUT")
            if args.mode in ("collect", "failed"):
                print(canonical_json({"stubbed_sdk_calls": calls, "real_provider_called": False, "real_gateway_called": False})); return
            sdk.reset_mock()
            job = run_pending_once(db, "fictional-initial-core", clock=lambda: NOW)
            if not job or job["status"] != "succeeded" or sdk.call_count: raise WorkbenchError("SYNTHETIC_INITIAL_BOOTSTRAP_FAILED")
        source = db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE model_id=?", (model["id"],)).fetchone()
        if source is None: raise WorkbenchError("SYNTHETIC_INITIAL_INPUT_MISSING")
        document = json.loads(source["document_json"])
        replay = resolve_monitor_data(db, model["workspace_id"], json.loads(model["document_json"]), document, now=NOW)
        if replay["unavailable_reason"]: raise WorkbenchError("SYNTHETIC_INITIAL_INPUT_NOT_CURRENT")
        print(canonical_json({"document": document, "projection": replay["projection"], "registered_input_id": source["id"],
            "stubbed_sdk_calls": calls, "real_provider_called": False, "real_gateway_called": False}))
    finally: db.close()


if __name__ == "__main__": main()
