"""Invented action bytes only; no network, credentials or research admission."""

import json
import unittest

from worker.market.providers.eodhd_actions import MAX_BYTES, action_url, action_window, parse_eodhd_actions
from worker.orchestration.db import WorkbenchError


AT = "2026-11-01T05:00:00.000Z"
START, END = "2025-11-01", "2026-10-31"


def dividend(amount="0.123456789123456789", **changes):
    value = {"date": "2026-07-01", "value": "__AMOUNT__", "unadjustedValue": "__AMOUNT__", "currency": "USD",
        "declarationDate": "2026-06-25", "recordDate": "2026-07-01", "paymentDate": "2026-07-07", "period": "Quarterly", **changes}
    return json.dumps(value).replace('"__AMOUNT__"', amount).encode()


def archive(*rows):
    return b"[" + b",".join(rows) + b"]"


class EodhdActionsTests(unittest.TestCase):
    def parse(self, raw=None, **changes):
        options = {"kind": "div", "symbol": "VT.US", "start_date": START, "end_date": END, "retrieved_at": AT, **changes}
        return parse_eodhd_actions(archive(dividend()) if raw is None else raw, **options)

    def test_exact_numbers_and_distinct_reported_adjusted_and_unadjusted_amounts(self):
        for raw, expected in (("0.123456789123456789", "0.123456789123456789"), ("1e-18", "0.000000000000000001"), ("1.2500", "1.25")):
            self.assertEqual(self.parse(archive(dividend(raw)))["records"][0]["value"], expected)
        result = self.parse(archive(dividend(value=2, unadjustedValue=3)))["records"][0]
        self.assertEqual((result["value"], result["unadjusted_value"]), ("2", "3"))
        self.assertIsNone(result["tax_per_unit"])

    def test_reported_dates_and_currency_do_not_certify_instants_identity_or_completeness(self):
        value = self.parse()
        for key in ("owner_reviewed", "corporate_actions_complete", "research_admitted"):
            self.assertFalse(value[key])
        self.assertFalse(value["source"]["network_origin_verified_by_parser"])
        self.assertFalse(value["source"]["instrument_identity_verified_by_payload"])
        self.assertEqual(value["records"][0]["date_precision"], "date_not_instant")
        self.assertIsNone(value["records"][0]["published_at"])
        self.assertEqual(value["records"][0]["declaration_date"], "2026-06-25")

    def test_absent_optional_reported_fields_remain_unknown(self):
        row = json.loads(dividend())
        for field in ("declarationDate", "recordDate", "paymentDate", "period"):
            del row[field]
        result = self.parse(json.dumps([row]).encode())["records"][0]
        self.assertTrue(all(result[field] is None for field in ("declaration_date", "record_date", "payment_date", "reported_period")))

    def test_empty_dividends_and_splits_are_valid_drafts_not_absence_proof(self):
        for kind in ("div", "splits"):
            value = self.parse(b"[]", kind=kind)
            self.assertEqual(value["records"], [])
            self.assertTrue(value["empty_is_not_absence_proof"])
            self.assertFalse(value["corporate_actions_complete"])

    def test_split_ratio_is_exact_and_its_economic_direction_unverified(self):
        value = self.parse(b'[{"date":"2026-07-01","split":"3.5/2"}]', kind="splits")["records"][0]
        self.assertEqual((value["numerator"], value["denominator"]), ("3.5", "2"))
        self.assertEqual(value["ratio_direction"], "provider_reported_not_issuer_verified")

    def test_corrections_keep_identity_but_duplicate_dates_are_not_added_together(self):
        first, corrected = self.parse(archive(dividend("1"))), self.parse(archive(dividend("2")))
        self.assertEqual(first["records"][0]["derived_event_key"], corrected["records"][0]["derived_event_key"])
        self.assertNotEqual(first["source"]["raw_sha256"], corrected["source"]["raw_sha256"])
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_EVENT"):
            self.parse(archive(dividend("1"), dividend("2")))

    def test_nonfinite_strings_bools_negative_excess_precision_and_oversize_reject(self):
        for token in ('"1.25"', "true", "null", "-1", "NaN", "Infinity", "1e-19", "1e38", "1e999999999", "1" * 81):
            with self.subTest(token=token), self.assertRaises(WorkbenchError):
                self.parse(archive(dividend(token)))
        with self.assertRaises(WorkbenchError):
            self.parse(b" " * (MAX_BYTES + 1))

    def test_duplicate_json_unknown_authority_fields_and_malformed_dates_reject(self):
        for raw in (b'[{"date":"2026-07-01","date":"2026-07-02","split":"1/2"}]',
                b'[{"date":"2026-02-30","split":"1/2"}]', b'[{"date":"2026-07-01","split":"1/0"}]',
                b'[{"date":"2026-07-01","split":"1/2","approved":true}]'):
            with self.assertRaises(WorkbenchError):
                self.parse(raw, kind="splits")
        for changes in ({"date": "2025-10-31"}, {"date": "2026-11-01"}, {"currency": "usd"}, {"paymentDate": "2026-2-01"}, {"execute_trade": True}):
            with self.assertRaises(WorkbenchError):
                self.parse(archive(dividend(**changes)))

    def test_window_is_exact_prior_new_york_day_including_leap_day_and_repeated_hour(self):
        self.assertEqual(action_window("2026-11-01T05:00:00.000Z"), (START, END))
        self.assertEqual(action_window("2026-11-01T06:00:00.000Z"), (START, END))
        self.assertEqual(action_window("2024-03-01T05:00:00.000Z"), ("2023-03-02", "2024-02-29"))
        self.assertEqual(action_window("2027-01-01T00:30:00.000Z"), ("2025-12-31", "2026-12-30"))
        for changes in ({"start_date": "2025-10-31"}, {"retrieved_at": "2026-10-31T05:00:00.000Z"}, {"end_date": "2026-11-01"}):
            with self.assertRaises(WorkbenchError):
                self.parse(**changes)

    def test_targets_are_closed_and_provenance_has_no_credential_argument(self):
        for kind, symbol in (("div", "VTI.US"), ("prices", "VT.US"), ("splits", "VT.US/other")):
            with self.assertRaises(WorkbenchError):
                action_url(kind, symbol, START, END)
        self.assertNotIn("api_token", action_url("div", "VT.US", START, END))
        with self.assertRaises(TypeError):
            action_url("div", "VT.US", START, END, token="FICTIONAL-NOT-A-TOKEN")


if __name__ == "__main__":
    unittest.main()
