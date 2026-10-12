"""Registered callback activity on an owned fictional model; no external transport."""

import argparse
from contextlib import ExitStack
from pathlib import Path
import tempfile
from unittest.mock import patch

from tests.investor.confirmed_capture_fixture import FictionalReceiver
from worker.investor import confirmed_capture, confirmed_feed
from worker.market.providers import longport, longport_confirmed
from worker.orchestration.db import WorkbenchError, canonical_json, open_database
from worker.orchestration.jobs import claim_job
from worker.orchestration.runtime import run_pending_once

EARLY = "2026-01-04T06:55:00.000Z"
START = "2026-01-04T06:58:00.000Z"
END = "2026-01-04T07:01:02.000Z"
LATE = "2026-01-04T06:59:30.001Z"


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--db", required=True)
    parser.add_argument("--mode", choices=("discover", "claim", "complete", "partial", "empty", "late", "admit"), required=True); args = parser.parse_args()
    path = Path(args.db).resolve(strict=True)
    if path.name != "workbench.db" or path.parent.parent != Path(tempfile.gettempdir()).resolve() or not path.parent.name.startswith("etf-investor-synthetic-"):
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db = open_database(path)
    try:
        models = db.execute("SELECT m.* FROM investor_models m JOIN investor_workspaces w ON w.id=m.workspace_id WHERE w.owner_id='synthetic-investor'").fetchall()
        if len(models) != 1 or db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0] != 1:
            raise WorkbenchError("SYNTHETIC_SINGLE_SEEDED_MODEL_REQUIRED")
        for table in ("portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"):
            if db.execute("SELECT count(*) FROM " + table).fetchone()[0]: raise WorkbenchError("SYNTHETIC_EMPTY_FINANCIAL_DATABASE_REQUIRED")
        if not confirmed_feed.discover_confirmed_watches(db, now=EARLY): raise WorkbenchError("SYNTHETIC_NO_DISCOVERED_CALLBACK")
        calls = 0
        if args.mode == "claim":
            if not claim_job(db, "fictional-activity-lease", job_type=confirmed_feed.JOB_TYPE, lease_seconds=300, now=START): raise WorkbenchError("SYNTHETIC_NO_LEASE")
        elif args.mode != "discover":
            at = [LATE if args.mode == "late" else START]
            def advance(): at[0] = END
            mock = FictionalReceiver(now=at[0], received_at=END, bars=1 if args.mode == "partial" else 0 if args.mode == "empty" else None, during=advance)
            millis, parse = confirmed_capture._milliseconds, confirmed_capture.instant
            with ExitStack() as stack:
                stack.enter_context(patch.object(longport_confirmed, "collect_confirmed_days", side_effect=lambda request, **kwargs: mock(request, kwargs["stop_requested"])))
                stack.enter_context(patch.object(confirmed_capture, "_milliseconds", side_effect=lambda value=None: millis(at[0] if value is None else value)))
                stack.enter_context(patch.object(confirmed_capture, "instant", side_effect=lambda value=None: parse(at[0] if value is None else value)))
                stack.enter_context(patch.object(longport, "_collect_isolated", side_effect=AssertionError("NO_HISTORY_FALLBACK")))
                if run_pending_once(db, "fictional-activity-listener", role="longport", clock=lambda: at[0]) is None: raise WorkbenchError("SYNTHETIC_NO_JOB")
                if args.mode == "admit":
                    if run_pending_once(db, "fictional-activity-core", clock=lambda: at[0]) is None: raise WorkbenchError("SYNTHETIC_NO_CORE_JOB")
            calls = mock.calls
        print(canonical_json({"stubbed_sdk_calls": calls, "real_provider_called": False, "real_gateway_called": False}))
    finally: db.close()


if __name__ == "__main__": main()
