"""Test-only lease execution; refuses non-temporary or financially populated DBs."""

import argparse
from pathlib import Path
import tempfile
from contextlib import nullcontext
from unittest.mock import patch

from worker.investor.funded_study_runtime import JOB_TYPE, sync_funded_study_requests
from worker.orchestration.db import WorkbenchError, canonical_json, open_database
from worker.orchestration.jobs import run_one
from worker.orchestration.runtime import command_handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--now", default="2026-01-02T12:00:05.000Z")
    parser.add_argument("--fail-first-candidate", action="store_true")
    parser.add_argument("--purge-due", action="store_true")
    parser.add_argument("--purge-first", action="store_true")
    parser.add_argument("--actor")
    parser.add_argument("--withdraw-first-source", action="store_true")
    args = parser.parse_args()
    path = Path(args.db).resolve(strict=True)
    if path.parent.parent != Path(tempfile.gettempdir()).resolve() or not path.parent.name.startswith(("etf-investor-synthetic-", "etf-browser-fixture-")) or path.name != "workbench.db":
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db = open_database(path)
    try:
        if db.execute("SELECT count(*) FROM portfolios").fetchone()[0]:
            raise WorkbenchError("SYNTHETIC_EMPTY_FINANCIAL_DATABASE_REQUIRED")
        if args.withdraw_first_source:
            from worker.investor.data_evidence import review_source
            row = db.execute("SELECT s.id,s.workspace_id,w.owner_id FROM investor_data_sources s JOIN investor_workspaces w ON w.id=s.workspace_id ORDER BY s.rowid LIMIT 1").fetchone()
            review_source(db, row["workspace_id"], row["owner_id"], row["id"], "withdrawn", None, "Fictional withdrawal only",
                          "2026-03-01T00:00:00.000Z", now=args.now)
            print(canonical_json({"status": "fictional_source_withdrawn", "real_provider_called": False}))
            return
        if args.purge_due or args.purge_first:
            from worker.investor.funded_result_retention import purge_due_funded_results, purge_funded_result
            if args.purge_first:
                row = db.execute("SELECT h.*,w.owner_id FROM investor_funded_result_headers h JOIN investor_workspaces w ON w.id=h.workspace_id ORDER BY h.parameters_hash LIMIT 1").fetchone()
                results = [purge_funded_result(db, row["workspace_id"], args.actor or row["owner_id"], row["run_id"], row["parameters_hash"], now=args.now)]
            else:
                results = purge_due_funded_results(db, now=args.now)
            print(canonical_json({"status": "fictional_retention_fixture_complete", "purge_count": len(results), "real_provider_called": False}))
            return
        sync_funded_study_requests(db, now=args.now)
        outcomes = []
        from worker.investor.funded_history import calculate_funded_history
        calls = 0
        def calculate(*a, **k):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise WorkbenchError("FUNDED_STUDY_CANDIDATE_FAILED")
            return calculate_funded_history(*a, **k)
        with patch("worker.investor.funded_study_runtime.calculate_funded_history", side_effect=calculate) if args.fail_first_candidate else nullcontext():
            for _ in range(10):
                result = run_one(db, "funded-study-fixture", command_handler(db, clock=lambda: args.now),
                                 job_type=JOB_TYPE, lease_seconds=300, clock=lambda: args.now)
                if result is None:
                    break
                outcomes.append(result["status"])
        print(canonical_json({"status": "fictional_funded_study_fixture_complete", "outcomes": outcomes, "real_provider_called": False}))
    finally:
        db.close()


if __name__ == "__main__":
    main()
