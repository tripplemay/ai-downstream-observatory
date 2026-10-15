"""Invented prices and capital; buffer values are test inputs, not personal policy."""

from copy import deepcopy
from datetime import timedelta
from zoneinfo import ZoneInfo

from tests.investor.funded_history_fixtures import funded_input
from worker.investor.funded_history import calculate_funded_history, prepare_funded_history
from worker.investor.long_horizon import funding_schedule
from worker.orchestration.db import instant, stamp
from worker.research.rotation import run_continuous_portfolio


def bounded_input(years=1):
    document = funded_input(years)
    document["schema_version"] = "investor-funded-history-input-v2"
    document["context"]["execution"].update(model="next_session_close_bounded_fixed_quantity",
        buy_price_buffer_bps="200", buy_fx_buffer_bps="200")
    return document


def cases():
    base = bounded_input()
    rows = {"flat": base}
    cents = deepcopy(base)
    cents["funding_plan"].update(first_annual_date="2026-01-01", initial_capital_cny="100.01", annual_contribution_cny="100.01")
    rows["same_day_cents"] = cents
    jump = deepcopy(base)
    for row in jump["dataset"]["observations"]:
        if row["listing_id"] == "CN:ALPHA" and row["observed_at"].startswith("2015-01-02"):
            row["value"] = "13"
    rows["price_breach"] = jump
    sales = deepcopy(base)
    sales["context"]["parameters"]["minimum_days_between_rebalances"] = 1
    for row in sales["dataset"]["observations"]:
        if row["listing_id"] == "CN:ALPHA" and row["observed_at"].startswith("2015-01-25"):
            row["value"] = "20"
    rows["sale_dependencies"] = sales
    pending = deepcopy(base)
    pending["dataset"]["actions"] = [{"id": "fictional-pending-split", "listing_id": "CN:ALPHA", "type": "split",
        "at": "2015-01-02T06:00:00Z", "published_at": "2014-12-01T00:00:00Z", "source_evidence": "Fictional only", "ratio": "2"}]
    for row in pending["dataset"]["observations"]:
        if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2015-01-02T06":
            row["value"] = "5"
    rows["pending_action"] = pending
    foreign = deepcopy(base)
    asset = foreign["dataset"]["assets"][0]
    asset.update(listing_id="HK:ALPHA", market="HK", currency="HKD")
    foreign["context"]["parameters"]["weights"]["HK:ALPHA"] = foreign["context"]["parameters"]["weights"].pop("CN:ALPHA")
    foreign["context"]["parameters"]["roles"]["HK:ALPHA"] = foreign["context"]["parameters"]["roles"].pop("CN:ALPHA")
    template = deepcopy(foreign["dataset"]["observations"][0]); template.pop("listing_id")
    for row in foreign["dataset"]["observations"]:
        if row["listing_id"] == "CN:ALPHA":
            row.update(listing_id="HK:ALPHA", unit="HKD")
    for table in ("sessions", "settlements"):
        foreign["dataset"][table].extend({**row, "market": "HK"} for row in list(foreign["dataset"][table]))
    for session in base["dataset"]["sessions"]:
        at = stamp(instant(session["close_at"]) - timedelta(hours=1))
        foreign["dataset"]["observations"].append({**template, "id": "fx:" + session["session_date"],
            "series_key": "FX:HKD", "metric": "fx_cny_per_unit", "unit": "CNY_per_unit_currency", "price_basis": "not_applicable",
            "value": "3" if session["session_date"] == "2015-01-02" else "2", "observed_at": at, "published_at": at, "ingested_at": at})
    foreign["context"]["execution"].update(commission_bps="10", minimum_fee_cny="1", slippage_bps="5", fx_bps="20")
    rows["foreign_fx_breach_costs"] = foreign
    actions = bounded_input(2)
    actions["dataset"]["actions"] = [
        {"id": "fictional-dividend", "listing_id": "CN:ALPHA", "type": "dividend", "at": "2015-12-31T06:00:00Z",
         "published_at": "2015-12-01T00:00:00Z", "source_evidence": "Fictional only", "gross_per_unit": "1", "tax_per_unit": "0.2", "pay_at": "2016-01-03T00:00:00Z"},
        {"id": "fictional-split", "listing_id": "CN:ALPHA", "type": "split", "at": "2016-01-01T06:00:00Z",
         "published_at": "2015-12-01T00:00:00Z", "source_evidence": "Fictional only", "ratio": "2"}]
    for row in actions["dataset"]["observations"]:
        if row["listing_id"] == "CN:ALPHA":
            row["value"] = "4.5" if row["observed_at"] >= "2016-01-01T06" else "9" if row["observed_at"] >= "2015-12-31T06" else "10"
    rows["cross_year_actions"] = actions
    decade = bounded_input(10)
    decade["context"]["decision_times"] = [at for at in decade["context"]["decision_times"] if at[8:10] == "01" or at[5:10] == "12-31"]
    rows["ten_years"] = decade
    return rows


def vector(name, document):
    projection, kernel = prepare_funded_history(document, allow_synthetic=True)
    traces, baselines = {}, {}
    for key in ("immediate", "staged"):
        _, releases = funding_schedule(kernel["plan"], ZoneInfo(kernel["plan"]["evaluation_timezone"]), staged=key == "staged")
        traces[key] = run_continuous_portfolio(kernel["dataset"], kernel["plan"], releases)
        baselines[key] = run_continuous_portfolio(kernel["dataset"], kernel["plan"], releases, holding_baseline=True)
    return {"name": name, "input": document, "prepared": {"projection": projection, "input": kernel},
            "result": calculate_funded_history(document, allow_synthetic=True), "traces": traces, "baselines": baselines}
