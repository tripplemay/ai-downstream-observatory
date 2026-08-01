# -*- coding: utf-8 -*-
"""数据库连接、通用 schema 与主题灌库。

分层约定：
- 数据层（顶层、主题无感知）：metrics 注册表 + snapshots 指标仓库，全局共享；
- 判断层（主题隔离）：signals / overview / pool / pages / observations / ai_reports 均带 theme_id；
- 连接方式：theme_metrics 订阅表，采集按启用主题的订阅并集驱动（见 worker/fetch_data.py）。

主题内容（thesis、信号、标的池、指标订阅）在 worker/themes/ 下按主题一个文件，
本文件不含任何具体主题的判断内容。"""
import json
import os
import sqlite3
import sys
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("OBS_DB_PATH") or os.path.join(BASE_DIR, "data", "observatory.db")

# 层定义：key -> 展示名（全局结构，各主题共用）
LAYERS = [
    ("upstream", "第一层：上游趋同（判断的前提）"),
    ("profit", "第二层：下游产生利润（核心判断）"),
    ("platform", "第三层：利润归属平台（标的选择依据）"),
    ("falsify", "证伪信号（出现则暂停/修正判断）"),
]

# 信号状态取值
CONFIRM_STATUSES = ["未验证", "验证中", "已验证", "反向"]
FALSIFY_STATUSES = ["未触发", "已触发"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS metrics (
    metric_key TEXT PRIMARY KEY,
    label TEXT DEFAULT '',
    unit TEXT DEFAULT '',
    kind TEXT NOT NULL,
    params TEXT DEFAULT '{}',
    enabled INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS theme_metrics (
    theme_id TEXT NOT NULL,
    metric_key TEXT NOT NULL,
    PRIMARY KEY (theme_id, metric_key)
);
CREATE TABLE IF NOT EXISTS signals (
    theme_id TEXT NOT NULL,
    id TEXT NOT NULL,
    layer TEXT NOT NULL,
    name TEXT NOT NULL,
    watch TEXT DEFAULT '',
    source TEXT DEFAULT '',
    trigger_cond TEXT DEFAULT '',
    current_value TEXT DEFAULT '',
    status TEXT DEFAULT '',
    updated_at TEXT DEFAULT '',
    note TEXT DEFAULT '',
    PRIMARY KEY (theme_id, id)
);
CREATE TABLE IF NOT EXISTS signal_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    theme_id TEXT NOT NULL,
    signal_id TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT,
    old_value TEXT,
    new_value TEXT,
    note TEXT,
    changed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    theme_id TEXT NOT NULL,
    date TEXT NOT NULL,
    light TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS overview (
    theme_id TEXT PRIMARY KEY,
    layer1_status TEXT, layer1_evidence TEXT,
    layer2_status TEXT, layer2_evidence TEXT,
    layer3_status TEXT, layer3_evidence TEXT,
    sentiment TEXT, sentiment_evidence TEXT,
    light TEXT, conclusion TEXT,
    action TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    theme_id TEXT NOT NULL,
    name TEXT NOT NULL,
    code TEXT DEFAULT '',
    channel TEXT DEFAULT '',
    position TEXT DEFAULT '',
    note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS pages (
    theme_id TEXT NOT NULL,
    key TEXT NOT NULL,
    content TEXT DEFAULT '',
    PRIMARY KEY (theme_id, key)
);
CREATE TABLE IF NOT EXISTS snapshots (
    metric_key TEXT NOT NULL,
    label TEXT DEFAULT '',
    period_date TEXT NOT NULL,
    value REAL,
    unit TEXT DEFAULT '',
    source TEXT DEFAULT '',
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (metric_key, period_date)
);
CREATE TABLE IF NOT EXISTS ai_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    theme_id TEXT NOT NULL,
    run_date TEXT NOT NULL,
    run_type TEXT NOT NULL,
    light TEXT DEFAULT '',
    narrative TEXT DEFAULT '',
    created_at TEXT NOT NULL
);
"""


def get_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def seed_theme(conn, theme):
    """灌入一个主题的定义内容（幂等：该主题已有信号则跳过内容，只补齐注册信息）。

    theme 结构见 worker/themes/ai_downstream.py：
      id/name/description, metrics [(key,label,unit,kind,params_dict)...],
      signals [(id,layer,name,watch,source,trigger_cond,current_value,status,updated_at,note)...],
      overview (10 字段元组), pool [(name,code,channel,position,note)...],
      pages {key: content}, initial_observation (date, light, snapshot_dict, note)
    """
    tid = theme["id"]
    conn.execute(
        "INSERT OR IGNORE INTO themes (id, name, description, enabled, created_at) VALUES (?,?,?,1,?)",
        (tid, theme["name"], theme.get("description", ""), datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
    for key, label, unit, kind, params in theme.get("metrics", []):
        conn.execute(
            "INSERT OR IGNORE INTO metrics (metric_key, label, unit, kind, params, enabled) VALUES (?,?,?,?,?,1)",
            (key, label, unit, kind, json.dumps(params, ensure_ascii=False)))
        conn.execute("INSERT OR IGNORE INTO theme_metrics (theme_id, metric_key) VALUES (?,?)", (tid, key))
    count = conn.execute("SELECT COUNT(*) AS c FROM signals WHERE theme_id = ?", (tid,)).fetchone()["c"]
    if count > 0:
        return
    conn.executemany(
        "INSERT INTO signals (theme_id, id, layer, name, watch, source, trigger_cond, current_value, status, updated_at, note)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [(tid,) + tuple(s) for s in theme["signals"]],
    )
    conn.execute(
        "INSERT INTO overview (theme_id, layer1_status, layer1_evidence, layer2_status, layer2_evidence,"
        " layer3_status, layer3_evidence, sentiment, sentiment_evidence, light, conclusion)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (tid,) + tuple(theme["overview"]),
    )
    conn.executemany(
        "INSERT INTO pool (theme_id, name, code, channel, position, note) VALUES (?,?,?,?,?,?)",
        [(tid,) + tuple(p) for p in theme.get("pool", [])],
    )
    conn.executemany(
        "INSERT INTO pages (theme_id, key, content) VALUES (?,?,?)",
        [(tid, k, v) for k, v in theme.get("pages", {}).items()],
    )
    obs = theme.get("initial_observation")
    if obs:
        date, light, snapshot, note = obs
        conn.execute(
            "INSERT INTO observations (theme_id, date, light, snapshot, note, created_at) VALUES (?,?,?,?,?,?)",
            (tid, date, light, json.dumps(snapshot, ensure_ascii=False), note, date + " 00:00:00"),
        )


def ensure_column(conn, table, column, ddl):
    """给已存在的库补列（幂等），用于 schema 小步演进。"""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(%s)" % table)]
    if column not in cols:
        conn.execute("ALTER TABLE %s ADD COLUMN %s" % (table, ddl))


def init_db():
    """建表；把 worker/themes 注册表里的主题灌入（幂等）。

    新增主题的入口就是这里：在 worker/themes/ 加一个模块并登记到 ALL_THEMES，
    任意 worker 运行（fetch/analyze 都会调 init_db）即自动完成灌库。"""
    conn = get_db()
    try:
        conn.executescript(SCHEMA)
        ensure_column(conn, "overview", "action", "action TEXT DEFAULT ''")
        if BASE_DIR not in sys.path:
            sys.path.insert(0, BASE_DIR)
        from worker.themes import ALL_THEMES
        for theme in ALL_THEMES:
            seed_theme(conn, theme)
        conn.commit()
    finally:
        conn.close()
