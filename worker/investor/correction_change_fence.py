"""Conservative metadata change fence, not source proof or a permission resolver."""

import json
import re

from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, content_hash
from .data_evidence import _owner


SPEC = json.loads((ROOT / "contracts/v1/investor-correction-change-fence.json").read_text())


def correction_change_fence(db, workspace, actor):
    _owner(db, workspace, actor)
    result, total, size = {}, 0, 0
    def add(table, rows):
        nonlocal total, size
        values = [dict(row) for row in rows]; total += len(values); size += len(canonical_json(values).encode())
        if total > SPEC["max_rows"] or size > 33554432: raise WorkbenchError("CORRECTION_FENCE_LIMIT")
        result[table] = values
    for table in SPEC["tables"]:
        columns = _columns(db, table)
        if "workspace_id" not in columns: raise WorkbenchError("CORRECTION_FENCE_SCHEMA_INVALID")
        selected = ",".join('"' + name + '"' for name in columns)
        rows = db.execute(f'SELECT rowid AS _rowid,{selected} FROM "{table}" WHERE workspace_id=? ORDER BY rowid LIMIT ?', (workspace, SPEC["max_rows"] - total + 1)).fetchall()
        add(table, rows)
    for table, key, parent in SPEC["children"]:
        columns = _columns(db, table)
        selected = ",".join('c."' + name + '"' for name in columns)
        rows = db.execute(f'SELECT c.rowid AS _rowid,{selected} FROM "{table}" c JOIN "{parent}" p ON p.id=c."{key}" WHERE p.workspace_id=? ORDER BY c.rowid LIMIT ?',
            (workspace, SPEC["max_rows"] - total + 1)).fetchall()
        add(table, rows)
    if total > SPEC["max_rows"] or len(canonical_json(result).encode()) > 33554432: raise WorkbenchError("CORRECTION_FENCE_LIMIT")
    result["workspace"] = dict(db.execute("SELECT id,owner_id,revision FROM investor_workspaces WHERE id=?", (workspace,)).fetchone())
    return content_hash(result)


def _columns(db, table):
    if not re.fullmatch(r"investor_[a-z_]+", table): raise WorkbenchError("CORRECTION_FENCE_SCHEMA_INVALID")
    # Only immutable header scalars and payload presence. This deliberately does
    # not reread source bytes or claim they were requalified by a cached GET.
    columns = [row["name"] for row in db.execute(f'PRAGMA table_info("{table}")')
        if not row["name"].endswith("_json") and row["type"].upper() != "BLOB"]
    if not columns: raise WorkbenchError("CORRECTION_FENCE_SCHEMA_INVALID")
    return columns
