"""Invented source permissions and durable daily budgets; no real HTTP or token."""

from copy import deepcopy
from hashlib import sha256
import json
import sqlite3
import unittest
from unittest.mock import patch

from tests.investor import test_runtime as runtime_fixtures
from worker.investor import eodhd_sources as source
from worker.market.providers.eodhd_actions import action_url, parse_eodhd_actions
from worker.market.providers.eodhd_transport import VERSION as TRANSPORT_VERSION
from worker.orchestration.db import WorkbenchError, open_database
from worker.orchestration.jobs import claim_job, complete_job, heartbeat, run_one
from worker.orchestration.runtime import run_pending_once
from worker.investor.source_retention import purge_due_source_payloads


REGISTER = "2026-10-31T12:00:00.000Z"
AT = "2026-11-01T05:00:03.000Z"


def policy(**changes):
    return {"schema_version": "investor-eodhd-policy-v1", "provider": "eodhd_action_drafts", "symbols": ["VT.US", "BND.US"],
        "kinds": ["div", "splits"], "uses": ["private_research", "private_retention", "private_display", "private_backup"],
        "valid_from": "2026-11-01T04:00:00.000Z", "valid_until": "2027-11-01T04:00:00.000Z", "retention_years": 10,
        "timezone": "America/New_York", "run_after_hour": 1, "lookback_days": 365, "max_requests_per_day": 4, "automatic_retry": False,
        "clause_references": ["FICTIONAL owner research use; not provider or legal certification"],
        "authorization_basis": "owner_declared_private_use_not_provider_certified", "raw_ai_sharing": False,
        "quote_replacement": False, "trading_permission": False, **changes}


class Collector:
    def __init__(self, during=None, error=None):
        self.calls = []; self.during = during; self.error = error

    def __call__(self, **options):
        self.calls.append({key: options[key] for key in ("kind", "symbol", "start_date", "end_date")})
        if self.during: self.during()
        if self.error: raise self.error
        raw = b"[]"; parameters = self.calls[-1]
        receipt = {"schema_version": TRANSPORT_VERSION, "url_without_credentials": action_url(**parameters), "request": parameters,
            "started_at": AT, "completed_at": AT, "retrieved_at": AT, "http_status": 200, "raw_sha256": sha256(raw).hexdigest(),
            "raw_bytes": len(raw), "redirects_followed": 0, "response_format": "utf8_json_identity", "credential_in_receipt": False}
        return {"schema_version": source.receiver.VERSION, "raw": raw, "receipt": receipt,
            "draft": parse_eodhd_actions(raw, **parameters, retrieved_at=AT)}


class EodhdSourceTests(unittest.TestCase):
    assert_no_finance = runtime_fixtures.InvestorRuntimeTests.assert_no_finance

    def setUp(self):
        runtime_fixtures.InvestorRuntimeTests.setUp(self)
        self.available = patch.dict("os.environ", {"WORKBENCH_EODHD_ENABLED": "1"})
        self.available.start(); self.addCleanup(self.available.stop)

    def count(self, table):
        return self.db.execute("SELECT count(*) FROM " + table).fetchone()[0]

    def grant(self, *, enabled=True, document=None):
        row = source.register_authority(self.db, "w", "synthetic-investor", document or policy(), now=REGISTER)
        if enabled:
            source.set_authority_enabled(self.db, "w", "synthetic-investor", row["id"], True, now=REGISTER)
        return row

    def run_capture(self, collector, clock=lambda: AT):
        return run_one(self.db, "fictional-eodhd-worker", lambda job, lease: source.prepare_eodhd_capture(self.db, job, lease,
            clock=clock, test_collector=collector), job_type=source.JOB_TYPE, lease_seconds=180, clock=clock)

    def test_registration_is_default_disabled_idempotent_and_grants_no_research(self):
        original = policy(); copy = deepcopy(original)
        row = self.grant(enabled=False, document=original)
        self.assertEqual(original, copy)
        self.assertEqual(source.register_authority(self.db, "w", "synthetic-investor", original, now=REGISTER)["id"], row["id"])
        self.assertEqual(self.count("investor_eodhd_authorities"), 1)
        self.assertEqual(self.db.execute("SELECT enabled FROM investor_eodhd_controls").fetchone()[0], 0)
        with patch.object(source.receiver, "read_private_token") as token:
            self.assertEqual(source.discover_eodhd_requests(self.db, now=AT), [])
        token.assert_not_called()
        for table in ("investor_eodhd_requests", "job_runs", "investor_data_reviews", "investor_evidence_inputs"):
            self.assertEqual(self.count(table), 0, table)
        self.assert_no_finance()

    def test_exact_four_immutable_daily_requests_and_single_attempt_jobs_precede_any_io(self):
        self.grant()
        with patch.object(source.receiver, "collect_eodhd_action_draft") as transport:
            jobs = source.discover_eodhd_requests(self.db, now=AT)
            self.assertEqual(len(jobs), 4)
            self.assertEqual(source.discover_eodhd_requests(self.db, now=AT), [])
        transport.assert_not_called()
        requests = self.db.execute("SELECT * FROM investor_eodhd_requests ORDER BY symbol,kind").fetchall()
        self.assertEqual({(row["symbol"], row["kind"], row["source_day"]) for row in requests},
            {(symbol, kind, "2026-11-01") for symbol in ("VT.US", "BND.US") for kind in ("div", "splits")})
        for row in requests:
            doc = json.loads(row["document_json"])
            self.assertEqual((doc["parameters"]["start_date"], doc["parameters"]["end_date"]), ("2025-11-01", "2026-10-31"))
            self.assertEqual(doc["valid_until"], "2026-11-02T05:00:00.000Z")
        for job in self.db.execute("SELECT * FROM job_runs"):
            self.assertEqual((job["job_type"], job["max_attempts"], job["attempt_count"], job["command_request_id"]),
                (source.JOB_TYPE, 1, 0, None))
        for table in ("investor_eodhd_requests", "investor_eodhd_authorities", "investor_eodhd_controls"):
            with self.assertRaises(sqlite3.IntegrityError): self.db.execute("DELETE FROM " + table)
            with self.assertRaises(sqlite3.IntegrityError): self.db.execute("UPDATE " + table + " SET actor_id='foreign'")
        self.assert_no_finance()

    def test_future_rule_and_pre_one_oclock_wait_without_spending_a_slot(self):
        self.grant()
        for at in (REGISTER, "2026-11-01T04:59:59.999Z"):
            self.assertEqual(source.discover_eodhd_requests(self.db, now=at), [])
        self.assertEqual(self.count("investor_eodhd_requests"), 0)
        self.assertEqual(len(source.discover_eodhd_requests(self.db, now=AT)), 4)

    def test_repeated_dst_hour_toggles_and_replacement_grants_do_not_reset_budget(self):
        row = self.grant(); source.discover_eodhd_requests(self.db, now=AT)
        self.assertEqual(source.discover_eodhd_requests(self.db, now="2026-11-01T06:00:03.000Z"), [])
        source.set_authority_enabled(self.db, "w", "synthetic-investor", row["id"], False, now=AT)
        source.set_authority_enabled(self.db, "w", "synthetic-investor", row["id"], True, now=AT)
        self.assertEqual(source.discover_eodhd_requests(self.db, now=AT), [])
        source.set_authority_enabled(self.db, "w", "synthetic-investor", row["id"], False, now=AT)
        other = source.register_authority(self.db, "w", "synthetic-investor", policy(clause_references=["FICTIONAL replacement, same daily quota"]), now=AT)
        source.set_authority_enabled(self.db, "w", "synthetic-investor", other["id"], True, now=AT)
        self.assertEqual(source.discover_eodhd_requests(self.db, now=AT), [])
        self.assertEqual(self.count("investor_eodhd_requests"), 4)
        self.assert_no_finance()

    def test_second_connection_observes_the_same_four_slots_not_eight(self):
        self.grant(); source.discover_eodhd_requests(self.db, now=AT)
        other = open_database(self.path); self.addCleanup(other.close)
        self.assertEqual(source.discover_eodhd_requests(other, now=AT), [])
        self.assertEqual(self.count("investor_eodhd_requests"), 4)
        self.assertEqual(self.count("job_runs"), 4)

    def test_another_workspace_cannot_multiply_the_shared_credentials_daily_budget(self):
        self.grant()
        self.db.execute("INSERT INTO investor_workspaces VALUES('w2','fictional-other-owner',0,?)", (REGISTER,))
        other = source.register_authority(self.db, "w2", "fictional-other-owner", policy(), now=AT)
        source.set_authority_enabled(self.db, "w2", "fictional-other-owner", other["id"], True, now=AT)
        self.assertEqual(len(source.discover_eodhd_requests(self.db, now=AT)), 4)
        self.assertEqual(source.discover_eodhd_requests(self.db, now=AT), [])
        self.assertEqual(self.count("investor_eodhd_requests"), 4); self.assertEqual(self.count("job_runs"), 4)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_eodhd_requests WHERE workspace_id='w2'").fetchone()[0], 0)
        self.assert_no_finance()

    def test_closed_scope_and_future_overlap_reject_without_grant_or_control_side_effects(self):
        before = list(self.db.iterdump())
        for changes in ({"retention_years": 11}, {"raw_ai_sharing": True}, {"quote_replacement": True}, {"trading_permission": True},
                {"max_requests_per_day": 20}, {"lookback_days": 366}, {"symbols": ["VTI.US"]}, {"api_token": "FICTIONAL-NOT-A-REAL-TOKEN"}):
            with self.assertRaises(WorkbenchError):
                self.grant(document=policy(**changes))
            self.assertEqual(list(self.db.iterdump()), before)
        self.grant()
        other = self.grant(enabled=False, document=policy(clause_references=["FICTIONAL overlapping authority"]))
        before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "AMBIGUOUS"):
            source.set_authority_enabled(self.db, "w", "synthetic-investor", other["id"], True, now=REGISTER)
        self.assertEqual(list(self.db.iterdump()), before)

    def test_disabled_transport_read_only_restore_and_stop_do_not_create_requests(self):
        self.grant()
        with patch.dict("os.environ", {"WORKBENCH_EODHD_ENABLED": "0"}):
            self.assertEqual(source.discover_eodhd_requests(self.db, now=AT), [])
        with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}), self.assertRaisesRegex(WorkbenchError, "READ_ONLY"):
            source.discover_eodhd_requests(self.db, now=AT)
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"; marker.touch()
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            source.discover_eodhd_requests(self.db, now=AT)
        marker.unlink()
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            source.discover_eodhd_requests(self.db, now=AT, stop_requested=lambda: True)
        self.assertEqual(self.count("investor_eodhd_requests"), 0)
        self.assert_no_finance()

    def test_late_job_insert_failure_rolls_back_entire_daily_batch(self):
        self.grant()
        self.db.execute("CREATE TEMP TRIGGER fictional_eodhd_job_failure BEFORE INSERT ON job_runs WHEN NEW.job_type='investor_eodhd_capture' BEGIN SELECT RAISE(ABORT,'FICTIONAL_EODHD_LATE_FAILURE'); END")
        before = list(self.db.iterdump())
        with self.assertRaisesRegex(sqlite3.IntegrityError, "FICTIONAL_EODHD_LATE_FAILURE"):
            source.discover_eodhd_requests(self.db, now=AT)
        self.assertEqual(list(self.db.iterdump()), before)

    def test_handled_late_domain_error_returns_no_rolled_back_job_ids(self):
        self.grant(); original = source.enqueue_job
        calls = []
        def late(*args, **kwargs):
            calls.append(True)
            if len(calls) == 2:
                raise WorkbenchError("FICTIONAL_EODHD_LATE_DOMAIN_FAILURE")
            return original(*args, **kwargs)
        with patch.object(source, "enqueue_job", side_effect=late):
            self.assertEqual(source.discover_eodhd_requests(self.db, now=AT), [])
        self.assertEqual(self.count("investor_eodhd_requests"), 0)
        self.assertEqual(self.count("job_runs"), 0)
        gap = self.db.execute("SELECT payload_json FROM outbox WHERE topic='investor.eodhd_source_gap'").fetchone()
        self.assertEqual(json.loads(gap[0])["code"], "EODHD_SOURCE_UNAVAILABLE")
        self.assert_no_finance()

    def test_four_single_attempt_captures_share_one_blob_and_keep_ten_year_deadlines(self):
        self.grant(); source.discover_eodhd_requests(self.db, now=AT); collector = Collector()
        for unused in range(4):
            self.assertEqual(self.run_capture(collector)["status"], "succeeded")
        self.assertIsNone(self.run_capture(collector))
        self.assertEqual(len(collector.calls), 4)
        self.assertEqual(self.count("investor_eodhd_captures"), 4)
        self.assertEqual(self.count("investor_eodhd_payloads"), 1)
        for row in self.db.execute("SELECT * FROM investor_eodhd_captures"):
            self.assertEqual(row["retain_until"], "2036-11-01T05:00:03.000Z")
            value = json.loads(row["document_json"])
            self.assertEqual(value["qualification"], source.SYNTHETIC)
            for flag in ("owner_reviewed", "research_admitted", "corporate_actions_complete", "live_advice_eligible"):
                self.assertFalse(value[flag])
        self.assertEqual(self.count("investor_data_reviews"), 0)
        self.assert_no_finance()

    def test_io_holds_no_writer_and_pause_during_call_discards_raw_without_restarting(self):
        authority = self.grant(); source.discover_eodhd_requests(self.db, now=AT)
        def during():
            other = open_database(self.path)
            try:
                other.execute("BEGIN IMMEDIATE"); other.execute("ROLLBACK")
                source.set_authority_enabled(other, "w", "synthetic-investor", authority["id"], False, now=AT)
            finally: other.close()
        collector = Collector(during=during)
        self.assertEqual(self.run_capture(collector)["status"], "skipped")
        self.assertEqual(len(collector.calls), 1)
        self.assertEqual(self.count("investor_eodhd_payloads"), 0)
        self.assertEqual(self.db.execute("SELECT status FROM investor_eodhd_captures").fetchone()[0], "superseded")
        self.assertEqual(source.discover_eodhd_requests(self.db, now=AT), [])
        self.assert_no_finance()

    def test_timeout_closes_one_attempt_and_inhibits_the_remaining_daily_requests(self):
        self.grant(); source.discover_eodhd_requests(self.db, now=AT)
        collector = Collector(error=WorkbenchError("EODHD_CAPTURE_CALL_TIMEOUT"))
        self.assertEqual(self.run_capture(collector)["status"], "failed")
        for unused in range(3):
            self.assertEqual(self.run_capture(collector)["status"], "skipped")
        self.assertIsNone(self.run_capture(collector))
        self.assertEqual(len(collector.calls), 1)
        self.assertEqual(self.count("investor_eodhd_payloads"), 0)
        self.assertTrue(all(row[0] == row[1] == 1 for row in self.db.execute("SELECT attempt_count,max_attempts FROM job_runs")))
        self.assert_no_finance()

    def test_late_payload_failure_rolls_back_capture_and_keeps_unknown_io_closed(self):
        self.grant(); source.discover_eodhd_requests(self.db, now=AT)
        self.db.execute("CREATE TEMP TRIGGER fictional_eodhd_payload_failure BEFORE INSERT ON investor_eodhd_payloads BEGIN SELECT RAISE(ABORT,'FICTIONAL_EODHD_PAYLOAD_FAILURE'); END")
        collector = Collector()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "FICTIONAL_EODHD_PAYLOAD_FAILURE"):
            self.run_capture(collector)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs WHERE attempt_count=1").fetchone()[0], "failed")
        self.assertEqual(self.count("investor_eodhd_captures"), 0)
        self.assertEqual(self.count("investor_eodhd_payloads"), 0)
        for unused in range(3):
            self.assertEqual(self.run_capture(collector)["status"], "skipped")
        self.assertEqual(len(collector.calls), 1)
        self.assertEqual(source.discover_eodhd_requests(self.db, now=AT), [])
        self.assert_no_finance()

    def test_closed_day_fast_path_does_not_replay_permissions_or_claim_a_data_qualification(self):
        self.grant(); source.discover_eodhd_requests(self.db, now=AT)
        changes = self.db.total_changes
        with patch.object(source, "_grant", side_effect=AssertionError("NO_NEW_SLOT_NO_PERMISSION_REPLAY")), \
                patch.object(source.receiver, "collect_eodhd_action_draft") as transport:
            self.assertEqual(source.discover_eodhd_requests(self.db, now=AT), [])
        transport.assert_not_called()
        self.assertEqual(self.db.total_changes, changes)
        self.assertEqual(self.count("investor_eodhd_captures"), 0)

    def test_draft_replay_is_owner_bound_read_only_and_does_not_renew_or_require_collection_enablement(self):
        authority = self.grant(); source.discover_eodhd_requests(self.db, now=AT)
        result = self.run_capture(Collector()); identity = json.loads(result["result_json"])["capture_id"]
        with self.assertRaisesRegex(WorkbenchError, "SYNTHETIC_CAPTURE_FORBIDDEN"):
            source.resolve_eodhd_capture(self.db, "w", "synthetic-investor", identity, now=AT)
        before = self.db.total_changes
        value = source.resolve_eodhd_capture(self.db, "w", "synthetic-investor", identity, now=AT, allow_synthetic=True)
        self.assertEqual(value["raw"], b"[]"); self.assertFalse(value["draft"]["corporate_actions_complete"])
        self.assertEqual(self.db.total_changes, before)
        with self.assertRaises(WorkbenchError):
            source.resolve_eodhd_capture(self.db, "w", "foreign", identity, now=AT, allow_synthetic=True)
        source.set_authority_enabled(self.db, "w", "synthetic-investor", authority["id"], False, now=AT)
        self.assertEqual(source.resolve_eodhd_capture(self.db, "w", "synthetic-investor", identity, now="2028-01-01T00:00:00.000Z", allow_synthetic=True)["capture"]["retain_until"], value["capture"]["retain_until"])
        self.assert_no_finance()

    def test_expiry_hides_raw_before_cleanup_and_shared_blob_waits_for_all_due_receipts(self):
        self.grant(); source.discover_eodhd_requests(self.db, now=AT); collector = Collector()
        for unused in range(4): self.run_capture(collector)
        rows = self.db.execute("SELECT id,retain_until FROM investor_eodhd_captures ORDER BY id").fetchall()
        with self.assertRaisesRegex(WorkbenchError, "PURGE_NOT_DUE"):
            source.purge_eodhd_capture(self.db, "w", "synthetic-investor", rows[0]["id"], now=AT)
        due = rows[0]["retain_until"]
        with self.assertRaisesRegex(WorkbenchError, "RETENTION_EXPIRED"):
            source.resolve_eodhd_capture(self.db, "w", "synthetic-investor", rows[0]["id"], now=due, allow_synthetic=True)
        for index, row in enumerate(rows):
            source.purge_eodhd_capture(self.db, "w", "synthetic-investor", row["id"], now=due)
            self.assertEqual(self.count("investor_eodhd_payloads"), 0 if index == 3 else 1)
            with self.assertRaisesRegex(WorkbenchError, "PAYLOAD_PURGED"):
                source.resolve_eodhd_capture(self.db, "w", "synthetic-investor", row["id"], now=due, allow_synthetic=True)
        self.assert_no_finance()

    def test_unknown_outcome_inspection_never_claims_a_retry_or_complete_capture(self):
        self.grant(); jobs = source.discover_eodhd_requests(self.db, now=AT)
        first = source.inspect_request(self.db, "w", "synthetic-investor", jobs[0]["period"], now=AT)
        self.assertEqual(first["status"], "queued")
        from worker.orchestration.jobs import claim_job
        lease = claim_job(self.db, "fictional-unknown-worker", 180, source.JOB_TYPE, now=AT)
        request_id = self.db.execute("SELECT period FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()[0]
        value = source.inspect_request(self.db, "w", "synthetic-investor", request_id, now=AT)
        self.assertEqual(value["status"], "indeterminate_no_retry")
        self.assertFalse(value["automatic_retry_permitted"]); self.assertIsNone(value["capture_id"])
        self.assert_no_finance()

    def test_sql_retyping_replacing_deleting_and_budget_increases_are_rejected(self):
        self.grant(); jobs = source.discover_eodhd_requests(self.db, now=AT)
        job = jobs[0]
        for clause in ("max_attempts=2", "job_type='ordinary'", "period='another'", "input_version='another'", "attempt_count=1",
                "status='retry_queued'", "fencing_token=2", "id='another'"):
            with self.assertRaises(sqlite3.IntegrityError): self.db.execute("UPDATE job_runs SET " + clause + " WHERE id=?", (job["id"],))
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("DELETE FROM job_runs WHERE id=?", (job["id"],))
        columns = list(job)
        for changes in ({}, {"job_type": "ordinary"}, {"id": "another", "max_attempts": 2}):
            value = {**job, **changes}
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("INSERT OR REPLACE INTO job_runs(" + ",".join(columns) + ") VALUES(" + ",".join("?" for unused in columns) + ")",
                    [value[column] for column in columns])
        self.assertEqual(self.count("job_runs"), 4); self.assert_no_finance()

    def test_heartbeat_then_expiry_closes_unknown_attempt_and_cannot_reset_or_claim_success(self):
        self.grant(); source.discover_eodhd_requests(self.db, now=AT)
        lease = claim_job(self.db, "fictional-interrupted", 180, source.JOB_TYPE, now=AT)
        lease = heartbeat(self.db, lease, 180, now=AT)
        other = open_database(self.path); self.addCleanup(other.close)
        self.assertIsNone(claim_job(other, "fictional-concurrent", 180, source.JOB_TYPE, now=AT))
        with self.assertRaises(sqlite3.IntegrityError): complete_job(self.db, lease, {}, now=AT)
        attempt = dict(self.db.execute("SELECT * FROM job_attempts").fetchone())
        for clause in ("status='succeeded',finished_at=started_at", "attempt=2", "fencing_token=99", "started_at='2026-01-01'"):
            with self.assertRaises(sqlite3.IntegrityError): self.db.execute("UPDATE job_attempts SET " + clause)
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("DELETE FROM job_attempts")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT OR REPLACE INTO job_attempts VALUES(?,?,?,?,?,?,?,?)", tuple(attempt.values()))
        late = "2026-11-01T05:03:04.000Z"
        collector = Collector()
        self.assertEqual(self.run_capture(collector, clock=lambda: late)["status"], "skipped")
        job = self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()
        self.assertEqual((job["status"], job["attempt_count"], job["max_attempts"]), ("failed", 1, 1))
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("UPDATE job_runs SET status='queued',attempt_count=0 WHERE id=?", (lease.job_id,))
        self.assertEqual(source.inspect_request(self.db, "w", "synthetic-investor", job["period"], now=late)["status"], "indeterminate_no_retry")
        self.assertEqual(collector.calls, []); self.assert_no_finance()

    def test_queue_cancellation_is_terminal_but_not_an_unknown_network_attempt(self):
        self.grant(); jobs = source.discover_eodhd_requests(self.db, now=AT)
        self.db.execute("UPDATE job_runs SET status='cancelled' WHERE id=?", (jobs[0]["id"],))
        value = source.inspect_request(self.db, "w", "synthetic-investor", jobs[0]["period"], now=AT)
        self.assertEqual(value["status"], "closed_without_capture"); self.assertFalse(value["automatic_retry_permitted"])
        self.assertEqual(source.discover_eodhd_requests(self.db, now=AT), [])
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("UPDATE job_runs SET status='queued' WHERE id=?", (jobs[0]["id"],))
        self.assert_no_finance()

    def test_last_pre_io_clock_pause_is_rechecked_and_never_reads_credentials(self):
        authority = self.grant(); source.discover_eodhd_requests(self.db, now=AT)
        calls = []
        def clock():
            calls.append(True)
            if len(calls) == 4:
                source.set_authority_enabled(self.db, "w", "synthetic-investor", authority["id"], False, now=AT)
            return AT
        collector = Collector()
        self.assertEqual(self.run_capture(collector, clock=clock)["status"], "skipped")
        self.assertEqual(collector.calls, []); self.assertEqual(self.count("investor_eodhd_payloads"), 0)
        self.assert_no_finance()

    def test_pause_after_prepare_but_before_commit_discards_in_memory_payload(self):
        authority = self.grant(); source.discover_eodhd_requests(self.db, now=AT)
        lease = claim_job(self.db, "fictional-prepared", 180, source.JOB_TYPE, now=AT)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        collector = Collector(); prepared = source.prepare_eodhd_capture(self.db, job, lease, clock=lambda: AT, test_collector=collector)
        self.assertEqual(len(collector.calls), 1)
        source.set_authority_enabled(self.db, "w", "synthetic-investor", authority["id"], False, now=AT)
        complete_job(self.db, lease, {}, effect=prepared["effect"], now=AT, clock=lambda: AT)
        self.assertEqual(self.db.execute("SELECT status FROM investor_eodhd_captures").fetchone()[0], "superseded")
        self.assertEqual(self.count("investor_eodhd_payloads"), 0); self.assert_no_finance()

    def test_expired_before_transport_or_after_transport_never_publishes_or_retries(self):
        self.grant(); source.discover_eodhd_requests(self.db, now=AT)
        state = [AT]; collector = Collector(during=lambda: state.__setitem__(0, "2026-11-01T05:03:04.000Z"))
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            self.run_capture(collector, clock=lambda: state[0])
        self.assertEqual(len(collector.calls), 1); self.assertEqual(self.count("investor_eodhd_captures"), 0)
        self.assertEqual(self.count("investor_eodhd_payloads"), 0)
        for unused in range(3): self.assertEqual(self.run_capture(collector, clock=lambda: state[0])["status"], "skipped")
        self.assertEqual(len(collector.calls), 1); self.assert_no_finance()

    def test_next_day_has_a_new_bounded_window_but_cannot_reopen_old_slots(self):
        self.grant(); source.discover_eodhd_requests(self.db, now=AT)
        collector = Collector()
        for unused in range(4): self.run_capture(collector)
        next_day = "2026-11-02T06:00:03.000Z"
        self.assertEqual(len(source.discover_eodhd_requests(self.db, now=next_day)), 4)
        self.assertEqual(source.discover_eodhd_requests(self.db, now=AT), [])
        requests = self.db.execute("SELECT document_json FROM investor_eodhd_requests WHERE source_day='2026-11-02'").fetchall()
        self.assertTrue(all(json.loads(row[0])["parameters"]["end_date"] == "2026-11-01" for row in requests))
        self.assertEqual(self.count("investor_eodhd_requests"), 8); self.assertEqual(len(collector.calls), 4)
        self.assertEqual(source._retention_until("2028-02-29T12:00:00.000Z"), "2038-02-28T12:00:00.000Z")
        self.assert_no_finance()

    def test_real_runtime_routes_capture_only_to_isolated_provider_and_core_purges_with_shared_budget(self):
        authority = self.grant(); collector = Collector(); original = source.prepare_eodhd_capture
        def injected(db, job, lease, **options):
            return original(db, job, lease, test_collector=collector, **options)
        with patch.object(source, "prepare_eodhd_capture", side_effect=injected):
            for role in ("core", "verifier"):
                self.assertIsNone(run_pending_once(self.db, "fictional-" + role, role=role, clock=lambda: AT))
            self.assertEqual(self.count("investor_eodhd_requests"), 0)
            for unused in range(4):
                self.assertEqual(run_pending_once(self.db, "fictional-provider", role="longport", clock=lambda: AT)["status"], "succeeded")
        self.assertEqual(len(collector.calls), 4)
        source.set_authority_enabled(self.db, "w", "synthetic-investor", authority["id"], False, now=AT)
        self.assertEqual(purge_due_source_payloads(self.db, now="2028-01-01T00:00:00.000Z"), [])
        due = self.db.execute("SELECT retain_until FROM investor_eodhd_captures LIMIT 1").fetchone()[0]
        for remaining in (3, 2, 1, 0):
            self.assertEqual(len(purge_due_source_payloads(self.db, limit=1, now=due)), 1)
            self.assertEqual(self.count("investor_eodhd_payloads"), 1 if remaining else 0)
        self.assert_no_finance()

if __name__ == "__main__":
    unittest.main()
