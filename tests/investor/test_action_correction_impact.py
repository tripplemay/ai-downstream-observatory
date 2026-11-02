"""Retained invented reports and real local replay; no supplier or approval I/O."""

from contextlib import closing
from copy import deepcopy
from hashlib import sha256
import json
import unittest
from unittest.mock import patch

from tests.investor import test_managed_actions as managed_fixture, action_reconciliation_fixture as sources
from tests.investor import test_runtime as runtime
from tests.investor.test_legacy_protocol_matrix import protocol_case, offline_protocol_fixture
from tests.investor.test_reviewed_action_successor import UpdatedCollector
from tests.market.test_vanguard_distributions import archive, row
from tests.market.test_eodhd_actions import archive as eodhd_archive
from worker.market.providers.eodhd_actions import parse_eodhd_actions
from worker.investor import action_review_workflow as review, eodhd_sources, issuer_schedule, managed_actions
from worker.investor.action_correction_impact import compare_action_correction_impact
from worker.orchestration.db import WorkbenchError, open_database
from worker.orchestration.jobs import run_one


REPORTED = "2026-11-07T06:00:03.000Z"
CHECKED = "2026-11-07T06:00:04.001Z"
OWNER = "synthetic-investor"


class SplitCorrectionCollector(UpdatedCollector):
    def __call__(self, **options):
        result = super().__call__(**options)
        if options["kind"] == "splits" and options["symbol"] == "VT.US":
            raw = eodhd_archive(json.dumps({"date": "2026-11-05", "split": "2.000000/1.000000"}).encode())
            result["raw"] = raw; result["receipt"].update(raw_sha256=sha256(raw).hexdigest(), raw_bytes=len(raw))
            result["draft"] = parse_eodhd_actions(raw, **{key: options[key] for key in ("kind", "symbol", "start_date", "end_date")}, retrieved_at=REPORTED)
        return result


def correction_case(db, path, *, mode="replace"):
    assert mode in ("replace", "cancel", "split")
    with offline_protocol_fixture():
        case = protocol_case(db, path); case.prepare("v3"); case.migrate(); original = case.advance()
        pending = db.execute("SELECT id FROM job_runs WHERE job_type=? AND status='queued' ORDER BY created_at,id", (issuer_schedule.JOB_TYPE,)).fetchall()
        for unused in pending:
            result = run_one(db, "fictional-expired-correction-issuer", lambda job, lease: issuer_schedule.prepare_issuer_capture(
                db, job, lease, clock=lambda: REPORTED), job_type=issuer_schedule.JOB_TYPE, lease_seconds=180, clock=lambda: REPORTED)
            assert result["status"] == "skipped"
        records = [row("987.1234", exDividendDate="2026-09-25", recordDate="2026-09-25", payableDate="2026-09-30")]
        if mode != "cancel": records.append(row("5.32109" if mode == "replace" else "4.32109", exDividendDate="2026-11-05", recordDate="2026-11-05", payableDate="2026-11-09"))
        collector = sources.ActionCollector if mode == "cancel" else SplitCorrectionCollector if mode == "split" else UpdatedCollector
        with patch.object(managed_fixture, "LATER", REPORTED), patch.object(sources, "ActionCollector", collector), patch.object(UpdatedCollector, "event_day", "2026-11-05"):
            case.case.next_source_day(issuer_raw=archive(*records))
        authority = db.execute("SELECT new_authority_id FROM investor_action_review_confirmations ORDER BY rowid DESC LIMIT 1").fetchone()[0]
        revision = db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
        preview = review.register_action_review_preview(db, "w", OWNER, {"authority_id": authority, "expected_revision": revision,
            "idempotency_key": "fictional-correction-source-preview"}, now=CHECKED, owner_interaction=True)
        request = {"schema_version": "investor-action-correction-impact-request-v1", "model_id": case.model_id, "preview_id": preview["preview_id"],
            "expected_revision": preview["workspace_revision"], "idempotency_key": "fictional-correction-impact",
            "acknowledgements": {key: True for key in ("hypothetical_only", "source_differences_seen", "explicit_time_and_tax", "original_reported_coverage_only", "unchanged_tax_assumption")},
            "decisions": [{"date": "2026-11-05", "choice": "replace", "reason": "Fictional issuer correction; old independent nominal report is still shown, not silently approved",
                "events": [{"type": "dividend", "at": "2026-11-05T14:30:00Z", "pay_at": "2026-11-09T21:00:00Z", "tax_per_unit": "0.432109"}]}]}
        if mode == "cancel": request["decisions"][0].update(choice="cancel", events=[])
        elif mode == "split": request["decisions"][0]["events"].append({"type": "split", "at": "2026-11-05T14:00:00Z",
            "ratio_direction": "provider_numerator_new_units_per_denominator_old_unit_assumed"})
        return {"request": request, "checked_at": CHECKED, "authority_id": authority, "member": case.case.member, "head": original["state"]}


class ActionCorrectionImpactTests(unittest.TestCase):
    setUp = runtime.InvestorRuntimeTests.setUp
    assert_no_finance = runtime.InvestorRuntimeTests.assert_no_finance

    def prepare(self):
        self.enterContext(offline_protocol_fixture()); self.value = correction_case(self.db, self.path)
        return self.value["request"]

    def compare(self, request=None, *, now=CHECKED, db=None):
        return compare_action_correction_impact(db or self.db, "w", OWNER, request or self.value["request"], now=now)

    def test_actual_changed_current_report_replays_paid_or_pending_economics_without_creating_approval(self):
        request = self.prepare(); before = list(self.db.iterdump()); count = self.db.total_changes
        result = self.compare(request)
        self.assertEqual(before, list(self.db.iterdump())); self.assertEqual(count, self.db.total_changes)
        self.assertTrue(result["comparison"]["economics_changed"])
        self.assertGreater(float(result["comparison"]["difference_cny"]), 0)
        self.assertEqual(result["comparison"]["original"]["quantities"], self.value["head"]["quantities"])
        changed = next(row for row in result["hypothetical_events"] if row["at"].startswith("2026-11-05"))
        self.assertEqual(changed["gross_per_unit"], "5.32109"); self.assertEqual(changed["tax_per_unit"], "0.432109")
        self.assertEqual(changed["published_at"], CHECKED)
        self.assertEqual(result["knowledge_not_before"], CHECKED)
        self.assertEqual(result["comparison"]["valuation_basis"], "same_original_checkpoint_quotes_and_fx_not_current_nav")
        for key in ("economic_correction_approved", "source_evidence_verified", "checkpoint_created", "monitoring_resumed", "historical_observations_rewritten", "trading_permission"):
            self.assertIs(result[key], False)
        self.assert_no_finance()

    def test_explicit_retain_is_zero_economic_delta_but_does_not_resolve_source_difference(self):
        request = self.prepare(); request["decisions"][0].update(choice="retain", events=[])
        result = self.compare(request)
        self.assertEqual(result["comparison"]["difference_cny"], "0"); self.assertFalse(result["comparison"]["economics_changed"])
        self.assertEqual(result["comparison"]["changed_action_count"], 0); self.assertFalse(result["source_evidence_verified"])
        self.assert_no_finance()

    def test_retained_two_source_cancellation_and_new_split_are_hypotheses_not_new_principal(self):
        for mode in ("cancel", "split"):
            with self.subTest(mode=mode):
                case = runtime.InvestorRuntimeTests(); case.setUp()
                try:
                    value = correction_case(case.db, case.path, mode=mode); before = list(case.db.iterdump())
                    if mode == "split":
                        implicit = deepcopy(value["request"]); del implicit["decisions"][0]["events"][-1]["ratio_direction"]
                        with self.assertRaises(WorkbenchError): compare_action_correction_impact(case.db, "w", OWNER, implicit, now=CHECKED)
                    result = compare_action_correction_impact(case.db, "w", OWNER, value["request"], now=CHECKED)
                    self.assertTrue(result["comparison"]["economics_changed"])
                    self.assertEqual(result["comparison"]["restated"]["initial_notional_cny"], "10000")
                    if mode == "cancel": self.assertLess(float(result["comparison"]["difference_cny"]), 0)
                    else:
                        from decimal import Decimal
                        old = result["comparison"]["original"]["quantities"]["synthetic-3141"]
                        new = result["comparison"]["restated"]["quantities"]["synthetic-3141"]
                        self.assertEqual(Decimal(new), Decimal(old) * 2)
                    self.assertEqual(before, list(case.db.iterdump())); case.assert_no_finance()
                finally: case.doCleanups()

    def test_genuinely_readonly_and_no_provider_calls_even_when_ordinary_monitor_is_not_current(self):
        self.prepare(); before = list(self.db.iterdump())
        with closing(open_database(self.path, read_only=True)) as reader:
            result = self.compare(db=reader); self.assertEqual(reader.total_changes, 0)
        self.assertEqual(result, self.compare()); self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_no_implicit_tax_times_amount_currency_or_consent_from_the_client(self):
        original = self.prepare(); before = list(self.db.iterdump())
        for mode in ("tax", "time", "gross", "knowledge", "currency", "ack", "extra_ack", "no_restatement", "cancel", "duplicate", "unrelated", "tax_negative", "tax_excess", "pay_day", "date", "blank"):
            request = deepcopy(original); decision = request["decisions"][0]; event = decision["events"][0]
            if mode == "tax": del event["tax_per_unit"]
            elif mode == "time": del event["at"]
            elif mode == "gross": event["gross_per_unit"] = "99999"
            elif mode == "knowledge": event["published_at"] = "2026-01-01T00:00:00Z"
            elif mode == "currency": event["currency"] = "HKD"
            elif mode == "ack": request["acknowledgements"]["hypothetical_only"] = False
            elif mode == "extra_ack": request["acknowledgements"]["trading_permission"] = True
            elif mode == "no_restatement": request["acknowledgements"] = {"no_historical_restatement": True}
            elif mode == "cancel": decision.update(choice="cancel", events=[])
            elif mode == "duplicate": request["decisions"].append(deepcopy(decision))
            elif mode == "unrelated": decision["date"] = "2026-11-04"
            elif mode == "tax_negative": event["tax_per_unit"] = "-1"
            elif mode == "tax_excess": event["tax_per_unit"] = "10000"
            elif mode == "pay_day": event["pay_at"] = "2026-11-10T21:00:00Z"
            elif mode == "date": event["at"] = "2026-11-04T14:30:00Z"
            else: decision["reason"] = "  "
            with self.subTest(mode=mode), self.assertRaises((ValueError, WorkbenchError)): self.compare(request)
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_preview_expiry_revision_owner_control_and_source_withdrawal_are_hard_stops(self):
        request = self.prepare(); before = list(self.db.iterdump())
        with self.assertRaises(WorkbenchError): self.compare(now="2026-11-07T06:15:04.001Z")
        changed = deepcopy(request); changed["expected_revision"] += 1
        with self.assertRaises(WorkbenchError): self.compare(changed)
        with patch("worker.investor.action_correction_impact.read_retained_monitor_history") as private:
            with self.assertRaises(WorkbenchError): compare_action_correction_impact(self.db, "w", "foreign", request, now=CHECKED)
            private.assert_not_called()
        self.assertEqual(before, list(self.db.iterdump()))
        managed_actions.set_authority_enabled(self.db, "w", OWNER, self.value["authority_id"], True, now=CHECKED)
        with self.assertRaises(WorkbenchError): self.compare()
        self.assert_no_finance()

    def test_stop_before_heavy_source_or_history_replay_and_actual_supplier_withdrawal(self):
        request = self.prepare(); before = list(self.db.iterdump())
        with self.assertRaises(WorkbenchError): compare_action_correction_impact(self.db, "w", OWNER, request, now=CHECKED, stop_requested=lambda: True)
        self.assertEqual(before, list(self.db.iterdump()))
        eodhd_sources.set_authority_enabled(self.db, "w", OWNER, self.value["member"]["eodhd_authority_id"], False, now=CHECKED)
        with self.assertRaises(WorkbenchError): self.compare()
        self.assert_no_finance()


if __name__ == "__main__": unittest.main()
