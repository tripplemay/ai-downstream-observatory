"""Language-neutral fixtures intended for the TypeScript reference comparison."""

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import json
from pathlib import Path
import unittest

from worker.accounting import (
    CurrencyBalance, DatedCashflow, NavPoint, Position, TimedFlow, ValuedFlow,
    ValuedPosition, buy, cashflow_profit, drawdown, exact_twr,
    fx_return_decomposition, modified_dietz, nav_cny, sell, settle_buy,
    settle_sell, split, unrealized, xirr,
)


class GoldenContractTests(unittest.TestCase):
    def test_language_neutral_fixture_results(self):
        manifest = json.loads(Path(__file__).with_name("golden.json").read_text())
        self.assertEqual(manifest["schema_version"], "accounting-golden-v1")
        self.assertTrue(manifest["synthetic"])
        self.assertEqual(len({item["id"] for item in manifest["fixtures"]}), 13)
        start = datetime(2025, 1, 1, tzinfo=timezone.utc)

        def valuation(balance, quantity, price):
            return nav_cny({"CNY": balance}, [ValuedPosition("test", "CNY", quantity, price)], {})

        for case in manifest["fixtures"]:
            with self.subTest(fixture=case["id"]):
                operation = case["operation"]
                if operation == "profit":
                    self.assertEqual(cashflow_profit(case["nav"], case["opening"], case["flows"]), Decimal(case["expected"]))
                elif operation == "buy":
                    trade = buy(Position(), case["quantity"], case["principal"], case["fee"])
                    balance = CurrencyBalance(case["cash"], trade_payables=trade.payable)
                    self.assertEqual(trade.payable, Decimal(case["expected_payable"]))
                    self.assertEqual(valuation(balance, trade.position.quantity, case["price"]).nav_cny, Decimal(case["expected_nav"]))
                    self.assertEqual(settle_buy(balance, trade.payable).settled_cash, Decimal(case["expected_cash"]))
                elif operation == "sell":
                    trade = sell(Position(case["opening_quantity"], case["opening_cost"]), case["quantity"], case["principal"], case["fee"])
                    balance = CurrencyBalance(case["cash"], trade_receivables=trade.receivable)
                    self.assertEqual(valuation(balance, trade.position.quantity, case["price"]).nav_cny, Decimal(case["expected_nav"]))
                    self.assertEqual(settle_sell(balance, trade.receivable).settled_cash, Decimal(case["expected_cash"]))
                    self.assertEqual(trade.gross_realized, Decimal(case["expected_realized"]))
                    self.assertEqual(unrealized(trade.position, case["price"]), Decimal(case["expected_unrealized"]))
                elif operation == "dividend":
                    balance = CurrencyBalance(dividend_receivables=case["receivable"])
                    self.assertEqual(valuation(balance, case["quantity"], case["price"]).nav_cny, Decimal(case["expected_nav"]))
                elif operation == "transfer":
                    balance = CurrencyBalance(case["cash"], owned_transfers_in_transit=case["in_transit"])
                    self.assertEqual(nav_cny({"CNY": balance}, [], {}).nav_cny, Decimal(case["expected_nav"]))
                elif operation == "fx":
                    result = nav_cny({"USD": CurrencyBalance(case["usd"])}, [], {"USD": case["cny_per_usd"]})
                    self.assertEqual(result.nav_cny, Decimal(case["expected_nav"]))
                    self.assertEqual(cashflow_profit(result.nav_cny, case["opening"], []), Decimal(case["expected_profit"]))
                elif operation == "returns":
                    middle, end = start + timedelta(days=5), start + timedelta(days=10)
                    twr = exact_twr(start, end, case["opening"], case["closing"], [ValuedFlow(middle, case["flow"], case["before_flow"])])
                    dietz = modified_dietz(start, end, case["opening"], case["closing"], [TimedFlow(middle, case["flow"])])
                    self.assertEqual(twr.value, Decimal(case["expected_twr"]))
                    self.assertEqual(dietz.value, Decimal(case["expected_dietz"]))
                    self.assertEqual(cashflow_profit(case["closing"], case["opening"], [case["flow"]]), Decimal(case["expected_profit"]))
                elif operation == "xirr":
                    result = xirr([DatedCashflow(date.fromisoformat(at), amount) for at, amount in case["flows"]])
                    self.assertEqual(result.status, case["expected_status"])
                    self.assertEqual(len(result.roots), len(case["expected_roots"]))
                    for actual, expected in zip(result.roots, case["expected_roots"]):
                        self.assertLess(abs(actual - Decimal(expected)), Decimal("1e-10"))
                elif operation == "drawdown":
                    result = drawdown([NavPoint(start + timedelta(days=i), value) for i, value in enumerate(case["values"])])
                    self.assertEqual(result.max_drawdown, Decimal(case["expected"]))
                    self.assertEqual(result.recovered_at, case["expected_recovered_at"])
                elif operation == "split":
                    result = split(Position(case["quantity"], case["cost"]), case["numerator"], case["denominator"])
                    self.assertEqual(result.quantity, Decimal(case["expected_quantity"]))
                    self.assertEqual(result.unit_cost, Decimal(case["expected_unit_cost"]))
                elif operation == "fx_return":
                    result = fx_return_decomposition(case["local_return"], case["fx_return"])
                    self.assertEqual(result["cny_return"], Decimal(case["expected_cny_return"]))
                    self.assertEqual(result["cross_return"], Decimal(case["expected_cross_return"]))
                elif operation == "missing_price":
                    result = nav_cny({}, [ValuedPosition(case["listing_id"], "CNY", case["quantity"], case["price"])], {})
                    self.assertEqual(result.nav_cny, case["expected_nav"])
                    self.assertEqual(result.quality, case["expected_quality"])
                else:
                    self.fail("unhandled fixture operation: " + operation)


if __name__ == "__main__":
    unittest.main()
