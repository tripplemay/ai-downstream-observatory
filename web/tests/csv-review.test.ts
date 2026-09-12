import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { correctLedger } from "../src/server/ledger/corrections";
import { buildCsvReviewCandidates, csvEconomicHash, parseCsvReview, type CsvCandidateReview } from "../src/server/ledger/csv-review";
import { canonical, createAccount, createPortfolio, hash, recordFact, revision, type LedgerCommand } from "../src/server/ledger/service";

const actor = { id: "SYNTHETIC-CSV-REVIEW" }, now = "2026-08-01T00:00:00.000Z";
function command(overrides: Partial<LedgerCommand> = {}): LedgerCommand {
  return { portfolio_id: "p", expected_revision: 0, idempotency_key: randomUUID(), source_id: "synthetic", effective_at: "2026-01-01T02:00:00.000Z", time_precision: "second", source_timezone: "Asia/Shanghai", reason: "Synthetic record", fact: { type: "deposit", account_id: "a", currency: "CNY", amount: "10" }, ...overrides };
}
function fixture() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "etf-csv-review-"));
  const filename = path.join(dataDir, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, actor, "Synthetic review", now);
  const account = createAccount(db, actor, portfolio, "A", "Synthetic", "CNY", now);
  const other = createAccount(db, actor, portfolio, "B", "Synthetic", "CNY", now);
  const make = (overrides: Partial<LedgerCommand> = {}) => command({ portfolio_id: portfolio, expected_revision: revision(db, portfolio), fact: { type: "deposit", account_id: account, currency: "CNY", amount: "10" }, ...overrides });
  const record = (overrides: Partial<LedgerCommand> = {}) => recordFact(db, actor, make(overrides), now);
  return { db, portfolio, account, other, dataDir, make, record, close: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test("economic hash normalizes decimal and UTC seconds while excluding provenance and request metadata", () => {
  const original = command();
  const equivalent = command({ expected_revision: 200, source_id: "other-file", source_event_id: "other-id", reason: "Different memo", effective_at: "2026-01-01T10:00:00+08:00", source_timezone: "America/New_York", fact: { ...original.fact, amount: "10.000" } });
  assert.equal(csvEconomicHash(original), csvEconomicHash(equivalent));
  for (const change of [{ portfolio_id: "other" }, { effective_at: "2026-01-01T02:00:01Z" }, { fact: { ...original.fact, amount: "11" } }, { fact: { ...original.fact, account_id: "other" } }, { fact: { ...original.fact, currency: "USD" } }]) {
    assert.notEqual(csvEconomicHash(original), csvEconomicHash(command(change)));
  }
  const date = command({ effective_at: "2026-01-01", time_precision: "date" });
  assert.notEqual(csvEconomicHash(date), csvEconomicHash({ ...date, source_timezone: "UTC" }));
  assert.notEqual(csvEconomicHash(date), csvEconomicHash(original));
  const buy = command({ fact: { type: "buy", account_id: "a", currency: "CNY", listing_id: "listing", quantity: "1.00", price: "10.000" } });
  assert.equal(csvEconomicHash(buy), csvEconomicHash({ ...buy, fact: { ...buy.fact, quantity: "1", price: "10", fee: "0.00" } }));
  assert.notEqual(csvEconomicHash(buy), csvEconomicHash({ ...buy, fact: { ...buy.fact, fee: "0.01" } }));
  assert.throws(() => csvEconomicHash(command({ fact: { ...original.fact, amount: "NaN" } })), /INVALID_DECIMAL/);
});

test("dividend duplicate review distinguishes unknown tax, estimated tax, confirmed zero and net finality", () => {
  const original = command({ fact: { type: "dividend_accrual", account_id: "a", currency: "CNY", amount: "200" } });
  const explicitUnknown = { ...original, fact: { ...original.fact, tax_status: "unknown" as const } };
  const zero = { ...original, fact: { ...original.fact, tax: "0" } };
  assert.equal(csvEconomicHash(original), csvEconomicHash(explicitUnknown));
  assert.notEqual(csvEconomicHash(original), csvEconomicHash(zero));
  assert.equal(csvEconomicHash(zero), csvEconomicHash({ ...zero, fact: { ...zero.fact, tax: "0.00", tax_status: "confirmed" } }));
  assert.notEqual(csvEconomicHash(zero), csvEconomicHash({ ...zero, fact: { ...zero.fact, tax_status: "estimated" } }));
  const net = command({ fact: { type: "dividend_net", account_id: "a", currency: "CNY", amount: "180", net_status: "final" } });
  assert.notEqual(csvEconomicHash(net), csvEconomicHash({ ...net, fact: { ...net.fact, net_status: "provisional" } }));
  const breakdown = command({ fact: { type: "dividend_breakdown", account_id: "a", currency: "CNY", related_event_id: "root", gross_amount: "200.00", tax: "20.00", evidence_reference: "Synthetic evidence" } });
  assert.equal(csvEconomicHash(breakdown), csvEconomicHash({ ...breakdown, fact: { ...breakdown.fact, gross_amount: "200", tax: "20" } }));
});

test("active same-scope records from any source are candidates; possible matches cannot replace exact classification", () => {
  const f = fixture();
  try {
    const first = f.record({ source_id: "manual" });
    const second = f.record({ source_id: "different-csv", source_event_id: "broker-2", effective_at: "2026-01-01T03:00:00Z" });
    f.record({ fact: { type: "deposit", account_id: f.other, currency: "CNY", amount: "10" }, effective_at: "2026-01-01T03:00:00Z" });
    const before = revision(f.db, f.portfolio);
    const rows = [{ row: 1, command: f.make() }, { row: 2, command: f.make({ effective_at: "2026-01-01", time_precision: "date", source_event_id: "reliable" }) }];
    const candidates = buildCsvReviewCandidates(f.db, f.portfolio, f.account, rows);
    assert.deepEqual(candidates[0], { row: 1, missing_source_id: true, exact_event_ids: [first.event_id], possible_event_ids: [second.event_id], exact_prior_rows: [], possible_prior_rows: [] });
    assert.deepEqual(candidates[1], { row: 2, missing_source_id: false, exact_event_ids: [], possible_event_ids: [first.event_id, second.event_id], exact_prior_rows: [], possible_prior_rows: [1] });
    assert.equal(revision(f.db, f.portfolio), before);
    assert.deepEqual(buildCsvReviewCandidates(f.db, f.portfolio, f.account, rows), candidates);
  } finally { f.close(); }
});

test("date-only weak matching uses the second-precision record's source-local day, including midnight crossings", () => {
  const f = fixture();
  try {
    const event = f.record({ effective_at: "2026-01-01T18:00:00Z", source_timezone: "Asia/Shanghai" });
    const candidates = buildCsvReviewCandidates(f.db, f.portfolio, f.account, [
      { row: 1, command: f.make({ effective_at: "2026-01-02", time_precision: "date" }) },
      { row: 2, command: f.make({ effective_at: "2026-01-01", time_precision: "date" }) },
    ]);
    assert.deepEqual(candidates[0].possible_event_ids, [event.event_id]);
    assert.deepEqual(candidates[1].possible_event_ids, []);
  } finally { f.close(); }
});

test("prior-row candidates are earlier numeric rows even when input order differs, and null rows stay inert", () => {
  const f = fixture();
  try {
    const result = buildCsvReviewCandidates(f.db, f.portfolio, f.account, [
      { row: 4, command: f.make() }, { row: 1, command: f.make() }, { row: 3, command: null },
      { row: 2, command: f.make({ effective_at: "2026-01-01T04:00:00Z" }) },
    ]);
    assert.deepEqual(result.map(row => row.row), [4, 1, 3, 2]);
    assert.deepEqual(result[0].exact_prior_rows, [1]); assert.deepEqual(result[0].possible_prior_rows, [2]);
    assert.deepEqual(result[1].exact_prior_rows, []); assert.deepEqual(result[3].possible_prior_rows, [1]);
    assert.deepEqual(result[2], { row: 3, missing_source_id: false, exact_event_ids: [], possible_event_ids: [], exact_prior_rows: [], possible_prior_rows: [] });
    assert.throws(() => buildCsvReviewCandidates(f.db, f.portfolio, f.account, [{ row: 1, command: f.make() }, { row: 1, command: null }]), /CSV_REVIEW_ROW_INVALID/);
    assert.throws(() => buildCsvReviewCandidates(f.db, f.portfolio, f.other, [{ row: 1, command: f.make() }]), /CSV_REVIEW_SCOPE_MISMATCH/);
    assert.throws(() => buildCsvReviewCandidates(f.db, "wrong-portfolio", f.account, []), /CSV_REVIEW_SCOPE_MISMATCH/);
  } finally { f.close(); }
});

test("correction excludes superseded originals and reversal envelopes while retaining the active replacement", () => {
  const f = fixture();
  try {
    const original = f.record();
    const attachment = storeJsonAttachment(f.db, actor, { portfolio_id: f.portfolio, account_id: f.account, raw: '{"synthetic":"correction"}' }, { dataDir: f.dataDir, now });
    const result = correctLedger(f.db, actor, {
      portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: randomUUID(), attachment_id: attachment.id, reason: "Synthetic replacement",
      changes: [{ action: "replace", event_id: original.event_id, replacement: { effective_at: "2026-01-01T02:00:00.000Z", time_precision: "second", source_timezone: "Asia/Shanghai", fact: { type: "deposit", account_id: f.account, currency: "CNY", amount: "11" } } }],
    }, { dataDir: f.dataDir, now });
    const replacement = result.replacements.find(row => row.original_event_id === original.event_id)!.event_id;
    const candidates = buildCsvReviewCandidates(f.db, f.portfolio, f.account, [
      { row: 1, command: f.make() }, { row: 2, command: f.make({ fact: { type: "deposit", account_id: f.account, currency: "CNY", amount: "11" } }) },
    ]);
    assert.deepEqual(candidates[0].exact_event_ids, []); assert.deepEqual(candidates[0].possible_event_ids, []);
    assert.deepEqual(candidates[1].exact_event_ids, [replacement]);
  } finally { f.close(); }
});

function reviewFixture() {
  const candidates: CsvCandidateReview[] = [
    { row: 1, missing_source_id: true, exact_event_ids: ["event-1"], possible_event_ids: ["possible-event"], exact_prior_rows: [], possible_prior_rows: [] },
    { row: 2, missing_source_id: true, exact_event_ids: [], possible_event_ids: [], exact_prior_rows: [1], possible_prior_rows: [] },
    { row: 3, missing_source_id: true, exact_event_ids: [], possible_event_ids: [], exact_prior_rows: [], possible_prior_rows: [2] },
  ];
  const reviewHash = hash(candidates);
  const input = { acknowledge_unverified_mapping: true, review_hash: reviewHash, rows: [
    { row: 1, action: "link_existing", event_id: "event-1", reason: "Compare original evidence" },
    { row: 2, action: "link_prior_row", prior_row: 1, reason: "Repeated CSV record" },
    { row: 3, action: "record_distinct", reason: "Separate occurrence, checked manually" },
  ] };
  return { candidates, reviewHash, input };
}

test("strict review requires exactly the requested rows, bound hash, acknowledgment and nonblank reasons", () => {
  const f = reviewFixture(), parse = (input: unknown) => parseCsvReview(input, [1, 2, 3], f.candidates, f.reviewHash);
  assert.equal(parse(f.input).size, 3);
  assert.throws(() => parse({ ...f.input, unexpected: true }), /CSV_REVIEW_INVALID/);
  assert.throws(() => parse({ ...f.input, acknowledge_unverified_mapping: false }), /CSV_REVIEW_INVALID/);
  assert.throws(() => parse({ ...f.input, review_hash: "0".repeat(64) }), /CSV_REVIEW_HASH_MISMATCH/);
  assert.throws(() => parse({ ...f.input, rows: f.input.rows.slice(1) }), /CSV_REVIEW_ROWS_MISMATCH/);
  assert.throws(() => parse({ ...f.input, rows: [...f.input.rows, f.input.rows[0]] }), /CSV_REVIEW_ROWS_MISMATCH/);
  assert.throws(() => parse({ ...f.input, rows: [...f.input.rows, { row: 4, action: "record_distinct", reason: "Extra" }] }), /CSV_REVIEW_ROWS_MISMATCH/);
  assert.throws(() => parse({ ...f.input, rows: f.input.rows.map(row => ({ ...row, reason: " \t\n" })) }), /CSV_REVIEW_INVALID/);
  assert.throws(() => parse({ ...f.input, rows: [{ ...f.input.rows[0], prior_row: 1 }, ...f.input.rows.slice(1)] }), /CSV_REVIEW_INVALID/);
  assert.throws(() => parseCsvReview(f.input, [1, 1, 3], f.candidates, f.reviewHash), /CSV_REVIEW_ROW_INVALID/);
  assert.equal(parseCsvReview({ ...f.input, rows: [] }, [], f.candidates, f.reviewHash).size, 0);
});

test("link decisions accept only exact scoped candidates and earlier exact rows, never weak matches", () => {
  const f = reviewFixture(), parse = (rows: unknown[]) => parseCsvReview({ ...f.input, rows }, [1, 2, 3], f.candidates, f.reviewHash);
  assert.throws(() => parse([{ ...f.input.rows[0], event_id: "possible-event" }, ...f.input.rows.slice(1)]), /CSV_REVIEW_LINK_NOT_EXACT/);
  assert.throws(() => parse([{ ...f.input.rows[0], event_id: "unrelated" }, ...f.input.rows.slice(1)]), /CSV_REVIEW_LINK_NOT_EXACT/);
  assert.throws(() => parse([...f.input.rows.slice(0, 2), { row: 3, action: "link_prior_row", prior_row: 2, reason: "Weak only" }]), /CSV_REVIEW_LINK_NOT_EXACT/);
  const forged = structuredClone(f.candidates); forged[1].exact_prior_rows.push(2, 3);
  for (const prior_row of [2, 3]) assert.throws(() => parseCsvReview({ ...f.input, rows: [f.input.rows[0], { ...f.input.rows[1], prior_row }, f.input.rows[2]] }, [1, 2, 3], forged, f.reviewHash), /CSV_REVIEW_LINK_NOT_EXACT/);
});

test("50k scoped facts plus 10k rows use batched scope lookup, preserving all matches without writes", () => {
  const f = fixture();
  try {
    // Bulk synthetic event fixtures exercise candidate indexing, not accounting correctness.
    const insert = f.db.prepare("INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,time_precision,source_timezone,recorded_at,source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id,reason) VALUES(?,?,?,'deposit',?,'second',?,?,'synthetic-load',?,?,?,?,'synthetic','Synthetic load only')");
    f.db.transaction(() => {
      for (let i = 1; i <= 50000; i++) {
        const value = f.make({ fact: { type: "deposit", account_id: f.account, currency: "CNY", amount: String(i) } });
        insert.run(`event-${i}`, f.portfolio, f.account, value.effective_at, value.source_timezone, now, `load-${i}`, hash(value), canonical(value), i);
      }
    })();
    const rows = Array.from({ length: 10000 }, (_, i) => ({ row: i + 1, command: f.make({ fact: { type: "deposit", account_id: f.account, currency: "CNY", amount: String(i + 1) } }) }));
    const result = buildCsvReviewCandidates(f.db, f.portfolio, f.account, rows);
    assert.equal(result.length, 10000);
    for (let i = 0; i < result.length; i++) {
      assert.deepEqual(result[i].exact_event_ids, [`event-${i + 1}`]);
      assert.deepEqual(result[i].possible_event_ids, []); assert.deepEqual(result[i].exact_prior_rows, []);
    }
    assert.equal(revision(f.db, f.portfolio), 0);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM postings").get() as { n: number }).n, 0);
  } finally { f.close(); }
});

test("dense duplicate candidate output fails explicitly instead of silently dropping rows or candidate IDs", () => {
  const f = fixture();
  try {
    const rows = Array.from({ length: 500 }, (_, index) => ({ row: index + 1, command: f.make() }));
    assert.throws(() => buildCsvReviewCandidates(f.db, f.portfolio, f.account, rows), /CSV_REVIEW_CANDIDATE_LIMIT/);
    assert.equal(revision(f.db, f.portfolio), 0);
  } finally { f.close(); }
});
