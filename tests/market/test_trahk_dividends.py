"""Fictional issuer JSON, never copies live dividends or prices into tests."""

import json
import unittest

from worker.market.providers.trahk_dividends import parse_trahk_dividends
from worker.orchestration.db import WorkbenchError


def fixture():
    row = {"Div": "0.123456789123456789", "Div_serial_no": "FICTIONAL-H1", "Ex_div_date": "2025-04-28 00:00:00.0",
        "Record_date": "2025-04-29 00:00:00.0", "Payment_date": "2025-05-30 00:00:00.0", "Div_deter_date": "2025-04-29 00:00:00.0"}
    return {"Fund": {"Trust_no": "H02800", "ISIN_code": "HK2800008867", "Base_Currency": "HKD", "Fund_type": "L",
        "FundUnitClass": [{"Fund_code": 2800, "Class_currency": "HKD", "Class_ISIN_code": "HK2800008867", "Listing_date": "1999-11-12",
            "Dividends": {"Dividend": [row]}}]}}


class TrahkDividendTests(unittest.TestCase):
    def parse(self, value=None, **options):
        return parse_trahk_dividends(json.dumps(fixture() if value is None else value).encode(),
            retrieved_at=options.pop("retrieved_at", "2025-06-01T00:00:00Z"),
            start_date=options.pop("start_date", "2025-01-01"), end_date=options.pop("end_date", "2025-05-31"), **options)

    def test_exact_per_unit_hkd_amount_no_price_nav_or_auto_approval(self):
        parsed = self.parse()
        self.assertEqual(parsed["records"][0]["gross_per_unit"], "0.123456789123456789")
        self.assertEqual(parsed["records"][0]["currency"], "HKD")
        self.assertEqual(parsed["records"][0]["ex_date"], "2025-04-28")
        self.assertEqual(parsed["records"][0]["pay_date"], "2025-05-30")
        self.assertIsNone(parsed["records"][0]["published_at"])
        self.assertIsNone(parsed["records"][0]["tax_per_unit"])
        self.assertFalse(parsed["corporate_actions_complete"])
        self.assertFalse(parsed["owner_reviewed"])
        self.assertFalse(parsed["source"]["network_origin_verified_by_parser"])
        self.assertIn("ISSUER_ANNOUNCEMENT_TIME_REQUIRED", parsed["gaps"])
        self.assertIn("SPLIT_COVERAGE_REVIEW_REQUIRED", parsed["gaps"])
        self.assertNotIn("Price", json.dumps(parsed))
        self.assertNotIn("Listing_date", json.dumps(parsed))

    def test_other_currency_counter_is_not_mixed_with_hkd_distribution(self):
        body = fixture()
        alternate = {**body["Fund"]["FundUnitClass"][0], "Fund_code": 82800, "Class_currency": "RMB"}
        body["Fund"]["FundUnitClass"].append(alternate)
        self.assertEqual(self.parse(body)["source"]["selected_fund_code"], "2800")
        self.assertEqual(self.parse(body)["source"]["issuer_currency"], "HKD")

    def test_determination_date_after_ex_date_is_not_invented_publication_time(self):
        parsed = self.parse()
        self.assertEqual(parsed["records"][0]["determination_date_uninterpreted"], "2025-04-29")
        self.assertIsNone(parsed["records"][0]["published_at"])

    def test_duplicate_id_or_ex_date_is_not_silently_deduplicated(self):
        for same_id in (True, False):
            body = fixture(); row = dict(body["Fund"]["FundUnitClass"][0]["Dividends"]["Dividend"][0])
            if not same_id: row["Div_serial_no"] = "FICTIONAL-H2"
            body["Fund"]["FundUnitClass"][0]["Dividends"]["Dividend"].append(row)
            with self.subTest(same_id=same_id), self.assertRaisesRegex(WorkbenchError, "DUPLICATE"):
                self.parse(body)

    def test_wrong_identity_duplicate_class_and_empty_window_fail_closed(self):
        for key, value in (("Trust_no", "OTHER"), ("ISIN_code", "OTHER"), ("Base_Currency", "USD"), ("Fund_type", "U")):
            body = fixture(); body["Fund"][key] = value
            with self.subTest(key=key), self.assertRaises(WorkbenchError): self.parse(body)
        body = fixture(); body["Fund"]["FundUnitClass"] *= 2
        with self.assertRaises(WorkbenchError): self.parse(body)
        with self.assertRaisesRegex(WorkbenchError, "WINDOW_EMPTY"):
            self.parse(start_date="2025-05-01")

    def test_missing_ambiguous_amount_and_dates_fail_even_outside_selected_window(self):
        for key, value in (("Div", "0"), ("Div", "-1"), ("Div", "NaN"), ("Div", "1e-3"), ("Div", 0.12),
            ("Div", "0.1234567891234567891"), ("Ex_div_date", "2025-04-31"), ("Ex_div_date", "2025-04-28 00:00:01.0"),
            ("Record_date", "2025-04-27"), ("Payment_date", "2025-04-28")):
            body = fixture(); body["Fund"]["FundUnitClass"][0]["Dividends"]["Dividend"][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(WorkbenchError):
                self.parse(body, start_date="2025-05-01")

    def test_json_duplicate_nonfinite_large_deep_and_unexpected_input_reject(self):
        for raw in (b'{"Fund":{},"Fund":{}}', b'{"Fund":NaN}', b'x' * (2097152 + 1), b'', b'[' * 3000 + b']' * 3000):
            with self.subTest(size=len(raw)), self.assertRaises(WorkbenchError):
                parse_trahk_dividends(raw, retrieved_at="2025-06-01T00:00:00Z", start_date="2025-01-01", end_date="2025-05-31")
        with self.assertRaises(WorkbenchError): self.parse(end_date="2025-06-02")
        with self.assertRaises(WorkbenchError): self.parse(retrieved_at="2025-06-01")


if __name__ == "__main__":
    unittest.main()
