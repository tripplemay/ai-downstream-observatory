"""Cross-language read-only adapter for invented private funding evidence only."""

import argparse
import sys
from pathlib import Path
import tempfile

from worker.investor.planned_funding_source import read_bound_planned_funding_monitor, read_planned_funding_monitor
from worker.investor.runtime import _json
from worker.orchestration.db import WorkbenchError, canonical_json, open_database


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--actor", default="synthetic-investor")
    parser.add_argument("--at", required=True)
    parser.add_argument("--bound", action="store_true")
    parser.add_argument("--checked-at")
    args = parser.parse_args()
    path = Path(args.db).resolve(strict=True)
    if path.parent.parent != Path(tempfile.gettempdir()).resolve() or not path.parent.name.startswith("etf-investor-synthetic-") or path.name != "workbench.db":
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db = open_database(path)
    try:
        before = db.total_changes
        if args.bound:
            binding = _json(sys.stdin.read(65537))
            if binding.get("model_id") != args.model:
                raise WorkbenchError("SYNTHETIC_FUNDING_MODEL_SCOPE_INVALID")
            result = read_bound_planned_funding_monitor(db, args.workspace, args.actor, binding,
                evaluated_at=args.at, now=args.checked_at or args.at)
        else:
            if args.checked_at is not None:
                raise WorkbenchError("SYNTHETIC_BOUND_MODE_REQUIRED")
            result = read_planned_funding_monitor(db, args.workspace, args.actor, args.model, now=args.at)
        if db.total_changes != before:
            raise WorkbenchError("SYNTHETIC_FUNDING_READER_WROTE_DATA")
        print(canonical_json(result))
    finally:
        db.close()


if __name__ == "__main__":
    main()
