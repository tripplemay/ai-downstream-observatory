"""Deterministic fixed-weight cash deployment, never a live order engine."""

from decimal import Decimal, ROUND_FLOOR
from zoneinfo import ZoneInfo

from worker.accounting import (
    DatedCashflow, NavPoint, ValuedFlow, annualized_unit_return, canonical,
    cashflow_profit, decimal, drawdown, exact_twr, quantize_cash, xirr,
)
from worker.accounting.decimal_math import ONE, ZERO, financial
from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp
from .snapshot import MarketView, validate_dataset, validate_parameters, validate_plan


ENGINE_VERSION = "fixed-weight-cash-deployment-v1"


@financial
def run_portfolio(dataset, plan, parameters, phase):
    window = plan["windows"][phase]
    start, end = instant(window["start"]), instant(window["end"])
    execution = plan["execution"]
    market = MarketView(dataset, execution["max_fx_age_seconds"])
    weights = {key: decimal(value) for key, value in parameters["weights"].items() if decimal(value) > ZERO}
    cash, positions, receivables, dividends_due = {"CNY": ZERO}, {}, {}, {}
    pending, events, curve, valued_flows = [], [], [], []
    costs, fx_costs, buys = ZERO, ZERO, ZERO
    flow_map = {}
    for flow in plan["contributions"]:
        at = instant(flow["at"])
        if start <= at <= end:
            flow_map[at] = flow_map.get(at, ZERO) + decimal(flow["amount_cny"])
    initial = decimal(plan["initial_capital_cny"]) + flow_map.pop(start, ZERO)
    cash["CNY"], units = initial, initial
    decisions = {instant(value) for value in plan["decision_times"] if start <= instant(value) <= end}
    times = {start, end, *flow_map, *decisions}
    times.update(instant(row["close_at"]) for row in dataset["sessions"] if start <= instant(row["close_at"]) <= end)
    times.update(instant(row["available_at"]) for row in dataset["sessions"] if start <= instant(row["available_at"]) <= end)
    actions = {}
    for action in dataset["actions"]:
        at = instant(action["at"])
        if start <= at <= end:
            actions.setdefault(at, []).append(action)
            times.add(at)
            if action["type"] == "dividend" and instant(action["pay_at"]) <= end:
                times.add(instant(action["pay_at"]))

    def fx(currency, at):
        return market.fx(currency, at)[0]

    def nav(at, decision=False):
        total = sum((amount * fx(currency, at) for currency, amount in cash.items() if amount != ZERO), ZERO)
        total += sum((amount * fx(currency, at) for currency, amount in receivables.items() if amount != ZERO), ZERO)
        for listing, quantity in positions.items():
            if quantity:
                price, _ = market.price(listing, at, decision=decision)
                total += quantity * price * fx(market.assets[listing]["currency"], at)
        return total

    def order_cost(quantity, price, currency, at):
        spot = fx(currency, at)
        execution_price = price * (ONE + decimal(execution["slippage_bps"]) / 10000)
        principal = quantity * execution_price * spot
        fee = max(decimal(execution["minimum_fee_cny"]), principal * decimal(execution["commission_bps"]) / 10000)
        fx_fee = principal * decimal(execution["fx_bps"]) / 10000 if currency != "CNY" else ZERO
        total = quantize_cash(principal + fee + fx_fee, execution["cash_quantum"])
        if total <= ZERO:
            raise WorkbenchError("ORDER_BELOW_CASH_PRECISION")
        return total, principal, fee, fx_fee, execution_price, spot

    for at in sorted(times):
        for action in actions.get(at, []):
            listing = action["listing_id"]
            quantity = positions.get(listing, ZERO)
            currency = market.assets[listing]["currency"]
            if action["type"] == "split":
                ratio = decimal(action["ratio"])
                positions[listing] = quantity * ratio
                for order in pending:
                    if order["listing_id"] == listing:
                        order["quantity"] *= ratio
                events.append({"type": "split", "at": stamp(at), "listing_id": listing, "ratio": canonical(ratio)})
            else:
                gross, tax = quantity * decimal(action["gross_per_unit"]), quantity * decimal(action["tax_per_unit"])
                net = gross - tax
                receivables[currency] = receivables.get(currency, ZERO) + net
                dividends_due.setdefault(instant(action["pay_at"]), []).append((currency, net, action["id"]))
                events.append({"type": "dividend_entitlement", "at": stamp(at), "listing_id": listing,
                               "gross": canonical(gross), "tax": canonical(tax), "net": canonical(net), "currency": currency})
        for currency, amount, action_id in dividends_due.pop(at, []):
            receivables[currency] -= amount
            cash[currency] = cash.get(currency, ZERO) + amount
            events.append({"type": "dividend_payment", "at": stamp(at), "action_id": action_id,
                           "amount": canonical(amount), "currency": currency})
        if at in flow_map:
            before = nav(at)
            amount = flow_map[at]
            if before <= ZERO:
                raise WorkbenchError("RESEARCH_UNIT_NAV_REQUIRES_RESET")
            units += amount / (before / units)
            cash["CNY"] += amount
            valued_flows.append(ValuedFlow(at, amount, before))
            events.append({"type": "external_contribution", "at": stamp(at), "amount_cny": canonical(amount)})
        for order in list(pending):
            if order["execute_at"] != at:
                continue
            listing, quantity = order["listing_id"], order["quantity"]
            currency = market.assets[listing]["currency"]
            price, price_id = market.price(listing, at, exact_at=at)
            total, principal, fee, fx_fee, execution_price, spot = order_cost(quantity, price, currency, at)
            pending.remove(order)
            other_reserved = sum((item["budget"] for item in pending), ZERO)
            if total > order["budget"] or total > cash["CNY"] - other_reserved:
                events.append({"type": "execution_skipped", "at": stamp(at), "listing_id": listing,
                               "reason": "EXECUTION_EXCEEDS_PRECOMMITTED_CASH_BUDGET", "budget_cny": canonical(order["budget"]),
                               "required_cny": canonical(total)})
                continue
            cash["CNY"] -= total
            positions[listing] = positions.get(listing, ZERO) + quantity
            costs += fee
            fx_costs += fx_fee
            buys += principal
            events.append({"type": "simulated_buy", "at": stamp(at), "decision_at": stamp(order["decision_at"]),
                           "listing_id": listing, "quantity": canonical(quantity), "execution_price": canonical(execution_price),
                           "fx_cny_per_unit": canonical(spot), "fee_cny": canonical(fee), "fx_fee_cny": canonical(fx_fee),
                           "total_cash_cny": canonical(total), "price_observation_id": price_id})
        if at in decisions:
            portfolio_nav = nav(at, decision=True)
            reserved = sum((item["budget"] for item in pending), ZERO)
            foreign_cash = sum((amount * fx(currency, at) for currency, amount in cash.items() if currency != "CNY"), ZERO)
            cash_floor = max(ZERO, portfolio_nav * (ONE - sum(weights.values(), ZERO)) - foreign_cash)
            available = max(ZERO, cash["CNY"] - reserved - cash_floor) * decimal(parameters["deployment_fraction"])
            known_prices, needs = {}, {}
            pending_listings = {order["listing_id"] for order in pending}
            for listing, weight in weights.items():
                if listing in pending_listings:
                    continue
                price, observation_id = market.price(listing, at, decision=True)
                rate = fx(market.assets[listing]["currency"], at)
                known_prices[listing] = (price, observation_id)
                needs[listing] = max(ZERO, portfolio_nav * weight - positions.get(listing, ZERO) * price * rate)
            if parameters["allocation"] == "repair_underweight":
                total_need = sum(needs.values(), ZERO)
                available = min(available, total_need)
                allocations = {listing: available * need / total_need for listing, need in needs.items()} if total_need else {}
            else:
                total_weight = sum((weights[listing] for listing in needs), ZERO)
                allocations = {listing: available * weights[listing] / total_weight for listing in needs} if total_weight else {}
            created = 0
            for listing, allocation in sorted(allocations.items()):
                asset = market.assets[listing]
                execution_at = market.next_session(listing, at, end)
                if execution_at is None or allocation <= ZERO:
                    continue
                price, observation_id = known_prices[listing]
                step = decimal(asset["quantity_step"])
                unit_principal = step * price * (ONE + decimal(execution["slippage_bps"]) / 10000) * fx(asset["currency"], at)
                if unit_principal <= ZERO:
                    raise WorkbenchError("NONPOSITIVE_ORDER_COST")
                # The fixed quantity is computed only from information known at
                # decision time; a later price jump cannot resize it in hindsight.
                low, high = 0, int((allocation / unit_principal).to_integral_value(rounding=ROUND_FLOOR))
                while low < high:
                    middle = (low + high + 1) // 2
                    if order_cost(step * middle, price, asset["currency"], at)[0] <= allocation:
                        low = middle
                    else:
                        high = middle - 1
                quantity = step * low
                if quantity <= ZERO:
                    continue
                pending.append({"listing_id": listing, "quantity": quantity, "budget": allocation,
                                "decision_at": at, "execute_at": execution_at})
                created += 1
                events.append({"type": "research_order", "at": stamp(at), "execute_at": stamp(execution_at),
                               "listing_id": listing, "quantity": canonical(quantity), "budget_cny": canonical(allocation),
                               "decision_price_observation_id": observation_id})
            events.append({"type": "evaluation", "at": stamp(at), "outcome": "proposed" if created else "unchanged",
                           "cash_cny": canonical(cash["CNY"]), "open_order_count": len(pending)})
        total_nav = nav(at)
        curve.append({"at": stamp(at), "nav_cny": canonical(total_nav), "unit_nav": canonical(total_nav / units),
                      "cash_cny": canonical(sum((amount * fx(currency, at) for currency, amount in cash.items() if amount != ZERO), ZERO))})
    closing = decimal(curve[-1]["nav_cny"])
    twr = exact_twr(start, end, initial, closing, valued_flows)
    risk = drawdown([NavPoint(instant(row["at"]), row["unit_nav"]) for row in curve])
    zone = ZoneInfo(plan["evaluation_timezone"])
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
            "fees_cny": canonical(costs), "fx_fees_cny": canonical(fx_costs),
            "buy_turnover_on_mean_observed_nav": canonical(buys / mean_nav) if mean_nav > ZERO else None,
            "ending_cash_ratio": canonical(decimal(curve[-1]["cash_cny"]) / closing) if closing > ZERO else None,
            "positions": {key: canonical(value) for key, value in sorted(positions.items())},
            "curve": curve, "events": events,
            "assumptions": ["independent_phase_restart_not_continuous_live_history", "ex_post_close_valuation_with_point_in_time_decisions",
                            "prepaid_cash_no_margin", "no_sales_contribution_deployment_only", "no_cash_interest",
                            "foreign_dividends_retained_in_original_currency", "buy_turnover_uses_arithmetic_mean_observed_nav"],
            "tax_coverage": plan["tax_coverage"]}


@financial
def compare_backtest(dataset, plan, parameters, phase):
    validate_dataset(dataset)
    validate_plan(plan, dataset)
    validate_parameters(parameters, dataset)
    if phase not in ("train", "validation", "holdout"):
        raise WorkbenchError("INVALID_RESEARCH_PHASE")
    if not dataset["corporate_actions_complete"]:
        raise WorkbenchError("CORPORATE_ACTION_COVERAGE_INCOMPLETE")
    if (plan["schema_version"] == "research-plan-v2") != bool(parameters.get("schema_version")):
        raise WorkbenchError("RESEARCH_PLAN_PARAMETER_VERSION_MISMATCH")
    runner = run_portfolio
    if plan["schema_version"] == "research-plan-v2":
        from .rotation import run_rotation_portfolio
        runner = run_rotation_portfolio
    strategy = runner(dataset, plan, parameters, phase)
    baseline = runner(dataset, plan, plan["benchmark"], phase)
    if strategy["initial_equity_cny"] != baseline["initial_equity_cny"] or strategy["contributions_cny"] != baseline["contributions_cny"]:
        raise WorkbenchError("BENCHMARK_CASHFLOW_MISMATCH")
    report = {"schema_version": "research-result-v1", "dataset_hash": content_hash(dataset), "plan_hash": content_hash(plan),
              "parameters_hash": content_hash(parameters), "phase": phase, "data_mode": dataset["mode"],
              "strategy": strategy, "benchmark": baseline,
              "excess_twr": canonical(decimal(strategy["twr"]) - decimal(baseline["twr"])) if strategy["twr"] is not None and baseline["twr"] is not None else None,
              "live_advice_eligible": False,
              "strategy_gates": {"S-%02d" % index: {"status": "BLOCKED" if index in (1, 6, 7, 8, 9, 10) else "NOT_RUN",
                                                       "reason": "Exploratory implementation evidence is not formal investment admission"}
                                 for index in range(1, 11)}}
    report["result_hash"] = content_hash(report)
    return report
