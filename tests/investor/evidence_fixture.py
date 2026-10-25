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


def create(db, workspace, actor, *, now=NOW, admit=True, fixed_policy_v2=False, funded_year=False, funded_calendar=False, external_ai=False, initial_monitor_calendar=False, bounded_execution_v3=False, browser_cent_tolerance=False, action_aware_execution_v4=False, event_review_execution_v5=False, train_execution_gap=False, settled_intent_execution_v6=False, train_settled_orphan=False, funded_settled_orphan=False):
    if initial_monitor_calendar and (funded_year or funded_calendar): raise WorkbenchError("SYNTHETIC_INITIAL_CALENDAR_CONFLICT")
    data, plan, policy = fixed_policy_input() if fixed_policy_v2 else research_input()
    causal_event = event_review_execution_v5 or settled_intent_execution_v6
    if train_settled_orphan and (not settled_intent_execution_v6 or not fixed_policy_v2 or funded_year or funded_calendar):
        raise WorkbenchError('SYNTHETIC_SETTLED_ORPHAN_SCOPE')
    if funded_settled_orphan and (not settled_intent_execution_v6 or not funded_year or not fixed_policy_v2):
        raise WorkbenchError('SYNTHETIC_FUNDED_SETTLED_ORPHAN_SCOPE')
    if settled_intent_execution_v6:
        plan['windows']['train']['end'] = '2025-02-20T23:00:00Z'
        for row in data['observations']:
            if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2025-01-15': row['value'] = '20'
        if train_settled_orphan:
            plan['decision_times'] = ['2025-01-05T07:01:00Z', '2025-02-05T07:01:00Z'] + [
                at for at in plan['decision_times'] if instant(at) >= instant(plan['windows']['validation']['start'])]
    if train_execution_gap:
        if not fixed_policy_v2 or not event_review_execution_v5 or funded_year or funded_calendar:
            raise WorkbenchError('SYNTHETIC_TRAIN_GAP_SCOPE')
        for row in data['observations']:
            if row['listing_id'] == 'CN:ALPHA' and row['observed_at'].startswith('2025-01-07'):
                row['value'] = '20'
    if browser_cent_tolerance:
        if not bounded_execution_v3 or not fixed_policy_v2:
            raise WorkbenchError("SYNTHETIC_BROWSER_TOLERANCE_SCOPE")
        for parameters in [*plan["parameter_candidates"], plan["benchmark"], *policy["candidates"]]:
            parameters["tolerance"]["absolute_cny"] = "0.01"
    if sum((bounded_execution_v3, action_aware_execution_v4, event_review_execution_v5, settled_intent_execution_v6)) > 1:
        raise WorkbenchError("SYNTHETIC_EXECUTION_VERSION_CONFLICT")
    if bounded_execution_v3 or action_aware_execution_v4 or causal_event:
        if not fixed_policy_v2:
            raise WorkbenchError("SYNTHETIC_BOUNDED_EXECUTION_SCOPE")
        from tests.research.bounded_fixtures import bounded_plan
        plan = bounded_plan(plan)
        if action_aware_execution_v4:
            plan["schema_version"] = "research-plan-v4"
            plan["execution"]["order_action_policy"] = "defer_known_scheduled_action_before_commit"
        if causal_event:
            plan["schema_version"] = "research-plan-v5"
            plan["execution"]["order_action_policy"] = "defer_known_else_cancel_batch_and_reassess"
            policy.update(schema_version="investor-strategy-policy-v2", execution_admission="causal_review_zero_terminal_gaps")
        if settled_intent_execution_v6:
            plan['schema_version'] = 'research-plan-v6'
            plan['execution']['buy_funding_policy'] = 'declare_sales_then_freeze_buy_from_settled_cash'
            policy.update(schema_version='investor-strategy-policy-v3', execution_admission='settled_cash_intents_and_reviews_zero_terminal_gaps')
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
        if funded_settled_orphan:
            plan['decision_times'] = ['2024-01-01T07:01:00Z', '2024-02-05T07:01:00Z']
            for row in data['observations']:
                if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2024-01-15': row['value'] = '20'

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
        action_at = "2024-01-02T00:00:00Z" if causal_event and funded_year else "2025-01-06T00:00:00Z"
        action_events = [{"id": "fictional:known-initial-dividend", "listing_id": identity, "type": "dividend",
            "at": action_at, "published_at": action_at if causal_event else "2024-12-01T00:00:00Z", "source_evidence": "Invented distribution",
            "gross_per_unit": "0.1", "tax_per_unit": "0", "pay_at": "2024-01-04T00:00:00Z" if causal_event and funded_year else "2025-01-08T00:00:00Z"}] if (action_aware_execution_v4 or causal_event) and index == 0 and not train_settled_orphan and not funded_settled_orphan else []
        actions.append(reviewed("actions", {"listing_id": identity, "range_start": start_date, "range_end": authority_end,
            "coverage": "reviewed_complete", "tax_assumption": "Explicit fictional zero tax, not account tax", "events": action_events}, "actions-" + identity)["id"])
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
    parser.add_argument("--bounded-execution-v3", action="store_true", help="Explicit synthetic v3 plan; no production parameters")
    parser.add_argument("--action-aware-execution-v4", action="store_true", help="Invented v4 known-action deferral; never real evidence")
    parser.add_argument("--event-review-execution-v5", action="store_true", help="Invented v5 late-action review and explicit admission policy")
    parser.add_argument("--train-execution-gap", action="store_true", help="Invented v5 replacement bound failure frozen before research")
    parser.add_argument('--settled-intent-execution-v6', action='store_true', help='Invented sale/settlement/frozen-buy intent protocol; never real evidence')
    parser.add_argument('--train-settled-orphan', action='store_true', help='Invented v6 train orphan with no future decision, declared before admission')
    parser.add_argument('--funded-settled-orphan', action='store_true', help='Invented annual v6 orphan, frozen before source admission')
    parser.add_argument("--browser-cent-tolerance", action="store_true", help="Explicit fixture-only cent tolerance frozen before study")
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
            funded_calendar=args.funded_calendar, external_ai=args.external_ai, initial_monitor_calendar=args.initial_monitor_calendar, bounded_execution_v3=args.bounded_execution_v3, browser_cent_tolerance=args.browser_cent_tolerance, action_aware_execution_v4=args.action_aware_execution_v4, event_review_execution_v5=args.event_review_execution_v5, train_execution_gap=args.train_execution_gap, settled_intent_execution_v6=args.settled_intent_execution_v6, train_settled_orphan=args.train_settled_orphan, funded_settled_orphan=args.funded_settled_orphan)
        print(canonical_json({"status": "fictional_stub_evidence_fixture_complete", "real_provider_called": False}))
    finally:
        db.close()


if __name__ == "__main__": main()
