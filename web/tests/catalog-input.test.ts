import assert from "node:assert/strict";
import test from "node:test";
import { parseHoldingsDraft, percentRatio, profileFromForm } from "../src/components/workbench/catalog-input";

test("catalog drafts retain exact weights, derive coverage and preserve unknown fields", () => {
  assert.deepEqual(parseHoldingsDraft('[{"security_id":"ISIN:TEST1","weight":"0.20"},{"security_id":"ISIN:TEST2","weight":"0.1"}]'), {
    items: [{ security_id: "ISIN:TEST1", weight: "0.20" }, { security_id: "ISIN:TEST2", weight: "0.1" }], coverage: "0.3",
  });
  assert.deepEqual(parseHoldingsDraft("[]"), { items: [], coverage: "0" });
  assert.equal(percentRatio(null), "未知"); assert.equal(percentRatio("0"), "0%"); assert.equal(percentRatio("0.00001"), "0.001%");
  const form = new FormData(); form.set("underlying_asset_class", "unknown"); form.set("distribution", "unknown"); form.set("replication", "unknown");
  assert.equal(profileFromForm(form).annual_expense_ratio, null); assert.deepEqual(profileFromForm(form).economic_regions, []);
});
test("catalog drafts reject duplicate IDs or JSON keys, negative/numeric weights and silent normalization", () => {
  for (const raw of [
    '[{"security_id":"ISIN:A","weight":0.5}]', '[{"security_id":"ISIN:A","weight":"-0.1"}]',
    '[{"security_id":"ISIN:A","weight":"0.5","weight":"0.2"}]',
    '[{"security_id":"ISIN:A","weight":"0.5"},{"security_id":"ISIN:A","weight":"0.5"}]',
    '[{"security_id":"ISIN:A","weight":"0.9"},{"security_id":"ISIN:B","weight":"0.2"}]',
    '[{"security_id":"a guessed name","weight":"0.5"}]', '[{"security_id":"ISIN:A","weight":"0.5","name":"hidden"}]',
  ]) assert.throws(() => parseHoldingsDraft(raw));
});
