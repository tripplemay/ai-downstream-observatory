from copy import deepcopy
from decimal import localcontext
import unittest

from worker.investor.planned_funding_monitor import planned_funding_context_hash, project_planned_funding_monitor, verify_planned_funding_monitor
from worker.orchestration.db import content_hash
from tests.investor.test_funding_plan import plan


def request(evaluated="2027-01-01T00:00:00.000Z", changes=None, binding_changes=None):
    value = {**plan(), **(changes or {})}
    return {"schema_version": "investor-planned-funding-monitor-v1", "funding_plan": value,
        "binding": {"funding_plan_id": "fictional-funding:1", "funding_plan_hash": content_hash(value), "profile_hash": "a" * 64,
            "model_id": "fictional-model", "model_hash": "b" * 64, "model_created_at": "2026-01-02T12:00:00.000Z",
            "plan_declared_at": "2026-01-03T12:00:00.000Z", **(binding_changes or {})}, "evaluated_at": evaluated}


class PlannedFundingMonitorTests(unittest.TestCase):
    def test_due_annual_release_is_normalized_not_initial_cash(self):
        result = project_planned_funding_monitor(request(changes={"entry_method": "immediate"}))
        self.assertEqual(result["initial_notional_cny"], "10000")
        self.assertEqual(result["due_amount_normalized_cny"], "2500")
        self.assertEqual(result["status"], "hypothetical_due")
        self.assertEqual(len(result["releases"]), 9)
        self.assertTrue(all(row["id"].startswith("annual:") for row in result["releases"]))
        self.assertEqual(result["qualification"], "unadmitted_planned_funding_projection")
        for field in ("actual_arrivals_confirmed", "model_cash_changed", "model_units_changed", "execution_authorized", "live_advice_eligible"):
            self.assertIs(result[field], False)
        for field in ("cash_cny", "quantities", "model_nav_cny", "actual_holdings", "annual_contribution_cny"):
            self.assertNotIn(field, result)

    def test_exact_tranches_normalize_the_sum_once(self):
        changes = {"initial_capital_cny": "100.01", "annual_contribution_cny": "10.01"}
        first = project_planned_funding_monitor(request(changes=changes))
        whole = project_planned_funding_monitor(request("2027-03-02T00:00:00.000Z", changes))
        self.assertEqual(first["due_amount_normalized_cny"], "332.966703329667033296")
        self.assertEqual(whole["due_amount_normalized_cny"], "1000.899910008999100089")
        self.assertEqual(whole["funding_intent"]["amount_cny"], whole["due_amount_normalized_cny"])
        self.assertEqual(sum(row["status"] == "due" for row in whole["releases"]), 3)
        self.assertEqual(whole["releases"][2]["release_date"], "2027-03-02")

    def test_unexecuted_due_pool_is_not_consumed_by_repeated_evaluation(self):
        a = project_planned_funding_monitor(request(changes={"entry_method": "immediate"}))
        b = project_planned_funding_monitor(request("2027-02-01T00:00:00.000Z", {"entry_method": "immediate"}))
        c = project_planned_funding_monitor(request("2028-01-01T00:00:00.000Z", {"entry_method": "immediate"}))
        self.assertEqual(a["funding_intent"], b["funding_intent"])
        self.assertEqual(c["due_amount_normalized_cny"], "5000")
        self.assertNotEqual(a["funding_intent"]["id"], c["funding_intent"]["id"])
        self.assertNotEqual(a["input_version"], b["input_version"])

    def test_future_intent_stays_future_until_exact_local_midnight(self):
        first = project_planned_funding_monitor(request("2026-12-31T15:59:59.999Z"))
        due = project_planned_funding_monitor(request("2026-12-31T16:00:00.000Z"))
        self.assertEqual(first["status"], "not_due")
        self.assertEqual(first["due_amount_normalized_cny"], "0")
        self.assertEqual(first["valid_until"], due["evaluated_at"])
        self.assertEqual(first["funding_intent"], due["funding_intent"])
        self.assertEqual(due["status"], "hypothetical_due")

    def test_anchor_is_later_registration_or_model_time_never_backfills(self):
        for field in ("plan_declared_at", "model_created_at"):
            with self.subTest(field=field):
                value = request("2027-01-16T00:00:00.000Z", binding_changes={field: "2027-01-15T00:00:00.000Z"})
                result = project_planned_funding_monitor(value)
                self.assertEqual(result["releases"][0]["status"], "excluded_before_anchor")
                self.assertEqual(result["status"], "not_due")
                self.assertEqual(result["funding_intent"]["expected_at"], "2027-01-30T16:00:00.000Z")
        for delta, expected in (("000", "due"), ("001", "excluded_before_anchor")):
            result = project_planned_funding_monitor(request(binding_changes={"plan_declared_at": "2026-12-31T16:00:00." + delta + "Z"}))
            self.assertEqual(result["releases"][0]["status"], expected)

    def test_same_day_annual_is_separate_and_initial_tranches_are_never_added(self):
        value = request("2026-01-01T00:00:00.000Z", {"first_annual_date": "2026-01-01", "entry_method": "immediate"},
            {"model_created_at": "2025-12-31T16:00:00.000Z", "plan_declared_at": "2025-12-31T16:00:00.000Z"})
        result = project_planned_funding_monitor(value)
        self.assertEqual(result["due_amount_normalized_cny"], "2500")
        self.assertEqual(len(result["releases"]), 10)

    def test_ny_natural_days_cross_dst_not_fixed_24_hour_offsets(self):
        spring = project_planned_funding_monitor(request("2027-03-13T05:00:00.000Z",
            {"evaluation_timezone": "America/New_York", "first_annual_date": "2027-03-13"}))
        self.assertEqual([row["expected_at"] for row in spring["releases"][:3]],
            ["2027-03-13T05:00:00.000Z", "2027-04-12T04:00:00.000Z", "2027-05-12T04:00:00.000Z"])
        fall = project_planned_funding_monitor(request("2027-11-06T04:00:00.000Z",
            {"evaluation_timezone": "America/New_York", "first_annual_date": "2027-11-06"}))
        self.assertEqual(fall["releases"][1]["expected_at"], "2027-12-06T05:00:00.000Z")

    def test_nonexistent_local_midnight_is_rejected_not_shifted(self):
        for zone, day in (("Asia/Shanghai", "1919-04-13"), ("Asia/Hong_Kong", "1941-12-25")):
            year = day[:4]
            value = request(year + "-12-31T00:00:00.000Z", {"start_date": year + "-01-01", "horizon_years": 1,
                "first_annual_date": day, "evaluation_timezone": zone, "entry_method": "immediate"},
                {"model_created_at": year + "-01-02T00:00:00.000Z", "plan_declared_at": year + "-01-03T00:00:00.000Z"})
            with self.subTest(zone=zone, day=day), self.assertRaises(ValueError):
                project_planned_funding_monitor(value)

    def test_historical_subminute_offset_is_exact_without_epoch_rounding(self):
        value = request("1900-01-03T00:00:00.000Z", {"start_date": "1900-01-01", "horizon_years": 1,
            "first_annual_date": "1900-01-03", "entry_method": "immediate"},
            {"model_created_at": "1900-01-01T00:00:00.000Z", "plan_declared_at": "1900-01-02T00:00:00.000Z"})
        result = project_planned_funding_monitor(value)
        self.assertEqual(result["releases"][0]["expected_at"], "1900-01-02T15:54:17.000Z")

    def test_exclusive_end_excludes_late_tranches_and_expires_intent(self):
        changes = {"horizon_years": 1, "first_annual_date": "2026-12-31"}
        before = project_planned_funding_monitor(request("2026-12-31T00:00:00.000Z", changes))
        self.assertEqual([row["status"] for row in before["releases"]], ["due", "excluded_outside_horizon", "excluded_outside_horizon"])
        self.assertEqual(before["valid_until"], "2026-12-31T16:00:00.000Z")
        expired = project_planned_funding_monitor(request(before["valid_until"], changes))
        self.assertEqual(expired["status"], "expired")
        self.assertIsNone(expired["funding_intent"])
        self.assertIsNone(expired["valid_until"])
        self.assertIsNone(expired["next_release_at"])

    def test_none_and_entirely_excluded_are_distinct(self):
        none = project_planned_funding_monitor(request(changes={"annual_contribution_cny": "0", "first_annual_date": None}))
        self.assertEqual(none["status"], "none")
        self.assertEqual(none["releases"], [])
        exhausted = project_planned_funding_monitor(request("2026-12-01T00:00:00.000Z",
            {"horizon_years": 1, "first_annual_date": "2026-01-01"}, {"plan_declared_at": "2026-04-01T00:00:00.000Z"}))
        self.assertEqual(exhausted["status"], "no_eligible_releases")
        self.assertIsNone(exhausted["funding_intent"])

    def test_model_or_plan_version_rebinds_intent_without_private_money_in_id(self):
        a = project_planned_funding_monitor(request())
        for changes in ({"funding_plan_id": "fictional-funding:2"}, {"model_hash": "c" * 64}, {"profile_hash": "d" * 64}):
            b = project_planned_funding_monitor(request(binding_changes=changes))
            self.assertNotEqual(a["funding_intent"]["id"], b["funding_intent"]["id"])
            self.assertEqual(a["funding_intent"]["amount_cny"], b["funding_intent"]["amount_cny"])

    def test_max_min_and_repeating_ratios_are_exact_under_tiny_decimal_context(self):
        for changes in ({"initial_capital_cny": "0.01", "annual_contribution_cny": "999999999999.99", "entry_method": "immediate"},
                {"initial_capital_cny": "999999999999.99", "annual_contribution_cny": "0.01", "entry_method": "immediate"},
                {"initial_capital_cny": "3", "annual_contribution_cny": "2", "entry_method": "immediate"}):
            with self.subTest(changes=changes):
                value = request(changes=changes)
                ordinary = project_planned_funding_monitor(value)
                with localcontext() as context:
                    context.prec = 6
                    self.assertEqual(project_planned_funding_monitor(value), ordinary)
                self.assertTrue(any(char in "123456789" for char in ordinary["funding_intent"]["amount_cny"]))
        self.assertEqual(project_planned_funding_monitor(request(changes={"initial_capital_cny": "3", "annual_contribution_cny": "2", "entry_method": "immediate"}))
            ["due_amount_normalized_cny"], "6666.666666666666666666")

    def test_input_is_closed_clock_scoped_and_not_mutated(self):
        value = request(); original = deepcopy(value)
        result = project_planned_funding_monitor(value)
        self.assertEqual(value, original)
        result["binding"]["model_id"] = "altered"
        self.assertEqual(value, original)
        bad = [request(binding_changes={"funding_plan_hash": "c" * 64}), request(binding_changes={"plan_declared_at": "2028-01-01T00:00:00.000Z"}),
            {**value, "cash_cny": "1000"}, {**value, "evaluated_at": "2027-02-30T00:00:00.000Z"}, {**value, "evaluated_at": "2027-01-01T00:00:00.000001Z"}]
        for changed in bad:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                project_planned_funding_monitor(changed)

    def test_verifier_replays_math_not_only_self_reported_hash(self):
        value = request(); result = project_planned_funding_monitor(value)
        self.assertEqual(verify_planned_funding_monitor(value, result), result)
        for field, altered in (("due_amount_normalized_cny", "999"), ("anchor_at", "2026-01-01T00:00:00.000Z"),
                ("qualification", "owner_reviewed_reconstructed"), ("execution_authorized", True)):
            bad = deepcopy(result); bad[field] = altered
            bad["result_hash"] = content_hash({key: item for key, item in bad.items() if key != "result_hash"})
            with self.subTest(field=field), self.assertRaises(ValueError):
                verify_planned_funding_monitor(value, bad)

    def test_context_stays_stable_within_release_bucket_not_across_release_or_end(self):
        before = request("2026-12-31T15:59:59.998Z")
        almost = request("2026-12-31T15:59:59.999Z")
        due = request("2026-12-31T16:00:00.000Z")
        repeated = request("2027-01-01T00:00:00.000Z")
        self.assertNotEqual(project_planned_funding_monitor(before)["input_version"], project_planned_funding_monitor(almost)["input_version"])
        self.assertEqual(planned_funding_context_hash(before), planned_funding_context_hash(almost))
        self.assertNotEqual(planned_funding_context_hash(almost), planned_funding_context_hash(due))
        self.assertEqual(planned_funding_context_hash(due), planned_funding_context_hash(repeated))
        self.assertNotEqual(planned_funding_context_hash(repeated), planned_funding_context_hash(request("2027-01-30T16:00:00.000Z")))
        changes = {"horizon_years": 1, "first_annual_date": "2026-12-31"}
        self.assertNotEqual(planned_funding_context_hash(request("2026-12-31T15:59:59.999Z", changes)),
            planned_funding_context_hash(request("2026-12-31T16:00:00.000Z", changes)))

    def test_context_rebuilds_the_plan_and_is_bound_to_every_frozen_identity(self):
        value = request(); before = deepcopy(value)
        original = planned_funding_context_hash(value)
        self.assertEqual(value, before)
        for key, replacement in (("funding_plan_id", "fictional-funding:2"), ("profile_hash", "c" * 64),
                ("model_id", "different-model"), ("model_hash", "d" * 64), ("model_created_at", "2026-01-03T12:00:00.000Z"),
                ("plan_declared_at", "2026-01-04T12:00:00.000Z")):
            with self.subTest(key=key):
                self.assertNotEqual(original, planned_funding_context_hash(request(binding_changes={key: replacement})))
        self.assertNotEqual(original, planned_funding_context_hash(request(changes={"annual_contribution_cny": "301"})))
        for bad in (project_planned_funding_monitor(value), {**value, "context_hash": original},
                request(binding_changes={"funding_plan_hash": "e" * 64})):
            with self.assertRaises(ValueError):
                planned_funding_context_hash(bad)


if __name__ == "__main__":
    unittest.main()
