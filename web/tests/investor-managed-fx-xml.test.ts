import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { currentEcbCollectionWindow, replayCurrentEcbDraft } from "../src/server/investor/ecb-reference-source";
import { hash } from "../src/server/ledger/service";

const at = "2025-10-28T12:00:00.000Z";
test("collection identity and expiry use Berlin calendar days, including 23/25-hour DST days", () => {
  for (const [created, day, expiry] of [
    ["2026-01-03T00:00:00Z", "2026-01-03", "2026-01-03T23:00:00.000Z"],
    ["2026-03-29T00:00:00Z", "2026-03-29", "2026-03-29T22:00:00.000Z"],
    ["2026-10-24T23:00:00Z", "2026-10-25", "2026-10-25T23:00:00.000Z"],
  ]) assert.deepEqual(currentEcbCollectionWindow(created), { feed_day: day, valid_until: expiry });
  for (const created of ["2026-01-02T23:59:59.999999Z", "2026-03-28T23:59:59Z", "2026-10-24T22:59:59Z"])
    assert.throws(() => currentEcbCollectionWindow(created));
});
function xml(days: [string, [string, string][]][] = [["2025-10-26", [["CNY", "8.0000"], ["USD", "1.25"], ["HKD", "10"]]]]) {
  return Buffer.from("<?xml version='1.0' encoding='UTF-8'?><gesmes:Envelope xmlns:gesmes='http://www.gesmes.org/xml/2002-08-01' xmlns='http://www.ecb.int/vocabulary/2002-08-01/eurofxref'>"
    + "<gesmes:subject>Reference rates</gesmes:subject><gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender><Cube>"
    + days.map(([day, rates]) => "<Cube time='" + day + "'>" + rates.map(([currency, rate]) => "<Cube currency='" + currency + "' rate='" + rate + "'/>").join("") + "</Cube>").join("")
    + "</Cube></gesmes:Envelope>");
}
function python(raw: Buffer, retrievedAt = at, currencies = ["USD", "HKD"]) {
  const program = "import sys,json,base64;from worker.market.providers.ecb_current import build_current_fx_draft;b=json.load(sys.stdin);print(json.dumps(build_current_fx_draft(base64.b64decode(b['raw']),retrieved_at=b['at'],currencies=b['currencies'])))";
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", program], {
    cwd: path.resolve(process.cwd(), ".."), input: JSON.stringify({ raw: raw.toString("base64"), at: retrievedAt, currencies }),
    encoding: "utf8", timeout: 15000, maxBuffer: 1048576,
  }));
}

test("independent XML/date/rational replay equals the entire Python draft and content hash", () => {
  const raw = xml(), local = replayCurrentEcbDraft(raw, at, ["HKD", "USD"]), expected = python(raw, at, ["HKD", "USD"]);
  assert.deepEqual(local, expected); assert.equal(hash(local), hash(expected));
  assert.equal(local.facts.USD.rows[0].value, "6.4");
  assert.equal(local.facts.USD.rows[0].observed_at, "2025-10-25T22:00:00.000Z");
  assert.equal(local.facts.USD.rows[0].assumed_available_at, "2025-10-26T23:00:00.000Z");
  assert.equal(local.metadata.freshness_status, "not_assessed");
  assert.equal(local.owner_reviewed, false); assert.equal(local.production_admitted, false);
});

test("both DST boundaries, conservative pending and exact availability retain every source row", () => {
  const raw = xml([["2025-03-30", [["CNY", "8"], ["USD", "2"]]], ["2025-03-29", [["CNY", "8"], ["USD", "2"]]]]);
  for (const retrieved of ["2025-03-30T17:00:00.000Z", "2025-03-30T22:00:00.000Z", "2025-03-31T00:00:00.000001Z"]) {
    const local = replayCurrentEcbDraft(raw, retrieved, ["USD"]); assert.deepEqual(local, python(raw, retrieved, ["USD"]));
    assert.equal(local.facts.USD.rows.length, 2);
    assert.equal(local.metadata.availability_status, retrieved.startsWith("2025-03-30T17") ? "pending" : "available");
  }
});

test("exact BigInt half-even conversion does not rely on binary floats or ambient precision", () => {
  for (const [cny, usd, value] of [["1", "7", "0.142857142857142857"], ["1.000000000000000001", "2", "0.5"], ["1.000000000000000003", "2", "0.500000000000000002"]]) {
    const raw = xml([["2025-10-26", [["CNY", cny], ["USD", usd]]]]), local = replayCurrentEcbDraft(raw, at, ["USD"]);
    assert.equal(local.facts.USD.rows[0].value, value); assert.deepEqual(local, python(raw, at, ["USD"]));
  }
});

test("namespace alias, attribute order, BOM, comments and raw bytes remain hash-bound", () => {
  const text = xml().toString().replaceAll("gesmes:", "g:").replace("xmlns:gesmes=", "xmlns:g=").replace("<Cube time=", "<!-- private fictional marker --><Cube time=");
  const raw = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(text)]), local = replayCurrentEcbDraft(raw, at, ["USD"]);
  assert.deepEqual(local, python(raw, at, ["USD"]));
  assert.notEqual(local.metadata.raw_sha256, replayCurrentEcbDraft(xml(), at, ["USD"]).metadata.raw_sha256);
});

test("old source dates are not rewritten or made fresh by a later retrieval time", () => {
  const raw = xml(), local = replayCurrentEcbDraft(raw, "2025-12-31T00:00:00Z", ["USD"]);
  assert.deepEqual(local, python(raw, "2025-12-31T00:00:00Z", ["USD"]));
  assert.equal(local.metadata.last_rate_date, "2025-10-26"); assert.equal(local.metadata.freshness_status, "not_assessed");
});

test("XML, encoding, namespace, structure and resource-limit violations fail closed", () => {
  const good = xml().toString();
  for (const raw of [Buffer.alloc(0), Buffer.alloc(2097153), Buffer.from([255, 254]), Buffer.from("<!DOCTYPE a><a/>"),
    Buffer.from(good.replace("UTF-8", "latin1")), Buffer.from(good.replace("xmlns='http://www.ecb.int", "xmlns='https://wrong.invalid")),
    Buffer.from(good.replace("Reference rates", "Other")), Buffer.from(good.replace("<Cube time=", "<Extra><Cube time=")),
    Buffer.from(good + "<extra/>"), Buffer.from(good.replace("currency='CNY'", "currency='CNY' currency='USD'")),
    Buffer.from(good.replace("<?xml version='1.0' encoding='UTF-8'?>", "<?xml?>")), Buffer.from(good.replace("<?xml", "<?XML")), Buffer.from(" \n" + good)]) {
    assert.throws(() => replayCurrentEcbDraft(raw, at, ["USD"]));
  }
});

test("missing, duplicate, future and invalid dates/currencies/amounts never receive a zero or fallback", () => {
  const invalid = [xml([]), xml([["2025-10-26", [["USD", "1"]]]]), xml([["2025-10-26", [["CNY", "8"], ["CNY", "9"], ["USD", "1"]]]]),
    xml([["2025-10-26", [["CNY", "8"], ["XYZ", "1"], ["USD", "1"]]]]), xml([["2025-10-29", [["CNY", "8"], ["USD", "1"]]]]),
    xml([["2025-02-30", [["CNY", "8"], ["USD", "1"]]]]), xml([["2025-10-26", [["CNY", "8"], ["USD", "0"]]]]),
    xml([["2025-10-26", [["CNY", "8"], ["USD", "1e2"]]]]), xml([["2025-10-26", [["CNY", "8"], ["USD", "9".repeat(39)]]]])];
  for (const raw of invalid) assert.throws(() => replayCurrentEcbDraft(raw, at, ["USD"]));
  for (const requested of [[], ["EUR"], ["USD", "USD"], ["USD", "HKD", "EUR"]]) assert.throws(() => replayCurrentEcbDraft(xml(), at, requested));
});
