"""Timed fictional HTTP monitor replay; never accepts a deployment database."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
from time import perf_counter, process_time


@contextmanager
def phase(name):
    started, cpu = perf_counter(), process_time()
    print(json.dumps({"phase": name, "event": "start"}), file=sys.stderr, flush=True)
    try:
        yield
    finally:
        print(json.dumps({"phase": name, "event": "end", "elapsed_ms": round((perf_counter() - started) * 1000),
                          "cpu_ms": round((process_time() - cpu) * 1000)}), file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("db")
    parser.add_argument("model_id")
    parser.add_argument("mode", choices=("collect", "reuse"))
    args = parser.parse_args()
    path = Path(args.db).resolve(strict=True)
    assert path.parent.parent == Path(tempfile.gettempdir()).resolve()
    assert path.parent.name.startswith("etf-workbench-http-") and path.name == "workbench.db"
    with phase("imports"):
        from tests.investor.live_monitor_fixture import create
        from worker.investor.evidence_monitor_runtime import discover_evidence_monitor_requests
        from worker.orchestration.db import open_database
        from worker.orchestration.jobs import run_one
        from worker.orchestration.runtime import command_handler
    with phase("open"):
        db = open_database(path)
    try:
        now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        rows = db.execute("SELECT id,owner_id FROM investor_workspaces").fetchall()
        assert len(rows) == 1
        if args.mode == "collect":
            with phase("collect_admit"):
                create(db, rows[0]["id"], rows[0]["owner_id"], args.model_id, now, funding=True)
        with phase("discover"):
            discover_evidence_monitor_requests(db, now=now)
        with phase("execute_publish"):
            completed = run_one(db, "http-fixed-current-monitor", command_handler(db), job_type="investor_evidence_monitor")
        assert completed is not None and completed["status"] == "succeeded", completed["status"] if completed else "missing"
        print(json.dumps({"status": "fictional_fixed_monitor_published", "real_provider_called": False}))
    finally:
        db.close()


if __name__ == "__main__":
    main()
