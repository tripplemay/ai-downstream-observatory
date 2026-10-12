from copy import deepcopy
import json
import subprocess
import sys
import unittest

from tests.investor.funded_history_fixtures import funded_input
from worker.accounting import decimal
from worker.investor.funded_history import calculate_funded_history, funding_history_projection, prepare_funded_history
from worker.investor.long_horizon import compare_funding_paths, funding_schedule, validate_input
from worker.market.contracts import validate_contract
from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, instant
from worker.research.rotation import run_continuous_portfolio


class FundedHistoryTests(unittest.TestCase):
    def test_reconstructed_availability_is_preserved_not_fabricated_as_provider_publication(self):
        document = funded_input()
        document["dataset"]["mode"] = "reconstructed"
        for row in document["dataset"]["observations"]:
            row["assumed_available_at"] = row.pop("published_at")
            row["provenance"] = "reconstructed"
        original = deepcopy(document)
        _, kernel = prepare_funded_history(document)
        self.assertEqual(document, original)
        self.assertNotIn("published_at", kernel["dataset"]["observations"][0])
        self.assertIn("assumed_available_at", kernel["dataset"]["observations"][0])
        late = deepcopy(document)
        late["dataset"]["observations"][0]["ingested_at"] = "2026-10-09T00:00:00Z"
        with self.assertRaisesRegex(WorkbenchError, "AFTER_INFORMATION_CUTOFF"):
            prepare_funded_history(late)

    def test_plan_reaches_one_continuous_account_in_past_without_backdating_parameters(self):
        document = funded_input(3)
        original = deepcopy(document)
        result = calculate_funded_history(document, allow_synthetic=True)
        validate_contract(result, "investor-funded-history-result.schema.json")
        self.assertEqual(document, original)
        projection, comparison = result["projection"], result["comparison"]
        self.assertEqual(projection["total_assumed_principal_cny"], "2100.00")
        self.assertEqual(projection["translation_years"], -11)
        self.assertEqual(projection["window"], {"start": "2014-12-31T16:00:00.000000Z", "end": "2017-12-31T15:59:59.999000Z"})
        self.assertEqual(comparison["parameters_recorded_at"], document["context"]["parameters_recorded_at"])
        self.assertGreater(instant(comparison["parameters_recorded_at"]), instant(comparison["window"]["end"]))
        for run in comparison["runs"].values():
            self.assertEqual(run["principal_cny"], "2100")
            self.assertEqual(run["ending_nav_cny"], "2100")
            self.assertEqual(run["profit_cny"], "0")
            self.assertEqual(run["twr"], "0")
            self.assertEqual(run["event_counts"]["external_contribution"], 3)
            self.assertIn("continuous_single_account_no_phase_or_year_restart", run["assumptions"])
        self.assertEqual(comparison["runs"]["staged"]["ending_locked_cash_cny"], "200")
        self.assertEqual(comparison["runs"]["immediate"]["ending_locked_cash_cny"], "0")
        for key in ("source_independently_verified", "parameters_independently_preregistered", "actual_arrivals_confirmed",
                    "economics_independently_replayed", "execution_authorized", "live_advice_eligible"):
            self.assertIs(result[key], False)

    def test_same_start_day_lots_are_separate_and_cents_not_rounded_after_merging(self):
        document = funded_input()
        document["funding_plan"].update(initial_capital_cny="100.01", annual_contribution_cny="100.01", first_annual_date="2026-01-01")
        projection, kernel = prepare_funded_history(document, allow_synthetic=True)
        self.assertEqual(len(projection["lots"]), 2)
        self.assertEqual(kernel["plan"]["contributions"][0]["at"], kernel["plan"]["window"]["start"])
        zone = validate_input(kernel, allow_synthetic=True)
        schedule, releases = funding_schedule(kernel["plan"], zone, staged=True)
        self.assertEqual([row["tranches"][0]["amount_cny"] for row in schedule], ["33.33", "33.33"])
        self.assertEqual(releases[instant(kernel["plan"]["window"]["start"])], decimal("66.66"))
        trace = run_continuous_portfolio(kernel["dataset"], kernel["plan"], releases)
        self.assertEqual(trace["curve"][0]["released_capital_cny"], "66.66")
        self.assertEqual(trace["initial_equity_cny"], "200.02")
        self.assertEqual(trace["contributions_cny"], "0")
        self.assertEqual(trace["profit_cny"], "0")
        old = deepcopy(kernel)
        old["schema_version"], old["plan"]["schema_version"] = "investor-long-horizon-input-v1", "investor-long-horizon-plan-v1"
        old["plan"]["parameters_frozen_at"] = "2014-12-30T00:00:00Z"
        for key in ("parameters_recorded_at", "comparison_declared_at", "information_cutoff_at", "study_basis"):
            del old["plan"][key]
        with self.assertRaisesRegex(WorkbenchError, "CONTRIBUTIONS_INVALID"):
            validate_input(old, allow_synthetic=True)

    def test_local_calendar_midnights_cross_dst_not_fixed_utc_days(self):
        document = funded_input()
        document["funding_plan"].update(start_date="2026-03-08", first_annual_date=None, annual_contribution_cny="0", evaluation_timezone="America/New_York")
        document["historical_start_date"] = "2015-03-08"
        projection = funding_history_projection(document)
        releases = projection["lots"][0]["staged_releases"]
        self.assertEqual(releases[0]["at"], "2015-03-08T05:00:00.000000Z")
        self.assertEqual(releases[1]["at"], "2015-04-07T04:00:00.000000Z")
        self.assertEqual((instant(releases[1]["at"]) - instant(releases[0]["at"])).total_seconds(), 30 * 86400 - 3600)

    def test_mapping_cannot_select_another_month_day_silently_move_leap_day_or_drop_principal(self):
        mismatch = funded_input(); mismatch["historical_start_date"] = "2015-02-01"
        with self.assertRaisesRegex(WorkbenchError, "MONTH_DAY_MISMATCH"):
            funding_history_projection(mismatch)
        leap = funded_input()
        leap["funding_plan"].update(start_date="2024-03-01", horizon_years=4, first_annual_date="2028-02-29")
        leap["historical_start_date"] = "2015-03-01"
        with self.assertRaisesRegex(WorkbenchError, "CALENDAR_INVALID"):
            funding_history_projection(leap)
        tiny = funded_input(); tiny["funding_plan"].update(entry_method="immediate", initial_capital_cny="0.01")
        with self.assertRaisesRegex(WorkbenchError, "SCHEDULE_INVALID"):
            funding_history_projection(tiny)

    def test_future_window_late_evidence_and_claimed_reversed_registration_reject(self):
        for quantum in ("0.05", "0.02", "1"):
            incompatible = funded_input(); incompatible["context"]["execution"]["cash_quantum"] = quantum
            with self.assertRaisesRegex(WorkbenchError, "CASH_QUANTUM_INVALID"):
                prepare_funded_history(incompatible, allow_synthetic=True)
        equivalent = funded_input(); equivalent["context"]["execution"]["cash_quantum"] = "0.010"
        prepare_funded_history(equivalent, allow_synthetic=True)
        for field, value in (("information_cutoff_at", "2015-01-01T00:00:00Z"),
                             ("parameters_recorded_at", "2026-10-08T00:00:03Z")):
            document = funded_input(); document["context"][field] = value
            with self.assertRaisesRegex(WorkbenchError, "RETROSPECTIVE_TIME_INVALID"):
                prepare_funded_history(document, allow_synthetic=True)
        for table, field in (("observations", "ingested_at"), ("sessions", "available_at"), ("settlements", "ingested_at")):
            document = funded_input(); document["dataset"][table][0][field] = "2026-10-09T00:00:00Z"
            with self.assertRaisesRegex(WorkbenchError, "AFTER_INFORMATION_CUTOFF"):
                prepare_funded_history(document, allow_synthetic=True)
        invalid_calendar = funded_input(); invalid_calendar["dataset"]["settlements"][0]["published_at"] = "2026-10-09T00:00:00Z"
        with self.assertRaisesRegex(WorkbenchError, "INVALID_RESEARCH_SETTLEMENT_CALENDAR"):
            prepare_funded_history(invalid_calendar, allow_synthetic=True)
        _, kernel = prepare_funded_history(funded_input(), allow_synthetic=True)
        kernel["plan"]["contributions"] *= 2
        with self.assertRaisesRegex(WorkbenchError, "CONTRIBUTIONS_INVALID"):
            compare_funding_paths(kernel, allow_synthetic=True)

    def test_cli_is_explicit_bounded_and_does_not_accept_authorization_flags(self):
        document = funded_input()
        command = [sys.executable, "-m", "worker.investor.funded_history"]
        denied = subprocess.run(command, cwd=ROOT, input=canonical_json(document), capture_output=True, text=True)
        self.assertEqual(denied.returncode, 1)
        self.assertEqual(json.loads(denied.stderr)["error"], "INVESTOR_LONG_HORIZON_SYNTHETIC_FORBIDDEN")
        allowed = subprocess.run(command + ["--allow-synthetic"], cwd=ROOT, input=canonical_json(document), capture_output=True, text=True)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertEqual(json.loads(allowed.stdout)["comparison"]["runs"]["immediate"]["principal_cny"], "1500")
        for mutate in (lambda d: d.update(execution_authorized=True), lambda d: d["context"].update(parameters_frozen_at="2014-01-01T00:00:00Z")):
            bad = deepcopy(document); mutate(bad)
            rejected = subprocess.run(command + ["--allow-synthetic"], cwd=ROOT, input=canonical_json(bad), capture_output=True, text=True)
            self.assertEqual(rejected.returncode, 1)
            self.assertEqual(json.loads(rejected.stderr), {"error": "CONTRACT_INVALID"})
