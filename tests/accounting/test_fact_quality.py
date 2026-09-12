from copy import deepcopy
from datetime import datetime, timezone
import unittest

from worker.accounting import CurrencyBalance, available_cash, nav_cny
from worker.accounting.fact_quality import dividend_obligation, evaluate_fact_quality
from worker.orchestration.db import canonical_json, content_hash


START = "2025-01-01T00:00:00.000000Z"
END = "2025-01-10T00:00:00.000000Z"


def event(identity, kind, at="2025-01-02T00:00:00.000000Z", revision=1, recorded=START, **fields):
    fact = {"type": kind, "account_id": "a", "currency": "CNY", **fields}
    command = {"portfolio_id": "p", "fact": fact, "effective_at": at, "time_precision": "second",
               "source_timezone": "UTC", "source_id": "verified", "idempotency_key": identity,
               "expected_revision": revision - 1, "reason": "retained-source"}
    row = {"id": identity, "portfolio_id": "p", "account_id": "a", "event_type": kind, "effective_at": at,
           "time_precision": "second", "source_timezone": "UTC", "recorded_at": recorded,
           "source_id": "verified", "source_event_id": None, "reversal_of": None, "ledger_revision": revision}
    return rehash(row, command)


def rehash(row, command):
    row["payload_json"] = canonical_json(command)
    row["payload_hash"] = content_hash({key: value for key, value in command.items() if key not in ("expected_revision", "idempotency_key")})
    return row


def dated(row, kind=None):
    import json
    command = json.loads(row["payload_json"])
    row.update(effective_at="2025-01-02", time_precision="date", source_timezone="Asia/Shanghai")
    command.update({key: row[key] for key in ("effective_at", "time_precision", "source_timezone")})
    return rehash(row, command)


class FactQualityTests(unittest.TestCase):
    def proof(self, events, cutoff=END, mode="restated", start=None):
        return evaluate_fact_quality(events, "p", max([item["ledger_revision"] for item in events] + [0]), cutoff, END, mode, start)

    def test_final_net_preserves_nav_and_only_blocks_attribution(self):
        proof = self.proof([event("net", "dividend_net", amount="180", net_status="final")])
        self.assertEqual([proof[key] for key in ("nav_quality", "performance_quality", "attribution_quality")],
                         ["complete", "complete", "provisional"])
        self.assertIsNone(proof["dividends"][0]["gross_amount"])
        self.assertIsNone(proof["dividends"][0]["recognized_tax"])
        self.assertEqual(nav_cny({"CNY": CurrencyBalance("180")}, [], {}).nav_cny, 180)

    def test_unknown_is_not_final_zero_tax_and_assessment_clears_receivable(self):
        root = event("gross", "dividend_accrual", amount="200", tax_status="unknown")
        payment = event("payment", "dividend_payment", revision=2, related_event_id="gross", amount="180")
        before = self.proof([root, payment])
        self.assertEqual(before["nav_quality"], "provisional")
        self.assertEqual(before["dividends"][0]["receivable"], "20")
        self.assertIsNone(before["dividends"][0]["recognized_tax"])
        assessment = event("tax", "dividend_tax_assessment", revision=3, related_event_id="gross", tax="20", tax_status="confirmed")
        after = self.proof([root, payment, assessment])
        self.assertEqual(after["nav_quality"], "complete")
        self.assertEqual(after["dividends"][0]["cash_received"], "180")
        self.assertEqual(after["dividends"][0]["receivable"], "0")

    def test_provisional_net_breakdown_needs_confirmed_assessment_even_zero_delta(self):
        root = event("net", "dividend_net", amount="180", net_status="provisional")
        breakdown = event("breakdown", "dividend_breakdown", revision=2, related_event_id="net", gross_amount="200", tax="20")
        self.assertEqual(self.proof([root, breakdown])["nav_quality"], "provisional")
        assessment = event("confirm", "dividend_tax_assessment", revision=3, related_event_id="net", tax="20", tax_status="confirmed")
        self.assertEqual(self.proof([root, breakdown, assessment])["nav_quality"], "complete")
        estimate = event("estimate", "dividend_tax_assessment", revision=4, related_event_id="net", tax="20", tax_status="estimated")
        self.assertEqual(self.proof([root, breakdown, assessment, estimate])["nav_quality"], "provisional")

    def test_final_net_breakdown_changes_classification_not_cash(self):
        root = event("net", "dividend_net", amount="180", net_status="final")
        breakdown = event("breakdown", "dividend_breakdown", revision=2, related_event_id="net", gross_amount="200", tax="20")
        proof = self.proof([root, breakdown])
        self.assertEqual(proof["attribution_quality"], "complete")
        self.assertEqual(proof["dividends"][0]["cash_received"], "180")

    def test_signed_tax_payable_is_deducted_exactly_once(self):
        balance = CurrencyBalance(settled_cash="180", dividend_tax_payable="-5")
        self.assertEqual(balance.net_assets, 175)
        self.assertEqual(nav_cny({"CNY": balance}, [], {}).nav_cny, 175)
        self.assertEqual(available_cash(balance), 175)
        with self.assertRaisesRegex(ValueError, "dividend_tax_payable_positive"):
            CurrencyBalance(dividend_tax_payable="5")
        self.assertEqual(dividend_obligation("200", "25", "180"), (0, -5))
        self.assertEqual(dividend_obligation("200", "20", "175"), (5, 0))

    def test_estimate_actual_receipt_assess_taxpay_and_refund_are_distinct(self):
        rows = [event("gross", "dividend_accrual", amount="200", tax="30", tax_status="estimated"),
                event("paid", "dividend_payment", revision=2, related_event_id="gross", amount="180")]
        self.assertEqual(self.proof(rows)["dividends"][0]["tax_payable"], "-10")
        for kind, fields in [("dividend_tax_assessment", {"tax": "25", "tax_status": "confirmed"}),
                             ("dividend_tax_payment", {"amount": "5"}),
                             ("dividend_tax_assessment", {"tax": "20", "tax_status": "confirmed"}),
                             ("dividend_payment", {"amount": "5"})]:
            rows.append(event(str(len(rows)), kind, revision=len(rows) + 1, related_event_id="gross", **fields))
        state = self.proof(rows)["dividends"][0]
        self.assertEqual((state["cash_received"], state["receivable"], state["tax_payable"]), ("180", "0", "0"))

    def test_legacy_explicit_tax_is_confirmed_but_missing_tax_is_unknown(self):
        self.assertEqual(self.proof([event("old", "dividend", amount="200", tax="0")])["nav_quality"], "complete")
        self.assertEqual(self.proof([event("old", "dividend", amount="200")])["nav_quality"], "provisional")

    def test_notice_is_independent_of_holdings_and_resolution_needs_valid_support(self):
        notice = event("notice", "corporate_action_notice", action_kind="merger", listing_id="l")
        self.assertEqual(self.proof([notice])["nav_quality"], "blocked")
        support = event("split", "split", revision=2, listing_id="l")
        resolution = event("resolve", "corporate_action_resolution", revision=3, related_event_id="notice",
                           resolution="recorded", supporting_event_ids=["split"])
        proof = self.proof([notice, support, resolution])
        self.assertEqual(proof["nav_quality"], "complete")
        self.assertIn("split", proof["event_hashes"])
        self.assertEqual(self.proof([notice, resolution])["nav_quality"], "blocked")
        support["account_id"] = "elsewhere"
        self.assertEqual(self.proof([notice, support, resolution])["nav_quality"], "blocked")

    def test_date_notice_starts_local_day_resolution_waits_local_next_midnight(self):
        notice = dated(event("notice", "corporate_action_notice", action_kind="other"))
        resolution = dated(event("resolve", "corporate_action_resolution", revision=2, related_event_id="notice",
                                 resolution="not_applicable", supporting_event_ids=[]))
        self.assertEqual(self.proof([notice, resolution], "2025-01-01T16:00:00Z")["nav_quality"], "blocked")
        self.assertEqual(self.proof([notice, resolution], "2025-01-02T15:59:59Z")["nav_quality"], "blocked")
        self.assertEqual(self.proof([notice, resolution], "2025-01-02T16:00:00Z")["nav_quality"], "complete")

    def test_as_known_late_resolution_and_reversal_do_not_rewrite_history(self):
        notice = event("notice", "corporate_action_notice", action_kind="other")
        resolution = event("resolve", "corporate_action_resolution", revision=2, recorded="2025-01-05T00:00:00Z",
                           related_event_id="notice", resolution="not_applicable", supporting_event_ids=[])
        at = "2025-01-03T00:00:00Z"
        self.assertEqual(self.proof([notice, resolution], at, "as_known")["nav_quality"], "blocked")
        self.assertEqual(self.proof([notice, resolution], at, "restated")["nav_quality"], "complete")
        reversal = {**resolution, "id": "reverse", "event_type": "reversal", "ledger_revision": 3, "reversal_of": "resolve"}
        self.assertEqual(self.proof([notice, resolution, reversal])["nav_quality"], "blocked")

    def test_interval_catches_middle_notice_but_does_not_invent_date_precision_points(self):
        notice = event("notice", "corporate_action_notice", action_kind="other")
        resolution = event("resolve", "corporate_action_resolution", revision=2, at="2025-01-04T00:00:00Z",
                           related_event_id="notice", resolution="not_applicable", supporting_event_ids=[])
        self.assertEqual(self.proof([notice, resolution])["nav_quality"], "complete")
        self.assertEqual(self.proof([notice, resolution], start=START)["nav_quality"], "blocked")
        dividend = dated(event("div", "dividend", recorded="2025-01-02T01:00:00Z", amount="200", tax="20"))
        self.assertEqual(self.proof([dividend], "2025-01-02T02:00:00Z")["nav_quality"], "provisional")
        self.assertEqual(self.proof([dividend], mode="as_known", start=START)["nav_quality"], "complete")

    def test_hash_determinism_scope_revision_and_invalid_payload_fail_closed(self):
        root = event("root", "dividend", amount="200", tax="20")
        future = event("future", "corporate_action_notice", at="2025-02-01T00:00:00Z", revision=2, action_kind="other")
        first, second = self.proof([root, future]), self.proof([future, root])
        self.assertEqual(first, second)
        self.assertEqual(first["event_hashes"], {"root": content_hash(root)})
        self.assertEqual(first["binding_id"], content_hash({key: value for key, value in first.items() if key != "binding_id"}))
        broken = deepcopy(root)
        broken["payload_hash"] = "0" * 64
        self.assertEqual(self.proof([broken])["nav_quality"], "blocked")


if __name__ == "__main__":
    unittest.main()
