"""Bounded pure-validation reuse; invented facts and stub transport only."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext, redirect_stderr, redirect_stdout
from copy import deepcopy
import io
import json
import unittest
from unittest.mock import patch

from tests.investor import evidence_fixture as fixture, test_data_evidence as evidence, test_runtime as queue
from tests.investor import fixture_dataset_shapes as shapes
from tests.research.fixtures import dataset
from worker.investor import data_evidence, data_snapshot, source_inputs
from worker.investor import action_restatement_kernel as restatement
from worker.investor.data_evidence import _fact_validation_scope, resolve_capture, resolve_review, review_source, validate_facts
from worker.market.contracts import validate_contract
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError
from worker.market import contracts
from worker.research import snapshot


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

    def test_header_checks_reuse_only_pure_fact_validation_across_all_shards(self):
        values = fixture.create(self.db, "w", "synthetic-investor")
        before = self.db.total_changes
        with patch.object(data_evidence, "validate_contract", wraps=validate_contract) as schemas, \
                patch.object(longport, "_parse_child_projection", wraps=longport._parse_child_projection) as payloads:
            source_inputs.resolve_evidence_input(self.db, "w", values["source"]["id"], now=fixture.NOW, header_only=True)
            self.assertEqual(schemas.call_count, 6)
            self.assertEqual(payloads.call_count, len(values["captures"]))
            source_inputs.resolve_evidence_input(self.db, "w", values["source"]["id"], now=fixture.NOW, header_only=True)
            self.assertEqual(schemas.call_count, 12)
            self.assertEqual(payloads.call_count, 2 * len(values["captures"]))
        self.assertEqual(self.db.total_changes, before)
        self.assertIsNone(data_evidence._FACT_VALIDATIONS.get())
        self.assert_no_finance()

    def test_header_payload_corruption_is_rejected_after_pure_facts_are_warm(self):
        values = fixture.create(self.db, "w", "synthetic-investor")
        ordered = [row["capture_id"] for row in json.loads(values["source"]["document_json"])["snapshot"]["capture_refs"]]
        target = ordered[-1]
        original = source_inputs.resolve_capture; visited = []
        def damaged(db, workspace, identifier, **kwargs):
            visited.append(identifier)
            if identifier == target:
                db.execute("DROP TRIGGER investor_price_payload_no_update")
                db.execute("UPDATE investor_price_payloads SET projection=? WHERE capture_id=?", (b"{}", target))
            return original(db, workspace, identifier, **kwargs)
        with patch.object(source_inputs, "resolve_capture", side_effect=damaged), self.assertRaises(WorkbenchError):
            source_inputs.resolve_evidence_input(self.db, "w", values["source"]["id"], now=fixture.NOW, header_only=True)
        self.assertEqual(visited, ordered)
        self.assertIsNone(data_evidence._FACT_VALIDATIONS.get())
        self.assert_no_finance()

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


def large_dataset():
    value = dataset(); observations = value["observations"]
    value["observations"] = [{**row, "id": row["id"] + ":copy:" + str(index), "revision_id": "copy:" + str(index)}
                             for index in range(12) for row in observations]
    assert len(json.dumps(value).encode()) > 65536
    return value


class FixtureDatasetShapesTests(unittest.TestCase):
    def test_small_restatement_shapes_reuse_only_input_validation_not_arithmetic(self):
        from tests.investor.test_action_restatement_kernel import fractional_case
        value = fractional_case(); compare = restatement.compare_action_restatement
        original = restatement.validate_contract
        with redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics, \
                patch.object(restatement, "_replay", wraps=restatement._replay) as replay:
            result = compare(value)
            self.assertEqual(compare(deepcopy(value)), result)
            self.assertEqual((metrics["validated"], metrics["hits"]), (1, 1))
            self.assertEqual(replay.call_count, 4)
            self.assertIs(restatement.compare_action_restatement, compare)
            hits = metrics["hits"]
            with patch.object(snapshot, "validate_contract", wraps=contracts.validate_contract), \
                    patch.object(restatement, "validate_contract", wraps=contracts.validate_contract) as uncached:
                self.assertEqual(compare(deepcopy(value)), result)
                self.assertTrue(any(call.args[1] == restatement.SCHEMA and not call.kwargs for call in uncached.call_args_list))
            self.assertEqual(metrics["hits"], hits)
            self.assertEqual(replay.call_count, 6)
            bad = deepcopy(value); bad["corrected_coverage"][next(iter(bad["corrected_coverage"]))]["complete"] = False
            for _ in range(2):
                with self.assertRaisesRegex(WorkbenchError, "CORRECTED_COVERAGE_GAP"): compare(bad)
            self.assertEqual((metrics["validated"], metrics["hits"]), (2, 2))
            self.assertEqual(replay.call_count, 8)
        self.assertIs(restatement.validate_contract, original)

    def test_restatement_transitive_schema_and_format_changes_are_not_cached(self):
        from tests.investor.test_action_restatement_kernel import fractional_case
        value = fractional_case(); schemas, _, checker = contracts._schemas()
        with redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics:
            result = restatement.compare_action_restatement(value)
            with patch.dict(schemas["common.schema.json"]["$defs"]["hash"], {"pattern": "^z$"}):
                with self.assertRaises(WorkbenchError): restatement.compare_action_restatement(value)
            with patch.dict(checker.checkers, {"date-time": (lambda _: False, ())}):
                with self.assertRaises(WorkbenchError): restatement.compare_action_restatement(value)
            self.assertEqual((metrics["validated"], metrics["hits"]), (3, 0))
            self.assertEqual(restatement.compare_action_restatement(value), result)
            self.assertEqual(metrics["hits"], 1)

    def test_restatement_invalid_types_and_fragments_always_reach_original_validation(self):
        from tests.investor.test_action_restatement_kernel import fractional_case
        value = fractional_case()
        with redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics:
            result = restatement.compare_action_restatement(value)
            for change in (lambda item: item["origin"].update(sequence=True),
                           lambda item: item["definition"].update(targets=tuple(item["definition"]["targets"]))):
                bad = deepcopy(value); change(bad)
                for _ in range(2):
                    with self.assertRaises(WorkbenchError): restatement.compare_action_restatement(bad)
            self.assertEqual((metrics["validated"], metrics["hits"]), (5, 0))
            result["difference_cny"] = "0"
            # A structurally valid result still requires independent arithmetic.
            for _ in range(2):
                with self.assertRaisesRegex(WorkbenchError, "RESULT_REPLAY_MISMATCH"):
                    restatement.verify_action_restatement_arithmetic(value, result)
            self.assertEqual((metrics["validated"], metrics["hits"]), (5, 2))

    def test_restatement_shares_entry_budget_and_cannot_cross_threads_or_wrappers(self):
        from tests.investor.test_action_restatement_kernel import fractional_case
        value = fractional_case(); original = restatement.validate_contract
        with redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics:
            restatement.compare_action_restatement(value)
            with ThreadPoolExecutor(max_workers=1) as pool: pool.submit(restatement.compare_action_restatement, value).result()
            self.assertEqual((metrics["validated"], metrics["hits"]), (1, 0))
        with patch.object(shapes, "MAX_ENTRIES", 1), redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics:
            snapshot.validate_dataset(large_dataset())
            restatement.compare_action_restatement(value); restatement.compare_action_restatement(value)
            self.assertEqual((metrics["validated"], metrics["hits"], metrics["entries"]), (3, 0, 1))
        with patch.object(restatement, "validate_contract", wraps=original) as wrapper, \
                redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics:
            restatement.compare_action_restatement(value)
            self.assertIs(restatement.validate_contract, wrapper)
            self.assertEqual(metrics["checks"], 0)
            self.assertGreater(wrapper.call_count, 0)
        with self.assertRaisesRegex(RuntimeError, "FICTIONAL_EXIT"), redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes():
            raise RuntimeError("FICTIONAL_EXIT")
        self.assertIs(restatement.validate_contract, original)
        self.assertIsNone(shapes._ACTIVE.get())

    def test_restatement_shared_json_subtrees_bind_expanded_bytes_and_stay_bounded(self):
        from tests.investor.test_action_restatement_kernel import fractional_case
        value = fractional_case(); value["corrected_actions"][0] = value["original_actions"][0]
        self.assertIsNone(shapes._document_key(value, 0))
        expanded = json.loads(json.dumps(value))
        self.assertEqual(shapes._document_key(value, 0, True), shapes._document_key(expanded, 0))
        with redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics:
            result = restatement.compare_action_restatement(value)
            self.assertEqual(restatement.compare_action_restatement(expanded), result)
            self.assertEqual((metrics["validated"], metrics["hits"]), (1, 1))
            value["original_actions"][0]["known_at"] = "not-an-instant"
            for _ in range(2):
                with self.assertRaises(WorkbenchError): restatement.compare_action_restatement(value)
            self.assertEqual((metrics["validated"], metrics["hits"]), (3, 1))
        cycle = {}; cycle["cycle"] = cycle
        self.assertIsNone(shapes._document_key(cycle, 0, True))
        with patch.object(shapes, "MAX_NODES", 4):
            leaf = {"value": 1}
            self.assertIsNone(shapes._document_key([leaf, leaf], 0, True))
        for guard in ({"MAX_BYTES": 128}, {"MAX_SCHEMAS": 2}):
            with patch.multiple(shapes, **guard), redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics:
                restatement.compare_action_restatement(expanded); restatement.compare_action_restatement(expanded)
                self.assertEqual((metrics["validated"], metrics["hits"], metrics["entries"]), (2, 0, 0))

    def test_restatement_mutating_format_callback_cannot_create_an_entry(self):
        from tests.investor.test_action_restatement_kernel import fractional_case
        value = fractional_case(); _, _, checker = contracts._schemas()
        original = checker.checkers["date-time"]
        def mutate(instant):
            value["checked_at"] = "2025-01-01T00:00:00Z"
            return original[0](instant)
        with patch.dict(checker.checkers, {"date-time": (mutate, original[1])}), \
                redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics:
            with self.assertRaises(WorkbenchError): restatement.compare_action_restatement(value)
            self.assertEqual(metrics["entries"], 0)

    def test_exact_shape_reuse_restores_original_and_keeps_every_dataset_semantic_check(self):
        original, validate = snapshot.validate_contract, snapshot.validate_dataset
        value = large_dataset()
        with redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics:
            snapshot.validate_dataset(value); snapshot.validate_dataset(deepcopy(value))
            self.assertEqual((metrics["validated"], metrics["hits"]), (1, 1))
            self.assertIs(snapshot.validate_dataset, validate)
            bad = deepcopy(value); bad["observations"].append(deepcopy(bad["observations"][0]))
            for _ in range(2):
                with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_RESEARCH_OBSERVATION"):
                    snapshot.validate_dataset(bad)
            # Shape reuse never skips duplicate-row or other semantic checks.
            self.assertEqual((metrics["validated"], metrics["hits"]), (2, 2))
        self.assertIs(snapshot.validate_contract, original)
        self.assertIs(contracts.validate_contract, original)

    def test_full_bytes_numeric_types_and_original_raw_hashes_do_not_alias(self):
        value = large_dataset()
        with redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics:
            snapshot.validate_dataset(value)
            variants = []
            for alias in (0, 0.0):
                bad = deepcopy(value); bad["historical_archive_verified"] = alias; variants.append(bad)
            bad = deepcopy(value); bad["observations"][0]["value"] = "not-a-decimal"; variants.append(bad)
            bad = deepcopy(value); bad["assets"] = tuple(bad["assets"]); variants.append(bad)
            for bad in variants:
                for _ in range(2):
                    with self.assertRaises(WorkbenchError): snapshot.validate_dataset(bad)
            self.assertEqual(metrics["hits"], 0)
            changed = deepcopy(value); changed["observations"][0]["value"] = "12.5"
            # An unchanged source label/hash never aliases changed full bytes.
            self.assertEqual(changed["observations"][0]["raw_hash"], value["observations"][0]["raw_hash"])
            validated = metrics["validated"]
            snapshot.validate_dataset(changed)
            self.assertEqual(metrics["validated"], validated + 1)
            self.assertEqual(metrics["hits"], 0)
            snapshot.validate_dataset(deepcopy(value)); self.assertEqual(metrics["hits"], 1)

    def test_schema_and_format_changes_cannot_reuse_an_old_success(self):
        value = large_dataset(); schemas, _, checker = contracts._schemas()
        mode = schemas[shapes.SCHEMA]["properties"]["mode"]
        with redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics:
            snapshot.validate_dataset(value)
            with patch.dict(mode, {"enum": ["historical_point_in_time"]}):
                with self.assertRaises(WorkbenchError): snapshot.validate_dataset(value)
            with patch.dict(checker.checkers, {"date-time": (lambda _: False, ())}):
                with self.assertRaises(WorkbenchError): snapshot.validate_dataset(value)
            self.assertEqual(metrics["hits"], 0)
            snapshot.validate_dataset(value); self.assertEqual(metrics["hits"], 1)

    def test_scopes_entry_caps_and_uncacheable_values_never_bypass_original_validation(self):
        value = large_dataset(); original = snapshot.validate_contract
        with redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics:
            for index in range(shapes.MAX_ENTRIES + 2):
                changed = deepcopy(value); changed["source_evidence"] = "Fictional scope " + str(index)
                snapshot.validate_dataset(changed)
            snapshot.validate_dataset(changed)
            self.assertEqual(metrics["entries"], shapes.MAX_ENTRIES)
            self.assertEqual(metrics["hits"], 0)
            with shapes.fixture_dataset_shapes() as nested: self.assertIs(nested, metrics)
        self.assertIs(snapshot.validate_contract, original)
        with redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as fresh:
            snapshot.validate_dataset(value); self.assertEqual((fresh["validated"], fresh["hits"]), (1, 0))
        for guard in ({"MAX_BYTES": 128}, {"MAX_NODES": 2}):
            with patch.multiple(shapes, **guard), redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as limited:
                snapshot.validate_dataset(value); snapshot.validate_dataset(value)
                self.assertEqual((limited["validated"], limited["hits"], limited["entries"]), (2, 0, 0))

    def test_other_threads_do_not_share_success_and_exception_exit_restores_alias(self):
        value = large_dataset(); original = snapshot.validate_contract
        with redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics:
            snapshot.validate_dataset(value)
            with ThreadPoolExecutor(max_workers=1) as pool: pool.submit(snapshot.validate_dataset, value).result()
            self.assertEqual((metrics["validated"], metrics["hits"]), (1, 0))
        with self.assertRaisesRegex(RuntimeError, "FICTIONAL_EXIT"), redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes():
            raise RuntimeError("FICTIONAL_EXIT")
        self.assertIs(snapshot.validate_contract, original)
        self.assertIsNone(shapes._ACTIVE.get())

    def test_a_mutating_format_callback_does_not_create_a_stale_shape_entry(self):
        value = large_dataset(); _, _, checker = contracts._schemas()
        original = checker.checkers["date-time"]
        def mutate(instant):
            value["source_evidence"] += "."
            return original[0](instant)
        with patch.dict(checker.checkers, {"date-time": (mutate, original[1])}), redirect_stderr(io.StringIO()), shapes.fixture_dataset_shapes() as metrics:
            snapshot.validate_dataset(value)
            self.assertEqual(metrics["entries"], 0)


if __name__ == "__main__":
    unittest.main()
