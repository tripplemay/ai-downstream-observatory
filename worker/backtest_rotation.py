# -*- coding: utf-8 -*-
"""轮动策略在线回测：用 snapshots 里的宇宙历史行情，按当前策略参数全历史模拟，
写出 sim:nav（模拟净值）与 sim_bm:nav（基准）序列（全量重算、幂等覆盖）。

用途：策略仪表盘的对照曲线 + 失效监控的"回测预期"基准。周频由 run_job weekly 调用。
用法: python worker/backtest_rotation.py"""
import json
import os
import sys
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db  # noqa: E402
from worker.rules import get_strategy_params, upsert_nav, log  # noqa: E402


def main():
    db.init_db()
    conn = db.get_db()
    try:
        params = get_strategy_params(conn, "etf-universe")
        mom_n = int(params.get("mom_days", 20))
        ma_n = int(params.get("ma_days", 200))
        top_n = int(params.get("top_n", 3))
        benchmark = params.get("benchmark", "510300.SS")

        codes = [r["code"] for r in conn.execute(
            "SELECT code FROM etf_universe WHERE active = 1 ORDER BY code").fetchall()]
        # 加载序列：date -> {code: close}
        price_map = defaultdict(dict)
        for c in codes:
            for d, v in conn.execute(
                    "SELECT period_date, value FROM snapshots WHERE metric_key = ? ORDER BY period_date",
                    ("px:" + c,)).fetchall():
                if v:
                    price_map[c][d] = v
        # 公共交易日历（用基准的日期，全市场同历）
        bm_series = sorted(price_map.get(benchmark, {}).items())
        if len(bm_series) < 250:
            log("基准历史不足，跳过回测")
            return
        calendar = [d for d, _ in bm_series]

        # 月末调仓点：每月第一个交易日
        rebalance_days = []
        prev_month = None
        for d in calendar:
            if d[:7] != prev_month:
                rebalance_days.append(d)
                prev_month = d[:7]
        rebalance_set = set(rebalance_days)

        # 每个调仓日计算组合：动量 = close[d] / close[d-mom_n 个日历索引] - 1（用各代码自身可得日期）
        day_index = {d: i for i, d in enumerate(calendar)}

        def close_on(code, d):
            return price_map.get(code, {}).get(d)

        nav = 1.0
        sim_points = []
        cur = []  # [(code, weight)]
        for i, d in enumerate(calendar):
            if i == 0:
                sim_points.append((d, 1.0))
                continue
            if d in rebalance_set and i > ma_n:
                # 排名
                cands = []
                for c in codes:
                    hist = price_map.get(c)
                    if not hist or d not in hist:
                        continue
                    base_idx = i - mom_n
                    d0 = calendar[base_idx]
                    if d0 not in hist:
                        continue
                    ma_window = [hist.get(calendar[j]) for j in range(i - ma_n, i)]
                    ma_window = [v for v in ma_window if v]
                    if len(ma_window) < ma_n * 0.8:
                        continue
                    ma = sum(ma_window) / len(ma_window)
                    cands.append((hist[d] / hist[d0] - 1, c, hist[d] > ma))
                cands.sort(key=lambda x: -x[0])
                cur = [(c, 1.0 / top_n) for _, c, above in cands if above][:top_n]
            # 当日收益
            prev_d = calendar[i - 1]
            ret = 0.0
            for c, w in cur:
                p0, p1 = close_on(c, prev_d), close_on(c, d)
                if p0 and p1:
                    ret += w * (p1 / p0 - 1)
            nav *= (1 + ret)
            sim_points.append((d, nav))

        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with conn:
            conn.execute("DELETE FROM snapshots WHERE metric_key IN ('sim:nav', 'sim_bm:nav')")
            for d, v in sim_points:
                upsert_nav(conn, "sim:nav", d, v, ts)
            bnav = 1.0
            bm_points = []
            for i, (d, v) in enumerate(bm_series):
                if i == 0:
                    bm_points.append((d, 1.0))
                    continue
                prev_v = bm_series[i - 1][1]
                if prev_v:
                    bnav *= v / prev_v
                bm_points.append((d, bnav))
            for d, v in bm_points:
                upsert_nav(conn, "sim_bm:nav", d, v, ts)
        total_ret = sim_points[-1][1] - 1
        bm_ret = bm_points[-1][1] - 1
        years = len(sim_points) / 244
        cagr = sim_points[-1][1] ** (1 / years) - 1 if years > 0 else 0
        log("在线回测完成：%s → %s，模拟累计 %+0.1f%%（CAGR %+0.1f%%），基准 %+0.1f%%，参数 mom%d/ma%d/top%d"
            % (sim_points[0][0], sim_points[-1][0], total_ret * 100, cagr * 100, bm_ret * 100,
               mom_n, ma_n, top_n))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
