import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkbench } from "../src/server/workbench-db";
import { revision } from "../src/server/ledger/service";
import { executeInvestorCommand } from "../src/server/investor/service";
import { getInvestorProposalReviewContext } from "../src/server/investor/proposal-review";
import { governanceFixture, human } from "../tests/governance-fixture";
import { syntheticProfile } from "../tests/investor-fixture";

async function main() {
  if (process.argv.length !== 3) throw new Error("SYNTHETIC_FIXTURE_PATH_REQUIRED");
  const filename = realpathSync(process.argv[2]), directory = path.dirname(filename);
  if (path.dirname(directory) !== realpathSync(os.tmpdir()) || !/^etf-browser-fixture-[A-Za-z0-9]+$/.test(path.basename(directory))
    || path.basename(filename) !== "workbench.db" || existsSync(path.join(directory, "proposal-fixture.json")) || existsSync(path.join(directory, "auth")))
    throw new Error("ONLY_NEW_EMPTY_BROWSER_FIXTURE_ALLOWED");
  const empty = openWorkbench(filename);
  try { for (const table of ["portfolios", "ledger_events", "investor_workspaces"])
    if ((empty.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n) throw new Error("EMPTY_SYNTHETIC_DATABASE_REQUIRED"); }
  finally { empty.close(); }
  const at = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  human.id = "owner";
  const f = governanceFixture(undefined, "0", "100000", true, "CNY", undefined, [], at);
  try {
    executeInvestorCommand(f.db, human, { action: "save_profile", expected_revision: 0, idempotency_key: "synthetic-proposal-profile", profile: syntheticProfile }, at);
    executeInvestorCommand(f.db, human, { action: "link_portfolio", expected_revision: 1, idempotency_key: "synthetic-proposal-link",
      portfolio_id: f.portfolio, expected_ledger_revision: revision(f.db, f.portfolio) }, at);
    const proposal = f.proposal(), mobile = f.proposal("200"), context = getInvestorProposalReviewContext(f.db, human, proposal.id, at, f.options);
    if (context.selected?.current_risk.status !== "pass" || !context.selected.allowed_operations.includes("approve")) throw new Error("SYNTHETIC_PROPOSAL_NOT_REVIEWABLE");
    const auth = path.join(directory, "auth"); mkdirSync(path.join(auth, "attachments"), { recursive: true, mode: 0o700 });
    for (const name of readdirSync(path.join(f.dataDir, "attachments"))) {
      const source = path.join(f.dataDir, "attachments", name);
      if (!/^[a-f0-9]{64}\.(json|csv)$/.test(name) || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error("INVALID_SYNTHETIC_ATTACHMENT");
      const target = path.join(auth, "attachments", name); copyFileSync(source, target); chmodSync(target, 0o600);
    }
    const staged = path.join(directory, "proposal-fixture.db"); await f.db.backup(staged); chmodSync(staged, 0o600); renameSync(staged, filename);
    writeFileSync(path.join(directory, "proposal-fixture.json"), JSON.stringify({ synthetic_fixture_only: true, formal_gates_are_synthetic: true,
      broker_or_provider_verified: false, production_changed: false, clock_modified: false, seeded_at: at, release_hash: f.options.releaseHash,
      portfolio_id: f.portfolio, account_id: f.account, proposal_id: proposal.id, proposal_item_id: proposal.item_ids[0],
      mobile_proposal_id: mobile.id, mobile_proposal_item_id: mobile.item_ids[0] }) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write("Fictional proposal seeded at current time; seeded gates are NOT real G/S verification. No process clock changed.\n");
  } finally { f.close(); }
}
main().catch(() => { process.stderr.write("SYNTHETIC_PROPOSAL_FIXTURE_FAILED\n"); process.exitCode = 1; });
