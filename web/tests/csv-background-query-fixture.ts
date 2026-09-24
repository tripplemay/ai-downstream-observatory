import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, hash } from "../src/server/ledger/service";
import { getImportPreview } from "../src/server/ledger/imports";
import { requestCsvBackgroundPreview, requestCsvBackgroundConfirmation } from "../src/server/csv-background/service";
import { csvBackgroundCommand, readCsvBackgroundRequest, readCsvBackgroundResult } from "../src/server/csv-background/binding";
import { publishCsvBackground } from "../src/server/csv-background/publisher";
import type { CsvBackgroundPreviewInput } from "../src/server/csv-background/types";

export function csvBackgroundQueryFixture(t: { after(callback: () => void): void }, count = 27) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "csv-background-query-")), filename = path.join(dir, "workbench.db"); migrateWorkbench(filename);
  const db = openWorkbench(filename), actor = { id: "owner" }, principal = { actorId: "owner", sessionHash: "a".repeat(64) };
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const now = "2026-09-12T00:00:00.000000Z", execution = "2026-09-12T00:00:01.000000Z", options = { now, dataDir: dir };
  const portfolio = createPortfolio(db, actor, "Synthetic background query"), account = createAccount(db, actor, portfolio, "A", "Synthetic", "CNY");
  const mapping = JSON.stringify({ schema_version: "csv-import-mapping-v1", mapping_id: "SYNTHETIC-QUERY", version: 1, title: "Synthetic only",
    dialect: { encoding: "utf-8", delimiter: ",", record_separator: "either" }, expected_headers: ["date", "amount", "id", "note"], ignored_columns: [],
    account: { kind: "constant", value: account }, event_type: { kind: "constant", value: "deposit" }, source_id: "synthetic",
    source_event_id: { kind: "column", column: "id", trim: false, empty: "reject" }, reason: { kind: "column", column: "note", trim: false, empty: "reject" },
    effective_at: { column: "date", format: "YYYY-MM-DD", trim: false, source_timezone: "Asia/Shanghai" },
    rules: [{ event_type: "deposit", fields: { currency: { kind: "constant", value: "CNY" }, amount: { kind: "decimal", column: "amount", empty: "reject", format: { decimal_separator: ".", grouping_separator: "none", negative_style: "minus", allow_leading_plus: false, trim: false } } } }] });
  const bytes = Buffer.from(["date,amount,id,note", ...Array.from({ length: count }, (_, index) => `2026-01-01,100,s${index},SYNTHETIC row ${index}`)].join("\n") + "\n");
  const input: CsvBackgroundPreviewInput = { portfolio_id: portfolio, account_id: account, expected_revision: 0, idempotency_key: "preview-1", filename: "synthetic.csv", mapping, bytes, acknowledge_background_execution: true };
  const enqueue = (patch: Partial<CsvBackgroundPreviewInput> = {}) => requestCsvBackgroundPreview(db, principal, { ...input, ...patch }, options);
  const publish = (request: string) => {
    const binding = readCsvBackgroundRequest(db, request), job = randomUUID(), attempt = randomUUID();
    db.prepare("INSERT INTO job_runs(id,command_request_id,job_type,scope,period,input_version,status,max_attempts,not_before,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',3,?,?,?)")
      .run(job, request, `csv_import_${binding.row.operation}_v1`, portfolio, now.slice(0, 10), `${request}:${hash(csvBackgroundCommand(binding.row))}`, execution, execution, execution);
    db.prepare("UPDATE job_runs SET status='running',attempt_count=1,fencing_token=1,lease_owner='synthetic-worker',lease_until='2026-09-12T00:05:00.000000Z',updated_at=? WHERE id=?").run(execution, job);
    db.prepare("INSERT INTO job_attempts(id,job_id,attempt,fencing_token,status,started_at) VALUES(?,?,1,1,'running',?)").run(attempt, job, execution);
    publishCsvBackground(db, { job_id: job, owner: "synthetic-worker", fencing_token: 1, attempt: 1 }, { now: execution, dataDir: dir });
    return readCsvBackgroundResult(db, request, options)!;
  };
  const confirm = (batch: string) => {
    const preview = getImportPreview(db, actor, portfolio, batch);
    const payload = JSON.stringify({ action: "confirm_import", portfolio_id: portfolio, batch_id: batch, preview_hash: preview.preview_hash, expected_revision: preview.expected_revision,
      csv_review: { acknowledge_unverified_mapping: true, review_hash: preview.csv!.review_hash, rows: preview.csv!.required_review_rows.map(row => ({ row, action: "record_distinct", reason: "Explicit synthetic distinct event" })) } });
    return requestCsvBackgroundConfirmation(db, principal, { portfolio_id: portfolio, account_id: account, idempotency_key: "confirm-1", payload_text: payload, acknowledge_background_execution: true }, { ...options, now: execution });
  };
  return { db, dir, actor, principal, portfolio, account, now, execution, options, input, enqueue, publish, confirm };
}
