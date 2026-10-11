from copy import deepcopy
import unittest

from worker.investor.funding_plan import funding_timeline


def plan():
    return {"schema_version": "investor-funding-plan-v1", "start_date": "2026-01-01", "horizon_years": 10,
        "evaluation_timezone": "Asia/Shanghai", "initial_capital_cny": "1200", "annual_contribution_cny": "300", "first_annual_date": "2027-01-01",
        "entry_method": "three_tranches_60_days", "actual_arrivals_confirmed": False, "execution_authorized": False, "live_advice_eligible": False}


class PlannedFundingTests(unittest.TestCase):
    def test_annual_dates_end_exclusive_and_no_profit_fields(self):
        result = funding_timeline(plan())
        self.assertEqual(result["horizon_end_exclusive"], "2036-01-01")
        self.assertEqual(result["total_planned_principal_cny"], "3900.00")
        self.assertEqual(len(result["lots"]), 10)
        self.assertEqual(result["lots"][-1]["arrival_date"], "2035-01-01")
        self.assertNotIn("profit_cny", result)

    def test_first_annual_may_share_start_date_without_becoming_cash(self):
        value = plan(); value["first_annual_date"] = value["start_date"]
        result = funding_timeline(value)
        self.assertEqual(len(result["lots"]), 11)
        self.assertEqual(result["total_planned_principal_cny"], "4200.00")

    def test_cents_conserve_and_calendar_days_are_not_trade_dates(self):
        value = plan(); value.update(initial_capital_cny="100.01", annual_contribution_cny="0", first_annual_date=None)
        rows = funding_timeline(value)["lots"][0]["tranches"]
        self.assertEqual([row["amount_cny"] for row in rows], ["33.33", "33.33", "33.35"])
        self.assertEqual([row["release_date"] for row in rows], ["2026-01-01", "2026-01-31", "2026-03-02"])

    def test_releases_beyond_end_remain_explicit(self):
        value = plan(); value.update(horizon_years=1, first_annual_date="2026-12-31")
        rows = funding_timeline(value)["lots"][-1]["tranches"]
        self.assertEqual([row["within_horizon"] for row in rows], [True, False, False])

    def test_invalid_money_dates_missing_arrival_and_unknown_timezones(self):
        for changes in ({"initial_capital_cny": "0"}, {"initial_capital_cny": "0.02"}, {"annual_contribution_cny": "0", "first_annual_date": "2027-01-01"},
                {"first_annual_date": None}, {"first_annual_date": "2036-01-01"}, {"first_annual_date": "2025-01-01"},
                {"start_date": "2024-02-29", "horizon_years": 1}, {"start_date": "2026-02-30"}, {"horizon_years": 11},
                {"start_date": "2023-01-01", "first_annual_date": "2024-02-29"}, {"evaluation_timezone": "+01:00"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                value = deepcopy(plan()); value.update(changes); funding_timeline(value)

    def test_closed_contract_has_no_cash_strategy_or_permission_grants(self):
        for key in ("actual_arrivals_confirmed", "execution_authorized", "live_advice_eligible", "source_certified", "weights", "actual_cash"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                funding_timeline({**plan(), key: True})


if __name__ == "__main__":
    unittest.main()
