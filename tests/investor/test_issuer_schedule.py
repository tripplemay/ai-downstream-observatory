"""Fictional scheduled issuer drafts; no real provider or economic approval."""

from copy import deepcopy
from datetime import timedelta
import sqlite3
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

from tests.investor import test_runtime as queue
from tests.investor.test_issuer_sources import Collector, policy, NOW, LATER
from worker.investor import issuer_sources as sources, issuer_schedule as schedule
from worker.orchestration.db import WorkbenchError, instant, open_database
from worker.orchestration.jobs import claim_job, complete_job, run_one
from worker.orchestration.runtime import run_pending_once


def scheduled(grant, **changes):
    return {"schema_version": "investor-issuer-schedule-policy-v1", "authority_id": grant["id"], "authority_hash": grant["content_hash"],
        "lookback_days": 366, "run_after_hour": 1, "timezone": "America/New_York", "valid_from": "2025-01-01T00:00:00.000Z",
        "valid_until": "2027-01-01T00:00:00.000Z", "standing_collection_authorized": True,
        "collection_scope": "unapproved_distribution_draft_only", "automatic_retry_permitted": False, **changes}


class IssuerScheduleTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance

    def count(self, name): return self.db.execute("SELECT count(*) FROM " + name).fetchone()[0]

    def grant(self, *, enabled=True, source_policy=None, at=NOW):
        parent = sources.register_authority(self.db, "w", "synthetic-investor", source_policy or policy(), now=at)
        sources.set_authority_enabled(self.db, "w", "synthetic-investor", parent["id"], True, now=at)
        row = schedule.register_schedule(self.db, "w", "synthetic-investor", scheduled(parent), now=at)
        if enabled: schedule.set_schedule_enabled(self.db, "w", "synthetic-investor", row["id"], True, now=at)
        return parent, row

    def run_capture(self, mock=None, at=NOW):
        mock = mock or Collector(at)
        with patch.object(sources.receiver, "collect_vanguard_distribution_draft", side_effect=mock):
            result = run_pending_once(self.db, "fictional-issuer-provider", role="longport", lease_seconds=180, clock=lambda: at)
        return result, mock

    def latest(self, at=NOW):
        row = self.db.execute("SELECT id FROM investor_issuer_schedule_requests ORDER BY rowid DESC LIMIT 1").fetchone()
        return schedule.inspect_scheduled_request(self.db, "w", "synthetic-investor", row["id"], now=at)

    def test_old_permission_does_not_authorize_scheduling_and_new_registration_is_disabled(self):
        parent = sources.register_authority(self.db, "w", "synthetic-investor", policy(), now=NOW)
        sources.set_authority_enabled(self.db, "w", "synthetic-investor", parent["id"], True, now=NOW)
        result, mock = self.run_capture(); self.assertIsNone(result); self.assertEqual(mock.calls, 0)
        original = scheduled(parent); before = deepcopy(original)
        row = schedule.register_schedule(self.db, "w", "synthetic-investor", original, now=NOW)
        self.assertEqual(original, before)
        self.assertEqual(schedule.register_schedule(self.db, "w", "synthetic-investor", original, now=NOW)["id"], row["id"])
        result, mock = self.run_capture(); self.assertIsNone(result); self.assertEqual(mock.calls, 0)
        self.assertEqual(self.count("investor_issuer_requests"), 0); self.assert_no_finance()

    def test_ordinary_provider_role_commits_one_draft_with_audited_job_and_dedup_payload(self):
        self.grant(); result, mock = self.run_capture()
        self.assertEqual(result["status"], "succeeded"); self.assertEqual(mock.calls, 1)
        self.assertEqual(result["max_attempts"], 1)
        state = self.latest(); self.assertEqual(state["status"], "captured"); self.assertFalse(state["research_admitted"])
        value = sources.resolve_issuer_capture(self.db, "w", "synthetic-investor", state["capture_id"], now=NOW)
        self.assertFalse(value["draft"]["corporate_actions_complete"])
        result, mock = self.run_capture(); self.assertIsNone(result); self.assertEqual(mock.calls, 0)
        result, mock = self.run_capture(at=LATER); self.assertEqual(result["status"], "succeeded"); self.assertEqual(mock.calls, 1)
        self.assertEqual(self.count("investor_issuer_payloads"), 1); self.assertEqual(self.count("investor_issuer_captures"), 2)
        self.assertEqual(self.count("investor_issuer_schedule_results"), 2)
        self.assertIsNone(run_pending_once(self.db, "fictional-issuer-core", role="core", clock=lambda: LATER))
        for name in ("investor_models", "investor_data_reviews", "investor_monitor_evidence_inputs", "investor_evidence_inputs"):
            self.assertEqual(self.count(name), 0)
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], 0); self.assert_no_finance()

    def test_manual_attempt_and_another_authority_or_flag_cannot_reset_the_shared_fund_day(self):
        parent, row = self.grant()
        sources.collect_issuer_draft(self.db, "w", "synthetic-investor", parent["id"], "a" * 32, "2025-01-01", "2026-01-03",
            now=NOW, test_collector=Collector())
        result, mock = self.run_capture(); self.assertIsNone(result); self.assertEqual(mock.calls, 0)
        self.assertEqual(self.count("investor_issuer_schedule_requests"), 0)
        self.assertEqual(self.count("investor_issuer_requests"), 1)
        alternate = sources.register_authority(self.db, "w", "synthetic-investor", policy(has_distribution_yield=True), now=NOW)
        sources.set_authority_enabled(self.db, "w", "synthetic-investor", alternate["id"], True, now=NOW)
        next_schedule = schedule.register_schedule(self.db, "w", "synthetic-investor", scheduled(alternate), now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "AMBIGUOUS"):
            schedule.set_schedule_enabled(self.db, "w", "synthetic-investor", next_schedule["id"], True, now=NOW)
        schedule.set_schedule_enabled(self.db, "w", "synthetic-investor", row["id"], False, now=NOW)
        schedule.set_schedule_enabled(self.db, "w", "synthetic-investor", next_schedule["id"], True, now=NOW)
        result, mock = self.run_capture(); self.assertIsNone(result); self.assertEqual(mock.calls, 0)
        self.assertEqual(self.count("investor_issuer_requests"), 1)

    def test_concurrent_discovery_cannot_allocate_a_second_request_or_repeat_transport(self):
        self.grant(); first = schedule.discover_issuer_requests(self.db, now=NOW)
        other = open_database(self.path); self.addCleanup(other.close)
        self.assertEqual(schedule.discover_issuer_requests(other, now=NOW), [])
        self.assertEqual(len(first), 1); self.assertEqual(self.count("investor_issuer_requests"), 1)
        observed = []
        def during():
            observed.append(self.latest()["status"])
            self.assertEqual(schedule.discover_issuer_requests(other, now=NOW), [])
            self.assertFalse(self.db.in_transaction)
        result, mock = self.run_capture(Collector(during=during))
        self.assertEqual(result["status"], "succeeded"); self.assertEqual(mock.calls, 1); self.assertEqual(observed, ["indeterminate"])

    def test_core_and_verifier_cannot_consume_the_queued_provider_job(self):
        self.grant(); schedule.discover_issuer_requests(self.db, now=NOW)
        with patch.object(sources.receiver, "collect_vanguard_distribution_draft") as collector:
            for role in ("core", "verifier"):
                self.assertIsNone(run_pending_once(self.db, "fictional-wrong-role", role=role, clock=lambda: NOW))
            collector.assert_not_called()
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "queued")

    def test_second_connection_withdrawal_after_preparation_fences_the_atomic_commit(self):
        _, row = self.grant(); schedule.discover_issuer_requests(self.db, now=NOW)
        lease = claim_job(self.db, "fictional-prepared-provider", lease_seconds=180, job_type=schedule.JOB_TYPE, now=NOW)
        job = self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()
        mock = Collector()
        with patch.object(sources.receiver, "collect_vanguard_distribution_draft", side_effect=mock):
            prepared = schedule.prepare_issuer_capture(self.db, job, lease, clock=lambda: NOW)
        other = open_database(self.path); self.addCleanup(other.close)
        schedule.set_schedule_enabled(other, "w", "synthetic-investor", row["id"], False, now=NOW)
        complete_job(self.db, lease, {}, effect=prepared["effect"], now=NOW, clock=lambda: NOW)
        self.assertEqual(mock.calls, 1); self.assertEqual(self.latest()["status"], "superseded")
        self.assertEqual(self.count("investor_issuer_payloads"), 0); self.assert_no_finance()

    def test_day_boundary_dst_run_hour_and_expiry_are_not_fixed_24_hour_offsets(self):
        parent, old = self.grant(enabled=False)
        for at, expected, hour in (("2026-03-08T06:30:00.000Z", "2026-03-09T04:00:00.000Z", 1),
                ("2026-11-01T05:30:00.000Z", "2026-11-02T05:00:00.000Z", 1)):
            row = schedule.register_schedule(self.db, "w", "synthetic-investor", scheduled(parent, run_after_hour=hour, lookback_days=365), now=at)
            schedule.set_schedule_enabled(self.db, "w", "synthetic-investor", row["id"], True, now=at)
            self.assertEqual(len(schedule.discover_issuer_requests(self.db, now=at)), 1)
            self.assertEqual(self.db.execute("SELECT valid_until FROM investor_issuer_schedule_requests ORDER BY rowid DESC LIMIT 1").fetchone()[0], expected)
            schedule.set_schedule_enabled(self.db, "w", "synthetic-investor", row["id"], False, now=at)

    def test_not_before_hour_and_too_short_remaining_window_never_start_io(self):
        parent, _ = self.grant(enabled=False)
        row = schedule.register_schedule(self.db, "w", "synthetic-investor", scheduled(parent, run_after_hour=23), now=NOW)
        schedule.set_schedule_enabled(self.db, "w", "synthetic-investor", row["id"], True, now=NOW)
        self.assertEqual(schedule.discover_issuer_requests(self.db, now=NOW), [])
        late = "2026-01-04T04:59:40.000Z"
        self.assertEqual(schedule.discover_issuer_requests(self.db, now=late), [])
        self.assertEqual(self.count("investor_issuer_requests"), 0)

    def test_expired_claim_is_unknown_and_never_automatically_retried(self):
        self.grant(); schedule.discover_issuer_requests(self.db, now=NOW)
        claim_job(self.db, "fictional-crashed", lease_seconds=1, job_type=schedule.JOB_TYPE, now=NOW)
        later = "2026-01-03T12:00:05.000Z"
        result, mock = self.run_capture(at=later); self.assertIsNone(result); self.assertEqual(mock.calls, 0)
        self.assertEqual(self.latest(later)["status"], "indeterminate")
        self.assertFalse(self.latest(later)["automatic_retry_permitted"])
        self.assertEqual(self.count("investor_issuer_captures"), 0)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "failed")

    def test_insufficient_lease_budget_never_opens_transport(self):
        self.grant(); schedule.discover_issuer_requests(self.db, now=NOW)
        with patch.object(sources.receiver, "collect_vanguard_distribution_draft") as collector:
            result = run_one(self.db, "fictional-short-lease", lambda job, lease: schedule.prepare_issuer_capture(self.db, job, lease, clock=lambda: NOW),
                job_type=schedule.JOB_TYPE, lease_seconds=1, clock=lambda: NOW)
            collector.assert_not_called()
        self.assertEqual(result["status"], "skipped"); self.assertEqual(self.latest()["status"], "superseded")

    def test_transport_failure_is_a_closed_terminal_result_not_an_automatic_retry(self):
        self.grant()
        def failure(): raise WorkbenchError("VANGUARD_CAPTURE_HTTP_RATE_LIMITED")
        result, mock = self.run_capture(Collector(during=failure))
        self.assertEqual(result["status"], "failed"); self.assertEqual(mock.calls, 1)
        self.assertEqual(self.latest()["status"], "transport_failed")
        self.assertEqual(self.count("investor_issuer_payloads"), 0)
        result, mock = self.run_capture(); self.assertIsNone(result); self.assertEqual(mock.calls, 0)

    def test_microsecond_future_job_cannot_be_hidden_by_a_millisecond_reader_clock(self):
        self.grant(); self.run_capture(); self.assertEqual(self.latest()["status"], "captured")
        self.db.execute("UPDATE job_runs SET created_at='2026-01-03T12:00:03.000001Z'")
        with self.assertRaises(WorkbenchError): self.latest()

    def test_runtime_datetime_clock_keeps_precise_job_and_transport_times_without_changing_source_dates(self):
        self.grant(); at = instant(NOW) + timedelta(microseconds=123)
        mock = Collector(at.isoformat(timespec="microseconds").replace("+00:00", "Z"))
        result, mock = self.run_capture(mock, at=at)
        self.assertEqual(result["status"], "succeeded"); self.assertEqual(mock.calls, 1)
        row = self.db.execute("SELECT id FROM investor_issuer_schedule_requests").fetchone()
        state = schedule.inspect_scheduled_request(self.db, "w", "synthetic-investor", row["id"], now=at)
        self.assertEqual(state["status"], "captured")
        captured = self.db.execute("SELECT * FROM investor_issuer_captures").fetchone()
        receipt = json.loads(captured["document_json"])
        self.assertEqual(captured["created_at"], NOW)
        self.assertEqual(receipt["transport"]["retrieved_at"], "2026-01-03T12:00:03.000123Z")
        with self.assertRaises(WorkbenchError): schedule.inspect_scheduled_request(self.db, "w", "synthetic-investor", row["id"], now=NOW)

    def test_empty_schedule_discovery_accepts_a_wall_clock_without_affecting_other_provider_work(self):
        self.assertEqual(schedule.discover_issuer_requests(self.db, now=instant(NOW) + timedelta(microseconds=123)), [])

    def test_private_cli_registration_reuses_actual_enabled_state_without_fetch_or_raw_output(self):
        parent, row = self.grant()
        self.path.chmod(0o600)
        filename = self.path.parent / "fictional-issuer-schedule.json"
        filename.write_text(json.dumps(scheduled(parent))); filename.chmod(0o600)
        result = subprocess.run([sys.executable, "-m", "worker.investor.data_pipeline", "--db", str(self.path),
            "--workspace", "w", "--actor", "synthetic-investor", "register-issuer-schedule", "--file", str(filename)],
            capture_output=True, text=True, timeout=30, env={"PATH": os.environ["PATH"]})
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads(result.stdout)
        self.assertEqual(state["schedule_id"], row["id"]); self.assertTrue(state["enabled"])
        self.assertFalse(state["research_admitted"]); self.assertEqual(self.count("investor_issuer_requests"), 0)

    def test_source_or_schedule_withdrawal_during_transport_discards_returned_bytes(self):
        for scope in ("source", "schedule"):
            if scope == "schedule": self.setUp()
            parent, row = self.grant()
            def withdraw():
                if scope == "source": sources.set_authority_enabled(self.db, "w", "synthetic-investor", parent["id"], False, now=NOW)
                else: schedule.set_schedule_enabled(self.db, "w", "synthetic-investor", row["id"], False, now=NOW)
            result, mock = self.run_capture(Collector(during=withdraw))
            self.assertEqual(mock.calls, 1); self.assertEqual(result["status"], "skipped")
            self.assertEqual(self.latest()["status"], "superseded"); self.assertEqual(self.count("investor_issuer_payloads"), 0)

    def test_stop_and_restore_before_or_during_transport_do_not_publish_or_resend(self):
        self.grant()
        with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}), self.assertRaisesRegex(WorkbenchError, "READ_ONLY"):
            schedule.discover_issuer_requests(self.db, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            schedule.discover_issuer_requests(self.db, now=NOW, stop_requested=lambda: True)
        schedule.discover_issuer_requests(self.db, now=NOW)
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        mock = Collector(during=lambda: marker.touch())
        try:
            with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"): self.run_capture(mock)
        finally: marker.unlink(missing_ok=True)
        self.assertEqual(mock.calls, 1); self.assertEqual(self.count("investor_issuer_captures"), 0)
        self.assertEqual(self.count("investor_issuer_payloads"), 0)

    def test_lost_lease_after_transport_keeps_unknown_attempt_without_committing_bytes(self):
        self.grant(); clock = [NOW]
        mock = Collector(during=lambda: clock.__setitem__(0, "2026-01-03T12:04:03.000Z"))
        with patch.object(sources.receiver, "collect_vanguard_distribution_draft", side_effect=mock), self.assertRaisesRegex(WorkbenchError, "LEASE"):
            run_pending_once(self.db, "fictional-expired-provider", role="longport", lease_seconds=180, clock=lambda: clock[0])
        self.assertEqual(mock.calls, 1); self.assertEqual(self.count("investor_issuer_captures"), 0)
        result, mock = self.run_capture(at=clock[0]); self.assertIsNone(result); self.assertEqual(mock.calls, 0)
        self.assertEqual(self.latest(clock[0])["status"], "indeterminate")

    def test_issuer_midnight_crossing_discards_late_bytes_even_while_lease_remains_valid(self):
        at = "2026-01-04T04:59:00.000Z"
        self.grant(at=at); clock = [at]
        mock = Collector(at, during=lambda: clock.__setitem__(0, "2026-01-04T05:00:05.000Z"))
        with patch.object(sources.receiver, "collect_vanguard_distribution_draft", side_effect=mock):
            result = run_pending_once(self.db, "fictional-midnight-provider", role="longport", lease_seconds=180, clock=lambda: clock[0])
        self.assertEqual(result["status"], "skipped"); self.assertEqual(mock.calls, 1)
        self.assertEqual(self.latest(clock[0])["status"], "superseded"); self.assertEqual(self.count("investor_issuer_payloads"), 0)

    def test_stop_after_final_schedule_audit_rolls_back_payload_capture_and_job_receipt(self):
        self.grant(); schedule.discover_issuer_requests(self.db, now=NOW)
        stopped = [False]; original = schedule._audit
        def audit(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[2] == "investor_finish_issuer_schedule": stopped[0] = True
            return result
        with patch.object(schedule, "_audit", side_effect=audit), patch.object(sources.receiver, "collect_vanguard_distribution_draft", side_effect=Collector()), self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            run_one(self.db, "fictional-late-stop", lambda job, lease: schedule.prepare_issuer_capture(self.db, job, lease, clock=lambda: NOW,
                stop_requested=lambda: stopped[0]), job_type=schedule.JOB_TYPE, lease_seconds=180, clock=lambda: NOW)
        for name in ("investor_issuer_captures", "investor_issuer_payloads", "investor_issuer_schedule_results"):
            self.assertEqual(self.count(name), 0)

    def test_late_result_audit_failure_atomically_rolls_back_capture_and_dedup_payload(self):
        self.grant()
        self.db.execute("CREATE TRIGGER fictional_late_issuer_abort BEFORE INSERT ON audit_events WHEN NEW.action='investor_finish_issuer_schedule' BEGIN SELECT RAISE(ABORT,'fictional late result audit'); END")
        mock = Collector()
        with self.assertRaises(sqlite3.IntegrityError): self.run_capture(mock)
        self.assertEqual(mock.calls, 1)
        for name in ("investor_issuer_captures", "investor_issuer_payloads", "investor_issuer_schedule_results"):
            self.assertEqual(self.count(name), 0)
        self.assertEqual(self.count("investor_issuer_requests"), 1)
        self.assertEqual(self.latest()["status"], "indeterminate")
        result, mock = self.run_capture(); self.assertIsNone(result); self.assertEqual(mock.calls, 0)

    def test_policy_scope_immutability_and_all_metadata_reads_cannot_be_resealed_into_approval(self):
        parent, row = self.grant()
        for change in ({"automatic_retry_permitted": True}, {"standing_collection_authorized": False}, {"lookback_days": 3661},
                {"endpoint": "https://arbitrary.invalid/"}, {"valid_until": "2028-01-01T00:00:00Z"}, {"authority_hash": "0" * 64}):
            with self.assertRaises((WorkbenchError, ValueError)): schedule.register_schedule(self.db, "w", "synthetic-investor", scheduled(parent, **change), now=NOW)
        with self.assertRaises(WorkbenchError): schedule.set_schedule_enabled(self.db, "foreign", "synthetic-investor", row["id"], True, now=NOW)
        self.run_capture(); before = self.db.total_changes; self.latest(); self.assertEqual(self.db.total_changes, before)
        for name in ("investor_issuer_schedules", "investor_issuer_schedule_controls", "investor_issuer_schedule_requests", "investor_issuer_schedule_results"):
            for sql in ("UPDATE " + name + " SET content_hash=content_hash", "DELETE FROM " + name, "INSERT OR REPLACE INTO " + name + " SELECT * FROM " + name):
                with self.assertRaises(sqlite3.IntegrityError): self.db.execute(sql)
        self.db.execute("DROP TRIGGER investor_issuer_schedule_result_update")
        self.db.execute("UPDATE investor_issuer_schedule_results SET content_hash=?", ("0" * 64,))
        with self.assertRaises(WorkbenchError): self.latest()
        self.assert_no_finance()


if __name__ == "__main__": unittest.main()
