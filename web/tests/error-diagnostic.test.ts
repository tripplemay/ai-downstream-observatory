import assert from "node:assert/strict";
import { test } from "node:test";
import { safeStorageErrorDiagnostic } from "../src/server/error-diagnostic";

test("storage diagnostics include only bounded SQLite codes", () => {
  const sqlite = new Error("/private/workbench.db: SELECT secret FROM facts");
  sqlite.name = "SqliteError";
  Object.assign(sqlite, { code: "SQLITE_BUSY" });
  assert.equal(safeStorageErrorDiagnostic(sqlite), "SqliteError:SQLITE_BUSY");
  Object.assign(sqlite, { code: "SQLITE_BUSY_SNAPSHOT" });
  assert.equal(safeStorageErrorDiagnostic(sqlite), "SqliteError:SQLITE_BUSY_SNAPSHOT");
  Object.assign(sqlite, { code: "SQLITE_BUSY /private/workbench.db" });
  assert.equal(safeStorageErrorDiagnostic(sqlite), "SqliteError");
  Object.assign(sqlite, { code: 5 });
  assert.equal(safeStorageErrorDiagnostic(sqlite), "SqliteError");
  assert.equal(safeStorageErrorDiagnostic(new Error("/private/workbench.db")), "Error");
  const unsafe = new Error("message");
  unsafe.name = "/private/workbench.db";
  assert.equal(safeStorageErrorDiagnostic(unsafe), "UnknownError");
  const getter = new Error("message");
  getter.name = "SqliteError";
  Object.defineProperty(getter, "code", { get() { throw new Error("unexpected getter"); } });
  assert.equal(safeStorageErrorDiagnostic(getter), "SqliteError");
  assert.equal(safeStorageErrorDiagnostic("/private/workbench.db"), "UnknownError");
});
