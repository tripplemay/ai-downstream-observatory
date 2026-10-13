"""Fictional disclosure metadata; no network calls or live fund documents."""

import copy
from hashlib import sha256
import json
import unittest

from worker.market.providers.sse_announcements import SQL_ID, parse_announcement_pages
from worker.orchestration.db import WorkbenchError


def row(number=0, title="Fictional distribution notice"):
    return {"SSEDATE": "2025-05-30", "SECURITY_CODE": "510999", "TITLE": title,
        "URL": "/disclosure/fund/announcement/c/new/2025-05-30/510999_FICTIONAL_" + str(number) + ".pdf"}


def fixture(rows=None, page_number=1, total=None):
    values = [row()] if rows is None else rows
    count = len(values) if total is None else total
    return {"sqlId": SQL_ID, "isPagination": "true", "fieldErrors": {}, "actionErrors": [], "jsonCallBack": None,
        "pageHelp": {"pageNo": page_number, "pageSize": 100, "pageCount": max(1, (count + 99) // 100),
            "total": count, "data": values}, "result": values}


class AnnouncementIndexTests(unittest.TestCase):
    def parse(self, bodies=None, **options):
        return parse_announcement_pages([json.dumps(value).encode() for value in (bodies or [fixture()])],
            symbol=options.pop("symbol", "510999"), start_date=options.pop("start_date", "2025-01-01"),
            end_date=options.pop("end_date", "2025-05-31"), retrieved_at=options.pop("retrieved_at", "2025-06-01T00:00:00Z"), **options)

    def test_hashes_and_complete_pages_never_auto_approve_actions(self):
        body = fixture(); result = self.parse([body])
        self.assertEqual(result["source"]["pages"][0]["raw_sha256"], sha256(json.dumps(body).encode()).hexdigest())
        self.assertTrue(result["pagination_complete"])
        self.assertFalse(result["corporate_actions_complete"])
        self.assertFalse(result["owner_reviewed"])
        self.assertFalse(result["research_admitted"])
        self.assertFalse(result["source"]["request_parameters_verified_by_parser"])
        self.assertFalse(result["source"]["document_identity_verified_by_parser"])
        self.assertIn("DOCUMENT_IDENTITY_REVIEW", result["gaps"])
        self.assertEqual(result["records"][0]["publication_date"], "2025-05-30")
        self.assertNotIn("published_at", result["records"][0])

    def test_two_pages_and_zero_row_index_are_valid(self):
        result = self.parse([fixture([row(i) for i in range(100)], total=101), fixture([row(100)], page_number=2, total=101)])
        self.assertEqual(result["source"]["record_count"], 101)
        self.assertEqual(self.parse([fixture([])])["records"], [])

    def test_titles_only_identify_review_candidates_not_amounts_or_events(self):
        result = self.parse([fixture([row(title="Fictional \u5206\u7ea2\u53ca\u4efd\u989d\u6298\u7b97\u505c\u724c\u8d39\u7387 notice")])])
        self.assertEqual(result["records"][0]["candidate_categories"],
            ["distribution", "unit_adjustment", "trading_status", "product_change"])
        self.assertNotIn("events", result)

    def test_primary_creation_unit_changes_are_not_secondary_lot_or_split_facts(self):
        result = self.parse([fixture([row(title="Fictional \u6700\u5c0f\u7533\u8d2d\u5355\u4f4d\u63d0\u793a\u6027\u516c\u544a")])])
        self.assertEqual(result["records"][0]["candidate_categories"], ["primary_market_change", "other_material_notice"])
        self.assertNotIn("quantity_step", result["records"][0])
        self.assertNotIn("unit_adjustment", result["records"][0]["candidate_categories"])

    def test_identity_and_index_cost_changes_are_selected_for_review(self):
        for words in ("\u53d8\u66f4\u57fa\u91d1\u7b80\u79f0", "\u53d8\u66f4\u6269\u4f4d\u8bc1\u5238\u7b80\u79f0", "\u6307\u6570\u4f7f\u7528\u8d39"):
            with self.subTest(words=words):
                result = self.parse([fixture([row(title="Fictional " + words)])])
                self.assertIn("product_change", result["records"][0]["candidate_categories"])

    def test_matching_index_symbol_does_not_certify_document_identity(self):
        body = fixture([row(title="Fictional OTHER FUND contract")])
        result = self.parse([body])
        self.assertEqual(result["schema_version"], "sse-fund-announcement-index-v2")
        self.assertEqual(result["records"][0]["symbol"], "510999.SH")
        self.assertFalse(result["source"]["document_identity_verified_by_parser"])
        self.assertFalse(result["research_admitted"])
        self.assertIn("DOCUMENT_IDENTITY_REVIEW", result["gaps"])

    def test_missing_extra_out_of_order_and_changed_total_pages_reject(self):
        first = fixture([row(i) for i in range(100)], total=101)
        second = fixture([row(100)], page_number=2, total=101)
        changed = copy.deepcopy(second); changed["pageHelp"]["total"] = 102
        for bodies in ([first], [first, second, second], [second, first], [first, changed]):
            with self.subTest(pages=len(bodies)), self.assertRaises(WorkbenchError):
                self.parse(bodies)

    def test_server_error_wrong_query_and_callback_are_rejected(self):
        for key, value in (("fieldErrors", {"query": "bad"}), ("actionErrors", ["bad"]),
            ("sqlId", "OTHER"), ("jsonCallBack", "callback"), ("isPagination", False)):
            body = fixture(); body[key] = value
            with self.subTest(key=key), self.assertRaises(WorkbenchError): self.parse([body])

    def test_noninteger_pagination_and_row_count_disagreement_reject(self):
        for key, value in (("total", True), ("total", 2001), ("pageNo", True), ("pageNo", 2),
            ("pageSize", 10), ("pageCount", True), ("total", 2)):
            body = fixture(); body["pageHelp"][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(WorkbenchError): self.parse([body])
        body = fixture(); body["pageHelp"]["data"] = []
        with self.assertRaises(WorkbenchError): self.parse([body])

    def test_duplicate_url_and_descending_date_order_are_checked(self):
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE"):
            self.parse([fixture([row(), row()])])
        first, second = row(), row(1); first["SSEDATE"] = "2025-05-29"
        with self.assertRaises(WorkbenchError): self.parse([fixture([first, second])])

    def test_wrong_symbol_offsite_path_html_and_noncanonical_urls_reject(self):
        for key, value in (("SECURITY_CODE", "510998"), ("URL", "https://example.invalid/notice.pdf"),
            ("URL", "/disclosure/fund/announcement/c/new/2025-05-30/510998_F.pdf"),
            ("URL", "/disclosure/fund/announcement/c/new/2025-05-30/510999_F.html"),
            ("URL", "/disclosure/fund/announcement/c/new/2025-02-30/510999_F.pdf"),
            ("TITLE", " "), ("TITLE", "Fictional\nnotice"), ("TITLE", "x" * 1001)):
            value_row = row(); value_row[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(WorkbenchError):
                self.parse([fixture([value_row])])

    def test_dates_symbol_and_future_windows_reject(self):
        for options in ({"symbol": "510999.SH"}, {"symbol": "510999&other=1"}, {"start_date": "20250501"},
            {"end_date": "2025-06-02"}, {"start_date": "2010-01-01"}, {"start_date": "2025-06-01"},
            {"retrieved_at": "2025-06-01"}):
            with self.subTest(options=options), self.assertRaises(WorkbenchError): self.parse(**options)
        with self.assertRaises(WorkbenchError): self.parse(start_date="2025-05-31")

    def test_duplicate_keys_constants_nonbytes_and_resource_limits_reject(self):
        options = {"symbol": "510999", "start_date": "2025-01-01", "end_date": "2025-05-31",
            "retrieved_at": "2025-06-01T00:00:00Z"}
        for pages in ([b'{"a":1,"a":2}'], [b'{"a":NaN}'], [b'[' * 2000 + b']' * 2000],
            [b'x' * (4194304 + 1)], ["not bytes"], [], [json.dumps(fixture()).encode()] * 21):
            with self.subTest(pages=len(pages)), self.assertRaises(WorkbenchError):
                parse_announcement_pages(pages, **options)


if __name__ == "__main__":
    unittest.main()
