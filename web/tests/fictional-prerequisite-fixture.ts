import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openWorkbench } from "../src/server/workbench-db";
import type { investorFixture } from "./investor-fixture";

type Fixture = ReturnType<typeof investorFixture>;
const maximumBytes = 8 * 1024 * 1024;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const financialTables = ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"];
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';

function scope(f: Fixture) {
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(path.basename(f.filename), "workbench.db");
  assert.equal(path.dirname(f.filename), f.directory);
  assert.equal(path.dirname(realpathSync(f.directory)), realpathSync(tmpdir()));
  assert.ok(path.basename(f.directory).startsWith("etf-investor-synthetic-"));
  const stat = lstatSync(f.filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid!());
  assert.equal(realpathSync(f.filename), path.join(realpathSync(f.directory), "workbench.db"));
  assert.equal(f.db.name, realpathSync(f.filename));
  assert.ok(f.db.open && !f.db.readonly && !f.db.inTransaction);
  assert.equal((f.db.pragma("database_list") as unknown[]).length, 1);
  assert.equal(f.db.pragma("query_only", { simple: true }), 0);
  assert.equal(f.db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(f.db.pragma("foreign_keys", { simple: true }), 1);
  assert.ok(!existsSync(path.join(f.directory, "RESTORE_PENDING_REVIEW")));
  for (const table of financialTables) assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
}

function fingerprint(db: Database.Database, forbidden: string[] = []) {
  const hash = createHash("sha256");
  const rows = (sql: string) => db.prepare(sql).raw(true).safeIntegers(true).all() as (string | number | bigint | Buffer | null)[][];
  const append = (values: (string | number | bigint | Buffer | null)[]) => {
    if (forbidden.some(root => values.some(value => typeof value === "string" ? value.includes(root) : Buffer.isBuffer(value) && value.includes(root)))) return false;
    hash.update(JSON.stringify(values.map(value => Buffer.isBuffer(value) ? ["blob", value.length, digest(value)] : [typeof value, String(value)])) + "\n");
    return true;
  };
  for (const value of rows("SELECT rowid,type,name,tbl_name,sql FROM sqlite_master ORDER BY rowid")) if (!append(value)) return null;
  for (const pragma of ["user_version", "application_id"]) append([pragma, db.pragma(pragma, { simple: true }) as number]);
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]) {
    append([name]);
    for (const value of rows(`SELECT rowid,* FROM ${quote(name)} ORDER BY rowid`)) if (!append(value)) return null;
  }
  return hash.digest("hex");
}

/** File-owned prerequisites only. Each actual test still replays its own bytes. */
export class FictionalPrerequisite {
  #image: Buffer;
  #value: string;
  #imageHash: string;
  #valueHash: string;
  #fingerprint: string;
  #closed = false;
  private constructor(image: Buffer, value: string, fullFingerprint: string) {
    this.#image = image; this.#value = value;
    this.#imageHash = digest(image); this.#valueHash = digest(value); this.#fingerprint = fullFingerprint;
  }
  static capture(f: Fixture, value: Record<string, unknown>): FictionalPrerequisite | null {
    scope(f);
    let encoded: string;
    try { encoded = JSON.stringify(value); assert.deepEqual(JSON.parse(encoded), value); }
    catch { return null; }
    const roots = [f.directory, realpathSync(f.directory)];
    if (roots.some(root => encoded.includes(root))) return null;
    const allocated = Number(f.db.pragma("page_count", { simple: true })) * Number(f.db.pragma("page_size", { simple: true }));
    if (allocated + Buffer.byteLength(encoded) > maximumBytes) return null;
    const fullFingerprint = fingerprint(f.db, roots);
    if (fullFingerprint === null) return null;
    const image = f.db.serialize();
    if (image.length + Buffer.byteLength(encoded) > maximumBytes) return null;
    return new FictionalPrerequisite(image, encoded, fullFingerprint);
  }
  instantiate(): Fixture & { value: Record<string, unknown> } {
    assert.equal(process.env.NODE_ENV, "test");
    assert.ok(!this.#closed, "FICTIONAL_PREREQUISITE_CLOSED");
    assert.equal(digest(this.#image), this.#imageHash); assert.equal(digest(this.#value), this.#valueHash);
    // Never overwrite a target: every copy owns an exclusive new temporary file.
    const directory = mkdtempSync(path.join(tmpdir(), "etf-investor-synthetic-")), filename = path.join(directory, "workbench.db");
    let db: Database.Database | undefined;
    try {
      writeFileSync(filename, this.#image, { flag: "wx", mode: 0o600 });
      db = openWorkbench(filename);
      const connection = db;
      const fixture = { db: connection, directory, filename, close() { connection.close(); rmSync(directory, { recursive: true, force: true }); } };
      scope(fixture);
      assert.equal(fingerprint(connection), this.#fingerprint);
      assert.deepEqual(connection.pragma("foreign_key_check"), []);
      return { ...fixture, value: JSON.parse(this.#value) as Record<string, unknown> };
    } catch (error) { db?.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
  }
  close() { this.#closed = true; this.#image.fill(0); this.#value = ""; }
}
