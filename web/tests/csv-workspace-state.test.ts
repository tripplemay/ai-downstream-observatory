import assert from "node:assert/strict";
import test from "node:test";
import { canClearCsvPreview, canRetryCsvConfirmation, csvContextDisposition, csvScopeKey, isCsvOperationCurrent,
  retainCsvConfirmedRefresh, sameCsvScope, shouldWarnCsvNavigation, type CsvContext, type CsvOperation, type CsvPendingConfirmation } from "../src/components/workbench/csv-workspace-state";

const original: CsvContext = { portfolioId: "portfolio:a", accountId: "account:a", revision: 7 };
const pending: CsvPendingConfirmation = { context: original, batchId: "batch:a", payload: '{ "expected_revision":7,"reason":"original choice" }' };
const preview = { id: "batch:a", account_id: "account:a", expected_revision: 7 };

test("CSV uncertain confirmation survives revision and scope changes without rewriting its frozen request", () => {
  const serialized = JSON.stringify(pending);
  assert.equal(csvContextDisposition(original, { ...original }, pending), "unchanged");
  assert.equal(csvContextDisposition(original, { ...original, revision: 9 }, pending), "retain_pending");
  assert.equal(csvContextDisposition(original, { ...original, accountId: "account:b" }, pending), "retain_pending");
  assert.equal(csvContextDisposition(original, { ...original, portfolioId: "portfolio:b" }, pending), "retain_pending");
  assert.equal(JSON.stringify(pending), serialized);
});

test("CSV ordinary previews invalidate when the ledger or ownership scope changes", () => {
  assert.equal(csvContextDisposition(original, original, null), "unchanged");
  assert.equal(csvContextDisposition(original, { ...original, revision: 8 }, null), "reset");
  assert.equal(csvContextDisposition(original, { ...original, accountId: "account:b" }, null), "reset");
});

test("CSV confirmed status without a receipt revision preserves one same-scope refresh, never another account", () => {
  let marker: { scope: string; revision: number | null } | null = { scope: csvScopeKey(original), revision: null };
  assert.equal(retainCsvConfirmedRefresh(marker, { ...original, revision: 9 }), true);
  assert.equal(retainCsvConfirmedRefresh(marker, { ...original, accountId: "account:b", revision: 9 }), false);
  marker = null;
  assert.equal(retainCsvConfirmedRefresh(marker, { ...original, revision: 10 }), false);
  assert.equal(retainCsvConfirmedRefresh({ scope: csvScopeKey(original), revision: 9 }, { ...original, revision: 9 }), true);
  assert.equal(retainCsvConfirmedRefresh({ scope: csvScopeKey(original), revision: 9 }, { ...original, revision: 10 }), false);
});

test("CSV file/mapping/mode resets cannot silently discard a pending confirmation", () => {
  assert.equal(canClearCsvPreview(pending), false);
  assert.equal(canClearCsvPreview(pending, false), false);
  assert.equal(canClearCsvPreview(pending, true), true);
  assert.equal(canClearCsvPreview(null), true);
});

test("CSV original confirmation retry ignores a newer live revision but never rebinds its account, batch or frozen revision", () => {
  assert.equal(canRetryCsvConfirmation(pending, { ...original, revision: 11 }, preview, false), true);
  assert.equal(canRetryCsvConfirmation(pending, { ...original, accountId: "account:b" }, preview, false), false);
  assert.equal(canRetryCsvConfirmation(pending, { ...original, portfolioId: "portfolio:b" }, preview, false), false);
  assert.equal(canRetryCsvConfirmation(pending, original, { ...preview, account_id: "account:b" }, false), false);
  assert.equal(canRetryCsvConfirmation(pending, original, { ...preview, id: "batch:b" }, false), false);
  assert.equal(canRetryCsvConfirmation(pending, original, { ...preview, expected_revision: 11 }, false), false);
  assert.equal(canRetryCsvConfirmation(pending, original, preview, true), false);
});

test("CSV confirmation/status replies remain current after same-scope revision updates", () => {
  for (const kind of ["confirm", "status"] as const) {
    const operation: CsvOperation = { id: 1, kind, context: original };
    assert.equal(isCsvOperationCurrent(operation, operation, { ...original, revision: 9 }), true);
    assert.equal(isCsvOperationCurrent(operation, operation, { ...original, accountId: "account:b" }), false);
    assert.equal(isCsvOperationCurrent(operation, null, original), false);
    assert.equal(isCsvOperationCurrent(operation, { ...operation, id: 2 }, original), false);
  }
});

test("CSV mapping/preview replies cannot cross revision or replacement operation boundaries", () => {
  for (const kind of ["preview", "mapping"] as const) {
    const operation: CsvOperation = { id: 1, kind, context: original };
    assert.equal(isCsvOperationCurrent(operation, operation, original), true);
    assert.equal(isCsvOperationCurrent(operation, operation, { ...original, revision: 9 }), false);
    assert.equal(isCsvOperationCurrent(operation, { ...operation }, original), false);
  }
});

test("CSV scope identities do not collide when identifiers contain separators", () => {
  const left = { portfolioId: "a:b", accountId: "c" }, right = { portfolioId: "a", accountId: "b:c" };
  assert.equal(sameCsvScope(left, right), false);
  assert.notEqual(csvScopeKey(left), csvScopeKey(right));
});

test("CSV navigation warns on route/query/external links, not harmless fragments or new-tab/download links", () => {
  const here = "https://example.test/workbench?portfolio=a";
  assert.equal(shouldWarnCsvNavigation("/workbench/funding", here), true);
  assert.equal(shouldWarnCsvNavigation("?portfolio=b", here), true);
  assert.equal(shouldWarnCsvNavigation("https://other.test/", here), true);
  assert.equal(shouldWarnCsvNavigation("#csv", here), false);
  assert.equal(shouldWarnCsvNavigation(here, here), false);
  assert.equal(shouldWarnCsvNavigation("/workbench/funding", here, "_blank"), false);
  assert.equal(shouldWarnCsvNavigation("/api/attachment", here, "", true), false);
});
