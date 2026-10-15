import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkbench } from "../src/server/workbench-db";
import { getInvestorState } from "../src/server/investor/service";

const [filename, mode] = process.argv.slice(2);
if (!filename || !["register", "compute", "core", "evidence", "fixed-policy-evidence", "bounded-policy-evidence", "bounded-zero-tolerance-evidence", "monitor", "funding", "funded-evidence", "bounded-funded-evidence", "funded-worker", "funded-withdraw", "summary"].includes(mode)) throw new Error("SYNTHETIC_BROWSER_RESEARCH_MODE_REQUIRED");
const target = realpathSync(filename), temporary = realpathSync(os.tmpdir());
if (path.dirname(path.dirname(target)) !== temporary || !/^etf-browser-fixture-[A-Za-z0-9]+$/.test(path.basename(path.dirname(target)))
    || path.basename(target) !== "workbench.db") throw new Error("ONLY_TEMPORARY_BROWSER_FIXTURE_ALLOWED");
const financialTables = ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"];
const before = openWorkbench(target);
try { for (const table of financialTables) if ((before.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n !== 0) throw new Error("EMPTY_FINANCIAL_FIXTURE_REQUIRED"); }
finally { before.close(); }
if (["funded-evidence", "bounded-funded-evidence", "funded-withdraw"].includes(mode)) {
  execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", `
from datetime import timedelta
import sys
from worker.orchestration.db import open_database,instant
from tests.investor import evidence_fixture as f
from worker.investor.data_evidence import review_source
db=open_database(sys.argv[1])
try:
    now=instant().isoformat(timespec='milliseconds').replace('+00:00','Z')
    expiry=(instant(now)+timedelta(days=30)).isoformat(timespec='milliseconds').replace('+00:00','Z')
    rows=db.execute('SELECT id,owner_id FROM investor_workspaces').fetchall()
    assert len(rows)==1
    workspace,actor=rows[0]['id'],rows[0]['owner_id']
    if sys.argv[2] in ('funded-evidence','bounded-funded-evidence'):
        f.EXPIRY=expiry
        f.create(db,workspace,actor,now=now,fixed_policy_v2=True,funded_year=True,bounded_execution_v3=sys.argv[2]=='bounded-funded-evidence')
    else:
        row=db.execute("SELECT id FROM investor_data_sources WHERE workspace_id=? AND kind='rights' ORDER BY rowid DESC LIMIT 1",(workspace,)).fetchone()
        assert row is not None
        review_source(db,workspace,actor,row['id'],'withdrawn',None,'Fictional browser withdrawal only',expiry,now=now)
finally:
    db.close()
`, target, mode], { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 90000, maxBuffer: 65536 });
} else if (mode === "funded-worker") {
  execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", "tests.investor.funded_study_fixture", "--db", target, "--now", new Date().toISOString()],
    { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 90000, maxBuffer: 65536 });
} else if (mode !== "summary") {
  const monitor = ["monitor", "funding"].includes(mode);
  const evidence = ["evidence", "fixed-policy-evidence", "bounded-policy-evidence", "bounded-zero-tolerance-evidence"].includes(mode);
  const evidenceFlags = mode === "bounded-policy-evidence" ? ["--fixed-policy-v2", "--bounded-execution-v3", "--browser-cent-tolerance"]
    : mode === "bounded-zero-tolerance-evidence" ? ["--fixed-policy-v2", "--bounded-execution-v3"] : mode === "fixed-policy-evidence" ? ["--fixed-policy-v2"] : [];
  const module = monitor ? "tests.investor.live_monitor_fixture" : evidence ? "tests.investor.evidence_fixture" : "tests.investor.queue_fixture";
  execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", target,
    ...(monitor ? mode === "funding" ? ["--funding"] : [] : evidence ? evidenceFlags : ["--mode", mode]), "--now", new Date().toISOString()],
    { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 65536 });
}
const db = openWorkbench(target);
try {
  const state = getInvestorState(db, { id: "owner" });
  const counts = Object.fromEntries(["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports", "investor_research_requests", "investor_research_runs"]
    .map(table => [table, (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n]));
  if (Object.entries(counts).some(([table, count]) => !table.startsWith("investor_") && count !== 0)) throw new Error("EMPTY_FINANCIAL_FIXTURE_REQUIRED");
  console.log(JSON.stringify({ synthetic_fixture_only: true, real_provider_called: false, mode, task_status: state.research_task?.status ?? null,
    study_status: state.research_task?.study?.status ?? null, risk_unconfirmed: state.profile?.document.loss_tolerance === null,
    monitoring_status: state.model_watch?.status ?? null, outcome: state.effective_outcome, counts }));
} finally { db.close(); }
