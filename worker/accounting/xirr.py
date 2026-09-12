"""ACT/365 XIRR, including explicit non-unique and unavailable outcomes.

Formula: https://support.microsoft.com/en-us/excel/functions/xirr-function
Unlike a single Newton guess, derivative isolation checks unconventional flows
for multiple roots. Search limits and ill-conditioned tangencies fail closed.
"""

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, DecimalException

from .decimal_math import AccountingError, ONE, ZERO, decimal, financial, positive


ALGORITHM_VERSION = "act365-exp-derivative-isolation-v1"
_TINY = Decimal("1e-42")
_UNCERTAIN = Decimal("1e-28")
_X_TOLERANCE = Decimal("1e-48")


@dataclass(frozen=True)
class DatedCashflow:
    at: date
    amount: object


@dataclass(frozen=True)
class XirrResult:
    rate: object = None
    status: str = "no_data"
    roots: tuple = ()
    residual: object = None
    duration_days: int = 0
    reason: str = ""
    algorithm: str = ALGORITHM_VERSION


def _aggregate(flows):
    grouped = {}
    for flow in flows:
        if not isinstance(flow.at, date) or isinstance(flow.at, datetime):
            raise AccountingError("xirr_requires_evaluation_timezone_dates")
        grouped[flow.at] = grouped.get(flow.at, ZERO) + decimal(flow.amount)
    return sorted(grouped.items())


@financial
def xnpv(rate, flows):
    rate = decimal(rate)
    if rate <= -ONE:
        raise AccountingError("xirr_rate_must_exceed_minus_one")
    grouped = _aggregate(flows)
    if not grouped:
        raise AccountingError("cashflows_required")
    start = grouped[0][0]
    log_daily_rate = (ONE + rate).ln() / decimal(365)
    return sum((amount * (-(decimal((at - start).days)) * log_daily_rate).exp()
                for at, amount in grouped), ZERO)


def _normalize(terms):
    terms = [(day, amount) for day, amount in terms if amount != ZERO]
    if not terms:
        return []
    scale = max(abs(amount) for _, amount in terms)
    base = terms[0][0]
    return [(day - base, amount / scale) for day, amount in terms]


def _value(terms, x):
    # A positive scale factor preserves signs without exponential overflow.
    anchor = terms[0][0] if x >= ZERO else terms[-1][0]
    return sum((amount * (-decimal(day - anchor) * x).exp() for day, amount in terms), ZERO)


def _bracket(terms):
    bound = ONE
    first_day, first = terms[0]
    last_day, last = terms[-1]
    for _ in range(18):
        right_rest = sum((abs(amount) * (-decimal(day - first_day) * bound).exp()
                          for day, amount in terms[1:]), ZERO)
        left_rest = sum((abs(amount) * (-decimal(last_day - day) * bound).exp()
                         for day, amount in terms[:-1]), ZERO)
        if right_rest < abs(first) and left_rest < abs(last):
            return -bound, bound
        bound *= 2
    return None


def _bisect(terms, left, right):
    left_value = _value(terms, left)
    for _ in range(256):
        middle = (left + right) / 2
        middle_value = _value(terms, middle)
        if middle_value == ZERO or right - left <= _X_TOLERANCE:
            return middle
        if (left_value > ZERO) == (middle_value > ZERO):
            left, left_value = middle, middle_value
        else:
            right = middle
    raise ArithmeticError("xirr_bisection_budget")


def _isolate(terms, left, right):
    terms = _normalize(terms)
    if len(terms) < 2:
        return [], False
    if len(terms) == 2:
        (_, c0), (day, c1) = terms
        if (c0 > ZERO) == (c1 > ZERO):
            return [], False
        root = -(-c0 / c1).ln() / decimal(day)
        return ([root] if left <= root <= right else []), False
    derivative = [(day, -decimal(day) * amount) for day, amount in terms[1:]]
    critical, uncertain = _isolate(derivative, left, right)
    bounds = [left] + sorted(critical) + [right]
    values = [_value(terms, value) for value in bounds]
    roots = []
    for index, value in enumerate(values):
        if abs(value) <= _UNCERTAIN:
            # A near-zero extremum may be a repeated root or a nearly touching
            # pair of roots. Expose candidates but never certify uniqueness.
            uncertain = True
            if abs(value) <= _TINY:
                roots.append(bounds[index])
    for index in range(len(bounds) - 1):
        lv, rv = values[index:index + 2]
        if abs(lv) <= _TINY or abs(rv) <= _TINY:
            continue
        if (lv > ZERO) != (rv > ZERO):
            roots.append(_bisect(terms, bounds[index], bounds[index + 1]))
    return sorted(roots), uncertain


@financial
def xirr(flows, residual_tolerance="0.000000000001", max_unconventional_terms=32):
    flows = tuple(flows)
    grouped = _aggregate(flows)
    if not grouped:
        return XirrResult()
    days = (grouped[-1][0] - grouped[0][0]).days
    if days == 0:
        return XirrResult(status="same_day_flows", duration_days=0,
                          reason="annualized_rate_is_not_identifiable")
    nonzero = [(at, amount) for at, amount in grouped if amount != ZERO]
    if not nonzero:
        return XirrResult(status="ambiguous", duration_days=days, reason="identically_zero_npv")
    if not any(amount > ZERO for _, amount in nonzero) or not any(amount < ZERO for _, amount in nonzero):
        return XirrResult(status="missing_signs", duration_days=days)
    tolerance = positive(residual_tolerance, "residual_tolerance")
    start = nonzero[0][0]
    terms = _normalize([((at - start).days, amount) for at, amount in nonzero])
    changes = sum((terms[i][1] > ZERO) != (terms[i - 1][1] > ZERO) for i in range(1, len(terms)))
    if changes > 1 and len(terms) > max_unconventional_terms:
        return XirrResult(status="ambiguous", duration_days=days, reason="root_isolation_budget")
    try:
        bracket = _bracket(terms)
        if bracket is None:
            return XirrResult(status="ambiguous", duration_days=days, reason="tail_bounds_not_proved")
        if changes == 1:
            candidates, uncertain = [_bisect(terms, *bracket)], False
        else:
            candidates, uncertain = _isolate(terms, *bracket)
        roots, residuals = [], []
        for candidate in candidates:
            rate = (decimal(365) * candidate).exp() - ONE
            if rate <= -ONE:
                uncertain = True
                continue
            residual = xnpv(rate, flows)
            roots.append(rate)
            residuals.append(residual)
            if abs(residual) > tolerance:
                uncertain = True
        if uncertain or len(roots) > 1:
            return XirrResult(status="ambiguous", roots=tuple(roots), duration_days=days,
                              reason="multiple_roots" if len(roots) > 1 else "numerically_ill_conditioned")
        if not roots:
            return XirrResult(status="no_root", duration_days=days,
                              reason="no_root_in_proved_global_bounds")
        return XirrResult(rate=roots[0], status="ok", roots=tuple(roots), residual=residuals[0],
                          duration_days=days)
    except (DecimalException, ArithmeticError):
        return XirrResult(status="ambiguous", duration_days=days, reason="numerical_limit")
