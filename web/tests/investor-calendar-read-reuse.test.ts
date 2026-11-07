import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import test from "node:test";
import { currentCalendarReview } from "../src/server/investor/calendar-continuation";
import { withInvestorKernelReadScope as scope } from "../src/server/investor/kernel-read-scope";
import type { VerifiedSourceReview } from "../src/server/investor/source-inputs";

function fixture() {
  const review = { source: { id: "fictional-calendar-source", kind: "calendar", created_at: "2026-01-01T00:00:00.000Z" },
    row: { id: "fictional-calendar-review", created_at: "2026-01-01T00:00:00.000Z", valid_until: "2027-01-01T00:00:00.000Z" },
    facts: { market: "US", range_start: "2026-01-02", range_end: "2026-01-02", days: [{ date: "2026-01-02", kind: "session",
      close_at: "2026-01-02T21:00:00.000Z", available_at: "2026-01-02T21:01:00.000Z",
      settled_at: "2026-01-05T21:00:00.000Z", settlement_rule_known_at: "2025-01-01T00:00:00.000Z" }] } } as unknown as VerifiedSourceReview;
  let latest = review.row.id, reads = 0;
  const db = { prepare(sql: string) {
    if (sql.startsWith("SELECT id FROM investor_data_reviews")) return { get() { reads++; return { id: latest }; } };
    if (sql.startsWith("SELECT * FROM investor_calendar_continuations")) return { get() { return undefined; } };
    throw new Error("UNEXPECTED_FICTIONAL_QUERY");
  } } as unknown as Database.Database;
  const read = (value = structuredClone(review)) => currentCalendarReview(db, "fictional-workspace", value,
    "2026-01-03T00:00:00.000Z", () => { throw new Error("FICTIONAL_MISSING_CONTINUATION"); });
  return { review, read, reads: () => reads, changeLatest: () => { latest = "fictional-new-review"; } };
}

test("complete calendar validation is reused only within its synchronous read; latest review lookup stays live", () => {
  const f = fixture(), Original = Intl.DateTimeFormat; let walks = 0;
  Intl.DateTimeFormat = function(...args: ConstructorParameters<typeof Original>) {
    const formatter = new Original(...args), original = formatter.formatToParts.bind(formatter);
    formatter.formatToParts = (date?: Date | number) => { walks++; return original(date); };
    return formatter;
  } as typeof Original;
  try {
    scope(() => { for (let n = 0; n < 20; n++) assert.deepEqual(f.read().facts, f.review.facts); });
    assert.equal(walks, 1); assert.equal(f.reads(), 20);
    f.read(); assert.equal(walks, 2);
    scope(() => { f.read(); f.changeLatest(); assert.throws(() => f.read()); });
    assert.equal(walks, 3); assert.equal(f.reads(), 23);
  } finally { Intl.DateTimeFormat = Original; }
});

test("cached calendar proof binds all consumed facts and metadata and never remembers a rejected value", () => {
  const f = fixture();
  const changes = [
    (v: VerifiedSourceReview) => { v.source.kind = "rights"; },
    (v: VerifiedSourceReview) => { v.source.created_at = "invalid"; },
    (v: VerifiedSourceReview) => { v.row.created_at = "invalid"; },
    (v: VerifiedSourceReview) => { v.row.valid_until = "invalid"; },
    (v: VerifiedSourceReview) => { v.facts.range_end = "2026-01-03"; },
    (v: VerifiedSourceReview) => { v.facts.market = "HK"; },
    ...["date", "close_at", "available_at", "settled_at", "settlement_rule_known_at"].map(field => (v: VerifiedSourceReview) => {
      const day = (v.facts.days as Record<string, unknown>[])[0];
      day[field] = field === "date" ? "2026-01-03" : field === "close_at" ? "2026-01-03T21:00:00.000Z"
        : field === "settlement_rule_known_at" ? "2026-01-03T21:00:00.000Z" : "2026-01-01T21:00:00.000Z";
    }),
  ];
  scope(() => {
    f.read();
    for (const change of changes) { const invalid = structuredClone(f.review); change(invalid); assert.throws(() => f.read(invalid)); }
    assert.deepEqual(f.read().facts, f.review.facts);
  });
});

test("calendar proof reuse binds every byte of a long calendar, including its last day", () => {
  const f = fixture(), start = Date.parse("2020-01-01T00:00:00Z");
  const days = Array.from({ length: 1095 }, (_, index) => ({ date: new Date(start + index * 86400000).toISOString().slice(0, 10),
    kind: "closed", close_at: null, available_at: null, settled_at: null, settlement_rule_known_at: null }));
  f.review.facts = { ...f.review.facts, range_start: days[0].date, range_end: days.at(-1)!.date, days };
  scope(() => {
    f.read(); f.read();
    const changed = structuredClone(f.review);
    (changed.facts.days as Record<string, unknown>[]).at(-1)!.date = "2020-01-01";
    assert.throws(() => f.read(changed)); assert.throws(() => f.read(changed));
    assert.deepEqual(f.read().facts, f.review.facts);
  });
});
