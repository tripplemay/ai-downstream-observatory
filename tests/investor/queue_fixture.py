"""Cross-language test helper, excluded from production images."""

import argparse
from pathlib import Path
import tempfile
from unittest.mock import patch
from contextlib import nullcontext

from tests.investor.fixtures import research_input
from worker.investor.runtime import prepare_research_job, register_synthetic_input, sync_research_requests
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, open_database
from worker.orchestration.jobs import run_one
from worker.orchestration.runtime import run_pending_once


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--mode", choices=("register", "compute", "core"), required=True)
    parser.add_argument("--now")
    parser.add_argument("--legacy-fixed-reference", action="store_true")
    parser.add_argument("--validation-execution-gap", action="store_true")
    parser.add_argument("--train-execution-gap", action="store_true")
    args = parser.parse_args()
    path = Path(args.db).resolve(strict=True)
    root = Path(tempfile.gettempdir()).resolve()
    if (path.parent.parent != root or not path.parent.name.startswith(("etf-investor-synthetic-", "etf-browser-fixture-"))
            or path.name != "workbench.db"):
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db = open_database(path)
    try:
        if db.execute("SELECT count(*) FROM portfolios").fetchone()[0] != 0:
            raise WorkbenchError("SYNTHETIC_EMPTY_FINANCIAL_DATABASE_REQUIRED")
        if args.mode == "register":
            workspaces = db.execute("SELECT id FROM investor_workspaces").fetchall()
            if len(workspaces) != 1: raise WorkbenchError("SYNTHETIC_SINGLE_WORKSPACE_REQUIRED")
            data, plan, policy = research_input()
            if args.validation_execution_gap or args.train_execution_gap:
                if args.validation_execution_gap and args.train_execution_gap:
                    raise WorkbenchError("SYNTHETIC_SINGLE_GAP_PHASE_REQUIRED")
                day = "2025-01-06" if args.train_execution_gap else "2025-03-02"
                for observation in data["observations"]:
                    if observation["listing_id"] == "CN:ALPHA" and observation["observed_at"].startswith(day):
                        marker = {"synthetic_train_execution_gap": True} if args.train_execution_gap else {"synthetic_validation_execution_gap": True}
                        observation.update(value="20", raw_hash=content_hash(marker))
            register_synthetic_input(db, workspaces[0]["id"], data, plan, policy, now=args.now or "2026-01-02T12:00:01.000Z")
        else:
            if args.validation_execution_gap or args.train_execution_gap: raise WorkbenchError("SYNTHETIC_GAP_REGISTRATION_ONLY")
            now = args.now or "2026-01-02T12:00:03.000Z"
            sync_research_requests(db, now=now)
            from worker.investor.reference_plan import render_reference_plan
            with patch("worker.investor.reference_plan.render_reference_plan", side_effect=lambda *a, **k: render_reference_plan(*a, version="investor-reference-plan-v1")) if args.legacy_fixed_reference else nullcontext():
                for _ in range(10):
                    if args.mode == "core":
                        result = run_pending_once(db, "synthetic-core", clock=lambda: now)
                    else:
                        result = run_one(db, "synthetic-test", lambda job, lease: prepare_research_job(db, job, lease,
                                         clock=lambda: now, allow_synthetic=True), job_type="investor_research", clock=lambda: now)
                    if result is None: break
        print(canonical_json({"status": "synthetic_fixture_complete"}))
    finally:
        db.close()


if __name__ == "__main__": main()
