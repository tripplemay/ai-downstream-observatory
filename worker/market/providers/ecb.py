"""ECB reference XML, not executable FX or historical publication evidence.

The parser is pure. The caller preserves downloaded bytes and decides whether
the resulting dated reference observations are eligible for any downstream use.
"""

from datetime import date, datetime, timezone
from fractions import Fraction
from hashlib import sha256
import http.client
from ipaddress import ip_address
import re
import socket
import ssl
from time import monotonic
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

import truststore

from worker.accounting import fact_decimal
from worker.orchestration.db import WorkbenchError, instant, stamp


PARSER_VERSION = "ecb-reference-xml-v1"
MAX_BYTES = 2 * 1024 * 1024
URLS = {
    "daily": "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
    "hist_90d": "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml",
}
_HOST = "www.ecb.europa.eu"
_GESMES = "{http://www.gesmes.org/xml/2002-08-01}"
_ECB = "{http://www.ecb.int/vocabulary/2002-08-01/eurofxref}"
_CURRENCIES = frozenset(("EUR USD JPY BGN CZK DKK GBP HUF PLN RON SEK CHF ISK NOK HRK RUB TRY AUD BRL CAD CNY HKD IDR ILS INR KRW MXN MYR NZD PHP SGD THB ZAR").split())
_RATE = re.compile(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\Z", re.ASCII)
_UTC = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z\Z", re.ASCII)


def _public_connection(address, timeout, source_address=None):
    if address != (_HOST, 443) or source_address is not None:
        raise WorkbenchError("ECB_CONNECTION_TARGET_FORBIDDEN")
    deadline = monotonic() + timeout
    addresses = socket.getaddrinfo(_HOST, 443, type=socket.SOCK_STREAM)
    if not addresses or len(addresses) > 32 or any(not ip_address(item[4][0]).is_global for item in addresses):
        raise WorkbenchError("ECB_NONPUBLIC_ADDRESS_FORBIDDEN")
    # Connect to the already checked numeric address; do not resolve it again.
    for family, kind, protocol, _, endpoint in addresses:
        left = deadline - monotonic()
        if left <= 0:
            raise WorkbenchError("ECB_DOWNLOAD_TIMEOUT")
        sock = socket.socket(family, kind, protocol)
        try:
            sock.settimeout(left)
            sock.connect(endpoint)
            return sock
        except OSError:
            sock.close()
    raise WorkbenchError("ECB_DOWNLOAD_FAILED")


def _feed_url(feed):
    if not isinstance(feed, str) or feed not in URLS:
        raise WorkbenchError("ECB_UNSUPPORTED_FEED")
    return URLS[feed]


def _rate(value):
    if not isinstance(value, str) or len(value) > 58 or not _RATE.fullmatch(value):
        raise WorkbenchError("ECB_INVALID_RATE")
    try:
        number = fact_decimal(value)
    except ValueError as exc:
        raise WorkbenchError("ECB_INVALID_RATE") from exc
    if number <= 0:
        raise WorkbenchError("ECB_NONPOSITIVE_RATE")
    return number


def _cross(numerator, denominator):
    fraction = Fraction(_rate(numerator)) / Fraction(_rate(denominator))
    scaled = fraction * 10 ** 18
    integer, remainder = divmod(scaled.numerator, scaled.denominator)
    twice = remainder * 2
    if twice > scaled.denominator or twice == scaled.denominator and integer % 2:
        integer += 1
    digits = str(integer).rjust(19, "0")
    value = (digits[:-18] + "." + digits[-18:]).rstrip("0").rstrip(".")
    try:
        if fact_decimal(value) <= 0:
            raise ValueError("rounded reference rate is not positive")
    except ValueError as exc:
        raise WorkbenchError("ECB_CROSS_OUT_OF_RANGE") from exc
    return value


def _xml(raw):
    if not isinstance(raw, bytes) or not 1 <= len(raw) <= MAX_BYTES:
        raise WorkbenchError("ECB_RAW_BYTES_INVALID_OR_TOO_LARGE")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise WorkbenchError("ECB_XML_REQUIRES_UTF8") from exc
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.IGNORECASE):
        raise WorkbenchError("ECB_DTD_OR_ENTITY_FORBIDDEN")
    declarations = re.findall(r"<\?xml\s+[^?]*\?>", text, re.IGNORECASE)
    if len(declarations) > 1:
        raise WorkbenchError("ECB_INVALID_XML")
    if declarations:
        encoding = re.search(r"\bencoding\s*=\s*(['\"])([^'\"]+)\1", declarations[0], re.IGNORECASE)
        if encoding and encoding.group(2).lower() not in ("utf-8", "utf8"):
            raise WorkbenchError("ECB_XML_REQUIRES_UTF8")
    parser = ElementTree.XMLPullParser(events=("start", "end"))
    depth, count, root = 0, 0, None
    try:
        for offset in range(0, len(text), 4096):
            parser.feed(text[offset:offset + 4096])
            for event, element in parser.read_events():
                if event == "start":
                    if root is None:
                        root = element
                    depth += 1
                    count += 1
                    if depth > 4 or count > 5000:
                        raise WorkbenchError("ECB_XML_STRUCTURE_LIMIT")
                else:
                    depth -= 1
        parser.close()
    except ElementTree.ParseError as exc:
        raise WorkbenchError("ECB_INVALID_XML") from exc
    if root is None or depth:
        raise WorkbenchError("ECB_INVALID_XML")
    return root


def _container(element, tag, attributes=()):
    if (element.tag != tag or set(element.attrib) != set(attributes)
            or element.text and element.text.strip() or element.tail and element.tail.strip()):
        raise WorkbenchError("ECB_UNEXPECTED_XML_STRUCTURE")


def parse_ecb_xml(raw, *, feed, retrieved_at, currencies):
    """Parse untrusted bytes with an explicit collection instant and currencies.

    `retrieved_at` limits future dates; it is never a publication timestamp.
    It does not prove network origin, freshness, or historical PIT coverage.
    """
    url = _feed_url(feed)
    if not isinstance(retrieved_at, str) or not _UTC.fullmatch(retrieved_at):
        raise WorkbenchError("ECB_RETRIEVAL_UTC_INSTANT_REQUIRED")
    try:
        retrieved = instant(retrieved_at)
    except (ValueError, WorkbenchError) as exc:
        raise WorkbenchError("ECB_RETRIEVAL_UTC_INSTANT_REQUIRED") from exc
    if (not isinstance(currencies, (list, tuple)) or not 1 <= len(currencies) <= len(_CURRENCIES)
            or any(not isinstance(currency, str) or currency not in _CURRENCIES for currency in currencies)
            or len(set(currencies)) != len(currencies)):
        raise WorkbenchError("ECB_REQUESTED_CURRENCIES_INVALID")
    requested = sorted(currencies)
    raw_hash, root = sha256(raw).hexdigest() if isinstance(raw, bytes) else None, _xml(raw)
    _container(root, _GESMES + "Envelope")
    children = list(root)
    if [child.tag for child in children] != [_GESMES + "subject", _GESMES + "Sender", _ECB + "Cube"]:
        raise WorkbenchError("ECB_UNEXPECTED_XML_STRUCTURE")
    subject, sender, outer = children
    if subject.attrib or list(subject) or (subject.text or "").strip() != "Reference rates" or subject.tail and subject.tail.strip():
        raise WorkbenchError("ECB_UNEXPECTED_XML_STRUCTURE")
    _container(sender, _GESMES + "Sender")
    if len(sender) != 1:
        raise WorkbenchError("ECB_UNEXPECTED_XML_STRUCTURE")
    name = sender[0]
    if name.tag != _GESMES + "name" or name.attrib or list(name) or (name.text or "").strip() != "European Central Bank" or name.tail and name.tail.strip():
        raise WorkbenchError("ECB_UNEXPECTED_XML_STRUCTURE")
    _container(outer, _ECB + "Cube")
    if not 1 <= len(outer) <= (1 if feed == "daily" else 100):
        raise WorkbenchError("ECB_EMPTY_OR_UNEXPECTED_DATE_COUNT")
    records, dates = [], set()
    for day in outer:
        _container(day, _ECB + "Cube", ("time",))
        day_text = day.attrib["time"]
        try:
            parsed_date = date.fromisoformat(day_text)
        except ValueError as exc:
            raise WorkbenchError("ECB_INVALID_RATE_DATE") from exc
        if parsed_date.isoformat() != day_text or parsed_date > retrieved.astimezone(ZoneInfo("Europe/Berlin")).date():
            raise WorkbenchError("ECB_INVALID_OR_FUTURE_RATE_DATE")
        if day_text in dates:
            raise WorkbenchError("ECB_DUPLICATE_RATE_DATE")
        dates.add(day_text)
        if len(day) == 0:
            raise WorkbenchError("ECB_EMPTY_RATE_DATE")
        rates = {}
        for row in day:
            _container(row, _ECB + "Cube", ("currency", "rate"))
            if list(row):
                raise WorkbenchError("ECB_UNEXPECTED_XML_STRUCTURE")
            currency, rate = row.attrib["currency"], row.attrib["rate"]
            if currency not in _CURRENCIES or currency == "EUR":
                raise WorkbenchError("ECB_UNKNOWN_OR_UNEXPECTED_CURRENCY")
            if currency in rates:
                raise WorkbenchError("ECB_DUPLICATE_CURRENCY")
            _rate(rate)
            rates[currency] = rate
        if "CNY" not in rates or any(currency != "EUR" and currency not in rates for currency in requested):
            raise WorkbenchError("ECB_REQUIRED_CURRENCY_MISSING")
        for currency in requested:
            denominator = "1" if currency == "EUR" else rates[currency]
            records.append({"rate_date": day_text, "currency": currency,
                            "value_cny_per_unit": _cross(rates["CNY"], denominator),
                            "time_precision": "date", "published_at": None, "raw_sha256": raw_hash,
                            "cross": {"formula": "CNY_per_EUR / currency_per_EUR",
                                      "numerator": {"currency": "CNY", "rate": rates["CNY"], "implicit_eur": False},
                                      "denominator": {"currency": currency, "rate": denominator, "implicit_eur": currency == "EUR"}}})
    return {"schema_version": "ecb-reference-rates-v1", "source": {
        "provider": "ecb", "feed": feed, "url": url, "parser_version": PARSER_VERSION,
        "raw_sha256": raw_hash, "raw_bytes": len(raw), "retrieved_at": stamp(retrieved),
        "source_timezone": "Europe/Berlin", "rate_kind": "reference_not_executable", "base_currency": "EUR",
        "publication_time_status": "not_supplied", "network_origin_verified_by_parser": False,
        "freshness_status": "not_assessed", "requested_currencies": requested,
        "first_rate_date": min(dates), "last_rate_date": max(dates), "rate_date_count": len(dates),
        "rounding": {"arithmetic": "exact_rational", "method": "ROUND_HALF_EVEN", "scale": 18}},
        "records": sorted(records, key=lambda row: (row["rate_date"], row["currency"]))}


def download_ecb_xml(feed, *, timeout_seconds=15):
    """Fixed-host HTTPS only; caller stores bytes. Never supply a job clock.

    Connect/TLS/read timeouts and an elapsed transfer deadline are enforced.
    Platform DNS resolution itself is not interruptible by a socket timeout.
    """
    url = _feed_url(feed)
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, int) or not 1 <= timeout_seconds <= 30:
        raise WorkbenchError("ECB_TIMEOUT_INVALID")
    started_at = stamp(datetime.now(timezone.utc))
    deadline = monotonic() + timeout_seconds
    context = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    connection = http.client.HTTPSConnection(_HOST, port=443, timeout=timeout_seconds, context=context)
    connection._create_connection = _public_connection
    network_socket = None

    def remaining(update_socket=True):
        left = deadline - monotonic()
        if left <= 0:
            raise WorkbenchError("ECB_DOWNLOAD_TIMEOUT")
        active_socket = connection.sock if connection.sock is not None else network_socket
        if update_socket and active_socket is not None:
            active_socket.settimeout(left)
        return left

    try:
        connection.connect()
        network_socket = connection.sock
        remaining()
        connection.request("GET", url.removeprefix("https://" + _HOST), headers={
            "Accept": "application/xml, text/xml", "Accept-Encoding": "identity", "Connection": "close",
            "User-Agent": "ETF-Workbench-ECB-Reference/1"})
        remaining()
        response = connection.getresponse()
        remaining()
        if 300 <= response.status < 400:
            raise WorkbenchError("ECB_REDIRECT_FORBIDDEN")
        if response.status != 200:
            raise WorkbenchError("ECB_HTTP_STATUS_REJECTED")
        headers = response.headers
        for name in ("Content-Type", "Content-Length", "Content-Encoding", "Transfer-Encoding"):
            if len(headers.get_all(name, [])) > 1:
                raise WorkbenchError("ECB_AMBIGUOUS_HTTP_HEADERS")
        if headers.get_content_type() not in ("application/xml", "text/xml") or headers.get_content_charset("utf-8").lower() not in ("utf-8", "utf8"):
            raise WorkbenchError("ECB_HTTP_CONTENT_TYPE_REJECTED")
        if headers.get("Content-Encoding", "identity").strip().lower() != "identity":
            raise WorkbenchError("ECB_HTTP_CONTENT_ENCODING_REJECTED")
        length = headers.get("Content-Length")
        if length is not None:
            if not re.fullmatch(r"[0-9]{1,7}", length) or not 1 <= int(length) <= MAX_BYTES:
                raise WorkbenchError("ECB_HTTP_CONTENT_LENGTH_REJECTED")
            if headers.get("Transfer-Encoding") is not None:
                raise WorkbenchError("ECB_AMBIGUOUS_HTTP_HEADERS")
        if headers.get("Transfer-Encoding", "chunked").strip().lower() != "chunked":
            raise WorkbenchError("ECB_HTTP_TRANSFER_ENCODING_REJECTED")
        body = bytearray()
        while not response.isclosed():
            remaining()
            chunk = response.read1(min(65536, MAX_BYTES + 1 - len(body)))
            # HTTPResponse may close its last socket reference at EOF. There is
            # no more I/O to configure, but the elapsed deadline still applies.
            remaining(update_socket=False)
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > MAX_BYTES:
                raise WorkbenchError("ECB_DOWNLOAD_TOO_LARGE")
        if not body or length is not None and len(body) != int(length):
            raise WorkbenchError("ECB_DOWNLOAD_INCOMPLETE")
        safe_headers = {}
        for header in ("Content-Type", "Content-Length", "Date", "Last-Modified", "ETag"):
            value = headers.get(header)
            if value is not None and len(value) <= 1024 and not any(ord(char) < 32 or ord(char) == 127 for char in value):
                safe_headers[header.lower()] = value
        completed = stamp(datetime.now(timezone.utc))
        raw = bytes(body)
        return {"raw": raw, "source_url": url, "started_at": started_at, "completed_at": completed,
                "retrieved_at": completed, "http_status": 200, "headers": safe_headers,
                "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw), "redirects_followed": 0}
    except (TimeoutError, ssl.SSLError, OSError, http.client.HTTPException) as exc:
        raise WorkbenchError("ECB_DOWNLOAD_FAILED") from exc
    finally:
        connection.close()
