"""Fictional retrospective economics, never source approval or monitor resumption."""

from copy import deepcopy
from datetime import timedelta
import sys
import unittest

from tests.investor.test_evidence_model_state import evidence_projection, sparse_cases
from tests.investor.test_model_state import model_fixture, next_snapshot
from tests.investor.fixtures import MONITOR_NOW
from tests.investor.test_funding_plan import plan as funding_plan
from tests.research.fixed_policy_fixtures import policy_parameters
from worker.investor.action_restatement_kernel import compare_action_restatement, verify_action_restatement_arithmetic, SCHEMA
from worker.investor.model_state import advance_evidence_model
from worker.investor.model_contracts import definition_basis
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant


def later(at): return (instant(at) + timedelta(days=1)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def request(definition, origin, head, origin_projection, head_projection, original_actions):
    return {"schema_version": "investor-action-restatement-kernel-input-v1", "definition": deepcopy(definition), "origin": deepcopy(origin),
        "head": deepcopy(head), "origin_projection": deepcopy(origin_projection), "head_projection": deepcopy(head_projection),
        "original_actions": deepcopy(original_actions), "corrected_actions": deepcopy(original_actions),
        "corrected_coverage": {market: {"from": origin["initialized_at"][market], "to": cutoff, "complete": True} for market, cutoff in head["market_cutoffs"].items()},
        "checked_at": later(head["created_at"])}


def protocol_cases(definition, origin_projection, ex_projection, paid_projection):
    result = {}
    for fixed, funded, name in ((True, False, "fixed"), (False, True, "funded_v1"), (True, True, "funded_fixed")):
        model = deepcopy(definition)
        if fixed:
            model.update(schema_version="investor-model-definition-v2", fixed_policy={"parameters": policy_parameters({row["listing_id"]: row["weight"] for row in model["targets"]}), "evaluation_timezone": "Asia/Shanghai"})
            model["target_definition_hash"] = content_hash(definition_basis(model))
        plan = funding_plan(); plan.update(start_date="2025-01-01", first_annual_date="2026-01-01")
        def advance(projection, previous, at, digest):
            funding = {"schema_version": "investor-planned-funding-monitor-v1", "funding_plan": plan,
                "binding": {"funding_plan_id": "fictional-restatement-funding", "funding_plan_hash": content_hash(plan), "profile_hash": model["profile_hash"],
                    "model_id": model["model_id"], "model_hash": content_hash(model), "model_created_at": model["created_at"], "plan_declared_at": model["created_at"]}, "evaluated_at": at} if funded else None
            return advance_evidence_model(model, projection, previous, at, input_hash=digest * 64, sparse=True, planned_funding=funding)["checkpoint"]
        origin = advance(origin_projection, None, MONITOR_NOW, "1")
        ex_now = max(row["known_at"] for row in ex_projection["quotes"])
        paid_now = max(row["known_at"] for row in paid_projection["quotes"])
        ex = advance(ex_projection, origin, ex_now, "2")
        head = advance(paid_projection, ex, paid_now, "3")
        assert origin and ex and head
        value = request(model, origin, head, origin_projection, paid_projection, ex_projection["corporate_actions"] + paid_projection["corporate_actions"])
        value["corrected_actions"][0].update(net_per_unit="6", known_at=value["checked_at"])
        result[name] = value
    return result


def temporal_cases(definition, origin, origin_projection, ex_projection, paid_projection):
    ex = deepcopy(ex_projection); dividend = deepcopy(ex["corporate_actions"][0])
    before_split = {"id": "fictional-before-ex-split", "listing_id": dividend["listing_id"], "kind": "split", "ratio": "2",
        "effective_at": dividend["effective_at"], "known_at": dividend["known_at"]}
    ex["corporate_actions"] = [dividend, before_split]
    ex_now = max(row["known_at"] for row in ex["quotes"])
    ex_head = advance_evidence_model(definition, ex, origin, ex_now, input_hash="4" * 64, sparse=True)["checkpoint"]
    paid = deepcopy(paid_projection); payment = paid["corporate_actions"][0]
    after_split = {**before_split, "id": "fictional-after-ex-split", "ratio": "0.5", "effective_at": payment["effective_at"], "known_at": payment["known_at"]}
    paid["corporate_actions"] = [payment, after_split]
    pay_now = max(row["known_at"] for row in paid["quotes"])
    head = advance_evidence_model(definition, paid, ex_head, pay_now, input_hash="5" * 64, sparse=True)["checkpoint"]
    assert ex_head and head
    chain = request(definition, origin, head, origin_projection, paid, ex["corporate_actions"] + paid["corporate_actions"])
    chain["corrected_actions"][0].update(net_per_unit="6", known_at=chain["checked_at"])
    pre = deepcopy(origin_projection)
    pre["corporate_actions"] = [{**before_split, "effective_at": origin["initialized_at"]["HK"], "known_at": MONITOR_NOW}]
    initial = advance_evidence_model(definition, pre, None, MONITOR_NOW, input_hash="6" * 64, sparse=True)["checkpoint"]
    at_inception = request(definition, initial, initial, pre, pre, pre["corporate_actions"])
    at_inception["corrected_actions"][0].update(ratio="3", known_at=at_inception["checked_at"])
    late = deepcopy(ex_projection); late["corporate_actions"] = [{**before_split, "effective_at": origin["initialized_at"]["HK"]}]
    late_head = advance_evidence_model(definition, late, origin, ex_now, input_hash="7" * 64, sparse=True)["checkpoint"]
    late_pre = request(definition, origin, late_head, origin_projection, late, late["corporate_actions"])
    late_pre["corrected_actions"][0].update(ratio="3", known_at=late_pre["checked_at"])
    names_ex, names_pay = deepcopy(ex_projection), deepcopy(paid_projection)
    names_ex["corporate_actions"][0]["entitlement_id"] = "constructor"
    names_pay["corporate_actions"][0]["entitlement_id"] = "constructor"
    names_head = advance_evidence_model(definition, names_ex, origin, ex_now, input_hash="a" * 64, sparse=True)["checkpoint"]
    names_head = advance_evidence_model(definition, names_pay, names_head, pay_now, input_hash="b" * 64, sparse=True)["checkpoint"]
    names = request(definition, origin, names_head, origin_projection, names_pay, names_ex["corporate_actions"] + names_pay["corporate_actions"])
    names["corrected_actions"][0].update(net_per_unit="6", known_at=names["checked_at"])
    return {"ex_entitlement_before_later_split": chain, "at_inception": at_inception, "late_pre_inception": late_pre, "dictionary_identifier": names}


def long_ledger_case(definition, origin, origin_projection, ex_projection, paid_projection):
    middle, end = deepcopy(ex_projection), deepcopy(paid_projection)
    listing = definition["targets"][0]["listing_id"]; effective = origin["initialized_at"][definition["targets"][0]["market"]]
    known = max(row["known_at"] for row in middle["quotes"])
    original = [{"id": "fictional-old-split-" + str(index), "listing_id": listing, "kind": "split", "ratio": "1", "effective_at": effective, "known_at": known} for index in range(600)]
    middle["corporate_actions"], end["corporate_actions"] = original[:300], original[300:]
    mid = advance_evidence_model(definition, middle, origin, known, input_hash="8" * 64, sparse=True)["checkpoint"]
    head = advance_evidence_model(definition, end, mid, max(row["known_at"] for row in end["quotes"]), input_hash="9" * 64, sparse=True)["checkpoint"]
    assert mid and head
    value = request(definition, origin, head, origin_projection, end, original)
    value["corrected_actions"][0].update(ratio="2", known_at=value["checked_at"])
    return value


def fractional_case():
    definition, source = model_fixture(); definition["data_mode"] = "reconstructed"
    for row, weight in zip(definition["targets"], ("0.33333333", "0.33333333", "0.33333334")): row["weight"] = weight
    definition["target_definition_hash"] = content_hash(definition_basis(definition))
    for row, price in zip(source["quotes"], ("0.123456789123456789", "222.987654321987654321", "17.000000000000000001")): row["close"] = price
    for row in source["fx"]: row["value"] = "0.876543210987654321" if row["currency"] == "HKD" else "7.123456789123456789"
    initial_projection = evidence_projection(source, definition)
    origin = advance_evidence_model(definition, initial_projection, None, MONITOR_NOW, input_hash="c" * 64, sparse=True)["checkpoint"]
    ex, ex_at = next_snapshot(source); hk = next(row for row in ex["quotes"] if row["market"] == "HK")
    actions = [{"id": "fractional-split", "listing_id": hk["listing_id"], "kind": "split", "ratio": "1.123456789123456789", "effective_at": hk["observed_at"], "known_at": ex_at},
        {"id": "fractional-ex", "listing_id": hk["listing_id"], "kind": "dividend_ex", "currency": "HKD", "net_per_unit": "0.000000000000000001",
            "entitlement_id": "fractional-dividend", "tax_assumption_hash": "a" * 64, "effective_at": hk["observed_at"], "known_at": ex_at}]
    ex["corporate_actions"] = actions; ex_projection = evidence_projection(ex, definition)
    ex_state = advance_evidence_model(definition, ex_projection, origin, ex_at, input_hash="d" * 64, sparse=True)["checkpoint"]
    pay, pay_at = next_snapshot(ex)
    payment = {"id": "fractional-pay", "listing_id": hk["listing_id"], "kind": "dividend_payment", "currency": "HKD",
        "entitlement_id": "fractional-dividend", "ex_at": hk["observed_at"], "effective_at": next(row for row in pay["quotes"] if row["market"] == "HK")["observed_at"], "known_at": pay_at}
    pay["corporate_actions"] = [payment]; pay_projection = evidence_projection(pay, definition)
    head = advance_evidence_model(definition, pay_projection, ex_state, pay_at, input_hash="e" * 64, sparse=True)["checkpoint"]
    assert origin and ex_state and head
    value = request(definition, origin, head, initial_projection, pay_projection, actions + [payment])
    value["corrected_actions"][1].update(net_per_unit="0.000000000000000002", known_at=value["checked_at"])
    return value


def restatement_cases(include_long=False):
    definition, cases = sparse_cases()
    origin_projection = cases[0]["projection"]
    origin = advance_evidence_model(definition, origin_projection, None, cases[0]["now"], input_hash="a" * 64, sparse=True)["checkpoint"]
    ex, paid = cases[5:7]
    unpaid_head = advance_evidence_model(definition, ex["projection"], origin, ex["now"], input_hash="b" * 64, sparse=True)["checkpoint"]
    paid_head = advance_evidence_model(definition, paid["projection"], unpaid_head, paid["now"], input_hash="c" * 64, sparse=True)["checkpoint"]
    original = ex["projection"]["corporate_actions"] + paid["projection"]["corporate_actions"]
    paid_input = request(definition, origin, paid_head, origin_projection, paid["projection"], original)
    paid_input["corrected_actions"][0].update(net_per_unit="6", known_at=paid_input["checked_at"])
    unpaid_input = request(definition, origin, unpaid_head, origin_projection, ex["projection"], ex["projection"]["corporate_actions"])
    unpaid_input["corrected_actions"][0].update(net_per_unit="6", known_at=unpaid_input["checked_at"])
    cancellation = deepcopy(paid_input); cancellation["corrected_actions"] = []
    unchanged = deepcopy(paid_input); unchanged["corrected_actions"] = deepcopy(unchanged["original_actions"])
    knowledge = deepcopy(unchanged)
    for action in knowledge["corrected_actions"]: action["known_at"] = knowledge["checked_at"]
    split = cases[2]
    split_head = advance_evidence_model(definition, split["projection"], origin, split["now"], input_hash="d" * 64, sparse=True)["checkpoint"]
    split_input = request(definition, origin, split_head, origin_projection, split["projection"], split["projection"]["corporate_actions"])
    split_input["corrected_actions"][0].update(ratio="3", known_at=split_input["checked_at"])
    missed_projection = deepcopy(paid["projection"]); missed_projection["corporate_actions"] = []
    for market, coverage in missed_projection["corporate_action_coverage"].items(): coverage["from"] = origin["market_cutoffs"][market]
    missed_head = advance_evidence_model(definition, missed_projection, origin, paid["now"], input_hash="e" * 64, sparse=True)["checkpoint"]
    missed_input = request(definition, origin, missed_head, origin_projection, missed_projection, [])
    missed_input["corrected_actions"] = deepcopy(paid_input["corrected_actions"])
    for action in missed_input["corrected_actions"]: action["known_at"] = missed_input["checked_at"]
    result = {"paid": paid_input, "unpaid": unpaid_input, "cancelled": cancellation, "unchanged": unchanged,
        "knowledge_only": knowledge, "split": split_input, "missed": missed_input}
    result.update(protocol_cases(definition, origin_projection, ex["projection"], paid["projection"]))
    result.update(temporal_cases(definition, origin, origin_projection, ex["projection"], paid["projection"]))
    result["fractional"] = fractional_case()
    if include_long: result["long_ledger"] = long_ledger_case(definition, origin, origin_projection, ex["projection"], paid["projection"])
    return result


def retained_v5_case(db, path):
    from tests.investor.test_legacy_protocol_matrix import protocol_case, offline_protocol_fixture
    with offline_protocol_fixture():
        case = protocol_case(db, path); case.prepare("v3"); case.migrate(); current = case.advance()
        actions = {row["id"]: row for row in [*case.projection["corporate_actions"], *current["projection"]["corporate_actions"]]}
        assert {key: content_hash(row) for key, row in actions.items()} == current["state"]["processed_actions"]
        value = request(case.definition, case.state, current["state"], case.projection, current["projection"], list(actions.values()))
        changed = next(row for row in value["corrected_actions"] if row["kind"] == "dividend_ex" and instant(row["effective_at"]) > instant(case.state["initialized_at"]["US"]))
        from worker.accounting.decimal_math import canonical, decimal
        changed.update(net_per_unit=canonical(decimal(changed["net_per_unit"]) * 2), known_at=value["checked_at"])
        before = db.total_changes; result = compare_action_restatement(value)
        assert db.total_changes == before; case.case.assert_no_finance()
        return {"input": value, "result": result, "model_id": case.model_id, "input_id": current["input_id"], "checkpoint_id": current["checkpoint_id"]}


class ActionRestatementKernelTests(unittest.TestCase):
    def test_actual_retained_original_v3_to_v5_chain_provides_same_economics_without_any_new_writes(self):
        from tests.investor.test_legacy_protocol_matrix import LegacyProtocolMatrixTests
        case = LegacyProtocolMatrixTests(); case.setUp(); self.addCleanup(case.doCleanups)
        value = retained_v5_case(case.db, case.case.path)
        self.assertEqual(value["input"]["head_projection"]["schema_version"], "investor-monitor-data-projection-v3")
        self.assertEqual(value["result"]["original"]["quantities"], value["result"]["restated"]["quantities"])
        self.assertNotEqual(value["result"]["difference_cny"], "0")
        self.assertFalse(value["result"]["state_published"])

    def test_fractional_units_small_dividends_and_non_unit_fx_are_not_rounded_to_cents(self):
        value = fractional_case(); result = compare_action_restatement(value)
        from worker.accounting.decimal_math import decimal
        self.assertGreater(decimal(result["difference_cny"]), 0)
        self.assertLess(decimal(result["difference_cny"]), decimal("0.000000000000001"))
        self.assertEqual(verify_action_restatement_arithmetic(value, result), result)
        result["difference_cny"] = "0"
        validate_contract(result, SCHEMA, fragment="$defs/result")
        with self.assertRaisesRegex(WorkbenchError, "RESULT_REPLAY_MISMATCH"): verify_action_restatement_arithmetic(value, result)

    def test_ex_date_units_not_latest_units_and_pre_inception_facts_do_not_create_entitlements(self):
        cases = restatement_cases()
        result = compare_action_restatement(cases["ex_entitlement_before_later_split"])
        self.assertEqual(result["original"]["cash_by_currency"]["HKD"], "300")
        self.assertEqual(result["restated"]["cash_by_currency"]["HKD"], "360")
        self.assertEqual(result["difference_cny"], "48")
        self.assertEqual(result["original"]["quantities"], result["restated"]["quantities"])
        for name in ("at_inception", "late_pre_inception"):
            with self.subTest(name=name):
                value = compare_action_restatement(cases[name])
                self.assertEqual(value["difference_cny"], "0"); self.assertFalse(value["economics_changed"])
                self.assertEqual(value["changed_action_count"], 1)

    def test_fixed_rules_and_genuine_funding_bound_checkpoints_do_not_turn_plan_capital_into_cash(self):
        cases = restatement_cases()
        for name in ("fixed", "funded_v1", "funded_fixed"):
            with self.subTest(name=name):
                self.assertEqual(cases[name]["head"]["schema_version"], "investor-evidence-model-checkpoint-v2" if name == "fixed" else "investor-evidence-model-checkpoint-v3")
                value = compare_action_restatement(cases[name]); self.assertEqual(value["difference_cny"], "24")
                self.assertEqual(value["restated"]["cash_by_currency"]["CNY"], value["original"]["cash_by_currency"]["CNY"])
        names = compare_action_restatement(cases["dictionary_identifier"])
        self.assertEqual(names["difference_cny"], "24"); self.assertIn("constructor", names["restated"]["entitlements"])

    def test_fixed_parameters_funding_and_original_quote_times_are_independently_bound(self):
        values = restatement_cases()
        changed = deepcopy(values["funded_fixed"]); changed["head"]["funding_binding"]["model_hash"] = "f" * 64
        with self.assertRaisesRegex(WorkbenchError, "FUNDING_SCOPE"): compare_action_restatement(changed)
        changed = deepcopy(values["fixed"]); changed["definition"]["fixed_policy"]["evaluation_timezone"] = "Not/AZone"
        with self.assertRaises(WorkbenchError): compare_action_restatement(changed)
        changed = deepcopy(values["paid"])
        changed["head_projection"]["quotes"][0]["known_at"] = changed["checked_at"]
        changed["head"]["projection_hash"] = content_hash(changed["head_projection"])
        with self.assertRaisesRegex(WorkbenchError, "ORIGINAL_PRICE_CLOCK"): compare_action_restatement(changed)

    def test_complete_ledger_can_span_multiple_500_action_projection_windows(self):
        value = restatement_cases(include_long=True)["long_ledger"]
        self.assertEqual(len(value["original_actions"]), 600)
        result = compare_action_restatement(value)
        self.assertEqual(len(result["restated"]["processed_actions"]), 600)
        self.assertEqual(result["difference_cny"], "0"); self.assertEqual(result["changed_action_count"], 1)

    def test_paid_and_unpaid_corrections_keep_one_old_valuation_point_and_original_inputs(self):
        cases = restatement_cases()
        for name in ("paid", "unpaid"):
            value = cases[name]; before = deepcopy(value)
            result = compare_action_restatement(value)
            self.assertEqual(value, before)
            self.assertEqual(result["difference_cny"], "24")
            self.assertEqual(result["restated"]["quantities"], result["original"]["quantities"])
            self.assertEqual(result["restated"]["initialized_at"], result["original"]["initialized_at"])
            self.assertEqual(result["restated"]["market_cutoffs"], result["original"]["market_cutoffs"])
            self.assertEqual(result["delta"]["cash_by_currency"]["HKD"], "30" if name == "paid" else "0")
            self.assertEqual(result["delta"]["receivables_by_currency"]["HKD"], "0" if name == "paid" else "30")
            self.assertEqual(result["changed_action_count"], 1)
            self.assertEqual(result["restated"]["processed_actions"][value["corrected_actions"][0]["id"]], content_hash(value["corrected_actions"][0]))
            for key in ("source_evidence_verified", "checkpoint_created", "state_published", "historical_observations_rewritten", "historical_strategy_results_recomputed", "monitoring_resumed", "current_advice_certified", "trading_permission"):
                self.assertIs(result[key], False)
            self.assertEqual(result["database_writes"], 0); self.assertEqual(result["provider_calls"], 0)

    def test_cancellation_and_late_missing_report_rebuild_entitlements_instead_of_double_crediting(self):
        values = restatement_cases()
        cancelled = compare_action_restatement(values["cancelled"])
        self.assertEqual(cancelled["difference_cny"], "-120")
        self.assertEqual(cancelled["restated"]["cash_by_currency"]["HKD"], "0")
        self.assertEqual(cancelled["restated"]["entitlements"], {})
        missed = compare_action_restatement(values["missed"])
        self.assertEqual(missed["difference_cny"], "144")
        self.assertEqual(missed["restated"]["cash_by_currency"]["HKD"], "180")
        self.assertEqual(len(missed["restated"]["entitlements"]), 1)
        self.assertEqual(compare_action_restatement(values["missed"]), missed)

    def test_split_correction_changes_units_without_new_capital_and_unchanged_or_knowledge_only_does_not_change_economics(self):
        cases = restatement_cases()
        split = compare_action_restatement(cases["split"])
        self.assertEqual(split["difference_cny"], "2000")
        self.assertEqual(split["restated"]["initial_notional_cny"], "10000")
        for name in ("unchanged", "knowledge_only"):
            result = compare_action_restatement(cases[name])
            self.assertEqual(result["difference_cny"], "0"); self.assertFalse(result["economics_changed"])
            self.assertEqual(result["changed_action_count"], 0 if name == "unchanged" else 2)

    def test_resealing_an_incorrect_original_state_does_not_replace_independent_economic_replay(self):
        for mutation in ("cash", "origin_units", "ledger", "projection", "scope"):
            value = restatement_cases()["paid"]
            if mutation == "cash": value["head"]["cash_by_currency"]["HKD"] = "151"
            elif mutation == "origin_units":
                key = next(iter(value["origin"]["quantities"])); value["origin"]["quantities"][key] = "999"
            elif mutation == "ledger": value["original_actions"][0]["net_per_unit"] = "7"
            elif mutation == "projection": value["head_projection"]["fx"][0]["value"] = "2"
            else: value["head"]["model_id"] = "foreign-model"
            with self.subTest(mutation=mutation), self.assertRaises(WorkbenchError): compare_action_restatement(value)

    def test_incomplete_future_duplicate_or_incoherent_corrections_are_not_zero_filled(self):
        for mutation in ("coverage", "coverage_start", "future", "duplicate", "missing_ex", "currency", "payment_time"):
            value = restatement_cases()["paid"]
            if mutation == "coverage": value["corrected_coverage"]["HK"]["complete"] = False
            elif mutation == "coverage_start": value["corrected_coverage"]["HK"]["from"] = value["corrected_coverage"]["HK"]["to"]
            elif mutation == "future": value["corrected_actions"][0]["known_at"] = later(value["checked_at"])
            elif mutation == "duplicate": value["corrected_actions"].append(deepcopy(value["corrected_actions"][0]))
            elif mutation == "missing_ex": value["corrected_actions"] = value["corrected_actions"][1:]
            elif mutation == "currency": value["corrected_actions"][0]["currency"] = "USD"
            else: value["corrected_actions"][1]["ex_at"] = later(value["corrected_actions"][1]["effective_at"])
            with self.subTest(mutation=mutation), self.assertRaises(WorkbenchError): compare_action_restatement(value)

    def test_closed_result_and_input_never_accept_publication_or_advice_grants(self):
        value = restatement_cases()["paid"]; result = compare_action_restatement(value)
        for key in ("state_published", "source_evidence_verified", "current_advice_certified", "trading_permission"):
            changed = deepcopy(result); changed[key] = True
            with self.subTest(key=key), self.assertRaises(WorkbenchError): validate_contract(changed, SCHEMA, fragment="$defs/result")
        value["force"] = True
        with self.assertRaises(WorkbenchError): compare_action_restatement(value)

    def test_extreme_correction_growth_and_underflow_stop_at_existing_derived_number_limits(self):
        for ratio in ("1000000000000000000", "0.000000000000000001"):
            value = restatement_cases()["paid"]; action = value["corrected_actions"][0]
            value["corrected_actions"].extend({"id": "fictional-extreme-" + str(index), "listing_id": action["listing_id"], "kind": "split", "ratio": ratio,
                "effective_at": action["effective_at"], "known_at": value["checked_at"]} for index in range(20))
            with self.subTest(ratio=ratio), self.assertRaisesRegex(WorkbenchError, "DERIVED_RANGE"): compare_action_restatement(value)


if __name__ == "__main__":
    if sys.argv[1:] == ["--contract"]:
        print(canonical_json({key: {"input": value, "result": compare_action_restatement(value)} for key, value in restatement_cases(include_long=True).items()}))
    else: unittest.main()
