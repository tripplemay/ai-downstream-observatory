"""Fictional issuer authority, idempotent capture, dedup and permission cleanup."""

from copy import deepcopy
from hashlib import sha256
import json
import sqlite3
import unittest
from unittest.mock import patch

from tests.investor import test_runtime as queue
from tests.market.test_vanguard_distributions import archive
from worker.investor import issuer_sources as sources
from worker.investor.source_retention import purge_due_source_payloads
from worker.market.providers import vanguard_capture as receiver
from worker.market.providers.vanguard_distributions import distribution_url, parse_vanguard_distributions
from worker.orchestration.db import WorkbenchError, content_hash, open_database
from worker.orchestration.runtime import run_pending_once


NOW = "2026-01-03T12:00:03.000Z"
LATER = "2026-01-04T12:00:03.000Z"
END = "2026-01-02"
START = "2025-01-01"


def policy(**changes):
    return {"schema_version": "investor-issuer-authority-v1", "provider": "vanguard_issuer_distributions",
        "fund_id": "9998", "has_distribution_yield": False,
        "uses": ["private_research", "private_retention", "private_display", "private_backup"], "retention_days": 10,
        "valid_from": "2025-01-01T00:00:00Z", "valid_until": "2027-01-01T00:00:00Z",
        "clause_references": ["FICTIONAL owner assertion; not provider certification"],
        "authorization_basis": "owner_declared_private_use_not_provider_certified",
        "collection_cadence": "at_most_one_request_per_issuer_day", **changes}


class Collector:
    def __init__(self, at=NOW, during=None, raw=None):
        self.at=at; self.during=during; self.raw=archive() if raw is None else raw; self.calls=0

    def __call__(self, **request):
        self.calls += 1
        if self.during: self.during()
        raw=self.raw
        receipt={"schema_version": receiver.TRANSPORT_VERSION, "source_url": distribution_url(request["fund_id"], request["has_distribution_yield"]),
            "request": {key: request[key] for key in ("fund_id", "has_distribution_yield")},
            "started_at": self.at, "completed_at": self.at, "retrieved_at": self.at,
            "http_status": 200, "headers": {"content-type": "application/json", "content-length": str(len(raw))},
            "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw), "redirects_followed": 0}
        draft=parse_vanguard_distributions(raw, fund_id=request["fund_id"], has_distribution_yield=request["has_distribution_yield"],
            retrieved_at=self.at, start_date=request["start_date"], end_date=request["end_date"])
        return {"schema_version": receiver.VERSION, "raw": raw, "receipt": receipt, "draft": draft}


class IssuerSourceTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance

    def grant(self, doc=None, enabled=True, workspace="w", actor="synthetic-investor"):
        row=sources.register_authority(self.db, workspace, actor, doc or policy(), now=NOW)
        if enabled:sources.set_authority_enabled(self.db, workspace, actor, row["id"], True, now=NOW)
        return row

    def collect(self, grant, key="a"*32, at=NOW, mock=None, **kwargs):
        return sources.collect_issuer_draft(self.db, "w", "synthetic-investor", grant["id"], key, START, END,
            now=at, test_collector=mock or Collector(at), **kwargs)

    def read(self, result, at=NOW):
        return sources.resolve_issuer_capture(self.db, "w", "synthetic-investor", result["capture_id"], now=at, allow_synthetic=True)

    def count(self, table):return self.db.execute("SELECT count(*) FROM "+table).fetchone()[0]

    def test_authority_is_disabled_by_default_normalized_and_idempotent_not_economic_approval(self):
        doc=policy(); original=deepcopy(doc); row=self.grant(doc, enabled=False)
        self.assertEqual(doc, original)
        self.assertEqual(json.loads(row["document_json"])["valid_until"], "2027-01-01T00:00:00.000Z")
        self.assertEqual(self.count("investor_issuer_authorities"), 1)
        self.assertEqual(self.db.execute("SELECT enabled FROM investor_issuer_controls").fetchone()[0], 0)
        self.assertEqual(self.grant(doc, enabled=False)["id"], row["id"])
        mock=Collector()
        with self.assertRaisesRegex(WorkbenchError, "AUTHORITY_INACTIVE"):self.collect(row, mock=mock)
        self.assertEqual(mock.calls, 0); self.assertEqual(self.count("investor_issuer_requests"), 0)
        self.assert_no_finance()

    def test_capture_receipt_and_exact_bytes_replay_with_zero_financial_source_or_queue_writes(self):
        grant=self.grant(); mock=Collector(); result=self.collect(grant, mock=mock)
        self.assertEqual(result["status"], "captured"); self.assertEqual(mock.calls, 1)
        before=self.db.total_changes; value=self.read(result)
        self.assertEqual(value["raw"], archive())
        self.assertEqual(value["capture"]["qualification"], sources.SYNTHETIC)
        self.assertFalse(value["draft"]["owner_reviewed"]); self.assertFalse(value["receipt"]["research_admitted"])
        self.assertEqual(self.db.total_changes, before)
        for table in ("investor_data_reviews", "investor_monitor_evidence_inputs", "investor_models", "job_runs", "outbox"):
            self.assertEqual(self.count(table), 0)
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], 0)
        self.assert_no_finance()

    def test_same_key_reuses_terminal_state_but_different_key_same_day_cannot_repeat_http(self):
        grant=self.grant(); mock=Collector(); first=self.collect(grant, mock=mock)
        before=list(self.db.iterdump())
        self.assertEqual(self.collect(grant, mock=mock), first); self.assertEqual(mock.calls, 1)
        self.assertEqual(list(self.db.iterdump()), before)
        with self.assertRaisesRegex(WorkbenchError, "DAY_ALREADY_STARTED"):self.collect(grant, key="b"*32, mock=mock)
        with self.assertRaisesRegex(WorkbenchError, "REQUEST_KEY_CONFLICT"):
            sources.collect_issuer_draft(self.db, "w", "synthetic-investor", grant["id"], "a"*32, "2025-02-01", END, now=NOW, test_collector=mock)
        self.assertEqual(mock.calls, 1); self.assert_no_finance()

    def test_concurrent_connection_observes_durable_unknown_attempt_and_never_resends(self):
        grant=self.grant(); other=open_database(self.path); self.addCleanup(other.close)
        observed=[]
        def concurrent():
            self.assertFalse(self.db.in_transaction)
            observed.append(sources.collect_issuer_draft(other, "w", "synthetic-investor", grant["id"], "a"*32, START, END,
                now=NOW, test_collector=lambda **_:self.fail("Second connection must not call transport")))
            other.execute("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('other','fixture','fixture','fixture','fixture','{}',?)", (NOW,))
        result=self.collect(grant, mock=Collector(during=concurrent))
        self.assertEqual(observed[0]["status"], "indeterminate"); self.assertEqual(result["status"], "captured")
        self.assert_no_finance()

    def test_new_authority_or_query_flag_cannot_bypass_workspace_fund_daily_budget(self):
        grant=self.grant(); self.collect(grant); mock=Collector()
        for index, change in enumerate(({"retention_days": 20}, {"has_distribution_yield": True})):
            other=self.grant(policy(**change))
            with self.assertRaisesRegex(WorkbenchError, "DAY_ALREADY_STARTED"):
                self.collect(other, key=str(index+1)*32, mock=mock)
        self.assertEqual(mock.calls, 0); self.assertEqual(self.count("investor_issuer_requests"), 1)
        distinct=self.grant(policy(fund_id="9997")); self.collect(distinct, key="c"*32, mock=mock)
        self.assertEqual(mock.calls, 1); self.assert_no_finance()

    def test_transport_failure_is_terminal_sanitized_and_cannot_be_automatically_retried(self):
        grant=self.grant(); calls=[]
        def fail(**request):calls.append(request);raise RuntimeError("fictional-secret-and-raw-provider-body")
        result=self.collect(grant, mock=fail)
        self.assertEqual(result["status"], "transport_failed")
        stored=self.db.execute("SELECT document_json FROM investor_issuer_captures").fetchone()[0]
        self.assertNotIn("fictional-secret", stored)
        self.assertEqual(json.loads(stored)["reason_code"], "ISSUER_CAPTURE_TRANSPORT_FAILED")
        self.assertEqual(self.collect(grant, mock=fail), result); self.assertEqual(len(calls), 1)
        self.assertEqual(self.count("investor_issuer_payloads"), 0); self.assert_no_finance()

    def test_only_closed_failure_categories_are_retained_not_arbitrary_uppercase_secrets(self):
        grant=self.grant()
        def fail(**_):raise WorkbenchError("VANGUARD_PRIVATE_FIXTURE_SECRET")
        first=self.collect(grant, mock=fail)
        doc=json.loads(self.db.execute("SELECT document_json FROM investor_issuer_captures WHERE id=?", (first["capture_id"],)).fetchone()[0])
        self.assertEqual(doc["reason_code"], "ISSUER_CAPTURE_TRANSPORT_FAILED")
        def throttled(**_):raise WorkbenchError("VANGUARD_CAPTURE_HTTP_RATE_LIMITED")
        second=self.collect(grant, key="b"*32, at=LATER, mock=throttled)
        doc=json.loads(self.db.execute("SELECT document_json FROM investor_issuer_captures WHERE id=?", (second["capture_id"],)).fetchone()[0])
        self.assertEqual(doc["reason_code"], "ISSUER_CAPTURE_RATE_LIMITED")

    def test_repeated_unchanged_daily_responses_share_one_private_blob_with_separate_receipts(self):
        grant=self.grant(); a=self.collect(grant); b=self.collect(grant, key="b"*32, at=LATER)
        self.assertNotEqual(a["capture_id"], b["capture_id"])
        self.assertEqual(self.count("investor_issuer_payloads"), 1)
        self.assertEqual(self.read(b, LATER)["raw"], self.read(a, LATER)["raw"])
        self.assertEqual(self.count("investor_issuer_requests"), 2); self.assert_no_finance()

    def test_independent_workspace_cannot_read_or_share_the_other_private_blob(self):
        grant=self.grant(); result=self.collect(grant)
        self.db.execute("INSERT INTO investor_workspaces VALUES('foreign','foreign-owner',0,?)", (NOW,))
        with self.assertRaises(WorkbenchError):sources.resolve_issuer_capture(self.db, "foreign", "foreign-owner", result["capture_id"], now=NOW, allow_synthetic=True)
        other=self.grant(workspace="foreign", actor="foreign-owner")
        result2=sources.collect_issuer_draft(self.db, "foreign", "foreign-owner", other["id"], "a"*32, START, END, now=NOW, test_collector=Collector())
        self.assertEqual(result2["status"], "captured"); self.assertEqual(self.count("investor_issuer_payloads"), 2)
        with self.assertRaises(WorkbenchError):sources.request_state(self.db, "w", "foreign-owner", "a"*32, now=NOW)

    def test_disabled_or_expired_grant_prevents_io_and_reenable_does_not_revive_old_capture(self):
        grant=self.grant(); result=self.collect(grant)
        sources.set_authority_enabled(self.db, "w", "synthetic-investor", grant["id"], False, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "AUTHORITY_INACTIVE"):self.read(result)
        sources.set_authority_enabled(self.db, "w", "synthetic-investor", grant["id"], True, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "AUTHORITY_INACTIVE"):self.read(result)
        expired=self.grant(policy(valid_until="2026-01-04T00:00:00Z"))
        mock=Collector(LATER)
        with self.assertRaisesRegex(WorkbenchError, "AUTHORITY_INACTIVE"):self.collect(expired, key="c"*32, at=LATER, mock=mock)
        self.assertEqual(mock.calls, 0)

    def test_authority_changes_during_io_discard_bytes_but_preserve_the_spent_request(self):
        grant=self.grant()
        def revoke():sources.set_authority_enabled(self.db, "w", "synthetic-investor", grant["id"], False, now=NOW)
        mock=Collector(during=revoke); result=self.collect(grant, mock=mock)
        self.assertEqual(result["status"], "superseded"); self.assertEqual(mock.calls, 1)
        self.assertEqual(self.count("investor_issuer_payloads"), 0)
        self.assertEqual(self.collect(grant, mock=mock), result); self.assertEqual(mock.calls, 1)

    def test_restore_readonly_stop_or_crash_leave_durable_unknown_not_a_replayable_request(self):
        for mode in ("restore", "readonly", "stop", "crash"):
            if mode!="restore":self.setUp()
            grant=self.grant(); stop=[False]
            def interrupt():
                if mode=="restore":(self.path.parent/"RESTORE_PENDING_REVIEW").write_text("Fictional marker")
                elif mode=="readonly":self.env=patch.dict("os.environ", {"WORKBENCH_MODE":"read_only"});self.env.start()
                elif mode=="stop":stop[0]=True
                else:raise KeyboardInterrupt()
            with self.assertRaises((WorkbenchError,KeyboardInterrupt)):
                self.collect(grant, mock=Collector(during=interrupt), stop_requested=lambda:stop[0])
            if mode=="restore":(self.path.parent/"RESTORE_PENDING_REVIEW").unlink()
            if mode=="readonly":self.env.stop()
            self.assertEqual(self.count("investor_issuer_requests"), 1); self.assertEqual(self.count("investor_issuer_captures"), 0)
            mock=Collector(); state=self.collect(grant, mock=mock)
            self.assertEqual(state["status"], "indeterminate"); self.assertEqual(mock.calls, 0)
            self.assert_no_finance()

    def test_malformed_receipt_or_parser_projection_is_terminal_without_retaining_data(self):
        for index, change in enumerate((lambda x:x["receipt"].update(raw_sha256="0"*64),lambda x:x["draft"].update(owner_reviewed=True))):
            if index:self.setUp()
            grant=self.grant(); base=Collector()
            def fake(**request):value=base(**request);change(value);return value
            result=self.collect(grant, mock=fake)
            self.assertEqual(result["status"], "transport_failed"); self.assertEqual(self.count("investor_issuer_payloads"), 0)

    def test_dedup_cleanup_removes_bytes_only_after_all_capture_references_are_purged(self):
        grant=self.grant(policy(retention_days=1)); first=self.collect(grant); second=self.collect(grant, key="b"*32, at=LATER)
        row=sources.purge_issuer_capture(self.db, "w", "synthetic-investor", first["capture_id"], now=LATER)
        self.assertEqual(row["reason"], "retention_expired"); self.assertEqual(self.count("investor_issuer_payloads"), 1)
        self.assertEqual(self.read(second, LATER)["raw"], archive())
        with self.assertRaisesRegex(WorkbenchError, "PAYLOAD_PURGED"):self.read(first, LATER)
        self.assertEqual(sources.purge_issuer_capture(self.db, "w", "synthetic-investor", first["capture_id"], now=LATER), row)
        sources.set_authority_enabled(self.db, "w", "synthetic-investor", grant["id"], False, now=LATER)
        sources.purge_issuer_capture(self.db, "w", "synthetic-investor", second["capture_id"], now=LATER)
        self.assertEqual(self.count("investor_issuer_payloads"), 0)
        self.assertEqual(self.count("investor_issuer_captures"), 2); self.assert_no_finance()

    def test_purge_not_due_and_immutability_and_late_blob_failure_preserve_state(self):
        grant=self.grant(); result=self.collect(grant)
        with self.assertRaisesRegex(WorkbenchError, "PURGE_NOT_DUE"):
            sources.purge_issuer_capture(self.db, "w", "synthetic-investor", result["capture_id"], now=NOW)
        for table in ("investor_issuer_authorities","investor_issuer_controls","investor_issuer_requests","investor_issuer_captures","investor_issuer_payloads"):
            with self.assertRaises(sqlite3.IntegrityError):self.db.execute("DELETE FROM "+table)
        self.db.execute("CREATE TRIGGER fictional_blob_abort BEFORE INSERT ON investor_issuer_payloads BEGIN SELECT RAISE(ABORT,'fictional late failure'); END")
        def different(**request):
            value=Collector()(**request);value["raw"]=value["raw"]+b' ';value["receipt"].update(raw_sha256=sha256(value["raw"]).hexdigest(),raw_bytes=len(value["raw"]))
            value["receipt"]["headers"]["content-length"]=str(len(value["raw"]))
            value["draft"]=parse_vanguard_distributions(value["raw"],fund_id=request["fund_id"],has_distribution_yield=request["has_distribution_yield"],retrieved_at=NOW,start_date=START,end_date=END)
            return value
        another=self.grant(policy(fund_id="9997"))
        with self.assertRaises(sqlite3.IntegrityError):self.collect(another,key="b"*32,mock=different)
        self.assertEqual(self.count("investor_issuer_requests"),2);self.assertEqual(self.count("investor_issuer_captures"),1)
        self.assertEqual(self.count("investor_issuer_payloads"),1);self.assert_no_finance()

    def test_official_clock_cannot_be_injected_and_synthetic_bytes_cannot_be_read_as_official(self):
        grant=self.grant();result=self.collect(grant)
        with self.assertRaisesRegex(WorkbenchError,"SYNTHETIC_CAPTURE_FORBIDDEN"):
            sources.resolve_issuer_capture(self.db,"w","synthetic-investor",result["capture_id"],now=NOW)
        with patch.object(receiver,"collect_vanguard_distribution_draft") as transport:
            with self.assertRaisesRegex(WorkbenchError,"PRODUCTION_CLOCK_NOT_CALLER_CONTROLLED"):
                sources.collect_issuer_draft(self.db,"w","synthetic-investor",grant["id"],"b"*32,START,END,now=NOW)
            transport.assert_not_called()

    def test_shared_core_cleanup_budget_audits_metadata_and_keeps_active_dedup_reference(self):
        grant=self.grant(policy(retention_days=1)); first=self.collect(grant); second=self.collect(grant,key="b"*32,at=LATER)
        self.assertEqual(purge_due_source_payloads(self.db,now=NOW),[])
        result=purge_due_source_payloads(self.db,now=LATER,limit=1)
        self.assertEqual([row["capture_id"] for row in result],[first["capture_id"]])
        self.assertEqual(self.count("investor_issuer_payloads"),1);self.assertEqual(self.read(second,LATER)["raw"],archive())
        sources.set_authority_enabled(self.db,"w","synthetic-investor",grant["id"],False,now=LATER)
        self.assertEqual(purge_due_source_payloads(self.db,now=LATER)[0]["capture_id"],second["capture_id"])
        before=self.db.total_changes;self.assertEqual(purge_due_source_payloads(self.db,now=LATER),[])
        self.assertEqual(self.db.total_changes,before);self.assertEqual(self.count("investor_issuer_payloads"),0)
        self.assert_no_finance()

    def test_default_core_purges_expired_bytes_but_new_identical_body_never_revives_old_capture(self):
        grant=self.grant(policy(retention_days=1)); first=self.collect(grant)
        self.assertIsNone(run_pending_once(self.db, "fictional-core", clock=lambda:LATER))
        self.assertEqual(self.count("investor_issuer_payloads"), 0)
        second=self.collect(grant, key="b"*32, at=LATER)
        self.assertEqual(self.read(second, LATER)["raw"], archive())
        with self.assertRaisesRegex(WorkbenchError, "PAYLOAD_PURGED"):self.read(first, LATER)
        self.assert_no_finance()

    def test_corrupted_prior_purge_audit_cannot_delete_the_last_shared_blob(self):
        grant=self.grant(policy(retention_days=1)); first=self.collect(grant); second=self.collect(grant,key="b"*32,at=LATER)
        purge=sources.purge_issuer_capture(self.db,"w","synthetic-investor",first["capture_id"],now=LATER)
        # Simulate an externally corrupted store, not an application mutation.
        for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_events'").fetchall():
            self.db.execute('DROP TRIGGER "'+row[0]+'"')
        self.db.execute("UPDATE audit_events SET payload_json='{}' WHERE id=?", (purge["audit_id"],))
        sources.set_authority_enabled(self.db,"w","synthetic-investor",grant["id"],False,now=LATER)
        with self.assertRaisesRegex(WorkbenchError,"INVESTOR_ISSUER_INVALID"):
            sources.purge_issuer_capture(self.db,"w","synthetic-investor",second["capture_id"],now=LATER)
        self.assertEqual(self.count("investor_issuer_payloads"),1);self.assertEqual(self.count("investor_issuer_purges"),1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_purge_issuer_capture'").fetchone()[0],1)

    def test_readonly_restore_and_invalid_owner_prevent_new_authorities_before_any_io(self):
        with patch.dict("os.environ", {"WORKBENCH_MODE":"read_only"}):
            with self.assertRaisesRegex(WorkbenchError,"READ_ONLY"):self.grant()
        marker=self.path.parent/"RESTORE_PENDING_REVIEW"; marker.write_text("Fictional recovery")
        with self.assertRaisesRegex(WorkbenchError,"RESTORE_PENDING_REVIEW"):self.grant()
        marker.unlink()
        with self.assertRaises(WorkbenchError):sources.register_authority(self.db,"w","wrong-owner",policy(),now=NOW)
        self.assertEqual(self.count("investor_issuer_authorities"),0)


if __name__=="__main__":unittest.main()
