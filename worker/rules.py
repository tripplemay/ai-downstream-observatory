# -*- coding: utf-8 -*-
"""规则引擎：对可机械计算的信号做确定性判定，每次采集后运行。

原则：
- 只动有明确定量规则的信号（按主题注册）；定性信号仍由 AI 季度核对或人工维护；
- 状态不变时只静默刷新 current_value/updated_at，状态变化才写 signal_history；
- 规则输出的是"建议判定"，依据写在 note 里，人工可随时在 Web 端改判（留痕）。

用法: python worker/rules.py [--theme <slug>]，退出码恒为 0（数据库错误除外）。"""
import argparse
import json
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

    # ---- C5/F2 推理成本（模型 API 牌价）----
    eval_model_prices(conn, theme_id)

    # ---- C1/C2/C3/C8/C10/F4 基本面定量信号 ----
    eval_fundamentals(conn, theme_id)

    # ---- 标的池体检（溢价/规模）----
    eval_pool_health(conn, theme_id)


def margin_series(conn, gross_key, rev_key):
    """毛利率序列：[(period_date, 毛利率%)]，按同一 period_date 配对。"""
    gross = dict(series(conn, gross_key))
    rev = dict(series(conn, rev_key))
    pts = []
    for d in sorted(set(gross) & set(rev)):
        if rev[d]:
            pts.append((d, gross[d] / rev[d] * 100))
    return pts


def median_val(xs):
    s = sorted(xs)
    n = len(s)
    if n == 0:
        return None
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def eval_fundamentals(conn, theme_id):
    """C1/C2/C3/C8/C10/F4：基本面定量信号（月频数据，每月采集后评估）。"""

    # ---- C1 存储合约价（代理：美光/三星/海力士综合毛利率环比趋势）----
    # 合约价本身无免费源；上游毛利率连续 2 个季度环比下滑视为趋同开始（代理）
    proxies = [("美光", margin_series(conn, "edgar:MU:gross_profit", "edgar:MU:revenue")),
               ("三星", margin_series(conn, "yf:005930.KS:gross_profit", "yf:005930.KS:revenue")),
               ("海力士", margin_series(conn, "yf:000660.KS:gross_profit", "yf:000660.KS:revenue"))]
    c1_details, c1_votes = [], []
    for name, pts in proxies:
        if len(pts) < 3:
            c1_details.append("%s 数据不足" % name)
            continue
        d1 = pts[-1][1] - pts[-2][1]  # 最近季环比 pp
        d2 = pts[-2][1] - pts[-3][1]  # 前一季环比 pp
        c1_details.append("%s %.1f%%（环比 %+.1f/%+.1fpp）" % (name, pts[-1][1], d1, d2))
        c1_votes.append(1 if (d1 < 0 and d2 < 0) else (-1 if (d1 > 0 and d2 > 0) else 0))
    if c1_votes:
        mu_vote = c1_votes[0]  # 以美光（纯存储）为准，韩系为综合毛利率仅参考
        status = "已验证" if mu_vote == 1 else ("反向" if mu_vote == -1 else "验证中")
        apply(conn, theme_id, "C1", status, "；".join(c1_details),
              "代理规则：美光毛利率连续2季环比%s" % {1: "下滑→趋同开始", -1: "上升→上行延续"}.get(mu_vote, "方向不一"))

    # ---- C2 算力供需：NVDA 毛利率环比明显下滑 → 松动确认 ----
    nvda_margin = margin_series(conn, "edgar:NVDA:gross_profit", "edgar:NVDA:revenue")
    if len(nvda_margin) >= 2:
        d = nvda_margin[-1][1] - nvda_margin[-2][1]
        dc = series(conn, "seg:NVDA:datacenter_revenue")
        dc_text = ""
        if len(dc) >= 1:
            dc_yoy = yoy(dc)
            dc_text = "；数据中心收入 %s" % ("同比 %+.1f%%" % dc_yoy if dc_yoy is not None else "%.0fM" % dc[-1][1])
        status = "已验证" if d <= -3 else ("反向" if d >= 1 else "验证中")
        apply(conn, theme_id, "C2", status,
              "NVDA 毛利率 %.1f%%（环比 %+.1fpp）%s" % (nvda_margin[-1][1], d, dc_text),
              "环比 %+.1fpp：%s" % (d, {1: "明显下滑→供需松动", -1: "回升→供需偏紧"}.get(
                  1 if d <= -3 else (-1 if d >= 1 else 0), "窄幅波动")))

    # ---- C3 上游 Capex：capex 同比 >50% 视为大幅上修 ----
    c3 = [("美光", "edgar:MU:capex"), ("三星", "yf:005930.KS:capex"), ("海力士", "yf:000660.KS:capex")]
    c3_details, hikes = [], 0
    for name, key in c3:
        c = yoy(series(conn, key))
        if c is None:
            c3_details.append("%s 数据不足" % name)
            continue
        hikes += 1 if c > 50 else 0
        c3_details.append("%s capex 同比 %+d%%" % (name, round(c)))
    computable3 = sum(1 for x in c3_details if "数据不足" not in x)
    if computable3:
        status = "已验证" if hikes >= 2 else ("验证中" if hikes == 1 else "未验证")
        apply(conn, theme_id, "C3", status, "；".join(c3_details),
              "%d/%d 家 capex 同比超 50%%（大幅上修）" % (hikes, computable3))

    # ---- C8 平台 vs 应用增速差：平台营收同比中位数 ≥ 应用侧 → 已验证 ----
    platforms = [("Meta", "edgar:META:revenue"), ("谷歌", "edgar:GOOGL:revenue"), ("腾讯", "yf:0700.HK:revenue")]
    apps = [("Palantir", "edgar:PLTR:revenue"), ("Salesforce", "edgar:CRM:revenue")]
    p_yoys = [yoy(series(conn, k)) for _, k in platforms]
    a_yoys = [yoy(series(conn, k)) for _, k in apps]
    p_yoys = [c for c in p_yoys if c is not None]
    a_yoys = [c for c in a_yoys if c is not None]
    if p_yoys and a_yoys:
        pm, am = median_val(p_yoys), median_val(a_yoys)
        status = "已验证" if pm >= am else ("验证中" if am - pm <= 5 else "反向")
        apply(conn, theme_id, "C8", status,
              "平台中位 %+.1f%%（%s）vs 应用中位 %+.1f%%（%s）"
              % (pm, "/".join("%+d%%" % round(c) for c in p_yoys), am,
                 "/".join("%+d%%" % round(c) for c in a_yoys)),
              "平台-应用增速差 %+.1fpp" % (pm - am))

    # ---- C10 应用层毛利率：PLTR/CRM 毛利率同比被压缩 → 归属逻辑成立 ----
    c10 = [("PLTR", margin_series(conn, "edgar:PLTR:gross_profit", "edgar:PLTR:revenue")),
           ("CRM", margin_series(conn, "edgar:CRM:gross_profit", "edgar:CRM:revenue"))]
    c10_details, compressed = [], 0
    for name, pts in c10:
        if len(pts) < 5:
            c10_details.append("%s 数据不足" % name)
            continue
        delta = pts[-1][1] - pts[-5][1]  # 同比 pp
        compressed += 1 if delta < -1 else 0  # 压缩阈值 1pp，排除走平噪声
        c10_details.append("%s 毛利率 %.1f%%（同比 %+.1fpp）" % (name, pts[-1][1], delta))
    computable10 = sum(1 for x in c10_details if "数据不足" not in x)
    if computable10:
        status = "已验证" if compressed == computable10 else ("验证中" if compressed else "反向")
        apply(conn, theme_id, "C10", status, "；".join(c10_details),
              "%d/%d 家毛利率同比压缩" % (compressed, computable10))

    # ---- F4 上游紧张超预期：C1-C3 全反向且 C1 反向持续 ≥12 个月 → 已触发 ----
    st = {sid: current_status(conn, theme_id, sid) for sid in ("C1", "C2", "C3")}
    if all(s == "反向" for s in st.values()):
        row = conn.execute(
            "SELECT changed_at FROM signal_history WHERE theme_id = ? AND signal_id = 'C1'"
            " AND new_status = '反向' ORDER BY id DESC LIMIT 1", (theme_id,)).fetchone()
        if row:
            anchor = row["changed_at"][:10]
        else:  # 无变更记录：自基线（最早观测）起就处于反向
            obs = conn.execute("SELECT MIN(date) AS d FROM observations WHERE theme_id = ?",
                               (theme_id,)).fetchone()
            anchor = obs["d"] if obs and obs["d"] else None
        months = 0
        if anchor:
            try:
                months = (datetime.now() - datetime.strptime(anchor, "%Y-%m-%d")).days // 30
            except ValueError:
                pass
        apply(conn, theme_id, "F4", "已触发" if months >= 12 else "未触发",
              "C1-C3 全反向，C1 反向已持续约 %d 个月" % months,
              "全反向且持续 %d 个月（阈值 12）" % months)
    else:
        apply(conn, theme_id, "F4", "未触发",
              "C1=%s C2=%s C3=%s" % (st["C1"], st["C2"], st["C3"]), "C1-C3 未全部反向")


def eval_pool_health(conn, theme_id):
    """标的池体检：QDII 溢价（价格 vs 净值，估算口径）+ 基金规模。
    结果写入 pool.health（正常/预警：…），状态翻转时告警。阈值在主题文件 POOL_HEALTH。"""
    from worker.themes.ai_downstream import POOL_HEALTH
    for code, checks in POOL_HEALTH.items():
        problems = []
        if "premium" in checks:
            suffix = ".SZ" if code.startswith("15") else ".SS"
            px, nav = series(conn, "px:%s%s" % (code, suffix)), series(conn, "nav:%s" % code)
            if px and nav and nav[-1][1]:
                premium = (px[-1][1] / nav[-1][1] - 1) * 100
                if premium > checks["premium"]:
                    problems.append("溢价 +%.1f%%（估算，净值滞后）" % premium)
        if "scale" in checks:
            s = series(conn, "scale:%s" % code)
            if s and s[-1][1] < checks["scale"]:
                problems.append("规模 %.1f 亿（低于 %.0f 亿）" % (s[-1][1], checks["scale"]))
        if "purity_floor" in checks:
            s = series(conn, "purity:%s" % code)
            if s and s[-1][1] < checks["purity_floor"]:
                problems.append("thesis纯度 %.1f%%（锚定 %.0f%%，%s）"
                                % (s[-1][1], checks["purity_floor"], s[-1][0]))
        health = "正常" if not problems else "预警：" + "、".join(problems)
        row = conn.execute(
            "SELECT id, name, health FROM pool WHERE theme_id = ? AND code LIKE ?",
            (theme_id, code + "%")).fetchone()
        if row is None:
            continue
        if (row["health"] or "正常") != health:
            conn.execute("UPDATE pool SET health = ? WHERE id = ?", (health, row["id"]))
            direction = "出现预警" if health != "正常" else "恢复正常"
            CHANGES.append("[%s] 标的 %s（%s）%s：%s" % (theme_id, row["name"], code, direction, health))
            log("[%s] 标的 %s %s → %s" % (theme_id, code, row["health"] or "正常", health))


def _ma(pts, n):
    if len(pts) < n:
        return None
    return sum(v for _, v in pts[-n:]) / n


def get_strategy_params(conn, theme_id):
    """策略参数：取最新版本；无记录则用主题文件默认值。"""
    row = conn.execute("SELECT params_json FROM strategy_params WHERE theme_id = ?"
                       " ORDER BY id DESC LIMIT 1", (theme_id,)).fetchone()
    if row:
        try:
            return json.loads(row["params_json"])
        except json.JSONDecodeError:
            pass
    from worker.themes.etf_universe import THEME
    return dict(THEME["strategy_params"])


def eval_universe(conn):
    """全行业 ETF 轮动（策略型主题）：参数化 MOM + MA 过滤，月末调仓；建议留痕 + 净值跟踪；
    市场宽度（mkt:width）每日落库；策略失效预警复用信号灯（overview.light）。"""
    params = get_strategy_params(conn, "etf-universe")
    mom_n = int(params.get("mom_days", 20))
    ma_n = int(params.get("ma_days", 200))
    top_n = int(params.get("top_n", 3))
    benchmark = params.get("benchmark", "510300.SS")
    decay_warn = float(params.get("decay_warn", -5.0))
    decay_fail = float(params.get("decay_fail", -10.0))

    codes = conn.execute("SELECT code, name FROM etf_universe WHERE active = 1").fetchall()
    latest_day = conn.execute("SELECT MAX(period_date) AS d FROM snapshots WHERE metric_key LIKE 'px:%'"
                              ).fetchone()["d"]
    if not latest_day:
        return
    ranked = []
    px_cache = {}
    for r in codes:
        pts = series(conn, "px:" + r["code"])
        if len(pts) < mom_n + 1 or pts[-1][0] != latest_day:
            continue  # 停牌/无当日数据的跳过
        px_cache[r["code"]] = pts
        mom = pts[-1][1] / pts[-1 - mom_n][1] - 1
        ma = _ma(pts, ma_n)
        ranked.append({"code": r["code"], "name": r["name"], "mom20": mom,
                       "above": ma is not None and pts[-1][1] > ma})
    if not ranked:
        return
    ranked.sort(key=lambda x: -x["mom20"])
    basket = [x for x in ranked if x["above"]][:top_n]
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # ---- 市场宽度（regime 温度计）：站上 MA 的比例 ----
    with_ma = [x for x in ranked if _ma(px_cache[x["code"]], ma_n) is not None]
    if with_ma:
        width = sum(1 for x in with_ma if x["above"]) / len(with_ma) * 100
        upsert_nav(conn, "mkt:width", latest_day, round(width, 1), ts)

    # ---- 建议留痕：月初首个评估日对比当前持仓 ----
    last_adv = conn.execute("SELECT * FROM advice ORDER BY id DESC LIMIT 1").fetchone()
    cur_basket = json.loads(last_adv["basket_json"]) if last_adv else []
    cur_codes = [b["code"] for b in cur_basket]
    new_codes = [b["code"] for b in basket]
    month_changed = (not last_adv) or last_adv["date"][:7] != latest_day[:7]
    if not last_adv:
        reason = "初始化建仓信号"
        changed = True
    elif month_changed and new_codes != cur_codes:
        reason = "月末调仓：%d日动量前%d且站上%d日线" % (mom_n, top_n, ma_n)
        changed = True
    else:
        changed = False
    if changed:
        w = 1.0 / top_n
        new_basket_json = json.dumps(
            [{"code": b["code"], "name": b["name"], "weight": w} for b in basket],
            ensure_ascii=False)
        detail = "；".join("%s 动量%+.1f%%" % (b["name"], b["mom20"] * 100) for b in basket) or "无合格标的，全部持币"
        conn.execute("INSERT INTO advice (date, basket_json, reason, created_at) VALUES (?,?,?,?)",
                     (latest_day, new_basket_json, "%s（%s）" % (reason, detail), ts))
        CHANGES.append("[etf-universe] 轮动建议变更：%s → %s（%s）"
                       % ("、".join(cur_codes) or "空仓", "、".join(new_codes) or "空仓", reason))
        cur_basket = json.loads(new_basket_json)
        log("[etf-universe] 建议变更：%s" % detail)
    elif month_changed:
        log("[etf-universe] 月初评估：组合维持 %s" % ("、".join(cur_codes) or "空仓"))

    # ---- 月中破位预警 ----
    for b in cur_basket:
        pts = px_cache.get(b["code"]) or series(conn, "px:" + b["code"])
        ma = _ma(pts, ma_n)
        if ma is not None and pts and pts[-1][1] < ma:
            CHANGES.append("[etf-universe] 破位预警：%s（%s）收于 %d 日线下方（月中不换仓，月末处理）"
                           % (b["name"], b["code"], ma_n))

    # ---- 建议净值 / 基准净值 续算 ----
    def nav_step(metric_key, daily_ret):
        pts = series(conn, metric_key)
        if pts and pts[-1][0] >= latest_day:
            return  # 今日已算
        prev = pts[-1][1] if pts else 1.0
        upsert_nav(conn, metric_key, latest_day, prev * (1 + daily_ret), ts)

    if cur_basket:
        rets = []
        for b in cur_basket:
            pts = px_cache.get(b["code"]) or series(conn, "px:" + b["code"])
            if len(pts) >= 2 and pts[-1][0] == latest_day and pts[-2][1]:
                rets.append(pts[-1][1] / pts[-2][1] - 1)
        daily_ret = sum(rets) / top_n if rets else 0.0  # 每只占 1/top_n，空缺为现金
        nav_step("adv:nav", daily_ret)
    bm = px_cache.get(benchmark) or series(conn, "px:" + benchmark)
    if len(bm) >= 2 and bm[-2][1]:
        nav_step("bm:nav", bm[-1][1] / bm[-2][1] - 1)

    # ---- 策略失效预警（信号灯复用）：滚动约 6 个月（120 交易日）超额收益 ----
    adv_pts, bm_pts = series(conn, "adv:nav"), series(conn, "bm:nav")
    if len(adv_pts) >= 60 and len(bm_pts) >= 60:
        n = min(120, len(adv_pts) - 1, len(bm_pts) - 1)
        excess = (adv_pts[-1][1] / adv_pts[-1 - n][1] - 1) - (bm_pts[-1][1] / bm_pts[-1 - n][1] - 1)
        excess_pct = excess * 100
        light = "red" if excess_pct < decay_fail else ("yellow" if excess_pct < decay_warn else "green")
        conclusion = ("近 %d 个交易日建议组合相对基准超额 %+.1f%%。" % (n, excess_pct))
        if light == "red":
            conclusion += "策略失效预警：超额低于 %.0f%% 阈值，应停用或复审参数。" % decay_fail
        elif light == "yellow":
            conclusion += "超额走弱（预警线 %.0f%%），持续观察。" % decay_warn
        else:
            conclusion += "策略运行正常。"
        old = conn.execute("SELECT light, conclusion FROM overview WHERE theme_id = 'etf-universe'").fetchone()
        conn.execute("UPDATE overview SET light = ?, conclusion = ? WHERE theme_id = 'etf-universe'",
                     (light, conclusion))
        if old and old["light"] and old["light"] != light:
            CHANGES.append("[etf-universe] 策略状态灯：%s → %s（%s）" % (old["light"], light, conclusion))
    else:
        # 实盘数据不足 60 个交易日：失效监控未启用，黄灯中性占位（避免种子红灯误导）
        conn.execute("UPDATE overview SET light = 'yellow', conclusion = ? WHERE theme_id = 'etf-universe'",
                     ("实盘建议净值数据积累中（失效监控需 60 个交易日）；回测模拟净值见下方对照曲线。",))

    # ---- 指数 PE 5 年分位 ----
    for r in conn.execute(
            "SELECT DISTINCT index_code FROM etf_universe WHERE active = 1"
            " AND index_code != '' AND index_code != 'NONE'").fetchall():
        pts = series(conn, "pe:" + r["index_code"])
        if len(pts) < 250:
            continue
        window = [v for _, v in pts[-1250:]]  # 约 5 年
        cur = pts[-1][1]
        pct = sum(1 for v in window if v <= cur) / len(window) * 100
        upsert_nav(conn, "pe_pct:%s" % r["index_code"], pts[-1][0], round(pct, 1), ts)


def upsert_nav(conn, metric_key, date, value, ts):
    conn.execute(
        "INSERT INTO snapshots (metric_key, label, period_date, value, unit, source, fetched_at)"
        " VALUES (?,?,?,?,?,?,?)"
        " ON CONFLICT(metric_key, period_date) DO UPDATE SET value = excluded.value,"
        " fetched_at = excluded.fetched_at",
        (metric_key, metric_key, date, round(value, 4), "", "规则引擎", ts))


def chg_since(pts, days):
    """最新值 vs 约 days 天前最近点的变化率 %（基准点容差 ±max(10, days*20%) 天），无则 None。"""
    if len(pts) < 2:
        return None
    try:
        end_date = datetime.strptime(pts[-1][0], "%Y-%m-%d")
    except ValueError:
        return None
    target = end_date - timedelta(days=days)
    tolerance = max(10, int(days * 0.2))
    best, best_dist = None, tolerance + 1
    for d_s, v in pts[:-1]:
        try:
            d = datetime.strptime(d_s, "%Y-%m-%d")
        except ValueError:
            continue
        dist = abs((d - target).days)
        if dist < best_dist and v:
            best, best_dist = v, dist
    if best is None or not pts[-1][1]:
        return None
    return (pts[-1][1] - best) / best * 100


def current_status(conn, theme_id, signal_id):
    row = conn.execute("SELECT status FROM signals WHERE theme_id = ? AND id = ?",
                       (theme_id, signal_id)).fetchone()
    return row["status"] if row else ""


def eval_model_prices(conn, theme_id):
    """C5 推理成本 / F2 推理成本停滞：基于 OpenRouter 牌价序列（price: 类指标）。

    C5：近 180 天有任一监控模型降价 ≥10% → 验证中；365 天无任何降价 → 反向；
        介于两者之间或数据不足 → 维持原状态（价格规则只管"盯"，拐点判断留给 AI）。
    F2（保守触发）：有充分历史的模型近 180 天全部零变化（|涨跌|<2%）→ 已触发；
        或中国阵营旗舰+走量中位价近 90 天上涨 >10%（集体提价预警）→ 已触发。"""
    rows = conn.execute(
        "SELECT m.metric_key, m.label, m.params FROM metrics m"
        " JOIN theme_metrics tm ON tm.metric_key = m.metric_key AND tm.theme_id = ?"
        " WHERE m.kind = 'model_price'", (theme_id,)).fetchall()
    models, ratios = [], {}
    import json as _json
    for r in rows:
        p = _json.loads(r["params"])
        pts = series(conn, r["metric_key"])
        if p.get("ratio"):
            if pts:
                ratios[p["tier"]] = pts[-1][1]
        elif pts:
            models.append({"label": r["label"].replace(" API混合价(3:1)", ""),
                           "tier": p["tier"], "camp": p["camp"], "pts": pts})
    if not models:
        return
    latest = {m["label"]: m["pts"][-1][1] for m in models}
    ratio_text = "；".join("%s背离 %.1f×" % ({"flagship": "旗舰", "volume": "走量", "reasoning": "推理"}.get(t, t), v)
                          for t, v in ratios.items())
    price_text = "；".join("%s $%.2f" % kv for kv in sorted(latest.items()))

    # ---- C5 ----
    declines_180 = [m["label"] for m in models
                    if (c := chg_since(m["pts"], 180)) is not None and c <= -10]
    chgs_365 = [chg_since(m["pts"], 365) for m in models]
    have_365 = [c for c in chgs_365 if c is not None]
    if declines_180:
        apply(conn, theme_id, "C5", "验证中",
              "%s｜%s" % (price_text, ratio_text),
              "近180天 %d 个模型降价≥10%%：%s" % (len(declines_180), "、".join(declines_180)))
    elif have_365 and all(c > -10 for c in have_365):
        apply(conn, theme_id, "C5", "反向",
              "%s｜%s" % (price_text, ratio_text),
              "近365天无任何监控模型降价≥10%，下降曲线停止")
    else:
        apply(conn, theme_id, "C5", current_status(conn, theme_id, "C5"),
              "%s｜%s" % (price_text, ratio_text), "")

    # ---- F2 ----
    chgs_180 = [(m["label"], chg_since(m["pts"], 180)) for m in models]
    have_180 = [(lb, c) for lb, c in chgs_180 if c is not None]
    cn_core = [m for m in models if m["camp"] == "cn" and m["tier"] in ("flagship", "volume")]
    cn_chg90 = [c for c in (chg_since(m["pts"], 90) for m in cn_core) if c is not None]
    cn_median_up = (len(cn_chg90) >= 2 and sorted(cn_chg90)[len(cn_chg90) // 2] > 10)
    if len(have_180) >= 3 and all(abs(c) < 2 for _, c in have_180):
        apply(conn, theme_id, "F2", "已触发", price_text,
              "%d 个有历史的模型近180天价格全部零变化" % len(have_180))
    elif cn_median_up:
        apply(conn, theme_id, "F2", "已触发", price_text,
              "中国阵营旗舰+走量中位价近90天上涨超10%（集体提价预警）")
    else:
        apply(conn, theme_id, "F2", "未触发", price_text, "")


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
        try:
            with conn:
                eval_universe(conn)
        except Exception as ex:
            log("[etf-universe] 轮动评估失败(跳过): %s: %s" % (type(ex).__name__, ex))
        notify.notify_changes("观测台信号状态变化（规则引擎）", CHANGES)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
