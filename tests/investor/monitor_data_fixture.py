"""Bounded cross-language fixture with invented sources and stub SDK only."""

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
from unittest.mock import patch

from tests.investor.test_monitor_data import InvestorMonitorDataTests, NOW
from worker.investor.monitor_data import build_monitor_data
from worker.investor.monitor_admission import admit_monitor_data, current_monitor_model
from worker.orchestration.db import WorkbenchError, canonical_json, open_database


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--stale", action="store_true")
    parser.add_argument("--admit", action="store_true")
    parser.add_argument("--monitor", action="store_true")
    parser.add_argument("--queue", action="store_true")
    parser.add_argument("--funding", action="store_true")
    parser.add_argument("--later", action="store_true")
    parser.add_argument("--legacy-monitor", action="store_true")
    parser.add_argument("--notification-series", type=int, default=0, help="Invented changed-input publications for inbox capacity tests only")
    parser.add_argument("--external-ai", action="store_true", help="Invented regression grant, no real AI call")
    parser.add_argument("--extra-closed-day", action="store_true", help="Invented calendar coverage for a funding-boundary regression only")
    args = parser.parse_args()
    if not 0 <= args.notification_series <= 30 or args.notification_series and not (args.admit and args.monitor and args.later):
        raise WorkbenchError("SYNTHETIC_NOTIFICATION_SERIES_INVALID")
    path = Path(args.db).resolve(strict=True)
    if path.parent.parent != Path(tempfile.gettempdir()).resolve() or not path.parent.name.startswith("etf-investor-synthetic-") or path.name != "workbench.db":
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db = open_database(path)
    try:
        if db.execute("SELECT count(*) FROM portfolios").fetchone()[0]:
            raise WorkbenchError("SYNTHETIC_EMPTY_FINANCIAL_DATABASE_REQUIRED")
        fixture = InvestorMonitorDataTests(methodName="test_three_market_different_closes_actual_receipt_time_and_newer_fx")
        fixture.db = db
        if args.admit:
            models = db.execute("SELECT * FROM investor_models").fetchall()
            if len(models) != 1: raise WorkbenchError("SYNTHETIC_SINGLE_MODEL_REQUIRED")
            model = models[0]; fixture.workspace_id = model["workspace_id"]
            _, definition, _ = current_monitor_model(db, model["workspace_id"], model["id"], NOW)
            _, windows, settings, refs = fixture.fixture(tuple(row["market"] for row in definition["targets"]), identities=[row["listing_id"] for row in definition["targets"]],
                roles=definition["fixed_policy"]["parameters"]["roles"] if definition["schema_version"] == "investor-model-definition-v2" else None, external_ai=args.external_ai, extra_closed_day=args.extra_closed_day)
            if args.funding:
                settings["funding_intent"] = {"id": "fictional-funding", "amount_cny": "1000", "expected_at": NOW}
            registered = admit_monitor_data(db, model["workspace_id"], "synthetic-investor", model["id"], windows, settings, now=NOW)
            duplicate = admit_monitor_data(db, model["workspace_id"], "synthetic-investor", model["id"], windows, settings, now="2026-01-03T12:00:04.000Z")
            if registered["id"] != duplicate["id"]: raise WorkbenchError("SYNTHETIC_ADMISSION_NOT_IDEMPOTENT")
        else:
            if db.execute("SELECT count(*) FROM investor_workspaces").fetchone()[0]: raise WorkbenchError("SYNTHETIC_EMPTY_WORKSPACE_REQUIRED")
            db.execute("INSERT INTO investor_workspaces(id,owner_id,revision,created_at) VALUES('w','synthetic-investor',0,'2026-01-02T12:00:03.000Z')")
            definition, windows, settings, refs = fixture.fixture(events=True)
            registered = None
        if args.stale: settings["max_quote_age_seconds"] = 1
        result = build_monitor_data(db, fixture.workspace_id, definition, windows, settings, now=NOW)
        if args.queue:
            if not args.admit: raise WorkbenchError("SYNTHETIC_ADMITTED_MODEL_REQUIRED")
            from worker.investor.evidence_monitor_runtime import discover_evidence_monitor_requests
            discover_evidence_monitor_requests(db, now=NOW)
        if args.monitor:
            if not args.admit: raise WorkbenchError("SYNTHETIC_ADMITTED_MODEL_REQUIRED")
            from worker.orchestration.runtime import run_pending_once
            with patch("worker.investor.evidence_monitor_runtime.ENGINE_VERSION", "investor-evidence-model-watcher-v1") if args.legacy_monitor else patch.dict({}, {}):
                completed = run_pending_once(db, "fictional-qualified-monitor", clock=lambda: NOW)
                if completed["status"] != "succeeded": raise WorkbenchError("SYNTHETIC_MONITOR_NOT_COMPLETED")
                if args.later:
                    completed = run_pending_once(db, "fictional-qualified-monitor", clock=lambda: "2026-01-03T12:15:03.000Z")
                    if completed["status"] != "succeeded": raise WorkbenchError("SYNTHETIC_MONITOR_NOT_COMPLETED")
                for index in range(args.notification_series):
                    at = (datetime(2026, 1, 3, 12, 15, 4, tzinfo=timezone.utc) + timedelta(seconds=index)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                    settings["funding_intent"] = {"id": "fictional-notification-funding-" + str(index), "amount_cny": "1000", "expected_at": at}
                    admit_monitor_data(db, model["workspace_id"], "synthetic-investor", model["id"], windows, settings, now=at)
                    completed = run_pending_once(db, "fictional-notification-capacity", clock=lambda: at)
                    if completed["status"] != "succeeded": raise WorkbenchError("SYNTHETIC_MONITOR_NOT_COMPLETED")
            if args.legacy_monitor:
                at = "2026-01-03T12:15:03.000Z" if args.later else NOW
                completed = run_pending_once(db, "fictional-sparse-monitor", clock=lambda: at)
                if completed["status"] != "succeeded": raise WorkbenchError("SYNTHETIC_MONITOR_NOT_COMPLETED")
        targets = [{**target, "symbol": result["catalog"][target["listing_id"]]["provider_symbol"]} for target in definition["targets"]]
        print(canonical_json({"definition": definition, "reference_targets": targets, "document": result["document"],
            "projection": result["projection"], "real_provider_called": False, "rights_review_id": refs[0]["rights"]["id"],
            "registered_input_id": registered["id"] if registered else None}))
    finally:
        db.close()


if __name__ == "__main__": main()
