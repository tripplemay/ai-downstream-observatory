"""Complete paginated disclosure index, not a corporate-action certification."""

from datetime import date
from hashlib import sha256
import json
import re
from zoneinfo import ZoneInfo

from worker.orchestration.db import WorkbenchError, instant, stamp


PARSER_VERSION = "sse-fund-announcement-index-v2"
QUERY_URL = "https://query.sse.com.cn/commonQuery.do"
REFERENCE_PAGE = "https://www.sse.com.cn/disclosure/fund/announcement/"
SQL_ID = "COMMON_PL_JJXX_JJGG_NEW_L"
PAGE_SIZE = 100
MAX_ROWS = 2000
MAX_PAGE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
_CATEGORIES = {
    "distribution": ("\u5206\u7ea2", "\u6536\u76ca\u5206\u914d"),
    "unit_adjustment": ("\u6298\u7b97", "\u62c6\u5206", "\u5408\u5e76", "\u4efd\u989d\u8c03\u6574"),
    "trading_status": ("\u505c\u724c", "\u590d\u724c", "\u6682\u505c\u4ea4\u6613", "\u7ec8\u6b62\u4e0a\u5e02"),
    "product_change": (
        "\u8f6c\u578b", "\u66f4\u540d", "\u540d\u79f0\u53d8\u66f4", "\u8d39\u7387", "\u7ba1\u7406\u8d39", "\u6258\u7ba1\u8d39",
        "\u6307\u6570\u4f7f\u7528\u8d39", "\u53d8\u66f4\u57fa\u91d1\u7b80\u79f0", "\u53d8\u66f4\u6269\u4f4d\u8bc1\u5238\u7b80\u79f0",
    ),
    "primary_market_change": (
        "\u6700\u5c0f\u7533\u8d2d", "\u7533\u8d2d\u66ff\u4ee3\u91d1\u989d", "\u6682\u505c\u9ec4\u91d1\u73b0\u8d27\u5408\u7ea6\u7533\u8d2d",
    ),
    "other_material_notice": ("\u63d0\u793a\u6027\u516c\u544a",),
}


def _check(value, code="SSE_ANNOUNCEMENT_INDEX_INVALID"):
    if not value:
        raise WorkbenchError(code)


def _day(value):
    _check(type(value) is str and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value))
    return date.fromisoformat(value)


def _object(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            _check(key not in value)
            value[key] = item
        return value
    _check(type(raw) is bytes and 0 < len(raw) <= MAX_PAGE_BYTES)
    value = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=pairs,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    _check(type(value) is dict)
    stack, count = [(value, 0)], 0
    while stack:
        item, depth = stack.pop(); count += 1
        _check(count <= 20000 and depth <= 12)
        if type(item) is dict:
            stack.extend((child, depth + 1) for child in item.values())
        elif type(item) is list:
            stack.extend((child, depth + 1) for child in item)
    return value


def parse_announcement_pages(pages, *, symbol, start_date, end_date, retrieved_at):
    """Require every page; title matches only select documents for human review."""
    try:
        _check(type(symbol) is str and re.fullmatch(r"5[0-9]{5}", symbol))
        _check(type(retrieved_at) is str and re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z", retrieved_at))
        received = instant(retrieved_at)
        start, end = _day(start_date), _day(end_date)
        _check(0 <= (end - start).days < 3660 and end <= received.astimezone(ZoneInfo("Asia/Shanghai")).date())
        _check(type(pages) is list and 1 <= len(pages) <= MAX_ROWS // PAGE_SIZE
            and all(type(raw) is bytes for raw in pages) and sum(map(len, pages)) <= MAX_TOTAL_BYTES)
        records, hashes, total, unique = [], [], None, set()
        for page_number, raw in enumerate(pages, 1):
            body = _object(raw); help_ = body.get("pageHelp")
            _check(body.get("sqlId") == SQL_ID and body.get("isPagination") == "true"
                and body.get("fieldErrors") == {} and body.get("actionErrors") == []
                and body.get("jsonCallBack") is None and type(help_) is dict)
            count = help_.get("total")
            _check(type(count) is int and 0 <= count <= MAX_ROWS)
            if total is None:
                total = count
            expected_pages = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
            _check(count == total and type(help_.get("pageNo")) is int and help_["pageNo"] == page_number
                and type(help_.get("pageSize")) is int and help_["pageSize"] == PAGE_SIZE
                and type(help_.get("pageCount")) is int and help_["pageCount"] == expected_pages
                and len(pages) == expected_pages, "SSE_ANNOUNCEMENT_PAGINATION_INCOMPLETE")
            rows = body.get("result")
            _check(type(rows) is list and rows == help_.get("data")
                and len(rows) == min(PAGE_SIZE, total - (page_number - 1) * PAGE_SIZE))
            for row in rows:
                _check(type(row) is dict and row.get("SECURITY_CODE") == symbol)
                published = _day(row.get("SSEDATE"))
                _check(start <= published <= end)
                title, relative = row.get("TITLE"), row.get("URL")
                _check(type(title) is str and 0 < len(title.strip()) <= 1000
                    and not any(ord(char) < 32 for char in title))
                _check(type(relative) is str and re.fullmatch(
                    r"/disclosure/fund/announcement/c/new/[0-9]{4}-[0-9]{2}-[0-9]{2}/"
                    + symbol + r"_[A-Za-z0-9_]+\.pdf", relative))
                _day(relative.split("/")[-2])
                _check(relative not in unique, "SSE_ANNOUNCEMENT_DUPLICATE")
                unique.add(relative)
                records.append({"symbol": symbol + ".SH", "publication_date": published.isoformat(),
                    "title": title, "url": "https://www.sse.com.cn" + relative,
                    "candidate_categories": [name for name, words in _CATEGORIES.items() if any(word in title for word in words)]})
            hashes.append({"page_number": page_number, "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw)})
        _check(len(records) == total and [row["publication_date"] for row in records]
            == sorted((row["publication_date"] for row in records), reverse=True))
        return {"schema_version": PARSER_VERSION, "source": {"provider": "sse_disclosure", "query_url": QUERY_URL,
            "reference_page": REFERENCE_PAGE, "sql_id": SQL_ID, "title_filter": "", "symbol": symbol,
            "range_start": start_date, "range_end": end_date, "retrieved_at": stamp(received),
            "record_count": total, "pages": hashes, "network_origin_verified_by_parser": False,
            "request_parameters_verified_by_parser": False, "document_identity_verified_by_parser": False}, "records": records,
            "pagination_complete": True, "corporate_actions_complete": False, "owner_reviewed": False,
            "research_admitted": False, "gaps": ["INDEX_FILTER_AND_COVERAGE_REVIEW", "DOCUMENT_CONTENT_REVIEW",
                "DOCUMENT_IDENTITY_REVIEW", "ANNOUNCEMENT_DATE_NOT_PUBLICATION_INSTANT", "CURRENT_OWNER_ACTION_REVIEW"]}
    except WorkbenchError:
        raise
    except Exception:
        raise WorkbenchError("SSE_ANNOUNCEMENT_INDEX_INVALID") from None
