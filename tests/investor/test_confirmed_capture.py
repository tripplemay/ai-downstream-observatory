"""Fictional read/persist/purge, no provider, broker or gateway call."""

from hashlib import sha256
from io import StringIO
import json
import unittest
from unittest.mock import Mock, patch

from tests.investor import test_runtime as queue
from tests.investor.confirmed_capture_fixture import DAY, EXPIRY, NOW, REVIEWED, FictionalReceiver, inputs, sources, stub_official
from worker.investor import confirmed_capture as captures, data_pipeline
from worker.investor.data_evidence import review_source
from worker.investor.source_retention import purge_due_source_payloads
from worker.market.providers import longport, longport_confirmed as receiver
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, open_database
from worker.orchestration.runtime import run_pending_once


class ConfirmedCaptureTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance

    def refs(self, markets=("CN",)):
        return [sources(self.db, market=market, identity="fictional-" + market, label=market) for market in markets]

    def collect(self, refs=None, mock=None, **kwargs):
        return captures.collect_confirmed_prices(self.db, "w", "synthetic-investor", inputs(self.refs() if refs is None else refs),
            watch_seconds=1, now=NOW, test_receiver=mock or FictionalReceiver(), **kwargs)

    def count(self, name):
        return self.db.execute("SELECT count(*) FROM " + name).fetchone()[0]

    def assert_no_capture(self):
        for name in ("investor_confirmed_captures", "investor_confirmed_targets", "investor_confirmed_payloads", "investor_confirmed_purges"):
            self.assertEqual(self.count(name), 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_store_confirmed_capture'").fetchone()[0], 0)
        self.assert_no_finance()

    def test_three_markets_same_day_half_day_decimal_and_private_receipts(self):
        row = self.collect(self.refs(("CN", "HK", "US")))
        before = self.db.total_changes
        value = captures.resolve_confirmed_capture(self.db, "w", row["id"], now=NOW, allow_synthetic=True)
        self.assertEqual(self.db.total_changes, before)
        self.assertEqual(row["qualification"], captures.SYNTHETIC)
        self.assertEqual(row["status"], "complete")
        self.assertEqual(len(value["records"]), 3)
        self.assertEqual({record["value"] for record in value["records"]}, {"11.250000000000000001"})
        self.assertEqual({record["observed_at"] for record in value["records"]}, {DAY})
        self.assertEqual(self.count("investor_confirmed_targets"), 3)
        self.assertEqual(self.count("investor_price_captures"), 0)
        self.assertNotIn("records", value["receipt"])
        self.assertFalse(value["receipt"]["live_advice_eligible"])
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], 0)
        self.assertEqual(self.count("job_runs"), 0); self.assertEqual(self.count("outbox"), 0)
        self.assert_no_finance()

    def test_partial_and_no_events_are_replayed_not_promoted_from_response_status(self):
        refs = self.refs(("CN", "HK", "US"))
        for bars, status in ((1, "partial"), (0, "no_confirmed_events")):
            row = self.collect(refs, FictionalReceiver(bars=bars))
            self.assertEqual(row["status"], status)
            value = captures.resolve_confirmed_capture(self.db, "w", row["id"], now=NOW, allow_synthetic=True)
            self.assertEqual(len(value["records"]), bars)

    def test_production_path_is_stubbed_and_default_synthetic_reads_are_forbidden(self):
        refs = self.refs(); row = self.collect(refs)
        with self.assertRaisesRegex(WorkbenchError, "SYNTHETIC_CAPTURE_FORBIDDEN"):
            captures.resolve_confirmed_capture(self.db, "w", row["id"], now=NOW)
        official = stub_official(self.db, refs)
        self.assertEqual(official["qualification"], captures.OFFICIAL)
        self.assertEqual(len(captures.resolve_confirmed_capture(self.db, "w", official["id"], now=NOW)["records"]), 1)

    def test_clock_injection_mixed_credentials_scope_and_extras_fail_before_sdk(self):
        refs = self.refs(); spec = inputs(refs)
        with patch.object(receiver, "collect_confirmed_days") as sdk, patch.object(longport, "_credentials") as secrets:
            for kwargs in ({"now": NOW}, {"test_receiver": FictionalReceiver(), "credentials_file": "/fictional/no-secret"}):
                with self.assertRaises(WorkbenchError):
                    captures.collect_confirmed_prices(self.db, "w", "synthetic-investor", spec, **kwargs)
            for changed in ([{**spec[0], "endpoint": "https://fixture.invalid"}], spec * 33):
                with self.assertRaises(WorkbenchError):
                    captures.collect_confirmed_prices(self.db, "w", "synthetic-investor", changed)
            with self.assertRaises(WorkbenchError):
                captures.collect_confirmed_prices(self.db, "w", "foreign", spec)
            sdk.assert_not_called(); secrets.assert_not_called()
        self.assert_no_capture()

    def test_restricted_uses_prevent_transport_and_capture(self):
        refs = self.refs(); old = refs[0][0]; facts = json.loads(old["document_json"])["facts"]
        facts["uses"].remove("private_backup")
        new = review_source(self.db, "w", "synthetic-investor", old["source_id"], "approved", facts, "Fictional restricted use", EXPIRY, now=NOW)
        mock = FictionalReceiver()
        with self.assertRaisesRegex(WorkbenchError, "USE_NOT_GRANTED"):
            self.collect([(new, *refs[0][1:])], mock)
        self.assertEqual(mock.calls, 0); self.assert_no_capture()

    def test_calendar_closed_too_early_and_duplicate_scope_prevent_transport(self):
        refs = self.refs(); mock = FictionalReceiver()
        for change in (lambda values: values.append(values[0]), lambda values: values[0].update(session_date="2026-01-03")):
            spec = inputs(refs); change(spec)
            with self.assertRaises(WorkbenchError):
                captures.collect_confirmed_prices(self.db, "w", "synthetic-investor", spec, now=NOW, test_receiver=mock, watch_seconds=1)
        old = refs[0][2]; facts = json.loads(old["document_json"])["facts"]
        facts["days"][0].update(kind="closed", close_at=None, available_at=None, settled_at=None, settlement_rule_known_at=None)
        new = review_source(self.db, "w", "synthetic-investor", old["source_id"], "approved", facts, "Fictional closed day", EXPIRY, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "SESSION_CLOSED"):
            self.collect([(*refs[0][:2], new)], mock)
        self.assertEqual(mock.calls, 0); self.assert_no_capture()

    def test_reviewed_close_outside_watch_startup_window_fails_before_io(self):
        refs = self.refs(("US",)); mock = FictionalReceiver(now=REVIEWED)
        with self.assertRaisesRegex(WorkbenchError, "WINDOW_TOO_EARLY"):
            captures.collect_confirmed_prices(self.db, "w", "synthetic-investor", inputs(refs),
                watch_seconds=1, now=REVIEWED, test_receiver=mock)
        self.assertEqual(mock.calls, 0); self.assert_no_capture()

    def test_same_market_targets_use_distinct_symbols_and_shortest_rights_deadline(self):
        first = self.refs()[0]
        second = sources(self.db, identity="fictional-second-CN", label="second", symbol="501998.SH")
        facts = json.loads(second[0]["document_json"])["facts"]; facts["retention_days"] = 2
        review = review_source(self.db, "w", "synthetic-investor", second[0]["source_id"], "approved", facts,
            "Fictional shorter retention", "2026-01-03T22:00:03.000Z", now=REVIEWED)
        row = self.collect([first, (review, *second[1:])])
        self.assertEqual(row["retain_until"], "2026-01-03T22:00:03.000Z")
        value = captures.resolve_confirmed_capture(self.db, "w", row["id"], now=NOW, allow_synthetic=True)
        self.assertEqual(len(value["records"]), 2); self.assert_no_finance()

    def test_caller_input_mutation_during_io_does_not_change_frozen_bindings(self):
        refs = self.refs(); spec = inputs(refs)
        def mutate():
            spec[0].update(session_date="2026-01-03", listing_review_id="unrelated")
            spec.append(dict(spec[0]))
        row = captures.collect_confirmed_prices(self.db, "w", "synthetic-investor", spec, watch_seconds=1,
            now=NOW, test_receiver=FictionalReceiver(during=mutate))
        value = captures.resolve_confirmed_capture(self.db, "w", row["id"], now=NOW, allow_synthetic=True)
        self.assertEqual(value["records"][0]["observed_at"], DAY)
        self.assertEqual(len(value["receipt"]["bindings"]), 1); self.assert_no_finance()

    def test_full_source_audit_is_rechecked_after_io(self):
        refs = self.refs(); audit_id = refs[0][0]["audit_id"]
        def corrupt():
            self.db.execute("DROP TRIGGER audit_events_no_update")
            self.db.execute("UPDATE audit_events SET payload_json='{}' WHERE id=?", (audit_id,))
        with self.assertRaises(WorkbenchError):
            self.collect(refs, FictionalReceiver(during=corrupt))
        self.assert_no_capture()

    def test_grant_expiry_during_io_prevents_commit_using_real_clock_path(self):
        refs = self.refs(); facts = json.loads(refs[0][0]["document_json"])["facts"]
        facts["valid_until"] = "2026-01-02T22:00:04.000Z"
        review = review_source(self.db, "w", "synthetic-investor", refs[0][0]["source_id"], "approved", facts,
            "Fictional short grant", EXPIRY, now=REVIEWED)
        time = [NOW]
        mock = FictionalReceiver(during=lambda: time.__setitem__(0, "2026-01-02T22:00:04.000Z"))
        original_millis, original_instant = captures._milliseconds, captures.instant
        with patch.object(receiver, "collect_confirmed_days", side_effect=lambda request, **kwargs: mock(request, kwargs["stop_requested"])), \
                patch.object(captures, "_milliseconds", side_effect=lambda value=None: original_millis(time[0] if value is None else value)), \
                patch.object(captures, "instant", side_effect=lambda value=None: original_instant(time[0] if value is None else value)):
            with self.assertRaisesRegex(WorkbenchError, "CHANGED_DURING_COLLECTION"):
                captures.collect_confirmed_prices(self.db, "w", "synthetic-investor", inputs([(review, *refs[0][1:])]), watch_seconds=1)
        self.assertEqual(mock.calls, 1); self.assert_no_capture()

    def test_withdrawal_in_flight_cannot_commit_old_sources(self):
        refs = self.refs(); old = refs[0][0]
        def withdraw():
            review_source(self.db, "w", "synthetic-investor", old["source_id"], "withdrawn", None, "Fictional in-flight withdrawal", EXPIRY, now=NOW)
        mock = FictionalReceiver(during=withdraw)
        with self.assertRaisesRegex(WorkbenchError, "CHANGED_DURING_COLLECTION"):
            self.collect(refs, mock)
        self.assertEqual(mock.calls, 1); self.assert_no_capture()

    def test_restore_lock_or_readonly_during_io_cannot_commit_and_does_not_hold_write_lock(self):
        refs = self.refs()
        other = open_database(self.path); self.addCleanup(other.close)
        def lock():
            self.assertFalse(self.db.in_transaction)
            other.execute("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('fictional-other-write','fixture','fixture','fixture','fixture','{}',?)", (NOW,))
            (self.path.parent / "RESTORE_PENDING_REVIEW").write_text("Fictional restore marker")
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            self.collect(refs, FictionalReceiver(during=lock))
        (self.path.parent / "RESTORE_PENDING_REVIEW").unlink()
        with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}):
            with self.assertRaisesRegex(WorkbenchError, "READ_ONLY"):
                self.collect(refs)
        self.assert_no_capture()

    def test_stop_before_io_and_before_commit_and_bad_protocol_leave_no_capture(self):
        refs = self.refs()
        mock = FictionalReceiver()
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            self.collect(refs, mock, stop_requested=lambda: True)
        self.assertEqual(mock.calls, 0)
        with self.assertRaisesRegex(WorkbenchError, "CHILD_RESPONSE_INVALID"):
            self.collect(refs, FictionalReceiver(malformed=True))
        # Initial guard, fake receiver guard, post-I/O guard, prewrite check,
        # postwrite check. A late stop rolls back audit/header/targets/BLOB.
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            self.collect(refs, stop_requested=Mock(side_effect=[False] * 4 + [True]))
        self.assert_no_capture()

    def test_late_payload_failure_rolls_back_header_targets_and_audit(self):
        refs = self.refs()
        self.db.execute("CREATE TRIGGER fictional_confirmed_failure BEFORE INSERT ON investor_confirmed_payloads BEGIN SELECT RAISE(ABORT,'fictional late failure'); END")
        with self.assertRaisesRegex(Exception, "fictional late failure"):
            self.collect(refs)
        self.assert_no_capture()

    def test_metadata_only_relabel_cannot_make_synthetic_payload_official(self):
        row = self.collect(); receipt = json.loads(row["receipt_json"]); receipt["qualification"] = captures.OFFICIAL
        self.db.execute("DROP TRIGGER investor_confirmed_capture_no_update"); self.db.execute("DROP TRIGGER audit_events_no_update")
        digest = content_hash(receipt)
        self.db.execute("UPDATE investor_confirmed_captures SET qualification=?,receipt_json=?,receipt_hash=? WHERE id=?", (captures.OFFICIAL, canonical_json(receipt), digest, row["id"]))
        self.db.execute("UPDATE audit_events SET payload_json=? WHERE id=?", (canonical_json({"content_hash": digest}), row["audit_id"]))
        with self.assertRaises(WorkbenchError):
            captures.resolve_confirmed_capture(self.db, "w", row["id"], now=NOW)

    def test_foreign_scope_bad_payload_audit_and_future_clock_fail_closed(self):
        row = self.collect()
        for workspace, at in (("foreign", NOW), ("w", REVIEWED)):
            with self.assertRaises(WorkbenchError):
                captures.resolve_confirmed_capture(self.db, workspace, row["id"], now=at, allow_synthetic=True)
        self.db.execute("DROP TRIGGER investor_confirmed_payload_no_update")
        self.db.execute("UPDATE investor_confirmed_payloads SET projection=?", (b"{}",))
        with self.assertRaises(WorkbenchError):
            captures.resolve_confirmed_capture(self.db, "w", row["id"], now=NOW, allow_synthetic=True)

    def test_resealed_confirmation_or_extra_fields_fail_payload_replay(self):
        row = self.collect(); original = bytes(self.db.execute("SELECT projection FROM investor_confirmed_payloads").fetchone()[0])
        self.db.execute("DROP TRIGGER investor_confirmed_payload_no_update"); self.db.execute("DROP TRIGGER investor_confirmed_capture_no_update")
        self.db.execute("DROP TRIGGER audit_events_no_update")
        for flag in (False, 1):
            value = json.loads(original); projection = value["frames"][1]["projection"]; projection["source"]["is_confirmed"] = flag
            value["frames"][1]["sha256"] = content_hash(projection)
            raw = canonical_json(value).encode(); receipt = json.loads(row["receipt_json"]); receipt["payload_sha256"] = sha256(raw).hexdigest()
            digest = content_hash(receipt)
            self.db.execute("UPDATE investor_confirmed_payloads SET projection=?", (raw,))
            self.db.execute("UPDATE investor_confirmed_captures SET payload_sha256=?,receipt_json=?,receipt_hash=? WHERE id=?", (receipt["payload_sha256"], canonical_json(receipt), digest, row["id"]))
            self.db.execute("UPDATE audit_events SET payload_json=? WHERE id=?", (canonical_json({"content_hash": digest}), row["audit_id"]))
            with self.assertRaises(WorkbenchError):
                captures.resolve_confirmed_capture(self.db, "w", row["id"], now=NOW, allow_synthetic=True)

    def test_latest_review_expiry_and_payload_purge_prevent_old_reads(self):
        refs = self.refs(); row = self.collect(refs)
        with self.assertRaisesRegex(WorkbenchError, "RETENTION_EXPIRED"):
            captures.resolve_confirmed_capture(self.db, "w", row["id"], now=row["retain_until"], allow_synthetic=True)
        review_source(self.db, "w", "synthetic-investor", refs[0][2]["source_id"], "withdrawn", None, "Fictional calendar withdrawal", EXPIRY, now=NOW)
        with self.assertRaises(WorkbenchError):
            captures.resolve_confirmed_capture(self.db, "w", row["id"], now=NOW, allow_synthetic=True)
        with self.assertRaisesRegex(WorkbenchError, "PURGE_NOT_DUE"):
            captures.purge_confirmed_payload(self.db, "w", "synthetic-investor", row["id"], now=NOW)

    def test_core_cleans_rights_withdrawal_and_keeps_immutable_receipt_without_finance(self):
        refs = self.refs(); row = self.collect(refs)
        with self.assertRaisesRegex(WorkbenchError, "PURGE_NOT_DUE"):
            captures.purge_confirmed_payload(self.db, "w", "synthetic-investor", row["id"], now=NOW)
        review_source(self.db, "w", "synthetic-investor", refs[0][0]["source_id"], "withdrawn", None, "Fictional withdrawal", EXPIRY, now=NOW)
        self.assertIsNone(run_pending_once(self.db, "fictional-core", clock=lambda: NOW))
        self.assertEqual(self.count("investor_confirmed_payloads"), 0)
        purge = self.db.execute("SELECT * FROM investor_confirmed_purges").fetchone()
        self.assertEqual(purge["reason"], "rights_no_longer_active")
        self.assertEqual(dict(self.db.execute("SELECT * FROM investor_confirmed_captures").fetchone()), row)
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], 0)
        self.assert_no_finance()

    def test_expiry_purge_is_audited_idempotent_cross_connection_and_cannot_restore(self):
        row = self.collect(); payload = bytes(self.db.execute("SELECT projection FROM investor_confirmed_payloads").fetchone()[0])
        other = open_database(self.path); self.addCleanup(other.close)
        values = purge_due_source_payloads(self.db, now=row["retain_until"], limit=1)
        self.assertEqual(len(values), 1); self.assertEqual(values[0]["reason"], "retention_expired")
        before = other.total_changes
        self.assertEqual(captures.purge_confirmed_payload(other, "w", "synthetic-investor", row["id"], now=row["retain_until"]), values[0])
        self.assertEqual(other.total_changes, before)
        with self.assertRaisesRegex(Exception, "cannot be replaced"):
            self.db.execute("INSERT INTO investor_confirmed_payloads VALUES(?,?)", (row["id"], payload))
        with self.assertRaises(WorkbenchError):
            captures.purge_confirmed_payload(self.db, "w", "synthetic-investor", row["id"], now=NOW)

    def test_invalid_future_or_corrupt_withdrawal_is_not_a_deletion_authority(self):
        refs = self.refs(); row = self.collect(refs)
        later = "2026-01-03T22:00:03.000Z"
        new = review_source(self.db, "w", "synthetic-investor", refs[0][0]["source_id"], "withdrawn", None, "Fictional later withdrawal", EXPIRY, now=later)
        with self.assertRaisesRegex(WorkbenchError, "INVALID_CLOCK"):
            captures.purge_confirmed_payload(self.db, "w", "synthetic-investor", row["id"], now=NOW)
        self.db.execute("DROP TRIGGER investor_data_review_no_update")
        self.db.execute("UPDATE investor_data_reviews SET document_json=json_set(document_json,'$.reason','Fictional unaudited mutation') WHERE id=?", (new["id"],))
        with self.assertRaises(WorkbenchError):
            purge_due_source_payloads(self.db, now=later)
        self.assertEqual(self.count("investor_confirmed_payloads"), 1)

    def test_purge_late_delete_failure_rolls_back_receipt_and_audit(self):
        row = self.collect()
        self.db.execute("CREATE TRIGGER fictional_delete_failure BEFORE DELETE ON investor_confirmed_payloads BEGIN SELECT RAISE(ABORT,'fictional delete failure'); END")
        with self.assertRaisesRegex(Exception, "fictional delete failure"):
            captures.purge_confirmed_payload(self.db, "w", "synthetic-investor", row["id"], now=row["retain_until"])
        self.assertEqual(self.count("investor_confirmed_purges"), 0)
        self.assertEqual(self.count("investor_confirmed_payloads"), 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_purge_confirmed_payload'").fetchone()[0], 0)

    def test_cleanup_never_replays_price_blob_and_idempotency_rechecks_purge_audit(self):
        row = self.collect()
        with patch.object(receiver, "parse_confirmed_watch", side_effect=AssertionError("Cleanup must not replay quotes")):
            purge = captures.purge_confirmed_payload(self.db, "w", "synthetic-investor", row["id"], now=row["retain_until"])
            self.assertEqual(captures.purge_confirmed_payload(self.db, "w", "synthetic-investor", row["id"], now=row["retain_until"]), purge)
        self.db.execute("DROP TRIGGER audit_events_no_update")
        self.db.execute("UPDATE audit_events SET payload_json='{}' WHERE id=?", (purge["audit_id"],))
        with self.assertRaises(WorkbenchError):
            captures.purge_confirmed_payload(self.db, "w", "synthetic-investor", row["id"], now=row["retain_until"])

    def test_purge_marker_prevents_read_even_if_illicit_payload_remains(self):
        refs = self.refs(); row = self.collect(refs)
        payload = bytes(self.db.execute("SELECT projection FROM investor_confirmed_payloads").fetchone()[0])
        review_source(self.db, "w", "synthetic-investor", refs[0][0]["source_id"], "withdrawn", None, "Fictional withdrawal", EXPIRY, now=NOW)
        captures.purge_confirmed_payload(self.db, "w", "synthetic-investor", row["id"], now=NOW)
        self.db.execute("DROP TRIGGER investor_confirmed_payload_insert")
        self.db.execute("INSERT INTO investor_confirmed_payloads VALUES(?,?)", (row["id"], payload))
        with self.assertRaisesRegex(WorkbenchError, "PAYLOAD_PURGED"):
            captures.resolve_confirmed_capture(self.db, "w", row["id"], now=NOW, allow_synthetic=True)
        with self.assertRaises(WorkbenchError):
            captures.purge_confirmed_payload(self.db, "w", "synthetic-investor", row["id"], now=NOW)

    def test_cli_private_collect_and_check_output_only_metadata(self):
        refs = self.refs(); document = {"targets": inputs(refs), "watch_seconds": 1}
        filename = self.path.parent / "fictional-input.json"; filename.write_text(canonical_json(document)); filename.chmod(0o600)
        self.path.chmod(0o600)
        base = ["--db", str(self.path), "--workspace", "w", "--actor", "synthetic-investor"]
        with patch.object(data_pipeline, "collect_confirmed_prices", side_effect=lambda db, workspace, actor, targets, **kwargs: stub_official(db, refs)) as sdk:
            output = StringIO()
            with patch("sys.stdout", output):
                self.assertEqual(data_pipeline.main(base + ["collect-confirmed-prices", "--file", str(filename), "--credentials-file", "/fictional/never-opened"]), 0)
            value = json.loads(output.getvalue()); self.assertEqual(value["status"], "complete")
            self.assertFalse(value["market_values_output"]); self.assertFalse(value["monitor_queue_updated"])
            self.assertNotIn("records", value); self.assertNotIn("targets", value)
            self.assertEqual(sdk.call_args.args[3], document["targets"])
            self.assertEqual(sdk.call_args.kwargs, {"watch_seconds": 1, "credentials_file": "/fictional/never-opened"})
        original = captures._milliseconds
        with patch.object(captures, "_milliseconds", side_effect=lambda value=None: original(NOW if value is None else value)), patch("sys.stdout", StringIO()) as output:
            self.assertEqual(data_pipeline.main(base + ["check-confirmed-capture", "--capture", value["capture_id"]]), 0)
            checked = json.loads(output.getvalue()); self.assertEqual(checked["record_count"], 1)
            self.assertFalse(checked["market_values_output"]); self.assertNotIn("records", checked)
        self.assert_no_finance()

    def test_cli_rejects_public_or_extra_input_and_redacts_transport_errors(self):
        self.path.chmod(0o600)
        filename = self.path.parent / "fictional-input.json"; filename.write_text(canonical_json({"targets": [], "watch_seconds": 1})); filename.chmod(0o644)
        base = ["--db", str(self.path), "--workspace", "w", "--actor", "synthetic-investor", "collect-confirmed-prices", "--file", str(filename), "--credentials-file", "/fictional/never-opened"]
        with patch.object(data_pipeline, "collect_confirmed_prices") as sdk, patch("sys.stderr", StringIO()) as error:
            self.assertEqual(data_pipeline.main(base), 1); self.assertEqual(json.loads(error.getvalue())["error"], "INVESTOR_DATA_PRIVATE_FILE_REQUIRED")
            sdk.assert_not_called()
        filename.chmod(0o600); filename.write_text(canonical_json({"targets": [], "watch_seconds": 1, "endpoint": "fictional"}))
        with patch.object(data_pipeline, "collect_confirmed_prices") as sdk, patch("sys.stderr", StringIO()):
            self.assertEqual(data_pipeline.main(base), 1); sdk.assert_not_called()
        filename.write_text(canonical_json({"targets": [], "watch_seconds": 1}))
        with patch.object(data_pipeline, "collect_confirmed_prices", side_effect=RuntimeError("FICTIONAL_SECRET_MARKER")), patch("sys.stderr", StringIO()) as error:
            self.assertEqual(data_pipeline.main(base), 1); self.assertEqual(json.loads(error.getvalue()), {"error": "INVESTOR_DATA_PIPELINE_FAILED"})
            self.assertNotIn("FICTIONAL_SECRET_MARKER", error.getvalue())
        self.assert_no_capture()

    def test_payload_and_normalized_targets_remain_immutable(self):
        row = self.collect()
        for name in ("investor_confirmed_captures", "investor_confirmed_targets", "investor_confirmed_payloads"):
            with self.assertRaisesRegex(Exception, "immutable|purge record"):
                self.db.execute("DELETE FROM " + name)
        with self.assertRaisesRegex(Exception, "immutable"):
            self.db.execute("UPDATE investor_confirmed_targets SET listing_id='foreign'")
        stored = dict(self.db.execute("SELECT * FROM investor_confirmed_targets").fetchone())
        with self.assertRaises(Exception):
            self.db.execute("INSERT OR REPLACE INTO investor_confirmed_targets VALUES(?,?,?,?,?,?)", tuple(stored.values()))


if __name__ == "__main__":
    unittest.main()
