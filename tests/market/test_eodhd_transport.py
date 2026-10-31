"""Invented HTTP/DNS and credential marker only; no live provider calls."""

from datetime import datetime, timezone
from hashlib import sha256
import json
import socket
import ssl
import unittest
from unittest.mock import Mock, patch

from tests.market.test_ecb_provider import FakeResponse
from worker.market.providers import eodhd_transport as provider
from worker.market.providers.eodhd_actions import MAX_BYTES
from worker.orchestration.db import WorkbenchError


TOKEN = "FICTIONAL-EODHD-TEST-TOKEN-NOT-REAL"
OPTIONS = {"kind": "div", "symbol": "VT.US", "start_date": "2025-11-01", "end_date": "2026-10-31", "token": TOKEN}


class EodhdTransportTests(unittest.TestCase):
    def request(self, response=None, **changes):
        connection = Mock(); connection.sock = Mock()
        connection.getresponse.return_value = response or FakeResponse(raw=b"[]", headers=[("Content-Type", "application/json")])
        with patch.object(provider.http.client, "HTTPSConnection", return_value=connection) as constructor:
            result = provider.download_eodhd_actions(**{**OPTIONS, **changes})
        return result, connection, constructor

    def test_exact_fixed_https_request_and_credential_free_receipt(self):
        response = FakeResponse(raw=b"[]", headers=[("Content-Type", "application/json; charset=utf-8"), ("Content-Length", "2"),
            ("ETag", TOKEN), ("Set-Cookie", TOKEN), ("Authorization", TOKEN)])
        result, connection, constructor = self.request(response, timeout_seconds=7)
        self.assertEqual(constructor.call_args.args, (provider.HOST,))
        options = constructor.call_args.kwargs
        self.assertEqual((options["port"], options["timeout"]), (443, 7))
        self.assertEqual(options["context"].verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(options["context"].check_hostname)
        self.assertEqual(connection._create_connection, provider._public_connection)
        connection.request.assert_called_once_with("GET", "/api/div/VT.US?fmt=json&from=2025-11-01&to=2026-10-31&api_token=" + TOKEN,
            headers={"Accept": "application/json", "Accept-Encoding": "identity", "Connection": "close", "User-Agent": "ETF-Workbench-Action-Draft/1"})
        self.assertEqual(result["raw"], b"[]")
        self.assertEqual(result["raw_sha256"], sha256(b"[]").hexdigest())
        self.assertNotIn(TOKEN, json.dumps({key: value for key, value in result.items() if key != "raw"}))
        self.assertNotIn("headers", result)
        self.assertFalse(result["credential_in_receipt"])
        connection.close.assert_called_once()

    def test_invalid_targets_tokens_timeout_and_range_precede_connection(self):
        for changes in ({"symbol": "VTI.US"}, {"symbol": "VT.US?x=1"}, {"kind": "eod"}, {"token": "demo"}, {"token": ""},
                {"token": TOKEN + "\n"}, {"token": "https://other.invalid/"}, {"timeout_seconds": True}, {"timeout_seconds": 31}, {"start_date": "2025-10-31"}):
            with self.subTest(changes=changes), patch.object(provider.http.client, "HTTPSConnection") as constructor:
                with self.assertRaises(WorkbenchError):
                    provider.download_eodhd_actions(**{**OPTIONS, **changes})
                constructor.assert_not_called()

    def test_redirect_auth_forbidden_rate_limit_and_server_errors_never_read_or_retry(self):
        for status, code in ((301, "REDIRECT_FORBIDDEN"), (307, "REDIRECT_FORBIDDEN"), (401, "HTTP_UNAUTHORIZED"), (403, "HTTP_FORBIDDEN"),
                (404, "HTTP_NOT_FOUND"), (429, "HTTP_RATE_LIMITED"), (503, "HTTP_UNAVAILABLE"), (418, "HTTP_STATUS_REJECTED")):
            response = FakeResponse(raw=TOKEN.encode(), status=status, headers=[("Location", "https://other.invalid/" + TOKEN)])
            response.read1 = Mock(side_effect=AssertionError("ERROR_BODY_MUST_NOT_BE_READ"))
            with self.subTest(status=status), self.assertRaisesRegex(WorkbenchError, "^EODHD_TRANSPORT_" + code + "$"):
                self.request(response)
            response.read1.assert_not_called()

    def test_ambiguous_mime_encoding_length_and_transfer_framing_reject(self):
        for headers in ([], [("Content-Type", "text/html")], [("Content-Type", "application/json; charset=utf-16")],
                [("Content-Type", "application/json"), ("Content-Type", "application/json")],
                [("Content-Type", "application/json"), ("Content-Encoding", "gzip")],
                [("Content-Type", "application/json"), ("Transfer-Encoding", "gzip")],
                [("Content-Type", "application/json"), ("Content-Length", "2"), ("Transfer-Encoding", "chunked")],
                [("Content-Type", "application/json"), ("Content-Length", "2"), ("Content-Length", "2")]):
            with self.subTest(headers=headers), self.assertRaises(WorkbenchError):
                self.request(FakeResponse(raw=b"[]", headers=headers))

    def test_invalid_size_truncated_stream_and_reflected_token_reject(self):
        for length in ("0", "-1", "+2", " 2 ", "2,2", str(MAX_BYTES + 1), "9" * 100):
            with self.subTest(length=length), self.assertRaises(WorkbenchError):
                self.request(FakeResponse(raw=b"[]", headers=[("Content-Type", "application/json"), ("Content-Length", length)]))
        with self.assertRaisesRegex(WorkbenchError, "DOWNLOAD_INCOMPLETE"):
            self.request(FakeResponse(raw=b"[]", headers=[("Content-Type", "application/json"), ("Content-Length", "3")]))
        for raw, code in ((b"", "DOWNLOAD_INCOMPLETE"), (b"x" * (MAX_BYTES + 1), "DOWNLOAD_TOO_LARGE"), (TOKEN.encode(), "REFLECTED_CREDENTIAL_REJECTED")):
            with self.subTest(code=code), self.assertRaisesRegex(WorkbenchError, code):
                self.request(FakeResponse(raw=raw, headers=[("Content-Type", "application/json")]))

    def test_trickle_timeout_clock_rollback_and_native_errors_are_fixed(self):
        now = [0]
        response = FakeResponse(raw=b"[]", headers=[("Content-Type", "application/json")])
        read = response.read1
        def slow(limit):
            now[0] += 2
            return read(1)
        response.read1 = slow
        with patch.object(provider, "monotonic", side_effect=lambda: now[0]), self.assertRaisesRegex(WorkbenchError, "DOWNLOAD_TIMEOUT"):
            self.request(response, timeout_seconds=3)
        with patch.object(provider, "datetime") as clock:
            clock.now.side_effect = [datetime(2026, 11, 1, 5, tzinfo=timezone.utc), datetime(2026, 11, 1, 4, tzinfo=timezone.utc)]
            with self.assertRaisesRegex(WorkbenchError, "CLOCK_INVALID"):
                self.request()
        connection = Mock(); connection.connect.side_effect = OSError(TOKEN)
        with patch.object(provider.http.client, "HTTPSConnection", return_value=connection), self.assertRaisesRegex(WorkbenchError, "^EODHD_TRANSPORT_DOWNLOAD_FAILED$") as error:
            provider.download_eodhd_actions(**OPTIONS)
        self.assertIsNone(error.exception.__cause__)
        self.assertNotIn(TOKEN, str(error.exception)); connection.close.assert_called_once()


class EodhdConnectionTests(unittest.TestCase):
    def address(self, value="1.1.1.1"):
        return (socket.AF_INET, socket.SOCK_STREAM, 6, "", (value, 443))

    def test_forbidden_target_source_or_timeout_precedes_dns(self):
        for address, timeout, source in ((("localhost", 443), 1, None), ((provider.HOST, 80), 1, None),
                ((provider.HOST, 443), 1, ("127.0.0.1", 0)), ((provider.HOST, 443), True, None), ((provider.HOST, 443), float("inf"), None)):
            with patch.object(provider.socket, "getaddrinfo") as dns, self.assertRaises(WorkbenchError):
                provider._public_connection(address, timeout, source)
            dns.assert_not_called()

    def test_mixed_nonpublic_or_multicast_answers_reject_before_socket(self):
        for addresses in ([], [self.address("127.0.0.1")], [self.address(), self.address("169.254.169.254")], [self.address("224.0.0.1")], [self.address()] * 33):
            with patch.object(provider.socket, "getaddrinfo", return_value=addresses), patch.object(provider.socket, "socket") as socket_, self.assertRaisesRegex(WorkbenchError, "NONPUBLIC_ADDRESS"):
                provider._public_connection((provider.HOST, 443), 1)
            socket_.assert_not_called()

    def test_checked_address_is_used_without_second_resolution(self):
        connection = Mock()
        with patch.object(provider.socket, "getaddrinfo", return_value=[self.address()]) as dns, patch.object(provider.socket, "socket", return_value=connection):
            self.assertIs(provider._public_connection((provider.HOST, 443), 1), connection)
        dns.assert_called_once_with(provider.HOST, 443, type=socket.SOCK_STREAM)
        connection.connect.assert_called_once_with(("1.1.1.1", 443))


if __name__ == "__main__":
    unittest.main()
