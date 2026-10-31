"""Fictional clock/control changes at the final transport boundary; no real SDK."""

from datetime import timedelta
import os
import unittest
from unittest.mock import patch

from tests.investor import test_initial_prices as fixture
from worker.investor import data_evidence, initial_prices
from worker.orchestration.db import WorkbenchError, instant, stamp
from worker.orchestration.jobs import claim_job, complete_job


class InitialPriceBoundaryTests(unittest.TestCase):
    setUp = fixture.InitialPriceTests.setUp
    prepare = fixture.InitialPriceTests.prepare
    model = fixture.InitialPriceTests.model
    monitor_fixture = fixture.InitialPriceTests.monitor_fixture
    clocked = fixture.InitialPriceTests.clocked
    transport = fixture.InitialPriceTests.transport
    assert_no_finance = fixture.InitialPriceTests.assert_no_finance

    def claimed(self):
        self.prepare(); initial_prices.discover_initial_prices(self.db, now=fixture.NOW)
        lease = claim_job(self.db, "fictional-boundary", 300, initial_prices.JOB_TYPE, now=fixture.NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        return lease, job

    def binding_change(self, change):
        active = [False]; prepare = data_evidence.prepare_prices; binding = data_evidence.collection_binding
        def preparing(*args, **kwargs):
            active[0] = True
            try: return prepare(*args, **kwargs)
            finally: active[0] = False
        def changed(*args, **kwargs):
            result = binding(*args, **kwargs)
            if active[0]: change()
            return result
        return patch.object(data_evidence, "prepare_prices", side_effect=preparing), patch.object(data_evidence, "collection_binding", side_effect=changed)

    def assert_no_publication(self):
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_price_runs").fetchone()[0], 0)
        self.assert_no_finance()

    def test_expired_after_read_validation_cannot_start_transport(self):
        lease, job = self.claimed(); clock = [fixture.NOW]; available = initial_prices._available
        def slow(*args, **kwargs):
            value = available(*args, **kwargs); clock[0] = stamp(instant(lease.lease_until) + timedelta(milliseconds=1)); return value
        with self.clocked(), patch.object(initial_prices, "_available", side_effect=slow), self.transport() as sdk:
            with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
                initial_prices.prepare_initial_price(self.db, job, lease, clock=lambda: clock[0])
        sdk.assert_not_called(); self.assert_no_publication()

    def test_margin_consumed_during_binding_does_not_call_sdk_or_retry(self):
        lease, job = self.claimed(); clock = [fixture.NOW]
        near = stamp(instant(lease.lease_until) - timedelta(seconds=30))
        first, second = self.binding_change(lambda: clock.__setitem__(0, near))
        before = self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0]
        with self.clocked(), first, second, self.transport() as sdk:
            prepared = initial_prices.prepare_initial_price(self.db, job, lease, clock=lambda: clock[0])
        sdk.assert_not_called()
        complete_job(self.db, lease, None, effect=prepared["effect"], now=clock[0], clock=lambda: clock[0])
        self.assertEqual(self.db.execute("SELECT status,attempt_count,max_attempts FROM job_runs WHERE id=?", (job["id"],)).fetchone()[:], ("failed", 1, 1))
        self.assertEqual(self.db.execute("SELECT status FROM investor_initial_price_runs").fetchone()[0], "transport_failed")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], before)
        self.assertEqual(initial_prices.discover_initial_prices(self.db, now=clock[0]), [])
        self.assert_no_finance()

    def test_stop_during_binding_is_propagated_before_transport(self):
        lease, job = self.claimed(); stopped = [False]
        first, second = self.binding_change(lambda: stopped.__setitem__(0, True))
        with self.clocked(), first, second, self.transport() as sdk:
            with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
                initial_prices.prepare_initial_price(self.db, job, lease, clock=lambda: fixture.NOW, stop_requested=lambda: stopped[0])
        sdk.assert_not_called(); self.assert_no_publication()

    def test_readonly_during_binding_is_not_a_transport_failure(self):
        lease, job = self.claimed()
        first, second = self.binding_change(lambda: os.environ.__setitem__("WORKBENCH_MODE", "read_only"))
        with patch.dict(os.environ), self.clocked(), first, second, self.transport() as sdk:
            with self.assertRaisesRegex(WorkbenchError, "WORKBENCH_READ_ONLY"):
                initial_prices.prepare_initial_price(self.db, job, lease, clock=lambda: fixture.NOW)
        sdk.assert_not_called(); self.assert_no_publication()

    def test_restore_during_binding_prevents_transport(self):
        lease, job = self.claimed(); marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        first, second = self.binding_change(marker.touch)
        try:
            with self.clocked(), first, second, self.transport() as sdk:
                with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
                    initial_prices.prepare_initial_price(self.db, job, lease, clock=lambda: fixture.NOW)
            sdk.assert_not_called(); self.assert_no_publication()
        finally:
            if marker.exists(): marker.unlink()

    def test_model_pause_during_binding_skips_without_sdk(self):
        lease, job = self.claimed()
        def pause():
            self.db.execute("INSERT INTO investor_model_controls VALUES('boundary-pause','w','fictional-monitor',2,0,'synthetic-investor','monitor-select-audit',?)", (fixture.NOW,))
        first, second = self.binding_change(pause)
        with self.clocked(), first, second, self.transport() as sdk:
            prepared = initial_prices.prepare_initial_price(self.db, job, lease, clock=lambda: fixture.NOW)
        sdk.assert_not_called()
        complete_job(self.db, lease, None, effect=prepared["effect"], now=fixture.NOW, clock=lambda: fixture.NOW)
        self.assertEqual(self.db.execute("SELECT status FROM investor_initial_price_runs").fetchone()[0], "superseded")
        self.assertEqual(self.db.execute("SELECT status FROM job_runs WHERE id=?", (job["id"],)).fetchone()[0], "skipped")
        self.assert_no_finance()

    def test_withdrawal_during_binding_skips_without_sdk(self):
        lease, job = self.claimed()
        def withdraw():
            data_evidence.review_source(self.db, "w", "synthetic-investor", self.refs[0]["rights"]["source_id"], "withdrawn", None,
                "FICTIONAL withdrawal before SDK boundary", fixture.monitor.EXPIRY, now=fixture.NOW)
        first, second = self.binding_change(withdraw)
        with self.clocked(), first, second, self.transport() as sdk:
            prepared = initial_prices.prepare_initial_price(self.db, job, lease, clock=lambda: fixture.NOW)
        sdk.assert_not_called()
        complete_job(self.db, lease, None, effect=prepared["effect"], now=fixture.NOW, clock=lambda: fixture.NOW)
        self.assertEqual(self.db.execute("SELECT status FROM investor_initial_price_runs").fetchone()[0], "superseded")
        self.assert_no_finance()

    def test_expired_during_transport_returns_no_publishable_effect(self):
        lease, job = self.claimed(); clock = [fixture.NOW]
        def expired(): clock[0] = stamp(instant(lease.lease_until) + timedelta(milliseconds=1))
        before = self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0]
        with self.clocked(), self.transport(during=expired) as sdk:
            with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
                initial_prices.prepare_initial_price(self.db, job, lease, clock=lambda: clock[0])
        self.assertEqual(sdk.call_count, 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], before)
        self.assert_no_publication()

    def test_stop_during_transport_returns_no_publishable_effect(self):
        lease, job = self.claimed(); stopped = [False]
        before = self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0]
        with self.clocked(), self.transport(during=lambda: stopped.__setitem__(0, True)) as sdk:
            with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
                initial_prices.prepare_initial_price(self.db, job, lease, clock=lambda: fixture.NOW, stop_requested=lambda: stopped[0])
        self.assertEqual(sdk.call_count, 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], before)
        self.assert_no_publication()


if __name__ == "__main__":
    unittest.main()
