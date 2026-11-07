import type Database from "better-sqlite3";
import spec from "../../../../contracts/v1/investor-correction-change-fence.json";
import { canonical, hash } from "../ledger/service";

type Obj = Record<string, unknown>;
export function correctionChangeFence(db: Database.Database, workspace: string, actor: { id: string }) {
  const owner = db.prepare("SELECT id,owner_id,revision FROM investor_workspaces WHERE id=?").get(workspace) as Obj | undefined;
  if (owner?.owner_id !== actor.id) throw new Error("CORRECTION_FENCE_OUT_OF_SCOPE");
  const result: Obj = {}; let total = 0, size = 0;
  const add = (table: string, rows: unknown[]) => {
    total += rows.length; size += Buffer.byteLength(canonical(rows));
    if (total > spec.max_rows || size > 33554432) throw new Error("CORRECTION_FENCE_LIMIT"); result[table] = rows;
  };
  const columns = (table: string) => {
    if (!/^investor_[a-z_]+$/.test(table)) throw new Error("CORRECTION_FENCE_SCHEMA_INVALID");
    const values = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; type: string }[])
      .filter(row => !row.name.endsWith("_json") && row.type.toUpperCase() !== "BLOB").map(row => row.name);
    if (!values.length) throw new Error("CORRECTION_FENCE_SCHEMA_INVALID"); return values;
  };
  // Scalar header changes and payload presence only. Never source qualification.
  for (const table of spec.tables) {
    const selected = columns(table); if (!selected.includes("workspace_id")) throw new Error("CORRECTION_FENCE_SCHEMA_INVALID");
    const rows = db.prepare(`SELECT rowid AS _rowid,${selected.map(name => `"${name}"`).join(",")} FROM "${table}" WHERE workspace_id=? ORDER BY rowid LIMIT ?`).all(workspace, spec.max_rows - total + 1);
    add(table, rows);
  }
  for (const [table, key, parent] of spec.children) {
    const selected = columns(table);
    const rows = db.prepare(`SELECT c.rowid AS _rowid,${selected.map(name => `c."${name}"`).join(",")} FROM "${table}" c JOIN "${parent}" p ON p.id=c."${key}" WHERE p.workspace_id=? ORDER BY c.rowid LIMIT ?`).all(workspace, spec.max_rows - total + 1);
    add(table, rows);
  }
  if (total > spec.max_rows || Buffer.byteLength(canonical(result)) > 33554432) throw new Error("CORRECTION_FENCE_LIMIT");
  result.workspace = owner; return hash(result);
}
