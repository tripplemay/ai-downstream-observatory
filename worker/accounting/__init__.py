"""Pure, Decimal-based ETF workbench accounting and performance domain."""

from .decimal_math import AccountingError, canonical, decimal, fact_decimal, quantize_cash
from .ledger_math import (
    CurrencyBalance, Position, TradeEffect, ValuedPosition, ValuationResult,
    amount_attribution, available_cash, buy, cashflow_profit, fx_return_decomposition, nav_cny,
    pay_dividend, sell, settle_buy, settle_sell, split, unrealized,
)
from .performance import (
    DrawdownResult, NavPoint, ReturnResult, TimedFlow, ValuedFlow,
    annualized_unit_return, chain_returns, drawdown, exact_twr, modified_dietz,
)
from .quality import (
    DataTimes, Eligibility, PriceRequirement, QualityResult, eligible_at, valuation_quality,
)
from .xirr import DatedCashflow, XirrResult, xirr, xnpv

__all__ = [
    "AccountingError", "canonical", "decimal", "fact_decimal", "quantize_cash",
    "CurrencyBalance", "Position", "TradeEffect", "ValuedPosition", "ValuationResult",
    "amount_attribution", "available_cash", "buy", "cashflow_profit", "fx_return_decomposition", "nav_cny",
    "pay_dividend", "sell", "settle_buy", "settle_sell", "split", "unrealized",
    "DrawdownResult", "NavPoint", "ReturnResult", "TimedFlow", "ValuedFlow",
    "annualized_unit_return", "chain_returns", "drawdown", "exact_twr", "modified_dietz",
    "DataTimes", "Eligibility", "PriceRequirement", "QualityResult", "eligible_at",
    "valuation_quality", "DatedCashflow", "XirrResult", "xirr", "xnpv",
]
