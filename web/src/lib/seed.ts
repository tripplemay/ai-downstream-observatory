/** 建表与种子数据 — 逐条移植自根目录 db.py（多主题基线 2026-08-01）。
 * 仅当 themes 表为空时灌入种子；与 worker 端 db.init_db() 行为一致。 */
import type Database from "better-sqlite3";

export const LAYERS: Array<[string, string]> = [
  ["upstream", "第一层：上游趋同（判断的前提）"],
  ["profit", "第二层：下游产生利润（核心判断）"],
  ["platform", "第三层：利润归属平台（标的选择依据）"],
  ["falsify", "证伪信号（出现则暂停/修正判断）"],
];

export const CONFIRM_STATUSES = ["未验证", "验证中", "已验证", "反向"];
export const FALSIFY_STATUSES = ["未触发", "已触发"];

export function validStatuses(layer: string): string[] {
  return layer === "falsify" ? FALSIFY_STATUSES : CONFIRM_STATUSES;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS metrics (
    metric_key TEXT PRIMARY KEY,
    label TEXT DEFAULT '',
    unit TEXT DEFAULT '',
    kind TEXT NOT NULL,
    params TEXT DEFAULT '{}',
    enabled INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS theme_metrics (
    theme_id TEXT NOT NULL,
    metric_key TEXT NOT NULL,
    PRIMARY KEY (theme_id, metric_key)
);
CREATE TABLE IF NOT EXISTS signals (
    theme_id TEXT NOT NULL,
    id TEXT NOT NULL,
    layer TEXT NOT NULL,
    name TEXT NOT NULL,
    watch TEXT DEFAULT '',
    source TEXT DEFAULT '',
    trigger_cond TEXT DEFAULT '',
    current_value TEXT DEFAULT '',
    status TEXT DEFAULT '',
    updated_at TEXT DEFAULT '',
    note TEXT DEFAULT '',
    PRIMARY KEY (theme_id, id)
);
CREATE TABLE IF NOT EXISTS signal_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    theme_id TEXT NOT NULL,
    signal_id TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT,
    old_value TEXT,
    new_value TEXT,
    note TEXT,
    changed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    theme_id TEXT NOT NULL,
    date TEXT NOT NULL,
    light TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS overview (
    theme_id TEXT PRIMARY KEY,
    layer1_status TEXT, layer1_evidence TEXT,
    layer2_status TEXT, layer2_evidence TEXT,
    layer3_status TEXT, layer3_evidence TEXT,
    sentiment TEXT, sentiment_evidence TEXT,
    light TEXT, conclusion TEXT,
    action TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    theme_id TEXT NOT NULL,
    name TEXT NOT NULL,
    code TEXT DEFAULT '',
    channel TEXT DEFAULT '',
    position TEXT DEFAULT '',
    note TEXT DEFAULT '',
    health TEXT DEFAULT '正常'
);
CREATE TABLE IF NOT EXISTS pages (
    theme_id TEXT NOT NULL,
    key TEXT NOT NULL,
    content TEXT DEFAULT '',
    PRIMARY KEY (theme_id, key)
);
CREATE TABLE IF NOT EXISTS snapshots (
    metric_key TEXT NOT NULL,
    label TEXT DEFAULT '',
    period_date TEXT NOT NULL,
    value REAL,
    unit TEXT DEFAULT '',
    source TEXT DEFAULT '',
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (metric_key, period_date)
);
CREATE TABLE IF NOT EXISTS ai_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    theme_id TEXT NOT NULL,
    run_date TEXT NOT NULL,
    run_type TEXT NOT NULL,
    light TEXT DEFAULT '',
    narrative TEXT DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS etf_universe (
    code TEXT PRIMARY KEY,
    name TEXT DEFAULT '',
    cat TEXT DEFAULT '',
    turnover REAL, mktcap REAL,
    active INTEGER DEFAULT 1,
    index_code TEXT DEFAULT '',
    index_name TEXT DEFAULT '',
    updated_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS advice (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    basket_json TEXT NOT NULL,
    reason TEXT DEFAULT '',
    created_at TEXT NOT NULL
);
`;

const THEME_ID = "ai-downstream";

// (id, name, description, enabled, created_at)
const SEED_THEME = [
  THEME_ID,
  "AI 下游应用",
  "AI 应用终将产生利润、利润归属平台：跟踪证实/证伪信号，辅助长期建仓决策",
  1,
  "2026-07-29 00:00:00",
] as const;

// (id, layer, name, watch, source, trigger_cond, current_value, status, updated_at, note)
const SEED_SIGNALS: string[][] = [
  ["C1", "upstream", "存储合约价", "DRAM/NAND 合约价环比转跌",
    "TrendForce 公开摘要；美光/海力士/三星季报毛利率",
    "合约价连续 2 个月环比下跌", "上行中", "反向", "2026-07-29", ""],
  ["C2", "upstream", "算力供需", "英伟达数据中心毛利率、GPU 交期、台积电 CoWoS 扩产",
    "英伟达/台积电季报",
    "英伟达毛利率环比明显下滑 或 交期回归正常", "供需偏紧", "反向", "2026-07-29", ""],
  ["C3", "upstream", "上游 Capex", "三星/海力士/美光资本开支指引",
    "各公司季报",
    "大幅上修（1-2 年后价格必跌的前奏）", "—", "未验证", "2026-07-29", ""],
  ["C4", "profit", "云厂商剪刀差（最关键）", "云/AI 收入增速 vs Capex 增速",
    "微软、谷歌、亚马逊、阿里季报",
    "收入增速重新反超 Capex 增速", "未反转", "未验证", "2026-07-29", ""],
  ["C5", "profit", "推理成本", "主流模型 API 单价下降曲线",
    "OpenAI/DeepSeek 等定价公告",
    "保持数量级下降即为持续验证", "持续下降中", "验证中", "2026-07-29", ""],
  ["C6", "profit", "AI 提价能力", "Copilot 席位数/续费率；金山办公、Salesforce 类 ARPU",
    "各公司季报",
    "提价且留存不降", "待填", "未验证", "2026-07-29", ""],
  ["C7", "profit", "下游指数相对强弱", "软件/中概互联指数相对纳指的强弱拐点",
    "Wind：159852、513050 vs 159509",
    "下游指数连续一个季度跑赢上游指数", "下游持续跑输", "反向", "2026-07-29", ""],
  ["C8", "platform", "平台 vs 应用增速差", "Meta/谷歌/腾讯广告收入增速 vs 纯 AI 应用公司增速",
    "季报对比",
    "平台增速持续 ≥ 应用公司", "平台强", "验证中", "2026-07-29", ""],
  ["C9", "platform", "中国平台 AI 收入", "阿里云 AI 相关收入增速、腾讯广告 AI 驱动占比",
    "阿里/腾讯季报",
    "保持高增长且不降速", "—", "未验证", "2026-07-29", ""],
  ["C10", "platform", "应用层毛利率", "Palantir、国内 AI 应用公司毛利率",
    "季报",
    "持续被压缩 → 归属逻辑成立（利空纯应用股，利好平台）", "—", "未验证", "2026-07-29", ""],
  ["F1", "falsify", "Capex 压制收入", "Capex 增速连续 4 个季度压制收入增速且无收敛（军备竞赛失控，平台两头受损）",
    "四大云厂商季报",
    "出现即触发", "无", "未触发", "2026-07-29", ""],
  ["F2", "falsify", "推理成本停滞", "推理成本下降曲线明显减速/停滞（下游利润改善的物理基础消失）",
    "API 定价跟踪",
    "出现即触发", "无", "未触发", "2026-07-29", ""],
  ["F3", "falsify", "只讲故事不给数字", "平台 AI 货币化连续多季度只讲故事不给数字（变现不是生意）",
    "季报管理层口径",
    "出现即触发", "无", "未触发", "2026-07-29", ""],
  ["F4", "falsify", "上游紧张超预期", "存储/算力供不应求持续超预期，如 2 年后仍无缓解（上游趋同时间表大幅后移）",
    "C1-C3 反向",
    "出现即触发", "无", "未触发", "2026-07-29", ""],
  ["F5", "falsify", "监管/地缘变化", "监管/地缘重大变化：ADR 退市风险重燃、出口管制升级（中国平台持仓的独立风险）",
    "新闻跟踪",
    "出现即触发", "无", "未触发", "2026-07-29", ""],
];

const SEED_OVERVIEW = [
  THEME_ID,
  "未开始", "存储上行周期延续（长协锁价、HBM 产能偏紧）；半导体材料设备ETF 159516 今年 +73%",
  "未兑现", "下游指数全线下跌：软件 159852 今年 -17.6%、游戏 159869 -22.6%、中概互联 513050 -22.7%；唯一例外消费电子 +15.9%",
  "部分验证", "平台型强于纯应用：纳指科技 +10.0% vs A股软件 -17.6%；标普500 +4.9% vs 软件/游戏 -20% 上下",
  "上游极端拥挤", "100055（存储主题主动基金）Q2 单季 +76%，单季净申购 23 亿份后限购——上游交易已高度拥挤",
  "red",
  "当前处于“上游拥挤、下游失血”阶段，符合判断的前半段；建仓条件尚不满足，处于等待期。",
];

const SEED_POOL: string[][] = [
  ["易方达中概互联网ETF及联接", "513050（场外联接更优）", "QDII", "中国平台，腾讯+阿里约半仓", "场内常溢价，长期建仓走场外"],
  ["天弘中美互联网", "009225", "QDII 场外", "中美两边互联网平台", "规模小，注意流动性"],
  ["纳指科技ETF及联接", "159509", "QDII", "美股平台，纯度最高", "溢价风险同上"],
  ["纳指100ETF及联接", "513100 / 159941", "QDII", "美股平台，更均衡", "—"],
  ["博时标普500ETF及联接", "513500", "QDII", "更宽的底仓选择", "科技权重约三成"],
  ["恒生科技/恒生互联网", "513180 / 513330", "QDII", "港股平台", "波动大于中概互联"],
];

const SEED_THESIS = `一、核心判断（Thesis）

1. 上游趋同：算力/存储等上游环节的超额利润会随供给释放而降低（存储先趋同，算力芯片后趋同）
2. 下游兑现：AI 应用是最终让用户感知变化并获益的环节，会逐渐产生利润
3. 利润归属平台：应用层利润主要流向有分发、数据和工作流壁垒的平台公司，而非纯应用公司
4. 推论：建仓标的选择“选对公司纯度不够”（中概互联/纳指类），不选“选对赛道选错公司”（A股软件/游戏类）

操作纪律：
- 证实信号充分 → 开始建仓
- 证实信号不充分 / 证伪信号充分 → 等待，或修正判断本身
- 本人为长期投资者，3 年属短周期，不为短期波动所动，只对信号变动作反应`;

const SEED_RULES = `建仓触发规则

- 绿灯（开始建仓）：C4 剪刀差反转 + C1 或 C2 至少一个确认 + 无 F1/F2 触发
- 黄灯（小额试探）：C4 未反转，但 C5/C6/C9 连续两个季度验证 + 下游指数相对强弱拐点（C7）出现
- 红灯（等待/修正判断）：F1/F2/F3 任一触发；或 C1-C3 全部反向运行超过 4 个季度

避免：A股软件/游戏/机器人主题 ETF（选对赛道选错公司）、100055 类存储主题基金（上游拥挤交易，与判断方向相反）。`;

const SEED_SNAPSHOT: Record<string, string> = {
  C1: "上行", C2: "偏紧", C3: "—", C4: "未反转", C5: "验证",
  C6: "—", C7: "下游输", C8: "平台强", C9: "—", C10: "—",
  F1: "无", F2: "无", F3: "无", F4: "无", F5: "无",
};

/** 仅当 themes 为空时灌入种子数据（与 db.init_db 一致） */
export function seedIfEmpty(db: Database.Database) {
  const row = db.prepare("SELECT COUNT(*) AS c FROM themes").get() as { c: number };
  if (row.c > 0) return;
  const insertSignal = db.prepare(
    "INSERT INTO signals (theme_id, id, layer, name, watch, source, trigger_cond, current_value, status, updated_at, note)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  );
  const insertPool = db.prepare(
    "INSERT INTO pool (theme_id, name, code, channel, position, note) VALUES (?,?,?,?,?,?)"
  );
  const insertPage = db.prepare("INSERT INTO pages (theme_id, key, content) VALUES (?,?,?)");
  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO themes (id, name, description, enabled, created_at) VALUES (?,?,?,?,?)"
    ).run(...SEED_THEME);
    for (const s of SEED_SIGNALS) insertSignal.run(THEME_ID, ...s);
    db.prepare(
      "INSERT INTO overview (theme_id, layer1_status, layer1_evidence, layer2_status, layer2_evidence," +
        " layer3_status, layer3_evidence, sentiment, sentiment_evidence, light, conclusion)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run(...SEED_OVERVIEW);
    for (const p of SEED_POOL) insertPool.run(THEME_ID, ...p);
    insertPage.run(THEME_ID, "thesis", SEED_THESIS);
    insertPage.run(THEME_ID, "rules", SEED_RULES);
    db.prepare(
      "INSERT INTO observations (theme_id, date, light, snapshot, note, created_at) VALUES (?,?,?,?,?,?)"
    ).run(THEME_ID, "2026-07-29", "red", JSON.stringify(SEED_SNAPSHOT), "基线建立", "2026-07-29 00:00:00");
  });
  tx();
}
