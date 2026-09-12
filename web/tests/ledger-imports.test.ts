import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, revision, recordFact } from "../src/server/ledger/service";
import { previewJsonImport, confirmImport } from "../src/server/ledger/imports";

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "etf-import-")), filename = path.join(dir, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), actor = { id: "owner" };
  const portfolio = createPortfolio(db, actor, "Synthetic"), account = createAccount(db, actor, portfolio, "A", "Test", "CNY");
  const row = (amount: string, id: string) => ({ source_id: "test", source_event_id: id, effective_at: "2026-01-01", time_precision: "date" as const, source_timezone: "Asia/Shanghai", reason: "Synthetic", fact: { type: "deposit" as const, account_id: account, currency: "CNY", amount } });
  const preview = (raw: string) => previewJsonImport(db, actor, portfolio, account, raw, undefined, { dataDir: dir });
  const confirm = (id: string, hash: string, rev: number) => confirmImport(db, actor, portfolio, id, hash, rev, undefined, { dataDir: dir });
  return { db, actor, portfolio, account, row, preview, confirm, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("preview exercises full validation but never books cash; confirm batch is atomic/idempotent", () => {
  const f = fixture();
  try {
    const raw = JSON.stringify([f.row("100", "1"), f.row("50", "2")]);
    const preview = f.preview(raw);
    assert.equal(preview.status, "preview");
    assert.equal(revision(f.db, f.portfolio), 0);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM ledger_events").get() as { n: number }).n, 0);
    const result = f.confirm(preview.id, preview.preview_hash, 0);
    assert.equal(result.revision, 2);
    assert.equal((f.db.prepare("SELECT balance FROM account_projections WHERE ledger_account='cash_settled'").get() as { balance: string }).balance, "150");
    assert.equal(f.confirm(preview.id, preview.preview_hash, 0).duplicate, true);
    assert.equal(f.preview(raw).id, preview.id);
    assert.equal(revision(f.db, f.portfolio), 2);
  } finally { f.close(); }
});

test("invalid row quarantines full batch; no silently accepted subset", () => {
  const f = fixture();
  try {
    const p = f.preview(JSON.stringify([f.row("100", "1"), f.row("-50", "2")]));
    assert.equal(p.status, "invalid");
    assert.equal(p.rows[0].errors.length, 0);
    assert.ok(p.rows[1].errors.length);
    assert.throws(() => f.confirm(p.id, p.preview_hash, 0), /IMPORT_HAS_ERRORS/);
    assert.equal(revision(f.db, f.portfolio), 0);
  } finally { f.close(); }
});

test("changed ledger prevents confirming stale preview; file cannot route another account", () => {
  const f = fixture();
  try {
    const p = f.preview(JSON.stringify([f.row("100", "1")]));
    recordFact(f.db, f.actor, { ...f.row("5", "other"), portfolio_id: f.portfolio, expected_revision: 0, idempotency_key: "outside" });
    assert.throws(() => f.confirm(p.id, p.preview_hash, 0), /VERSION_CONFLICT/);
    const refreshed = f.preview(JSON.stringify([f.row("100", "1")]));
    assert.notEqual(refreshed.id, p.id);
    assert.equal(refreshed.expected_revision, 1);
    assert.equal(f.confirm(refreshed.id, refreshed.preview_hash, 1).revision, 2);
    const wrong = f.row("100", "bad"); wrong.fact.account_id = "other-account";
    assert.equal(f.preview(JSON.stringify([wrong])).status, "invalid");
  } finally { f.close(); }
});

test("source cross-file duplicates do not book twice, equal real amounts remain separate", () => {
  const f = fixture();
  try {
    for (const values of [[f.row("100", "1")], [f.row("100", "1"), f.row("100", "2")]]) {
      const p = f.preview(JSON.stringify(values));
      assert.equal(p.status, "preview");
      f.confirm(p.id, p.preview_hash, p.expected_revision);
    }
    assert.equal(revision(f.db, f.portfolio), 2);
    assert.equal((f.db.prepare("SELECT balance FROM account_projections WHERE ledger_account='cash_settled'").get() as { balance: string }).balance, "200");
  } finally { f.close(); }
});
