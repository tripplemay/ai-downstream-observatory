# ETF 投资工作台

面向 A 股、港股、美股 ETF 的个人组合工作台：真实事实账本、原件留存、对账、数据质量、估值与收益核算，以及隔离的策略研究和人工决策流程。AI 辅助研究，不代表交易授权；软件正确性不保证持续盈利。

## 设计基线

1. [投资目标与约束模板](docs/01-investment-mandate.md)：在本地填写资金金额、预计到账日期、投资期限和账户约束；计划不等于资金已到账。
2. [产品需求](docs/02-product-requirements.md)：组合、账户、投入计划与人工执行闭环。
3. [策略治理](docs/03-decision-policy.md)：策略、AI、风控、批准与权限边界。
4. [数据与核算](docs/04-data-and-accounting.md)：事实、结算、多币种、收益口径。
5. [架构与迁移](docs/05-architecture-and-migration.md)：版本化新库、旧研究隔离、备份恢复。
6. [验证与验收](docs/06-validation-and-acceptance.md)：工程与投资有效性分别验收。

公开文档定义通用产品规格，不携带个人已确认的资金计划或投资授权。个人约束、账户与资金计划仅在本地填写和保存，不随源码发布；具体目录、Git、Docker 与 CI 边界见 [公开与本地资料规则](docs/publication-privacy.md)。实现和验证证据另行记录，不能把设计规格当成已通过验收；实际账户数据、行情授权、参数批准和异机灾难恢复仍须按对应门槛完成。

## 工程结构

- `web/`：Next.js、认证、Web 唯一真实账本写入入口、附件和操作界面。
- `worker/accounting/`、`market/`、`performance/`、`research/`、`orchestration/`：Decimal 核算、数据批次/估值、收益、研究及持久任务；研究不写真实资金。
- `contracts/v1/`、`migrations/`：共享 JSON Schema 与校验和固定的 SQLite 迁移。
- `data-workbench/etf-workbench.db`：新工作台库；不会隐式创建初始资金或从预算补余额。

资金计划入口为 `/workbench/funding`，支持日期化来源、投入批次、版本/延期及到账、执行事项关联；保存计划不创建现金或下单。实现边界见 [资金计划](docs/funding-plans.md)。账本支持 [证券转入、转出与在途](docs/security-transfers.md)，估值与绩效分离外部资本、历史成本与收益；缺时点、规则或来源时继续阻断，见 [逐流汇率核算](docs/performance-flow-fx.md)。[通用 CSV 导入](docs/csv-import.md) 支持原件留存、不可变映射、逐行重复核对和原子确认；高级界面需明确映射 JSON，尚未认证具体券商原生格式。当前测试与未完成项见 [开发进度](docs/07-implementation-tracker.md)，不据此宣称生产或策略准入完成。
- 原 `data/observatory.db`：旧主题观测/ETF 模拟研究。原库不被新迁移触碰；通过 Online Backup 归档，旧记录不晋升为真实事实。

标的研究入口为 `/workbench/catalog`：按组合保留结构化来源、资料与持仓披露版本，支持分页和最多四个标的比较。披露不完整时显示覆盖率与重叠上下界，不将未知持仓归一化；目录记录不授予交易权限。实现与剩余核验见 [ETF 标的目录](docs/etf-catalog.md)。

## 开发与验证

需要 Node.js 22、Python 3.11+。先安装 Web 依赖，Python 跨语言 fixture 会调用 Node 迁移工具：

```bash
npm --prefix web ci
python3 -m pip install -r requirements-workbench.txt
export WORKBENCH_PYTHON="$(command -v python3)"
export WORKBENCH_TEST_PYTHON="$WORKBENCH_PYTHON"
node --test tests/*/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py' -v
npm --prefix web test
npm --prefix web run typecheck
npm --prefix web run build
npm --prefix web run test:auth:http
npm --prefix web run test:workbench:http -- --no-build
```

上述两个变量均须指向安装了项目 Python 依赖的解释器；推荐先激活隔离虚拟环境。Web、Node 和 HTTP 集成测试均包含跨语言调用，不能仅为独立 Python 测试选择解释器。

本地真实数据开发需显式配置 `WORKBENCH_DB_PATH`、`WORKBENCH_DATA_DIR`、HTTPS `WORKBENCH_ORIGIN`、密码 hash 与会话 secret。缺少数据库/认证配置会失败，不回退创建另一份空库。优先使用隔离 fixture，不把生产数据拷进源码目录。

## Docker 与生产发布

**不要直接在旧部署目录执行 `docker compose up --build`，不要上传本地数据库覆盖生产。**

- 自动 CI：`.github/workflows/ci.yml`，push/PR 只测试，不自动发布。
- 人工发布：`.github/workflows/deploy.yml`，`workflow_dispatch` 输入准确已审 SHA，CI 后进入 `production` 审批环境。
- 发布脚本：`scripts/deploy-workbench.sh` 默认只显示计划，只有 `--execute` 才切换。
- 工具容器：`migrate`、`archive-legacy`、`backup`、`restore`；新目录 UID/GID 10001、0700，文件 0600；秘密使用主机受控文件，不进镜像。
- 失败后保留新事实并进入恢复只读，不用旧备份自动覆盖新库。

完整配置、秘密初始化、实际旧库一致性归档、发布门槛和操作命令见 [生产发布手册](docs/production-release-runbook.md)、[验证记录](docs/production-release-verification.md)、[恢复操作说明](docs/recovery-operations.md)。

Linux Docker 隔离验证：`sudo bash tests/deployment/container-smoke.sh`。它只使用临时目录、独立 project/tag、随机测试凭据与 loopback 端口，测试后清理自身容器；不访问生产库。

## 旧观测台

旧 AI 下游主题、全行业 ETF 轮动、报告和模拟账户仅保留为历史研究入口。`worker/scheduler.py`、旧 `jobs/`、旧 `config/gateway.json` / `alerts.json` 不由新工作台 worker 自动运行。不得沿用旧定时任务写新账本，旧主题信号也不是新组合的实盘建议。

数据、认证库、原始附件、备份、恢复 secret、环境文件和本地验证证据均不应进入 Git 或镜像。当前发布工具仅提供受控交付路径，不表示生产已经发布，也不表示 RPO/RTO 或投资有效性已经达标。
