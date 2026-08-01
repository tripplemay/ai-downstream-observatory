# -*- coding: utf-8 -*-
"""规则引擎：对可机械计算的信号做确定性判定，每次采集后运行。

原则：
- 只动有明确定量规则的信号（按主题注册）；定性信号仍由 AI 季度核对或人工维护；
- 状态不变时只静默刷新 current_value/updated_at，状态变化才写 signal_history；
- 规则输出的是"建议判定"，依据写在 note 里，人工可随时在 Web 端改判（留痕）。

用法: python worker/rules.py [--theme <slug>]，退出码恒为 0（数据库错误除外）。"""
import argparse
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db  # noqa: E402
from worker import notify  # noqa: E402

# 一次运行内的状态变化事件（汇总发一封告警邮件）
CHANGES = []


def log(msg):
    print("[%s] %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg), flush=True)


def series(conn, metric_key):
    """snapshots 序列：[(period_date, value)] 按日期升序。"""
    return [(r["period_date"], r["value"]) for r in conn.execute(
        "SELECT period_date, value FROM snapshots WHERE metric_key = ? AND value IS NOT NULL"
        " ORDER BY period_date", (metric_key,)).fetchall()]


def window_chg(pts):
    """价格类窗口涨跌幅 %：首→末（px 类数据本身就是近 3 个月窗口）。"""
    if len(pts) < 2 or not pts[0][1]:
        return None
    return (pts[-1][1] - pts[0][1]) / pts[0][1] * 100


def yoy(pts, offset=0):
    """季度序列同比 %：倒数第 1+offset 个点 vs 约一年前最近的点（±60 天内），无则 None。"""
    if len(pts) < 2:
        return None
    end_date_s, end_val = pts[-1 - offset] if len(pts) > offset else (None, None)
    if end_date_s is None or not end_val:
        return None
    try:
        end_date = datetime.strptime(end_date_s, "%Y-%m-%d")
    except ValueError:
        return None
    target = end_date - timedelta(days=365)
    best, best_dist = None, 61
    for d_s, v in pts:
        try:
            d = datetime.strptime(d_s, "%Y-%m-%d")
        except ValueError:
            continue
        dist = abs((d - target).days)
        if dist < best_dist and v:
            best, best_dist = v, dist
    if best is None:
        return None
    return (end_val - best) / best * 100


def apply(conn, theme_id, signal_id, new_status, new_value, reason):
    """状态不变只刷新当前值；变化则更新 + 写 signal_history。"""
    row = conn.execute("SELECT * FROM signals WHERE theme_id = ? AND id = ?",
                       (theme_id, signal_id)).fetchone()
    if row is None:
        log("[%s] 信号 %s 不存在，跳过" % (theme_id, signal_id))
        return
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if row["status"] == new_status:
        conn.execute("UPDATE signals SET current_value = ?, updated_at = ? WHERE theme_id = ? AND id = ?",
                     (new_value, ts, theme_id, signal_id))
        log("[%s] %s 状态维持 %s（当前值已刷新）" % (theme_id, signal_id, new_status))
        return
    conn.execute("UPDATE signals SET status = ?, current_value = ?, note = ?, updated_at = ?"
                 " WHERE theme_id = ? AND id = ?",
                 (new_status, new_value, reason, ts, theme_id, signal_id))
    conn.execute(
        "INSERT INTO signal_history (theme_id, signal_id, old_status, new_status, old_value, new_value, note, changed_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (theme_id, signal_id, row["status"], new_status, row["current_value"], new_value,
         "规则引擎: " + reason, ts))
    CHANGES.append("[%s] %s %s：%s → %s（%s）"
                   % (theme_id, signal_id, row["name"], row["status"], new_status, new_value))
    log("[%s] %s 状态变更: %s → %s" % (theme_id, signal_id, row["status"], new_status))


CLOUD_TICKERS = ["MSFT", "GOOGL", "AMZN"]  # BABA 无 10-Q 分部数据，阿里云增速留 AI 季度核对


def eval_ai_downstream(conn, theme_id):
    """AI 下游主题的可量化信号规则。"""
    # ---- C7 下游指数相对强弱：两个下游指数近 3 个月均跑赢对应上游 → 已验证 ----
    pairs = [("px:159852.SZ", "px:159509.SZ", "软件ETF", "纳指科技ETF"),
             ("px:513050.SS", "px:^SOX", "中概互联ETF", "费城半导体")]
    chgs = []
    for down_key, up_key, dname, uname in pairs:
        d, u = window_chg(series(conn, down_key)), window_chg(series(conn, up_key))
        if d is None or u is None:
            chgs = []
            break
        chgs.append((dname, d, uname, u))
    if chgs:
        wins = sum(1 for _, d, _, u in chgs if d > u)
        status = "已验证" if wins == 2 else ("反向" if wins == 0 else "验证中")
        value = "；".join("%s %+.1f%% vs %s %+.1f%%" % c for c in chgs)
        apply(conn, theme_id, "C7", status, value,
              "近3个月相对强弱：%d/2 下游跑赢" % wins)

    # ---- C4 云厂商剪刀差：云分部收入同比 vs capex 同比，≥2 家反超 → 已验证 ----
    details, reversed_cnt, computable = [], 0, 0
    for t in CLOUD_TICKERS:
        rev_yoy = yoy(series(conn, "seg:%s:cloud_revenue" % t))
        cap_yoy = yoy(series(conn, "edgar:%s:capex" % t))
        if rev_yoy is None or cap_yoy is None:
            details.append("%s 数据不足" % t)
            continue
        computable += 1
        reversed_cnt += 1 if rev_yoy > cap_yoy else 0
        details.append("%s 云收入 %+.1f%% vs capex %+.1f%%" % (t, rev_yoy, cap_yoy))
    if computable:
        status = "已验证" if reversed_cnt >= 2 else ("未验证" if reversed_cnt == 0 else "验证中")
        apply(conn, theme_id, "C4", status, "；".join(details),
              "同比口径，%d/%d 家收入增速反超 capex 增速" % (reversed_cnt, computable))

    # ---- F1 Capex 压制收入：连续 4 个季度 capex 同比 > 收入同比且缺口无收敛 → 已触发 ----
    details, triggered = [], True
    computable = 0
    for t in CLOUD_TICKERS:
        caps, revs = series(conn, "edgar:%s:capex" % t), series(conn, "edgar:%s:revenue" % t)
        gaps = []
        for k in range(4):
            c, r = yoy(caps, offset=k), yoy(revs, offset=k)
            if c is None or r is None:
                gaps = []
                break
            gaps.append(c - r)
        if not gaps:
            details.append("%s 数据不足" % t)
            continue
        computable += 1
        # gaps[0] 最近季；要求 4 季全为正（capex 跑赢收入）且最近缺口 >= 前一季（无收敛）
        if not (all(g > 0 for g in gaps) and gaps[0] >= gaps[1]):
            triggered = False
        details.append("%s 近4季缺口 %s" % (t, "/".join("%+.1f" % g for g in gaps)))
    if computable == len(CLOUD_TICKERS):
        apply(conn, theme_id, "F1", "已触发" if triggered else "未触发", "；".join(details),
              "capex同比-收入同比 连续4季为正且未收敛" if triggered else "未满足连续4季压制或无收敛")


RULES = {
    "ai-downstream": eval_ai_downstream,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--theme", help="只评估指定主题（默认全部有规则注册的启用主题）")
    args = ap.parse_args()
    db.init_db()
    conn = db.get_db()
    try:
        themes = conn.execute("SELECT id FROM themes WHERE enabled = 1").fetchall()
        for t in themes:
            tid = t["id"]
            if args.theme and tid != args.theme:
                continue
            fn = RULES.get(tid)
            if fn is None:
                continue
            try:
                with conn:
                    fn(conn, tid)
            except Exception as ex:
                log("[%s] 规则评估失败(跳过): %s: %s" % (tid, type(ex).__name__, ex))
        log("规则引擎完成")
        notify.notify_changes("观测台信号状态变化（规则引擎）", CHANGES)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
