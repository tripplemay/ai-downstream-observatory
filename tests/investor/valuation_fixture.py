"""Run the real core queue in a temporary fictional investor database only."""

import argparse
from pathlib import Path
import tempfile

from worker.orchestration.db import WorkbenchError, canonical_json, open_database
from worker.orchestration.runtime import run_pending_once


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--now", required=True)
    args = parser.parse_args()
    path = Path(args.db).resolve(strict=True)
    if (path.parent.parent != Path(tempfile.gettempdir()).resolve()
            or not path.parent.name.startswith(("etf-investor-synthetic-", "etf-workbench-http-", "etf-browser-fixture-"))
            or path.name != "workbench.db"):
        raise WorkbenchError("FICTIONAL_VALUATION_FIXTURE_DATABASE_REQUIRED")
    db = open_database(path)
    try:
        results = []
        for _ in range(20):
            result = run_pending_once(db, "fictional-valuation-core", clock=lambda: args.now)
            if result is None:
                break
            results.append(result)
        print(canonical_json({"results": results, "real_provider_called": False}))
    finally:
        db.close()


if __name__ == "__main__":
    main()
