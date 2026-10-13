"""Fictional history and HTTP responses only; never requests real FX in CI."""

from datetime import date, timedelta
from hashlib import sha256
import unittest
from unittest.mock import Mock, patch

from tests.market.test_ecb_provider import FakeResponse, xml
from worker.market.providers import ecb
from worker.market.providers.ecb_history import build_fx_drafts, parse_history_xml
from worker.orchestration.db import WorkbenchError
from worker.investor.data_evidence import validate_facts


RETRIEVED = "2025-06-06T17:30:00Z"
RATES = [("CNY", "8"), ("USD", "2"), ("HKD", "10")]


class HistoryParseTests(unittest.TestCase):
    def parse(self, raw=None, **kwargs):
        return parse_history_xml(xml() if raw is None else raw, retrieved_at=kwargs.pop("retrieved_at", RETRIEVED),
            currencies=kwargs.pop("currencies", ["USD", "HKD"]),
            start_date=kwargs.pop("start_date", "2025-06-06"), end_date=kwargs.pop("end_date", "2025-06-06"), **kwargs)

    def test_full_archive_keeps_original_hash_and_explicit_window_not_90_day_label(self):
        raw = xml([("1999-01-04", [("USD", "2"), ("EEK", "16")]),
            ("2025-06-06", RATES), ("2025-06-05", RATES)])
        parsed = self.parse(raw, start_date="2025-06-05")
        self.assertEqual(parsed["schema_version"], "ecb-history-reference-v1")
        self.assertEqual(parsed["source"]["feed"], "full_history")
        self.assertEqual(parsed["source"]["url"], ecb.HISTORY_URL)
        self.assertEqual(parsed["source"]["raw_sha256"], sha256(raw).hexdigest())
        self.assertEqual(parsed["source"]["archive_date_count"], 3)
        self.assertEqual(parsed["source"]["selected_date_count"], 2)
        self.assertEqual([row["rate_date"] for row in parsed["records"]], ["2025-06-05"] * 2 + ["2025-06-06"] * 2)
        self.assertEqual({row["currency"]: row["value_cny_per_unit"] for row in parsed["records"]}, {"USD": "4", "HKD": "0.8"})
        self.assertFalse(parsed["source"]["network_origin_verified_by_parser"])
        self.assertEqual(parsed["source"]["publication_time_status"], "not_supplied")
        self.assertEqual(parsed["source"]["rate_kind"], "reference_not_executable")

    def test_history_beyond_100_dates_is_separate_from_legacy_parser(self):
        days = [((date(2025, 1, 1) + timedelta(days=i)).isoformat(), RATES) for i in range(150)]
        raw = xml(days)
        parsed = self.parse(raw, start_date="2025-01-01", end_date="2025-05-30")
        self.assertEqual(parsed["source"]["selected_date_count"], 150)
        with self.assertRaises(WorkbenchError):
            ecb.parse_ecb_xml(raw, feed="hist_90d", retrieved_at=RETRIEVED, currencies=["USD"])
        with self.assertRaisesRegex(WorkbenchError, "UNSUPPORTED_FEED"):
            ecb.parse_ecb_xml(raw, feed="full_history", retrieved_at=RETRIEVED, currencies=["USD"])

    def test_drafts_are_existing_review_facts_with_conservative_next_local_day_availability(self):
        raw = xml([("2025-03-28", RATES), ("2025-03-31", RATES)])
        drafts = build_fx_drafts(raw, retrieved_at=RETRIEVED, currencies=["USD", "HKD"],
            start_date="2025-03-28", end_date="2025-03-31")
        usd = drafts["facts"]["USD"]
        self.assertEqual([row["observed_at"] for row in usd["rows"]], ["2025-03-27T23:00:00.000Z", "2025-03-30T22:00:00.000Z"])
        self.assertEqual([row["assumed_available_at"] for row in usd["rows"]], ["2025-03-28T23:00:00.000Z", "2025-03-31T22:00:00.000Z"])
        for currency, facts in drafts["facts"].items():
            validate_facts("fx", facts)
            self.assertEqual(facts["currency"], currency)
        self.assertFalse(drafts["owner_reviewed"])
        self.assertFalse(drafts["production_admitted"])
        self.assertNotIn("decision", drafts)
        self.assertEqual(set(drafts["source_document"]), {"title", "reference", "excerpt"})
        self.assertIn("date anchor", drafts["source_document"]["excerpt"])
        self.assertIn(sha256(raw).hexdigest(), drafts["source_document"]["excerpt"])

    def test_gaps_are_not_filled_and_selected_missing_legs_fail_closed(self):
        raw = xml([("2025-06-06", RATES), ("2025-06-04", RATES)])
        parsed = self.parse(raw, start_date="2025-06-04")
        self.assertEqual(parsed["source"]["selected_date_count"], 2)
        self.assertNotIn("2025-06-05", [row["rate_date"] for row in parsed["records"]])
        for rates in ([('USD', '2'), ('HKD', '10')], [('CNY', '8'), ('USD', '2')]):
            with self.subTest(rates=rates), self.assertRaisesRegex(WorkbenchError, "REQUIRED_CURRENCY_MISSING"):
                self.parse(xml([("2025-06-06", rates)]))

    def test_empty_future_and_overlong_windows_and_bad_currencies_reject(self):
        for args in ({"start_date": "2025-06-07"}, {"end_date": "2025-06-07"},
            {"start_date": "2010-01-01"}, {"start_date": "20250606"}, {"start_date": None},
            {"currencies": ["EUR"]}, {"currencies": ["USD", "USD"]}, {"currencies": "USD"},
            {"retrieved_at": "2025-06-06"}):
            with self.subTest(args=args), self.assertRaises(WorkbenchError):
                self.parse(**args)
        with self.assertRaisesRegex(WorkbenchError, "HISTORY_WINDOW_EMPTY"):
            self.parse(xml([("2025-06-05", RATES)]))

    def test_unselected_rows_still_validate_dates_rates_duplicates_and_structure(self):
        cases = [xml([("1999-01-04", [('USD', '0')]), ("2025-06-06", RATES)]),
            xml([("1999-01-04", [('USD', '2'), ('USD', '2')]), ("2025-06-06", RATES)]),
            xml([("1999-01-04", [('XYZ', '2')]), ("2025-06-06", RATES)]),
            xml([("1999-01-04", [('EUR', '1')]), ("2025-06-06", RATES)]),
            xml([("2025-06-07", RATES), ("2025-06-06", RATES)]),
            xml([("1999-01-04", []), ("2025-06-06", RATES)]),
            xml([("1999-01-04", RATES), ("1999-01-04", RATES), ("2025-06-06", RATES)])]
        for raw in cases:
            with self.subTest(raw=raw[:50]), self.assertRaises(WorkbenchError):
                self.parse(raw)

    def test_xml_security_limits_are_not_bypassed_by_history_mode(self):
        cases = [b"<!DOCTYPE x [<!ENTITY y SYSTEM 'file:///not-read'>]>" + xml(),
            xml().replace(b"encoding='UTF-8'", b"encoding='utf-16'"),
            xml().replace(b"<Cube time=", b"<Unknown time="),
            xml().replace(b"European Central Bank", b"Untrusted sender"),
            b"<x>" * 20 + b"</x>" * 20, b"", b"x" * (ecb.HISTORY_MAX_BYTES + 1), "not bytes"]
        for raw in cases:
            with self.subTest(raw=str(raw)[:60]), self.assertRaises(WorkbenchError):
                self.parse(raw)

    def test_history_date_node_and_currency_count_budgets_fail_closed(self):
        raw = xml([((date(1990, 1, 1) + timedelta(days=i)).isoformat(), RATES) for i in range(10001)])
        with self.assertRaisesRegex(WorkbenchError, "UNEXPECTED_DATE_COUNT"):
            self.parse(raw)
        with patch("worker.market.providers.ecb_history.MAX_NODES", 5):
            with self.assertRaisesRegex(WorkbenchError, "XML_STRUCTURE_LIMIT"):
                self.parse()
        with self.assertRaisesRegex(WorkbenchError, "UNEXPECTED_CURRENCY_COUNT"):
            self.parse(xml([("2025-06-06", RATES * 22)]))


class HistoryTransportTests(unittest.TestCase):
    def request(self, response):
        connection = Mock()
        connection.sock = Mock()
        connection.getresponse.return_value = response
        with patch("worker.market.providers.ecb.http.client.HTTPSConnection", return_value=connection):
            result = ecb.download_ecb_history_xml()
        return result, connection

    def test_full_fixed_download_uses_verified_transport_with_separate_size_budget(self):
        raw = b"x" * (ecb.MAX_BYTES + 1)
        result, connection = self.request(FakeResponse(raw=raw))
        self.assertEqual(result["raw"], raw)
        self.assertEqual(result["source_url"], ecb.HISTORY_URL)
        self.assertEqual(connection.request.call_args.args, ("GET", "/stats/eurofxref/eurofxref-hist.xml"))
        self.assertEqual(connection._create_connection, ecb._public_connection)
        connection.close.assert_called_once()

    def test_full_transport_keeps_redirect_encoding_mime_size_and_timeout_limits(self):
        for response in (FakeResponse(status=302), FakeResponse(headers=(("Content-Type", "text/html"),)),
            FakeResponse(headers=(("Content-Type", "text/xml"), ("Content-Encoding", "gzip"))),
            FakeResponse(headers=(("Content-Type", "text/xml"), ("Content-Length", str(ecb.HISTORY_MAX_BYTES + 1)))),
            FakeResponse(raw=b"x" * (ecb.HISTORY_MAX_BYTES + 1))):
            with self.subTest(response=response), self.assertRaises(WorkbenchError):
                self.request(response)
        with patch("worker.market.providers.ecb.http.client.HTTPSConnection") as connection:
            with self.assertRaises(WorkbenchError):
                ecb.download_ecb_history_xml(timeout_seconds=31)
            connection.assert_not_called()

    def test_legacy_download_does_not_gain_history_size_or_endpoint(self):
        connection = Mock()
        connection.sock = Mock()
        connection.getresponse.return_value = FakeResponse(raw=b"x" * (ecb.MAX_BYTES + 1))
        with patch("worker.market.providers.ecb.http.client.HTTPSConnection", return_value=connection):
            with self.assertRaisesRegex(WorkbenchError, "DOWNLOAD_TOO_LARGE"):
                ecb.download_ecb_xml("hist_90d")
        with patch("worker.market.providers.ecb.http.client.HTTPSConnection") as connection:
            with self.assertRaisesRegex(WorkbenchError, "UNSUPPORTED_FEED"):
                ecb.download_ecb_xml("full_history")
            connection.assert_not_called()


if __name__ == "__main__":
    unittest.main()
