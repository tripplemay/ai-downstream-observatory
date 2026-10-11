"""Bounded, read-only SDK-confirmed daily callbacks, not exchange certification.

Subscription snapshots are ignored. The SDK derives the confirmation flag in
its local candlestick engine. No database, source approval or order is created.
"""

from datetime import datetime, timezone
from hashlib import sha256
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
from threading import Event, Lock
import time
from zoneinfo import ZoneInfo

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, stamp


ADAPTER_VERSION = "longport-sdk-confirmed-day-v1"
MAX_TARGETS = 32
MAX_WATCH_SECONDS = 900
STARTUP_SECONDS = 30
MAX_FRAME_BYTES = 65536
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
_HASH = re.compile(r"[a-f0-9]{64}\Z", re.ASCII)
_WATCH = re.compile(r"[a-f0-9]{32}\Z", re.ASCII)
_CHILD_CONTEXT = None


def _require(condition, code="INVALID_REQUEST"):
    if not condition:
        raise WorkbenchError("LONGPORT_CONFIRMED_" + code)


def _target(value):
    _require(type(value) is dict and set(value) == {"mapping", "session_date", "close_at", "available_at", "calendar_hash"})
    day = longport._day(value["session_date"]).isoformat()
    mapping = longport._request(value["mapping"], day, day, [day])["mapping"]
    close, available = longport._instant(value["close_at"]), longport._instant(value["available_at"])
    _require(close <= available and close.astimezone(ZoneInfo(longport._MARKETS[mapping["market"]][0])).date().isoformat() == day)
    _require(type(value["calendar_hash"]) is str and _HASH.fullmatch(value["calendar_hash"]))
    result = {"mapping": mapping, "session_date": day, "close_at": stamp(close), "available_at": stamp(available), "calendar_hash": value["calendar_hash"]}
    return result


def make_watch_request(targets, watch_id, *, watch_seconds=900):
    _require(type(watch_id) is str and _WATCH.fullmatch(watch_id))
    _require(type(watch_seconds) is int and 1 <= watch_seconds <= MAX_WATCH_SECONDS)
    _require(type(targets) is list and 1 <= len(targets) <= MAX_TARGETS)
    normalized = [_target(value) for value in targets]
    _require(len({row["mapping"]["listing_id"] for row in normalized}) == len(normalized)
        and len({row["mapping"]["provider_symbol"] for row in normalized}) == len(normalized))
    return {"schema_version": "longport-confirmed-watch-v1", "watch_id": watch_id,
        "watch_seconds": watch_seconds, "targets": sorted(normalized, key=lambda row: row["mapping"]["listing_id"])}


def _request(value):
    _require(type(value) is dict and set(value) == {"schema_version", "watch_id", "watch_seconds", "targets"})
    frozen = make_watch_request(value["targets"], value["watch_id"], watch_seconds=value["watch_seconds"])
    _require(value == frozen)
    return frozen


def normalize_confirmed_day(candle, target, *, watch_id, started_at, received_at):
    """Pure replay only. Supplying JSON/SDK-like objects does not prove origin."""
    target = _target(target)
    _require(type(watch_id) is str and _WATCH.fullmatch(watch_id))
    started, received = longport._instant(started_at), longport._instant(received_at)
    _require(started <= received and longport._instant(target["available_at"]) <= received, "BEFORE_REVIEWED_CLOSE")
    timestamp = longport._field(candle, "timestamp")
    _require(isinstance(timestamp, datetime), "TIMESTAMP_REQUIRED")
    timestamp = longport._instant(timestamp)
    zone = longport._MARKETS[target["mapping"]["market"]][0]
    _require(timestamp.astimezone(ZoneInfo(zone)).date().isoformat() == target["session_date"]
        and timestamp <= longport._instant(target["close_at"]), "SESSION_MISMATCH")
    prices = {key: longport._money(longport._field(candle, key)) for key in ("open", "high", "low", "close", "turnover")}
    _require(prices["close"][1] > 0 and prices["low"][1] <= min(prices["open"][1], prices["close"][1])
        and prices["high"][1] >= max(prices["open"][1], prices["close"][1]) and prices["low"][1] <= prices["high"][1], "OHLC_INVALID")
    volume = longport._field(candle, "volume")
    _require(type(volume) is int and 0 <= volume <= 9223372036854775807, "VOLUME_INVALID")
    row = {key: value[0] for key, value in prices.items()}
    row.update(volume=str(volume), timestamp=stamp(timestamp), trade_session=longport._session(longport._field(candle, "trade_session")))
    source = {"provider": "longport", "sdk_version": longport.SDK_VERSION, "sdk_source_commit": longport.SDK_SOURCE_COMMIT,
        "adapter_version": ADAPTER_VERSION, "capture_kind": "sdk_confirmed_callback_projection", "period": "day", "adjust_type": "none",
        "trade_session": "regular", "push_mode": "confirmed", "is_confirmed": True,
        "confirmation_semantics": "pinned_sdk_local_engine_not_exchange_signoff",
        "receiver_started_at": stamp(started), "received_at": stamp(received), "source_timezone": zone,
        "sdk_datetime_basis": "runtime_utc_from_unix_timestamp", "publication_time_status": "not_supplied",
        "provider_revision_status": "not_supplied", "network_bytes_preserved": False,
        "calendar_verified_by_adapter": False, "mapping_verified_by_adapter": False, "account_buyability_verified": False,
        "subscription_snapshot_used": False, "stream_continuity_verified": False}
    projection = {"schema_version": "longport-confirmed-day-projection-v1", "watch_id": watch_id,
        "target": target, "candlestick": row, "source": source}
    encoded = canonical_json(projection).encode()
    _require(0 < len(encoded) < MAX_FRAME_BYTES, "PROJECTION_TOO_LARGE")
    digest = sha256(encoded).hexdigest()
    record = {"listing_id": target["mapping"]["listing_id"], "currency": target["mapping"]["currency"],
        "observed_at": target["session_date"], "time_precision": "date", "value": prices["close"][0], "metric": "close",
        "price_basis": "unadjusted", "published_at": None, "provider_revision": None, "ingested_at": stamp(received),
        "source_timezone": zone, "provider_timestamp": stamp(timestamp), "provenance": "live_observed",
        "projection_sha256": digest}
    return {"projection": projection, "projection_bytes": encoded, "projection_sha256": digest, "record": record}


def parse_confirmed_watch(raw, request, parent_started, parent_returned):
    """Reject extra, duplicate, conflicting, noncanonical and unfinished frames."""
    try:
        request = _request(request)
        _require(type(raw) is bytes and 0 < len(raw) <= MAX_OUTPUT_BYTES and raw.endswith(b"\n"))
        lines = raw[:-1].split(b"\n")
        _require(2 <= len(lines) <= MAX_TARGETS + 2)
        frames = []
        for line in lines:
            _require(0 < len(line) <= MAX_FRAME_BYTES)
            value = longport._strict_json(line.decode())
            _require(type(value) is dict and canonical_json(value).encode() == line)
            frames.append(value)
        first, last = frames[0], frames[-1]
        _require(set(first) == {"frame", "watch_id", "request_hash", "started_at", "sdk_version", "adapter_version"}
            and first["frame"] == "ready" and first["watch_id"] == request["watch_id"] and first["request_hash"] == content_hash(request)
            and first["sdk_version"] == longport.SDK_VERSION and first["adapter_version"] == ADAPTER_VERSION)
        started = longport._instant(first["started_at"])
        _require(first["started_at"] == stamp(started) and longport._instant(parent_started) <= started <= longport._instant(parent_returned))
        _require(set(last) == {"frame", "watch_id", "events", "reason"} and last["frame"] == "finished"
            and last["watch_id"] == request["watch_id"] and type(last["events"]) is int and last["events"] == len(frames) - 2
            and last["reason"] == "watch_window_elapsed")
        targets = {value["mapping"]["provider_symbol"]: value for value in request["targets"]}
        bars, seen, previous_received = [], set(), started
        for index, frame in enumerate(frames[1:-1], 1):
            _require(set(frame) == {"frame", "sequence", "projection", "sha256"} and frame["frame"] == "bar"
                and type(frame["sequence"]) is int and frame["sequence"] == index)
            projection = frame["projection"]
            symbol = projection["target"]["mapping"]["provider_symbol"]
            _require(symbol in targets and symbol not in seen and projection["target"] == targets[symbol])
            seen.add(symbol)
            source = projection["source"]
            received = longport._instant(source["received_at"])
            _require(previous_received <= received <= longport._instant(parent_returned))
            previous_received = received
            row = dict(projection["candlestick"])
            _require(type(row["volume"]) is str and re.fullmatch(r"0|[1-9][0-9]{0,18}", row["volume"]))
            row["volume"] = int(row["volume"]); row["timestamp"] = longport._instant(row["timestamp"])
            result = normalize_confirmed_day(row, targets[symbol], watch_id=request["watch_id"], started_at=first["started_at"], received_at=source["received_at"])
            # Python equality treats True == 1 and False == 0. Compare the
            # canonical bytes as well as the replay digest, not coercive dicts.
            _require(canonical_json(projection).encode() == result["projection_bytes"]
                and frame["sha256"] == result["projection_sha256"])
            bars.append(result)
        return {"request": request, "bars": bars, "status": "complete" if len(bars) == len(targets) else "partial" if bars else "no_confirmed_events",
            "qualification": "parser_only_not_network_authenticated", "stream_continuity_verified": False}
    except Exception:
        raise WorkbenchError("LONGPORT_CONFIRMED_CHILD_RESPONSE_INVALID") from None


def _watch_with_sdk(request, credentials, emit):
    global _CHILD_CONTEXT
    _require(os.environ.get("TZ") == "UTC" and hasattr(time, "tzset"), "ISOLATED_UTC_REQUIRED")
    time.tzset()
    _require(time.timezone == 0 and time.daylight == 0 and datetime.fromtimestamp(0) == datetime(1970, 1, 1), "ISOLATED_UTC_REQUIRED")
    sdk = longport._load_sdk()
    started = stamp()
    config = sdk.Config.from_apikey(**credentials, http_url="https://openapi.longportapp.com",
        quote_ws_url="wss://openapi-quote.longportapp.com/v2", trade_ws_url="wss://openapi-trade.longportapp.com/v2",
        enable_overnight=False, push_candlestick_mode=sdk.PushCandlestickMode.Confirmed, enable_print_quote_packages=False)
    client = sdk.QuoteContext(config)
    _CHILD_CONTEXT = client
    targets = {row["mapping"]["provider_symbol"]: row for row in request["targets"]}
    lock, failed, active, seen = Lock(), Event(), Event(), {}
    active.set()
    emit({"frame": "ready", "watch_id": request["watch_id"], "request_hash": content_hash(request),
        "started_at": started, "sdk_version": longport.SDK_VERSION, "adapter_version": ADAPTER_VERSION})

    def callback(symbol, event):
        with lock:
            if failed.is_set() or not active.is_set():
                return
            try:
                _require(symbol in targets, "CALLBACK_SCOPE")
                _require(type(event.is_confirmed) is bool, "CONFIRMATION_FLAG")
                if not event.is_confirmed:
                    return
                _require(event.period == sdk.Period.Day, "CALLBACK_PERIOD")
                candle = {key: longport._field(event.candlestick, key) for key in longport._CANDLE_FIELDS}
                timestamp = candle["timestamp"]
                _require(isinstance(timestamp, datetime), "TIMESTAMP_REQUIRED")
                if timestamp.tzinfo is None:
                    timestamp = timestamp.replace(tzinfo=timezone.utc)
                candle["timestamp"] = timestamp
                # Confirmed events for another date are not coverage for this
                # request. Snapshot history is never used to fill that hole.
                zone = ZoneInfo(longport._MARKETS[targets[symbol]["mapping"]["market"]][0])
                if timestamp.astimezone(zone).date().isoformat() != targets[symbol]["session_date"]:
                    return
                result = normalize_confirmed_day(candle, targets[symbol], watch_id=request["watch_id"], started_at=started, received_at=stamp())
                digest = content_hash(result["projection"]["candlestick"])
                if symbol in seen:
                    _require(seen[symbol] == digest, "CONFIRMED_BAR_CONFLICT")
                    return
                seen[symbol] = digest
                emit({"frame": "bar", "sequence": len(seen), "projection": result["projection"], "sha256": result["projection_sha256"]})
            except Exception:
                # The pinned SDK swallows callback exceptions. Signal the main
                # loop explicitly, with no provider exception strings or data.
                failed.set()

    deadline = time.monotonic() + request["watch_seconds"]
    try:
        client.set_on_candlestick(callback)
        for symbol in targets:
            client.subscribe_candlesticks(symbol, sdk.Period.Day, sdk.TradeSessions.Intraday)
            _require(not failed.is_set(), "CALLBACK_INVALID")
        failed.wait(max(0, deadline - time.monotonic()))
        with lock:
            active.clear()
            _require(not failed.is_set(), "CALLBACK_INVALID")
            emit({"frame": "finished", "watch_id": request["watch_id"], "events": len(seen), "reason": "watch_window_elapsed"})
    finally:
        with lock:
            active.clear()


def _child_main():
    try:
        import resource
        signal.signal(signal.SIGALRM, signal.SIG_DFL)
        signal.setitimer(signal.ITIMER_REAL, STARTUP_SECONDS)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES))
        body = sys.stdin.buffer.read(longport.MAX_CHILD_INPUT_BYTES + 1)
        _require(0 < len(body) <= longport.MAX_CHILD_INPUT_BYTES)
        command = longport._strict_json(body.decode())
        _require(type(command) is dict and set(command) == {"request", "credentials"})
        request = _request(command["request"])
        credentials = command["credentials"]
        _require(type(credentials) is dict and set(credentials) == {"app_key", "app_secret", "access_token"}
            and all(type(value) is str and 0 < len(value.encode()) <= 8192 and value.strip() for value in credentials.values()))
        signal.setitimer(signal.ITIMER_REAL, STARTUP_SECONDS + request["watch_seconds"])
        def emit(frame):
            encoded = canonical_json(frame).encode()
            _require(0 < len(encoded) <= MAX_FRAME_BYTES, "FRAME_LIMIT")
            sys.stdout.buffer.write(encoded + b"\n"); sys.stdout.buffer.flush()
        _watch_with_sdk(request, credentials, emit)
        return 0
    except Exception:
        return 1


def collect_confirmed_days(request, *, credentials_file=None, stop_requested=None):
    """Fixed isolated receiver. Returns only after a clean, bounded watch ends.

    Incomplete coverage is explicit. A late callback/protocol error discards the
    whole in-memory batch. Source rights and persistence require a separate
    before/after-I/O owner-bound adapter; this is not a production scheduler.
    """
    request = _request(request)
    if stop_requested and stop_requested():
        raise WorkbenchError("WORKER_STOP_REQUESTED")
    credentials = longport._credentials() if credentials_file is None else longport.read_private_credentials_file(credentials_file)
    encoded = canonical_json({"request": request, "credentials": credentials}).encode()
    _require(len(encoded) <= longport.MAX_CHILD_INPUT_BYTES, "INPUT_LIMIT")
    started, deadline = stamp(), time.monotonic() + STARTUP_SECONDS + request["watch_seconds"]
    with tempfile.TemporaryDirectory(prefix="etf-confirmed-") as directory:
        os.chmod(directory, 0o700)
        descriptor = os.open(Path(directory) / ".env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.close(descriptor)
        environment = {"TZ": "UTC", "HOME": directory, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "PYTHONUTF8": "1"}
        with tempfile.TemporaryFile(dir=directory) as output:
            process = None
            try:
                process = subprocess.Popen([sys.executable, "-I", str(Path(__file__).resolve()), "--confirmed-sdk-child"],
                    stdin=subprocess.PIPE, stdout=output, stderr=subprocess.DEVNULL, cwd=directory, env=environment, start_new_session=True)
                input_ = encoded
                while True:
                    if stop_requested and stop_requested():
                        raise WorkbenchError("WORKER_STOP_REQUESTED")
                    remaining = deadline - time.monotonic()
                    _require(remaining > 0, "WATCH_TIMEOUT")
                    try:
                        process.communicate(input_, timeout=min(0.25, remaining))
                        break
                    except subprocess.TimeoutExpired:
                        input_ = None
                _require(process.returncode == 0, "SDK_RECEIVER_FAILED")
                _require(0 < output.tell() <= MAX_OUTPUT_BYTES, "OUTPUT_LIMIT")
                output.seek(0); raw = output.read(MAX_OUTPUT_BYTES + 1)
            except OSError:
                raise WorkbenchError("LONGPORT_CONFIRMED_RUNTIME_FAILED") from None
            finally:
                if process is not None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
    if stop_requested and stop_requested():
        raise WorkbenchError("WORKER_STOP_REQUESTED")
    returned = stamp()
    result = parse_confirmed_watch(raw, request, started, returned)
    result["qualification"] = "isolated_official_sdk_callback"
    result.update(protocol_bytes=raw, protocol_sha256=sha256(raw).hexdigest(),
        call_started_at=started, call_returned_at=returned)
    return result


if __name__ == "__main__":
    if sys.argv[1:] != ["--confirmed-sdk-child"]:
        raise SystemExit(2)
    # Avoid GIL/callback-mutex races during SDK/interpreter destruction. All
    # output is explicitly flushed; the parent reaps this owned process group.
    os._exit(_child_main())
