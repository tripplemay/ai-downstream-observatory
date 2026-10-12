"""Owned temporary DB, invented current-session callbacks; no live SDK or AI."""

import argparse
from copy import deepcopy
from datetime import timedelta
import json
from pathlib import Path
import tempfile
from unittest.mock import patch

from tests.investor import test_monitor_data as fixtures
from tests.investor.confirmed_capture_fixture import FictionalReceiver
from worker.investor import confirmed_capture
from worker.market.providers import longport_confirmed
from worker.investor.monitor_admission import admit_monitor_data, current_monitor_model
from worker.investor.monitor_data import build_monitor_data, resolve_monitor_data
from worker.orchestration.db import WorkbenchError, canonical_json, open_database, instant, stamp
from worker.orchestration.runtime import run_pending_once

NOW = "2026-01-02T12:05:03.000Z"


def create(db, *, definition=None, workspace="w", external_ai=False, events=True, next_calendar=False):
    fixture = fixtures.InvestorMonitorDataTests(methodName="test_three_market_different_closes_actual_receipt_time_and_newer_fx")
    fixture.db, fixture.workspace_id = db, workspace
    original = fixtures.InvestorMonitorDataTests.reviewed
    def extended(self, kind, facts, label):
        facts = deepcopy(facts)
        if next_calendar and kind in ("calendar", "actions"):
            facts["range_end"] = "2026-01-04"
            if kind == "calendar":
                close = instant("2026-01-04T" + {"CN": "07", "HK": "08", "US": "21"}[facts["market"]] + ":00:00.000Z")
                facts["days"].append({"date": "2026-01-04", "kind": "full", "close_at": stamp(close), "available_at": stamp(close + timedelta(minutes=1)),
                    "settled_at": stamp(close + timedelta(days=1)), "settlement_rule_known_at": "2025-12-01T00:00:00Z"})
        return original(self, kind, facts, label)
    with patch.object(fixtures, "NOW", NOW), patch.object(fixtures.InvestorMonitorDataTests, "reviewed", extended):
        generated, windows, settings, refs = fixture.fixture(tuple(row["market"] for row in definition["targets"]) if definition else ("CN", "HK", "US"),
            identities=[row["listing_id"] for row in definition["targets"]] if definition else None,
            roles=definition["fixed_policy"]["parameters"]["roles"] if definition and definition["schema_version"] == "investor-model-definition-v2" else None,
            external_ai=external_ai, confirmed_latest=True, events=events)
    return definition or generated, windows, settings, refs


def group_confirmed(db, workspace, windows, refs, *, deny_second_ai=False):
    selected = [row for row in refs if row["confirmed_capture"]]
    if deny_second_ai:
        if len(selected) < 2: raise WorkbenchError("SYNTHETIC_TWO_CONFIRMED_TARGETS_REQUIRED")
        fixture = fixtures.InvestorMonitorDataTests(); fixture.db, fixture.workspace_id = db, workspace
        facts = json.loads(selected[1]["rights"]["document_json"])["facts"]
        facts["uses"] = [use for use in facts["uses"] if use != "external_ai"]
        with patch.object(fixtures, "NOW", NOW):
            selected[1]["rights"] = fixture.reviewed("rights", facts, "confirmed-second-no-ai")
    for window in windows:
        if "confirmed_capture_ids" not in window: continue
        targets = [row for row in selected if row["confirmed_capture"]["id"] in window["confirmed_capture_ids"]]
        specs = [{**{kind + "_review_id": row[kind]["id"] for kind in ("rights", "listing", "calendar")}, "session_date": "2026-01-02"} for row in targets]
        mock = FictionalReceiver(now=NOW)
        millis, parse_time = confirmed_capture._milliseconds, confirmed_capture.instant
        with patch.object(longport_confirmed, "collect_confirmed_days", side_effect=lambda request, **kwargs: mock(request, kwargs["stop_requested"])), \
                patch.object(confirmed_capture, "_milliseconds", side_effect=lambda value=None: millis(NOW if value is None else value)), \
                patch.object(confirmed_capture, "instant", side_effect=lambda value=None: parse_time(NOW if value is None else value)):
            grouped = confirmed_capture.collect_confirmed_prices(db, workspace, "synthetic-investor", specs, watch_seconds=1)
        window["confirmed_capture_ids"] = [grouped["id"]]
        for row in targets: row["confirmed_capture"] = grouped


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--db", required=True); parser.add_argument("--admit", action="store_true")
    parser.add_argument("--monitor", action="store_true"); parser.add_argument("--funding", action="store_true")
    parser.add_argument("--external-ai", action="store_true"); parser.add_argument("--grouped", action="store_true")
    parser.add_argument("--bootstrap", action="store_true")
    parser.add_argument("--next-calendar", action="store_true")
    parser.add_argument("--deny-second-confirmed-ai", action="store_true"); args = parser.parse_args()
    if args.deny_second_confirmed_ai and not (args.grouped and args.external_ai): raise WorkbenchError("SYNTHETIC_GROUPED_AI_REQUIRED")
    if args.bootstrap and (not args.admit or not args.monitor or args.funding): raise WorkbenchError("SYNTHETIC_BOOTSTRAP_MODEL_REQUIRED")
    filename = Path(args.db).resolve(strict=True)
    if filename.name != "workbench.db" or filename.parent.parent != Path(tempfile.gettempdir()).resolve() or not filename.parent.name.startswith("etf-investor-synthetic-"):
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db = open_database(filename)
    try:
        if db.execute("SELECT count(*) FROM portfolios").fetchone()[0]: raise WorkbenchError("SYNTHETIC_EMPTY_FINANCIAL_DATABASE_REQUIRED")
        if args.admit:
            models = db.execute("SELECT * FROM investor_models").fetchall()
            if len(models) != 1: raise WorkbenchError("SYNTHETIC_SINGLE_MODEL_REQUIRED")
            model = models[0]; workspace = model["workspace_id"]
            _, definition, _ = current_monitor_model(db, workspace, model["id"], NOW)
        else:
            if db.execute("SELECT count(*) FROM investor_workspaces").fetchone()[0]: raise WorkbenchError("SYNTHETIC_EMPTY_WORKSPACE_REQUIRED")
            workspace, definition = "w", None
            db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,?)", (NOW,))
        definition, windows, settings, refs = create(db, definition=definition, workspace=workspace, external_ai=args.external_ai, next_calendar=args.next_calendar)
        if args.grouped: group_confirmed(db, workspace, windows, refs, deny_second_ai=args.deny_second_confirmed_ai)
        if args.funding: settings["funding_intent"] = {"id": "fictional-confirmed-funding", "amount_cny": "1000", "expected_at": NOW}
        if args.bootstrap:
            if db.execute("SELECT 1 FROM investor_monitor_evidence_inputs").fetchone(): raise WorkbenchError("SYNTHETIC_BOOTSTRAP_EMPTY_INPUT_REQUIRED")
            completed = run_pending_once(db, "fictional-bootstrap-core", clock=lambda: NOW)
            admitted = db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE model_id=?", (definition["model_id"],)).fetchone()
            if not admitted or not completed or completed["status"] != "succeeded": raise WorkbenchError("SYNTHETIC_BOOTSTRAP_NOT_COMPLETED")
            document = json.loads(admitted["document_json"])
            replay = resolve_monitor_data(db, workspace, definition, document, now=NOW)
            if replay["unavailable_reason"]: raise WorkbenchError("SYNTHETIC_BOOTSTRAP_NOT_CURRENT")
            result = {"document": document, "projection": replay["projection"],
                "catalog": {json.loads(row["listing"]["document_json"])["facts"]["listing_id"]: json.loads(row["listing"]["document_json"])["facts"] for row in refs}}
        else:
            result = build_monitor_data(db, workspace, definition, windows, settings, now=NOW)
            admitted = admit_monitor_data(db, workspace, "synthetic-investor", definition["model_id"], windows, settings, now=NOW) if args.admit else None
        if args.monitor and not args.bootstrap:
            if not admitted: raise WorkbenchError("SYNTHETIC_ADMITTED_MODEL_REQUIRED")
            completed = run_pending_once(db, "fictional-confirmed-core", clock=lambda: NOW)
            if completed["status"] != "succeeded": raise WorkbenchError("SYNTHETIC_MONITOR_NOT_COMPLETED")
        print(canonical_json({"definition": definition, "reference_targets": [{**target, "symbol": result["catalog"][target["listing_id"]]["provider_symbol"]} for target in definition["targets"]],
            "document": result["document"], "projection": result["projection"], "registered_input_id": admitted["id"] if admitted else None,
            "confirmed_capture_ids": [row["confirmed_capture"]["id"] for row in refs if row["confirmed_capture"]],
            "rights_review_id": refs[0]["rights"]["id"], "real_provider_called": False, "real_gateway_called": False}))
    finally:
        db.close()


if __name__ == "__main__": main()
