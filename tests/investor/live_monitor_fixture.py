"""Invented current-clock CN receipts for isolated HTTP/browser checks only."""

from datetime import datetime, timedelta
import argparse
from decimal import Decimal
from pathlib import Path
import tempfile
from unittest.mock import patch
from zoneinfo import ZoneInfo

from tests.investor.fixtures import monitor_input
from worker.investor.data_evidence import collect_prices, review_source, store_source
from worker.investor.monitor_admission import admit_monitor_data, current_monitor_model
from worker.market.providers import longport
from worker.orchestration.db import canonical_json, instant, open_database


def create(db, workspace, actor, model_id, now, *, funding=False, external_ai=False, receipts_only=False):
    """Never operate on a user or deployment database."""
    path = Path(db.execute("PRAGMA database_list").fetchone()[2]).resolve(strict=True)
    assert path.parent.parent == Path(tempfile.gettempdir()).resolve() and path.name == "workbench.db"
    assert path.parent.name.startswith(("etf-investor-synthetic-", "etf-workbench-http-", "etf-browser-fixture-"))
    _, definition, _ = current_monitor_model(db, workspace, model_id, now)
    assert all(target["market"] == "CN" and target["currency"] == "CNY" for target in definition["targets"])
    at = instant(now); today = at.astimezone(ZoneInfo("Asia/Shanghai")).date(); start, end = today - timedelta(days=2), today - timedelta(days=1)
    expiry = (at + timedelta(days=10)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    date = lambda value: value.isoformat()
    stamp = lambda day, hour=7: date(day) + f"T{hour:02d}:00:00.000Z"
    def reviewed(kind, facts, label):
        source = store_source(db, workspace, actor, kind, {"title": "FICTIONAL " + label,
            "reference": "synthetic://current-clock/" + label + "/" + now, "excerpt": "Invented fixture, not provider certification or real license"}, now=now)
        return review_source(db, workspace, actor, source["id"], "approved", facts, "Fictional fixture only", expiry, now=now)
    rights = reviewed("rights", {"provider": "longport", "account_region": "SG", "markets": ["CN"],
        "uses": ["private_research", "private_retention", "private_display", "private_backup"] + (["external_ai"] if external_ai else []), "retention_days": 10,
        "valid_from": stamp(start, 0), "valid_until": expiry, "clause_references": ["Fictional fixture, not real permission"]}, "rights")
    calendar = reviewed("calendar", {"market": "CN", "range_start": date(start), "range_end": date(today), "days": [
        {"date": date(day), "kind": "full", "close_at": stamp(day), "available_at": stamp(day).replace(":00:00.", ":01:00."),
         "settled_at": stamp(day + timedelta(days=1)), "settlement_rule_known_at": stamp(start - timedelta(days=1), 0)} for day in (start, end)
    ] + [{"date": date(today), "kind": "closed", "close_at": None, "available_at": None, "settled_at": None, "settlement_rule_known_at": None}]}, "calendar")
    captures, actions = [], []
    for target in definition["targets"]:
        listing_id = target["listing_id"]
        plan = current_monitor_model(db, workspace, model_id, now)[2]
        symbol = next(row["symbol"] for row in plan["targets"] if row["listing_id"] == listing_id)
        mapping = {"listing_id": listing_id, "market": "CN", "currency": "CNY", "provider_symbol": symbol}
        listing = reviewed("listing", {**mapping, "quantity_step": "1", "tradable_from": "2020-01-01T00:00:00Z", "tradable_until": None,
            "product_type": "ETF", "leveraged": False, "inverse": False,
            "role": definition["fixed_policy"]["parameters"]["roles"][listing_id] if definition["schema_version"] == "investor-model-definition-v2" else "growth", "fee_rate": "0.001", "fee_as_of": date(start),
            "economic_exposure": "Fictional exposure", "historical_universe_basis": "retrospectively_selected_not_survivorship_free"}, listing_id)
        action = reviewed("actions", {"listing_id": listing_id, "range_start": date(start), "range_end": date(today),
            "coverage": "reviewed_complete", "tax_assumption": "Fictional net amount assumption", "events": []}, listing_id + "-actions")
        request = longport._request(mapping, date(start), date(end), [date(start), date(end)])
        candles = [{"timestamp": datetime.combine(day, datetime.min.time(), ZoneInfo("Asia/Shanghai")), "open": Decimal("10"),
            "high": Decimal("12"), "low": Decimal("9"), "close": Decimal("11.25"), "turnover": Decimal("11250"), "volume": 1000, "trade_session": 0} for day in (start, end)]
        projection = longport._normalize(candles, request=request, sdk_version="4.3.7", call_started_at=now, call_returned_at=now,
            datetime_basis="runtime_utc_from_unix_timestamp", collector_runtime="isolated_official_sdk")
        with patch.object(longport, "_collect_isolated", return_value=projection), \
                patch("worker.investor.data_evidence._milliseconds", side_effect=lambda value=None: now if value is None else value), \
                patch("worker.investor.data_evidence.instant", side_effect=lambda value=None: instant(now if value is None else value)):
            capture = collect_prices(db, workspace, actor, rights["id"], listing["id"], calendar["id"], date(start), date(end))
        captures.append(capture["id"]); actions.append(action["id"])
    if receipts_only:
        assert not funding
        return None
    settings = {"policy": monitor_input()["policy"], "funding_intent": {"id": "fictional-current-funding", "amount_cny": "1000", "expected_at": now} if funding else None,
        "max_quote_age_seconds": 172800}
    return admit_monitor_data(db, workspace, actor, model_id, [{"capture_ids": captures, "action_review_ids": actions, "fx_review_ids": [],
        "start_date": date(start), "end_date": date(end)}], settings, now=now)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--now", required=True)
    parser.add_argument("--funding", action="store_true")
    parser.add_argument("--external-ai", action="store_true")
    args = parser.parse_args()
    path = Path(args.db).resolve(strict=True)
    assert path.parent.parent == Path(tempfile.gettempdir()).resolve() and path.name == "workbench.db"
    assert path.parent.name.startswith(("etf-investor-synthetic-", "etf-browser-fixture-"))
    db = open_database(path)
    try:
        assert db.execute("SELECT count(*) FROM portfolios").fetchone()[0] == 0
        rows = db.execute("SELECT id,owner_id FROM investor_workspaces").fetchall(); assert len(rows) == 1
        workspace, actor = rows[0]["id"], rows[0]["owner_id"]
        model = db.execute("SELECT m.id FROM investor_models m JOIN investor_profiles p ON p.id=m.profile_id WHERE m.workspace_id=? ORDER BY p.version DESC,m.rowid DESC LIMIT 1", (workspace,)).fetchone()
        assert model is not None
        create(db, workspace, actor, model["id"], args.now, funding=args.funding, external_ai=args.external_ai)
        from worker.orchestration.runtime import run_pending_once
        for _ in range(10):
            result = run_pending_once(db, "fictional-current-monitor", clock=lambda: args.now)
            if result is None: break
            assert result["status"] in ("succeeded", "skipped")
        print(canonical_json({"status": "fictional_current_monitor_complete", "real_provider_called": False}))
    finally: db.close()


if __name__ == "__main__": main()
