# -*- coding: utf-8 -*-
"""公开数据源抓取：SEC EDGAR / yfinance / TWSE，结果写入 snapshots 表（幂等 UPSERT）。

采集范围由 metrics 注册表 ⋈ theme_metrics 订阅 ⋈ themes(enabled) 的并集驱动，
本文件不含任何主题内容；新增数据源 = 新增一个 fetcher 并登记到 FETCHERS。
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

# us-gaap 标签候选（通用财务知识，按 metric 后缀索引）——候选标签按数据新鲜度（最大 end 日期）
# 自动选择，以兼容公司换标签的情况（如 NVDA capex 已改用 PaymentsToAcquireProductiveAssets）
EDGAR_METRIC_TAGS = {
    "capex": ("资本开支(单季)", ["PaymentsToAcquirePropertyPlantAndEquipment",
                                "PaymentsToAcquireProductiveAssets"]),
    "revenue": ("营业收入(单季)", ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"]),
    "gross_profit": ("毛利(单季)", ["GrossProfit"]),
}


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


def fetch_edgar(conn, now, rows):
    """rows: edgar 类指标行；params = {ticker, cik, cname, metric}。按公司分组，每公司只拉一次 companyfacts。"""
    by_company = {}
    for r in rows:
        p = json.loads(r["params"])
        by_company.setdefault((p["ticker"], p["cik"], p["cname"]), []).append((r, p))
    total = 0
    for (ticker, cik, cname), items in by_company.items():
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
        for r, p in items:
            suffix = p["metric"]
            if suffix not in EDGAR_METRIC_TAGS:
                log("EDGAR %s: 未知指标后缀 %r，跳过" % (ticker, suffix))
                continue
            tags = EDGAR_METRIC_TAGS[suffix][1]
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
                log("EDGAR %s %s: 无数据标签" % (ticker, suffix))
                continue
            quarters = extract_quarters(fact)
            metric_key = r["metric_key"]
            conn.execute("DELETE FROM snapshots WHERE metric_key = ?", (metric_key,))
            for (start, end), val in quarters:
                upsert(conn, metric_key, r["label"], end, float(val), r["unit"], "SEC EDGAR", now)
                total += 1
        time.sleep(0.5)  # EDGAR 速率限制：串行加 sleep
    log("EDGAR 完成，写入 %d 条" % total)


def fetch_yf_price(conn, now, rows):
    """rows: yf_price 类指标行；params = {ticker}。日线收盘价，近 3 个月。"""
    import yfinance as yf
    total = 0
    for r in rows:
        ticker = json.loads(r["params"])["ticker"]
        try:
            hist = yf.Ticker(ticker).history(period="3mo", auto_adjust=False)
            if hist is None or hist.empty:
                log("yfinance %s: 无数据" % ticker)
                continue
            for idx, row in hist.iterrows():
                close = row.get("Close")
                if close is None or close != close:  # None 或 NaN
                    continue
                upsert(conn, r["metric_key"], r["label"], idx.strftime("%Y-%m-%d"),
                       round(float(close), 4), r["unit"], "yfinance", now)
                total += 1
        except Exception as ex:
            log("yfinance %s 失败: %s" % (ticker, ex))
    log("yfinance 日线完成，写入 %d 条" % total)


def fetch_yf_financials(conn, now, rows):
    """rows: yf_financials 类指标行；params = {ticker, cname, rows:{财报行名: metric后缀}}。
    同一 ticker 的多个指标共享一次 quarterly_financials 拉取。"""
    import yfinance as yf
    by_ticker = {}
    for r in rows:
        p = json.loads(r["params"])
        by_ticker.setdefault(p["ticker"], {"cname": p.get("cname", p["ticker"]),
                                           "rows": p.get("rows", {}), "items": []})
        by_ticker[p["ticker"]]["items"].append((r, p))
    total = 0
    for ticker, grp in by_ticker.items():
        try:
            fin = yf.Ticker(ticker).quarterly_financials
            if fin is None or fin.empty:
                log("%s 季度财报: 无数据" % ticker)
                continue
            for r, p in grp["items"]:
                # 财报行名 → 本指标对应的后缀，反查行名
                suffix = r["metric_key"].rsplit(":", 1)[-1]
                row_names = [name for name, sfx in grp["rows"].items() if sfx == suffix]
                if not row_names or row_names[0] not in fin.index:
                    continue
                for col, val in fin.loc[row_names[0]].items():
                    if val != val:  # NaN
                        continue
                    upsert(conn, r["metric_key"], r["label"],
                           col.strftime("%Y-%m-%d") if hasattr(col, "strftime") else str(col)[:10],
                           float(val), r["unit"], "yfinance", now)
                    total += 1
        except Exception as ex:
            log("%s 季度财报失败: %s" % (ticker, ex))
    log("yfinance 季度财报完成，写入 %d 条" % total)


def fetch_twse_monthly(conn, now, rows):
    """rows: twse_monthly 类指标行；params = {code, cname}。TWSE OpenAPI 上市公司每月营收。"""
    try:
        data = http_get_json("https://openapi.twse.com.tw/v1/opendata/t187ap05_L", timeout=15)
    except Exception as ex:
        log("TWSE 月营收失败(跳过): %s" % ex)
        return
    total = 0
    wanted = {}
    for r in rows:
        p = json.loads(r["params"])
        wanted.setdefault(str(p["code"]).strip(), []).append(r)
    for row in data:
        code = str(row.get("公司代號", "")).strip()
        if code not in wanted:
            continue
        period = str(row.get("資料年月", "")).strip()
        rev = str(row.get("營業收入-當月營收", "")).replace(",", "").strip()
        if not period or not rev:
            continue
        for r in wanted[code]:
            upsert(conn, r["metric_key"], r["label"],
                   period + "-01" if len(period) == 6 else period, float(rev),
                   r["unit"], "TWSE OpenAPI", now)
            total += 1
    log("TWSE 月营收完成，写入 %d 条" % total)


# kind -> fetcher(conn, now, rows)。新数据源在这里登记。
FETCHERS = {
    "edgar": fetch_edgar,
    "yf_price": fetch_yf_price,
    "yf_financials": fetch_yf_financials,
    "twse_monthly": fetch_twse_monthly,
}


def upsert(conn, metric_key, label, period_date, value, unit, source, fetched_at):
    conn.execute(
        "INSERT INTO snapshots (metric_key, label, period_date, value, unit, source, fetched_at)"
        " VALUES (?,?,?,?,?,?,?)"
        " ON CONFLICT(metric_key, period_date) DO UPDATE SET"
        " value = excluded.value, label = excluded.label, unit = excluded.unit,"
        " source = excluded.source, fetched_at = excluded.fetched_at",
        (metric_key, label, period_date, value, unit, source, fetched_at),
    )


def subscribed_metrics(conn):
    """所有启用主题订阅的启用指标（并集），按 kind 分组。"""
    rows = conn.execute(
        "SELECT DISTINCT m.metric_key, m.label, m.unit, m.kind, m.params"
        " FROM metrics m"
        " JOIN theme_metrics tm ON tm.metric_key = m.metric_key"
        " JOIN themes t ON t.id = tm.theme_id"
        " WHERE t.enabled = 1 AND m.enabled = 1"
        " ORDER BY m.kind, m.metric_key"
    ).fetchall()
    by_kind = {}
    for r in rows:
        by_kind.setdefault(r["kind"], []).append(r)
    return by_kind


def main():
    db.init_db()
    conn = db.get_db()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        by_kind = subscribed_metrics(conn)
        for kind, rows in by_kind.items():
            fn = FETCHERS.get(kind)
            if fn is None:
                log("未知指标类型 %r（%d 个指标，跳过）" % (kind, len(rows)))
                continue
            try:
                fn(conn, now, rows)
                conn.commit()
            except Exception as ex:
                conn.rollback()
                log("数据源 %s 整体失败(跳过): %s" % (kind, ex))
        count = conn.execute("SELECT COUNT(*) AS c FROM snapshots").fetchone()["c"]
        log("fetch_data 完成，snapshots 表共 %d 条" % count)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
