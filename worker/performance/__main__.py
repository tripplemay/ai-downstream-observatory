import argparse
import sys

from worker.market.__main__ import _load
from worker.orchestration.db import WorkbenchError, canonical_json, open_database
from .pipeline import persist_performance, prepare_performance


def main(argv=None):
    parser = argparse.ArgumentParser(description="Performance from immutable actual valuation snapshots; no trades")
    parser.add_argument("--db", required=True)
    parser.add_argument("--portfolio", required=True)
    parser.add_argument("--file", required=True)
    args = parser.parse_args(argv)
    try:
        connection = open_database(args.db)
        try:
            prepared = prepare_performance(connection, args.portfolio, _load(args.file))
            result = persist_performance(connection, prepared)
            print(canonical_json(result))
            return 0 if result["quality"] == "complete" else 2
        finally:
            connection.close()
    except (WorkbenchError, ValueError, OSError) as exc:
        print(canonical_json({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
