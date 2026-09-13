"""Actual TS human review service consumed independently by read-only Python."""

from hashlib import sha256
import json
import os
import subprocess
import unittest
from unittest.mock import patch

from tests.market.test_collection import db_state, fixture
from worker.market.listing_reviews import verify_listing_review
from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, content_hash


SOURCE_AT = "2026-04-02T04:00:00.000000Z"
REVIEW_AT = "2026-04-02T04:00:00.000001Z"
CHECK_AT = "2026-04-02T04:00:00.000002Z"
EXPIRES_AT = "2026-05-02T04:00:00.000000Z"


def reviewed_facts():
    return {"instrument_kind": "ETF", "lifecycle_status": "active", "quantity_step": "100",
            "price_step": "0.000000000000000001", "source_effective_date": "2026-04-02",
            "fund_identifier": "SYNTHETIC:FUND", "share_class_identifier": "SYNTHETIC:SHARE",
            "product_structure": {"leverage": "unleveraged", "direction": "long_only"},
            "risk_classification": {"index_id": "SYNTHETIC:INDEX", "region": "synthetic-region", "sector": "synthetic-sector"}}


_SERVICE = r"""
import fs from 'node:fs'; import Database from 'better-sqlite3';
import {addCatalogEntry} from './src/server/catalog/service.ts';
import {storeMarketReferenceSource} from './src/server/market-references/service.ts';
import {publishListingReview} from './src/server/listing-reviews/service.ts';
import {hash} from './src/server/ledger/service.ts';
const x=JSON.parse(fs.readFileSync(0,'utf8')),db=new Database(x.path);db.pragma('foreign_keys=ON');
try {
  const author={id:'synthetic-source-author',kind:'human'},reviewer={id:'synthetic-reviewer',kind:'human'};
  if(!db.prepare('SELECT 1 FROM catalog_entries WHERE portfolio_id=? AND listing_id=?').get(x.portfolio,x.listing))
    addCatalogEntry(db,reviewer,{portfolio_id:x.portfolio,listing_id:x.listing,
      expected_catalog_revision:db.prepare('SELECT revision FROM catalog_heads WHERE portfolio_id=?').get(x.portfolio)?.revision??0,
      idempotency_key:'synthetic-catalog:'+crypto.randomUUID()},{now:x.source_at});
  const source=storeMarketReferenceSource(db,author,{portfolio_id:x.portfolio,
    reference:'Synthetic listing reference, not real issuer or exchange evidence',content_text:x.content_text,
    idempotency_key:'synthetic-source:'+crypto.randomUUID()},{now:x.source_at});
  const command={portfolio_id:x.portfolio,listing_id:x.listing,expected_review_revision:x.revision,
    expected_identity_hash:hash(db.prepare('SELECT id AS listing_id,instrument_id,market,exchange,ticker,currency FROM listings WHERE id=?').get(x.listing)),
    source_id:source.id,source_hash:source.content_hash,facts:x.facts,review_until:x.review_until,
    reason:x.reason,acknowledgement:true,idempotency_key:'synthetic-review:'+crypto.randomUUID()};
  const receipt=publishListingReview(db,reviewer,command,{now:x.review_at});
  console.log(JSON.stringify({source,receipt,command}));
}finally{db.close();}
"""


class ListingReviewTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = fixture(self)
        self.original_global = {table: [tuple(row) for row in self.db.execute("SELECT * FROM " + table)]
                                for table in ("instruments", "listings", "ledger_events", "postings", "ledger_heads")}

    def service(self, *, facts=None, revision=0, source_at=SOURCE_AT, review_at=REVIEW_AT,
                review_until=EXPIRES_AT, portfolio="p", listing="CN:TEST", reason="Synthetic human identity review only"):
        raw = '{\r\n  "synthetic": true, "description": "No real security or broker", "spelling": "001.00"\r\n}\r\n'
        value = {"path": str(self.path), "portfolio": portfolio, "listing": listing, "revision": revision,
                 "facts": reviewed_facts() if facts is None else facts, "source_at": source_at,
                 "review_at": review_at, "review_until": review_until, "content_text": raw, "reason": reason}
        completed = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "-e", _SERVICE], cwd=ROOT / "web",
                                   input=json.dumps(value), capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return {**json.loads(completed.stdout), "raw": raw}

    def read(self, known_at=CHECK_AT, *, now=CHECK_AT, **kwargs):
        before = db_state(self.db)
        value = verify_listing_review(self.db, "p", "CN:TEST", known_at, now=now, **kwargs)
        self.assertEqual(before, db_state(self.db))
        return value

    def web_read(self, known_at=CHECK_AT, *, now=CHECK_AT):
        script = r"""
import fs from 'node:fs'; import Database from 'better-sqlite3';
import {reviewedListingAt} from './src/server/listing-reviews/service.ts';
const x=JSON.parse(fs.readFileSync(0,'utf8')),db=new Database(x.path,{readonly:true});
try{console.log(JSON.stringify(reviewedListingAt(db,{portfolio_id:'p',listing_id:'CN:TEST',knowledge_at:x.known_at,now:x.now})));}
finally{db.close();}
"""
        result = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "-e", script], cwd=ROOT / "web",
                                input=json.dumps({"path": str(self.path), "known_at": known_at, "now": now}),
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def drop_guards(self, table):
        for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?", (table,)).fetchall():
            self.db.execute('DROP TRIGGER "' + row[0].replace('"', '""') + '"')

    def mutate_audit(self, review, change, *, source=False):
        self.drop_guards("audit_events")
        identity = review["source"]["audit_id"] if source else self.db.execute(
            "SELECT audit_id FROM listing_review_versions WHERE id=?", (review["receipt"]["id"],)).fetchone()[0]
        row = dict(self.db.execute("SELECT * FROM audit_events WHERE id=?", (identity,)).fetchone())
        body = json.loads(row["payload_json"])
        change(row, body)
        row["payload_json"] = canonical_json(body)
        self.db.execute("UPDATE audit_events SET actor_id=:actor_id,portfolio_id=:portfolio_id,ledger_revision=:ledger_revision,payload_json=:payload_json WHERE id=:id", row)

    def test_actual_source_review_service_exact_decimal_raw_bytes_and_no_financial_mutation(self):
        saved = self.service()
        value = self.read()
        self.assertEqual(value["quality"], "complete")
        self.assertEqual(value["issues"], [])
        self.assertEqual(value["document"]["review_basis"], "human_reviewed_not_provider_verified")
        self.assertEqual(value["source"]["content_text"], saved["raw"])
        self.assertEqual(value["source"]["content_hash"], sha256(saved["raw"].encode()).hexdigest())
        self.assertEqual(value["source"]["created_by"], "synthetic-source-author")
        self.assertEqual(value["row"]["created_by"], "synthetic-reviewer")
        self.assertEqual(value["document"]["facts"]["price_step"], "0.000000000000000001")
        self.assertEqual(value["document"]["identity_hash"], content_hash(value["identity"]))
        self.assertEqual(value["row"]["content_hash"], content_hash(value["document"]))
        self.assertEqual(value, self.web_read())
        for table, rows in self.original_global.items():
            self.assertEqual(rows, [tuple(row) for row in self.db.execute("SELECT * FROM " + table)], table)

    def test_missing_review_does_not_fall_back_to_global_legacy_verified_columns(self):
        self.db.execute("INSERT INTO catalog_entries VALUES('p','CN:TEST',?)", (SOURCE_AT,))
        self.db.execute("UPDATE listings SET status='active',verified_at=?,quantity_step='1',price_step='0.01'", (SOURCE_AT,))
        self.db.execute("UPDATE instruments SET asset_class='ETF',index_id='synthetic-index'")
        value = self.read()
        self.assertEqual(value["issues"], ["LISTING_REVIEW_MISSING"])
        self.assertIsNone(value["row"])
        self.assertIsNone(value["proof_hash"])
        self.assertEqual(value, self.web_read())

    def test_latest_unknown_nullable_review_blocks_instead_of_falling_back(self):
        first = self.service()
        facts = {**reviewed_facts(), "instrument_kind": "unknown", "lifecycle_status": "unknown",
                 "quantity_step": None, "price_step": None,
                 "risk_classification": {"index_id": None, "region": None, "sector": None}}
        second = self.service(facts=facts, revision=1, source_at=CHECK_AT, review_at=CHECK_AT)
        value = self.read()
        self.assertEqual(value["row"]["id"], second["receipt"]["id"])
        self.assertNotEqual(value["row"]["id"], first["receipt"]["id"])
        self.assertEqual(value["issues"], ["LISTING_REVIEW_NOT_ACTIVE", "LISTING_REVIEW_NOT_ETF",
                         "LISTING_REVIEW_RISK_CLASSIFICATION_MISSING", "LISTING_REVIEW_TRADING_UNITS_MISSING"])
        self.assertEqual(value, self.web_read())

    def test_active_etf_with_unknown_steps_is_recordable_but_not_eligible(self):
        self.service(facts={**reviewed_facts(), "quantity_step": None, "price_step": None})
        self.assertEqual(self.read()["issues"], ["LISTING_REVIEW_TRADING_UNITS_MISSING"])

    def test_same_microsecond_highest_revision_wins_and_suspension_blocks(self):
        self.service()
        second = self.service(facts={**reviewed_facts(), "lifecycle_status": "suspended"}, revision=1)
        value = self.read()
        self.assertEqual(value["row"]["id"], second["receipt"]["id"])
        self.assertEqual(value["issues"], ["LISTING_REVIEW_NOT_ACTIVE"])

    def test_historical_knowledge_retains_prior_bytes_and_hash_after_new_review(self):
        self.service()
        before = self.read(REVIEW_AT)
        self.service(facts={**reviewed_facts(), "lifecycle_status": "delisted"}, revision=1,
                     source_at=CHECK_AT, review_at=CHECK_AT)
        self.assertEqual(self.read(REVIEW_AT), before)
        self.assertEqual(before, self.web_read(REVIEW_AT))
        self.assertEqual(self.read(REVIEW_AT, require_current=True)["issues"], ["LISTING_REVIEW_SUPERSEDED"])
        self.assertEqual(self.read()["issues"], ["LISTING_REVIEW_NOT_ACTIVE"])

    def test_one_microsecond_future_review_is_not_visible_and_expiry_uses_checked_time(self):
        self.service()
        self.assertEqual(self.read(SOURCE_AT)["issues"], ["LISTING_REVIEW_MISSING"])
        self.assertEqual(self.read(REVIEW_AT, now=EXPIRES_AT)["issues"], ["LISTING_REVIEW_EXPIRED"])
        self.assertEqual(self.read(REVIEW_AT, now=EXPIRES_AT), self.web_read(REVIEW_AT, now=EXPIRES_AT))
        self.assertEqual(self.read(REVIEW_AT, now="2026-05-02T03:59:59.999999Z")["quality"], "complete")

    def test_global_identity_change_blocks_but_keeps_original_readable(self):
        self.service()
        original = self.read()
        self.db.execute("UPDATE listings SET ticker='000002'")
        value = self.read()
        self.assertEqual(value["issues"], ["LISTING_REVIEW_IDENTITY_CHANGED"])
        self.assertEqual(value["document"], original["document"])
        self.assertEqual(value["proof_hash"], original["proof_hash"])
        self.assertNotEqual(value["identity"], original["identity"])
        self.assertEqual(value, self.web_read())

    def test_legacy_status_and_classification_change_does_not_rewrite_private_facts(self):
        self.service()
        before = self.read()
        self.db.execute("UPDATE listings SET status='delisted',quantity_step='9',price_step='5',verified_at=NULL")
        self.db.execute("UPDATE instruments SET asset_class='equity',index_id='unrelated',exposure_json='{}'")
        self.assertEqual(self.read(), before)

    def test_cross_portfolio_membership_never_exposes_private_review(self):
        self.service()
        self.db.execute("INSERT INTO portfolios(id,name,created_at) VALUES('other','Synthetic other',?)", (SOURCE_AT,))
        with self.assertRaisesRegex(WorkbenchError, "^LISTING_REVIEW_OUT_OF_SCOPE$"):
            verify_listing_review(self.db, "other", "CN:TEST", CHECK_AT, now=CHECK_AT)
        self.db.execute("INSERT INTO catalog_entries VALUES('other','CN:TEST',?)", (SOURCE_AT,))
        value = verify_listing_review(self.db, "other", "CN:TEST", CHECK_AT, now=CHECK_AT)
        self.assertEqual(value["issues"], ["LISTING_REVIEW_MISSING"])
        self.assertIsNone(value["source"])

    def test_read_only_restore_mode_can_read_proof_without_writes(self):
        self.service()
        before = self.read()
        with patch.dict(os.environ, {"WORKBENCH_MODE": "read_only"}):
            self.assertEqual(self.read(), before)

    def test_raw_source_byte_tamper_is_not_an_eligibility_warning(self):
        saved = self.service()
        self.drop_guards("market_reference_sources")
        self.db.execute("UPDATE market_reference_sources SET content_text=content_text||' ' WHERE id=?", (saved["source"]["id"],))
        with self.assertRaisesRegex(WorkbenchError, "^LISTING_REVIEW_EVIDENCE_INVALID$"):
            self.read()

    def test_source_store_audit_human_and_input_binding_are_independently_verified(self):
        saved = self.service()
        self.mutate_audit(saved, lambda row, body: body.update(input_hash="a" * 64), source=True)
        with self.assertRaisesRegex(WorkbenchError, "^LISTING_REVIEW_EVIDENCE_INVALID$"):
            self.read()

    def test_review_audit_cannot_claim_system_human_or_add_authority(self):
        saved = self.service()
        self.mutate_audit(saved, lambda row, body: body["input"].update(actor_id="forged"))
        with self.assertRaisesRegex(WorkbenchError, "^LISTING_REVIEW_EVIDENCE_INVALID$"):
            self.read()

    def test_system_source_author_is_rejected_even_with_consistent_source_audit(self):
        saved = self.service()
        self.drop_guards("market_reference_sources")
        self.db.execute("UPDATE market_reference_sources SET created_by='system:synthetic' WHERE id=?", (saved["source"]["id"],))
        self.mutate_audit(saved, lambda row, body: row.update(actor_id="system:synthetic"), source=True)
        with self.assertRaisesRegex(WorkbenchError, "^LISTING_REVIEW_EVIDENCE_INVALID$"):
            self.read()

    def test_review_audit_acknowledgement_cannot_be_numeric_true(self):
        saved = self.service()
        self.mutate_audit(saved, lambda row, body: body["input"].update(acknowledgement=1))
        with self.assertRaisesRegex(WorkbenchError, "^LISTING_REVIEW_EVIDENCE_INVALID$"):
            self.read()

    def test_review_result_hash_and_expected_identity_are_bound_independently(self):
        saved = self.service()
        self.mutate_audit(saved, lambda row, body: body["input"].update(expected_identity_hash="f" * 64))
        with self.assertRaisesRegex(WorkbenchError, "^LISTING_REVIEW_EVIDENCE_INVALID$"):
            self.read()

    def test_audit_result_true_cannot_alias_revision_one_in_python(self):
        saved = self.service()
        self.mutate_audit(saved, lambda row, body: body["result"].update(revision=True))
        with self.assertRaisesRegex(WorkbenchError, "^LISTING_REVIEW_EVIDENCE_INVALID$"):
            self.read()

    def test_asian_effective_date_uses_market_day_not_utc_day(self):
        at = "2026-04-01T17:30:00.000000Z"
        self.service(source_at=at, review_at=at)
        value = self.read(at, now=at)
        self.assertEqual(value["quality"], "complete")
        self.assertEqual(value, self.web_read(at, now=at))

    def test_unknown_optional_identifiers_do_not_fabricate_or_require_values(self):
        facts = {**reviewed_facts(), "source_effective_date": None,
                 "fund_identifier": None, "share_class_identifier": None}
        self.service(facts=facts)
        value = self.read()
        self.assertEqual(value["quality"], "complete")
        self.assertEqual(value["document"]["facts"], facts)
        self.assertEqual(value, self.web_read())

    def test_leveraged_and_inverse_etfs_are_blocked_not_silently_treated_as_supported(self):
        self.service(facts={**reviewed_facts(), "product_structure": {"leverage": "leveraged", "direction": "inverse"}})
        value = self.read()
        self.assertEqual(value["issues"], ["LISTING_REVIEW_PRODUCT_NOT_SUPPORTED"])
        self.assertEqual(value, self.web_read())

    def test_product_structure_unknown_is_not_assumed_long_only_unleveraged(self):
        self.service(facts={**reviewed_facts(), "product_structure": {"leverage": "unknown", "direction": "long_only"}})
        value = self.read()
        self.assertEqual(value["issues"], ["LISTING_REVIEW_PRODUCT_STRUCTURE_UNKNOWN"])
        self.assertEqual(value, self.web_read())

    def test_unsupported_structure_takes_precedence_over_other_unknown_structure(self):
        self.service(facts={**reviewed_facts(), "product_structure": {"leverage": "unknown", "direction": "inverse"}})
        value = self.read()
        self.assertEqual(value["issues"], ["LISTING_REVIEW_PRODUCT_NOT_SUPPORTED"])
        self.assertEqual(value, self.web_read())

    def test_review_facts_json_tamper_and_current_head_tamper_fail_closed(self):
        saved = self.service()
        self.drop_guards("listing_review_versions")
        self.db.execute("UPDATE listing_review_versions SET facts_json='{}' WHERE id=?", (saved["receipt"]["id"],))
        with self.assertRaisesRegex(WorkbenchError, "^LISTING_REVIEW_EVIDENCE_INVALID$"):
            self.read()

    def test_current_head_must_match_latest_even_during_historical_read(self):
        self.service()
        self.drop_guards("listing_review_heads")
        self.db.execute("UPDATE listing_review_heads SET updated_at=?", (CHECK_AT,))
        with self.assertRaisesRegex(WorkbenchError, "^LISTING_REVIEW_EVIDENCE_INVALID$"):
            self.read(REVIEW_AT)

    def test_reformatted_canonical_stored_documents_are_detected_not_rehashed_away(self):
        saved = self.service()
        row = dict(self.db.execute("SELECT * FROM listing_review_versions WHERE id=?", (saved["receipt"]["id"],)).fetchone())
        self.drop_guards("listing_review_versions")
        for column in ("identity_json", "facts_json", "document_json"):
            with self.subTest(column=column):
                self.db.execute("UPDATE listing_review_versions SET " + column + "=? WHERE id=?",
                                (json.dumps(json.loads(row[column]), indent=2), row["id"]))
                with self.assertRaisesRegex(WorkbenchError, "^LISTING_REVIEW_EVIDENCE_INVALID$"):
                    self.read()
                self.db.execute("UPDATE listing_review_versions SET " + column + "=? WHERE id=?", (row[column], row["id"]))
        self.assertEqual(self.read()["quality"], "complete")

    def test_additional_review_audit_is_ambiguous_even_when_bound_audit_is_untouched(self):
        saved = self.service()
        aid = self.db.execute("SELECT audit_id FROM listing_review_versions WHERE id=?", (saved["receipt"]["id"],)).fetchone()[0]
        audit = dict(self.db.execute("SELECT * FROM audit_events WHERE id=?", (aid,)).fetchone())
        audit["id"] = "synthetic-duplicate-review-audit"
        self.db.execute("INSERT INTO audit_events(" + ",".join(audit) + ") VALUES(" + ",".join("?" for _ in audit) + ")", tuple(audit.values()))
        with self.assertRaisesRegex(WorkbenchError, "^LISTING_REVIEW_EVIDENCE_INVALID$"):
            self.read()

    def test_clock_precision_and_future_knowledge_fail_closed(self):
        self.service()
        for at in ("2026-04-02T04:00:00Z", "2026-04-02T04:00:00.000Z", "2026-04-02T04:00:00.000003Z"):
            with self.subTest(at=at), self.assertRaisesRegex(WorkbenchError, "^LISTING_REVIEW_INVALID_CLOCK$"):
                self.read(at)


if __name__ == "__main__":
    unittest.main()
