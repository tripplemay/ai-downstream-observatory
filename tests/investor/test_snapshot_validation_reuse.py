"""Bounded pure-validation reuse; invented facts and stub transport only."""

from contextlib import nullcontext, redirect_stdout
from copy import deepcopy
import io
import json
import unittest
from unittest.mock import patch

from tests.investor import evidence_fixture as fixture, test_data_evidence as evidence, test_runtime as queue
from worker.investor import data_evidence, data_snapshot
from worker.investor.data_evidence import _fact_validation_scope, resolve_capture, resolve_review, review_source, validate_facts
from worker.market.contracts import validate_contract
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError


def rights():
    return {"provider": "longport", "account_region": "SG", "markets": ["CN"],
        "uses": ["private_research", "private_retention", "private_display", "private_backup"],
        "retention_days": 30, "valid_from": "2025-01-01T00:00:00Z", "valid_until": fixture.EXPIRY,
        "clause_references": ["FICTIONAL test, not a licence"]}


class PureFactValidationReuseTests(unittest.TestCase):
    def test_nested_scopes_restore_outer_cache_and_leave_no_reuse_after_exit(self):
        with patch.object(data_evidence, "validate_contract", wraps=validate_contract) as schema:
            with _fact_validation_scope():
                validate_facts("rights", rights()); validate_facts("rights", rights())
                with _fact_validation_scope():
                    validate_facts("rights", rights()); validate_facts("rights", rights())
                validate_facts("rights", rights())
                self.assertEqual(schema.call_count, 2)
            validate_facts("rights", rights()); validate_facts("rights", rights())
            self.assertEqual(schema.call_count, 4)
        self.assertIsNone(data_evidence._FACT_VALIDATIONS.get())

    def test_exception_discards_scope_without_leaking_validated_documents(self):
        with self.assertRaisesRegex(RuntimeError, "FICTIONAL"):
            with _fact_validation_scope():
                validate_facts("rights", rights())
                raise RuntimeError("FICTIONAL")
        self.assertIsNone(data_evidence._FACT_VALIDATIONS.get())
        with patch.object(data_evidence, "validate_contract", wraps=validate_contract) as schema:
            validate_facts("rights", rights())
            schema.assert_called_once()

    def test_kind_content_and_numeric_representations_bind_each_validation(self):
        value = rights()
        with _fact_validation_scope(), patch.object(data_evidence, "validate_contract", wraps=validate_contract) as schema:
            validate_facts("rights", value)
            value["retention_days"] = 30.0
            validate_facts("rights", value)
            self.assertEqual(schema.call_count, 2)
            with self.assertRaisesRegex(WorkbenchError, "FACTS_INVALID"):
                validate_facts("calendar", value)
            value["valid_until"] = "2024-01-01T00:00:00Z"
            for _ in range(2):
                with self.assertRaisesRegex(WorkbenchError, "FACTS_INVALID"):
                    validate_facts("rights", value)
            self.assertEqual(schema.call_count, 5)

    def test_mutated_precision_and_oversize_inputs_are_not_accepted_by_a_warm_scope(self):
        with _fact_validation_scope():
            validate_facts("rights", rights())
            bad = rights(); bad["clause_references"] = ["x" * data_evidence.MAX_REVIEW_BYTES]
            with self.assertRaisesRegex(WorkbenchError, "REVIEW_LIMIT"):
                validate_facts("rights", bad)
            bad = rights(); bad["at"] = "2027-01-01T00:00:00.0000001Z"
            with self.assertRaisesRegex(WorkbenchError, "TIME_PRECISION_UNSUPPORTED"):
                validate_facts("rights", bad)

    def test_capacity_only_bounds_optimization_and_never_skips_extra_validations(self):
        with _fact_validation_scope(), patch.object(data_evidence, "validate_contract", wraps=validate_contract) as schema:
            for index in range(data_evidence._MAX_FACT_VALIDATIONS + 1):
                value = rights(); value["clause_references"] = [str(index)]
                validate_facts("rights", value)
            self.assertEqual(len(data_evidence._FACT_VALIDATIONS.get()), data_evidence._MAX_FACT_VALIDATIONS)
            validate_facts("rights", value)
            self.assertEqual(schema.call_count, data_evidence._MAX_FACT_VALIDATIONS + 2)
            value["clause_references"] = ["0"]
            validate_facts("rights", value)
            self.assertEqual(schema.call_count, data_evidence._MAX_FACT_VALIDATIONS + 2)
            self.assertTrue(all(isinstance(key[1], bytes) and len(key[1]) == 32 for key in data_evidence._FACT_VALIDATIONS.get()))

    def test_public_benchmark_uses_only_disposable_stub_evidence_without_credentials(self):
        from tests.investor.benchmark_source_reconstruction import main
        output = io.StringIO()
        with patch("sys.argv", ["benchmark", "--days", "7"]), redirect_stdout(output), \
                patch.object(longport, "read_private_credentials_file") as credentials:
            self.assertEqual(main(), 0)
        credentials.assert_not_called()
        report = json.loads(output.getvalue())
        self.assertEqual(report["status"], "FICTIONAL_LOCAL_REPLAY_BENCHMARK_PASS_NOT_RELEASE")
        self.assertEqual(report["database_writes_during_replay"], 0)
        self.assertEqual(report["experiments_registered"], 0)
        self.assertFalse(report["independent_production_performance_verified"])
        self.assertIsNone(data_evidence._FACT_VALIDATIONS.get())


class SnapshotValidationReuseTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance
    review = evidence.InvestorDataTests.review
    prepare = evidence.InvestorDataTests.prepare
    stub_official_capture = evidence.InvestorDataTests.stub_official_capture

    def test_shards_share_only_fact_validation_with_identical_full_reconstruction(self):
        values = fixture.create(self.db, "w", "synthetic-investor", admit=False)
        arguments = (self.db, "w", values["captures"], values["actions"], [], fixture.START, fixture.END)
        before = self.db.total_changes
        with patch.object(data_snapshot, "_fact_validation_scope", nullcontext), \
                patch.object(data_evidence, "validate_contract", wraps=validate_contract) as schemas:
            original = data_snapshot.build_dataset(*arguments, now=fixture.NOW)
        self.assertEqual(schemas.call_count, len(values["captures"]) * 3 + 2)
        with patch.object(data_evidence, "validate_contract", wraps=validate_contract) as schemas, \
                patch.object(longport, "_parse_child_projection", wraps=longport._parse_child_projection) as payloads, \
                patch.object(data_evidence, "_audit_binding", wraps=data_evidence._audit_binding) as audits:
            optimized = data_snapshot.build_dataset(*arguments, now=fixture.NOW)
            self.assertEqual(schemas.call_count, 6)
            self.assertEqual(payloads.call_count, len(values["captures"]))
            self.assertEqual(audits.call_count, (len(values["captures"]) * 3 + 2) * 2)
            repeated = data_snapshot.build_dataset(*arguments, now=fixture.NOW)
            self.assertEqual(schemas.call_count, 12)
        self.assertEqual(original, optimized)
        self.assertEqual(optimized, repeated)
        self.assertEqual(self.db.total_changes, before)
        self.assertIsNone(data_evidence._FACT_VALIDATIONS.get())
        self.assert_no_finance()

    def test_withdrawal_scope_expiry_and_wrong_kind_still_fail_after_validation_hit(self):
        refs = self.prepare()
        with _fact_validation_scope():
            resolve_review(self.db, "w", refs[0]["id"], "rights", now=queue.NOW)
            with self.assertRaisesRegex(WorkbenchError, "OUT_OF_SCOPE"):
                resolve_review(self.db, "other", refs[0]["id"], "rights", now=queue.NOW)
            with self.assertRaises(WorkbenchError):
                resolve_review(self.db, "w", refs[0]["id"], "calendar", now=queue.NOW)
            with self.assertRaises(WorkbenchError):
                resolve_review(self.db, "w", refs[0]["id"], "rights", now=refs[0]["valid_until"])
            review_source(self.db, "w", "synthetic-investor", refs[0]["source_id"], "withdrawn", None,
                "Fictional withdrawal after cache hit", fixture.EXPIRY, now=queue.NOW)
            with self.assertRaisesRegex(WorkbenchError, "SUPERSEDED"):
                resolve_review(self.db, "w", refs[0]["id"], "rights", now=queue.NOW)
        self.assert_no_finance()

    def test_every_payload_is_rechecked_and_corruption_cannot_hit_a_fact_cache(self):
        refs = self.prepare(); capture = self.stub_official_capture(refs)
        with _fact_validation_scope(), patch.object(longport, "_parse_child_projection", wraps=longport._parse_child_projection) as payloads:
            resolve_capture(self.db, "w", capture["id"], now=queue.NOW)
            resolve_capture(self.db, "w", capture["id"], now=queue.NOW)
            self.assertEqual(payloads.call_count, 2)
            # Fault injection in this disposable database, not a production purge.
            self.db.execute("DROP TRIGGER investor_price_payload_no_update")
            self.db.execute("UPDATE investor_price_payloads SET projection=? WHERE capture_id=?", (b"{}", capture["id"]))
            with self.assertRaisesRegex(WorkbenchError, "EVIDENCE_INVALID"):
                resolve_capture(self.db, "w", capture["id"], now=queue.NOW)
        self.assert_no_finance()

    def test_unchanged_facts_do_not_cache_source_or_audit_bindings(self):
        refs = self.prepare()
        with _fact_validation_scope():
            resolve_review(self.db, "w", refs[0]["id"], "rights", now=queue.NOW)
            with patch.object(data_evidence, "_audit_binding", side_effect=WorkbenchError("FICTIONAL_AUDIT_CHANGED")):
                with self.assertRaisesRegex(WorkbenchError, "AUDIT_CHANGED"):
                    resolve_review(self.db, "w", refs[0]["id"], "rights", now=queue.NOW)
            current = deepcopy(json.loads(refs[0]["document_json"])["facts"])
            replacement = review_source(self.db, "w", "synthetic-investor", refs[0]["source_id"], "approved", current,
                "Fictional new review, same validated facts", fixture.EXPIRY, now=queue.NOW)
            with self.assertRaisesRegex(WorkbenchError, "SUPERSEDED"):
                resolve_review(self.db, "w", refs[0]["id"], "rights", now=queue.NOW)
            resolved = resolve_review(self.db, "w", replacement["id"], "rights", now=queue.NOW)
            self.assertEqual(resolved["review"]["id"], replacement["id"])
        self.assert_no_finance()


if __name__ == "__main__":
    unittest.main()
