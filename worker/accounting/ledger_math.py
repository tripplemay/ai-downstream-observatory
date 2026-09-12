"""Pure trade-date projections, not persistence or broker transaction APIs."""

from dataclasses import dataclass, replace
from decimal import Decimal, ROUND_HALF_EVEN
from typing import Mapping, Optional, Sequence

from .decimal_math import AccountingError, ONE, ZERO, decimal, financial, nonnegative, positive


@dataclass(frozen=True)
class Position:
    quantity: Decimal = ZERO
    total_cost: Optional[Decimal] = ZERO

    def __post_init__(self):
        object.__setattr__(self, "quantity", nonnegative(self.quantity, "quantity"))
        if self.total_cost is not None:
            object.__setattr__(self, "total_cost", nonnegative(self.total_cost, "cost"))
        if self.quantity == ZERO and self.total_cost not in (ZERO, None):
            raise AccountingError("cost_without_position")

    @property
    @financial
    def unit_cost(self):
        if not self.quantity or self.total_cost is None:
            return None
        return self.total_cost / self.quantity


@dataclass(frozen=True)
class TradeEffect:
    position: Position
    payable: Decimal = ZERO
    receivable: Decimal = ZERO
    fee: Decimal = ZERO
    gross_realized: Optional[Decimal] = ZERO


@financial
def buy(position, quantity, principal, fee="0"):
    quantity = positive(quantity, "quantity")
    principal, fee = nonnegative(principal), nonnegative(fee, "fee")
    cost = None if position.total_cost is None else position.total_cost + principal
    return TradeEffect(Position(position.quantity + quantity, cost), principal + fee, fee=fee)


@financial
def sell(position, quantity, principal, fee="0"):
    quantity = positive(quantity, "quantity")
    principal, fee = nonnegative(principal), nonnegative(fee, "fee")
    if quantity > position.quantity:
        raise AccountingError("insufficient_position")
    if fee > principal:
        raise AccountingError("fee_exceeds_sale_proceeds")
    released = None if position.total_cost is None else position.total_cost * quantity / position.quantity
    remaining = position.quantity - quantity
    cost = None if released is None else position.total_cost - released
    if remaining == ZERO:
        cost = ZERO
    return TradeEffect(Position(remaining, cost), receivable=principal - fee, fee=fee,
                       gross_realized=None if released is None else principal - released)


@financial
def split(position, numerator, denominator="1"):
    ratio = positive(numerator, "numerator") / positive(denominator, "denominator")
    return Position(position.quantity * ratio, position.total_cost)


@financial
def unrealized(position, market_price):
    price = nonnegative(market_price, "price")
    return None if position.total_cost is None else position.quantity * price - position.total_cost


@dataclass(frozen=True)
class SecurityTransferEffect:
    position: Position
    transferred: Position
    external_flow: Decimal = ZERO
    capital_adjustment: Decimal = ZERO


@dataclass(frozen=True)
class SecurityReceiptEffect:
    position: Position
    transit: Position
    received: Position


def _merge_security(position, incoming):
    if position.quantity == ZERO:
        return incoming
    cost = None if position.total_cost is None or incoming.total_cost is None else position.total_cost + incoming.total_cost
    return Position(position.quantity + incoming.quantity, cost)


def _release_security(position, quantity):
    quantity = positive(quantity, "quantity")
    if quantity > position.quantity:
        raise AccountingError("insufficient_position")
    remaining = position.quantity - quantity
    if position.total_cost is None:
        released, cost = None, None
    elif remaining == ZERO:
        released, cost = position.total_cost, ZERO
    else:
        released = (position.total_cost * quantity / position.quantity).quantize(
            Decimal("0.000000000000000001"), rounding=ROUND_HALF_EVEN)
        cost = position.total_cost - released
    return Position(remaining, ZERO if remaining == ZERO else cost), Position(quantity, released)


@financial
def security_in(position, quantity, market_value, carry_cost=None):
    incoming = Position(positive(quantity, "quantity"), None if carry_cost is None else nonnegative(carry_cost, "cost"))
    market_value = positive(market_value, "market_value")
    adjustment = market_value - (incoming.total_cost if incoming.total_cost is not None else ZERO)
    return SecurityTransferEffect(_merge_security(position, incoming), incoming, market_value, adjustment)


@financial
def security_out(position, quantity, market_value):
    remaining, outgoing = _release_security(position, quantity)
    market_value = positive(market_value, "market_value")
    adjustment = (outgoing.total_cost if outgoing.total_cost is not None else ZERO) - market_value
    return SecurityTransferEffect(remaining, outgoing, -market_value, adjustment)


@financial
def security_transfer_dispatch(position, quantity):
    remaining, transit = _release_security(position, quantity)
    return SecurityTransferEffect(remaining, transit)


@financial
def security_transfer_receive(position, transit, quantity):
    """Arrival and return share cost arithmetic, never external-capital semantics."""
    remaining, received = _release_security(transit, quantity)
    return SecurityReceiptEffect(_merge_security(position, received), remaining, received)


@dataclass(frozen=True)
class CurrencyBalance:
    settled_cash: Decimal = ZERO
    trade_receivables: Decimal = ZERO
    dividend_receivables: Decimal = ZERO
    owned_transfers_in_transit: Decimal = ZERO
    trade_payables: Decimal = ZERO
    other_liabilities: Decimal = ZERO
    dividend_tax_payable: Decimal = ZERO

    def __post_init__(self):
        for name in self.__dataclass_fields__:
            value = decimal(getattr(self, name))
            if name == "dividend_tax_payable" and value > ZERO:
                raise AccountingError("dividend_tax_payable_positive")
            if name not in ("settled_cash", "dividend_tax_payable") and value < ZERO:
                raise AccountingError(name + "_negative")
            object.__setattr__(self, name, value)

    @property
    @financial
    def net_assets(self):
        return (self.settled_cash + self.trade_receivables + self.dividend_receivables
                + self.owned_transfers_in_transit - self.trade_payables - self.other_liabilities
                + self.dividend_tax_payable)


@financial
def settle_buy(balance, payable):
    payable = nonnegative(payable, "payable")
    if payable > balance.trade_payables:
        raise AccountingError("settlement_exceeds_payable")
    return replace(balance, settled_cash=balance.settled_cash - payable,
                   trade_payables=balance.trade_payables - payable)


@financial
def settle_sell(balance, receivable):
    receivable = nonnegative(receivable, "receivable")
    if receivable > balance.trade_receivables:
        raise AccountingError("settlement_exceeds_receivable")
    return replace(balance, settled_cash=balance.settled_cash + receivable,
                   trade_receivables=balance.trade_receivables - receivable)


@financial
def pay_dividend(balance, amount):
    amount = nonnegative(amount)
    if amount > balance.dividend_receivables:
        raise AccountingError("payment_exceeds_dividend_receivable")
    return replace(balance, settled_cash=balance.settled_cash + amount,
                   dividend_receivables=balance.dividend_receivables - amount)


@financial
def available_cash(balance, confirmed_other_holds="0", active_reservations="0"):
    """Inputs must exclude holds already represented by payable/reservation."""
    return (balance.settled_cash - balance.trade_payables + balance.dividend_tax_payable
            - nonnegative(confirmed_other_holds, "hold")
            - nonnegative(active_reservations, "reservation"))


@dataclass(frozen=True)
class ValuedPosition:
    listing_id: str
    currency: str
    quantity: Decimal
    unadjusted_price: Optional[Decimal]
    price_basis: str = "unadjusted"

    def __post_init__(self):
        object.__setattr__(self, "quantity", nonnegative(self.quantity, "quantity"))
        if self.unadjusted_price is not None:
            object.__setattr__(self, "unadjusted_price", nonnegative(self.unadjusted_price, "price"))
        if self.price_basis != "unadjusted":
            raise AccountingError("valuation_requires_unadjusted_price")


@dataclass(frozen=True)
class ValuationResult:
    nav_cny: Optional[Decimal]
    known_partial_cny: Decimal
    quality: str
    issues: tuple


@financial
def nav_cny(balances: Mapping[str, CurrencyBalance], positions: Sequence[ValuedPosition],
            fx_cny_per_unit: Mapping[str, Decimal], quality="complete", issues=()):
    if quality not in ("complete", "provisional", "blocked"):
        raise AccountingError("invalid_quality")
    problems = list(issues)
    if problems and quality == "complete":
        quality = "provisional"
    totals = {currency: balance.net_assets for currency, balance in balances.items()}
    seen = set()
    for position in positions:
        # The caller aggregates per-account quantities to one listing row.
        if position.listing_id in seen:
            raise AccountingError("duplicate_valuation_position")
        seen.add(position.listing_id)
        if not position.quantity:
            continue
        if position.unadjusted_price is None:
            problems.append("missing_price:" + position.listing_id)
            quality = "blocked"
            continue
        totals[position.currency] = (totals.get(position.currency, ZERO)
                                      + position.quantity * position.unadjusted_price)
    total = ZERO
    for currency, value in totals.items():
        if currency == "CNY":
            if currency in fx_cny_per_unit and decimal(fx_cny_per_unit[currency]) != ONE:
                raise AccountingError("cny_fx_must_equal_one")
            rate = ONE
        elif currency not in fx_cny_per_unit:
            if value != ZERO:
                problems.append("missing_fx:" + currency)
                quality = "blocked"
            continue
        else:
            rate = positive(fx_cny_per_unit[currency], "fx")
        total += value * rate
    # A partial sum is never represented as a complete portfolio NAV.
    return ValuationResult(total if quality == "complete" else None, total, quality, tuple(problems))


@financial
def cashflow_profit(nav, opening_equity, external_flows):
    return decimal(nav) - decimal(opening_equity) - sum((decimal(x) for x in external_flows), ZERO)


@financial
def fx_return_decomposition(local_return, fx_return):
    local, fx = decimal(local_return), decimal(fx_return)
    if local < -ONE or fx <= -ONE:
        raise AccountingError("invalid_return")
    cross = local * fx
    return {"local_return": local, "fx_return": fx, "cross_return": cross,
            "cny_return": local + fx + cross}


@financial
def amount_attribution(nav, opening_equity, external_flows, components):
    """Reconcile signed CNY contributions; do not invent balancing entries."""
    allowed = {"local_asset_price", "dividends_interest", "explicit_fees_taxes",
               "fx", "fx_execution", "cross"}
    if set(components) - allowed:
        raise AccountingError("unknown_attribution_component")
    explained = {name: decimal(value) for name, value in components.items()}
    profit = cashflow_profit(nav, opening_equity, external_flows)
    residual = profit - sum(explained.values(), ZERO)
    return {"profit_cny": profit, "components_cny": explained,
            "unexplained_cny": residual, "fully_explained": residual == ZERO}
