"""Role isolation and provider concurrency without SDK installation or network."""

from datetime import timedelta
import subprocess
import sys
import unittest
from unittest.mock import patch

from tests.market.support import NOW, database, seed_account
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, open_database, stamp
from worker.orchestration.jobs import claim_job, complete_job, enqueue_job
from worker.orchestration.runtime import command_handler, run_pending_once, sync_requests


class ProviderRoleTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = database(self)
        seed_account(self.db)

    def request(self, kind="market_collect_prices", identity="synthetic-provider-request"):
        payload = {"synthetic_fixture": True}
        self.db.execute("""INSERT INTO command_requests(id,portfolio_id,command_type,idempotency_key,
            payload_hash,payload_json,actor_id,created_at) VALUES(?,'p',?,?,?,?,?,?)""",
                        (identity, kind, identity, content_hash(payload), canonical_json(payload), "synthetic-owner", stamp(NOW)))

    def test_core_neither_dispatches_nor_claims_optional_provider_requests(self):
        self.request()
        self.assertIsNone(run_pending_once(self.db, "synthetic-core", clock=lambda: NOW))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM job_runs").fetchone()[0], 0)
        sync_requests(self.db, now=NOW)
        self.assertIsNone(run_pending_once(self.db, "synthetic-core", clock=lambda: NOW))
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "queued")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM job_attempts").fetchone()[0], 0)

    def test_provider_role_does_not_discover_monthly_or_take_core_work(self):
        self.request("valuation")
        with patch("worker.orchestration.runtime.discover_due_cycles") as discover:
            self.assertIsNone(run_pending_once(self.db, "synthetic-provider", clock=lambda: NOW, role="longport"))
            discover.assert_not_called()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM job_runs").fetchone()[0], 0)

    def test_role_guard_precedes_payload_or_provider_import(self):
        self.request()
        job = sync_requests(self.db, now=NOW)[0]
        lease = claim_job(self.db, "synthetic-owner", job_type="market_collect_prices", now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "JOB_REQUIRES_DIFFERENT_WORKER_ROLE"):
            command_handler(self.db, lambda: NOW)(job, lease)

    def test_global_price_lease_mutex_does_not_block_core_jobs(self):
        for identity in ("one", "two"):
            enqueue_job(self.db, "market_collect_prices", "p", identity, identity, now=NOW)
        enqueue_job(self.db, "valuation", "p", "core", "core", now=NOW)
        other = open_database(self.path)
        self.addCleanup(other.close)
        first = claim_job(self.db, "synthetic-price-one", 300, "market_collect_prices", now=NOW)
        self.assertIsNotNone(first)
        self.assertIsNone(claim_job(other, "synthetic-price-two", 300, "market_collect_prices", now=NOW))
        core = claim_job(other, "synthetic-core", 300, "valuation", now=NOW)
        self.assertIsNotNone(core)
        complete_job(self.db, first, {"synthetic": True}, now=NOW)
        self.assertIsNotNone(claim_job(other, "synthetic-price-two", 300, "market_collect_prices", now=NOW))

    def test_expired_provider_fence_never_allows_late_commit(self):
        enqueue_job(self.db, "market_collect_prices", "p", "one", "one", now=NOW)
        first = claim_job(self.db, "synthetic-first", 180, "market_collect_prices", now=NOW)
        later = NOW + timedelta(seconds=181)
        second = claim_job(self.db, "synthetic-second", 180, "market_collect_prices", now=later)
        self.assertGreater(second.fencing_token, first.fencing_token)
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            complete_job(self.db, first, {"must_not_commit": True}, now=later)

    def test_invalid_role_or_short_provider_lease_has_no_writes(self):
        self.request()
        before = list(self.db.iterdump())
        for kwargs, code in [({"role": "arbitrary"}, "INVALID_WORKER_ROLE"),
                             ({"role": "longport", "lease_seconds": 179}, "PRICE_WORKER_LEASE_TOO_SHORT")]:
            with self.assertRaisesRegex(WorkbenchError, code):
                run_pending_once(self.db, "synthetic-worker", clock=lambda: NOW, **kwargs)
            self.assertEqual(list(self.db.iterdump()), before)

    def test_cli_optional_runtime_is_checked_before_opening_database(self):
        result = subprocess.run([sys.executable, "-m", "worker.orchestration", "--role", "longport",
                                 "--db", str(self.path.parent / "missing.db"), "--once"],
                                capture_output=True, text=True, timeout=15,
                                env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("LONGPORT_RUNTIME_NOT_CONFIGURED", result.stderr)
        self.assertFalse((self.path.parent / "missing.db").exists())
        self.assertNotIn(str(self.path), result.stderr)


if __name__ == "__main__":
    unittest.main()
