"""One fixed-host authenticated HTTPS read; secret never enters the receipt."""

from datetime import datetime, timezone
from hashlib import sha256
import http.client
from ipaddress import ip_address
import math
import re
import socket
import ssl
from time import monotonic
from urllib.parse import urlencode

import truststore

from worker.orchestration.db import WorkbenchError, instant, stamp
from .eodhd_actions import HOST, MAX_BYTES, action_url


VERSION = "eodhd-fixed-actions-https-v1"


def _error(code):
    return WorkbenchError("EODHD_TRANSPORT_" + code)


def check_token(token):
    if type(token) is not str or token == "demo" or re.fullmatch(r"[A-Za-z0-9_.-]{16,512}", token, re.ASCII) is None:
        raise _error("TOKEN_REQUIRED")


def _public_connection(address, timeout, source_address=None):
    if address != (HOST, 443) or source_address is not None:
        raise _error("CONNECTION_TARGET_FORBIDDEN")
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 30:
        raise _error("TIMEOUT_INVALID")
    deadline = monotonic() + timeout
    addresses = socket.getaddrinfo(HOST, 443, type=socket.SOCK_STREAM)
    if not addresses or len(addresses) > 32 or any(not ip_address(item[4][0]).is_global
            or ip_address(item[4][0]).is_multicast for item in addresses):
        raise _error("NONPUBLIC_ADDRESS_FORBIDDEN")
    for family, kind, protocol, _, endpoint in addresses:
        left = deadline - monotonic()
        if left <= 0:
            raise _error("DOWNLOAD_TIMEOUT")
        connection = socket.socket(family, kind, protocol)
        try:
            connection.settimeout(left)
            connection.connect(endpoint)
            return connection
        except OSError:
            connection.close()
    raise _error("DOWNLOAD_FAILED")


def download_eodhd_actions(*, kind, symbol, start_date, end_date, token, timeout_seconds=15):
    url = action_url(kind, symbol, start_date, end_date)
    check_token(token)
    if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= 30:
        raise _error("TIMEOUT_INVALID")
    started = stamp(datetime.now(timezone.utc))
    deadline = monotonic() + timeout_seconds
    context = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    connection = http.client.HTTPSConnection(HOST, port=443, timeout=timeout_seconds, context=context)
    connection._create_connection = _public_connection
    network_socket = None

    def remaining(update_socket=True):
        left = deadline - monotonic()
        if left <= 0:
            raise _error("DOWNLOAD_TIMEOUT")
        active = connection.sock if connection.sock is not None else network_socket
        if update_socket and active is not None:
            active.settimeout(left)

    try:
        connection.connect()
        network_socket = connection.sock
        remaining()
        path = url.removeprefix("https://" + HOST) + "&" + urlencode({"api_token": token})
        connection.request("GET", path, headers={"Accept": "application/json", "Accept-Encoding": "identity",
            "Connection": "close", "User-Agent": "ETF-Workbench-Action-Draft/1"})
        remaining()
        response = connection.getresponse()
        remaining()
        if 300 <= response.status < 400:
            raise _error("REDIRECT_FORBIDDEN")
        if response.status != 200:
            category = {401: "HTTP_UNAUTHORIZED", 403: "HTTP_FORBIDDEN", 404: "HTTP_NOT_FOUND", 429: "HTTP_RATE_LIMITED"}.get(response.status)
            if category:
                raise _error(category)
            raise _error("HTTP_UNAVAILABLE" if 500 <= response.status < 600 else "HTTP_STATUS_REJECTED")
        headers = response.headers
        for name in ("Content-Type", "Content-Length", "Content-Encoding", "Transfer-Encoding"):
            if len(headers.get_all(name, [])) > 1:
                raise _error("AMBIGUOUS_HTTP_HEADERS")
        if headers.get_content_type() != "application/json" or headers.get_content_charset("utf-8").lower() not in ("utf-8", "utf8"):
            raise _error("HTTP_CONTENT_TYPE_REJECTED")
        if headers.get("Content-Encoding", "identity").strip().lower() != "identity":
            raise _error("HTTP_CONTENT_ENCODING_REJECTED")
        length = headers.get("Content-Length")
        if length is not None:
            if not re.fullmatch(r"[0-9]{1,7}", length) or not 1 <= int(length) <= MAX_BYTES:
                raise _error("HTTP_CONTENT_LENGTH_REJECTED")
            if headers.get("Transfer-Encoding") is not None:
                raise _error("AMBIGUOUS_HTTP_HEADERS")
        if headers.get("Transfer-Encoding", "chunked").strip().lower() != "chunked":
            raise _error("HTTP_TRANSFER_ENCODING_REJECTED")
        body = bytearray()
        while not response.isclosed():
            remaining()
            chunk = response.read1(min(65536, MAX_BYTES + 1 - len(body)))
            remaining(update_socket=False)
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > MAX_BYTES:
                raise _error("DOWNLOAD_TOO_LARGE")
        if not body or length is not None and len(body) != int(length):
            raise _error("DOWNLOAD_INCOMPLETE")
        raw = bytes(body)
        if token.encode("ascii") in raw:
            raise _error("REFLECTED_CREDENTIAL_REJECTED")
        completed = stamp(datetime.now(timezone.utc))
        if instant(completed) < instant(started):
            raise _error("CLOCK_INVALID")
        return {"schema_version": VERSION, "raw": raw, "url_without_credentials": url,
            "request": {"kind": kind, "symbol": symbol, "start_date": start_date, "end_date": end_date},
            "started_at": started, "completed_at": completed, "retrieved_at": completed, "http_status": 200,
            "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw), "redirects_followed": 0,
            "response_format": "utf8_json_identity", "credential_in_receipt": False}
    except (TimeoutError, ssl.SSLError, OSError, http.client.HTTPException):
        raise _error("DOWNLOAD_FAILED") from None
    finally:
        connection.close()
