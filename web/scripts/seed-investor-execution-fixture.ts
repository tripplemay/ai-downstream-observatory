import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkbench } from "../src/server/workbench-db";
import { recordFact, revision } from "../src/server/ledger/service";
import { executeInvestorCommand } from "../src/server/investor/service";
import { storeCsvAttachment } from "../src/server/ledger/attachments";
import { governanceFixture, human, now } from "../tests/governance-fixture";
import { syntheticProfile } from "../tests/investor-fixture";

async function main() {
  if (process.argv.length !== 3) throw new Error("SYNTHETIC_FIXTURE_PATH_REQUIRED");
  const filename = realpathSync(process.argv[2]), directory = path.dirname(filename);
  if (path.dirname(directory) !== realpathSync(os.tmpdir()) || !/^etf-browser-fixture-[A-Za-z0-9]+$/.test(path.basename(directory))
    || path.basename(filename) !== "workbench.db" || existsSync(path.join(directory, "execution-fixture.json")) || existsSync(path.join(directory, "auth")))
    throw new Error("ONLY_NEW_EMPTY_BROWSER_FIXTURE_ALLOWED");
  const empty = openWorkbench(filename);
  try { for (const table of ["portfolios", "ledger_events", "investor_workspaces"])
    if ((empty.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n) throw new Error("EMPTY_SYNTHETIC_DATABASE_REQUIRED"); }
  finally { empty.close(); }
  // This separate opt-in process seeds only fictional records for the fixed login principal.
  human.id = "owner";
  const f = governanceFixture();
  try {
    executeInvestorCommand(f.db, human, { action: "save_profile", expected_revision: 0, idempotency_key: "synthetic-browser-profile", profile: syntheticProfile }, now);
    executeInvestorCommand(f.db, human, { action: "link_portfolio", expected_revision: 1, idempotency_key: "synthetic-browser-link",
      portfolio_id: f.portfolio, expected_ledger_revision: revision(f.db, f.portfolio) }, now);
    const proposal = f.proposal(); f.approve(proposal);
    const fact = recordFact(f.db, human, f.command({ type: "buy", account_id: f.account, listing_id: "l", currency: "CNY", quantity: "200", price: "100" }, "2026-01-05"), now);
    const csv = storeCsvAttachment(f.db, human, { portfolio_id: f.portfolio, account_id: f.account,
      bytes: Buffer.from("synthetic,not_real_broker_data\r\n1,fictional_only\r\n") }, f.options);
    const auth = path.join(directory, "auth"); mkdirSync(path.join(auth, "attachments"), { recursive: true, mode: 0o700 });
    for (const name of readdirSync(path.join(f.dataDir, "attachments"))) {
      const source = path.join(f.dataDir, "attachments", name);
      if (!/^[a-f0-9]{64}\.(json|csv)$/.test(name) || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error("INVALID_SYNTHETIC_ATTACHMENT");
      const target = path.join(auth, "attachments", name); copyFileSync(source, target); chmodSync(target, 0o600);
    }
    const staged = path.join(directory, "execution-fixture.db"); await f.db.backup(staged); chmodSync(staged, 0o600); renameSync(staged, filename);
    const result = { synthetic_fixture_only: true, broker_or_provider_verified: false, production_changed: false,
      portfolio_id: f.portfolio, account_id: f.account, proposal_id: proposal.id, proposal_item_id: proposal.item_ids[0], event_id: fact.event_id, attachment_id: csv.id };
    writeFileSync(path.join(directory, "execution-fixture.json"), JSON.stringify(result) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write("Synthetic execution records seeded; not real G/S evidence or investment permission.\n");
  } finally { f.close(); }
}
main().catch(() => { process.stderr.write("SYNTHETIC_EXECUTION_FIXTURE_FAILED\n"); process.exitCode = 1; });
