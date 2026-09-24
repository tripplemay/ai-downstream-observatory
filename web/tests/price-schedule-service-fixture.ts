import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createPortfolio } from "../src/server/ledger/service";
import { publishMarketReference, storeMarketReferenceSource, type ReferenceDocument } from "../src/server/market-references/service";
import { savePriceCollectionSchedule, setPriceCollectionScheduleStatus } from "../src/server/price-schedules/service";

export const priceActor = { id: "synthetic-price-owner", kind: "human" as const };
export const priceNow = "2026-01-01T00:00:00.000000Z", priceDue = "2026-01-02T16:00:00.000000Z";
export function priceScheduleFixture(filename?: string) {
  const directory = filename ? path.dirname(filename) : mkdtempSync(path.join(os.tmpdir(), "price-schedule-service-"));
  const file = filename ?? path.join(directory, "workbench.db"); migrateWorkbench(file);
  const db = openWorkbench(file), portfolio = createPortfolio(db, priceActor, "Synthetic price schedule", priceNow), other = createPortfolio(db, priceActor, "Synthetic other scope", priceNow);
  db.prepare("INSERT INTO instruments(id,name,asset_class,created_at) VALUES('price-instrument','Synthetic ETF','ETF',?)").run(priceNow);
  db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('CN:PRICE','price-instrument','CN','TEST','000001','CNY',?)").run(priceNow);
  db.prepare("INSERT INTO catalog_entries(portfolio_id,listing_id,created_at) VALUES(?,'CN:PRICE',?)").run(portfolio, priceNow);
  const source = storeMarketReferenceSource(db, priceActor, { portfolio_id: portfolio, idempotency_key: "source", reference: "Synthetic human-reviewed evidence only", content_text: '{"synthetic":true}' }, { now: priceNow });
  const review = (document: ReferenceDocument, key: string, version = 0, now = priceNow) => publishMarketReference(db, priceActor, { portfolio_id: portfolio, idempotency_key: key, expected_version: version, source_id: source.id, source_hash: source.content_hash, review_reason: "Synthetic explicit review, not provider verification", acknowledgement: true, document }, { now });
  const mapping: ReferenceDocument = { kind: "mapping", facts: { provider: "longport", listing_id: "CN:PRICE", provider_symbol: "000001.SH", market: "CN", exchange: "TEST", currency: "CNY", valid_from: "2026-01-01", valid_to: null } };
  const calendar: ReferenceDocument = { kind: "calendar", facts: { market: "CN", exchange: "TEST", timezone: "Asia/Shanghai", range_start: "2026-01-02", range_end: "2026-01-05", days: [
    { date: "2026-01-02", kind: "full", close_at: "2026-01-02T07:00:00.000000Z" },
    { date: "2026-01-03", kind: "closed", close_at: null },
    { date: "2026-01-04", kind: "half", close_at: "2026-01-04T04:00:00.000000Z" },
    { date: "2026-01-05", kind: "full", close_at: "2026-01-05T07:00:00.000000Z" },
  ] } };
  const mapped = review(mapping, "mapping"), calendared = review(calendar, "calendar");
  const definition = { schema_version: "price-collection-schedule-v1" as const, provider: "longport" as const, frequency: "daily" as const, publish: true as const,
    market: "CN" as const, timezone: "Asia/Shanghai" as const, mapping_version_ids: [mapped.id], calendar_version_ids: [calendared.id],
    start_date: "2026-01-02", end_date: "2026-01-05", trigger_local: { hour: 0, minute: 0 }, deadline_seconds: 3600, max_attempts: 2, missed_policy: "record_no_backfill" as const };
  const input = (patch = {}) => ({ portfolio_id: portfolio, expected_schedule_id: null, expected_schedule_revision: 0,
    definition_json: JSON.stringify(definition, null, 2) + "\n", reason: "Explicit synthetic recurring price data only", acknowledgement: true, idempotency_key: "save", ...patch });
  const saved = savePriceCollectionSchedule(db, priceActor, input(), { now: priceNow });
  const status = (patch = {}) => ({ portfolio_id: portfolio, schedule_id: saved.schedule_id, expected_schedule_revision: 1,
    status: "enabled", reason: "Explicit synthetic human authorization", acknowledgement: true, idempotency_key: "enable", ...patch });
  const enable = () => setPriceCollectionScheduleStatus(db, priceActor, status(), { now: priceNow });
  return { db, filename: file, directory, portfolio, other, source, review, mapping, calendar, mapped, calendared, definition, input, saved, status, enable,
    close() { db.close(); if (!filename) rmSync(directory, { recursive: true, force: true }); } };
}
