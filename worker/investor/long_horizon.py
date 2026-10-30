"""Continuous counterfactual funding comparisons, not advice or live facts."""

import argparse
from bisect import bisect_right
from collections import Counter
from datetime import timedelta
from decimal import ROUND_FLOOR
import re
import sys
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from worker.accounting import canonical, decimal, fact_decimal
from worker.accounting.decimal_math import ZERO, financial
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, stamp
from worker.research.registry import implementation_manifest
from worker.research.rotation import run_continuous_portfolio
from worker.research.snapshot import validate_dataset, validate_parameters
from .__main__ import MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, parse_request
from .implementation import implementation_hash
from .precision import validate_time_precision


INPUT_CONTRACT = "investor-long-horizon-input.schema.json"
OUTPUT_CONTRACT = "investor-long-horizon-result.schema.json"
RETROSPECTIVE_INPUT_CONTRACT = "investor-long-horizon-input-v2.schema.json"
RETROSPECTIVE_OUTPUT_CONTRACT = "investor-long-horizon-result-v2.schema.json"
BOUNDED_INPUT_CONTRACT = "investor-long-horizon-input-v3.schema.json"
BOUNDED_OUTPUT_CONTRACT = "investor-long-horizon-result-v3.schema.json"
EVENT_INPUT_CONTRACT = "investor-long-horizon-input-v4.schema.json"
EVENT_OUTPUT_CONTRACT = "investor-long-horizon-result-v4.schema.json"
SETTLED_INPUT_CONTRACT = 'investor-long-horizon-input-v5.schema.json'
SETTLED_OUTPUT_CONTRACT = 'investor-long-horizon-result-v5.schema.json'


def _validate_decisions(dataset, decisions):
    blackout = []
    for close, available in sorted((instant(row["close_at"]), instant(row["available_at"])) for row in dataset["sessions"]):
        if close == available:
            continue
        if blackout and close <= blackout[-1][1]:
            blackout[-1] = (blackout[-1][0], max(available, blackout[-1][1]))
        else:
            blackout.append((close, available))
    starts = [row[0] for row in blackout]
    for decision in decisions:
        index = bisect_right(starts, decision) - 1
        if index >= 0 and decision < blackout[index][1]:
            raise WorkbenchError("INVESTOR_LONG_HORIZON_UNOBSERVED_CLOSE_DECISION")


@financial
def validate_input(document, *, allow_synthetic=False):
    version = document.get("schema_version") if isinstance(document, dict) else None
    settled = version == 'investor-long-horizon-input-v5'
    event_review = settled or version == "investor-long-horizon-input-v4"
    bounded = event_review or version == "investor-long-horizon-input-v3"
    retrospective = bounded or version == "investor-long-horizon-input-v2"
    validate_contract(document, SETTLED_INPUT_CONTRACT if settled else EVENT_INPUT_CONTRACT if event_review else BOUNDED_INPUT_CONTRACT if bounded else RETROSPECTIVE_INPUT_CONTRACT if retrospective else INPUT_CONTRACT)
    data, plan = document["dataset"], document["plan"]
    validate_time_precision(document)
    registration_fields = ("parameters_recorded_at", "comparison_declared_at", "information_cutoff_at") if retrospective else ("parameters_frozen_at",)
    for field in registration_fields:
        validate_time_precision(plan[field], "at")
    for action in data["actions"]:
        if "pay_at" in action:
            validate_time_precision(action["pay_at"], "at")
    validate_dataset(data)
    if data["mode"] == "synthetic" and not allow_synthetic:
        raise WorkbenchError("INVESTOR_LONG_HORIZON_SYNTHETIC_FORBIDDEN")
    if not data["corporate_actions_complete"]:
        raise WorkbenchError("INVESTOR_LONG_HORIZON_ACTIONS_INCOMPLETE")
    try:
        zone = ZoneInfo(plan["evaluation_timezone"])
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise WorkbenchError("INVESTOR_LONG_HORIZON_TIMEZONE_INVALID") from exc
    start, end = instant(plan["window"]["start"]), instant(plan["window"]["end"])
    local_start, local_end = start.astimezone(zone), end.astimezone(zone)
    try:
        tenth_anniversary = local_start.replace(year=local_start.year + 10)
    except ValueError:
        tenth_anniversary = local_start.replace(year=local_start.year + 10, day=28)
    if start >= end or local_end > tenth_anniversary:
        raise WorkbenchError("INVESTOR_LONG_HORIZON_WINDOW_INVALID")
    if retrospective:
        recorded, declared, cutoff = (instant(plan[field]) for field in registration_fields)
        if not recorded <= declared <= cutoff or end > cutoff:
            raise WorkbenchError("INVESTOR_LONG_HORIZON_RETROSPECTIVE_TIME_INVALID")
        known_times = []
        for row in data["observations"]:
            available = row.get("published_at") or row.get("assumed_available_at")
            if not available:
                raise WorkbenchError("INVESTOR_LONG_HORIZON_AVAILABILITY_UNKNOWN")
            known_times.extend((available, row["ingested_at"]))
        known_times.extend(row["available_at"] for row in data["sessions"])
        known_times.extend(row["published_at"] for row in data["actions"])
        known_times.extend(row["published_at"] for row in data["settlements"])
        known_times.extend(row["ingested_at"] for table in ("actions", "settlements") for row in data[table] if "ingested_at" in row)
        if any(instant(at) > cutoff for at in known_times):
            raise WorkbenchError("INVESTOR_LONG_HORIZON_AFTER_INFORMATION_CUTOFF")
    elif instant(plan["parameters_frozen_at"]) > start:
        raise WorkbenchError("INVESTOR_LONG_HORIZON_PARAMETERS_NOT_FROZEN")
    validate_parameters(plan["parameters"], data)
    decisions = [instant(value) for value in plan["decision_times"]]
    if decisions != sorted(set(decisions)) or any(not start <= at < end for at in decisions):
        raise WorkbenchError("INVESTOR_LONG_HORIZON_DECISIONS_INVALID")
    _validate_decisions(data, decisions)
    quantum = fact_decimal(plan["execution"]["cash_quantum"])
    if quantum <= ZERO:
        raise WorkbenchError("INVESTOR_LONG_HORIZON_QUANTUM_INVALID")
    for name in ("commission_bps", "minimum_fee_cny", "slippage_bps", "fx_bps"):
        if fact_decimal(plan["execution"][name]) < ZERO:
            raise WorkbenchError("INVESTOR_LONG_HORIZON_COST_INVALID")
    if decimal(plan["execution"]["slippage_bps"]) >= 10000:
        raise WorkbenchError("INVESTOR_LONG_HORIZON_COST_INVALID")
    if bounded and (quantum != decimal("0.01") or any(not ZERO <= fact_decimal(plan["execution"][name]) <= 10000
            for name in ("buy_price_buffer_bps", "buy_fx_buffer_bps", "commission_bps", "fx_bps"))):
        raise WorkbenchError("INVESTOR_LONG_HORIZON_BOUND_INVALID")
    policy = plan["funding_policy"]
    for name in ("initial_offsets_days", "contribution_offsets_days"):
        offsets = policy[name]
        if offsets != sorted(set(offsets)) or offsets[0] != 0:
            raise WorkbenchError("INVESTOR_LONG_HORIZON_OFFSETS_INVALID")
    previous = start
    for index, flow in enumerate(plan["contributions"]):
        at = instant(flow["at"])
        initial_day = retrospective and index == 0 and at == start
        if not (initial_day or previous < at <= end):
            raise WorkbenchError("INVESTOR_LONG_HORIZON_CONTRIBUTIONS_INVALID")
        previous = at
    amounts = [(plan["initial_capital_cny"], policy["initial_offsets_days"])]
    amounts.extend((row["amount_cny"], policy["contribution_offsets_days"]) for row in plan["contributions"])
    for value, offsets in amounts:
        amount = fact_decimal(value)
        if amount <= ZERO or amount % quantum or amount < quantum * len(offsets):
            raise WorkbenchError("INVESTOR_LONG_HORIZON_FUNDING_PRECISION_INVALID")
    return zone


def _release_at(arrival, offset, zone):
    if not offset:
        return arrival
    local = arrival.astimezone(zone) + timedelta(days=offset)
    valid = set()
    for fold in (0, 1):
        candidate = local.replace(fold=fold)
        utc = instant(candidate)
        roundtrip = utc.astimezone(zone)
        if roundtrip.replace(tzinfo=None) == local.replace(tzinfo=None):
            valid.add(utc)
    if len(valid) != 1:
        raise WorkbenchError("INVESTOR_LONG_HORIZON_RELEASE_LOCAL_TIME_INVALID")
    return valid.pop()


@financial
def funding_schedule(plan, zone, *, staged):
    end = instant(plan["window"]["end"])
    quantum = decimal(plan["execution"]["cash_quantum"])
    lots = [("initial", plan["window"]["start"], plan["initial_capital_cny"], "initial_offsets_days")]
    lots.extend(("contribution:%04d" % (index + 1), row["at"], row["amount_cny"], "contribution_offsets_days")
                for index, row in enumerate(plan["contributions"]))
    schedule, releases = [], {}
    for lot_id, arrival_text, value, offset_key in lots:
        arrival, amount = instant(arrival_text), decimal(value)
        offsets = plan["funding_policy"][offset_key] if staged else [0]
        tranche = (amount / len(offsets) / quantum).to_integral_value(rounding=ROUND_FLOOR) * quantum
        remaining, rows = amount, []
        for index, offset in enumerate(offsets):
            released = remaining if index == len(offsets) - 1 else tranche
            remaining -= released
            at = _release_at(arrival, offset, zone)
            rows.append({"at": stamp(at), "amount_cny": canonical(released), "within_window": at <= end})
            if at <= end:
                releases[at] = releases.get(at, ZERO) + released
        if remaining != ZERO:
            raise WorkbenchError("INVESTOR_LONG_HORIZON_TRANCHE_CONSERVATION_FAILED")
        schedule.append({"lot_id": lot_id, "arrival_at": stamp(arrival), "amount_cny": canonical(amount), "tranches": rows})
    return schedule, releases


def _snapshots(curve, zone, pattern):
    latest = {}
    for row in curve:
        period = instant(row["at"]).astimezone(zone).strftime(pattern)
        latest[period] = {"period": period, "observed_at": row["at"], **{key: row[key] for key in (
            "nav_cny", "unit_nav", "principal_cny", "profit_cny", "cash_cny", "locked_cash_cny",
            "released_capital_cny", "unreserved_released_cash_cny")}}
    return [latest[key] for key in sorted(latest)]


@financial
def _summarize(run, schedule, zone):
    closing = run["curve"][-1]
    principal = decimal(run["initial_equity_cny"]) + decimal(run["contributions_cny"])
    if (decimal(closing["principal_cny"]) != principal
            or decimal(closing["profit_cny"]) != decimal(run["profit_cny"])
            or decimal(run["ending_nav_cny"]) - principal != decimal(run["profit_cny"])):
        raise WorkbenchError("INVESTOR_LONG_HORIZON_WEALTH_IDENTITY_INVALID")
    counts = Counter(row["type"] for row in run["events"])
    return {**{key: run[key] for key in (
                "engine_version", "initial_equity_cny", "contributions_cny", "ending_nav_cny", "profit_cny", "twr",
                "return_method", "annualized_unit_return", "xirr", "max_drawdown", "recovered_at", "fees_cny",
                "fx_fees_cny", "slippage_cny", "cash_rounding_cny", "execution_failure_count", "ending_cash_ratio", "assumptions")},
            "engine_trace_hash": content_hash(run), "principal_cny": closing["principal_cny"],
            **({key: run[key] for key in ("terminal_execution_failure_count", "corporate_action_cancellation_count",
                "resolved_corporate_action_cancellation_count", "unresolved_order_review_count", "order_review_lineage_hash")}
               if run["engine_version"] in ("continuous-event-review-funding-v1", 'continuous-settled-intent-funding-v1') else {}),
            **({key: run[key] for key in ('failed_cash_intent_count', 'pending_cash_intent_count', 'cash_intent_lineage_hash')}
               if run['engine_version'] == 'continuous-settled-intent-funding-v1' else {}),
            "ending_locked_cash_cny": closing["locked_cash_cny"], "ending_positions": run["positions"],
            "event_counts": {key: counts[key] for key in ("external_contribution", "funding_release", "simulated_buy", "simulated_sell",
                "execution_skipped", "order_expired", "policy_deployment_failed")},
            "monthly": _snapshots(run["curve"], zone, "%Y-%m"), "annual": _snapshots(run["curve"], zone, "%Y"),
            "funding_schedule": schedule}


@financial
def compare_funding_paths(document, *, allow_synthetic=False, progress=None):
    zone = validate_input(document, allow_synthetic=allow_synthetic)
    data, plan = document["dataset"], document["plan"]
    runs = {}
    for name in ("immediate", "staged"):
        schedule, releases = funding_schedule(plan, zone, staged=name == "staged")
        run = run_continuous_portfolio(data, plan, releases, progress=progress)
        runs[name] = _summarize(run, schedule, zone)
    settled = document['schema_version'] == 'investor-long-horizon-input-v5'
    event_review = settled or document["schema_version"] == "investor-long-horizon-input-v4"
    bounded = event_review or document["schema_version"] == "investor-long-horizon-input-v3"
    retrospective = bounded or document["schema_version"] == "investor-long-horizon-input-v2"
    result = {"schema_version": 'investor-long-horizon-result-v5' if settled else "investor-long-horizon-result-v4" if event_review else "investor-long-horizon-result-v3" if bounded else "investor-long-horizon-result-v2" if retrospective else "investor-long-horizon-result-v1", "input_hash": content_hash(document),
              "dataset_hash": content_hash(data), "plan_hash": content_hash(plan),
              "implementation_hash": content_hash({"investor": implementation_hash(),
                  "timezone_hashes": implementation_manifest(plan["evaluation_timezone"])["timezone_hashes"]}),
              "parameters_hash": content_hash(plan["parameters"]), "window": dict(plan["window"]),
              "evaluation_timezone": plan["evaluation_timezone"], "data_mode": data["mode"],
              "status": "execution_gaps" if any((run['failed_cash_intent_count'] or run['pending_cash_intent_count'] or run['terminal_execution_failure_count'] or run['unresolved_order_review_count']) if settled else (run["terminal_execution_failure_count"] or run["unresolved_order_review_count"])
                  if event_review else run["execution_failure_count"] for run in runs.values()) else "computed",
              "qualification": "retrospective_exploratory_funding_comparison_only" if retrospective else "counterfactual_funding_path_comparison_only", "source_independently_verified": False,
              "parameters_independently_preregistered": False, "actual_holdings_linked": False,
              "execution_authorized": False, "live_advice_eligible": False, "runs": runs,
              "limits": ["historical_counterfactual_not_a_forecast_or_personal_ten_year_return",
                         "same_parameters_arrival_times_costs_and_decisions_only_release_timing_differs",
                         "parameters_freeze_timestamp_and_dataset_metadata_are_not_independent_evidence",
                         "no_risk_budget_selection_or_candidate_optimization",
                         "monthly_and_annual_rows_are_last_observed_snapshots_not_certified_period_end_prices",
                         "waiting_cash_is_in_nav_no_interest_no_automatic_execution",
                         "release_deadlines_never_override_invalid_prices_settlement_or_quantity_steps",
                         "tax_coverage_is_caller_supplied_not_a_verified_tax_or_cost_certificate",
                         "no_publication_registry_or_monitoring_chain_integration_in_this_interface"]}
    if retrospective:
        result.update({field: plan[field] for field in ("parameters_recorded_at", "comparison_declared_at", "information_cutoff_at")})
        result["limits"].append("retrospective_declared_times_are_not_independent_preregistration_or_unused_holdout_evidence")
    result["result_hash"] = content_hash(result)
    validate_contract(result, SETTLED_OUTPUT_CONTRACT if settled else EVENT_OUTPUT_CONTRACT if event_review else BOUNDED_OUTPUT_CONTRACT if bounded else RETROSPECTIVE_OUTPUT_CONTRACT if retrospective else OUTPUT_CONTRACT)
    if len(canonical_json(result).encode("utf-8")) > MAX_OUTPUT_BYTES:
        raise WorkbenchError("INVESTOR_KERNEL_OUTPUT_TOO_LARGE")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description="Continuous counterfactual ETF funding paths; no DB, broker or advice publication")
    parser.add_argument("--allow-synthetic", action="store_true", help="Explicit fixture permission, not live eligibility")
    versions = parser.add_mutually_exclusive_group()
    versions.add_argument("--retrospective", action="store_true", help="Explicit v2 retrospective exploration; never backdate registration")
    versions.add_argument("--bounded-retrospective", action="store_true", help="Explicit v3 bounded execution; caller supplies both buffers")
    versions.add_argument("--event-review-retrospective", action="store_true", help="Explicit v4 causal order review; not a live execution model")
    versions.add_argument('--settled-cash-retrospective', action='store_true', help='Explicit v5 settled-cash buy intents; never live execution')
    args = parser.parse_args(argv)
    try:
        contract = SETTLED_INPUT_CONTRACT if args.settled_cash_retrospective else EVENT_INPUT_CONTRACT if args.event_review_retrospective else BOUNDED_INPUT_CONTRACT if args.bounded_retrospective else RETROSPECTIVE_INPUT_CONTRACT if args.retrospective else INPUT_CONTRACT
        document = parse_request(sys.stdin.buffer.read(MAX_INPUT_BYTES + 1), contract)
        result = compare_funding_paths(document, allow_synthetic=args.allow_synthetic)
        print(canonical_json(result))
        return 0
    except (ValueError, TypeError, KeyError, ArithmeticError, RecursionError, OSError) as exc:
        code = str(exc).split(":", 1)[0]
        if not re.fullmatch(r"(?:INVESTOR_[A-Z_]+|CONTRACT_INVALID)", code):
            code = "INVESTOR_LONG_HORIZON_FAILED"
        print(canonical_json({"error": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
