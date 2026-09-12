"""Real SQLite collection proofs with synthetic transport, never CI network."""

from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from worker.market import ingest_document, prepare_valuation, publish_batch
from worker.market.collection import (
    collection_scope, persist_collection, prepare_collection, source_verified,
    verify_provider_capture,
)
from worker.market.providers.ecb import URLS, parse_ecb_xml
from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, content_hash, open_database, stamp
from worker.orchestration.jobs import JobCommit, claim_job, complete_job, enqueue_job
from tests.market.support import document, ledger_event, seed_account
from tests.market.test_ecb_provider import xml


def utc_now():
    return datetime.now(timezone.utc)


def payload(revision=0, publish=True, feed="daily", currencies=None):
    return {"provider": "ecb", "feed": feed, "currencies": ["USD", "HKD"] if currencies is None else currencies,
            "expected_publication_revision": revision, "publish": publish}


def fake_download(raw=None, inspect=None):
    raw = b"\xef\xbb\xbf" + xml().replace(b"/><", b"/>\r\n<") if raw is None else raw
    def download(feed):
        if inspect is not None:
            inspect()
        started, completed = stamp(utc_now()), stamp(utc_now())
        return {"raw": raw, "source_url": URLS[feed], "started_at": started, "completed_at": completed,
                "retrieved_at": completed, "http_status": 200, "headers": {"content-type": "text/xml"},
                "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw), "redirects_followed": 0}
    return download


def add_request(db, identity, value, portfolio="p", kind="market_collect"):
    now = utc_now()
    db.execute("""INSERT INTO command_requests
        (id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at)
        VALUES(?,?,?,?,?,?,?,?)""", (identity, portfolio, kind, identity, content_hash(value), canonical_json(value), "synthetic-human", stamp(now)))
    return dict(db.execute("SELECT * FROM command_requests WHERE id=?", (identity,)).fetchone())


def fixture(test):
    temporary = TemporaryDirectory(prefix="synthetic-provider-collection-")
    test.addCleanup(temporary.cleanup)
    path = Path(temporary.name) / "workbench.db"
    migrated = subprocess.run(["node", str(ROOT / "scripts/migrate-workbench.mjs"), "--db", str(path)],
                              capture_output=True, text=True, cwd=ROOT, timeout=30, check=False)
    test.assertEqual(migrated.returncode, 0, migrated.stderr)
    db = open_database(path)
    test.addCleanup(db.close)
    seed_account(db)
    ledger_event(db, "synthetic-capital", (("cash_settled", "240"), ("external_capital", "-240")))
    return db, path


def db_state(db):
    names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    return {name: [tuple(row) for row in db.execute('SELECT * FROM "' + name.replace('"', '""') + '" ORDER BY rowid')]
            for name in names}


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = fixture(self)
        self.number = 0

    def pending(self, value=None):
        self.number += 1
        request = add_request(self.db, "collect:" + str(self.number), value or payload())
        job = enqueue_job(self.db, "market_collect", "p", request["created_at"][:10], request["id"] + ":" + request["payload_hash"],
                          command_request_id=request["id"], now=utc_now())
        lease = claim_job(self.db, "synthetic-worker:" + str(self.number), 300, "market_collect", now=utc_now())
        self.assertEqual(lease.job_id, job["id"])
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (job["id"],)).fetchone())
        return request, job, lease

    def prepare(self, value=None, raw=None):
        request, job, lease = self.pending(value)
        with patch("worker.market.collection.download_ecb_xml", fake_download(raw)):
            prepared = prepare_collection(self.db, request, job, lease)
        return prepared, lease

    def commit(self, prepared, lease):
        now = utc_now()
        complete_job(self.db, lease, {}, effect=lambda db: JobCommit(persist_collection(db, prepared, now=now)), now=now)
        return json.loads(self.db.execute("SELECT result_json FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()[0])

    def test_success_original_blob_hash_parser_and_published_manifest_replay(self):
        before_facts = list(self.db.execute("SELECT * FROM ledger_events"))
        prepared, lease = self.prepare()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_provider_captures").fetchone()[0], 0)
        result = self.commit(prepared, lease)
        capture = self.db.execute("SELECT * FROM market_provider_captures").fetchone()
        self.assertIsInstance(capture["raw_body"], bytes)
        self.assertEqual(capture["raw_body"], prepared.raw)
        self.assertTrue(capture["raw_body"].startswith(b"\xef\xbb\xbf"))
        self.assertEqual(sha256(capture["raw_body"]).hexdigest(), prepared.receipt["raw_sha256"])
        self.assertEqual(json.loads(capture["normalized_json"]), parse_ecb_xml(prepared.raw, feed="daily",
                         retrieved_at=prepared.receipt["received_at"], currencies=["USD", "HKD"]))
        proof = verify_provider_capture(self.db, result["batch_id"])
        self.assertEqual(proof["id"], result["capture_id"])
        self.assertEqual(proof["receipt_hash"], result["receipt_hash"])
        self.assertEqual(proof["raw_sha256"], prepared.receipt["raw_sha256"])
        batch = self.db.execute("SELECT * FROM market_batches").fetchone()
        self.assertEqual(batch["status"], "published")
        validation = json.loads(batch["validation_json"])
        self.assertEqual(validation["manifest"]["provider_capture"], proof)
        self.assertTrue(source_verified(self.db, batch["id"], validation["plan"]))
        self.assertFalse(result["live_advice_eligible"])
        self.assertEqual(list(self.db.execute("SELECT * FROM ledger_events")), before_facts)

    def test_dates_remain_dates_without_fabricated_historical_publication_time(self):
        raw = xml([("2025-06-06", [("CNY", "8"), ("USD", "2")]), ("2025-06-05", [("CNY", "8"), ("USD", "4")])])
        prepared, lease = self.prepare(payload(feed="hist_90d", currencies=["USD"]), raw)
        result = self.commit(prepared, lease)
        observations = self.db.execute("SELECT * FROM market_observations ORDER BY observed_at").fetchall()
        self.assertEqual([row["observed_at"] for row in observations], ["2025-06-05", "2025-06-06"])
        for row in observations:
            self.assertIsNone(row["published_at"])
            self.assertEqual(row["time_precision"], "date")
            self.assertEqual(row["ingested_at"], prepared.receipt["received_at"])
            self.assertEqual(row["source_timezone"], "Europe/Berlin")
        self.assertEqual(prepared.receipt["coverage_kind"], "returned_feed_dates_not_historical_calendar")
        self.assertEqual(verify_provider_capture(self.db, result["batch_id"])["rate_kind"], "reference_not_executable")

    def test_recollection_new_revision_preserves_old_publication_and_as_known_members(self):
        old, lease = self.prepare()
        first = self.commit(old, lease)
        original_capture = dict(self.db.execute("SELECT * FROM market_provider_captures WHERE id=?", (first["capture_id"],)).fetchone())
        original_observations = [dict(row) for row in self.db.execute("SELECT * FROM market_observations ORDER BY id")]
        publication = dict(self.db.execute("SELECT * FROM market_publication_events WHERE batch_id=?", (first["batch_id"],)).fetchone())
        newer_raw = xml([("2025-06-06", [("CNY", "8.4"), ("USD", "1.25"), ("HKD", "10")])])
        new, lease = self.prepare(payload(revision=1), newer_raw)
        second = self.commit(new, lease)
        self.assertNotEqual(first["capture_id"], second["capture_id"])
        self.assertEqual(self.db.execute("SELECT revision FROM market_publications").fetchone()[0], 2)
        as_known = self.db.execute("SELECT batch_id FROM market_publication_events WHERE scope=? AND published_at<=? ORDER BY revision DESC LIMIT 1",
                                   (publication["scope"], publication["published_at"])).fetchone()[0]
        self.assertEqual(as_known, first["batch_id"])
        self.assertEqual(dict(self.db.execute("SELECT * FROM market_provider_captures WHERE id=?", (first["capture_id"],)).fetchone()), original_capture)
        for original in original_observations:
            self.assertEqual(dict(self.db.execute("SELECT * FROM market_observations WHERE id=?", (original["id"],)).fetchone()), original)
        self.assertEqual(verify_provider_capture(self.db, first["batch_id"])["raw_sha256"], old.receipt["raw_sha256"])
        self.assertEqual(verify_provider_capture(self.db, second["batch_id"])["raw_sha256"], new.receipt["raw_sha256"])

    def test_historical_reference_capture_is_not_available_to_old_as_known_valuation(self):
        ledger_event(self.db, "synthetic-usd-capital", (("cash_settled", "10"), ("external_capital", "-10")), currency="USD")
        prepared, lease = self.prepare()
        self.commit(prepared, lease)
        rules = {"schema_version": "valuation-rules-v1", "approved": True,
                 "approval_evidence": "Synthetic valuation data-quality rules, not execution authorization",
                 "price_scope_by_market": {}, "expected_sessions": {}, "corporate_actions_complete": {},
                 "fx_scope": collection_scope(payload()), "max_fx_age_seconds": 86400}
        before = db_state(self.db)
        cutoff = "2025-06-07T00:00:00Z"
        original = prepare_valuation(self.db, "p", cutoff, rules, "as_known", now=utc_now())
        self.assertEqual(original.quality, "blocked")
        self.assertIsNone(original.nav_cny)
        self.assertTrue(any(code.startswith("MISSING_PUBLICATION:") for code in original.issues))
        restated = prepare_valuation(self.db, "p", cutoff, rules, "restated", now=utc_now())
        self.assertEqual((restated.quality, restated.nav_cny), ("complete", "304"))
        manifest = json.loads(restated.market_manifest)
        self.assertEqual(manifest["mode"], "restated")
        self.assertGreater(manifest["publications"][collection_scope(payload())]["published_at"], cutoff)
        stale = prepare_valuation(self.db, "p", stamp(utc_now()), rules, "as_known", now=utc_now())
        self.assertEqual(stale.quality, "provisional")
        self.assertIn("STALE_FX:USD", stale.issues)
        self.assertEqual(db_state(self.db), before)

    def test_validate_only_capture_does_not_become_an_eligible_published_source(self):
        prepared, lease = self.prepare(payload(publish=False))
        result = self.commit(prepared, lease)
        self.assertEqual(result["batch_status"], "validated")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_publications").fetchone()[0], 0)
        self.assertEqual(verify_provider_capture(self.db, result["batch_id"], require_published=False)["id"], result["capture_id"])
        with self.assertRaisesRegex(WorkbenchError, "PROVIDER_EVIDENCE_INVALID"):
            verify_provider_capture(self.db, result["batch_id"])
        self.assertFalse(source_verified(self.db, result["batch_id"], prepared.document["batch"]))

    def test_validate_only_terminal_capture_cannot_publish_but_fresh_explicit_collection_can(self):
        staged, lease = self.prepare(payload(publish=False))
        staged_result = self.commit(staged, lease)
        before = db_state(self.db)
        with self.assertRaisesRegex(WorkbenchError, "PROVIDER_PUBLICATION_REQUIRES_ACTIVE_COMMAND"):
            publish_batch(self.db, staged_result["batch_id"], now=utc_now())
        self.assertEqual(db_state(self.db), before)
        self.assertFalse(source_verified(self.db, staged_result["batch_id"], staged.document["batch"]))
        fresh, fresh_lease = self.prepare(payload(publish=True))
        fresh_result = self.commit(fresh, fresh_lease)
        self.assertNotEqual(fresh_result["capture_id"], staged_result["capture_id"])
        self.assertEqual(self.db.execute("SELECT batch_id,revision FROM market_publications").fetchone()[:],
                         (fresh_result["batch_id"], 1))
        self.assertEqual(self.db.execute("SELECT status FROM market_batches WHERE id=?", (staged_result["batch_id"],)).fetchone()[0], "validated")
        self.assertTrue(source_verified(self.db, fresh_result["batch_id"], fresh.document["batch"]))
        self.assertFalse(source_verified(self.db, staged_result["batch_id"], staged.document["batch"]))

    def test_publish_true_unpublished_terminal_job_cannot_be_resumed_by_generic_publisher(self):
        prepared, lease = self.prepare(payload(publish=True))
        # Fault injection creates an old terminal/validated state which the
        # current atomic runtime cannot normally produce.
        with patch("worker.market.batches.publish_batch", return_value=None):
            result = self.commit(prepared, lease)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()[0], "succeeded")
        self.assertEqual(self.db.execute("SELECT status FROM market_batches").fetchone()[0], "validated")
        before = db_state(self.db)
        with self.assertRaisesRegex(WorkbenchError, "PROVIDER_PUBLICATION_REQUIRES_ACTIVE_COMMAND"):
            publish_batch(self.db, result["batch_id"], now=utc_now())
        self.assertEqual(db_state(self.db), before)
        with self.assertRaisesRegex(WorkbenchError, "PROVIDER_EVIDENCE_INVALID"):
            verify_provider_capture(self.db, result["batch_id"])

    def test_consumer_requires_published_status_in_original_worker_result(self):
        prepared, lease = self.prepare()
        result = self.commit(prepared, lease)
        result["batch_status"] = "validated"
        self.db.execute("UPDATE job_runs SET result_json=? WHERE id=?", (canonical_json(result), lease.job_id))
        before = db_state(self.db)
        with self.assertRaisesRegex(WorkbenchError, "PROVIDER_EVIDENCE_INVALID"):
            verify_provider_capture(self.db, result["batch_id"])
        self.assertFalse(source_verified(self.db, result["batch_id"], prepared.document["batch"]))
        self.assertEqual(db_state(self.db), before)

    def test_persist_without_successful_job_terminal_is_not_published_evidence(self):
        prepared, lease = self.prepare()
        result = persist_collection(self.db, prepared, now=utc_now())
        with self.assertRaisesRegex(WorkbenchError, "PROVIDER_EVIDENCE_INVALID"):
            verify_provider_capture(self.db, result["batch_id"])
        self.assertEqual(verify_provider_capture(self.db, result["batch_id"], require_published=False)["id"], result["capture_id"])

    def test_mutated_prepared_material_rejects_atomically(self):
        prepared, lease = self.prepare()
        changes = [replace(prepared, raw=prepared.raw + b" ")]
        for key, value in (("raw_sha256", "0" * 64), ("request_hash", "1" * 64), ("fencing_token", lease.fencing_token + 1),
                           ("endpoint", URLS["hist_90d"]), ("job_id", "job:wrong")):
            receipt = {**prepared.receipt, key: value}
            changes.append(replace(prepared, receipt=receipt))
        for key, value in (("scope", "provider:ecb:fx:daily:EUR"), ("source_id", "provider:other")):
            document = deepcopy(prepared.document)
            document["batch"][key] = value
            receipt = {**prepared.receipt, "document_hash": content_hash(document)}
            changes.append(replace(prepared, document=document, receipt=receipt))
        for changed in changes:
            before = db_state(self.db)
            with self.subTest(receipt=changed.receipt["id"]), self.assertRaises((WorkbenchError, sqlite3.IntegrityError)):
                persist_collection(self.db, changed, now=utc_now())
            self.assertEqual(db_state(self.db), before)

    def test_mutating_nested_prepared_values_and_rehashing_does_not_bypass_frozen_prepare(self):
        prepared, _ = self.prepare()
        prepared.normalized["records"][0]["value_cny_per_unit"] = "999"
        currency = prepared.normalized["records"][0]["currency"]
        for observation in prepared.document["pages"][0]["observations"]:
            if observation["series_key"] == "FX:" + currency:
                observation["value"] = "999"
        prepared.receipt["normalized_hash"] = content_hash(prepared.normalized)
        prepared.receipt["document_hash"] = content_hash(prepared.document)
        before = db_state(self.db)
        with self.assertRaisesRegex(WorkbenchError, "PROVIDER_PREPARED_MUTATED"):
            persist_collection(self.db, prepared, now=utc_now())
        self.assertEqual(db_state(self.db), before)

    def test_expired_lease_restore_marker_and_stale_cas_never_publish(self):
        prepared, lease = self.prepare()
        before = db_state(self.db)
        with self.assertRaises((WorkbenchError, sqlite3.IntegrityError)):
            persist_collection(self.db, prepared, now=lease.lease_until)
        self.assertEqual(db_state(self.db), before)
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        marker.touch()
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            persist_collection(self.db, prepared, now=utc_now())
        self.assertEqual(db_state(self.db), before)
        marker.unlink()
        other, other_lease = self.prepare()
        self.commit(other, other_lease)
        before = db_state(self.db)
        with self.assertRaisesRegex(WorkbenchError, "STALE_PUBLICATION_REVISION"):
            persist_collection(self.db, prepared, now=utc_now())
        self.assertEqual(db_state(self.db), before)

    def test_invalid_scope_url_time_or_clock_payload_never_reaches_download(self):
        for key, value in (("url", "https://untrusted.invalid/xml"), ("scope", "provider:other"), ("received_at", "2025-01-01T00:00:00Z")):
            request, job, lease = self.pending({**payload(), key: value})
            before = db_state(self.db)
            with patch("worker.market.collection.download_ecb_xml") as download:
                with self.assertRaises(WorkbenchError):
                    prepare_collection(self.db, request, job, lease)
                download.assert_not_called()
            self.assertEqual(db_state(self.db), before)

    def test_cross_portfolio_job_and_network_inside_transaction_are_refused(self):
        request, job, lease = self.pending()
        with patch("worker.market.collection.download_ecb_xml") as download:
            with self.assertRaisesRegex(WorkbenchError, "JOB_SCOPE"):
                prepare_collection(self.db, {**request, "portfolio_id": "different"}, job, lease)
            self.db.execute("BEGIN")
            try:
                with self.assertRaisesRegex(WorkbenchError, "NETWORK_INSIDE_TRANSACTION"):
                    prepare_collection(self.db, request, job, lease)
            finally:
                self.db.rollback()
            download.assert_not_called()

    def test_capture_is_append_only_and_read_verifier_rejects_corrupt_blob(self):
        prepared, lease = self.prepare()
        result = self.commit(prepared, lease)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE market_provider_captures SET raw_body=?", (b"changed",))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM market_provider_captures")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT OR REPLACE INTO market_provider_captures SELECT * FROM market_provider_captures")
        # Simulate damaged storage only in this disposable fixture.
        self.db.execute("DROP TRIGGER provider_capture_no_update")
        self.db.execute("UPDATE market_provider_captures SET raw_body=?", (b"x" + prepared.raw[1:],))
        before = db_state(self.db)
        with self.assertRaisesRegex(WorkbenchError, "PROVIDER_EVIDENCE_INVALID"):
            verify_provider_capture(self.db, result["batch_id"])
        self.assertEqual(db_state(self.db), before)

    def test_read_verifier_reparses_raw_when_normalized_and_document_hashes_are_rewritten(self):
        prepared, lease = self.prepare()
        result = self.commit(prepared, lease)
        normalized, document, receipt = deepcopy(prepared.normalized), deepcopy(prepared.document), deepcopy(prepared.receipt)
        normalized["records"][0]["value_cny_per_unit"] = "999"
        currency = normalized["records"][0]["currency"]
        for observation in document["pages"][0]["observations"]:
            if observation["series_key"] == "FX:" + currency:
                observation["value"] = "999"
        receipt.update(normalized_hash=content_hash(normalized), document_hash=content_hash(document))
        self.db.execute("DROP TRIGGER provider_capture_no_update")
        self.db.execute("""UPDATE market_provider_captures SET normalized_json=?,document_json=?,receipt_json=?,receipt_hash=?""",
                        (canonical_json(normalized), canonical_json(document), canonical_json(receipt), content_hash(receipt)))
        before = db_state(self.db)
        with patch("worker.market.collection.parse_ecb_xml", wraps=parse_ecb_xml) as parse:
            with self.assertRaisesRegex(WorkbenchError, "PROVIDER_EVIDENCE_INVALID"):
                verify_provider_capture(self.db, result["batch_id"])
            parse.assert_called_once_with(prepared.raw, feed="daily", retrieved_at=receipt["received_at"], currencies=["USD", "HKD"])
        self.assertFalse(source_verified(self.db, result["batch_id"], document["batch"]))
        self.assertEqual(db_state(self.db), before)

    def test_empty_incomplete_or_invalid_feed_does_not_replace_existing_publication(self):
        prepared, lease = self.prepare()
        self.commit(prepared, lease)
        invalid_feeds = [b"", xml([]), xml([("2025-06-06", [("CNY", "8"), ("USD", "2")])]),
                         xml([("2025-06-06", [("CNY", "8"), ("USD", "NaN"), ("HKD", "10")])])]
        for raw in invalid_feeds:
            request, job, lease = self.pending(payload(revision=1))
            before = db_state(self.db)
            with patch("worker.market.collection.download_ecb_xml", fake_download(raw)):
                with self.assertRaisesRegex(WorkbenchError, "^PROVIDER_COLLECTION_FAILED$"):
                    prepare_collection(self.db, request, job, lease)
            self.assertEqual(db_state(self.db), before)
        self.assertEqual(self.db.execute("SELECT revision FROM market_publications").fetchone()[0], 1)

    def test_manual_ingest_cannot_claim_provider_mode_source_or_scope(self):
        prepared, _ = self.prepare()
        cases = [prepared.document]
        for key in ("source_id", "scope"):
            fake = document(batch_id="manual:" + key)
            fake["batch"][key] = "provider:ecb:reserved"
            if key == "source_id":
                fake["pages"][0]["observations"][0]["source_id"] = fake["batch"][key]
            cases.append(fake)
        for fake in cases:
            before = db_state(self.db)
            with self.subTest(batch=fake["batch"]["id"]), self.assertRaises((WorkbenchError, sqlite3.IntegrityError)):
                ingest_document(self.db, fake, publish=True, now=utc_now())
            self.assertEqual(db_state(self.db), before)

    def test_encrypted_backup_restore_preserves_exact_provider_blob_and_proof(self):
        prepared, lease = self.prepare()
        result = self.commit(prepared, lease)
        capture_before = dict(self.db.execute("SELECT * FROM market_provider_captures").fetchone())
        script = """
            const { backupWorkbench } = await import(process.argv[1]);
            const { restoreWorkbench } = await import(process.argv[2]);
            const [dbPath,dataDir,outputDir,targetDir] = process.argv.slice(3);
            const passphrase = 'synthetic-capture-backup-passphrase-not-a-real-secret';
            const saved = await backupWorkbench({dbPath,dataDir,outputDir,passphrase,appRef:'synthetic-provider-capture'});
            const restored = await restoreWorkbench({archivePath:saved.path,targetDir,passphrase});
            process.stdout.write(JSON.stringify(restored));
        """
        target = self.path.parent / "restored"
        process = subprocess.run(["node", "--input-type=module", "-e", script,
                                  (ROOT / "scripts/backup-workbench.mjs").as_uri(), (ROOT / "scripts/restore-workbench.mjs").as_uri(),
                                  str(self.path), str(self.path.parent), str(self.path.parent / "archives"), str(target)],
                                 capture_output=True, text=True, cwd=ROOT, timeout=30, check=False)
        self.assertEqual(process.returncode, 0, process.stderr)
        restored = json.loads(process.stdout)
        self.assertTrue(restored["pending_review"])
        with sqlite3.connect(restored["database_path"]) as db:
            db.row_factory = sqlite3.Row
            self.assertEqual(dict(db.execute("SELECT * FROM market_provider_captures").fetchone()), capture_before)
            self.assertEqual(verify_provider_capture(db, result["batch_id"]), verify_provider_capture(self.db, result["batch_id"]))
        self.assertTrue((target / "RESTORE_PENDING_REVIEW").exists())
        self.assertEqual((Path(restored["database_path"]).stat().st_mode & 0o777), 0o600)


if __name__ == "__main__":
    unittest.main()
