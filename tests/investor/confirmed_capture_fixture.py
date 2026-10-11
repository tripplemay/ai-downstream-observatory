"""Fictional reviews and stubbed callbacks for an owned temporary SQLite only."""

import argparse
from datetime import datetime, timedelta
from decimal import Decimal
from hashlib import sha256
from pathlib import Path
import tempfile
from unittest.mock import patch
from zoneinfo import ZoneInfo

from worker.investor import confirmed_capture as captures
from worker.investor.data_evidence import review_source, store_source
from worker.market.providers import longport, longport_confirmed as receiver
from worker.orchestration.db import canonical_json, content_hash, instant, open_database, stamp


NOW = "2026-01-02T22:00:03.000Z"
REVIEWED = "2026-01-02T12:00:03.000Z"
EXPIRY = "2027-01-01T00:00:00.000Z"
DAY = "2026-01-02"


def sources(db, *, market="CN", identity="fictional-CN", label="", workspace="w", actor="synthetic-investor", symbol=None):
    def reviewed(kind, facts):
        source = store_source(db, workspace, actor, kind, {"title": "FICTIONAL " + kind + label,
            "reference": "synthetic://confirmed/" + kind + label, "excerpt": "Invented software fixture; no provider data or real permission"}, now=REVIEWED)
        return review_source(db, workspace, actor, source["id"], "approved", facts, "Fictional test only", EXPIRY, now=REVIEWED)
    rights = reviewed("rights", {"provider": "longport", "account_region": "HK", "markets": ["CN", "HK", "US"],
        "uses": ["private_research", "private_retention", "private_display", "private_backup"], "retention_days": 30,
        "valid_from": "2025-01-01T00:00:00.000Z", "valid_until": EXPIRY, "clause_references": ["Fictional, not real permission"]})
    mapping = {"listing_id": identity, "provider_symbol": symbol or {"CN": "501999.SH", "HK": "9999.HK", "US": "FIC01.US"}[market],
        "market": market, "currency": {"CN": "CNY", "HK": "HKD", "US": "USD"}[market]}
    listing = reviewed("listing", {**mapping, "quantity_step": "1", "tradable_from": "2020-01-01T00:00:00.000Z", "tradable_until": None,
        "product_type": "ETF", "leveraged": False, "inverse": False, "role": "growth", "fee_rate": "0.001", "fee_as_of": "2025-01-01",
        "economic_exposure": "Fictional", "historical_universe_basis": "retrospectively_selected_not_survivorship_free"})
    close = instant(DAY + {"CN": "T07:00:00.000Z", "HK": "T04:00:00.000Z", "US": "T21:00:00.000Z"}[market])
    calendar = reviewed("calendar", {"market": market, "range_start": DAY, "range_end": DAY, "days": [{"date": DAY,
        "kind": "half" if market == "HK" else "full", "close_at": stamp(close), "available_at": stamp(close + timedelta(minutes=1)),
        "settled_at": stamp(close + timedelta(days=1)), "settlement_rule_known_at": "2024-01-01T00:00:00.000Z"}]})
    return (rights, listing, calendar)


def inputs(refs):
    return [{**{kind + "_review_id": row["id"] for kind, row in zip(("rights", "listing", "calendar"), group)}, "session_date": DAY} for group in refs]


class FictionalReceiver:
    def __init__(self, *, now=NOW, bars=None, during=None, malformed=False, received_at=None):
        self.now, self.bars, self.during, self.malformed, self.calls = now, bars, during, malformed, 0
        self.received_at = received_at or now

    def __call__(self, request, guard):
        self.calls += 1
        assert not guard()
        if self.during: self.during()
        started = stamp(instant(self.now))
        frames = [{"frame": "ready", "watch_id": request["watch_id"], "request_hash": content_hash(request), "started_at": started,
            "sdk_version": longport.SDK_VERSION, "adapter_version": receiver.ADAPTER_VERSION}]
        targets = request["targets"] if self.bars is None else request["targets"][:self.bars]
        for sequence, target in enumerate(targets, 1):
            zone = ZoneInfo(longport._MARKETS[target["mapping"]["market"]][0])
            candle = {"timestamp": datetime.fromisoformat(target["session_date"]).replace(tzinfo=zone), "open": Decimal("10.0000"),
                "high": Decimal("12"), "low": Decimal("9"), "close": Decimal("11.250000000000000001"), "turnover": Decimal("11250.0000"),
                "volume": 9007199254740993, "trade_session": 0}
            bar = receiver.normalize_confirmed_day(candle, target, watch_id=request["watch_id"], started_at=started, received_at=stamp(instant(self.received_at)))
            frames.append({"frame": "bar", "sequence": sequence, "projection": bar["projection"], "sha256": bar["projection_sha256"]})
        frames.append({"frame": "finished", "watch_id": request["watch_id"], "events": len(targets), "reason": "watch_window_elapsed"})
        if self.malformed:
            frames[0]["watch_id"] = "0" * 32
        raw = b"".join(canonical_json(value).encode() + b"\n" for value in frames)
        return {"qualification": captures.OFFICIAL, "protocol_bytes": raw, "protocol_sha256": sha256(raw).hexdigest(),
            "call_started_at": started, "call_returned_at": stamp(instant(self.received_at)),
            "status": "complete", "records": [{"value": "999999"}], "execution_authorized": True}


def stub_official(db, refs, *, bars=None):
    mock = FictionalReceiver(bars=bars)
    original_millis, original_instant = captures._milliseconds, captures.instant
    with patch.object(receiver, "collect_confirmed_days", side_effect=lambda request, **kwargs: mock(request, kwargs["stop_requested"])), \
            patch.object(captures, "_milliseconds", side_effect=lambda value=None: original_millis(NOW if value is None else value)), \
            patch.object(captures, "instant", side_effect=lambda value=None: original_instant(NOW if value is None else value)):
        return captures.collect_confirmed_prices(db, "w", "synthetic-investor", inputs(refs), watch_seconds=1)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--db", required=True); parser.add_argument("--synthetic", action="store_true")
    parser.add_argument("--bars", type=int); args = parser.parse_args()
    filename = Path(args.db).resolve(strict=True)
    assert filename.name == "workbench.db" and filename.parent.parent == Path(tempfile.gettempdir()).resolve()
    assert filename.parent.name.startswith("etf-investor-synthetic-")
    db = open_database(filename)
    try:
        assert db.execute("SELECT count(*) FROM portfolios").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM investor_workspaces").fetchone()[0] == 0
        db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,?)", (REVIEWED,))
        refs = [sources(db, market=market, identity="fictional-" + market, label=market) for market in ("CN", "HK", "US")]
        row = captures.collect_confirmed_prices(db, "w", "synthetic-investor", inputs(refs), watch_seconds=1, now=NOW,
            test_receiver=FictionalReceiver(bars=args.bars)) if args.synthetic else stub_official(db, refs, bars=args.bars)
        resolved = captures.resolve_confirmed_capture(db, "w", row["id"], now=NOW, allow_synthetic=args.synthetic)
        print(canonical_json({"capture_id": row["id"], "receipt": resolved["receipt"], "records": resolved["records"],
            "real_provider_called": False, "fixture_transport": "stubbed_not_network_authenticated"}))
    finally:
        db.close()


if __name__ == "__main__":
    main()
