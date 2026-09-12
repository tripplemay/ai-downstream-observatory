"""Research-only monthly targets with fixed orders and explicit settlement."""

from bisect import bisect_right
from datetime import datetime
from decimal import ROUND_FLOOR
from heapq import heappop, heappush
from zoneinfo import ZoneInfo

from worker.accounting import (
    DatedCashflow, NavPoint, ValuedFlow, annualized_unit_return, canonical,
    cashflow_profit, decimal, drawdown, exact_twr, quantize_cash, xirr,
)
from worker.accounting.decimal_math import ONE, ZERO, financial
from worker.orchestration.db import WorkbenchError, instant, stamp
from .snapshot import MarketView


ENGINE_VERSION = "monthly-rotation-rebalance-v1"


def _next_month(at, zone):
    local = at.astimezone(zone)
    year, month = (local.year + 1, 1) if local.month == 12 else (local.year, local.month + 1)
    return datetime(year, month, 1, tzinfo=zone).astimezone(at.tzinfo)


@financial
def run_rotation_portfolio(dataset, plan, parameters, phase):
    """Consume a validated frozen v2 plan/dataset; never read or write a DB."""
    execution = plan["execution"]
    if (dataset["schema_version"] != "research-dataset-v2" or plan["schema_version"] != "research-plan-v2"
            or execution["model"] != "next_session_close_fixed_quantity"
            or execution["settlement_model"] != "explicit_market_calendar"
            or execution["sale_proceeds"] != "convert_to_cny_at_fill_then_settle"):
        raise WorkbenchError("UNSUPPORTED_ROTATION_EXECUTION_MODEL")
    kind = parameters["schema_version"]
    if kind not in ("research-rotation-parameters-v1", "research-fixed-rebalance-parameters-v1"):
        raise WorkbenchError("UNSUPPORTED_ROTATION_PARAMETERS")
    if phase not in ("train", "validation", "holdout"):
        raise WorkbenchError("INVALID_RESEARCH_PHASE")
    window = plan["windows"][phase]
    start, end = instant(window["start"]), instant(window["end"])
    zone = ZoneInfo(plan["evaluation_timezone"])
    market = MarketView(dataset, execution["max_fx_age_seconds"])
    observation_by_id = {row["id"]: row for row in dataset["observations"]}
    action_windows = {}
    for action in sorted(dataset["actions"], key=lambda row: (instant(row["at"]), row["type"] != "split", row["id"])):
        action_windows.setdefault(action["listing_id"], ([], []))[0].append(instant(action["at"]))
        action_windows[action["listing_id"]][1].append(action)
    sessions = {(row["market"], instant(row["close_at"])): row for row in dataset["sessions"]}
    settlements = {(row["market"], row["session_date"]): row for row in dataset["settlements"]}
    if len(settlements) != len(dataset["settlements"]):
        raise WorkbenchError("DUPLICATE_RESEARCH_SETTLEMENT")
    cash, positions, dividends_receivable = {"CNY": ZERO}, {}, {}
    pending, unsettled, sale_receivables, dividend_payments = [], [], [], {}
    orders, slots, events, curve, valued_flows = {}, {}, [], [], []
    costs = fx_costs = slippage_costs = cash_rounding = buys = sells = ZERO
    flow_map = {}
    for flow in plan["contributions"]:
        at = instant(flow["at"])
        if start <= at <= end:
            flow_map[at] = flow_map.get(at, ZERO) + decimal(flow["amount_cny"])
    initial = decimal(plan["initial_capital_cny"]) + flow_map.pop(start, ZERO)
    cash["CNY"], units = initial, initial
    decisions = {instant(value) for value in plan["decision_times"] if start <= instant(value) <= end}
    times, queued = [], set()

    def schedule(at):
        if start <= at <= end and at not in queued:
            queued.add(at)
            heappush(times, at)

    for at in (start, end, *decisions, *flow_map):
        schedule(at)
    for session in dataset["sessions"]:
        schedule(instant(session["close_at"]))
        schedule(instant(session["available_at"]))
    for observation in dataset["observations"]:
        if observation["metric"] == "fx_cny_per_unit":
            schedule(market.available(observation))
    actions = {}
    for action in dataset["actions"]:
        at = instant(action["at"])
        if start <= at <= end:
            actions.setdefault(at, []).append(action)
            schedule(at)
            if action["type"] == "dividend":
                schedule(instant(action["pay_at"]))

    def fx(currency, at):
        return market.fx(currency, at)[0]

    def mark(listing, at, decision=False):
        price, quote_id = market.price(listing, at, decision=decision)
        observed = instant(observation_by_id[quote_id]["observed_at"])
        raw, applied = price, []
        action_times, action_rows = action_windows.get(listing, ([], []))
        for action in action_rows[bisect_right(action_times, observed):bisect_right(action_times, at)]:
            if instant(action["published_at"]) > at or (dataset["mode"] == "actual_replay" and instant(action["ingested_at"]) > at):
                raise WorkbenchError("CORPORATE_ACTION_CARRY_NOT_KNOWN:" + action["id"])
            price = price / decimal(action["ratio"]) if action["type"] == "split" else price - decimal(action["gross_per_unit"])
            if price <= ZERO:
                raise WorkbenchError("NONPOSITIVE_EX_ACTION_CARRY_MARK:" + listing)
            applied.append(action["id"])
        evidence = {"listing_id": listing, "price_observation_id": quote_id, "quote_observed_at": stamp(observed),
                    "mark_kind": "theoretical_ex_action_carry" if applied else "observed_close",
                    "raw_price": canonical(raw), "mark_price": canonical(price), "action_ids": applied}
        return price, quote_id, evidence

    def nav(at, decision=False, carry_marks=None):
        total = sum((amount * fx(currency, at) for currency, amount in cash.items() if amount), ZERO)
        total += sum((amount * fx(currency, at) for currency, amount in dividends_receivable.items() if amount), ZERO)
        total += sum((row["amount"] for row in sale_receivables), ZERO)
        for listing, quantity in positions.items():
            if quantity:
                price, _, evidence = mark(listing, at, decision=decision)
                if carry_marks is not None and evidence["action_ids"]:
                    carry_marks.append(evidence)
                total += quantity * price * fx(market.assets[listing]["currency"], at)
        return total

    def cost(side, quantity, price, currency, at):
        spot = fx(currency, at)
        slip = decimal(execution["slippage_bps"]) / 10000
        execution_price = price * (ONE + slip if side == "buy" else ONE - slip)
        if execution_price <= ZERO:
            raise WorkbenchError("NONPOSITIVE_ORDER_COST")
        principal = quantity * execution_price * spot
        fee = max(decimal(execution["minimum_fee_cny"]), principal * decimal(execution["commission_bps"]) / 10000)
        fx_fee = principal * decimal(execution["fx_bps"]) / 10000 if currency != "CNY" else ZERO
        unrounded = principal + fee + fx_fee if side == "buy" else principal - fee - fx_fee
        amount = quantize_cash(unrounded, execution["cash_quantum"])
        if amount <= ZERO:
            raise WorkbenchError("ORDER_BELOW_CASH_PRECISION")
        rounding = amount - unrounded if side == "buy" else unrounded - amount
        return amount, principal, fee, fx_fee, execution_price, spot, quantity * price * spot * slip, rounding

    def reserved():
        return sum((order["budget"] for order in pending if order["side"] == "buy" and order["state"] == "scheduled"), ZERO)

    def finish(order, state, at, reason=None, **extra):
        order["state"] = state
        if order in pending:
            pending.remove(order)
        if reason:
            events.append({"type": "order_expired" if state == "expired" else "execution_skipped",
                           "at": stamp(at), "order_id": order["id"], "listing_id": order["listing_id"],
                           "side": order["side"], "quantity": canonical(order["quantity"]), "reason": reason, **extra})

    def next_close(listing, after, expiry):
        at = market.next_session(listing, after, expiry)
        return at if at is not None and at < expiry else None

    def settle(at):
        for lot in list(unsettled):
            if lot["settled_at"] <= at:
                unsettled.remove(lot)
                events.append({"type": "stock_settlement", "at": stamp(at), "order_id": lot["order_id"],
                               "listing_id": lot["listing_id"], "quantity": canonical(lot["quantity"]),
                               "settlement_evidence": lot["evidence"]})
        for payment in list(sale_receivables):
            if payment["settled_at"] <= at:
                sale_receivables.remove(payment)
                cash["CNY"] += payment["amount"]
                orders[payment["order_id"]]["state"] = "settled"
                events.append({"type": "sale_cash_settlement", "at": stamp(at), "order_id": payment["order_id"],
                               "amount_cny": canonical(payment["amount"]), "settlement_evidence": payment["evidence"]})

    def activate(at):
        for order in list(pending):
            if order["state"] != "waiting_for_sales":
                continue
            dependencies = [orders[key] for key in order["dependencies"]]
            if any(row["state"] in ("skipped", "expired") for row in dependencies):
                finish(order, "skipped", at, "DEPENDENT_SALE_NOT_COMPLETED")
                continue
            if not all(row["state"] == "settled" for row in dependencies):
                continue
            if order["budget"] > cash["CNY"] - reserved() - order["cash_floor"]:
                finish(order, "skipped", at, "SETTLED_CASH_BELOW_PRECOMMITTED_BUDGET",
                       budget_cny=canonical(order["budget"]), available_cny=canonical(max(ZERO, cash["CNY"] - reserved() - order["cash_floor"])))
                continue
            try:
                at_close = next_close(order["listing_id"], at, order["expires_at"])
            except WorkbenchError as exc:
                finish(order, "skipped", at, str(exc))
                continue
            if at_close is None:
                finish(order, "skipped", at, "NO_EXECUTABLE_CLOSE_AFTER_SETTLEMENT")
                continue
            order.update(state="scheduled", execute_at=at_close)
            schedule(at_close)
            events.append({"type": "order_cash_reserved", "at": stamp(at), "order_id": order["id"],
                           "execute_at": stamp(at_close), "budget_cny": canonical(order["budget"]),
                           "reason": "DEPENDENT_SALE_CASH_SETTLED"})

    def evaluate(at):
        period = at.astimezone(zone).strftime("%Y-%m")
        if period in slots:
            events.append({"type": "monthly_monitor", "at": stamp(at), "period": period,
                           "slot_at": slots[period], "reason": "MONTHLY_SLOT_ALREADY_EVALUATED"})
            return
        slots[period] = stamp(at)
        expiry = min(end, _next_month(at, zone))
        schedule(expiry)
        base = {"type": "evaluation", "at": stamp(at), "period": period, "expires_at": stamp(expiry),
                "cash_cny": canonical(cash["CNY"]), "open_order_count": len(pending)}
        if pending or unsettled or sale_receivables:
            events.append({**base, "outcome": "blocked", "targets": {}, "signals": [], "deltas": [],
                           "reason_codes": ["ACTIVE_ORDERS_OR_UNSETTLED_ASSETS"]})
            return
        if kind == "research-rotation-parameters-v1":
            from .rotation_signals import rank_targets
            ranked = rank_targets(dataset, market, parameters, at)
        else:
            ranked = {"status": "ready", "targets": dict(sorted(parameters["weights"].items())),
                      "signals": [], "reason_codes": []}
        base.update(targets=ranked["targets"], signals=ranked["signals"])
        if ranked["status"] != "ready":
            events.append({**base, "outcome": "blocked", "deltas": [], "reason_codes": ranked["reason_codes"]})
            return
        try:
            value = nav(at, decision=True)
            weights = {key: decimal(amount) for key, amount in ranked["targets"].items()}
            if value <= ZERO or any(weight < ZERO for weight in weights.values()) or sum(weights.values(), ZERO) > ONE:
                raise WorkbenchError("INVALID_ROTATION_TARGETS_OR_NAV")
            tolerance = max(decimal(parameters["tolerance"]["absolute_cny"]), value * decimal(parameters["tolerance"]["weight"]))
            deltas, quotes = [], {}
            for listing in sorted(set(weights) | {key for key, quantity in positions.items() if quantity}):
                weight, quantity = weights.get(listing, ZERO), positions.get(listing, ZERO)
                if not weight and not quantity:
                    continue
                price, quote_id, price_mark = mark(listing, at, decision=True)
                rate, fx_id = market.fx(market.assets[listing]["currency"], at)
                target, current = value * weight, quantity * price * rate
                difference = target - current
                deltas.append({"listing_id": listing, "target_cny": canonical(target), "current_cny": canonical(current),
                               "difference_cny": canonical(difference), "within_tolerance": abs(difference) <= tolerance,
                               "price_mark": price_mark})
                quotes[listing] = (price, rate, quote_id, fx_id, price_mark)
        except WorkbenchError as exc:
            events.append({**base, "outcome": "blocked", "deltas": [], "reason_codes": [str(exc)]})
            return
        base.update(deltas=deltas, nav_cny=canonical(value), tolerance_cny=canonical(tolerance))
        if all(row["within_tolerance"] for row in deltas):
            events.append({**base, "outcome": "unchanged", "reason_codes": ["TARGETS_WITHIN_TOLERANCE"]})
            return
        issues, planned, projected_sales = [], [], ZERO
        sales, needs = [], {}
        foreign_cash = sum((amount * fx(currency, at) for currency, amount in cash.items() if currency != "CNY" and amount), ZERO)
        cash_floor = max(ZERO, value * (ONE - sum(weights.values(), ZERO)) - foreign_cash)

        def make_order(listing, side, quantity, budget=ZERO, dependencies=()):
            order = {"id": "order:%06d" % (len(orders) + 1), "listing_id": listing, "side": side,
                     "quantity": quantity, "budget": budget, "cash_floor": cash_floor,
                     "decision_at": at, "expires_at": expiry, "dependencies": list(dependencies), "state": "planned"}
            orders[order["id"]] = order
            planned.append(order)
            return order

        for row in deltas:
            if row["within_tolerance"]:
                continue
            listing, difference = row["listing_id"], decimal(row["difference_cny"])
            if difference > ZERO:
                needs[listing] = difference
                continue
            price, rate, _, _, _ = quotes[listing]
            step = decimal(market.assets[listing]["quantity_step"])
            desired_quantity = positions.get(listing, ZERO) if decimal(row["target_cny"]) == ZERO else -difference / (price * rate)
            quantity = min(positions.get(listing, ZERO), step * int((desired_quantity / step).to_integral_value(rounding=ROUND_FLOOR)))
            if quantity <= ZERO:
                issues.append("SELL_BELOW_QUANTITY_STEP:" + listing)
                continue
            if decimal(row["target_cny"]) == ZERO and quantity < positions.get(listing, ZERO):
                issues.append("SELL_QUANTITY_STEP_RESIDUAL:" + listing)
            try:
                execute_at = next_close(listing, at, expiry)
                proceeds = cost("sell", quantity, price, market.assets[listing]["currency"], at)[0]
                if execute_at is None:
                    raise WorkbenchError("NO_EXECUTABLE_CLOSE:" + listing)
            except WorkbenchError as exc:
                issues.append(str(exc))
                continue
            order = make_order(listing, "sell", quantity)
            order.update(state="scheduled", execute_at=execute_at)
            sales.append(order["id"])
            projected_sales += proceeds
        available = max(ZERO, cash["CNY"] - cash_floor) + projected_sales
        total_need = sum(needs.values(), ZERO)
        deployment = min(available, total_need)
        for listing, need in sorted(needs.items()):
            allocation = deployment * need / total_need if total_need else ZERO
            price, rate, _, _, _ = quotes[listing]
            asset, step = market.assets[listing], decimal(market.assets[listing]["quantity_step"])
            if allocation <= ZERO:
                issues.append("NO_SETTLED_OR_DEPENDENT_CASH:" + listing)
                continue
            low, high = 0, int((allocation / (price * rate * step)).to_integral_value(rounding=ROUND_FLOOR))
            try:
                while low < high:
                    middle = (low + high + 1) // 2
                    if cost("buy", step * middle, price, asset["currency"], at)[0] <= allocation:
                        low = middle
                    else:
                        high = middle - 1
            except WorkbenchError as exc:
                issues.append(str(exc) + ":" + listing)
                continue
            if not low:
                issues.append("BUY_BELOW_QUANTITY_STEP_OR_FEES:" + listing)
                continue
            immediate_reserved = sum((order["budget"] for order in planned if order["side"] == "buy" and order["state"] == "scheduled"), ZERO)
            if allocation <= cash["CNY"] - cash_floor - immediate_reserved:
                try:
                    execute_at = next_close(listing, at, expiry)
                    if execute_at is None:
                        raise WorkbenchError("NO_EXECUTABLE_CLOSE:" + listing)
                except WorkbenchError as exc:
                    issues.append(str(exc))
                    continue
                order = make_order(listing, "buy", step * low, allocation)
                order.update(state="scheduled", execute_at=execute_at)
            elif sales:
                order = make_order(listing, "buy", step * low, allocation, sales)
                order["state"] = "waiting_for_sales"
            else:
                issues.append("NO_SETTLED_OR_DEPENDENT_CASH:" + listing)
        for order in planned:
            pending.append(order)
            if order["state"] == "scheduled":
                schedule(order["execute_at"])
            _, _, price_id, fx_id, price_mark = quotes[order["listing_id"]]
            events.append({"type": "research_order", "at": stamp(at), "order_id": order["id"],
                           "side": order["side"], "listing_id": order["listing_id"], "quantity": canonical(order["quantity"]),
                           "budget_cny": canonical(order["budget"]) if order["side"] == "buy" else None,
                           "execute_at": stamp(order["execute_at"]) if order["state"] == "scheduled" else None,
                           "expires_at": stamp(expiry), "funding": order["state"], "dependency_order_ids": order["dependencies"],
                           "decision_price_observation_id": price_id, "decision_fx_observation_id": fx_id,
                           "decision_price_mark": price_mark})
        events.append({**base, "outcome": "proposed" if planned else "blocked", "reason_codes": sorted(set(issues)),
                       "order_ids": [row["id"] for row in planned], "partial": bool(issues)})

    while times:
        at = heappop(times)
        for order in list(pending):
            if at >= order["expires_at"]:
                finish(order, "expired", at, "MONTHLY_ORDER_EXPIRED")
        for action in sorted(actions.get(at, []), key=lambda row: (row["type"] != "split", row["id"])):
            listing = action["listing_id"]
            quantity = positions.get(listing, ZERO)
            currency = market.assets[listing]["currency"]
            if action["type"] == "split":
                ratio = decimal(action["ratio"])
                positions[listing] = quantity * ratio
                for lot in unsettled:
                    if lot["listing_id"] == listing:
                        lot["quantity"] *= ratio
                for order in pending:
                    if order["listing_id"] == listing:
                        order["quantity"] *= ratio
                events.append({"type": "split", "at": stamp(at), "action_id": action["id"],
                               "listing_id": listing, "ratio": canonical(ratio)})
            else:
                gross, tax = quantity * decimal(action["gross_per_unit"]), quantity * decimal(action["tax_per_unit"])
                net = gross - tax
                dividends_receivable[currency] = dividends_receivable.get(currency, ZERO) + net
                dividend_payments.setdefault(instant(action["pay_at"]), []).append((currency, net, action["id"]))
                events.append({"type": "dividend_entitlement", "at": stamp(at), "action_id": action["id"],
                               "listing_id": listing, "gross": canonical(gross), "tax": canonical(tax),
                               "net": canonical(net), "currency": currency})
        for currency, amount, action_id in dividend_payments.pop(at, []):
            dividends_receivable[currency] -= amount
            cash[currency] = cash.get(currency, ZERO) + amount
            events.append({"type": "dividend_payment", "at": stamp(at), "action_id": action_id,
                           "amount": canonical(amount), "currency": currency})
        settle(at)
        if at in flow_map:
            before, amount = nav(at), flow_map[at]
            if before <= ZERO:
                raise WorkbenchError("RESEARCH_UNIT_NAV_REQUIRES_RESET")
            units += amount / (before / units)
            cash["CNY"] += amount
            valued_flows.append(ValuedFlow(at, amount, before))
            events.append({"type": "external_contribution", "at": stamp(at), "amount_cny": canonical(amount)})
        activate(at)
        # Sales cannot finance a same-close buy: settlement activation always
        # schedules strictly after the actual cash-availability instant.
        for order in list(pending):
            if order["state"] != "scheduled" or order["execute_at"] != at:
                continue
            listing, quantity, side = order["listing_id"], order["quantity"], order["side"]
            asset = market.assets[listing]
            if quantity <= ZERO or quantity % decimal(asset["quantity_step"]) != ZERO:
                finish(order, "skipped", at, "FIXED_QUANTITY_NOT_EXECUTABLE_AFTER_ACTION")
                continue
            session = sessions[(asset["market"], at)]
            evidence = settlements.get((asset["market"], session["session_date"]))
            if (evidence is None or instant(evidence["published_at"]) > at
                    or instant(evidence["settled_at"]) < at or not evidence["source_evidence"]
                    or dataset["mode"] == "actual_replay" and (not evidence.get("ingested_at") or instant(evidence["ingested_at"]) > at)):
                finish(order, "skipped", at, "SETTLEMENT_EVIDENCE_UNAVAILABLE")
                continue
            settlement_at = instant(evidence["settled_at"])
            try:
                price, price_id = market.price(listing, at, exact_at=at)
                amount, principal, fee, fx_fee, fill_price, spot, slip_cost, rounding = cost(side, quantity, price, asset["currency"], at)
            except WorkbenchError as exc:
                finish(order, "skipped", at, str(exc))
                continue
            if side == "buy":
                other_reserved = reserved() - order["budget"]
                if amount > order["budget"] or amount > cash["CNY"] - other_reserved:
                    finish(order, "skipped", at, "EXECUTION_EXCEEDS_PRECOMMITTED_CASH_BUDGET",
                           budget_cny=canonical(order["budget"]), required_cny=canonical(amount))
                    continue
                cash["CNY"] -= amount
                positions[listing] = positions.get(listing, ZERO) + quantity
                unsettled.append({"order_id": order["id"], "listing_id": listing, "quantity": quantity,
                                  "settled_at": settlement_at, "evidence": evidence})
                buys += principal
            else:
                available_quantity = positions.get(listing, ZERO) - sum((lot["quantity"] for lot in unsettled if lot["listing_id"] == listing), ZERO)
                if quantity > available_quantity:
                    finish(order, "skipped", at, "STOCK_NOT_SETTLED_OR_UNAVAILABLE")
                    continue
                positions[listing] -= quantity
                sale_receivables.append({"order_id": order["id"], "amount": amount,
                                         "settled_at": settlement_at, "evidence": evidence})
                sells += principal
            finish(order, "filled", at)
            costs += fee
            fx_costs += fx_fee
            slippage_costs += slip_cost
            cash_rounding += rounding
            schedule(settlement_at)
            events.append({"type": "simulated_" + side, "at": stamp(at), "order_id": order["id"],
                           "decision_at": stamp(order["decision_at"]), "listing_id": listing,
                           "quantity": canonical(quantity), "execution_price": canonical(fill_price),
                           "fx_cny_per_unit": canonical(spot), "fee_cny": canonical(fee), "fx_fee_cny": canonical(fx_fee),
                           "cash_rounding_cny": canonical(rounding),
                           "total_cash_cny": canonical(amount), "price_observation_id": price_id,
                           "fx_observation_id": market.fx(asset["currency"], at)[1], "settled_at": stamp(settlement_at),
                           "settlement_evidence": evidence})
        settle(at)
        activate(at)
        if at in decisions:
            evaluate(at)
        carry_marks = []
        total = nav(at, carry_marks=carry_marks)
        curve.append({"at": stamp(at), "nav_cny": canonical(total), "unit_nav": canonical(total / units),
                      "cash_cny": canonical(sum((amount * fx(currency, at) for currency, amount in cash.items() if amount), ZERO)),
                      "derived_carry_marks": sorted(carry_marks, key=lambda row: row["listing_id"])})
    closing = decimal(curve[-1]["nav_cny"])
    twr = exact_twr(start, end, initial, closing, valued_flows)
    risk = drawdown([NavPoint(instant(row["at"]), row["unit_nav"]) for row in curve])
    flows = [DatedCashflow(start.astimezone(zone).date(), -initial)]
    flows.extend(DatedCashflow(at.astimezone(zone).date(), -amount) for at, amount in sorted(flow_map.items()))
    flows.append(DatedCashflow(end.astimezone(zone).date(), closing))
    irr = xirr(flows)
    days = (end.astimezone(zone).date() - start.astimezone(zone).date()).days
    annual = annualized_unit_return("1", curve[-1]["unit_nav"], days) if days > 0 else None
    mean_nav = sum((decimal(row["nav_cny"]) for row in curve), ZERO) / len(curve)
    return {"engine_version": ENGINE_VERSION, "phase": phase, "window": window,
            "initial_equity_cny": canonical(initial), "contributions_cny": canonical(sum(flow_map.values(), ZERO)),
            "ending_nav_cny": canonical(closing), "profit_cny": canonical(cashflow_profit(closing, initial, flow_map.values())),
            "twr": canonical(twr.value) if twr.value is not None else None, "return_method": twr.method,
            "annualized_unit_return": canonical(annual.value) if annual is not None and annual.value is not None else None,
            "xirr": {"status": irr.status, "rate": canonical(irr.rate) if irr.rate is not None else None,
                     "roots": [canonical(root) for root in irr.roots], "duration_days": irr.duration_days},
            "max_drawdown": canonical(risk.max_drawdown) if risk.max_drawdown is not None else None,
            "recovered_at": stamp(risk.recovered_at) if risk.recovered_at else None,
            "fees_cny": canonical(costs), "fx_fees_cny": canonical(fx_costs), "slippage_cny": canonical(slippage_costs),
            "cash_rounding_cny": canonical(cash_rounding),
            "buy_turnover_on_mean_observed_nav": canonical(buys / mean_nav) if mean_nav > ZERO else None,
            "sell_turnover_on_mean_observed_nav": canonical(sells / mean_nav) if mean_nav > ZERO else None,
            "total_turnover_on_mean_observed_nav": canonical((buys + sells) / mean_nav) if mean_nav > ZERO else None,
            "ending_cash_ratio": canonical(decimal(curve[-1]["cash_cny"]) / closing) if closing > ZERO else None,
            "positions": {key: canonical(value) for key, value in sorted(positions.items())},
            "ending_cash": {key: canonical(value) for key, value in sorted(cash.items())},
            "ending_receivables": {"sale_cny": canonical(sum((row["amount"] for row in sale_receivables), ZERO)),
                                   "dividends": {key: canonical(value) for key, value in sorted(dividends_receivable.items())}},
            "ending_unsettled_positions": [{"order_id": row["order_id"], "listing_id": row["listing_id"],
                                            "quantity": canonical(row["quantity"]), "settled_at": stamp(row["settled_at"])} for row in unsettled],
            "execution_failure_count": sum(row["type"] in ("execution_skipped", "order_expired") for row in events),
            "monthly_evaluation_counts": {outcome: sum(row["type"] == "evaluation" and row["outcome"] == outcome for row in events)
                                          for outcome in ("proposed", "unchanged", "blocked")},
            "curve": curve, "events": events,
            "assumptions": ["independent_phase_restart_not_continuous_forward_history", "research_only_no_actual_facts_or_approval",
                            "ex_post_close_valuation_with_point_in_time_decisions", "explicit_market_calendar_settlement",
                            "sale_proceeds_converted_to_cny_at_fill_unavailable_until_settlement", "fixed_decision_quantity_and_budget",
                            "theoretical_ex_action_carry_between_raw_closes_not_an_observed_or_live_price",
                            "monthly_first_decision_only", "unsettled_assets_block_new_monthly_orders", "no_margin", "no_cash_interest",
                            "foreign_dividends_retained_in_original_currency", "turnover_uses_arithmetic_mean_observed_nav"],
            "tax_coverage": plan["tax_coverage"]}
