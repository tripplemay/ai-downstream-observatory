# -*- coding: utf-8 -*-
"""公开数据源抓取：SEC EDGAR / yfinance / TWSE，结果写入 snapshots 表（幂等 UPSERT）。
单个源失败只记日志跳过，不阻塞其他源；退出码恒为 0（除非数据库本身出错）。"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db  # noqa: E402

UA = "observatory admin@example.com"
TIMEOUT = 30

# SEC EDGAR CIK 表
EDGAR_COMPANIES = [
    ("MSFT", 789019, "微软"),
    ("GOOGL", 1652044, "谷歌"),
    ("AMZN", 1018724, "亚马逊"),
    ("META", 1326801, "Meta"),
    ("NVDA", 1045810, "英伟达"),
    ("MU", 723125, "美光"),
    ("BABA", 1577552, "阿里巴巴"),
]
# (metric_key 后缀, 中文名, us-gaap 标签候选) —— 候选标签按数据新鲜度（最大 end 日期）自动选择，
# 以兼容公司换标签的情况（如 NVDA capex 已改用 PaymentsToAcquireProductiveAssets）
EDGAR_METRICS = [
    ("capex", "资本开支(单季)", ["PaymentsToAcquirePropertyPlantAndEquipment",
                               "PaymentsToAcquireProductiveAssets"]),
    ("revenue", "营业收入(单季)", ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"]),
    ("gross_profit", "毛利(单季)", ["GrossProfit"]),
]

# yfinance 日线收盘价（近 3 个月，C7 相对强弱用）
YF_PRICE_TICKERS = [
    ("^SOX", "费城半导体指数 收盘价"),
    ("MU", "美光(MU) 收盘价"),
    ("513050.SS", "中概互联网ETF(513050) 收盘价"),
    ("159509.SZ", "纳指科技ETF(159509) 收盘价"),
    ("159852.SZ", "软件ETF(159852) 收盘价"),
    ("159516.SZ", "半导体材料设备ETF(159516) 收盘价"),
    ("588200.SS", "科创芯片ETF(588200) 收盘价"),
]


def log(msg):
    print("[%s] %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg), flush=True)


def http_get_json(url, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def days_between(start, end):
    try:
        d1 = datetime.strptime(start, "%Y-%m-%d")
        d2 = datetime.strptime(end, "%Y-%m-%d")
        return (d2 - d1).days
    except (ValueError, TypeError):
        return -1


def extract_quarters(entries):
    """从 companyfacts 的某个 us-gaap 条目中提取最近 8 个单季值。
    优先直接季度条目（70-110 天），再用同一起始日的累计值相邻相减（YTD 差分）。"""
    # 去重：同一 (start,end) 取 filed 最新的
    best = {}
    for e in entries:
        start, end, val = e.get("start"), e.get("end"), e.get("val")
        if not start or not end or val is None:
            continue
        key = (start, end)
        if key not in best or e.get("filed", "") > best[key].get("filed", ""):
            best[key] = e
    periods = {}  # (start,end) -> val，单季
    for (start, end), e in best.items():
        if 70 <= days_between(start, end) <= 110:
            periods[(start, end)] = e["val"]
    # YTD 差分：按 start 分组，累计区间两两相邻相减
    by_start = {}
    for (start, end), e in best.items():
        by_start.setdefault(start, []).append((end, e["val"]))
    for start, lst in by_start.items():
        lst.sort()
        for i in range(1, len(lst)):
            end_prev, val_prev = lst[i - 1]
            end_cur, val_cur = lst[i]
            if 70 <= days_between(end_prev, end_cur) <= 110 and (start, end_cur) not in periods:
                periods[(end_prev, end_cur)] = val_cur - val_prev
    # 最近 8 个季度，按结束日排序
    items = sorted(periods.items(), key=lambda kv: kv[0][1])[-8:]
    return items


def fetch_edgar(conn, now):
    total = 0
    for ticker, cik, cname in EDGAR_COMPANIES:
        path = "/api/xbrl/companyfacts/CIK%010d.json" % cik
        data = None
        for host in ("https://data.sec.gov", "https://www.sec.gov"):
            try:
                data = http_get_json(host + path)
                if host != "https://data.sec.gov":
                    log("EDGAR %s: data.sec.gov 不通，已改用 %s 镜像" % (ticker, host))
                break
            except Exception as ex:
                log("EDGAR %s %s 失败: %s" % (ticker, host, ex))
        if data is None:
            continue
        facts = data.get("facts", {}).get("us-gaap", {})
        for mkey, mname, tags in EDGAR_METRICS:
            # 在候选标签里选数据最新（max(end) 最大）的一个
            fact, freshest = None, ""
            for tag in tags:
                entries = facts.get(tag, {}).get("units", {}).get("USD")
                if not entries:
                    continue
                latest = max(e.get("end", "") for e in entries)
                if latest > freshest:
                    fact, freshest = entries, latest
            if not fact:
                log("EDGAR %s %s: 无数据标签" % (ticker, mkey))
                continue
            quarters = extract_quarters(fact)
            metric_key = "edgar:%s:%s" % (ticker, mkey)
            conn.execute("DELETE FROM snapshots WHERE metric_key = ?", (metric_key,))
            for (start, end), val in quarters:
                upsert(conn, metric_key, "%s(%s) %s" % (cname, ticker, mname),
                       end, float(val), "USD", "SEC EDGAR", now)
                total += 1
        time.sleep(0.5)  # EDGAR 速率限制：串行加 sleep
    log("EDGAR 完成，写入 %d 条" % total)


def fetch_yfinance_prices(conn, now):
    import yfinance as yf
    total = 0
    for ticker, label in YF_PRICE_TICKERS:
        try:
            hist = yf.Ticker(ticker).history(period="3mo", auto_adjust=False)
            if hist is None or hist.empty:
                log("yfinance %s: 无数据" % ticker)
                continue
            for idx, row in hist.iterrows():
                close = row.get("Close")
                if close is None or close != close:  # None 或 NaN
                    continue
                upsert(conn, "px:%s" % ticker, label, idx.strftime("%Y-%m-%d"),
                       round(float(close), 4), "local_ccy", "yfinance", now)
                total += 1
        except Exception as ex:
            log("yfinance %s 失败: %s" % (ticker, ex))
    log("yfinance 日线完成，写入 %d 条" % total)


def fetch_tencent_quarterly(conn, now):
    import yfinance as yf
    try:
        fin = yf.Ticker("0700.HK").quarterly_financials
        if fin is None or fin.empty:
            log("0700.HK 季度财报: 无数据")
            return
        mapping = [("Total Revenue", "revenue", "腾讯(0700.HK) 营业收入(单季)"),
                   ("Gross Profit", "gross_profit", "腾讯(0700.HK) 毛利(单季)")]
        n = 0
        for row_name, mkey, label in mapping:
            if row_name not in fin.index:
                continue
            for col, val in fin.loc[row_name].items():
                if val != val:  # NaN
                    continue
                upsert(conn, "yf:0700.HK:%s" % mkey, label,
                       col.strftime("%Y-%m-%d") if hasattr(col, "strftime") else str(col)[:10],
                       float(val), "HKD", "yfinance", now)
                n += 1
        log("0700.HK 季度财报完成，写入 %d 条" % n)
    except Exception as ex:
        log("0700.HK 季度财报失败: %s" % ex)


def fetch_twse(conn, now):
    # TWSE OpenAPI：上市公司每月营业收入汇总，过滤台积电(2330)
    try:
        data = http_get_json("https://openapi.twse.com.tw/v1/opendata/t187ap05_L", timeout=15)
        n = 0
        for row in data:
            if str(row.get("公司代號", "")).strip() != "2330":
                continue
            period = str(row.get("資料年月", "")).strip()
            rev = str(row.get("營業收入-當月營收", "")).replace(",", "").strip()
            if not period or not rev:
                continue
            upsert(conn, "twse:2330:monthly_revenue", "台积电(2330) 月营收",
                   period + "-01" if len(period) == 6 else period, float(rev),
                   "TWD(千元)", "TWSE OpenAPI", now)
            n += 1
        log("TWSE 台积电月营收完成，写入 %d 条" % n)
    except Exception as ex:
        log("TWSE 台积电月营收失败(跳过): %s" % ex)


def upsert(conn, metric_key, label, period_date, value, unit, source, fetched_at):
    conn.execute(
        "INSERT INTO snapshots (metric_key, label, period_date, value, unit, source, fetched_at)"
        " VALUES (?,?,?,?,?,?,?)"
        " ON CONFLICT(metric_key, period_date) DO UPDATE SET"
        " value = excluded.value, label = excluded.label, unit = excluded.unit,"
        " source = excluded.source, fetched_at = excluded.fetched_at",
        (metric_key, label, period_date, value, unit, source, fetched_at),
    )


def main():
    db.init_db()
    conn = db.get_db()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        for name, fn in (("EDGAR", fetch_edgar), ("yfinance_prices", fetch_yfinance_prices),
                         ("tencent", fetch_tencent_quarterly), ("TWSE", fetch_twse)):
            try:
                fn(conn, now)
                conn.commit()
            except Exception as ex:
                conn.rollback()
                log("数据源 %s 整体失败(跳过): %s" % (name, ex))
        count = conn.execute("SELECT COUNT(*) AS c FROM snapshots").fetchone()["c"]
        log("fetch_data 完成，snapshots 表共 %d 条" % count)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
