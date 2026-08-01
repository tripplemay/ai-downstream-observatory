# -*- coding: utf-8 -*-
"""AI 分析：调 AIGC 网关生成月度纪要 / 季度结构化分析。
用法: python worker/analyze.py [monthly|quarterly]
失败（网关不通 / JSON 解析失败）只写 data/jobs.log，不动业务表，退出码非 0。
成功时先算后写，单事务落库。"""
import json
import os
import sys
import traceback
import urllib.request
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db  # noqa: E402

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GATEWAY_CONF = os.path.join(BASE_DIR, "config", "gateway.json")
JOBS_LOG = os.path.join(BASE_DIR, "data", "jobs.log")
TIMEOUT = 240


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def fail(run_type, msg):
    with open(JOBS_LOG, "a", encoding="utf-8") as f:
        f.write("[%s] [STATUS] %s FAILED %s\n" % (now_str(), run_type, msg))
    print("FAILED: %s" % msg, file=sys.stderr, flush=True)
    sys.exit(1)


def call_gateway(conf, model, messages, json_mode=False, max_tokens=2000):
    body = {"model": model, "messages": messages,
            "temperature": conf.get("temperature", 0.3), "max_tokens": max_tokens}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(
        conf["base_url"].rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + conf["api_key"]},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]


def snapshot_summary(conn, quarters_only=False):
    """汇总 snapshots：EDGAR 类每指标最近 8 季度序列；价格类给最近值与 3 个月涨跌幅。"""
    lines = []
    metrics = conn.execute(
        "SELECT metric_key, label, unit FROM snapshots GROUP BY metric_key ORDER BY metric_key"
    ).fetchall()
    for m in metrics:
        key = m["metric_key"]
        rows = conn.execute(
            "SELECT period_date, value FROM snapshots WHERE metric_key = ? ORDER BY period_date",
            (key,),
        ).fetchall()
        if not rows:
            continue
        if key.startswith("px:"):
            first, last = rows[0], rows[-1]
            chg = (last["value"] - first["value"]) / first["value"] * 100 if first["value"] else 0
            lines.append("%s: 最新 %s=%.2f，近3个月(%s→%s)涨跌 %+.1f%%"
                         % (m["label"], last["period_date"], last["value"],
                            first["period_date"], last["period_date"], chg))
        else:
            tail = rows[-8:] if quarters_only else rows[-3:]
            seq = ", ".join("%s:%s" % (r["period_date"], format_num(r["value"])) for r in tail)
            lines.append("%s(%s): %s" % (m["label"], m["unit"], seq))
    return "\n".join(lines)


def format_num(v):
    if v is None:
        return "—"
    if abs(v) >= 1e9:
        return "%.1fB" % (v / 1e9)
    if abs(v) >= 1e6:
        return "%.1fM" % (v / 1e6)
    return "%.2f" % v


def run_monthly(conn, conf):
    data_text = snapshot_summary(conn)
    prompt = (
        "你是投资观测助手。以下是 AI 产业链观测台最新自动抓取的公开数据快照。\n"
        "请写一段不超过 300 字的中文月度纪要：概括上游(存储/算力/半导体)、下游(软件/中概)与平台公司的最新变化，"
        "指出哪些信号值得人工进一步核对。只输出纪要正文，不要标题、不要列表。\n\n"
        "数据快照:\n" + data_text
    )
    text = call_gateway(conf, conf["monthly_model"],
                        [{"role": "user", "content": prompt}],
                        max_tokens=conf.get("monthly_max_tokens", 2000)).strip()
    ts = now_str()
    with conn:  # 单事务
        conn.execute(
            "INSERT INTO ai_reports (run_date, run_type, light, narrative, created_at) VALUES (?,?,?,?,?)",
            (datetime.now().strftime("%Y-%m-%d"), "monthly", "", text, ts),
        )
    print("[%s] monthly 纪要已写入 ai_reports（%d 字）" % (ts, len(text)), flush=True)


def run_quarterly(conn, conf):
    data_text = snapshot_summary(conn, quarters_only=True)
    signals = conn.execute("SELECT * FROM signals ORDER BY rowid").fetchall()
    sig_text = "\n".join(
        "%s %s｜状态:%s｜当前值:%s｜触发条件:%s"
        % (s["id"], s["name"], s["status"], s["current_value"], s["trigger_cond"]) for s in signals)
    rules_row = conn.execute("SELECT content FROM pages WHERE key = 'rules'").fetchone()
    rules = rules_row["content"] if rules_row else ""
    statuses_hint = "确认信号(C开头)取值: %s；证伪信号(F开头)取值: %s" % (
        "/".join(db.CONFIRM_STATUSES), "/".join(db.FALSIFY_STATUSES))
    prompt = (
        "你是投资观测助手。本观测台跟踪的判断是：上游算力/存储超额利润终将趋同，下游 AI 应用会产生利润，"
        "且利润主要归属有分发/数据/工作流壁垒的平台公司。请基于以下信息做季度核对。\n\n"
        "【信号灯规则】\n%s\n\n【信号当前状态】（%s）\n%s\n\n【最近自动抓取的公开数据】\n%s\n\n"
        "请只输出一个 JSON 对象，字段如下：\n"
        '{"light":"red|yellow|green",'
        '"conclusion":"<一句话当前结论>",'
        '"signal_updates":[{"code":"C4","status":"<合法状态值>","current_value":"<简短当前值>","reason":"<依据>"}...],'
        '"manual_checklist":["<需要人工核实的事项>"...],'
        '"narrative":"<完整中文 Markdown 分析，含三层判断各自的论证>"}\n'
        "只更新证据有实质变化的信号，无把握的不要改；不要输出 JSON 以外的任何文字。"
    ) % (rules, statuses_hint, sig_text, data_text)
    raw = call_gateway(conf, conf["quarterly_model"],
                       [{"role": "user", "content": prompt}], json_mode=True,
                       max_tokens=conf.get("quarterly_max_tokens", 16000))
    # 容错解析：截取第一个 { 到最后一个 }
    try:
        start, end = raw.index("{"), raw.rindex("}")
        result = json.loads(raw[start:end + 1])
    except (ValueError, json.JSONDecodeError) as ex:
        fail("quarterly", "JSON 解析失败: %s" % ex)
    light = result.get("light", "")
    if light not in ("red", "yellow", "green"):
        fail("quarterly", "light 字段非法: %r" % light)
    updates = result.get("signal_updates") or []
    checklist = result.get("manual_checklist") or []
    narrative = (result.get("narrative") or "").strip()
    conclusion = (result.get("conclusion") or "").strip() or narrative.replace("\n", " ")[:120]
    if not narrative:
        fail("quarterly", "narrative 为空")

    # 先算后写：校验全部 signal_updates，非法条目跳过并记日志
    valid_status = {s["id"]: (db.FALSIFY_STATUSES if s["layer"] == "falsify" else db.CONFIRM_STATUSES)
                    for s in signals}
    old_map = {s["id"]: s for s in signals}
    plan = []
    for u in updates:
        code = str(u.get("code", "")).strip()
        st = str(u.get("status", "")).strip()
        if code not in valid_status:
            print("跳过未知信号 %r" % code, flush=True)
            continue
        if st not in valid_status[code]:
            print("跳过 %s 的非法状态 %r" % (code, st), flush=True)
            continue
        plan.append((code, st, str(u.get("current_value", "")).strip(),
                     str(u.get("reason", "")).strip()))

    ts = now_str()
    run_date = datetime.now().strftime("%Y-%m-%d")
    full_narrative = narrative
    if checklist:
        full_narrative += "\n\n## 人工核对清单\n" + "\n".join("- " + str(c) for c in checklist)
    with conn:  # 单事务落库
        for code, st, val, reason in plan:
            old = old_map[code]
            conn.execute(
                "UPDATE signals SET status = ?, current_value = ?, note = ?, updated_at = ? WHERE id = ?",
                (st, val or old["current_value"], reason, ts, code))
            conn.execute(
                "INSERT INTO signal_history (signal_id, old_status, new_status, old_value, new_value, note, changed_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (code, old["status"], st, old["current_value"], val or old["current_value"],
                 "AI季度分析: " + reason, ts))
        snap = {r["id"]: r["current_value"] for r in
                conn.execute("SELECT id, current_value FROM signals ORDER BY rowid").fetchall()}
        conn.execute(
            "INSERT INTO observations (date, light, snapshot, note, created_at) VALUES (?,?,?,?,?)",
            (run_date, light, json.dumps(snap, ensure_ascii=False), "季度自动分析（AI）", ts))
        conn.execute("UPDATE overview SET light = ?, conclusion = ? WHERE id = 1", (light, conclusion))
        conn.execute(
            "INSERT INTO ai_reports (run_date, run_type, light, narrative, created_at) VALUES (?,?,?,?,?)",
            (run_date, "quarterly", light, full_narrative, ts))
    print("[%s] quarterly 完成: light=%s, 信号更新 %d 条, 核对清单 %d 项"
          % (ts, light, len(plan), len(checklist)), flush=True)


def main():
    run_type = sys.argv[1] if len(sys.argv) > 1 else "monthly"
    if run_type not in ("monthly", "quarterly"):
        fail(run_type, "未知运行类型（应为 monthly|quarterly）")
    try:
        with open(GATEWAY_CONF, encoding="utf-8") as f:
            conf = json.load(f)
    except Exception as ex:
        fail(run_type, "读取 gateway.json 失败: %s" % ex)
    db.init_db()
    conn = db.get_db()
    try:
        if run_type == "monthly":
            run_monthly(conn, conf)
        else:
            run_quarterly(conn, conf)
    except SystemExit:
        raise
    except Exception as ex:
        traceback.print_exc()
        fail(run_type, "%s: %s" % (type(ex).__name__, ex))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
