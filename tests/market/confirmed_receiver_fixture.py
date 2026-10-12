"""Isolated fictional child for receiver process tests; never contacts a provider."""

from datetime import datetime
import json
import os
from pathlib import Path
import resource
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from worker.market.providers import longport, longport_confirmed as receiver
from worker.orchestration.db import canonical_json, content_hash, stamp


mode, probe = sys.argv[1:]
if mode == "kernel-stall":
    def stalled(request, credentials, emit):
        Path(probe).write_text(canonical_json({"pid": os.getpid(), "credentials_are_fictional": credentials["app_key"] == "fixture-only-key",
            "core_limit": list(resource.getrlimit(resource.RLIMIT_CORE)), "file_limit": list(resource.getrlimit(resource.RLIMIT_FSIZE))}))
        time.sleep(30)
    receiver.STARTUP_SECONDS = 1
    receiver._watch_with_sdk = stalled
    os._exit(receiver._child_main())
command = json.loads(sys.stdin.buffer.read())
request = command["request"]
Path(probe).write_text(canonical_json({"pid": os.getpid(), "credentials_are_fictional": command["credentials"]["app_key"] == "fixture-only-key"}))
started = stamp()
def emit(value):
    sys.stdout.buffer.write(canonical_json(value).encode() + b"\n"); sys.stdout.buffer.flush()
emit({"frame": "ready", "watch_id": request["watch_id"], "request_hash": content_hash(request),
    "started_at": started, "sdk_version": longport.SDK_VERSION, "adapter_version": receiver.ADAPTER_VERSION})
if mode == "stall":
    time.sleep(30)
if mode == "bad":
    print("FICTIONAL_SECRET_MUST_NOT_SURFACE", file=sys.stderr)
    raise SystemExit(1)
events = 0
if mode in ("complete", "late-bad", "coerced-bool"):
    for target in request["targets"]:
        zone = __import__("zoneinfo").ZoneInfo(longport._MARKETS[target["mapping"]["market"]][0])
        candle = {"open": "10.0000", "high": "12", "low": "9", "close": "11.2500", "turnover": "11250",
            "volume": 1000, "trade_session": 0, "timestamp": datetime.fromisoformat(target["session_date"]).replace(tzinfo=zone)}
        result = receiver.normalize_confirmed_day(candle, target, watch_id=request["watch_id"], started_at=started, received_at=stamp())
        if mode == "coerced-bool":
            result["projection"]["source"]["is_confirmed"] = 1
        events += 1
        emit({"frame": "bar", "sequence": events, "projection": result["projection"], "sha256": result["projection_sha256"]})
if mode == "late-bad":
    raise SystemExit(1)
emit({"frame": "finished", "watch_id": request["watch_id"], "events": events, "reason": "watch_window_elapsed"})
