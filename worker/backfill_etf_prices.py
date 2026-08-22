# -*- coding: utf-8 -*-
"""宇宙历史价格一次性回填：东财 kline 接口（前复权日线，单请求全历史），
写入 snapshots 的 px:{code}（先清后写，覆盖旧来源数据，保证复权口径一致）。
幂等可重跑；带重试退避。
用法: python worker/backfill_etf_prices.py [--limit N] [--sleep 0.3] [--codes a.SS,b.SZ]"""
import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db  # noqa: E402
from worker.fetch_data import upsert, log  # noqa: E402

UA = "Mozilla/5.0"


def fetch_kline(code):
    """腾讯 ifzq 日 k（前复权）：code 形如 512800.SS / 159995.SZ。返回 [(date, close)]，升序。
    单页最多 800 根，向前翻页直到 2020 年或取尽。"""
    symbol = ("sh" if code.endswith(".SS") else "sz") + code.split(".")[0]
    out = []
    end = "2050-01-01"
    for _ in range(3):  # 3 页 × 800 ≈ 2400 个交易日 ≈ 9.8 年
        url = ("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
               "?param=%s,day,2020-01-01,%s,800,qfq" % (symbol, end))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            data = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8"))
            d = (data.get("data") or {}).get(symbol) or {}
            rows = d.get("qfqday") or d.get("day") or []
        except Exception:
            rows = []
        if not rows:
            break
        page = [(r[0], float(r[2])) for r in rows if len(r) >= 3 and r[2] not in ("", "-")]
        out = page + out
        if len(rows) < 800:
            break
        end = rows[0][0]  # 向更早翻页
    return out or None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--sleep", type=float, default=0.3)
    ap.add_argument("--codes", help="只回填指定代码（逗号分隔，如 510300.SS,512880.SS）")
    args = ap.parse_args()
    db.init_db()
    conn = db.get_db()
    try:
        if args.codes:
            todo = args.codes.split(",")
        else:
            codes = [r["code"] for r in conn.execute(
                "SELECT code FROM etf_universe WHERE active = 1 ORDER BY code").fetchall()]
            todo = []
            for c in codes:
                n = conn.execute("SELECT COUNT(*) AS c FROM snapshots WHERE metric_key = ?",
                                 ("px:" + c,)).fetchone()["c"]
                if n < 500:
                    todo.append(c)
            if args.limit:
                todo = todo[:args.limit]
        log("回填计划：%d 只" % len(todo))
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        done = 0
        for code in todo:
            try:
                pts = fetch_kline(code)
                if not pts:
                    log("%s 无数据" % code)
                    continue
                key = "px:" + code
                conn.execute("DELETE FROM snapshots WHERE metric_key = ?", (key,))
                for d, close in pts:
                    upsert(conn, key, code, d, round(close, 4), "local_ccy", "腾讯kline前复权", now)
                conn.commit()
                done += 1
                if done % 100 == 0:
                    log("回填进度 %d/%d" % (done, len(todo)))
                time.sleep(args.sleep)
            except Exception as ex:
                conn.rollback()
                log("%s 失败(跳过): %s" % (code, ex))
                time.sleep(3)
        log("回填完成：%d 只" % done)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
