"""Real synthetic engine writes feed a separate, read-only Python verifier."""

from copy import deepcopy
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("mixed_workload_oracle", Path(__file__).with_name("mixed_workload_oracle.py"))
oracle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(oracle)

CREATE = r"""
import {createWorkbenchMixedFixture} from './scripts/workbench-mixed-fixture';
const directory=process.argv[1];
console.log(JSON.stringify(createWorkbenchMixedFixture({filename:directory+'/workbench.db',dataDir:directory+'/data',history:30,listings:10,marketRows:50})));
"""

EXECUTE = r"""
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mixedMarketRequest,mixedValuationRequest,mixedActivationRequest,mixedProposalRequest,mixedApprovalRequest,mixedCancelRequest,mixedLedgerRequest} from './scripts/workbench-mixed-fixture';
import {openWorkbench} from './src/server/workbench-db';
import {enqueueWorkbenchTask} from './src/server/workbench-commands';
import {executeGovernanceCommand} from './src/server/governance-commands';
import {recordFact} from './src/server/ledger/service';
import {requestCsvBackgroundPreview,requestCsvBackgroundConfirmation} from './src/server/csv-background/service';
import {getImportPreview} from './src/server/ledger/imports';
const f=JSON.parse(readFileSync(process.argv[1],'utf8')),stage=process.argv[2],python=process.argv[3];
const db=openWorkbench(f.filename),actor={id:'owner',kind:'human' as const},options={dataDir:f.dataDir,releaseHash:f.releaseHash};
const run=()=>execFileSync(python,['-m','worker.orchestration','--db',f.filename,'--once','--role','core'],{cwd:'..',env:{...process.env,WORKBENCH_DB_PATH:f.filename,WORKBENCH_DATA_DIR:f.dataDir},timeout:30000});
const queue=(command:any)=>{const r=enqueueWorkbenchTask(db,actor,command);run();const j=db.prepare('SELECT status,result_json FROM job_runs WHERE command_request_id=?').get(r.request_id) as any;if(j.status!=='succeeded')throw Error(j.status);return {request_id:r.request_id,result:JSON.parse(j.result_json)};};
const execute=(request:any)=>executeGovernanceCommand(db,actor,request.command,options) as any;
let out:any;
if(stage==='preview'){
 const account=f.ids.csv.account_ids[0];
 const mapping=JSON.stringify({schema_version:'csv-import-mapping-v1',mapping_id:'SYNTHETIC-MIXED-ORACLE',version:1,title:'Synthetic only',dialect:{encoding:'utf-8',delimiter:',',record_separator:'either'},expected_headers:['date','amount','id','note'],ignored_columns:[],account:{kind:'constant',value:account},event_type:{kind:'constant',value:'deposit'},source_id:'synthetic-mixed-csv',source_event_id:{kind:'column',column:'id',trim:false,empty:'reject'},reason:{kind:'column',column:'note',trim:false,empty:'reject'},effective_at:{column:'date',format:'YYYY-MM-DD',trim:false,source_timezone:'UTC'},rules:[{event_type:'deposit',fields:{currency:{kind:'constant',value:'CNY'},amount:{kind:'decimal',column:'amount',empty:'reject',format:{decimal_separator:'.',grouping_separator:'none',negative_style:'minus',allow_leading_plus:false,trim:false}}}}]});
 const bytes=Buffer.from('date,amount,id,note\n'+[1,2,3].map(n=>`${f.clock.effective_date},${n},synthetic-csv-${n},Synthetic row ${n}`).join('\n')+'\n');
 const r=requestCsvBackgroundPreview(db,{actorId:'owner',sessionHash:'a'.repeat(64)},{portfolio_id:f.ids.csv.portfolio_id,account_id:account,expected_revision:f.revisions.csv,idempotency_key:'oracle-preview',filename:'synthetic.csv',mapping,bytes,acknowledge_background_execution:true},options);run();
 // Commit a normal command whose response is intentionally not included in preview oracle inputs.
 const command=mixedLedgerRequest(f,0,f.revisions.ledger).command,receipt=recordFact(db,actor,command);
 const sha=(v:any)=>createHash('sha256').update(v).digest('hex');
 out={csv:{preview_request_id:r.request_id,confirm_request_id:null,rows:3,csv_sha256:sha(bytes),mapping_sha256:sha(mapping)},records:[{command,receipt}]};
}else{
 const previewRequest=process.argv[4];
 const result=JSON.parse((db.prepare('SELECT result_json FROM csv_background_results WHERE request_id=?').get(previewRequest) as any).result_json);
 const preview=getImportPreview(db,actor,f.ids.csv.portfolio_id,result.batch_id);
 const payload_text=JSON.stringify({action:'confirm_import',portfolio_id:f.ids.csv.portfolio_id,batch_id:result.batch_id,preview_hash:preview.preview_hash,expected_revision:preview.expected_revision,csv_review:{acknowledge_unverified_mapping:true,review_hash:preview.csv!.review_hash,rows:preview.csv!.required_review_rows.map(row=>({row,action:'record_distinct',reason:'Synthetic explicitly distinct occurrence'}))}});
 const confirmation=requestCsvBackgroundConfirmation(db,{actorId:'owner',sessionHash:'a'.repeat(64)},{portfolio_id:f.ids.csv.portfolio_id,account_id:f.ids.csv.account_ids[0],idempotency_key:'oracle-confirm',payload_text,acknowledge_background_execution:true},options);run();
 const markets=['approval','valuation','fx'].map((kind:any)=>queue(mixedMarketRequest(f,kind,0).command));
 const valuations=['approval','valuation'].map((kind:any)=>queue(mixedValuationRequest(f,kind,0).command));
 const activation=execute(mixedActivationRequest(f,valuations[0].result.valuation_id));
 const proposal=execute(mixedProposalRequest(f,activation.id,valuations[0].result.valuation_id,0));
 const approval=execute(mixedApprovalRequest(f,proposal,0)),cancel=execute(mixedCancelRequest(f,proposal.id,0));
 out={confirm_request_id:confirmation.request_id,approvals:[{proposal_id:proposal.id,approval_id:approval.id,cancel_id:cancel.id}],market_request_ids:markets.map(r=>r.request_id),valuation_request_ids:valuations.map(r=>r.request_id)};
}
db.pragma('wal_checkpoint(TRUNCATE)');db.close();console.log(JSON.stringify(out));
"""


class MixedWorkloadOracleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="mixed-oracle-source-")
        cls.directory = Path(cls.temporary.name)
        cls.fixture = cls.ts(CREATE, str(cls.directory))
        cls.fixture_path = cls.directory / "fixture.json"
        cls.fixture_path.write_text(json.dumps(cls.fixture))
        cls.base_input = {"schema_version": oracle.SCHEMA, "phase": "baseline", "fixture": cls.fixture,
                          "baseline": None, "csv": None, "records": [], "approvals": [], "market_request_ids": [], "valuation_request_ids": []}
        with oracle.readonly_database(cls.fixture["filename"]) as connection:
            cls.baseline = oracle.verify(connection, cls.base_input)["baseline"]
        preview = cls.ts(EXECUTE, str(cls.fixture_path), "preview", sys.executable)
        cls.preview_input = cls.base_input | {"phase": "preview", "baseline": cls.baseline, "csv": preview["csv"]}
        with patch.dict(os.environ, {"WORKBENCH_DATA_DIR": cls.fixture["dataDir"]}), oracle.readonly_database(cls.fixture["filename"]) as connection:
            cls.preview_result = oracle.verify(connection, cls.preview_input)
        complete = cls.ts(EXECUTE, str(cls.fixture_path), "complete", sys.executable, preview["csv"]["preview_request_id"])
        cls.complete_input = cls.preview_input | {"phase": "complete", "csv": preview["csv"] | {"confirm_request_id": complete.pop("confirm_request_id")}, "records": preview["records"], **complete}

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    @classmethod
    def ts(cls, source, *args):
        result = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "-e", source, *args], cwd=ROOT / "web", capture_output=True, text=True, timeout=90)
        if result.returncode:
            raise AssertionError(result.stderr or result.stdout)
        return json.loads(result.stdout)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mixed-oracle-test-")
        self.directory = Path(self.temporary.name)
        self.filename = self.directory / "workbench.db"
        shutil.copy2(self.fixture["filename"], self.filename)
        shutil.copytree(self.fixture["dataDir"], self.directory / "data")
        self.expected = deepcopy(self.complete_input)
        self.expected["fixture"]["filename"] = str(self.filename)
        self.expected["fixture"]["dataDir"] = str(self.directory / "data")
        self.environment = patch.dict(os.environ, {"WORKBENCH_DATA_DIR": str(self.directory / "data")})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def verify(self):
        with oracle.readonly_database(self.filename) as connection:
            return oracle.verify(connection, self.expected)

    def corrupt(self, table, sql, args=()):
        connection = sqlite3.connect(self.filename)
        for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?", (table,)).fetchall():
            connection.execute('DROP TRIGGER "' + name.replace('"', '""') + '"')
        connection.execute(sql, args)
        connection.commit()
        connection.close()

    def test_real_csv_market_valuation_and_approval_pipeline_is_independently_verified(self):
        result = self.verify()
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["csv"]["actual_facts"], 3)
        self.assertEqual(result["csv"]["actual_receipts"], 3)
        self.assertEqual(result["normal_fact_count"], 1)
        self.assertEqual(result["approval_count"], 1)
        self.assertEqual(result["cash"]["csv"], "331")
        self.assertEqual(result["cash"]["valuation"], "4899")
        self.assertIn("37642.5", [value["nav_cny"] for value in result["valuations"]])
        for key in ("performance_sla_passed", "production_verified", "real_gate_verified", "broker_network_absence_verified"):
            self.assertFalse(result[key])

    def test_preview_ignores_lagging_unrelated_http_receipts_but_proves_no_csv_facts(self):
        self.assertEqual(self.preview_result["csv"]["actual_facts"], 0)
        self.assertEqual(self.preview_result["csv"]["actual_receipts"], 0)
        self.assertIsNone(self.preview_result["normal_fact_count"])
        self.assertFalse(self.preview_result["runtime_request_coverage_verified"])
        self.expected.update(phase="preview", records=[], approvals=[], market_request_ids=[], valuation_request_ids=[])
        self.expected["csv"]["confirm_request_id"] = None
        with self.assertRaisesRegex(oracle.OracleError, "PREVIEW_WROTE_FINANCIAL_FACTS"):
            self.verify()

    def test_readonly_connection_and_cli_cannot_mutate_the_database(self):
        before = sha256(self.filename.read_bytes()).hexdigest()
        with oracle.readonly_database(self.filename) as connection:
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("UPDATE ledger_heads SET revision=revision+1")
        path = self.directory / "expected.json"
        path.write_text(json.dumps(self.expected))
        child = subprocess.run([sys.executable, str(Path(oracle.__file__)), "--db", str(self.filename), "--data-dir", str(self.directory / "data"), "--expected", str(path)], cwd=self.directory, capture_output=True, text=True, timeout=30)
        self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
        self.assertEqual(json.loads(child.stdout)["status"], "passed")
        self.assertEqual(sha256(self.filename.read_bytes()).hexdigest(), before)

    def test_expected_claims_and_missing_committed_requests_do_not_replace_evidence(self):
        self.expected["fixture"]["expected"]["valuation_nav_cny"] = "999999"
        with self.assertRaisesRegex(oracle.OracleError, "VALUATION_NAV_MISMATCH"):
            self.verify()
        self.expected = deepcopy(self.complete_input)
        self.expected["records"] = []
        with self.assertRaisesRegex(oracle.OracleError, "RECORD_COVERAGE_MISMATCH"):
            self.verify()

    def test_original_csv_attachment_corruption_fails_independent_receipt_proof(self):
        path = next((self.directory / "data/attachments").glob("*.csv"))
        path.write_bytes(b"synthetic corruption")
        with self.assertRaisesRegex(ValueError, "CSV_BACKGROUND_RECEIPT_INVALID"):
            self.verify()

    def test_original_input_hashes_and_position_projection_are_independent_checks(self):
        self.expected["csv"]["mapping_sha256"] = "0" * 64
        with self.assertRaisesRegex(oracle.OracleError, "CSV_ORIGINAL_INPUT_MISMATCH"):
            self.verify()
        self.expected["csv"]["mapping_sha256"] = self.complete_input["csv"]["mapping_sha256"]
        self.corrupt("position_projections", "UPDATE position_projections SET quantity='99'")
        with self.assertRaisesRegex(oracle.OracleError, "POSITION_PROJECTION_MISMATCH"):
            self.verify()

    def test_receipt_market_valuation_and_reservation_corruption_fail_closed(self):
        cases = [
            ("csv_import_outcomes", "UPDATE csv_import_outcomes SET result_json='{}' WHERE row_number=3", "CSV_BACKGROUND_RECEIPT_INVALID"),
            ("market_observations", "UPDATE market_observations SET value='99' WHERE source_id='synthetic-mixed-manual' AND metric='close'", "MARKET_MEMBER_CONTENT_MISMATCH"),
            ("market_publications", "UPDATE market_publications SET manifest_hash='" + "0" * 64 + "'", "MARKET_HEAD_MISMATCH"),
            ("valuation_runs", "UPDATE valuation_runs SET nav_cny='999999'", "VALUATION_REPLAY_MISMATCH"),
            ("reservations", "UPDATE reservations SET amount='1'", "RESERVATION_RELEASE_MISMATCH"),
        ]
        for table, sql, code in cases:
            with self.subTest(table=table):
                shutil.copy2(self.fixture["filename"], self.filename)
                self.corrupt(table, sql)
                with self.assertRaisesRegex(ValueError, code):
                    self.verify()

    def test_immutable_baseline_corruption_and_extra_input_fields_are_rejected(self):
        self.expected["status"] = "passed"
        with self.assertRaisesRegex(oracle.OracleError, "ORACLE_INPUT_INVALID"):
            self.verify()
        del self.expected["status"]
        self.corrupt("postings", "UPDATE postings SET amount='999' WHERE ledger_account='opening_equity'")
        with self.assertRaisesRegex(oracle.OracleError, "BASELINE_FACTS_CHANGED"):
            self.verify()

    def test_strict_json_rejects_duplicates_and_nonfinite_values(self):
        for raw in ('{"phase":"preview","phase":"complete"}', '{"x":NaN}'):
            with self.assertRaises(oracle.OracleError):
                oracle.strict_json(raw)


if __name__ == "__main__":
    unittest.main()
