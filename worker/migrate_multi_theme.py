# -*- coding: utf-8 -*-
"""单主题库 → 多主题库一次性迁移。

- 先备份原库（<db>.bak-YYYYMMDD-HHMMSS），再迁移；
- 现有数据全部归入主题 ai-downstream，并回填 metrics 注册表与订阅关系；
- 幂等：已存在 themes 表（已迁移或新库）直接跳过；
- 用法: python worker/migrate_multi_theme.py [--db 路径]（默认 data/observatory.db）"""
import argparse
import os
import sqlite3
import sys
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)
import db  # noqa: E402
from worker.themes.ai_downstream import THEME  # noqa: E402

THEME_ID = THEME["id"]


def migrate(path):
    if not os.path.exists(path):
        print("库不存在，无需迁移: %s" % path)
        return
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "themes" in tables:
            print("已是多主题结构，跳过: %s" % path)
            return
        backup = "%s.bak-%s" % (path, datetime.now().strftime("%Y%m%d-%H%M%S"))
        conn.close()
        # 用 SQLite backup API 备份：直接文件拷贝会漏掉 WAL 里未 checkpoint 的数据
        bconn = sqlite3.connect(path)
        dest = sqlite3.connect(backup)
        bconn.backup(dest)
        dest.close()
        bconn.close()
        print("已备份: %s" % backup)
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        with conn:  # 单事务：改表名 → 建新结构 → 拷贝 → 灌注册信息 → 删旧表
            conn.execute("ALTER TABLE signals RENAME TO _old_signals")
            conn.execute("ALTER TABLE signal_history RENAME TO _old_signal_history")
            conn.execute("ALTER TABLE observations RENAME TO _old_observations")
            conn.execute("ALTER TABLE overview RENAME TO _old_overview")
            conn.execute("ALTER TABLE pool RENAME TO _old_pool")
            conn.execute("ALTER TABLE pages RENAME TO _old_pages")
            conn.execute("ALTER TABLE ai_reports RENAME TO _old_ai_reports")
            conn.executescript(db.SCHEMA)

            conn.execute(
                "INSERT INTO signals (theme_id, id, layer, name, watch, source, trigger_cond,"
                " current_value, status, updated_at, note)"
                " SELECT ?, id, layer, name, watch, source, trigger_cond, current_value, status, updated_at, note"
                " FROM _old_signals", (THEME_ID,))
            conn.execute(
                "INSERT INTO signal_history (theme_id, signal_id, old_status, new_status, old_value, new_value, note, changed_at)"
                " SELECT ?, signal_id, old_status, new_status, old_value, new_value, note, changed_at"
                " FROM _old_signal_history ORDER BY id", (THEME_ID,))
            conn.execute(
                "INSERT INTO observations (theme_id, date, light, snapshot, note, created_at)"
                " SELECT ?, date, light, snapshot, note, created_at FROM _old_observations ORDER BY id", (THEME_ID,))
            conn.execute(
                "INSERT INTO overview (theme_id, layer1_status, layer1_evidence, layer2_status, layer2_evidence,"
                " layer3_status, layer3_evidence, sentiment, sentiment_evidence, light, conclusion)"
                " SELECT ?, layer1_status, layer1_evidence, layer2_status, layer2_evidence,"
                " layer3_status, layer3_evidence, sentiment, sentiment_evidence, light, conclusion"
                " FROM _old_overview", (THEME_ID,))
            conn.execute(
                "INSERT INTO pool (theme_id, name, code, channel, position, note)"
                " SELECT ?, name, code, channel, position, note FROM _old_pool ORDER BY id", (THEME_ID,))
            conn.execute(
                "INSERT INTO pages (theme_id, key, content) SELECT ?, key, content FROM _old_pages", (THEME_ID,))
            conn.execute(
                "INSERT INTO ai_reports (theme_id, run_date, run_type, light, narrative, created_at)"
                " SELECT ?, run_date, run_type, light, narrative, created_at FROM _old_ai_reports ORDER BY id", (THEME_ID,))

            db.seed_theme(conn, THEME)  # 只补 themes/metrics/theme_metrics（信号已存在，内容自动跳过）

            for t in ("_old_signals", "_old_signal_history", "_old_observations", "_old_overview",
                      "_old_pool", "_old_pages", "_old_ai_reports"):
                conn.execute("DROP TABLE %s" % t)
        # 校验输出
        for t in ("themes", "metrics", "theme_metrics", "signals", "signal_history",
                  "observations", "overview", "pool", "pages", "ai_reports", "snapshots"):
            n = conn.execute("SELECT COUNT(*) AS c FROM %s" % t).fetchone()["c"]
            print("  %-16s %d 行" % (t, n))
        print("迁移完成: %s" % path)
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=db.DB_PATH)
    args = ap.parse_args()
    migrate(args.db)


if __name__ == "__main__":
    main()
