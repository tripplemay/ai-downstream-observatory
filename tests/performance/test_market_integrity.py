from datetime import timedelta
import json
import unittest
from uuid import uuid4

from tests.market.support import NOW, database, document, ledger_event, rules, seed_account
from worker.market import ingest_document, value_portfolio
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, stamp
from worker.performance import prepare_performance, persist_performance


class MarketPerformanceIntegrityTests(unittest.TestCase):
    start = NOW
    end = NOW + timedelta(days=1)

    def fixture(self, kind):
        db, _ = database(self)
        seed_account(db)
        if kind == "price":
            ledger_event(db, "initial", [("inventory_cost", "100"), ("opening_equity", "-100")],
                         quantity="1", effective=self.start - timedelta(days=1))
        elif kind == "fx":
            ledger_event(db, "initial", [("cash_settled", "1"), ("opening_equity", "-1")],
                         currency="USD", effective=self.start - timedelta(days=1))
        else:
            ledger_event(db, "initial", [("cash_settled", "100"), ("opening_equity", "-100")],
                         effective=self.start - timedelta(days=1))
        return db

    def quote(self, kind, identity, value, revision=0, observed=None, known=None, corrected=False):
        observed = observed or self.start - timedelta(hours=1)
        payload = document(identity, price=value, revision=revision, observed=observed)
        row = payload["pages"][0]["observations"][0]
        if kind == "fx":
            payload["batch"].update(batch_type="fx", scope="fx:CNY")
            row.pop("listing_id")
            row.update(series_key="FX:USD", metric="fx_cny_per_unit", unit="CNY_per_unit_currency", price_basis="not_applicable")
        if corrected:
            row.update(revision_id="correction:" + identity, published_at=stamp(known or self.end))
        return payload

    def config(self, kind, session=None):
        result = rules()
        result["expected_sessions"]["CN"] = (session or self.start).date().isoformat()
        result["max_fx_age_seconds"] = 10 * 86400
        if kind == "fx":
            result["fx_scope"] = "fx:CNY"
        return result

    def value(self, db, kind, cutoff, mode, known=None, session=None):
        result = value_portfolio(db, "p", stamp(cutoff), self.config(kind, session), mode=mode, now=known or cutoff)
        self.assertEqual(result["quality"], "complete", result["issues_json"])
        return result

    def performance(self, db, first, last, now=None):
        return prepare_performance(db, "p", {"valuation_ids": [first["id"], last["id"]],
                                            "evaluation_timezone": "Asia/Shanghai"}, now=now or self.end)

    def clone_snapshot(self, db, snapshot, changes=None, item_changes=None, omit_items=False):
        row = dict(snapshot)
        row.update(id=str(uuid4()), cutoff_at=stamp(self.end + timedelta(seconds=1)))
        row.update(changes or {})
        db.execute("INSERT INTO valuation_runs (" + ",".join(row) + ") VALUES (" + ",".join("?" for _ in row) + ")", tuple(row.values()))
        if not omit_items:
            for original in db.execute("SELECT * FROM valuation_items WHERE run_id=?", (snapshot["id"],)):
                item = dict(original)
                item.update(id=str(uuid4()), run_id=row["id"])
                item.update(item_changes or {})
                db.execute("INSERT INTO valuation_items (" + ",".join(item) + ") VALUES (" + ",".join("?" for _ in item) + ")", tuple(item.values()))
        return row

    def test_missing_or_mismatched_evidence_cannot_publish_complete_performance(self):
        for kind in ("price", "fx"):
            for corrupt in ("missing_ref", "malformed_ref", "currency", "publication", "unapproved", "no_items", "rules"):
                with self.subTest(kind=kind, corrupt=corrupt):
                    db = self.fixture(kind)
                    ingest_document(db, self.quote(kind, "p1", "100"), publish=True, now=self.start)
                    first = self.value(db, kind, self.start, "restated")
                    last = self.value(db, kind, self.end, "restated")
                    changes, item_changes = {}, {}
                    manifest = json.loads(last["market_manifest"])
                    if corrupt == "missing_ref":
                        item_changes["evidence_json"] = "{}"
                    elif corrupt == "malformed_ref":
                        item_changes["evidence_json"] = canonical_json({kind + "_observation_id": []})
                    elif corrupt == "currency":
                        item_changes["currency"] = "HKD"
                    elif corrupt == "publication":
                        manifest["publications"]["fx:CNY" if kind == "fx" else "prices:CN"] = {}
                    elif corrupt == "unapproved":
                        manifest["rules"]["approved"] = False
                        manifest["rules_hash"] = content_hash(manifest["rules"])
                    elif corrupt == "rules":
                        manifest["rules"]["price_scope_by_market"] = []
                        manifest["rules_hash"] = content_hash(manifest["rules"])
                    changes["market_manifest"] = canonical_json(manifest)
                    invalid = self.clone_snapshot(db, last, changes, item_changes, omit_items=corrupt == "no_items")
                    result = self.performance(db, first, invalid, now=self.end + timedelta(days=1))
                    self.assertEqual(result.quality, "blocked")
                    self.assertIsNone(result.result["net_profit_cny"])
                    self.assertTrue(any(code.startswith("VALUATION_") for code in result.result["issues"]))

    def test_old_valuation_method_and_missing_mode_are_rejected(self):
        for corrupt in ("method", "mode"):
            with self.subTest(corrupt=corrupt):
                db = self.fixture("cash")
                first = self.value(db, "cash", self.start, "restated")
                last = self.value(db, "cash", self.end, "restated")
                changes = {"method_version": "decimal-nav-cny-v1:restated"} if corrupt == "method" else {"market_manifest": "{}"}
                a = self.clone_snapshot(db, first, {**changes, "cutoff_at": stamp(self.start + timedelta(seconds=1))})
                b = self.clone_snapshot(db, last, changes)
                with self.assertRaisesRegex(WorkbenchError, "UNSUPPORTED_VALUATION_METHOD|INCOMPATIBLE_PERFORMANCE_INPUTS"):
                    self.performance(db, a, b, now=self.end + timedelta(days=1))

    def test_original_reference_point_in_time_is_checked_even_in_terminal_snapshot(self):
        for kind in ("price", "fx"):
            for defect in ("future_observation", "late_knowledge"):
                with self.subTest(kind=kind, defect=defect):
                    db = self.fixture(kind)
                    ingest_document(db, self.quote(kind, "p1", "100"), publish=True, now=self.start)
                    first = self.value(db, kind, self.start, "as_known")
                    observed = self.end - timedelta(hours=1) if defect == "future_observation" else self.start
                    ingest_document(db, self.quote(kind, "p2", "100", revision=1, observed=observed), publish=True, now=self.end)
                    last = self.value(db, kind, self.end, "as_known", session=observed)
                    invalid = self.clone_snapshot(db, last, {"cutoff_at": stamp(self.end - timedelta(hours=2))})
                    result = self.performance(db, first, invalid)
                    self.assertEqual(result.quality, "blocked")
                    self.assertTrue(any(code.startswith("VALUATION_MARKET_EVIDENCE_INVALID:") for code in result.result["issues"]))

    def test_unknown_and_zero_cost_new_account_openings_are_not_profit(self):
        for known in (0, 1):
            with self.subTest(cost_known=known):
                db = self.fixture("cash")
                db.execute("INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES('new-account','p','new','fixture','CNY',?)", (stamp(self.start),))
                at = stamp(self.start + timedelta(hours=1))
                fact = {"type": "opening_position", "account_id": "new-account", "listing_id": "CN:TEST", "currency": "CNY", "quantity": "10"}
                if known:
                    fact["cost_amount"] = "0"
                payload = canonical_json({"fact": fact})
                db.execute("""INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,recorded_at,
                    source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id)
                    VALUES('zero-cost','p','new-account','opening_position',?,?,'fixture','zero-cost',?,?,2,'fixture')""",
                           (at, at, content_hash(payload), payload))
                db.execute("INSERT INTO position_movements(id,event_id,account_id,listing_id,quantity,cost_amount,cost_known,currency) VALUES('movement','zero-cost','new-account','CN:TEST','10','0',?,'CNY')", (known,))
                db.execute("UPDATE ledger_heads SET revision=2 WHERE portfolio_id='p'")
                ingest_document(db, self.quote("price", "p1", "10"), publish=True, now=self.start)
                first = self.value(db, "price", self.start, "restated", known=self.end)
                last = self.value(db, "price", self.end, "restated")
                self.assertEqual((first["nav_cny"], last["nav_cny"]), ("100", "200"))
                result = self.performance(db, first, last)
                self.assertEqual(result.quality, "blocked")
                self.assertIsNone(result.result["net_profit_cny"])
                self.assertIn("OPENING_SNAPSHOT_INSIDE_PERFORMANCE_PERIOD", result.result["issues"])
                reversal = canonical_json({"reversal_of": "zero-cost"})
                db.execute("""INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,recorded_at,
                    source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id,reversal_of)
                    VALUES('reverse','p','new-account','reversal',?,?,'fixture','reverse',?,?,3,'fixture','zero-cost')""",
                           (at, stamp(self.end), content_hash(reversal), reversal))
                db.execute("INSERT INTO position_movements(id,event_id,account_id,listing_id,quantity,cost_amount,cost_known,currency) VALUES('reverse-movement','reverse','new-account','CN:TEST','-10','0',?,'CNY')", (known,))
                db.execute("UPDATE ledger_heads SET revision=3 WHERE portfolio_id='p'")
                reversed_first = self.value(db, "price", self.start, "restated", known=self.end)
                reversed_last = self.value(db, "price", self.end, "restated")
                reversed_result = self.performance(db, reversed_first, reversed_last)
                self.assertEqual(reversed_result.quality, "complete")
                self.assertEqual(reversed_result.result["return"]["value"], "0")

    def test_restated_price_and_fx_vintages_cannot_mix_and_recompute_restores_zero(self):
        for kind in ("price", "fx"):
            with self.subTest(kind=kind):
                db = self.fixture(kind)
                ingest_document(db, self.quote(kind, "v1", "100"), publish=True, now=self.start)
                old = self.value(db, kind, self.start, "restated")
                ingest_document(db, self.quote(kind, "v2", "200", revision=1, corrected=True), publish=True, now=self.end)
                end = self.value(db, kind, self.end, "restated")
                result = self.performance(db, old, end)
                self.assertEqual(result.quality, "blocked")
                self.assertTrue(any(code.startswith("STALE_RESTATED_MARKET_INPUT:") for code in result.result["issues"]))
                fresh = self.value(db, kind, self.start, "restated", known=self.end)
                corrected = self.performance(db, fresh, end)
                self.assertEqual(corrected.quality, "complete")
                self.assertEqual(corrected.result["return"]["value"], "0")
                self.assertEqual(corrected.result["net_profit_cny"], "0")

    def test_as_known_prior_session_price_and_fx_revision_is_not_weekend_profit(self):
        for kind in ("price", "fx"):
            with self.subTest(kind=kind):
                db = self.fixture(kind)
                ingest_document(db, self.quote(kind, "v1", "100"), publish=True, now=self.start)
                first = self.value(db, kind, self.start, "as_known")
                ingest_document(db, self.quote(kind, "v2", "200", revision=1, corrected=True), publish=True, now=self.end)
                last = self.value(db, kind, self.end, "as_known")
                result = self.performance(db, first, last)
                self.assertEqual(result.quality, "blocked")
                self.assertIsNone(result.result["return"])
                self.assertTrue(any(code.startswith("MARKET_KNOWLEDGE_CHANGED_RESTATE_REQUIRED:") for code in result.result["issues"]))

    def test_as_known_new_session_price_and_fx_movement_remains_valid_return(self):
        end = self.start + timedelta(days=3)
        for kind in ("price", "fx"):
            with self.subTest(kind=kind):
                db = self.fixture(kind)
                ingest_document(db, self.quote(kind, "v1", "100"), publish=True, now=self.start)
                first = self.value(db, kind, self.start, "as_known")
                ingest_document(db, self.quote(kind, "v2", "110", revision=1, observed=end - timedelta(hours=1)), publish=True, now=end)
                last = self.value(db, kind, end, "as_known", session=end)
                result = self.performance(db, first, last, now=end)
                self.assertEqual(result.quality, "complete", result.result["issues"])
                self.assertEqual(result.result["return"]["value"], "0.1")

    def test_as_known_late_report_before_left_cutoff_requires_restatement(self):
        for kind in ("price", "fx"):
            with self.subTest(kind=kind):
                db = self.fixture(kind)
                ingest_document(db, self.quote(kind, "v1", "100"), publish=True, now=self.start)
                first = self.value(db, kind, self.start, "as_known")
                late = self.quote(kind, "late", "120", revision=1, observed=self.start - timedelta(minutes=30))
                ingest_document(db, late, publish=True, now=self.end)
                last = self.value(db, kind, self.end, "as_known")
                self.assertEqual(self.performance(db, first, last).quality, "blocked")

    def test_as_known_new_session_does_not_hide_prior_session_revision_in_same_batch(self):
        for kind in ("price", "fx"):
            with self.subTest(kind=kind):
                db = self.fixture(kind)
                ingest_document(db, self.quote(kind, "v1", "100"), publish=True, now=self.start)
                first = self.value(db, kind, self.start, "as_known")
                mixed = self.quote(kind, "v2", "220", revision=1, observed=self.end - timedelta(hours=1))
                correction = self.quote(kind, "v2", "200", corrected=True)["pages"][0]["observations"][0]
                correction["id"] += ":correction"
                mixed["batch"]["expected_rows"] = 2
                mixed["pages"][0]["observations"].append(correction)
                ingest_document(db, mixed, publish=True, now=self.end)
                last = self.value(db, kind, self.end, "as_known", session=self.end)
                self.assertEqual(self.performance(db, first, last).quality, "blocked")

    def test_older_correction_does_not_replace_a_later_already_known_left_quote(self):
        db = self.fixture("price")
        ingest_document(db, self.quote("price", "v1", "100"), publish=True, now=self.start)
        first = self.value(db, "price", self.start, "as_known")
        mixed = self.quote("price", "v2", "110", revision=1, observed=self.end - timedelta(hours=1))
        older = self.quote("price", "v2", "999", observed=self.start - timedelta(hours=2), corrected=True)["pages"][0]["observations"][0]
        older["id"] += ":older"
        mixed["batch"]["expected_rows"] = 2
        mixed["pages"][0]["observations"].append(older)
        ingest_document(db, mixed, publish=True, now=self.end)
        last = self.value(db, "price", self.end, "as_known", session=self.end)
        result = self.performance(db, first, last)
        self.assertEqual(result.quality, "complete")
        self.assertEqual(result.result["return"]["value"], "0.1")

    def test_intermediate_published_revision_is_not_forgotten_by_latest_session_batch(self):
        for kind in ("price", "fx"):
            with self.subTest(kind=kind):
                db = self.fixture(kind)
                ingest_document(db, self.quote(kind, "v1", "100"), publish=True, now=self.start)
                first = self.value(db, kind, self.start, "as_known")
                middle = self.start + timedelta(hours=1)
                correction = self.quote(kind, "v2", "200", revision=1, corrected=True, known=middle)
                ingest_document(db, correction, publish=True, now=middle)
                latest_only = self.quote(kind, "v3", "220", revision=2, observed=self.end - timedelta(hours=1))
                ingest_document(db, latest_only, publish=True, now=self.end)
                last = self.value(db, kind, self.end, "as_known", session=self.end)
                result = self.performance(db, first, last)
                self.assertEqual(result.quality, "blocked")
                self.assertTrue(any(code.startswith("MARKET_KNOWLEDGE_CHANGED_RESTATE_REQUIRED:") for code in result.result["issues"]))

    def test_same_value_metadata_revision_does_not_invent_a_market_return_or_block(self):
        db = self.fixture("price")
        ingest_document(db, self.quote("price", "v1", "100"), publish=True, now=self.start)
        first = self.value(db, "price", self.start, "as_known")
        ingest_document(db, self.quote("price", "v2", "100", revision=1, corrected=True), publish=True, now=self.end)
        last = self.value(db, "price", self.end, "as_known")
        result = self.performance(db, first, last)
        self.assertEqual(result.quality, "complete")
        self.assertEqual(result.result["return"]["value"], "0")

    def test_market_publication_change_between_prepare_and_persist_rejects(self):
        for kind in ("price", "fx"):
            with self.subTest(kind=kind):
                db = self.fixture(kind)
                ingest_document(db, self.quote(kind, "v1", "100"), publish=True, now=self.start)
                first = self.value(db, kind, self.start, "restated", known=self.end)
                last = self.value(db, kind, self.end, "restated")
                prepared = self.performance(db, first, last)
                self.assertEqual(json.loads(prepared.manifest)["schema_version"], "performance-input-v5")
                ingest_document(db, self.quote(kind, "v2", "200", revision=1, corrected=True), publish=True, now=self.end)
                with self.assertRaisesRegex(WorkbenchError, "STALE_PERFORMANCE_MARKET_INPUT"):
                    persist_performance(db, prepared, now=self.end)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM performance_runs").fetchone()[0], 0)

    def test_date_only_source_timezone_fx_revision_is_restatement(self):
        db = self.fixture("fx")
        first_quote = self.quote("fx", "v1", "7.000000000000000001")
        first_quote["pages"][0]["observations"][0].update(observed_at="2025-01-02", time_precision="date", source_timezone="America/New_York")
        ingest_document(db, first_quote, publish=True, now=self.start)
        first = self.value(db, "fx", self.start, "as_known")
        revised = self.quote("fx", "v2", "7.000000000000000002", revision=1, corrected=True)
        revised["pages"][0]["observations"][0].update(observed_at="2025-01-02", time_precision="date", source_timezone="America/New_York")
        ingest_document(db, revised, publish=True, now=self.end)
        last = self.value(db, "fx", self.end, "as_known")
        result = self.performance(db, first, last)
        self.assertEqual(result.quality, "blocked")
        self.assertIn("MARKET_KNOWLEDGE_CHANGED_RESTATE_REQUIRED:FX:USD", result.result["issues"])

    def test_persist_v5_retains_market_head_provenance_and_deduplicates(self):
        db = self.fixture("price")
        ingest_document(db, self.quote("price", "v1", "100"), publish=True, now=self.start)
        first = self.value(db, "price", self.start, "restated", known=self.end)
        last = self.value(db, "price", self.end, "restated")
        prepared = self.performance(db, first, last)
        saved = persist_performance(db, prepared, now=self.end)
        self.assertEqual(saved["method_version"], "snapshot-performance-cny-v5")
        self.assertEqual(json.loads(saved["market_manifest"])["market_heads"]["prices:CN"]["revision"], 1)
        self.assertEqual(persist_performance(db, prepared, now=self.end)["id"], saved["id"])
