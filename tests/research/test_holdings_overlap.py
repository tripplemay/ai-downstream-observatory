from copy import deepcopy
from decimal import Decimal, localcontext
from hashlib import sha256
from itertools import product
import json
from pathlib import Path
import unittest

from worker.research.holdings_overlap import HoldingsOverlapError, compare_holdings, disclosure_hash


AT = "2026-01-15T12:00:00Z"


def disclosure(identity, weights, *, complete=True, as_of="2025-12-31", known_at="2026-01-10T00:00:00Z", portfolio_id="p", listing_id=None):
    with localcontext() as context:
        context.prec = 60
        value = {"schema_version": "holdings-disclosure-v1", "snapshot_id": identity, "version": 1,
                 "portfolio_id": portfolio_id, "listing_id": listing_id or "listing:" + identity,
                 "as_of": as_of, "known_at": known_at, "weight_basis": "net_assets_long_only", "complete": complete,
                 "coverage": format(sum((Decimal(weight) for _, weight in weights), Decimal(0)), "f"),
                 "items": [{"security_id": security, "weight": weight} for security, weight in weights], "content_hash": None}
        value["content_hash"] = disclosure_hash(value)
    return value


class HoldingsOverlapTests(unittest.TestCase):
    def test_shared_golden_source_hashes_results_and_evidence_bindings(self):
        fixture = json.loads(Path(__file__).with_name("holdings-overlap-golden.json").read_text())
        self.assertEqual(fixture["schema_version"], "holdings-overlap-golden-v1")
        for case in fixture["cases"]:
            with self.subTest(case=case["name"]):
                for key in ("snapshot_a", "snapshot_b"):
                    self.assertEqual(disclosure_hash(case[key]), case[key]["content_hash"])
                result = compare_holdings(case["snapshot_a"], case["snapshot_b"], case["comparison_at"])
                self.assertEqual(result, case["expected_result"])
                payload = {key: value for key, value in result.items() if key != "binding_id"}
                digest = sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                self.assertEqual(result["binding_id"], digest)

    def test_full_same_date_exact_and_sorted_stable_ids(self):
        left = disclosure("d:a", [("ISIN:B", "0.3"), ("ISIN:A", "0.7")])
        right = disclosure("d:b", [("ISIN:C", "0.4"), ("ISIN:A", "0.6")])
        result = compare_holdings(left, right, AT)
        self.assertEqual((result["quality"], result["known_overlap"], result["conservative_upper_bound"]), ("exact", "0.6", "0.6"))
        self.assertEqual(result["common_holdings"], [{"security_id": "ISIN:A", "weight_a": "0.7", "weight_b": "0.6", "overlap_weight": "0.6"}])
        self.assertEqual(result["snapshot_a"]["content_hash"], left["content_hash"])

    def test_partial_disclosures_return_interval_not_imputed_zeros(self):
        left = disclosure("d:a", [("ISIN:A", "0.4"), ("ISIN:B", "0.4")], complete=False)
        right = disclosure("d:b", [("ISIN:A", "0.2"), ("ISIN:C", "0.7")], complete=False)
        result = compare_holdings(left, right, AT)
        self.assertEqual(result["quality"], "lower_bound")
        self.assertEqual([result[key] for key in ("known_overlap", "coverage_a", "coverage_b", "uncovered_a", "uncovered_b", "conservative_upper_bound")],
                         ["0.2", "0.8", "0.9", "0.2", "0.1", "0.5"])

    def test_empty_partial_is_unknown_while_empty_complete_is_invalid(self):
        left = disclosure("d:a", [], complete=False)
        right = disclosure("d:b", [], complete=False)
        result = compare_holdings(left, right, AT)
        self.assertEqual((result["known_overlap"], result["conservative_upper_bound"], result["quality"]), ("0", "1", "lower_bound"))
        right["complete"] = True
        with self.assertRaisesRegex(HoldingsOverlapError, "COMPLETE_DISCLOSURE_REQUIRES_FULL_COVERAGE"):
            compare_holdings(left, right, AT)

    def test_different_dates_never_claim_same_date_exact_even_for_full_coverage(self):
        left = disclosure("d:a", [("ID:A", "1")])
        right = disclosure("d:b", [("ID:A", "1")], as_of="2026-01-01")
        result = compare_holdings(left, right, AT)
        self.assertEqual(result["quality"], "different_dates")
        self.assertFalse(result["same_date"])
        self.assertEqual(result["known_overlap"], "1")
        self.assertEqual(result["bound_scope"], "the_two_disclosed_date_vectors")
        self.assertIn("DISCLOSURE_DATES_DIFFER", result["issues"])

    def test_equal_coverage_without_complete_flag_stays_lower_bound(self):
        left = disclosure("d:a", [("ID:A", "1")], complete=False)
        right = disclosure("d:b", [("ID:A", "1")])
        result = compare_holdings(left, right, AT)
        self.assertEqual((result["known_overlap"], result["conservative_upper_bound"], result["quality"]), ("1", "1", "lower_bound"))

    def test_ids_are_exact_not_case_folded_or_matched_by_display_name(self):
        left = disclosure("d:a", [("ISIN:abc", "1")])
        right = disclosure("d:b", [("TICKER:abc", "1")])
        self.assertEqual(compare_holdings(left, right, AT)["known_overlap"], "0")
        right = disclosure("d:b", [("ISIN:ABC", "1")])
        self.assertEqual(compare_holdings(left, right, AT)["known_overlap"], "0")
        left["items"][0]["name"] = "Same displayed security name"
        with self.assertRaisesRegex(HoldingsOverlapError, "INVALID_HOLDING_SHAPE"):
            compare_holdings(left, right, AT)

    def test_security_ids_require_explicit_stable_namespace(self):
        good = disclosure("d:good", [("ID:A", "1")])
        for identity in ("A", "Apple", "Apple Inc", "isin:A", "ISIN:", ":ABC", "ISIN:has space",
                         "X" * 33 + ":A", "ISIN:" + "A" * 161):
            broken = deepcopy(good)
            broken["items"][0]["security_id"] = identity
            with self.subTest(identity=identity), self.assertRaisesRegex(HoldingsOverlapError, "INVALID_SECURITY_ID"):
                compare_holdings(broken, good, AT)
        longest = "X" * 32 + ":" + "a" * 160
        valid = disclosure("d:long", [(longest, "1")])
        self.assertEqual(compare_holdings(valid, valid, AT)["common_holdings"][0]["security_id"], longest)
        namespaced_path = disclosure("d:path", [("EXCHANGE:US/ABC-A", "1")])
        self.assertEqual(compare_holdings(namespaced_path, namespaced_path, AT)["known_overlap"], "1")

    def test_no_float_bool_null_negative_duplicate_or_unsupported_basis(self):
        good = disclosure("d:good", [("ID:A", "1")])
        for value in (0.5, True, None, "-0.1", "1.1", "1e-2", "NaN", "0.0000000000000000001"):
            broken = deepcopy(good)
            broken["items"][0]["weight"] = value
            with self.subTest(value=value), self.assertRaises(HoldingsOverlapError):
                compare_holdings(broken, good, AT)
        for key, value in (("complete", 1), ("version", True), ("coverage", 1), ("coverage", "0.9"), ("weight_basis", "gross_exposure")):
            broken = deepcopy(good)
            broken[key] = value
            with self.subTest(key=key), self.assertRaises(HoldingsOverlapError):
                compare_holdings(broken, good, AT)
        broken = deepcopy(good)
        broken["items"].append(deepcopy(broken["items"][0]))
        with self.assertRaisesRegex(HoldingsOverlapError, "DUPLICATE_SECURITY_ID"):
            compare_holdings(broken, good, AT)

    def test_coverage_sum_cannot_exceed_one_or_silently_normalize(self):
        good = disclosure("d:good", [("ID:A", "1")])
        broken = deepcopy(good)
        broken["items"] = [{"security_id": "ID:A", "weight": "0.8"}, {"security_id": "ID:B", "weight": "0.8"}]
        with self.assertRaisesRegex(HoldingsOverlapError, "DISCLOSURE_COVERAGE_EXCEEDS_ONE"):
            compare_holdings(broken, good, AT)

    def test_future_dates_and_unknown_at_comparison_are_rejected(self):
        good = disclosure("d:good", [("ID:A", "1")])
        future = disclosure("d:future", [("ID:A", "1")], as_of="2026-01-16")
        with self.assertRaisesRegex(HoldingsOverlapError, "FUTURE_DISCLOSURE_DATE"):
            compare_holdings(good, future, AT)
        late = disclosure("d:late", [("ID:A", "1")], known_at="2026-01-15T12:00:00.000001Z")
        with self.assertRaisesRegex(HoldingsOverlapError, "DISCLOSURE_NOT_YET_KNOWN"):
            compare_holdings(good, late, AT)
        for at in (None, "2026-01-15", "2026-01-15T12:00:00", "2026-02-30T00:00:00Z",
                   "2026-01-15T12:00Z", "2026-01-15T12:00:00.0000001Z", "0000-01-01T00:00:00Z",
                   "2026-01-15T12:00:00+00:00", "2026-01-15T12:00:00,123Z"):
            with self.subTest(at=at), self.assertRaises(HoldingsOverlapError):
                compare_holdings(good, good, at)

    def test_snapshot_scope_is_validated_and_hash_bound(self):
        left = disclosure("d:a", [("ID:A", "1")])
        right = disclosure("d:b", [("ID:A", "1")], portfolio_id="other")
        with self.assertRaisesRegex(HoldingsOverlapError, "DISCLOSURE_PORTFOLIO_MISMATCH"):
            compare_holdings(left, right, AT)
        right = disclosure("d:b", [("ID:A", "1")])
        right["listing_id"] = "listing:tampered"
        with self.assertRaisesRegex(HoldingsOverlapError, "DISCLOSURE_HASH_MISMATCH"):
            compare_holdings(left, right, AT)
        for key in ("portfolio_id", "listing_id", "snapshot_id"):
            broken = deepcopy(left)
            broken[key] = "has space"
            with self.subTest(key=key), self.assertRaises(HoldingsOverlapError):
                compare_holdings(left, broken, AT)

    def test_items_are_bounded_and_timestamp_precision_is_not_silently_truncated(self):
        good = disclosure("d:good", [("ID:A", "1")])
        broken = deepcopy(good)
        broken["items"] = [{"security_id": "ID:" + str(index), "weight": "0"} for index in range(10001)]
        with self.assertRaisesRegex(HoldingsOverlapError, "INVALID_HOLDINGS_ITEMS"):
            compare_holdings(good, broken, AT)
        broken = deepcopy(good)
        broken["known_at"] = "2026-01-15T12:00:00.0000001Z"
        with self.assertRaisesRegex(HoldingsOverlapError, "INVALID_KNOWN_AT"):
            compare_holdings(good, broken, AT)

    def test_exact_decimal_math_ignores_ambient_precision(self):
        left = disclosure("d:a", [("ID:A", "0.000000000000000001"), ("ID:B", "0.999999999999999999")])
        right = disclosure("d:b", [("ID:A", "0.999999999999999999"), ("ID:B", "0.000000000000000001")])
        with localcontext() as context:
            context.prec = 2
            result = compare_holdings(left, right, AT)
        self.assertEqual(result["known_overlap"], "0.000000000000000002")
        self.assertEqual(result["conservative_upper_bound"], "0.000000000000000002")

    def test_hash_binds_metadata_and_weights_while_order_is_irrelevant_and_inputs_untouched(self):
        left = disclosure("d:a", [("ID:B", "0.50"), ("ID:A", "0.50")])
        right = disclosure("d:b", [("ID:A", "1")])
        before = deepcopy(left)
        expected = compare_holdings(left, right, AT)
        self.assertEqual(left, before)
        left["items"].reverse()
        self.assertEqual(compare_holdings(left, right, AT), expected)
        left["items"][0]["weight"] = "0.5"
        with self.assertRaisesRegex(HoldingsOverlapError, "DISCLOSURE_HASH_MISMATCH"):
            compare_holdings(left, right, AT)
        left = deepcopy(before)
        left["known_at"] = "2026-01-09T00:00:00Z"
        with self.assertRaisesRegex(HoldingsOverlapError, "DISCLOSURE_HASH_MISMATCH"):
            compare_holdings(left, right, AT)

    def test_same_snapshot_version_cannot_have_conflicting_content(self):
        left = disclosure("d:same", [("ID:A", "1")])
        right = disclosure("d:same", [("ID:B", "1")])
        with self.assertRaisesRegex(HoldingsOverlapError, "DISCLOSURE_VERSION_CONFLICT"):
            compare_holdings(left, right, AT)

    def test_conservative_bound_contains_all_small_exact_portfolios(self):
        vectors = [parts for parts in product(range(3), repeat=3) if sum(parts) == 2]
        cases = []
        for index, vector in enumerate(vectors):
            for mask in range(8):
                weights = [("ID:" + str(i), str(Decimal(vector[i]) / 2)) for i in range(3) if mask & (1 << i)]
                cases.append((vector, disclosure("d:" + str(index) + ":" + str(mask), weights, complete=mask == 7)))
        for vector_a, left in cases:
            for vector_b, right in cases:
                exact = sum((min(a, b) for a, b in zip(vector_a, vector_b)), 0) / Decimal(2)
                result = compare_holdings(left, right, AT)
                self.assertLessEqual(Decimal(result["known_overlap"]), exact)
                self.assertGreaterEqual(Decimal(result["conservative_upper_bound"]), exact)
                self.assertLessEqual(Decimal(result["conservative_upper_bound"]), 1)


if __name__ == "__main__":
    unittest.main()
