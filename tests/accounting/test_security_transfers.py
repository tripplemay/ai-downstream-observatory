from decimal import Decimal
import unittest

from worker.accounting import AccountingError, Position, split
from worker.accounting.ledger_math import (
    security_in, security_out, security_transfer_dispatch, security_transfer_receive,
)


class SecurityTransferMathTests(unittest.TestCase):
    def test_market_value_and_carry_cost_are_not_trade_income(self):
        for cost in ("80", "100", "120"):
            incoming = security_in(Position(), "10", "100", cost)
            self.assertEqual(incoming.position, Position(Decimal("10"), Decimal(cost)))
            self.assertEqual(incoming.external_flow, Decimal("100"))
            self.assertEqual(incoming.capital_adjustment, Decimal("100") - Decimal(cost))
            outgoing = security_out(incoming.position, "10", "100")
            self.assertEqual(outgoing.position, Position())
            self.assertEqual(outgoing.external_flow, Decimal("-100"))
            self.assertEqual(outgoing.capital_adjustment, Decimal(cost) - Decimal("100"))
            self.assertFalse(hasattr(incoming, "gross_realized"))

    def test_unknown_and_known_zero_cost_stay_distinct(self):
        unknown = security_in(Position(), "10", "100")
        known_zero = security_in(Position(), "10", "100", "0")
        self.assertIsNone(unknown.position.total_cost)
        self.assertEqual(known_zero.position.total_cost, Decimal("0"))
        self.assertIsNone(security_in(unknown.position, "1", "10", "8").position.total_cost)
        self.assertIsNone(security_out(unknown.position, "1", "10").position.total_cost)
        self.assertEqual(security_out(unknown.position, "10", "100").position, Position())
        self.assertEqual(unknown.capital_adjustment, Decimal("100"))

    def test_partial_arrival_return_and_final_residual_conserve_cost(self):
        dispatched = security_transfer_dispatch(Position(Decimal("3"), Decimal("1")), "3")
        first = security_transfer_receive(Position(), dispatched.transferred, "1")
        self.assertEqual(first.received.total_cost, Decimal("0.333333333333333333"))
        returned = security_transfer_receive(dispatched.position, first.transit, "1")
        self.assertEqual(returned.received.total_cost, Decimal("0.333333333333333334"))
        final = security_transfer_receive(first.position, returned.transit, "1")
        self.assertEqual(final.transit, Position())
        self.assertEqual(returned.position.total_cost + final.position.total_cost, Decimal("1"))
        self.assertEqual(dispatched.external_flow, Decimal("0"))

    def test_split_transit_and_unknown_receipt_do_not_create_cost(self):
        pending = security_transfer_dispatch(Position(Decimal("4"), None), "2")
        after_split = split(pending.transferred, "2")
        received = security_transfer_receive(Position(Decimal("1"), Decimal("5")), after_split, "4")
        self.assertEqual(received.position.quantity, Decimal("5"))
        self.assertIsNone(received.position.total_cost)
        self.assertEqual(received.transit, Position())

    def test_overdraw_zero_value_and_negative_cost_are_rejected(self):
        for operation in (
            lambda: security_out(Position(Decimal("1"), Decimal("1")), "2", "1"),
            lambda: security_transfer_receive(Position(), Position(Decimal("1"), None), "2"),
            lambda: security_in(Position(), "1", "0"),
            lambda: security_in(Position(), "1", "1", "-1"),
        ):
            with self.assertRaises(AccountingError):
                operation()


if __name__ == "__main__":
    unittest.main()
