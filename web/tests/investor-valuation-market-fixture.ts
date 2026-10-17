import { hash, revision } from "../src/server/ledger/service";
import { enqueueWorkbenchTask } from "../src/server/workbench-commands";
import { holdingsPython, investorHoldingsFixture, holdingsNow } from "./investor-holdings-fixture";

export const valuationAt = (n: number) => new Date(Date.parse(holdingsNow) + n * 1000).toISOString();
export function publishValuationFixtureMarket(f: ReturnType<typeof investorHoldingsFixture>) {
  const document = (kind: "prices" | "fx", records: Record<string, unknown>[]) => {
    const id = "FICTIONAL:" + kind;
    return { schema_version: "market-batch-v1", batch: { id, scope: id, source_id: "FICTIONAL", batch_type: kind, expected_pages: 1,
      expected_rows: records.length, expected_publication_revision: 0, source_mode: "manual_verified", source_evidence: "Fictional local test only, not provider evidence" },
      pages: [{ page_number: 1, observations: records.map((record, index) => ({ id: id + ":" + index, batch_id: id, source_id: "FICTIONAL",
        observed_at: "2026-01-02T11:59:59.000Z", ingested_at: holdingsNow, published_at: holdingsNow, source_timezone: "Asia/Shanghai", time_precision: "second",
        revision_id: "fictional-v1", raw_hash: hash(record), parser_version: "fictional-v1", provenance: "live_observed", ...record })) }] };
  };
  const documents = [document("prices", [
    { listing_id: f.alpha, series_key: f.alpha, metric: "close", price_basis: "unadjusted", unit: "CNY", value: "10" },
    { listing_id: f.outside, series_key: f.outside, metric: "close", price_basis: "unadjusted", unit: "CNY", value: "20" }]),
  document("fx", [{ series_key: "FX:USD", metric: "fx_cny_per_unit", price_basis: "not_applicable", unit: "CNY_per_unit_currency", value: "7" }])];
  for (const document of documents) enqueueWorkbenchTask(f.db, f.actor, { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio),
    idempotency_key: document.batch.id, command_type: "market_ingest", payload: { document, publish: true } }, valuationAt(0));
  holdingsPython(f, "tests.investor.valuation_fixture", ["--now", valuationAt(1)]);
  return documents;
}
