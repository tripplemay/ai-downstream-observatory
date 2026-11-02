"""Actual first-close job lifecycle on invented retained authorities only."""

from copy import deepcopy
from datetime import timedelta
import json
import sqlite3
import unittest
from unittest.mock import patch

from tests.investor import evidence_fixture, test_initial_prices as history, test_monitor_data as data
from tests.investor.confirmed_capture_fixture import FictionalReceiver
from worker.investor import confirmed_capture, confirmed_feed, initial_close, initial_prices
from worker.investor.data_evidence import review_source
from worker.orchestration.db import WorkbenchError, instant, stamp, open_database
from worker.orchestration.jobs import claim_job, complete_job, enqueue_job
from worker.orchestration.runtime import run_pending_once
from worker.market.providers import longport, longport_confirmed

EARLY = "2026-01-04T06:55:00.000Z"
START = "2026-01-04T06:58:00.000Z"
END = "2026-01-04T07:01:02.000Z"
LATE = "2026-01-04T06:59:30.001Z"


class InitialCloseTests(unittest.TestCase):
    setUp = history.InitialPriceTests.setUp
    model = history.InitialPriceTests.model
    monitor_fixture = history.InitialPriceTests.monitor_fixture
    assert_no_finance = history.InitialPriceTests.assert_no_finance

    def prepare(self, fixed=True, market="CN"):
        original = evidence_fixture.review_source
        def extended(db, workspace, actor, source_id, decision, facts, *args, **kwargs):
            kind = db.execute("SELECT kind FROM investor_data_sources WHERE id=?", (source_id,)).fetchone()[0]
            facts = deepcopy(facts)
            if facts is not None and kind in ("calendar", "actions"):
                old_end = facts["range_end"]
                facts["range_end"] = "2026-01-05"
                if kind == "calendar":
                    day = instant(old_end + "T00:00:00Z").date() + timedelta(days=1)
                    while day.isoformat() <= "2026-01-05":
                        value = {"date": day.isoformat(), "kind": "closed", "close_at": None, "available_at": None,
                            "settled_at": None, "settlement_rule_known_at": None}
                        if day.isoformat() in ("2026-01-01", "2026-01-02", "2026-01-04", "2026-01-05"):
                            close = instant(day.isoformat() + {"CN":"T07", "HK":"T08", "US":"T21"}[market] + ":00:00.000Z")
                            value.update(kind="full", close_at=stamp(close), available_at=stamp(close + timedelta(minutes=1)),
                                settled_at=stamp(close + timedelta(days=1)), settlement_rule_known_at="2024-12-01T00:00:00Z")
                        facts["days"].append(value); day += timedelta(days=1)
            if facts is not None and kind == "fx":
                facts["monitor_series"] = {"authority_id": "fictional-initial-close-" + facts["currency"], "revision_policy": "append_only_no_restatements"}
            return original(db, workspace, actor, source_id, decision, facts, *args, **kwargs)
        original_create, retained = evidence_fixture.create, {}
        def create(*args, **kwargs):
            result = original_create(*args, **{**kwargs, "initial_monitor_calendar": market == "CN", "research_market": market})
            retained.update(result); return result
        with patch.object(evidence_fixture, "review_source", side_effect=extended), patch.object(evidence_fixture, "create", side_effect=create), \
                patch.object(data.InvestorMonitorDataTests, "fixture", return_value=(None, [], None, [])):
            self.model(fixed, positive_tolerance=True)
        self.refs = [{"rights": retained["rights"], "listing": listing} for listing in retained["listings"]]
        self.enterContext(patch.object(longport, "_collect_isolated", side_effect=AssertionError("NO_HISTORY_FALLBACK")))
        self.enterContext(patch.object(longport, "_credentials", side_effect=AssertionError("NO_REAL_CREDENTIALS")))
        self.enterContext(patch.object(longport, "read_private_credentials_file", side_effect=AssertionError("NO_REAL_CREDENTIAL_FILE")))
        # Original historical sessions are consumed via real claim/expiry, never
        # reset or marked successful. This mirrors the production bootstrap gap.
        self.assertEqual(len(initial_prices.discover_initial_prices(self.db, now=history.NOW)), 2)
        for offset in (0, 2, 4):
            at = stamp(instant(history.NOW) + timedelta(seconds=offset))
            lease = claim_job(self.db, "fictional-expired-history", 1, initial_prices.JOB_TYPE, now=at)
            self.assertEqual(lease is not None, offset != 4)
        self.assertEqual(self.db.execute("SELECT count(*) FROM job_runs WHERE job_type=? AND status='failed'", (initial_prices.JOB_TYPE,)).fetchone()[0], 2)

    def test_reviewed_foreign_market_closes_and_independent_current_fx_reach_first_core_checkpoint(self):
        from worker.investor.data_evidence import store_source
        for market, hour in (("HK", "08"), ("US", "21")):
            with self.subTest(market=market):
                if market == "US": self.setUp()
                self.prepare(market=market)
                early = f"2026-01-04T{int(hour)-1:02d}:55:00.000Z"
                self.assertEqual(len(initial_close.discover_initial_closes(self.db, now=early)), 1)
                request = json.loads(self.db.execute("SELECT document_json FROM investor_initial_close_requests").fetchone()[0])
                self.assertEqual(request["market"], market); self.assertEqual(request["stop_at"], f"2026-01-04T{hour}:03:00.000000Z")
                start, end = f"2026-01-04T{int(hour)-1:02d}:58:00.000Z", f"2026-01-04T{hour}:01:02.000Z"
                result, calls, _ = self.watch(start=start, end=end); self.assertEqual((result["status"], calls), ("succeeded", 1))
                for row in self.db.execute("SELECT r.document_json FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id WHERE s.kind='fx'").fetchall():
                    facts = deepcopy(json.loads(row[0])["facts"])
                    observed = instant(end) - timedelta(minutes=30)
                    facts["rows"].append({"observed_at": stamp(observed), "assumed_available_at": stamp(observed + timedelta(minutes=1)), "value": "1.3"})
                    source = store_source(self.db, "w", "synthetic-investor", "fx", {"title":"FICTIONAL current FX",
                        "reference":"synthetic://first-close/fx/"+market,"excerpt":"Invented current reference, not real provider permission"}, now=end)
                    review_source(self.db,"w","synthetic-investor",source["id"],"approved",facts,"Fictional append-only current reference",data.EXPIRY,now=end)
                self.assertEqual(run_pending_once(self.db,"fictional-foreign-first-core",clock=lambda:end)["status"],"succeeded")
                self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0],1)
                self.assert_no_finance()

    def watch(self, *, start=START, end=END, bars=None, during=None, binding_at=None, requests=None, poll_transport=False):
        times = [start]
        def advance():
            times[0] = end
            if during: during()
        mock = FictionalReceiver(now=start, received_at=end, bars=bars, during=advance)
        original_binding = confirmed_capture._bindings
        def binding(*args, **kwargs):
            value = original_binding(*args, **kwargs)
            if binding_at is not None and kwargs.get("watch_seconds") is not None:
                times[0] = binding_at; mock.now = binding_at
            return value
        def collect(request, **kwargs):
            if requests is not None: requests.append(request)
            if poll_transport:
                for seconds in (100, 200, 300):
                    tick = instant(start) + timedelta(seconds=seconds)
                    if tick >= instant(end): break
                    times[0] = stamp(tick); self.assertFalse(kwargs["stop_requested"]())
            return mock(request, kwargs["stop_requested"])
        millis, parse_time = confirmed_capture._milliseconds, confirmed_capture.instant
        with patch.object(longport_confirmed, "collect_confirmed_days", side_effect=collect) as transport, \
                patch.object(confirmed_capture, "_bindings", side_effect=binding), \
                patch.object(confirmed_capture, "_milliseconds", side_effect=lambda value=None: millis(times[0] if value is None else value)), \
                patch.object(confirmed_capture, "instant", side_effect=lambda value=None: parse_time(times[0] if value is None else value)):
            result = run_pending_once(self.db, "fictional-first-close", role="longport", clock=lambda: times[0])
        return result, mock.calls, transport.call_count

    def test_actual_io_boundary_rejects_a_start_window_consumed_by_validation_and_shrinks_remaining_watch(self):
        self.prepare()
        result, calls, transport = self.watch(binding_at=LATE)
        self.assertEqual((result["status"], calls, transport), ("skipped", 0, 0))
        self.assertEqual(self.db.execute("SELECT status FROM investor_initial_close_runs").fetchone()[0], "missed_window")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_captures").fetchone()[0], 0)
        self.setUp(); self.prepare(); requests = []
        result, calls, _ = self.watch(binding_at="2026-01-04T06:58:10.000Z", requests=requests)
        self.assertEqual((result["status"], calls), ("succeeded", 1)); self.assertEqual(requests[0]["watch_seconds"], 290)
        self.assert_no_finance()

    def test_default_roles_first_close_bootstraps_then_ordinary_next_close_continues_without_replaying_history(self):
        self.prepare()
        with patch.object(longport_confirmed, "collect_confirmed_days") as sdk:
            self.assertIsNone(run_pending_once(self.db, "fictional-first-discovery", role="longport", clock=lambda: EARLY))
        sdk.assert_not_called()
        request = self.db.execute("SELECT * FROM investor_initial_close_requests").fetchone()
        self.assertIsNotNone(request); self.assertEqual(request["session_date"], "2026-01-04")
        self.assertEqual(len(json.loads(request["document_json"])["targets"]), 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 0)
        before = {table: [tuple(row) for row in self.db.execute("SELECT rowid,* FROM " + table)] for table in
            ("investor_models", "investor_initial_price_requests", "investor_initial_price_runs")}
        result, calls, transport = self.watch(); self.assertEqual((result["status"], calls, transport), ("succeeded", 1, 1))
        self.assertEqual(self.db.execute("SELECT status FROM investor_initial_close_runs").fetchone()[0], "complete")
        self.assertEqual(run_pending_once(self.db, "fictional-first-core", clock=lambda: END)["status"], "succeeded")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 1)
        source = json.loads(self.db.execute("SELECT document_json FROM investor_monitor_evidence_inputs").fetchone()[0])
        self.assertEqual(source["schema_version"], "investor-monitor-data-input-v4")
        self.assertTrue(all(ref["kind"] == "confirmed_sdk" for ref in source["segments"][0]["snapshot"]["capture_refs"]))
        self.assertEqual(source["segments"][0]["snapshot"]["range_start"], "2026-01-04")
        result, calls, _ = self.watch(start="2026-01-05T06:58:00.000Z", end="2026-01-05T07:01:02.000Z")
        self.assertEqual((result["status"], calls), ("succeeded", 1))
        self.assertEqual(run_pending_once(self.db, "fictional-next-core", clock=lambda: "2026-01-05T07:01:02.000Z")["status"], "succeeded")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_close_requests").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_feed_requests").fetchone()[0], 1)
        self.assertEqual(before, {table: [tuple(row) for row in self.db.execute("SELECT rowid,* FROM " + table)] for table in before})
        self.assert_no_finance()

    def test_partial_empty_and_missed_session_never_fall_back_to_history_or_repeat_the_listener(self):
        for bars, start, expected in ((1, START, "partial"), (0, START, "no_confirmed_events"), (None, LATE, "missed_window")):
            with self.subTest(expected=expected):
                if expected != "partial": self.setUp()
                self.prepare(); result, calls, _ = self.watch(start=start, bars=bars)
                self.assertEqual(calls, 0 if expected == "missed_window" else 1)
                self.assertEqual(self.db.execute("SELECT status FROM investor_initial_close_runs").fetchone()[0], expected)
                with patch.object(longport_confirmed, "collect_confirmed_days") as sdk:
                    self.assertIsNone(run_pending_once(self.db, "fictional-no-second-close", role="longport", clock=lambda: END))
                    initial_prices.discover_initial_prices(self.db, now="2026-01-05T00:01:00.000Z")
                    self.assertIsNone(run_pending_once(self.db, "fictional-no-first-input", clock=lambda: END))
                sdk.assert_not_called()
                self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_price_requests").fetchone()[0], 2)
                self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_close_requests").fetchone()[0], 1)
                self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 0)
                self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 0)
                self.assert_no_finance()

    def test_first_listener_reserves_the_same_global_price_budget_before_its_window(self):
        self.prepare(); self.assertEqual(len(initial_close.discover_initial_closes(self.db, now=EARLY)), 1)
        enqueue_job(self.db, "market_collect_prices", "fictional-unused", "unused", "f" * 64, now=EARLY)
        self.assertIsNone(claim_job(self.db, "fictional-other-provider", 300, "market_collect_prices", now="2026-01-04T06:56:00.000Z"))
        self.assertIsNotNone(claim_job(self.db, "fictional-first-provider", 300, initial_close.JOB_TYPE, now=START))
        self.assertIsNone(claim_job(self.db, "fictional-parallel-provider", 300, "market_collect_prices", now=START))
        self.assert_no_finance()

    def test_discovery_has_no_writer_during_source_replay_and_concurrent_revocation_cannot_publish_the_old_plan(self):
        self.prepare(); second = open_database(self.path); self.addCleanup(second.close)
        second.execute("PRAGMA busy_timeout=0"); original = initial_prices._context; phases = []
        def withdrawn(*args, **kwargs):
            second.execute("BEGIN IMMEDIATE"); second.execute("ROLLBACK"); phases.append("writer_available")
            result = original(*args, **kwargs)
            review_source(second, "w", "synthetic-investor", self.refs[0]["rights"]["source_id"], "withdrawn", None,
                "Fictional concurrent source change", data.EXPIRY, now=EARLY)
            return result
        with patch.object(initial_prices, "_context", side_effect=withdrawn), patch.object(longport_confirmed, "collect_confirmed_days") as sdk:
            self.assertEqual(initial_close.discover_initial_closes(self.db, now=EARLY), [])
        self.assertEqual(phases, ["writer_available"]); sdk.assert_not_called()
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_close_requests").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_schedule_initial_close'").fetchone()[0], 0)
        self.assert_no_finance()

    def test_stop_after_request_audit_rolls_back_the_whole_discovery_before_job_registration(self):
        self.prepare(); before=list(self.db.iterdump()); stopped=[False]; original=initial_close._audit
        def audited(*args,**kwargs):
            result=original(*args,**kwargs);stopped[0]=True;return result
        with patch.object(initial_close,"_audit",side_effect=audited):
            with self.assertRaisesRegex(WorkbenchError,"WORKER_STOP_REQUESTED"):
                initial_close.discover_initial_closes(self.db,now=EARLY,stop_requested=lambda:stopped[0])
        self.assertEqual(list(self.db.iterdump()),before);self.assert_no_finance()

    def test_readonly_scope_and_immutable_request_metadata_do_not_reach_transport(self):
        self.prepare()
        reader = open_database(self.path, read_only=True); self.addCleanup(reader.close)
        with patch.object(longport_confirmed, "collect_confirmed_days") as sdk:
            with self.assertRaisesRegex(WorkbenchError, "WORKBENCH_READ_ONLY"):
                initial_close.discover_initial_closes(reader, now=EARLY)
        sdk.assert_not_called()
        self.assertEqual(len(initial_close.discover_initial_closes(self.db, now=EARLY)), 1)
        request = self.db.execute("SELECT * FROM investor_initial_close_requests").fetchone()
        with self.assertRaisesRegex(WorkbenchError, "INITIAL_CLOSE_BINDING_INVALID"):
            initial_close.request_header(self.db, "other-workspace", request["id"], EARLY)
        for sql in ("UPDATE investor_initial_close_requests SET market='US'", "DELETE FROM investor_initial_close_requests"):
            with self.assertRaises(sqlite3.IntegrityError): self.db.execute(sql)
        self.db.execute("DROP TRIGGER investor_initial_close_request_update")
        value = json.loads(request["document_json"]); value["caller_transport"] = "forbidden"
        self.db.execute("UPDATE investor_initial_close_requests SET document_json=?", (json.dumps(value),))
        with self.assertRaisesRegex(WorkbenchError, "INITIAL_CLOSE_BINDING_INVALID"):
            initial_close.request_header(self.db, "w", request["id"], START)
        self.assert_no_finance()

    def test_lease_expires_before_io_without_capture_or_a_replayable_second_attempt(self):
        self.prepare(); initial_close.discover_initial_closes(self.db, now=EARLY)
        lease = claim_job(self.db, "fictional-short-first-lease", 1, initial_close.JOB_TYPE, now=START)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        readings = iter((START, END)); clock = lambda: next(readings, END)
        with patch.object(longport_confirmed, "collect_confirmed_days") as sdk:
            with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
                initial_close.prepare_initial_close(self.db, job, lease, clock=clock)
        sdk.assert_not_called()
        self.assertIsNone(claim_job(self.db, "fictional-expired-first-no-retry", 300, initial_close.JOB_TYPE, now=END))
        self.assertEqual(self.db.execute("SELECT status FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()[0], "failed")
        self.assertEqual(initial_close.discover_initial_closes(self.db, now=END), [])
        for table in ("investor_initial_close_runs", "investor_confirmed_captures", "investor_monitor_evidence_inputs"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)
        self.assert_no_finance()

    def test_wrong_claimed_job_cannot_spend_the_first_close_request_budget(self):
        self.prepare(); initial_close.discover_initial_closes(self.db, now=EARLY)
        lease = claim_job(self.db, "fictional-bound-first-lease", 300, initial_close.JOB_TYPE, now=START)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        with patch.object(longport_confirmed, "collect_confirmed_days") as sdk:
            for change in ({"id":"other"},{"period":"other"},{"scope":"other"},{"input_version":"f"*64}):
                with self.assertRaisesRegex(WorkbenchError,"CONFIRMED_FEED_BINDING_INVALID"):
                    initial_close.prepare_initial_close(self.db,{**job,**change},lease,clock=lambda:START)
        sdk.assert_not_called(); self.assert_no_finance()

    def test_timely_receipt_survives_source_replay_after_network_window_but_not_late_transport(self):
        self.prepare(); initial_close.discover_initial_closes(self.db,now=EARLY)
        lease=claim_job(self.db,"fictional-post-window-replay",300,initial_close.JOB_TYPE,now=START)
        job=dict(self.db.execute("SELECT * FROM job_runs WHERE id=?",(lease.job_id,)).fetchone())
        times=[START];finished="2026-01-04T07:03:00.000Z";after="2026-01-04T07:03:45.000Z";original=initial_close._current;calls=[]
        def current(*args,**kwargs):
            value=original(*args,**kwargs);calls.append(1)
            if len(calls)==2:times[0]=after
            return value
        mock=FictionalReceiver(now=START,received_at=finished,during=lambda:times.__setitem__(0,finished))
        def collect(request,**kwargs):
            # Exercise ordinary heartbeats; a synthetic time jump must not turn
            # this network-window regression into the separate lease-expiry case.
            for seconds in (100,200):
                times[0]=stamp(instant(START)+timedelta(seconds=seconds));self.assertFalse(kwargs["stop_requested"]())
            return mock(request,kwargs["stop_requested"])
        millis,parse=confirmed_capture._milliseconds,confirmed_capture.instant
        with patch.object(initial_close,"_current",side_effect=current), \
                patch.object(longport_confirmed,"collect_confirmed_days",side_effect=collect), \
                patch.object(confirmed_capture,"_milliseconds",side_effect=lambda value=None:millis(times[0] if value is None else value)), \
                patch.object(confirmed_capture,"instant",side_effect=lambda value=None:parse(times[0] if value is None else value)):
            prepared=initial_close.prepare_initial_close(self.db,job,lease,clock=lambda:times[0],lease_seconds=300)
            complete_job(self.db,lease,None,effect=prepared["effect"],clock=lambda:times[0],now=finished)
        self.assertEqual(mock.calls,1);self.assertEqual(self.db.execute("SELECT status FROM investor_initial_close_runs").fetchone()[0],"complete")
        self.setUp();self.prepare()
        result,calls,_=self.watch(end="2026-01-04T07:03:30.001Z",poll_transport=True)
        self.assertEqual((result["status"],calls),("failed",1))
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_captures").fetchone()[0],0)
        self.assert_no_finance()

    def test_late_source_withdrawal_discards_first_close_and_preserves_original_consumed_attempts(self):
        self.prepare()
        def withdraw():
            review_source(self.db, "w", "synthetic-investor", self.refs[0]["rights"]["source_id"], "withdrawn", None,
                "Fictional withdrawal after the callback started", data.EXPIRY, now=END)
        result, calls, _ = self.watch(during=withdraw)
        self.assertEqual((result["status"], calls), ("failed", 1))
        self.assertEqual(self.db.execute("SELECT status FROM investor_initial_close_runs").fetchone()[0], "transport_failed")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_captures").fetchone()[0], 0)
        self.assert_no_finance()

    def test_late_run_failure_rolls_back_capture_payload_and_audit_without_retrying(self):
        self.prepare(); self.db.execute("CREATE TRIGGER fictional_first_close_abort BEFORE INSERT ON investor_initial_close_runs BEGIN SELECT RAISE(ABORT,'fictional late failure'); END")
        with self.assertRaisesRegex(WorkbenchError, "CONFIRMED_FEED_COMMIT_FAILED"): self.watch()
        for table in ("investor_initial_close_runs", "investor_confirmed_captures", "investor_confirmed_payloads"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_capture_confirmed_prices'").fetchone()[0], 0)
        self.assert_no_finance()


if __name__ == "__main__": unittest.main()
