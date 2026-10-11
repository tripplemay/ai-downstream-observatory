import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { canonical, hash } from "../src/server/ledger/service";
import { readInvestorConfirmedCapture, replayConfirmedProtocol } from "../src/server/investor/confirmed-source";
import { investorFixture } from "./investor-fixture";

type Obj = Record<string, any>;
const now = "2026-01-02T22:00:03.000Z", invalid = /INVESTOR_CONFIRMED_EVIDENCE_INVALID/;
function seed(f: ReturnType<typeof investorFixture>, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", "tests.investor.confirmed_capture_fixture", "--db", f.filename, ...args],
    { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 131072, stdio: ["ignore", "pipe", "pipe"] })) as Obj;
}
function noFinance(f: ReturnType<typeof investorFixture>) {
  for (const name of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports", "job_runs", "outbox"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0);
  assert.equal((f.db.prepare("SELECT revision FROM investor_workspaces WHERE id='w'").get() as Obj).revision, 0);
}
function retained(f: ReturnType<typeof investorFixture>, id: string) {
  return JSON.parse((f.db.prepare("SELECT projection FROM investor_confirmed_payloads WHERE capture_id=?").get(id) as { projection: Buffer }).projection.toString()) as Obj;
}
function reseal(f: ReturnType<typeof investorFixture>, id: string, payload?: Obj, editReceipt?: (receipt: Obj) => void) {
  const row = f.db.prepare("SELECT * FROM investor_confirmed_captures WHERE id=?").get(id) as Obj;
  const receipt = JSON.parse(row.receipt_json) as Obj;
  f.db.exec("DROP TRIGGER IF EXISTS investor_confirmed_capture_no_update; DROP TRIGGER IF EXISTS investor_confirmed_payload_no_update; DROP TRIGGER IF EXISTS audit_events_no_update");
  if (payload) {
    const raw = Buffer.from(canonical(payload)); receipt.payload_sha256 = createHash("sha256").update(raw).digest("hex");
    f.db.prepare("UPDATE investor_confirmed_payloads SET projection=? WHERE capture_id=?").run(raw, id);
  }
  editReceipt?.(receipt);
  f.db.prepare("UPDATE investor_confirmed_captures SET receipt_json=?,receipt_hash=?,payload_sha256=?,qualification=?,status=?,retain_until=? WHERE id=?")
    .run(canonical(receipt), hash(receipt), receipt.payload_sha256, receipt.qualification, receipt.status, receipt.retain_until, id);
  f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical({ content_hash: hash(receipt) }), row.audit_id);
}

test("Node independently replays exact three-market confirmed callback receipts with no writes or financial effects", () => {
  const f = investorFixture();
  try {
    const value = seed(f); assert.equal(value.real_provider_called, false); assert.equal(value.fixture_transport, "stubbed_not_network_authenticated");
    const before = f.db.prepare("SELECT total_changes() n").get();
    const result = readInvestorConfirmedCapture(f.db, "w", value.capture_id, now);
    assert.deepEqual(result.receipt, value.receipt); assert.deepEqual(result.records, value.records); assert.equal(result.status, "complete");
    assert.equal(result.live_advice_eligible, false); assert.equal(result.receipt.confirmation_semantics, "pinned_sdk_local_engine_not_exchange_signoff");
    assert.equal(result.receipt.network_bytes_preserved, false); assert.equal(result.receipt.stream_continuity_verified, false);
    assert.deepEqual(result.records.map(row => row.value), Array(3).fill("11.250000000000000001"));
    const envelope = retained(f, value.capture_id); assert.equal(envelope.frames[1].projection.candlestick.volume, "9007199254740993");
    assert.ok(Array.isArray(result.receipt.bindings));
    assert.equal(result.receipt.bindings[1].target.close_at, "2026-01-02T04:00:00.000000Z");
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); noFinance(f);
  } finally { f.close(); }
});

test("partial and empty attempts remain partial or empty, not complete quote coverage", () => {
  for (const count of [1, 0]) {
    const f = investorFixture();
    try {
      const value = seed(f, ["--bars", String(count)]), result = readInvestorConfirmedCapture(f.db, "w", value.capture_id, now);
      assert.deepEqual(result.records, value.records); assert.equal(result.records.length, count);
      assert.equal(result.status, count ? "partial" : "no_confirmed_events");
      reseal(f, value.capture_id, undefined, receipt => { receipt.status = "complete"; });
      assert.throws(() => readInvestorConfirmedCapture(f.db, "w", value.capture_id, now), invalid); noFinance(f);
    } finally { f.close(); }
  }
});

test("synthetic receipt needs explicit test allowance and cannot be promoted by metadata-only relabeling", () => {
  const f = investorFixture();
  try {
    const value = seed(f, ["--synthetic"]);
    assert.throws(() => readInvestorConfirmedCapture(f.db, "w", value.capture_id, now), invalid);
    assert.deepEqual(readInvestorConfirmedCapture(f.db, "w", value.capture_id, now, true).records, value.records);
    reseal(f, value.capture_id, undefined, receipt => { receipt.qualification = "isolated_official_sdk_callback"; });
    assert.throws(() => readInvestorConfirmedCapture(f.db, "w", value.capture_id, now), invalid); noFinance(f);
  } finally { f.close(); }
});

test("canonical protocol replay rejects resealed finality, numeric aliases, mapping, clock and OHLC defects", () => {
  const f = investorFixture();
  try {
    const value = seed(f), original = retained(f, value.capture_id);
    const edits: ((payload: Obj) => void)[] = [
      p => { p.frames[1].projection.source.is_confirmed = 1; },
      p => { p.frames[1].projection.source.is_confirmed = false; },
      p => { p.frames[1].projection.source.network_bytes_preserved = 0; },
      p => { p.frames[1].projection.source.subscription_snapshot_used = true; },
      p => { p.frames[1].projection.source.received_at = "2026-01-02T07:00:00.000000Z"; },
      p => { p.frames[1].projection.candlestick.volume = "9223372036854775808"; },
      p => { p.frames[1].projection.candlestick.high = "1"; },
      p => { p.frames[1].projection.candlestick.timestamp = "2026-01-01T00:00:00.000000Z"; },
      p => { p.frames[1].projection.candlestick.trade_session = false; },
      p => { p.frames[1].projection.target.mapping.provider_symbol = "501998.SH"; },
      p => { p.frames[2].projection = structuredClone(p.frames[1].projection); },
      p => { p.frames.at(-1).events = 2; },
      p => { p.frames[0].request_hash = "0".repeat(64); },
      p => { p.frames[0].started_at = "2026-01-03T00:00:00.000000Z"; },
    ];
    for (const [index, edit] of edits.entries()) {
      const payload = structuredClone(original); edit(payload);
      for (const frame of payload.frames) if (frame.frame === "bar") frame.sha256 = hash(frame.projection);
      const protocol = Buffer.from(payload.frames.map((frame: Obj) => canonical(frame) + "\n").join(""));
      assert.throws(() => replayConfirmedProtocol(protocol, value.receipt.request, original.call_started_at, original.call_returned_at), invalid, `case ${index}`);
      reseal(f, value.capture_id, payload);
      assert.throws(() => readInvestorConfirmedCapture(f.db, "w", value.capture_id, now), invalid, `persisted case ${index}`);
    }
    noFinance(f);
  } finally { f.close(); }
});

test("protocol needs canonical UTF-8 NDJSON, exact requests and unambiguous scalar types", () => {
  const f = investorFixture();
  try {
    const value = seed(f), p = retained(f, value.capture_id), raw = Buffer.from(p.frames.map((frame: Obj) => canonical(frame) + "\n").join(""));
    const replay = (bytes: Buffer, input = value.receipt.request) => replayConfirmedProtocol(bytes, input, p.call_started_at, p.call_returned_at);
    for (const bytes of [raw.subarray(0, -1), Buffer.concat([raw, Buffer.from("\n")]), Buffer.from(raw.toString().replace('"frame":"ready"', '"frame":"ready","frame":"ready"')),
      Buffer.from(raw.toString().replace('"is_confirmed":true', '"is_confirmed":1')), Buffer.from(raw.toString().replace('"trade_session":0', '"trade_session":-0')),
      Buffer.concat([Buffer.from([0xff]), raw])]) assert.throws(() => replay(bytes), invalid);
    for (const edit of [(input: Obj) => { input.watch_seconds = true; }, (input: Obj) => { input.targets.reverse(); },
      (input: Obj) => { input.targets[0].mapping.listing_id += "\n"; }, (input: Obj) => { input.allow_history_fallback = true; }]) {
      const input = structuredClone(value.receipt.request); edit(input); assert.throws(() => replay(raw, input), invalid);
    }
    noFinance(f);
  } finally { f.close(); }
});

test("scope, retention, owner, audit and normalized target corruption fail closed", () => {
  const f = investorFixture();
  try {
    const value = seed(f), read = () => readInvestorConfirmedCapture(f.db, "w", value.capture_id, now);
    assert.throws(() => readInvestorConfirmedCapture(f.db, "other", value.capture_id, now), invalid);
    assert.throws(() => readInvestorConfirmedCapture(f.db, "w", value.capture_id, "2026-01-02T22:00:02.000Z"), invalid);
    assert.throws(() => readInvestorConfirmedCapture(f.db, "w", value.capture_id, value.receipt.retain_until), invalid);
    assert.throws(() => readInvestorConfirmedCapture(f.db, "w", value.capture_id, now, 1 as unknown as boolean), invalid);
    f.db.exec("DROP TRIGGER investor_workspace_update; DROP TRIGGER audit_events_no_update");
    f.db.prepare("UPDATE investor_workspaces SET owner_id='other' WHERE id='w'").run(); assert.throws(read, invalid);
    f.db.prepare("UPDATE investor_workspaces SET owner_id='synthetic-investor' WHERE id='w'").run();
    const row = f.db.prepare("SELECT * FROM investor_confirmed_captures WHERE id=?").get(value.capture_id) as Obj;
    f.db.prepare("UPDATE audit_events SET actor_id='other' WHERE id=?").run(row.audit_id); assert.throws(read, invalid);
    f.db.prepare("UPDATE audit_events SET actor_id='synthetic-investor' WHERE id=?").run(row.audit_id);
    f.db.exec("DROP TRIGGER investor_confirmed_target_no_update");
    f.db.prepare("UPDATE investor_confirmed_targets SET listing_review_id=rights_review_id WHERE capture_id=?").run(value.capture_id);
    assert.throws(read, invalid); noFinance(f);
  } finally { f.close(); }
});

test("current source approval is checked independently and withdrawn rights reject an otherwise intact capture", () => {
  const f = investorFixture();
  try {
    const value = seed(f), rights = value.receipt.bindings[0].reviews.rights;
    const row = f.db.prepare("SELECT * FROM investor_data_reviews WHERE id=?").get(rights.review_id) as Obj;
    const document = { ...JSON.parse(row.document_json), version: 2, decision: "withdrawn", facts: null, reason: "Fictional withdrawal" };
    f.db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('confirmed-withdraw-audit','synthetic-investor','investor_review_data_source','investor_data_review','confirmed-withdraw',?,?)")
      .run(canonical({ content_hash: hash(document) }), now);
    f.db.prepare("INSERT INTO investor_data_reviews(id,workspace_id,source_id,version,decision,document_json,content_hash,actor_id,created_at,valid_until,audit_id) VALUES('confirmed-withdraw','w',?,2,'withdrawn',?,?,'synthetic-investor',?,?,'confirmed-withdraw-audit')")
      .run(row.source_id, canonical(document), hash(document), now, row.valid_until);
    const before = f.db.prepare("SELECT total_changes() n").get();
    assert.throws(() => readInvestorConfirmedCapture(f.db, "w", value.capture_id, now), invalid);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    assert.ok(f.db.prepare("SELECT 1 FROM investor_confirmed_payloads WHERE capture_id=?").get(value.capture_id)); noFinance(f);
  } finally { f.close(); }
});

test("a resealed receipt cannot extend its rights-derived retention deadline", () => {
  const f = investorFixture();
  try {
    const value = seed(f); reseal(f, value.capture_id, undefined, receipt => { receipt.retain_until = "2026-12-31T00:00:00.000Z"; });
    f.db.prepare("UPDATE investor_confirmed_captures SET retain_until=? WHERE id=?").run("2026-12-31T00:00:00.000Z", value.capture_id);
    assert.throws(() => readInvestorConfirmedCapture(f.db, "w", value.capture_id, now), invalid); noFinance(f);
  } finally { f.close(); }
});

test("purge marker is authoritative even if an illicit payload remains", () => {
  const f = investorFixture();
  try {
    const value = seed(f); f.db.exec("DROP TRIGGER investor_confirmed_purge_insert");
    const audit = (f.db.prepare("SELECT audit_id FROM investor_confirmed_captures WHERE id=?").get(value.capture_id) as Obj).audit_id;
    f.db.prepare("INSERT INTO investor_confirmed_purges VALUES(?,'rights_no_longer_active','synthetic-investor',?,?)").run(value.capture_id, now, audit);
    assert.throws(() => readInvestorConfirmedCapture(f.db, "w", value.capture_id, now), invalid); noFinance(f);
  } finally { f.close(); }
});
