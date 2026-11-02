"""Real wall-clock first-close acceptance, with fictional sources and calendar."""

import argparse
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import socket
import tempfile
import time
from unittest.mock import patch
from zoneinfo import ZoneInfo

from tests.investor import evidence_fixture
from tests.investor.confirmed_capture_fixture import FictionalReceiver
from worker.investor import initial_close, monitor_bootstrap
from worker.investor.confirmed_feed import _windows
from worker.investor.data_evidence import review_source
from worker.investor.monitor_admission import admit_monitor_data, latest_monitor_evidence
from worker.investor.model_runtime import POLL_SECONDS
from worker.market.providers import longport, longport_confirmed
from worker.orchestration.db import WorkbenchError, canonical_json, instant, open_database, stamp
from worker.orchestration.runtime import run_pending_once

FINANCE = ("portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports")
ZONE = ZoneInfo("Asia/Shanghai")


def actual(): return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def scope(db):
    rows = db.execute("SELECT id,owner_id FROM investor_workspaces").fetchall()
    assert len(rows) == 1, "FICTIONAL_SINGLE_WORKSPACE_REQUIRED"
    return rows[0]["id"], rows[0]["owner_id"]


def prepare(db):
    workspace, actor = scope(db)
    assert db.execute("SELECT count(*) FROM investor_evidence_inputs").fetchone()[0] == 0
    waited = time.monotonic()
    at = actual(); local = instant(at).astimezone(ZONE)
    rollover = datetime.combine(local.date() + timedelta(days=1), datetime.min.time(), tzinfo=ZONE)
    if (rollover - local).total_seconds() <= 240:
        time.sleep((rollover - local).total_seconds() + 0.05)
        at = actual()
    waited = round(time.monotonic() - waited, 3)
    close = instant(at) + timedelta(minutes=4); today = instant(at).astimezone(ZONE).date()
    assert close.astimezone(ZONE).date() == today, "FICTIONAL_ACCEPTANCE_NEEDS_ROOM_IN_LOCAL_DAY"
    end = today + timedelta(days=1); expiry = stamp(instant(at) + timedelta(days=30))
    original_review, original_input = evidence_fixture.review_source, evidence_fixture.fixed_policy_input
    def reviewed(db, workspace, actor, source_id, decision, facts, *args, **kwargs):
        kind = db.execute("SELECT kind FROM investor_data_sources WHERE id=?", (source_id,)).fetchone()[0]
        if kind in ("calendar", "actions"):
            facts = json.loads(json.dumps(facts)); prior = facts["range_end"]; facts["range_end"] = end.isoformat()
            if kind == "calendar":
                day = instant(prior + "T00:00:00Z").date() + timedelta(days=1)
                while day <= end:
                    value = {"date": day.isoformat(), "kind": "closed", "close_at": None, "available_at": None,
                        "settled_at": None, "settlement_rule_known_at": None}
                    if day == today:
                        value.update(kind="full", close_at=stamp(close), available_at=stamp(close + timedelta(seconds=2)),
                            settled_at=stamp(close + timedelta(days=1)), settlement_rule_known_at=at)
                    facts["days"].append(value); day += timedelta(days=1)
        return original_review(db, workspace, actor, source_id, decision, facts, *args, **kwargs)
    def positive_tolerance():
        data, plan, policy = original_input()
        for candidate in [*plan["parameter_candidates"], plan["benchmark"], *policy["candidates"]]:
            candidate["tolerance"] = {"absolute_cny": "0.01", "weight": "0.005"}
        return data, plan, policy
    with patch.object(evidence_fixture, "review_source", side_effect=reviewed), \
            patch.object(evidence_fixture, "fixed_policy_input", side_effect=positive_tolerance), patch.object(evidence_fixture, "EXPIRY", expiry):
        evidence_fixture.create(db, workspace, actor, now=at, fixed_policy_v2=True)
    return {"fictional_calendar": True, "close_at": stamp(close), "stop_at": stamp(close + timedelta(seconds=122)),
        "local_day": today.isoformat(), "source_created_at": at, "calendar_rollover_wait_seconds": waited, "real_provider_called": False}


def core(db):
    remaining = POLL_SECONDS - time.time() % POLL_SECONDS
    if remaining < 30:
        time.sleep(remaining + 0.05)
    results = []
    for _ in range(4):
        value = run_pending_once(db, "fictional-actual-clock-first-core")
        if value is None: break
        assert value["status"] in ("succeeded", "skipped"), value["status"]
        results.append({"job_type": value["job_type"], "status": value["status"]})
    return {"jobs": results, "actual_application_clock": True, "real_provider_called": False}


def provider(db):
    workspace, _ = scope(db)
    models = db.execute("SELECT id FROM investor_models WHERE workspace_id=?", (workspace,)).fetchall(); assert len(models) == 1
    assert db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0] == 0
    value = run_pending_once(db, "fictional-current-first-discovery", role="longport")
    assert value is None, "FICTIONAL_EXPECTED_FUTURE_WINDOW"
    row = db.execute("SELECT r.*,j.status job_status,j.attempt_count,j.max_attempts FROM investor_initial_close_requests r JOIN job_runs j ON j.period=r.id AND j.scope=r.workspace_id AND j.job_type=?",
        (initial_close.JOB_TYPE,)).fetchall(); assert len(row) == 1
    row = row[0]; assert row["job_status"] == "queued" and row["attempt_count"] == 0 and row["max_attempts"] == 1
    wait = (instant(row["not_before"]) - instant()).total_seconds()
    assert 0 <= wait <= 130, "FICTIONAL_START_WINDOW_NOT_AVAILABLE"
    while instant() < instant(row["not_before"]): time.sleep(max(0, min(0.25, (instant(row["not_before"]) - instant()).total_seconds())))
    calls = []
    def collect(request, *, stop_requested, **kwargs):
        assert len(request["targets"]) == 2 and all(target["mapping"]["market"] == "CN" for target in request["targets"])
        assert not calls; calls.append(1)
        started, deadline = stamp(instant()), time.monotonic() + request["watch_seconds"]
        while time.monotonic() < deadline:
            if stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
            time.sleep(min(0.25, max(0, deadline - time.monotonic())))
        returned = stamp(instant())
        receiver = FictionalReceiver(now=started, received_at=returned)
        return receiver(request, stop_requested)
    with patch.object(longport_confirmed, "collect_confirmed_days", side_effect=collect):
        result = run_pending_once(db, "fictional-actual-clock-first-provider", role="longport")
    assert result is not None and result["status"] == "succeeded" and result["job_type"] == initial_close.JOB_TYPE, result
    assert len(calls) == 1
    return {"status": result["status"], "stubbed_callback_calls": 1, "actual_application_clock": True, "real_provider_called": False}


def diagnose_stale(db):
    workspace, _ = scope(db); models = db.execute("SELECT id FROM investor_models WHERE workspace_id=?", (workspace,)).fetchall(); assert len(models) == 1
    at = actual(); changes = db.total_changes
    dates = [row[0] for row in db.execute("SELECT json_extract(receipt_json,'$.request.end_date') FROM investor_price_captures WHERE workspace_id=?", (workspace,))]
    assert dates and all(day < (instant(at) - timedelta(seconds=monitor_bootstrap.MAX_QUOTE_AGE_SECONDS)).date().isoformat() for day in dates)
    try: monitor_bootstrap.plan_bootstrap(db, workspace, models[0][0], at)
    except WorkbenchError as error: assert str(error) == "INVESTOR_BOOTSTRAP_PRICES_NOT_READY", str(error)
    else: raise AssertionError("FICTIONAL_OLD_PRICES_MUST_NOT_BOOTSTRAP")
    assert db.total_changes == changes
    return {"retained_old_captures": len(dates), "latest_old_session": max(dates), "checked_at": at,
        "stale_retained_quotes_rejected": True, "writes": 0, "real_provider_called": False}


def scenario_input(db, *, expire=False):
    workspace, actor = scope(db)
    models = db.execute("SELECT id FROM investor_models WHERE workspace_id=?", (workspace,)).fetchall()
    assert len(models) == 1
    model = models[0][0]
    assert db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints WHERE model_id=?", (model,)).fetchone()[0] >= 1
    assert db.execute("SELECT count(*) FROM investor_funding_plans").fetchone()[0] == 0
    previous = latest_monitor_evidence(db, workspace, model)
    document = json.loads(previous["document_json"])
    assert document["schema_version"] == "investor-monitor-data-input-v4"
    windows = [window for _, window in _windows(db, workspace, document)]
    settings = document["settings"]
    at = actual()
    if expire:
        assert settings["funding_intent"] is not None
        close = db.execute("SELECT payload FROM investor_evidence_checkpoint_payloads ORDER BY rowid DESC LIMIT 1").fetchone()[0]
        cutoffs = json.loads(close)["market_cutoffs"]
        settings["max_quote_age_seconds"] = math.ceil(max((instant(at) - instant(value)).total_seconds() for value in cutoffs.values())) + 120
    else:
        assert settings["funding_intent"] is None
        settings["funding_intent"] = {"id": "fictional-current-first-funding", "amount_cny": "1000", "expected_at": at}
    admitted = admit_monitor_data(db, workspace, actor, model, windows, settings, now=at, audited_action_knowledge=True)
    assert admitted["id"] != previous["id"]
    return {"fictional_input": "short_quote_lifetime" if expire else "explicit_hypothetical_funding_intent",
        "input_id": admitted["id"], "actual_application_clock": True, "ordinary_funding_plan_due_path": False,
        "real_provider_called": False, "model_cash_changed": False, "model_units_changed": False}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--db", required=True)
    parser.add_argument("--stage", choices=("prepare", "core", "provider", "stale", "funding", "expire", "withdraw"), required=True); args = parser.parse_args()
    path = Path(args.db).resolve(strict=True)
    assert path.name == "workbench.db" and path.parent.parent == Path(tempfile.gettempdir()).resolve()
    assert path.parent.name.startswith("etf-first-close-http-")
    def denied(*args, **kwargs): raise AssertionError("FICTIONAL_FIRST_CLOSE_EXTERNAL_IO_FORBIDDEN")
    with patch.object(socket, "create_connection", denied), patch.object(socket, "getaddrinfo", denied), \
            patch.object(longport, "_credentials", denied), patch.object(longport, "read_private_credentials_file", denied), \
            patch.object(longport, "_collect_isolated", denied), patch.object(longport_confirmed, "collect_confirmed_days", denied):
        db = open_database(path)
        try:
            assert all(db.execute("SELECT count(*) FROM " + table).fetchone()[0] == 0 for table in FINANCE)
            if args.stage == "prepare": value = prepare(db)
            elif args.stage == "core": value = core(db)
            elif args.stage == "provider": value = provider(db)
            elif args.stage == "stale": value = diagnose_stale(db)
            elif args.stage in ("funding", "expire"): value = scenario_input(db, expire=args.stage == "expire")
            else:
                workspace, actor = scope(db)
                rights = db.execute("SELECT id FROM investor_data_sources WHERE workspace_id=? AND kind='rights'", (workspace,)).fetchall(); assert len(rights) == 1
                at = actual()
                review_source(db, workspace, actor, rights[0][0], "withdrawn", None, "Fictional HTTP permission withdrawal", stamp(instant(at) + timedelta(days=1)), now=at)
                value = {"rights_withdrawn": True, "real_provider_called": False}
            assert all(db.execute("SELECT count(*) FROM " + table).fetchone()[0] == 0 for table in FINANCE)
            print(canonical_json(value))
        finally: db.close()


if __name__ == "__main__": main()
