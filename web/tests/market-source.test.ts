import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { canonical, createAccount, createPortfolio, hash, recordFact, revision } from "../src/server/ledger/service";
import { enqueueWorkbenchTask } from "../src/server/workbench-commands";
import { currentPublications } from "../src/server/governance/risk";
import type { Policy } from "../src/server/governance/schemas";
import { marketCollectScope, verifiedMarketSource, type MarketCollectRequest } from "../src/server/market-source";
import { performanceFreshness, valuationFreshness } from "../src/server/valuation-freshness";

const root = path.resolve(process.cwd(), "..");
const python = process.env.WORKBENCH_TEST_PYTHON ?? process.env.PYTHON ?? "python3";
const actor = { id: "synthetic-provider-test" };
const collection = String.raw`
import json,sys
from datetime import datetime,timedelta,timezone
from hashlib import sha256
from unittest.mock import patch
from tests.market.test_ecb_provider import xml
from worker.market.providers.ecb import URLS
from worker.market.batches import publish_batch
from worker.market import value_portfolio
from worker.performance import prepare_performance,persist_performance
from worker.orchestration.db import WorkbenchError,open_database,stamp
from worker.orchestration.runtime import run_pending_once
db=open_database(sys.argv[1]); args=json.loads(sys.argv[2])
def downloaded(feed):
 started=datetime.now(timezone.utc)
 day=(started-timedelta(days=2)).date().isoformat()
 raw=xml([(day,[('CNY','8.0000'),('USD','1.25'),('HKD','10.0')])])
 received=datetime.now(timezone.utc)
 return {'raw':raw,'raw_sha256':sha256(raw).hexdigest(),'raw_bytes':len(raw),'source_url':URLS[feed],
         'http_status':200,'redirects_followed':0,'started_at':stamp(started),'completed_at':stamp(received),
         'retrieved_at':stamp(received),'headers':{'content-type':'text/xml'}}
with patch('worker.market.collection.download_ecb_xml',side_effect=downloaded):
 job=run_pending_once(db,'synthetic-provider-worker')
assert job['status']=='succeeded',job['result_json']
result=json.loads(job['result_json'])
if args.get('publish_later'):
 try:
  publish_batch(db,result['batch_id'])
 except WorkbenchError as error:
  result['later_publish_error']=str(error)
 else:
  raise AssertionError('Provider publication outside its active command was accepted')
if args.get('valuations'):
 now=datetime.now(timezone.utc)
 rules={'schema_version':'valuation-rules-v1','approved':True,'approval_evidence':'Synthetic test rules only',
        'price_scope_by_market':{},'expected_sessions':{},'corporate_actions_complete':{},
        'fx_scope':args['scope'],'max_fx_age_seconds':604800}
 first=value_portfolio(db,args['portfolio'],args['start'],rules,mode='restated',now=now)
 last=value_portfolio(db,args['portfolio'],stamp(now),rules,mode='restated',now=now)
 prepared=prepare_performance(db,args['portfolio'],{'valuation_ids':[first['id'],last['id']],
   'evaluation_timezone':'UTC','flow_fx_rules':{'schema_version':'flow-fx-rules-v1','approved':True,
   'approval_evidence':'Synthetic reference-only evidence test','fx_scope':args['scope'],
   'max_fx_age_seconds':604800,'time_policy':'event_second_strict'}},now=now)
 saved=persist_performance(db,prepared,now=now)
 result.update(valuation_ids=[first['id'],last['id']],performance_id=saved['id'])
db.close();print(json.dumps(result))
`;
type Result = { capture_id: string; batch_id: string; receipt_hash: string; manifest_hash: string; later_publish_error?: string; valuation_ids?: string[]; performance_id?: string };
function fixture(options: { publish?: boolean; publishLater?: boolean; valuations?: boolean } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "provider-source-web-")), filename = path.join(directory, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, actor, "Synthetic source evidence");
  const payload: MarketCollectRequest = { provider: "ecb", feed: "daily", currencies: ["USD", "HKD", "CNY", "EUR"], expected_publication_revision: 0, publish: options.publish ?? true };
  const scope = marketCollectScope(payload), now = Date.now();
  const start = new Date(now - 120000).toISOString();
  if (options.valuations) {
    const account = createAccount(db, actor, portfolio, "Synthetic foreign cash", "Synthetic not a broker", "USD");
    for (const [key, effective, fact] of [
      ["opening", now - 4 * 86400000, { type: "opening_cash", account_id: account, currency: "USD", amount: "100" }],
      ["deposit", now - 60000, { type: "deposit", account_id: account, currency: "USD", amount: "10" }],
    ] as const) recordFact(db, actor, { portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: key, source_id: "synthetic", source_event_id: key, effective_at: new Date(effective).toISOString(), time_precision: "second", source_timezone: "UTC", reason: "Synthetic provider evidence test only", fact });
  }
  enqueueWorkbenchTask(db, actor, { portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: "synthetic-collection", command_type: "market_collect", payload });
  try {
    const result = JSON.parse(execFileSync(python, ["-c", collection, filename, JSON.stringify({ scope, portfolio, start, publish_later: options.publishLater, valuations: options.valuations })], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 })) as Result;
    return { db, directory, filename, portfolio, scope, result, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) { db.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
}
test("real Web queue and Python worker capture bind raw bytes, decoded rows, hashes and committed origin", () => {
  const f = fixture();
  try {
    assert.deepEqual(verifiedMarketSource(f.db, f.result.batch_id), { mode: "provider_observed", provider: "ecb", capture_id: f.result.capture_id, receipt_hash: f.result.receipt_hash, rate_kind: "reference_not_executable", capture_kind: "http_response_bytes", received_at: JSON.parse((f.db.prepare("SELECT receipt_json FROM market_provider_captures").get() as { receipt_json: string }).receipt_json).received_at });
    const policy = { price_scope_by_market: {}, fx_scope: f.scope } as Policy;
    assert.equal(currentPublications(f.db, policy, new Date(Date.now() + 1000).toISOString())[0].batch_id, f.result.batch_id);
    for (const table of ["ledger_events", "activations", "approval_events", "reservations"]) assert.equal((f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n, 0);
    const observations = f.db.prepare("SELECT published_at,time_precision,provenance FROM market_observations").all() as { published_at: null; time_precision: string; provenance: string }[];
    assert.equal(observations.length, 4);
    for (const row of observations) assert.deepEqual(row, { published_at: null, time_precision: "date", provenance: "live_observed" });
  } finally { f.close(); }
});
test("provider verification is a zero-write read under a live recovery marker", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "Synthetic restore guard\n");
    const before = f.db.prepare("SELECT total_changes() changes").get();
    assert.equal(verifiedMarketSource(f.db, f.result.batch_id).mode, "provider_observed");
    assert.deepEqual(f.db.prepare("SELECT total_changes() changes").get(), before);
  } finally { f.close(); }
});
test("a published capture proof is unavailable one microsecond before its worker commit", () => {
  const f = fixture();
  try {
    const { updated_at: finished } = f.db.prepare("SELECT updated_at FROM job_runs WHERE id=(SELECT job_id FROM market_provider_captures)").get() as { updated_at: string };
    const micros = BigInt(Date.parse(finished.slice(0, 19) + "Z")) * 1000n + BigInt(finished.slice(20, 26)) - 1n;
    const earlier = new Date(Number(micros / 1000n)).toISOString().slice(0, 19) + "." + (micros % 1000000n).toString().padStart(6, "0") + "Z";
    assert.throws(() => verifiedMarketSource(f.db, f.result.batch_id, earlier), /MARKET_PROVIDER_EVIDENCE_INVALID/);
    assert.equal(verifiedMarketSource(f.db, f.result.batch_id, finished).mode, "provider_observed");
  } finally { f.close(); }
});
test("capture without publication consent stays validated and cannot be published after its command ends", () => {
  const f = fixture({ publish: false, publishLater: true });
  try {
    assert.equal(f.result.later_publish_error, "PROVIDER_PUBLICATION_REQUIRES_ACTIVE_COMMAND");
    assert.equal((f.db.prepare("SELECT status FROM market_batches WHERE id=?").get(f.result.batch_id) as { status: string }).status, "validated");
    assert.equal((f.db.prepare("SELECT status FROM job_runs WHERE id=(SELECT job_id FROM market_provider_captures)").get() as { status: string }).status, "succeeded");
    for (const table of ["market_publications", "market_publication_events"]) assert.equal((f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n, 0);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM market_provider_captures").get() as { n: number }).n, 1);
    assert.throws(() => verifiedMarketSource(f.db, f.result.batch_id), /MARKET_PROVIDER_EVIDENCE_INVALID/);
  } finally { f.close(); }
});
test("tampered raw or capture hashes, missing worker receipt and forged source labels fail closed", () => {
  const f = fixture();
  try {
    const original = f.db.prepare("SELECT raw_body,receipt_json,receipt_hash,normalized_json,document_json FROM market_provider_captures").get() as { raw_body: Buffer; receipt_json: string; receipt_hash: string; normalized_json: string; document_json: string };
    f.db.exec("DROP TRIGGER provider_capture_no_update");
    const replace = (field: string, value: unknown) => f.db.prepare(`UPDATE market_provider_captures SET ${field}=?`).run(value);
    const changedRaw = Buffer.from(original.raw_body); changedRaw[0] ^= 1;
    for (const field of ["raw_body", "receipt_hash", "normalized_json", "document_json"] as const) {
      replace(field, field === "raw_body" ? changedRaw : field === "receipt_hash" ? "a".repeat(64) : field === "document_json" ? '{"schema_version":"market-provider-batch-v1"}' : "{}");
      assert.throws(() => verifiedMarketSource(f.db, f.result.batch_id), /MARKET_PROVIDER_EVIDENCE_INVALID/);
      replace(field, original[field]);
    }
    const receipt = JSON.parse(original.receipt_json); receipt.fencing_token += 1;
    replace("receipt_json", canonical(receipt)); replace("receipt_hash", hash(receipt));
    assert.throws(() => verifiedMarketSource(f.db, f.result.batch_id), /MARKET_PROVIDER_EVIDENCE_INVALID/);
    replace("receipt_json", original.receipt_json); replace("receipt_hash", original.receipt_hash);
    f.db.prepare("UPDATE job_runs SET result_json='{}' WHERE id=(SELECT job_id FROM market_provider_captures)").run();
    assert.throws(() => verifiedMarketSource(f.db, f.result.batch_id), /MARKET_PROVIDER_EVIDENCE_INVALID/);
    assert.throws(() => currentPublications(f.db, { price_scope_by_market: {}, fx_scope: f.scope } as Policy, new Date().toISOString()), /ACTUAL_DATA_NOT_VERIFIED/);
    assert.throws(() => verifiedMarketSource(f.db, "provider:ecb:forged"), /MARKET_PROVIDER_EVIDENCE_INVALID/);
  } finally { f.close(); }
});
test("captured reference FX can support restated NAV but cannot invent publication-time evidence for returns", () => {
  const f = fixture({ valuations: true });
  try {
    const values = f.result.valuation_ids!.map(id => f.db.prepare("SELECT * FROM valuation_runs WHERE id=?").get(id) as { id: string; market_manifest: string; ledger_revision: number; nav_cny: string; quality: string });
    assert.deepEqual(values.map(row => row.nav_cny), ["640", "704"]);
    for (const row of values) { assert.equal(row.quality, "complete"); assert.deepEqual(valuationFreshness(f.db, row, revision(f.db, f.portfolio)), []); }
    const performance = f.db.prepare("SELECT * FROM performance_runs WHERE id=?").get(f.result.performance_id) as { id: string; method_version: string; market_manifest: string; ledger_revision: number; quality: string; result_json: string };
    assert.equal(performance.method_version, "snapshot-performance-cny-v6"); assert.equal(performance.quality, "blocked");
    const manifest = JSON.parse(performance.market_manifest), result = JSON.parse(performance.result_json);
    assert.equal(manifest.schema_version, "performance-input-v6"); assert.equal(manifest.external_flow_evidence[0].schema_version, "flow-fx-evidence-v3");
    assert.equal(result.net_profit_cny, null); assert.equal(result.return, null);
    const issues = performanceFreshness(f.db, performance, revision(f.db, f.portfolio));
    assert.ok(!issues.includes("PERFORMANCE_METHOD_SUPERSEDED") && !issues.includes("INPUT_MANIFEST_INVALID"));
    assert.ok(issues.includes("FLOW_EVIDENCE_BLOCKED"));
    assert.ok(performanceFreshness(f.db, { ...performance, method_version: "snapshot-performance-cny-v5" }, revision(f.db, f.portfolio)).includes("INPUT_MANIFEST_INVALID"));
  } finally { f.close(); }
});
