"""Synthetic SDK transport through real reviewed references and SQLite jobs."""

from datetime import datetime, timedelta
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import unittest
from unittest.mock import patch

from worker.market import publish_batch
from worker.market.collection import verify_provider_capture
from worker.market.price_collection import prepare_price_collection, persist_price_collection
from worker.market.providers import longport
from worker.market.references import price_calendar_session, select_references, price_collection_scope
from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, content_hash, stamp
from worker.orchestration.jobs import JobCommit, claim_job, complete_job, enqueue_job
from worker.orchestration.runtime import run_pending_once
from tests.market.test_collection import add_request, db_state, fixture, utc_now


def mapping(listing="CN:TEST", market="CN", currency="CNY", exchange="TEST", symbol="000001.SH"):
    return {"provider": "longport", "listing_id": listing, "provider_symbol": symbol,
            "market": market, "exchange": exchange, "currency": currency,
            "valid_from": "2025-01-01", "valid_to": None}


def calendar(market="CN", exchange="TEST", zone="Asia/Shanghai", close_hour="07"):
    return {"market": market, "exchange": exchange, "timezone": zone,
            "range_start": "2025-06-05", "range_end": "2025-06-08",
            "days": [{"date": "2025-06-05", "kind": "full", "close_at": f"2025-06-05T{close_hour}:00:00.000000Z"},
                     {"date": "2025-06-06", "kind": "half", "close_at": f"2025-06-06T{close_hour}:00:00.000000Z"},
                     {"date": "2025-06-07", "kind": "closed", "close_at": None},
                     {"date": "2025-06-08", "kind": "closed", "close_at": None}]}


def publish_reference(test, path, kind, facts, *, version=0, at=None, portfolio="p"):
    # The producer is the actual human-only TS service; no handwritten audit shortcut.
    script = r"""
      import fs from 'node:fs'; import Database from 'better-sqlite3';
      import {storeMarketReferenceSource,publishMarketReference} from './src/server/market-references/service.ts';
      const x=JSON.parse(fs.readFileSync(0,'utf8')), db=new Database(x.path); db.pragma('foreign_keys=ON');
      const actor={id:'synthetic-human',kind:'human'}, key='synthetic:'+crypto.randomUUID();
      const source=storeMarketReferenceSource(db,actor,{portfolio_id:x.portfolio,idempotency_key:key,
        reference:'Synthetic reviewed fixture; not an official exchange calendar',content_text:JSON.stringify({kind:x.kind,facts:x.facts})},{now:x.at});
      const result=publishMarketReference(db,actor,{portfolio_id:x.portfolio,idempotency_key:key+':review',expected_version:x.version,
        source_id:source.id,source_hash:source.content_hash,review_reason:'Synthetic test review only',acknowledgement:true,
        document:{kind:x.kind,facts:x.facts}},{now:x.at}); db.close(); console.log(JSON.stringify(result));
    """
    result = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "-e", script], cwd=ROOT / "web", capture_output=True,
                            text=True, timeout=30, input=json.dumps({"path": str(path), "portfolio": portfolio,
                            "kind": kind, "facts": facts, "version": version, "at": at or stamp(utc_now() - timedelta(seconds=2))}))
    test.assertEqual(result.returncode, 0, result.stderr)
    return json.loads(result.stdout)


def price_payload(mapping_ids, calendar_ids, revision=0, publish=True):
    return {"schema_version": "market-price-collect-v1", "provider": "longport", "mapping_version_ids": mapping_ids,
            "calendar_version_ids": calendar_ids, "start_date": "2025-06-05", "end_date": "2025-06-06",
            "expected_publication_revision": revision, "publish": publish}


def fake_collect(*, mapping, start_date, end_date, expected_dates):
    started = stamp()
    rows = [{"open": "9.1", "high": "10.100000000000000001", "low": "9", "close": "10.100000000000000001",
             "turnover": "91", "volume": 9, "timestamp": datetime.fromisoformat(day + "T14:00:00+00:00"),
             "trade_session": 0} for day in reversed(expected_dates)]
    return longport._normalize(rows, request=longport._request(mapping, start_date, end_date, expected_dates),
                               sdk_version=longport.SDK_VERSION, call_started_at=started, call_returned_at=stamp(),
                               datetime_basis="runtime_utc_from_unix_timestamp", collector_runtime="isolated_official_sdk")


class PriceCollectionTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = fixture(self)
        self.db.execute("INSERT INTO catalog_entries VALUES('p','CN:TEST',?)", ("2025-01-01T00:00:00.000000Z",))
        self.mapping = publish_reference(self, self.path, "mapping", mapping())
        self.calendar = publish_reference(self, self.path, "calendar", calendar())
        self.payload = price_payload([self.mapping["id"]], [self.calendar["id"]])
        self.counter = 0

    def pending(self, payload=None):
        self.counter += 1
        request = add_request(self.db, "synthetic-price:" + str(self.counter), payload or self.payload, kind="market_collect_prices")
        job = enqueue_job(self.db, "market_collect_prices", "p", request["created_at"][:10], request["id"] + ":" + request["payload_hash"],
                          command_request_id=request["id"], now=utc_now())
        lease = claim_job(self.db, "synthetic-price-worker", 300, "market_collect_prices", now=utc_now())
        self.assertEqual(lease.job_id, job["id"])
        return request, dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (job["id"],)).fetchone()), lease

    def prepare(self, payload=None, collector=fake_collect):
        request, job, lease = self.pending(payload)
        with patch("worker.market.providers.longport.collect_longport_candles", collector):
            prepared = prepare_price_collection(self.db, request, job, lease)
        return prepared, lease

    def commit(self, prepared, lease):
        now = utc_now()
        complete_job(self.db, lease, {}, effect=lambda db: JobCommit(persist_price_collection(db, prepared, now=now)), now=now)
        return json.loads(self.db.execute("SELECT result_json FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()[0])

    def test_real_reference_service_sdk_projection_atomic_publication(self):
        before = list(self.db.execute("SELECT * FROM ledger_events"))
        prepared, lease = self.prepare()
        self.assertEqual(self.db.execute("SELECT count(*) FROM market_sdk_captures").fetchone()[0], 0)
        result = self.commit(prepared, lease)
        proof = verify_provider_capture(self.db, result["batch_id"])
        self.assertEqual(proof["raw_sha256"], sha256(prepared.raw).hexdigest())
        self.assertEqual(proof["capture_kind"], "sdk_projection")
        self.assertEqual(proof["rate_kind"], "market_price_not_executable")
        self.assertFalse(result["live_advice_eligible"])
        self.assertEqual(list(self.db.execute("SELECT * FROM ledger_events")), before)
        rows = self.db.execute("SELECT * FROM market_observations ORDER BY observed_at").fetchall()
        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertEqual(row["time_precision"], "date")
            self.assertIsNone(row["published_at"])
            self.assertEqual(row["value"], "10.100000000000000001")
            self.assertEqual(row["price_basis"], "unadjusted")
            self.assertEqual(row["ingested_at"], prepared.receipt["received_at"])
        self.assertEqual(price_calendar_session(self.db, result["batch_id"], "p", "CN:TEST", "2025-06-07T06:00:00Z", stamp()), "2025-06-06")

    def test_missing_second_listing_aborts_all_without_partial_capture(self):
        self.db.execute("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('CN:SECOND','instrument','CN','TEST','000002','CNY','2025-01-01T00:00:00Z')")
        self.db.execute("INSERT INTO catalog_entries VALUES('p','CN:SECOND','2025-01-01T00:00:00Z')")
        other = publish_reference(self, self.path, "mapping", mapping("CN:SECOND", symbol="000002.SH"))
        value = {**self.payload, "mapping_version_ids": [self.mapping["id"], other["id"]]}
        request, job, lease = self.pending(value)
        before = db_state(self.db)
        calls = []
        def collector(**kwargs):
            self.assertFalse(self.db.in_transaction)
            calls.append(kwargs["mapping"]["listing_id"])
            if len(calls) == 2:
                raise RuntimeError("synthetic opaque SDK failure; do not propagate")
            return fake_collect(**kwargs)
        with patch("worker.market.providers.longport.collect_longport_candles", collector):
            with self.assertRaisesRegex(WorkbenchError, "^PRICE_PROVIDER_COLLECTION_FAILED$"):
                prepare_price_collection(self.db, request, job, lease)
        self.assertEqual(len(calls), 2)
        self.assertEqual(before, db_state(self.db))

    def test_prepared_mutation_cannot_rehash_into_another_batch(self):
        prepared, lease = self.prepare()
        prepared.document["pages"][0]["observations"][0]["value"] = "999"
        prepared.receipt["document_hash"] = content_hash(prepared.document)
        before = db_state(self.db)
        with self.assertRaisesRegex(WorkbenchError, "PROVIDER_PREPARED_MUTATED"):
            self.commit(prepared, lease)
        self.assertEqual(before, db_state(self.db))

    def test_new_reference_before_commit_rejects_without_changing_head(self):
        prepared, lease = self.prepare()
        publish_reference(self, self.path, "calendar", calendar(), version=1, at=stamp())
        before = db_state(self.db)
        with self.assertRaises(WorkbenchError):
            self.commit(prepared, lease)
        self.assertEqual(before, db_state(self.db))

    def test_as_known_old_capture_survives_reference_update_restated_blocks(self):
        prepared, lease = self.prepare()
        result = self.commit(prepared, lease)
        known = stamp()
        publish_reference(self, self.path, "calendar", calendar(), version=1, at=stamp())
        self.assertEqual(verify_provider_capture(self.db, result["batch_id"], known_at=known)["id"], result["capture_id"])
        with self.assertRaises(WorkbenchError):
            verify_provider_capture(self.db, result["batch_id"])

    def test_window_and_version_not_part_of_publication_scope(self):
        proof, _ = select_references(self.db, "p", self.payload, stamp())
        changed = {**self.payload, "start_date": "2025-06-06", "end_date": "2025-06-06"}
        other, _ = select_references(self.db, "p", changed, stamp())
        self.assertEqual(price_collection_scope("p", proof), price_collection_scope("p", other))

    def test_false_publish_is_not_later_promoted_without_fresh_command(self):
        prepared, lease = self.prepare({**self.payload, "publish": False})
        result = self.commit(prepared, lease)
        self.assertEqual(result["batch_status"], "validated")
        with self.assertRaises(WorkbenchError):
            publish_batch(self.db, result["batch_id"])
        with self.assertRaises(WorkbenchError):
            verify_provider_capture(self.db, result["batch_id"])
        fresh, lease = self.prepare()
        self.assertEqual(self.commit(fresh, lease)["batch_status"], "published")

    def test_expired_lease_restore_and_read_only_prevent_commit(self):
        prepared, lease = self.prepare()
        before = db_state(self.db)
        with self.assertRaises(WorkbenchError):
            persist_price_collection(self.db, prepared, now=utc_now() + timedelta(seconds=301))
        self.assertEqual(before, db_state(self.db))
        with patch.dict(os.environ, {"WORKBENCH_MODE": "read_only"}):
            with self.assertRaisesRegex(WorkbenchError, "WORKBENCH_READ_ONLY"):
                self.commit(prepared, lease)
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        marker.touch()
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            self.commit(prepared, lease)
        self.assertEqual(before, db_state(self.db))

    def test_unsupported_payload_has_no_sdk_call_or_write(self):
        for key, value in (("url", "https://synthetic.invalid"), ("token", "synthetic-not-secret"),
                           ("now", "2025-01-01T00:00:00Z"), ("raw", "synthetic"), ("source_mode", "provider_observed")):
            with self.subTest(key=key):
                request = add_request(self.db, "invalid:" + key, {**self.payload, key: value}, kind="market_collect_prices")
                before = db_state(self.db)
                with patch("worker.market.providers.longport.collect_longport_candles") as sdk:
                    with self.assertRaisesRegex(WorkbenchError, "^INVALID_MARKET_PRICE_COLLECT$"):
                        prepare_price_collection(self.db, request, {}, None)
                sdk.assert_not_called()
                self.assertEqual(before, db_state(self.db))

    def test_bad_projection_missing_date_and_untrusted_parser_origin_fail_closed(self):
        request, job, lease = self.pending()
        for change in (lambda result: result["projection"]["candlesticks"].pop(),
                       lambda result: result["projection"]["source"].update(collector_runtime="injected_test_client"),
                       lambda result: result["projection"]["source"].update(sdk_version="0.0.0")):
            def collector(**kwargs):
                result = fake_collect(**kwargs)
                change(result)
                return result
            before = db_state(self.db)
            with patch("worker.market.providers.longport.collect_longport_candles", collector):
                with self.assertRaisesRegex(WorkbenchError, "^PRICE_PROVIDER_COLLECTION_FAILED$"):
                    prepare_price_collection(self.db, request, job, lease)
            self.assertEqual(before, db_state(self.db))

    def test_capture_blob_is_immutable_and_sqlite_backup_preserves_exact_bytes(self):
        prepared, lease = self.prepare()
        result = self.commit(prepared, lease)
        for sql in ("UPDATE market_sdk_captures SET raw_body=X'00'", "DELETE FROM market_sdk_captures"):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(sql)
        copied = sqlite3.connect(":memory:")
        self.addCleanup(copied.close)
        self.db.backup(copied)
        raw, receipt = copied.execute("SELECT raw_body,receipt_json FROM market_sdk_captures WHERE batch_id=?", (result["batch_id"],)).fetchone()
        self.assertEqual(raw, prepared.raw)
        self.assertEqual(sha256(raw).hexdigest(), json.loads(receipt)["raw_sha256"])

    def test_real_role_dispatch_four_listings_two_exchanges_is_one_capture(self):
        ids = [self.mapping["id"]]
        for number in range(2, 5):
            listing, exchange = "CN:SYNTH" + str(number), "SECOND" if number == 4 else "TEST"
            self.db.execute("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES(?,'instrument','CN',?,?,'CNY','2025-01-01T00:00:00Z')",
                            (listing, exchange, str(number)))
            self.db.execute("INSERT INTO catalog_entries VALUES('p',?,'2025-01-01T00:00:00Z')", (listing,))
            ids.append(publish_reference(self, self.path, "mapping", mapping(listing, exchange=exchange, symbol=f"00000{number}.SH"))["id"])
        second = publish_reference(self, self.path, "calendar", calendar(exchange="SECOND"))
        value = price_payload(list(reversed(ids)), [second["id"], self.calendar["id"]])
        request = add_request(self.db, "four-symbols", value, kind="market_collect_prices")
        calls = []
        def collector(**kwargs):
            self.assertFalse(self.db.in_transaction)
            calls.append(kwargs["mapping"]["listing_id"])
            return fake_collect(**kwargs)
        with patch("worker.market.providers.longport.collect_longport_candles", collector):
            self.assertIsNone(run_pending_once(self.db, "synthetic-core"))
            result = run_pending_once(self.db, "synthetic-longport", role="longport")
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(calls, sorted(calls))
        self.assertEqual(len(calls), 4)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_sdk_captures").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_observations").fetchone()[0], 8)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM job_attempts").fetchone()[0], 1)
        self.assertIsNone(run_pending_once(self.db, "synthetic-longport", role="longport"))
        self.assertEqual(self.db.execute("SELECT command_request_id FROM job_runs").fetchone()[0], request["id"])

    def test_hk_and_us_currency_local_dates_publish_separately(self):
        for market, currency, zone, symbol, hour in (("HK", "HKD", "Asia/Hong_Kong", "00009.HK", "08"),
                                                    ("US", "USD", "America/New_York", "SYNTH.US", "20")):
            with self.subTest(market=market):
                listing = market + ":SYNTH"
                self.db.execute("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES(?,'instrument',?,'SYNTH','SYNTH',?,'2025-01-01T00:00:00Z')",
                                (listing, market, currency))
                self.db.execute("INSERT INTO catalog_entries VALUES('p',?,'2025-01-01T00:00:00Z')", (listing,))
                m = publish_reference(self, self.path, "mapping", mapping(listing, market, currency, "SYNTH", symbol))
                c = publish_reference(self, self.path, "calendar", calendar(market, "SYNTH", zone, hour))
                prepared, lease = self.prepare(price_payload([m["id"]], [c["id"]]))
                result = self.commit(prepared, lease)
                verify_provider_capture(self.db, result["batch_id"])
                self.assertEqual({row["unit"] for row in self.db.execute("SELECT unit FROM market_observations WHERE batch_id=?", (result["batch_id"],))}, {currency})

    def test_lease_expiry_after_first_call_prevents_next_symbol(self):
        self.db.execute("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('CN:TWO','instrument','CN','TEST','000002','CNY','2025-01-01T00:00:00Z')")
        self.db.execute("INSERT INTO catalog_entries VALUES('p','CN:TWO','2025-01-01T00:00:00Z')")
        m = publish_reference(self, self.path, "mapping", mapping("CN:TWO", symbol="000002.SH"))
        request, job, lease = self.pending({**self.payload, "mapping_version_ids": [self.mapping["id"], m["id"]]})
        calls = []
        def collector(**kwargs):
            calls.append(kwargs["mapping"]["listing_id"])
            result = fake_collect(**kwargs)
            self.db.execute("UPDATE job_runs SET lease_until=? WHERE id=?", (stamp(utc_now() - timedelta(seconds=1)), job["id"]))
            return result
        with patch("worker.market.providers.longport.collect_longport_candles", collector):
            with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
                prepare_price_collection(self.db, request, job, lease)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_sdk_captures").fetchone()[0], 0)

    def test_restore_marker_after_call_blocks_batch_without_any_rows(self):
        request, job, lease = self.pending()
        def collector(**kwargs):
            result = fake_collect(**kwargs)
            (self.path.parent / "RESTORE_PENDING_REVIEW").touch()
            return result
        with patch("worker.market.providers.longport.collect_longport_candles", collector):
            with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
                prepare_price_collection(self.db, request, job, lease)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_sdk_captures").fetchone()[0], 0)

    def test_recollection_preserves_old_snapshot_and_stale_cas_does_not_call_sdk(self):
        prepared, lease = self.prepare()
        old = self.commit(prepared, lease)
        old_row = dict(self.db.execute("SELECT * FROM market_sdk_captures").fetchone())
        new, lease = self.prepare({**self.payload, "expected_publication_revision": 1})
        current = self.commit(new, lease)
        self.assertNotEqual(old["batch_id"], current["batch_id"])
        self.assertEqual(self.db.execute("SELECT revision FROM market_publications").fetchone()[0], 2)
        self.assertEqual(dict(self.db.execute("SELECT * FROM market_sdk_captures WHERE id=?", (old["capture_id"],)).fetchone()), old_row)
        verify_provider_capture(self.db, old["batch_id"])
        request, job, lease = self.pending()
        before = db_state(self.db)
        with patch("worker.market.providers.longport.collect_longport_candles") as sdk:
            with self.assertRaisesRegex(WorkbenchError, "STALE_PUBLICATION_REVISION"):
                prepare_price_collection(self.db, request, job, lease)
        sdk.assert_not_called()
        self.assertEqual(before, db_state(self.db))

    def test_consumer_replays_corrupt_projection_and_job_status_not_just_hashes(self):
        prepared, lease = self.prepare()
        result = self.commit(prepared, lease)
        self.db.execute("DROP TRIGGER sdk_capture_no_update")
        raw = json.loads(prepared.raw)
        raw["projections"][0]["candlesticks"][0]["close"] = "9.2"
        encoded = canonical_json(raw).encode()
        receipt = {**prepared.receipt, "raw_sha256": sha256(encoded).hexdigest(), "raw_bytes": len(encoded)}
        self.db.execute("UPDATE market_sdk_captures SET raw_body=?,receipt_json=?,receipt_hash=?", (encoded, canonical_json(receipt), content_hash(receipt)))
        with self.assertRaises(WorkbenchError):
            verify_provider_capture(self.db, result["batch_id"])

    def test_cutoff_calendar_coverage_and_original_knowledge_are_required(self):
        prepared, lease = self.prepare()
        result = self.commit(prepared, lease)
        for cutoff in ("2025-06-04T12:00:00Z", "2025-06-05T06:59:59Z", "2025-06-09T12:00:00Z"):
            with self.subTest(cutoff=cutoff), self.assertRaises(WorkbenchError):
                price_calendar_session(self.db, result["batch_id"], "p", "CN:TEST", cutoff, stamp())
        with self.assertRaises(WorkbenchError):
            verify_provider_capture(self.db, result["batch_id"], known_at="2025-06-07T00:00:00Z")
        for pf, listing in (("foreign-portfolio", "CN:TEST"), ("p", "CN:UNKNOWN")):
            with self.assertRaises(WorkbenchError):
                price_calendar_session(self.db, result["batch_id"], pf, listing, "2025-06-06T08:00:00Z", stamp())

    def test_encrypted_backup_restore_replays_sdk_and_private_reference_evidence(self):
        prepared, lease = self.prepare()
        result = self.commit(prepared, lease)
        original = {table: [dict(row) for row in self.db.execute("SELECT * FROM " + table + " ORDER BY rowid")]
                    for table in ("market_sdk_captures", "market_reference_sources", "market_reference_versions", "market_reference_heads")}
        script = """
            const { backupWorkbench } = await import(process.argv[1]);
            const { restoreWorkbench } = await import(process.argv[2]);
            const [dbPath,dataDir,outputDir,targetDir] = process.argv.slice(3);
            const passphrase = 'synthetic-sdk-backup-passphrase-not-a-real-secret';
            const saved = await backupWorkbench({dbPath,dataDir,outputDir,passphrase,appRef:'synthetic-sdk-capture'});
            process.stdout.write(JSON.stringify(await restoreWorkbench({archivePath:saved.path,targetDir,passphrase})));
        """
        target = self.path.parent / "restored"
        process = subprocess.run(["node", "--input-type=module", "-e", script,
                                  (ROOT / "scripts/backup-workbench.mjs").as_uri(), (ROOT / "scripts/restore-workbench.mjs").as_uri(),
                                  str(self.path), str(self.path.parent), str(self.path.parent / "archives"), str(target)],
                                 capture_output=True, text=True, cwd=ROOT, timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        restored = json.loads(process.stdout)
        self.assertTrue(restored["pending_review"])
        with sqlite3.connect(restored["database_path"]) as db:
            db.row_factory = sqlite3.Row
            for table, rows in original.items():
                self.assertEqual([dict(row) for row in db.execute("SELECT * FROM " + table + " ORDER BY rowid")], rows)
            self.assertEqual(verify_provider_capture(db, result["batch_id"]), verify_provider_capture(self.db, result["batch_id"]))
        self.assertTrue((target / "RESTORE_PENDING_REVIEW").exists())
        self.assertEqual(Path(restored["database_path"]).stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
