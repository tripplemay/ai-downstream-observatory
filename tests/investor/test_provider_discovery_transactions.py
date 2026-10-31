"""Two-connection fictional discovery; no credentials, SDK or financial facts."""

import os
from pathlib import Path
import sqlite3
import subprocess
import unittest
from unittest.mock import patch

from tests.investor import test_initial_prices as initial, test_confirmed_feed as feed
from worker.investor import initial_prices, confirmed_feed
from worker.market.providers import longport, longport_confirmed
from worker.orchestration.db import ROOT, WorkbenchError, open_database, transaction


class InitialDiscoveryTransactions(unittest.TestCase):
    setUp = initial.InitialPriceTests.setUp
    prepare = initial.InitialPriceTests.prepare
    model = initial.InitialPriceTests.model
    monitor_fixture = initial.InitialPriceTests.monitor_fixture
    assert_no_finance = initial.InitialPriceTests.assert_no_finance

    def other(self):
        db = open_database(self.path); self.addCleanup(db.close)
        db.execute("PRAGMA busy_timeout=0")
        return db

    def assert_no_discovery(self):
        for table in ("investor_initial_price_requests", "investor_initial_price_runs"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_schedule_initial_price'").fetchone()[0], 0)
        self.assert_no_finance()

    def test_a_competing_discoverer_commits_one_shared_daily_batch(self):
        self.prepare(); other = self.other(); original = initial_prices._context
        def concurrent(*args, **kwargs):
            result = original(*args, **kwargs)
            with patch.object(initial_prices, "_context", original):
                self.assertEqual(len(initial_prices.discover_initial_prices(other, now=initial.NOW)), 2)
            return result
        with patch.object(initial_prices, "_context", side_effect=concurrent), patch.object(longport, "_collect_isolated") as sdk:
            self.assertEqual(initial_prices.discover_initial_prices(self.db, now=initial.NOW), [])
        sdk.assert_not_called()
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_price_requests").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM job_runs WHERE job_type='investor_initial_prices' AND max_attempts=1 AND attempt_count=0").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='investor.initial_price_gap'").fetchone()[0], 0)
        self.assert_no_finance()

    def test_actual_node_writer_can_commit_while_python_prepares(self):
        self.prepare(); original = initial_prices._context; observed = []
        def node_write(*args, **kwargs):
            result = original(*args, **kwargs)
            program = """import {createRequire} from 'node:module';
const require=createRequire(process.argv[2]);const Database=require('better-sqlite3');
const db=new Database(process.argv[1],{fileMustExist:true});db.pragma('busy_timeout=0');
try {db.transaction(()=>db.prepare("UPDATE investor_workspaces SET revision=revision+1 WHERE id='w'").run()).immediate();console.log('FICTIONAL_NODE_WRITE_COMMITTED');}finally{db.close();}
"""
            node = "/opt/homebrew/bin/node" if Path("/opt/homebrew/bin/node").exists() else "node"
            process = subprocess.run([node, "--input-type=module", "-e", program, str(self.path), str(ROOT / "web/package.json")],
                capture_output=True, text=True, timeout=30)
            self.assertEqual(process.returncode, 0, process.stderr)
            observed.append(process.stdout.strip())
            return result
        with patch.object(initial_prices, "_context", side_effect=node_write):
            self.assertEqual(initial_prices.discover_initial_prices(self.db, now=initial.NOW), [])
        self.assertEqual(observed, ["FICTIONAL_NODE_WRITE_COMMITTED"])
        self.assert_no_discovery()

    def test_pausing_model_during_read_abandons_stale_requests_without_gap(self):
        self.prepare(); other = self.other(); original = initial_prices._context
        def paused(*args, **kwargs):
            result = original(*args, **kwargs)
            other.execute("INSERT INTO investor_model_controls VALUES('concurrent-pause','w','fictional-monitor',2,0,'synthetic-investor','monitor-select-audit',?)", (initial.NOW,))
            return result
        with patch.object(initial_prices, "_context", side_effect=paused):
            self.assertEqual(initial_prices.discover_initial_prices(self.db, now=initial.NOW), [])
        self.assert_no_discovery()
        self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='investor.initial_price_gap'").fetchone()[0], 0)
        self.assertEqual(initial_prices.discover_initial_prices(self.db, now=initial.NOW), [])

    def test_live_competing_writer_defers_without_automatic_retry(self):
        self.prepare(); other = self.other(); original = initial_prices._context
        def locked(*args, **kwargs):
            result = original(*args, **kwargs)
            other.execute("BEGIN IMMEDIATE")
            other.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id='w'")
            return result
        try:
            with patch.object(initial_prices, "_context", side_effect=locked), patch.object(longport, "_collect_isolated") as sdk:
                self.assertEqual(initial_prices.discover_initial_prices(self.db, now=initial.NOW), [])
            sdk.assert_not_called(); self.assert_no_discovery()
        finally:
            if other.in_transaction: other.execute("ROLLBACK")
        self.assertEqual(len(initial_prices.discover_initial_prices(self.db, now=initial.NOW)), 2)

    def test_metadata_batch_is_atomic_on_second_audit_failure(self):
        self.prepare(); original = initial_prices._audit; calls = []
        def fail(*args, **kwargs):
            result = original(*args, **kwargs); calls.append(result)
            if len(calls) == 2: raise RuntimeError("FICTIONAL_LATE_DISCOVERY_FAILURE")
            return result
        with patch.object(initial_prices, "_audit", side_effect=fail), self.assertRaisesRegex(RuntimeError, "LATE_DISCOVERY"):
            initial_prices.discover_initial_prices(self.db, now=initial.NOW)
        self.assertEqual(len(calls), 2); self.assert_no_discovery()

    def test_stop_restore_and_readonly_after_preparation_publish_nothing(self):
        self.prepare(); original = initial_prices._available
        for mode in ("stop", "restore", "readonly"):
            with self.subTest(mode=mode), patch.dict(os.environ):
                stopped = [False]; calls = []; marker = self.path.parent / "RESTORE_PENDING_REVIEW"
                def changed(*args, **kwargs):
                    value = original(*args, **kwargs); calls.append(value)
                    if len(calls) == 2:
                        if mode == "stop": stopped[0] = True
                        elif mode == "restore": marker.touch()
                        else: os.environ["WORKBENCH_MODE"] = "read_only"
                    return value
                code = {"stop": "WORKER_STOP_REQUESTED", "restore": "RESTORE_PENDING_REVIEW", "readonly": "WORKBENCH_READ_ONLY"}[mode]
                try:
                    with patch.object(initial_prices, "_available", side_effect=changed), self.assertRaisesRegex(WorkbenchError, code):
                        initial_prices.discover_initial_prices(self.db, now=initial.NOW, stop_requested=lambda: stopped[0])
                    self.assert_no_discovery()
                finally:
                    if marker.exists(): marker.unlink()

    def test_nested_transactions_are_rejected_and_nonbusy_errors_propagate(self):
        self.prepare()
        for immediate in (False, True):
            with transaction(self.db, immediate=immediate), self.assertRaisesRegex(WorkbenchError, "REQUIRES_AUTOCOMMIT"):
                initial_prices.discover_initial_prices(self.db, now=initial.NOW)
        with patch.object(initial_prices, "_context", side_effect=sqlite3.OperationalError("FICTIONAL_DISK_IO")), \
                self.assertRaisesRegex(sqlite3.OperationalError, "FICTIONAL_DISK_IO"):
            initial_prices.discover_initial_prices(self.db, now=initial.NOW)
        self.assert_no_discovery()


class ConfirmedDiscoveryTransactions(unittest.TestCase):
    setUp = feed.ConfirmedFeedTests.setUp
    model = feed.ConfirmedFeedTests.model
    monitor_fixture = feed.ConfirmedFeedTests.monitor_fixture
    assert_no_finance = feed.ConfirmedFeedTests.assert_no_finance

    def other(self):
        db = open_database(self.path); self.addCleanup(db.close)
        db.execute("PRAGMA busy_timeout=0")
        return db

    def test_expensive_seed_and_market_plan_do_not_reserve_writer(self):
        self.model(); other = self.other(); phases = []
        def instrument(name, original):
            def checked(*args, **kwargs):
                phases.append(name); other.execute("BEGIN IMMEDIATE"); other.execute("ROLLBACK")
                return original(*args, **kwargs)
            return checked
        with patch.object(confirmed_feed, "_seed", side_effect=instrument("seed", confirmed_feed._seed)), \
                patch.object(confirmed_feed, "market_plan", side_effect=instrument("plan", confirmed_feed.market_plan)), \
                patch.object(longport_confirmed, "collect_confirmed_days") as sdk:
            jobs = confirmed_feed.discover_confirmed_watches(self.db, now=feed.EARLY)
        self.assertEqual(phases, ["seed", "plan"]); self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["max_attempts"], 1); sdk.assert_not_called(); self.assert_no_finance()

    def test_concurrent_model_pause_rolls_back_discovery_without_false_gap(self):
        self.model(); other = self.other(); original = confirmed_feed._seed
        def paused(*args, **kwargs):
            result = original(*args, **kwargs)
            other.execute("INSERT INTO investor_model_controls VALUES('concurrent-pause','w','fictional-monitor',2,0,'synthetic-investor','monitor-select-audit',?)", (feed.EARLY,))
            return result
        with patch.object(confirmed_feed, "_seed", side_effect=paused), patch.object(longport_confirmed, "collect_confirmed_days") as sdk:
            self.assertEqual(confirmed_feed.discover_confirmed_watches(self.db, now=feed.EARLY), [])
        sdk.assert_not_called()
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_feed_requests").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='investor.confirmed_feed_source_gap'").fetchone()[0], 0)
        self.assert_no_finance()

    def test_nested_transactions_and_nonbusy_errors_do_not_become_gaps(self):
        self.model()
        with transaction(self.db), self.assertRaisesRegex(WorkbenchError, "REQUIRES_AUTOCOMMIT"):
            confirmed_feed.discover_confirmed_watches(self.db, now=feed.EARLY)
        with patch.object(confirmed_feed, "_seed", side_effect=sqlite3.OperationalError("FICTIONAL_DISK_IO")), \
                self.assertRaisesRegex(sqlite3.OperationalError, "FICTIONAL_DISK_IO"):
            confirmed_feed.discover_confirmed_watches(self.db, now=feed.EARLY)
        self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='investor.confirmed_feed_source_gap'").fetchone()[0], 0)
        self.assert_no_finance()

    def test_queue_failure_retains_one_request_and_rescues_same_identity(self):
        self.model()
        with patch.object(confirmed_feed, "enqueue_job", side_effect=RuntimeError("FICTIONAL_QUEUE_FAILURE")), \
                self.assertRaisesRegex(RuntimeError, "QUEUE_FAILURE"):
            confirmed_feed.discover_confirmed_watches(self.db, now=feed.EARLY)
        requests = [dict(row) for row in self.db.execute("SELECT * FROM investor_confirmed_feed_requests")]
        self.assertEqual(len(requests), 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM job_runs WHERE job_type=?", (confirmed_feed.JOB_TYPE,)).fetchone()[0], 0)
        with patch.object(longport_confirmed, "collect_confirmed_days") as sdk:
            rescued = confirmed_feed.discover_confirmed_watches(self.db, now=feed.EARLY)
            self.assertEqual(confirmed_feed.discover_confirmed_watches(self.db, now=feed.EARLY), [])
        sdk.assert_not_called()
        self.assertEqual(len(rescued), 1)
        self.assertEqual((rescued[0]["period"], rescued[0]["input_version"], rescued[0]["max_attempts"], rescued[0]["attempt_count"]),
            (requests[0]["id"], requests[0]["content_hash"], 1, 0))
        self.assertEqual([dict(row) for row in self.db.execute("SELECT * FROM investor_confirmed_feed_requests")], requests)
        self.assert_no_finance()

    def test_stop_after_seed_cannot_publish_or_be_misreported_as_source_gap(self):
        self.model(); original = confirmed_feed._seed; stopped = [False]
        def stop(*args, **kwargs):
            result = original(*args, **kwargs); stopped[0] = True; return result
        with patch.object(confirmed_feed, "_seed", side_effect=stop), self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            confirmed_feed.discover_confirmed_watches(self.db, now=feed.EARLY, stop_requested=lambda: stopped[0])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_confirmed_feed_requests").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='investor.confirmed_feed_source_gap'").fetchone()[0], 0)
        self.assert_no_finance()


if __name__ == "__main__": unittest.main()
