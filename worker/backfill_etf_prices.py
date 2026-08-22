# -*- coding: utf-8 -*-
"""宇宙历史价格一次性回填：yfinance 5 年日线（auto_adjust=False，与 clist 日频口径一致），
写入 snapshots 的 px:{code}。幂等可重跑；带重试退避。
用法: python worker/backfill_etf_prices.py [--limit N] [--sleep 0.3]"""
import argparse
import os
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db  # noqa: E402
from worker.fetch_data import upsert, log  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--sleep", type=float, default=0.3)
    ap.add_argument("--codes", help="只回填指定代码（逗号分隔，如 510300.SS,512880.SS）")
    args = ap.parse_args()
    import yfinance as yf
    db.init_db()
    conn = db.get_db()
    try:
        if args.codes:
            todo = args.codes.split(",")
            codes = todo
        else:
            codes = [r["code"] for r in conn.execute(
                "SELECT code FROM etf_universe WHERE active = 1 ORDER BY code").fetchall()]
            # 跳过已有足够历史的（可重跑续传）
            todo = []
            for c in codes:
                n = conn.execute("SELECT COUNT(*) AS c FROM snapshots WHERE metric_key = ?",
                                 ("px:" + c,)).fetchone()["c"]
                if n < 500:
                    todo.append(c)
            if args.limit:
                todo = todo[:args.limit]
        log("回填计划：%d 只（宇宙 active %d 只）" % (len(todo), len(codes)))
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        done = 0
        for code in todo:
            try:
                hist = yf.Ticker(code).history(period="5y", auto_adjust=False)
                if hist is None or hist.empty:
                    log("%s 无数据" % code)
                    continue
                key = "px:" + code
                conn.execute("DELETE FROM snapshots WHERE metric_key = ? AND source = 'yfinance-5y'", (key,))
                n = 0
                for idx, row in hist.iterrows():
                    close = row.get("Close")
                    if close is None or close != close:
                        continue
                    upsert(conn, key, code, idx.strftime("%Y-%m-%d"),
                           round(float(close), 4), "local_ccy", "yfinance-5y", now)
                    n += 1
                conn.commit()
                done += 1
                if done % 50 == 0:
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
