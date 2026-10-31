"""Invented issuer JSON only; no provider, account or database calls."""

import json
import unittest

from worker.market.providers.vanguard_distributions import MAX_BYTES, MAX_RECORDS, parse_vanguard_distributions
from worker.orchestration.db import WorkbenchError


def row(amount="0.123456789123456789", component="INC", **changes):
    body = {"amount": "__NUMBER__", "exDividendDate": "2025-04-01", "recordDate": "2025-04-01",
        "payableDate": "2025-04-04", "reinvestDate": "2025-04-04", "reinvestPrice": 99,
        "typeCode": component, **changes}
    return json.dumps(body).replace('"__NUMBER__"', amount).encode()


def archive(*rows):
    return b"[" + b",".join(rows or [row()]) + b"]"


class VanguardDistributionTests(unittest.TestCase):
    def parse(self, raw=None, **changes):
        options = {"fund_id": "9998", "has_distribution_yield": False, "retrieved_at": "2025-06-01T12:00:00Z",
            "start_date": "2025-01-01", "end_date": "2025-05-31", **changes}
        return parse_vanguard_distributions(archive() if raw is None else raw, **options)

    def test_exact_json_numbers_never_pass_through_binary_float(self):
        for token, expected in (("0.123456789123456789", "0.123456789123456789"), ("1e-18", "0.000000000000000001"),
            ("12345678901234567890.123456789123456789", "12345678901234567890.123456789123456789"), ("1.2500", "1.25"), ("0", "0")):
            with self.subTest(token=token):
                self.assertEqual(self.parse(archive(row(token)))["records"][0]["distribution_amount"], expected)

    def test_reported_dates_are_not_publication_or_effective_instants(self):
        result = self.parse()
        event = result["records"][0]
        self.assertEqual(event["ex_date"], "2025-04-01")
        self.assertEqual(event["pay_date"], "2025-04-04")
        self.assertEqual(event["date_precision"], "date_not_instant")
        self.assertIsNone(event["published_at"])
        self.assertIsNone(event["tax_per_unit"])

    def test_payload_cannot_certify_identity_currency_amount_basis_or_approval(self):
        result = self.parse()
        self.assertIsNone(result["records"][0]["currency"])
        self.assertEqual(result["records"][0]["amount_basis"], "not_supplied_in_payload")
        self.assertFalse(result["source"]["fund_identity_verified_by_payload"])
        self.assertFalse(result["source"]["network_origin_verified_by_parser"])
        for key in ("owner_reviewed", "corporate_actions_complete", "research_admitted"):
            self.assertFalse(result[key])
        self.assertIn("SPLIT_AND_DISTRIBUTION_COVERAGE_REVIEW_REQUIRED", result["gaps"])

    def test_income_and_capital_gain_components_share_dates_without_collapsing(self):
        result = self.parse(archive(row("1", "INC"), row("2", "CGLT"), row("3", "CGST")))
        self.assertEqual(len(result["records"]), 3)
        self.assertEqual({event["issuer_type_code"] for event in result["records"]}, {"INC", "CGLT", "CGST"})
        self.assertEqual(len({event["derived_event_key"] for event in result["records"]}), 3)

    def test_amount_correction_has_same_derived_identity_and_duplicate_is_rejected(self):
        self.assertEqual(self.parse(archive(row("1")))["records"][0]["derived_event_key"],
            self.parse(archive(row("2")))["records"][0]["derived_event_key"])
        for second in (row("1"), row("2")):
            with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_COMPONENT"):
                self.parse(archive(row("1"), second))

    def test_stable_order_and_raw_provenance_do_not_copy_reinvestment_fields(self):
        a, b = row("1", "INC"), row("2", "CGLT", distributionYieldAmount="88.12")
        first, second = self.parse(archive(a, b)), self.parse(archive(b, a))
        self.assertEqual(first["records"], second["records"])
        self.assertNotEqual(first["source"]["raw_sha256"], second["source"]["raw_sha256"])
        text = json.dumps(first)
        self.assertNotIn("reinvestPrice", text); self.assertNotIn("distributionYieldAmount", text)
        self.assertEqual(self.parse(archive(row(reinvestPrice=42)))["records"],
            self.parse(archive(row(reinvestPrice=99)))["records"])

    def test_no_event_in_window_is_not_complete_no_distribution_evidence(self):
        result = self.parse(start_date="2025-05-01")
        self.assertEqual(result["records"], [])
        self.assertEqual(result["source"]["archive_record_count"], 1)
        self.assertFalse(result["corporate_actions_complete"])
        with self.assertRaises(WorkbenchError): self.parse(b"[]")

    def test_unsupported_components_and_malformed_outside_window_still_reject(self):
        for raw in (archive(row(component="UNKNOWN")), archive(row("-1")), archive(row(exDividendDate="2025-02-30"))):
            with self.subTest(raw=raw), self.assertRaises(WorkbenchError): self.parse(raw, start_date="2025-05-01")

    def test_invalid_amount_types_precision_and_numeric_bounds_reject_without_rounding(self):
        for token in ('"1.25"', "true", "null", "NaN", "Infinity", "1e-19", "1e38", "1e999999999",
            "0." + "1" * 19, "1" * 81):
            with self.subTest(token=token), self.assertRaises(WorkbenchError): self.parse(archive(row(token)))

    def test_dates_order_exactness_and_new_york_local_window_boundary(self):
        for changes in ({"exDividendDate": "2025-4-01"}, {"recordDate": "2025-03-31"},
            {"payableDate": "2025-03-31"}, {"exDividendDate": "2025-04-01T00:00:00Z"}):
            with self.subTest(changes=changes), self.assertRaises(WorkbenchError): self.parse(archive(row(**changes)))
        with self.assertRaises(WorkbenchError): self.parse(retrieved_at="2025-06-01T00:30:00Z", end_date="2025-06-01")
        self.assertEqual(self.parse(retrieved_at="2025-06-01T00:30:00Z")["source"]["range_end"], "2025-05-31")
        with self.assertRaises(WorkbenchError): self.parse(start_date="2025-06-01")
        with self.assertRaises(WorkbenchError): self.parse(start_date="2010-01-01")

    def test_request_metadata_requires_closed_types_and_does_not_accept_urls(self):
        for changes in ({"fund_id": 9998}, {"fund_id": "../x"}, {"fund_id": "999"},
            {"has_distribution_yield": 1}, {"retrieved_at": "2025-06-01"}, {"retrieved_at": "2025-06-01T12:00:00+00:00"}):
            with self.subTest(changes=changes), self.assertRaises(WorkbenchError): self.parse(**changes)
        self.assertTrue(self.parse(has_distribution_yield=True)["source"]["url"].endswith("=true"))

    def test_duplicate_json_keys_bad_roots_unknown_fields_and_size_limits(self):
        duplicate = archive(row()).replace(b'"typeCode": "INC"', b'"typeCode":"INC","typeCode":"CGST"')
        for raw in (b"", b"{}", b"[null]", duplicate, b"x" * (MAX_BYTES + 1),
            b"[" * 2000 + b"]" * 2000, archive(row(extra="unexpected"))):
            with self.subTest(length=len(raw)), self.assertRaises(WorkbenchError): self.parse(raw)
        with self.assertRaises(WorkbenchError): self.parse(archive(*[row() for _ in range(MAX_RECORDS + 1)]))


if __name__ == "__main__":
    unittest.main()
