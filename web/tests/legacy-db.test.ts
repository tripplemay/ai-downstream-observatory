import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { getDb } from "../src/lib/db";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";

test("legacy archive cannot initialize missing files or mutate an existing database", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "etf-legacy-readonly-")), filename = path.join(dir, "legacy.db");
  const previousPath = process.env.DB_PATH;
  process.env.DB_PATH = filename;
  try {
    assert.throws(() => getDb());
    assert.equal(existsSync(filename), false);
    const seed = new Database(filename);
    seed.exec("CREATE TABLE legacy_fixture (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO legacy_fixture VALUES(1,'historical')");
    seed.close();
    const archive = getDb();
    assert.equal(archive.readonly, true);
    assert.equal((archive.prepare("SELECT label FROM legacy_fixture").get() as { label: string }).label, "historical");
    assert.throws(() => archive.prepare("UPDATE legacy_fixture SET label='changed'").run(), /readonly/);
    assert.deepEqual(archive.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), [{ name: "legacy_fixture" }]);
  } finally {
    globalThis.__obsDb?.close(); globalThis.__obsDb = undefined;
    if (previousPath === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workbench reads only its hashed legacy attachment and survives archive-directory removal", async () => {
  const { archiveLegacy } = await import("../../scripts/archive-legacy.mjs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "etf-legacy-hash-"));
  const source = path.join(dir, "observatory.db"), workbench = path.join(dir, "workbench.db");
  const previous = { DB_PATH: process.env.DB_PATH, WORKBENCH_DB_PATH: process.env.WORKBENCH_DB_PATH, WORKBENCH_DATA_DIR: process.env.WORKBENCH_DATA_DIR };
  Object.assign(process.env, { DB_PATH: source, WORKBENCH_DB_PATH: workbench, WORKBENCH_DATA_DIR: dir });
  try {
    const old = new Database(source);
    old.exec("CREATE TABLE metrics (label TEXT); INSERT INTO metrics VALUES('historical source')"); old.close();
    migrateWorkbench(workbench);
    assert.throws(() => getDb(), /LEGACY_ARCHIVE_NOT_AVAILABLE/);
    const archiveDir = path.join(dir, "legacy-archives");
    const result = await archiveLegacy({ sourcePath: source, archiveDir, dbPath: workbench, dataDir: dir, appRef: "synthetic" });
    rmSync(archiveDir, { recursive: true });
    const archive = getDb();
    assert.equal(archive.readonly, true);
    assert.equal((archive.prepare("SELECT label FROM metrics").get() as { label: string }).label, "historical source");
    assert.equal(getDb(), archive);
    globalThis.__obsDb?.close(); globalThis.__obsDb = undefined;
    writeFileSync(path.join(dir, "attachments", `legacy-${result.source_sha256}.sqlite`), "tampered");
    assert.throws(() => getDb(), /UNSAFE_LEGACY_ARCHIVE_PATH|LEGACY_ARCHIVE_HASH_MISMATCH/);
  } finally {
    globalThis.__obsDb?.close(); globalThis.__obsDb = undefined; globalThis.__obsArchiveIdentity = undefined;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
});
