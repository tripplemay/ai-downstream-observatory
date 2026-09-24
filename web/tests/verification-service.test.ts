import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { canonical, createPortfolio, hash } from "../src/server/ledger/service";
import { registerCompletedVerification } from "../src/server/governance/verification";
import { openWorkbench } from "../src/server/workbench-db";
import { checkVerificationArtifact, strictEvidenceJson } from "../src/server/verifications/checker";
import { verifiedExecution } from "../src/server/verifications/proof";
import { getVerificationState, readVerificationArtifact, requestVerification } from "../src/server/verifications/service";
import { verificationContext } from "../src/server/verifications/source";
import { VERIFICATION_CHECK_ID } from "../src/server/verifications/types";

const root = path.resolve(".."), at = "2026-01-05T00:00:00.000000Z", options = { now: at };
const human = { id: "SYNTHETIC-VERIFICATION-SERVICE", kind: "human" as const };
const bytesHash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "etf-verification-service-")), filename = path.join(dir, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, human, "SYNTHETIC engineering tests only", at);
  const input = { portfolio_id: portfolio, check_id: VERIFICATION_CHECK_ID, expected_context_hash: hash(verificationContext(portfolio)),
    reason: "SYNTHETIC verification; never investment approval", idempotency_key: "synthetic-request" };
  return { dir, filename, db, portfolio, input, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
let completed: ReturnType<typeof fixture>, baseline: Buffer, artifactBody: Buffer, requestId: string, executionId: string, artifactId: string;
before(() => {
  completed = fixture();
  requestId = requestVerification(completed.db, human, completed.input, options).request_id;
  const python = process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3";
  const result = spawnSync(python, ["-c", [
    "import sys", "from worker.orchestration.db import open_database,instant", "from worker.orchestration.runtime import run_pending_once",
    "db=open_database(sys.argv[1])", "result=run_pending_once(db,'synthetic-service-verifier',role='verifier',clock=lambda:instant(sys.argv[2]))",
    "assert result['status']=='succeeded',result", "db.close()",
  ].join(";"), completed.filename, at], { cwd: root, encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const state = getVerificationState(completed.db, { portfolio: completed.portfolio }, options), view = state.requests[0];
  assert.deepEqual(view.evidence_issues, []); assert.equal(view.execution?.status, "pass");
  executionId = view.execution!.id; artifactId = view.execution!.artifact_id;
  artifactBody = readVerificationArtifact(completed.db, completed.portfolio, artifactId, options).body;
  baseline = completed.db.serialize();
});
after(() => completed?.close());

test("verification service records a human request, not economic facts or an investment gate", () => {
  const state = getVerificationState(completed.db, { portfolio: completed.portfolio }, options), result = state.requests[0].execution!;
  assert.equal(state.check.available, true); assert.equal(result.current_runtime_match, true);
  assert.equal(result.execution_authority, "controlled_runner"); assert.equal(result.data_provenance, "synthetic");
  assert.equal(result.acceptance_scope, "engineering_subcheck"); assert.equal(result.result.gate_eligible, false);
  assert.deepEqual(result.result.completed_requirements, []); assert.equal(result.result.assertions.length, 6);
  for (const table of ["ledger_events", "valuation_runs", "performance_runs", "activations", "governance_verification_runs"]) {
    assert.equal((completed.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  }
  const job = completed.db.prepare("SELECT id FROM job_runs WHERE command_request_id=?").get(requestId) as { id: string };
  assert.throws(() => registerCompletedVerification(completed.db, job.id, at));
  assert.equal((completed.db.prepare("SELECT ledger_revision FROM audit_events WHERE action='request_verification'").get() as { ledger_revision: unknown }).ledger_revision, null);
});

test("artifact download preserves exact bytes and proof remains readable without installed source", () => {
  const blob = readVerificationArtifact(completed.db, completed.portfolio, artifactId, options);
  assert.deepEqual(blob.body, artifactBody); assert.equal(blob.sha256, bytesHash(artifactBody));
  assert.equal(checkVerificationArtifact(blob.body, blob.sha256).result.status, "pass");
  const state = getVerificationState(completed.db, {}, { ...options, sourceRoot: path.join(completed.dir, "absent") });
  assert.equal(state.check.available, false); assert.deepEqual(state.check.issues, ["VERIFICATION_SOURCE_UNAVAILABLE"]);
  assert.equal(state.requests[0].execution?.current_runtime_match, null); assert.deepEqual(state.requests[0].evidence_issues, []);
  assert.equal(verifiedExecution(completed.db, completed.portfolio, executionId, at, "0".repeat(64)).view.current_runtime_match, false);
  assert.throws(() => verifiedExecution(completed.db, completed.portfolio, executionId, "2026-01-04T00:00:00.000000Z", null), /EVIDENCE_INVALID/);
  assert.throws(() => readVerificationArtifact(completed.db, "other-portfolio", artifactId, options), /ARTIFACT_NOT_FOUND/);
});

test("exact request replay is bound to actor and input, even when source is later unavailable", () => {
  const f = fixture();
  try {
    const receipt = requestVerification(f.db, human, f.input, options);
    assert.deepEqual(requestVerification(f.db, human, f.input, { ...options, sourceRoot: path.join(f.dir, "absent") }), receipt);
    assert.throws(() => requestVerification(f.db, { ...human, id: "another-human" }, f.input, options), /IDEMPOTENCY_CONFLICT/);
    assert.throws(() => requestVerification(f.db, human, { ...f.input, reason: "changed" }, options), /IDEMPOTENCY_CONFLICT/);
    assert.equal((f.db.prepare("SELECT count(*) n FROM verification_requests").get() as { n: number }).n, 1);
    const state = getVerificationState(f.db, {}, options);
    assert.equal(state.requests[0].job_status, "queued"); assert.equal(state.requests[0].execution, null);
    writeFileSync(path.join(f.dir, "RESTORE_PENDING_REVIEW"), "SYNTHETIC TEST\n");
    assert.throws(() => requestVerification(f.db, human, f.input, options), /WORKBENCH_READ_ONLY/);
    assert.equal(getVerificationState(f.db, {}, options).read_only, true);
  } finally { f.close(); }
});

test("request boundary rejects caller-controlled execution, stale source, invalid identities and clocks atomically", () => {
  const f = fixture();
  try {
    for (const actor of [{ ...human, kind: "system" as const }, { ...human, id: "System:fixture" }, { ...human, id: "has space" }, { ...human, id: "x".repeat(161) }]) {
      assert.throws(() => requestVerification(f.db, actor, f.input, options), /PERMISSION_DENIED/);
    }
    for (const patch of [{ status: "pass" }, { command: "anything" }, { fixture: {} }, { reason: " " }, { reason: "x".repeat(1001) },
      { reason: "\ud800" }, { reason: "\udfff" }, { reason: "bad\u0000reason" }, { reason: "\u0085SYNTHETIC" }, { reason: "\u001cSYNTHETIC" },
      { idempotency_key: "bad key" }, { check_id: "E-02" }]) {
      assert.throws(() => requestVerification(f.db, human, { ...f.input, ...patch }, options), /COMMAND_INVALID/);
    }
    assert.throws(() => requestVerification(f.db, human, { ...f.input, expected_context_hash: "0".repeat(64) }, options), /CONTEXT_CHANGED/);
    assert.throws(() => requestVerification(f.db, human, { ...f.input, portfolio_id: "unknown" }, options), /PORTFOLIO_NOT_FOUND/);
    assert.throws(() => requestVerification(f.db, human, f.input, { now: "not-a-clock" }), /CLOCK_INVALID/);
    assert.throws(() => requestVerification(f.db, human, f.input, { ...options, sourceRoot: path.join(f.dir, "absent") }), /SOURCE_UNAVAILABLE/);
    for (const table of ["verification_requests", "command_requests", "command_dedup"]) {
      assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
    }
    const receipt = requestVerification(f.db, human, { ...f.input, reason: "\u{1f9ea}".repeat(1000) }, options);
    assert.ok(receipt.request_id);
  } finally { f.close(); }
});

test("replay cannot be redirected to a different valid request by replacing a dedup alias", () => {
  for (const actor of [human, { ...human, id: "another-human" }]) {
    const f = fixture();
    try {
      const first = requestVerification(f.db, human, f.input, options);
      const second = requestVerification(f.db, actor, { ...f.input, idempotency_key: "other-key", reason: "Other synthetic request" }, options);
      assert.notEqual(first.request_id, second.request_id);
      f.db.pragma("recursive_triggers = OFF");
      f.db.prepare(`INSERT OR REPLACE INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at)
        SELECT scope,idempotency_key,payload_hash,?,created_at FROM command_dedup WHERE scope=? AND idempotency_key=?`)
        .run(canonical(second), `verification-v2:${f.portfolio}`, f.input.idempotency_key);
      assert.throws(() => requestVerification(f.db, human, f.input, options), /EVIDENCE_INVALID/);
      assert.equal((f.db.prepare("SELECT count(*) n FROM verification_requests").get() as { n: number }).n, 2);
    } finally { f.close(); }
  }
});

test("request history uses portfolio-bound keyset pagination including equal timestamps", () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 3 }, (_, i) => requestVerification(f.db, human, { ...f.input, idempotency_key: `page:${i}` }, options).request_id).sort().reverse();
    const a = getVerificationState(f.db, { portfolio: f.portfolio, limit: 2 }, options);
    assert.deepEqual(a.requests.map(r => r.id), ids.slice(0, 2)); assert.ok(a.next_cursor);
    const b = getVerificationState(f.db, { portfolio: f.portfolio, limit: 2, cursor: a.next_cursor! }, options);
    assert.deepEqual(b.requests.map(r => r.id), ids.slice(2)); assert.equal(b.next_cursor, null);
    const other = createPortfolio(f.db, human, "SYNTHETIC second scope", at);
    assert.throws(() => getVerificationState(f.db, { portfolio: other, cursor: a.next_cursor! }, options), /CURSOR_INVALID/);
    assert.throws(() => getVerificationState(f.db, { portfolio: other, request: ids[0] }, options), /REQUEST_NOT_FOUND/);
    assert.throws(() => getVerificationState(f.db, { portfolio: f.portfolio, cursor: a.next_cursor! + "=" }, options), /CURSOR_INVALID/);
    assert.equal(getVerificationState(f.db, { portfolio: f.portfolio, request: ids[0] }, options).requests[0].id, ids[0]);
  } finally { f.close(); }
});

test("strict evidence JSON rejects duplicate keys, floats, unsafe integers, Unicode damage and deep nesting", () => {
  assert.deepEqual(strictEvidenceJson('{"integer":9007199254740991,"decimal":"50.125","unicode":"\\ud83e\\uddea"}'), { integer: 9007199254740991, decimal: "50.125", unicode: "\u{1f9ea}" });
  for (const raw of ['{"x":1,"x":2}', '{"x":1e0}', '{"x":1.0}', '{"x":9007199254740992}', '{"x":"\\ud800"}', '{"\\udfff":1}', '\ufeff{}', "[".repeat(65) + "0" + "]".repeat(65)]) {
    assert.throws(() => strictEvidenceJson(raw), raw.slice(0, 80));
  }
  for (const bytes of [Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), artifactBody]), Buffer.alloc(1048577)]) assert.throws(() => checkVerificationArtifact(bytes));
  assert.throws(() => checkVerificationArtifact(artifactBody, "0".repeat(64)), /EVIDENCE_INVALID/);
});

test("a boolean cannot impersonate the first audit revision in independent decimal evidence", () => {
  const artifact = JSON.parse(artifactBody.toString("utf8"));
  const audit = artifact.ledger.audits.find((row: { action: string; ledger_revision: number }) => row.action === "record_fact" && row.ledger_revision === 1);
  audit.ledger_revision = true;
  assert.ok(checkVerificationArtifact(Buffer.from(canonical(artifact))).result.issues.includes("ASSERTION_FAILED:normal_service_audit"));
});

test("independent checker requires typed nonempty association identifiers and ledger request text", () => {
  const mutations = [
    (a: any) => { a.ledger.events[0].id = true; },
    (a: any) => { a.ledger.events[0].reason = false; },
    (a: any) => { a.ledger.events[0].idempotency_key = 0; },
    (a: any) => { a.ledger.postings[0].event_id = 1; },
    (a: any) => { a.ledger.postings[0].id = true; a.ledger.postings[1].id = 1; },
    (a: any) => { a.ledger.audits[0].id = true; a.ledger.audits[1].id = 1; },
    (a: any) => { a.ledger.audits[0].object_id = false; },
    (a: any) => { a.valuations[0].run.id = ""; },
    (a: any) => { a.valuations[0].items[0].id = null; },
    (a: any) => { a.valuations[0].items[0].run_id = true; },
    (a: any) => { a.performance.run.id = 1; },
    (a: any) => { const r = JSON.parse(a.performance.run.result_json); r.assumptions = Object.fromEntries(r.assumptions.map((key: string) => [key, true])); a.performance.run.result_json = canonical(r); },
    (a: any) => { const m = JSON.parse(a.performance.run.market_manifest); m.valuations[0].id = true; a.performance.run.market_manifest = canonical(m); },
    (a: any) => { const m = JSON.parse(a.performance.run.market_manifest); m.external_flow_evidence[0].posting_id = true; a.performance.run.market_manifest = canonical(m); },
  ];
  for (const mutate of mutations) {
    const artifact = JSON.parse(artifactBody.toString("utf8")); mutate(artifact);
    assert.throws(() => checkVerificationArtifact(Buffer.from(canonical(artifact))), /EVIDENCE_INVALID/);
  }
});

type Mutation = (db: Database.Database) => void;
const sql = (statement: string): Mutation => db => { db.exec(statement); };
function changeArtifact(db: Database.Database, mutate: (artifact: Record<string, unknown>) => void, pretty = false) {
  const artifact = JSON.parse(artifactBody.toString("utf8")) as Record<string, unknown>; mutate(artifact);
  const body = Buffer.from(pretty ? JSON.stringify(artifact, null, 2) : canonical(artifact)), digest = bytesHash(body);
  db.prepare("UPDATE verification_artifacts SET body=?,body_sha256=?").run(body, digest);
  db.prepare("UPDATE verification_executions SET artifact_sha256=?").run(digest);
}
const corruptions: [string, Mutation][] = [
  ["command actor", sql("UPDATE command_requests SET actor_id='system:other'")],
  ["command hash", sql("UPDATE command_requests SET payload_hash=printf('%064d',0)")],
  ["audit ledger revision", sql("UPDATE audit_events SET ledger_revision=1 WHERE action='request_verification'")],
  ["audit actor", sql("UPDATE audit_events SET actor_id='other' WHERE action='request_verification'")],
  ["audit input", sql("UPDATE audit_events SET payload_json='{}' WHERE action='request_verification'")],
  ["request context hash", sql("UPDATE verification_requests SET context_hash=printf('%064d',0)")],
  ["request timestamp", sql("UPDATE verification_requests SET requested_at='2026-01-05T00:00:01.000000Z'")],
  ["job terminal status", sql("UPDATE job_runs SET status='retry_queued'")],
  ["job result", sql("UPDATE job_runs SET result_json='{}'")],
  ["job fence", sql("UPDATE job_runs SET fencing_token=fencing_token+1")],
  ["job scope", sql("UPDATE job_runs SET scope='other'")],
  ["job period", sql("UPDATE job_runs SET period='2026-01-04'")],
  ["job retry budget", sql("UPDATE job_runs SET max_attempts=4")],
  ["job live lease", sql("UPDATE job_runs SET lease_owner='stale'")],
  ["attempt status", sql("UPDATE job_attempts SET status='failed'")],
  ["attempt error", sql("UPDATE job_attempts SET error_json='{}'")],
  ["attempt completion", sql("UPDATE job_attempts SET finished_at='2026-01-06T00:00:00.000000Z'")],
  ["artifact raw bytes", sql("UPDATE verification_artifacts SET body=CAST('{}' AS BLOB)")],
  ["artifact hash", sql("UPDATE verification_artifacts SET body_sha256=printf('%064d',0)")],
  ["artifact fence", sql("UPDATE verification_artifacts SET fencing_token=fencing_token+1")],
  ["execution status", sql("UPDATE verification_executions SET status='fail'")],
  ["execution authority", sql("UPDATE verification_executions SET execution_authority='user'")],
  ["execution result", sql("UPDATE verification_executions SET result_json='{}'")],
  ["execution time", sql("UPDATE verification_executions SET started_at='2026-01-06T00:00:00.000000Z'")],
  ["outbox missing", sql("DELETE FROM outbox WHERE topic='governance_verification.completed'")],
  ["outbox payload", sql("UPDATE outbox SET payload_json='{}' WHERE topic='governance_verification.completed'")],
  ["outbox timestamp", sql("UPDATE outbox SET created_at='2026-01-06T00:00:00.000000Z' WHERE topic='governance_verification.completed'")],
  ["rehash noncanonical bytes", db => changeArtifact(db, () => {}, true)],
  ["rehash envelope scope", db => changeArtifact(db, a => { (a.binding as Record<string, unknown>).request_id = "other"; })],
  ["rehash production profit claim", db => changeArtifact(db, a => {
    const run = (a.performance as { run: { result_json: string } }).run, result = JSON.parse(run.result_json);
    result.net_profit_cny = "50.125"; run.result_json = canonical(result);
  })],
];
for (const [name, mutate] of corruptions) test(`independent reader rejects ${name} even after database guards are bypassed`, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "etf-verification-corruption-")), filename = path.join(dir, "workbench.db");
  writeFileSync(filename, baseline);
  const db = new Database(filename);
  try {
    // Isolated corruption simulation, never a supported write path or a fabricated passing fixture.
    for (const { name: trigger } of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]) {
      db.exec(`DROP TRIGGER "${trigger.replaceAll('"', '""')}"`);
    }
    db.pragma("ignore_check_constraints = ON"); mutate(db);
    const state = getVerificationState(db, { portfolio: completed.portfolio }, options);
    assert.equal(state.requests[0].execution, null, name); assert.deepEqual(state.requests[0].evidence_issues, ["VERIFICATION_EVIDENCE_INVALID"], name);
    assert.throws(() => readVerificationArtifact(db, completed.portfolio, artifactId, options), /EVIDENCE_INVALID/, name);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
