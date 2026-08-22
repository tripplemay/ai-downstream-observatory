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


def http_get_text(url, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


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
    # 最近 12 个季度，按结束日排序（F1 规则需要 4 个季度同比，即至少 8 个点）
    items = sorted(periods.items(), key=lambda kv: kv[0][1])[-12:]
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
    """rows: yf_financials 类指标行；params = {ticker, cname, rows:{利润表行名: 后缀},
    cf_rows:{现金流量表行名: 后缀}}。同一 ticker 的多个指标共享一次拉取。
    capex 取 Capital Expenditure（负值），入库取绝对值以与 EDGAR 口径一致。"""
    import yfinance as yf
    by_ticker = {}
    for r in rows:
        p = json.loads(r["params"])
        by_ticker.setdefault(p["ticker"], []).append((r, p))
    total = 0
    for ticker, items in by_ticker.items():
        try:
            fin = yf.Ticker(ticker).quarterly_financials
            cashflow = None
            if any(p.get("cf_rows") for _, p in items):
                cashflow = yf.Ticker(ticker).quarterly_cashflow
            for r, p in items:
                suffix = r["metric_key"].rsplit(":", 1)[-1]
                found = False
                for stmt, row_map in ((fin, p.get("rows") or {}), (cashflow, p.get("cf_rows") or {})):
                    if stmt is None:
                        continue
                    row_names = [name for name, sfx in row_map.items() if sfx == suffix]
                    if not row_names or row_names[0] not in stmt.index:
                        continue
                    for col, val in stmt.loc[row_names[0]].items():
                        if val != val:  # NaN
                            continue
                        if suffix == "capex":
                            val = abs(val)
                        upsert(conn, r["metric_key"], r["label"],
                               col.strftime("%Y-%m-%d") if hasattr(col, "strftime") else str(col)[:10],
                               float(val), r["unit"], "yfinance", now)
                        total += 1
                    found = True
                    break
                if not found:
                    log("%s %s: 无数据行" % (ticker, suffix))
        except Exception as ex:
            log("%s 季度财报失败: %s" % (ticker, ex))
    log("yfinance 季度财报完成，写入 %d 条" % total)


def _parse_number(text):
    """解析 R 文件数值单元格：去 $、逗号、空白；括号表示负数。"""
    t = text.replace("$", "").replace(",", "").strip()
    if not t or t in ("—", "-"):
        return None
    neg = t.startswith("(") and t.endswith(")")
    t = t.strip("()")
    try:
        v = float(t)
    except ValueError:
        return None
    return -v if neg else v


class _TableParser:
    """把 R 文件 HTML 解析成行列表（每行 = 文本单元格列表），丢弃 XBRL 元数据行。"""

    @staticmethod
    def parse(html_text):
        from html.parser import HTMLParser

        class P(HTMLParser):
            def __init__(self):
                super().__init__()
                self.rows, self.cur_row, self.cur_cell = [], None, None

            def handle_starttag(self, tag, attrs):
                if tag == "tr":
                    self.cur_row = []
                elif tag in ("td", "th") and self.cur_row is not None:
                    self.cur_cell = []

            def handle_data(self, data):
                if self.cur_cell is not None:
                    self.cur_cell.append(data)

            def handle_endtag(self, tag):
                if tag in ("td", "th") and self.cur_cell is not None:
                    self.cur_row.append("".join(self.cur_cell).strip())
                    self.cur_cell = None
                elif tag == "tr" and self.cur_row is not None:
                    row = [c for c in self.cur_row if c]
                    if row and not row[0].startswith(("X", "Name:")):
                        self.rows.append(row)
                    self.cur_row = None

        p = P()
        p.feed(html_text)
        return p.rows


def fetch_edgar_segment(conn, now, rows):
    """rows: edgar_segment 类指标行；params = {ticker, cik, report_re, segment, metric_label}。
    链路：submissions → 最新 10-Q → FilingSummary.xml 按 LongName 正则定位 R 文件 →
    解析表格：分部标题行独占一行，其后第一个匹配 metric_label 的行的首个数值格 = 本季单季值。"""
    import re
    import xml.etree.ElementTree as ET
    total = 0
    for r in rows:
        p = json.loads(r["params"])
        ticker, cik = p["ticker"], int(p["cik"])
        try:
            subs = http_get_json("https://data.sec.gov/submissions/CIK%010d.json" % cik)
            recent = subs["filings"]["recent"]
            accession = None
            for form, acc in zip(recent["form"], recent["accessionNumber"]):
                if form == "10-Q":
                    accession = acc
                    break
            if not accession:
                log("EDGAR seg %s: 无 10-Q" % ticker)
                continue
            base = "https://www.sec.gov/Archives/edgar/data/%d/%s/" % (cik, accession.replace("-", ""))
            fs_root = ET.fromstring(http_get_text(base + "FilingSummary.xml"))
            report_re = re.compile(p["report_re"])
            htm = None
            for rep in fs_root.iter("Report"):
                long_name = (rep.findtext("LongName") or "")
                html_name = (rep.findtext("HtmlFileName") or "").strip()
                if html_name and report_re.search(long_name):
                    htm = html_name
                    break
            if not htm:
                log("EDGAR seg %s: FilingSummary 中找不到分部报告" % ticker)
                continue
            html_text = http_get_text(base + htm)
            rows_parsed = _TableParser.parse(html_text)
            values = []
            for i, row in enumerate(rows_parsed):
                if row[0].strip() == p["segment"]:
                    for nxt in rows_parsed[i + 1:i + 6]:
                        if p["metric_label"].lower() in nxt[0].lower():
                            for cell in nxt[1:]:
                                v = _parse_number(cell)
                                if v is not None:
                                    values.append(v)
                                if len(values) == 2:  # 本季 + 去年同期（列序恒定）
                                    break
                            if values:  # 标签行可能是无数值的分节头（如 NVDA），跳过继续找
                                break
                    break
            if not values:
                log("EDGAR seg %s: 表中找不到 %s/%s" % (ticker, p["segment"], p["metric_label"]))
                continue
            # period 取 10-Q 报告期；去年同期值一并入库（便于即刻算同比）
            period = recent["reportDate"][recent["accessionNumber"].index(accession)]
            upsert(conn, r["metric_key"], r["label"], period, values[0], r["unit"], "SEC EDGAR 10-Q", now)
            if len(values) == 2:
                prior_period = "%04d%s" % (int(period[:4]) - 1, period[4:])
                upsert(conn, r["metric_key"], r["label"], prior_period, values[1], r["unit"],
                       "SEC EDGAR 10-Q(去年同期列)", now)
            total += 1
            time.sleep(0.5)
        except Exception as ex:
            log("EDGAR seg %s 失败: %s" % (ticker, ex))
    log("EDGAR 分部收入完成，写入 %d 条" % total)


def fetch_model_price(conn, now, rows):
    """rows: model_price 类指标行。拉 OpenRouter models API 一次，
    对监控模型写 blended 价（输入×3+输出)/4，每百万 token 美元；
    然后按档位计算中美阵营中位价比率（衍生指标，params.ratio=true 的行）。"""
    try:
        data = http_get_json("https://openrouter.ai/api/v1/models")["data"]
    except Exception as ex:
        log("OpenRouter models API 失败(跳过): %s" % ex)
        return
    price_by_id = {}
    for m in data:
        p = m.get("pricing") or {}
        try:
            i, o = float(p.get("prompt", 0)), float(p.get("completion", 0))
        except (TypeError, ValueError):
            continue
        if i > 0 or o > 0:
            price_by_id[m["id"]] = (i * 3 + o) / 4 * 1e6
    today = now[:10]
    total = 0
    tier_prices = {}  # tier -> {"cn": [prices], "us": [prices]}
    ratio_rows = []
    for r in rows:
        p = json.loads(r["params"])
        if p.get("ratio"):
            ratio_rows.append((r, p))
            continue
        model_id = p["model_id"]
        blended = price_by_id.get(model_id)
        if blended is None:
            log("OpenRouter 无模型 %r（可能已下架/改名，跳过）" % model_id)
            continue
        upsert(conn, r["metric_key"], r["label"], today, round(blended, 4),
               r["unit"], "OpenRouter", now)
        tier_prices.setdefault(p["tier"], {}).setdefault(p["camp"], []).append(blended)
        total += 1
    for r, p in ratio_rows:
        tier = tier_prices.get(p["tier"], {})
        cn, us = tier.get("cn"), tier.get("us")
        if not cn or not us:
            log("背离比率 %s: 阵营数据不足（cn=%d, us=%d）"
                % (p["tier"], len(cn or []), len(us or [])))
            continue
        def median(xs):
            s = sorted(xs)
            n = len(s)
            return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
        ratio = median(us) / median(cn)
        upsert(conn, r["metric_key"], r["label"], today, round(ratio, 2),
               r["unit"], "OpenRouter 计算值", now)
        total += 1
    log("模型价格完成，写入 %d 条" % total)


def fetch_fund_info(conn, now, rows):
    """rows: fund_info 类指标行；params = {code, field(nav|scale)}。
    数据源：天天基金 pingzhongdata（每代码一次请求，解析净值序列与规模变动）。
    nav → 最新净值；scale → 最新规模（亿元，季度更新）。"""
    import re
    by_code = {}
    for r in rows:
        p = json.loads(r["params"])
        by_code.setdefault(p["code"], []).append((r, p))
    total = 0
    for code, items in by_code.items():
        try:
            req = urllib.request.Request(
                "http://fund.eastmoney.com/pingzhongdata/%s.js" % code,
                headers={"User-Agent": "Mozilla/5.0"})
            js = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", errors="replace")
            name_m = re.search(r'fS_name\s*=\s*"(.*?)"', js)
            fund_name = name_m.group(1) if name_m else code
            for r, p in items:
                if p["field"] == "nav":
                    m = re.search(r"Data_netWorthTrend\s*=\s*(\[.*?\]);", js)
                    if not m:
                        continue
                    nw = json.loads(m.group(1))
                    if not nw:
                        continue
                    last = nw[-1]
                    from datetime import datetime as _dt
                    day = _dt.utcfromtimestamp(last["x"] / 1000).strftime("%Y-%m-%d")
                    label = "%s(%s) 净值" % (fund_name, code)
                    upsert(conn, r["metric_key"], label, day, float(last["y"]),
                           r["unit"], "天天基金", now)
                    total += 1
                elif p["field"] == "scale":
                    m = re.search(r"Data_fluctuationScale\s*=\s*(\{.*?\});", js)
                    if not m:
                        continue
                    fs = json.loads(m.group(1))
                    cats, ser = fs.get("categories") or [], fs.get("series") or []
                    if not cats or not ser:
                        continue
                    label = "%s(%s) 规模" % (fund_name, code)
                    upsert(conn, r["metric_key"], label, cats[-1], float(ser[-1]["y"]),
                           r["unit"], "天天基金", now)
                    total += 1
        except Exception as ex:
            log("基金 %s 数据失败(跳过): %s" % (code, ex))
    log("基金净值/规模完成，写入 %d 条" % total)


def fetch_fund_holdings(conn, now, rows):
    """rows: fund_holdings 类指标行；params = {code, anchors:[名称关键词]}。
    天天基金 FundArchivesDatas(jjcc) 抓最新季度 top10 持仓，计算锚定持仓占净值比例合计（纯度）。
    接口要求 Referer 头；季度披露，月频抓取即可。"""
    import re
    total = 0
    for r in rows:
        p = json.loads(r["params"])
        code, anchors = p["code"], p["anchors"]
        html = None
        for attempt in range(3):  # 东财偶发限流：重试 + 退避
            try:
                for year in (datetime.now().year, datetime.now().year - 1):
                    url = ("https://fundf10.eastmoney.com/FundArchivesDatas.aspx"
                           "?type=jjcc&code=%s&topline=10&year=%d&month=&rt=0.5" % (code, year))
                    req = urllib.request.Request(url, headers={
                        "User-Agent": "Mozilla/5.0",
                        "Referer": "https://fundf10.eastmoney.com/ccmx_%s.html" % code})
                    raw = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", errors="replace")
                    m = re.search(r'content:"((?:[^"\\]|\\.)*)"', raw, re.S)
                    if m and "股票投资明细" in m.group(1):
                        html = m.group(1).replace('\\"', '"').replace("\\/", "/")
                        break
                break
            except Exception as ex:
                if attempt == 2:
                    log("持仓 %s 失败(跳过): %s" % (code, ex))
                time.sleep(3 * (attempt + 1))
        if html is None:
            continue
        try:
            blocks = re.split(r"\d{4}年\d季度股票投资明细", html)
            qm = re.search(r"(\d{4})年(\d)季度", html)
            quarter_end = {1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31"}
            period = "%s-%s" % (qm.group(1), quarter_end[int(qm.group(2))]) if qm else None
            # 列位置随年份不同（当年表多"最新价/涨跌幅"列），从表头定位"占净值比例"
            head_m = re.search(r"<thead>(.*?)</thead>", blocks[1], re.S)
            headers = [re.sub(r"<[^>]+>", "", c).strip()
                       for c in re.findall(r"<th[^>]*>(.*?)</th>", head_m.group(1), re.S)] if head_m else []
            try:
                pct_col = headers.index("占净值比例")
            except ValueError:
                log("持仓 %s: 表头找不到占净值比例列（%s）" % (code, headers))
                continue
            purity = 0.0
            matched = []
            for row in re.findall(r"<tr>(.*?)</tr>", blocks[1], re.S):
                cells = [re.sub(r"<[^>]+>", "", c).strip()
                         for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
                if len(cells) > pct_col and cells[0].isdigit():
                    try:
                        pct = float(cells[pct_col].replace("%", ""))
                    except ValueError:
                        continue
                    if any(a in cells[2] for a in anchors):
                        purity += pct
                        matched.append("%s %.1f%%" % (cells[2], pct))
            if period is None or purity == 0.0:
                # 0% 几乎必是解析问题而非真实漂移，宁可本轮不写也不污染序列
                log("持仓 %s 数据异常（period=%s, purity=%.1f），本轮跳过" % (code, period, purity))
                continue
            upsert(conn, r["metric_key"], r["label"], period, round(purity, 2),
                   r["unit"], "天天基金", now)
            total += 1
            log("持仓 %s 纯度 %.1f%%（%s）" % (code, purity, "、".join(matched[:4])))
        except Exception as ex:
            log("持仓 %s 解析失败(跳过): %s" % (code, ex))
        time.sleep(0.5)
    log("持仓纯度完成，写入 %d 条" % total)


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


def refresh_universe(conn, now):
    """全行业 ETF 宇宙每日刷新（东财 clist，MK0021-24 权益板块）。
    active = 规模>2亿 且 非货币/债券/商品类。新上市自动入、萎缩自动出。"""
    rows = []
    for pn in range(1, 16):
        data = None
        for host in ("https://push2.eastmoney.com", "https://push2delay.eastmoney.com"):
            try:
                data = http_get_json(
                    "%s/api/qt/clist/get?pn=%d&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3"
                    "&fs=b:MK0021,b:MK0022,b:MK0023,b:MK0024&fields=f12,f13,f14,f2,f6,f20" % (host, pn))
                break
            except Exception:
                continue
        if not data or not data.get("data") or not data["data"].get("diff"):
            break
        rows.extend(data["data"]["diff"])
        if len(data["data"]["diff"]) < 100:
            break
        time.sleep(0.3)
    EXCLUDE = ("货币", "债", "黄金", "白银", "豆粕", "原油", "上海金", "大宗", "现金", "国开", "添益")
    CROSS = ("纳指", "纳斯达克", "标普", "道琼", "日经", "德国", "法国", "沙特", "东南亚", "恒生",
             "港股", "H股", "中概", "海外", "全球", "美国", "亚太", "新兴市场", "中韩")
    BROAD = ("300", "500", "800", "1000", "2000", "50", "100", "A50", "A100", "A500", "创业板",
             "科创", "综指", "成指", "宽基", "红利", "低波", "基本面", "现金流", "MSCI", "增强")
    n = 0
    seen = set()
    for r in rows:
        code, name = r.get("f12"), r.get("f14") or ""
        mktcap, turnover = r.get("f20"), r.get("f6")
        if not code or any(k in name for k in EXCLUDE):
            continue
        if any(k in name for k in CROSS):
            cat = "跨境"
        elif any(k in name for k in BROAD):
            cat = "宽基/策略"
        else:
            cat = "行业主题"
        active = 1 if (mktcap and mktcap > 2e8) else 0
        suffix = ".SS" if r.get("f13") == 1 else ".SZ"
        key = code + suffix
        seen.add(key)
        conn.execute(
            "INSERT INTO etf_universe (code, name, cat, turnover, mktcap, active, updated_at)"
            " VALUES (?,?,?,?,?,?,?)"
            " ON CONFLICT(code) DO UPDATE SET name=excluded.name, cat=excluded.cat,"
            " turnover=excluded.turnover, mktcap=excluded.mktcap, active=excluded.active,"
            " updated_at=excluded.updated_at",
            (key, name, cat, turnover, mktcap, active, now))
        n += 1
    # 退出市场的标的停用
    for r in conn.execute("SELECT code FROM etf_universe WHERE active = 1").fetchall():
        if r["code"] not in seen:
            conn.execute("UPDATE etf_universe SET active = 0, updated_at = ? WHERE code = ?",
                         (now, r["code"]))
    log("宇宙刷新：%d 只（active %d 只）"
        % (n, conn.execute("SELECT COUNT(*) AS c FROM etf_universe WHERE active=1").fetchone()["c"]))


def fetch_etf_px(conn, now):
    """全宇宙日频收盘价（clist 批量，pz=100 分页）。写入 px:{code}。"""
    codes = {r["code"] for r in
             conn.execute("SELECT code FROM etf_universe WHERE active = 1").fetchall()}
    if not codes:
        log("宇宙为空，跳过批量行情")
        return
    total = 0
    for pn in range(1, 16):
        data = None
        for host in ("https://push2.eastmoney.com", "https://push2delay.eastmoney.com"):
            try:
                data = http_get_json(
                    "%s/api/qt/clist/get?pn=%d&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12"
                    "&fs=b:MK0021,b:MK0022,b:MK0023,b:MK0024&fields=f12,f13,f2,f14,f124" % (host, pn))
                break
            except Exception:
                continue
        if not data or not data.get("data") or not data["data"].get("diff"):
            break
        for r in data["data"]["diff"]:
            suffix = ".SS" if r.get("f13") == 1 else ".SZ"
            key = r.get("f12", "") + suffix
            price = r.get("f2")
            ts = r.get("f124")  # 行情时间戳（周末/假日取到的是上一交易日）
            day = datetime.fromtimestamp(ts).strftime("%Y-%m-%d") if ts else now[:10]
            if key in codes and price and price > 0:
                upsert(conn, "px:%s" % key, r.get("f14") or key, day, float(price),
                       "local_ccy", "东财clist", now)
                total += 1
        if len(data["data"]["diff"]) < 100:
            break
        time.sleep(0.3)
    log("宇宙批量行情完成，写入 %d 条" % total)


def fill_index_mapping(conn, now):
    """给宇宙里没有 index_code 的 ETF 抓跟踪标的（fundf10 jbgk 页），并匹配中证指数代码。
    周频调用；每只对一次请求，带限速。"""
    import re
    rows = conn.execute("SELECT code, name FROM etf_universe WHERE active = 1 AND index_code = ''"
                        " LIMIT 60").fetchall()  # 每次最多 60 只，防限流
    filled = 0
    for r in rows:
        code = r["code"].split(".")[0]
        try:
            req = urllib.request.Request(
                "https://fundf10.eastmoney.com/jbgk_%s.html" % code,
                headers={"User-Agent": "Mozilla/5.0",
                         "Referer": "https://fundf10.eastmoney.com/ccmx_%s.html" % code})
            html = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", errors="replace")
            m = re.search(r"跟踪标的</th><td[^>]*>(.*?)</td>", html, re.S)
            target = re.sub(r"<[^>]+>", "", m.group(1)).strip() if m else ""
            index_code, index_name = "", ""
            if target and target != "—":
                idx = match_csindex(target)
                if idx:
                    index_code, index_name = idx
            conn.execute("UPDATE etf_universe SET index_code = ?, index_name = ? WHERE code = ?",
                         (index_code or "NONE", index_name or target, r["code"]))
            filled += 1
            time.sleep(0.5)
        except Exception as ex:
            log("指数映射 %s 失败(跳过): %s" % (code, ex))
    log("指数映射完成，处理 %d 只" % filled)


def match_csindex(index_name):
    """指数名称 → 代码：东财搜索 API（type=14）取候选，名称相似度过滤（difflib ≥0.8），
    再用中证 index-perf 验证是否中证系（PE 数据源只覆盖中证）。失败返回 None。"""
    import difflib
    import re as _re
    import urllib.parse

    def core(s):
        return _re.sub(r"(中证|国证|申万|中华交易服务|有限责任|有限公司|指数|主题|行业)", "", s)

    def valid_csi(code):
        try:
            data = http_get_json_with_referer(
                "https://www.csindex.com.cn/csindex-home/perf/index-perf"
                "?indexCode=%s&startDate=20260101&endDate=20261231" % code)
            items = data if isinstance(data, list) else (data.get("data") or [])
            return len(items) > 0
        except Exception:
            return False

    target_core = core(index_name)
    for kw in dict.fromkeys([index_name, target_core]):  # 原名 → 清洗名
        if not kw:
            continue
        try:
            url = ("https://searchapi.eastmoney.com/api/suggest/get?input=%s&type=14"
                   "&token=D43BF722C8E33BDC906FB84D85E326E8&count=10" % urllib.parse.quote(kw))
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            data = json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8", errors="replace"))
            items = (data.get("QuotationCodeTable") or {}).get("Data") or []
        except Exception:
            continue
        best, best_ratio = None, 0.0
        for it in items:
            code, name = it.get("Code") or "", it.get("Name") or ""
            if not _re.fullmatch(r"(\d{6}|H\d{5})", code):  # 排除 BK 板块与基金
                continue
            ratio = difflib.SequenceMatcher(None, core(name), target_core).ratio()
            if ratio >= 0.85 and ratio > best_ratio and valid_csi(code):
                best, best_ratio = (code, name), ratio
        if best:
            return best
        time.sleep(0.3)
    return None


def http_get_json_with_referer(url, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "application/json",
        "Referer": "https://www.csindex.com.cn/"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_index_pe(conn, now):
    """中证指数 PE 日频（index-perf 接口，字段 peg 实为 PE）。增量：从库里最新日期续抓。
    首次自动拉全历史（2005 起），供 5 年分位计算。"""
    rows = conn.execute(
        "SELECT DISTINCT index_code, index_name FROM etf_universe"
        " WHERE active = 1 AND index_code != '' AND index_code != 'NONE'").fetchall()
    total = 0
    for r in rows:
        code = r["index_code"]
        metric_key = "pe:%s" % code
        try:
            last = conn.execute("SELECT MAX(period_date) AS d FROM snapshots WHERE metric_key = ?",
                                (metric_key,)).fetchone()["d"]
            start = "20050101" if not last else last.replace("-", "")
            data = http_get_json_with_referer(
                "https://www.csindex.com.cn/csindex-home/perf/index-perf"
                "?indexCode=%s&startDate=%s&endDate=%s"
                % (code, start, now[:10].replace("-", "")))
            items = data if isinstance(data, list) else (data.get("data") or [])
            for it in items:
                d = str(it.get("tradeDate") or it.get("tradingDate") or "")
                if len(d) == 8:  # 20260801 → 2026-08-01
                    d = "%s-%s-%s" % (d[:4], d[4:6], d[6:8])
                d = d[:10]
                pe = it.get("peg")
                if d and pe:
                    upsert(conn, metric_key, "%s PE" % (r["index_name"] or code), d,
                           float(pe), "倍", "中证指数", now)
                    total += 1
            time.sleep(0.3)
        except Exception as ex:
            log("指数PE %s 失败(跳过): %s" % (code, ex))
    log("指数PE完成，写入 %d 条（%d 个指数）" % (total, len(rows)))


# 全局采集任务（不经主题订阅，直接驱动）：daily 刷宇宙+行情，weekly 补映射+估值
GLOBAL_FETCHERS = {
    "universe": refresh_universe,
    "etf_px": fetch_etf_px,
    "index_data": lambda conn, now: (fill_index_mapping(conn, now), fetch_index_pe(conn, now)),
}


# kind -> fetcher(conn, now, rows)。新数据源在这里登记。
FETCHERS = {
    "edgar": fetch_edgar,
    "edgar_segment": fetch_edgar_segment,
    "yf_price": fetch_yf_price,
    "yf_financials": fetch_yf_financials,
    "twse_monthly": fetch_twse_monthly,
    "model_price": fetch_model_price,
    "fund_info": fetch_fund_info,
    "fund_holdings": fetch_fund_holdings,
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
    # 用法: python worker/fetch_data.py [--only kind1,kind2]（--only 只抓指定类型，如 daily 任务的 yf_price）
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    db.init_db()
    conn = db.get_db()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        # 全局采集（宇宙/批量行情/估值，不经主题订阅）
        for name, fn in GLOBAL_FETCHERS.items():
            if only is not None and name not in only:
                continue
            try:
                fn(conn, now)
                conn.commit()
            except Exception as ex:
                conn.rollback()
                log("全局采集 %s 失败(跳过): %s" % (name, ex))
        by_kind = subscribed_metrics(conn)
        for kind, rows in by_kind.items():
            if only is not None and kind not in only:
                continue
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
