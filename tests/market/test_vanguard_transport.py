"""Synthetic HTTP/DNS only; never calls the real issuer in tests."""

from datetime import datetime, timezone
from hashlib import sha256
import socket
import ssl
import unittest
from unittest.mock import Mock, patch

from tests.market.test_ecb_provider import FakeResponse
from tests.market.test_vanguard_distributions import archive
from worker.market.providers import vanguard_transport as provider
from worker.market.providers.vanguard_distributions import MAX_BYTES
from worker.orchestration.db import WorkbenchError


class VanguardTransportTests(unittest.TestCase):
    def request(self, response=None, **options):
        connection = Mock(); connection.sock = Mock()
        connection.getresponse.return_value = response or FakeResponse(raw=archive(), headers=[("Content-Type", "application/json")])
        with patch.object(provider.http.client, "HTTPSConnection", return_value=connection) as constructor:
            result = provider.download_vanguard_distributions(fund_id=options.pop("fund_id", "9998"),
                has_distribution_yield=options.pop("has_distribution_yield", False), **options)
        return result, connection, constructor

    def test_fixed_https_json_exact_bytes_hash_receipt_and_no_sensitive_headers(self):
        raw = archive()
        response = FakeResponse(raw=raw, headers=[("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", str(len(raw))), ("Date", "Fri, 02 May 2025 12:00:00 GMT"),
            ("ETag", '"fictional"'), ("Set-Cookie", "not-exported"), ("Authorization", "not-exported")])
        result, connection, constructor = self.request(response, timeout_seconds=7)
        self.assertEqual(constructor.call_args.args, (provider.HOST,))
        options = constructor.call_args.kwargs
        self.assertEqual(options["port"], 443); self.assertEqual(options["timeout"], 7)
        self.assertEqual(options["context"].verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(options["context"].check_hostname)
        self.assertEqual(connection._create_connection, provider._public_connection)
        connection.connect.assert_called_once()
        connection.request.assert_called_once_with("GET",
            "/investments/products/api/funds/9998/pricing/distributions?hasDistributionYield=false",
            headers={"Accept": "application/json", "Accept-Encoding": "identity", "Connection": "close", "User-Agent": "ETF-Workbench-Issuer/1"})
        connection.close.assert_called_once()
        self.assertEqual(result["raw"], raw); self.assertEqual(result["raw_sha256"], sha256(raw).hexdigest())
        self.assertEqual(result["raw_bytes"], len(raw)); self.assertEqual(result["redirects_followed"], 0)
        self.assertEqual(result["request"], {"fund_id": "9998", "has_distribution_yield": False})
        self.assertNotIn("authorization", result["headers"]); self.assertNotIn("set-cookie", result["headers"])
        self.assertLessEqual(result["started_at"], result["completed_at"])
        self.assertEqual(result["retrieved_at"], result["completed_at"])

    def test_parameters_reject_before_any_transport_construction(self):
        for changes in ({"fund_id": "https://other.invalid"}, {"fund_id": "../x"}, {"fund_id": "9998?x=1"},
            {"fund_id": 9998}, {"has_distribution_yield": 1}, {"timeout_seconds": True},
            {"timeout_seconds": 0}, {"timeout_seconds": 31}, {"timeout_seconds": 1.5}):
            with self.subTest(changes=changes), patch.object(provider.http.client, "HTTPSConnection") as constructor:
                with self.assertRaises(WorkbenchError):
                    provider.download_vanguard_distributions(**{"fund_id": "9998", "has_distribution_yield": False, **changes})
                constructor.assert_not_called()

    def test_redirects_errors_and_rate_limits_are_not_followed_or_retried(self):
        for status in (301, 302, 307, 308, 403, 404, 429, 500, 503):
            response = FakeResponse(raw=b"untrusted-error-body", status=status, headers=[("Location", "http://127.0.0.1/")])
            connection = Mock(); connection.sock = Mock(); connection.getresponse.return_value = response
            with self.subTest(status=status), patch.object(provider.http.client, "HTTPSConnection", return_value=connection) as constructor:
                with self.assertRaises(WorkbenchError) as error:
                    provider.download_vanguard_distributions(fund_id="9998", has_distribution_yield=False)
                self.assertNotIn("untrusted-error-body", str(error.exception))
                self.assertEqual(constructor.call_count, 1); self.assertEqual(connection.request.call_count, 1)
                connection.close.assert_called_once()

    def test_mime_encoding_header_ambiguity_and_transfer_framing_fail_closed(self):
        cases = [[], [("Content-Type", "text/html")], [("Content-Type", "application/json; charset=utf-16")],
            [("Content-Type", "application/json"), ("Content-Type", "application/json")],
            [("Content-Type", "application/json"), ("Content-Encoding", "gzip")],
            [("Content-Type", "application/json"), ("Content-Encoding", "identity"), ("Content-Encoding", "identity")],
            [("Content-Type", "application/json"), ("Transfer-Encoding", "gzip")],
            [("Content-Type", "application/json"), ("Content-Length", "2"), ("Transfer-Encoding", "chunked")],
            [("Content-Type", "application/json"), ("Content-Length", "2"), ("Content-Length", "2")]]
        for headers in cases:
            with self.subTest(headers=headers), self.assertRaises(WorkbenchError):
                self.request(FakeResponse(raw=b"[]", headers=headers))

    def test_invalid_declared_lengths_and_truncated_body_do_not_return_receipts(self):
        for length in ("0", "-1", "+2", "2,2", " 2 ", "x", str(MAX_BYTES + 1), "9" * 100):
            with self.subTest(length=length), self.assertRaises(WorkbenchError):
                self.request(FakeResponse(raw=b"[]", headers=[("Content-Type", "application/json"), ("Content-Length", length)]))
        with self.assertRaisesRegex(WorkbenchError, "DOWNLOAD_INCOMPLETE"):
            self.request(FakeResponse(raw=b"[]", headers=[("Content-Type", "application/json"), ("Content-Length", "3")]))

    def test_empty_or_streaming_oversize_body_is_not_partial_success(self):
        for raw in (b"", b"x" * (MAX_BYTES + 1)):
            with self.subTest(length=len(raw)), self.assertRaises(WorkbenchError):
                self.request(FakeResponse(raw=raw, headers=[("Content-Type", "application/json")]))

    def test_trickle_body_hits_elapsed_deadline_and_closes_connection(self):
        now = [0]
        response = FakeResponse(raw=archive(), headers=[("Content-Type", "application/json")])
        original = response.read1
        def slow(limit):
            now[0] += 2
            return original(1)
        response.read1 = slow
        connection = Mock(); connection.sock = Mock(); connection.getresponse.return_value = response
        with patch.object(provider, "monotonic", side_effect=lambda: now[0]), patch.object(provider.http.client, "HTTPSConnection", return_value=connection):
            with self.assertRaisesRegex(WorkbenchError, "DOWNLOAD_TIMEOUT"):
                provider.download_vanguard_distributions(fund_id="9998", has_distribution_yield=False, timeout_seconds=3)
        connection.close.assert_called_once()

    def test_response_at_eof_checks_time_without_reusing_a_closed_socket(self):
        response = FakeResponse(raw=archive(), headers=[("Content-Type", "application/json")])
        connection = Mock(); connection.sock = Mock(); connection.getresponse.return_value = response
        original = response.read1
        def read(limit):
            result = original(limit)
            if not result:
                connection.sock = None
                network.settimeout.side_effect = OSError("closed")
            return result
        network = connection.sock; response.read1 = read
        with patch.object(provider.http.client, "HTTPSConnection", return_value=connection):
            result = provider.download_vanguard_distributions(fund_id="9998", has_distribution_yield=True)
        self.assertEqual(result["raw"], archive()); connection.close.assert_called_once()

    def test_clock_rollback_and_raw_network_errors_are_not_exposed_or_retried(self):
        with patch.object(provider, "datetime") as clock:
            clock.now.side_effect = [datetime(2025, 5, 2, 12, tzinfo=timezone.utc), datetime(2025, 5, 2, 11, tzinfo=timezone.utc)]
            with self.assertRaisesRegex(WorkbenchError, "CLOCK_INVALID"): self.request()
        connection = Mock(); connection.connect.side_effect = OSError("sensitive-native-marker")
        with patch.object(provider.http.client, "HTTPSConnection", return_value=connection):
            with self.assertRaisesRegex(WorkbenchError, "DOWNLOAD_FAILED") as error:
                provider.download_vanguard_distributions(fund_id="9998", has_distribution_yield=False)
        self.assertIsNone(error.exception.__cause__)
        self.assertNotIn("sensitive-native-marker", str(error.exception)); connection.close.assert_called_once()

    def test_oversize_or_control_character_response_metadata_is_not_exported(self):
        response = FakeResponse(raw=archive(), headers=[("Content-Type", "application/json"),
            ("ETag", "x" * 1025), ("Last-Modified", "value\nnot-exported")])
        result, _, _ = self.request(response)
        self.assertNotIn("etag", result["headers"]); self.assertNotIn("last-modified", result["headers"])


class VanguardConnectionTests(unittest.TestCase):
    def address(self, value="1.1.1.1"):
        return (socket.AF_INET, socket.SOCK_STREAM, 6, "", (value, 443))

    def test_forbidden_target_and_source_address_reject_before_dns(self):
        for target, source in ((("localhost", 443), None), ((provider.HOST, 80), None), ((provider.HOST, 443), ("127.0.0.1", 0))):
            with self.subTest(target=target), patch.object(provider.socket, "getaddrinfo") as dns:
                with self.assertRaises(WorkbenchError): provider._public_connection(target, 1, source)
                dns.assert_not_called()

    def test_mixed_nonpublic_multicast_empty_and_excessive_dns_answers_reject_before_connect(self):
        cases = [[], [self.address("127.0.0.1")], [self.address(), self.address("169.254.169.254")],
            [self.address("224.0.0.1")], [self.address()] * 33]
        for addresses in cases:
            with self.subTest(addresses=addresses), patch.object(provider.socket, "getaddrinfo", return_value=addresses), patch.object(provider.socket, "socket") as socket_:
                with self.assertRaisesRegex(WorkbenchError, "NONPUBLIC_ADDRESS"): provider._public_connection((provider.HOST, 443), 1)
                socket_.assert_not_called()

    def test_checked_numeric_address_is_used_without_a_second_resolution(self):
        connection = Mock()
        with patch.object(provider.socket, "getaddrinfo", return_value=[self.address()]) as dns, patch.object(provider.socket, "socket", return_value=connection):
            self.assertIs(provider._public_connection((provider.HOST, 443), 1), connection)
        dns.assert_called_once_with(provider.HOST, 443, type=socket.SOCK_STREAM)
        connection.connect.assert_called_once_with(("1.1.1.1", 443))

    def test_timeout_budget_and_failed_socket_close_before_any_alternate_address(self):
        connection = Mock(); connection.connect.side_effect = OSError("not exported")
        with patch.object(provider.socket, "getaddrinfo", return_value=[self.address()]), patch.object(provider.socket, "socket", return_value=connection):
            with self.assertRaisesRegex(WorkbenchError, "DOWNLOAD_FAILED"): provider._public_connection((provider.HOST, 443), 1)
        connection.close.assert_called_once()
        for timeout in (0, True, None, float("inf"), 31):
            with self.subTest(timeout=timeout), patch.object(provider.socket, "getaddrinfo") as dns:
                with self.assertRaises(WorkbenchError): provider._public_connection((provider.HOST, 443), timeout)
                dns.assert_not_called()


if __name__ == "__main__":
    unittest.main()
