/** 只读数据访问（Server Components 用）。除 snapshots 全局共享外，均按 theme_id 过滤。 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db";
import { LAYERS } from "./seed";

export interface Theme {
  id: string;
  name: string;
  description: string;
  enabled: number;
  created_at: string;
  type: string; // observation | strategy
}

export interface Signal {
  id: string;
  layer: string;
  name: string;
  watch: string;
  source: string;
  trigger_cond: string;
  current_value: string;
  status: string;
  updated_at: string;
  note: string;
}

export interface Overview {
  theme_id: string;
  layer1_status: string;
  layer1_evidence: string;
  layer2_status: string;
  layer2_evidence: string;
  layer3_status: string;
  layer3_evidence: string;
  sentiment: string;
  sentiment_evidence: string;
  light: string;
  conclusion: string;
  action: string;
}

export interface Observation {
  id: number;
  date: string;
  light: string;
  snapshot: string;
  note: string;
  created_at: string;
}

export interface PoolItem {
  id: number;
  name: string;
  code: string;
  channel: string;
  position: string;
  note: string;
  health: string;
}

export interface AiReport {
  id: number;
  run_date: string;
  run_type: string;
  light: string;
  narrative: string;
  created_at: string;
}

export interface SnapshotRow {
  metric_key: string;
  label: string;
  period_date: string;
  value: number;
  unit: string;
  source: string;
  fetched_at: string;
}

export interface MetricGroup {
  key: string;
  label: string;
  unit: string;
  source: string;
  points: Array<{ d: string; v: number }>;
  rows: Array<{ d: string; v: number; ts: string }>;
}

export function getThemes(): Theme[] {
  return getDb()
    .prepare("SELECT * FROM themes WHERE enabled = 1 ORDER BY rowid")
    .all() as Theme[];
}

export function getTheme(slug: string): Theme | null {
  return (getDb().prepare("SELECT * FROM themes WHERE id = ?").get(slug) as Theme) ?? null;
}

export function getSignals(themeId: string): Signal[] {
  return getDb()
    .prepare("SELECT * FROM signals WHERE theme_id = ? ORDER BY rowid")
    .all(themeId) as Signal[];
}

export function getSignalGroups(themeId: string) {
  const rows = getSignals(themeId);
  return LAYERS.map(([key, label]) => ({
    key,
    label,
    signals: rows.filter((r) => r.layer === key),
  }));
}

export function getOverview(themeId: string): Overview | null {
  return (
    (getDb().prepare("SELECT * FROM overview WHERE theme_id = ?").get(themeId) as Overview) ??
    null
  );
}

export function getObservations(themeId: string): Observation[] {
  return getDb()
    .prepare("SELECT * FROM observations WHERE theme_id = ? ORDER BY date DESC, id DESC")
    .all(themeId) as Observation[];
}

export function getLastObservation(themeId: string): Observation | null {
  return (
    (getDb()
      .prepare("SELECT * FROM observations WHERE theme_id = ? ORDER BY date DESC, id DESC LIMIT 1")
      .get(themeId) as Observation) ?? null
  );
}

export function getStatusCounts(themeId: string): Record<string, number> {
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS c FROM signals WHERE theme_id = ? GROUP BY status")
    .all(themeId) as Array<{ status: string; c: number }>;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = r.c;
  return counts;
}

export function getPool(themeId: string): PoolItem[] {
  return getDb()
    .prepare("SELECT * FROM pool WHERE theme_id = ? ORDER BY id")
    .all(themeId) as PoolItem[];
}

export function getPages(themeId: string): Record<string, string> {
  const rows = getDb().prepare("SELECT * FROM pages WHERE theme_id = ?").all(themeId) as Array<{
    key: string;
    content: string;
  }>;
  const pages: Record<string, string> = {};
  for (const r of rows) pages[r.key] = r.content;
  return pages;
}

export function getReports(themeId: string): AiReport[] {
  return getDb()
    .prepare("SELECT * FROM ai_reports WHERE theme_id = ? ORDER BY id DESC")
    .all(themeId) as AiReport[];
}

export function getReport(themeId: string, id: number): AiReport | null {
  return (
    (getDb()
      .prepare("SELECT * FROM ai_reports WHERE theme_id = ? AND id = ?")
      .get(themeId, id) as AiReport) ?? null
  );
}

export function getLastReport(themeId: string): AiReport | null {
  return (
    (getDb()
      .prepare("SELECT * FROM ai_reports WHERE theme_id = ? ORDER BY id DESC LIMIT 1")
      .get(themeId) as AiReport) ?? null
  );
}

/** 该主题订阅的指标快照（snapshots 全局共享，经 theme_metrics 关联过滤） */
function getSnapshots(themeId: string): SnapshotRow[] {
  return getDb()
    .prepare(
      "SELECT s.* FROM snapshots s" +
        " JOIN theme_metrics tm ON tm.metric_key = s.metric_key" +
        " WHERE tm.theme_id = ? ORDER BY s.metric_key, s.period_date"
    )
    .all(themeId) as SnapshotRow[];
}

function metricRank(key: string): [number, string] {
  if (key.startsWith("edgar:")) return [0, key];
  if (key.startsWith("yf:") || key.startsWith("twse:")) return [1, key];
  return [2, key];
}

export function getMetricGroups(themeId: string): MetricGroup[] {
  const rows = getSnapshots(themeId);
  const map = new Map<string, MetricGroup>();
  for (const r of rows) {
    let m = map.get(r.metric_key);
    if (!m) {
      m = {
        key: r.metric_key,
        label: r.label,
        unit: r.unit,
        source: r.source,
        points: [],
        rows: [],
      };
      map.set(r.metric_key, m);
    }
    m.points.push({ d: r.period_date, v: r.value });
    m.rows.push({ d: r.period_date, v: r.value, ts: r.fetched_at });
  }
  const groups = [...map.values()].sort((a, b) => {
    const ra = metricRank(a.key);
    const rb = metricRank(b.key);
    return ra[0] - rb[0] || (ra[1] < rb[1] ? -1 : 1);
  });
  for (const m of groups) m.rows = m.rows.slice(-10).reverse();
  return groups;
}

export function getSeries(metricKey: string): Array<{ d: string; v: number }> {
  const rows = getDb()
    .prepare("SELECT period_date, value FROM snapshots WHERE metric_key = ? ORDER BY period_date")
    .all(metricKey) as Array<{ period_date: string; value: number }>;
  return rows.map((r) => ({ d: r.period_date, v: r.value }));
}

/** 云厂商剪刀差：最近季 capex/收入 同比增速（需要 5 个季度数据）。主题一专属图表。 */
export function getScissorData(themeId: string) {
  if (themeId !== "ai-downstream") return null;
  const companies: Array<[string, string]> = [
    ["MSFT", "微软"],
    ["GOOGL", "谷歌"],
    ["AMZN", "亚马逊"],
  ];
  const out: Array<{
    ticker: string;
    name: string;
    period: string;
    capexYoY: number | null;
    revenueYoY: number | null;
    capex: Array<{ d: string; v: number }>;
    revenue: Array<{ d: string; v: number }>;
  }> = [];
  for (const [ticker, name] of companies) {
    const capex = getSeries(`edgar:${ticker}:capex`);
    const revenue = getSeries(`edgar:${ticker}:revenue`);
    const yoy = (s: Array<{ d: string; v: number }>) =>
      s.length >= 5 && s[s.length - 5].v !== 0
        ? s[s.length - 1].v / s[s.length - 5].v - 1
        : null;
    out.push({
      ticker,
      name,
      period: capex.length ? capex[capex.length - 1].d : "",
      capexYoY: yoy(capex),
      revenueYoY: yoy(revenue),
      capex: capex.slice(-8),
      revenue: revenue.slice(-8),
    });
  }
  return out;
}

/** 上下游强弱：下游 ETF vs 上游/平台 ETF 近 3 个月涨跌。主题一专属图表。 */
export function getStrengthData(themeId: string) {
  if (themeId !== "ai-downstream") return null;
  const tickers: Array<[string, string, string]> = [
    ["px:159852.SZ", "软件ETF(159852)", "down"],
    ["px:513050.SS", "中概互联网ETF(513050)", "down"],
    ["px:159509.SZ", "纳指科技ETF(159509)", "up"],
    ["px:^SOX", "费城半导体指数", "up"],
  ];
  return tickers.map(([key, label, side]) => {
    const s = getSeries(key);
    const chg =
      s.length >= 2 && s[0].v !== 0 ? s[s.length - 1].v / s[0].v - 1 : null;
    return { key, label, side, chg, period: s.length ? s[s.length - 1].d : "", series: s };
  });
}

/** 读 data/jobs.log 最后一条 [STATUS] 行（移植自 app.py last_job_status） */
export function lastJobStatus(): string | null {
  const logPath = path.resolve(process.cwd(), "..", "data", "jobs.log");
  try {
    const buf = fs.readFileSync(logPath);
    const tail = buf.subarray(Math.max(0, buf.length - 65536)).toString("utf-8");
    const lines = tail.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes("[STATUS]")) return lines[i].trim();
    }
  } catch {
    /* 日志不存在 */
  }
  return null;
}

/* ---------- 全行业 ETF 轮动（etf-universe 主题） ---------- */

export interface UniverseMonitorRow {
  code: string;
  name: string;
  cat: string;
  mktcap: number | null;
  lastPx: number | null;
  lastPxDate: string;
  mom20: number | null;
  aboveMa200: boolean | null;
  pePct: number | null;
  held: boolean;
  heldWeight: number | null;
}

export interface AdviceBasketItem {
  code: string;
  name: string;
  weight: number;
}

export interface Advice {
  id: number;
  date: string;
  basket: AdviceBasketItem[];
  reason: string;
  created_at: string;
}

interface AdviceRow {
  id: number;
  date: string;
  basket_json: string;
  reason: string;
  created_at: string;
}

function parseAdvice(r: AdviceRow): Advice {
  let basket: AdviceBasketItem[] = [];
  try {
    const raw = JSON.parse(r.basket_json) as AdviceBasketItem[];
    if (Array.isArray(raw)) basket = raw;
  } catch {
    /* 坏 JSON 视为空仓 */
  }
  return { id: r.id, date: r.date, basket, reason: r.reason, created_at: r.created_at };
}

export function getAdviceCurrent(): Advice | null {
  const r = getDb()
    .prepare("SELECT * FROM advice ORDER BY id DESC LIMIT 1")
    .get() as AdviceRow | undefined;
  return r ? parseAdvice(r) : null;
}

export function getAdviceHistory(limit = 50): Advice[] {
  const rows = getDb()
    .prepare("SELECT * FROM advice ORDER BY id DESC LIMIT ?")
    .all(limit) as AdviceRow[];
  return rows.map(parseAdvice);
}

/** 每只 active ETF 最近 210 个交易日的收盘价（窗口函数截取），在 TS 里算动量与 MA200 */
export function getUniverseMonitor(): UniverseMonitorRow[] {
  const db = getDb();
  const universe = db
    .prepare("SELECT * FROM etf_universe WHERE active = 1 ORDER BY code")
    .all() as Array<{
    code: string;
    name: string;
    cat: string;
    mktcap: number | null;
    index_code: string;
  }>;

  const held = new Map<string, number>();
  const current = getAdviceCurrent();
  if (current) for (const b of current.basket) held.set(b.code, b.weight);

  // 各指数 PE 分位最新值（index_code -> pe_pct）
  const pePct = new Map<string, number>();
  const peRows = db
    .prepare(
      "SELECT metric_key, value FROM (" +
        " SELECT metric_key, value, ROW_NUMBER() OVER (PARTITION BY metric_key ORDER BY period_date DESC) rn" +
        " FROM snapshots WHERE metric_key LIKE 'pe_pct:%'" +
        ") WHERE rn = 1"
    )
    .all() as Array<{ metric_key: string; value: number }>;
  for (const r of peRows) pePct.set(r.metric_key.slice("pe_pct:".length), r.value);

  // 收盘价：active 代码每只最近 210 根
  const pxByCode = new Map<string, Array<{ d: string; v: number }>>();
  if (universe.length > 0) {
    const keys = universe.map((u) => `px:${u.code}`);
    const placeholders = keys.map(() => "?").join(",");
    const rows = db
      .prepare(
        "SELECT metric_key, period_date, value FROM (" +
          " SELECT metric_key, period_date, value," +
          " ROW_NUMBER() OVER (PARTITION BY metric_key ORDER BY period_date DESC) rn" +
          ` FROM snapshots WHERE metric_key IN (${placeholders})` +
          ") WHERE rn <= 210 ORDER BY metric_key, rn"
      )
      .all(...keys) as Array<{ metric_key: string; period_date: string; value: number }>;
    for (const r of rows) {
      const code = r.metric_key.slice(3);
      let arr = pxByCode.get(code);
      if (!arr) {
        arr = [];
        pxByCode.set(code, arr);
      }
      arr.push({ d: r.period_date, v: r.value }); // 已按日期倒序
    }
  }

  const out: UniverseMonitorRow[] = universe.map((u) => {
    const px = pxByCode.get(u.code) ?? [];
    const last = px[0] ?? null;
    const mom20 = px.length >= 21 && px[20].v !== 0 ? last!.v / px[20].v - 1 : null;
    let aboveMa200: boolean | null = null;
    if (px.length >= 200 && last) {
      let sum = 0;
      for (let i = 0; i < 200; i++) sum += px[i].v;
      aboveMa200 = last.v >= sum / 200;
    }
    const idx = u.index_code && u.index_code !== "NONE" ? u.index_code : "";
    return {
      code: u.code,
      name: u.name,
      cat: u.cat,
      mktcap: u.mktcap,
      lastPx: last?.v ?? null,
      lastPxDate: last?.d ?? "",
      mom20,
      aboveMa200,
      pePct: idx ? (pePct.get(idx) ?? null) : null,
      held: held.has(u.code),
      heldWeight: held.get(u.code) ?? null,
    };
  });
  out.sort((a, b) => (b.mom20 ?? -Infinity) - (a.mom20 ?? -Infinity));
  return out;
}

/** 建议组合净值 vs 沪深300ETF 基准净值（按日期合并，供对照折线图） */
export function getAdviceNavSeries(): Array<{ d: string; adv: number | null; bm: number | null }> {
  const adv = getSeries("adv:nav");
  const bm = getSeries("bm:nav");
  const map = new Map<string, { d: string; adv: number | null; bm: number | null }>();
  for (const p of adv) map.set(p.d, { d: p.d, adv: p.v, bm: null });
  for (const p of bm) {
    const row = map.get(p.d);
    if (row) row.bm = p.v;
    else map.set(p.d, { d: p.d, adv: null, bm: p.v });
  }
  return [...map.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
}

/* ---------- 策略型主题（type = strategy） ---------- */

export interface StrategyParams {
  id: number;
  params: Record<string, unknown>;
  note: string;
  created_at: string;
}

interface StrategyParamsRow {
  id: number;
  params_json: string;
  note: string;
  created_at: string;
}

function parseStrategyParams(r: StrategyParamsRow): StrategyParams {
  let params: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(r.params_json) as Record<string, unknown>;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) params = raw;
  } catch {
    /* 坏 JSON 视为空参数 */
  }
  return { id: r.id, params, note: r.note, created_at: r.created_at };
}

/** 最新一版策略参数（追加式，最新一条生效） */
export function getStrategyParams(themeId: string): StrategyParams | null {
  const r = getDb()
    .prepare("SELECT * FROM strategy_params WHERE theme_id = ? ORDER BY id DESC LIMIT 1")
    .get(themeId) as StrategyParamsRow | undefined;
  return r ? parseStrategyParams(r) : null;
}

export function getStrategyParamsHistory(themeId: string, limit = 20): StrategyParams[] {
  const rows = getDb()
    .prepare("SELECT * FROM strategy_params WHERE theme_id = ? ORDER BY id DESC LIMIT ?")
    .all(themeId, limit) as StrategyParamsRow[];
  return rows.map(parseStrategyParams);
}

/** 四序列净值对照：实盘建议/基准（近期）+ 回测模拟/回测基准（2020 起全历史），按日期合并 */
export function getNavCompareFull(): Array<{
  d: string;
  adv: number | null;
  bm: number | null;
  sim: number | null;
  simBm: number | null;
}> {
  const keys = [
    ["adv:nav", "adv"],
    ["bm:nav", "bm"],
    ["sim:nav", "sim"],
    ["sim_bm:nav", "simBm"],
  ] as const;
  type Row = { d: string; adv: number | null; bm: number | null; sim: number | null; simBm: number | null };
  const map = new Map<string, Row>();
  const blank = (d: string): Row => ({ d, adv: null, bm: null, sim: null, simBm: null });
  for (const [metric, field] of keys) {
    for (const p of getSeries(metric)) {
      let row = map.get(p.d);
      if (!row) {
        row = blank(p.d);
        map.set(p.d, row);
      }
      row[field] = p.v;
    }
  }
  return [...map.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
}

/** 全市场宽度：站上 200 日线 ETF 占比（最新值 + 近 60 点序列） */
export function getMarketWidth(): {
  latest: { d: string; v: number } | null;
  series: Array<{ d: string; v: number }>;
} {
  const series = getSeries("mkt:width");
  return {
    latest: series.length ? series[series.length - 1] : null,
    series: series.slice(-60),
  };
}
