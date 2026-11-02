"""Retained fictional two-source updates for actual-clock local HTTP acceptance."""

import argparse
from datetime import datetime, time, timedelta, timezone
from hashlib import sha256
import json
from pathlib import Path
import tempfile
from unittest.mock import patch
from zoneinfo import ZoneInfo

from tests.investor.test_issuer_sources import Collector as IssuerCollector, policy as issuer_policy
from tests.investor.test_eodhd_sources import policy as eodhd_policy
from tests.market.test_eodhd_actions import archive as div_archive, dividend
from tests.market.test_vanguard_distributions import archive, row
from worker.investor import data_evidence, eodhd_sources, issuer_sources, issuer_schedule, managed_actions
from worker.market.providers.eodhd_actions import action_url, parse_eodhd_actions
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, open_database
from worker.orchestration.jobs import run_one
from worker.orchestration.runtime import run_pending_once


ZONE = ZoneInfo("America/New_York")
FINANCE = ("portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports")


def stamp(value): return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def day_at(day, hour): return stamp(datetime.combine(day, time(hour), ZONE))


def timeline(at):
    current = instant(at).astimezone(ZONE)
    event = current.date() - timedelta(days=1)
    while event.weekday() >= 5: event -= timedelta(days=1)
    seed = event - timedelta(days=2)
    old = event - timedelta(days=45)
    while old.weekday() >= 5: old -= timedelta(days=1)
    return {"event": event, "seed": seed, "old": old}


class ActionCollector:
    def __init__(self, at, dates, updated): self.at, self.dates, self.updated, self.calls = at, dates, updated, 0

    def __call__(self, **options):
        assert options["symbol"] in ("VT.US", "BND.US") and options["kind"] in ("div", "splits")
        self.calls += 1
        parameters = {key: options[key] for key in ("kind", "symbol", "start_date", "end_date")}
        old = self.dates["old"].isoformat(); event = self.dates["event"].isoformat()
        records = [dividend("987.123", date=old, declarationDate=old, recordDate=old, paymentDate=(self.dates["old"] + timedelta(days=7)).isoformat())]
        if self.updated: records.append(dividend("4.321", date=event, recordDate=event, paymentDate=(self.dates["event"] + timedelta(days=7)).isoformat()))
        raw = b"[]" if options["kind"] == "splits" or options["symbol"] == "BND.US" else div_archive(*records)
        receipt = {"schema_version": eodhd_sources.receiver.TRANSPORT_VERSION, "url_without_credentials": action_url(**parameters), "request": parameters,
            "started_at": self.at, "completed_at": self.at, "retrieved_at": self.at, "http_status": 200,
            "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw), "redirects_followed": 0,
            "response_format": "utf8_json_identity", "credential_in_receipt": False}
        return {"schema_version": eodhd_sources.receiver.VERSION, "raw": raw, "receipt": receipt,
            "draft": parse_eodhd_actions(raw, **parameters, retrieved_at=self.at)}


def collect(db, dates, issuer_id, at, *, updated):
    old, event = dates["old"], dates["event"]
    records = [row("987.1234", exDividendDate=old.isoformat(), recordDate=old.isoformat(), payableDate=(old + timedelta(days=7)).isoformat())]
    if updated: records.append(row("4.32109", exDividendDate=event.isoformat(), recordDate=event.isoformat(), payableDate=(event + timedelta(days=7)).isoformat()))
    issuer = IssuerCollector(at=at, raw=archive(*records))
    end = instant(at).astimezone(ZONE).date(); start = end - timedelta(days=364)
    milliseconds, clock, parse_time = issuer_sources._milliseconds, issuer_sources._clock, issuer_sources.instant
    with patch.object(issuer_sources.receiver, "collect_vanguard_distribution_draft", side_effect=issuer), \
            patch.object(issuer_sources, "_milliseconds", side_effect=lambda value=None: milliseconds(at if value is None else value)), \
            patch.object(issuer_sources, "_clock", side_effect=lambda value=None: clock(at if value is None else value)), \
            patch.object(issuer_sources, "instant", side_effect=lambda value=None: parse_time(at if value is None else value)):
        result = issuer_sources.collect_issuer_draft(db, "w", "owner", issuer_id, sha256(("fictional-issuer:" + at).encode()).hexdigest()[:32],
            start.isoformat(), end.isoformat())
    assert result["status"] == "captured", result
    collector = ActionCollector(at, dates, updated)
    with patch.dict("os.environ", {"WORKBENCH_EODHD_ENABLED": "1"}), patch.object(eodhd_sources.receiver, "collect_eodhd_action_draft", side_effect=collector):
        queued = eodhd_sources.discover_eodhd_requests(db, now=at)
        assert len(queued) == 4
        for _ in queued:
            result = run_one(db, "fictional-current-action-source", lambda job, lease: eodhd_sources.prepare_eodhd_capture(db, job, lease, clock=lambda: at),
                job_type=eodhd_sources.JOB_TYPE, lease_seconds=180, clock=lambda: at)
            assert result["status"] == "succeeded", result
    assert issuer.calls == 1 and collector.calls == 4
    return {"issuer": 1, "eodhd": 4}


def prepare(db, at):
    assert not db.execute("SELECT 1 FROM investor_workspaces").fetchone()
    dates = timeline(at); seed = day_at(dates["seed"], 12); registered = day_at(dates["seed"] - timedelta(days=1), 12)
    expiry = stamp(instant(at) + timedelta(days=30))
    db.execute("INSERT INTO investor_workspaces VALUES('w','owner',0,?)", (registered,))
    def reviewed(kind, facts, name):
        source = data_evidence.store_source(db, "w", "owner", kind, {"title": "FICTIONAL current HTTP " + name,
            "reference": "synthetic://current-action-http/" + name, "excerpt": "Invented source, not provider or tax certification"}, now=registered)
        return data_evidence.review_source(db, "w", "owner", source["id"], "approved", facts, "Fictional isolated acceptance only", expiry, now=registered)
    listing = reviewed("listing", {"listing_id": "synthetic-current-3141", "provider_symbol": "VT.US", "market": "US", "currency": "USD",
        "quantity_step": "1", "tradable_from": "2020-01-01T00:00:00Z", "tradable_until": None, "product_type": "ETF", "leveraged": False,
        "inverse": False, "role": "growth", "fee_rate": "0.001", "fee_as_of": registered[:10],
        "economic_exposure": "Fictional test exposure", "historical_universe_basis": "retrospectively_selected_not_survivorship_free"}, "listing")
    old = dates["old"]
    base = reviewed("actions", {"listing_id": "synthetic-current-3141", "range_start": (dates["seed"] - timedelta(days=364)).isoformat(),
        "range_end": (old + timedelta(days=7)).isoformat(), "coverage": "reviewed_complete", "tax_assumption": "FICTIONAL explicit test tax assumption",
        "events": [{"id": "fictional-current-old-dividend", "listing_id": "synthetic-current-3141", "type": "dividend", "at": day_at(old, 10),
            "published_at": day_at(old - timedelta(days=1), 10), "pay_at": day_at(old + timedelta(days=7), 16), "gross_per_unit": "987.1234",
            "tax_per_unit": "98.71234", "source_evidence": "synthetic://current-action-http/old-event"}]}, "baseline")
    issuer = issuer_sources.register_authority(db, "w", "owner", issuer_policy(fund_id="3141", valid_from=registered, valid_until=expiry), now=registered)
    issuer_sources.set_authority_enabled(db, "w", "owner", issuer["id"], True, now=registered)
    eodhd = eodhd_sources.register_authority(db, "w", "owner", eodhd_policy(valid_from=registered, valid_until=expiry), now=registered)
    eodhd_sources.set_authority_enabled(db, "w", "owner", eodhd["id"], True, now=registered)
    calls = collect(db, dates, issuer["id"], seed, updated=False)
    refs = {}
    for kind in ("issuer", "dividends", "splits"):
        capture = db.execute("SELECT * FROM investor_issuer_captures").fetchone() if kind == "issuer" else db.execute(
            "SELECT c.* FROM investor_eodhd_captures c JOIN investor_eodhd_requests r ON r.id=c.request_id WHERE r.kind=? AND r.symbol='VT.US'",
            ("div" if kind == "dividends" else "splits",)).fetchone()
        refs[kind] = {"capture_id": capture["id"], "capture_hash": capture["content_hash"]}
    preview = managed_actions.preview_authority(db, "w", "owner", base["id"], listing["id"], refs, now=seed)
    policy = {"schema_version": "investor-action-maintenance-policy-v1", **{key: preview[key] for key in
        ("listing_id", "provider_symbol", "base_review_id", "base_review_hash", "listing_review_id", "listing_review_hash", "anchor_captures", "anchor_binding_hash")},
        "valid_from": seed, "valid_until": preview["maximum_valid_until"], "timezone": "America/New_York", "run_after_hour": 1,
        "standing_rule_authorized": True, "registered_nominal_differences_accepted": True,
        "coverage_basis": "selected_two_source_reports_not_objective_absence", "additional_source_requests": 0,
        "tax_changes_permitted": False, "trading_permission": False, "raw_ai_sharing": False}
    authority = managed_actions.register_authority(db, "w", "owner", policy, now=seed)
    managed_actions.set_authority_enabled(db, "w", "owner", authority["id"], True, now=seed)
    published = managed_actions.publish_current_actions(db, now=seed)
    assert len(published) == 1 and published[0]["status"] == "published", published
    return {"source_calls": calls, "fixture": "fictional_retained_sources", "real_provider_called": False}


def reports(db, at):
    if instant(at).astimezone(ZONE).hour < 1: raise WorkbenchError("FICTIONAL_ACCEPTANCE_REQUIRES_NY_AFTER_01")
    issuer = db.execute("SELECT id FROM investor_issuer_authorities WHERE workspace_id='w'").fetchall(); assert len(issuer) == 1
    dates = timeline(at)
    calls = collect(db, dates, issuer[0][0], at, updated=True)
    published = managed_actions.publish_current_actions(db, now=at)
    assert len(published) == 1 and published[0]["status"] == "blocked", published
    return {"source_calls": calls, "new_event_date": dates["event"].isoformat(), "effective_at": day_at(dates["event"], 10),
        "payment_at": day_at(dates["event"] + timedelta(days=7), 16), "real_provider_called": False}


def recovery_reports(db, at):
    if instant(at).astimezone(ZONE).hour < 1: raise WorkbenchError("FICTIONAL_ACCEPTANCE_REQUIRES_NY_AFTER_01")
    dates = timeline(at); failed_at = day_at(instant(at).astimezone(ZONE).date() - timedelta(days=1), 12)
    registered = day_at(dates["seed"], 12)
    issuer = db.execute("SELECT * FROM investor_issuer_authorities WHERE workspace_id='w'").fetchone()
    policy = {"schema_version": "investor-issuer-schedule-policy-v1", "authority_id": issuer["id"], "authority_hash": issuer["content_hash"],
        "lookback_days": 365, "run_after_hour": 1, "timezone": "America/New_York", "valid_from": registered,
        "valid_until": json.loads(issuer["document_json"])["valid_until"], "standing_collection_authorized": True,
        "collection_scope": "unapproved_distribution_draft_only", "automatic_retry_permitted": False}
    schedule = issuer_schedule.register_schedule(db, "w", "owner", policy, now=registered)
    issuer_schedule.set_schedule_enabled(db, "w", "owner", schedule["id"], True, now=registered)
    issuer_schedule.discover_issuer_requests(db, now=failed_at)
    with patch.object(issuer_sources.receiver, "collect_vanguard_distribution_draft", side_effect=WorkbenchError("FICTIONAL_TRANSPORT_FAILURE")) as collector:
        failed = run_one(db, "fictional-current-recovery-failure", lambda job, lease: issuer_schedule.prepare_issuer_capture(
            db, job, lease, clock=lambda: failed_at), job_type=issuer_schedule.JOB_TYPE, lease_seconds=180, clock=lambda: failed_at)
    collector.assert_called_once(); assert (failed["status"], failed["attempt_count"], failed["max_attempts"]) == ("failed", 1, 1)
    publication = managed_actions.publish_current_actions(db, now=failed_at)
    assert len(publication) == 1 and publication[0]["failure_code"] == "SOURCE_CAPTURE_TERMINAL_FAILURE", publication
    calls = collect(db, dates, issuer["id"], at, updated=False)
    return {"source_calls": calls, "failed_job_id": failed["id"], "failed_publication_id": publication[0]["publication_id"], "real_provider_called": False}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--db", required=True); parser.add_argument("--stage", choices=("prepare", "reports", "recovery", "work", "tick", "withdraw"), required=True)
    args = parser.parse_args(); path = Path(args.db).resolve(strict=True)
    assert path.name == "workbench.db" and path.parent.parent == Path(tempfile.gettempdir()).resolve()
    assert path.parent.name.startswith(("etf-action-review-http-", "etf-browser-fixture-"))
    with patch("socket.create_connection", side_effect=AssertionError("NO_PROVIDER_NETWORK")), \
            patch("socket.getaddrinfo", side_effect=AssertionError("NO_PROVIDER_DNS")), \
            patch("worker.market.providers.eodhd_capture.read_private_token", side_effect=AssertionError("NO_CREDENTIAL_READ")), \
            patch("worker.market.providers.longport.read_private_credentials_file", side_effect=AssertionError("NO_CREDENTIAL_READ")):
        db = open_database(path)
        try:
            assert all(db.execute("SELECT count(*) FROM " + table).fetchone()[0] == 0 for table in FINANCE)
            at = stamp(datetime.now(timezone.utc))
            if args.stage == "prepare": result = prepare(db, at)
            elif args.stage == "reports": result = reports(db, at)
            elif args.stage == "recovery": result = recovery_reports(db, at)
            elif args.stage in ("work", "tick"):
                result = run_pending_once(db, "fictional-actual-clock-action-review")
                assert result is not None or args.stage == "tick", "EXPECTED_CORE_JOB"
                assert result is None or result["status"] == "succeeded", result
                result = {"status": "idle" if result is None else result["status"], "job_type": None if result is None else result["job_type"], "actual_clock": True}
            else:
                authority = db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchall(); assert len(authority) == 1
                eodhd_sources.set_authority_enabled(db, "w", "owner", authority[0][0], False, now=at)
                result = {"supplier_withdrawn": True, "real_provider_called": False}
            assert all(db.execute("SELECT count(*) FROM " + table).fetchone()[0] == 0 for table in FINANCE)
            print(canonical_json(result))
        finally: db.close()


if __name__ == "__main__": main()
