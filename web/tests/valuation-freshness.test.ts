import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { canonical, createAccount, createPortfolio, hash, recordFact, revision, type LedgerCommand } from "../src/server/ledger/service";
import { Decimal } from "../src/server/ledger/decimal";
import { correctLedger } from "../src/server/ledger/corrections";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { performanceFreshness, valuationFreshness } from "../src/server/valuation-freshness";
import { ledgerFactQualityAt } from "../src/server/ledger/fact-quality-db";

const approvedFlowRules = { schema_version: "flow-fx-rules-v1", approved: true, approval_evidence: "Synthetic fixture only", fx_scope: "FX", max_fx_age_seconds: 2592000, time_policy: "event_second_strict" };
const FlowDecimal = Decimal.clone({ precision: 80 });
function rebind(flow: Json): Json {
  const { binding_id: _, ...bound } = flow;
  return { ...bound, binding_id: hash(bound) };
}
function flowBinding(f: ReturnType<typeof fixture>, eventId: string, source: ReturnType<ReturnType<typeof fixture>["publish"]> | null, mode = "restated", patch: Json = {}): Json {
  const event = f.db.prepare("SELECT * FROM ledger_events WHERE id=?").get(eventId) as Json;
  const posting = f.db.prepare("SELECT * FROM postings WHERE event_id=? AND ledger_account='external_capital'").get(eventId) as Json;
  const native = new Decimal(String(posting.amount)).neg().toFixed();
  const observationRow = source ? f.db.prepare("SELECT * FROM market_observations WHERE id=?").get(source.observation) as Json : null;
  const observation = observationRow ? Object.fromEntries(Object.entries(observationRow).filter(([, value]) => value !== null)) : null;
  const validation = source ? JSON.parse((f.db.prepare("SELECT validation_json FROM market_batches WHERE id=?").get(source.publication.batch_id) as { validation_json: string }).validation_json) : null;
  const at = String(event.effective_at);
  const rate = observation ? new Decimal(String(observation.value)).toFixed() : "1";
  return rebind({ schema_version: "flow-fx-evidence-v2", flow_kind: "cash", security: null, portfolio_id: f.portfolio, event_id: event.id, posting_id: posting.id,
    event_payload_hash: event.payload_hash, event_hash: hash(event), posting_hash: hash(posting), event_ledger_revision: event.ledger_revision,
    currency: posting.currency, amount_native: native, effective_at: event.effective_at, time_precision: event.time_precision, source_timezone: event.source_timezone,
    flow_time: at, evaluation_date: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(at)),
    mode, knowledge_at: source ? mode === "restated" ? "2026-01-10T00:00:00.000Z" : at : null,
    rules_hash: source ? hash(approvedFlowRules) : null, publication: source?.publication ?? null, observation, observation_hash: observation ? hash(observation) : null,
    source_validation_hash: validation ? hash(validation) : null, source_mode: validation?.plan.source_mode ?? null, source_evidence: validation?.plan.source_evidence ?? null,
    fx_rate: rate, amount_cny: new FlowDecimal(native).mul(rate).toFixed(), quality: "complete", issues: [], ...patch });
}
function persistFlows(f: ReturnType<typeof fixture>, values: ReturnType<ReturnType<typeof fixture>["snapshot"]>[], flows: Json[], patch: Json = {}, resultFlows: unknown = flows) {
  return f.performance(values, { external_flow_evidence: flows, ...patch }, resultFlows);
}
function flowScenario(options: { mode?: string; currency?: string; amount?: string; rate?: string; effective?: string } = {}) {
  const f = fixture(), mode = options.mode ?? "restated";
  const source = f.publish("FX", undefined, "2026-01-05T00:00:00.000Z", "second", "UTC", { value: options.rate ?? "7", sourceMode: "manual_verified", provenance: "historical_point_in_time", currency: options.currency ?? "USD" });
  const event = f.addFlow(options.currency ?? "USD", options.amount ?? "1", options.effective);
  const values = [f.snapshot({ kind: "cash", mode, publications: {}, cutoff: "2026-01-05T13:00:00.000Z" }), f.snapshot({ kind: "cash", mode, publications: {}, cutoff: "2026-01-07T13:00:00.000Z" })];
  const evidence = flowBinding(f, event.event_id, source, mode);
  const persist = (flows: Json[] = [evidence], patch: Json = {}, resultFlows: unknown = flows) => {
    const heads = f.db.prepare("SELECT revision,manifest_hash FROM market_publications WHERE scope='FX'").get();
    return persistFlows(f, values, flows, { flow_fx_rules: approvedFlowRules, flow_fx_rules_hash: hash(approvedFlowRules), market_heads: { FX: heads }, ...patch }, resultFlows);
  };
  return { ...f, mode, source, event, values, evidence, persist };
}

test("foreign flows alone consume FX scope and preserve exact USD/HKD decimal conversion", () => {
  for (const currency of ["USD", "HKD"]) {
    const f = flowScenario({ currency, amount: "0.000000000000000003", rate: "7.123456789012345678" });
    try {
      assert.equal(f.evidence.amount_cny, "0.000000000000000021370370367037037034");
      const run = f.persist();
      assert.deepEqual(performanceFreshness(f.db, run, revision(f.db, f.portfolio)), []);
      f.publish("CN");
      assert.deepEqual(performanceFreshness(f.db, run, revision(f.db, f.portfolio)), []);
      f.publish("FX", undefined, "2026-01-06T00:00:00.000Z", "second", "UTC", { sourceMode: "manual_verified", provenance: "live_observed", currency, knownAt: "2026-01-11T00:00:00.000Z" });
      assert.deepEqual(performanceFreshness(f.db, run, revision(f.db, f.portfolio)), ["RESTATED_MARKET_CHANGED:FX"]);
    } finally { f.close(); }
  }
});

test("flow bindings enforce original posting/event hashes, amount, identity and full coverage", () => {
  const f = flowScenario();
  try {
    const rev = revision(f.db, f.portfolio);
    for (const patch of [{ event_hash: "a".repeat(64) }, { posting_hash: "b".repeat(64) }, { event_payload_hash: "c".repeat(64) }, { currency: "HKD" }, { amount_native: "2" }, { event_ledger_revision: 0 }, { portfolio_id: "other" }, { source_timezone: "Asia/Shanghai" }, { fx_rate: "8" }, { amount_cny: "8" }, { evaluation_date: "2026-01-07" }]) {
      assert.ok(performanceFreshness(f.db, f.persist([rebind({ ...f.evidence, ...patch })]), rev).some(reason => reason.startsWith("FLOW_")));
    }
    assert.ok(performanceFreshness(f.db, f.persist([{ ...f.evidence, binding_id: "a".repeat(64) }]), rev).includes("FLOW_EVIDENCE_INVALID"));
    assert.ok(performanceFreshness(f.db, f.persist([]), rev).includes("FLOW_EVIDENCE_COVERAGE_INVALID"));
    assert.ok(performanceFreshness(f.db, f.persist([f.evidence, f.evidence]), rev).includes("FLOW_EVIDENCE_COVERAGE_INVALID"));
    assert.ok(performanceFreshness(f.db, f.persist([f.evidence], {}, []), rev).includes("FLOW_EVIDENCE_INVALID"));
    assert.ok(performanceFreshness(f.db, f.persist([f.evidence], { market_heads: {} }), rev).includes("FLOW_FX_EVIDENCE_INVALID"));
    assert.ok(performanceFreshness(f.db, f.persist([f.evidence], { flow_fx_rules_hash: "a".repeat(64) }), rev).includes("FLOW_FX_RULES_INVALID"));
    const unapproved = { ...approvedFlowRules, approved: false };
    assert.ok(performanceFreshness(f.db, f.persist([rebind({ ...f.evidence, rules_hash: hash(unapproved) })], { flow_fx_rules: unapproved, flow_fx_rules_hash: hash(unapproved) }), rev).includes("FLOW_FX_RULES_INVALID"));
  } finally { f.close(); }
});

test("foreign flow FX scope must match actually consumed NAV FX, not unused configuration", () => {
  for (const consumed of [false, true]) {
    const f = flowScenario();
    try {
    const source = f.publish("FX_NAV", undefined, "2026-01-05T00:00:00.000Z", "second", "UTC", { currency: "USD" });
    const rules = { ...f.rules, fx_scope: "FX_NAV" };
    const manifest = { schema_version: "valuation-input-v3", mode: "restated", rules, rules_hash: hash(rules), publications: { FX_NAV: source.publication } };
      if (!consumed) recordFact(f.db, { id: "SYNTHETIC" }, { portfolio_id: f.portfolio, expected_revision: 1, idempotency_key: randomUUID(), source_id: "synthetic-fee", reason: "Synthetic fee exhausts cash, not an external withdrawal", effective_at: "2026-01-06T01:00:00.000Z", time_precision: "second", source_timezone: "UTC", fact: { type: "fee", account_id: f.account, currency: "USD", amount: "1" } }, "2026-01-06T12:00:00.000Z");
      const values = ["2026-01-05T13:00:00.000Z", "2026-01-07T13:00:00.000Z"].map(at => f.snapshot({ kind: "cash", manifest, cutoff: at, refs: { fx_observation_id: source.observation } }));
      const heads = { FX: { revision: f.source.publication.revision, manifest_hash: f.source.publication.manifest_hash }, ...(consumed ? { FX_NAV: { revision: source.publication.revision, manifest_hash: source.publication.manifest_hash } } : {}) };
      const run = persistFlows(f, values, [f.evidence], { flow_fx_rules: approvedFlowRules, flow_fx_rules_hash: hash(approvedFlowRules), market_heads: heads });
      assert.deepEqual(performanceFreshness(f.db, run, revision(f.db, f.portfolio)), consumed ? ["INCOMPATIBLE_FLOW_FX_SOURCE:USD"] : []);
    } finally { f.close(); }
  }
});

test("as-known flow evidence ignores future heads but rejects revisions known before period end", () => {
  for (const knownAt of ["2026-01-06T12:00:00.000Z", "2026-01-08T12:00:00.000Z"]) {
    const f = flowScenario({ mode: "as_known" });
    try {
      const run = f.persist();
      assert.deepEqual(performanceFreshness(f.db, run, 1), []);
      f.publish("FX", undefined, "2026-01-05T00:00:00.000Z", "second", "UTC", { value: "8", knownAt, sourceMode: "manual_verified", provenance: "historical_point_in_time" });
      const issues = performanceFreshness(f.db, run, 1);
      if (knownAt.startsWith("2026-01-06")) assert.ok(issues.includes("FLOW_FX_KNOWLEDGE_CHANGED_RESTATE_REQUIRED"));
      else assert.deepEqual(issues, []);
    } finally { f.close(); }
  }
});

test("flow PIT refuses microsecond-future quotes, excess age and wrong source evidence", () => {
  const f = flowScenario();
  try {
    const rev = revision(f.db, f.portfolio);
    for (const patch of [{ knowledge_at: "2026-01-11T00:00:00.000Z" }, { knowledge_at: "2026-01-06T00:00:00.000Z" }]) assert.ok(performanceFreshness(f.db, f.persist([rebind({ ...f.evidence, ...patch })]), rev).includes("FLOW_FX_PIT_INVALID"));
    for (const patch of [{ observation_hash: "a".repeat(64) }, { source_validation_hash: "b".repeat(64) }, { source_evidence: "Forged source" }, { source_mode: "synthetic" }]) assert.ok(performanceFreshness(f.db, f.persist([rebind({ ...f.evidence, ...patch })]), rev).some(reason => reason.startsWith("FLOW_FX_")));
    const staleRules = { ...approvedFlowRules, max_fx_age_seconds: 1 };
    assert.ok(performanceFreshness(f.db, f.persist([rebind({ ...f.evidence, rules_hash: hash(staleRules) })], { flow_fx_rules: staleRules, flow_fx_rules_hash: hash(staleRules) }), rev).includes("FLOW_FX_PIT_INVALID"));
    const future = f.publish("FX", undefined, "2026-01-06T00:00:00.000001Z", "second", "UTC", { value: "7", sourceMode: "manual_verified", provenance: "historical_point_in_time" });
    assert.ok(performanceFreshness(f.db, f.persist([flowBinding(f, f.event.event_id, future)]), rev).includes("FLOW_FX_PIT_INVALID"));
  } finally { f.close(); }
});

test("a synthetically sourced or reconstructed FX rate cannot certify a complete external flow", () => {
  for (const sourceMode of ["synthetic", "manual_verified"]) {
    const f = flowScenario();
    try {
      const source = f.publish("FX", undefined, "2026-01-05T00:00:00.000Z", "second", "UTC", { sourceMode, provenance: sourceMode === "synthetic" ? "live_observed" : "reconstructed" });
      assert.ok(performanceFreshness(f.db, f.persist([flowBinding(f, f.event.event_id, source)]), 1).includes("FLOW_FX_SOURCE_UNVERIFIED"));
    } finally { f.close(); }
  }
});

const now = "2026-01-05T12:00:00.000Z";

test("CNY deposits/withdrawals need no FX metadata and signed amounts remain exact", () => {
  const f = fixture();
  try {
    const deposit = f.addFlow("CNY", "10"), withdrawal = f.addFlow("CNY", "3", "2026-01-06T01:00:00.000Z", "second", "UTC", "withdrawal");
    const values = [f.snapshot({ kind: "cash", publications: {} }), f.snapshot({ kind: "cash", publications: {}, cutoff: "2026-01-07T13:00:00.000Z" })];
    const flows = [flowBinding(f, deposit.event_id, null), flowBinding(f, withdrawal.event_id, null)];
    assert.equal(flows[1].amount_native, "-3");
    assert.equal(flows[1].amount_cny, "-3");
    assert.deepEqual(performanceFreshness(f.db, persistFlows(f, values, flows), 2), []);
    assert.ok(performanceFreshness(f.db, persistFlows(f, values, [flows[0]]), 2).includes("FLOW_EVIDENCE_COVERAGE_INVALID"));
    assert.ok(performanceFreshness(f.db, persistFlows(f, values, [flows[0], rebind({ ...flows[1], amount_cny: "3" })]), 2).includes("FLOW_EVIDENCE_INVALID"));
  } finally { f.close(); }
});

test("voided external postings cannot reappear, and an empty post-void flow set remains valid", () => {
  const f = flowScenario();
  try {
    const attachment = storeJsonAttachment(f.db, { id: "synthetic" }, { portfolio_id: f.portfolio, account_id: f.account, raw: JSON.stringify({ fixture: "Synthetic void approval only" }) }, { dataDir: f.dir, now: "2026-01-06T13:00:00.000Z" });
    correctLedger(f.db, { id: "synthetic" }, { portfolio_id: f.portfolio, expected_revision: 1, idempotency_key: "void-flow", attachment_id: attachment.id, reason: "Synthetic void only", changes: [{ action: "void", event_id: f.event.event_id }] }, { dataDir: f.dir, now: "2026-01-06T13:00:00.000Z" });
    const values = [f.snapshot({ kind: "cash", publications: {}, cutoff: "2026-01-05T13:00:00.000Z" }), f.snapshot({ kind: "cash", publications: {}, cutoff: "2026-01-07T13:00:00.000Z" })];
    const rev = revision(f.db, f.portfolio);
    assert.ok(performanceFreshness(f.db, persistFlows(f, values, [f.evidence]), rev).includes("FLOW_EVIDENCE_COVERAGE_INVALID"));
    assert.deepEqual(performanceFreshness(f.db, persistFlows(f, values, []), rev), []);
  } finally { f.close(); }
});

test("date-only foreign flow overlapping a terminal intraday snapshot cannot disappear", () => {
  const f = fixture();
  try {
    const event = f.addFlow("USD", "1", "2026-01-06", "date", "America/New_York");
    const values = [f.snapshot({ kind: "cash", publications: {}, cutoff: "2026-01-05T13:00:00.000Z" }), f.snapshot({ kind: "cash", publications: {}, cutoff: "2026-01-06T17:00:00.000Z" })];
    const flow = flowBinding(f, event.event_id, null, "restated", { flow_time: null, evaluation_date: null, rules_hash: hash(approvedFlowRules), fx_rate: null, amount_cny: null, quality: "blocked", issues: ["FLOW_TIME_PRECISION_UNSUPPORTED"] });
    const patch = { flow_fx_rules: approvedFlowRules, flow_fx_rules_hash: hash(approvedFlowRules) };
    assert.ok(performanceFreshness(f.db, persistFlows(f, values, [flow], patch), 1).includes("FLOW_EVIDENCE_BLOCKED"));
    assert.ok(performanceFreshness(f.db, persistFlows(f, values, [], patch), 1).includes("FLOW_EVIDENCE_COVERAGE_INVALID"));
    const inventedTime = rebind({ ...flow, flow_time: "2026-01-06T16:00:00.000Z", evaluation_date: "2026-01-07", quality: "complete", issues: [], fx_rate: "7", amount_cny: "7" });
    assert.ok(performanceFreshness(f.db, persistFlows(f, values, [inventedTime], patch), 1).includes("FLOW_EVIDENCE_INVALID"));
  } finally { f.close(); }
});

test("CNY date-only EOD follows source timezone while evaluation date follows the report timezone", () => {
  const f = fixture();
  try {
    const event = f.addFlow("CNY", "1", "2026-01-06", "date", "America/New_York");
    const values = [f.snapshot({ kind: "cash", publications: {}, cutoff: "2026-01-05T13:00:00.000Z" }), f.snapshot({ kind: "cash", publications: {}, cutoff: "2026-01-07T13:00:00.000Z" })];
    const flow = flowBinding(f, event.event_id, null, "restated", { flow_time: "2026-01-07T05:00:00.000000Z", evaluation_date: "2026-01-07" });
    assert.deepEqual(performanceFreshness(f.db, persistFlows(f, values, [flow]), 1), []);
    assert.ok(performanceFreshness(f.db, persistFlows(f, values, [rebind({ ...flow, evaluation_date: "2026-01-06" })]), 1).includes("FLOW_EVIDENCE_INVALID"));
  } finally { f.close(); }
});

test("Python-produced v5 evidence, 60-digit NAV and full-precision external-flow products independently verify in Web", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "freshness-cross-language-"));
  try {
    for (const amount of ["100.000000000000000001", "12345678901234567890.123456789012345678"]) {
      const filename = path.join(dir, randomUUID() + ".db");
      const script = [
        "import json,sqlite3,sys",
        "from tests.performance.test_flow_fx import FlowFxTests",
        "from tests.market.support import NOW,rules",
        "from worker.market import value_portfolio",
        "from worker.orchestration.db import stamp",
        "from worker.performance import persist_performance",
        "from decimal import Decimal,localcontext",
        "case=FlowFxTests(); case.setUp()",
        "try:",
        " case.add_flow(amount=sys.argv[2])",
        " case.publish(case.fx_document(value='98765432109876543210.987654321098765432'))",
        " with localcontext() as ctx:",
        "  ctx.prec=60; terminal=format(Decimal('100')+Decimal(sys.argv[2])*Decimal('98765432109876543210.987654321098765432'),'f')",
        " config=rules(); config.update(fx_scope='fx:flows',max_fx_age_seconds=2592000)",
        " snapshots=[value_portfolio(case.db,'p',stamp(at),config,'restated',now=NOW) for at in (case.start,case.end)]",
        " assert snapshots[-1]['nav_cny']==terminal,snapshots",
        " prepared=case.prepare(ids=tuple(row['id'] for row in snapshots))",
        " result=persist_performance(case.db,prepared,now=NOW)",
        " target=sqlite3.connect(sys.argv[1]); case.db.backup(target); target.close()",
        " print(json.dumps({'id':result['id'],'quality':result['quality']}))",
        "finally:",
        " case.doCleanups()",
      ].join("\n");
      const result = JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", script, filename, amount], { cwd: path.resolve(".."), encoding: "utf8" }));
      assert.notEqual(result.quality, "blocked");
      const db = openWorkbench(filename);
      try {
        const run = db.prepare("SELECT * FROM performance_runs WHERE id=?").get(result.id) as { id: string; ledger_revision: number; method_version: string; market_manifest: string };
        assert.deepEqual(performanceFreshness(db, run, run.ledger_revision), []);
      } finally { db.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
type Json = Record<string, unknown>;
type Publication = { scope: string; revision: number; batch_id: string; manifest_hash: string; published_at: string };
function fixture(holding: "price" | "fx" | "cash" = "cash") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "freshness-fixture-"));
  const filename = path.join(dir, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), actor = { id: "SYNTHETIC-TEST", kind: "human" as const };
  const portfolio = createPortfolio(db, actor, "SYNTHETIC TEST ONLY", now);
  const account = createAccount(db, actor, portfolio, "Synthetic", "No live broker", "CNY", now);
  db.prepare("INSERT INTO instruments(id,name,asset_class,created_at) VALUES('i','Synthetic ETF','ETF',?)").run(now);
  for (const id of ["l", "other"]) db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,quantity_step,price_step,status,created_at) VALUES(?,'i','CN','SSE',?,'CNY','1','0.01','active',?)").run(id, id, now);
  if (holding === "price") recordFact(db, actor, { portfolio_id: portfolio, expected_revision: 0, idempotency_key: "opening-stock", source_id: "synthetic", effective_at: "2026-01-01", time_precision: "date", source_timezone: "UTC", reason: "Synthetic quantity evidence", fact: { type: "opening_position", account_id: account, listing_id: "l", currency: "CNY", quantity: "1", cost_amount: "100" } }, now);
  if (holding === "fx") recordFact(db, actor, { portfolio_id: portfolio, expected_revision: 0, idempotency_key: "opening-fx", source_id: "synthetic", effective_at: "2026-01-01", time_precision: "date", source_timezone: "UTC", reason: "Synthetic cash evidence", fact: { type: "opening_cash", account_id: account, currency: "USD", amount: "100" } }, now);
  const rules = { schema_version: "valuation-rules-v1", approved: true, approval_evidence: "SYNTHETIC TEST ONLY",
    price_scope_by_market: { CN: "CN" }, expected_sessions: { CN: "2026-01-05" },
    corporate_actions_complete: { l: true, other: true }, fx_scope: "FX", max_fx_age_seconds: 86400 };
  const publish = (scope: string, unit?: string, observed = "2026-01-05T00:00:00.000Z", precision = "second", zone = "UTC", options: { value?: string; knownAt?: string; sourceMode?: string; provenance?: string; currency?: string } = {}) => {
    const batch = randomUUID(), observation = randomUUID(), fx = scope.startsWith("FX");
    db.prepare("INSERT INTO market_batches(id,source_id,batch_type,scope,status,expected_pages,validation_json,started_at) VALUES(?,'fixture',?,?,'staging',1,?,?)")
      .run(batch, fx ? "fx" : "prices", scope, canonical({ plan: { source_id: "fixture", scope, source_mode: options.sourceMode ?? "manual_verified", source_evidence: "Synthetic fixture; no actual FX authorization" } }), options.knownAt ?? now);
    db.prepare("INSERT INTO market_observations(id,batch_id,source_id,listing_id,series_key,metric,value,unit,observed_at,published_at,ingested_at,time_precision,source_timezone,price_basis,revision_id,raw_hash,parser_version,provenance) VALUES(?,?,'fixture',?,?,?,?,?,? ,?,?,?,?,?,?,?,'fixture',?)")
      .run(observation, batch, fx ? null : "l", fx ? "FX:" + (options.currency ?? "USD") : "l", fx ? "fx_cny_per_unit" : "close", options.value ?? "100",
        unit ?? (fx ? "CNY_per_unit_currency" : "CNY"), observed, options.knownAt ?? now, options.knownAt ?? now, precision, zone,
        fx ? "not_applicable" : "unadjusted", batch, "a".repeat(64), options.provenance ?? "live_observed");
    db.prepare("INSERT INTO market_batch_members(batch_id,observation_id) VALUES(?,?)").run(batch, observation);
    const manifest = hash({ batch, observation });
    db.prepare("UPDATE market_batches SET status='validated',manifest_hash=? WHERE id=?").run(manifest, batch);
    const previous = db.prepare("SELECT revision FROM market_publications WHERE scope=?").get(scope) as { revision: number } | undefined;
    const publication: Publication = { scope, revision: (previous?.revision ?? 0) + 1, batch_id: batch, manifest_hash: manifest, published_at: options.knownAt ?? now };
    db.prepare("INSERT INTO market_publication_events(scope,revision,batch_id,manifest_hash,published_at) VALUES(?,?,?,?,?)").run(scope, publication.revision, batch, manifest, publication.published_at);
    db.prepare("INSERT INTO market_publications(scope,revision,batch_id,manifest_hash,published_at) VALUES(?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,batch_id=excluded.batch_id,manifest_hash=excluded.manifest_hash,published_at=excluded.published_at").run(scope, publication.revision, batch, manifest, publication.published_at);
    db.prepare("UPDATE market_batches SET status='published' WHERE id=?").run(batch);
    return { publication, observation };
  };
  const cn = publish("CN"), fx = publish("FX");
  let snapshotCounter = 0;
  const snapshot = (options: { mode?: string; kind?: "price" | "fx" | "cash"; refs?: unknown; publications?: Json; manifest?: unknown; currency?: string; listing?: string; method?: string; nav?: string; allowInvalidNav?: boolean; noItems?: boolean; cutoff?: string; knowledgeAt?: string; portfolio?: string } = {}) => {
    const id = randomUUID(), mode = options.mode ?? "restated", kind = options.kind ?? holding;
    const target = options.portfolio ?? portfolio, rev = revision(db, target), cutoff = options.cutoff ?? new Date(Date.parse("2026-01-05T13:00:00.000Z") + ++snapshotCounter * 1000).toISOString();
    const proof = ledgerFactQualityAt(db, target, cutoff, options.knowledgeAt ?? (mode === "as_known" ? cutoff : "2026-01-10T00:00:00.000Z"), mode as "restated" | "as_known", rev);
    const ledger = db.prepare("SELECT * FROM ledger_events WHERE portfolio_id=? AND ledger_revision<=?").all(target, rev) as { id: string; reversal_of: string | null; event_type: string; effective_at: string; recorded_at: string; time_precision: string; source_timezone: string }[];
    const included = ledger.filter(row => !(mode === "as_known" && Date.parse(row.recorded_at) > Date.parse(cutoff)) && (row.time_precision === "date" ? row.effective_at <= new Intl.DateTimeFormat("en-CA", { timeZone: row.source_timezone }).format(new Date(cutoff)) : Date.parse(row.effective_at) <= Date.parse(cutoff)));
    const reversed = new Set(included.map(row => row.reversal_of));
    const initialized = included.some(row => !reversed.has(row.id) && !["reversal", "corporate_action_notice", "corporate_action_resolution"].includes(row.event_type));
    const quality = initialized ? proof.nav_quality : "blocked";
    const publications = { ...(options.publications ?? { CN: cn.publication, FX: fx.publication }) };
    const manifest = options.manifest && typeof options.manifest === "object" && (options.manifest as Json).schema_version === "valuation-input-v3"
      ? { ...options.manifest, ledger_fact_quality: proof } : options.manifest ?? { schema_version: "valuation-input-v3", mode, rules, rules_hash: hash(rules), publications, ledger_fact_quality: proof };
    const itemRows: { account: string; listing: string | null; type: string; currency: string; amount: string; fx: string; value: string; refs: unknown }[] = [];
    if (!options.noItems) {
      const totals = new Map<string, Decimal>();
      const monetary = new Set(["cash_settled", "trade_receivable", "trade_payable", "dividend_receivable", "dividend_tax_payable", "transfer_in_transit"]);
      const rows = db.prepare("SELECT p.*,e.effective_at,e.time_precision,e.source_timezone,e.recorded_at FROM postings p JOIN ledger_events e ON e.id=p.event_id WHERE e.portfolio_id=? AND e.ledger_revision<=?").all(target, rev) as { account_id: string; currency: string; ledger_account: string; amount: string; effective_at: string; time_precision: string; source_timezone: string; recorded_at: string }[];
      for (const row of rows) {
        if (!monetary.has(row.ledger_account) || (mode === "as_known" && Date.parse(row.recorded_at) > Date.parse(cutoff))) continue;
        const included = row.time_precision === "date" ? row.effective_at <= new Intl.DateTimeFormat("en-CA", { timeZone: row.source_timezone }).format(new Date(cutoff)) : Date.parse(row.effective_at) <= Date.parse(cutoff);
        if (included) { const key = canonical([row.account_id, row.currency, row.ledger_account]); totals.set(key, (totals.get(key) ?? new Decimal(0)).add(row.amount)); }
      }
      // Only the malformed-input branches create an unmatched item; ordinary snapshots derive every cash leg.
      if (kind === "fx" && ![...totals.keys()].some(key => JSON.parse(key)[1] === "USD")) totals.set(canonical([account, "USD", "cash_settled"]), new Decimal(100));
      for (const [key, total] of totals) {
        if (total.isZero()) continue;
        const [owner, native, type] = JSON.parse(key) as string[], currency = options.currency ?? native;
        const scope = (manifest as { rules?: { fx_scope?: string } })?.rules?.fx_scope ?? "FX";
        let observation = db.prepare("SELECT o.id,o.value,p.scope,p.revision,p.batch_id,p.manifest_hash,p.published_at FROM market_observations o JOIN market_batch_members m ON m.observation_id=o.id JOIN market_publications p ON p.batch_id=m.batch_id WHERE p.scope=? AND o.series_key=? LIMIT 1").get(scope, "FX:" + currency) as { id: string; value: string } & Publication | undefined;
        if (kind === "fx" && options.refs === undefined) observation = db.prepare("SELECT id,value FROM market_observations WHERE id=?").get(fx.observation) as typeof observation;
        const refs = options.refs ?? { ledger_revision: rev, ...(currency === "CNY" ? {} : { fx_observation_id: observation?.id }) };
        const evidence = typeof refs === "object" && refs !== null && !Array.isArray(refs) ? { ledger_revision: rev, ...refs } : refs;
        const bound = (evidence as Json)?.fx_observation_id;
        const rate = currency === "CNY" ? "1" : (typeof bound === "string" ? (db.prepare("SELECT value FROM market_observations WHERE id=?").get(bound) as { value: string } | undefined)?.value : undefined) ?? "1";
        if (kind === "cash" && currency !== "CNY" && observation && !options.manifest) publications[scope] = { scope: observation.scope, revision: observation.revision, batch_id: observation.batch_id, manifest_hash: observation.manifest_hash, published_at: observation.published_at };
        itemRows.push({ account: owner, listing: null, type, currency, amount: total.toFixed(), fx: rate, value: total.mul(rate).toFixed(), refs: evidence });
      }
      if (kind === "price") itemRows.push({ account, listing: options.listing ?? "l", type: "security_market_value", currency: options.currency ?? "CNY", amount: "100", fx: "1", value: "100", refs: options.refs ?? { quantity: "1", price_observation_id: cn.observation } });
    }
    db.prepare("INSERT INTO valuation_runs(id,portfolio_id,ledger_revision,market_manifest,method_version,cutoff_at,quality,nav_cny,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, target, rev, canonical(manifest), options.method ?? "decimal-nav-cny-v4:" + mode, cutoff, quality,
        quality !== "complete" && !options.allowInvalidNav ? null : options.nav ?? (options.noItems ? "100" : itemRows.reduce((sum, row) => sum.add(row.value), new Decimal(0)).toFixed()), "2026-01-10T00:00:00.000Z");
    for (const row of itemRows) db.prepare("INSERT INTO valuation_items(id,run_id,account_id,listing_id,item_type,currency,amount,fx_rate,value_cny,quality,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,'complete',?)")
      .run(randomUUID(), id, row.account, row.listing, row.type, row.currency, row.amount, row.fx, row.value, canonical(row.refs));
    return db.prepare("SELECT * FROM valuation_runs WHERE id=?").get(id) as { id: string; market_manifest: string; method_version: string; ledger_revision: number };
  };
  const performance = (values: ReturnType<typeof snapshot>[], patch: Json = {}, resultFlows: unknown = patch.external_flow_evidence ?? []) => {
    const market_heads: Json = {};
    for (const value of values) for (const item of db.prepare("SELECT evidence_json FROM valuation_items WHERE run_id=?").all(value.id) as { evidence_json: string }[]) {
      const refs = JSON.parse(item.evidence_json);
      const manifest = JSON.parse(value.market_manifest);
      for (const kind of ["price", "fx"]) if (refs[kind + "_observation_id"]) {
        const scope = kind === "price" ? "CN" : manifest.rules.fx_scope;
        const publication = manifest.publications[scope];
        if (publication) market_heads[scope] = { revision: publication.revision, manifest_hash: publication.manifest_hash };
      }
    }
    const mode = JSON.parse(values[0].market_manifest).mode, known = "2026-01-10T00:00:00.000Z";
    const cutoffs = values.map(value => (db.prepare("SELECT cutoff_at FROM valuation_runs WHERE id=?").get(value.id) as { cutoff_at: string }).cutoff_at);
    const proofs = cutoffs.map(cutoff => ledgerFactQualityAt(db, portfolio, cutoff, known, mode, values[0].ledger_revision));
    const period = ledgerFactQualityAt(db, portfolio, cutoffs.at(-1)!, known, mode, values[0].ledger_revision, cutoffs[0]);
    const built = { id: randomUUID(), ledger_revision: values[0].ledger_revision, method_version: "snapshot-performance-cny-v5", market_manifest: canonical({
      schema_version: "performance-input-v5", mode,
      ledger_revision: values[0].ledger_revision, evaluation_timezone: "Asia/Shanghai", market_heads,
      flow_fx_rules: null, flow_fx_rules_hash: null, external_flow_evidence: [],
      ledger_fact_quality: proofs, period_fact_quality: period,
      valuations: values.map(value => ({ id: value.id, content_hash: hash(value) })), ...patch }) };
    const levels = ["complete", "provisional", "blocked"], all = [...proofs, period];
    const quality = levels[Math.max(...all.map(proof => levels.indexOf(proof.performance_quality)))];
    const attribution = levels[Math.max(...all.map(proof => levels.indexOf(proof.attribution_quality)))];
    db.prepare("INSERT INTO performance_runs(id,portfolio_id,ledger_revision,market_manifest,method_version,period_start,period_end,quality,method,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,'modified_dietz_estimate',?,?)")
      .run(built.id, portfolio, built.ledger_revision, built.market_manifest, built.method_version, cutoffs[0], cutoffs.at(-1), quality, canonical({ external_flow_evidence: resultFlows, ledger_fact_quality: proofs, period_fact_quality: period, attribution_quality: attribution }), known);
    return built;
  };
  const addFlow = (currency = "USD", value = "1", effective = "2026-01-06T00:00:00.000Z", precision: "date" | "second" = "second", zone = "UTC", type: "deposit" | "withdrawal" = "deposit", recorded = "2026-01-06T12:00:00.000Z") => recordFact(db, actor, { portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: randomUUID(), source_id: "synthetic-test", effective_at: effective, time_precision: precision, source_timezone: zone, reason: "Synthetic fixture only", fact: { type, account_id: account, currency, amount: value } }, recorded);
  return { db, dir, portfolio, account, rules, cn, fx, snapshot, performance, publish, addFlow, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function recordSecurity(f: ReturnType<typeof fixture>, fact: LedgerCommand["fact"], effective_at: string, time_precision: "date" | "second" = "second", source_timezone = "UTC") {
  return recordFact(f.db, { id: "SYNTHETIC-SECURITY" }, { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: randomUUID(), source_id: "synthetic-security", reason: "Synthetic security consumer fixture", effective_at, time_precision, source_timezone, fact }, "2026-01-10T00:00:00.000Z");
}
type SecurityItemInput = { account_id: string; quantity: string; transfer_event_id?: string; target_account_id?: string };
function securitySnapshot(f: ReturnType<typeof fixture>, holdings: SecurityItemInput[], cutoff: string, mode = "restated", itemPatch: Record<string, string> = {}) {
  const run = f.snapshot({ noItems: true, cutoff, mode, publications: { CN: f.cn.publication }, nav: new Decimal(holdings.reduce((sum, row) => sum.add(row.quantity), new Decimal(0))).mul(100).toFixed() });
  for (const holding of holdings) {
    const value = new Decimal(holding.quantity).mul(100).toFixed();
    const { account_id, ...quantityEvidence } = holding;
    f.db.prepare("INSERT INTO valuation_items(id,run_id,account_id,listing_id,item_type,currency,amount,fx_rate,value_cny,quality,evidence_json) VALUES(?,?,?,'l',?,'CNY',?,?,?,'complete',?)").run(randomUUID(), run.id, account_id, holding.transfer_event_id ? "security_in_transit_market_value" : "security_market_value", itemPatch.amount ?? value, itemPatch.fx_rate ?? "1", itemPatch.value_cny ?? value, canonical({ ...quantityEvidence, price_observation_id: f.cn.observation, fx_observation_id: null }));
  }
  return run;
}
function transitScenario() {
  const f = fixture(), target = createAccount(f.db, { id: "SYNTHETIC-SECURITY" }, f.portfolio, "Synthetic receiver", "No broker", "CNY", now);
  recordSecurity(f, { type: "opening_position", account_id: f.account, listing_id: "l", currency: "CNY", quantity: "100" }, "2026-01-01T00:00:00.000Z");
  const sent = recordSecurity(f, { type: "security_transfer_out", account_id: f.account, target_account_id: target, listing_id: "l", currency: "CNY", quantity: "40" }, "2026-01-06T00:00:00.000Z");
  const holdings = [{ account_id: f.account, quantity: "60" }, { account_id: f.account, target_account_id: target, transfer_event_id: sent.event_id, quantity: "40" }];
  return { ...f, target, sent, holdings };
}
function securityFlowScenario(currency = "CNY", precision: "date" | "second" = "second") {
  const f = fixture(), listing = currency === "CNY" ? "l" : "foreign";
  if (currency !== "CNY") f.db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,status,created_at) VALUES('foreign','i','US','SYNTHETIC','FOREIGN',?,'active',?)").run(currency, now);
  const source = currency === "CNY" ? null : f.publish("FX", undefined, "2026-01-05T00:00:00.000Z", "second", "UTC", { currency, sourceMode: "manual_verified", provenance: "historical_point_in_time", value: "7.123456789012345678" });
  const flows = ["security_in", "security_out"].map((type, index) => {
    const effective_at = precision === "date" ? "2026-01-06" : `2026-01-06T0${index}:00:00.000Z`;
    const value_evidence = { schema_version: "security-transfer-value-v1" as const, reference: "Synthetic verified transfer market value", effective_at, time_precision: precision, source_timezone: "UTC" };
    const event = recordSecurity(f, { type: type as "security_in" | "security_out", account_id: f.account, listing_id: listing, currency, quantity: "2", market_value: String(200 + index * 20), value_evidence }, effective_at, precision);
    const fact = JSON.parse((f.db.prepare("SELECT payload_json FROM ledger_events WHERE id=?").get(event.event_id) as { payload_json: string }).payload_json).fact;
    return flowBinding(f, event.event_id, source, "restated", { flow_kind: "security", security: { listing_id: listing, quantity: fact.quantity, market_value: fact.market_value, value_evidence: fact.value_evidence, fact_hash: hash(fact) }, ...(precision === "date" ? { flow_time: null, evaluation_date: null, knowledge_at: null, fx_rate: null, amount_cny: null, quality: "blocked", issues: ["SECURITY_FLOW_TIME_PRECISION_UNSUPPORTED"] } : {}) });
  });
  const values = [f.snapshot({ kind: "cash", publications: {}, cutoff: "2026-01-05T13:00:00.000Z" }), f.snapshot({ kind: "cash", publications: {}, cutoff: "2026-01-07T13:00:00.000Z" })];
  const persist = (evidence = flows) => persistFlows(f, values, evidence, source ? { flow_fx_rules: approvedFlowRules, flow_fx_rules_hash: hash(approvedFlowRules), market_heads: { FX: { revision: source.publication.revision, manifest_hash: source.publication.manifest_hash } } } : {});
  return { ...f, flows, values, persist };
}

test("security v5 external flow binds original market value, share movement and CNY/foreign conversion", () => {
  for (const currency of ["CNY", "USD", "HKD"]) {
    const f = securityFlowScenario(currency);
    try {
      assert.equal(f.flows[0].amount_native, "200"); assert.equal(f.flows[1].amount_native, "-220");
      assert.deepEqual(performanceFreshness(f.db, f.persist(), 2), []);
      for (const patch of [{ flow_kind: "cash", security: null }, { security: null }, { security: { ...f.flows[0].security as Json, quantity: "3" } }, { security: { ...f.flows[0].security as Json, market_value: "199" } }, { security: { ...f.flows[0].security as Json, fact_hash: "a".repeat(64) } }, { security: { ...f.flows[0].security as Json, value_evidence: { ...(f.flows[0].security as Json).value_evidence as Json, effective_at: "2026-01-05T00:00:00.000Z" } } }]) {
        assert.ok(performanceFreshness(f.db, f.persist([rebind({ ...f.flows[0], ...patch }), f.flows[1]]), 2).some(issue => ["FLOW_EVIDENCE_INVALID", "SECURITY_FLOW_EVIDENCE_INVALID", "INPUT_MANIFEST_INVALID"].includes(issue)));
      }
    } finally { f.close(); }
  }
});

test("all date-only security flows including CNY remain blocked and cannot disappear at intraday boundaries", () => {
  for (const currency of ["CNY", "USD"]) {
    const f = securityFlowScenario(currency, "date");
    try {
      assert.ok(performanceFreshness(f.db, f.persist(), 2).includes("FLOW_EVIDENCE_BLOCKED"));
      assert.ok(performanceFreshness(f.db, f.persist([]), 2).includes("FLOW_EVIDENCE_COVERAGE_INVALID"));
      if (currency === "CNY") {
        const invented = f.flows.map(flow => rebind({ ...flow, quality: "complete", issues: [], fx_rate: "1", amount_cny: flow.amount_native }));
        assert.ok(performanceFreshness(f.db, f.persist(invented), 2).includes("SECURITY_FLOW_TIME_UNCERTAIN"));
      }
      const intraday = f.snapshot({ kind: "cash", publications: {}, cutoff: "2026-01-06T12:00:00.000Z" });
      const omitted = persistFlows(f, [f.values[0], intraday], []);
      assert.ok(performanceFreshness(f.db, omitted, 2).includes("FLOW_EVIDENCE_COVERAGE_INVALID"));
    } finally { f.close(); }
  }
});

test("valuation v4 independently separates settled shares from each transit lot and rejects omitted/forged quantities", () => {
  const f = transitScenario();
  try {
    const current = securitySnapshot(f, f.holdings, "2026-01-07T00:00:00.000Z");
    assert.deepEqual(valuationFreshness(f.db, current, 2), []);
    const invalid = [f.holdings.slice(0, 1), [f.holdings[0], { ...f.holdings[1], quantity: "39" }], [f.holdings[0], { ...f.holdings[1], target_account_id: f.account }], [f.holdings[0], { ...f.holdings[1], account_id: f.target }], [f.holdings[0], { ...f.holdings[1], transfer_event_id: "missing" }], [f.holdings[0], f.holdings[1], f.holdings[1]], [{ account_id: f.account, quantity: "100" }]];
    for (const [index, holdings] of invalid.entries()) assert.ok(valuationFreshness(f.db, securitySnapshot(f, holdings, `2026-01-07T00:01:0${index}.000Z`), 2).some(issue => issue.startsWith("SECURITY_")));
    f.db.prepare("UPDATE security_transit_projections SET quantity='999' WHERE transfer_event_id=?").run(f.sent.event_id);
    assert.deepEqual(valuationFreshness(f.db, current, 2), []);
  } finally { f.close(); }
});

test("historical transit quantities follow partial receipts, splits, returns and economic cutoff rather than current projections", () => {
  const f = transitScenario();
  try {
    recordSecurity(f, { type: "security_transfer_in", account_id: f.target, listing_id: "l", currency: "CNY", quantity: "15", related_event_id: f.sent.event_id }, "2026-01-07T00:00:00.000Z");
    recordSecurity(f, { type: "split", account_id: f.account, listing_id: "l", currency: "CNY", split_numerator: "2", split_denominator: "1" }, "2026-01-08T00:00:00.000Z");
    recordSecurity(f, { type: "security_transfer_return", account_id: f.account, listing_id: "l", currency: "CNY", quantity: "10", related_event_id: f.sent.event_id }, "2026-01-09T00:00:00.000Z");
    const lot = { account_id: f.account, transfer_event_id: f.sent.event_id, target_account_id: f.target };
    for (const [cutoff, holdings] of [
      ["2026-01-06T12:00:00.000Z", f.holdings],
      ["2026-01-07T12:00:00.000Z", [{ account_id: f.account, quantity: "60" }, { account_id: f.target, quantity: "15" }, { ...lot, quantity: "25" }]],
      ["2026-01-08T12:00:00.000Z", [{ account_id: f.account, quantity: "120" }, { account_id: f.target, quantity: "15" }, { ...lot, quantity: "50" }]],
      ["2026-01-09T12:00:00.000Z", [{ account_id: f.account, quantity: "130" }, { account_id: f.target, quantity: "15" }, { ...lot, quantity: "40" }]],
    ] as [string, SecurityItemInput[]][]) assert.deepEqual(valuationFreshness(f.db, securitySnapshot(f, holdings, cutoff), 5), []);
    const unknownAtCutoff = securitySnapshot(f, [], "2026-01-07T13:00:00.000Z", "as_known");
    assert.deepEqual(valuationFreshness(f.db, unknownAtCutoff, 5), []);
  } finally { f.close(); }
});

test("settled and in-transit value items must equal ledger quantity times their own bound price and FX", () => {
  const f = transitScenario();
  try {
    for (const [index, field] of ["amount", "fx_rate", "value_cny"].entries()) {
      const run = securitySnapshot(f, f.holdings, `2026-01-07T00:02:0${index}.000Z`, "restated", { [field]: field === "fx_rate" ? "2" : "1" });
      assert.ok(valuationFreshness(f.db, run, 2).includes("SECURITY_VALUE_EVIDENCE_INVALID"));
    }
  } finally { f.close(); }
});

test("restated security quantities honor append-only reversals and replacement transit identities", () => {
  const f = transitScenario(), actor = { id: "SYNTHETIC-SECURITY" };
  try {
    const raw = JSON.stringify({ synthetic: "Security correction evidence only" });
    const options = { dataDir: f.dir, now: "2026-01-10T00:00:00.000Z" };
    const attachment = storeJsonAttachment(f.db, actor, { portfolio_id: f.portfolio, account_id: f.account, raw }, options);
    storeJsonAttachment(f.db, actor, { portfolio_id: f.portfolio, account_id: f.target, raw }, options);
    const result = correctLedger(f.db, actor, { portfolio_id: f.portfolio, expected_revision: 2, idempotency_key: randomUUID(), attachment_id: attachment.id, reason: "Synthetic transfer amount correction", changes: [{ action: "replace", event_id: f.sent.event_id, replacement: { effective_at: "2026-01-06T00:00:00.000Z", time_precision: "second", source_timezone: "UTC", fact: { type: "security_transfer_out", account_id: f.account, target_account_id: f.target, listing_id: "l", currency: "CNY", quantity: "30" } } }] }, options);
    const replacement = result.replacements.find(row => row.original_event_id === f.sent.event_id)!;
    const current = securitySnapshot(f, [{ account_id: f.account, quantity: "70" }, { account_id: f.account, target_account_id: f.target, transfer_event_id: replacement.event_id, quantity: "30" }], "2026-01-07T00:00:00.000Z");
    assert.deepEqual(valuationFreshness(f.db, current, result.revision), []);
    const oldLot = securitySnapshot(f, [{ account_id: f.account, quantity: "70" }, { account_id: f.account, target_account_id: f.target, transfer_event_id: f.sent.event_id, quantity: "30" }], "2026-01-07T00:00:01.000Z");
    assert.ok(valuationFreshness(f.db, oldLot, result.revision).includes("SECURITY_TRANSIT_EVIDENCE_MISSING"));
  } finally { f.close(); }
});

test("real TS transfers and Python v4 valuations independently verify across partial arrival, split and return cutoffs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "security-valuation-cross-language-")), filename = path.join(dir, "workbench.db");
  try {
    const script = [
      "import json,sqlite3,sys",
      "from tests.market.test_security_transfers import SecurityTransferTests",
      "case=SecurityTransferTests(); case.setUp()",
      "try:",
      " results=[case.valuation(hours,mode) for mode in ('restated','as_known') for hours in (1.5,2.5,3.5,4.5,5.5,6.5)]",
      " assert all(row['quality']=='complete' for row in results)",
      " target=sqlite3.connect(sys.argv[1]); case.db.backup(target); target.close()",
      " print(json.dumps([row['id'] for row in results]))",
      "finally:",
      " case.doCleanups()",
    ].join("\n");
    const ids = JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", script, filename], { cwd: path.resolve(".."), encoding: "utf8" })) as string[];
    const db = openWorkbench(filename);
    try {
      for (const id of ids) {
        const run = db.prepare("SELECT * FROM valuation_runs WHERE id=?").get(id) as { id: string; market_manifest: string; ledger_revision: number };
        assert.deepEqual(valuationFreshness(db, run, run.ledger_revision), [], id);
      }
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real TS security facts to Python v5 performance verify market-value flows and in-transit NAV in Web", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "security-performance-cross-language-"));
  try {
    for (const currency of ["CNY", "USD"]) {
      const filename = path.join(dir, currency + ".db");
      const script = [
        "import json,sqlite3,sys,unittest",
        "from tests.market.test_security_transfers import security_database,publish_security_prices",
        "from tests.performance.test_security_flows import performance_for,publish_security_fx",
        "from tests.market.support import NOW",
        "from worker.performance import persist_performance",
        "case=unittest.TestCase(); currency=sys.argv[2]",
        "try:",
        " db,path,events=security_database(case,currency=currency,internal=currency=='CNY')",
        " publish_security_prices(db,currency,split=currency=='CNY')",
        " if currency!='CNY': publish_security_fx(db,currency,split_fx=True)",
        " results=[]",
        " for mode in ('restated','as_known'):",
        "  prepared,snapshots=performance_for(db,(0,5.5) if currency=='CNY' else (0,4),mode,currency)",
        "  assert prepared.quality!='blocked',prepared.result",
        "  results.append(persist_performance(db,prepared,now=NOW)['id'])",
        " target=sqlite3.connect(sys.argv[1]); db.backup(target); target.close()",
        " print(json.dumps(results))",
        "finally:",
        " case.doCleanups()",
      ].join("\n");
      const ids = JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", script, filename, currency], { cwd: path.resolve(".."), encoding: "utf8" })) as string[];
      const db = openWorkbench(filename);
      try {
        for (const id of ids) {
          const run = db.prepare("SELECT * FROM performance_runs WHERE id=?").get(id) as { id: string; market_manifest: string; ledger_revision: number; method_version: string };
          assert.deepEqual(performanceFreshness(db, run, run.ledger_revision), [], `${currency}:${id}`);
        }
      } finally { db.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("security external posting coverage is checked from events, including omitted or duplicated capital legs", () => {
  const duplicated = securityFlowScenario();
  try {
    duplicated.db.prepare("INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES(?,?,?,'CNY','external_capital','0')").run(randomUUID(), duplicated.flows[0].event_id, duplicated.account);
    assert.ok(performanceFreshness(duplicated.db, duplicated.persist(), 2).includes("SECURITY_FLOW_POSTING_COVERAGE_INVALID"));
  } finally { duplicated.close(); }
  const f = securityFlowScenario();
  try {
    const id = randomUUID(), at = "2026-01-06T02:00:00.000Z";
    const fact = { type: "security_in", account_id: f.account, listing_id: "l", currency: "CNY", quantity: "1", market_value: "100", value_evidence: { schema_version: "security-transfer-value-v1", reference: "Synthetic missing-posting corruption fixture", effective_at: at, time_precision: "second", source_timezone: "UTC" } };
    const payload = { fact };
    f.db.prepare("INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,recorded_at,source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id) VALUES(?,?,?,'security_in',?,?,'synthetic-corrupt',?,?,?,3,'synthetic')").run(id, f.portfolio, f.account, at, at, id, hash(payload), canonical(payload));
    f.db.prepare("INSERT INTO position_movements(id,event_id,account_id,listing_id,currency,quantity,cost_amount,cost_known) VALUES(?,?,?,'l','CNY','1','0',0)").run(randomUUID(), id, f.account);
    f.db.prepare("UPDATE ledger_heads SET revision=3 WHERE portfolio_id=?").run(f.portfolio);
    const first = f.snapshot({ kind: "cash", publications: {}, cutoff: "2026-01-05T13:00:00.000Z" });
    const last = securitySnapshot(f, [{ account_id: f.account, quantity: "1" }], "2026-01-07T13:00:00.000Z");
    assert.ok(performanceFreshness(f.db, persistFlows(f, [first, last], f.flows), 3).includes("SECURITY_FLOW_POSTING_COVERAGE_INVALID"));
  } finally { f.close(); }
});

test("restated checks only consumed price/FX heads; as-known validates immutable history", () => {
  for (const kind of ["price", "fx"] as const) {
    const f = fixture(kind), rev = revision(f.db, f.portfolio), scope = kind === "price" ? "CN" : "FX";
    try {
      const current = f.snapshot(), historic = f.snapshot({ mode: "as_known" });
      assert.deepEqual(valuationFreshness(f.db, current, rev), []);
      f.publish(kind === "price" ? "FX" : "CN");
      assert.deepEqual(valuationFreshness(f.db, current, rev), []);
      f.publish(scope);
      assert.deepEqual(valuationFreshness(f.db, current, rev), ["RESTATED_MARKET_CHANGED:" + scope]);
      assert.deepEqual(valuationFreshness(f.db, historic, rev), []);
      assert.deepEqual(valuationFreshness(f.db, historic, rev + 1), ["LEDGER_REVISION_CHANGED"]);
    } finally { f.close(); }
  }
});

test("missing refs, wrong listing/currency/units and forged publication evidence are never current", () => {
  const f = fixture("price");
  try {
    for (const mode of ["as_known", "restated"]) for (const kind of ["price", "fx"] as const) {
      assert.ok(valuationFreshness(f.db, f.snapshot({ mode, kind, refs: {} }), 0).includes("MARKET_EVIDENCE_MISSING"));
    }
    for (const options of [{ listing: "other" }, { currency: "USD" }, { kind: "fx" as const, currency: "HKD" }, { refs: { price_observation_id: [] } },
      { publications: { CN: { ...f.cn.publication, manifest_hash: "b".repeat(64) } } },
      { publications: { CN: { ...f.cn.publication, revision: 999 } } },
      { publications: { CN: { ...f.cn.publication, scope: "FX" } } },
      { publications: { CN: [] } }]) assert.ok(valuationFreshness(f.db, f.snapshot(options), 1).some(issue => ["MARKET_EVIDENCE_INVALID", "INPUT_MANIFEST_INVALID"].includes(issue)));
    const wrongPrice = f.publish("CN", "USD"), wrongFx = f.publish("FX", "USD_per_CNY");
    for (const [kind, source] of [["price", wrongPrice], ["fx", wrongFx]] as const) {
      const run = f.snapshot({ kind, refs: { [kind + "_observation_id"]: source.observation }, publications: { [source.publication.scope]: source.publication } });
      assert.ok(valuationFreshness(f.db, run, 0).includes("MARKET_EVIDENCE_INVALID"));
    }
  } finally { f.close(); }
});

test("manifest evidence is required and uninitialized empty portfolios remain blocked without invented cash", () => {
  const f = fixture();
  try {
    assert.deepEqual(valuationFreshness(f.db, f.snapshot({ kind: "cash", publications: {} }), 0), []);
    assert.deepEqual(valuationFreshness(f.db, f.snapshot({ noItems: true, publications: {} }), 0), []);
    assert.ok(valuationFreshness(f.db, f.snapshot({ noItems: true, nav: "100", allowInvalidNav: true }), 0).includes("VALUATION_ITEMS_MISSING"));
    for (const manifest of [{ mode: "as_known" }, [], { schema_version: "valuation-input-v1", mode: "as_known", rules: f.rules, rules_hash: "b".repeat(64), publications: {} }]) {
      assert.ok(valuationFreshness(f.db, f.snapshot({ manifest }), 0).includes("INPUT_MANIFEST_INVALID"));
    }
    for (const version of [1, 2, 3]) assert.ok(valuationFreshness(f.db, f.snapshot({ method: `decimal-nav-cny-v${version}:restated` }), 0).includes("VALUATION_METHOD_SUPERSEDED"));
  } finally { f.close(); }
});

test("performance v5 binds valuation hashes, scope heads, modes and portfolio; old methods are superseded", () => {
  const f = fixture("price");
  try {
    const start = f.snapshot(), end = f.snapshot({ cutoff: "2026-01-06T13:00:00.000Z" });
    const result = f.performance([start, end]);
    assert.deepEqual(performanceFreshness(f.db, result, 1), []);
    assert.ok(performanceFreshness(f.db, f.performance([start, end], { market_heads: {} }), 0).includes("MARKET_EVIDENCE_INVALID"));
    for (const patch of [{ mode: "unknown" }, { valuations: [] }, { market_heads: null }, { evaluation_timezone: "Invalid/Zone" }]) {
      assert.ok(performanceFreshness(f.db, f.performance([start, end], patch), 0).includes("INPUT_MANIFEST_INVALID"));
    }
    assert.ok(performanceFreshness(f.db, f.performance([start, end], { valuations: [{ id: start.id, content_hash: "b".repeat(64) }, { id: end.id, content_hash: hash(end) }] }), 0).includes("VALUATION_EVIDENCE_INVALID"));
    const old = f.snapshot({ cutoff: "2026-01-07T13:00:00.000Z", method: "decimal-nav-cny-v1:restated" });
    assert.ok(performanceFreshness(f.db, f.performance([start, old]), 0).includes("VALUATION_METHOD_SUPERSEDED"));
    assert.ok(performanceFreshness(f.db, { ...result, method_version: "snapshot-performance-cny-v1" }, 0).includes("PERFORMANCE_METHOD_SUPERSEDED"));
    assert.ok(performanceFreshness(f.db, { ...result, method_version: "snapshot-performance-cny-v2" }, 0).includes("PERFORMANCE_METHOD_SUPERSEDED"));
    assert.ok(performanceFreshness(f.db, { ...result, method_version: "snapshot-performance-cny-v3" }, 0).includes("PERFORMANCE_METHOD_SUPERSEDED"));
    assert.ok(performanceFreshness(f.db, { ...result, method_version: "snapshot-performance-cny-v4" }, 0).includes("PERFORMANCE_METHOD_SUPERSEDED"));
    const otherPortfolio = createPortfolio(f.db, { id: "test" }, "OTHER SYNTHETIC", now);
    const other = f.snapshot({ cutoff: "2026-01-08T13:00:00.000Z", portfolio: otherPortfolio });
    assert.ok(performanceFreshness(f.db, f.performance([start, other]), 0).includes("VALUATION_EVIDENCE_INVALID"));
    f.publish("CN");
    assert.deepEqual(performanceFreshness(f.db, result, 1), ["RESTATED_MARKET_CHANGED:CN"]);
  } finally { f.close(); }
});

test("as-known performance remains historical after head updates and cash-only performance is valid", () => {
  const f = fixture("fx");
  try {
    const start = f.snapshot({ mode: "as_known", kind: "fx" }), end = f.snapshot({ mode: "as_known", kind: "fx", cutoff: "2026-01-06T13:00:00.000Z" });
    const result = f.performance([start, end]);
    f.publish("FX");
    assert.deepEqual(performanceFreshness(f.db, result, 1), []);
  } finally { f.close(); }
  const cash = fixture();
  try {
    const a = cash.snapshot({ kind: "cash", publications: {} }), b = cash.snapshot({ kind: "cash", publications: {}, cutoff: "2026-01-06T13:00:00.000Z" });
    assert.deepEqual(performanceFreshness(cash.db, cash.performance([a, b]), 0), []);
    assert.ok(performanceFreshness(cash.db, cash.performance([a, b], { market_heads: { unused: { revision: 1, manifest_hash: "a".repeat(64) } } }), 0).includes("MARKET_EVIDENCE_INVALID"));
  } finally { cash.close(); }
});

test("each original price/FX reference obeys cutoff, source timezone and knowledge time", () => {
  for (const kind of ["price", "fx"] as const) {
    const f = fixture(kind), rev = revision(f.db, f.portfolio);
    try {
      assert.ok(valuationFreshness(f.db, f.snapshot({ kind, mode: "as_known", cutoff: kind === "price" ? "2026-01-05T11:00:00.000Z" : "2026-01-05T11:01:00.000Z" }), 0).includes("MARKET_EVIDENCE_INVALID"));
      const future = f.publish(kind === "price" ? "CN" : "FX", undefined, "2026-01-07T00:00:00.000Z");
      const input = { kind, refs: { [kind + "_observation_id"]: future.observation }, publications: { [future.publication.scope]: future.publication } };
      assert.ok(valuationFreshness(f.db, f.snapshot(input), 0).includes("MARKET_EVIDENCE_INVALID"));
      const dated = f.publish(kind === "price" ? "CN" : "FX", undefined, "2026-01-05", "date", "America/New_York");
      const dayInput = { kind, mode: "as_known", refs: { ...(kind === "price" ? { quantity: "1" } : {}), [kind + "_observation_id"]: dated.observation }, publications: { [dated.publication.scope]: dated.publication } };
      assert.ok(valuationFreshness(f.db, f.snapshot({ ...dayInput, cutoff: "2026-01-06T04:59:59.999Z" }), 0).includes("MARKET_EVIDENCE_INVALID"));
      assert.deepEqual(valuationFreshness(f.db, f.snapshot({ ...dayInput, cutoff: "2026-01-06T05:00:00.000Z" }), rev), []);
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    const rules = { ...f.rules, approved: false };
    const unapproved = f.snapshot({ kind: "cash", manifest: { schema_version: "valuation-input-v3", mode: "restated", rules, rules_hash: hash(rules), publications: {} } });
    assert.ok(valuationFreshness(f.db, unapproved, 0).includes("VALUATION_QUALITY_RULES_UNAPPROVED"));
  } finally { f.close(); }
});

test("real TS dividends to Python v4 NAV/v5 performance retain three quality dimensions and reject self-rehashed evidence omissions", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dividend-freshness-cross-language-"));
  try {
    for (const scenario of ["tax", "net", "notice"]) {
      const filename = path.join(dir, scenario + ".db");
      const script = [
        "import json,sqlite3,sys,unittest",
        "from datetime import timedelta",
        "from tests.market.test_corporate_actions import corporate_database,assessment",
        "from tests.performance.test_corporate_actions import CorporateActionPerformanceTests",
        "from tests.market.test_security_transfers import START",
        "from tests.market.support import NOW,rules",
        "from worker.market import value_portfolio",
        "from worker.performance import persist_performance",
        "from worker.orchestration.db import stamp",
        "case=unittest.TestCase(); scenario=sys.argv[2]",
        "try:",
        " if scenario=='tax':",
        "  commands=[('gross',1,{'type':'dividend_accrual','amount':'200','tax_status':'unknown'}),('paid',2,{'type':'dividend_payment','related_event_id':'@gross','amount':'180'}),assessment('tax20',3,'20'),assessment('tax25',4,'25'),('deduct',5,{'type':'dividend_tax_payment','related_event_id':'@gross','amount':'5','evidence_reference':'Synthetic real withholding'}),assessment('taxback20',6,'20'),('refund',7,{'type':'dividend_payment','related_event_id':'@gross','amount':'5'})]",
        " elif scenario=='net': commands=[('net',1,{'type':'dividend_net','amount':'180','net_status':'final'})]",
        " else: commands=[('notice',1,{'type':'corporate_action_notice','action_kind':'merger','evidence_reference':'Synthetic unresolved notice only'})]",
        " db,path,events=corporate_database(case,commands,opening=scenario!='notice')",
        " valuations=[]; performances=[]",
        " for mode in ('as_known','restated'):",
        "  for hour in ((1.5,2.5,3.5,4.5,5.5,6.5,7.5) if scenario=='tax' else (2.5,)):",
        "   row=value_portfolio(db,'p',stamp(START+timedelta(hours=hour)),rules(),mode,now=NOW); valuations.append({'id':row['id'],'hour':hour,'mode':mode})",
        "  if scenario!='notice':",
        "   prepared=CorporateActionPerformanceTests().prepare(db,start=3.5 if scenario=='tax' else 0,mode=mode)",
        "   saved=persist_performance(db,prepared,now=NOW); performances.append(saved['id'])",
        "   if scenario=='tax':",
        "    interval=CorporateActionPerformanceTests().prepare(db,start=0,mode=mode)",
        "    assert interval.quality=='blocked' and interval.result['period_fact_quality']['performance_quality']=='provisional'",
        "    performances.append(persist_performance(db,interval,now=NOW)['id'])",
        " target=sqlite3.connect(sys.argv[1]); db.backup(target); target.close()",
        " print(json.dumps({'valuations':valuations,'performances':performances}))",
        "finally: case.doCleanups()",
      ].join("\n");
      const result = JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", script, filename, scenario], { cwd: path.resolve(".."), encoding: "utf8" })) as { valuations: { id: string; hour: number; mode: string }[]; performances: string[] };
      const db = openWorkbench(filename);
      type Run = { id: string; portfolio_id: string; cutoff_at: string; ledger_revision: number; market_manifest: string; method_version: string; quality: string; nav_cny: string | null };
      const copy = (table: string, id: string, changes: Json) => {
        const original = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Json, row = { ...original, ...changes };
        db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
      };
      try {
        for (const value of result.valuations) {
          const run = db.prepare("SELECT * FROM valuation_runs WHERE id=?").get(value.id) as Run;
          assert.deepEqual(valuationFreshness(db, run, run.ledger_revision), [], `${scenario}:${value.mode}:${value.hour}`);
          const proof = JSON.parse(run.market_manifest).ledger_fact_quality;
          if (scenario === "notice") { assert.equal(run.quality, "blocked"); assert.equal(run.nav_cny, null); }
          if (scenario === "net") { assert.equal(run.nav_cny, "280"); assert.equal(proof.nav_quality, "complete"); assert.equal(proof.attribution_quality, "provisional"); }
          if (scenario === "tax") assert.equal(run.nav_cny, value.hour < 3 ? null : value.hour === 4.5 || value.hour === 5.5 ? "275" : "280");
        }
        for (const id of result.performances) {
          const run = db.prepare("SELECT * FROM performance_runs WHERE id=?").get(id) as Run;
          assert.deepEqual(performanceFreshness(db, run, run.ledger_revision), []);
          const proof = JSON.parse(run.market_manifest);
          assert.deepEqual(proof.external_flow_evidence, []);
          if (proof.period_fact_quality.performance_quality !== "complete") {
            assert.equal(run.quality, "blocked");
            assert.ok(proof.ledger_fact_quality.every((value: Json) => value.performance_quality === "complete"));
            const saved = JSON.parse((db.prepare("SELECT result_json FROM performance_runs WHERE id=?").get(id) as { result_json: string }).result_json);
            for (const quality of ["provisional", "blocked"]) for (const metric of ["none", "return", "net_profit_cny", "drawdown", "xirr.rate"]) {
              if (quality === "blocked" && metric === "none") continue;
              const payload = structuredClone(saved), clone = randomUUID();
              if (metric === "xirr.rate") payload.xirr.rate = "0.25";
              else if (metric !== "none") payload[metric] = "0.25";
              copy("performance_runs", id, { id: clone, quality, result_json: canonical(payload) });
              const bad = db.prepare("SELECT * FROM performance_runs WHERE id=?").get(clone) as Run;
              assert.ok(performanceFreshness(db, bad, bad.ledger_revision).includes("LEDGER_FACT_QUALITY_OVERRIDDEN"), `${quality}:${metric}`);
            }
          }
          const forged = structuredClone(proof), period = forged.period_fact_quality;
          period.dividends = []; period.event_hashes = {}; period.issues = []; period.attribution_quality = "complete";
          const { binding_id: _, ...semantic } = period; void _; period.binding_id = hash(semantic);
          const clone = randomUUID();
          const stored = db.prepare("SELECT result_json FROM performance_runs WHERE id=?").get(id) as { result_json: string }, payload = JSON.parse(stored.result_json);
          payload.period_fact_quality = period; payload.attribution_quality = "complete";
          copy("performance_runs", id, { id: clone, market_manifest: canonical(forged), result_json: canonical(payload) });
          const bad = db.prepare("SELECT * FROM performance_runs WHERE id=?").get(clone) as Run;
          assert.ok(performanceFreshness(db, bad, bad.ledger_revision).includes("LEDGER_FACT_QUALITY_EVIDENCE_INVALID"));
        }
        const reference = result.valuations.find(value => value.mode === "restated" && value.hour === (scenario === "tax" ? 4.5 : 2.5))!;
        const original = db.prepare("SELECT * FROM valuation_runs WHERE id=?").get(reference.id) as Run;
        for (const mutation of scenario === "tax" ? ["proof", "omit-liability", "positive-liability"] : ["proof"]) {
          const manifest = JSON.parse(original.market_manifest), id = randomUUID();
          manifest.rules.approval_evidence = "Synthetic adversarial fixture " + id; manifest.rules_hash = hash(manifest.rules);
          if (mutation === "proof") {
            const proof = manifest.ledger_fact_quality;
            proof.dividends = []; proof.corporate_actions = []; proof.event_hashes = {}; proof.issues = []; proof.nav_quality = "complete"; proof.performance_quality = "complete"; proof.attribution_quality = "complete";
            const { binding_id: _, ...semantic } = proof; void _; proof.binding_id = hash(semantic);
          }
          copy("valuation_runs", original.id, { id, market_manifest: canonical(manifest) });
          for (const item of db.prepare("SELECT id,item_type FROM valuation_items WHERE run_id=?").all(original.id) as { id: string; item_type: string }[]) {
            if (mutation === "omit-liability" && item.item_type === "dividend_tax_payable") continue;
            copy("valuation_items", item.id, { id: randomUUID(), run_id: id, ...(mutation === "positive-liability" && item.item_type === "dividend_tax_payable" ? { amount: "5", value_cny: "5" } : {}) });
          }
          const clone = db.prepare("SELECT * FROM valuation_runs WHERE id=?").get(id) as Run, errors = valuationFreshness(db, clone, clone.ledger_revision);
          assert.ok(errors.includes(mutation === "proof" ? "LEDGER_FACT_QUALITY_EVIDENCE_INVALID" : mutation === "omit-liability" ? "MONETARY_AMOUNT_EVIDENCE_MISSING" : "MONETARY_AMOUNT_EVIDENCE_INVALID"), errors.join(","));
        }
      } finally { db.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("price and FX quotes learned after prepare cannot enter a snapshot merely because persistence happened later", () => {
  for (const kind of ["price", "fx"] as const) {
    const f = fixture(kind);
    try {
      const source = f.publish(kind === "price" ? "CN" : "FX", undefined, "2026-01-05T00:00:00.000Z", "second", "UTC", { knownAt: "2026-01-08T00:00:00.000Z" });
      const options = { kind, cutoff: "2026-01-06T13:00:00.000Z", refs: { ...(kind === "price" ? { quantity: "1" } : {}), [kind + "_observation_id"]: source.observation }, publications: { [source.publication.scope]: source.publication } };
      const tooLate = f.snapshot({ ...options, knowledgeAt: "2026-01-07T00:00:00.000Z" });
      assert.ok(valuationFreshness(f.db, tooLate, revision(f.db, f.portfolio)).includes("MARKET_EVIDENCE_INVALID"));
      const learned = f.snapshot({ ...options, knowledgeAt: "2026-01-09T00:00:00.000Z" });
      assert.deepEqual(valuationFreshness(f.db, learned, revision(f.db, f.portfolio)), []);
    } finally { f.close(); }
  }
});

test("as-known late confirmed dividends cannot become current returns despite complete endpoint and period proofs", () => {
  for (const [recorded, effective, blocked] of [
    ["2026-01-07T00:00:00.000Z", "2026-01-02T00:00:00.000Z", true],
    ["2026-01-05T13:00:00.000Z", "2026-01-02T00:00:00.000Z", false],
    ["2026-01-08T13:00:00.000Z", "2026-01-02T00:00:00.000Z", true],
    ["2026-01-09T00:00:00.000Z", "2026-01-02T00:00:00.000Z", false],
    ["2026-01-07T00:00:00.000Z", "2026-01-06T00:00:00.000Z", false],
  ] as const) {
    const f = fixture(), actor = { id: "SYNTHETIC-KNOWLEDGE" };
    try {
      const input = (fact: LedgerCommand["fact"], effective_at: string): LedgerCommand => ({ portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: randomUUID(), source_id: "synthetic-knowledge", reason: "Synthetic late arrival; not return earned today", effective_at, time_precision: "second", source_timezone: "UTC", fact });
      recordFact(f.db, actor, input({ type: "opening_cash", account_id: f.account, currency: "CNY", amount: "100" }, "2026-01-01T00:00:00.000Z"), "2026-01-01T00:00:00.000Z");
      recordFact(f.db, actor, input({ type: "dividend", account_id: f.account, currency: "CNY", amount: "200", tax: "20" }, effective), recorded);
      for (const mode of ["as_known", "restated"]) {
        const snapshots = ["2026-01-05T13:00:00.000Z", "2026-01-08T13:00:00.000Z"].map(cutoff => f.snapshot({ mode, cutoff, kind: "cash", publications: {} }));
        const run = f.performance(snapshots), manifest = JSON.parse(run.market_manifest);
        assert.ok([...manifest.ledger_fact_quality, manifest.period_fact_quality].every(proof => proof.performance_quality === "complete"));
        const errors = performanceFreshness(f.db, run, 2);
        assert.deepEqual(errors, mode === "as_known" && blocked ? ["KNOWLEDGE_SET_CHANGED_RESTATE_REQUIRED"] : [], `${mode}:${recorded}:${effective}`);
      }
    } finally { f.close(); }
  }
});

test("as-known date-only knowledge uses source-local end-of-day and detects late reversal records", () => {
  for (const cutoff of ["2026-01-06T04:00:00.000Z", "2026-01-06T05:00:00.000Z"]) {
    const f = fixture(), actor = { id: "SYNTHETIC-KNOWLEDGE" };
    try {
      const command = (fact: LedgerCommand["fact"], effective_at: string): LedgerCommand => ({ portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: randomUUID(), source_id: "synthetic-knowledge", reason: "Synthetic date-precision knowledge boundary", effective_at, time_precision: "date", source_timezone: "America/New_York", fact });
      recordFact(f.db, actor, command({ type: "opening_cash", account_id: f.account, currency: "CNY", amount: "100" }, "2026-01-01"), "2026-01-02T00:00:00.000Z");
      const dividend = recordFact(f.db, actor, command({ type: "dividend", account_id: f.account, currency: "CNY", amount: "200", tax: "20" }, "2026-01-05"), "2026-01-05T12:00:00.000Z");
      const options = { dataDir: f.dir, now: "2026-01-07T00:00:00.000Z" }, raw = '{"synthetic":"void mistaken dividend"}';
      const attachment = storeJsonAttachment(f.db, actor, { portfolio_id: f.portfolio, account_id: f.account, raw }, options);
      correctLedger(f.db, actor, { portfolio_id: f.portfolio, expected_revision: 2, idempotency_key: randomUUID(), attachment_id: attachment.id, reason: "Synthetic late void", changes: [{ action: "void", event_id: dividend.event_id }] }, options);
      const values = [cutoff, "2026-01-08T13:00:00.000Z"].map(at => f.snapshot({ mode: "as_known", cutoff: at, kind: "cash", publications: {} }));
      const errors = performanceFreshness(f.db, f.performance(values), 3);
      assert.equal(errors.includes("KNOWLEDGE_SET_CHANGED_RESTATE_REQUIRED"), cutoff === "2026-01-06T05:00:00.000Z");
    } finally { f.close(); }
  }
});
