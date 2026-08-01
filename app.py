# -*- coding: utf-8 -*-
"""AI 下游投资观测台 — Flask 服务端渲染工作台，监听 127.0.0.1:5000"""
import json
import os
from datetime import datetime

from flask import Flask, abort, redirect, render_template, request, url_for

import db

app = Flask(__name__)
db.init_db()

LIGHT_NAMES = {"red": "红灯", "yellow": "黄灯", "green": "绿灯"}


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def last_job_status():
    """读 data/jobs.log 最后一条 [STATUS] 行，返回原文；没有则返回 None"""
    log_path = os.path.join(db.BASE_DIR, "data", "jobs.log")
    try:
        with open(log_path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 65536))
            lines = f.read().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        if "[STATUS]" in line:
            return line.strip()
    return None


def fmt_num(v):
    if v is None:
        return "—"
    a = abs(v)
    if a >= 1e12:
        return "%.2fT" % (v / 1e12)
    if a >= 1e9:
        return "%.2fB" % (v / 1e9)
    if a >= 1e6:
        return "%.2fM" % (v / 1e6)
    if a >= 1e3:
        return "{:,.1f}".format(v)
    return "{:,.3f}".format(v).rstrip("0").rstrip(".")


def get_signals_grouped():
    conn = db.get_db()
    try:
        rows = conn.execute("SELECT * FROM signals ORDER BY rowid").fetchall()
    finally:
        conn.close()
    groups = []
    for key, label in db.LAYERS:
        groups.append({
            "key": key,
            "label": label,
            "signals": [r for r in rows if r["layer"] == key],
            "statuses": db.FALSIFY_STATUSES if key == "falsify" else db.CONFIRM_STATUSES,
        })
    return groups


@app.template_filter("light_name")
def light_name(light):
    return LIGHT_NAMES.get(light, light)


@app.route("/")
def dashboard():
    conn = db.get_db()
    try:
        overview = conn.execute("SELECT * FROM overview WHERE id = 1").fetchone()
        last_obs = conn.execute("SELECT * FROM observations ORDER BY date DESC, id DESC LIMIT 1").fetchone()
        counts = {}
        for row in conn.execute("SELECT status, COUNT(*) AS c FROM signals GROUP BY status").fetchall():
            counts[row["status"]] = row["c"]
        last_report = conn.execute(
            "SELECT * FROM ai_reports ORDER BY id DESC LIMIT 1").fetchone()
    finally:
        conn.close()
    return render_template("dashboard.html", overview=overview, last_obs=last_obs,
                           counts=counts, last_report=last_report,
                           last_status=last_job_status(), active="dashboard")


@app.route("/signals")
def signals():
    return render_template("signals.html", groups=get_signals_grouped(), active="signals")


@app.route("/signals/<sid>/update", methods=["POST"])
def signal_update(sid):
    status = request.form.get("status", "").strip()
    current_value = request.form.get("current_value", "").strip()
    note = request.form.get("note", "").strip()
    conn = db.get_db()
    try:
        old = conn.execute("SELECT * FROM signals WHERE id = ?", (sid,)).fetchone()
        if old is None:
            conn.close()
            abort(404)
        valid = db.FALSIFY_STATUSES if old["layer"] == "falsify" else db.CONFIRM_STATUSES
        if status not in valid:
            status = old["status"]
        ts = now_str()
        conn.execute(
            "UPDATE signals SET status = ?, current_value = ?, note = ?, updated_at = ? WHERE id = ?",
            (status, current_value, note, ts, sid),
        )
        conn.execute(
            "INSERT INTO signal_history (signal_id, old_status, new_status, old_value, new_value, note, changed_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (sid, old["status"], status, old["current_value"], current_value, note, ts),
        )
        conn.commit()
    finally:
        conn.close()
    return redirect(url_for("signals") + "#" + sid)


@app.route("/observations")
def observations():
    conn = db.get_db()
    try:
        rows = conn.execute("SELECT * FROM observations ORDER BY date DESC, id DESC").fetchall()
    finally:
        conn.close()
    obs = []
    for r in rows:
        obs.append(dict(r, snapshot=json.loads(r["snapshot"])))
    return render_template("observations.html", observations=obs,
                           groups=get_signals_grouped(), today=datetime.now().strftime("%Y-%m-%d"),
                           active="observations")


@app.route("/observations/add", methods=["POST"])
def observation_add():
    date = request.form.get("date", "").strip() or datetime.now().strftime("%Y-%m-%d")
    light = request.form.get("light", "red")
    if light not in LIGHT_NAMES:
        light = "red"
    note = request.form.get("note", "").strip()
    # 快照：表单里每个信号一个输入，缺失时回退到该信号当前值
    snapshot = {}
    conn = db.get_db()
    try:
        for r in conn.execute("SELECT id, current_value FROM signals ORDER BY rowid").fetchall():
            snapshot[r["id"]] = request.form.get("snap_" + r["id"], "").strip() or r["current_value"]
        conn.execute(
            "INSERT INTO observations (date, light, snapshot, note, created_at) VALUES (?,?,?,?,?)",
            (date, light, json.dumps(snapshot, ensure_ascii=False), note, now_str()),
        )
        conn.commit()
    finally:
        conn.close()
    return redirect(url_for("observations"))


@app.route("/thesis", methods=["GET", "POST"])
def thesis():
    conn = db.get_db()
    try:
        if request.method == "POST":
            for key in ("thesis", "rules"):
                conn.execute(
                    "INSERT INTO pages (key, content) VALUES (?, ?)"
                    " ON CONFLICT(key) DO UPDATE SET content = excluded.content",
                    (key, request.form.get(key, "")),
                )
            conn.commit()
            return redirect(url_for("thesis"))
        pages = {r["key"]: r["content"] for r in conn.execute("SELECT * FROM pages").fetchall()}
    finally:
        conn.close()
    return render_template("thesis.html", thesis=pages.get("thesis", ""),
                           rules=pages.get("rules", ""), active="thesis")


@app.route("/pool")
def pool():
    conn = db.get_db()
    try:
        rows = conn.execute("SELECT * FROM pool ORDER BY id").fetchall()
    finally:
        conn.close()
    return render_template("pool.html", items=rows, active="pool")


@app.route("/pool/add", methods=["POST"])
def pool_add():
    name = request.form.get("name", "").strip()
    if name:
        conn = db.get_db()
        try:
            conn.execute(
                "INSERT INTO pool (name, code, channel, position, note) VALUES (?,?,?,?,?)",
                (name, request.form.get("code", "").strip(), request.form.get("channel", "").strip(),
                 request.form.get("position", "").strip(), request.form.get("note", "").strip()),
            )
            conn.commit()
        finally:
            conn.close()
    return redirect(url_for("pool"))


@app.route("/pool/<int:pid>/update", methods=["POST"])
def pool_update(pid):
    conn = db.get_db()
    try:
        conn.execute(
            "UPDATE pool SET name = ?, code = ?, channel = ?, position = ?, note = ? WHERE id = ?",
            (request.form.get("name", "").strip(), request.form.get("code", "").strip(),
             request.form.get("channel", "").strip(), request.form.get("position", "").strip(),
             request.form.get("note", "").strip(), pid),
        )
        conn.commit()
    finally:
        conn.close()
    return redirect(url_for("pool"))


@app.route("/pool/<int:pid>/delete", methods=["POST"])
def pool_delete(pid):
    conn = db.get_db()
    try:
        conn.execute("DELETE FROM pool WHERE id = ?", (pid,))
        conn.commit()
    finally:
        conn.close()
    return redirect(url_for("pool"))


@app.route("/snapshots")
def snapshots():
    conn = db.get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM snapshots ORDER BY metric_key, period_date").fetchall()
    finally:
        conn.close()
    # 分组排序：edgar 公司指标在前，其次腾讯/台积电，最后 px 行情
    def rank(key):
        if key.startswith("edgar:"):
            return (0, key)
        if key.startswith(("yf:", "twse:")):
            return (1, key)
        return (2, key)
    metrics = {}
    for r in rows:
        m = metrics.setdefault(r["metric_key"], {
            "key": r["metric_key"], "label": r["label"], "unit": r["unit"],
            "source": r["source"], "points": [], "rows": []})
        m["points"].append({"d": r["period_date"], "v": r["value"]})
        m["rows"].append((r["period_date"], fmt_num(r["value"]), r["fetched_at"]))
    groups = sorted(metrics.values(), key=lambda m: rank(m["key"]))
    for m in groups:
        m["rows"] = m["rows"][-10:][::-1]  # 表格只显示最近 10 行，倒序
    return render_template("snapshots.html", groups=groups, active="snapshots")


@app.route("/reports")
def reports():
    conn = db.get_db()
    try:
        rows = conn.execute("SELECT * FROM ai_reports ORDER BY id DESC").fetchall()
    finally:
        conn.close()
    return render_template("reports.html", reports=rows, active="reports")


@app.route("/reports/<int:rid>")
def report_detail(rid):
    conn = db.get_db()
    try:
        report = conn.execute("SELECT * FROM ai_reports WHERE id = ?", (rid,)).fetchone()
    finally:
        conn.close()
    if report is None:
        abort(404)
    return render_template("report_detail.html", report=report, active="reports")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5051, debug=False)
