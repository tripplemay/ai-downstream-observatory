import { openWorkbench } from "../src/server/workbench-db";
import { approveProposal, type GovernanceActor } from "../src/server/governance/service";

const [filename, command, dataDir, now, releaseHash] = process.argv.slice(2);
const db = openWorkbench(filename);
try {
  const actor: GovernanceActor = { id: "SYNTHETIC-CONCURRENT-HUMAN", kind: "human" };
  process.stdout.write(JSON.stringify({ ok: true, result: approveProposal(db, actor, JSON.parse(command), { dataDir, now, releaseHash }) }));
} catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "UNKNOWN" })); }
finally { db.close(); }
