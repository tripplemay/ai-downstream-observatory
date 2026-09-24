from copy import deepcopy
from hashlib import sha256
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from worker.governance_verification.checker import ASSERTION_IDS, check_artifact, check_bytes, strict_json
from worker.governance_verification.fixture import execute_fixture
from worker.governance_verification.process import bounded_process, clean_environment
from worker.orchestration.db import ROOT, canonical_json, content_hash


class CashNeutralityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.artifact = execute_fixture()

    def test_real_normal_ledger_to_valuation_to_performance(self):
        result = check_artifact(self.artifact)
        self.assertEqual(result["status"], "pass")
        self.assertEqual(tuple(row["id"] for row in result["assertions"]), ASSERTION_IDS)
        self.assertEqual([row["run"]["nav_cny"] for row in self.artifact["valuations"]], ["100.25", "150.375"])
        self.assertEqual([row["event_type"] for row in self.artifact["ledger"]["events"]], ["opening_cash", "deposit"])
        self.assertEqual(self.artifact["performance"]["run"]["method"], "modified_dietz_estimate")
        self.assertFalse(result["gate_eligible"])
        self.assertEqual(result["completed_requirements"], [])

    def test_rehashed_wrong_profit_does_not_self_certify(self):
        artifact = deepcopy(self.artifact)
        result = strict_json(artifact["performance"]["run"]["result_json"])
        result["net_profit_cny"] = "50.125"
        artifact["performance"]["run"]["result_json"] = canonical_json(result)
        body = canonical_json(artifact).encode()
        checked = check_bytes(body, sha256(body).hexdigest())
        self.assertEqual(checked["status"], "fail")
        self.assertIn("ASSERTION_FAILED:cash_contribution_neutrality", checked["issues"])

    def test_estimate_cannot_claim_exact_twr(self):
        artifact = deepcopy(self.artifact)
        artifact["performance"]["run"].update(quality="complete", method="exact_twr")
        self.assertIn("ASSERTION_FAILED:honest_estimate_quality", check_artifact(artifact)["issues"])

    def test_rehashed_boolean_number_confusion_in_rules_is_not_pass(self):
        artifact = deepcopy(self.artifact)
        run = artifact["valuations"][0]["run"]
        manifest = strict_json(run["market_manifest"])
        manifest["rules"]["approved"] = 1
        manifest["rules_hash"] = content_hash(manifest["rules"])
        run["market_manifest"] = canonical_json(manifest)
        self.assertIn("ASSERTION_FAILED:real_valuation_binding", check_artifact(artifact)["issues"])

    def test_boolean_cannot_impersonate_audit_ledger_revision(self):
        artifact = deepcopy(self.artifact)
        audit = next(row for row in artifact["ledger"]["audits"] if row["action"] == "record_fact" and row["ledger_revision"] == 1)
        audit["ledger_revision"] = True
        self.assertIn("ASSERTION_FAILED:normal_service_audit", check_artifact(artifact)["issues"])

    def test_coordinated_boolean_identity_and_structure_aliases_never_pass_either_checker(self):
        cases = []
        def add(name, mutate):
            artifact = deepcopy(self.artifact)
            mutate(artifact)
            try:
                status = check_bytes(canonical_json(artifact).encode())["status"]
            except (ValueError, TypeError, KeyError):
                status = "rejected"
            self.assertNotEqual(status, "pass", name)
            cases.append({"name": name, "artifact": artifact})

        def payload_mismatch(artifact, key):
            event = artifact["ledger"]["events"][0]
            payload = strict_json(event["payload_json"])
            payload[key], event[key] = 0, False
            event["payload_json"] = canonical_json(payload)
            event["payload_hash"] = content_hash({k: v for k, v in payload.items() if k not in ("expected_revision", "idempotency_key")})
            audit = next(a for a in artifact["ledger"]["audits"] if a["action"] == "record_fact" and a["ledger_revision"] == 1)
            proof = strict_json(audit["payload_json"])
            proof["digest"] = event["payload_hash"]
            audit["payload_json"] = canonical_json(proof)

        def event_mismatch(artifact, key):
            event = artifact["ledger"]["events"][0]
            old, event["id"] = event["id"], 1
            for posting in artifact["ledger"]["postings"]:
                if posting["event_id"] == old:
                    posting["event_id"] = True if key == "postings" else 1
            for audit in artifact["ledger"]["audits"]:
                if audit["object_id"] == old:
                    audit["object_id"] = True if key == "audits" else 1

        def valuation_mismatch(artifact, key):
            snapshot = artifact["valuations"][0]
            snapshot["run"]["id"] = 1
            snapshot["items"][0]["run_id"] = True if key == "item" else 1
            performance = artifact["performance"]["run"]
            manifest = strict_json(performance["market_manifest"])
            manifest["valuations"][0] = {"id": True if key == "reference" else 1, "content_hash": content_hash(snapshot["run"])}
            performance["market_manifest"] = canonical_json(manifest)

        def flow_mismatch(artifact, key):
            event = artifact["ledger"]["events"][1]
            posting = next(p for p in artifact["ledger"]["postings"] if p["ledger_account"] == "external_capital")
            if key == "event_id":
                old, event["id"] = event["id"], 1
                for row in artifact["ledger"]["postings"]:
                    if row["event_id"] == old:
                        row["event_id"] = 1
                for row in artifact["ledger"]["audits"]:
                    if row["object_id"] == old:
                        row["object_id"] = 1
            elif key == "posting_id":
                posting["id"] = 1
            performance = artifact["performance"]["run"]
            manifest, result = strict_json(performance["market_manifest"]), strict_json(performance["result_json"])
            evidence = manifest["external_flow_evidence"][0]
            evidence[key] = 0 if key == "extra" else True
            evidence["posting_hash"], evidence["event_hash"] = content_hash(posting), content_hash(event)
            evidence["binding_id"] = content_hash({k: v for k, v in evidence.items() if k != "binding_id"})
            result["external_flow_evidence"] = deepcopy(manifest["external_flow_evidence"])
            if key == "extra":
                result["external_flow_evidence"][0][key] = False
            performance["market_manifest"], performance["result_json"] = canonical_json(manifest), canonical_json(result)

        def distinct_ids(artifact, key):
            selected = artifact["ledger"][key]
            if key == "postings":
                selected = [p for p in selected if p["event_id"] == artifact["ledger"]["events"][0]["id"]]
            selected[0]["id"], selected[1]["id"] = True, 1

        def assumptions_object(artifact):
            performance = artifact["performance"]["run"]
            result = strict_json(performance["result_json"])
            result["assumptions"] = {key: True for key in result["assumptions"]}
            performance["result_json"] = canonical_json(result)

        for key in ("reason", "idempotency_key"):
            add("payload:" + key, lambda artifact, k=key: payload_mismatch(artifact, k))
        for key in ("postings", "audits"):
            add("event-link:" + key, lambda artifact, k=key: event_mismatch(artifact, k))
            add("distinct-ids:" + key, lambda artifact, k=key: distinct_ids(artifact, k))
        for key in ("item", "reference"):
            add("valuation-link:" + key, lambda artifact, k=key: valuation_mismatch(artifact, k))
        for key in ("posting_id", "event_id", "extra"):
            add("flow:" + key, lambda artifact, k=key: flow_mismatch(artifact, k))
        add("assumptions:object-not-array", assumptions_object)
        program = '''import {readFileSync} from "node:fs";
import {checkVerificationArtifact} from "./web/src/server/verifications/checker";
for (const row of JSON.parse(readFileSync(0, "utf8"))) {
  let status; try {status=checkVerificationArtifact(Buffer.from(JSON.stringify(row.artifact))).result.status;} catch {status="rejected";}
  console.log(JSON.stringify({name:row.name,status}));
}'''
        checked = subprocess.run(["node", str(ROOT / "web/node_modules/tsx/dist/cli.mjs"), "-e", program],
                                 input=canonical_json(cases), cwd=ROOT, capture_output=True, text=True, timeout=30, check=True)
        results = [strict_json(line) for line in checked.stdout.splitlines()]
        self.assertEqual([row["name"] for row in results], [row["name"] for row in cases])
        self.assertTrue(all(row["status"] in ("fail", "rejected") for row in results), results)

    def test_fixture_cannot_swallow_node_errors_or_malformed_identity(self):
        for output, errors, code in ((b'{}', b"unexpected Node warning", "UNEXPECTED_NODE_STDERR"),
                                    (b'{"portfolio_id":"unbound"}', b"", "NODE_IDENTITY_INVALID")):
            with self.subTest(code=code), patch("worker.governance_verification.fixture.bounded_process", return_value=(output, errors)):
                with self.assertRaisesRegex(ValueError, code): execute_fixture()

    def test_balanced_but_changed_fixed_fixture_is_not_pass(self):
        artifact = deepcopy(self.artifact)
        for row in artifact["ledger"]["postings"]:
            if row["amount"] == "50.125": row["amount"] = "51.125"
            elif row["amount"] == "-50.125": row["amount"] = "-51.125"
        self.assertEqual(check_artifact(artifact)["status"], "fail")

    def test_cross_scope_valuation_and_rehashed_flow_proofs_fail(self):
        for target in ("valuation", "flow", "quality"):
            with self.subTest(target=target):
                artifact = deepcopy(self.artifact)
                if target == "valuation":
                    artifact["valuations"][0]["run"]["portfolio_id"] = "wrong"
                else:
                    run = artifact["performance"]["run"]
                    manifest, result = strict_json(run["market_manifest"]), strict_json(run["result_json"])
                    key = "external_flow_evidence" if target == "flow" else "ledger_fact_quality"
                    proof = manifest[key][0]
                    proof["portfolio_id"] = "wrong"
                    proof["binding_id"] = content_hash({key: value for key, value in proof.items() if key != "binding_id"})
                    result[key] = manifest[key]
                    run["market_manifest"], run["result_json"] = canonical_json(manifest), canonical_json(result)
                self.assertEqual(check_artifact(artifact)["status"], "fail")

    def test_missing_audit_or_fake_execution_claim_rejected(self):
        artifact = deepcopy(self.artifact)
        artifact["ledger"]["audits"].pop()
        with self.assertRaisesRegex(ValueError, "SHAPE_INVALID"):
            check_artifact(artifact)
        artifact = deepcopy(self.artifact)
        artifact["status"] = "pass"
        with self.assertRaisesRegex(ValueError, "SHAPE_INVALID"):
            check_artifact(artifact)

    def test_duplicate_keys_non_integer_nan_limit_and_hash_rejected(self):
        for raw in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":1.0}', '{"x":1e0}', '{"x":9007199254740992}',
                    '{"x":"\\ud800"}', '{"\\ud800":1}', "[" * 65 + "0" + "]" * 65, "[" * 1000 + "0" + "]" * 1000,
                    b'\xff', b'\xef\xbb\xbf{}', '{}'.encode('utf-16'), '{}'.encode('utf-32')):
            with self.assertRaises(ValueError): strict_json(raw)
        nested = strict_json("[" * 64 + "0" + "]" * 64)
        for _ in range(64):
            nested = nested[0]
        self.assertEqual(nested, 0)
        self.assertEqual(strict_json('{"x":9007199254740991}')["x"], 9007199254740991)
        with self.assertRaisesRegex(ValueError, "BYTES_INVALID"):
            check_bytes(b"x" * (1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, "HASH_MISMATCH"):
            check_bytes(canonical_json(self.artifact).encode(), "0" * 64)

    def test_artifact_hash_binds_original_bytes_not_reserialized_json(self):
        canonical = canonical_json(self.artifact).encode()
        original = b" \n" + canonical + b"\n"
        self.assertEqual(check_bytes(original, sha256(original).hexdigest())["status"], "pass")
        with self.assertRaisesRegex(ValueError, "HASH_MISMATCH"):
            check_bytes(original, sha256(canonical).hexdigest())


class ControlledProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def run_program(self, code, **options):
        return bounded_process([sys.executable, "-I", "-c", code], environment=clean_environment(self.temp.name), cwd=ROOT, **options)

    def test_secrets_and_python_node_injection_environment_not_inherited(self):
        with patch.dict(os.environ, {"LONGPORT_APP_SECRET": "secret", "WORKBENCH_DB_PATH": "/private/actual.db",
                                     "NODE_OPTIONS": "--require /not-allowed", "PYTHONPATH": "/not-allowed"}):
            output, errors = self.run_program("import json,os;print(json.dumps(dict(os.environ)))")
        environment = strict_json(output)
        self.assertFalse(errors)
        self.assertNotIn("LONGPORT_APP_SECRET", environment)
        self.assertNotIn("WORKBENCH_DB_PATH", environment)
        self.assertNotIn("NODE_OPTIONS", environment)
        self.assertNotIn("PYTHONPATH", environment)

    def test_actual_output_limit_timeout_and_nonzero_exit(self):
        for code, options, error in (("print('x'*4096)", {"output_limit": 128}, "OUTPUT_LIMIT"),
                                      ("import sys;sys.stdout.write('x'*80);sys.stderr.write('x'*80)", {"output_limit": 128}, "OUTPUT_LIMIT"),
                                      ("import time;time.sleep(5)", {"timeout": .05}, "TIMEOUT"),
                                      ("raise SystemExit(7)", {}, "PROCESS_FAILED:7")):
            with self.subTest(error=error):
                with self.assertRaisesRegex(ValueError, error): self.run_program(code, **options)

    def test_health_failure_kills_running_child(self):
        def health(): raise ValueError("LEASE_LOST")
        with self.assertRaisesRegex(ValueError, "LEASE_LOST"):
            self.run_program("import time;time.sleep(5)", health=health)

    def test_health_failure_kills_descendants_in_same_process_group(self):
        marker = Path(self.temp.name) / "descendant-heartbeats"
        child = ("import pathlib,time;p=pathlib.Path(" + repr(str(marker)) + ");"
                 "exec('while True:\\n with p.open(\"a\") as f: f.write(\"x\"); f.flush()\\n time.sleep(.01)')")
        parent = "import subprocess,sys,time;subprocess.Popen([sys.executable,'-I','-c'," + repr(child) + "]);time.sleep(5)"
        def health():
            if marker.exists() and marker.stat().st_size:
                raise ValueError("LEASE_LOST")
        with self.assertRaisesRegex(ValueError, "LEASE_LOST"):
            self.run_program(parent, health=health)
        time.sleep(.05)
        size = marker.stat().st_size
        time.sleep(.1)
        self.assertEqual(marker.stat().st_size, size)

    def test_killed_child_synthetic_database_tree_is_parent_owned_and_removed(self):
        with tempfile.TemporaryDirectory(dir=self.temp.name) as home:
            marker = Path(home) / "child-directory"
            code = ("import pathlib,tempfile,time; p=pathlib.Path(tempfile.mkdtemp(prefix='synthetic-crash-'));"
                    "(p/'synthetic.db').touch();pathlib.Path(" + repr(str(marker)) + ").write_text(str(p));time.sleep(5)")
            def health():
                if marker.exists(): raise ValueError("LEASE_LOST")
            with self.assertRaisesRegex(ValueError, "LEASE_LOST"):
                bounded_process([sys.executable, "-I", "-c", code], environment=clean_environment(home), cwd=ROOT, health=health)
            child_directory = Path(marker.read_text())
            self.assertTrue(child_directory.is_relative_to(home))
            self.assertTrue((child_directory / "synthetic.db").exists())
        self.assertFalse(child_directory.exists())
