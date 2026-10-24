"""Bounded, preregistered reference selection; no DB, accounts or live admission."""

from copy import deepcopy

from worker.accounting.decimal_math import ONE, ZERO, canonical, decimal, financial
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, instant
from worker.research.backtest import compare_backtest
from worker.research.snapshot import validate_dataset, validate_parameters, validate_plan
from .precision import validate_time_precision
from .implementation import implementation_hash


ENGINE_VERSION = "investor-diversified-reference-v1"
PHASES = ("train", "validation", "holdout")


def _summary(report):
    result = report["strategy"]
    keys = ("twr", "annualized_unit_return", "max_drawdown", "profit_cny", "fees_cny", "fx_fees_cny", "slippage_cny",
            "execution_failure_count", "sell_turnover_on_mean_observed_nav", "buy_turnover_on_mean_observed_nav")
    return {"phase": report["phase"], "result_hash": report["result_hash"], "window": result["window"],
            **{key: result[key] for key in keys},
            **{"benchmark_" + key: report["benchmark"][key] for key in ("twr", "annualized_unit_return", "max_drawdown", "execution_failure_count", "profit_cny", "fees_cny", "fx_fees_cny", "slippage_cny")},
            "excess_twr": report["excess_twr"], "assumptions": result["assumptions"]}


def _usable(summary):
    return (all(summary[key] is not None for key in ("twr", "annualized_unit_return", "max_drawdown", "benchmark_twr", "benchmark_annualized_unit_return", "benchmark_max_drawdown", "excess_twr"))
            and -ONE <= decimal(summary["max_drawdown"]) <= ZERO
            and -ONE <= decimal(summary["benchmark_max_drawdown"]) <= ZERO
            and summary["execution_failure_count"] == 0 and summary["benchmark_execution_failure_count"] == 0)


@financial
def _stress(parameters, policy):
    rows = []
    for scenario in policy["stress_scenarios"]:
        result = sum((decimal(weight) * decimal(scenario["role_returns"][policy["roles"][listing]])
                      for listing, weight in parameters["weights"].items()), ZERO)
        rows.append({"id": scenario["id"], "label": scenario["label"], "portfolio_return": canonical(result),
                     "kind": "hypothetical_role_shock_not_probability_or_loss_limit"})
    return rows


def _within_risk(summary, stresses, limit):
    # The accounting engine reports peak-to-trough declines in [-1, 0].
    return _usable(summary) and -decimal(summary["max_drawdown"]) <= limit and all(-decimal(row["portfolio_return"]) <= limit for row in stresses)


@financial
def _validate_policy(policy, dataset, plan):
    validate_contract(policy, "investor-strategy-policy.schema.json")
    if len(dataset["assets"]) > 20 or len(dataset["observations"]) > 100000 or len(dataset["sessions"]) > 30000:
        raise WorkbenchError("INVESTOR_RESEARCH_INPUT_LIMIT")
    if plan["schema_version"] not in ("research-plan-v2", "research-plan-v3", "research-plan-v4") or dataset["schema_version"] != "research-dataset-v2":
        raise WorkbenchError("INVESTOR_RESEARCH_VERSION_REQUIRED")
    if set(policy["roles"]) != {row["listing_id"] for row in dataset["assets"]}:
        raise WorkbenchError("INVESTOR_RESEARCH_ROLE_SCOPE")
    if not ZERO < decimal(policy["maximum_single_weight"]) <= ONE:
        raise WorkbenchError("INVESTOR_RESEARCH_CONCENTRATION_INVALID")
    if {content_hash(row) for row in policy["candidates"]} != {content_hash(row) for row in plan["parameter_candidates"]}:
        raise WorkbenchError("INVESTOR_RESEARCH_CANDIDATES_NOT_FROZEN")
    if (plan["trial_budgets"]["train"] < len(policy["candidates"])
            or plan["trial_budgets"]["validation"] < 1 or plan["trial_budgets"]["holdout"] < 1):
        raise WorkbenchError("INVESTOR_RESEARCH_TRIAL_BUDGET_TOO_SMALL")
    if plan["benchmark"]["schema_version"] not in ("research-fixed-rebalance-parameters-v1", "research-fixed-rebalance-parameters-v2"):
        raise WorkbenchError("INVESTOR_RESEARCH_FIXED_BENCHMARK_REQUIRED")
    if content_hash(plan["benchmark"]) not in {content_hash(row) for row in policy["candidates"]}:
        raise WorkbenchError("INVESTOR_RESEARCH_BASELINE_NOT_IN_CANDIDATES")
    identities = set()
    for index, parameters in enumerate([*policy["candidates"], plan["benchmark"]]):
        validate_parameters(parameters, dataset)
        if parameters["schema_version"] == "research-fixed-rebalance-parameters-v2" and any(
                policy["roles"].get(key) != role for key, role in parameters["roles"].items()):
            raise WorkbenchError("INVESTOR_RESEARCH_POLICY_ROLE_MISMATCH")
        weights = {key: decimal(value) for key, value in parameters["weights"].items()}
        if (sum(weights.values(), ZERO) != ONE or any(value <= ZERO or value > decimal(policy["maximum_single_weight"]) for value in weights.values())
                or any(len(value.partition(".")[2]) > 8 for value in parameters["weights"].values())
                or not {"growth", "defensive"} <= {policy["roles"][key] for key in weights}):
            raise WorkbenchError("INVESTOR_RESEARCH_DIVERSIFICATION_INVALID")
        if index < len(policy["candidates"]):
            normalized = {**parameters, "weights": {key: canonical(value) for key, value in weights.items()},
                          "tolerance": {key: canonical(decimal(value)) for key, value in parameters["tolerance"].items()}}
            if parameters["schema_version"] == "research-fixed-rebalance-parameters-v2":
                normalized["class_drift_threshold"] = canonical(decimal(parameters["class_drift_threshold"]))
            signature = content_hash(normalized)
            if signature in identities:
                raise WorkbenchError("INVESTOR_RESEARCH_DUPLICATE_ECONOMIC_CANDIDATE")
            identities.add(signature)
    for phase in PHASES:
        window = plan["windows"][phase]
        if (instant(window["end"]) - instant(window["start"])).total_seconds() < policy["minimum_phase_days"] * 86400:
            raise WorkbenchError("INVESTOR_RESEARCH_WINDOW_TOO_SHORT")
    stress_ids = [row["id"] for row in policy["stress_scenarios"]]
    if len(set(stress_ids)) != len(stress_ids) or any(not -ONE <= decimal(value) <= ONE for row in policy["stress_scenarios"] for value in row["role_returns"].values()):
        raise WorkbenchError("INVESTOR_RESEARCH_STRESS_INVALID")


def validate_reference_inputs(dataset, plan, policy, profile, *, allow_synthetic=False):
    validate_contract(profile, "investor-profile.schema.json")
    if isinstance(dataset, dict) and any(isinstance(dataset.get(key), list) and len(dataset[key]) > maximum
            for key, maximum in (("assets", 20), ("observations", 100000), ("sessions", 30000))):
        raise WorkbenchError("INVESTOR_RESEARCH_INPUT_LIMIT")
    validate_time_precision(dataset)
    validate_time_precision(plan)
    validate_dataset(dataset)
    _validate_policy(policy, dataset, plan)
    validate_plan(plan, dataset)
    if type(allow_synthetic) is not bool or dataset["mode"] == "synthetic" and not allow_synthetic:
        raise WorkbenchError("INVESTOR_SYNTHETIC_REFERENCE_FORBIDDEN")


@financial
def research_reference(dataset, plan, policy, profile, *, allow_synthetic=False, evaluate=None, freeze=None):
    """Caller must separately prove issuer identity, license, sources and freshness.

    Unknown risk returns train-only alternatives, never a selected plan. A
    selected candidate is frozen before validation and holdout are evaluated;
    a later failure blocks instead of searching for a luckier replacement.
    """
    validate_reference_inputs(dataset, plan, policy, profile, allow_synthetic=allow_synthetic)
    evaluate = evaluate or (lambda parameters, phase: _summary(compare_backtest(dataset, plan, parameters, phase)))
    basis = {"schema_version": "investor-strategy-result-v1", "engine_version": ENGINE_VERSION,
             "implementation_hash": implementation_hash(),
             "profile_hash": content_hash(profile), "dataset_hash": content_hash(dataset), "plan_hash": content_hash(plan),
             "policy_hash": content_hash(policy), "data_mode": dataset["mode"], "selected_parameters": None,
             "selection_frozen_before_validation": True, "candidates": [], "phase_evidence": [], "reason_codes": [],
             "holdout_unseen_status": "not_independently_verified",
             "qualification": "exploratory_research_only", "live_advice_eligible": False,
             "limits": ["No issuer, license, provider or production certification is performed by this kernel",
                        "Phase portfolios restart independently, not a continuous personal ten-year return",
                        "Historical and hypothetical losses are not future loss ceilings", "No AI-predicted alpha or live orders"]}
    reasons = []
    if dataset["mode"] == "reconstructed":
        basis["limits"].extend(["Retrospectively assembled history is not a point-in-time archive",
            "Historical availability and universe membership are reconstructed assumptions, not independent unseen evidence"])
    if profile["liquidity_need"] != "none_in_horizon": reasons.append("LIQUIDITY_REVIEW_REQUIRED")
    if profile["horizon_years"] < policy["minimum_horizon_years"]: reasons.append("HORIZON_OUTSIDE_STRATEGY_SCOPE")
    if profile["exclusions"]: reasons.append("EXCLUSIONS_REQUIRE_QUALIFIED_UNIVERSE")
    if any(row["market"] not in profile["markets"] for row in dataset["assets"]): reasons.append("UNIVERSE_OUTSIDE_ALLOWED_MARKETS")
    if profile["research_direction"] == "rotation": reasons.append("ENHANCEMENT_EVIDENCE_NOT_AVAILABLE")
    if not dataset["corporate_actions_complete"]: reasons.append("CORPORATE_ACTION_COVERAGE_INCOMPLETE")

    def finish(status, codes):
        result = {**basis, "status": status, "reason_codes": codes}
        result["result_hash"] = content_hash(result)
        validate_contract(result, "investor-strategy-result.schema.json")
        return result

    if reasons: return finish("insufficient_evidence", reasons)
    budget = decimal(profile["loss_tolerance"]) if profile["loss_tolerance"] is not None else None
    eligible = []
    for parameters in sorted(policy["candidates"], key=content_hash):
        summary = evaluate(parameters, "train")
        stresses = _stress(parameters, policy)
        candidate = {"parameters_hash": content_hash(parameters), "weights": deepcopy(parameters["weights"]), "train": summary, "stresses": stresses,
                     "risk_budget_pass": None if budget is None else _within_risk(summary, stresses, budget)}
        basis["candidates"].append(candidate)
        if budget is not None and candidate["risk_budget_pass"]:
            eligible.append((parameters, candidate))
    if budget is None:
        if not any(_usable(row["train"]) for row in basis["candidates"]):
            return finish("insufficient_evidence", ["NO_USABLE_TRAIN_AND_BENCHMARK_EVIDENCE", "RISK_BUDGET_UNCONFIRMED"])
        return finish("risk_options_ready", ["RISK_BUDGET_UNCONFIRMED"])
    if not eligible: return finish("insufficient_evidence", ["NO_CANDIDATE_WITHIN_CONFIRMED_RISK_BUDGET"])
    selected, evidence = min(eligible, key=lambda item: (-decimal(item[1]["train"]["annualized_unit_return"]),
        -decimal(item[1]["train"]["max_drawdown"]),
        decimal(item[1]["train"]["buy_turnover_on_mean_observed_nav"]) + decimal(item[1]["train"]["sell_turnover_on_mean_observed_nav"]),
        item[1]["parameters_hash"]))
    basis["selected_parameters"] = deepcopy(selected)
    basis["phase_evidence"].append(evidence["train"])
    if freeze is not None:
        freeze(selected)
    for phase in ("validation", "holdout"):
        summary = evaluate(selected, phase)
        basis["phase_evidence"].append(summary)
        if not _within_risk(summary, evidence["stresses"], budget):
            return finish("insufficient_evidence", ["SELECTED_CANDIDATE_FAILED_" + phase.upper()])
    return finish("reference_ready", [])
