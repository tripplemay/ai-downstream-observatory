"""Read-side scope, audit and calendar checks against real human-service fixtures."""

from datetime import timedelta
from hashlib import sha256
import json
import unittest

from worker.market.references import select_references, strict_object, verify_reference_version
from worker.orchestration.db import WorkbenchError, canonical_json, stamp
from tests.market.test_collection import db_state, fixture, utc_now
from tests.market.test_price_collection import calendar, mapping, price_payload, publish_reference


class MarketReferenceTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = fixture(self)
        self.db.execute("INSERT INTO catalog_entries VALUES('p','CN:TEST','2025-01-01T00:00:00.000000Z')")
        self.mapping = publish_reference(self, self.path, "mapping", mapping())
        self.calendar = publish_reference(self, self.path, "calendar", calendar())
        self.payload = price_payload([self.mapping["id"]], [self.calendar["id"]])

    def test_same_service_row_hashes_and_selection_proof_are_read_only(self):
        before = db_state(self.db)
        proof, chosen = select_references(self.db, "p", self.payload, stamp(), require_current=True)
        self.assertEqual(len(proof["mappings"]), 1)
        self.assertEqual(chosen[0]["expected_dates"], ["2025-06-05", "2025-06-06"])
        self.assertEqual(proof["mappings"][0]["calendar_version_id"], self.calendar["id"])
        self.assertEqual(before, db_state(self.db))

    def test_source_raw_bytes_hash_and_audit_are_independently_required(self):
        self.db.execute("DROP TRIGGER market_reference_source_no_update")
        source = self.db.execute("SELECT * FROM market_reference_sources WHERE id=?", (self.mapping["source_id"],)).fetchone()
        changed = source["content_text"] + " "
        self.db.execute("UPDATE market_reference_sources SET content_text=? WHERE id=?", (changed, source["id"]))
        with self.assertRaises(WorkbenchError):
            verify_reference_version(self.db, self.mapping["id"], "p", stamp())
        self.db.execute("UPDATE market_reference_sources SET content_hash=? WHERE id=?", (sha256(changed.encode()).hexdigest(), source["id"]))
        with self.assertRaises(WorkbenchError):
            verify_reference_version(self.db, self.mapping["id"], "p", stamp())

    def test_review_audit_missing_actor_or_changed_facts_cannot_be_claimed_verified(self):
        row = self.db.execute("SELECT audit_id FROM market_reference_versions WHERE id=?", (self.mapping["id"],)).fetchone()
        triggers = self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_events'").fetchall()
        for trigger in triggers:
            self.db.execute('DROP TRIGGER "' + trigger[0] + '"')
        audit = self.db.execute("SELECT * FROM audit_events WHERE id=?", (row["audit_id"],)).fetchone()
        body = json.loads(audit["payload_json"])
        for changed in ({**body, "actor_kind": "ai"}, {**body, "input": {**body["input"], "acknowledgement": False}}):
            self.db.execute("UPDATE audit_events SET payload_json=? WHERE id=?", (canonical_json(changed), audit["id"]))
            with self.assertRaises(WorkbenchError):
                verify_reference_version(self.db, self.mapping["id"], "p", stamp())

    def test_latest_reference_as_known_and_current_head_are_distinct_checks(self):
        original_known = stamp()
        new = publish_reference(self, self.path, "mapping", mapping(), version=1, at=stamp())
        self.assertEqual(verify_reference_version(self.db, self.mapping["id"], "p", original_known)["version"]["version"], 1)
        with self.assertRaises(WorkbenchError):
            verify_reference_version(self.db, self.mapping["id"], "p", original_known, require_current=True)
        with self.assertRaises(WorkbenchError):
            verify_reference_version(self.db, self.mapping["id"], "p", stamp())
        self.assertEqual(verify_reference_version(self.db, new["id"], "p", stamp(), require_current=True)["version"]["version"], 2)

    def test_cross_portfolio_missing_catalog_or_currency_change_blocks_selection(self):
        with self.assertRaises(WorkbenchError):
            select_references(self.db, "other", self.payload, stamp())
        self.db.execute("DROP TRIGGER catalog_entry_no_delete")
        self.db.execute("DELETE FROM catalog_entries")
        with self.assertRaises(WorkbenchError):
            select_references(self.db, "p", self.payload, stamp())
        self.db.execute("INSERT INTO catalog_entries VALUES('p','CN:TEST','2025-01-01T00:00:00.000000Z')")
        self.db.execute("UPDATE listings SET currency='USD' WHERE id='CN:TEST'")
        with self.assertRaises(WorkbenchError):
            select_references(self.db, "p", self.payload, stamp())

    def test_closed_only_range_gap_more_than_31days_duplicate_refs_and_kind_reversal(self):
        variants = [{**self.payload, "start_date": "2025-06-07", "end_date": "2025-06-08"},
                    {**self.payload, "start_date": "2025-06-04"},
                    {**self.payload, "end_date": "2025-07-06"},
                    {**self.payload, "mapping_version_ids": [self.mapping["id"], self.mapping["id"]]},
                    {**self.payload, "calendar_version_ids": [self.mapping["id"]]},
                    {**self.payload, "mapping_version_ids": [self.calendar["id"]]}]
        for value in variants:
            with self.subTest(payload=value), self.assertRaises(WorkbenchError):
                select_references(self.db, "p", value, stamp())

    def test_mapping_validity_end_is_exclusive(self):
        facts = {**mapping(), "valid_to": "2025-06-06"}
        row = publish_reference(self, self.path, "mapping", facts, version=1, at=stamp())
        with self.assertRaises(WorkbenchError):
            select_references(self.db, "p", {**self.payload, "mapping_version_ids": [row["id"]]}, stamp())

    def test_unused_or_cross_market_calendar_cannot_pad_proof(self):
        extra = publish_reference(self, self.path, "calendar", calendar(exchange="UNUSED"))
        with self.assertRaises(WorkbenchError):
            select_references(self.db, "p", {**self.payload, "calendar_version_ids": [self.calendar["id"], extra["id"]]}, stamp())
        other = publish_reference(self, self.path, "calendar", calendar("US", "US", "America/New_York", "20"))
        with self.assertRaises(WorkbenchError):
            select_references(self.db, "p", {**self.payload, "calendar_version_ids": [self.calendar["id"], other["id"]]}, stamp())

    def test_future_reference_is_not_available_before_review(self):
        future = stamp(utc_now() + timedelta(days=1))
        row = publish_reference(self, self.path, "calendar", calendar(), version=1, at=future)
        with self.assertRaises(WorkbenchError):
            verify_reference_version(self.db, row["id"], "p", stamp())

    def test_strict_original_object_rejects_bom_duplicate_nonfinite_or_arrays(self):
        for source in ('\ufeff{}', '{"x":1,"x":2}', '{"x":NaN}', '[]', ''):
            with self.subTest(source=source), self.assertRaises(WorkbenchError):
                strict_object(source)


if __name__ == "__main__":
    unittest.main()
