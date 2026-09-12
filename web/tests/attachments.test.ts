import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio } from "../src/server/ledger/service";
import { MAX_ATTACHMENT_BYTES, readJsonAttachment, storeJsonAttachment } from "../src/server/ledger/attachments";
import { confirmImport, previewJsonImport } from "../src/server/ledger/imports";

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "etf-attachments-"));
  const filename = path.join(dir, "workbench.db"); migrateWorkbench(filename);
  const db = openWorkbench(filename), actor = { id: "owner" };
  const portfolio = createPortfolio(db, actor, "Synthetic"), account = createAccount(db, actor, portfolio, "Fixture", "Synthetic", "CNY");
  const options = { dataDir: dir };
  const store = (raw: string) => storeJsonAttachment(db, actor, { portfolio_id: portfolio, account_id: account, raw }, options);
  const read = (id: string) => readJsonAttachment(db, actor, portfolio, id, options);
  return { db, actor, portfolio, account, dir, store, read, options, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("original UTF-8 JSON whitespace is retained; permissions and scope-aware dedup are exact", () => {
  const f = fixture();
  try {
    const original = ' [\n { "source": "合成原件", "amount": "100.00" }\n ]\n';
    const first = f.store(original), duplicate = f.store(original);
    assert.equal(first.id, duplicate.id);
    assert.equal(first.byte_size, Buffer.byteLength(original));
    assert.equal(first.storage_key, `attachments/${first.content_hash}.json`);
    assert.deepEqual(f.read(first.id).bytes, Buffer.from(original));
    assert.equal(lstatSync(path.join(f.dir, first.storage_key)).mode & 0o777, 0o600);
    assert.equal(lstatSync(path.join(f.dir, "attachments")).mode & 0o777, 0o700);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n, 1);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='store_attachment'").get() as { n: number }).n, 1);
  } finally { f.close(); }
});

test("attachment IDs cannot cross portfolio or account scope; clients never choose storage paths", () => {
  const f = fixture();
  try {
    const attachment = f.store("{}");
    const other = createPortfolio(f.db, f.actor, "Other"), otherAccount = createAccount(f.db, f.actor, other, "Other", "Synthetic", "CNY");
    assert.throws(() => readJsonAttachment(f.db, f.actor, other, attachment.id, f.options), /OUT_OF_SCOPE/);
    assert.throws(() => storeJsonAttachment(f.db, f.actor, { portfolio_id: f.portfolio, account_id: otherAccount, raw: "{}" }, f.options), /OUT_OF_SCOPE/);
    assert.throws(() => f.read("../../etc/passwd"), /OUT_OF_SCOPE/);
    const same = storeJsonAttachment(f.db, f.actor, { portfolio_id: other, account_id: otherAccount, raw: "{}" }, f.options);
    assert.equal(same.id, attachment.id);
    assert.equal(readJsonAttachment(f.db, f.actor, other, same.id, f.options).bytes.toString(), "{}");
    assert.throws(() => readJsonAttachment(f.db, { id: "" }, f.portfolio, attachment.id, f.options), /UNAUTHENTICATED/);
  } finally { f.close(); }
});

test("duplicate or downloaded content is rehashed, and file/directory symlinks are rejected", () => {
  const f = fixture();
  try {
    const original = '{"amount":"1"}', attachment = f.store(original);
    const filename = path.join(f.dir, attachment.storage_key);
    writeFileSync(filename, '{"amount":"2"}');
    assert.throws(() => f.read(attachment.id), /HASH_MISMATCH/);
    assert.throws(() => f.store(original), /HASH_MISMATCH/);
    unlinkSync(filename);
    const outside = path.join(f.dir, "unrelated.json"); writeFileSync(outside, original);
    symlinkSync(outside, filename);
    assert.throws(() => f.read(attachment.id));
    assert.throws(() => f.store(original));
    unlinkSync(filename); rmSync(path.join(f.dir, "attachments"), { recursive: true });
    symlinkSync(f.dir, path.join(f.dir, "attachments"));
    assert.throws(() => f.read(attachment.id), /UNSAFE_ATTACHMENT_DIRECTORY/);
  } finally { f.close(); }
});

test("import batch references the complete original text rather than reconstructed rows", () => {
  const f = fixture();
  try {
    const raw = ` [\n  ${JSON.stringify({ source_id: "fixture", source_event_id: "1", effective_at: "2026-01-01", time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Synthetic", fact: { type: "deposit", account_id: f.account, currency: "CNY", amount: "100" } })}\n ]\n`;
    const preview = previewJsonImport(f.db, f.actor, f.portfolio, f.account, raw, undefined, f.options);
    assert.equal(preview.status, "preview");
    assert.ok(preview.attachment_id);
    assert.equal(f.read(preview.attachment_id).bytes.toString(), raw);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM ledger_events").get() as { n: number }).n, 0);
    assert.throws(() => previewJsonImport(f.db, f.actor, f.portfolio, f.account, "{bad", undefined, f.options), /INVALID_JSON_IMPORT/);
    const last = f.db.prepare("SELECT storage_key FROM attachments WHERE byte_size=4").get() as { storage_key: string };
    assert.equal(readFileSync(path.join(f.dir, last.storage_key), "utf8"), "{bad");
  } finally { f.close(); }
});

test("attachment bounds and restore read-only gate apply before durable writes", () => {
  const f = fixture();
  try {
    assert.throws(() => f.store("x".repeat(MAX_ATTACHMENT_BYTES + 1)), /TOO_LARGE/);
    assert.throws(() => f.store("\ud800"), /INVALID_ATTACHMENT_UTF8/);
    const existing = f.store("{}");
    writeFileSync(path.join(f.dir, "RESTORE_PENDING_REVIEW"), "pending");
    assert.throws(() => f.store('{"new":1}'), /WORKBENCH_READ_ONLY/);
    const before = lstatSync(path.join(f.dir, "attachments"));
    assert.equal(f.read(existing.id).bytes.toString(), "{}");
    assert.equal(lstatSync(path.join(f.dir, "attachments")).ctimeMs, before.ctimeMs);
    chmodSync(path.join(f.dir, "attachments"), 0o755);
    assert.throws(() => f.read(existing.id), /UNSAFE_ATTACHMENT_DIRECTORY/);
    assert.equal(lstatSync(path.join(f.dir, "attachments")).mode & 0o777, 0o755);
    chmodSync(path.join(f.dir, existing.storage_key), 0o600);
  } finally { f.close(); }
});

test("metadata cannot redirect an authorized attachment, and missing read paths are not created", () => {
  const f = fixture();
  try {
    const attachment = f.store("{}");
    f.db.prepare("UPDATE attachments SET storage_key='../outside.json' WHERE id=?").run(attachment.id);
    assert.throws(() => f.read(attachment.id), /INVALID_ATTACHMENT_METADATA/);
    f.db.prepare("UPDATE attachments SET storage_key=?,content_hash=? WHERE id=?").run(attachment.storage_key, "0".repeat(64), attachment.id);
    assert.throws(() => f.read(attachment.id), /INVALID_ATTACHMENT_METADATA/);
    f.db.prepare("UPDATE attachments SET content_hash=? WHERE id=?").run(attachment.content_hash, attachment.id);
    rmSync(path.join(f.dir, "attachments"), { recursive: true });
    assert.throws(() => f.read(attachment.id));
    assert.equal(existsSync(path.join(f.dir, "attachments")), false);
  } finally { f.close(); }
});

test("tampered original prevents import confirmation without partially posting facts", () => {
  const f = fixture();
  try {
    const raw = JSON.stringify([{ source_id: "fixture", effective_at: "2026-01-01", time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Synthetic", fact: { type: "deposit", account_id: f.account, currency: "CNY", amount: "100" } }]);
    const preview = previewJsonImport(f.db, f.actor, f.portfolio, f.account, raw, undefined, f.options);
    const attachment = f.read(preview.attachment_id).attachment;
    writeFileSync(path.join(f.dir, attachment.storage_key), raw.replace('"100"', '"101"'));
    assert.throws(() => confirmImport(f.db, f.actor, f.portfolio, preview.id, preview.preview_hash, 0, undefined, f.options), /HASH_MISMATCH/);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM ledger_events").get() as { n: number }).n, 0);
  } finally { f.close(); }
});
