"""Ordinary TS human authorization to real provider slots and isolated synthetic SDK."""

from contextlib import contextmanager
from datetime import timedelta
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from worker.market.collection import verify_provider_capture
from worker.market.price_collection import prepare_price_collection, persist_price_collection
from worker.market.providers import longport
from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, content_hash, stamp
from worker.orchestration.jobs import JobCommit, claim_job, complete_job, enqueue_job
from worker.orchestration.price_collections import (
    DISCOVERY_ACTOR, PriceCollectionDiscoveryState, assert_price_collection_authorized,
    discover_due_price_collections, price_collection_request_binding, scheduled_at,
)
from worker.orchestration.runtime import run_pending_once, sync_requests
from tests.market.test_collection import fixture, utc_now, add_request
from tests.market.test_price_collection import mapping, publish_reference


class PriceScheduleTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = fixture(self)
        self.today = utc_now().astimezone(ZoneInfo("Asia/Shanghai")).date()
        self.period = (self.today - timedelta(days=1)).isoformat()
        self.before = stamp(utc_now() - timedelta(days=200))
        self.db.execute("INSERT INTO catalog_entries VALUES('p','CN:TEST','2025-01-01T00:00:00.000000Z')")
        self.mapping = publish_reference(self, self.path, "mapping", mapping(), at=self.before)
        self.days = {"market": "CN", "exchange": "TEST", "timezone": "Asia/Shanghai",
                     "range_start": (self.today - timedelta(days=5)).isoformat(), "range_end": (self.today + timedelta(days=2)).isoformat(),
                     "days": [{"date": (self.today + timedelta(days=offset)).isoformat(), "kind": "half" if offset == -1 else "full",
                               "close_at": (self.today + timedelta(days=offset)).isoformat() + "T07:00:00.000000Z"} for offset in range(-5, 3)]}
        self.calendar = publish_reference(self, self.path, "calendar", self.days, at=self.before)
        self.definition = {"schema_version": "price-collection-schedule-v1", "provider": "longport", "frequency": "daily", "publish": True,
                           "market": "CN", "timezone": "Asia/Shanghai", "mapping_version_ids": [self.mapping["id"]],
                           "calendar_version_ids": [self.calendar["id"]], "start_date": self.period, "end_date": self.period,
                           "trigger_local": {"hour": 0, "minute": 0}, "deadline_seconds": 86400, "max_attempts": 2,
                           "missed_policy": "record_no_backfill"}
        self.saved = None
        self.calls = 0

    def command(self, action, value, at=None):
        script = r"""
          import fs from 'node:fs'; import Database from 'better-sqlite3';
          import {savePriceCollectionSchedule,setPriceCollectionScheduleStatus} from './src/server/price-schedules/service.ts';
          const x=JSON.parse(fs.readFileSync(0,'utf8')), db=new Database(x.path); db.pragma('foreign_keys=ON');
          const fn=x.action==='save'?savePriceCollectionSchedule:setPriceCollectionScheduleStatus;
          const result=fn(db,{id:'synthetic-human',kind:'human'},x.value,{now:x.at}); db.close(); console.log(JSON.stringify(result));
        """
        result = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "-e", script], cwd=ROOT / "web", capture_output=True,
                                text=True, timeout=30, input=json.dumps({"path": str(self.path), "action": action, "value": value,
                                                                        "at": at or stamp(utc_now())}))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.saved = json.loads(result.stdout)
        return self.saved

    def save(self, definition=None, at=None):
        previous = self.saved
        return self.command("save", {"portfolio_id": "p", "expected_schedule_id": previous["schedule_id"] if previous else None,
                            "expected_schedule_revision": previous["schedule_revision"] if previous else 0,
                            "definition_json": json.dumps(definition or self.definition), "idempotency_key": "save:" + os.urandom(6).hex(),
                            "reason": "Synthetic finite daily-price fixture", "acknowledgement": True},
                            at or stamp(utc_now() - timedelta(days=8)))

    def status(self, status, at=None):
        return self.command("status", {"portfolio_id": "p", "schedule_id": self.saved["schedule_id"],
                            "expected_schedule_revision": self.saved["schedule_revision"], "status": status,
                            "idempotency_key": "status:" + os.urandom(6).hex(), "reason": "Synthetic explicit human control", "acknowledgement": True},
                            at or stamp(utc_now() - timedelta(days=7)))

    def enable(self, definition=None):
        self.save(definition)
        self.status("enabled")

    def enable_expired_history(self, count=106):
        end = self.today - timedelta(days=2)
        start = end - timedelta(days=count - 1)
        days = {**self.days, "range_start": start.isoformat(), "range_end": end.isoformat(),
                "days": [{"date": (start + timedelta(days=offset)).isoformat(), "kind": "full",
                          "close_at": (start + timedelta(days=offset)).isoformat() + "T07:00:00.000000Z"}
                         for offset in range(count)]}
        calendar = publish_reference(self, self.path, "calendar", days, version=1, at=self.before)
        definition = {**self.definition, "calendar_version_ids": [calendar["id"]],
                      "start_date": start.isoformat(), "end_date": end.isoformat()}
        self.save(definition, stamp(utc_now() - timedelta(days=count + 3)))
        self.status("enabled", stamp(utc_now() - timedelta(days=count + 2)))
        return definition

    def slots(self):
        return [dict(row) for row in self.db.execute("SELECT * FROM price_collection_schedule_slots ORDER BY period,id")]

    def pending(self):
        self.assertEqual(len(discover_due_price_collections(self.db)), 1)
        sync_requests(self.db, command_types=("market_collect_prices",))
        lease = claim_job(self.db, "synthetic-prices", 300, "market_collect_prices")
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        request = dict(self.db.execute("SELECT * FROM command_requests WHERE id=?", (job["command_request_id"],)).fetchone())
        return request, job, lease

    @contextmanager
    def transport(self, callback=None, failure=False):
        original = subprocess.Popen
        test = self
        class Process:
            def __init__(self, process):
                self.process = process
            def __getattr__(self, key):
                return getattr(self.process, key)
            def communicate(self, *args, **kwargs):
                result = self.process.communicate(*args, **kwargs)
                if callback:
                    callback()
                return result
        def launch(args, **kwargs):
            if str(ROOT / "web/node_modules/.bin/tsx") == args[0]:
                return original(args, **kwargs)
            test.assertEqual(args, [sys.executable, "-I", str(Path(longport.__file__).resolve()), "--sdk-child"])
            test.assertEqual(set(kwargs["env"]), {"TZ", "HOME", "LANG", "LC_ALL", "PYTHONUTF8"})
            test.assertEqual(kwargs["env"]["TZ"], "UTC")
            test.assertFalse(test.db.in_transaction)
            test.calls += 1
            target = [sys.executable, "-I", "-c", "raise SystemExit(1)"] if failure else [sys.executable, "-I", str(ROOT / "tests/market/price_schedule_sdk_child.py")]
            return Process(original(target, **kwargs))
        with patch.dict(os.environ, {"LONGPORT_APP_KEY": "fixture-only-key", "LONGPORT_APP_SECRET": "fixture-only-secret", "LONGPORT_ACCESS_TOKEN": "fixture-only-token"}), \
                patch.object(longport.subprocess, "Popen", side_effect=launch):
            yield

    def assert_no_capture(self):
        for table in ("market_sdk_captures", "market_batches", "market_publications"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0, table)

    def test_normal_human_service_provider_role_fixed_sdk_child_and_history(self):
        self.enable()
        facts = list(self.db.execute("SELECT * FROM ledger_events"))
        with self.transport():
            job = run_pending_once(self.db, "synthetic-provider", role="longport")
        self.assertEqual(job["status"], "succeeded")
        self.assertEqual(self.calls, 1)
        slot = self.slots()[0]
        self.assertEqual(slot["period"], self.period)
        self.assertEqual(slot["scheduled_at"], stamp(scheduled_at(self.period, self.definition)))
        self.assertEqual(slot["disposition"], "requested")
        result = json.loads(job["result_json"])
        proof = verify_provider_capture(self.db, result["batch_id"])
        self.assertEqual(proof["capture_kind"], "sdk_projection")
        self.assertFalse(result["live_advice_eligible"])
        self.assertEqual(job["period"], self.period)
        self.assertEqual(job["max_attempts"], 2)
        self.assertEqual(len(list(self.db.execute("SELECT * FROM market_observations"))), 1)
        self.assertEqual(list(self.db.execute("SELECT * FROM ledger_events")), facts)
        self.status("paused", stamp())
        self.assertEqual(verify_provider_capture(self.db, result["batch_id"]), proof)
        if os.environ.get("WORKBENCH_PRICE_SCHEDULE_TEST_ARTIFACT_DIR"):
            target = Path(os.environ["WORKBENCH_PRICE_SCHEDULE_TEST_ARTIFACT_DIR"])
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
            capture = dict(self.db.execute("SELECT * FROM market_sdk_captures WHERE id=?", (result["capture_id"],)).fetchone())
            raw = capture.pop("raw_body")
            (target / "sdk-projection-original.json").write_bytes(raw)
            (target / "synthetic-workbench.db").write_bytes(self.db.serialize())
            (target / "evidence.json").write_text(canonical_json({
                "synthetic_transport": True, "network_used": False, "provider_acceptance": False,
                "slot": slot, "job": job, "capture": capture, "independent_python_proof": proof,
                "paused_receipt": self.saved,
                "references": [dict(row) for row in self.db.execute("SELECT * FROM market_reference_versions ORDER BY id")],
                "reference_sources": [dict(row) for row in self.db.execute("SELECT * FROM market_reference_sources ORDER BY id")],
            }) + "\n", encoding="utf8")
            for name in ("sdk-projection-original.json", "synthetic-workbench.db", "evidence.json"):
                (target / name).chmod(0o600)
        with self.transport():
            self.assertIsNone(run_pending_once(self.db, "synthetic-provider", role="longport"))
        self.assertEqual(self.calls, 1)

    def test_saved_paused_and_non_provider_roles_do_not_discover(self):
        self.save()
        self.assertEqual(discover_due_price_collections(self.db), [])
        self.status("enabled")
        for role in ("core", "verifier"):
            self.assertIsNone(run_pending_once(self.db, "synthetic-other-role", role=role))
        self.assertEqual(self.slots(), [])

    def test_next_local_day_and_restart_dedup(self):
        self.enable()
        due = scheduled_at(self.period, self.definition)
        self.assertEqual(discover_due_price_collections(self.db, now=due - timedelta(microseconds=1)), [])
        self.assertEqual(len(discover_due_price_collections(self.db, now=due)), 1)
        self.assertEqual(discover_due_price_collections(self.db, now=due, state=PriceCollectionDiscoveryState()), [])
        slot = self.slots()[0]
        request = self.db.execute("SELECT * FROM command_requests WHERE id=?", (slot["command_request_id"],)).fetchone()
        self.assertEqual(json.loads(request["payload_json"])["start_date"], self.period)
        self.assertEqual(request["actor_id"], DISCOVERY_ACTOR)
        self.assertEqual(price_collection_request_binding(self.db, request)["slot"], slot)

    def test_missed_deadline_is_durable_and_never_enqueued(self):
        self.enable()
        at = scheduled_at(self.period, self.definition) + timedelta(days=1)
        self.assertEqual(len(discover_due_price_collections(self.db, now=at)), 1)
        self.assertEqual(self.slots()[0]["reason_code"], "DEADLINE_EXPIRED")
        self.assertIsNone(self.slots()[0]["command_request_id"])
        self.assertEqual(sync_requests(self.db, now=at, command_types=("market_collect_prices",)), [])
        self.assertEqual(discover_due_price_collections(self.db, now=at + timedelta(days=1)), [])

    def test_pause_before_discovery_records_original_window_as_missed(self):
        self.enable()
        due = scheduled_at(self.period, self.definition)
        self.status("paused", stamp(due + timedelta(seconds=1)))
        self.assertEqual(len(discover_due_price_collections(self.db, now=due + timedelta(seconds=2))), 1)
        self.assertEqual(self.slots()[0]["reason_code"], "AUTHORIZATION_ENDED")
        self.assert_no_capture()

    def test_closed_calendar_skips_without_request(self):
        days = {**self.days, "days": [{**row, "kind": "closed", "close_at": None} for row in self.days["days"]]}
        newer = publish_reference(self, self.path, "calendar", days, version=1, at=stamp(utc_now() - timedelta(days=9)))
        self.enable({**self.definition, "calendar_version_ids": [newer["id"]]})
        self.assertEqual(len(discover_due_price_collections(self.db)), 1)
        self.assertEqual((self.slots()[0]["disposition"], self.slots()[0]["reason_code"]), ("skipped", "MARKET_CLOSED"))
        self.assertIsNone(self.slots()[0]["command_request_id"])

    def test_stale_reference_creates_blocked_slot_without_network(self):
        self.enable()
        publish_reference(self, self.path, "mapping", mapping(), version=1, at=stamp())
        self.assertEqual(len(discover_due_price_collections(self.db)), 1)
        self.assertEqual(self.slots()[0]["disposition"], "blocked")
        self.assertEqual(self.slots()[0]["reason_code"], "REFERENCE_CHANGED")
        self.assertIsNone(self.slots()[0]["command_request_id"])

    def test_mixed_exchanges_block_without_shrinking_the_scope(self):
        self.db.execute("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('CN:SECOND','instrument','CN','OTHER','000002','CNY','2025-01-01T00:00:00Z')")
        self.db.execute("INSERT INTO catalog_entries VALUES('p','CN:SECOND','2025-01-01T00:00:00Z')")
        mapped = publish_reference(self, self.path, "mapping", mapping("CN:SECOND", exchange="OTHER", symbol="000002.SH"), at=self.before)
        days = {**self.days, "exchange": "OTHER", "days": [{**row, "kind": "closed", "close_at": None} for row in self.days["days"]]}
        calendar = publish_reference(self, self.path, "calendar", days, at=self.before)
        self.enable({**self.definition, "mapping_version_ids": [self.mapping["id"], mapped["id"]],
                     "calendar_version_ids": [self.calendar["id"], calendar["id"]]})
        self.assertEqual(len(discover_due_price_collections(self.db)), 1)
        self.assertEqual(self.slots()[0]["reason_code"], "MIXED_CALENDAR_SESSION")
        self.assertEqual(len(json.loads(self.slots()[0]["reference_binding_json"])["mappings"]), 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM command_requests").fetchone()[0], 0)

    def test_bounded_missed_scan_and_current_window_priority(self):
        self.enable({**self.definition, "start_date": self.days["range_start"]})
        state = PriceCollectionDiscoveryState()
        self.assertEqual(len(discover_due_price_collections(self.db, limit=1, scan_limit=1, state=state)), 1)
        self.assertEqual(self.slots()[0]["period"], self.period)
        for _ in range(8):
            self.assertLessEqual(len(discover_due_price_collections(self.db, limit=1, scan_limit=1, state=state)), 1)
        self.assertEqual(len(self.slots()), 5)
        self.assertEqual(sum(slot["disposition"] == "requested" for slot in self.slots()), 1)
        for kwargs in ({"limit": True}, {"scan_limit": 0}, {"state": {}}):
            with self.assertRaises(WorkbenchError):
                discover_due_price_collections(self.db, **kwargs)

    def test_fresh_state_default_quota_advances_from_durable_missed_slots(self):
        self.enable_expired_history()
        self.assertEqual(len(discover_due_price_collections(self.db)), 100)
        self.assertEqual(len(discover_due_price_collections(self.db, state=PriceCollectionDiscoveryState())), 6)
        self.assertEqual(discover_due_price_collections(self.db), [])
        self.assertEqual(len(self.slots()), 106)
        self.assertEqual({slot["reason_code"] for slot in self.slots()}, {"DEADLINE_EXPIRED"})
        self.assertEqual(self.db.execute("SELECT count(*) FROM command_requests").fetchone()[0], 0)
        self.assert_no_capture()

    def test_fresh_state_fills_middle_gaps_without_skipping_current_window(self):
        self.enable({**self.definition, "start_date": self.days["range_start"]})
        self.assertEqual(len(discover_due_price_collections(self.db, limit=1, scan_limit=1)), 1)
        self.assertEqual(self.slots()[0]["period"], self.period)
        for _ in range(4):
            self.assertEqual(len(discover_due_price_collections(self.db, limit=1, scan_limit=1,
                                                              state=PriceCollectionDiscoveryState())), 1)
        self.assertEqual(len(self.slots()), 5)
        self.assertEqual(sum(slot["disposition"] == "requested" for slot in self.slots()), 1)
        self.assertEqual(discover_due_price_collections(self.db, limit=1, scan_limit=1), [])

    def test_fresh_state_skips_completed_authorization_intervals(self):
        definition = {**self.definition, "start_date": self.days["range_start"]}
        self.enable(definition)
        for offset in range(3):
            period = (self.today - timedelta(days=5 - offset)).isoformat()
            due = scheduled_at(period, definition)
            self.status("paused", stamp(due + timedelta(seconds=1)))
            self.status("enabled", stamp(due + timedelta(seconds=2)))
        now = scheduled_at(self.period, definition) + timedelta(days=1)
        for _ in range(5):
            self.assertEqual(len(discover_due_price_collections(self.db, limit=1, scan_limit=1, now=now)), 1)
        self.assertEqual(len(self.slots()), 5)
        self.assertEqual(discover_due_price_collections(self.db, limit=1, scan_limit=1, now=now), [])
        self.assertEqual(self.db.execute("SELECT count(*) FROM command_requests").fetchone()[0], 0)

    def test_durable_gap_ranges_exclude_unauthorized_endpoints_and_empty_intervals(self):
        definition = {**self.definition, "start_date": self.days["range_start"]}
        self.save(definition)
        due = [scheduled_at((self.today - timedelta(days=5 - offset)).isoformat(), definition) for offset in range(5)]
        self.status("enabled", stamp(due[0] + timedelta(microseconds=1)))
        self.status("paused", stamp(due[1]))
        self.status("enabled", stamp(due[1] + timedelta(microseconds=1)))
        self.status("paused", stamp(due[2] + timedelta(microseconds=1)))
        self.status("enabled", stamp(due[2] + timedelta(microseconds=2)))
        now = due[-1] + timedelta(days=1)
        for _ in range(3):
            self.assertEqual(len(discover_due_price_collections(self.db, limit=1, scan_limit=1, now=now)), 1)
        self.assertEqual([slot["period"] for slot in self.slots()],
                         [(self.today - timedelta(days=offset)).isoformat() for offset in (3, 2, 1)])
        self.assertEqual(discover_due_price_collections(self.db, limit=1, scan_limit=1, now=now), [])
        self.assertEqual(self.db.execute("SELECT count(*) FROM command_requests").fetchone()[0], 0)

    def test_repeated_cli_once_processes_complete_expired_history_without_backfill(self):
        self.enable_expired_history()
        # Only SDK availability is stubbed; the child executes the actual CLI and discovery.
        script = """
import runpy
import sys
from worker.market.providers import longport
longport._load_sdk = lambda: object()
def forbid_transport(event, arguments):
    if event in ('socket.connect', 'socket.getaddrinfo', 'subprocess.Popen'):
        raise AssertionError('expired slots must not invoke transport')
sys.addaudithook(forbid_transport)
runpy.run_module('worker.orchestration', run_name='__main__')
"""
        for expected in (100, 106, 106):
            result = subprocess.run([sys.executable, "-c", script, "--db", str(self.path), "--role", "longport", "--once"],
                                    cwd=ROOT, capture_output=True, text=True, timeout=30,
                                    env={"PATH": os.defpath, "TZ": "UTC", "LONGPORT_APP_KEY": "synthetic-key",
                                         "LONGPORT_APP_SECRET": "synthetic-secret", "LONGPORT_ACCESS_TOKEN": "synthetic-token"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertEqual(len(self.slots()), expected)
        self.assertEqual({slot["reason_code"] for slot in self.slots()}, {"DEADLINE_EXPIRED"})
        self.assertEqual(self.db.execute("SELECT count(*) FROM command_requests").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM job_runs").fetchone()[0], 0)
        self.assert_no_capture()

    def test_reserved_discovery_actor_without_slot_is_not_dispatched(self):
        value = {"schema_version": "market-price-collect-v1", "provider": "longport", "mapping_version_ids": [self.mapping["id"]],
                 "calendar_version_ids": [self.calendar["id"]], "start_date": self.period, "end_date": self.period,
                 "expected_publication_revision": 0, "publish": True}
        self.db.execute("INSERT INTO command_requests(id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at) VALUES('bad','p','market_collect_prices','bad',?,?,?,?)",
                        (content_hash(value), canonical_json(value), DISCOVERY_ACTOR, stamp()))
        self.assertEqual(sync_requests(self.db, command_types=("market_collect_prices",)), [])
        self.assertEqual(self.db.execute("SELECT count(*) FROM job_runs").fetchone()[0], 0)

    def test_pause_during_real_child_call_discards_all_market_effects(self):
        self.enable()
        with self.transport(callback=lambda: self.status("paused", stamp())):
            job = run_pending_once(self.db, "synthetic-provider", role="longport")
        self.assertEqual(job["status"], "skipped")
        self.assertEqual(json.loads(job["result_json"])["code"], "PRICE_COLLECTION_AUTHORIZATION_ENDED")
        self.assert_no_capture()

    def test_pause_after_first_listing_prevents_a_second_sdk_call(self):
        self.db.execute("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('CN:SECOND','instrument','CN','TEST','000002','CNY','2025-01-01T00:00:00Z')")
        self.db.execute("INSERT INTO catalog_entries VALUES('p','CN:SECOND','2025-01-01T00:00:00Z')")
        mapped = publish_reference(self, self.path, "mapping", mapping("CN:SECOND", symbol="000002.SH"), at=self.before)
        self.enable({**self.definition, "mapping_version_ids": [self.mapping["id"], mapped["id"]]})
        with self.transport(callback=lambda: self.status("paused", stamp())):
            job = run_pending_once(self.db, "synthetic-provider", role="longport")
        self.assertEqual(job["status"], "skipped")
        self.assertEqual(self.calls, 1)
        self.assert_no_capture()

    def test_late_queued_request_expires_without_any_sdk_call(self):
        self.enable()
        self.assertEqual(len(discover_due_price_collections(self.db)), 1)
        late = scheduled_at(self.period, self.definition) + timedelta(days=1)
        with self.transport():
            job = run_pending_once(self.db, "synthetic-provider", role="longport", clock=lambda: late)
        self.assertEqual(job["status"], "skipped")
        self.assertEqual(json.loads(job["result_json"])["code"], "PRICE_COLLECTION_DEADLINE_EXPIRED")
        self.assertEqual(self.calls, 0)
        self.assert_no_capture()

    def test_reference_change_during_call_discards_capture(self):
        self.enable()
        with self.transport(callback=lambda: publish_reference(self, self.path, "mapping", mapping(), version=1, at=stamp())):
            job = run_pending_once(self.db, "synthetic-provider", role="longport")
        self.assertEqual(job["status"], "skipped")
        self.assertEqual(json.loads(job["result_json"])["code"], "PRICE_COLLECTION_REFERENCE_CHANGED")
        self.assert_no_capture()

    def test_revision_during_call_pauses_and_never_reinterprets_original_slot(self):
        self.enable()
        with self.transport(callback=lambda: self.save({**self.definition, "max_attempts": 3}, stamp())):
            job = run_pending_once(self.db, "synthetic-provider", role="longport")
        self.assertEqual(job["status"], "skipped")
        self.assertEqual(self.saved["status"], "paused")
        self.assertNotEqual(self.slots()[0]["schedule_version_id"], self.saved["version_id"])
        self.assertEqual(discover_due_price_collections(self.db), [])
        self.assert_no_capture()

    def test_competing_manual_publication_keeps_frozen_cas_and_discards_scheduled_capture(self):
        self.enable()
        value = {"schema_version": "market-price-collect-v1", "provider": "longport", "mapping_version_ids": [self.mapping["id"]],
                 "calendar_version_ids": [self.calendar["id"]], "start_date": self.period, "end_date": self.period,
                 "expected_publication_revision": 0, "publish": True}
        request = add_request(self.db, "manual-competition", value, kind="market_collect_prices")
        enqueue_job(self.db, "market_collect_prices", "p", request["created_at"][:10], request["id"] + ":" + request["payload_hash"], command_request_id=request["id"])
        lease = claim_job(self.db, "synthetic-manual", 300, "market_collect_prices")
        manual_job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        with self.transport():
            prepared = prepare_price_collection(self.db, request, manual_job, lease)
        # The provider mutex serializes SDK jobs, but discovery can freeze a CAS while one is running.
        self.assertEqual(len(discover_due_price_collections(self.db)), 1)
        complete_job(self.db, lease, {}, effect=lambda db: JobCommit(persist_price_collection(db, prepared)))
        with self.transport():
            job = run_pending_once(self.db, "synthetic-provider", role="longport")
        self.assertEqual(job["status"], "skipped")
        self.assertEqual(json.loads(job["result_json"])["code"], "STALE_PUBLICATION_REVISION")
        self.assertEqual(self.slots()[0]["expected_publication_revision"], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM market_sdk_captures").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT revision FROM market_publications").fetchone()[0], 1)
        self.assertEqual(self.calls, 1)

    def test_finalization_deadline_rolls_back_capture_publication_and_success(self):
        local = utc_now().astimezone(ZoneInfo("Asia/Shanghai"))
        definition = {**self.definition, "trigger_local": {"hour": local.hour, "minute": local.minute}, "deadline_seconds": 120}
        self.enable(definition)
        override = [None]
        def clock():
            return override[0] or utc_now()
        def persist_then_expire(*args, **kwargs):
            result = persist_price_collection(*args, **kwargs)
            override[0] = scheduled_at(self.period, definition) + timedelta(seconds=120)
            return result
        with self.transport(), patch("worker.market.price_collection.persist_price_collection", side_effect=persist_then_expire):
            with self.assertRaisesRegex(WorkbenchError, "PRICE_COLLECTION_DEADLINE_EXPIRED"):
                run_pending_once(self.db, "synthetic-provider", role="longport", clock=clock)
        self.assert_no_capture()
        self.assertNotEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "succeeded")

    def test_transport_failure_retries_original_slot_then_succeeds(self):
        self.enable()
        with self.transport(failure=True), self.assertRaisesRegex(WorkbenchError, "PRICE_PROVIDER_COLLECTION_FAILED"):
            run_pending_once(self.db, "synthetic-provider", role="longport")
        first = dict(self.db.execute("SELECT * FROM job_runs").fetchone())
        self.assertEqual(first["status"], "retry_queued")
        self.assert_no_capture()
        request = first["command_request_id"]
        self.db.execute("UPDATE job_runs SET not_before=? WHERE id=?", (stamp(), first["id"]))
        with self.transport():
            final = run_pending_once(self.db, "synthetic-provider", role="longport")
        self.assertEqual(final["status"], "succeeded")
        self.assertEqual(final["command_request_id"], request)
        self.assertEqual(final["attempt_count"], 2)
        self.assertEqual(len(self.slots()), 1)

    def test_restore_lock_blocks_discovery_and_inflight_commit(self):
        self.enable()
        request, job, lease = self.pending()
        with self.transport():
            prepared = prepare_price_collection(self.db, request, job, lease)
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        marker.write_text("synthetic recovery lock")
        with self.assertRaises(WorkbenchError):
            discover_due_price_collections(self.db)
        with self.assertRaises(WorkbenchError):
            complete_job(self.db, lease, {}, effect=lambda db: JobCommit(persist_price_collection(db, prepared)))
        self.assert_no_capture()

    def test_lease_loss_after_transport_blocks_all_capture(self):
        self.enable()
        def lose():
            self.db.execute("UPDATE job_runs SET fencing_token=fencing_token+1 WHERE status='running'")
        with self.transport(callback=lose), self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            run_pending_once(self.db, "synthetic-provider", role="longport")
        self.assert_no_capture()

    def test_job_scope_and_frozen_request_tampering_fail_independent_binding(self):
        self.enable()
        request, job, lease = self.pending()
        for field, value in (("scope", "foreign"), ("period", "2025-01-01"), ("max_attempts", 5), ("input_version", "forged")):
            with self.subTest(field=field), self.assertRaises(WorkbenchError):
                assert_price_collection_authorized(self.db, request, {**job, field: value}, lease)
        for field, value in (("actor_id", "synthetic-human"), ("portfolio_id", "foreign"), ("payload_hash", "0" * 64), ("idempotency_key", "different")):
            with self.subTest(field=field), self.assertRaises(WorkbenchError):
                price_collection_request_binding(self.db, {**request, field: value})

    def test_success_history_rejects_changed_job_input_version_and_attempt_window(self):
        self.enable()
        with self.transport():
            job = run_pending_once(self.db, "synthetic-provider", role="longport")
        self.assertEqual(job["status"], "succeeded")
        batch_id = json.loads(job["result_json"])["batch_id"]
        verify_provider_capture(self.db, batch_id)
        for table, query, values in (
            ("job_runs", "UPDATE job_runs SET input_version=? WHERE id=?", ("forged", job["id"])),
            ("job_attempts", "UPDATE job_attempts SET started_at=? WHERE job_id=?", (stamp(scheduled_at(self.period, self.definition) - timedelta(seconds=1)), job["id"])),
        ):
            self.db.execute("SAVEPOINT synthetic_damage")
            try:
                for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?", (table,)).fetchall():
                    self.db.execute('DROP TRIGGER "' + row[0].replace('"', '""') + '"')
                self.db.execute(query, values)
                with self.subTest(table=table), self.assertRaises(WorkbenchError):
                    verify_provider_capture(self.db, batch_id)
            finally:
                self.db.execute("ROLLBACK TO synthetic_damage")
                self.db.execute("RELEASE synthetic_damage")
        verify_provider_capture(self.db, batch_id)

    def test_broken_frozen_reference_leaves_explicit_blocked_slot(self):
        self.enable()
        self.db.execute("SAVEPOINT synthetic_damage")
        try:
            for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='market_reference_versions'").fetchall():
                self.db.execute('DROP TRIGGER "' + row[0].replace('"', '""') + '"')
            self.db.execute("UPDATE market_reference_versions SET content_hash=? WHERE id=?", ("0" * 64, self.mapping["id"]))
            self.assertEqual(len(discover_due_price_collections(self.db)), 1)
            self.assertEqual(self.slots()[0]["reason_code"], "REFERENCE_INVALID")
            self.assertIsNone(self.slots()[0]["command_request_id"])
        finally:
            self.db.execute("ROLLBACK TO synthetic_damage")
            self.db.execute("RELEASE synthetic_damage")

    def test_dst_gap_and_fold_never_choose_an_implicit_instant(self):
        for period, trigger in (("2026-03-07", {"hour": 2, "minute": 30}), ("2026-10-31", {"hour": 1, "minute": 30})):
            with self.subTest(period=period), self.assertRaises(WorkbenchError):
                scheduled_at(period, {**self.definition, "timezone": "America/New_York", "trigger_local": trigger})
        self.assertEqual(stamp(scheduled_at("2026-03-08", {**self.definition, "timezone": "America/New_York", "trigger_local": {"hour": 3, "minute": 0}})), "2026-03-09T07:00:00.000000Z")


if __name__ == "__main__":
    unittest.main()
