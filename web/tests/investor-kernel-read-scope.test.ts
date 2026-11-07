import { hash } from "../src/server/ledger/service";
import { parseSealedInvestorJson } from "../src/server/investor/sealed-json";
import assert from "node:assert/strict";
import test from "node:test";
import { withInvestorKernelReadScope as scope, verifyInvestorKernelProof as proof } from "../src/server/investor/kernel-read-scope";
import { actionPython, readActionFixtureTimings } from "./action-maintenance-fixture";
import { investorFixture } from "./investor-fixture";
import { FictionalPrerequisite } from "./fictional-prerequisite-fixture";
import { existsSync, linkSync, writeFileSync } from "node:fs";
import path from "node:path";

test("file-owned fictional prerequisites copy full metadata, raw BLOBs and rowids into distinct new cases", t => {
  const source=investorFixture();t.after(source.close);
  source.db.exec("CREATE TABLE fictional_copy(id TEXT PRIMARY KEY,payload BLOB)");
  source.db.prepare("INSERT INTO fictional_copy(rowid,id,payload) VALUES(17,'a',?)").run(Buffer.from([0,255,1]));
  const value={references:["a"],fictional:true},template=FictionalPrerequisite.capture(source,value)!;
  assert.ok(template);t.after(()=>template.close());
  value.references.push("caller-only");
  const first=template.instantiate(),second=template.instantiate();t.after(first.close);t.after(second.close);
  assert.notEqual(first.filename,second.filename);assert.notEqual(first.filename,source.filename);
  for(const copy of [first,second]) {
    assert.deepEqual(copy.db.prepare("SELECT rowid,* FROM fictional_copy").all(),source.db.prepare("SELECT rowid,* FROM fictional_copy").all());
    assert.deepEqual(copy.db.prepare("SELECT rowid,* FROM schema_migrations ORDER BY rowid").all(),source.db.prepare("SELECT rowid,* FROM schema_migrations ORDER BY rowid").all());
    assert.deepEqual(copy.value,{references:["a"],fictional:true});
    assert.equal(copy.db.pragma("journal_mode",{simple:true}),"wal");assert.equal(copy.db.pragma("foreign_keys",{simple:true}),1);
    assert.equal((copy.db.prepare("SELECT total_changes() n").get() as {n:number}).n,0);
  }
  (first.value.references as string[]).push("first-only");first.db.exec("UPDATE fictional_copy SET payload=x'10',rowid=19");
  source.db.exec("UPDATE fictional_copy SET payload=x'20',rowid=20");
  assert.deepEqual(second.value,{references:["a"],fictional:true});
  assert.deepEqual(second.db.prepare("SELECT rowid,payload FROM fictional_copy").get(),{rowid:17,payload:Buffer.from([0,255,1])});
  template.close();template.close();assert.throws(()=>template.instantiate(),/PREREQUISITE_CLOSED/);
  assert.ok(existsSync(second.filename));
});
test("fictional prerequisite capture declines oversize, lossy JSON and external scratch dependencies",t=>{
  const f=investorFixture();t.after(f.close);
  for(const value of [{tooLarge:"x".repeat(8*1024*1024)},{nan:NaN},{missing:undefined},{date:new Date(0)},{file:f.directory+"/raw.xml"}])
    assert.equal(FictionalPrerequisite.capture(f,value),null);
  const cycle:Record<string,unknown>={};cycle.self=cycle;assert.equal(FictionalPrerequisite.capture(f,cycle),null);
  f.db.exec("CREATE TABLE fictional_external(payload BLOB)");f.db.prepare("INSERT INTO fictional_external VALUES(?)").run(Buffer.from(f.directory+"/raw.xml"));
  assert.equal(FictionalPrerequisite.capture(f,{}),null);
});
test("fictional prerequisite scope rejects transactions, readonly, recovery and attachment before copying",t=>{
  for(const mode of ["transaction","readonly","recovery","attached","hardlink"]) {
    const f=investorFixture();t.after(f.close);
    if(mode==="transaction")f.db.exec("BEGIN");
    if(mode==="readonly")f.db.pragma("query_only=ON");
    if(mode==="attached")f.db.exec("ATTACH ':memory:' AS extra");
    if(mode==="recovery")writeFileSync(path.join(f.directory,"RESTORE_PENDING_REVIEW"),"Fictional recovery");
    if(mode==="hardlink")linkSync(f.filename,path.join(f.directory,"alias.db"));
    assert.throws(()=>FictionalPrerequisite.capture(f,{}));
    assert.equal((f.db.prepare("SELECT total_changes() n").get() as {n:number}).n,0);
  }
});
test("fictional prerequisite capture never copies financial facts or accepts a caller's unrelated path",t=>{
  const f=investorFixture();t.after(f.close);
  const before=f.db.prepare("SELECT rowid,* FROM schema_migrations ORDER BY rowid").all();
  assert.throws(()=>FictionalPrerequisite.capture({...f,filename:path.join(f.directory,"other.db")},{}));
  f.db.prepare("INSERT INTO portfolios(id,name,created_at) VALUES('fictional','Fictional scope refusal','2026-01-01T00:00:00Z')").run();
  assert.throws(()=>FictionalPrerequisite.capture(f,{}));
  assert.equal((f.db.prepare("SELECT count(*) n FROM portfolios").get() as {n:number}).n,1);
  assert.deepEqual(f.db.prepare("SELECT rowid,* FROM schema_migrations ORDER BY rowid").all(),before);
});

const key = (n: number) => () => n.toString(16).padStart(64, "0");
test("offline timing diagnostics contain only bounded fixed scalar phases, never child documents or warnings", () => {
  const row={phase:"progress",checks:128,validated:8,hits:120,uncacheable:0,entries:8,key_ms:5.1,validation_ms:12,elapsed_ms:18};
  const line=(value:unknown)=>"FICTIONAL_SHAPE_TIMING "+JSON.stringify(value)+"\n";
  assert.deepEqual(readActionFixtureTimings("foreign warning with fictional private content\n"+line(row)),[row]);
  for(const value of [null,[],{...row,secret:"FICTIONAL_PRIVATE_VALUE"},{...row,phase:"FICTIONAL_PRIVATE_VALUE"},
    {...row,key_ms:"1"},{...row,entries:9},{...row,hits:121},{...row,checks:-1},{...row,validated:1.5},
    {...row,uncacheable:9},{...row,elapsed_ms:null},{...row,key_ms:-1}]) {
    assert.throws(()=>readActionFixtureTimings(line(value)),error=>error instanceof Error&&error.message==="INVALID_ACTION_FIXTURE_TIMING");
  }
  for(const value of ["FICTIONAL_SHAPE_TIMING {\"secret\":",line({...row,phase:"x".repeat(2048)}),line(row).repeat(257),
    line(row).replace('"key_ms":5.1','"key_ms":1e999')])
    assert.throws(()=>readActionFixtureTimings(value),/^Error: INVALID_ACTION_FIXTURE_TIMING$/);
});
test("malformed offline diagnostics never replace an original child failure or turn a successful child into silent acceptance", t => {
  const f=investorFixture();t.after(f.close);
  const malformed="print('FICTIONAL_SHAPE_TIMING malformed',file=sys.stderr)\n";
  assert.throws(()=>actionPython(f.filename,malformed+"raise RuntimeError('FICTIONAL_ORIGINAL_CHILD_FAILURE')"),/FICTIONAL_ORIGINAL_CHILD_FAILURE/);
  assert.throws(()=>actionPython(f.filename,malformed+"print('{}')"),/^Error: INVALID_ACTION_FIXTURE_TIMING$/);
});
test("cheap legacy checks can opt out without retaining a proof", () => {
  let count = 0;
  scope(() => { for (let n = 0; n < 3; n++) proof(() => null, () => { count++; }); });
  assert.equal(count, 3);
});
test("proof reuse is synchronous, success-only, bounded and never survives the owning read", () => {
  let count = 0;
  const verify = () => { count++; };
  proof(() => { throw new Error("OUTSIDE_SCOPE_KEY_MUST_NOT_RUN"); }, verify);
  scope(() => { proof(key(1), verify); proof(key(1), verify); });
  assert.equal(count, 2);
  scope(() => { proof(key(1), verify); }); assert.equal(count, 3);
  assert.throws(() => scope(() => { proof(key(2), () => { throw new Error("FICTIONAL_INVALID_PROOF"); }); }), /FICTIONAL_INVALID_PROOF/);
  scope(() => {
    assert.throws(() => proof(key(2), () => { throw new Error("FICTIONAL_INVALID_PROOF"); }));
    proof(key(2), verify);
  }); assert.equal(count, 4);
  scope(() => {
    for (let n = 1; n <= 70; n++) proof(key(n), verify);
    for (let n = 1; n <= 70; n++) proof(key(n), verify);
  }); assert.equal(count, 80);
  assert.throws(() => scope(() => Promise.resolve(true)), /MUST_BE_SYNCHRONOUS/);
  proof(key(1), verify); assert.equal(count, 81);
});

test("nested reads have distinct proof sets, restore the parent on success/failure, and reject malformed keys", () => {
  let count = 0;
  const verify = () => { count++; };
  scope(() => {
    proof(key(1), verify);
    scope(() => { proof(key(1), verify); proof(key(1), verify); });
    assert.throws(() => scope(() => { proof(key(1), verify); throw new Error("FICTIONAL_READ_FAILURE"); }));
    proof(key(1), verify);
    assert.throws(() => proof(() => "unbound", verify), /PROOF_KEY_INVALID/);
  });
  assert.equal(count, 3);
  scope(() => proof(key(1), verify)); assert.equal(count, 4);
});

function scanCount(read: () => void) {
  const original = JSON.parse;
  let count = 0;
  JSON.parse = function(raw: string, ...args: unknown[]) {
    if (raw === '"probe"') count++;
    return Reflect.apply(original, JSON, [raw, ...args]);
  } as typeof JSON.parse;
  try { read(); return count; }
  finally { JSON.parse = original; }
}

test("one synchronous read verifies exact sealed JSON once but returns fresh independent values", () => {
  const original = { probe: { values: ["fictional", "1.00"] } }, raw = JSON.stringify(original), digest = hash(original);
  const count = scanCount(() => scope(() => {
    for (let index = 0; index < 20; index++) {
      const value = parseSealedInvestorJson(raw, digest) as typeof original;
      assert.deepEqual(value, original);
      value.probe.values[0] = "changed locally, not retained evidence";
    }
  }));
  assert.equal(count, 1, "repeated duplicate-key/depth and canonical seal checks are pure, not source authority");
});

test("same claimed seal never admits different raw bytes, duplicate keys, excess depth or rejected documents", () => {
  const original = { probe: 1 }, raw = JSON.stringify(original), digest = hash(original);
  scope(() => {
    assert.deepEqual(parseSealedInvestorJson(raw, digest), original);
    for (const invalid of ['{"probe":1,"probe":1}', '{"pr\\u006fbe":1,"probe":1}'])
      for (let attempt = 0; attempt < 2; attempt++) assert.throws(() => parseSealedInvestorJson(invalid, digest), /DUPLICATE_JSON_KEY/);
    assert.throws(() => parseSealedInvestorJson('{"probe":2}', digest), /EVIDENCE_INVALID/);
    assert.throws(() => parseSealedInvestorJson(raw, "a".repeat(64)), /EVIDENCE_INVALID/);
    const tooDeep = '{"probe":' + "[".repeat(64) + "0" + "]".repeat(64) + "}";
    for (let attempt = 0; attempt < 2; attempt++) assert.throws(() => parseSealedInvestorJson(tooDeep, hash(JSON.parse(tooDeep))), /JSON_DEPTH_EXCEEDED/);
    assert.throws(() => parseSealedInvestorJson("{", digest), SyntaxError);
    assert.deepEqual(parseSealedInvestorJson(raw, digest), original);
  });
});

test("nested, subsequent and standalone reads never inherit another read's JSON proof", () => {
  const value = { probe: "fictional" }, raw = JSON.stringify(value), digest = hash(value);
  const read = () => assert.deepEqual(parseSealedInvestorJson(raw, digest), value);
  const count = scanCount(() => {
    read(); read();
    scope(() => { read(); read(); scope(() => { read(); read(); }); read(); });
    scope(() => { read(); read(); });
    read();
  });
  assert.equal(count, 6);
});

test("wire representations, Unicode and negative zero retain the original strict-parser semantics", () => {
  for (const raw of ['{"probe":-0}', '{ "probe" : 1e2 }', '{"probe":"\\ud800"}', '{"probe":"\ud800"}', '{"probe":"\ufffd"}',
    '{"probe":{"__proto__":{"polluted":true}}}', '{"probe":' + "[".repeat(63) + "0" + "]".repeat(63) + "}"]) {
    const expected = JSON.parse(raw);
    scope(() => {
      assert.deepEqual(parseSealedInvestorJson(raw, hash(expected)), expected);
      assert.deepEqual(parseSealedInvestorJson(raw, hash(expected)), expected);
    });
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  for (const value of [null, [], true, 1, "text"]) assert.throws(() => parseSealedInvestorJson(JSON.stringify(value), hash(value)), /EVIDENCE_INVALID/);
  assert.throws(() => parseSealedInvestorJson("[1e400]", "a".repeat(64)), /EVIDENCE_INVALID/);
  scope(() => {
    const raw = '{"probe":"\ud800"}', digest = hash(JSON.parse(raw));
    parseSealedInvestorJson(raw, digest);
    assert.throws(() => parseSealedInvestorJson('{"probe":"\ufffd"}', digest), /EVIDENCE_INVALID/);
  });
});

test("JSON checks share the original 64-entry proof budget and never cache rejections", () => {
  const count = scanCount(() => scope(() => {
    for (let index = 0; index < 65; index++) {
      const value = { probe: index }, raw = JSON.stringify(value), digest = hash(value);
      parseSealedInvestorJson(raw, digest);
      parseSealedInvestorJson(raw, digest);
    }
    parseSealedInvestorJson('{"probe":0}', hash({ probe: 0 }));
    let checks = 0;
    proof(() => hash("additional-proof"), () => checks++);
    proof(() => hash("additional-proof"), () => checks++);
    assert.equal(checks, 2);
  }));
  assert.equal(count, 66);
  const bad = '{"probe":1,"probe":1}', digest = hash({ probe: 1 });
  const invalidScans = scanCount(() => scope(() => {
    for (let attempt = 0; attempt < 2; attempt++) assert.throws(() => parseSealedInvestorJson(bad, digest), /DUPLICATE_JSON_KEY/);
  }));
  assert.equal(invalidScans, 4);
});
