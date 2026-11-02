"""Invented first-close state for independent Node reads, never deployment data."""

import argparse
from pathlib import Path
import socket
import tempfile
from unittest.mock import patch

from tests.investor.test_initial_close import InitialCloseTests, EARLY, START, END, LATE
from worker.investor import initial_close
from worker.orchestration.db import canonical_json, open_database
from worker.orchestration.jobs import claim_job
from worker.orchestration.runtime import run_pending_once


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--db", required=True)
    parser.add_argument("--mode", choices=("discover", "claim", "expired", "complete", "partial", "empty", "late", "admit"), required=True)
    args = parser.parse_args(); path = Path(args.db).resolve(strict=True)
    assert path.name == "workbench.db" and path.parent.parent == Path(tempfile.gettempdir()).resolve()
    assert path.parent.name.startswith("etf-investor-synthetic-")
    def denied(*args, **kwargs): raise AssertionError("FICTIONAL_FIRST_CLOSE_NETWORK_FORBIDDEN")
    with patch.object(socket, "create_connection", denied), patch.object(socket, "getaddrinfo", denied):
        db = open_database(path); case = InitialCloseTests(); case.db = db; case.path = path; case.version = 0
        try:
            assert db.execute("SELECT count(*) FROM investor_workspaces").fetchone()[0] == 0
            case.assert_no_finance()
            db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-01-02T12:00:00.000Z')")
            case.prepare(); jobs = initial_close.discover_initial_closes(db, now=EARLY); assert len(jobs) == 1
            calls = 0; at = EARLY
            if args.mode in ("claim", "expired"):
                assert claim_job(db, "fictional-first-close-lease", 300, initial_close.JOB_TYPE, now=START)
                at = "2026-01-04T06:58:01.000Z"
                if args.mode == "expired":
                    at = "2026-01-04T07:03:00.000Z"
                    assert claim_job(db, "fictional-no-retry", 300, initial_close.JOB_TYPE, now=at) is None
            elif args.mode != "discover":
                result, calls, _ = case.watch(start=LATE if args.mode == "late" else START,
                    bars=1 if args.mode == "partial" else 0 if args.mode == "empty" else None)
                assert result is not None; at = END
                if args.mode == "admit": assert run_pending_once(db, "fictional-first-core", clock=lambda: END)["status"] == "succeeded"
            case.assert_no_finance()
            print(canonical_json({"checked_at": at, "stubbed_sdk_calls": calls, "real_provider_called": False, "real_gateway_called": False}))
        finally: case.doCleanups(); db.close()


if __name__ == "__main__": main()
