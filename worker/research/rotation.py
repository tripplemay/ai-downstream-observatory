"""Versioned research targets with fixed orders and explicit settlement."""

from bisect import bisect_right
from datetime import datetime
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN, localcontext
from heapq import heappop, heappush
from zoneinfo import ZoneInfo

from worker.accounting import (
    DatedCashflow, NavPoint, ValuedFlow, annualized_unit_return, canonical,
    cashflow_profit, decimal, drawdown, exact_twr, quantize_cash, xirr,
)
from worker.accounting.decimal_math import ONE, ZERO, financial
from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp
from .snapshot import MarketView
from .fixed_policy import VERSION as FIXED_POLICY_VERSION, class_drift, cooldown_elapsed, period as policy_period
from .order_reviews import OrderReviews
from .cash_intents import CashIntents
from .settled_funding import prepare_settled_cash_buys


ENGINE_VERSION = "monthly-rotation-rebalance-v1"


def _next_month(at, zone):
    local = at.astimezone(zone)
    year, month = (local.year + 1, 1) if local.month == 12 else (local.year, local.month + 1)
    return datetime(year, month, 1, tzinfo=zone).astimezone(at.tzinfo)


@financial
def run_rotation_portfolio(dataset, plan, parameters, phase, *, progress=None):
    """Consume a validated frozen v2 plan/dataset; never read or write a DB."""
    if plan['schema_version'] == 'research-plan-v6':
        with localcontext() as arithmetic:
            arithmetic.prec = 256
            return _run_portfolio(dataset, plan, parameters, phase, progress=progress)
    return _run_portfolio(dataset, plan, parameters, phase, progress=progress)


@financial
def run_continuous_portfolio(dataset, plan, releases, *, progress=None, holding_baseline=False):
    """Internal engine for a validated continuous plan and frozen releases."""
    return _run_portfolio(dataset, plan, plan["parameters"], "continuous", releases=releases, progress=progress, holding_baseline=holding_baseline)


def _run_portfolio(dataset, plan, parameters, phase, *, releases=None, progress=None, holding_baseline=False):
    continuous = releases is not None
    settled_funding = plan['schema_version'] == 'research-plan-v6'
    reviewable = settled_funding or plan["schema_version"] in ("research-plan-v5", "investor-long-horizon-plan-v4")
    action_aware = reviewable or plan["schema_version"] == "research-plan-v4"
    bounded = settled_funding or plan["schema_version"] in ("research-plan-v3", "research-plan-v4", "research-plan-v5", "investor-long-horizon-plan-v3", "investor-long-horizon-plan-v4")
    execution = plan["execution"]
    expected_plans = ("investor-long-horizon-plan-v1", "investor-long-horizon-plan-v2", "investor-long-horizon-plan-v3", "investor-long-horizon-plan-v4") if continuous else ("research-plan-v2", "research-plan-v3", "research-plan-v4", "research-plan-v5", "research-plan-v6")
    if (dataset["schema_version"] != "research-dataset-v2" or plan["schema_version"] not in expected_plans
            or execution["model"] != ("next_session_close_bounded_fixed_quantity" if bounded else "next_session_close_fixed_quantity")
            or execution["settlement_model"] != "explicit_market_calendar"
            or execution["sale_proceeds"] != "convert_to_cny_at_fill_then_settle"):
        raise WorkbenchError("UNSUPPORTED_ROTATION_EXECUTION_MODEL")
    kind = parameters["schema_version"]
    if kind not in ("research-rotation-parameters-v1", "research-fixed-rebalance-parameters-v1", FIXED_POLICY_VERSION):
        raise WorkbenchError("UNSUPPORTED_ROTATION_PARAMETERS")
    low_frequency = kind == FIXED_POLICY_VERSION
    if bounded:
        if continuous:
            from worker.market.contracts import validate_contract
            validate_contract(plan, "investor-long-horizon-input-v4.schema.json" if reviewable else "investor-long-horizon-input-v3.schema.json", fragment="$defs/plan")
            if (decimal(execution["cash_quantum"]) != decimal("0.01")
                    or any(not ZERO <= decimal(execution[name]) <= 10000 for name in (
                        "buy_price_buffer_bps", "buy_fx_buffer_bps", "commission_bps", "fx_bps"))
                    or not ZERO <= decimal(execution["slippage_bps"]) < 10000
                    or decimal(execution["minimum_fee_cny"]) < ZERO):
                raise WorkbenchError("INVALID_BOUNDED_EXECUTION_COST")
        else:
            from .snapshot import validate_plan
            validate_plan(plan, dataset)
            if settled_funding and content_hash(parameters) not in {
                    content_hash(row) for row in [*plan['parameter_candidates'], plan['benchmark']]}:
                raise WorkbenchError('SETTLED_CASH_PARAMETERS_OUTSIDE_PLAN')
        if not low_frequency:
            raise WorkbenchError("BOUNDED_RESEARCH_REQUIRES_FIXED_POLICY")
    if not isinstance(holding_baseline, bool) or holding_baseline and not (continuous and low_frequency):
        raise WorkbenchError("UNSUPPORTED_HOLDING_BASELINE")
    if continuous and not low_frequency:
        raise WorkbenchError("UNSUPPORTED_CONTINUOUS_PARAMETERS")
    if not continuous and phase not in ("train", "validation", "holdout"):
        raise WorkbenchError("INVALID_RESEARCH_PHASE")
    window = plan["window"] if continuous else plan["windows"][phase]
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
    reviews = OrderReviews(orders, events, parameters["weights"]) if reviewable else None
    intents = CashIntents(orders, events, reviews, content_hash({'parameters': parameters, 'execution': execution,
        'decision_times': plan['decision_times'], 'window': window})) if settled_funding else None
    funding_pending, last_proposed_at = False, None
    deferred_review = None
    costs = fx_costs = slippage_costs = cash_rounding = buys = sells = ZERO
    flow_map = {}
    for flow in plan["contributions"]:
        at = instant(flow["at"])
        if start <= at <= end:
            flow_map[at] = flow_map.get(at, ZERO) + decimal(flow["amount_cny"])
    initial = decimal(plan["initial_capital_cny"]) + flow_map.pop(start, ZERO)
    cash["CNY"], units = initial, initial
    locked_cash, cumulative_principal = (initial if continuous else ZERO), initial
    decisions = {instant(value) for value in plan["decision_times"] if start <= instant(value) <= end}
    times, queued = [], set()

    def schedule(at):
        if start <= at <= end and at not in queued:
            queued.add(at)
            heappush(times, at)

    for at in (start, end, *decisions, *flow_map):
        schedule(at)
    for at in releases or {}:
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

    def cost(side, quantity, price, currency, at, *, spot_override=None):
        spot = fx(currency, at) if spot_override is None else spot_override
        slip = decimal(execution["slippage_bps"]) / 10000
        execution_price = price * (ONE + slip if side == "buy" else ONE - slip)
        if execution_price <= ZERO:
            raise WorkbenchError("NONPOSITIVE_ORDER_COST")
        principal = quantity * execution_price * spot
        fee = max(decimal(execution["minimum_fee_cny"]), principal * decimal(execution["commission_bps"]) / 10000)
        fx_fee = principal * decimal(execution["fx_bps"]) / 10000 if currency != "CNY" else ZERO
        unrounded = principal + fee + fx_fee if side == "buy" else principal - fee - fx_fee
        amount = ((unrounded / decimal(execution["cash_quantum"])).to_integral_value(
                  rounding=ROUND_CEILING if side == 'buy' else ROUND_HALF_EVEN)
                  * decimal(execution["cash_quantum"])) if settled_funding or bounded and side == "buy" else quantize_cash(unrounded, execution["cash_quantum"])
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
            if reviews is not None and state in ("skipped", "expired") and "cancellation_review_id" not in extra:
                reviews.failed(order, at)

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
                if settled_funding:
                    orders[payment['order_id']]['settled_at'] = stamp(payment['settled_at'])
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
            cash_floor = order["cash_floor"]
            if continuous:
                # New arrivals/releases may change locked capital while a
                # precommitted buy waits for sale settlement.
                cash_floor += locked_cash - order["locked_cash_at_decision"]
            if order["budget"] > cash["CNY"] - reserved() - cash_floor:
                finish(order, "skipped", at, "SETTLED_CASH_BELOW_PRECOMMITTED_BUDGET",
                       budget_cny=canonical(order["budget"]), available_cny=canonical(max(ZERO, cash["CNY"] - reserved() - cash_floor)))
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

    def resolve_deferred(at, outcome):
        nonlocal deferred_review
        if deferred_review is not None:
            events.append({"type": "policy_review_resumed", "at": stamp(at), **deferred_review, "outcome": outcome})
            deferred_review = None

    def evaluate(at):
        nonlocal funding_pending, last_proposed_at, deferred_review
        period = policy_period(at, zone, parameters["rebalance"]) if low_frequency else at.astimezone(zone).strftime("%Y-%m")
        if not low_frequency and period in slots:
            events.append({"type": "monthly_monitor", "at": stamp(at), "period": period,
                           "slot_at": slots[period], "reason": "MONTHLY_SLOT_ALREADY_EVALUATED"})
            return
        if not low_frequency:
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
            deployment_value = value - locked_cash
            weights = {key: decimal(amount) for key, amount in ranked["targets"].items()}
            if value <= ZERO or any(weight < ZERO for weight in weights.values()) or sum(weights.values(), ZERO) > ONE:
                raise WorkbenchError("INVALID_ROTATION_TARGETS_OR_NAV")
            tolerance = max(decimal(parameters["tolerance"]["absolute_cny"]), deployment_value * decimal(parameters["tolerance"]["weight"]))
            deltas, quotes = [], {}
            for listing in sorted(set(weights) | {key for key, quantity in positions.items() if quantity}):
                weight, quantity = weights.get(listing, ZERO), positions.get(listing, ZERO)
                if not weight and not quantity:
                    continue
                price, quote_id, price_mark = mark(listing, at, decision=True)
                rate, fx_id = market.fx(market.assets[listing]["currency"], at)
                target, current = deployment_value * weight, quantity * price * rate
                difference = target - current
                deltas.append({"listing_id": listing, "target_cny": canonical(target), "current_cny": canonical(current),
                               "difference_cny": canonical(difference), "within_tolerance": abs(difference) <= tolerance,
                               "price_mark": price_mark})
                quotes[listing] = (price, rate, quote_id, fx_id, price_mark)
            if reviews is not None:
                reviews.require_fresh(quotes, at)
        except WorkbenchError as exc:
            events.append({**base, "outcome": "blocked", "deltas": [], "reason_codes": [str(exc)]})
            return
        base.update(deltas=deltas, nav_cny=canonical(value), tolerance_cny=canonical(tolerance))
        cash_intent = intents.active if intents is not None else None
        if cash_intent is not None and cash_intent['state'] in ('failed', 'expired'):
            events.append({**base, 'outcome': 'blocked', 'reason_codes': ['CASH_INTENT_TERMINAL_FAILURE']})
            return
        if cash_intent is not None and cash_intent['state'] == 'waiting_decision' and reviews.active is None:
            declaration = cash_intent['declaration']
            scope = [row for row in deltas if row['listing_id'] in declaration['buy_listing_ids']]
            needs_now = [row for row in scope if not row['within_tolerance'] and decimal(row['difference_cny']) > ZERO]
            events.append({'type': 'cash_intent_reassessment', 'at': stamp(at), 'intent_id': declaration['id'],
                           'nav_cny': canonical(value), 'deltas': scope,
                           'current_sale_order_ids': list(cash_intent['current_sale_order_ids'])})
            if not needs_now:
                intents.resolve(at, 'original_buy_scope_no_longer_needed')
                events.append({**base, 'outcome': 'unchanged', 'reason_codes': ['CASH_INTENT_BUY_SCOPE_NO_LONGER_NEEDED']})
                return
            foreign_cash = sum((amount * fx(currency, at) for currency, amount in cash.items() if currency != 'CNY' and amount), ZERO)
            floor = locked_cash + max(ZERO, deployment_value * (ONE - sum(weights.values(), ZERO)) - foreign_cash)
            floor = (floor * 100).to_integral_value(rounding=ROUND_CEILING) / 100
            needs_document, executable = [], {}
            try:
                for index, row in enumerate(needs_now, 1):
                    listing = row['listing_id']
                    price, rate, price_id, fx_id, evidence = quotes[listing]
                    quote, asset = observation_by_id[price_id], market.assets[listing]
                    fx_row = observation_by_id.get(fx_id)
                    close_at = next_close(listing, at, instant(declaration['deadline']))
                    if close_at is None:
                        raise WorkbenchError('NO_EXECUTABLE_CLOSE:' + listing)
                    executable[listing] = close_at
                    needs_document.append({'listing_id': listing, 'order_id': 'order:%06d' % (len(orders) + index),
                        'need_cny': canonical((decimal(row['difference_cny']) * 100).to_integral_value(rounding=ROUND_FLOOR) / 100),
                        'quantity_step': asset['quantity_step'], 'currency': asset['currency'], 'close': canonical(price),
                        'fx_cny_per_unit': canonical(rate), 'observed_at': quote['observed_at'],
                        'available_at': stamp(market.available(quote)), 'mark_kind': evidence['mark_kind'],
                        'fx_observed_at': fx_row['observed_at'] if fx_row else None,
                        'fx_available_at': stamp(market.available(fx_row)) if fx_row else None,
                        'price_observation_id': price_id, 'fx_observation_id': fx_id or 'fx:CNY:constant'})
                current_sales = cash_intent['current_sale_order_ids']
                document = {'schema_version': 'settled-cash-buy-preparation-v2',
                    'intent': {**declaration, 'sale_order_ids': list(current_sales),
                               'buy_listing_ids': [row['listing_id'] for row in needs_now]},
                    'decision_at': stamp(at), 'decision_times': plan['decision_times'],
                    'cash': {'as_of': stamp(at), 'settled_cny': canonical(cash['CNY']),
                             'reserved_cny': canonical(reserved()), 'floor_cny': canonical(floor)},
                    'book': [{'id': key, 'listing_id': orders[key]['listing_id'], 'side': 'sell',
                              'cash_intent_id': declaration['id'], 'state': orders[key]['state'],
                              'settled_at': orders[key].get('settled_at')} for key in current_sales],
                    'needs': needs_document, 'execution': {key: execution[key] for key in (
                        'commission_bps', 'minimum_fee_cny', 'fx_bps', 'slippage_bps', 'buy_price_buffer_bps',
                        'buy_fx_buffer_bps', 'cash_quantum', 'max_fx_age_seconds')}}
                preparation = prepare_settled_cash_buys(document)
                for listing, close_at in executable.items():
                    if any(instant(action['published_at']) <= at and (dataset['mode'] != 'actual_replay'
                           or instant(action['ingested_at']) <= at) and at < instant(action['at']) <= close_at
                           for action in action_windows.get(listing, ([], []))[1]):
                        raise WorkbenchError('KNOWN_ACTION_BEFORE_SCHEDULED_CLOSE')
            except WorkbenchError as exc:
                events.append({**base, 'outcome': 'blocked', 'reason_codes': [str(exc)], 'cash_intent_id': declaration['id']})
                return
            planned = []
            for prepared in preparation['orders']:
                listing = prepared['listing_id']
                order = {'id': prepared['order_id'], 'listing_id': listing, 'side': 'buy',
                    'quantity': decimal(prepared['quantity']), 'budget': decimal(prepared['budget_cny']),
                    'cash_floor': floor, 'decision_at': at, 'expires_at': instant(declaration['deadline']),
                    'dependencies': list(current_sales), 'state': 'scheduled', 'execute_at': executable[listing],
                    'allow_sales': False, 'price_cap': decimal(prepared['buy_price_cap']),
                    'fx_cap': decimal(prepared['buy_fx_cap']), 'worst_total_cash': decimal(prepared['worst_total_cash_cny'])}
                orders[order['id']] = order
                planned.append(order)
            intents.publish(planned, preparation, at)
            publish_orders(planned, at, instant(declaration['deadline']), quotes)
            events.append({**base, 'outcome': 'proposed', 'reason_codes': ['SETTLED_CASH_BUY_BATCH_FROZEN'],
                           'order_ids': [row['id'] for row in planned], 'partial': False})
            return
        reviewing = reviews is not None and reviews.active is not None
        review_scope = set(reviews.active["listing_ids"]) if reviewing else None
        if reviewing:
            base["reassessment_scope"] = sorted(review_scope)
        if continuous:
            base.update(deployment_base_cny=canonical(deployment_value), locked_cash_cny=canonical(locked_cash))
        allow_sales = True
        if low_frequency:
            classes = class_drift(weights, parameters["roles"], {row["listing_id"]: decimal(row["current_cny"]) for row in deltas},
                                  deployment_value, decimal(parameters["class_drift_threshold"]))
            bootstrap = not any(positions.values())
            calendar_due, breached = period not in slots, any(row["threshold_breached"] for row in classes)
            triggers = (["INITIAL_DEPLOYMENT"] if bootstrap else []) + (["NEW_CASH_REPAIR"] if funding_pending else [])
            reassessing = reviewing
            if reassessing:
                triggers.append("CORPORATE_ACTION_ORDER_REVIEW")
            if not holding_baseline:
                triggers += (["CALENDAR_REVIEW"] if calendar_due else []) + (["CLASS_WEIGHT_BREACH"] if breached else [])
            base.update(class_drift=classes, trigger_codes=triggers, last_proposed_at=stamp(last_proposed_at) if last_proposed_at else None)
            if not triggers or not (bootstrap or funding_pending or reassessing) and not cooldown_elapsed(at, last_proposed_at, zone, parameters["minimum_days_between_rebalances"]):
                if action_aware and not triggers:
                    resolve_deferred(at, "no_longer_triggered")
                events.append({**base, "type": "policy_monitor", "reason_codes": ["REBALANCE_COOLDOWN" if triggers else "LOW_FREQUENCY_RULE_NOT_TRIGGERED"]})
                return
            # Cash is already included in NAV. Repair first without selling;
            # this is not a second hypothetical contribution added to targets.
            allow_sales = not holding_baseline and not funding_pending
            if reassessing:
                allow_sales = reviews.active["allow_sales"]
            base["allocation_method"] = "rebalance_to_targets" if allow_sales else "new_cash_repair_without_sales"
            if not action_aware:
                slots[period] = stamp(at)
                funding_pending = False
        actionable = [row for row in deltas if review_scope is None or row["listing_id"] in review_scope]
        targets_satisfied = all(row["within_tolerance"] for row in actionable)
        sale_review_satisfied = cash_intent is not None and cash_intent['state'] in ('waiting_sales', 'waiting_decision') and reviewing and all(
            row['within_tolerance'] or decimal(row['difference_cny']) > ZERO for row in actionable)
        if targets_satisfied or sale_review_satisfied or reviewing and not allow_sales and all(
                row["within_tolerance"] or decimal(row["difference_cny"]) < ZERO for row in actionable):
            if action_aware:
                if not reviewing:
                    slots[period] = stamp(at)
                    funding_pending = False
                resolve_deferred(at, "targets_within_tolerance")
                if reviews is not None:
                    reviews.complete(at, within_tolerance=True, no_sales_repair_satisfied=not targets_satisfied and not sale_review_satisfied,
                                     sale_scope_no_longer_needed=sale_review_satisfied and not targets_satisfied)
            events.append({**base, "outcome": "unchanged", "reason_codes": ["SELL_SCOPE_NO_LONGER_NEEDED" if sale_review_satisfied and not targets_satisfied else "TARGETS_WITHIN_TOLERANCE"]})
            return
        issues, planned, projected_sales = [], [], ZERO
        sales, needs = [], {}
        foreign_cash = sum((amount * fx(currency, at) for currency, amount in cash.items() if currency != "CNY" and amount), ZERO)
        cash_floor = locked_cash + max(ZERO, deployment_value * (ONE - sum(weights.values(), ZERO)) - foreign_cash)

        def make_order(listing, side, quantity, budget=ZERO, dependencies=(), bounds=None):
            order = {"id": "order:%06d" % (len(orders) + 1), "listing_id": listing, "side": side,
                     "quantity": quantity, "budget": budget, "cash_floor": cash_floor,
                     "decision_at": at, "expires_at": expiry, "dependencies": list(dependencies), "state": "planned"}
            if continuous:
                order["locked_cash_at_decision"] = locked_cash
            if cash_intent is not None:
                order['expires_at'] = min(expiry, instant(cash_intent['declaration']['deadline']))
            if reviewable:
                order["allow_sales"] = allow_sales
            if bounds is not None:
                order.update(price_cap=bounds[0], fx_cap=bounds[1], worst_total_cash=bounds[2])
            orders[order["id"]] = order
            planned.append(order)
            return order

        for row in actionable:
            if row["within_tolerance"]:
                continue
            listing, difference = row["listing_id"], decimal(row["difference_cny"])
            if difference > ZERO:
                needs[listing] = difference
                continue
            if not allow_sales:
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
        deferred_buys = settled_funding and (bool(sales) or cash_intent is not None and cash_intent['state'] in ('waiting_sales', 'waiting_decision'))
        for listing, need in ([] if deferred_buys else sorted(needs.items())):
            allocation = deployment * need / total_need if total_need else ZERO
            if bounded:
                allocation = (allocation * 100).to_integral_value(rounding=ROUND_FLOOR) / 100
            price, rate, _, _, _ = quotes[listing]
            asset, step = market.assets[listing], decimal(market.assets[listing]["quantity_step"])
            cap = price * (ONE + decimal(execution["buy_price_buffer_bps"]) / 10000) if bounded else price
            fx_cap = rate * (ONE + decimal(execution["buy_fx_buffer_bps"]) / 10000) if bounded and asset["currency"] != "CNY" else rate
            if allocation <= ZERO:
                issues.append("NO_SETTLED_OR_DEPENDENT_CASH:" + listing)
                continue
            low, high = 0, int((allocation / (cap * fx_cap * step)).to_integral_value(rounding=ROUND_FLOOR))
            try:
                while low < high:
                    middle = (low + high + 1) // 2
                    if cost("buy", step * middle, cap, asset["currency"], at, spot_override=fx_cap if bounded else None)[0] <= allocation:
                        low = middle
                    else:
                        high = middle - 1
            except WorkbenchError as exc:
                issues.append(str(exc) + ":" + listing)
                continue
            if not low:
                issues.append("BUY_BELOW_QUANTITY_STEP_OR_FEES:" + listing)
                continue
            bounds = (cap, fx_cap, cost("buy", step * low, cap, asset["currency"], at, spot_override=fx_cap)[0]) if bounded else None
            immediate_reserved = sum((order["budget"] for order in planned if order["side"] == "buy" and order["state"] == "scheduled"), ZERO)
            if allocation <= cash["CNY"] - cash_floor - immediate_reserved:
                try:
                    execute_at = next_close(listing, at, expiry)
                    if execute_at is None:
                        raise WorkbenchError("NO_EXECUTABLE_CLOSE:" + listing)
                except WorkbenchError as exc:
                    issues.append(str(exc))
                    continue
                order = make_order(listing, "buy", step * low, allocation, bounds=bounds)
                order.update(state="scheduled", execute_at=execute_at)
            elif sales:
                order = make_order(listing, "buy", step * low, allocation, sales, bounds=bounds)
                order["state"] = "waiting_for_sales"
            else:
                issues.append("NO_SETTLED_OR_DEPENDENT_CASH:" + listing)
        if action_aware:
            if (reviews is not None and reviews.active is not None or settled_funding) and (issues or not planned):
                for order in planned:
                    del orders[order["id"]]
                events.append({**base, "outcome": "blocked", "reason_codes": sorted(set(issues + ["ORDER_REVIEW_REPLACEMENT_INCOMPLETE"]))})
                return
            deferred = []
            for order in planned:
                if order["state"] != "scheduled":
                    continue
                for action in action_windows.get(order["listing_id"], ([], []))[1]:
                    known = instant(action["published_at"]) <= at and (dataset["mode"] != "actual_replay"
                        or instant(action["ingested_at"]) <= at)
                    if known and at < instant(action["at"]) <= order["execute_at"]:
                        deferred.append({"listing_id": order["listing_id"], "side": order["side"],
                            "planned_close_at": stamp(order["execute_at"]), "action_id": action["id"],
                            "action_at": action["at"]})
            if deferred:
                # These are tentative calculations, not published orders or reservations.
                for order in planned:
                    del orders[order["id"]]
                deferred_review = {"first_deferred_at": deferred_review["first_deferred_at"] if deferred_review else stamp(at),
                                   "last_deferred_at": stamp(at)}
                events.append({**base, "outcome": "deferred", "reason_codes": sorted(set(issues + [
                    "KNOWN_ACTION_BEFORE_SCHEDULED_CLOSE"])), "deferred_actions": deferred})
                return
            if not reviewing:
                slots[period] = stamp(at)
                funding_pending = False
            if planned and not issues:
                resolve_deferred(at, "new_orders_proposed")
            if reviews is not None and reviews.active is not None:
                reviews.publish(planned, at)
                if intents is not None and intents.active is not None:
                    intents.bind_replacements(planned, at)
            if settled_funding and sales and needs and intents.active is None:
                intents.declare(sales, needs, at, expiry)
        publish_orders(planned, at, expiry, quotes)
        events.append({**base, "outcome": "proposed" if planned else "blocked", "reason_codes": sorted(set(issues)),
                       "order_ids": [row["id"] for row in planned], "partial": bool(issues)})
        if low_frequency and planned:
            last_proposed_at = at

    def publish_orders(planned, at, expiry, quotes):
        for order in planned:
            pending.append(order)
            if order["state"] == "scheduled":
                schedule(order["execute_at"])
            _, _, price_id, fx_id, price_mark = quotes[order["listing_id"]]
            events.append({"type": "research_order", "at": stamp(at), "order_id": order["id"],
                           "side": order["side"], "listing_id": order["listing_id"], "quantity": canonical(order["quantity"]),
                           "budget_cny": canonical(order["budget"]) if order["side"] == "buy" else None,
                           "execute_at": stamp(order["execute_at"]) if order["state"] == "scheduled" else None,
                           "expires_at": stamp(order['expires_at'] if settled_funding else expiry), "funding": order["state"], "dependency_order_ids": order["dependencies"],
                           "decision_price_observation_id": price_id, "decision_fx_observation_id": fx_id,
                           "decision_price_mark": price_mark,
                           **({'cash_intent_id': order['cash_intent_id']} if 'cash_intent_id' in order else {}),
                           **({"origin_review_id": order["origin_review_id"], "replaces_order_ids": order["replaces_order_ids"]} if "origin_review_id" in order else {}),
                           **({"buy_price_cap": canonical(order["price_cap"]), "buy_fx_cap": canonical(order["fx_cap"]),
                               "worst_total_cash_cny": canonical(order["worst_total_cash"])} if bounded and order["side"] == "buy" else {})})
    while times:
        if progress is not None:
            progress()
        at = heappop(times)
        for order in list(pending):
            if at >= order["expires_at"]:
                finish(order, "expired", at, "FIXED_POLICY_ORDER_EXPIRED" if low_frequency else "MONTHLY_ORDER_EXPIRED")
        if reviews is not None:
            reviews.on_actions(actions.get(at, []), pending, at, finish)
        for action in sorted(actions.get(at, []), key=lambda row: (row["type"] != "split", row["id"])):
            listing = action["listing_id"]
            if bounded and not reviewable:
                for order in list(pending):
                    if order["listing_id"] == listing:
                        finish(order, "skipped", at, "CORPORATE_ACTION_INVALIDATES_FROZEN_ORDER", action_id=action["id"])
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
            if low_frequency and currency == "CNY" and amount > ZERO:
                funding_pending = True
            events.append({"type": "dividend_payment", "at": stamp(at), "action_id": action_id,
                           "amount": canonical(amount), "currency": currency})
        settle(at)
        if at in flow_map:
            before, amount = nav(at), flow_map[at]
            if before <= ZERO:
                raise WorkbenchError("RESEARCH_UNIT_NAV_REQUIRES_RESET")
            units += amount / (before / units)
            cash["CNY"] += amount
            cumulative_principal += amount
            if continuous:
                locked_cash += amount
            elif low_frequency:
                funding_pending = True
            valued_flows.append(ValuedFlow(at, amount, before))
            events.append({"type": "external_contribution", "at": stamp(at), "amount_cny": canonical(amount)})
        if continuous and at in releases:
            amount = releases[at]
            if not ZERO <= amount <= locked_cash:
                raise WorkbenchError("INVESTOR_LONG_HORIZON_RELEASE_EXCEEDS_LOCKED_CASH")
            locked_cash -= amount
            funding_pending = funding_pending or amount > ZERO
            events.append({"type": "funding_release", "at": stamp(at), "amount_cny": canonical(amount),
                           "remaining_locked_cash_cny": canonical(locked_cash)})
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
                if bounded and (price > order["price_cap"] or spot > order["fx_cap"]):
                    finish(order, "skipped", at, "EXECUTION_PRICE_OR_FX_BOUND_EXCEEDED",
                           buy_price_cap=canonical(order["price_cap"]), buy_fx_cap=canonical(order["fx_cap"]),
                           observed_price=canonical(price), observed_fx=canonical(spot))
                    continue
                other_reserved = reserved() - order["budget"]
                if amount > order["budget"] or amount > cash["CNY"] - other_reserved - locked_cash:
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
        if reviews is not None:
            reviews.complete(at)
        if intents is not None:
            intents.refresh(at)
        if at in decisions:
            evaluate(at)
        carry_marks = []
        total = nav(at, carry_marks=carry_marks)
        curve.append({"at": stamp(at), "nav_cny": canonical(total), "unit_nav": canonical(total / units),
                      "cash_cny": canonical(sum((amount * fx(currency, at) for currency, amount in cash.items() if amount), ZERO)),
                      "derived_carry_marks": sorted(carry_marks, key=lambda row: row["listing_id"])})
        if continuous or bounded:
            if locked_cash < ZERO or cash["CNY"] - locked_cash - reserved() < ZERO:
                raise WorkbenchError("INVESTOR_LONG_HORIZON_CASH_RESERVATION_INVALID")
        if continuous:
            curve[-1].update(principal_cny=canonical(cumulative_principal), profit_cny=canonical(total - cumulative_principal),
                            locked_cash_cny=canonical(locked_cash), released_capital_cny=canonical(cumulative_principal - locked_cash),
                            unreserved_released_cash_cny=canonical(cash["CNY"] - locked_cash - reserved()))
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
    if low_frequency:
        bought = {row["listing_id"] for row in events if row["type"] == "simulated_buy"}
        missing = sorted(listing for listing, weight in parameters["weights"].items() if decimal(weight) > ZERO and listing not in bought)
        if missing:
            events.append({"type": "policy_deployment_failed", "at": stamp(end), "missing_listings": missing,
                           "reason": "INITIAL_DEPLOYMENT_INCOMPLETE" if bought else "INITIAL_DEPLOYMENT_NOT_EXECUTED"})
        elif action_aware and deferred_review is not None:
            events.append({"type": "policy_deployment_failed", "at": stamp(end), **deferred_review,
                           "reason": "DEFERRED_POLICY_REVIEW_UNRESOLVED"})
    raw_failures = sum(row["type"] in ("execution_skipped", "order_expired", "policy_deployment_failed") for row in events)
    engine = 'fixed-policy-settled-intent-rebalance-v6' if settled_funding else ("continuous-event-review-hold-v1" if holding_baseline else "continuous-event-review-funding-v1") if reviewable and continuous else "fixed-policy-event-review-rebalance-v5" if reviewable else "fixed-policy-action-aware-bounded-rebalance-v4" if action_aware else ("continuous-bounded-hold-new-cash-v1" if holding_baseline else "continuous-bounded-fixed-policy-funding-v1") if continuous and bounded else "fixed-policy-bounded-rebalance-v3" if bounded else "continuous-hold-new-cash-v1" if holding_baseline else "continuous-fixed-policy-funding-v1" if continuous else "fixed-policy-rebalance-v2" if low_frequency else ENGINE_VERSION
    return {"engine_version": engine, "phase": phase, "window": window,
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
            "execution_failure_count": raw_failures,
            **(reviews.result(raw_failures) if reviews is not None else {}),
            **(intents.result() if intents is not None else {}),
            **{("policy_evaluation_counts" if low_frequency else "monthly_evaluation_counts"):
                {outcome: sum(row["type"] == "evaluation" and row["outcome"] == outcome for row in events)
                 for outcome in (("proposed", "unchanged", "blocked", "deferred") if action_aware else ("proposed", "unchanged", "blocked"))}},
            **({"policy_rules": {**{key: parameters[key] for key in ("rebalance", "roles", "class_drift_threshold", "minimum_days_between_rebalances", "contribution_mode", "order_expiry")},
                                **({"rebalance": "disabled_hold_new_cash"} if holding_baseline else {})},
                "policy_monitor_count": sum(row["type"] == "policy_monitor" for row in events)} if low_frequency else {}),
            "curve": curve, "events": events,
            "assumptions": ["continuous_single_account_no_phase_or_year_restart" if continuous else "independent_phase_restart_not_continuous_forward_history", "research_only_no_actual_facts_or_approval",
                            "ex_post_close_valuation_with_point_in_time_decisions", "explicit_market_calendar_settlement",
                            "sale_proceeds_converted_to_cny_at_fill_unavailable_until_settlement", "fixed_decision_quantity_and_budget",
                            "theoretical_ex_action_carry_between_raw_closes_not_an_observed_or_live_price",
                            *(["buy_raw_close_and_fx_caps_frozen_at_decision", "buy_quantity_sized_at_both_caps_with_upward_cent_debit",
                               "allocation_cent_dust_stays_cash", "corporate_action_cancels_frozen_orders_without_resizing"] if bounded else []),
                            *(["known_scheduled_action_defers_entire_tentative_batch_without_consuming_policy_slot"] if action_aware else []),
                            *(["deferred_review_requires_later_valid_review_or_fails_phase"] if action_aware else []),
                            *(["raw_action_cancellations_preserved_and_only_resolved_lineage_closes_terminal_gaps",
                               "post_action_raw_close_and_declared_future_decision_required_for_replacement"] if reviewable else []),
                            *(['sell_only_publication_then_declared_decision_with_settled_cash',
                               'cash_floor_upward_cent_and_remaining_buy_need_downward_cent',
                               'failed_frozen_buy_never_resized_or_retried'] if settled_funding else []),
                            *( ["no_calendar_or_class_drift_rebalancing" if holding_baseline else "half_year_or_year_calendar_review_plus_absolute_class_drift", "cooldown_uses_evaluation_local_calendar_days",
                                "new_cny_cash_repairs_without_sales" if holding_baseline else "new_cny_cash_repairs_without_sales_before_rebalancing", "orders_expire_at_next_month_boundary", "unsettled_assets_block_new_orders"]
                               if low_frequency else ["monthly_first_decision_only", "unsettled_assets_block_new_monthly_orders"]), "no_margin", "no_cash_interest",
                            "foreign_dividends_retained_in_original_currency", "turnover_uses_arithmetic_mean_observed_nav",
                            *(["all_capital_enters_nav_at_arrival_not_at_tranche_release", "waiting_cny_cash_has_no_interest_and_is_unavailable_for_orders",
                               "strategic_targets_use_nav_less_unreleased_capital", "release_is_not_a_trade_or_an_external_cashflow"] if continuous else [])],
            "tax_coverage": plan["tax_coverage"]}
