"""Temporary browser fixture: invented facts and default core, never a provider."""

import argparse
from pathlib import Path
import re
import tempfile
from unittest.mock import patch

from tests.investor.evidence_fixture import create
from tests.investor.test_monitor_data import InvestorMonitorDataTests, NOW, EXPIRY
from worker.investor.data_evidence import collect_prices, review_source, store_source
from worker.investor.monitor_admission import admit_monitor_data, current_monitor_model
from worker.orchestration.db import WorkbenchError, canonical_json, open_database
from worker.orchestration.runtime import run_pending_once


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--mode", required=True, choices=("research", "monitor"))
    args = parser.parse_args()
    path = Path(args.db).resolve(strict=True)
    if (path.parent.parent != Path(tempfile.gettempdir()).resolve()
            or not re.fullmatch(r"etf-browser-fixture-[A-Za-z0-9]+", path.parent.name)
            or path.name != "workbench.db"):
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db = open_database(path)
    try:
        for table in ("portfolios", "accounts", "ledger_events", "postings", "position_movements",
                      "approval_events", "activations", "reservations", "execution_reports"):
            if db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]:
                raise WorkbenchError("SYNTHETIC_EMPTY_FINANCIAL_DATABASE_REQUIRED")
        rows = db.execute("SELECT id,owner_id FROM investor_workspaces").fetchall()
        if len(rows) != 1 or rows[0]["owner_id"] != "owner":
            raise WorkbenchError("SYNTHETIC_SINGLE_BROWSER_OWNER_REQUIRED")
        workspace, actor = rows[0]["id"], rows[0]["owner_id"]
        if args.mode == "research":
            if db.execute("SELECT count(*) FROM investor_data_sources").fetchone()[0]:
                raise WorkbenchError("SYNTHETIC_EMPTY_SOURCES_REQUIRED")
            create(db, workspace, actor, fixed_policy_v2=True)
            for _ in range(10):
                result = run_pending_once(db, "fictional-browser-core", clock=lambda: "2026-01-02T12:00:03.000Z")
                if result is None:
                    break
                if result["status"] not in ("succeeded", "skipped"):
                    raise WorkbenchError("SYNTHETIC_RESEARCH_NOT_COMPLETED")
        else:
            models = db.execute("SELECT * FROM investor_models").fetchall()
            if len(models) != 1 or db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0]:
                raise WorkbenchError("SYNTHETIC_SINGLE_FRESH_MODEL_REQUIRED")
            model = models[0]
            _, definition, _ = current_monitor_model(db, workspace, model["id"], NOW)
            fixture = InvestorMonitorDataTests(methodName="test_three_market_different_closes_actual_receipt_time_and_newer_fx")
            fixture.db, fixture.workspace_id = db, workspace

            def reviewed(kind, facts, label):
                source = store_source(db, workspace, actor, kind, {"title": "FICTIONAL " + label,
                    "reference": "synthetic://browser-notifications/" + label,
                    "excerpt": "Invented browser regression, not real market data or a licence"}, now=NOW)
                return review_source(db, workspace, actor, source["id"], "approved", facts,
                                     "Fictional browser regression only", EXPIRY, now=NOW)

            fixture.reviewed = reviewed

            def capture(connection, scope, _fixture_actor, *arguments, **keywords):
                return collect_prices(connection, scope, actor, *arguments, **keywords)

            with patch("tests.investor.test_monitor_data.collect_prices", side_effect=capture):
                _, windows, settings, _ = fixture.fixture(
                    tuple(row["market"] for row in definition["targets"]),
                    identities=[row["listing_id"] for row in definition["targets"]],
                    roles=definition["fixed_policy"]["parameters"]["roles"])
            admit_monitor_data(db, workspace, actor, model["id"], windows, settings, now=NOW)
            for at in (NOW, "2026-01-03T12:15:03.000Z"):
                result = run_pending_once(db, "fictional-browser-monitor", clock=lambda: at)
                if result is None or result["status"] != "succeeded":
                    raise WorkbenchError("SYNTHETIC_MONITOR_NOT_COMPLETED")
            if db.execute("SELECT count(*) FROM investor_evidence_monitor_runs").fetchone()[0] != 2:
                raise WorkbenchError("SYNTHETIC_TWO_PUBLICATIONS_REQUIRED")
        print(canonical_json({"status": "fictional_browser_core_complete", "mode": args.mode,
                              "real_provider_called": False, "trade_commands_executed": False}))
    finally:
        db.close()


if __name__ == "__main__":
    main()
