"""Actual retained v2/v3 heads, not relabelled v1 fixtures or current advice."""

from copy import deepcopy
from contextlib import contextmanager, ExitStack
import json
import os
import subprocess
import unittest
from unittest.mock import patch

from tests.investor import test_action_refresh as refresh_fixture
from tests.investor import test_action_review_workflow as review_fixture
from tests.investor import action_reconciliation_fixture as sources, test_managed_actions as managed_fixture
from tests.investor.confirmed_capture_fixture import FictionalReceiver
from tests.investor.fixtures import monitor_input
from tests.investor.test_reviewed_action_successor import UpdatedCollector
from tests.market.test_vanguard_distributions import archive, row
from worker.investor import action_review_workflow as review, confirmed_capture, confirmed_feed, managed_actions
from worker.investor import issuer_schedule
from worker.investor import legacy_transition_jobs as jobs, legacy_transition_workflow as workflow
from worker.investor import monitor_admission, monitor_costs, monitor_data
from worker.orchestration.db import ROOT, content_hash, open_database
from worker.orchestration.runtime import run_pending_once
from worker.orchestration.jobs import run_one
from worker.market.providers import longport_confirmed


OLD_REPORT = "2026-11-03T06:00:03.000Z"
COST_DECLARED = "2026-11-03T06:00:03.001Z"
ADMITTED = "2026-11-03T06:00:03.003Z"
REPORT = "2026-11-06T06:00:03.000Z"
REVIEWED = "2026-11-06T06:00:04.001Z"
MIGRATED = "2026-11-06T06:00:04.002Z"
NEXT = "2026-11-06T06:00:04.003Z"


@contextmanager
def offline_protocol_fixture():
    with ExitStack() as stack:
        for target in ("socket.create_connection", "socket.getaddrinfo", "worker.market.providers.longport.read_private_credentials_file",
                       "worker.market.providers.eodhd_capture.read_private_token", "worker.market.providers.longport._collect_isolated",
                       "worker.market.providers.longport_confirmed.collect_confirmed_days",
                       "worker.market.providers.vanguard_capture.collect_vanguard_distribution_draft",
                       "worker.market.providers.eodhd_capture.collect_eodhd_action_draft", "worker.market.providers.ecb_current.collect_current_fx_draft"):
            stack.enter_context(patch(target, side_effect=AssertionError("NO_NETWORK_OR_CREDENTIALS")))
        yield


class LegacyProtocolMatrixTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(offline_protocol_fixture())
        self.case = review_fixture.ActionReviewWorkflowTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.db = self.case.db

    def rows(self, table):
        return [list(value) for value in self.db.execute("SELECT rowid,* FROM " + table + " ORDER BY rowid")]

    def revision(self):
        return self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]

    def reports(self, at, *, updated=False):
        if updated:
            pending = self.db.execute("SELECT id FROM job_runs WHERE job_type=? AND status='queued' ORDER BY created_at,id", (issuer_schedule.JOB_TYPE,)).fetchall()
            for original in pending:
                expired = run_one(self.db, "fictional-protocol-expired-issuer", lambda job, lease: issuer_schedule.prepare_issuer_capture(
                    self.db, job, lease, clock=lambda: at), job_type=issuer_schedule.JOB_TYPE, lease_seconds=180, clock=lambda: at)
                self.assertEqual((expired["id"], expired["status"], expired["attempt_count"]), (original["id"], "skipped", 1))
        with patch.object(managed_fixture, "LATER", at):
            if updated:
                raw = archive(row("987.1234", exDividendDate="2026-09-25", recordDate="2026-09-25", payableDate="2026-09-30"),
                    row("4.32109", exDividendDate="2026-11-05", recordDate="2026-11-05", payableDate="2026-11-09"))
                with patch.object(sources, "ActionCollector", UpdatedCollector), patch.object(UpdatedCollector, "event_day", "2026-11-05"):
                    self.case.next_source_day(issuer_raw=raw)
            else:
                self.case.next_source_day()
        publications = managed_actions.publish_current_actions(self.db, now=at)
        self.assertEqual(len(publications), 1)
        self.assertEqual(publications[0]["status"], "blocked" if updated else "published")
        return publications[0]["publication_id"]

    def confirmed_prices(self):
        start, end = "2026-11-02T19:58:00.000Z", "2026-11-02T20:01:02.000Z"
        targets = []
        for capture in self.prepared["windows"][0]["capture_ids"]:
            bound = self.db.execute("SELECT rights_review_id,listing_review_id,calendar_review_id FROM investor_price_captures WHERE id=?", (capture,)).fetchone()
            targets.append({**dict(bound), "session_date": "2026-11-02"})
        times = [start]; receiver = FictionalReceiver(now=start, received_at=end, during=lambda: times.__setitem__(0, end))
        millis, parse = confirmed_capture._milliseconds, confirmed_capture.instant
        with patch.object(longport_confirmed, "collect_confirmed_days", side_effect=lambda request, **kw: receiver(request, kw["stop_requested"])), \
                patch.object(confirmed_capture, "_milliseconds", side_effect=lambda value=None: millis(times[0] if value is None else value)), \
                patch.object(confirmed_capture, "instant", side_effect=lambda value=None: parse(times[0] if value is None else value)):
            value = confirmed_capture.collect_confirmed_prices(self.db, "w", "synthetic-investor", targets, watch_seconds=185)
        self.assertEqual(receiver.calls, 1)
        actual = confirmed_capture.resolve_confirmed_capture(self.db, "w", value["id"], now=end)
        self.assertEqual(actual["capture"]["qualification"], "isolated_official_sdk_callback")
        self.assertEqual(len(actual["records"]), 2)
        return value["id"]

    def declare_costs(self):
        program = """import {createRequire} from 'node:module';
import {getInvestorState,executeInvestorCommand} from './web/src/server/investor/service';
const require=createRequire(process.cwd()+'/web/package.json'), Database=require('better-sqlite3');
const db=new Database(process.argv[1]),at=process.argv[2],actor={id:'synthetic-investor'};
const denied=()=>{throw new Error('FICTIONAL_NETWORK_FORBIDDEN')};
for(const name of ['node:http','node:https']) require(name).request=denied;
require('node:net').connect=denied;globalThis.fetch=denied;
try {const s=getInvestorState(db,actor,at);const r=executeInvestorCommand(db,actor,{action:'set_monitor_costs',
model_id:s.model_watch.id,model_hash:s.monitor_costs.model_hash,expected_cost_version:s.monitor_costs.version,
expected_revision:s.revision,idempotency_key:'fictional-original-v3-costs',validity_days:7,acknowledged_research_only:true,
costs:{commission_bps:'1',minimum_fee_cny:'1',fx_bps:'2',slippage_bps:'3',maximum_cost_fraction:'0.01'}},at);
console.log(JSON.stringify({id:r.resource_id}));}finally{db.close();}"""
        process = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "-e", program, str(self.case.path), COST_DECLARED],
            cwd=ROOT, env={"PATH": os.environ.get("PATH", ""), "NODE_ENV": "test", "WORKBENCH_MODE": "ledger"},
            text=True, capture_output=True, timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertTrue(json.loads(process.stdout)["id"])

    def prepare(self, protocol):
        self.assertIn(protocol, ("v2", "v3"))
        # Fictional holidays only; the new ex-date remains an open session.
        self.definition, self.prepared, old = refresh_fixture.ActionRefreshTests.model_and_prices(self.case, audited=False,
            explicit_costs=monitor_input()["policy"]["costs"], calendar_end="2026-11-06", bnd_coverage_end="2026-11-06",
            closed_dates=("2026-11-03", "2026-11-04"), prepare_only=True)
        self.model_id = self.definition["model_id"]
        self.assertEqual(self.rows("investor_monitor_evidence_inputs"), []); self.assertEqual(self.rows("investor_evidence_model_checkpoints"), [])
        self.capture_id = self.confirmed_prices(); publication = self.reports(OLD_REPORT)
        windows = deepcopy(self.prepared["windows"])
        windows[0].update(confirmed_capture_ids=[self.capture_id], end_date="2026-11-02")
        windows[0]["action_review_ids"] = [publication if value == old else value for value in windows[0]["action_review_ids"]]
        if protocol == "v3": self.declare_costs()
        settings = monitor_costs.current_settings(self.db, "w", self.definition, self.prepared["settings"], ADMITTED) if protocol == "v3" else self.prepared["settings"]
        self.seed = monitor_admission.admit_monitor_data(self.db, "w", "synthetic-investor", self.model_id, windows, settings, now=ADMITTED)
        self.document = json.loads(self.seed["document_json"])
        self.assertEqual(self.document["schema_version"], "investor-monitor-data-input-" + protocol)
        self.assertEqual("cost_assumptions" in self.document["settings"], protocol == "v3")
        for _ in range(6):
            job = run_pending_once(self.db, "fictional-original-protocol-core", clock=lambda: ADMITTED)
            self.assertIsNotNone(job)
            if self.db.execute("SELECT 1 FROM investor_evidence_model_checkpoints WHERE input_id=?", (self.seed["id"],)).fetchone(): break
        else: self.fail("FICTIONAL_ORIGINAL_CHECKPOINT_REQUIRED")
        self.assertEqual(job["status"], "succeeded")
        self.head = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints").fetchone()
        self.state = json.loads(self.db.execute("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?", (self.head["id"],)).fetchone()[0])
        self.assertEqual(self.state["market_cutoffs"], {"US": "2026-11-02T20:00:00.000Z"})
        self.assertTrue(self.state["processed_actions"])
        replay = monitor_data.resolve_monitor_data(self.db, "w", self.definition, self.document, now=ADMITTED)
        self.assertIsNone(replay["unavailable_reason"]); self.assertEqual(replay["projection"]["quality_gaps"], [])
        self.assertEqual({quote["observed_at"] for quote in replay["projection"]["quotes"]}, {"2026-11-02T20:00:00.000Z"})
        self.projection = replay["projection"]

    def explicit_action_review(self):
        self.reports(REPORT, updated=True)
        self.assertEqual(confirmed_feed.refresh_monitor_sources(self.db, now=REPORT), [])
        preview = review.register_action_review_preview(self.db, "w", "synthetic-investor", {"authority_id": self.case.authority["id"],
            "expected_revision": self.revision(), "idempotency_key": "fictional-protocol-action-preview"}, now=REPORT)
        self.action_confirmation = review.confirm_action_review(self.db, "w", "synthetic-investor", {
            "schema_version": "investor-action-review-submit-v1", "preview_id": preview["preview_id"],
            "expected_revision": preview["workspace_revision"], "idempotency_key": "fictional-protocol-action-confirm",
            "new_events": [{"type": "dividend", "date": "2026-11-05", "at": "2026-11-05T14:30:00Z", "pay_at": "2026-11-09T21:00:00Z", "tax_per_unit": "0.432109"}],
            "acknowledgements": {key: True for key in ("issuer_amount_unit_and_currency", "reported_differences_seen", "explicit_research_instants",
                "explicit_tax_amounts", "unchanged_tax_assumption_applies", "reported_coverage_not_objective_absence", "no_historical_restatement", "register_new_default_off_rule")},
            "enable_rule": False}, now=REVIEWED)

    def job(self, kind, body):
        request = jobs.enqueue_legacy_transition_request(self.db, "w", "synthetic-investor", kind, body, now=MIGRATED)
        for _ in range(8):
            result = run_pending_once(self.db, "fictional-protocol-compatibility-core", clock=lambda: MIGRATED)
            self.assertIsNotNone(result)
            row = self.db.execute("SELECT document_json FROM investor_legacy_transition_job_results WHERE request_id=?", (request["request_id"],)).fetchone()
            if row: break
        else: self.fail("FICTIONAL_PROTOCOL_COMPATIBILITY_RESULT_REQUIRED")
        self.assertEqual(result["status"], "succeeded")
        return request, json.loads(row[0])

    def buffered_prices(self):
        start, end = "2026-11-05T19:58:00.000Z", "2026-11-05T20:01:02.000Z"
        self.assertEqual(len(confirmed_feed.discover_confirmed_watches(self.db, now=start)), 1)
        self.assertEqual(confirmed_feed.discover_confirmed_watches(self.db, now=start), [])
        times = [start]; receiver = FictionalReceiver(now=start, received_at=end, during=lambda: times.__setitem__(0, end))
        millis, parse = confirmed_capture._milliseconds, confirmed_capture.instant
        with patch.object(longport_confirmed, "collect_confirmed_days", side_effect=lambda request, **kw: receiver(request, kw["stop_requested"])), \
                patch.object(confirmed_capture, "_milliseconds", side_effect=lambda value=None: millis(times[0] if value is None else value)), \
                patch.object(confirmed_capture, "instant", side_effect=lambda value=None: parse(times[0] if value is None else value)):
            job = run_pending_once(self.db, "fictional-protocol-buffered-listener", role="longport", clock=lambda: times[0])
        self.assertEqual((job["status"], job["attempt_count"], job["max_attempts"], receiver.calls), ("succeeded", 1, 1, 1))
        confirmed_feed.admit_completed_feeds(self.db, now=end)
        admission = self.db.execute("SELECT status FROM investor_confirmed_feed_admissions").fetchall()
        self.assertEqual([value["status"] for value in admission], ["blocked"])

    def ready(self):
        self.buffered_prices()
        self.explicit_action_review()
        # Finish the actual background evaluation before capturing a fresh CAS.
        # Never rebase/replay an owner request that already lost that race.
        for _ in range(8):
            job = run_pending_once(self.db, "fictional-protocol-baseline-core", clock=lambda: MIGRATED)
            if job is None: break
            self.assertEqual((job["job_type"], job["status"]), ("investor_evidence_monitor", "succeeded"))
        else: self.fail("FICTIONAL_PROTOCOL_BASELINE_NOT_SETTLED")
        self.original = {name: self.rows(name) for name in ("investor_models", "investor_model_controls", "investor_monitor_evidence_inputs",
            "investor_evidence_model_checkpoints", "investor_evidence_checkpoint_payloads", "investor_confirmed_captures")}

    def migrate(self):
        self.ready()
        request, result = self.job("preview", {"model_id": self.model_id, "expected_revision": self.revision(), "idempotency_key": "fictional-protocol-legacy-preview"})
        self.assertEqual(result["outcome"], "preview_ready")
        self.preview = workflow._preview_header(self.db, "w", "synthetic-investor", result["resource_id"])[1]
        self.assertEqual(self.preview["proof"]["legacy_input_id"], self.seed["id"])
        body = {"schema_version": "investor-legacy-transition-submit-v1", "preview_id": self.preview["preview_id"],
            "expected_preview_hash": content_hash(self.preview), "expected_revision": self.preview["workspace_revision"],
            "idempotency_key": "fictional-protocol-legacy-confirm", "acknowledgements": {key: True for key in
                ("preserve_original_accounting_and_knowledge", "revalidate_current_sources_on_every_use", "new_actions_keep_audited_knowledge",
                 "quality_gaps_are_not_current_advice", "research_only_no_trading")}}
        self.request, self.result = self.job("confirmation", body)
        self.assertEqual((self.result["outcome"], self.result["code"]), ("registered", "LEGACY_TRANSITION_REGISTERED"))
        self.assertEqual(jobs.enqueue_legacy_transition_request(self.db, "w", "synthetic-investor", "confirmation", body, now=MIGRATED), self.request)
        self.admission = json.loads(self.db.execute("SELECT document_json FROM investor_legacy_transition_admissions WHERE id=?", (self.result["resource_id"],)).fetchone()[0])
        self.root = monitor_admission.latest_monitor_evidence(self.db, "w", self.model_id)
        self.root_document = json.loads(self.root["document_json"])
        self.assertEqual(self.root_document["schema_version"], "investor-monitor-data-input-v5")
        self.assertFalse(self.admission["monitoring_activated"])
        for name, before in self.original.items():
            self.assertEqual(self.rows(name)[:len(before)], before, name)
        from worker.investor.evidence_monitor_runtime import resolve_checkpoint
        readonly = open_database(self.case.path, read_only=True)
        try:
            self.assertEqual(resolve_checkpoint(readonly, "w", self.definition, self.head["id"], MIGRATED), (self.state, None))
            self.assertEqual(readonly.total_changes, 0)
        finally: readonly.close()
        self.assertEqual(monitor_data.resolve_monitor_data(self.db, "w", self.definition, self.document, now=MIGRATED)["unavailable_reason"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        self.case.assert_no_finance()

    def advance(self):
        self.root = monitor_admission.latest_monitor_evidence(self.db, "w", self.model_id)
        self.root_document = json.loads(self.root["document_json"])
        controls = self.rows("investor_model_controls")
        confirmation = json.loads(self.db.execute("SELECT document_json FROM investor_action_review_confirmations ORDER BY rowid DESC LIMIT 1").fetchone()[0])
        self.assertEqual(self.db.execute("SELECT enabled FROM investor_action_controls WHERE authority_id=? ORDER BY version DESC LIMIT 1",
            (confirmation["new_authority_id"],)).fetchone()[0], 0)
        admissions = self.rows("investor_confirmed_feed_admissions")
        self.assertEqual(admissions[-1][5], "blocked")
        original = {name: self.rows(name) for name in ("investor_monitor_evidence_inputs", "investor_evidence_model_checkpoints",
            "investor_evidence_checkpoint_payloads", "investor_confirmed_feed_requests", "investor_confirmed_feed_runs", "investor_confirmed_captures",
            "job_runs", "job_attempts")}
        for _ in range(8):
            self.assertIsNotNone(run_pending_once(self.db, "fictional-protocol-next-core", clock=lambda: NEXT))
            source = monitor_admission.latest_monitor_evidence(self.db, "w", self.model_id)
            head = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1").fetchone()
            if source["id"] != self.root["id"] and head["input_id"] == source["id"]: break
        else: self.fail("FICTIONAL_PROTOCOL_LATER_CHECKPOINT_REQUIRED")
        document = json.loads(source["document_json"])
        self.assertEqual(document["schema_version"], "investor-monitor-data-input-v5")
        self.assertEqual(document["transition"], self.root_document["transition"])
        current = monitor_data.resolve_monitor_data(self.db, "w", self.definition, document, now=NEXT)
        self.assertIsNone(current["unavailable_reason"]); self.assertEqual(current["projection"]["quality_gaps"], [])
        self.assertEqual({value["observed_at"] for value in current["projection"]["quotes"]}, {"2026-11-05T20:00:00.000Z"})
        state = json.loads(self.db.execute("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?", (head["id"],)).fetchone()[0])
        self.assertEqual(state["sequence"], self.state["sequence"] + 1)
        self.assertEqual(state["initialized_at"], self.state["initialized_at"])
        self.assertEqual(state["initial_notional_cny"], self.state["initial_notional_cny"])
        self.assertEqual(state["quantities"], self.state["quantities"])
        for key, value in self.state["processed_actions"].items(): self.assertEqual(state["processed_actions"][key], value)
        added = set(state["processed_actions"]) - set(self.state["processed_actions"])
        self.assertEqual(len(added), 1); self.assertEqual(len(state["receivables"]), 1)
        self.assertEqual({value["known_at"] for value in current["projection"]["corporate_actions"] if value["id"] in added}, {REVIEWED})
        for name, before in original.items(): self.assertEqual(self.rows(name)[:len(before)], before, name)
        self.assertEqual(self.rows("investor_confirmed_feed_admissions"), admissions)
        self.assertEqual(self.rows("investor_model_controls"), controls)
        self.assertEqual(self.db.execute("SELECT enabled FROM investor_action_controls WHERE authority_id=? ORDER BY version DESC LIMIT 1",
            (confirmation["new_authority_id"],)).fetchone()[0], 0)
        self.assertEqual(len(self.rows("investor_monitor_evidence_inputs")), 3)
        before = self.db.total_changes
        self.assertEqual(confirmed_feed.refresh_monitor_sources(self.db, now=NEXT), [])
        self.assertEqual(self.db.total_changes, before)
        self.case.assert_no_finance()
        return {"input_id": source["id"], "document": document, "checkpoint_id": head["id"], "state": state, "projection": current["projection"]}

    def test_genuine_confirmed_price_v2_head_gets_explicit_v5_without_rewriting_its_original_chain(self):
        self.prepare("v2"); self.migrate(); self.advance()

    def test_genuine_owner_cost_bound_v3_head_gets_explicit_v5_without_rewriting_original_fees(self):
        self.prepare("v3"); self.migrate(); self.advance()


def protocol_case(db, path, metadata=None):
    case = LegacyProtocolMatrixTests(); case.db = db
    case.case = review_fixture.ActionReviewWorkflowTests(); case.case.db = db; case.case.path = path; case.case.version = 0
    if metadata is not None:
        case.model_id = metadata["model_id"]; case.case.member = metadata["member"]
        case.case.authority = db.execute("SELECT * FROM investor_action_authorities WHERE id=?", (metadata["authority_id"],)).fetchone()
        case.definition = json.loads(db.execute("SELECT document_json FROM investor_models WHERE id=?", (case.model_id,)).fetchone()[0])
        case.seed = db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE id=?", (metadata["input_id"],)).fetchone()
        case.document = json.loads(case.seed["document_json"])
        case.head = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE id=?", (metadata["checkpoint_id"],)).fetchone()
        case.state = json.loads(db.execute("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?", (case.head["id"],)).fetchone()[0])
    return case


if __name__ == "__main__": unittest.main()
