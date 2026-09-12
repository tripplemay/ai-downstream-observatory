"""Exact input boundaries for the workbench's financial calculation domain."""

from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN, localcontext
from functools import wraps
import re


PRECISION = 60
ZERO = Decimal("0")
ONE = Decimal("1")
_DECIMAL = re.compile(r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$")


class AccountingError(ValueError):
    """An input cannot safely be used for a financial calculation."""


def financial(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with localcontext() as context:
            context.prec = PRECISION
            context.rounding = ROUND_HALF_EVEN
            return function(*args, **kwargs)
    return wrapped


def decimal(value):
    """Accept Decimal, integer, or normalized text; never coerce a float."""
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        raise AccountingError("decimal_required")
    if isinstance(value, str) and not _DECIMAL.fullmatch(value):
        raise AccountingError("non_canonical_decimal")
    try:
        result = Decimal(value)
    except InvalidOperation as exc:
        raise AccountingError("invalid_decimal") from exc
    if not result.is_finite():
        raise AccountingError("non_finite_decimal")
    return result


def fact_decimal(value):
    """Validate stored fact limits without silently rounding the original."""
    result = decimal(value)
    _, digits, exponent = result.as_tuple()
    significant = len(digits) + max(0, exponent)
    if significant > 38 or -exponent > 18:
        raise AccountingError("decimal_out_of_range")
    return result


def nonnegative(value, field="amount"):
    result = decimal(value)
    if result < ZERO:
        raise AccountingError(field + "_negative")
    return result


def positive(value, field="amount"):
    result = decimal(value)
    if result <= ZERO:
        raise AccountingError(field + "_not_positive")
    return result


def canonical(value):
    result = decimal(value)
    if not result:
        return "0"
    text = format(result, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


@financial
def quantize_cash(value, quantum="0.01"):
    amount, unit = decimal(value), positive(quantum, "quantum")
    return (amount / unit).quantize(ONE, rounding=ROUND_HALF_EVEN) * unit
