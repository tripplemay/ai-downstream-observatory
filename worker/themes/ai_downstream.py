# -*- coding: utf-8 -*-
"""主题：AI 下游应用（来源：AI下游投资观测台.md，基线 2026-07-29）。

纯数据模块，不 import db。结构约定见 db.seed_theme()。
指标订阅即采集需求：fetch_data.py 按所有启用主题的订阅并集抓取。"""

# ---- 指标订阅（写入 metrics 注册表 + theme_metrics 关联） ----
# SEC EDGAR 公司表：(ticker, CIK, 中文名)；抓取指标为 capex/revenue/gross_profit 三件套
EDGAR_COMPANIES = [
    ("MSFT", 789019, "微软"),
    ("GOOGL", 1652044, "谷歌"),
    ("AMZN", 1018724, "亚马逊"),
    ("META", 1326801, "Meta"),
    ("NVDA", 1045810, "英伟达"),
    ("MU", 723125, "美光"),
    ("BABA", 1577552, "阿里巴巴"),
    ("PLTR", 1321655, "Palantir"),   # C10 应用层毛利率
    ("CRM", 1108524, "Salesforce"),  # C6 AI 提价能力（ARPU 代理）
]
EDGAR_METRIC_NAMES = [("capex", "资本开支(单季)"), ("revenue", "营业收入(单季)"), ("gross_profit", "毛利(单季)")]

# 部分公司在 EDGAR 没有（或已停更）某些 us-gaap 标签，按公司裁剪订阅，避免陈旧/空指标
EDGAR_METRIC_OVERRIDES = {
    "AMZN": ("capex", "revenue"),   # 毛利标签停更于 2009（报表格式变更）
    "GOOGL": ("capex", "revenue"),  # 无毛利标签
    "META": ("capex", "revenue"),   # 无毛利标签
    "BABA": ("revenue",),           # capex/毛利均无标签
}

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

# yfinance 季度财报（EDGAR 覆盖不到的公司）：(ticker, cname, 是否取 capex)
# capex 在现金流量表（quarterly_cashflow 的 Capital Expenditure 行，负值，入库取绝对值）
YF_FINANCIAL_COMPANIES = [
    ("0700.HK", "腾讯", False),      # C8/C9；Yahoo 不给腾讯季度现金流
    ("005930.KS", "三星电子", True),  # C1/C3
    ("000660.KS", "SK海力士", True),  # C1/C3
]

# EDGAR 10-Q 分部收入（C4 云厂商剪刀差/C2 算力供需的精确口径）：解析 FilingSummary.xml 定位 R 文件
EDGAR_SEGMENTS = [
    # (ticker, CIK, 指标后缀, 分部中文名, LongName 正则, 分部标题行, 指标行标签)
    ("MSFT", 789019, "cloud_revenue", "微软智能云", r"Segment Revenue.*Operating Income \(Detail\)",
     "Intelligent Cloud", "Revenue"),
    ("GOOGL", 1652044, "cloud_revenue", "谷歌云", r"Revenue by Segment \(Details?\)",
     "Google Cloud", "Revenue from contract with customers"),
    ("AMZN", 1018724, "cloud_revenue", "AWS", r"Reportable Segments and Reconciliation.*\(Details\)",
     "AWS", "Net sales"),
    ("NVDA", 1045810, "datacenter_revenue", "英伟达数据中心", r"Revenue by Market Platform \(Details?\)",
     "Data Center", "Revenue"),
]

# 主流模型 API 价格监控（C5/F2，OpenRouter 牌价）：档位 × 阵营 二维清单
# 混合价 = (输入×3 + 输出)/4，每百万 token 美元
MODEL_PRICE_WATCH = [
    # (OpenRouter model_id, 展示名, tier, camp)
    ("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", "flagship", "cn"),
    ("qwen/qwen3.7-max", "Qwen3.7 Max", "flagship", "cn"),
    ("openai/gpt-5.6-sol", "GPT-5.6 Sol", "flagship", "us"),
    ("google/gemini-3.1-pro-preview", "Gemini 3.1 Pro", "flagship", "us"),
    ("deepseek/deepseek-v4-flash-0731", "DeepSeek V4 Flash", "volume", "cn"),
    ("minimax/minimax-m3", "MiniMax M3", "volume", "cn"),
    ("openai/gpt-5.6-luna", "GPT-5.6 Luna", "volume", "us"),
    ("deepseek/deepseek-r1", "DeepSeek R1", "reasoning", "cn"),
    ("anthropic/claude-opus-4.1", "Claude Opus 4.1", "reasoning", "us"),
    ("openai/gpt-5.5-pro", "GPT-5.5 Pro", "reasoning", "us"),
]
# 背离比率衍生指标：tier -> 展示名（美国阵营中位价 ÷ 中国阵营中位价）
MODEL_PRICE_RATIOS = [
    ("flagship", "旗舰档中美价格比"),
    ("volume", "走量档中美价格比"),
    ("reasoning", "推理档中美价格比"),
]


def build_metrics():
    rows = []
    metric_names = dict(EDGAR_METRIC_NAMES)
    for ticker, cik, cname in EDGAR_COMPANIES:
        for suffix in EDGAR_METRIC_OVERRIDES.get(ticker, tuple(metric_names)):
            rows.append((
                "edgar:%s:%s" % (ticker, suffix),
                "%s(%s) %s" % (cname, ticker, metric_names[suffix]),
                "USD", "edgar",
                {"ticker": ticker, "cik": cik, "cname": cname, "metric": suffix},
            ))
    for ticker, label in YF_PRICE_TICKERS:
        rows.append(("px:%s" % ticker, label, "local_ccy", "yf_price", {"ticker": ticker}))
    # yfinance 季度财报（EDGAR 覆盖不到的公司）
    for ticker, cname, with_capex in YF_FINANCIAL_COMPANIES:
        unit = "HKD" if ticker.endswith(".HK") else "KRW"
        fin_rows = {"Total Revenue": "revenue", "Gross Profit": "gross_profit"}
        cf_rows = {"Capital Expenditure": "capex"} if with_capex else {}
        params = {"ticker": ticker, "cname": cname, "rows": fin_rows, "cf_rows": cf_rows}
        for suffix, mname in (("revenue", "营业收入(单季)"), ("gross_profit", "毛利(单季)")):
            rows.append(("yf:%s:%s" % (ticker, suffix), "%s(%s) %s" % (cname, ticker, mname),
                         unit, "yf_financials", params))
        if with_capex:
            rows.append(("yf:%s:capex" % ticker, "%s(%s) 资本开支(单季,现金流口径)" % (cname, ticker),
                         unit, "yf_financials", params))
    # EDGAR 10-Q 分部收入（C4/C2 精确口径）
    for ticker, cik, suffix, seg_name, report_re, segment, metric_label in EDGAR_SEGMENTS:
        rows.append((
            "seg:%s:%s" % (ticker, suffix),
            "%s 分部收入(单季)" % seg_name,
            "USD(百万)", "edgar_segment",
            {"ticker": ticker, "cik": cik, "report_re": report_re,
             "segment": segment, "metric_label": metric_label},
        ))
    # TWSE OpenAPI 月营收
    rows.append(("twse:2330:monthly_revenue", "台积电(2330) 月营收", "TWD(千元)", "twse_monthly",
                 {"code": "2330", "cname": "台积电"}))
    # 主流模型 API 价格（C5/F2）+ 中美背离比率衍生指标
    for model_id, label, tier, camp in MODEL_PRICE_WATCH:
        rows.append((
            "price:%s:blended" % model_id,
            "%s API混合价(3:1)" % label,
            "USD/M tokens", "model_price",
            {"model_id": model_id, "tier": tier, "camp": camp},
        ))
    for tier, label in MODEL_PRICE_RATIOS:
        rows.append((
            "price:ratio:%s" % tier, label,
            "倍", "model_price",
            {"ratio": True, "tier": tier},
        ))
    return rows


# ---- C1-C10 / F1-F5 完整定义 + 2026-07-29 基线当前值与状态 ----
SIGNALS = [
    # (id, layer, name, watch, source, trigger_cond, current_value, status, updated_at, note)
    ("C1", "upstream", "存储合约价", "DRAM/NAND 合约价环比转跌",
     "TrendForce 公开摘要；美光/海力士/三星季报毛利率",
     "合约价连续 2 个月环比下跌", "上行中", "反向", "2026-07-29", ""),
    ("C2", "upstream", "算力供需", "英伟达数据中心毛利率、GPU 交期、台积电 CoWoS 扩产",
     "英伟达/台积电季报",
     "英伟达毛利率环比明显下滑 或 交期回归正常", "供需偏紧", "反向", "2026-07-29", ""),
    ("C3", "upstream", "上游 Capex", "三星/海力士/美光资本开支指引",
     "各公司季报",
     "大幅上修（1-2 年后价格必跌的前奏）", "—", "未验证", "2026-07-29", ""),
    ("C4", "profit", "云厂商剪刀差（最关键）", "云/AI 收入增速 vs Capex 增速",
     "微软、谷歌、亚马逊、阿里季报",
     "收入增速重新反超 Capex 增速", "未反转", "未验证", "2026-07-29", ""),
    ("C5", "profit", "推理成本", "主流模型 API 单价下降曲线",
     "OpenAI/DeepSeek 等定价公告",
     "保持数量级下降即为持续验证", "持续下降中", "验证中", "2026-07-29", ""),
    ("C6", "profit", "AI 提价能力", "Copilot 席位数/续费率；金山办公、Salesforce 类 ARPU",
     "各公司季报",
     "提价且留存不降", "待填", "未验证", "2026-07-29", ""),
    ("C7", "profit", "下游指数相对强弱", "软件/中概互联指数相对纳指的强弱拐点",
     "Wind：159852、513050 vs 159509",
     "下游指数连续一个季度跑赢上游指数", "下游持续跑输", "反向", "2026-07-29", ""),
    ("C8", "platform", "平台 vs 应用增速差", "Meta/谷歌/腾讯广告收入增速 vs 纯 AI 应用公司增速",
     "季报对比",
     "平台增速持续 ≥ 应用公司", "平台强", "验证中", "2026-07-29", ""),
    ("C9", "platform", "中国平台 AI 收入", "阿里云 AI 相关收入增速、腾讯广告 AI 驱动占比",
     "阿里/腾讯季报",
     "保持高增长且不降速", "—", "未验证", "2026-07-29", ""),
    ("C10", "platform", "应用层毛利率", "Palantir、国内 AI 应用公司毛利率",
     "季报",
     "持续被压缩 → 归属逻辑成立（利空纯应用股，利好平台）", "—", "未验证", "2026-07-29", ""),
    ("F1", "falsify", "Capex 压制收入", "Capex 增速连续 4 个季度压制收入增速且无收敛（军备竞赛失控，平台两头受损）",
     "四大云厂商季报",
     "出现即触发", "无", "未触发", "2026-07-29", ""),
    ("F2", "falsify", "推理成本停滞", "推理成本下降曲线明显减速/停滞（下游利润改善的物理基础消失）",
     "API 定价跟踪",
     "出现即触发", "无", "未触发", "2026-07-29", ""),
    ("F3", "falsify", "只讲故事不给数字", "平台 AI 货币化连续多季度只讲故事不给数字（变现不是生意）",
     "季报管理层口径",
     "出现即触发", "无", "未触发", "2026-07-29", ""),
    ("F4", "falsify", "上游紧张超预期", "存储/算力供不应求持续超预期，如 2 年后仍无缓解（上游趋同时间表大幅后移）",
     "C1-C3 反向",
     "出现即触发", "无", "未触发", "2026-07-29", ""),
    ("F5", "falsify", "监管/地缘变化", "监管/地缘重大变化：ADR 退市风险重燃、出口管制升级（中国平台持仓的独立风险）",
     "新闻跟踪",
     "出现即触发", "无", "未触发", "2026-07-29", ""),
]

OVERVIEW = (
    "未开始", "存储上行周期延续（长协锁价、HBM 产能偏紧）；半导体材料设备ETF 159516 今年 +73%",
    "未兑现", "下游指数全线下跌：软件 159852 今年 -17.6%、游戏 159869 -22.6%、中概互联 513050 -22.7%；唯一例外消费电子 +15.9%",
    "部分验证", "平台型强于纯应用：纳指科技 +10.0% vs A股软件 -17.6%；标普500 +4.9% vs 软件/游戏 -20% 上下",
    "上游极端拥挤", "100055（存储主题主动基金）Q2 单季 +76%，单季净申购 23 亿份后限购——上游交易已高度拥挤",
    "red",
    "当前处于“上游拥挤、下游失血”阶段，符合判断的前半段；建仓条件尚不满足，处于等待期。",
)

POOL = [
    ("易方达中概互联网ETF及联接", "513050（场外联接更优）", "QDII", "中国平台，腾讯+阿里约半仓", "场内常溢价，长期建仓走场外"),
    ("天弘中美互联网", "009225", "QDII 场外", "中美两边互联网平台", "规模小，注意流动性"),
    ("纳指科技ETF及联接", "159509", "QDII", "美股平台，纯度最高", "溢价风险同上"),
    ("纳指100ETF及联接", "513100 / 159941", "QDII", "美股平台，更均衡", "—"),
    ("博时标普500ETF及联接", "513500", "QDII", "更宽的底仓选择", "科技权重约三成"),
    ("恒生科技/恒生互联网", "513180 / 513330", "QDII", "港股平台", "波动大于中概互联"),
]

THESIS = """一、核心判断（Thesis）

1. 上游趋同：算力/存储等上游环节的超额利润会随供给释放而降低（存储先趋同，算力芯片后趋同）
2. 下游兑现：AI 应用是最终让用户感知变化并获益的环节，会逐渐产生利润
3. 利润归属平台：应用层利润主要流向有分发、数据和工作流壁垒的平台公司，而非纯应用公司
4. 推论：建仓标的选择“选对公司纯度不够”（中概互联/纳指类），不选“选对赛道选错公司”（A股软件/游戏类）

操作纪律：
- 证实信号充分 → 开始建仓
- 证实信号不充分 / 证伪信号充分 → 等待，或修正判断本身
- 本人为长期投资者，3 年属短周期，不为短期波动所动，只对信号变动作反应"""

RULES = """建仓触发规则

- 绿灯（开始建仓）：C4 剪刀差反转 + C1 或 C2 至少一个确认 + 无 F1/F2 触发
- 黄灯（小额试探）：C4 未反转，但 C5/C6/C9 连续两个季度验证 + 下游指数相对强弱拐点（C7）出现
- 红灯（等待/修正判断）：F1/F2/F3 任一触发；或 C1-C3 全部反向运行超过 4 个季度

避免：A股软件/游戏/机器人主题 ETF（选对赛道选错公司）、100055 类存储主题基金（上游拥挤交易，与判断方向相反）。"""

# 第一条观测记录（2026-07-29 基线）的信号快照
INITIAL_SNAPSHOT = {
    "C1": "上行", "C2": "偏紧", "C3": "—", "C4": "未反转", "C5": "验证",
    "C6": "—", "C7": "下游输", "C8": "平台强", "C9": "—", "C10": "—",
    "F1": "无", "F2": "无", "F3": "无", "F4": "无", "F5": "无",
}

THEME = {
    "id": "ai-downstream",
    "name": "AI 下游应用",
    "description": "AI 应用终将产生利润、利润归属平台：跟踪证实/证伪信号，辅助长期建仓决策",
    "metrics": build_metrics(),
    "signals": SIGNALS,
    "overview": OVERVIEW,
    "pool": POOL,
    "pages": {"thesis": THESIS, "rules": RULES},
    "initial_observation": ("2026-07-29", "red", INITIAL_SNAPSHOT, "基线建立"),
}
