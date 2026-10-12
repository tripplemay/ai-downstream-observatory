"""Sparse transition arithmetic, fictional inputs only; not source admission."""

from copy import deepcopy
import unittest

from tests.investor.fixtures import MONITOR_NOW
from tests.investor.test_model_state import model_fixture, next_snapshot
from worker.investor.model_state import advance_evidence_model
from worker.orchestration.db import WorkbenchError, content_hash


def evidence_projection(snapshot, definition):
    return {**deepcopy(snapshot), "schema_version": "investor-monitor-data-projection-v1",
        "source_qualification": "owner_reviewed_reconstructed", "created_at": definition["created_at"],
        "valid_until": definition["valid_until"], "live_advice_eligible": False}


def sparse_cases():
    definition, snapshot = model_fixture()
    definition["data_mode"] = "reconstructed"
    projection = evidence_projection(snapshot, definition)
    first = advance_evidence_model(definition, projection, None, MONITOR_NOW, input_hash="a" * 64, sparse=True)
    previous = first["checkpoint"]
    changed = deepcopy(projection)
    changed["fx"][0]["value"] = "1.25"
    changed["policy"]["costs"]["minimum_fee_cny"] = "2"
    changed["funding_intent"] = {"id": "fictional-due", "amount_cny": "1000", "expected_at": MONITOR_NOW}
    later, now = next_snapshot(snapshot)
    quote = later["quotes"][0]
    quote["close"] = "50"
    later["corporate_actions"] = [{"id": "fictional-split", "listing_id": quote["listing_id"], "kind": "split",
        "ratio": "2", "effective_at": quote["observed_at"], "known_at": now}]
    advanced = evidence_projection(later, definition)
    capped = {**deepcopy(previous), "sequence": 1000, "previous_hash": "f" * 64}
    ex, ex_now = next_snapshot(snapshot)
    hk = next(row for row in ex["quotes"] if row["market"] == "HK")
    hk["close"] = "120"
    action = {"id": "fictional-dividend-ex", "listing_id": hk["listing_id"], "kind": "dividend_ex", "currency": "HKD",
        "net_per_unit": "5", "entitlement_id": "fictional-dividend", "tax_assumption_hash": "d" * 64,
        "effective_at": hk["observed_at"], "known_at": ex_now}
    ex["corporate_actions"] = [action]
    ex_projection = evidence_projection(ex, definition)
    ex_state = advance_evidence_model(definition, ex_projection, previous, ex_now, input_hash="b" * 64, sparse=True)["checkpoint"]
    paid, pay_now = next_snapshot(ex, 2)
    paid["corporate_actions"] = [{"id": "fictional-dividend-pay", "listing_id": hk["listing_id"], "kind": "dividend_payment",
        "currency": "HKD", "entitlement_id": "fictional-dividend", "ex_at": action["effective_at"],
        "effective_at": next(row for row in paid["quotes"] if row["market"] == "HK")["observed_at"], "known_at": pay_now}]
    paid_projection = evidence_projection(paid, definition)
    paid_state = advance_evidence_model(definition, paid_projection, ex_state, pay_now, input_hash="b" * 64, sparse=True)["checkpoint"]
    revised = deepcopy(ex_projection)
    revised["corporate_actions"][0]["net_per_unit"] = "6"
    return definition, [
        {"projection": projection, "previous": None, "now": MONITOR_NOW},
        {"projection": changed, "previous": previous, "now": MONITOR_NOW},
        {"projection": advanced, "previous": previous, "now": now},
        {"projection": projection, "previous": capped, "now": MONITOR_NOW},
        {"projection": advanced, "previous": capped, "now": now},
        {"projection": ex_projection, "previous": previous, "now": ex_now},
        {"projection": paid_projection, "previous": ex_state, "now": pay_now},
        {"projection": paid_projection, "previous": paid_state, "now": pay_now},
        {"projection": revised, "previous": ex_state, "now": ex_now},
    ]


class EvidenceModelStateTests(unittest.TestCase):
    def test_price_fx_policy_and_funding_reassess_without_resealing_unit_state(self):
        definition, cases = sparse_cases()
        case = cases[1]
        result = advance_evidence_model(definition, case["projection"], case["previous"], case["now"], input_hash="b" * 64, sparse=True)
        self.assertEqual(result["checkpoint"], case["previous"])
        self.assertEqual(result["monitor_request"]["document"]["model_state_hash"], content_hash(case["previous"]))
        self.assertNotEqual(result["assessment"]["model_nav_cny"], "10000")
        self.assertEqual(result["assessment"]["outcome"], "decision_required")
        self.assertEqual(result["assessment"]["funding_status"], "hypothetical_due")
        self.assertGreater(float(result["assessment"]["estimated_cost_cny"]), 0)

    def test_effective_close_and_split_append_exactly_one_state_transition(self):
        definition, cases = sparse_cases()
        case = cases[2]
        result = advance_evidence_model(definition, case["projection"], case["previous"], case["now"], input_hash="b" * 64, sparse=True)
        state = result["checkpoint"]
        self.assertEqual(state["sequence"], 2)
        self.assertEqual(state["previous_hash"], content_hash(case["previous"]))
        self.assertEqual(state["projection_hash"], content_hash(case["projection"]))
        repeat = advance_evidence_model(definition, case["projection"], state, case["now"], input_hash="c" * 64, sparse=True)
        self.assertEqual(repeat["checkpoint"], state)
        self.assertEqual(result["assessment"]["model_nav_cny"], "10000")

    def test_cap_allows_unchanged_recheck_but_never_silently_discards_changed_state(self):
        definition, cases = sparse_cases()
        unchanged, changed = cases[3:5]
        result = advance_evidence_model(definition, unchanged["projection"], unchanged["previous"], unchanged["now"], input_hash="b" * 64, sparse=True)
        self.assertEqual(result["checkpoint"], unchanged["previous"])
        with self.assertRaisesRegex(WorkbenchError, "CHECKPOINT_LIMIT_REQUIRES_RESTART"):
            advance_evidence_model(definition, changed["projection"], changed["previous"], changed["now"], input_hash="b" * 64, sparse=True)

    def test_unqualified_unchanged_input_still_cannot_publish_state_or_fresh_conclusion(self):
        definition, cases = sparse_cases()
        case = cases[1]
        case["projection"]["corporate_action_coverage"]["HK"]["complete"] = False
        result = advance_evidence_model(definition, case["projection"], case["previous"], case["now"], input_hash="b" * 64, sparse=True)
        self.assertIsNone(result["checkpoint"])
        self.assertEqual(result["assessment"]["outcome"], "insufficient_evidence")

    def test_dividend_payment_is_not_duplicated_by_unchanged_rechecks(self):
        definition, cases = sparse_cases()
        paid, repeated = cases[6:8]
        self.assertEqual(paid["previous"]["receivables"][0]["amount"], "150")
        result = advance_evidence_model(definition, paid["projection"], paid["previous"], paid["now"], input_hash="b" * 64, sparse=True)
        self.assertEqual(result["checkpoint"]["cash_by_currency"]["HKD"], "150")
        self.assertEqual(result["checkpoint"]["receivables"], [])
        self.assertEqual(result["checkpoint"]["sequence"], 3)
        repeat = advance_evidence_model(definition, repeated["projection"], repeated["previous"], repeated["now"], input_hash="c" * 64, sparse=True)
        self.assertEqual(repeat["checkpoint"], result["checkpoint"])
        self.assertEqual(repeat["assessment"]["model_nav_cny"], "10000")

    def test_sparse_policy_never_hides_a_revised_processed_action(self):
        definition, cases = sparse_cases()
        revised = cases[8]
        with self.assertRaisesRegex(WorkbenchError, "ACTION_RESTATEMENT_REQUIRED"):
            advance_evidence_model(definition, revised["projection"], revised["previous"], revised["now"], input_hash="b" * 64, sparse=True)


if __name__ == "__main__": unittest.main()
