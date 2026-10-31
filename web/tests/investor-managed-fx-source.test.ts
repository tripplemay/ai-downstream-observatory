import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { investorFixture } from "./investor-fixture";
import { readInvestorSourceReview } from "../src/server/investor/source-inputs";
import { managedFxReviewUnavailable } from "../src/server/investor/managed-fx-source";
import { canonical, hash } from "../src/server/ledger/service";

type Obj = Record<string, unknown>;
type Ref = { review_id: string; review_hash: string; source_id: string; source_hash: string; facts_hash: string };
type Fixture = ReturnType<typeof investorFixture>;
type Result = { workspace: string; authority_id: string; capture_id: string; head_id: string; refs: Record<string, Ref>; at: string;
  latest_publication: Obj; publications: number; review_count: number; raw_payload_count: number; models: number;
  real_provider_called: boolean; real_gateway_called: boolean; financial_counts: Record<string, number> };
function python(f: Fixture, stage: string): Result {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", "tests.investor.managed_fx_fixture", "--db", f.filename, "--stage", stage], {
    cwd: path.resolve(process.cwd(), ".."), timeout: 20000, maxBuffer: 262144, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
}
function noMoney(result: Result) {
  assert.equal(result.real_provider_called, false); assert.equal(result.real_gateway_called, false); assert.equal(result.models, 0);
  assert.ok(Object.values(result.financial_counts).every(count => count === 0));
}

test("default Python roles publish under standing permission; Node independently replays XML with no readonly writes", () => {
  const f = investorFixture();
  try {
    const result = python(f, "init"); noMoney(result);
    assert.equal(result.latest_publication.human_review_performed, false); assert.equal(result.latest_publication.trading_permission, false);
    assert.equal(result.publications, 1); assert.equal(result.review_count, 2);
    const before = f.db.prepare("SELECT total_changes() n").get();
    for (const [currency, ref] of Object.entries(result.refs)) {
      const value = readInvestorSourceReview(f.db, result.workspace, ref, result.at);
      assert.equal(value.facts.currency, currency); assert.equal(hash(value.facts), ref.facts_hash);
      assert.equal((value.facts.monitor_series as Obj).authority_id, result.authority_id);
      assert.equal(managedFxReviewUnavailable(f.db, result.workspace, ref.review_id, result.at), null);
    }
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  } finally { f.close(); }
});

test("new head does not revoke the exact old source; duplicate raw/tail creates no fresh review", () => {
  const f = investorFixture();
  try {
    const first = python(f, "init"), next = python(f, "advance"); noMoney(next);
    assert.equal(next.publications, 2); assert.equal(next.review_count, 4); assert.notEqual(next.head_id, first.head_id);
    for (const ref of Object.values(first.refs)) assert.ok(readInvestorSourceReview(f.db, first.workspace, ref, next.at));
    for (const ref of Object.values(next.refs)) assert.ok(readInvestorSourceReview(f.db, next.workspace, ref, next.at));
  } finally { f.close(); }
  const duplicate = investorFixture();
  try {
    const first = python(duplicate, "init"), same = python(duplicate, "unchanged");
    assert.equal(same.latest_publication.status, "unchanged"); assert.equal(same.head_id, first.head_id);
    assert.equal(same.review_count, 2); assert.equal(same.raw_payload_count, 1); noMoney(same);
  } finally { duplicate.close(); }
});

test("withdrawal, payload purge, expiry and a known restatement never leave an apparently current review", () => {
  for (const [stage, reason] of [["withdraw", "REFERENCE_SOURCE_NO_LONGER_CURRENT"], ["expire", "REFERENCE_SOURCE_EXPIRED"], ["restate", "REFERENCE_SOURCE_NO_LONGER_CURRENT"]]) {
    const f = investorFixture();
    try {
      const first = python(f, "init"), result = python(f, stage); noMoney(result);
      for (const ref of Object.values(first.refs)) {
        assert.equal(managedFxReviewUnavailable(f.db, first.workspace, ref.review_id, result.at), reason);
        assert.throws(() => readInvestorSourceReview(f.db, first.workspace, ref, result.at));
      }
      if (stage === "restate") { assert.equal(result.latest_publication.status, "blocked"); assert.equal(result.review_count, 2); }
      else assert.equal(result.raw_payload_count, 0);
    } finally { f.close(); }
  }
});

test("even self-consistent altered review amounts and their hash/audit cannot override independently replayed XML", () => {
  const f = investorFixture();
  try {
    const result = python(f, "init"), ref = { ...result.refs.USD };
    assert.ok(readInvestorSourceReview(f.db, result.workspace, ref, result.at));
    const row = f.db.prepare("SELECT * FROM investor_data_reviews WHERE id=?").get(ref.review_id) as Obj;
    const doc = JSON.parse(row.document_json as string) as { facts: { rows: { value: string }[] } };
    doc.facts.rows[0].value = "999"; const digest = hash(doc);
    f.db.exec("DROP TRIGGER investor_data_review_no_update; DROP TRIGGER audit_events_no_update; DROP TRIGGER investor_fx_publication_update");
    f.db.prepare("UPDATE investor_data_reviews SET document_json=?,content_hash=? WHERE id=?").run(canonical(doc), digest, ref.review_id);
    f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical({ content_hash: digest }), row.audit_id);
    const publication = f.db.prepare("SELECT * FROM investor_fx_publications WHERE id=?").get(result.head_id) as Obj;
    const published = JSON.parse(publication.document_json as string) as { refs: Record<string, Ref> };
    published.refs.USD.review_hash = digest; published.refs.USD.facts_hash = hash(doc.facts);
    const publicationHash = hash(published);
    f.db.prepare("UPDATE investor_fx_publications SET document_json=?,content_hash=? WHERE id=?").run(canonical(published), publicationHash, result.head_id);
    f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical({ content_hash: publicationHash }), publication.audit_id);
    ref.review_hash = digest;
    assert.throws(() => readInvestorSourceReview(f.db, result.workspace, ref, result.at));
  } finally { f.close(); }
});

test("capture, source-rule and raw tampering remain ineligible without mutating business state", () => {
  for (const field of ["raw", "authority", "capture", "control"]) {
    const f = investorFixture();
    try {
      const result = python(f, "init"), ref = result.refs.USD;
      assert.ok(readInvestorSourceReview(f.db, result.workspace, ref, result.at));
      if (field === "raw") {
        f.db.exec("DROP TRIGGER investor_fx_payload_update"); f.db.prepare("UPDATE investor_fx_payloads SET payload=?").run(Buffer.alloc((f.db.prepare("SELECT raw_bytes FROM investor_fx_payloads").get() as { raw_bytes: number }).raw_bytes, 32));
      } else if (field === "authority") {
        f.db.exec("DROP TRIGGER investor_fx_authority_update"); f.db.prepare("UPDATE investor_fx_authorities SET content_hash=? WHERE id=?").run("0".repeat(64), result.authority_id);
      } else if (field === "capture") {
        f.db.exec("DROP TRIGGER investor_fx_capture_update"); f.db.prepare("UPDATE investor_fx_captures SET content_hash=? WHERE id=?").run("0".repeat(64), result.capture_id);
      } else {
        f.db.exec("DROP TRIGGER investor_fx_control_update"); f.db.prepare("UPDATE investor_fx_controls SET content_hash=? WHERE enabled=1").run("0".repeat(64));
      }
      const before = f.db.prepare("SELECT total_changes() n").get();
      assert.throws(() => readInvestorSourceReview(f.db, result.workspace, ref, result.at));
      assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
      for (const name of Object.keys(result.financial_counts)) assert.equal((f.db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0);
    } finally { f.close(); }
  }
});
