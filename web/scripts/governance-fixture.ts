import { parseArgs } from "node:util";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, recordFact, revision } from "../src/server/ledger/service";

const { values } = parseArgs({ options: { db: { type: "string" } }, strict: true, allowPositionals: false });
if (!values.db) throw new Error("SYNTHETIC_DATABASE_REQUIRED");
const db = openWorkbench(values.db);
try {
  if ((db.prepare("SELECT COUNT(*) count FROM portfolios").get() as { count: number }).count !== 0) throw new Error("EMPTY_SYNTHETIC_DATABASE_REQUIRED");
  const actor = { id: "SYNTHETIC-VERIFICATION-FIXTURE", kind: "human" as const };
  const opening = "2026-01-01T00:00:00.000Z", deposit = "2026-01-02T12:00:00.000Z";
  const portfolio = createPortfolio(db, actor, "SYNTHETIC cash neutrality; not investment authorization", opening);
  const account = createAccount(db, actor, portfolio, "SYNTHETIC cash", "No broker or credentials", "CNY", opening);
  for (const [type, amount, at] of [["opening_cash", "100.25", opening], ["deposit", "50.125", deposit]] as const) {
    recordFact(db, actor, { portfolio_id: portfolio, expected_revision: revision(db, portfolio),
      idempotency_key: `synthetic-cash-neutrality:${type}`, reason: "SYNTHETIC fixed engineering check; not investment approval",
      source_id: "synthetic-cash-neutrality-v1", source_event_id: type, effective_at: at,
      time_precision: "second", source_timezone: "UTC", fact: { type, account_id: account, currency: "CNY", amount } }, at);
  }
  process.stdout.write(JSON.stringify({ portfolio_id: portfolio, account_id: account, node_version: process.version }) + "\n");
} finally { db.close(); }
