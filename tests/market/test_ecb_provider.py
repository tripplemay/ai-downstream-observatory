"""Canned synthetic XML/HTTP only: no CI network requests or real rate fixtures."""

from decimal import localcontext
from email.message import Message
from hashlib import sha256
from io import BytesIO
import ssl
import unittest
from unittest.mock import Mock, patch

from worker.market.providers.ecb import MAX_BYTES, PARSER_VERSION, URLS, download_ecb_xml, parse_ecb_xml
from worker.orchestration.db import WorkbenchError


RETRIEVED = "2025-06-06T17:30:00Z"


def xml(days=None):
    days = days if days is not None else [("2025-06-06", [("CNY", "8.0000"), ("USD", "1.25"), ("HKD", "10.0")])]
    body = "".join("<Cube time='" + day + "'>" + "".join("<Cube currency='" + currency + "' rate='" + rate + "'/>" for currency, rate in rates) + "</Cube>"
                   for day, rates in days)
    return ("<?xml version='1.0' encoding='UTF-8'?>"
            "<gesmes:Envelope xmlns:gesmes='http://www.gesmes.org/xml/2002-08-01' xmlns='http://www.ecb.int/vocabulary/2002-08-01/eurofxref'>"
            "<gesmes:subject>Reference rates</gesmes:subject><gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender>"
            "<Cube>" + body + "</Cube></gesmes:Envelope>").encode("utf-8")


class ParseEcbTests(unittest.TestCase):
    def parse(self, raw=None, **kwargs):
        return parse_ecb_xml(xml() if raw is None else raw, feed=kwargs.pop("feed", "daily"),
                             retrieved_at=kwargs.pop("retrieved_at", RETRIEVED), currencies=kwargs.pop("currencies", ("USD", "HKD", "EUR", "CNY")), **kwargs)

    def test_exact_eur_cross_preserves_both_original_legs_and_bytes_hash(self):
        raw = xml()
        result = self.parse(raw)
        self.assertEqual(result["schema_version"], "ecb-reference-rates-v1")
        self.assertEqual(result["source"]["parser_version"], PARSER_VERSION)
        values = {row["currency"]: row for row in result["records"]}
        self.assertEqual({key: row["value_cny_per_unit"] for key, row in values.items()}, {"CNY": "1", "EUR": "8", "HKD": "0.8", "USD": "6.4"})
        self.assertEqual(values["USD"]["cross"]["numerator"], {"currency": "CNY", "rate": "8.0000", "implicit_eur": False})
        self.assertEqual(values["USD"]["cross"]["denominator"], {"currency": "USD", "rate": "1.25", "implicit_eur": False})
        self.assertEqual(values["EUR"]["cross"]["denominator"], {"currency": "EUR", "rate": "1", "implicit_eur": True})
        self.assertEqual(values["CNY"]["cross"]["numerator"], values["CNY"]["cross"]["denominator"])
        for record in result["records"]:
            self.assertEqual(record["raw_sha256"], sha256(raw).hexdigest())
            self.assertEqual(record["rate_date"], "2025-06-06")
            self.assertIsNone(record["published_at"])
            self.assertEqual(record["time_precision"], "date")

    def test_history_is_sorted_deterministic_and_never_synthesizes_publication_time(self):
        raw = xml([("2025-06-06", [("CNY", "8"), ("USD", "2")]), ("2025-06-05", [("USD", "4"), ("CNY", "8")])])
        result = self.parse(raw, feed="hist_90d", currencies=("USD", "EUR"))
        self.assertEqual([row["rate_date"] for row in result["records"]], ["2025-06-05", "2025-06-05", "2025-06-06", "2025-06-06"])
        self.assertEqual(result, self.parse(raw, feed="hist_90d", currencies=("EUR", "USD")))
        self.assertEqual(result["source"]["publication_time_status"], "not_supplied")
        self.assertEqual(result["source"]["freshness_status"], "not_assessed")
        self.assertFalse(result["source"]["network_origin_verified_by_parser"])
        self.assertEqual(result["source"]["rate_kind"], "reference_not_executable")
        self.assertEqual(result["source"]["source_timezone"], "Europe/Berlin")
        self.assertEqual(result["source"]["rate_date_count"], 2)

    def test_rounding_is_exact_half_even_at_18_not_float_or_ambient_decimal_context(self):
        cases = [("1", "7", "0.142857142857142857"),
                 ("1.000000000000000001", "2", "0.5"),
                 ("1.000000000000000003", "2", "0.500000000000000002")]
        with localcontext() as context:
            context.prec = 6
            for cny, usd, expected in cases:
                with self.subTest(cny=cny):
                    result = self.parse(xml([("2025-06-06", [("CNY", cny), ("USD", usd)])]), currencies=("USD",))
                    self.assertEqual(result["records"][0]["value_cny_per_unit"], expected)
                    self.assertEqual(result["source"]["rounding"], {"arithmetic": "exact_rational", "method": "ROUND_HALF_EVEN", "scale": 18})

    def test_requested_currency_is_required_explicit_unique_and_known(self):
        with self.assertRaises(TypeError):
            parse_ecb_xml(xml(), feed="daily", retrieved_at=RETRIEVED)
        for value in ([], (), "USD", ["usd"], ["XXX"], ["USD", "USD"], [True], [1.2], None):
            with self.subTest(value=value), self.assertRaisesRegex(WorkbenchError, "REQUESTED_CURRENCIES"):
                self.parse(currencies=value)

    def test_cny_or_requested_leg_missing_blocks_whole_document_without_zero(self):
        for rates in ([('USD', '2')], [('CNY', '8')]):
            with self.subTest(rates=rates), self.assertRaisesRegex(WorkbenchError, "REQUIRED_CURRENCY_MISSING"):
                self.parse(xml([("2025-06-06", rates)]), currencies=("USD",))
        raw = xml([("2025-06-06", [("CNY", "8"), ("USD", "2")]), ("2025-06-05", [("CNY", "8")])])
        with self.assertRaisesRegex(WorkbenchError, "REQUIRED_CURRENCY_MISSING"):
            self.parse(raw, feed="hist_90d", currencies=("USD",))

    def test_invalid_rates_are_rejected_even_when_currency_not_requested(self):
        for rate in ("0", "-1", "+1", "1e2", "NaN", "Infinity", "", " 1", "01", "1,2", "9" * 39, "0." + "1" * 19):
            with self.subTest(rate=rate), self.assertRaises(WorkbenchError):
                self.parse(xml([("2025-06-06", [("CNY", "8"), ("USD", rate)])]), currencies=("EUR",))

    def test_unknown_currency_or_explicit_eur_and_duplicate_currency_fail_closed(self):
        for rate in ([('CNY', '8'), ('XYZ', '1')], [('CNY', '8'), ('EUR', '1')], [('CNY', '8'), ('CNY', '8')]):
            with self.subTest(rate=rate), self.assertRaises(WorkbenchError):
                self.parse(xml([("2025-06-06", rate)]), currencies=("EUR",))

    def test_nonpositive_rounded_cross_and_overflow_are_not_clamped(self):
        for cny, usd in (("0.000000000000000001", "9" * 38), ("9" * 38, "0.000000000000000001")):
            with self.subTest(cny=cny), self.assertRaisesRegex(WorkbenchError, "CROSS_OUT_OF_RANGE"):
                self.parse(xml([("2025-06-06", [("CNY", cny), ("USD", usd)])]), currencies=("USD",))

    def test_duplicate_empty_daily_multi_day_or_excessive_history_fail_closed(self):
        day = ("2025-06-06", [("CNY", "8")])
        cases = [(xml([]), "daily"), (xml([day, day]), "hist_90d"), (xml([day, day]), "daily"),
                 (xml([("2025-06-06", [])]), "daily"), (xml([day] * 101), "hist_90d")]
        for raw, feed in cases:
            with self.subTest(feed=feed, size=len(raw)), self.assertRaises(WorkbenchError):
                self.parse(raw, feed=feed, currencies=("EUR",))

    def test_future_bad_dates_and_non_utc_retrieval_are_rejected(self):
        for day in ("2025-06-07", "2025-02-30", "20250606", "0000-01-01"):
            with self.subTest(day=day), self.assertRaises(WorkbenchError):
                self.parse(xml([(day, [("CNY", "8")])]), currencies=("EUR",))
        for at in ("2025-06-06", "2025-06-06T17:30:00+00:00", "2025-02-30T00:00:00Z", "2025-06-06T17:30:00.1234567Z", None):
            with self.subTest(at=at), self.assertRaises(WorkbenchError):
                self.parse(retrieved_at=at)

    def test_raw_hash_is_bytes_not_normalized_xml_and_bom_is_preserved(self):
        raw = b"\xef\xbb\xbf" + xml().replace(b"/><", b"/>\r\n<")
        result = self.parse(raw)
        self.assertEqual(result["source"]["raw_sha256"], sha256(raw).hexdigest())
        self.assertEqual(result["source"]["raw_bytes"], len(raw))
        self.assertNotEqual(result["source"]["raw_sha256"], self.parse()["source"]["raw_sha256"])

    def test_xml_dtd_entities_encoding_depth_and_unknown_structure_are_rejected(self):
        cases = [b"<!DOCTYPE foo [<!ENTITY secret SYSTEM 'file:///not-read'>]>" + xml(),
                 b"<!ENTITY x 'amplification'>" + xml(), xml().decode().encode("utf-16"),
                 xml().replace(b"encoding='UTF-8'", b"encoding='ISO-8859-1'"),
                 xml().replace(b"<Cube time=", b"<Unknown time="),
                 xml().replace(b"currency='USD' rate='1.25'/>", b"currency='USD' rate='1.25'><Cube/></Cube>"),
                 xml().replace(b"European Central Bank", b"Untrusted sender"), b"<x>" * 10 + b"</x>" * 10,
                 xml().replace(b"<Cube time=", b"<Cube unexpected='1' time="),
                 xml()[:-10], b"", b"x" * (MAX_BYTES + 1), "not bytes"]
        for raw in cases:
            with self.subTest(sample=str(raw)[:80]), self.assertRaises(WorkbenchError):
                self.parse(raw)

    def test_arbitrary_url_is_not_accepted_as_feed(self):
        for feed in ("https://example.test/data.xml", "../daily", "daily?redirect=1", [], None):
            with self.subTest(feed=feed), self.assertRaisesRegex(WorkbenchError, "UNSUPPORTED_FEED"):
                self.parse(feed=feed)


class FakeResponse:
    def __init__(self, raw=None, status=200, headers=None):
        self.body = BytesIO(xml() if raw is None else raw)
        self.status = status
        self.headers = Message()
        for name, value in headers if headers is not None else (("Content-Type", "text/xml; charset=UTF-8"),):
            self.headers[name] = value

    def read1(self, limit):
        return self.body.read(limit)

    def isclosed(self):
        return False


class DownloadEcbTests(unittest.TestCase):
    def request(self, response=None, **kwargs):
        connection = Mock()
        connection.sock = Mock()
        connection.getresponse.return_value = response or FakeResponse()
        with patch("worker.market.providers.ecb.http.client.HTTPSConnection", return_value=connection) as constructor:
            result = download_ecb_xml(kwargs.pop("feed", "daily"), **kwargs)
        return result, connection, constructor

    def test_download_uses_only_fixed_verified_https_and_no_sensitive_header_export(self):
        response = FakeResponse(headers=(("Content-Type", "application/xml"), ("Content-Length", str(len(xml()))),
                                         ("Date", "Fri, 06 Jun 2025 16:00:00 GMT"), ("Last-Modified", "Fri, 06 Jun 2025 15:00:00 GMT"),
                                         ("ETag", '"synthetic"'), ("Set-Cookie", "untrusted-secret-not-exported")))
        result, connection, constructor = self.request(response, feed="hist_90d", timeout_seconds=7)
        args, kwargs = constructor.call_args
        self.assertEqual(args, ("www.ecb.europa.eu",))
        self.assertEqual(kwargs["port"], 443)
        self.assertEqual(kwargs["timeout"], 7)
        self.assertTrue(kwargs["context"].check_hostname)
        self.assertEqual(kwargs["context"].verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(connection.request.call_args.args, ("GET", "/stats/eurofxref/eurofxref-hist-90d.xml"))
        self.assertEqual(connection.request.call_args.kwargs["headers"]["Accept-Encoding"], "identity")
        self.assertEqual(result["source_url"], URLS["hist_90d"])
        self.assertEqual(result["raw"], xml())
        self.assertEqual(result["raw_sha256"], sha256(xml()).hexdigest())
        self.assertEqual(result["raw_bytes"], len(xml()))
        self.assertEqual(result["redirects_followed"], 0)
        self.assertEqual(result["retrieved_at"], result["completed_at"])
        self.assertNotIn("set-cookie", result["headers"])
        self.assertNotIn("published_at", result)
        connection.close.assert_called_once()
        self.assertGreater(connection.sock.settimeout.call_count, 1)

    def test_all_redirects_and_non_200_are_rejected_not_followed(self):
        for status in (301, 302, 303, 307, 308, 204, 304, 404, 429, 500):
            with self.subTest(status=status), self.assertRaises(WorkbenchError):
                self.request(FakeResponse(status=status, headers=(("Location", "https://untrusted.invalid/"),)))

    def test_wrong_mime_encoding_ambiguous_and_oversize_headers_fail_closed(self):
        cases = [(("Content-Type", "text/html"),), (("Content-Type", "text/xml; charset=utf-16"),),
                 (("Content-Type", "text/xml"), ("Content-Encoding", "gzip")),
                 (("Content-Type", "text/xml"), ("Content-Length", str(MAX_BYTES + 1))),
                 (("Content-Type", "text/xml"), ("Content-Length", "garbage")),
                 (("Content-Type", "text/xml"), ("Content-Length", "9" * 5000)),
                 (("Content-Type", "text/xml"), ("Content-Length", "0")),
                 (("Content-Type", "text/xml"), ("Content-Length", "1"), ("Content-Length", "1")),
                 (("Content-Type", "text/xml"), ("Content-Length", "1"), ("Transfer-Encoding", "chunked")),
                 (("Content-Type", "text/xml"), ("Transfer-Encoding", "gzip")),
                 (("Content-Type", "text/xml"), ("Content-Type", "text/html"))]
        for headers in cases:
            with self.subTest(headers=headers), self.assertRaises(WorkbenchError):
                self.request(FakeResponse(headers=headers))

    def test_stream_size_empty_or_truncated_body_is_rejected(self):
        cases = [FakeResponse(raw=b"x" * (MAX_BYTES + 1)), FakeResponse(raw=b""),
                 FakeResponse(raw=b"short", headers=(("Content-Type", "text/xml"), ("Content-Length", "100")))]
        for response in cases:
            with self.subTest(response=response), self.assertRaises(WorkbenchError):
                self.request(response)

    def test_request_feed_and_timeout_are_validated_before_network(self):
        for kwargs in ({"feed": "https://other.invalid"}, {"timeout_seconds": 0}, {"timeout_seconds": 31},
                       {"timeout_seconds": 1.2}, {"timeout_seconds": True}):
            with self.subTest(kwargs=kwargs), patch("worker.market.providers.ecb.http.client.HTTPSConnection") as constructor:
                with self.assertRaises(WorkbenchError):
                    download_ecb_xml(kwargs.get("feed", "daily"), **{key: value for key, value in kwargs.items() if key != "feed"})
                constructor.assert_not_called()

    def test_network_errors_close_connection_without_exporting_raw_exception(self):
        for exception in (TimeoutError("synthetic private network detail"), OSError("synthetic network detail"), ssl.SSLError("synthetic tls failure")):
            connection = Mock()
            connection.connect.side_effect = exception
            with patch("worker.market.providers.ecb.http.client.HTTPSConnection", return_value=connection):
                with self.assertRaisesRegex(WorkbenchError, "^ECB_DOWNLOAD_FAILED$"):
                    download_ecb_xml("daily")
                connection.close.assert_called_once()

    def test_elapsed_transfer_deadline_rejects_trickle_response(self):
        with patch("worker.market.providers.ecb.monotonic", side_effect=(0, 1, 2, 3, 4, 16)):
            with self.assertRaisesRegex(WorkbenchError, "ECB_DOWNLOAD_TIMEOUT"):
                self.request(timeout_seconds=15)


if __name__ == "__main__":
    unittest.main()
