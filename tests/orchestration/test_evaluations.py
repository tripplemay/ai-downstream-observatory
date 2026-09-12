"""Synthetic scheduler lifecycle tests, not strategy or investment acceptance."""

from copy import deepcopy
from datetime import timedelta
from hashlib import sha256
import json
import unittest
from unittest.mock import patch

from tests.market.support import NOW, database, ledger_event, rules, seed_account
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, stamp, transaction
from worker.orchestration.evaluations import DiscoveryState, discover_due_cycles, scheduled_instant
from worker.orchestration.jobs import assert_lease, claim_job, complete_job, fail_job, run_one
from worker.orchestration.runtime import run_pending_once, sync_requests


def schedule_definition():
    return {"schema_version": "evaluation-schedule-v1", "frequency": "monthly", "environment": "actual",
            "policy_version_id": "policy", "strategy_version_id": "strategy", "activation_id": "activation",
            "timezone": "UTC", "start_month": "2025-01", "end_month": None,
            "trigger": {"day": 3, "hour": 10, "minute": 0}, "deadline_seconds": 3600, "max_attempts": 2,
            "targets": {"method": "manual_weight_targets_v1", "weight_basis": "portfolio_nav",
                        "rows": [{"account_id": "a", "listing_id": "CN:TEST", "currency": "CNY", "weight": "0.2"}],
                        "absolute_tolerance_cny": "0", "weight_tolerance": "0",
                        "tolerance_rule": "max_absolute_or_weight", "unlisted_strategy_positions": "block",
                        "pending_activity": "block", "price_rule": "close_rounded_to_step", "quantity_rule": "floor_to_step"}}


class EvaluationFixture:
    def setUp(self):
        self.db, self.path = database(self)
        seed_account(self.db)
        self.db.execute("""INSERT INTO policy_versions
            (id,portfolio_id,version,policy_json,content_hash,created_by,created_at)
            VALUES('policy','p',1,'{}',?,'synthetic-human',?)""", (content_hash({}), stamp(NOW)))
        self.db.execute("""INSERT INTO strategy_versions
            (id,portfolio_id,strategy_key,version,parameters_json,content_hash,created_by,created_at)
            VALUES('strategy','p','synthetic-strategy',1,'{}',?,'synthetic-human',?)""", (content_hash({}), stamp(NOW)))

    def schedule(self, definition=None, enabled=True, approved_at=None, bad_hash=False, human=True):
        definition = deepcopy(definition or schedule_definition())
        self.definition = definition
        created = stamp(approved_at or NOW - timedelta(days=2))
        raw = json.dumps(definition, indent=2)
        digest = "a" * 64 if bad_hash else sha256(raw.encode()).hexdigest()
        self.db.execute("""INSERT INTO evaluation_schedules
            (id,portfolio_id,environment,strategy_key,scope_key,created_by,created_at)
            VALUES('schedule','p','actual','synthetic-strategy','portfolio','synthetic-human',?)""", (created,))
        self.db.execute("""INSERT INTO evaluation_schedule_versions
            (id,schedule_id,version,policy_version_id,strategy_version_id,definition_json,content_hash,created_by,created_at)
            VALUES('schedule-v1','schedule',1,'policy','strategy',?,?,'synthetic-human',?)""", (raw, digest, created))
        self.audit("saved", "paused", 1, created, action="save_evaluation_schedule")
        self.db.execute("""INSERT INTO evaluation_schedule_heads
            (schedule_id,current_version_id,revision,status,last_audit_id,updated_at)
            VALUES('schedule','schedule-v1',1,'paused','saved',?)""", (created,))
        if enabled:
            self.audit("enabled", "enabled", 2, created, human=human)
            self.db.execute("""UPDATE evaluation_schedule_heads SET revision=2,status='enabled',
                last_audit_id='enabled',updated_at=? WHERE schedule_id='schedule'""", (created,))

    def audit(self, identity, status, revision, at, version="schedule-v1", human=True,
              action="set_evaluation_schedule_status"):
        payload = {"actor_kind": "human" if human else "strategy",
                   "input": {"portfolio_id": "p", "schedule_id": "schedule", "status": status},
                   "result": {"schedule_id": "schedule", "version_id": version,
                              "schedule_revision": revision, "status": status}}
        self.db.execute("""INSERT INTO audit_events
            (id,actor_id,action,object_type,object_id,portfolio_id,payload_json,created_at)
            VALUES(?,'synthetic-human',?,'evaluation_schedule','schedule','p',?,?)""",
                        (identity, action, canonical_json(payload), at))

    def dispatch(self, now=NOW):
        cycles = discover_due_cycles(self.db, now=now)
        jobs = sync_requests(self.db, now=now)
        return cycles, jobs

    def claim(self, seconds=60, now=NOW):
        return claim_job(self.db, "synthetic-worker", seconds, "monthly_evaluation", now=now)

    def second_schedule(self):
        definition = deepcopy(self.definition)
        definition["strategy_version_id"] = "strategy-two"
        raw = canonical_json(definition)
        created = stamp(NOW - timedelta(days=2))
        self.db.execute("""INSERT INTO strategy_versions
            SELECT 'strategy-two',portfolio_id,'synthetic-strategy-two',version,parameters_json,content_hash,created_by,created_at
            FROM strategy_versions WHERE id='strategy'""")
        self.db.execute("""INSERT INTO evaluation_schedules VALUES
            ('schedule-two','p','actual','synthetic-strategy-two','portfolio','synthetic-human',?)""", (created,))
        self.db.execute("""INSERT INTO evaluation_schedule_versions VALUES
            ('schedule-two-v1','schedule-two',1,'policy','strategy-two',?,?,'synthetic-human',?)""",
                        (raw, sha256(raw.encode()).hexdigest(), created))
        for name, status, revision in (("two-saved", "paused", 1), ("two-enabled", "enabled", 2)):
            payload = {"actor_kind": "human", "input": {"portfolio_id": "p", "schedule_id": "schedule-two", "status": status},
                       "result": {"schedule_id": "schedule-two", "version_id": "schedule-two-v1",
                                  "schedule_revision": revision, "status": status}}
            self.db.execute("""INSERT INTO audit_events
                (id,actor_id,action,object_type,object_id,portfolio_id,payload_json,created_at)
                VALUES(?,'synthetic-human','set_evaluation_schedule_status','evaluation_schedule','schedule-two','p',?,?)""",
                            (name, canonical_json(payload), created))
        self.db.execute("""INSERT INTO evaluation_schedule_heads VALUES
            ('schedule-two','schedule-two-v1',1,'paused','two-saved',?)""", (created,))
        self.db.execute("""UPDATE evaluation_schedule_heads SET revision=2,status='enabled',last_audit_id='two-enabled'
            WHERE schedule_id='schedule-two'""")


def domain_commit(db, lease, now=NOW, outcome="unchanged"):
    """Emulate only the Node transaction receipt for lifecycle tests."""
    def effect(connection):
        job = assert_lease(connection, lease, now)
        cycle = connection.execute("""SELECT c.* FROM evaluation_cycles c JOIN evaluation_cycle_requests r
            ON r.cycle_id=c.id WHERE r.command_request_id=?""", (job["command_request_id"],)).fetchone()
        attempt_id = "domain:" + str(lease.fencing_token)
        job_attempt = connection.execute("SELECT id FROM job_attempts WHERE job_id=? AND attempt=?",
                                         (lease.job_id, lease.attempt)).fetchone()[0]
        number = connection.execute("SELECT COALESCE(MAX(attempt),0)+1 FROM evaluation_attempts WHERE cycle_id=?",
                                    (cycle["id"],)).fetchone()[0]
        proof, result = {"synthetic_lifecycle_only": True}, {"outcome": outcome, "proposal_id": None}
        connection.execute("""INSERT INTO evaluation_attempts
            (id,cycle_id,attempt,input_manifest,status,result_json,created_at,job_attempt_id,input_hash,result_hash,completed_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                           (attempt_id, cycle["id"], number, canonical_json(proof),
                            "blocked" if outcome == "blocked" else "succeeded", canonical_json(result), stamp(now),
                            job_attempt, content_hash(proof), content_hash(result), stamp(now)))
        connection.execute("""UPDATE evaluation_cycles SET status=?,outcome=?,completed_at=?,
            terminal_attempt_id=?,state_revision=state_revision+1 WHERE id=?""",
                           ("blocked" if outcome == "blocked" else "completed", outcome, stamp(now), attempt_id, cycle["id"]))
        from worker.orchestration.jobs import JobCommit
        return JobCommit({"schema_version": "monthly-evaluation-job-result-v1", "cycle_id": cycle["id"],
                          "evaluation_attempt_id": attempt_id, "outcome": outcome, "proposal_id": None})
    complete_job(db, lease, {}, effect=effect, now=now)


class EvaluationDiscoveryTests(EvaluationFixture, unittest.TestCase):
    def test_empty_or_paused_configuration_never_autostarts(self):
        self.assertEqual(discover_due_cycles(self.db, now=NOW), [])
        self.schedule(enabled=False)
        self.assertEqual(self.dispatch(), ([], []))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM command_requests").fetchone()[0], 0)

    def test_due_slot_request_and_original_time_are_stable(self):
        self.schedule()
        self.assertEqual(self.dispatch(NOW - timedelta(microseconds=1)), ([], []))
        cycles, jobs = self.dispatch()
        self.assertEqual(len(cycles), 1)
        self.assertEqual(len(jobs), 1)
        cycle = self.db.execute("SELECT * FROM evaluation_cycles").fetchone()
        self.assertEqual(cycle["scheduled_at"], stamp(NOW))
        self.assertEqual(cycle["knowledge_at"], stamp(NOW))
        self.assertEqual(cycle["cutoff_at"], stamp(NOW))
        self.assertEqual(jobs[0]["period"], "2025-01")
        self.assertEqual(jobs[0]["max_attempts"], 2)
        command = self.db.execute("SELECT * FROM command_requests").fetchone()
        self.assertEqual(json.loads(command["payload_json"]), {"cycle_id": cycle["id"]})
        self.assertEqual(command["actor_id"], "system:monthly-discovery")
        self.assertEqual(self.dispatch(NOW + timedelta(days=1)), ([], []))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM ledger_events").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM reservations").fetchone()[0], 0)

    def test_late_restart_fills_months_with_original_deadlines_in_bounded_batches(self):
        self.schedule()
        later = instant("2025-04-04T00:00:00Z")
        self.assertEqual(len(discover_due_cycles(self.db, limit=2, now=later)), 2)
        self.assertEqual(len(discover_due_cycles(self.db, limit=2, now=later)), 2)
        self.assertEqual(discover_due_cycles(self.db, now=later), [])
        rows = self.db.execute("SELECT * FROM evaluation_cycles ORDER BY period").fetchall()
        self.assertEqual([row["period"] for row in rows], ["2025-01", "2025-02", "2025-03", "2025-04"])
        self.assertEqual(rows[0]["knowledge_at"], stamp(NOW))
        self.assertEqual(rows[0]["deadline_at"], stamp(NOW + timedelta(hours=1)))
        self.assertEqual(rows[0]["created_at"], stamp(later))

    def test_enable_after_trigger_does_not_backdate_current_month(self):
        self.schedule(approved_at=NOW + timedelta(seconds=1))
        self.assertEqual(self.dispatch(NOW + timedelta(days=1)), ([], []))
        cycles, _ = self.dispatch(instant("2025-02-03T10:00:00Z"))
        self.assertEqual(len(cycles), 1)
        self.assertEqual(self.db.execute("SELECT period FROM evaluation_cycles").fetchone()[0], "2025-02")

    def test_explicit_end_month_bounds_catch_up(self):
        definition = schedule_definition()
        definition["end_month"] = "2025-02"
        self.schedule(definition)
        self.assertEqual(len(discover_due_cycles(self.db, now=instant("2025-05-01T00:00:00Z"))), 2)

    def test_raw_definition_hash_not_recoded_canonical_hash(self):
        self.schedule()
        self.assertNotEqual(self.db.execute("SELECT content_hash FROM evaluation_schedule_versions").fetchone()[0],
                            content_hash(self.definition))
        self.assertEqual(len(discover_due_cycles(self.db, now=NOW)), 1)

    def test_bad_hash_or_nonhuman_enable_evidence_blocks_discovery(self):
        for bad_hash, human in ((True, True), (False, False)):
            with self.subTest(bad_hash=bad_hash, human=human):
                other = EvaluationDiscoveryTests()
                other.setUp()
                self.addCleanup(other.doCleanups)
                other.schedule(bad_hash=bad_hash, human=human)
                self.assertEqual(discover_due_cycles(other.db, now=NOW), [])
                self.assertEqual(discover_due_cycles(other.db, now=NOW), [])
                self.assertEqual(other.db.execute("SELECT COUNT(*) FROM evaluation_cycles").fetchone()[0], 0)
                self.assertEqual(other.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 1)

    def test_restore_marker_and_read_only_discovery_do_not_write(self):
        self.schedule()
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        marker.touch()
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            discover_due_cycles(self.db, now=NOW)
        marker.unlink()
        with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}):
            with self.assertRaisesRegex(WorkbenchError, "WORKBENCH_READ_ONLY"):
                discover_due_cycles(self.db, now=NOW)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM evaluation_cycles").fetchone()[0], 0)

    def test_local_dst_gap_and_fold_never_choose_a_guess(self):
        definition = schedule_definition()
        definition["timezone"] = "America/New_York"
        for month, day, hour in (("2025-03", 9, 2), ("2025-11", 2, 1)):
            definition["trigger"] = {"day": day, "hour": hour, "minute": 30}
            with self.assertRaisesRegex(WorkbenchError, "TRIGGER_NOT_UNIQUE"):
                scheduled_instant(month, definition)
        definition["trigger"] = {"day": 3, "hour": 10, "minute": 0}
        self.assertEqual(stamp(scheduled_instant("2025-03", definition)), "2025-03-03T15:00:00.000000Z")

    def test_completed_month_never_reopens_on_revision_or_input_change(self):
        self.schedule()
        self.dispatch()
        lease = self.claim()
        domain_commit(self.db, lease)
        self.db.execute("UPDATE ledger_heads SET revision=1 WHERE portfolio_id='p'")
        self.assertEqual(self.dispatch(NOW + timedelta(days=1)), ([], []))
        self.assertEqual(self.db.execute("SELECT status FROM evaluation_cycles").fetchone()[0], "completed")

    def test_new_version_does_not_create_second_month_slot(self):
        self.schedule()
        self.dispatch()
        definition = deepcopy(self.definition)
        definition["targets"]["rows"][0]["weight"] = "0.25"
        raw = canonical_json(definition)
        self.db.execute("""INSERT INTO evaluation_schedule_versions
            (id,schedule_id,version,policy_version_id,strategy_version_id,definition_json,content_hash,created_by,created_at)
            VALUES('schedule-v2','schedule',2,'policy','strategy',?,?,'synthetic-human',?)""",
                        (raw, sha256(raw.encode()).hexdigest(), stamp(NOW)))
        self.audit("v2-saved", "paused", 3, stamp(NOW), version="schedule-v2", action="save_evaluation_schedule")
        self.db.execute("""UPDATE evaluation_schedule_heads SET current_version_id='schedule-v2',revision=3,
            status='paused',last_audit_id='v2-saved',updated_at=?""", (stamp(NOW),))
        self.audit("v2-enabled", "enabled", 4, stamp(NOW), version="schedule-v2")
        self.db.execute("""UPDATE evaluation_schedule_heads SET revision=4,status='enabled',
            last_audit_id='v2-enabled',updated_at=?""", (stamp(NOW),))
        self.assertEqual(self.dispatch(), ([], []))
        self.assertEqual(self.db.execute("SELECT schedule_version_id FROM evaluation_cycles").fetchone()[0], "schedule-v1")

    def test_bad_schedule_diagnostic_does_not_starve_valid_schedule_or_existing_jobs(self):
        self.schedule(bad_hash=True)
        self.second_schedule()
        ledger_event(self.db, "opening", [("cash_settled", "100"), ("opening_equity", "-100")])
        payload = {"cutoff_at": stamp(NOW), "rules": rules()}
        self.db.execute("""INSERT INTO command_requests VALUES
            ('earlier-valuation','p','valuation','earlier-valuation',?,?,'synthetic-human',?)""",
                        (content_hash(payload), canonical_json(payload), stamp(NOW - timedelta(seconds=1))))
        # Claim order uses persisted job readiness, not command creation time.
        queued = sync_requests(self.db, now=NOW - timedelta(seconds=1))
        self.assertEqual([job["job_type"] for job in queued], ["valuation"])
        self.assertEqual(len(discover_due_cycles(self.db, now=NOW)), 1)
        self.assertEqual(self.db.execute("SELECT schedule_version_id FROM evaluation_cycles").fetchone()[0], "schedule-two-v1")
        result = run_pending_once(self.db, "synthetic-worker", clock=lambda: NOW)
        self.assertEqual(result["job_type"], "valuation")
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 1)

    def test_scan_cursor_is_bounded_disposable_and_idempotent_after_restart(self):
        self.schedule()
        later = instant("2025-04-04T00:00:00Z")
        state = DiscoveryState()
        for expected in (2, 2):
            with patch("worker.orchestration.evaluations.scheduled_instant", wraps=scheduled_instant) as resolve:
                self.assertEqual(len(discover_due_cycles(self.db, now=later, state=state, scan_limit=2)), expected)
                self.assertLessEqual(resolve.call_count, 2)
        original = [tuple(row) for row in self.db.execute("SELECT * FROM evaluation_cycles ORDER BY period")]
        restarted = DiscoveryState()
        for _ in range(2):
            self.assertEqual(discover_due_cycles(self.db, now=later, state=restarted, scan_limit=2), [])
        self.assertEqual([tuple(row) for row in self.db.execute("SELECT * FROM evaluation_cycles ORDER BY period")], original)

    def test_backlog_round_robin_gives_second_schedule_its_turn(self):
        self.schedule()
        self.second_schedule()
        later, state = instant("2025-04-04T00:00:00Z"), DiscoveryState()
        self.assertEqual(len(discover_due_cycles(self.db, limit=1, now=later, state=state, scan_limit=2)), 1)
        self.assertEqual(len(discover_due_cycles(self.db, limit=1, now=later, state=state, scan_limit=2)), 1)
        rows = self.db.execute("SELECT schedule_version_id,period FROM evaluation_cycles ORDER BY schedule_version_id").fetchall()
        self.assertEqual({row[0] for row in rows}, {"schedule-v1", "schedule-two-v1"})
        self.assertEqual({row[1] for row in rows}, {"2025-01"})

    def test_ambiguous_month_records_diagnostic_without_fake_scheduled_instant(self):
        definition = schedule_definition()
        definition.update(timezone="America/New_York", start_month="2025-11")
        definition["trigger"] = {"day": 2, "hour": 1, "minute": 30}
        self.schedule(definition, approved_at=instant("2025-11-01T00:00:00Z"))
        self.assertEqual(discover_due_cycles(self.db, now=instant("2025-11-03T00:00:00Z")), [])
        diagnostic = json.loads(self.db.execute("SELECT payload_json FROM outbox").fetchone()[0])
        self.assertEqual(diagnostic["period"], "2025-11")
        self.assertEqual(diagnostic["code"], "EVALUATION_TRIGGER_NOT_UNIQUE")
        self.assertNotIn("scheduled_at", diagnostic)

    def test_cycle_and_command_rollback_together_when_request_insert_fails(self):
        self.schedule()
        self.db.execute("""CREATE TRIGGER synthetic_request_failure BEFORE INSERT ON evaluation_cycle_requests
            BEGIN SELECT RAISE(ABORT,'synthetic request failure'); END""")
        state = DiscoveryState()
        self.assertEqual(discover_due_cycles(self.db, state=state, now=NOW), [])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM evaluation_cycles").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM command_requests").fetchone()[0], 0)
        self.db.execute("DROP TRIGGER synthetic_request_failure")
        self.assertEqual(len(discover_due_cycles(self.db, state=state, now=NOW)), 1)

    def test_invalid_monthly_request_is_diagnosed_without_stalling_other_dispatch(self):
        self.schedule(enabled=False)
        self.db.execute("""INSERT INTO command_requests VALUES
            ('bad-command','p','monthly_evaluation','bad-command',?,?,'synthetic-human',?)""",
                        (content_hash({"cycle_id": "not-authorized"}), canonical_json({"cycle_id": "not-authorized"}), stamp(NOW)))
        payload = {"cutoff_at": stamp(NOW), "rules": rules()}
        self.db.execute("""INSERT INTO command_requests VALUES
            ('valid-valuation','p','valuation','valid-valuation',?,?,'synthetic-human',?)""",
                        (content_hash(payload), canonical_json(payload), stamp(NOW)))
        self.assertEqual(sync_requests(self.db, limit=1, now=NOW), [])
        jobs = sync_requests(self.db, limit=1, now=NOW)
        self.assertEqual([job["job_type"] for job in jobs], ["valuation"])
        self.assertEqual(sync_requests(self.db, now=NOW), [])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 1)

    def test_integer_json_number_representation_keeps_raw_hash_and_executes_same_trigger(self):
        definition = schedule_definition()
        definition["trigger"]["day"] = 3.0
        definition["deadline_seconds"] = 3600.0
        definition["max_attempts"] = 2.0
        self.schedule(definition)
        self.assertEqual(len(self.dispatch()[0]), 1)
        self.assertEqual(self.db.execute("SELECT scheduled_at FROM evaluation_cycles").fetchone()[0], stamp(NOW))

    def test_shared_semantic_invalid_shapes_cannot_generate_cycles(self):
        for mutate in (lambda definition: definition.update(start_month="0000-01"),
                       lambda definition: definition.update(end_month="2024-12"),
                       lambda definition: definition["targets"].update(absolute_tolerance_cny="-1"),
                       lambda definition: definition["targets"].update(absolute_tolerance_cny="1" * 39),
                       lambda definition: definition["targets"]["rows"].append(deepcopy(definition["targets"]["rows"][0])),
                       lambda definition: definition["targets"]["rows"][0].update(account_id=" a")):
            fixture = EvaluationDiscoveryTests()
            fixture.setUp()
            self.addCleanup(fixture.doCleanups)
            definition = schedule_definition()
            mutate(definition)
            fixture.schedule(definition)
            self.assertEqual(discover_due_cycles(fixture.db, now=NOW), [])
            self.assertEqual(fixture.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 1)


class EvaluationFailureTests(EvaluationFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.schedule()
        self.cycles, self.jobs = self.dispatch()

    def test_claim_and_finite_failures_do_not_leave_cycle_running(self):
        first = self.claim()
        self.assertEqual(self.db.execute("SELECT status FROM evaluation_cycles").fetchone()[0], "running")
        self.assertEqual(fail_job(self.db, first, {"code": "SYNTHETIC_FAILURE"}, now=NOW), "retry_queued")
        second = self.claim(now=NOW + timedelta(seconds=30))
        self.assertEqual(fail_job(self.db, second, {"code": "SYNTHETIC_FAILURE"}, now=NOW + timedelta(seconds=31)), "failed")
        cycle = self.db.execute("SELECT * FROM evaluation_cycles").fetchone()
        self.assertEqual(cycle["status"], "failed")
        self.assertIsNone(cycle["outcome"])
        self.assertIsNone(cycle["terminal_attempt_id"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM evaluation_attempts").fetchone()[0], 0)

    def test_expired_last_lease_fails_cycle_and_old_worker_cannot_terminalize(self):
        first = self.claim(seconds=1)
        second = self.claim(seconds=1, now=NOW + timedelta(seconds=2))
        self.assertIsNone(self.claim(now=NOW + timedelta(seconds=4)))
        self.assertEqual(self.db.execute("SELECT status FROM evaluation_cycles").fetchone()[0], "failed")
        for lease in (first, second):
            with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED"):
                domain_commit(self.db, lease, NOW + timedelta(seconds=4))

    def test_explicit_retry_appends_generation_and_retains_original_time(self):
        first = self.claim()
        fail_job(self.db, first, {"code": "SYNTHETIC_FAILURE"}, retryable=False, now=NOW)
        original = dict(self.db.execute("SELECT * FROM evaluation_cycles").fetchone())
        with transaction(self.db):
            self.db.execute("""UPDATE evaluation_cycles SET status='pending',outcome=NULL,completed_at=NULL,
                terminal_attempt_id=NULL,state_revision=state_revision+1 WHERE id=?""", (original["id"],))
            payload = {"cycle_id": original["id"]}
            self.db.execute("""INSERT INTO command_requests VALUES
                ('explicit-retry','p','monthly_evaluation','explicit-retry',?,?,'synthetic-human',?)""",
                            (content_hash(payload), canonical_json(payload), stamp(NOW)))
            self.db.execute("""INSERT INTO evaluation_cycle_requests VALUES
                ('explicit-retry',?,2,'synthetic-human','Explicit synthetic retry',?)""", (original["id"], stamp(NOW)))
        self.assertEqual(len(sync_requests(self.db, now=NOW)), 1)
        lease = self.claim()
        domain_commit(self.db, lease, outcome="blocked")
        current = self.db.execute("SELECT * FROM evaluation_cycles").fetchone()
        for name in ("period", "scheduled_at", "cutoff_at", "knowledge_at", "deadline_at", "schedule_version_id"):
            self.assertEqual(current[name], original[name])
        self.assertEqual(current["status"], "blocked")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM job_runs").fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main()
