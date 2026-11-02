"""Complete recorded-history software proofs on isolated fictional databases."""

from contextlib import contextmanager, closing
from copy import deepcopy
from datetime import timedelta
import json
import unittest

from tests.investor import test_runtime as runtime, test_evidence_monitor_runtime as monitor
from tests.investor.test_legacy_protocol_matrix import protocol_case, offline_protocol_fixture, NEXT
from tests.investor.test_retained_action_evidence import retained_v5_after_correction
from worker.investor import data_evidence, monitor_admission
from worker.investor.retained_monitor_history import read_retained_monitor_history
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, open_database


OWNER = "synthetic-investor"


@contextmanager
def mutation(db, tables):
    db.execute("SAVEPOINT fictional_history_mutation")
    try:
        for table in tables:
            for row in db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?", (table,)).fetchall():
                db.execute('DROP TRIGGER "' + row[0] + '"')
        yield
    finally:
        db.execute("ROLLBACK TO fictional_history_mutation"); db.execute("RELEASE fictional_history_mutation")


def plain_history_case(db, path, *, protocol="v1", market="CN", fixed=False, events=True, funded=False):
    from tests.investor.test_data_pipeline import DataPipelineCliTests
    from tests.investor.test_planned_funding_runtime import PlannedFundingRuntimeTests
    case = PlannedFundingRuntimeTests() if funded else monitor.EvidenceMonitorRuntimeTests()
    case.db, case.path, case.version = db, path, 0
    with offline_protocol_fixture():
        if funded:
            definition = case.seed(fixed=fixed); case.funding(); case.calculate()
            source = db.execute("SELECT * FROM investor_monitor_evidence_inputs ORDER BY rowid DESC LIMIT 1").fetchone()
        else:
            definition, windows, settings, references = DataPipelineCliTests.monitor_fixture(case, fixed_policy=fixed,
                confirmed_latest=protocol == "v2", market=market)
            if events:
                for index, ref in enumerate(references):
                    facts = json.loads(ref["actions"]["document_json"])["facts"]
                    hour = {"CN": "01", "HK": "01", "US": "14"}[market]
                    facts["events"] = [{"id": "fictional-local-boundary-" + str(index), "listing_id": facts["listing_id"], "type": "dividend",
                        "at": "2026-01-01T" + hour + ":30:00Z", "published_at": "2025-12-30T00:00:00Z", "pay_at": "2026-01-02T08:00:00Z",
                        "gross_per_unit": "1.1", "tax_per_unit": "0.1", "source_evidence": "synthetic://qualified-local-session"}]
                    replacement = data_evidence.review_source(db, "w", OWNER, ref["actions"]["source_id"], "approved", facts,
                        "Fictional local session boundary, never actual ETF evidence", ref["actions"]["valid_until"], now=monitor.NOW)
                    for window in windows:
                        window["action_review_ids"] = [replacement["id"] if identifier == ref["actions"]["id"] else identifier for identifier in window["action_review_ids"]]
            source = monitor_admission.admit_monitor_data(db, "w", OWNER, definition["model_id"], windows, settings,
                now=monitor.NOW, audited_action_knowledge=protocol == "v4")
            case.calculate()
        before = db.total_changes
        history = read_retained_monitor_history(db, "w", OWNER, definition["model_id"], now=monitor.NOW)
        assert db.total_changes == before; case.assert_no_finance()
        return {"history": history, "model_id": definition["model_id"], "checked_at": monitor.NOW, "input_id": source["id"]}


class RetainedMonitorHistoryTests(unittest.TestCase):
    setUp = runtime.InvestorRuntimeTests.setUp
    assert_no_finance = runtime.InvestorRuntimeTests.assert_no_finance

    def read(self, value, *, now=None, db=None):
        return read_retained_monitor_history(db or self.db, "w", OWNER, value["model_id"], now=now or value["checked_at"])

    def test_three_markets_and_audited_knowledge_use_qualified_local_dates_not_a_new_york_default(self):
        for market, protocol in (("CN", "v1"), ("HK", "v2"), ("US", "v4"), ("CN", "v4"), ("HK", "v4")):
            with self.subTest(market=market, protocol=protocol):
                case = runtime.InvestorRuntimeTests(); case.setUp()
                try:
                    value = plain_history_case(case.db, case.path, market=market, protocol=protocol, fixed=protocol == "v4")
                    history = value["history"]; self.assertEqual(history["proof"]["input_bindings"][0]["input_protocol"], "investor-monitor-data-input-" + protocol)
                    self.assertEqual({row["market"] for row in history["definition"]["targets"]}, {market})
                    self.assertTrue(history["original_actions"]); self.assertEqual(history["origin"], history["head"])
                    self.assertFalse(history["proof"]["monitoring_resumed"])
                finally: case.doCleanups()

    def test_genuine_original_v2_and_v3_to_v5_replay_every_original_byte_knowledge_cost_and_checkpoint(self):
        for protocol in ("v2", "v3"):
            with self.subTest(protocol=protocol):
                case = runtime.InvestorRuntimeTests(); case.setUp()
                try:
                    with offline_protocol_fixture():
                        original = protocol_case(case.db, case.path); original.prepare(protocol); original.migrate(); head = original.advance()
                        before = list(case.db.iterdump()); count = case.db.total_changes
                        history = read_retained_monitor_history(case.db, "w", OWNER, original.model_id, now=NEXT)
                        self.assertEqual(history["origin"], original.state); self.assertEqual(history["head"], head["state"])
                        self.assertEqual(history["origin_projection"], original.projection); self.assertEqual(history["head_projection"], head["projection"])
                        self.assertEqual([row["input_protocol"] for row in history["proof"]["input_bindings"]], ["investor-monitor-data-input-" + protocol, "investor-monitor-data-input-v5"])
                        self.assertEqual(count, case.db.total_changes); self.assertEqual(before, list(case.db.iterdump())); case.assert_no_finance()
                finally: case.doCleanups()

    def test_hypothetical_correction_preserves_original_full_history_without_approving_corrected_source(self):
        value = retained_v5_after_correction(self.db, self.path); value["checked_at"] = value["input"]["checked_at"]
        before = list(self.db.iterdump()); result = self.read(value)
        self.assertEqual(result["head"], value["input"]["head"]); self.assertEqual(result["head_projection"], value["input"]["head_projection"])
        self.assertEqual({row["id"]: content_hash(row) for row in result["original_actions"]}, result["head"]["processed_actions"])
        for key in ("corrected_source_evidence_verified", "economic_correction_approved", "current_source_eligibility_restored", "checkpoint_created", "monitoring_resumed", "trading_permission"):
            self.assertIs(result["proof"][key], False)
        for forbidden in ("net_per_unit", "gross_per_unit", "tax_assumption", "quantities", "cash_by_currency"):
            self.assertNotIn(forbidden, canonical_json(result["proof"]))
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_actual_funding_bound_checkpoint_replays_without_depositing_planned_principal(self):
        value = plain_history_case(self.db, self.path, funded=True, fixed=True)
        state = value["history"]["head"]
        self.assertEqual(state["schema_version"], "investor-evidence-model-checkpoint-v3")
        self.assertEqual(state["initial_notional_cny"], "10000")
        self.assertEqual(value["history"], self.read(value)); self.assert_no_finance()

    def test_real_readonly_connection_and_normal_projection_expiry_do_not_rewrite_original_history(self):
        value = plain_history_case(self.db, self.path, protocol="v4", fixed=True)
        before = list(self.db.iterdump())
        with closing(open_database(self.path, read_only=True)) as db:
            count = db.total_changes; result = self.read(value, db=db, now=value["history"]["head_projection"]["valid_until"])
            self.assertEqual(count, db.total_changes); self.assertEqual(result["head"], value["history"]["head"])
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_same_shape_resealed_false_input_or_state_and_missing_raw_never_become_historical_evidence(self):
        value = plain_history_case(self.db, self.path, protocol="v4", fixed=True)
        for kind in ("input", "state", "price"):
            with self.subTest(kind=kind), mutation(self.db, ("investor_monitor_evidence_inputs", "audit_events", "investor_evidence_checkpoint_payloads", "investor_evidence_model_checkpoints", "investor_price_payloads")):
                if kind == "input":
                    row = self.db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE id=?", (value["input_id"],)).fetchone()
                    doc = json.loads(row["document_json"]); doc["projection_hash"] = "0" * 64; digest = content_hash(doc)
                    self.db.execute("UPDATE investor_monitor_evidence_inputs SET document_json=?,content_hash=? WHERE id=?", (canonical_json(doc), digest, row["id"]))
                    self.db.execute("UPDATE audit_events SET payload_json=? WHERE id=?", (canonical_json({"content_hash": digest}), row["audit_id"]))
                elif kind == "state":
                    row = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1").fetchone()
                    state = deepcopy(value["history"]["head"]); state["cash_by_currency"]["CNY"] = "1"
                    self.db.execute("UPDATE investor_evidence_checkpoint_payloads SET payload=? WHERE checkpoint_id=?", (canonical_json(state).encode(), row["id"]))
                    self.db.execute("UPDATE investor_evidence_model_checkpoints SET content_hash=? WHERE id=?", (content_hash(state), row["id"]))
                else:
                    self.db.execute("UPDATE investor_price_payloads SET projection=zeroblob(length(projection))")
                with self.assertRaises((WorkbenchError, ValueError)): self.read(value)
        self.assertEqual(value["history"], self.read(value)); self.assert_no_finance()

    def test_price_rights_withdrawal_and_payload_purge_stop_even_while_old_state_is_retained(self):
        value = plain_history_case(self.db, self.path)
        document = json.loads(self.db.execute("SELECT document_json FROM investor_monitor_evidence_inputs WHERE id=?", (value["input_id"],)).fetchone()[0])
        capture_id = document["segments"][0]["snapshot"]["capture_refs"][0]["capture_id"]
        row = self.db.execute("SELECT * FROM investor_data_reviews WHERE id=(SELECT rights_review_id FROM investor_price_captures WHERE id=?)", (capture_id,)).fetchone()
        data_evidence.review_source(self.db, "w", OWNER, row["source_id"], "withdrawn", None, "Fictional current withdrawal", row["valid_until"], now=value["checked_at"])
        with self.assertRaises(WorkbenchError): self.read(value)
        for capture in self.db.execute("SELECT id FROM investor_price_captures WHERE rights_review_id=?", (row["id"],)).fetchall():
            data_evidence.purge_price_payload(self.db, "w", OWNER, capture["id"], now=value["checked_at"])
        with self.assertRaises(WorkbenchError): self.read(value)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 1); self.assert_no_finance()

    def test_latest_manual_read_permission_caps_new_proof_without_changing_recorded_deadlines_or_knowledge(self):
        from worker.investor.model_runtime import _clock
        from worker.investor.monitor_data import resolve_monitor_data
        value = plain_history_case(self.db, self.path, protocol="v4", fixed=True)
        document = json.loads(self.db.execute("SELECT document_json FROM investor_monitor_evidence_inputs WHERE id=?", (value["input_id"],)).fetchone()[0])
        from worker.investor.source_inputs import _snapshot_ids
        identifier = _snapshot_ids(self.db, "w", document["segments"][0]["snapshot"], "actions")[0]
        original = self.db.execute("SELECT * FROM investor_data_reviews WHERE id=?", (identifier,)).fetchone()
        facts = json.loads(original["document_json"])["facts"]; facts["events"][0]["gross_per_unit"] = "1.2"
        at = _clock(instant(value["checked_at"]) + timedelta(milliseconds=1)); expiry = _clock(instant(at) + timedelta(seconds=60))
        data_evidence.review_source(self.db, "w", OWNER, original["source_id"], "approved", facts, "Hypothetical local correction with shorter permission", expiry, now=at)
        result = self.read(value, now=at)
        self.assertEqual(result["proof"]["source_valid_until"], expiry); self.assertEqual(result["head"], value["history"]["head"])
        self.assertEqual(result["head_projection"], value["history"]["head_projection"])
        self.assertEqual(resolve_monitor_data(self.db, "w", result["definition"], document, now=at)["unavailable_reason"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        with self.assertRaises(WorkbenchError): self.read(value, now=expiry)
        self.assert_no_finance()

    def test_foreign_owner_is_rejected_before_any_source_or_checkpoint_payload_and_stop_is_cooperative(self):
        value = plain_history_case(self.db, self.path)
        statements = []; self.db.set_trace_callback(statements.append)
        try:
            with self.assertRaises(WorkbenchError): read_retained_monitor_history(self.db, "w", "foreign", value["model_id"], now=value["checked_at"])
        finally: self.db.set_trace_callback(None)
        self.assertFalse(any("payload" in statement.lower() or "investor_data_reviews" in statement for statement in statements))
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            read_retained_monitor_history(self.db, "w", OWNER, value["model_id"], now=value["checked_at"], stop_requested=lambda: True)
        with self.assertRaises(WorkbenchError): self.read(value, now="2025-01-01T00:00:00.000Z")
        with self.assertRaises(WorkbenchError): self.read(value, now=value["history"]["proof"]["source_valid_until"])
        self.assert_no_finance()
