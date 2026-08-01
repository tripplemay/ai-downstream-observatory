# 投资观测台

多主题的投资信号观测工作台：每个主题以一套判断框架（thesis）为前提，持续跟踪证实/证伪信号，
由 AI 定时自动拉取公开数据、更新信号状态、生成分析报告，辅助长期建仓决策。
当前主题：AI 下游应用（AI 下游应用终将产生利润、利润归属平台；C1–C10 / F1–F5）。

> 个人研究工具，所有内容不构成投资建议。

## 功能

- **多主题**：主题为独立判断体系（信号、thesis、标的池、报告各自隔离）；跨主题首页 + 侧栏切换
- **总览**：红黄绿信号灯 + 三层判断状态 + 操作建议 + 最近自动运行
- **信号管理**：证实/证伪信号的状态维护，变更留痕
- **数据快照**：全局指标仓库（SEC EDGAR 季报与 10-Q 分部数据、Yahoo Finance 行情与财报、TWSE 月营收），按主题订阅 + 趋势图
- **规则引擎**：可量化信号（C4 剪刀差、C7 相对强弱、F1 压制、C5/F2 推理成本等）按定量规则确定性判定，数据落库即评估
- **AI 报告**：月度纪要、季度深度分析（复核规则判定 + 定性信号判定 + 操作建议 + 人工核查清单）
- **邮件告警**：灯号变化、信号状态变化时推送（`config/alerts.json`，参考 `config/alerts.example.json`）
- **观测记录 / 判断与规则 / 标的池**：全在线编辑

## 架构

```
scheduler(容器内)
   → worker/fetch_data.py   数据采集（按全部启用主题的指标订阅并集，写入全局 snapshots 仓库）
   → worker/rules.py        规则引擎（定量信号确定性判定）
   → worker/analyze.py      AIGC 网关模型逐主题分析（OpenAI 兼容接口，prompt 注入主题 thesis/rules）
   → worker/notify.py       邮件告警（灯号/信号变化）
   → SQLite (data/observatory.db)
   → Next.js (standalone)   Web 呈现（宿主 nginx 反代 + certbot TLS）
```

分层约定：数据层（metrics 注册表 + snapshots 仓库）全局共享、主题无感知；判断层
（signals/overview/pool/pages/observations/ai_reports）按 theme_id 隔离；
`theme_metrics` 订阅表是两层之间唯一的连接。

## 新增主题

1. 在 `worker/themes/` 下复制 `ai_downstream.py` 为新模块，填写主题定义
   （id/name/description、指标订阅 metrics、signals、overview、pool、pages、initial_observation）；
2. 在 `worker/themes/__init__.py` 的 `ALL_THEMES` 登记；
3. 运行任意 worker（如 `python worker/fetch_data.py`）即自动灌库（幂等），Web 端自动出现新主题。

## 本地开发

```bash
cp config/gateway.example.json config/gateway.json  # 填入你的网关信息（worker 用）
cd web && npm ci && npm run dev                      # http://localhost:3000
```

技术栈：Next.js 15（App Router）+ React + TypeScript + shadcn/ui + Tailwind + better-sqlite3（web/ 目录）；
采集与分析 worker 为 Python（worker/ 目录，db.py 为其共享数据层）。

## Docker 部署（VPS）

```bash
cp config/gateway.example.json config/gateway.json  # 填入网关信息
docker compose up -d --build
```

域名与 TLS：VPS 宿主 nginx 反代（模板 `deploy/nginx/etf.vpanel.cc.conf`，含安装步骤注释），certbot 签发证书。web 容器只监听 127.0.0.1:5051。

### 从单主题旧版本升级（数据库迁移）

旧库（无 themes 表）需先迁移再启动新版容器：

```bash
docker compose down
.venv/bin/python worker/migrate_multi_theme.py   # 自动备份并迁移 data/observatory.db（幂等）
docker compose up -d --build
```

VPS 上无 .venv 时可先在本地按同版本代码迁移好库文件再上传，或临时 `python3 worker/migrate_multi_theme.py`
（脚本只依赖标准库）。

## 定时任务

- 容器内 `worker/scheduler.py`：每日 16:35 行情采集 + 规则引擎（daily）；每月 11 日月度快照；
  2/5/8/11 月 15 日季度核对
- 手动执行：`./jobs/run_job.sh daily|monthly|quarterly`，日志 `data/jobs.log`
- 邮件告警：复制 `config/alerts.example.json` 为 `config/alerts.json` 填入 SMTP 信息并置
  `enabled: true`（已 gitignore）；`python worker/notify.py --test` 验证

## CI/CD

push 到 `main` → GitHub Actions 语法检查 → SSH 到 VPS `git reset --hard + docker compose up -d --build`。
需要在仓库 Secrets 配置：`VPS_HOST`、`VPS_USER`、`VPS_SSH_KEY`、`VPS_PATH`。

## 安全说明

`config/gateway.json`（AI 网关密钥）、`config/alerts.json`（SMTP 密钥）与 `data/`（个人数据）均已 gitignore，不会进入仓库与镜像层。
