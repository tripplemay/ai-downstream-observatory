"""Synthetic resolver/socket tests; never contact an external host in CI."""

import socket
import http.client
import unittest
from unittest.mock import Mock, patch

from worker.market.providers.ecb import _public_connection, download_ecb_xml
from worker.orchestration.db import WorkbenchError
from tests.market.test_ecb_provider import xml


class ProviderAddressTests(unittest.TestCase):
    def test_real_http_response_eof_closes_socket_without_losing_complete_body(self):
        body = xml()
        for framing in (b"Content-Length: " + str(len(body)).encode() + b"\r\n", b""):
            with self.subTest(framing=bool(framing)):
                client, server = socket.socketpair()
                self.addCleanup(client.close)
                self.addCleanup(server.close)
                server.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nConnection: close\r\n" + framing + b"\r\n" + body)
                server.close()
                connection = Mock(sock=client)

                def response():
                    result = http.client.HTTPResponse(client)
                    result.begin()
                    connection.sock = None
                    client.close()
                    return result

                connection.getresponse.side_effect = response
                with patch("worker.market.providers.ecb.http.client.HTTPSConnection", return_value=connection):
                    result = download_ecb_xml("daily")
                self.assertEqual(result["raw"], body)
                self.assertEqual(client.fileno(), -1)

    def test_fixed_target_and_public_address_required_before_socket(self):
        with patch("worker.market.providers.ecb.socket.socket") as create:
            for address in (("fixture.invalid", 443), ("www.ecb.europa.eu", 80)):
                with self.assertRaisesRegex(WorkbenchError, "TARGET_FORBIDDEN"):
                    _public_connection(address, 1)
            for ip in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fd00::1", "0.0.0.0"):
                rows = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))]
                with patch("worker.market.providers.ecb.socket.getaddrinfo", return_value=rows):
                    with self.assertRaisesRegex(WorkbenchError, "NONPUBLIC"):
                        _public_connection(("www.ecb.europa.eu", 443), 1)
            create.assert_not_called()

    def test_connection_pins_checked_numeric_address_without_second_dns(self):
        rows = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        fake = Mock()
        with patch("worker.market.providers.ecb.socket.getaddrinfo", return_value=rows) as resolve:
            with patch("worker.market.providers.ecb.socket.socket", return_value=fake):
                self.assertIs(_public_connection(("www.ecb.europa.eu", 443), 1), fake)
        resolve.assert_called_once_with("www.ecb.europa.eu", 443, type=socket.SOCK_STREAM)
        fake.connect.assert_called_once_with(("8.8.8.8", 443))
        self.assertGreater(fake.settimeout.call_args.args[0], 0)

    def test_any_private_dns_answer_blocks_mixed_answer_set(self):
        rows = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ("8.8.8.8", "127.0.0.1")]
        with patch("worker.market.providers.ecb.socket.getaddrinfo", return_value=rows):
            with patch("worker.market.providers.ecb.socket.socket") as create:
                with self.assertRaisesRegex(WorkbenchError, "NONPUBLIC"):
                    _public_connection(("www.ecb.europa.eu", 443), 1)
                create.assert_not_called()

    def test_failed_socket_is_closed_and_original_error_is_not_exposed(self):
        rows = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        fake = Mock()
        fake.connect.side_effect = OSError("synthetic-private-error-marker")
        with patch("worker.market.providers.ecb.socket.getaddrinfo", return_value=rows):
            with patch("worker.market.providers.ecb.socket.socket", return_value=fake):
                with self.assertRaisesRegex(WorkbenchError, "^ECB_DOWNLOAD_FAILED$"):
                    _public_connection(("www.ecb.europa.eu", 443), 1)
        fake.close.assert_called_once()
