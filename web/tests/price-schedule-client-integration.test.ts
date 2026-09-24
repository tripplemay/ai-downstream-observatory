import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createPortfolio } from "../src/server/ledger/service";
import { storeMarketReferenceSource, publishMarketReference, type ReferenceDocument } from "../src/server/market-references/service";
import { savePriceCollectionSchedule, setPriceCollectionScheduleStatus } from "../src/server/price-schedules/service";
import { getPriceCollectionScheduleState } from "../src/server/price-schedules/queries";
import { assertPriceScheduleState, assertPriceScheduleReceipt, draftFromDefinition, preparePriceScheduleAttempt } from "../src/components/workbench/price-schedule-client";
import { priceBinding as binding, priceDraft } from "./price-schedule-test-fixture";

test("actual schedule services accept typed client save/enable/pause and return hash-verified next-D+1 state", async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "price-schedule-client-")), filename = path.join(directory, "workbench.db");
  t.after(() => rmSync(directory, { recursive: true, force: true })); migrateWorkbench(filename);
  const db = openWorkbench(filename), now = "2030-01-01T00:00:00.000000Z", actor = { id: "synthetic-owner", kind: "human" as const };
  try {
    const portfolio = createPortfolio(db, actor, "SYNTHETIC PRICE CLIENT INTEGRATION");
    db.prepare("INSERT INTO instruments(id,name,asset_class,created_at) VALUES('synthetic-instrument','SYNTHETIC ETF','ETF',?)").run(now);
    db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('synthetic-listing','synthetic-instrument','HK','XHKG','SYNTHETIC','HKD',?)").run(now);
    db.prepare("INSERT INTO catalog_entries(portfolio_id,listing_id,created_at) VALUES(?,'synthetic-listing',?)").run(portfolio, now);
    const source = storeMarketReferenceSource(db, actor, { portfolio_id: portfolio, idempotency_key: "source", reference: "Synthetic bounded reviewed reference", content_text: '{"synthetic":true}' }, { now });
    const publish = (document: ReferenceDocument, key: string) => publishMarketReference(db, actor, { portfolio_id: portfolio, idempotency_key: key, expected_version: 0, source_id: source.id, source_hash: source.content_hash, review_reason: "Synthetic human review only", acknowledgement: true, document }, { now });
    const mapping = publish({ kind: "mapping", facts: { provider: "longport", listing_id: "synthetic-listing", provider_symbol: "99999.HK", market: "HK", exchange: "XHKG", currency: "HKD", valid_from: "2030-01-01", valid_to: null } }, "mapping");
    const calendar = publish({ kind: "calendar", facts: { market: "HK", exchange: "XHKG", timezone: "Asia/Hong_Kong", range_start: "2030-01-02", range_end: "2030-01-04",
      days: [{ date: "2030-01-02", kind: "full", close_at: "2030-01-02T08:00:00.000000Z" }, { date: "2030-01-03", kind: "half", close_at: "2030-01-03T04:00:00.000000Z" }, { date: "2030-01-04", kind: "closed", close_at: null }] } }, "calendar");
    const read = async () => {
      const before = db.prepare("SELECT total_changes() n").get(), state = getPriceCollectionScheduleState(db, { portfolio_id: portfolio }, { now });
      assert.deepEqual(db.prepare("SELECT total_changes() n").get(), before);
      return assertPriceScheduleState({ ...state, session_binding: binding }, portfolio, null, binding);
    };
    const initial = await read(), draft = { ...priceDraft(), mappingIds: [mapping.id], calendarIds: [calendar.id] };
    assert.equal(initial.reference_candidates.length, 2); assert.deepEqual(initial.schedules, []);
    const pending = await preparePriceScheduleAttempt(initial, draft, binding, "save"), command = JSON.parse(pending.body).command;
    const saved = savePriceCollectionSchedule(db, actor, command, { now }); assertPriceScheduleReceipt({ ...saved, session_binding: binding }, pending);
    let state = await read(); assert.equal(state.schedules[0].status, "paused"); assert.equal(state.schedules[0].next_trigger_at, null);
    for (const operation of ["enabled", "paused"] as const) {
      const draft = { ...draftFromDefinition(saved.schedule_id, state.schedules[0].current_version.definition), operation, reason: "Synthetic explicit status transition" };
      const pending = await preparePriceScheduleAttempt(state, draft, binding, operation), command = JSON.parse(pending.body).command;
      const receipt = setPriceCollectionScheduleStatus(db, actor, command, { now }); assertPriceScheduleReceipt({ ...receipt, session_binding: binding }, pending);
      assert.deepEqual(setPriceCollectionScheduleStatus(db, actor, command, { now }), receipt);
      state = await read(); assert.equal(state.schedules[0].status, operation);
      assert.equal(state.schedules[0].next_target_date, operation === "enabled" ? "2030-01-02" : null);
      assert.equal(state.schedules[0].next_trigger_at, operation === "enabled" ? "2030-01-02T18:05:00.000000Z" : null);
    }
    for (const table of ["price_collection_schedule_slots", "command_requests", "job_runs", "ledger_events", "accounts"]) assert.equal((db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n, 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
