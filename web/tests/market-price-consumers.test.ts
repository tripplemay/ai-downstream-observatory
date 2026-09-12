import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openWorkbench } from "../src/server/workbench-db";
import { hash, revision } from "../src/server/ledger/service";
import { valuationFreshness, performanceFreshness } from "../src/server/valuation-freshness";
import { currentPublications } from "../src/server/governance/risk";
import type { Policy } from "../src/server/governance/schemas";
import { publishMarketReference, readMarketReferenceVersion } from "../src/server/market-references/service";
import { priceInstant } from "../src/server/market-price-source";

const python = process.env.WORKBENCH_TEST_PYTHON ?? process.env.PYTHON ?? "python3", root = path.resolve(process.cwd(), "..");
const build = String.raw`
import json,sys,sqlite3
from tests.market.test_price_consumers import PriceConsumerTests
from worker.performance import persist_performance
from worker.orchestration.db import stamp
t=PriceConsumerTests();t.setUp()
try:
 snapshots=t.snapshots();p=persist_performance(t.db,t.performance(snapshots));result={'valuation_ids':[row['id'] for row in snapshots],'performance_id':p['id'],'calendar_id':t.calendar['id'],'publication':t.publication,'known_at':stamp()}
 target=sqlite3.connect(sys.argv[1]);t.db.backup(target);target.close();print(json.dumps(result))
finally:t.doCleanups()
`;
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sdk-consumers-web-")), filename = path.join(directory, "workbench.db");
  try {
    const result = JSON.parse(execFileSync(python, ["-c", build, filename], { cwd: root, encoding: "utf8" })) as { valuation_ids: string[]; performance_id: string; calendar_id: string; publication: { scope: string; batch_id: string }; known_at: string };
    const db = openWorkbench(filename);
    const valuations = () => result.valuation_ids.map(id => db.prepare("SELECT * FROM valuation_runs WHERE id=?").get(id) as { id: string; portfolio_id: string; market_manifest: string; ledger_revision: number; nav_cny: string; quality: string; cutoff_at: string; method_version: string; created_at: string });
    const performance = () => db.prepare("SELECT * FROM performance_runs WHERE id=?").get(result.performance_id) as { id: string; portfolio_id: string; market_manifest: string; ledger_revision: number; result_json: string; quality: string; method_version: string; created_at: string };
    return { db, result, filename, valuations, performance, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
test("genuine Python price NAV/performance pass Web evidence verification; current risk refuses another portfolio's private price scope", () => {
  const f = fixture(); try {
    const head = revision(f.db, "p");
    for (const row of f.valuations()) { assert.equal(row.nav_cny, "260.200000000000000002"); assert.deepEqual(valuationFreshness(f.db, row, head), []); }
    assert.deepEqual(performanceFreshness(f.db, f.performance(), head), []);
    const policy = { price_scope_by_market: { CN: f.result.publication.scope }, fx_scope: "synthetic-unused-fx" } as Policy;
    assert.equal(currentPublications(f.db, policy, f.result.known_at, "p").length, 1);
    for (const portfolio of [undefined, "other"]) assert.throws(() => currentPublications(f.db, policy, f.result.known_at, portfolio), /ACTUAL_DATA_NOT_VERIFIED/);
  } finally { f.close(); }
});
test("a new reviewed calendar makes present restated NAV and performance stale without rewriting frozen returns", () => {
  const f = fixture(); try {
    const prior = f.performance(), before = hash(prior), value = readMarketReferenceVersion(f.db, "p", f.result.calendar_id);
    const micros = priceInstant(f.result.known_at) + 1n, now = new Date(Number(micros / 1000n)).toISOString().slice(0, 19) + "." + (micros % 1000000n).toString().padStart(6, "0") + "Z";
    publishMarketReference(f.db, { id: "synthetic-human", kind: "human" }, { portfolio_id: "p", idempotency_key: "synthetic-calendar-v2", expected_version: 1, source_id: value.row.source_id, source_hash: value.row.source_hash, review_reason: "Synthetic later human review", acknowledgement: true, document: { kind: "calendar", facts: value.document.facts } }, { now });
    for (const row of f.valuations()) assert.ok(valuationFreshness(f.db, row, revision(f.db, "p")).some(code => code.startsWith("RESTATED_MARKET_REFERENCE_CHANGED:")));
    assert.ok(performanceFreshness(f.db, prior, revision(f.db, "p")).some(code => code.startsWith("RESTATED_MARKET_REFERENCE_CHANGED:")));
    assert.equal(hash(f.performance()), before);
    const replay = String.raw`import json,sys
from worker.orchestration.db import open_database
from worker.performance import prepare_performance
d=open_database(sys.argv[1]);p=prepare_performance(d,'p',{'valuation_ids':json.loads(sys.argv[2]),'evaluation_timezone':'Asia/Shanghai'});print(json.dumps({'quality':p.quality,'return':p.result['return']}));d.close()`;
    const result = JSON.parse(execFileSync(python, ["-c", replay, f.filename, JSON.stringify(f.result.valuation_ids)], { cwd: root, encoding: "utf8" }));
    assert.equal(result.quality, "complete"); assert.equal(result.return.value, "0");
  } finally { f.close(); }
});
