# -*- coding: utf-8 -*-
"""AI 分析：调 AIGC 网关为每个启用主题生成月度纪要 / 季度结构化分析。

主题化：prompt 中的判断框架取自该主题 pages 表的 thesis/rules，数据摘要只含该主题
订阅的指标；signals/overview/observations/ai_reports 读写均带 theme_id。
用法: python worker/analyze.py [monthly|quarterly] [--theme <slug>]
单主题失败只记 data/jobs.log 并继续其余主题，全部完成后有失败则退出码非 0。
成功时先算后写，单事务落库。"""
import argparse
import json
import os
import sys
import traceback
import urllib.request
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db  # noqa: E402
from worker import notify  # noqa: E402

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


def snapshot_summary(conn, theme_id, quarters_only=False):
    """汇总该主题订阅的 snapshots：EDGAR 类每指标最近 8 季度序列；价格类给最近值与 3 个月涨跌幅。"""
    lines = []
    metrics = conn.execute(
        "SELECT s.metric_key, s.label, s.unit FROM snapshots s"
        " JOIN theme_metrics tm ON tm.metric_key = s.metric_key AND tm.theme_id = ?"
        " GROUP BY s.metric_key ORDER BY s.metric_key",
        (theme_id,),
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


def get_page(conn, theme_id, key):
    row = conn.execute("SELECT content FROM pages WHERE theme_id = ? AND key = ?",
                       (theme_id, key)).fetchone()
    return row["content"] if row else ""


def run_monthly(conn, conf, theme):
    """月度核对：轻量 JSON 判定（light/conclusion/action/narrative），消除季度间的信号灯空窗。
    灯号变化时写观测记录并告警；纪要始终入 ai_reports。"""
    tid = theme["id"]
    data_text = snapshot_summary(conn, tid)
    thesis = get_page(conn, tid, "thesis")
    rules = get_page(conn, tid, "rules")
    signals = conn.execute("SELECT id, name, status, current_value FROM signals"
                           " WHERE theme_id = ? ORDER BY rowid", (tid,)).fetchall()
    sig_text = "\n".join("%s %s｜%s｜%s" % (s["id"], s["name"], s["status"], s["current_value"])
                         for s in signals)
    prompt = (
        "你是投资观测助手。「%s」观测台跟踪的判断是：\n%s\n\n【信号灯规则】\n%s\n\n"
        "【信号当前状态】（部分由规则引擎每日/每月定量判定）\n%s\n\n"
        "【最近自动抓取的公开数据】\n%s\n\n"
        "请做月度核对，只输出一个 JSON 对象：\n"
        '{"light":"red|yellow|green",'
        '"conclusion":"<一句话当前结论>",'
        '"action":"<当前灯号下的明确操作建议；无动作则写 继续等待，不操作>",'
        '"narrative":"<不超过 300 字的中文月度纪要：概括最新变化，指出值得人工核对的信号>"}\n'
        "信号状态维持概率很高时灯号不要轻易变动；不要输出 JSON 以外的任何文字。"
    ) % (theme["name"], thesis or "（未填写）", rules, sig_text, data_text)
    raw = call_gateway(conf, conf["monthly_model"],
                       [{"role": "user", "content": prompt}], json_mode=True,
                       max_tokens=conf.get("monthly_max_tokens", 4000))
    try:
        start, end = raw.index("{"), raw.rindex("}")
        result = json.loads(raw[start:end + 1])
    except (ValueError, json.JSONDecodeError) as ex:
        fail("monthly", "JSON 解析失败: %s" % ex)
    light = result.get("light", "")
    if light not in ("red", "yellow", "green"):
        fail("monthly", "light 字段非法: %r" % light)
    narrative = (result.get("narrative") or "").strip()
    if not narrative:
        fail("monthly", "narrative 为空")
    conclusion = (result.get("conclusion") or "").strip() or narrative.replace("\n", " ")[:120]
    action = (result.get("action") or "").strip()

    ts = now_str()
    run_date = datetime.now().strftime("%Y-%m-%d")
    old = conn.execute("SELECT light FROM overview WHERE theme_id = ?", (tid,)).fetchone()
    old_light = old["light"] if old else ""
    changes = []
    with conn:  # 单事务
        conn.execute(
            "INSERT INTO ai_reports (theme_id, run_date, run_type, light, narrative, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (tid, run_date, "monthly", light, narrative, ts))
        conn.execute("UPDATE overview SET light = ?, conclusion = ?, action = ? WHERE theme_id = ?",
                     (light, conclusion, action, tid))
        if old_light and old_light != light:
            snap = {s["id"]: s["current_value"] for s in signals}
            conn.execute(
                "INSERT INTO observations (theme_id, date, light, snapshot, note, created_at)"
                " VALUES (?,?,?,?,?,?)",
                (tid, run_date, light, json.dumps(snap, ensure_ascii=False), "月度核对灯号变化（AI）", ts))
            changes.append("[%s] 信号灯：%s → %s（%s）" % (tid, old_light, light, conclusion))
    print("[%s] [%s] monthly 完成: light=%s（%d 字）" % (ts, tid, light, len(narrative)), flush=True)
    notify.notify_changes("观测台月度核对：%s" % theme["name"], changes)


def run_quarterly(conn, conf, theme):
    tid = theme["id"]
    data_text = snapshot_summary(conn, tid, quarters_only=True)
    signals = conn.execute("SELECT * FROM signals WHERE theme_id = ? ORDER BY rowid", (tid,)).fetchall()
    sig_text = "\n".join(
        "%s %s｜状态:%s｜当前值:%s｜触发条件:%s"
        % (s["id"], s["name"], s["status"], s["current_value"], s["trigger_cond"]) for s in signals)
    thesis = get_page(conn, tid, "thesis")
    rules = get_page(conn, tid, "rules")
    pool_rows = conn.execute("SELECT name, code, channel, position, note FROM pool WHERE theme_id = ?",
                             (tid,)).fetchall()
    pool_text = "\n".join("- %s（%s，%s）：%s%s" % (p["name"], p["code"], p["channel"], p["position"],
                                                  "；备注:" + p["note"] if p["note"] else "")
                          for p in pool_rows) or "（标的池为空）"
    statuses_hint = "确认信号(C开头)取值: %s；证伪信号(F开头)取值: %s" % (
        "/".join(db.CONFIRM_STATUSES), "/".join(db.FALSIFY_STATUSES))
    prompt = (
        "你是投资观测助手。「%s」观测台跟踪的判断是：\n%s\n请基于以下信息做季度核对。\n\n"
        "【信号灯规则】\n%s\n\n【信号当前状态】（%s）\n%s\n\n【最近自动抓取的公开数据】\n%s\n\n"
        "【标的池】\n%s\n\n"
        "请只输出一个 JSON 对象，字段如下：\n"
        '{"light":"red|yellow|green",'
        '"conclusion":"<一句话当前结论>",'
        '"action":"<当前灯号下的明确操作建议：做什么（等待/小额试探/开始建仓/暂停或修正判断）、'
        '涉及标的池中的具体标的、执行节奏；无动作则写 继续等待，不操作>",'
        '"signal_updates":[{"code":"C4","status":"<合法状态值>","current_value":"<简短当前值>","reason":"<依据>"}...],'
        '"manual_checklist":["<需要人工核实的事项>"...],'
        '"pool_review":"<标的池复核：逐个评估现有标的是否仍符合主题（持仓纯度/规模/溢价/流动性），'
        '指出需要关注的标的；无问题写 无异常>",'
        '"pool_candidates":["<新发现的候选标的：名称+代码+纳入理由（如纯度更高的平台ETF、'
        '新成立的 AI 应用ETF）；无则空数组>"...],'
        '"narrative":"<完整中文 Markdown 分析，含各层判断各自的论证>"}\n'
        "说明：部分信号（如 C4/C7/F1）已由规则引擎按定量规则先行判定，请复核其判定是否合理，"
        "不合理才改；只更新证据有实质变化的信号，无把握的不要改；不要输出 JSON 以外的任何文字。"
    ) % (theme["name"], thesis or "（未填写）", rules, statuses_hint, sig_text, data_text, pool_text)
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
    pool_review = (result.get("pool_review") or "").strip()
    pool_candidates = [str(c).strip() for c in (result.get("pool_candidates") or []) if str(c).strip()]
    narrative = (result.get("narrative") or "").strip()
    conclusion = (result.get("conclusion") or "").strip() or narrative.replace("\n", " ")[:120]
    action = (result.get("action") or "").strip()
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
            print("[%s] 跳过未知信号 %r" % (tid, code), flush=True)
            continue
        if st not in valid_status[code]:
            print("[%s] 跳过 %s 的非法状态 %r" % (tid, code, st), flush=True)
            continue
        plan.append((code, st, str(u.get("current_value", "")).strip(),
                     str(u.get("reason", "")).strip()))

    ts = now_str()
    run_date = datetime.now().strftime("%Y-%m-%d")
    full_narrative = narrative
    if action:
        full_narrative += "\n\n## 操作建议\n" + action
    if pool_review:
        full_narrative += "\n\n## 标的池复核\n" + pool_review
    if pool_candidates:
        full_narrative += "\n\n## 新标的候选\n" + "\n".join("- " + c for c in pool_candidates)
    if checklist:
        full_narrative += "\n\n## 人工核对清单\n" + "\n".join("- " + str(c) for c in checklist)
    old_overview = conn.execute("SELECT light FROM overview WHERE theme_id = ?", (tid,)).fetchone()
    changes = []
    if old_overview and old_overview["light"] and old_overview["light"] != light:
        changes.append("[%s] 信号灯：%s → %s（%s）" % (tid, old_overview["light"], light, conclusion))
    with conn:  # 单事务落库
        for code, st, val, reason in plan:
            old = old_map[code]
            if old["status"] != st:
                changes.append("[%s] %s %s：%s → %s（%s）" % (tid, code, old["name"], old["status"], st, reason))
            conn.execute(
                "UPDATE signals SET status = ?, current_value = ?, note = ?, updated_at = ?"
                " WHERE theme_id = ? AND id = ?",
                (st, val or old["current_value"], reason, ts, tid, code))
            conn.execute(
                "INSERT INTO signal_history (theme_id, signal_id, old_status, new_status, old_value, new_value, note, changed_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (tid, code, old["status"], st, old["current_value"], val or old["current_value"],
                 "AI季度分析: " + reason, ts))
        snap = {r["id"]: r["current_value"] for r in
                conn.execute("SELECT id, current_value FROM signals WHERE theme_id = ? ORDER BY rowid",
                             (tid,)).fetchall()}
        conn.execute(
            "INSERT INTO observations (theme_id, date, light, snapshot, note, created_at) VALUES (?,?,?,?,?,?)",
            (tid, run_date, light, json.dumps(snap, ensure_ascii=False), "季度自动分析（AI）", ts))
        conn.execute("UPDATE overview SET light = ?, conclusion = ?, action = ? WHERE theme_id = ?",
                     (light, conclusion, action, tid))
        conn.execute(
            "INSERT INTO ai_reports (theme_id, run_date, run_type, light, narrative, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (tid, run_date, "quarterly", light, full_narrative, ts))
    print("[%s] [%s] quarterly 完成: light=%s, 信号更新 %d 条, 核对清单 %d 项"
          % (ts, tid, light, len(plan), len(checklist)), flush=True)
    notify.notify_changes("观测台季度分析：%s" % theme["name"], changes)


def run_weekly(conn, conf):
    """全行业 ETF 周报：汇聚轮动规则数据，AI 写行业综述 + 建议组合点评。
    写入 ai_reports(theme_id='etf-universe', run_type='weekly')。"""
    from worker.rules import series, _ma
    tid = "etf-universe"
    theme = conn.execute("SELECT * FROM themes WHERE id = ?", (tid,)).fetchone()
    if theme is None:
        fail("weekly", "主题 etf-universe 不存在")
    latest_day = conn.execute("SELECT MAX(period_date) AS d FROM snapshots"
                              " WHERE metric_key LIKE 'px:%'").fetchone()["d"]
    # 动量排名（与规则引擎同口径）
    ranked = []
    for r in conn.execute("SELECT code, name FROM etf_universe WHERE active = 1").fetchall():
        pts = series(conn, "px:" + r["code"])
        if len(pts) < 21 or pts[-1][0] != latest_day:
            continue
        mom20 = pts[-1][1] / pts[-21][1] - 1
        ma200 = _ma(pts, 200)
        ranked.append((r["name"], r["code"], mom20, ma200 is not None and pts[-1][1] > ma200))
    ranked.sort(key=lambda x: -x[2])
    top10 = "\n".join("%s（%s）20日动量 %+.1f%%，%s200日线"
                      % (n, c, m * 100, "站上" if a else "跌破") for n, c, m, a in ranked[:10])
    bottom5 = "\n".join("%s（%s）20日动量 %+.1f%%" % (n, c, m * 100) for n, c, m, a in ranked[-5:])
    # 当前建议组合
    adv = conn.execute("SELECT * FROM advice ORDER BY id DESC LIMIT 1").fetchone()
    basket = json.loads(adv["basket_json"]) if adv else []
    basket_text = "、".join("%s（%s）" % (b["name"], b["code"]) for b in basket) or "空仓（无合格标的）"
    # 建议净值 vs 基准
    nav, bm = series(conn, "adv:nav"), series(conn, "bm:nav")
    nav_text = ""
    if nav and bm:
        nav_text = "建议组合净值 %.3f，同期沪深300ETF基准 %.3f（自 %s 起）" % (nav[-1][1], bm[-1][1], nav[0][0])
    # PE 极值
    extremes = []
    for r in conn.execute("SELECT DISTINCT index_code, index_name FROM etf_universe"
                          " WHERE active=1 AND index_code NOT IN ('', 'NONE')").fetchall():
        pts = series(conn, "pe_pct:" + r["index_code"])
        if pts and (pts[-1][1] < 10 or pts[-1][1] > 90):
            extremes.append("%s PE分位 %.0f%%" % (r["index_name"], pts[-1][1]))
    extremes_text = "；".join(extremes[:15]) or "无"
    rules = get_page(conn, tid, "rules")
    prompt = (
        "你是 ETF 投资分析助手。这是一个全行业 ETF 轮动监测系统（规则见下）。"
        "请基于最新数据写一份中文周报（Markdown，600 字内）：\n"
        "1) 行业/板块动量格局综述（谁在走强、谁在走弱）；\n"
        "2) 对当前建议组合的点评（动量与估值是否支持继续持有）；\n"
        "3) 估值极值与风险提示；\n"
        "4) 下周值得关注的方向（只列观察，不构成交易指令）。\n\n"
        "【轮动规则】\n%s\n\n【当前建议组合】%s\n%s\n\n"
        "【动量前 10（截至 %s）】\n%s\n\n【动量末 5】\n%s\n\n【PE 分位极值（5年）】%s\n"
    ) % (rules, basket_text, nav_text, latest_day, top10, bottom5, extremes_text)
    text = call_gateway(conf, conf.get("weekly_model") or conf["monthly_model"],
                        [{"role": "user", "content": prompt}],
                        max_tokens=conf.get("weekly_max_tokens", 4000)).strip()
    ts = now_str()
    with conn:
        conn.execute(
            "INSERT INTO ai_reports (theme_id, run_date, run_type, light, narrative, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (tid, datetime.now().strftime("%Y-%m-%d"), "weekly", "", text, ts))
    print("[%s] weekly 周报已写入（%d 字）" % (ts, len(text)), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_type", nargs="?", default="monthly",
                    choices=["monthly", "quarterly", "weekly"])
    ap.add_argument("--theme", help="只跑指定主题（默认全部启用主题；weekly 为全行业报告，忽略主题）")
    args = ap.parse_args()
    run_type = args.run_type
    try:
        with open(GATEWAY_CONF, encoding="utf-8") as f:
            conf = json.load(f)
    except Exception as ex:
        fail(run_type, "读取 gateway.json 失败: %s" % ex)
    db.init_db()
    conn = db.get_db()
    failures = 0
    try:
        if run_type == "weekly":
            try:
                run_weekly(conn, conf)
            except SystemExit:
                failures += 1
            except Exception as ex:
                traceback.print_exc()
                fail(run_type, "%s: %s" % (type(ex).__name__, ex))
        else:
            if args.theme:
                themes = conn.execute("SELECT * FROM themes WHERE id = ? AND enabled = 1",
                                      (args.theme,)).fetchall()
                if not themes:
                    fail(run_type, "主题不存在或未启用: %s" % args.theme)
            else:
                themes = conn.execute("SELECT * FROM themes WHERE enabled = 1"
                                      " AND id != 'etf-universe' ORDER BY rowid").fetchall()
            for theme in themes:
                try:
                    if run_type == "monthly":
                        run_monthly(conn, conf, theme)
                    else:
                        run_quarterly(conn, conf, theme)
                except SystemExit:
                    failures += 1  # fail() 已记日志，继续其余主题
                except Exception as ex:
                    traceback.print_exc()
                    with open(JOBS_LOG, "a", encoding="utf-8") as f:
                        f.write("[%s] [STATUS] %s FAILED [%s] %s: %s\n"
                                % (now_str(), run_type, theme["id"], type(ex).__name__, ex))
                    failures += 1
    finally:
        conn.close()
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
