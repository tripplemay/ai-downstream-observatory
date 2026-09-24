import path from "node:path";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../../web/src/server/workbench-db";
import { createPortfolio, createAccount } from "../../web/src/server/ledger/service";
import { requestCsvBackgroundPreview, requestCsvBackgroundConfirmation, cancelCsvBackgroundRequest } from "../../web/src/server/csv-background/service";
import { readCsvBackgroundResult } from "../../web/src/server/csv-background/binding";

const [action, filename, argument, suppliedNow] = process.argv.slice(2);
const dataDir = path.dirname(filename), now = suppliedNow ?? new Date().toISOString();
const who = { actorId: "synthetic-csv-owner", sessionHash: "a".repeat(64) };
if (action === "create" || action === "create-padded") migrateWorkbench(filename);
const db = openWorkbench(filename);
try {
  let result: unknown;
  if (action === "create" || action === "create-padded") {
    const portfolio = createPortfolio(db, { id: who.actorId }, "Synthetic background CSV", now);
    const account = createAccount(db, { id: who.actorId }, portfolio, "Synthetic", "Synthetic", "CNY", now);
    const mapping = {
      schema_version: "csv-import-mapping-v1", mapping_id: "SYNTHETIC", version: 1, title: "Synthetic transport-free fixture",
      dialect: { encoding: "utf-8", delimiter: ",", record_separator: "either" }, expected_headers: ["date", "amount", "id", "note"], ignored_columns: [],
      account: { kind: "constant", value: account }, event_type: { kind: "constant", value: "deposit" }, source_id: "synthetic",
      source_event_id: { kind: "column", column: "id", trim: false, empty: "reject" }, reason: { kind: "column", column: "note", trim: false, empty: "reject" },
      effective_at: { column: "date", format: "YYYY-MM-DD", trim: false, source_timezone: "Asia/Shanghai" },
      rules: [{ event_type: "deposit", fields: { currency: { kind: "constant", value: "CNY" }, amount: { kind: "decimal", column: "amount", empty: "reject", format: { decimal_separator: ".", grouping_separator: "none", negative_style: "minus", allow_leading_plus: false, trim: false } } } }],
    };
    const count = Number(argument || 2);
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error("FIXTURE_ROWS_INVALID");
    const bytes = Buffer.from("\ufeffdate,amount,id,note\r\n" + Array.from({ length: count }, (_, i) => `2026-01-01,1.123456789012345678,s${i},Synthetic ${i}`).join("\r\n") + "\r\n");
    const rawMapping = action === "create-padded" ? JSON.stringify(mapping).padEnd(256 * 1024, "\t") : JSON.stringify(mapping);
    result = { portfolio, account, ...requestCsvBackgroundPreview(db, who, { portfolio_id: portfolio, account_id: account, expected_revision: 0, idempotency_key: "preview", filename: "synthetic.csv", mapping: rawMapping, bytes, acknowledge_background_execution: true }, { dataDir, now }) };
  } else if (action === "confirm" || action === "confirm-unicode-reason") {
    const preview = readCsvBackgroundResult(db, argument, { dataDir });
    if (!preview) throw new Error("FIXTURE_PREVIEW_MISSING");
    const request = db.prepare("SELECT portfolio_id,account_id FROM csv_background_requests WHERE id=?").get(argument) as { portfolio_id: string; account_id: string };
    const manifest = JSON.parse((db.prepare("SELECT manifest_json FROM csv_import_manifests WHERE batch_id=?").get(preview.batch_id) as { manifest_json: string }).manifest_json) as { required_review_rows: number[] };
    const payload = { action: "confirm_import", portfolio_id: request.portfolio_id, batch_id: preview.batch_id, preview_hash: preview.preview_hash, expected_revision: preview.expected_revision,
      csv_review: { acknowledge_unverified_mapping: true, review_hash: preview.review_hash, rows: manifest.required_review_rows.map(row => ({ row, action: "record_distinct", reason: action === "confirm-unicode-reason" ? "\u0085" : "Synthetic rows represent separate deposits" })) } };
    result = requestCsvBackgroundConfirmation(db, who, { ...request, idempotency_key: "confirm", payload_text: "\ufeff" + JSON.stringify(payload, null, 2), acknowledge_background_execution: true }, { dataDir, now });
  } else if (action === "read") result = readCsvBackgroundResult(db, argument, { dataDir });
  else if (action === "cancel") {
    const request = db.prepare("SELECT portfolio_id FROM csv_background_requests WHERE id=?").get(argument) as { portfolio_id: string };
    result = cancelCsvBackgroundRequest(db, { ...who, sessionHash: "b".repeat(64) }, { ...request, request_id: argument, reason: "Synthetic cancellation" }, { dataDir, now });
  } else throw new Error("FIXTURE_ACTION_INVALID");
  process.stdout.write(JSON.stringify(result) + "\n");
} finally { db.close(); }
