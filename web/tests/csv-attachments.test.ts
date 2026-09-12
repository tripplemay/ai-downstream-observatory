import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { audit, createAccount, createPortfolio } from "../src/server/ledger/service";
import { MAX_ATTACHMENT_BYTES, readAttachment, readCsvAttachment, readJsonAttachment, storeCsvAttachment, storeJsonAttachment } from "../src/server/ledger/attachments";

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "etf-csv-attachments-"));
  const filename = path.join(dir, "workbench.db"); migrateWorkbench(filename);
  const db = openWorkbench(filename), actor = { id: "synthetic-owner" };
  const portfolio = createPortfolio(db, actor, "Synthetic CSV"), account = createAccount(db, actor, portfolio, "Fixture", "Synthetic", "CNY");
  const options = { dataDir: dir };
  const store = (bytes: Uint8Array) => storeCsvAttachment(db, actor, { portfolio_id: portfolio, account_id: account, bytes }, options);
  const read = (id: string) => readCsvAttachment(db, actor, portfolio, id, options);
  return { db, actor, portfolio, account, dir, filename, options, store, read, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("CSV originals preserve BOM, CRLF, quoted newlines and inert formula text byte for byte", () => {
  const f = fixture();
  try {
    const bytes = Buffer.from('\ufeffcode,note,amount\r\n000001,"line one\r\nline two",100.00\r\n000002,=1+1,20\r\n');
    const envelope = Buffer.concat([Buffer.from("ignored"), bytes, Buffer.from("ignored")]);
    const original = new Uint8Array(envelope.buffer, envelope.byteOffset + 7, bytes.length);
    const attachment = f.store(original);
    original.fill(0);
    assert.equal(attachment.content_hash, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(attachment.media_type, "text/csv");
    assert.equal(attachment.byte_size, bytes.length);
    assert.equal(attachment.storage_key, `attachments/${attachment.content_hash}.csv`);
    assert.deepEqual(f.read(attachment.id).bytes, bytes);
    assert.deepEqual(readAttachment(f.db, f.actor, f.portfolio, attachment.id, f.options).bytes, bytes);
    assert.deepEqual(readFileSync(path.join(f.dir, attachment.storage_key)), bytes);
    assert.equal(lstatSync(path.join(f.dir, attachment.storage_key)).mode & 0o777, 0o600);
    assert.equal(lstatSync(path.join(f.dir, "attachments")).mode & 0o777, 0o700);
    const evidence = f.db.prepare("SELECT payload_json FROM audit_events WHERE action='store_attachment' AND object_id=?").get(attachment.id) as { payload_json: string };
    assert.deepEqual(JSON.parse(evidence.payload_json), { account_id: f.account, content_hash: attachment.content_hash, byte_size: bytes.length, media_type: "text/csv", storage_key: attachment.storage_key });
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM ledger_events").get() as { n: number }).n, 0);
  } finally { f.close(); }
});

test("identical bytes deduplicate within their MIME only; JSON and CSV identities and readers stay separate", () => {
  const f = fixture();
  try {
    const raw = "{}\r\n", csv = f.store(Buffer.from(raw)), duplicate = f.store(Buffer.from(raw));
    const json = storeJsonAttachment(f.db, f.actor, { portfolio_id: f.portfolio, account_id: f.account, raw }, f.options);
    assert.equal(csv.id, duplicate.id); assert.notEqual(csv.id, json.id); assert.equal(csv.content_hash, json.content_hash);
    assert.notEqual(csv.storage_key, json.storage_key);
    assert.equal(readJsonAttachment(f.db, f.actor, f.portfolio, json.id, f.options).bytes.toString(), raw);
    assert.equal(readAttachment(f.db, f.actor, f.portfolio, json.id, f.options).attachment.media_type, "application/json");
    assert.throws(() => readJsonAttachment(f.db, f.actor, f.portfolio, csv.id, f.options), /INVALID_ATTACHMENT_METADATA/);
    assert.throws(() => f.read(json.id), /INVALID_ATTACHMENT_METADATA/);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM attachments").get() as { n: number }).n, 2);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='store_attachment'").get() as { n: number }).n, 2);
  } finally { f.close(); }
});

test("CSV attachment authorization remains portfolio/account scoped including shared content hashes", () => {
  const f = fixture();
  try {
    const bytes = Buffer.from("code\n000001\n"), first = f.store(bytes);
    const other = createPortfolio(f.db, f.actor, "Other synthetic"), otherAccount = createAccount(f.db, f.actor, other, "Other", "Synthetic", "USD");
    const samePortfolioAccount = createAccount(f.db, f.actor, f.portfolio, "Unscoped", "Synthetic", "CNY");
    assert.throws(() => readAttachment(f.db, f.actor, other, first.id, f.options), /ATTACHMENT_OUT_OF_SCOPE/);
    assert.throws(() => readCsvAttachment(f.db, f.actor, f.portfolio, first.id, { ...f.options, accountId: samePortfolioAccount }), /ATTACHMENT_OUT_OF_SCOPE/);
    assert.throws(() => storeCsvAttachment(f.db, f.actor, { portfolio_id: f.portfolio, account_id: otherAccount, bytes }, f.options), /ACCOUNT_OUT_OF_SCOPE/);
    assert.throws(() => readAttachment(f.db, { id: "" }, f.portfolio, first.id, f.options), /UNAUTHENTICATED/);
    assert.throws(() => f.read("../../outside.csv"), /ATTACHMENT_OUT_OF_SCOPE/);
    const shared = storeCsvAttachment(f.db, f.actor, { portfolio_id: other, account_id: otherAccount, bytes }, f.options);
    assert.equal(shared.id, first.id);
    assert.deepEqual(readCsvAttachment(f.db, f.actor, other, shared.id, { ...f.options, accountId: otherAccount }).bytes, bytes);
  } finally { f.close(); }
});

test("CSV byte and UTF-8 limits reject malformed input before any file or attachment metadata exists", () => {
  const f = fixture();
  try {
    for (const bytes of [new Uint8Array(), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)]) assert.throws(() => f.store(bytes), /ATTACHMENT_TOO_LARGE/);
    for (const bytes of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xff, 0xfe, 0x61, 0x00]]) assert.throws(() => f.store(Uint8Array.from(bytes)), /INVALID_ATTACHMENT_UTF8/);
    assert.throws(() => f.store("code\n" as unknown as Uint8Array), /INVALID_ATTACHMENT_BYTES/);
    assert.throws(() => f.store([1, 2] as unknown as Uint8Array), /INVALID_ATTACHMENT_BYTES/);
    assert.equal(existsSync(path.join(f.dir, "attachments")), false);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM attachments").get() as { n: number }).n, 0);
    const limit = f.store(Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x61));
    assert.equal(f.read(limit.id).bytes.length, MAX_ATTACHMENT_BYTES);
  } finally { f.close(); }
});

test("audit-bound MIME, suffix, hash and size prevent metadata redirection on reads and dedup writes", () => {
  const f = fixture();
  try {
    const bytes = Buffer.from("code\n000001\n"), original = f.store(bytes);
    const readBoth = () => { f.read(original.id); readAttachment(f.db, f.actor, f.portfolio, original.id, f.options); };
    for (const patch of [
      { media_type: "application/json", storage_key: `attachments/${original.content_hash}.json`, content_hash: original.content_hash, byte_size: bytes.length },
      { media_type: "text/csv; charset=utf-8", storage_key: original.storage_key, content_hash: original.content_hash, byte_size: bytes.length },
      { media_type: "text/html", storage_key: original.storage_key, content_hash: original.content_hash, byte_size: bytes.length },
      { media_type: "text/csv", storage_key: "../outside.csv", content_hash: original.content_hash, byte_size: bytes.length },
      { media_type: "text/csv", storage_key: original.storage_key, content_hash: "0".repeat(64), byte_size: bytes.length },
      { media_type: "text/csv", storage_key: original.storage_key, content_hash: original.content_hash, byte_size: bytes.length + 1 },
    ]) {
      f.db.prepare("UPDATE attachments SET media_type=@media_type,storage_key=@storage_key,content_hash=@content_hash,byte_size=@byte_size WHERE id=@id").run({ ...patch, id: original.id });
      assert.throws(readBoth, /INVALID_ATTACHMENT_METADATA/);
    }
    f.db.prepare("UPDATE attachments SET media_type='text/csv',storage_key=?,content_hash=?,byte_size=? WHERE id=?").run(original.storage_key, original.content_hash, original.byte_size, original.id);
    readBoth();
    writeFileSync(path.join(f.dir, original.storage_key), "code\n000002\n");
    assert.throws(() => f.read(original.id), /ATTACHMENT_HASH_MISMATCH/);
    assert.throws(() => f.store(bytes), /ATTACHMENT_HASH_MISMATCH/);
  } finally { f.close(); }
});

test("legacy JSON audit scopes remain readable but cannot be reinterpreted as CSV", () => {
  const f = fixture();
  try {
    const bytes = Buffer.from('{"legacy":true}\n'), contentHash = createHash("sha256").update(bytes).digest("hex"), id = randomUUID();
    const key = `attachments/${contentHash}.json`, now = new Date().toISOString();
    mkdirSync(path.join(f.dir, "attachments"), { mode: 0o700 });
    writeFileSync(path.join(f.dir, key), bytes, { mode: 0o600 });
    f.db.prepare("INSERT INTO attachments(id,content_hash,media_type,byte_size,storage_key,created_at) VALUES(?,?,'application/json',?,?,?)").run(id, contentHash, bytes.length, key, now);
    audit(f.db, f.actor, "store_attachment", "attachment", id, f.portfolio, null, { account_id: f.account, content_hash: contentHash, byte_size: bytes.length }, now);
    assert.deepEqual(readJsonAttachment(f.db, f.actor, f.portfolio, id, f.options).bytes, bytes);
    assert.deepEqual(readAttachment(f.db, f.actor, f.portfolio, id, f.options).bytes, bytes);
    assert.equal(storeJsonAttachment(f.db, f.actor, { portfolio_id: f.portfolio, account_id: f.account, raw: bytes.toString() }, f.options).id, id);
    const csvKey = `attachments/${contentHash}.csv`; writeFileSync(path.join(f.dir, csvKey), bytes, { mode: 0o600 });
    f.db.prepare("UPDATE attachments SET media_type='text/csv',storage_key=? WHERE id=?").run(csvKey, id);
    assert.throws(() => f.read(id), /INVALID_ATTACHMENT_METADATA/);
    assert.throws(() => readAttachment(f.db, f.actor, f.portfolio, id, f.options), /INVALID_ATTACHMENT_METADATA/);
    assert.throws(() => f.store(bytes), /INVALID_ATTACHMENT_METADATA/);
  } finally { f.close(); }
});

test("CSV reads and duplicate writes reject file/directory symlinks and unsafe file permissions", () => {
  const f = fixture();
  try {
    const bytes = Buffer.from("code\n000001\n"), original = f.store(bytes), filename = path.join(f.dir, original.storage_key);
    chmodSync(filename, 0o644); assert.throws(() => f.read(original.id), /UNSAFE_ATTACHMENT_PERMISSIONS/);
    chmodSync(filename, 0o600); unlinkSync(filename);
    const outside = path.join(f.dir, "outside.csv"); writeFileSync(outside, bytes, { mode: 0o600 }); symlinkSync(outside, filename);
    assert.throws(() => f.read(original.id)); assert.throws(() => f.store(bytes));
    unlinkSync(filename); rmSync(path.join(f.dir, "attachments"), { recursive: true }); symlinkSync(f.dir, path.join(f.dir, "attachments"));
    assert.throws(() => f.read(original.id), /UNSAFE_ATTACHMENT_DIRECTORY/);
    assert.throws(() => f.store(bytes), /UNSAFE_ATTACHMENT_DIRECTORY/);
  } finally { f.close(); }
});

test("restore-guarded CSV downloads have no mkdir/chmod side effects and all attachment stores remain blocked", () => {
  const f = fixture();
  try {
    const bytes = Buffer.from("code\r\n000001\r\n"), original = f.store(bytes);
    writeFileSync(path.join(f.dir, "RESTORE_PENDING_REVIEW"), "synthetic pending review");
    const directory = path.join(f.dir, "attachments"), before = lstatSync(directory), fileBefore = lstatSync(path.join(f.dir, original.storage_key));
    assert.deepEqual(readAttachment(f.db, f.actor, f.portfolio, original.id, f.options).bytes, bytes);
    assert.equal(lstatSync(directory).ctimeMs, before.ctimeMs);
    assert.equal(lstatSync(path.join(f.dir, original.storage_key)).ctimeMs, fileBefore.ctimeMs);
    assert.throws(() => f.store(bytes), /WORKBENCH_READ_ONLY/);
    assert.throws(() => f.store(Buffer.from("new\n")), /WORKBENCH_READ_ONLY/);
    assert.throws(() => storeJsonAttachment(f.db, f.actor, { portfolio_id: f.portfolio, account_id: f.account, raw: "{}" }, f.options), /WORKBENCH_READ_ONLY/);
    chmodSync(directory, 0o755); assert.throws(() => f.read(original.id), /UNSAFE_ATTACHMENT_DIRECTORY/);
    assert.equal(lstatSync(directory).mode & 0o777, 0o755);
    rmSync(directory, { recursive: true }); assert.throws(() => f.read(original.id)); assert.equal(existsSync(directory), false);
  } finally { f.close(); }
});
