"""Invented review preparation only; never approve data, call a source or trade."""

from copy import deepcopy
import json
import sys
import unittest

from tests.investor import test_no_new_actions as fixtures
from tests.investor.fixtures import research_input
from worker.investor.reviewed_actions import check_reviewed_action_append
from worker.market.providers.eodhd_actions import action_window, parse_eodhd_actions
from worker.market.providers.vanguard_distributions import parse_vanguard_distributions
from worker.orchestration.db import WorkbenchError
from worker.research.snapshot import validate_dataset


AT = "2026-11-03T06:00:03.000Z"
FLOOR = "2026-11-03T06:00:03.001Z"
REVIEWED = "2026-11-03T06:00:03.002Z"


class ReviewedActionAppendTests(unittest.TestCase):
    def setUp(self):
        prior = fixtures.NoNewActionTests(); prior.setUp()
        self.old, self.previous = prior.base, prior.anchor
        self.old["range_end"] = "2026-10-31"
        self.current = fixtures.snapshot(AT, "2025-11-04", "2026-11-03")
        self.current["issuer"] = parse_vanguard_distributions(fixtures.archive(
            fixtures.row("987.1234", exDividendDate="2026-09-25", recordDate="2026-09-25", payableDate="2026-09-30"),
            fixtures.row("4.32109", exDividendDate="2026-11-02", recordDate="2026-11-02", payableDate="2026-11-09")),
            fund_id="3141", has_distribution_yield=False, retrieved_at=AT, start_date="2025-11-04", end_date="2026-11-03")
        start, end = action_window(AT)
        self.current["dividends"] = parse_eodhd_actions(fixtures.div_archive(
            fixtures.dividend("987.123", date="2026-09-25", recordDate="2026-09-25", paymentDate="2026-09-30"),
            fixtures.dividend("4.321", date="2026-11-02", recordDate="2026-11-02", paymentDate="2026-11-09")),
            kind="div", symbol="VT.US", start_date=start, end_date=end, retrieved_at=AT)
        self.new = deepcopy(self.old); self.new["range_end"] = "2026-11-02"
        self.new["events"].append({"id":"fictional-explicitly-reviewed-new-dividend", "listing_id":"synthetic-vt",
            "type":"dividend", "at":"2026-11-02T14:30:00Z", "published_at":FLOOR,
            "pay_at":"2026-11-09T21:00:00Z", "gross_per_unit":"4.32109", "tax_per_unit":"0.432109",
            "source_evidence":"synthetic://separately-reviewed-new-event"})

    def check(self):
        before = deepcopy((self.old, self.new, self.previous, self.current))
        value = check_reviewed_action_append(self.old, self.new, self.previous, self.current,
            symbol="VT.US", listing_id="synthetic-vt", knowledge_floor=FLOOR, reviewed_at=REVIEWED)
        self.assertEqual(before, (self.old, self.new, self.previous, self.current))
        for field in ("owner_approval_verified", "source_authority_verified", "handover_registered", "research_admitted", "trading_permission"):
            self.assertIs(value[field], False)
        for text in ("987.1234", "4.32109", "0.432109", self.old["tax_assumption"]):
            self.assertNotIn(text, json.dumps(value))
        return value

    def test_explicit_new_event_preserves_old_facts_and_only_prepares_a_successor(self):
        value = self.check()
        self.assertEqual(value["status"], "reviewed_append_prepared_only")
        self.assertEqual(value["added_event_count"], 1)
        self.assertEqual(value["added_dividend_count"], 1)
        self.assertEqual(value["added_split_count"], 0)
        self.assertEqual(value["previous_coverage_end"], "2026-10-31")
        self.assertEqual(value["new_coverage_end"], "2026-11-02")
        self.assertEqual(value["new_nominal_difference_count"], 1)
        self.assertEqual(value["late_knowledge_event_count"], 1)
        self.assertFalse(value["continuation_timing_ready"])
        self.assertTrue(value["requires_separate_knowledge_or_start"])

    def test_late_receipt_preparation_does_not_bypass_the_existing_dataset_causality_boundary(self):
        value=self.check();self.assertFalse(value["continuation_timing_ready"])
        data,_,_=research_input();event=deepcopy(self.new["events"][-1])
        event["listing_id"]=data["assets"][0]["listing_id"];data["actions"]=[event]
        with self.assertRaisesRegex(WorkbenchError,"CORPORATE_ACTION_NOT_KNOWN_AT_EVENT"):
            validate_dataset(data)

    def test_exact_new_provider_amount_does_not_need_a_precision_tolerance(self):
        self.current["dividends"]["records"][-1]["unadjusted_value"] = "4.32109"
        self.assertEqual(self.check()["new_nominal_difference_count"], 0)

    def test_explicit_new_split_keeps_ratio_direction_and_knowledge_uninferred(self):
        self.current["splits"]["records"].append({"date":"2026-11-02", "numerator":"3", "denominator":"2"})
        self.new["events"].append({"id":"fictional-reviewed-split", "listing_id":"synthetic-vt", "type":"split",
            "at":"2026-11-02T14:30:00Z", "published_at":FLOOR, "ratio":"1.5", "source_evidence":"synthetic://reviewed-direction"})
        self.assertEqual(self.check()["added_split_count"], 1)

    def test_tax_text_or_any_old_event_change_requires_separate_historical_review(self):
        for mutate in (lambda value:value.update(tax_assumption="Different tax rule"),
                lambda value:value["events"][0].update(tax_per_unit="0"),
                lambda value:value["events"][0].update(source_evidence="synthetic://different")):
            original=deepcopy(self.new);mutate(self.new)
            with self.assertRaisesRegex(WorkbenchError, "HISTORICAL_FACTS_CHANGED"):self.check()
            self.new=original

    def test_new_tax_amount_is_required_not_inferred_or_defaulted_to_zero(self):
        self.new["events"][-1].pop("tax_per_unit")
        with self.assertRaises(WorkbenchError):self.check()

    def test_new_event_cannot_retroactively_fill_a_previously_covered_date(self):
        self.new["events"][-1]["at"]="2026-10-30T13:30:00Z"
        with self.assertRaisesRegex(WorkbenchError, "HISTORICAL_CORRECTION_REQUIRED"):self.check()

    def test_old_source_correction_is_not_relabelled_a_new_event(self):
        for key,field,value in (("issuer","distribution_amount","987.1235"),("dividends","unadjusted_value","987.124")):
            original=deepcopy(self.current);self.current[key]["records"][0][field]=value
            with self.assertRaisesRegex(WorkbenchError, "HISTORICAL_SOURCE_CORRECTION_REQUIRED"):self.check()
            self.current=original

    def test_omitted_old_records_and_changed_old_optional_dates_stop(self):
        original=deepcopy(self.current);self.current["issuer"]["records"].pop(0)
        with self.assertRaisesRegex(WorkbenchError,"HISTORICAL_SOURCE_CORRECTION_REQUIRED"):self.check()
        self.current=original
        self.current["dividends"]["records"][0]["declaration_date"]="2026-09-19"
        with self.assertRaisesRegex(WorkbenchError, "HISTORICAL_SOURCE_CORRECTION_REQUIRED"):self.check()

    def test_added_gross_pay_date_and_split_ratio_must_exactly_match_reports(self):
        for field,value in (("gross_per_unit","4.321"),("pay_at","2026-11-10T21:00:00Z")):
            original=deepcopy(self.new);self.new["events"][-1][field]=value
            with self.assertRaises(WorkbenchError):self.check()
            self.new=original
        self.current["splits"]["records"].append({"date":"2026-11-02","numerator":"3","denominator":"2"})
        self.new["events"].append({"id":"fictional-wrong-ratio","listing_id":"synthetic-vt","type":"split",
            "at":"2026-11-02T14:30:00Z","published_at":FLOOR,"ratio":"1.6","source_evidence":"synthetic://wrong-direction"})
        with self.assertRaises(WorkbenchError):self.check()

    def test_reported_later_event_cannot_be_hidden_by_common_cutoff(self):
        self.current["issuer"]["records"].append(dict(self.current["issuer"]["records"][-1],ex_date="2026-11-03",derived_event_key="fictional-later"))
        with self.assertRaisesRegex(WorkbenchError, "REPORT_OUTSIDE_REVIEW_RANGE"):self.check()

    def test_current_frames_must_share_the_same_source_day(self):
        self.current["splits"]["source"]["retrieved_at"]="2026-11-04T06:00:03.000Z"
        with self.assertRaises(WorkbenchError):self.check()

    def test_invented_early_publication_is_not_accepted_as_actual_announcement_time(self):
        self.new["events"][-1]["published_at"]="2026-11-02T14:00:00Z"
        with self.assertRaisesRegex(WorkbenchError, "EARLIER_KNOWLEDGE_REQUIRES_EVIDENCE"):self.check()

    def test_knowledge_floor_cannot_precede_the_current_reports(self):
        with self.assertRaisesRegex(WorkbenchError, "KNOWLEDGE_FLOOR_INVALID"):
            check_reviewed_action_append(self.old,self.new,self.previous,self.current,symbol="VT.US",
                listing_id="synthetic-vt",knowledge_floor="2026-11-01T05:00:03.000Z",reviewed_at=REVIEWED)

    def test_caller_must_supply_exact_explicit_instants_not_an_implicit_wall_clock(self):
        for floor in (None, "2026-11-03", "2026-11-03T06:00:03.0010001Z"):
            with self.assertRaisesRegex(WorkbenchError, "KNOWLEDGE_FLOOR_INVALID"):
                check_reviewed_action_append(self.old,self.new,self.previous,self.current,symbol="VT.US",
                    listing_id="synthetic-vt",knowledge_floor=floor,reviewed_at=REVIEWED)

    def test_future_knowledge_and_review_before_reception_are_rejected(self):
        self.new["events"][-1]["published_at"]="2026-11-03T06:00:03.002001Z"
        with self.assertRaisesRegex(WorkbenchError,"KNOWLEDGE_AFTER_REVIEW"):self.check()
        with self.assertRaisesRegex(WorkbenchError,"REVIEW_PRECEDES_DATA"):
            check_reviewed_action_append(self.old,self.new,self.previous,self.current,symbol="VT.US",
                listing_id="synthetic-vt",knowledge_floor=FLOOR,reviewed_at=AT)

    def test_unknown_or_mixed_currency_is_not_just_a_nominal_difference(self):
        self.current["dividends"]["records"][-1]["reported_currency"]="HKD"
        with self.assertRaisesRegex(WorkbenchError,"CURRENT_REPORTS_REQUIRE_SEPARATE_REVIEW"):self.check()

    def test_window_cannot_omit_an_unreviewed_tail(self):
        self.current["splits"]["source"]["range_start"]="2026-11-02"
        with self.assertRaisesRegex(WorkbenchError,"HISTORY_WINDOW_GAP"):self.check()

    def test_old_rows_leaving_a_rolling_window_do_not_create_negative_new_differences(self):
        event=deepcopy(self.old["events"][0]);event.update(id="fictional-rolling-old",at="2025-11-02T14:30:00Z",
            published_at="2025-11-01T04:00:00Z",pay_at="2025-11-09T21:00:00Z")
        self.old["events"].append(event);self.new["events"].insert(1,deepcopy(event))
        self.previous["issuer"]["records"].append(dict(self.previous["issuer"]["records"][0],
            ex_date="2025-11-02",record_date="2025-11-02",pay_date="2025-11-09",derived_event_key="fictional-rolling-issuer"))
        self.previous["dividends"]["records"].append(dict(self.previous["dividends"]["records"][0],
            date="2025-11-02",record_date="2025-11-02",payment_date="2025-11-09",derived_event_key="fictional-rolling-provider"))
        self.assertEqual(self.check()["new_nominal_difference_count"],1)

    def test_no_new_events_remain_the_existing_no_new_action_rule_not_a_manual_successor(self):
        self.current=fixtures.snapshot(AT,"2025-11-04","2026-11-03")
        self.new=deepcopy(self.old);self.new["range_end"]="2026-11-02"
        with self.assertRaisesRegex(WorkbenchError, "MATERIAL_APPEND_REQUIRED"):self.check()

    def test_wrong_fund_symbol_or_record_kind_cannot_prepare_recovery(self):
        for kind,key,value in (("issuer","requested_fund_id","0928"),("dividends","requested_symbol","BND.US"),("splits","kind","div")):
            original=deepcopy(self.current);self.current[kind]["source"][key]=value
            with self.assertRaises(WorkbenchError):self.check()
            self.current=original

    def test_new_tax_amount_cannot_exceed_the_unrounded_gross(self):
        self.new["events"][-1]["tax_per_unit"]="4.32110"
        with self.assertRaisesRegex(WorkbenchError,"TAX_AMOUNT_INVALID"):self.check()

    def test_an_old_event_outside_its_own_coverage_cannot_hide_in_both_fact_sets(self):
        self.old["events"][0]["at"]="2027-01-01T14:30:00Z"
        self.new["events"][0]=deepcopy(self.old["events"][0])
        with self.assertRaisesRegex(WorkbenchError,"FACT_EVENT_OUTSIDE_REVIEW_RANGE"):self.check()

    def test_cash_payment_cannot_precede_the_claimed_entitlement_instant(self):
        self.new["events"][-1]["pay_at"]="2026-11-02T13:00:00Z"
        with self.assertRaisesRegex(WorkbenchError,"PAYMENT_PRECEDES_ENTITLEMENT"):self.check()

    def test_reused_old_event_id_and_submicrosecond_source_time_are_rejected(self):
        self.new["events"][-1]["id"]=self.old["events"][0]["id"]
        with self.assertRaisesRegex(WorkbenchError,"DUPLICATE_EVENT_ID"):self.check()
        self.new["events"][-1]["id"]="fictional-unique-new-id"
        self.current["issuer"]["source"]["retrieved_at"]="2026-11-03T06:00:03.0000001Z"
        with self.assertRaisesRegex(WorkbenchError,"SOURCE_TIME_INVALID"):self.check()


if __name__ == "__main__":
    if sys.argv[1:] == ["--contract"]:
        case=ReviewedActionAppendTests();case.setUp();print(json.dumps(case.check()))
    else:
        unittest.main()
