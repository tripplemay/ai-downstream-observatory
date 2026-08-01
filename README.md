# AI 下游投资观测台

一个自包含的投资信号观测工作台：以"AI 下游应用终将产生利润、利润归属平台"的判断框架为前提，
持续跟踪证实/证伪信号（C1–C10 / F1–F5），由 AI 定时自动拉取公开数据、更新信号状态、生成分析报告，
辅助长期建仓决策。

> 个人研究工具，所有内容不构成投资建议。

## 功能

- **总览**：红黄绿信号灯 + 三层判断状态 + 最近自动运行
- **信号管理**：证实信号（上游趋同/下游利润/平台归属）与证伪信号的状态维护，变更留痕
- **数据快照**：SEC EDGAR（美股季报 capex/收入/毛利）、Yahoo Finance（指数与 ETF 行情）、TWSE（台积电月营收）自动采集 + 趋势图
- **AI 报告**：月度纪要、季度深度分析（信号判定 + 建仓触发条件检查 + 人工核查清单），由 AIGC 网关模型生成
- **观测记录 / 判断与规则 / 标的池**：全在线编辑

## 架构

```
launchd(本地) 或 scheduler(容器)
   → worker/fetch_data.py   公开数据源采集（EDGAR / yfinance / TWSE）
   → worker/analyze.py      AIGC 网关模型分析（OpenAI 兼容接口）
   → SQLite (data/observatory.db)
   → Flask + Gunicorn       Web 呈现（Caddy 反代 + 自动 HTTPS）
```

## 本地开发

```bash
cp config/gateway.example.json config/gateway.json  # 填入你的网关信息
./run.sh                                            # http://127.0.0.1:5051
```

## Docker 部署（VPS）

```bash
cp config/gateway.example.json config/gateway.json  # 填入网关信息
docker compose up -d --build
```

域名与证书：`Caddyfile` 中配置域名后，Caddy 自动签发 HTTPS 证书（需 DNS 指向 VPS 且 80/443 放行）。

## 定时任务

- 容器内 `worker/scheduler.py`：每月 11 日月度快照，2/5/8/11 月 15 日季度核对
- 手动执行：`./jobs/run_job.sh monthly|quarterly`，日志 `data/jobs.log`

## CI/CD

push 到 `main` → GitHub Actions 语法检查 → SSH 到 VPS `git reset --hard + docker compose up -d --build`。
需要在仓库 Secrets 配置：`VPS_HOST`、`VPS_USER`、`VPS_SSH_KEY`、`VPS_PATH`。

## 安全说明

`config/gateway.json`（AI 网关密钥）与 `data/`（个人数据）均已 gitignore，不会进入仓库与镜像层。
