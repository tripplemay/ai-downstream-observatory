import assert from "node:assert/strict";
import test from "node:test";
import { securityTransferListing } from "../src/components/workbench/security-transfer-input";

test("receiving and returning a known lot never depend on the truncated listing directory", () => {
  const state = {
    listings: [],
    security_transits: [{ transfer_event_id: "out", source_account_id: "source", target_account_id: "target", listing_id: "beyond-page-1000", ticker: "000001", name: "Synthetic", currency: "USD", quantity: "1", cost_amount: "0", cost_known: 0 }],
  };
  assert.deepEqual(securityTransferListing(state, true, "out"), { id: "beyond-page-1000", currency: "USD" });
  assert.equal(securityTransferListing(state, true, "missing"), undefined);
  assert.equal(securityTransferListing(state, false, "beyond-page-1000"), undefined);
  assert.equal(securityTransferListing(state, true, "beyond-page-1000"), undefined);
});
