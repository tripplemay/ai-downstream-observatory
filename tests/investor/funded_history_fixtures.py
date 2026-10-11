"""Fictional future plan and fictional past data, not investment evidence."""

from tests.investor.long_horizon_fixtures import long_input
from worker.orchestration.db import instant


def funded_input(years=1):
    kernel = long_input(days=years * 366 + 2, start="2015-01-01T00:00:00Z")
    end = instant("%d-12-31T15:59:59.999000Z" % (2014 + years))
    context = {key: kernel["plan"][key] for key in ("parameters", "execution", "tax_coverage")}
    context.update(parameters_recorded_at="2026-10-08T00:00:00.000000Z", comparison_declared_at="2026-10-08T00:00:01.000000Z",
                   information_cutoff_at="2026-10-08T00:00:02.000000Z",
                   decision_times=[value for value in kernel["plan"]["decision_times"] if instant(value) <= end])
    return {"schema_version": "investor-funded-history-input-v1", "funding_plan": {
        "schema_version": "investor-funding-plan-v1", "start_date": "2026-01-01", "horizon_years": years,
        "evaluation_timezone": "Asia/Shanghai", "initial_capital_cny": "1200", "annual_contribution_cny": "300",
        "first_annual_date": "2026-12-31", "entry_method": "three_tranches_60_days",
        "actual_arrivals_confirmed": False, "execution_authorized": False, "live_advice_eligible": False},
        "historical_start_date": "2015-01-01", "dataset": kernel["dataset"], "context": context}
