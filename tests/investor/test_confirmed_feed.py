"""Fictional reviewed calendars and callback transport, never provider qualification."""

from contextlib import ExitStack
from copy import deepcopy
from datetime import timedelta
import json
import sqlite3
import unittest
from unittest.mock import patch

from tests.investor import test_runtime as queue, test_data_pipeline as pipeline, test_monitor_data as fixtures
from tests.investor.confirmed_capture_fixture import FictionalReceiver
from worker.investor import confirmed_capture, confirmed_feed, monitor_admission
from worker.investor.data_evidence import review_source
from worker.market.providers import longport, longport_confirmed
from worker.orchestration.db import WorkbenchError, instant, stamp, open_database, canonical_json
from worker.investor.monitor_data import build_monitor_data
from worker.orchestration.jobs import claim_job, enqueue_job
from worker.orchestration.runtime import run_pending_once


SEED = "2026-01-02T12:05:03.000Z"
EARLY = "2026-01-04T06:55:00.000Z"
START = "2026-01-04T06:58:00.000Z"
END = "2026-01-04T07:01:02.000Z"
LATE = "2026-01-04T06:59:30.001Z"


class ConfirmedFeedTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance
    monitor_fixture = pipeline.DataPipelineCliTests.monitor_fixture

    def model(self, fixed=False, market="CN"):
        seed_at = SEED if market == "CN" else "2026-01-02T22:05:03.000Z"
        original = fixtures.InvestorMonitorDataTests.reviewed
        def extended(fixture, kind, facts, label):
            facts = deepcopy(facts)
            if kind in ("calendar", "actions"): facts["range_end"] = "2026-01-05"
            if kind == "calendar":
                for day in (4, 5):
                    close = instant(f"2026-01-{day:02d}T" + {"CN":"07", "HK":"08", "US":"21"}[market] + ":00:00.000Z")
                    facts["days"].append({"date": f"2026-01-{day:02d}", "kind": "full", "close_at": stamp(close),
                        "available_at": stamp(close + timedelta(minutes=1)), "settled_at": stamp(close + timedelta(days=1)),
                        "settlement_rule_known_at": "2025-12-01T00:00:00Z"})
            if kind == "fx":
                facts["monitor_series"] = {"authority_id":"fictional-feed-reference-series", "revision_policy":"append_only_no_restatements"}
            return original(fixture, kind, facts, label)
        with patch.object(fixtures, "NOW", seed_at), patch.object(fixtures.InvestorMonitorDataTests, "reviewed", extended):
            self.definition, windows, settings, self.refs = self.monitor_fixture(fixed_policy=fixed, confirmed_latest=True, market=market)
        self.seed = monitor_admission.admit_monitor_data(self.db, "w", "synthetic-investor", self.definition["model_id"], windows, settings, now=seed_at)
        self.assertEqual(run_pending_once(self.db, "fictional-seed-core", clock=lambda: seed_at)["status"], "succeeded")
        return self.seed

    def test_new_current_same_series_fx_after_callback_extends_the_saved_us_model(self):
        from worker.investor.data_evidence import store_source
        self.model(market="US")
        result,calls,_=self.watch(start="2026-01-04T20:58:00.000Z",end="2026-01-04T21:01:02.000Z")
        self.assertEqual((result["status"],calls),("succeeded",1))
        old=self.db.execute("SELECT r.* FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id WHERE s.kind='fx' AND json_extract(r.document_json,'$.facts.monitor_series') IS NOT NULL").fetchone()
        facts=deepcopy(json.loads(old["document_json"])["facts"])
        facts["rows"].append({"observed_at":"2026-01-04T20:00:00Z","assumed_available_at":"2026-01-04T20:01:00Z","value":"1.3"})
        at="2026-01-04T21:01:02.000Z"
        source=store_source(self.db,"w","synthetic-investor","fx",{"title":"FICTIONAL current FX","reference":"synthetic://feed/current-fx","excerpt":"Invented software fixture, not a supplier permission"},now=at)
        current=review_source(self.db,"w","synthetic-investor",source["id"],"approved",facts,"Fictional explicit append-only source review",fixtures.EXPIRY,now=at)
        run_pending_once(self.db,"fictional-fx-core",clock=lambda:at)
        admission=self.db.execute("SELECT * FROM investor_confirmed_feed_admissions").fetchone()
        self.assertEqual(admission["status"],"admitted")
        latest=self.db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE id=?",(admission["input_id"],)).fetchone()
        document=json.loads(latest["document_json"])
        fx_ids=[row["review_id"] for row in document["segments"][0]["snapshot"]["review_refs"] if row["review_id"] in (old["id"],current["id"])]
        self.assertEqual(fx_ids,[current["id"]]);self.assertEqual(document["settings"],json.loads(self.seed["document_json"])["settings"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_models").fetchone()[0],1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0],2)
        self.assert_no_finance()

    def watch(self, *, start=START, end=END, bars=None, during=None, stop_requested=None, late_failure=False):
        times = [start]
        def advance():
            times[0] = end
            if during: during()
        mock = FictionalReceiver(now=start, received_at=end, bars=bars, during=advance)
        millis, parse_time = confirmed_capture._milliseconds, confirmed_capture.instant
        with ExitStack() as stack:
            transport = stack.enter_context(patch.object(longport_confirmed, "collect_confirmed_days", side_effect=lambda request, **kwargs: mock(request, kwargs["stop_requested"])))
            stack.enter_context(patch.object(confirmed_capture, "_milliseconds", side_effect=lambda value=None: millis(times[0] if value is None else value)))
            stack.enter_context(patch.object(confirmed_capture, "instant", side_effect=lambda value=None: parse_time(times[0] if value is None else value)))
            stack.enter_context(patch.object(longport, "_collect_isolated", side_effect=AssertionError("NO_HISTORY_FALLBACK")))
            if late_failure:
                self.db.execute("CREATE TRIGGER fictional_feed_abort BEFORE INSERT ON investor_confirmed_feed_runs BEGIN SELECT RAISE(ABORT,'fictional late failure'); END")
            if late_failure:
                with self.assertRaisesRegex(WorkbenchError, "CONFIRMED_FEED_COMMIT_FAILED"):
                    run_pending_once(self.db, "fictional-listener", role="longport", clock=lambda: times[0], stop_requested=stop_requested)
                result = dict(self.db.execute("SELECT * FROM job_runs WHERE job_type=?", (confirmed_feed.JOB_TYPE,)).fetchone())
            else:
                result = run_pending_once(self.db, "fictional-listener", role="longport", clock=lambda: times[0], stop_requested=stop_requested)
        return result, mock.calls, transport.call_count

    def test_default_roles_wait_then_capture_admit_and_publish_both_model_versions(self):
        for fixed in (False, True):
            if fixed: self.setUp()
            self.model(fixed)
            with patch.object(longport_confirmed, "collect_confirmed_days") as sdk:
                self.assertIsNone(run_pending_once(self.db, "fictional-listener", role="longport", clock=lambda: EARLY))
                sdk.assert_not_called()
            request = self.db.execute("SELECT * FROM investor_confirmed_feed_requests").fetchone()
            spec = json.loads(request["document_json"])
            self.assertEqual(len(spec["targets"]), 2)
            self.assertEqual(spec["not_before"], "2026-01-04T06:58:00.000000Z")
            self.assertEqual(spec["latest_start"], "2026-01-04T06:59:30.000000Z")
            self.assertEqual(spec["stop_at"], "2026-01-04T07:03:00.000000Z")
            result, calls, _ = self.watch()
            self.assertEqual(result["status"], "succeeded", result)
            self.assertEqual(calls, 1)
            self.assertEqual(self.db.execute("SELECT status FROM investor_confirmed_feed_runs").fetchone()[0], "complete")
            with patch.object(longport_confirmed, "collect_confirmed_days") as sdk:
                self.assertEqual(run_pending_once(self.db, "fictional-core", clock=lambda: END)["status"], "succeeded")
                sdk.assert_not_called()
            admission = self.db.execute("SELECT * FROM investor_confirmed_feed_admissions").fetchone()
            self.assertEqual(admission["status"], "admitted")
            self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 2)
            source = self.db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE id=?", (admission["input_id"],)).fetchone()
            snapshot = json.loads(source["document_json"])["segments"][0]["snapshot"]
            self.assertEqual((snapshot["range_start"], snapshot["range_end"]), ("2026-01-01", "2026-01-04"))
            self.assertEqual(len(snapshot["capture_refs"]), 5)
            self.assertIsNone(run_pending_once(self.db, "fictional-listener", role="longport", clock=lambda: END))
            self.assertIsNone(run_pending_once(self.db, "fictional-core", clock=lambda: END))
            self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_feed_requests").fetchone()[0], 1)
            self.assert_no_finance()

    def test_late_start_is_once_only_missed_with_no_sdk_and_no_new_input(self):
        self.model()
        result, calls, transport = self.watch(start=LATE, end=LATE)
        self.assertEqual((result["status"], calls, transport), ("skipped", 0, 0), result)
        self.assertEqual(self.db.execute("SELECT status FROM investor_confirmed_feed_runs").fetchone()[0], "missed_window")
        self.assertEqual(confirmed_feed.admit_completed_feeds(self.db, now=LATE), 0)
        self.assertIsNone(run_pending_once(self.db, "fictional-listener", role="longport", clock=lambda: END))
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_captures").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 1)
        self.assert_no_finance()

    def test_partial_and_empty_receipts_do_not_admit_or_checkpoint(self):
        for bars, status in ((1, "partial"), (0, "no_confirmed_events")):
            if bars == 0: self.setUp()
            self.model()
            result, calls, _ = self.watch(bars=bars)
            self.assertEqual((result["status"], calls), ("partial", 1), result)
            self.assertEqual(self.db.execute("SELECT status FROM investor_confirmed_feed_runs").fetchone()[0], status)
            self.assertEqual(confirmed_feed.admit_completed_feeds(self.db, now=END), 0)
            self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 1)
            self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 1)
            self.assert_no_finance()

    def test_closed_day_does_not_schedule_and_missing_calendar_is_explicit_gap(self):
        self.model()
        self.assertEqual(confirmed_feed.discover_confirmed_watches(self.db, now="2026-01-03T06:58:00.000Z"), [])
        self.assertEqual(confirmed_feed.discover_confirmed_watches(self.db, now="2026-01-06T06:58:00.000Z"), [])
        gap = self.db.execute("SELECT payload_json FROM outbox WHERE topic='investor.confirmed_feed_source_gap'").fetchone()
        self.assertEqual(json.loads(gap[0])["code"], "CONFIRMED_FEED_SOURCE_GAP")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_feed_requests").fetchone()[0], 0)
        self.assert_no_finance()

    def test_late_metadata_failure_rolls_back_receipt_payload_run_and_audit(self):
        self.model()
        result, calls, _ = self.watch(late_failure=True)
        self.assertEqual((result["status"], calls), ("failed", 1), result)
        for table, expected in (("investor_confirmed_captures", 2), ("investor_confirmed_payloads", 2), ("investor_confirmed_feed_runs", 0)):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], expected)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_complete_confirmed_feed'").fetchone()[0], 0)
        self.assertIsNone(run_pending_once(self.db, "fictional-listener", role="longport", clock=lambda: END))
        self.assert_no_finance()

    def test_withdrawal_during_io_never_persists_a_callback_receipt(self):
        self.model()
        def withdraw():
            review_source(self.db, "w", "synthetic-investor", self.refs[0]["rights"]["source_id"], "withdrawn", None,
                "Fictional withdrawal", fixtures.EXPIRY, now=END)
        result, calls, _ = self.watch(during=withdraw)
        self.assertEqual((result["status"], calls), ("failed", 1), result)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_captures").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT status FROM investor_confirmed_feed_runs").fetchone()[0], "transport_failed")
        self.assertEqual(confirmed_feed.admit_completed_feeds(self.db, now=END), 0)
        self.assert_no_finance()

    def test_sdk_mutex_reserves_window_and_crashed_watch_never_retries(self):
        self.model()
        confirmed_feed.discover_confirmed_watches(self.db, now=EARLY)
        history = enqueue_job(self.db, "market_collect_prices", "fictional-history", "fixture", "1", now=EARLY)
        enqueue_job(self.db, "investor_current_fx", "fictional-reference", "fixture", "1", max_attempts=1, now=EARLY)
        enqueue_job(self.db, "investor_issuer_capture", "fictional-issuer", "fixture", "1", max_attempts=1, now=EARLY)
        reserved = "2026-01-04T06:56:00.000Z"
        self.assertIsNone(claim_job(self.db, "history", job_type="market_collect_prices", now=reserved))
        self.assertIsNone(claim_job(self.db, "reference", job_type="investor_current_fx", now=reserved))
        self.assertIsNone(claim_job(self.db, "issuer", job_type="investor_issuer_capture", now=reserved))
        lease = claim_job(self.db, "watch", lease_seconds=300, job_type=confirmed_feed.JOB_TYPE, now=START)
        self.assertIsNotNone(lease)
        second = open_database(self.path)
        self.addCleanup(second.close)
        self.assertIsNone(claim_job(second, "history", job_type="market_collect_prices", now=START))
        self.assertIsNone(claim_job(second, "watch-2", job_type=confirmed_feed.JOB_TYPE, now=START))
        expired = "2026-01-04T07:03:00.001Z"
        self.assertIsNone(claim_job(second, "watch-3", job_type=confirmed_feed.JOB_TYPE, now=expired))
        watched = self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()
        self.assertEqual((watched["status"], watched["attempt_count"], watched["max_attempts"]), ("failed", 1, 1))
        self.assertIsNotNone(claim_job(second, "history", job_type="market_collect_prices", now=expired))
        self.assertIsNotNone(claim_job(second, "issuer", job_type="investor_issuer_capture", now=expired))
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_feed_runs").fetchone()[0], 0)
        self.assert_no_finance()

    def test_immutable_metadata_and_cross_workspace_request_fail_closed(self):
        self.model(); confirmed_feed.discover_confirmed_watches(self.db, now=EARLY)
        request = self.db.execute("SELECT * FROM investor_confirmed_feed_requests").fetchone()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE investor_confirmed_feed_requests SET market='HK' WHERE id=?", (request["id"],))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM investor_confirmed_feed_requests WHERE id=?", (request["id"],))
        with self.assertRaises(WorkbenchError): confirmed_feed.request_header(self.db, "foreign", request["id"], START)
        with self.assertRaises(WorkbenchError): confirmed_feed.request_header(self.db, "w", request["id"], SEED)
        self.assert_no_finance()

    def test_pause_after_prepare_suppresses_commit_and_cannot_reuse_old_control(self):
        self.model()
        original = confirmed_capture.prepare_confirmed_prices
        def pause(*args, **kwargs):
            prepared = original(*args, **kwargs)
            self.db.execute("INSERT INTO investor_model_controls VALUES('paused','w','fictional-monitor',2,0,'synthetic-investor','monitor-select-audit',?)", (END,))
            return prepared
        with patch.object(confirmed_capture, "prepare_confirmed_prices", side_effect=pause):
            result, calls, _ = self.watch()
        self.assertEqual((result["status"], calls), ("skipped", 1), result)
        self.assertEqual(self.db.execute("SELECT status FROM investor_confirmed_feed_runs").fetchone()[0], "superseded")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_captures").fetchone()[0], 2)
        self.assertEqual(confirmed_feed.admit_completed_feeds(self.db, now=END), 0)
        self.assert_no_finance()

    def test_expired_lease_suppresses_all_callback_writes_and_exhausts_single_attempt(self):
        self.model()
        expired = "2026-01-04T07:04:00.000Z"
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            self.watch(end=expired)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_captures").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_feed_runs").fetchone()[0], 0)
        self.assertIsNone(claim_job(self.db, "fictional-recovery", job_type=confirmed_feed.JOB_TYPE, now=expired))
        job = self.db.execute("SELECT status,attempt_count,max_attempts FROM job_runs WHERE job_type=?", (confirmed_feed.JOB_TYPE,)).fetchone()
        self.assertEqual(tuple(job), ("failed", 1, 1))
        self.assert_no_finance()

    def test_withdrawal_after_capture_blocks_admission_without_breaking_default_core(self):
        self.model(); self.assertEqual(self.watch()[0]["status"], "succeeded")
        review_source(self.db, "w", "synthetic-investor", self.refs[0]["rights"]["source_id"], "withdrawn", None,
            "Fictional post-capture withdrawal", fixtures.EXPIRY, now=END)
        with patch.object(longport_confirmed, "collect_confirmed_days") as sdk:
            self.assertEqual(run_pending_once(self.db, "fictional-core", clock=lambda: END)["status"], "succeeded")
            sdk.assert_not_called()
        self.assertEqual(self.db.execute("SELECT status FROM investor_confirmed_feed_admissions").fetchone()[0], "blocked")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_payloads").fetchone()[0], 0)
        self.assert_no_finance()

    def test_malformed_request_error_is_fixed_and_never_reaches_sdk_or_logs_caller_bytes(self):
        self.model(); confirmed_feed.discover_confirmed_watches(self.db, now=EARLY)
        row = self.db.execute("SELECT * FROM investor_confirmed_feed_requests").fetchone()
        malformed = json.loads(row["document_json"]); malformed["untrusted"] = "FICTIONAL_SENSITIVE_SENTINEL"
        self.db.execute("DROP TRIGGER investor_confirmed_feed_request_update")
        self.db.execute("UPDATE investor_confirmed_feed_requests SET document_json=? WHERE id=?", (canonical_json(malformed), row["id"]))
        with patch.object(longport_confirmed, "collect_confirmed_days") as sdk, self.assertRaisesRegex(WorkbenchError, "^CONFIRMED_FEED_BINDING_INVALID$"):
            run_pending_once(self.db, "fictional-listener", role="longport", clock=lambda: START)
        sdk.assert_not_called()
        result = self.db.execute("SELECT result_json FROM job_runs WHERE job_type=?", (confirmed_feed.JOB_TYPE,)).fetchone()[0]
        self.assertNotIn("FICTIONAL_SENSITIVE_SENTINEL", result)
        self.assertEqual(json.loads(result)["message"], "CONFIRMED_FEED_BINDING_INVALID")
        self.assert_no_finance()

    def test_read_only_mode_prevents_discovery_before_any_sdk_call(self):
        self.model()
        with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}), patch.object(longport_confirmed, "collect_confirmed_days") as sdk, \
                self.assertRaisesRegex(WorkbenchError, "WORKBENCH_READ_ONLY"):
            run_pending_once(self.db, "fictional-listener", role="longport", clock=lambda: START)
        sdk.assert_not_called()
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_feed_requests").fetchone()[0], 0)
        self.assert_no_finance()

    def test_planner_uses_each_reviewed_market_close_not_a_shared_utc_cron(self):
        original = fixtures.InvestorMonitorDataTests.reviewed
        def extended(fixture, kind, facts, label):
            facts = deepcopy(facts)
            if kind in ("calendar", "actions"): facts["range_end"] = "2026-01-04"
            if kind == "calendar":
                close = instant(facts["days"][0]["close_at"]) + timedelta(days=3)
                facts["days"].append({"date": "2026-01-04", "kind": "half" if facts["market"] == "HK" else "full", "close_at": stamp(close),
                    "available_at": stamp(close + timedelta(minutes=1)), "settled_at": stamp(close + timedelta(days=1)),
                    "settlement_rule_known_at": "2025-12-01T00:00:00Z"})
            return original(fixture, kind, facts, label)
        fixture = fixtures.InvestorMonitorDataTests(); fixture.db = self.db
        with patch.object(fixtures, "NOW", SEED), patch.object(fixtures.InvestorMonitorDataTests, "reviewed", extended):
            definition, windows, settings, _ = fixture.fixture(confirmed_latest=True)
        result = build_monitor_data(self.db, "w", definition, windows, settings, now=SEED)
        for market, hour in (("CN", 7), ("HK", 8), ("US", 20)):
            spec = confirmed_feed.market_plan(self.db, "w", {"id": definition["model_id"], "content_hash": "a" * 64}, definition,
                {"id": "fictional-control"}, {"id": "fictional-input", "content_hash": "b" * 64}, result["document"], result, market, "2026-01-04", EARLY)
            self.assertEqual(spec["not_before"], f"2026-01-04T{hour - 1:02d}:58:00.000000Z")
            self.assertEqual(spec["stop_at"], f"2026-01-04T{hour:02d}:03:00.000000Z")
            self.assertEqual(len(spec["targets"]), 1)
        self.assert_no_finance()


if __name__ == "__main__": unittest.main()
