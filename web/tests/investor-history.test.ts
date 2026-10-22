import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readInvestorHistory } from "../src/server/investor/history";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { investorActor as actor, investorFixture, saveSyntheticProfile, seedSyntheticCandidate } from "./investor-fixture";

const now = "2026-01-02T12:00:10.000Z";
function execute(f: ReturnType<typeof investorFixture>, body: Record<string, unknown>, at = now) {
  const revision = (f.db.prepare("SELECT revision FROM investor_workspaces WHERE owner_id=?").get(actor.id) as { revision: number }).revision;
  return executeInvestorCommand(f.db, actor, { ...body, expected_revision: revision, idempotency_key: randomUUID() }, at);
}
test("archive traverses all observations beyond the old 50-row ceiling, fixed against tied-time later appends, without writes", () => {
  const f = investorFixture(); try {
    saveSyntheticProfile(f);
    for (let i = 0; i < 62; i++) execute(f, { action: "evaluate" });
    assert.equal(getInvestorState(f.db, actor, now).observations.length, 50);
    const lean = getInvestorState(f.db, actor, now, { includeRecentHistory: false });
    assert.equal(lean.observations.length, 1); assert.equal(lean.observations_truncated, true); assert.equal(lean.decisions.length, 0);
    assert.equal(lean.latest!.id, getInvestorState(f.db, actor, now).latest!.id);
    const before = f.db.prepare("SELECT total_changes() n").get(), first = readInvestorHistory(f.db, actor, {}, now);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    assert.equal(first.entries.length, 20); assert.equal(first.previous_cursor, null); assert.ok(first.next_cursor);
    assert.equal(first.is_current_conclusion, false); assert.equal(first.live_advice_eligible, false);
    const ids = first.entries.map(row => row.id);
    execute(f, { action: "evaluate" });
    let page = first;
    while (page.next_cursor) { page = readInvestorHistory(f.db, actor, { cursor: page.next_cursor }, now); ids.push(...page.entries.map(row => row.id)); }
    assert.equal(ids.length, 63); assert.equal(new Set(ids).size, 63);
    const last = page; assert.ok(last.previous_cursor); assert.equal(last.next_cursor, null);
    const previous = readInvestorHistory(f.db, actor, { cursor: last.previous_cursor! }, now);
    const again = readInvestorHistory(f.db, actor, { cursor: previous.next_cursor! }, now);
    assert.deepEqual(again.entries, last.entries);
    const refreshed = readInvestorHistory(f.db, actor, {}, now); assert.ok(refreshed.entries.some(row => !ids.includes(row.id)));
    assert.ok(first.entries.every(row => !("model_change" in row) && !("document_json" in row)));
  } finally { f.close(); }
});
test("all decisions for an old observation remain independently available, not lost to the global recent-50 limit", () => {
  const f = investorFixture(); try {
    saveSyntheticProfile(f); const seeded = seedSyntheticCandidate(f);
    for (let i = 0; i < 54; i++) execute(f, { action: "review", observation_id: seeded.observationId, decision: i % 2 ? "defer" : "reject", note: "Fictional review " + i });
    const first = readInvestorHistory(f.db, actor, { observation: seeded.observationId }, now), original = first.decisions.map(row => row.id);
    assert.equal(first.entries[0].latest_decision!.note, "Fictional review 53");
    execute(f, { action: "review", observation_id: seeded.observationId, decision: "accept_idea", note: "Fictional later decision" });
    let page = first;
    while (page.next_cursor) { page = readInvestorHistory(f.db, actor, { observation: seeded.observationId, cursor: page.next_cursor }, now); original.push(...page.decisions.map(row => row.id)); }
    assert.equal(original.length, 54); assert.equal(new Set(original).size, 54);
    assert.equal(first.entries[0].more_decisions, true);
    for (let i = 0; i < 52; i++) execute(f, { action: "evaluate" });
    assert.ok(!getInvestorState(f.db, actor, now).observations.some(row => row.id === seeded.observationId));
    const selected = readInvestorHistory(f.db, actor, { observation: seeded.observationId }, now);
    assert.equal(selected.entries[0].id, seeded.observationId); assert.equal(selected.mode, "decisions");
    assert.equal(selected.entries[0].latest_decision!.note, "Fictional later decision");
    const refreshed = [...selected.decisions]; page = selected;
    while (page.next_cursor) { page = readInvestorHistory(f.db, actor, { observation: seeded.observationId, cursor: page.next_cursor }, now); refreshed.push(...page.decisions); }
    assert.equal(refreshed.length, 55); assert.ok(refreshed.some(row => row.note === "Fictional later decision"));
    assert.equal((f.db.prepare("SELECT count(*) n FROM ledger_events").get() as { n: number }).n, 0);
  } finally { f.close(); }
});
test("empty, foreign, cursor scope, future clocks and malformed requests fail without leaking another workspace", () => {
  const f = investorFixture(); try {
    assert.equal(readInvestorHistory(f.db, actor, {}, now).workspace_id, null);
    saveSyntheticProfile(f);
    for (let i = 0; i < 21; i++) execute(f, { action: "evaluate" });
    const page = readInvestorHistory(f.db, actor, {}, now);
    assert.throws(() => readInvestorHistory(f.db, { id: "foreign" }, { cursor: page.next_cursor! }, now), /CURSOR_INVALID/);
    assert.throws(() => readInvestorHistory(f.db, { id: "foreign" }, { observation: page.entries[0].id }, now), /NOT_FOUND/);
    assert.throws(() => readInvestorHistory(f.db, actor, { observation: "foreign" }, now), /NOT_FOUND/);
    assert.throws(() => readInvestorHistory(f.db, actor, { cursor: "e30" }, now), /CURSOR_INVALID/);
    assert.throws(() => readInvestorHistory(f.db, actor, { cursor: page.next_cursor!, observation: page.entries[0].id }, now), /CURSOR_INVALID/);
    assert.throws(() => readInvestorHistory(f.db, actor, {}, "2026-01-02T12:00:00.000Z"), /EVIDENCE_INVALID/);
    assert.throws(() => readInvestorHistory(f.db, actor, { owner: "foreign" } as never, now));
  } finally { f.close(); }
});
test("archive query plans use append-head and per-observation keyset indexes rather than whole-book sorting", () => {
  const f = investorFixture(); try {
    for (const [sql, name] of [
      ["SELECT rowid,id,created_at FROM investor_observations WHERE workspace_id=? ORDER BY rowid DESC LIMIT 1", "investor_observation_append_head"],
      ["SELECT rowid,id,created_at FROM investor_decisions WHERE workspace_id=? ORDER BY rowid DESC LIMIT 1", "investor_decision_append_head"],
      ["SELECT * FROM investor_decisions WHERE workspace_id=? AND observation_id=? AND rowid<=? AND (created_at,rowid)<(?,?) ORDER BY created_at DESC,rowid DESC LIMIT 20", "investor_decision_observation_history"],
      ["SELECT * FROM investor_observations WHERE workspace_id=? AND rowid<=? AND (created_at,rowid)<(?,?) ORDER BY created_at DESC,rowid DESC LIMIT 20", "investor_observation_archive_order"],
    ]) {
      const count = (sql.match(/\?/g) ?? []).length;
      const details = (f.db.prepare("EXPLAIN QUERY PLAN " + sql).all(...Array(count).fill("fictional")) as { detail: string }[]).map(row => row.detail).join("\n");
      assert.ok(details.includes(name), details); assert.ok(!details.includes("TEMP B-TREE"), details);
    }
  } finally { f.close(); }
});
test("recovery mode permits read-only archive access, while a corrupt durable decision receipt cannot become trusted history", () => {
  const f = investorFixture(); try {
    saveSyntheticProfile(f); const seeded = seedSyntheticCandidate(f);
    execute(f, { action: "review", observation_id: seeded.observationId, decision: "defer", note: "Fictional immutable review" });
    const good = readInvestorHistory(f.db, actor, { observation: seeded.observationId }, now);
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "SYNTHETIC RECOVERY ONLY");
    const before = f.db.prepare("SELECT total_changes() n").get();
    assert.deepEqual(readInvestorHistory(f.db, actor, { observation: seeded.observationId }, now), good);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    f.db.exec("DROP TRIGGER investor_command_no_update");
    f.db.prepare("UPDATE investor_commands SET result_json=json_set(result_json,'$.audit_id','foreign') WHERE json_extract(result_json,'$.action')='review'").run();
    assert.throws(() => readInvestorHistory(f.db, actor, { observation: seeded.observationId }, now), /EVIDENCE_INVALID/);
  } finally { f.close(); }
});
