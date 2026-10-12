"""Invented sources and stubbed official transport, NEVER real market evidence."""

import argparse
from datetime import timedelta
from decimal import Decimal
from pathlib import Path
import tempfile
from unittest.mock import patch
from zoneinfo import ZoneInfo

from tests.investor.fixtures import fixed_policy_input, research_input
from worker.investor.data_evidence import collect_prices, review_source, store_source
from worker.investor.source_inputs import admit_evidence_input
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, canonical_json, instant, open_database


NOW = "2026-01-02T12:00:03.000Z"
EXPIRY = "2027-01-01T00:00:00.000Z"
START, END = "2025-01-01", "2025-06-10"


def create(db, workspace, actor, *, now=NOW, admit=True, fixed_policy_v2=False, funded_year=False, funded_calendar=False, external_ai=False, initial_monitor_calendar=False):
    if initial_monitor_calendar and (funded_year or funded_calendar): raise WorkbenchError("SYNTHETIC_INITIAL_CALENDAR_CONFLICT")
    data, plan, policy = fixed_policy_input() if fixed_policy_v2 else research_input()
    start_date, end_date = START, END
    if funded_calendar or funded_year:
        plan["evaluation_timezone"] = "Asia/Shanghai"
    if funded_year:
        from tests.investor.long_horizon_fixtures import long_input
        data = long_input(days=366, start="2024-01-01T00:00:00Z")["dataset"]
        start_date, end_date = "2024-01-01", "2024-12-31"
        plan.update(decision_times=[row["available_at"] for row in data["sessions"]], windows={
            "train": {"start": "2024-01-01T00:00:00Z", "end": "2024-04-30T23:00:00Z"},
            "validation": {"start": "2024-05-01T00:00:00Z", "end": "2024-08-31T23:00:00Z"},
            "holdout": {"start": "2024-09-01T00:00:00Z", "end": "2024-12-31T23:00:00Z"}})

    def reviewed(kind, facts, label):
        source = store_source(db, workspace, actor, kind, {"title": "FICTIONAL " + label,
            "reference": "synthetic://stub-transport/" + label, "excerpt": "Invented software fixture, not provider rights, prices, eligibility or a real licence"}, now=now)
        return review_source(db, workspace, actor, source["id"], "approved", facts, "Fictional regression only", EXPIRY, now=now)

    rights = reviewed("rights", {"provider": "longport", "account_region": "SG", "markets": ["CN"],
        "uses": ["private_research", "private_retention", "private_display", "private_backup"] + (["external_ai"] if external_ai else []), "retention_days": 30,
        "valid_from": "2025-01-01T00:00:00Z", "valid_until": EXPIRY, "clause_references": ["FICTIONAL, not a licence"]}, "rights")
    calendar_facts = {"market": "CN", "range_start": start_date, "range_end": end_date,
        "days": [{"date": row["session_date"], "kind": "full", "close_at": row["close_at"], "available_at": row["available_at"],
            "settled_at": data["settlements"][i]["settled_at"], "settlement_rule_known_at": "2023-12-01T00:00:00Z" if funded_year else "2024-12-01T00:00:00Z"}
            for i, row in enumerate(data["sessions"])]}
    authority_end = "2026-01-03" if initial_monitor_calendar else end_date
    if initial_monitor_calendar:
        calendar_facts["range_end"] = authority_end
        day = instant(end_date + "T00:00:00Z").date() + timedelta(days=1)
        while day.isoformat() <= authority_end:
            value = {"date": day.isoformat(), "kind": "closed", "close_at": None, "available_at": None,
                "settled_at": None, "settlement_rule_known_at": None}
            if day.isoformat() in ("2026-01-01", "2026-01-02"):
                close = instant(day.isoformat() + "T07:00:00Z")
                millis = lambda at: at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
                value.update(kind="full", close_at=millis(close), available_at=millis(close + timedelta(minutes=1)),
                    settled_at=millis(close + timedelta(days=1)), settlement_rule_known_at="2024-12-01T00:00:00Z")
            calendar_facts["days"].append(value); day += timedelta(days=1)
    calendar = reviewed("calendar", calendar_facts, "calendar")
    captures, actions, listings = [], [], []
    for index, identity in enumerate(("CN:ALPHA", "CN:BETA")):
        mapping = {"listing_id": identity, "provider_symbol": "501998.SH" if index == 0 else "501999.SH", "market": "CN", "currency": "CNY"}
        listing = reviewed("listing", {**mapping, "quantity_step": "1", "tradable_from": "2024-01-01T00:00:00Z", "tradable_until": None,
            "product_type": "ETF", "leveraged": False, "inverse": False, "role": "growth" if index == 0 else "defensive", "fee_rate": "0.001",
            "fee_as_of": "2024-01-01" if funded_year else "2025-01-01", "economic_exposure": "Fictional exposure", "historical_universe_basis": "retrospectively_selected_not_survivorship_free"}, identity)
        listings.append(listing)
        actions.append(reviewed("actions", {"listing_id": identity, "range_start": start_date, "range_end": authority_end,
            "coverage": "reviewed_complete", "tax_assumption": "Explicit fictional zero tax, not account tax", "events": []}, "actions-" + identity)["id"])
        start, last = instant(start_date + "T00:00:00Z").date(), instant(end_date + "T00:00:00Z").date()
        while start <= last:
            end = min(start + timedelta(days=30), last)
            expected = [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]
            request = longport._request(mapping, start.isoformat(), end.isoformat(), expected)
            candles = []
            for day in expected:
                close = next(row["value"] for row in data["observations"] if row["listing_id"] == identity and row["observed_at"].startswith(day))
                candles.append({"timestamp": instant(day + "T00:00:00Z").astimezone(ZoneInfo("Asia/Shanghai")).replace(hour=0),
                    "open": Decimal(close), "high": Decimal(close), "low": Decimal(close), "close": Decimal(close),
                    "volume": 1000, "turnover": Decimal(close) * 1000, "trade_session": 0})
            projection = longport._normalize(candles, request=request, sdk_version="4.3.7", call_started_at=now, call_returned_at=now,
                datetime_basis="runtime_utc_from_unix_timestamp", collector_runtime="isolated_official_sdk")
            with patch.object(longport, "_collect_isolated", return_value=projection), \
                    patch("worker.investor.data_evidence._milliseconds", side_effect=lambda value=None: now if value is None else value), \
                    patch("worker.investor.data_evidence.instant", side_effect=lambda value=None: instant(now if value is None else value)):
                capture = collect_prices(db, workspace, actor, rights["id"], listing["id"], calendar["id"], start.isoformat(), end.isoformat())
            captures.append(capture["id"])
            start = end + timedelta(days=1)
    source = admit_evidence_input(db, workspace, actor, captures, actions, [], start_date, end_date, plan, policy, now=now) if admit else None
    return {"source": source, "captures": captures, "actions": actions, "rights": rights, "listings": listings, "plan": plan, "policy": policy}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--now", default=NOW)
    parser.add_argument("--fixed-policy-v2", action="store_true")
    parser.add_argument("--funded-year", action="store_true")
    parser.add_argument("--funded-calendar", action="store_true")
    parser.add_argument("--initial-monitor-calendar", action="store_true", help="Invented future calendar, declared before study freeze")
    parser.add_argument("--external-ai", action="store_true", help="Invented regression grant only, never a provider licence")
    args = parser.parse_args()
    path = Path(args.db).resolve(strict=True)
    if path.parent.parent != Path(tempfile.gettempdir()).resolve() or not path.parent.name.startswith(("etf-investor-synthetic-", "etf-browser-fixture-")) or path.name != "workbench.db":
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db = open_database(path)
    try:
        rows = db.execute("SELECT id,owner_id FROM investor_workspaces").fetchall()
        if len(rows) != 1 or db.execute("SELECT count(*) FROM portfolios").fetchone()[0]:
            raise WorkbenchError("SYNTHETIC_EMPTY_FINANCIAL_DATABASE_REQUIRED")
        create(db, rows[0]["id"], rows[0]["owner_id"], now=args.now, fixed_policy_v2=args.fixed_policy_v2, funded_year=args.funded_year,
            funded_calendar=args.funded_calendar, external_ai=args.external_ai, initial_monitor_calendar=args.initial_monitor_calendar)
        print(canonical_json({"status": "fictional_stub_evidence_fixture_complete", "real_provider_called": False}))
    finally:
        db.close()


if __name__ == "__main__": main()
