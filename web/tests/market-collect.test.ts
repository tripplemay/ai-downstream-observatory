import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createPortfolio, hash } from "../src/server/ledger/service";
import { enqueueWorkbenchTask } from "../src/server/workbench-commands";
import { marketCollectScope, type MarketCollectRequest } from "../src/server/market-source";
import { workbenchState } from "../src/server/ledger/queries";

const actor = { id: "synthetic-collector-owner" };
const payload: MarketCollectRequest = { provider: "ecb", feed: "daily", currencies: ["USD", "HKD"], expected_publication_revision: 0, publish: true };
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "market-collect-command-")), filename = path.join(directory, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, actor, "Synthetic collection");
  return { db, directory, portfolio, input: { portfolio_id: portfolio, expected_revision: 0, idempotency_key: "synthetic-collect", command_type: "market_collect", payload }, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test("fixed provider request is authenticated, immutable and queued, never a receipt or financial fact", () => {
  const f = fixture();
  try {
    const result = enqueueWorkbenchTask(f.db, actor, f.input);
    assert.deepEqual(enqueueWorkbenchTask(f.db, actor, f.input), result);
    assert.equal(result.payload_hash, hash(payload));
    assert.equal(marketCollectScope(payload), "provider:ecb:fx:daily:HKD-USD");
    const request = f.db.prepare("SELECT * FROM command_requests WHERE id=?").get(result.request_id) as { payload_json: string; actor_id: string };
    assert.deepEqual(JSON.parse(request.payload_json), payload); assert.equal(request.actor_id, actor.id);
    const state = workbenchState(f.db, actor, f.portfolio);
    assert.equal(state.tasks[0].command_type, "market_collect"); assert.equal(state.tasks[0].status, "queued");
    for (const table of ["ledger_events", "approval_events", "activations", "market_provider_captures", "market_publications"]) {
      assert.equal((f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n, 0);
    }
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...f.input, payload: { ...payload, publish: false } }), /DUPLICATE_CONFLICT/);
  } finally { f.close(); }
});
test("collection contract rejects caller transport, proofs, implicit currencies and numeric coercion", () => {
  const f = fixture();
  try {
    const patches = [{ url: "https://fixture.invalid" }, { headers: {} }, { token: "SYNTHETIC-NOT-A-CREDENTIAL" }, { source_mode: "provider_observed" }, { raw: "SYNTHETIC" }, { received_at: "2026-01-01T00:00:00Z" }, { provider_capture_id: "forged" }, { scope: "FX" }, { provider: "other" }, { feed: "history" }, { currencies: [] }, { currencies: ["USD", "USD"] }, { currencies: ["usd"] }, { currencies: ["XXX"] }, { currencies: ["USD", "HKD", "EUR", "CNY", "GBP", "CHF", "SGD", "JPY", "AUD"] }, { expected_publication_revision: "0" }, { expected_publication_revision: -1 }, { expected_publication_revision: Number.MAX_SAFE_INTEGER + 1 }, { publish: "true" }];
    for (const patch of patches) assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...f.input, payload: { ...payload, ...patch } }), /INVALID_MARKET_COLLECT/);
    for (const key of Object.keys(payload)) { const missing = { ...payload } as Record<string, unknown>; delete missing[key]; assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...f.input, payload: missing }), /INVALID_MARKET_COLLECT/); }
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM command_requests").get() as { n: number }).n, 0);
  } finally { f.close(); }
});
test("manual ingestion cannot occupy the reserved provider source or publication scope", () => {
  const f = fixture();
  try {
    const observation = { id: "synthetic-quote", batch_id: "synthetic-manual", source_id: "manual", series_key: "FX:USD", metric: "fx_cny_per_unit", value: "1", unit: "CNY_per_unit_currency", observed_at: "2025-01-01", ingested_at: "2025-01-02T00:00:00Z", source_timezone: "UTC", time_precision: "date", price_basis: "not_applicable", revision_id: "synthetic-1", raw_hash: "a".repeat(64), parser_version: "synthetic", provenance: "live_observed" };
    const document = { schema_version: "market-batch-v1", batch: { id: "synthetic-manual", source_id: "manual", batch_type: "fx", scope: "FX", expected_pages: 1, expected_rows: 1, expected_publication_revision: 0, source_mode: "manual_verified", source_evidence: "Synthetic test only" }, pages: [{ page_number: 1, observations: [observation] }] };
    for (const source of ["provider:ecb:reference-fx", "Provider:ecb:reference-fx"]) for (const field of ["source_id", "scope"]) assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...f.input, command_type: "market_ingest", payload: { document: { ...document, batch: { ...document.batch, [field]: source } }, publish: true } }), /RESERVED_MARKET_SOURCE/);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM command_requests").get() as { n: number }).n, 0);
  } finally { f.close(); }
});
test("collection queue retains scope, revision and restore guards, including exact retries", () => {
  const f = fixture();
  try {
    assert.throws(() => enqueueWorkbenchTask(f.db, { id: "" }, f.input), /UNAUTHENTICATED/);
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...f.input, portfolio_id: "absent" }), /PORTFOLIO_NOT_FOUND/);
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...f.input, expected_revision: 1 }), /VERSION_CONFLICT/);
    enqueueWorkbenchTask(f.db, actor, f.input);
    const other = createPortfolio(f.db, actor, "Synthetic other");
    assert.deepEqual(workbenchState(f.db, actor, other).tasks, []);
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "Synthetic restore guard\n");
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, f.input), /WORKBENCH_READ_ONLY/);
  } finally { f.close(); }
});
