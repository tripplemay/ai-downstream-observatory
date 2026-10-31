"""Fictional first monitoring-price jobs, no live SDK, licence or accounts."""

from datetime import datetime, timedelta
from decimal import Decimal
import json
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from tests.investor import test_monitor_bootstrap as bootstrap, test_monitor_data as monitor
from worker.investor import data_evidence, initial_prices
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, instant, stamp, open_database
from worker.orchestration.jobs import claim_job, complete_job
from worker.orchestration.runtime import run_pending_once, command_handler

NOW = monitor.NOW


class InitialPriceTests(unittest.TestCase):
    setUp = bootstrap.MonitorBootstrapTests.setUp
    assert_no_finance = bootstrap.MonitorBootstrapTests.assert_no_finance
    monitor_fixture = bootstrap.MonitorBootstrapTests.monitor_fixture
    model = bootstrap.MonitorBootstrapTests.model

    def prepare(self, fixed=False):
        from tests.investor import evidence_fixture
        create = evidence_fixture.create
        retained = {}
        def remember(*args, **kwargs):
            result = create(*args, **kwargs, initial_monitor_calendar=True); retained.update(result); return result
        # Extend invented source facts BEFORE research admission/freeze and do
        # not create the unrelated latest-price fixtures at all.
        with patch.object(evidence_fixture, "create", remember), \
                patch.object(monitor.InvestorMonitorDataTests, "fixture", return_value=(None, [], None, [])):
            self.model(fixed, positive_tolerance=True)
        self.refs = [{"rights": retained["rights"], "listing": listing} for listing in retained["listings"]]

    def transport(self, during=None):
        def collect(request):
            if during: during()
            rows = [{"timestamp": datetime.fromisoformat(day).replace(tzinfo=ZoneInfo(longport._MARKETS[request["mapping"]["market"]][0])),
                "open": Decimal("10"), "high": Decimal("12"), "low": Decimal("9"), "close": Decimal("11.25"),
                "turnover": Decimal("11250"), "volume": 1000, "trade_session": 0} for day in request["expected_dates"]]
            return longport._normalize(rows, request=request, sdk_version=longport.SDK_VERSION, call_started_at=NOW, call_returned_at=NOW,
                datetime_basis="runtime_utc_from_unix_timestamp", collector_runtime="isolated_official_sdk")
        return patch.object(longport, "_collect_isolated", side_effect=collect)

    def clocked(self):
        return patch.multiple(data_evidence, _milliseconds=lambda value=None: NOW if value is None else value,
            instant=lambda value=None: instant(NOW if value is None else value))

    def test_discovery_validation_does_not_reserve_writer_even_between_targets(self):
        self.prepare()
        other = open_database(self.path); self.addCleanup(other.close)
        other.execute("PRAGMA busy_timeout=0")
        phases = []
        def instrument(name, original):
            def checked(*args, **kwargs):
                phases.append(name)
                other.execute("BEGIN IMMEDIATE"); other.execute("ROLLBACK")
                return original(*args, **kwargs)
            return checked
        with patch.object(initial_prices, "_context", side_effect=instrument("context", initial_prices._context)), \
                patch.object(initial_prices, "_plan", side_effect=instrument("plan", initial_prices._plan)), \
                patch.object(initial_prices, "_available", side_effect=instrument("available", initial_prices._available)), \
                patch.object(longport, "_collect_isolated") as sdk:
            jobs = initial_prices.discover_initial_prices(self.db, now=NOW)
        sdk.assert_not_called()
        self.assertEqual(phases, ["context", "plan", "available", "plan", "available"])
        self.assertEqual(len(jobs), 2)
        self.assertEqual({job["max_attempts"] for job in jobs}, {1})
        self.assert_no_finance()

    def test_concurrent_withdrawal_cannot_upgrade_stale_discovery_snapshot(self):
        self.prepare()
        other = open_database(self.path); self.addCleanup(other.close)
        other.execute("PRAGMA busy_timeout=0")
        original = initial_prices._context
        def withdrawn(*args, **kwargs):
            result = original(*args, **kwargs)
            data_evidence.review_source(other, "w", "synthetic-investor", self.refs[0]["rights"]["source_id"], "withdrawn", None,
                "Fictional concurrent withdrawal during read preparation", monitor.EXPIRY, now=NOW)
            return result
        with patch.object(initial_prices, "_context", side_effect=withdrawn), patch.object(longport, "_collect_isolated") as sdk:
            self.assertEqual(initial_prices.discover_initial_prices(self.db, now=NOW), [])
        sdk.assert_not_called()
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_price_requests").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_schedule_initial_price'").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='investor.initial_price_gap'").fetchone()[0], 0)
        self.assertEqual(initial_prices.discover_initial_prices(self.db, now=NOW), [])
        self.assert_no_finance()

    def test_default_longport_acquires_missing_past_days_then_core_bootstraps_both_models(self):
        for fixed in (False, True):
            if fixed: self.setUp()
            self.prepare(fixed)
            with self.clocked(), self.transport() as sdk:
                self.assertEqual(run_pending_once(self.db, "fictional-provider", role="longport", clock=lambda: NOW)["status"], "succeeded")
                self.assertEqual(run_pending_once(self.db, "fictional-provider", role="longport", clock=lambda: NOW)["status"], "succeeded")
            self.assertEqual(sdk.call_count, 2)
            self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_price_runs WHERE status='collected'").fetchone()[0], 2)
            self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 0)
            with patch.object(longport, "_collect_isolated") as sdk:
                self.assertEqual(run_pending_once(self.db, "fictional-core", clock=lambda: NOW)["status"], "succeeded")
            sdk.assert_not_called()
            self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 1)
            self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 1)
            self.assert_no_finance()

    def test_existing_complete_history_uses_zero_sdk_and_zero_requests(self):
        self.prepare()
        with self.clocked(), self.transport():
            for _ in range(2): run_pending_once(self.db, "fictional-provider", role="longport", clock=lambda: NOW)
        before = self.db.total_changes
        with patch.object(longport, "_collect_isolated") as sdk:
            self.assertEqual(initial_prices.discover_initial_prices(self.db, now=NOW), [])
        sdk.assert_not_called(); self.assertEqual(self.db.total_changes, before); self.assert_no_finance()

    def test_withdrawn_authority_and_foreign_model_never_reach_sdk(self):
        self.prepare()
        data_evidence.review_source(self.db, "w", "synthetic-investor", self.refs[0]["rights"]["source_id"], "withdrawn", None,
            "Fictional revoked authority", monitor.EXPIRY, now=NOW)
        with patch.object(longport, "_collect_isolated") as sdk:
            self.assertEqual(initial_prices.discover_initial_prices(self.db, now=NOW), [])
        sdk.assert_not_called()
        with self.assertRaises(WorkbenchError): initial_prices._context(self.db, "foreign", self.definition["model_id"], NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_price_requests").fetchone()[0], 0); self.assert_no_finance()

    def test_one_attempt_and_unknown_transport_error_is_fixed_not_secret_echo(self):
        self.prepare()
        with self.clocked(), patch.object(longport, "_collect_isolated", side_effect=RuntimeError("FICTIONAL-PRIVATE-ERROR")) as sdk:
            job = run_pending_once(self.db, "fictional-provider", role="longport", clock=lambda: NOW)
        self.assertEqual(job["status"], "failed"); self.assertEqual(job["max_attempts"], 1); self.assertEqual(sdk.call_count, 1)
        self.assertNotIn("FICTIONAL-PRIVATE", json.dumps(list(map(dict, self.db.execute("SELECT * FROM investor_initial_price_runs")))))
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_price_runs WHERE status='transport_failed'").fetchone()[0], 1)
        initial_prices.discover_initial_prices(self.db, now=NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM job_runs WHERE job_type=? AND period=?", (initial_prices.JOB_TYPE, job["period"])).fetchone()[0], 1)
        self.assert_no_finance()

    def test_pause_after_preparation_discards_bytes_and_leaves_no_capture(self):
        self.prepare(); initial_prices.discover_initial_prices(self.db, now=NOW)
        lease = claim_job(self.db, "fictional-provider", 300, initial_prices.JOB_TYPE, now=NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        before = self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0]
        with self.clocked(), self.transport(): prepared = command_handler(self.db, clock=lambda: NOW, role="longport")(job, lease)
        self.db.execute("INSERT INTO investor_model_controls VALUES('paused','w','fictional-monitor',2,0,'synthetic-investor','monitor-select-audit',?)", (NOW,))
        complete_job(self.db, lease, None, effect=prepared["effect"], now=NOW, clock=lambda: NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], before)
        self.assertEqual(self.db.execute("SELECT status FROM investor_initial_price_runs").fetchone()[0], "superseded"); self.assert_no_finance()

    def test_expired_lease_after_sdk_does_not_commit_or_automatically_resend(self):
        self.prepare(); initial_prices.discover_initial_prices(self.db, now=NOW)
        lease = claim_job(self.db, "fictional-provider", 180, initial_prices.JOB_TYPE, now=NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        with self.clocked(), self.transport(): prepared = initial_prices.prepare_initial_price(self.db, job, lease, clock=lambda: NOW)
        expired = stamp(instant(NOW) + timedelta(seconds=180))
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            complete_job(self.db, lease, None, effect=prepared["effect"], now=expired)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_price_runs").fetchone()[0], 0)
        claim_job(self.db, "fictional-next", 300, initial_prices.JOB_TYPE, now=expired)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs WHERE id=?", (job["id"],)).fetchone()[0], "failed"); self.assert_no_finance()

    def test_late_run_insert_failure_rolls_back_capture_payload_and_audit(self):
        self.prepare(); before = self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0]
        self.db.execute("CREATE TRIGGER fictional_initial_abort BEFORE INSERT ON investor_initial_price_runs BEGIN SELECT RAISE(ABORT,'fictional abort'); END")
        with self.clocked(), self.transport(), self.assertRaisesRegex(WorkbenchError, "INITIAL_PRICE_COMMIT_FAILED"):
            run_pending_once(self.db, "fictional-provider", role="longport", clock=lambda: NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_complete_initial_price'").fetchone()[0], 0)
        self.assert_no_finance()

    def test_read_only_restore_and_stop_prevent_discovery_before_sdk(self):
        self.prepare(); before = self.db.total_changes
        with patch.object(longport, "_collect_isolated") as sdk:
            with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}), self.assertRaisesRegex(WorkbenchError, "WORKBENCH_READ_ONLY"):
                initial_prices.discover_initial_prices(self.db, now=NOW)
            marker = self.path.parent / "RESTORE_PENDING_REVIEW"; marker.touch()
            with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
                initial_prices.discover_initial_prices(self.db, now=NOW)
            marker.unlink()
            with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
                initial_prices.discover_initial_prices(self.db, now=NOW, stop_requested=lambda: True)
            sdk.assert_not_called()
        self.assertEqual(self.db.total_changes, before)

    def test_stop_after_transport_rolls_back_without_completion_or_input(self):
        self.prepare(); initial_prices.discover_initial_prices(self.db, now=NOW)
        lease = claim_job(self.db, "fictional-provider", 300, initial_prices.JOB_TYPE, now=NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        stopped = [False]; before = self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0]
        with self.clocked(), self.transport(during=lambda: stopped.__setitem__(0, True)):
            prepared = initial_prices.prepare_initial_price(self.db, job, lease, clock=lambda: NOW, stop_requested=lambda: stopped[0])
            with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
                complete_job(self.db, lease, None, effect=prepared["effect"], now=NOW, clock=lambda: NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_price_runs").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 0)

    def test_same_local_day_after_close_waits_without_history_fallback(self):
        at = "2026-01-02T12:00:04.000Z"
        with patch.object(bootstrap, "NOW", at): self.prepare()
        with patch.object(longport, "_collect_isolated") as sdk:
            context = initial_prices._context(self.db, "w", self.definition["model_id"], at)
            with self.assertRaisesRegex(WorkbenchError, "INITIAL_PRICE_WAITING_PAST_SESSION"):
                initial_prices._plan(self.db, "w", context, self.definition["targets"][0]["listing_id"], at)
            self.assertEqual(initial_prices.discover_initial_prices(self.db, now=at), [])
            sdk.assert_not_called()
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_price_requests").fetchone()[0], 0)

    def test_wrong_job_lease_and_short_budget_never_call_transport(self):
        self.prepare(); initial_prices.discover_initial_prices(self.db, now=NOW)
        lease = claim_job(self.db, "fictional-provider", longport.CALL_TIMEOUT_SECONDS, initial_prices.JOB_TYPE, now=NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        with patch.object(longport, "_collect_isolated") as sdk:
            forged = {**job, "id": "wrong-job"}
            with self.assertRaises(WorkbenchError): initial_prices.prepare_initial_price(self.db, forged, lease, clock=lambda: NOW)
            prepared = initial_prices.prepare_initial_price(self.db, job, lease, clock=lambda: NOW)
            complete_job(self.db, lease, None, effect=prepared["effect"], now=NOW, clock=lambda: NOW)
            sdk.assert_not_called()
        self.assertEqual(self.db.execute("SELECT status FROM investor_initial_price_runs").fetchone()[0], "transport_failed")

    def test_closed_request_contract_and_immutable_metadata_precede_sdk(self):
        self.prepare(); initial_prices.discover_initial_prices(self.db, now=NOW)
        row = dict(self.db.execute("SELECT * FROM investor_initial_price_requests LIMIT 1").fetchone())
        for statement in ("UPDATE investor_initial_price_requests SET market='HK'", "DELETE FROM investor_initial_price_requests"):
            with self.assertRaisesRegex(Exception, "immutable"): self.db.execute(statement)
        malformed = json.loads(row["document_json"]); malformed["caller_price"] = "99999"
        self.db.execute("DROP TRIGGER investor_initial_price_request_update")
        self.db.execute("UPDATE investor_initial_price_requests SET document_json=? WHERE id=?", (json.dumps(malformed), row["id"]))
        with patch.object(longport, "_collect_isolated") as sdk, self.assertRaisesRegex(WorkbenchError, "^INITIAL_PRICE_BINDING_INVALID$"):
            initial_prices.request_header(self.db, "w", row["id"], NOW)
        sdk.assert_not_called(); self.assert_no_finance()


if __name__ == "__main__": unittest.main()
