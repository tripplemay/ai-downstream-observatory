import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { getInvestorProposalReviewContext } from "../src/server/investor/proposal-review";

const web = path.resolve("."), root = path.resolve("..");
function seed(filename: string) {
  return spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/seed-investor-proposal-fixture.ts", filename], {
    cwd: web, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: "test" }, encoding: "utf8", timeout: 60000,
  });
}
test("current-time proposal seed is opt-in, temporary, explicitly fictional and cannot replace an existing fixture", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "etf-browser-fixture-")), filename = path.join(directory, "workbench.db");
  try {
    migrateWorkbench(filename); const start = Date.now(), result = seed(filename);
    assert.equal(result.status, 0, result.stderr);
    const marker = JSON.parse(readFileSync(path.join(directory, "proposal-fixture.json"), "utf8"));
    assert.equal(marker.synthetic_fixture_only, true); assert.equal(marker.formal_gates_are_synthetic, true); assert.equal(marker.clock_modified, false);
    assert.equal(marker.production_changed, false); assert.equal(marker.broker_or_provider_verified, false);
    assert.ok(Date.parse(marker.seeded_at) >= start - 1000 && Date.parse(marker.seeded_at) <= Date.now());
    const db = openWorkbench(filename);
    try {
      const before = db.prepare("SELECT total_changes() n").get();
      const context = getInvestorProposalReviewContext(db, { id: "owner" }, marker.proposal_id, new Date().toISOString(),
        { dataDir: path.join(directory, "auth"), releaseHash: marker.release_hash });
      assert.deepEqual(db.prepare("SELECT total_changes() n").get(), before);
      assert.equal(context.proposals.length, 2); assert.equal(context.selected!.current_risk.status, "pass");
      assert.ok(context.selected!.allowed_operations.includes("approve"));
      for (const table of ["approval_events", "reservations"])
        assert.equal((db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
      const snapshot = db.prepare("SELECT id,input_hash FROM proposals ORDER BY id").all();
      assert.equal(seed(filename).status, 1);
      assert.deepEqual(db.prepare("SELECT id,input_hash FROM proposals ORDER BY id").all(), snapshot);
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("non-fixture locations and worker combinations fail before any synthetic seed or server startup", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "not-an-etf-browser-fixture-")), filename = path.join(directory, "workbench.db");
  try {
    migrateWorkbench(filename); assert.equal(seed(filename).status, 1); assert.equal(existsSync(path.join(directory, "auth")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  for (const flag of ["--with-worker", "--with-verifier", "--with-execution-records", "--with-history-records"]) {
    const result = spawnSync(process.execPath, ["web/scripts/serve-workbench-fixture.mjs", "--with-proposal-records", flag], { cwd: root, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 2); assert.match(result.stderr, /UNKNOWN_FIXTURE_ARGUMENT/); assert.equal(result.stdout, "");
  }
  const launcher = readFileSync(path.join(web, "scripts/serve-workbench-fixture.mjs"), "utf8");
  assert.doesNotMatch(launcher, /NODE_OPTIONS|Date\.now\s*=/);
});
