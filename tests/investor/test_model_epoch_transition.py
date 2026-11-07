"""Source-free fictional transition arithmetic, never registration or source proof."""

from copy import deepcopy
from datetime import timedelta
import unittest

from tests.investor import test_action_restatement_kernel as restatement
from tests.investor.test_funding_plan import plan as funding_plan
from tests.investor.test_model_state import next_snapshot
from worker.investor.action_restatement_kernel import compare_action_restatement
from worker.investor.model_epoch_transition import advance_corrected_model_epoch, continue_corrected_model_epoch, verify_corrected_model_epoch_arithmetic, verify_model_epoch_continuation_arithmetic, SCHEMA
from worker.investor.model_state import advance_evidence_model
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, instant


def later(at, **kwargs): return (instant(at) + timedelta(**kwargs)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def arithmetic_correction(raw, listing=None, name="fictional-correction"):
    result = compare_action_restatement(raw); model, head, origin = (raw[key] for key in ("definition", "head", "origin"))
    changed = [row["listing_id"] for row in raw["corrected_actions"] if row not in raw["original_actions"]]
    listing = listing or (changed[0] if changed else raw["original_actions"][0]["listing_id"])
    bindings = []
    for sequence in range(1, head["sequence"] + 1):
        checkpoint = origin if sequence == 1 else head
        bindings.append({"checkpoint_id": "fictional-prefix-" + str(sequence), "sequence": sequence, "checkpoint_hash": content_hash(checkpoint),
            "input_id": "fictional-input-" + str(sequence), "input_hash": checkpoint["input_hash"], "input_protocol": "investor-monitor-data-input-v4",
            "projection_hash": checkpoint["projection_hash"], "created_at": checkpoint["created_at"], "valid_until": model["valid_until"]})
    proof = {"schema_version": "investor-retained-monitor-history-v1", "workspace_id": "fictional-no-registration", "actor_id": "fictional-owner",
        "model_id": model["model_id"], "model_hash": content_hash(model), "control_hash": "c" * 64, "origin_checkpoint_id": bindings[0]["checkpoint_id"],
        "head_checkpoint_id": bindings[-1]["checkpoint_id"], "head_checkpoint_sequence": head["sequence"], "checkpoint_chain_hash": content_hash(bindings),
        "original_actions_hash": content_hash(sorted(raw["original_actions"], key=lambda row: row["id"])), "input_bindings": bindings,
        "checked_at": raw["checked_at"], "source_valid_until": model["valid_until"], "purpose": "recorded_history_comparison_only", "status": "original_history_replayed_not_recovered",
        **{key: True for key in ("original_inputs_replayed", "original_states_replayed", "original_knowledge_replayed", "reference_source_current_at_check")},
        **{key: False for key in ("corrected_source_evidence_verified", "current_source_eligibility_restored", "economic_correction_approved", "checkpoint_created",
            "monitoring_resumed", "historical_observations_rewritten", "trading_permission")}, "provider_calls": 0, "database_writes": 0, "distribution": "private_owner_only_not_ai"}
    # These well-shaped metadata/facts deliberately have no database/source proof.
    baseline = {"schema_version": "investor-approved-restatement-baseline-v1", "epoch_id": name, "model_hash": content_hash(model), "original_history": proof,
        "approved_facts": {"listing_id": listing, "range_start": "2025-07-01", "range_end": "2025-07-20", "coverage": "reviewed_complete",
            "tax_assumption": "FICTIONAL unregistered arithmetic only", "events": []}, "corrected_actions_hash": content_hash(raw["corrected_actions"]),
        "economics": result["restated"], "policy_state": deepcopy(head.get("policy_state")), "original_checkpoint_hash": content_hash(head),
        "original_projection_hash": content_hash(raw["head_projection"]), "comparison_hash": content_hash(result),
        "valuation_summary": {key: result[key] for key in ("original_valuation_cny", "restated_valuation_cny", "difference_cny", "delta")},
        "knowledge_at": raw["checked_at"], "status": "approved_baseline_requires_new_current_data_protocol"}
    return {"baseline": baseline, "corrected_actions": deepcopy(raw["corrected_actions"]), "confirmation_hash": "d" * 64,
        "handover_id": name + "-handover", "handover_hash": "e" * 64, "handover_at": later(raw["checked_at"], minutes=1)}


def epoch_case(raw):
    projection, at = next_snapshot(raw["head_projection"], days=2)
    projection.update(created_at=at, valid_until=raw["definition"]["valid_until"], corporate_actions=deepcopy(raw["corrected_actions"]))
    history = {key: deepcopy(raw[key]) for key in ("definition", "origin", "head", "origin_projection", "head_projection", "original_actions", "corrected_coverage")}
    planned = None
    if "funding_binding" in raw["head"]:
        plan = funding_plan(); plan.update(start_date="2025-01-01", first_annual_date="2026-01-01")
        planned = {"schema_version": "investor-planned-funding-monitor-v1", "funding_plan": plan, "binding": deepcopy(raw["head"]["funding_binding"]), "evaluated_at": at}
        projection["funding_intent"] = None
    return {"schema_version": "investor-model-epoch-transition-input-v1", "epoch_id": "fictional-new-epoch", "history": history,
        "corrections": [arithmetic_correction(raw)], "projection": projection, "input_hash": "f" * 64, "planned_funding": planned, "now": at}


def epoch_cases():
    values = {name: epoch_case(raw) for name, raw in restatement.restatement_cases().items() if name != "unchanged"}
    value = deepcopy(values["unpaid"]); action = value["projection"]["corporate_actions"][0]
    value["projection"]["corporate_actions"].append({"id": "fictional-new-payment", "listing_id": action["listing_id"], "kind": "dividend_payment",
        "currency": action["currency"], "entitlement_id": action["entitlement_id"], "ex_at": action["effective_at"],
        "effective_at": next(row["observed_at"] for row in value["projection"]["quotes"] if row["listing_id"] == action["listing_id"]), "known_at": value["now"]})
    values["next_payment"] = value
    raw = deepcopy(restatement.restatement_cases()["paid"])
    listing = next(row["listing_id"] for row in raw["definition"]["targets"] if row["market"] == "CN")
    raw["checked_at"] = later(raw["checked_at"], seconds=1)
    split = {"id": "fictional-second-listing-split", "listing_id": listing, "kind": "split", "ratio": "2",
        "effective_at": raw["head"]["market_cutoffs"]["CN"], "known_at": raw["checked_at"]}
    raw["corrected_actions"] = deepcopy(raw["original_actions"]) + [split]
    multi = deepcopy(values["paid"]); multi["corrections"].append(arithmetic_correction(raw, listing, "fictional-second-correction"))
    multi["projection"]["corporate_actions"].append(split); values["multi_listing"] = multi
    observe = deepcopy(values["cancelled"]); observe["projection"]["funding_intent"] = None; values["observe"] = observe
    stale = deepcopy(values["paid"])
    stale["projection"]["quotes"][0]["valid_until"] = later(stale["projection"]["quotes"][0]["known_at"], seconds=1)
    stale["now"] = later(stale["now"], minutes=1); values["stale"] = stale
    return values


def continuation_cases():
    result = {}
    for name, first in epoch_cases().items():
        if name == "stale": continue
        previous = advance_corrected_model_epoch(first)["checkpoint"]
        projection, at = next_snapshot(first["projection"])
        projection.update(created_at=at, valid_until=first["history"]["definition"]["valid_until"], corporate_actions=deepcopy(first["projection"]["corporate_actions"]))
        planned = deepcopy(first["planned_funding"])
        if planned: planned["evaluated_at"] = at
        result[name] = {"schema_version": "investor-model-epoch-continuation-input-v1", "definition": deepcopy(first["history"]["definition"]),
            "previous": previous, "projection": projection, "input_hash": "a" * 64, "planned_funding": planned, "now": at}
    split = deepcopy(result["paid"]); listing = next(row for row in split["projection"]["quotes"] if row["market"] == "CN")
    split["projection"]["corporate_actions"].append({"id": "fictional-post-epoch-split", "listing_id": listing["listing_id"], "kind": "split",
        "ratio": "2", "effective_at": listing["observed_at"], "known_at": split["now"]}); result["new_split"] = split
    payment = deepcopy(result["unpaid"]); action = payment["projection"]["corporate_actions"][0]
    payment["projection"]["corporate_actions"].append({"id": "fictional-post-epoch-payment", "listing_id": action["listing_id"], "kind": "dividend_payment",
        "currency": action["currency"], "entitlement_id": action["entitlement_id"], "ex_at": action["effective_at"],
        "effective_at": next(row["observed_at"] for row in payment["projection"]["quotes"] if row["listing_id"] == action["listing_id"]), "known_at": payment["now"]})
    result["new_payment"] = payment
    again = deepcopy(payment); again["previous"] = continue_corrected_model_epoch(payment)["checkpoint"]; again["now"] = later(again["now"], minutes=1)
    result["same_payment_again"] = again
    same_close = deepcopy(result["paid"]); first = epoch_cases()["paid"]
    same_close["projection"] = deepcopy(first["projection"]); same_close["now"] = later(first["now"], minutes=1); result["same_close"] = same_close
    stale = deepcopy(result["paid"]); quote = stale["projection"]["quotes"][0]
    quote["valid_until"] = later(quote["known_at"], seconds=1); stale["now"] = later(stale["now"], minutes=1); result["stale"] = stale
    return result


class ModelEpochTransitionTests(unittest.TestCase):
    def test_continuation_preserves_epoch_and_sparse_state_but_appends_real_action_changes_once(self):
        cases = continuation_cases()
        for name, value in cases.items():
            with self.subTest(name=name):
                before = deepcopy(value); result = continue_corrected_model_epoch(value); self.assertEqual(value, before)
                self.assertEqual(result["epoch_binding"], value["previous"]["epoch_binding"])
                self.assertFalse(result["registered_bindings_verified"]); self.assertFalse(result["source_evidence_verified"])
                if name == "stale": self.assertIsNone(result["checkpoint"]); self.assertIsNone(result["monitor_request"]); continue
                candidate = result["checkpoint"]
                self.assertEqual(candidate["initialized_at"], value["previous"]["initialized_at"])
                self.assertEqual(candidate["initial_notional_cny"], "10000")
                if name in ("same_close", "same_payment_again"): self.assertEqual(candidate, value["previous"])
                if name == "paid": self.assertNotEqual(candidate, value["previous"])
                if candidate != value["previous"]:
                    self.assertEqual(candidate["sequence"], value["previous"]["sequence"] + 1)
                    self.assertEqual(candidate["previous_hash"], content_hash(value["previous"]))
                self.assertEqual(result["monitor_request"]["document"]["model_state_hash"], content_hash(candidate))
        self.assertEqual(continue_corrected_model_epoch(cases["new_payment"])["checkpoint"]["cash_by_currency"]["HKD"], "180")
        self.assertEqual(continue_corrected_model_epoch(cases["same_payment_again"])["checkpoint"]["cash_by_currency"]["HKD"], "180")
        self.assertEqual(verify_model_epoch_continuation_arithmetic(cases["new_split"], continue_corrected_model_epoch(cases["new_split"])), continue_corrected_model_epoch(cases["new_split"]))

    def test_continuation_rejects_missing_or_changed_old_ledger_binding_regression_and_limit_without_legacy_bypass(self):
        base = continuation_cases()["new_split"]
        for mutate in (lambda v: v["projection"].update(corporate_actions=[]),
                lambda v: v["previous"]["epoch_binding"].update(model_hash="0" * 64),
                lambda v: v["projection"]["corporate_actions"][0].update(known_at=v["now"]),
                lambda v: v["projection"]["quotes"][0].update(observed_at="2025-07-01T00:00:00.000Z")):
            value = deepcopy(base); mutate(value)
            with self.assertRaises((ValueError, WorkbenchError)): continue_corrected_model_epoch(value)
        capped = deepcopy(base); capped["previous"].update(sequence=1000)
        with self.assertRaisesRegex(WorkbenchError, "CHECKPOINT_LIMIT_REQUIRES_CONTINUATION"): continue_corrected_model_epoch(capped)
        result = continue_corrected_model_epoch(base); result["checkpoint"]["previous_hash"] = "0" * 64
        with self.assertRaisesRegex(WorkbenchError, "RESULT_REPLAY_MISMATCH"): verify_model_epoch_continuation_arithmetic(base, result)

    def test_next_close_preserves_original_principal_origin_history_and_persisted_parent_not_bridge(self):
        for name, value in epoch_cases().items():
            with self.subTest(name=name):
                before = deepcopy(value); result = advance_corrected_model_epoch(value); self.assertEqual(value, before)
                for flag in ("registered_bindings_verified", "source_evidence_verified", "checkpoint_created", "state_published", "monitoring_resumed", "trading_permission"):
                    self.assertIs(result[flag], False)
                if name == "stale":
                    self.assertIsNone(result["checkpoint"]); self.assertIsNone(result["monitor_request"]); self.assertEqual(result["assessment"]["outcome"], "insufficient_evidence"); continue
                candidate = result["checkpoint"]; head = value["history"]["head"]
                self.assertEqual(candidate["schema_version"], "investor-evidence-model-checkpoint-v4")
                self.assertEqual(candidate["sequence"], head["sequence"] + 1); self.assertEqual(candidate["previous_hash"], content_hash(head))
                self.assertEqual(candidate["initialized_at"], head["initialized_at"]); self.assertEqual(candidate["initial_notional_cny"], "10000")
                self.assertEqual(result["monitor_request"]["document"]["model_state_hash"], content_hash(candidate))
                if name in ("paid", "split", "funded_v1", "funded_fixed", "fixed"):
                    baseline = value["corrections"][0]["baseline"]
                    self.assertEqual(candidate["quantities"], baseline["economics"]["quantities"])
                    self.assertEqual(candidate["cash_by_currency"], baseline["economics"]["cash_by_currency"])
                with self.assertRaises(ValueError): validate_contract(candidate, "investor-evidence-model-checkpoint.schema.json")
                with self.assertRaises((ValueError, WorkbenchError)):
                    advance_evidence_model(value["history"]["definition"], value["projection"], candidate, value["now"], input_hash=value["input_hash"])

    def test_next_payment_uses_restated_ex_date_entitlement_once_and_multiple_listings_are_recomputed_together(self):
        cases = epoch_cases(); paid = advance_corrected_model_epoch(cases["next_payment"])["checkpoint"]
        self.assertEqual(advance_corrected_model_epoch(cases["paid"])["assessment"]["outcome"], "observe")
        self.assertEqual(advance_corrected_model_epoch(cases["split"])["assessment"]["outcome"], "decision_required")
        self.assertEqual(paid["cash_by_currency"]["HKD"], "180"); self.assertEqual(paid["receivables"], [])
        result = advance_corrected_model_epoch(cases["multi_listing"]); baseline = cases["paid"]["corrections"][0]["baseline"]
        listing = cases["multi_listing"]["corrections"][1]["baseline"]["approved_facts"]["listing_id"]
        from worker.accounting.decimal_math import decimal
        self.assertEqual(decimal(result["checkpoint"]["quantities"][listing]), decimal(baseline["economics"]["quantities"][listing]) * 2)
        self.assertEqual(result["checkpoint"]["cash_by_currency"], baseline["economics"]["cash_by_currency"])
        self.assertEqual(len(result["epoch_binding"]["corrections"]), 2)

    def test_backdated_or_missing_market_close_wrong_baseline_ledger_scope_policy_knowledge_and_closed_protocol_stop(self):
        base = epoch_cases()["paid"]
        mutations = [lambda v: v["corrections"].append(deepcopy(v["corrections"][0])),
            lambda v: v["corrections"][0]["baseline"]["economics"]["cash_by_currency"].update(HKD="99999"),
            lambda v: v["corrections"][0]["baseline"].update(policy_state={}),
            lambda v: v["corrections"][0].update(handover_at=v["now"]),
            lambda v: v["projection"]["quotes"][0].update(observed_at=v["history"]["head"]["market_cutoffs"][v["projection"]["quotes"][0]["market"]]),
            lambda v: v["projection"]["quotes"].pop(), lambda v: v["projection"].update(corporate_actions=[]),
            lambda v: v["corrections"][0]["corrected_actions"][0].update(known_at=v["history"]["head"]["created_at"]),
            lambda v: v["history"]["origin"]["quantities"].update({next(iter(v["history"]["origin"]["quantities"])): "999"}),
            lambda v: v["corrections"][0]["baseline"]["original_history"].update(model_hash="a" * 64),
            lambda v: v.update(force=True)]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                value = deepcopy(base); mutate(value)
                with self.assertRaises((ValueError, WorkbenchError)): advance_corrected_model_epoch(value)
        result = advance_corrected_model_epoch(base)
        for key in ("registered_bindings_verified", "source_evidence_verified", "checkpoint_created", "state_published", "monitoring_resumed", "trading_permission"):
            with self.assertRaises(ValueError): validate_contract({**result, key: True}, SCHEMA, fragment="$defs/result")
        self.assertEqual(verify_corrected_model_epoch_arithmetic(base, result), result)
        for index in range(len(base["projection"]["quotes"])):
            value = deepcopy(base); value["projection"]["quotes"][index]["observed_at"] = value["corrections"][0]["handover_at"]
            with self.assertRaisesRegex(WorkbenchError, "NEXT_CLOSE_REQUIRED"): advance_corrected_model_epoch(value)
        result["checkpoint"]["previous_hash"] = result["epoch_binding"]["bridge_hash"]
        result["monitor_request"]["document"]["model_state_hash"] = content_hash(result["checkpoint"])
        from worker.investor.monitor import assess_model
        result["assessment"] = assess_model(result["monitor_request"]["document"], base["now"])
        validate_contract(result, SCHEMA, fragment="$defs/result")
        with self.assertRaisesRegex(WorkbenchError, "RESULT_REPLAY_MISMATCH"): verify_corrected_model_epoch_arithmetic(base, result)

    def test_existing_checkpoint_limit_is_not_increased_or_hidden_by_a_new_epoch(self):
        raw = deepcopy(restatement.restatement_cases()["paid"]); raw["head"]["sequence"] = 1000
        value = epoch_case(raw)
        with self.assertRaisesRegex(WorkbenchError, "CHECKPOINT_LIMIT_REQUIRES_CONTINUATION"): advance_corrected_model_epoch(value)

    def test_registered_fictional_handover_supplies_the_exact_baseline_but_arithmetic_alone_still_does_not_resume_monitoring(self):
        from tests.investor import test_corrected_action_handover as fixture
        from worker.investor import corrected_action_source as source, action_review_workflow as review, managed_actions
        from worker.investor.retained_monitor_history import read_registered_correction_history
        from worker.investor.action_correction_impact import _ledger
        from worker.orchestration.db import open_database
        import json

        case = fixture.CorrectedActionHandoverTests(); case.setUp(); self.addCleanup(case.doCleanups)
        case.prepared(); completed = case.finish_handover(case.enqueue_handover()); self.assertEqual(completed["outcome"], "confirmed")
        db = open_database(case.path, read_only=True); self.addCleanup(db.close)
        doc = source.read_correction_consent_baseline(db, "w", fixture.OWNER, case.correction["id"], now=fixture.AT)
        handover = review.resolve_action_review_confirmation(db, "w", fixture.OWNER, completed["resource_id"], now=fixture.AT)
        history = read_registered_correction_history(db, "w", fixture.OWNER, case.correction["id"], now=fixture.AT)
        baseline = doc["baseline"]; facts = baseline["approved_facts"]
        impact = json.loads(db.execute("SELECT document_json FROM investor_correction_impact_requests WHERE id=?", (doc["impact_request_id"],)).fetchone()[0])
        days = {row["date"] for row in impact["body"]["decisions"]}
        changed = lambda row: row["listing_id"] == facts["listing_id"] and instant(row.get("ex_at", row["effective_at"])).astimezone(managed_actions.ZONE).date().isoformat() in days
        actions = sorted([row for row in history["original_actions"] if not changed(row)] + [row for row in _ledger(facts,
            history["head"]["market_cutoffs"]["US"], baseline["knowledge_at"]) if changed(row)], key=lambda row: row["id"])
        self.assertEqual(content_hash(actions), baseline["corrected_actions_hash"])
        # Only extrapolated arithmetic here; no new price/calendar source is admitted.
        projection, at = next_snapshot(history["head_projection"], days=3)
        projection.update(created_at=at, valid_until=history["definition"]["valid_until"], corporate_actions=actions)
        projection["corporate_action_coverage"] = {row["market"]: {"from": history["head"]["market_cutoffs"][row["market"]],
            "to": row["observed_at"], "complete": True} for row in projection["quotes"]}
        value = {"schema_version": "investor-model-epoch-transition-input-v1", "epoch_id": "fictional-unregistered-epoch-from-retained-source",
            "history": {**{key: history[key] for key in ("definition", "origin", "head", "origin_projection", "head_projection", "original_actions")},
                "corrected_coverage": history["head_projection"]["corporate_action_coverage"]},
            "corrections": [{"baseline": baseline, "corrected_actions": actions, "confirmation_hash": case.correction["content_hash"],
                "handover_id": handover["confirmation_id"], "handover_hash": content_hash(handover), "handover_at": handover["created_at"]}],
            "projection": projection, "input_hash": "f" * 64, "planned_funding": None, "now": at}
        before = list(case.db.iterdump()); result = advance_corrected_model_epoch(value)
        self.assertIsNotNone(result["checkpoint"]); self.assertEqual(result["checkpoint"]["previous_hash"], content_hash(history["head"]))
        self.assertEqual(result["checkpoint"]["initialized_at"], history["head"]["initialized_at"])
        self.assertFalse(result["registered_bindings_verified"]); self.assertFalse(result["monitoring_resumed"])
        self.assertEqual(db.total_changes, 0); self.assertEqual(before, list(case.db.iterdump())); case.assert_no_finance()


if __name__ == "__main__": unittest.main()
