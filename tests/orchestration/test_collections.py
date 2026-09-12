"""Synthetic daily polling authorization, not historical prices or investment eligibility."""

from copy import deepcopy
from datetime import timedelta
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from tests.market.support import seed_account
from tests.market.test_ecb_provider import xml
from worker.market.collection import persist_collection, prepare_collection, verify_provider_capture
from worker.market.providers.ecb import URLS
from worker.orchestration.collections import (
    CollectionDiscoveryState, DISCOVERY_ACTOR, assert_collection_authorized,
    assert_collection_finalization, collection_request_binding, discover_due_collections,
)
from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, content_hash, instant, open_database, stamp, transaction
from worker.orchestration.jobs import JobCommit, claim_job, complete_job, enqueue_job
from worker.orchestration.runtime import run_pending_once, sync_requests


NOW = instant("2026-04-09T12:00:00.000000Z")


def definition():
    return {"schema_version": "collection-schedule-v1", "provider": "ecb", "feed": "daily",
            "currencies": ["USD", "HKD"], "frequency": "daily", "timezone": "UTC",
            "start_date": "2026-04-09", "end_date": None, "trigger": {"hour": 12, "minute": 0},
            "deadline_seconds": 3600, "max_attempts": 3, "publish": True,
            "missed_policy": "record_no_backfill"}


def transport(at=NOW, callback=None):
    raw = xml([("2026-04-08", [("CNY", "8"), ("USD", "2"), ("HKD", "10")])])
    def download(feed):
        if callback is not None:
            callback()
        return {"raw": raw, "source_url": URLS[feed], "started_at": stamp(at), "completed_at": stamp(at),
                "retrieved_at": stamp(at), "http_status": 200, "headers": {"content-type": "text/xml"},
                "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw), "redirects_followed": 0}
    return download


class CollectionFixture:
    def setUp(self):
        temporary = TemporaryDirectory(prefix="synthetic-collection-schedules-")
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "workbench.db"
        migrated = subprocess.run(["node", str(ROOT / "scripts/migrate-workbench.mjs"), "--db", str(self.path)],
                                  capture_output=True, text=True, cwd=ROOT, timeout=30, check=False)
        self.assertEqual(migrated.returncode, 0, migrated.stderr)
        self.db = open_database(self.path)
        self.addCleanup(self.db.close)
        seed_account(self.db)

    def save(self, value=None, identity="schedule", portfolio="p", at=None):
        value = deepcopy(value or definition())
        at = stamp(at or NOW - timedelta(minutes=2))
        scope = "provider:ecb:fx:daily:" + "-".join(sorted(value["currencies"]))
        raw = json.dumps(value, indent=2)
        digest = sha256(raw.encode()).hexdigest()
        head = self.db.execute("SELECT * FROM collection_schedule_heads WHERE schedule_id=?", (identity,)).fetchone()
        revision = head["revision"] + 1 if head else 1
        version = self.db.execute("SELECT COALESCE(MAX(version),0)+1 FROM collection_schedule_versions WHERE schedule_id=?", (identity,)).fetchone()[0]
        vid, aid = f"{identity}-v{version}", f"{identity}-control-{revision}"
        command = {"portfolio_id": portfolio, "expected_schedule_id": identity if head else None,
                   "expected_schedule_revision": revision - 1, "definition_json": raw,
                   "idempotency_key": aid, "reason": "Synthetic polling authorization only", "acknowledgement": True}
        result = {"schedule_id": identity, "version_id": vid, "version": version,
                  "schedule_revision": revision, "status": "paused", "scope_key": scope, "content_hash": digest}
        with transaction(self.db):
            if head is None:
                self.db.execute("""INSERT INTO collection_schedules
                    (id,portfolio_id,provider,scope_key,created_by,created_at) VALUES(?,?,'ecb',?,'synthetic-human',?)""",
                                (identity, portfolio, scope, at))
            self.audit(aid, identity, portfolio, "save_collection_schedule", command, result, at)
            self.db.execute("""INSERT INTO collection_schedule_versions
                (id,schedule_id,version,definition_json,content_hash,created_by,created_at,audit_id)
                VALUES(?,?,?,?,?,'synthetic-human',?,?)""", (vid, identity, version, raw, digest, at, aid))
            self.control(identity, scope, vid, revision, "paused", aid, at, head is None)
        return identity

    def audit(self, aid, identity, portfolio, action, command, result, at):
        self.db.execute("""INSERT INTO audit_events
            (id,actor_id,action,object_type,object_id,portfolio_id,payload_json,created_at)
            VALUES(?,'synthetic-human',?,'collection_schedule',?,?,?,?)""",
                        (aid, action, identity, portfolio,
                         canonical_json({"actor_kind": "human", "input": command, "result": result}), at))

    def control(self, identity, scope, vid, revision, status, aid, at, initial=False):
        self.db.execute("INSERT INTO collection_schedule_controls VALUES(?,?,?,?,?,?)",
                        (identity, revision, vid, status, aid, at))
        if initial:
            self.db.execute("INSERT INTO collection_schedule_heads VALUES(?,?,?,?,?,?,?)",
                            (identity, scope, vid, revision, status, aid, at))
        else:
            self.db.execute("""UPDATE collection_schedule_heads SET current_version_id=?,revision=?,status=?,
                last_audit_id=?,updated_at=? WHERE schedule_id=?""", (vid, revision, status, aid, at, identity))

    def status(self, status="enabled", identity="schedule", at=None):
        at = stamp(at or NOW - timedelta(minutes=1))
        head = self.db.execute("""SELECT h.*,s.portfolio_id,v.version,v.content_hash FROM collection_schedule_heads h
            JOIN collection_schedules s ON s.id=h.schedule_id JOIN collection_schedule_versions v ON v.id=h.current_version_id
            WHERE h.schedule_id=?""", (identity,)).fetchone()
        revision = head["revision"] + 1
        aid = f"{identity}-control-{revision}"
        command = {"portfolio_id": head["portfolio_id"], "schedule_id": identity,
                   "expected_schedule_revision": head["revision"], "status": status,
                   "idempotency_key": aid, "reason": "Synthetic status control", "acknowledgement": True}
        result = {"schedule_id": identity, "version_id": head["current_version_id"], "version": head["version"],
                  "schedule_revision": revision, "status": status, "scope_key": head["scope_key"], "content_hash": head["content_hash"]}
        with transaction(self.db):
            self.audit(aid, identity, head["portfolio_id"], "set_collection_schedule_status", command, result, at)
            self.control(identity, head["scope_key"], head["current_version_id"], revision, status, aid, at)

    def enabled(self, value=None, **kwargs):
        identity = self.save(value, **kwargs)
        self.status(identity=identity)
        return identity

    def slots(self):
        return [dict(row) for row in self.db.execute("SELECT * FROM collection_schedule_slots ORDER BY period,id")]

    def request(self):
        return dict(self.db.execute("SELECT * FROM command_requests ORDER BY created_at,id LIMIT 1").fetchone())

    def claim(self, at=NOW, seconds=7200):
        request = self.request()
        binding = collection_request_binding(self.db, request)
        job = enqueue_job(self.db, "market_collect", request["portfolio_id"], binding["slot"]["period"],
                          request["id"] + ":" + request["payload_hash"], max_attempts=binding["definition"]["max_attempts"],
                          command_request_id=request["id"], now=at)
        lease = claim_job(self.db, "synthetic-poll-worker", seconds, "market_collect", now=at)
        self.assertEqual(lease.job_id, job["id"])
        return request, dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (job["id"],)).fetchone()), lease

    def drop_guards(self, table):
        names = [row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?", (table,))]
        for name in names:
            self.db.execute('DROP TRIGGER "' + name.replace('"', '""') + '"')


class CollectionDiscoveryTests(CollectionFixture, unittest.TestCase):
    def test_empty_and_paused_never_autostart(self):
        self.assertEqual(discover_due_collections(self.db, now=NOW), [])
        self.save()
        self.assertEqual(discover_due_collections(self.db, now=NOW), [])
        self.assertEqual(self.slots(), [])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM command_requests").fetchone()[0], 0)

    def test_due_request_exact_existing_payload_and_raw_definition_proof(self):
        self.enabled()
        self.assertEqual(discover_due_collections(self.db, now=NOW - timedelta(microseconds=1)), [])
        self.assertEqual(len(discover_due_collections(self.db, now=NOW)), 1)
        slot, request = self.slots()[0], self.request()
        self.assertEqual(slot["disposition"], "requested")
        self.assertEqual(slot["scheduled_at"], stamp(NOW))
        self.assertEqual(slot["deadline_at"], stamp(NOW + timedelta(hours=1)))
        self.assertEqual(slot["created_at"], request["created_at"])
        self.assertEqual(request["actor_id"], DISCOVERY_ACTOR)
        self.assertEqual(json.loads(request["payload_json"]), {"provider": "ecb", "feed": "daily", "currencies": ["USD", "HKD"],
                                                               "expected_publication_revision": 0, "publish": True})
        proof = collection_request_binding(self.db, request)
        self.assertEqual(proof["authorization"]["revision"], 2)
        self.assertIsNone(proof["authorization"]["ended_at"])
        raw = self.db.execute("SELECT definition_json,content_hash FROM collection_schedule_versions").fetchone()
        self.assertNotEqual(raw["content_hash"], content_hash(json.loads(raw["definition_json"])))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM ledger_events").fetchone()[0], 0)

    def test_two_connections_and_disposable_cursor_do_not_duplicate_slots(self):
        self.enabled()
        first = discover_due_collections(self.db, now=NOW, state=CollectionDiscoveryState())
        other = sqlite3.connect(self.path, isolation_level=None)
        other.row_factory = sqlite3.Row
        self.addCleanup(other.close)
        self.assertEqual(discover_due_collections(other, now=NOW, state=CollectionDiscoveryState()), [])
        self.assertEqual(len(first), 1)
        self.assertEqual(len(self.slots()), 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM command_requests").fetchone()[0], 1)

    def test_deadline_equality_records_missed_without_request_or_network(self):
        self.enabled()
        with patch("worker.market.collection.download_ecb_xml") as download:
            self.assertEqual(len(discover_due_collections(self.db, now=NOW + timedelta(hours=1))), 1)
            download.assert_not_called()
        slot = self.slots()[0]
        self.assertEqual((slot["disposition"], slot["reason_code"]), ("missed", "DEADLINE_EXPIRED"))
        self.assertIsNone(slot["command_request_id"])
        self.assertIsNone(slot["expected_publication_revision"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM command_requests").fetchone()[0], 0)

    def test_enable_one_microsecond_after_due_does_not_backdate(self):
        self.save()
        self.status(at=NOW + timedelta(microseconds=1))
        self.assertEqual(discover_due_collections(self.db, now=NOW + timedelta(hours=1)), [])
        self.assertEqual(len(discover_due_collections(self.db, now=NOW + timedelta(days=1))), 1)
        self.assertEqual(self.slots()[0]["period"], "2026-04-10")

    def test_pre_due_scan_keeps_today_for_later_missed_record(self):
        self.enabled()
        cursor = CollectionDiscoveryState()
        self.assertEqual(discover_due_collections(self.db, now=NOW - timedelta(microseconds=1), state=cursor), [])
        self.assertEqual(len(discover_due_collections(self.db, now=NOW + timedelta(hours=2), state=cursor)), 1)
        self.assertEqual((self.slots()[0]["period"], self.slots()[0]["reason_code"]), ("2026-04-09", "DEADLINE_EXPIRED"))

    def test_closed_authorization_records_original_due_and_earliest_end_reason(self):
        for closed, reason in ((NOW + timedelta(minutes=1), "AUTHORIZATION_ENDED"),
                               (NOW + timedelta(hours=1), "DEADLINE_EXPIRED"),
                               (NOW + timedelta(hours=2), "DEADLINE_EXPIRED")):
            with self.subTest(closed=closed):
                fixture = CollectionDiscoveryTests()
                fixture.setUp()
                self.addCleanup(fixture.doCleanups)
                fixture.enabled()
                fixture.status("paused", at=closed)
                self.assertEqual(len(discover_due_collections(fixture.db, now=NOW + timedelta(hours=3))), 1)
                slot = fixture.slots()[0]
                self.assertEqual(slot["authorization_revision"], 2)
                self.assertEqual(slot["scheduled_at"], stamp(NOW))
                self.assertEqual(slot["reason_code"], reason)
                self.assertIsNone(slot["command_request_id"])

    def test_pause_at_due_means_no_authorized_slot(self):
        self.enabled()
        self.status("paused", at=NOW)
        self.assertEqual(discover_due_collections(self.db, now=NOW + timedelta(hours=2)), [])

    def test_fresh_window_is_first_even_after_years_of_missed_history(self):
        value = definition()
        value["start_date"] = "2020-01-01"
        self.save(value, at=instant("2020-01-01T00:00:00Z"))
        self.status(at=instant("2020-01-01T01:00:00Z"))
        self.assertEqual(len(discover_due_collections(self.db, now=NOW, limit=1, scan_limit=1)), 1)
        self.assertEqual((self.slots()[0]["period"], self.slots()[0]["disposition"]), ("2026-04-09", "requested"))
        cursor = CollectionDiscoveryState()
        self.assertEqual(len(discover_due_collections(self.db, now=NOW, limit=2, scan_limit=2, state=cursor)), 2)
        self.assertEqual([row["period"] for row in self.slots()[:2]], ["2020-01-01", "2020-01-02"])
        self.assertEqual(len(discover_due_collections(self.db, now=NOW, limit=2, scan_limit=2, state=cursor)), 2)
        self.assertEqual(len(self.slots()), 5)

    def test_current_window_on_later_scope_precedes_earlier_scope_missed_backlog(self):
        value = definition()
        value["start_date"], value["trigger"]["hour"] = "2020-01-01", 10
        self.save(value, identity="a-history", at=instant("2020-01-01T00:00:00Z"))
        self.status(identity="a-history", at=instant("2020-01-01T01:00:00Z"))
        current = definition()
        current["currencies"] = ["EUR"]
        self.enabled(current, identity="b-current")
        self.assertEqual(len(discover_due_collections(self.db, now=NOW, limit=1)), 1)
        self.assertEqual((self.slots()[0]["schedule_id"], self.slots()[0]["disposition"]), ("b-current", "requested"))

    def test_cross_portfolio_unique_enabled_scope_and_no_private_slot_reuse(self):
        self.enabled()
        self.db.execute("INSERT INTO portfolios(id,name,base_currency,created_at) VALUES('other','Synthetic other','CNY',?)", (stamp(NOW),))
        self.save(identity="other-schedule", portfolio="other")
        with self.assertRaises(sqlite3.IntegrityError):
            self.status(identity="other-schedule")
        original = discover_due_collections(self.db, now=NOW)
        self.status("paused", at=NOW + timedelta(minutes=1))
        value = definition()
        value["trigger"]["minute"] = 2
        self.save(value, identity="other-schedule", portfolio="other", at=NOW + timedelta(minutes=1))
        self.status(identity="other-schedule", at=NOW + timedelta(minutes=1, seconds=1))
        self.assertEqual(discover_due_collections(self.db, now=NOW + timedelta(minutes=2)), [])
        self.assertEqual([row["id"] for row in self.slots()], original)
        self.assertEqual(self.slots()[0]["portfolio_id"], "p")

    def test_new_version_cannot_reopen_same_day(self):
        self.enabled()
        original = discover_due_collections(self.db, now=NOW)
        value = definition()
        value["trigger"]["minute"] = 2
        self.save(value, at=NOW + timedelta(minutes=1))
        self.status(at=NOW + timedelta(minutes=1, seconds=1))
        self.assertEqual(discover_due_collections(self.db, now=NOW + timedelta(minutes=2)), [])
        self.assertEqual([row["id"] for row in self.slots()], original)

    def test_bad_schedule_is_diagnosed_once_without_starving_valid_scope(self):
        self.enabled(identity="a-bad")
        value = definition()
        value["currencies"] = ["EUR"]
        self.enabled(value, identity="b-good")
        self.drop_guards("collection_schedule_versions")
        self.db.execute("UPDATE collection_schedule_versions SET content_hash=? WHERE schedule_id='a-bad'", ("0" * 64,))
        state = CollectionDiscoveryState()
        self.assertEqual(discover_due_collections(self.db, now=NOW, scan_limit=1, state=state), [])
        self.assertEqual(len(discover_due_collections(self.db, now=NOW, scan_limit=1, state=state)), 1)
        self.assertEqual(discover_due_collections(self.db, now=NOW, scan_limit=1, state=state), [])
        self.assertEqual(self.slots()[0]["schedule_id"], "b-good")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM outbox WHERE topic='market_collection.discovery_blocked'").fetchone()[0], 1)

    def test_historical_scopes_also_advance_fairly_under_limit_one(self):
        self.enabled(identity="a-history")
        value = definition()
        value["currencies"] = ["EUR"]
        self.enabled(value, identity="b-history")
        cursor = CollectionDiscoveryState()
        for _ in range(2):
            self.assertEqual(len(discover_due_collections(self.db, now=NOW + timedelta(days=3, hours=2),
                                                        limit=1, scan_limit=2, state=cursor)), 1)
        self.assertEqual({row["schedule_id"] for row in self.slots()}, {"a-history", "b-history"})

    def test_restore_marker_and_read_only_block_discovery_without_writes(self):
        self.enabled()
        before = self.db.total_changes
        with patch.dict(os.environ, {"WORKBENCH_MODE": "read_only"}):
            with self.assertRaisesRegex(WorkbenchError, "WORKBENCH_READ_ONLY"):
                discover_due_collections(self.db, now=NOW)
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        marker.touch()
        self.addCleanup(marker.unlink)
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            discover_due_collections(self.db, now=NOW)
        self.assertEqual(self.db.total_changes, before)


class CollectionAuthorizationTests(CollectionFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.enabled()
        discover_due_collections(self.db, now=NOW)

    def test_current_job_binding_and_exact_deadline_guard(self):
        request, job, lease = self.claim()
        self.assertEqual(assert_collection_authorized(self.db, request, job, lease, now=NOW)["slot"]["period"], "2026-04-09")
        with self.assertRaisesRegex(WorkbenchError, "COLLECTION_DEADLINE_EXPIRED"):
            assert_collection_authorized(self.db, request, job, lease, now=NOW + timedelta(hours=1))

    def test_job_scope_period_or_input_identity_cannot_be_substituted(self):
        request, job, lease = self.claim()
        for field, value in (("scope", "other"), ("period", "2026-04-10"), ("input_version", "forged"), ("max_attempts", 5)):
            with self.subTest(field=field), self.assertRaisesRegex(WorkbenchError, "COLLECTION_BINDING_INVALID"):
                assert_collection_authorized(self.db, request, {**job, field: value}, lease, now=NOW)

    def test_pause_resume_same_version_permanently_invalidates_old_attempt(self):
        request, job, lease = self.claim()
        self.status("paused", at=NOW + timedelta(minutes=1))
        self.status("enabled", at=NOW + timedelta(minutes=2))
        with self.assertRaisesRegex(WorkbenchError, "COLLECTION_AUTHORIZATION_ENDED"):
            assert_collection_authorized(self.db, request, job, lease, now=NOW + timedelta(minutes=3))
        proof = collection_request_binding(self.db, request)
        self.assertEqual(proof["authorization"]["ended_at"], stamp(NOW + timedelta(minutes=1)))

    def test_edited_version_invalidates_current_but_not_historical_binding(self):
        request, job, lease = self.claim()
        value = definition()
        value["max_attempts"] = 4
        self.save(value, at=NOW + timedelta(minutes=1))
        with self.assertRaisesRegex(WorkbenchError, "COLLECTION_AUTHORIZATION_ENDED"):
            assert_collection_authorized(self.db, request, job, lease, now=NOW + timedelta(minutes=2))
        self.assertEqual(collection_request_binding(self.db, request)["definition"]["max_attempts"], 3)

    def test_expired_lease_and_restore_never_authorize(self):
        request, job, lease = self.claim(seconds=1)
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            assert_collection_authorized(self.db, request, job, lease, now=NOW + timedelta(seconds=1))
        with patch.dict(os.environ, {"WORKBENCH_MODE": "read_only"}):
            with self.assertRaisesRegex(WorkbenchError, "WORKBENCH_READ_ONLY"):
                assert_collection_authorized(self.db, request, job, lease, now=NOW)

    def test_forged_request_and_system_actor_without_slot_are_rejected(self):
        request = self.request()
        forged = {**request, "payload_json": canonical_json({**json.loads(request["payload_json"]), "publish": False})}
        forged["payload_hash"] = content_hash(json.loads(forged["payload_json"]))
        for value in (forged, {**request, "id": "absent"}, {**request, "id": "absent", "actor_id": "system:other"}):
            with self.assertRaisesRegex(WorkbenchError, "COLLECTION_BINDING_INVALID"):
                collection_request_binding(self.db, value)
        self.assertIsNone(collection_request_binding(self.db, {**request, "id": "manual", "actor_id": "synthetic-human"}))

    def test_raw_version_or_enable_audit_tampering_fails_closed(self):
        request = self.request()
        self.drop_guards("audit_events")
        row = self.db.execute("SELECT payload_json FROM audit_events WHERE id='schedule-control-2'").fetchone()
        payload = json.loads(row[0])
        payload["actor_kind"] = "ai"
        self.db.execute("UPDATE audit_events SET payload_json=? WHERE id='schedule-control-2'", (canonical_json(payload),))
        with self.assertRaisesRegex(WorkbenchError, "COLLECTION_BINDING_INVALID"):
            collection_request_binding(self.db, request)

    def test_human_audit_actor_and_all_json_objects_are_independently_strict(self):
        request = self.request()
        self.drop_guards("audit_events")
        original = dict(self.db.execute("SELECT * FROM audit_events WHERE id='schedule-control-2'").fetchone())
        mutations = [
            ("system actor", lambda row, body: row.update(actor_id="system:synthetic-discovery")),
            ("JS whitespace actor", lambda row, body: row.update(actor_id="\ufeff\u00a0")),
            ("wrapper extra", lambda row, body: body.update(extra=True)),
            ("input extra", lambda row, body: body["input"].update(extra=True)),
            ("result extra", lambda row, body: body["result"].update(extra=True)),
            ("empty reason", lambda row, body: body["input"].update(reason="")),
            ("JS whitespace reason", lambda row, body: body["input"].update(reason="\ufeff\u00a0")),
            ("UTF16 reason limit", lambda row, body: body["input"].update(reason="\U0001f9ea" * 1001)),
            ("ID alphabet", lambda row, body: body["input"].update(idempotency_key="synthetic key")),
            ("ID limit", lambda row, body: body["input"].update(idempotency_key="x" * 161)),
            ("boolean input revision", lambda row, body: body["input"].update(expected_schedule_revision=True)),
            ("boolean result version", lambda row, body: body["result"].update(version=True)),
        ]
        for label, mutate in mutations:
            with self.subTest(label=label):
                row, body = dict(original), json.loads(original["payload_json"])
                mutate(row, body)
                self.db.execute("UPDATE audit_events SET actor_id=?,payload_json=? WHERE id=?",
                                (row["actor_id"], canonical_json(body), row["id"]))
                with self.assertRaisesRegex(WorkbenchError, "COLLECTION_BINDING_INVALID"):
                    collection_request_binding(self.db, request)
        valid = json.loads(original["payload_json"])
        valid["input"]["reason"] = "\U0001f9ea" * 1000
        self.db.execute("UPDATE audit_events SET actor_id=?,payload_json=? WHERE id=?",
                        (original["actor_id"], canonical_json(valid), original["id"]))
        self.assertIsNotNone(collection_request_binding(self.db, request))

    def test_save_audit_extra_fields_and_raw_definition_bounds_are_independently_strict(self):
        request = self.request()
        self.drop_guards("audit_events")
        original = self.db.execute("SELECT payload_json FROM audit_events WHERE id='schedule-control-1'").fetchone()[0]
        for field, value in (("extra", True), ("schedule_id", "schedule"), ("reason", "x" * 2001),
                             ("idempotency_key", ":invalid"), ("definition_json", "x" * 65537)):
            with self.subTest(field=field):
                body = json.loads(original)
                body["input"][field] = value
                self.db.execute("UPDATE audit_events SET payload_json=? WHERE id='schedule-control-1'", (canonical_json(body),))
                with self.assertRaisesRegex(WorkbenchError, "COLLECTION_BINDING_INVALID"):
                    collection_request_binding(self.db, request)

    def test_nonadjacent_old_control_audit_is_part_of_the_full_proof(self):
        for number, status in enumerate(("paused", "enabled", "paused", "enabled"), 1):
            self.status(status, at=NOW + timedelta(minutes=number))
        created = discover_due_collections(self.db, now=NOW + timedelta(days=1))
        slot = self.db.execute("SELECT * FROM collection_schedule_slots WHERE id=?", (created[0],)).fetchone()
        request = dict(self.db.execute("SELECT * FROM command_requests WHERE id=?", (slot["command_request_id"],)).fetchone())
        self.assertEqual(collection_request_binding(self.db, request)["authorization"]["revision"], 6)
        self.drop_guards("audit_events")
        body = json.loads(self.db.execute("SELECT payload_json FROM audit_events WHERE id='schedule-control-2'").fetchone()[0])
        body["actor_kind"] = "ai"
        self.db.execute("UPDATE audit_events SET payload_json=? WHERE id='schedule-control-2'", (canonical_json(body),))
        with self.assertRaisesRegex(WorkbenchError, "COLLECTION_BINDING_INVALID"):
            collection_request_binding(self.db, request)

    def test_control_history_budget_blocks_instead_of_skipping_old_controls(self):
        from worker.orchestration.collections import MAX_CONTROL_HISTORY
        self.assertEqual(MAX_CONTROL_HISTORY, 1024)
        self.status("paused", at=NOW + timedelta(minutes=1))
        with patch("worker.orchestration.collections.MAX_CONTROL_HISTORY", 2):
            with self.assertRaisesRegex(WorkbenchError, "COLLECTION_BINDING_INVALID"):
                collection_request_binding(self.db, self.request())
            self.assertEqual(discover_due_collections(self.db, now=NOW + timedelta(minutes=2)), [])
        payload = json.loads(self.db.execute("SELECT payload_json FROM outbox WHERE topic='market_collection.discovery_blocked'").fetchone()[0])
        self.assertEqual(payload["code"], "COLLECTION_CONTROL_HISTORY_LIMIT")

    def test_full_1024_control_proof_accepts_only_the_reserved_last_pause(self):
        from worker.orchestration.collections import _history, _version
        # Generate the real contiguous audit chain only in the temporary database.
        for revision in range(3, 1024):
            self.status("enabled", at=NOW + timedelta(microseconds=revision))
        self.status("paused", at=NOW + timedelta(microseconds=1024))
        schedule = dict(self.db.execute("SELECT * FROM collection_schedules").fetchone())
        self.assertEqual(len(_history(self.db, schedule)), 1024)
        # Corrupt stored evidence deliberately; the reader must not rely on FK/trigger enforcement.
        self.db.execute("PRAGMA foreign_keys=OFF")
        self.drop_guards("audit_events")
        self.drop_guards("collection_schedule_controls")
        original = self.db.execute("SELECT payload_json FROM audit_events WHERE id='schedule-control-1024'").fetchone()[0]
        body = json.loads(original)
        body["input"]["status"] = body["result"]["status"] = "enabled"
        self.db.execute("UPDATE audit_events SET payload_json=? WHERE id='schedule-control-1024'", (canonical_json(body),))
        self.db.execute("UPDATE collection_schedule_controls SET status='enabled' WHERE revision=1024")
        with self.assertRaisesRegex(WorkbenchError, "COLLECTION_BINDING_INVALID"):
            _history(self.db, schedule)
        self.db.execute("UPDATE audit_events SET payload_json=? WHERE id='schedule-control-1024'", (original,))
        self.db.execute("UPDATE collection_schedule_controls SET status='paused' WHERE revision=1024")
        prior = json.loads(self.db.execute("SELECT payload_json FROM audit_events WHERE id='schedule-control-1023'").fetchone()[0])
        prior["input"]["status"] = prior["result"]["status"] = "paused"
        self.db.execute("UPDATE audit_events SET payload_json=? WHERE id='schedule-control-1023'", (canonical_json(prior),))
        self.db.execute("UPDATE collection_schedule_controls SET status='paused' WHERE revision=1023")
        with self.assertRaisesRegex(WorkbenchError, "COLLECTION_BINDING_INVALID"):
            _history(self.db, schedule)
        self.drop_guards("collection_schedule_versions")
        self.db.execute("UPDATE collection_schedule_versions SET version=1024")
        with self.assertRaisesRegex(WorkbenchError, "COLLECTION_BINDING_INVALID"):
            _version(self.db, schedule, "schedule-v1")

    def test_finalization_rechecks_deadline_and_authorization(self):
        request, job, lease = self.claim()
        self.assertIsNotNone(assert_collection_finalization(self.db, request, job, lease, now=NOW))
        with self.assertRaisesRegex(WorkbenchError, "COLLECTION_DEADLINE_EXPIRED"):
            assert_collection_finalization(self.db, request, job, lease, now=NOW + timedelta(hours=1))
        self.status("paused", at=NOW + timedelta(seconds=1))
        with self.assertRaisesRegex(WorkbenchError, "COLLECTION_AUTHORIZATION_ENDED"):
            assert_collection_finalization(self.db, request, job, lease, now=NOW + timedelta(seconds=2))


class CollectionRuntimeTests(CollectionFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.enabled()

    def unchanged_financial_rows(self):
        names = ("ledger_events", "postings", "position_movements", "reservations", "approval_events", "proposals")
        return {name: [tuple(row) for row in self.db.execute('SELECT * FROM "' + name + '" ORDER BY rowid')]
                for name in names}

    def test_actual_discovery_runtime_capture_publish_is_atomic_and_not_financial(self):
        before = self.unchanged_financial_rows()
        with patch("worker.market.collection.download_ecb_xml", side_effect=transport()) as download:
            job = run_pending_once(self.db, "synthetic-worker", clock=lambda: NOW)
            self.assertEqual(job["status"], "succeeded", job["result_json"])
            self.assertIsNone(run_pending_once(self.db, "synthetic-worker", clock=lambda: NOW))
            download.assert_called_once_with("daily")
        self.assertEqual(job["period"], "2026-04-09")
        self.assertEqual(job["max_attempts"], 3)
        result = json.loads(job["result_json"])
        self.assertFalse(result["live_advice_eligible"])
        proof = verify_provider_capture(self.db, result["batch_id"])
        self.assertEqual(proof["id"], result["capture_id"])
        self.assertEqual(self.db.execute("SELECT revision FROM market_publications").fetchone()[0], 1)
        for observation in self.db.execute("SELECT * FROM market_observations"):
            self.assertEqual(observation["observed_at"], "2026-04-08")
            self.assertIsNone(observation["published_at"])
            self.assertEqual(observation["ingested_at"], stamp(NOW))
        self.assertEqual(self.unchanged_financial_rows(), before)
        self.status("paused", at=NOW + timedelta(seconds=1))
        self.assertEqual(verify_provider_capture(self.db, result["batch_id"]), proof)

    def test_pause_during_download_discards_entire_material_without_retries(self):
        clock = [NOW]
        def pause():
            self.assertFalse(self.db.in_transaction)
            self.status("paused", at=NOW + timedelta(seconds=1))
            clock[0] = NOW + timedelta(seconds=2)
        with patch("worker.market.collection.download_ecb_xml", side_effect=transport(callback=pause)) as download:
            job = run_pending_once(self.db, "synthetic-worker", clock=lambda: clock[0])
            download.assert_called_once()
        self.assertEqual(job["status"], "skipped")
        self.assertEqual(json.loads(job["result_json"])["code"], "COLLECTION_AUTHORIZATION_ENDED")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_provider_captures").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_publications").fetchone()[0], 0)
        self.assertEqual(job["attempt_count"], 1)

    def test_queued_expired_slot_is_terminal_without_network(self):
        discover_due_collections(self.db, now=NOW)
        sync_requests(self.db, now=NOW)
        with patch("worker.market.collection.download_ecb_xml") as download:
            job = run_pending_once(self.db, "synthetic-worker", clock=lambda: NOW + timedelta(hours=1))
            download.assert_not_called()
        self.assertEqual(job["status"], "skipped")
        self.assertEqual(json.loads(job["result_json"])["code"], "COLLECTION_DEADLINE_EXPIRED")

    def test_deadline_crossing_after_publish_rolls_back_capture_head_and_success(self):
        clock = [NOW]
        def publish_then_advance(db, prepared, **kwargs):
            result = persist_collection(db, prepared, **kwargs)
            self.assertEqual(db.execute("SELECT revision FROM market_publications").fetchone()[0], 1)
            clock[0] = NOW + timedelta(hours=1)
            return result
        with patch("worker.market.collection.download_ecb_xml", transport()), \
                patch("worker.orchestration.runtime.persist_collection", side_effect=publish_then_advance):
            with self.assertRaisesRegex(WorkbenchError, "COLLECTION_DEADLINE_EXPIRED"):
                run_pending_once(self.db, "synthetic-worker", lease_seconds=7200, clock=lambda: clock[0])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_provider_captures").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_publications").fetchone()[0], 0)
        job = self.db.execute("SELECT * FROM job_runs").fetchone()
        self.assertEqual((job["status"], job["attempt_count"]), ("failed", 1))

    def test_transport_errors_retry_only_within_original_slot_and_budget(self):
        with patch("worker.market.collection.download_ecb_xml", side_effect=RuntimeError("synthetic transport failure")) as download:
            for seconds in (0, 30, 90):
                with self.assertRaisesRegex(WorkbenchError, "PROVIDER_COLLECTION_FAILED"):
                    run_pending_once(self.db, "synthetic-worker", clock=lambda seconds=seconds: NOW + timedelta(seconds=seconds))
            self.assertIsNone(run_pending_once(self.db, "synthetic-worker", clock=lambda: NOW + timedelta(seconds=180)))
            self.assertEqual(download.call_count, 3)
        job = self.db.execute("SELECT * FROM job_runs").fetchone()
        self.assertEqual((job["status"], job["attempt_count"]), ("failed", 3))
        self.assertEqual(len(self.slots()), 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM command_requests").fetchone()[0], 1)

    def test_manual_publication_competes_with_frozen_slot_cas_without_rebase(self):
        discover_due_collections(self.db, now=NOW)
        value = json.loads(self.request()["payload_json"])
        self.db.execute("""INSERT INTO command_requests
            (id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at)
            VALUES('manual','p','market_collect','manual',?,?,'synthetic-human',?)""",
                        (content_hash(value), canonical_json(value), stamp(NOW)))
        request = dict(self.db.execute("SELECT * FROM command_requests WHERE id='manual'").fetchone())
        job = enqueue_job(self.db, "market_collect", "p", "2026-04-09", "manual:" + request["payload_hash"],
                          command_request_id="manual", now=NOW)
        lease = claim_job(self.db, "manual-worker", 300, "market_collect", now=NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (job["id"],)).fetchone())
        with patch("worker.market.collection.download_ecb_xml", transport()):
            prepared = prepare_collection(self.db, request, job, lease, clock=lambda: NOW)
            complete_job(self.db, lease, {}, effect=lambda db: JobCommit(persist_collection(db, prepared, now=NOW)), now=NOW)
        with patch("worker.market.collection.download_ecb_xml") as download:
            original = run_pending_once(self.db, "synthetic-worker", clock=lambda: NOW)
            download.assert_not_called()
        self.assertEqual(original["status"], "skipped")
        self.assertEqual(json.loads(original["result_json"])["code"], "STALE_PUBLICATION_REVISION")
        self.assertEqual(self.slots()[0]["expected_publication_revision"], 0)
        self.assertEqual(self.db.execute("SELECT revision FROM market_publications").fetchone()[0], 1)

    def test_provider_role_does_not_discover_or_claim_core_slots(self):
        with patch("worker.market.collection.download_ecb_xml") as download:
            self.assertIsNone(run_pending_once(self.db, "price-worker", role="longport", clock=lambda: NOW))
            download.assert_not_called()
        self.assertEqual(self.slots(), [])

    def test_encrypted_backup_restore_preserves_slots_requests_and_raw_capture(self):
        with patch("worker.market.collection.download_ecb_xml", transport()):
            job = run_pending_once(self.db, "synthetic-worker", clock=lambda: NOW)
        result = json.loads(job["result_json"])
        tables = ("collection_schedules", "collection_schedule_versions", "collection_schedule_controls",
                  "collection_schedule_heads", "collection_schedule_slots", "command_requests", "job_runs", "market_provider_captures")
        before = {name: [tuple(row) for row in self.db.execute('SELECT * FROM "' + name + '" ORDER BY rowid')]
                  for name in tables}
        script = """
          const { backupWorkbench } = await import(process.argv[1]);
          const { restoreWorkbench } = await import(process.argv[2]);
          const [dbPath,dataDir,outputDir,targetDir] = process.argv.slice(3);
          const passphrase = 'synthetic-collection-recovery-not-a-private-secret';
          const saved = await backupWorkbench({dbPath,dataDir,outputDir,passphrase,appRef:'synthetic-daily-polling'});
          process.stdout.write(JSON.stringify(await restoreWorkbench({archivePath:saved.path,targetDir,passphrase})));
        """
        target = self.path.parent / "restored"
        restored = subprocess.run(["node", "--input-type=module", "-e", script,
                                   (ROOT / "scripts/backup-workbench.mjs").as_uri(), (ROOT / "scripts/restore-workbench.mjs").as_uri(),
                                   str(self.path), str(self.path.parent), str(self.path.parent / "archives"), str(target)],
                                  capture_output=True, text=True, cwd=ROOT, timeout=30, check=False)
        self.assertEqual(restored.returncode, 0, restored.stderr)
        info = json.loads(restored.stdout)
        self.assertTrue(info["pending_review"])
        db = sqlite3.connect(info["database_path"], isolation_level=None)
        db.row_factory = sqlite3.Row
        self.addCleanup(db.close)
        after = {name: [tuple(row) for row in db.execute('SELECT * FROM "' + name + '" ORDER BY rowid')] for name in tables}
        self.assertEqual(after, before)
        self.assertEqual(verify_provider_capture(db, result["batch_id"]), verify_provider_capture(self.db, result["batch_id"]))
        self.assertEqual(Path(info["database_path"]).stat().st_mode & 0o777, 0o600)
        with patch("worker.market.collection.download_ecb_xml") as download:
            with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
                discover_due_collections(db, now=NOW + timedelta(days=1))
            download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
