import argparse
import os
import signal
import socket
import sys
import time

from .db import WorkbenchError, canonical_json, open_database
from .evaluations import DiscoveryState
from .runtime import run_pending_once


def main(argv=None):
    parser = argparse.ArgumentParser(description="Fenced workbench worker; explicit data collection, no broker execution")
    parser.add_argument("--db", default=os.environ.get("WORKBENCH_DB_PATH"))
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--poll-seconds", type=float, default=5)
    parser.add_argument("--lease-seconds", type=int, default=300)
    parser.add_argument("--evaluation-discovery-limit", type=int, default=100)
    parser.add_argument("--role", choices=("core", "longport"), default="core")
    args = parser.parse_args(argv)
    if (not args.db or not 0.1 <= args.poll_seconds <= 3600 or not 1 <= args.lease_seconds <= 86400
            or not 1 <= args.evaluation_discovery_limit <= 1000):
        parser.error("absolute --db, poll 0.1..3600, lease 1..86400 and discovery limit 1..1000 required")
    if args.role == "longport" and args.lease_seconds < 180:
        parser.error("longport role requires a lease of at least 180 seconds")
    owner = socket.gethostname() + ":" + str(os.getpid())
    stop = False
    def stopping(signum, frame):
        nonlocal stop
        stop = True
    signal.signal(signal.SIGTERM, stopping)
    signal.signal(signal.SIGINT, stopping)
    try:
        if args.role == "longport":
            from worker.market.providers.longport import _credentials, _load_sdk
            try:
                _load_sdk()
                _credentials()
            except Exception:
                raise WorkbenchError("LONGPORT_RUNTIME_NOT_CONFIGURED") from None
        connection = open_database(args.db)
        discovery_state = DiscoveryState()
        try:
            while not stop:
                try:
                    result = run_pending_once(connection, owner, args.lease_seconds,
                                              discovery_limit=args.evaluation_discovery_limit,
                                              stop_requested=lambda: stop, discovery_state=discovery_state,
                                              role=args.role)
                    if result is not None:
                        print(canonical_json({"job_id": result["id"], "status": result["status"]}), flush=True)
                    if args.once:
                        return 0 if result is None or result["status"] in ("succeeded", "skipped") else 2
                except Exception as exc:
                    print(canonical_json({"error": type(exc).__name__, "message": str(exc)}), file=sys.stderr, flush=True)
                    if args.once:
                        return 1
                time.sleep(args.poll_seconds)
        finally:
            connection.close()
    except (WorkbenchError, OSError) as exc:
        print(canonical_json({"error": str(exc)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
