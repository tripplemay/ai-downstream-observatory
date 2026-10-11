"""Generic test-only investor preferences and bounded strategy policy."""

from copy import deepcopy
from tests.research.rotation_fixtures import dataset, fixed, plan
from tests.research.fixed_policy_fixtures import policy_parameters


def profile(loss=None):
    return {"schema_version": "investor-profile-v1", "horizon_years": 12, "loss_tolerance": loss,
            "liquidity_need": "none_in_horizon", "markets": ["CN", "HK", "US"],
            "product_scope": "unleveraged_long_only_etfs", "research_direction": "system_design", "exclusions": [],
            "illustrative_budget_cny": None, "planned_annual_contribution_cny": None}


def research_input():
    data, research_plan = dataset(), plan()
    candidates = [fixed({"CN:ALPHA": growth, "CN:BETA": defensive})
                  for growth, defensive in [("0.2", "0.8"), ("0.4", "0.6"), ("0.6", "0.4")]]
    research_plan.update(parameter_candidates=deepcopy(candidates), benchmark=deepcopy(candidates[0]))
    research_plan["trial_budgets"]["train"] = len(candidates)
    policy = {"schema_version": "investor-strategy-policy-v1", "version": "synthetic-policy-v1", "minimum_horizon_years": 5,
              "minimum_phase_days": 20, "maximum_single_weight": "0.8", "roles": {"CN:ALPHA": "growth", "CN:BETA": "defensive"},
              "candidates": candidates, "stress_scenarios": [{"id": "synthetic-shock", "label": "Synthetic joint loss, not a forecast",
                  "role_returns": {"growth": "-0.5", "defensive": "-0.05", "diversifier": "-0.2"}}],
              "selection": "train_net_annual_return_then_drawdown_then_turnover_then_hash", "enhancement": "disabled_pending_evidence"}
    return data, research_plan, policy


def fixed_policy_input():
    data, research_plan, policy = research_input()
    candidates = [policy_parameters(row["weights"]) for row in policy["candidates"]]
    research_plan.update(parameter_candidates=deepcopy(candidates), benchmark=deepcopy(candidates[0]))
    policy.update(version="synthetic-fixed-policy-v2", candidates=candidates)
    return data, research_plan, policy


MONITOR_NOW = "2025-07-08T23:00:00.000Z"


def monitor_input():
    document = {"schema_version": "investor-model-monitor-v1", "profile_id": "synthetic-profile", "profile_version": 1,
                "profile_hash": "a" * 64, "model_id": "synthetic-model", "model_state_hash": "b" * 64,
                "before_plan_hash": "c" * 64, "after_plan_hash": "c" * 64,
                "before_weights": {"CN:ALPHA": "0.4", "HK:BETA": "0.3", "US:GAMMA": "0.3"},
                "after_weights": {"CN:ALPHA": "0.4", "HK:BETA": "0.3", "US:GAMMA": "0.3"},
                "quantities": {"CN:ALPHA": "40", "HK:BETA": "30", "US:GAMMA": "30"}, "cash_cny": "0",
                "quotes": [], "fx": [], "funding_intent": None, "quality_gaps": [],
                "policy": {"version": "synthetic-monitor-policy", "weight_band": "0.05", "absolute_band_cny": "0",
                           "max_fx_age_seconds": 86400, "costs": {"commission_bps": "1", "minimum_fee_cny": "1",
                               "fx_bps": "2", "slippage_bps": "3", "maximum_cost_fraction": "0.01", "assumption_hash": "d" * 64}}}
    for listing, market, currency, close, observed in [
        ("CN:ALPHA", "CN", "CNY", "100", "2025-07-08T07:00:00.000Z"),
        ("HK:BETA", "HK", "HKD", "125", "2025-07-08T08:00:00.000Z"),
        ("US:GAMMA", "US", "USD", "20", "2025-07-08T20:00:00.000Z"),
    ]:
        document["quotes"].append({"listing_id": listing, "market": market, "currency": currency, "close": close,
            "price_basis": "unadjusted", "observed_at": observed, "expected_close_at": observed,
            "known_at": MONITOR_NOW, "valid_until": "2025-07-09T06:00:00.000Z", "calendar_hash": "e" * 64, "observation_hash": "f" * 64})
    for currency, value in [("HKD", "0.8"), ("USD", "5")]:
        document["fx"].append({"currency": currency, "value": value, "unit": "CNY_per_unit_currency",
            "observed_at": "2025-07-08T21:00:00.000Z", "known_at": MONITOR_NOW,
            "valid_until": "2025-07-09T06:00:00.000Z", "observation_hash": "f" * 64})
    return document
