"""Pure, point-in-time gross-total-return signals for research only."""

from bisect import bisect_right
from decimal import Decimal
from fractions import Fraction
from zoneinfo import ZoneInfo

from worker.accounting.decimal_math import PRECISION, canonical, decimal, financial
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp
from .snapshot import validate_parameters


FORMULA = {
    "momentum": "TR[-1] / TR[-1-N] - 1",
    "moving_average": "mean(TR[-M:])",
    "period_return": "(units_end * close + accumulated_gross_cash) / previous_close",
    "reinvestment": "at_period_close",
    "action_order": "at_then_split_before_dividend_then_id",
    "arithmetic": "exact_rational_comparison_decimal60_half_even_evidence",
}
MARKET_ZONES = {"CN": "Asia/Shanghai", "HK": "Asia/Hong_Kong", "US": "America/New_York"}
MAX_EVIDENCE_DECIMAL_CHARS = 256
MAX_RATIO_BITS = 131072


def _bounded(value):
    if max(value.numerator.bit_length(), value.denominator.bit_length()) > MAX_RATIO_BITS:
        raise WorkbenchError("ROTATION_NUMERIC_EVIDENCE_LIMIT")
    return value


def _text(value):
    _bounded(value)
    if not value:
        return "0"
    numerator, denominator = abs(value.numerator), value.denominator
    exponent = (numerator.bit_length() - denominator.bit_length()) * 30103 // 100000

    def at_least_power(power):
        return numerator >= denominator * 10 ** power if power >= 0 else numerator * 10 ** -power >= denominator

    while not at_least_power(exponent):
        exponent -= 1
    while at_least_power(exponent + 1):
        exponent += 1
    if exponent >= MAX_EVIDENCE_DECIMAL_CHARS or exponent < 2 - MAX_EVIDENCE_DECIMAL_CHARS:
        raise WorkbenchError("ROTATION_NUMERIC_EVIDENCE_LIMIT")
    # Scale/divmod keeps exact half-even rounding without converting potentially
    # 39,000-digit integers to Decimal just to display 60 significant digits.
    scale = PRECISION - 1 - exponent
    divisor = denominator * 10 ** -scale if scale < 0 else denominator
    scaled = numerator * 10 ** scale if scale >= 0 else numerator
    quotient, remainder = divmod(scaled, divisor)
    if remainder * 2 > divisor or remainder * 2 == divisor and quotient % 2:
        quotient += 1
    while quotient % 10 == 0:
        quotient //= 10
        scale -= 1
    result = Decimal((int(value < 0), tuple(int(digit) for digit in str(quotient)), -scale))
    sign, digits, exponent = result.as_tuple()
    length = sign + (len(digits) + exponent if exponent >= 0 else max(len(digits) + 1, 2 - exponent))
    if result and length > MAX_EVIDENCE_DECIMAL_CHARS:
        raise WorkbenchError("ROTATION_NUMERIC_EVIDENCE_LIMIT")
    return canonical(result)


def _exact_price(market, listing_id, close, at):
    # MarketView.price checks the latest session even with exact_at; historical
    # signal windows instead select each exact session's as-known revision.
    group = market._price_groups.get(listing_id, {}).get(close)
    index = bisect_right(group[0], at) - 1 if group is not None else -1
    if index < 0:
        raise WorkbenchError("MISSING_REQUIRED_ROTATION_BAR")
    value, observation_id, observed, ambiguous = group[1][index]
    if observed != close or value <= 0:
        raise WorkbenchError("INVALID_ROTATION_BAR")
    if ambiguous:
        raise WorkbenchError("AMBIGUOUS_ROTATION_BAR_REVISION")
    return value, observation_id


def _action_available(action, mode):
    values = [instant(action["at"]), instant(action["published_at"])]
    if mode == "actual_replay":
        values.append(instant(action["ingested_at"]))
    return max(values)


def _signal(listing_id, asset, required):
    return {
        "schema_version": "research-rotation-signal-v1",
        "listing_id": listing_id, "market": asset.get("market"), "currency": asset.get("currency"),
        "status": "ineligible", "reason_codes": [], "selected": False, "rank": None,
        "target_weight": "0", "momentum": None, "moving_average": None, "latest_index": None,
        "formula": dict(FORMULA), "required_points": required, "available_points": 0,
        "lifecycle_session_count": 0, "window_bounds": [None, None], "window": [],
    }


def _window(signal, market, parameters, at, sessions, actions):
    listing_id = signal["listing_id"]
    start, end = market._lifecycles[listing_id]
    if at < start or end is not None and at >= end:
        signal["reason_codes"] = ["ASSET_NOT_ACTIVE_AT_DECISION"]
        return
    if not sessions:
        raise WorkbenchError("ROTATION_CALENDAR_UNAVAILABLE")
    eligible = [row for row in sessions if start <= instant(row["close_at"]) <= at]
    signal["lifecycle_session_count"] = len(eligible)
    required = signal["required_points"]
    window = eligible[-required:]
    if window:
        signal["window_bounds"] = [stamp(window[0]["close_at"]), stamp(window[-1]["close_at"])]
    first_date = sessions[0]["session_date"]
    listing_date = start.astimezone(ZoneInfo(MARKET_ZONES[signal["market"]])).date().isoformat()
    insufficient = len(window) < required
    if insufficient and listing_date < first_date:
        raise WorkbenchError("ROTATION_HISTORY_COVERAGE_UNKNOWN")
    previous_close, previous_at, index = None, None, Fraction(1)
    indexes = []
    action_offset = 0
    for session in window:
        close_at = instant(session["close_at"])
        if instant(session["available_at"]) > at:
            raise WorkbenchError("ROTATION_SESSION_NOT_AVAILABLE")
        price, observation_id = _exact_price(market, listing_id, close_at, at)
        exact_price = Fraction(price)
        units, gross_cash, action_evidence = Fraction(1), Fraction(0), []
        while action_offset < len(actions) and instant(actions[action_offset]["at"]) <= close_at:
            action = actions[action_offset]
            action_offset += 1
            if previous_at is None or instant(action["at"]) <= previous_at:
                continue
            before = units
            cash = Fraction(0)
            if action["type"] == "split":
                units = _bounded(units * Fraction(decimal(action["ratio"])))
            elif action["type"] == "dividend":
                cash = _bounded(units * Fraction(decimal(action["gross_per_unit"])))
                gross_cash = _bounded(gross_cash + cash)
            else:
                raise WorkbenchError("UNSUPPORTED_ROTATION_ACTION")
            action_evidence.append({"action_id": action["id"], "type": action["type"], "at": stamp(action["at"]),
                                    "ratio": action.get("ratio"), "gross_per_unit": action.get("gross_per_unit"),
                                    "units_before": _text(before), "units_after": _text(units),
                                    "gross_cash": _text(cash)})
        if previous_close is not None:
            index = _bounded(index * (units * exact_price + gross_cash) / previous_close)
        indexes.append(index)
        signal["window"].append({"session_date": session["session_date"], "close_at": stamp(close_at),
                                 "available_at": stamp(session["available_at"]), "observation_id": observation_id,
                                 "source_close": format(price, "f"), "close": canonical(price),
                                 "tr_index": _text(index), "actions": action_evidence})
        previous_close, previous_at = exact_price, close_at
    if insufficient:
        signal["reason_codes"] = ["IPO_INSUFFICIENT_HISTORY"]
        return
    momentum = _bounded(indexes[-1] / indexes[-parameters["momentum_sessions"] - 1] - 1)
    total = Fraction(0)
    for value in indexes[-parameters["moving_average_sessions"]:]:
        total = _bounded(total + value)
    average = _bounded(total / parameters["moving_average_sessions"])
    signal.update(momentum=_text(momentum), moving_average=_text(average), latest_index=_text(indexes[-1]))
    if indexes[-1] <= average:
        signal["reason_codes"].append("NOT_STRICTLY_ABOVE_MOVING_AVERAGE")
    floor = parameters["momentum_floor"]
    if floor is not None and momentum <= Fraction(decimal(floor)):
        signal["reason_codes"].append("MOMENTUM_NOT_STRICTLY_ABOVE_FLOOR")
    signal["reason_codes"].sort()
    if not signal["reason_codes"]:
        signal["status"] = "eligible"
    return momentum


def _compact_window(signal):
    points = signal["window"]
    start, end = signal.pop("window_bounds")
    signal["available_points"] = len(points)
    signal["window"] = {
        "start_at": start, "end_at": end, "count": len(points),
        "observation_ids": [point["observation_id"] for point in points],
        "action_ids": [action["action_id"] for point in points for action in point["actions"]],
        "selected_vector_hash": content_hash(points),
    }


@financial
def rank_targets(dataset, market, parameters, at):
    """Return evidence and weights, never trades, approvals or financial facts.

    The caller validates the frozen dataset before constructing MarketView.
    Monthly scheduling and execution tolerances belong to the research engine.
    """
    validate_contract(parameters, "research-rotation-parameters.schema.json")
    validate_parameters(parameters, dataset)
    at = instant(at)
    if market.dataset is not dataset and market.dataset != dataset:
        raise WorkbenchError("ROTATION_MARKET_DATASET_MISMATCH")
    required = max(parameters["momentum_sessions"] + 1, parameters["moving_average_sessions"])
    universe = sorted(parameters["universe"])
    universe_set = set(universe)
    if len(set(universe)) != len(universe):
        raise WorkbenchError("DUPLICATE_ROTATION_ASSET")
    if set(universe) - set(market.assets):
        raise WorkbenchError("UNKNOWN_ROTATION_ASSET")
    sessions = {}
    for session in market.sessions:
        sessions.setdefault(session["market"], []).append(session)
    actions = {}
    for action in dataset["actions"]:
        if action["listing_id"] in universe_set and _action_available(action, dataset["mode"]) <= at:
            actions.setdefault(action["listing_id"], []).append(action)
    for values in actions.values():
        values.sort(key=lambda row: (instant(row["at"]), 0 if row["type"] == "split" else 1, row["id"]))
    signals, reasons, momentums = [], [], {}
    for listing_id in universe:
        signal = _signal(listing_id, market.assets[listing_id], required)
        try:
            if not dataset["corporate_actions_complete"]:
                raise WorkbenchError("ROTATION_CORPORATE_ACTIONS_INCOMPLETE")
            momentums[listing_id] = _window(signal, market, parameters, at, sessions.get(signal["market"], []), actions.get(listing_id, []))
        except WorkbenchError as exc:
            signal["status"] = "blocked"
            signal["reason_codes"] = [str(exc)]
            reasons.append(str(exc) + ":" + listing_id)
        _compact_window(signal)
        signals.append(signal)
    if reasons:
        return {"status": "blocked", "targets": {}, "signals": signals, "reason_codes": sorted(set(reasons))}
    ranked = sorted((signal for signal in signals if signal["status"] == "eligible"),
                    key=lambda signal: (-momentums[signal["listing_id"]], signal["listing_id"]))
    weight = canonical(decimal(parameters["target_fraction"]) / parameters["top_n"])
    for number, signal in enumerate(ranked, 1):
        signal["rank"] = number
        if number <= parameters["top_n"]:
            signal["selected"], signal["target_weight"] = True, weight
        else:
            signal["reason_codes"] = ["OUTSIDE_TOP_N"]
    return {"status": "ready", "targets": {signal["listing_id"]: signal["target_weight"] for signal in signals},
            "signals": signals, "reason_codes": []}
