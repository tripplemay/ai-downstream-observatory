"""Cash-flow-neutral performance with explicit unavailable/estimated states."""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from .decimal_math import AccountingError, ONE, ZERO, decimal, financial, nonnegative


def utc(value):
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise AccountingError("timezone_aware_datetime_required")
    return value.astimezone(timezone.utc)


def _microseconds(delta):
    return decimal(delta.days * 86400000000 + delta.seconds * 1000000 + delta.microseconds)


@dataclass(frozen=True)
class ReturnResult:
    value: Optional[object]
    method: str
    status: str = "ok"
    assumptions: tuple = ()


@dataclass(frozen=True)
class ValuedFlow:
    at: datetime
    amount: object
    nav_before: object


@dataclass(frozen=True)
class TimedFlow:
    at: object
    amount: object


@financial
def exact_twr(start_at, end_at, opening_nav, closing_nav, flows=(), quality="complete"):
    start_at, end_at = utc(start_at), utc(end_at)
    if end_at <= start_at:
        raise AccountingError("invalid_period")
    if quality != "complete":
        return ReturnResult(None, "exact_twr", "incomplete_valuation")
    start, end = nonnegative(opening_nav, "nav"), nonnegative(closing_nav, "nav")
    if start == ZERO:
        return ReturnResult(None, "exact_twr", "nonpositive_denominator")
    factor, previous, prior_at = ONE, start, start_at
    for flow in flows:
        at = utc(flow.at)
        if not (prior_at < at <= end_at):
            raise AccountingError("flow_outside_period_or_unsorted")
        before, amount = nonnegative(flow.nav_before, "nav"), decimal(flow.amount)
        if previous <= ZERO or before <= ZERO or before + amount <= ZERO:
            return ReturnResult(None, "exact_twr", "requires_new_return_interval")
        if at == end_at and before + amount != end:
            raise AccountingError("closing_flow_valuation_inconsistent")
        factor *= before / previous
        previous, prior_at = before + amount, at
    return ReturnResult(factor * end / previous - ONE, "exact_twr")


@financial
def modified_dietz(start_at, end_at, opening_nav, closing_nav, flows=(),
                    evaluation_timezone=None, quality="complete"):
    start_at, end_at = utc(start_at), utc(end_at)
    if end_at <= start_at:
        raise AccountingError("invalid_period")
    if quality != "complete":
        return ReturnResult(None, "modified_dietz_estimate", "incomplete_valuation")
    start, end = nonnegative(opening_nav, "nav"), nonnegative(closing_nav, "nav")
    duration, total, weighted = _microseconds(end_at - start_at), ZERO, ZERO
    assumptions = set()
    for flow in flows:
        if isinstance(flow.at, datetime):
            at = utc(flow.at)
        elif isinstance(flow.at, date):
            if not evaluation_timezone:
                raise AccountingError("date_only_requires_evaluation_timezone")
            # EOD is the boundary at the next local midnight, including DST.
            at = utc(datetime.combine(flow.at + timedelta(days=1), time.min,
                                      ZoneInfo(evaluation_timezone)))
            assumptions.add("date_only_eod_assumption")
        else:
            raise AccountingError("invalid_flow_date")
        if not start_at <= at <= end_at:
            raise AccountingError("flow_outside_period")
        amount = decimal(flow.amount)
        total += amount
        weighted += _microseconds(end_at - at) / duration * amount
    denominator = start + weighted
    if denominator <= ZERO:
        return ReturnResult(None, "modified_dietz_estimate", "nonpositive_denominator",
                            tuple(sorted(assumptions)))
    return ReturnResult((end - start - total) / denominator, "modified_dietz_estimate",
                        assumptions=tuple(sorted(assumptions)))


@financial
def chain_returns(returns):
    returns = tuple(returns)
    if not returns:
        return ReturnResult(None, "linked_return", "no_data")
    method = ("exact_twr" if all(item.method == "exact_twr" for item in returns)
              else "linked_return_estimate")
    factor, assumptions = ONE, set()
    for index, item in enumerate(returns):
        assumptions.update(item.assumptions)
        if item.status != "ok" or item.value is None:
            return ReturnResult(None, method, "incomplete_return_chain", tuple(sorted(assumptions)))
        value = decimal(item.value)
        if value < -ONE:
            raise AccountingError("return_below_minus_one")
        factor *= ONE + value
        if factor == ZERO and index < len(returns) - 1:
            return ReturnResult(None, method, "requires_new_return_interval", tuple(sorted(assumptions)))
    return ReturnResult(factor - ONE, method, assumptions=tuple(sorted(assumptions)))


@dataclass(frozen=True)
class NavPoint:
    at: datetime
    unit_nav: Optional[object]
    quality: str = "complete"


@dataclass(frozen=True)
class DrawdownResult:
    max_drawdown: Optional[object]
    known_segment_drawdown: object
    peak_at: Optional[datetime]
    trough_at: Optional[datetime]
    recovered_at: Optional[datetime]
    underwater_until: Optional[datetime]
    quality: str
    method: str


@financial
def drawdown(points, estimated=False):
    points = tuple(points)
    if not points:
        return DrawdownResult(None, ZERO, None, None, None, None, "blocked", "no_data")
    previous_at, peak, peak_at = None, None, None
    worst, worst_peak, worst_trough, worst_value = ZERO, None, None, None
    recovered_at, recovery_valid, has_gap = None, True, False
    for point in points:
        at = utc(point.at)
        if previous_at is not None and at <= previous_at:
            raise AccountingError("nav_dates_not_strictly_increasing")
        previous_at = at
        if point.quality not in ("complete", "provisional", "blocked"):
            raise AccountingError("invalid_quality")
        if point.unit_nav is None or point.quality != "complete":
            has_gap, peak, peak_at = True, None, None
            if recovered_at is None:
                recovery_valid = False
            continue
        value = nonnegative(point.unit_nav, "unit_nav")
        if peak is None:
            if value == ZERO:
                has_gap = True
                continue
            peak, peak_at = value, at
        if worst_value is not None and recovered_at is None and recovery_valid and value >= worst_value:
            recovered_at = at
        if value >= peak:
            peak, peak_at = value, at
        decline = value / peak - ONE
        if decline < worst:
            worst, worst_peak, worst_trough, worst_value = decline, peak_at, at, peak
            recovered_at, recovery_valid = None, True
    method = "unit_nav_estimate" if estimated else "unit_nav"
    return DrawdownResult(None if has_gap else worst, worst, worst_peak, worst_trough,
                          recovered_at, previous_at if worst < ZERO and recovered_at is None else None,
                          "blocked" if has_gap else "complete", method)


@financial
def annualized_unit_return(start_nav, end_nav, days):
    if not isinstance(days, int) or isinstance(days, bool) or days <= 0:
        raise AccountingError("positive_day_count_required")
    start, end = nonnegative(start_nav), nonnegative(end_nav)
    if start == ZERO:
        return ReturnResult(None, "annualized_unit_return", "nonpositive_denominator")
    value = (end / start) ** (decimal(365) / decimal(days)) - ONE
    return ReturnResult(value, "annualized_unit_return",
                        assumptions=("shorter_than_one_year",) if days < 365 else ())
