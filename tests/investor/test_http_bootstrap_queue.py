"""Known earlier fake work must not become an actual provider request."""

from datetime import timedelta
import json
import sqlite3
import unittest
from unittest.mock import patch

from tests.investor import test_monitor_bootstrap as fixture
from tests.investor.http_bootstrap_queue import run_bootstrap_core
from tests.market.support import seed_account
from tests.market.test_collection import payload
from worker.orchestration import runtime
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, stamp
from worker.orchestration.jobs import run_one


class HttpBootstrapQueueTests(unittest.TestCase):
    def setUp(self):
        self.case = fixture.MonitorBootstrapTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.db = self.case.db; self.case.model(positive_tolerance=True)

    def retry(self, *, known=True):
        seed_account(self.db)
        at = stamp(instant(self.case.now) - timedelta(minutes=1)); value = payload()
        self.db.execute("""INSERT INTO command_requests(id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at)
          VALUES('fictional-prior-collection','p','market_collect',?,?,?,'synthetic-human',?)""",
            ("http-collection-transport-failure" if known else "unknown-fixture-retry", content_hash(value), canonical_json(value), at))
        runtime.sync_requests(self.db, now=at, command_types=("market_collect",))
        with patch("worker.market.collection.download_ecb_xml", side_effect=RuntimeError("FICTIONAL_INITIAL_FAILURE")), \
                self.assertRaisesRegex(WorkbenchError,"PROVIDER_COLLECTION_FAILED"):
            run_one(self.db,"fictional-earlier-http",runtime.command_handler(self.db,clock=lambda:at),job_type="market_collect",clock=lambda:at)
        return self.db.execute("SELECT * FROM job_runs WHERE command_request_id='fictional-prior-collection'").fetchone()

    def test_isolated_investor_suite_runs_only_its_normal_default_core(self):
        value = run_bootstrap_core(self.db,"w",self.case.definition["model_id"],clock=lambda:self.case.now)
        self.assertEqual(value["selected_types"],["investor_evidence_monitor"])
        self.assertEqual(value["fixture_legacy_downloads"],0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0],1)
        self.case.assert_no_finance()

    def test_known_prior_retry_and_new_monitor_both_complete_without_real_network_or_resetting_attempts(self):
        prior = self.retry(); self.assertEqual((prior["status"],prior["attempt_count"]),("retry_queued",1))
        finance = {table:[list(row) for row in self.db.execute("SELECT rowid,* FROM " + table)] for table in fixture.queue.FINANCIAL_TABLES}
        with patch("socket.create_connection",side_effect=AssertionError("NO_REAL_NETWORK")), \
                patch("socket.getaddrinfo",side_effect=AssertionError("NO_REAL_DNS")):
            value = run_bootstrap_core(self.db,"w",self.case.definition["model_id"],clock=lambda:self.case.now)
        self.assertEqual(value["selected_types"],["market_collect","investor_evidence_monitor"])
        self.assertEqual(value["fixture_legacy_downloads"],1); self.assertEqual(value["real_provider_calls"],0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0],1)
        self.assertEqual(finance,{table:[list(row) for row in self.db.execute("SELECT rowid,* FROM " + table)] for table in finance})

    def test_unknown_prior_job_is_rejected_before_bootstrap_or_transport(self):
        self.retry(known=False); before = list(self.db.iterdump())
        with self.assertRaisesRegex(AssertionError,"UNEXPECTED_HTTP_CORE_READY_MARKET_COLLECT"):
            run_bootstrap_core(self.db,"w",self.case.definition["model_id"],clock=lambda:self.case.now)
        self.assertEqual(list(self.db.iterdump()),before)

    def test_non_fixture_database_is_rejected_before_any_dispatch(self):
        other = sqlite3.connect(":memory:")
        try:
            with self.assertRaises(AssertionError): run_bootstrap_core(other,"w","model")
        finally: other.close()


if __name__ == "__main__": unittest.main()
