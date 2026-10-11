"""Prepared historical bytes and atomic commit; invented data, no network."""

from contextlib import ExitStack
import json
import unittest
from unittest.mock import patch

from tests.investor import test_data_evidence as evidence
from worker.investor import data_evidence
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, instant, open_database, stamp
from worker.orchestration.jobs import enqueue_notification

NOW, START, END = evidence.NOW, evidence.START, evidence.END


class PreparedPriceTests(unittest.TestCase):
    setUp = evidence.InvestorDataTests.setUp
    review = evidence.InvestorDataTests.review
    prepare = evidence.InvestorDataTests.prepare
    assert_no_finance = evidence.InvestorDataTests.assert_no_finance

    def injected(self, refs, **kwargs):
        with patch.object(longport, "stamp", side_effect=lambda value=None: NOW if value is None else stamp(value)):
            return data_evidence.prepare_prices(self.db, "w", "synthetic-investor", *(row["id"] for row in refs[:3]),
                START, END, now=NOW, client=evidence.FictionalClient(), sdk_version=longport.SDK_VERSION, **kwargs)

    def formal(self, refs, mutate=None, during=None):
        def collect(request):
            if during: during()
            result = longport._normalize(evidence.FictionalClient().history_candlesticks_by_date("fictional"), request=request,
                sdk_version=longport.SDK_VERSION, call_started_at=NOW, call_returned_at=NOW,
                datetime_basis="runtime_utc_from_unix_timestamp", collector_runtime="isolated_official_sdk")
            if mutate: mutate(result, request)
            return result
        stack = ExitStack()
        stack.enter_context(patch.object(longport, "_collect_isolated", side_effect=collect))
        stack.enter_context(patch.object(data_evidence, "_milliseconds", side_effect=lambda value=None: NOW if value is None else value))
        stack.enter_context(patch.object(data_evidence, "instant", side_effect=lambda value=None: instant(NOW if value is None else value)))
        return stack

    def test_prepare_is_read_only_and_connection_bound_then_injected_commit_stays_synthetic(self):
        refs = self.prepare(); before = self.db.total_changes; persist = self.injected(refs)
        self.assertEqual(self.db.total_changes, before)
        other = open_database(self.path); self.addCleanup(other.close)
        with self.assertRaisesRegex(WorkbenchError, "PREPARED_CONNECTION_CHANGED"): persist(other)
        self.assertEqual(self.db.total_changes, before)
        capture = persist(self.db)
        self.assertEqual(capture["qualification"], "injected_test_client")
        with self.assertRaisesRegex(WorkbenchError, "SYNTHETIC_CAPTURE_FORBIDDEN"):
            data_evidence.resolve_capture(self.db, "w", capture["id"], now=NOW)
        self.assert_no_finance()

    def test_formal_bytes_not_mutable_result_records_define_receipt(self):
        refs = self.prepare(); saved = {}
        def mutate(result, request):
            result["records"] = [{"listing_id": "foreign", "value": "999999"}]
            saved["result"] = result
        with self.formal(refs, mutate=mutate):
            persist = data_evidence.prepare_prices(self.db, "w", "synthetic-investor", *(row["id"] for row in refs[:3]), START, END)
            saved["result"]["source"]["sdk_version"] = "changed-after-prepare"
            capture = persist(self.db)
        resolved = data_evidence.resolve_capture(self.db, "w", capture["id"], now=NOW)
        self.assertEqual({row["value"] for row in resolved["records"]}, {"11.25"})
        self.assertEqual(json.loads(capture["receipt_json"])["source"]["sdk_version"], longport.SDK_VERSION)
        self.assert_no_finance()

    def test_changed_request_during_transport_rejected_before_any_capture(self):
        refs = self.prepare()
        def mutate(result, request):
            request["mapping"]["listing_id"] = "foreign"
            result["projection_bytes"] = longport._normalize(evidence.FictionalClient().history_candlesticks_by_date("fictional"), request=request,
                sdk_version=longport.SDK_VERSION, call_started_at=NOW, call_returned_at=NOW,
                datetime_basis="runtime_utc_from_unix_timestamp", collector_runtime="isolated_official_sdk")["projection_bytes"]
            from hashlib import sha256
            result["projection_sha256"] = sha256(result["projection_bytes"]).hexdigest()
        with self.formal(refs, mutate=mutate), self.assertRaises(WorkbenchError):
            data_evidence.prepare_prices(self.db, "w", "synthetic-investor", *(row["id"] for row in refs[:3]), START, END)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], 0)

    def test_withdrawal_after_prepare_prevents_commit(self):
        refs = self.prepare(); persist = self.injected(refs)
        data_evidence.review_source(self.db, "w", "synthetic-investor", refs[0]["source_id"], "withdrawn", None,
            "Fictional withdrawal", evidence.EXPIRY, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "SUPERSEDED"): persist(self.db)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_payloads").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], 0)

    def test_overlapping_prepare_race_is_rechecked_at_commit(self):
        refs = self.prepare()
        first = self.injected(refs, prevent_retained_overlap=True)
        second = self.injected(refs, prevent_retained_overlap=True)
        first(self.db)
        with self.assertRaisesRegex(WorkbenchError, "WINDOWS_CONFLICT"): second(self.db)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], 1)

    def test_late_payload_failure_rolls_back_receipt(self):
        refs = self.prepare(); persist = self.injected(refs)
        self.db.execute("CREATE TRIGGER fictional_payload_abort BEFORE INSERT ON investor_price_payloads BEGIN SELECT RAISE(ABORT,'fictional abort'); END")
        with self.assertRaisesRegex(Exception, "fictional abort"): persist(self.db)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], 0)
        self.assert_no_finance()

    def test_transport_does_not_hold_database_write_lock(self):
        refs = self.prepare(); other = open_database(self.path); self.addCleanup(other.close)
        def during(): enqueue_notification(other, "fictional-concurrent", "fictional", {}, now=NOW)
        with self.formal(refs, during=during):
            persist = data_evidence.prepare_prices(self.db, "w", "synthetic-investor", *(row["id"] for row in refs[:3]), START, END)
            self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], 0)
            self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='fictional'").fetchone()[0], 1)
            persist(self.db)

    def test_read_only_restore_and_caller_clock_reject_before_sdk(self):
        refs = self.prepare(); arguments = (self.db, "w", "synthetic-investor", *(row["id"] for row in refs[:3]), START, END)
        with patch.object(longport, "_collect_isolated") as sdk:
            with self.assertRaisesRegex(WorkbenchError, "CLOCK_NOT_CALLER_CONTROLLED"):
                data_evidence.prepare_prices(*arguments, now=NOW)
            with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}), self.assertRaisesRegex(WorkbenchError, "WORKBENCH_READ_ONLY"):
                data_evidence.prepare_prices(*arguments)
            marker = self.path.parent / "RESTORE_PENDING_REVIEW"; marker.touch()
            with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"): data_evidence.prepare_prices(*arguments)
            marker.unlink(); sdk.assert_not_called()


if __name__ == "__main__": unittest.main()
