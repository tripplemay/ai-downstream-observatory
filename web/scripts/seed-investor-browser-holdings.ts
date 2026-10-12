import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkbench } from "../src/server/workbench-db";
import { getInvestorHoldings } from "../src/server/investor/holdings";
import { recordFact, revision } from "../src/server/ledger/service";
import { investorHoldingsFixture } from "../tests/investor-holdings-fixture";

const [filename, mode = "reference"] = process.argv.slice(2);
if (!filename || !["reference", "reconciliation", "new-fact"].includes(mode)) throw new Error("SYNTHETIC_BROWSER_MODE_REQUIRED");
const target = realpathSync(filename), temporary = realpathSync(os.tmpdir());
if (path.dirname(path.dirname(target)) !== temporary || !/^etf-browser-fixture-[A-Za-z0-9]+$/.test(path.basename(path.dirname(target)))
  || path.basename(target) !== "workbench.db") throw new Error("ONLY_TEMPORARY_BROWSER_FIXTURE_ALLOWED");
const db = openWorkbench(target), directory = path.join(path.dirname(target), "auth"), actor = { id: "owner" };
try {
  if (mode === "reference" || mode === "reconciliation") {
    if ((db.prepare("SELECT count(*) n FROM portfolios").get() as { n: number }).n !== 0
      || (db.prepare("SELECT count(*) n FROM investor_workspaces").get() as { n: number }).n !== 0) throw new Error("EMPTY_SYNTHETIC_FIXTURE_REQUIRED");
    const f = investorHoldingsFixture({ fixture: { db, filename: target, directory, close() {} }, actor, now: new Date().toISOString(),
      securities: mode === "reference", reference: mode === "reference", twoAccounts: mode === "reference", transit: mode === "reference" });
    if (mode === "reference") { f.reconcile(); f.reconcile(f.second!); f.publish(); }
  } else {
    const portfolio = (db.prepare("SELECT id FROM portfolios").get() as { id: string }).id;
    const account = (db.prepare("SELECT id FROM accounts ORDER BY rowid LIMIT 1").get() as { id: string }).id;
    recordFact(db, actor, { portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: "native-fictional-new-fact",
      source_id: "FICTIONAL-NATIVE-TEST", source_event_id: "new-fact", effective_at: new Date().toISOString().slice(0, 10), time_precision: "date", source_timezone: "Asia/Shanghai",
      reason: "Fictional native browser regression only", fact: { type: "deposit", account_id: account, currency: "CNY", amount: "1" } });
  }
  const value = getInvestorHoldings(db, actor, new Date().toISOString(), { dataDir: directory });
  console.log(JSON.stringify({ fictional_only: true, real_provider_called: false, status: value.status, gaps: value.gaps,
    nav_cny: value.snapshot?.nav_cny ?? null, comparison_rows: value.comparison?.rows.length ?? 0 }));
} finally { db.close(); }
