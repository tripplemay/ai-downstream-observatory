"""Fictional SQLite maintenance, with no provider, AI or financial writes."""

from datetime import timedelta
import json
import unittest
from unittest.mock import patch

from tests.investor import test_data_evidence as data, test_evidence_monitor_runtime as monitor, test_monitor_data as monitor_data, test_runtime as queue
from tests.investor import test_planned_funding_runtime as planned
from worker.investor.data_evidence import purge_price_payload, review_source
from worker.investor.evidence_monitor_runtime import purge_monitor_payload
from worker.investor.monitor_admission import admit_monitor_data
from worker.investor.source_retention import purge_due_source_payloads
from worker.orchestration.db import WorkbenchError, instant, open_database
from worker.orchestration.runtime import run_pending_once


class PriceRetentionTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance
    review = data.InvestorDataTests.review
    prepare = data.InvestorDataTests.prepare
    collect = data.InvestorDataTests.collect

    def test_active_bytes_and_empty_core_are_zero_write(self):
        capture = self.collect(self.prepare())
        before = self.db.total_changes
        self.assertEqual(purge_due_source_payloads(self.db, now=data.NOW), [])
        self.assertIsNone(run_pending_once(self.db, "fictional-core", clock=lambda: data.NOW))
        self.assertEqual(self.db.total_changes, before)
        self.assertIsNotNone(self.db.execute("SELECT projection FROM investor_price_payloads WHERE capture_id=?", (capture["id"],)).fetchone())
        self.assert_no_finance()

    def test_expiry_is_exact_and_core_removes_only_payload_with_one_audit(self):
        capture = self.collect(self.prepare())
        before = instant(capture["retain_until"]) - timedelta(milliseconds=1)
        self.assertEqual(purge_due_source_payloads(self.db, now=before), [])
        self.assertIsNone(run_pending_once(self.db, "fictional-core", clock=lambda: capture["retain_until"]))
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_payloads").fetchone()[0], 0)
        receipt = self.db.execute("SELECT * FROM investor_price_purges").fetchone()
        self.assertEqual(receipt["reason"], "retention_expired")
        self.assertEqual(receipt["created_at"], capture["retain_until"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_purge_price_payload'").fetchone()[0], 1)
        self.assertEqual(dict(self.db.execute("SELECT * FROM investor_price_captures").fetchone()), capture)
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], 0)
        self.assert_no_finance()

    def test_audited_withdrawal_removes_price_before_expiry(self):
        refs = self.prepare(); capture = self.collect(refs)
        review_source(self.db, "w", "synthetic-investor", refs[0]["source_id"], "withdrawn", None, "Fictional withdrawal", data.EXPIRY, now=data.NOW)
        values = purge_due_source_payloads(self.db, now=data.NOW)
        self.assertEqual(len(values), 1); self.assertEqual(values[0]["reason"], "rights_no_longer_active")
        self.assertEqual(values[0]["capture_id"], capture["id"])
        self.assert_no_finance()

    def test_superseding_approved_rights_do_not_extend_old_capture(self):
        refs = self.prepare(); self.collect(refs)
        facts = json.loads(refs[0]["document_json"])["facts"]
        review_source(self.db, "w", "synthetic-investor", refs[0]["source_id"], "approved", facts, "Fictional re-review", data.EXPIRY, now=data.NOW)
        self.assertEqual(purge_due_source_payloads(self.db, now=data.NOW)[0]["reason"], "rights_no_longer_active")

    def test_limit_and_stop_leave_remaining_items_for_next_poll(self):
        first = self.collect(self.prepare(label="one"))
        self.collect(self.prepare(label="two", listing="synthetic-beta"))
        self.assertEqual(len(purge_due_source_payloads(self.db, now=first["retain_until"], limit=1)), 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_payloads").fetchone()[0], 1)
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            purge_due_source_payloads(self.db, now=first["retain_until"], stop_requested=lambda: True)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_payloads").fetchone()[0], 1)
        self.assertEqual(len(purge_due_source_payloads(self.db, now=first["retain_until"])), 1)
        self.assert_no_finance()

    def test_cross_connection_replay_is_zero_write_and_does_not_read_credentials(self):
        capture = self.collect(self.prepare())
        other = open_database(self.path); self.addCleanup(other.close)
        with patch.object(data.longport, "read_private_credentials_file") as secrets, patch.object(data.longport, "_collect_isolated") as network:
            result = purge_due_source_payloads(self.db, now=capture["retain_until"])
            before = other.total_changes
            self.assertEqual(purge_due_source_payloads(other, now=capture["retain_until"]), [])
            self.assertEqual(purge_price_payload(other, "w", "synthetic-investor", capture["id"], now=capture["retain_until"]), result[0])
            self.assertEqual(other.total_changes, before)
            secrets.assert_not_called(); network.assert_not_called()

    def test_scope_historical_clock_and_precision_do_not_create_purges(self):
        capture = self.collect(self.prepare())
        for workspace, actor, at in (("w", "wrong", capture["retain_until"]), ("missing", "synthetic-investor", capture["retain_until"]),
                                     ("w", "synthetic-investor", "2026-01-01T12:00:03.000Z")):
            with self.assertRaisesRegex(WorkbenchError, "OUT_OF_SCOPE"):
                purge_price_payload(self.db, workspace, actor, capture["id"], now=at)
        for limit in (0, 1001, True, 1.5):
            with self.assertRaisesRegex(WorkbenchError, "PURGE_LIMIT"):
                purge_due_source_payloads(self.db, now=data.NOW, limit=limit)
        with self.assertRaisesRegex(WorkbenchError, "CLOCK_PRECISION"):
            purge_due_source_payloads(self.db, now="2026-01-02T12:00:03.123456Z")
        self.assertEqual(purge_due_source_payloads(self.db, now=instant("2026-01-02T12:00:03.123456Z")), [])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_purges").fetchone()[0], 0)

    def test_restore_lock_and_readonly_apply_even_to_empty_maintenance(self):
        with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}):
            with self.assertRaisesRegex(WorkbenchError, "READ_ONLY"):
                purge_due_source_payloads(self.db, now=data.NOW)
        lock = self.path.parent / "RESTORE_PENDING_REVIEW"
        lock.write_text("Fictional restore lock")
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            purge_due_source_payloads(self.db, now=data.NOW)

    def test_late_delete_failure_rolls_back_audit_and_purge(self):
        capture = self.collect(self.prepare())
        self.db.execute("CREATE TRIGGER fictional_purge_failure BEFORE DELETE ON investor_price_payloads BEGIN SELECT RAISE(ABORT,'fictional late failure'); END")
        with self.assertRaisesRegex(Exception, "fictional late failure"):
            purge_due_source_payloads(self.db, now=capture["retain_until"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_purges").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_purge_price_payload'").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_payloads").fetchone()[0], 1)

    def test_future_withdrawal_is_not_a_current_deletion_authority(self):
        refs = self.prepare(); capture = self.collect(refs)
        later = "2026-01-03T12:00:03.000Z"
        review_source(self.db, "w", "synthetic-investor", refs[0]["source_id"], "withdrawn", None, "Fictional future withdrawal", data.EXPIRY, now=later)
        with self.assertRaisesRegex(WorkbenchError, "INVALID_CLOCK"):
            purge_due_source_payloads(self.db, now=data.NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_payloads").fetchone()[0], 1)
        self.assertEqual(len(purge_due_source_payloads(self.db, now=later)), 1)

    def test_stop_after_one_committed_item_preserves_that_receipt(self):
        capture = self.collect(self.prepare(label="one"))
        self.collect(self.prepare(label="two", listing="synthetic-beta"))
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            purge_due_source_payloads(self.db, now=capture["retain_until"], stop_requested=unittest.mock.Mock(side_effect=[False, False, True]))
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_purges").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_payloads").fetchone()[0], 1)
        self.assertEqual(len(purge_due_source_payloads(self.db, now=capture["retain_until"])), 1)


class MonitorRetentionTests(unittest.TestCase):
    setUp = monitor.EvidenceMonitorRuntimeTests.setUp
    save = monitor.EvidenceMonitorRuntimeTests.save
    monitor_fixture = monitor.EvidenceMonitorRuntimeTests.monitor_fixture
    seed = monitor.EvidenceMonitorRuntimeTests.seed
    calculate = monitor.EvidenceMonitorRuntimeTests.calculate
    assert_no_finance = monitor.EvidenceMonitorRuntimeTests.assert_no_finance

    def protected_state(self):
        tables = ("investor_workspaces", "investor_models", "investor_model_controls", "investor_reference_plans",
                  "investor_observations", "investor_evidence_model_checkpoints", "investor_evidence_monitor_runs", "outbox", "job_runs")
        return {table: [tuple(row) for row in self.db.execute("SELECT * FROM " + table + " ORDER BY rowid")] for table in tables}

    def test_active_monitor_is_not_due_and_metadata_is_unchanged(self):
        self.seed(); run, _ = self.calculate()
        before, changes = self.protected_state(), self.db.total_changes
        self.assertEqual(purge_due_source_payloads(self.db, now=monitor.NOW), [])
        for kind, identity in (("run", run["id"]), ("checkpoint", run["checkpoint_id"])):
            with self.assertRaisesRegex(WorkbenchError, "PURGE_NOT_DUE"):
                purge_monitor_payload(self.db, "w", "synthetic-investor", kind, identity, now=monitor.NOW)
        self.assertEqual(self.protected_state(), before); self.assertEqual(self.db.total_changes, changes)
        self.assert_no_finance()

    def test_expiry_cleans_all_payloads_with_shared_budget_and_preserves_metadata(self):
        self.seed(); run, _ = self.calculate()
        before = self.protected_state()
        due_prices = self.db.execute("SELECT count(*) FROM investor_price_captures WHERE retain_until<=?", (run["valid_until"],)).fetchone()[0]
        current_prices = self.db.execute("SELECT count(*) FROM investor_price_captures WHERE retain_until>?", (run["valid_until"],)).fetchone()[0]
        self.assertGreater(due_prices, 0); self.assertGreater(current_prices, 0)
        first = purge_due_source_payloads(self.db, now=run["valid_until"], limit=1)
        self.assertEqual(len(first), 1)
        rest = purge_due_source_payloads(self.db, now=run["valid_until"])
        self.assertEqual(len(first) + len(rest), due_prices + 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_payloads").fetchone()[0], current_prices)
        self.assertEqual(self.protected_state(), before)
        self.assertEqual(purge_due_source_payloads(self.db, now=run["valid_until"]), [])
        self.assert_no_finance()

    def test_monitor_rights_withdrawal_cascades_without_financial_or_observation_writes(self):
        _, _, refs = self.seed(); self.calculate()
        rights = refs[0]["rights"]
        review_source(self.db, "w", "synthetic-investor", rights["source_id"], "withdrawn", None, "Fictional withdrawal", rights["valid_until"], now=monitor.NOW)
        before = self.protected_state()
        values = purge_due_source_payloads(self.db, now=monitor.NOW)
        self.assertGreaterEqual(len(values), 3)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_checkpoint_payloads").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_run_payloads").fetchone()[0], 0)
        self.assertEqual({row[0] for row in self.db.execute("SELECT reason FROM investor_monitor_payload_purges")}, {"source_unavailable"})
        self.assertEqual(self.protected_state(), before); self.assert_no_finance()

    def test_original_research_withdrawal_cleans_monitor_even_when_current_quote_sources_are_valid(self):
        self.seed(); self.calculate()
        rights = self.db.execute("SELECT d.* FROM investor_reference_evidence e JOIN investor_evidence_inputs i ON i.id=e.evidence_input_id JOIN json_each(i.document_json,'$.snapshot.review_refs') ref JOIN investor_data_reviews d ON d.id=json_extract(ref.value,'$.review_id') JOIN investor_data_sources s ON s.id=d.source_id WHERE s.kind='rights'").fetchone()
        review_source(self.db, "w", "synthetic-investor", rights["source_id"], "withdrawn", None, "Fictional original-source withdrawal", rights["valid_until"], now=monitor.NOW)
        purge_due_source_payloads(self.db, now=monitor.NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_checkpoint_payloads").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_run_payloads").fetchone()[0], 0)
        self.assert_no_finance()

    def test_ancestor_source_withdrawal_removes_descendants_but_never_extends_retention(self):
        definition, _, refs = self.seed()
        later = "2026-01-03T12:15:03.000Z"
        with patch("worker.investor.evidence_monitor_runtime.ENGINE_VERSION", "investor-evidence-model-watcher-v1"):
            first, _ = self.calculate()
            fixture = monitor_data.InvestorMonitorDataTests()
            fixture.db = self.db
            reviewed = monitor_data.InvestorMonitorDataTests.reviewed
            with patch.object(monitor_data.InvestorMonitorDataTests, "reviewed", lambda self_, kind, facts, label: reviewed(self_, kind, facts, label + "-independent-second")):
                _, windows, settings, new_refs = fixture.fixture(("CN", "CN"), identities=[target["listing_id"] for target in definition["targets"]])
            source = admit_monitor_data(self.db, "w", "synthetic-investor", definition["model_id"], windows, settings, now=later)
            second, _ = self.calculate(later)
        self.assertNotEqual(first["checkpoint_id"], second["checkpoint_id"])
        self.assertNotEqual(refs[0]["rights"]["source_id"], new_refs[0]["rights"]["source_id"])
        rights = refs[0]["rights"]
        review_source(self.db, "w", "synthetic-investor", rights["source_id"], "withdrawn", None, "Fictional ancestor withdrawal", rights["valid_until"], now=later)
        with patch.object(data.longport, "_parse_child_projection", side_effect=AssertionError("Maintenance must not replay prices")):
            values = purge_due_source_payloads(self.db, now=later, limit=100)
        checkpoints = {value["entity_id"] for value in values if value.get("kind") == "checkpoint"}
        self.assertEqual(checkpoints, {first["checkpoint_id"], second["checkpoint_id"]})
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_run_payloads").fetchone()[0], 0)
        self.assertIsNotNone(self.db.execute("SELECT 1 FROM investor_price_payloads WHERE capture_id=?", (new_refs[0]["capture"]["id"],)).fetchone())
        self.assertEqual(self.db.execute("SELECT input_id FROM investor_evidence_model_checkpoints WHERE id=?", (second["checkpoint_id"],)).fetchone()[0], source["id"])

    def test_withdrawn_action_review_is_also_a_due_source_without_price_deletion(self):
        _, _, refs = self.seed(); self.calculate()
        action = refs[0]["actions"]
        review_source(self.db, "w", "synthetic-investor", action["source_id"], "withdrawn", None, "Fictional action withdrawal", action["valid_until"], now=monitor.NOW)
        prices = self.db.execute("SELECT count(*) FROM investor_price_payloads").fetchone()[0]
        values = purge_due_source_payloads(self.db, now=monitor.NOW)
        self.assertEqual({value["kind"] for value in values}, {"checkpoint", "run"})
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_payloads").fetchone()[0], prices)
        self.assert_no_finance()

    def test_cross_connection_monitor_replay_and_historical_purge_clock(self):
        self.seed(); run, _ = self.calculate()
        other = open_database(self.path); self.addCleanup(other.close)
        result = purge_monitor_payload(self.db, "w", "synthetic-investor", "run", run["id"], now=run["valid_until"])
        before = other.total_changes
        self.assertEqual(purge_monitor_payload(other, "w", "synthetic-investor", "run", run["id"], now=run["valid_until"]), result)
        self.assertEqual(other.total_changes, before)
        with self.assertRaisesRegex(WorkbenchError, "INVALID_CLOCK"):
            purge_monitor_payload(other, "w", "synthetic-investor", "run", run["id"], now=monitor.NOW)

    def test_late_monitor_failure_rolls_back_its_own_audit_but_keeps_prior_item_commits(self):
        self.seed(); run, _ = self.calculate()
        self.db.execute("CREATE TRIGGER fictional_monitor_purge_failure BEFORE DELETE ON investor_evidence_run_payloads BEGIN SELECT RAISE(ABORT,'fictional monitor failure'); END")
        with self.assertRaisesRegex(Exception, "fictional monitor failure"):
            purge_due_source_payloads(self.db, now=run["valid_until"])
        self.assertIsNotNone(self.db.execute("SELECT 1 FROM investor_evidence_run_payloads WHERE run_id=?", (run["id"],)).fetchone())
        self.assertIsNone(self.db.execute("SELECT 1 FROM investor_monitor_payload_purges WHERE kind='run' AND entity_id=?", (run["id"],)).fetchone())
        self.assertIsNone(self.db.execute("SELECT 1 FROM audit_events WHERE action='investor_purge_monitor_payload' AND object_id=?", (run["id"],)).fetchone())
        self.assertGreater(self.db.execute("SELECT count(*) FROM investor_monitor_payload_purges WHERE kind='checkpoint'").fetchone()[0], 0)
        self.assert_no_finance()

    def test_unverified_review_document_cannot_authorize_cleanup(self):
        _, _, refs = self.seed(); self.calculate()
        action = refs[0]["actions"]
        latest = review_source(self.db, "w", "synthetic-investor", action["source_id"], "withdrawn", None, "Fictional withdrawal", action["valid_until"], now=monitor.NOW)
        self.db.execute("DROP TRIGGER investor_data_review_no_update")
        self.db.execute("UPDATE investor_data_reviews SET document_json=json_set(document_json,'$.reason','Fictional unaudited tamper') WHERE id=?", (latest["id"],))
        before = self.protected_state()
        with self.assertRaises(WorkbenchError):
            purge_due_source_payloads(self.db, now=monitor.NOW)
        self.assertEqual(self.protected_state(), before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_payload_purges").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_run_payloads").fetchone()[0], 1)

    def test_provider_role_does_not_run_source_maintenance(self):
        self.seed(); run, _ = self.calculate()
        before = self.db.execute("SELECT count(*) FROM investor_price_payloads").fetchone()[0]
        self.assertIsNone(run_pending_once(self.db, "fictional-provider", role="longport", clock=lambda: run["valid_until"]))
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_payloads").fetchone()[0], before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_payload_purges").fetchone()[0], 0)

    def test_default_core_purges_old_bytes_before_publishing_withdrawal_gap(self):
        _, _, refs = self.seed(); self.calculate()
        rights = refs[0]["rights"]
        later = "2026-01-03T12:15:03.000Z"
        review_source(self.db, "w", "synthetic-investor", rights["source_id"], "withdrawn", None, "Fictional withdrawal", rights["valid_until"], now=later)
        with patch.object(data.longport, "read_private_credentials_file") as secrets, patch.object(data.longport, "_collect_isolated") as network:
            run, payload = self.calculate(later)
            secrets.assert_not_called(); network.assert_not_called()
        self.assertEqual(run["status"], "blocked"); self.assertIsNone(payload["assessment"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_checkpoint_payloads").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_run_payloads").fetchone()[0], 1)
        self.assert_no_finance()


class PlannedMonitorRetentionTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    save = queue.InvestorRuntimeTests.save
    seed = planned.PlannedFundingRuntimeTests.seed
    funding = planned.PlannedFundingRuntimeTests.funding
    calculate = planned.PlannedFundingRuntimeTests.calculate
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance
    protected_state = MonitorRetentionTests.protected_state

    def test_new_request_active_data_is_not_due_and_keeps_its_funding_binding(self):
        self.seed(); self.funding(); run, _ = self.calculate()
        request = self.db.execute('SELECT * FROM investor_evidence_monitor_requests WHERE id=?', (run['request_id'],)).fetchone()
        document = json.loads(request['document_json'])
        self.assertEqual(document['schema_version'], 'investor-evidence-monitor-request-v2')
        self.assertEqual(document['engine_version'], 'investor-evidence-model-watcher-v4')
        before, changes = self.protected_state(), self.db.total_changes
        for kind, identity in (('run', run['id']), ('checkpoint', run['checkpoint_id'])):
            with self.assertRaisesRegex(WorkbenchError, 'PURGE_NOT_DUE'):
                purge_monitor_payload(self.db, 'w', 'synthetic-investor', kind, identity, now=monitor.NOW)
        self.assertEqual(self.protected_state(), before); self.assertEqual(self.db.total_changes, changes)
        self.assertEqual(dict(self.db.execute('SELECT * FROM investor_evidence_monitor_requests WHERE id=?', (request['id'],)).fetchone()), dict(request))
        self.assert_no_finance()

    def test_new_request_withdrawal_cleanup_and_default_core_publish_gap_without_research_or_financial_writes(self):
        self.seed(); self.funding(); run, _ = self.calculate()
        rights = self.db.execute("""SELECT r.* FROM investor_monitor_evidence_inputs i
            JOIN json_each(i.document_json,'$.segments') segment
            JOIN json_each(segment.value,'$.snapshot.review_refs') ref
            JOIN investor_data_reviews r ON r.id=json_extract(ref.value,'$.review_id')
            JOIN investor_data_sources s ON s.id=r.source_id WHERE s.kind='rights' ORDER BY i.rowid DESC LIMIT 1""").fetchone()
        later = '2026-01-03T12:15:03.000Z'
        review_source(self.db, 'w', 'synthetic-investor', rights['source_id'], 'withdrawn', None,
                      'Fictional planned-monitor withdrawal', rights['valid_until'], now=later)
        before = self.protected_state()
        studies = self.db.execute('SELECT count(*) FROM investor_trial_results').fetchone()[0]
        with patch.object(data.longport, 'read_private_credentials_file') as secrets, patch.object(data.longport, '_collect_isolated') as network:
            values = purge_due_source_payloads(self.db, now=later)
            self.assertTrue(any(value.get('kind') == 'run' and value.get('entity_id') == run['id'] for value in values))
            self.assertEqual(self.protected_state(), before)
            self.assertEqual(self.db.execute('SELECT count(*) FROM investor_evidence_checkpoint_payloads').fetchone()[0], 0)
            self.assertEqual(self.db.execute('SELECT count(*) FROM investor_evidence_run_payloads').fetchone()[0], 0)
            self.assertEqual(purge_due_source_payloads(self.db, now=later), [])
            blocked, payload = self.calculate(later)
            secrets.assert_not_called(); network.assert_not_called()
        self.assertEqual(blocked['status'], 'blocked'); self.assertIsNone(payload['assessment'])
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_trial_results').fetchone()[0], studies)
        self.assert_no_finance()

    def test_malformed_new_request_cannot_authorize_retirement(self):
        from worker.investor import source_retention
        self.seed(); self.funding(); run, _ = self.calculate()
        original = source_retention._object
        def missing_binding(value):
            document = original(value)
            if document.get('schema_version') == 'investor-evidence-monitor-request-v2': document.pop('funding_context_hash')
            return document
        before, changes = self.protected_state(), self.db.total_changes
        with patch.object(source_retention, '_object', side_effect=missing_binding):
            with self.assertRaisesRegex(WorkbenchError, 'CONTRACT_INVALID'):
                purge_monitor_payload(self.db, 'w', 'synthetic-investor', 'run', run['id'], now=monitor.NOW)
        self.assertEqual(self.protected_state(), before); self.assertEqual(self.db.total_changes, changes)
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_monitor_payload_purges').fetchone()[0], 0)
        self.assert_no_finance()


if __name__ == "__main__":
    unittest.main()
