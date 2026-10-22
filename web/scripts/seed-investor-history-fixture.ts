import { chmodSync, existsSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkbench } from "../src/server/workbench-db";
import { executeInvestorCommand } from "../src/server/investor/service";
import { investorActor, investorFixture, saveSyntheticProfile, seedSyntheticCandidate } from "../tests/investor-fixture";

async function main() {
  if (process.argv.length !== 3) throw new Error("SYNTHETIC_FIXTURE_PATH_REQUIRED");
  const filename = realpathSync(process.argv[2]), directory = path.dirname(filename);
  if (path.dirname(directory) !== realpathSync(os.tmpdir()) || !/^etf-browser-fixture-[A-Za-z0-9]+$/.test(path.basename(directory))
    || path.basename(filename) !== "workbench.db" || existsSync(path.join(directory, "history-fixture.json")) || existsSync(path.join(directory, "auth")))
    throw new Error("ONLY_NEW_EMPTY_BROWSER_FIXTURE_ALLOWED");
  const empty = openWorkbench(filename);
  try { for (const table of ["portfolios", "ledger_events", "investor_workspaces"])
    if ((empty.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n) throw new Error("EMPTY_SYNTHETIC_DATABASE_REQUIRED"); }
  finally { empty.close(); }
  if (existsSync(filename + "-wal") || existsSync(filename + "-shm")) throw new Error("CLOSED_EMPTY_FIXTURE_REQUIRED");
  // Separate opt-in process, not a production data or strategy producer.
  investorActor.id = "owner";
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); const seeded = seedSyntheticCandidate(f);
    const command = (body: Record<string, unknown>, key: string) => {
      const { revision } = f.db.prepare("SELECT revision FROM investor_workspaces WHERE owner_id='owner'").get() as { revision: number };
      executeInvestorCommand(f.db, investorActor, { ...body, expected_revision: revision, idempotency_key: key }, "2026-01-02T12:00:10.000Z");
    };
    for (let i = 0; i < 55; i++) command({ action: "review", observation_id: seeded.observationId, decision: i % 2 ? "defer" : "reject",
      note: "Fictional historical review " + i + " - NOT A REAL INVESTMENT DECISION" }, "fictional-history-review-" + i);
    for (let i = 0; i < 65; i++) command({ action: "evaluate" }, "fictional-history-evaluate-" + i);
    const staged = path.join(directory, "history-fixture.db"); await f.db.backup(staged); chmodSync(staged, 0o600); renameSync(staged, filename);
    writeFileSync(path.join(directory, "history-fixture.json"), JSON.stringify({ synthetic_fixture_only: true, production_changed: false,
      broker_or_provider_verified: false, observation_id: seeded.observationId, observation_count: 67, decision_count: 55 }) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write("Synthetic archive records seeded; no real broker, market or investment evidence.\n");
  } finally { f.close(); }
}
main().catch(() => { process.stderr.write("SYNTHETIC_HISTORY_FIXTURE_FAILED\n"); process.exitCode = 1; });
