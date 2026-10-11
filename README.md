# ETF 投资工作台

面向 A 股、港股、美股 ETF 的个人组合工作台：真实事实账本、原件留存、对账、数据质量、估值与收益核算，以及隔离的策略研究和人工决策流程。AI 辅助研究，不代表交易授权；软件正确性不保证持续盈利。

## 设计基线

1. [投资目标与约束模板](docs/01-investment-mandate.md)：在本地填写资金金额、预计到账日期、投资期限和账户约束；计划不等于资金已到账。
2. [产品需求](docs/02-product-requirements.md)：组合、账户、投入计划与人工执行闭环。
3. [策略治理](docs/03-decision-policy.md)：策略、AI、风控、批准与权限边界。
4. [数据与核算](docs/04-data-and-accounting.md)：事实、结算、多币种、收益口径。
5. [架构与迁移](docs/05-architecture-and-migration.md)：版本化新库、旧研究隔离、备份恢复。
6. [验证与验收](docs/06-validation-and-acceptance.md)：工程与投资有效性分别验收。

组合优先的下一版交互方向见 [v2 产品主流程提案](docs/09-product-v2-portfolio-first.md)和[可点击的合成数据首页原型](docs/prototypes/portfolio-first.html)。本地入口已改为总览、组合方案、观察记录、账户资料；旧账本在 `/workbench/ledger` 保留。保存研究偏好会建立独立后台任务，首页显示阶段进度、损失算术示意和具体数据缺口；试验与候选冻结持久化，失败重试不能清除本地窗口曝光。保存参考方案登记独立观察任务，支持暂停/恢复和检查点。审阅收据的研究与监测已接入默认 core，Web 独立重放模型及成本后展示变化卡；验证仍仅使用虚构资料和模拟传输，不代表真实行情资格或个人收益。真实来源验收、自动数据更新、在线 AI 和完整 v2 发布尚未完成。逐项状态见 [v2 实现与验收追踪](docs/v2-implementation-progress.md)，不改变投资与工程准入门槛。

行情服务的官方资料调研、既有行情账户/独立数据源候选、公开价格与许可留存门槛见 [行情源选型](docs/10-market-data-source-selection.md)。长桥的两种只读检查见 [OAuth AI 工具验证](docs/11-longbridge-ai-market-data-access.md) 和 [API Key / VPS 接入](docs/12-longbridge-apikey-server-access.md)。本地三地短窗口读取通过不代表生产数据源已合格；复用行情账户不授权交易。

长期组合的研究目标、基准、资金部署、风险情景与增强策略准入见 [长期参考策略研发规格](docs/13-long-horizon-reference-strategy.md)。该规格不是已经验证的个人方案，不包含个人权重或交易授权。

首版采用分散配置、新资金优先修复与低频再平衡，增强层暂不启用。候选结构、联合损失情景、有限分期、触发规则及与现有实现的差距见 [长期组合策略运行草案](docs/16-long-term-portfolio-policy.md)。所有具体比例和阈值仍是研究候选，不是已生效个人配置。

风险未确定时可先查看[损失情景与风险预算](docs/21-risk-budget-review.md)，再明确更新风险答案并重新研究。假设金额只是本地算术示意，预算不保证最大亏损，不自动选权重或交易。

低频研究已新增独立 v2 参数与引擎，旧月度口径保留。新版参考方案绑定冻结参数和时区，独立监测 v3 已接入默认 core、稀疏政策检查点和 Web 全链重放；界面展示类别偏离、复核与冷却，而不只显示单证券差异。旧版未绑定规则的方案仍暂停且不能启用旧监测器。验证仅用虚构来源；自动更新、完整长期资金路径、真实策略验证和发布仍待完成。

新增独立的[连续资金路径计算接口](docs/17-continuous-funding-path.md)：同一账户轨迹跨年处理本金、年度到账、等待现金与预定有限分批，并比较相同配置/成本下的及时投入路径。它是本地探索算术，不是十年预测，尚未接入工作台发布或生产；旧阶段回测、用户风险答案与实际账户均不改写。

新增可选的[私有长期投入安排](docs/18-private-planned-funding.md)：界面填写年度日期和进入路径，保存独立不可变版本，并展示计划本金与精确分批。无需账户或 JSON；偏好变化后重新审阅，不写到账事实、收益或交易。

年度投入已接入[默认持续观察](docs/29-planned-funding-core-monitor.md)：后台固定私有计划版本、释放边界及原检查点，准备和提交重核；改计划或批次到期使旧结论失效。初始资金不重复加入模型，过去批次不倒填，到期池与审阅决定不改变现金/单位；只用虚构资料验证，不是生产发布或实际投入，也不会外发计划金额到 AI。[准备与历史版本规则](docs/28-planned-funding-monitor-preparation.md)保留原基线。

[年度观察的 AI 生命周期](docs/30-planned-funding-ai-lifecycle.md)已验证封闭派生证据、显式请求、独立冷后台去重和版本/释放失效，模拟 AI 不改变策略结论；没有真实网关或生产验收。[当前显示期限](docs/31-current-display-expiry.md)修复统一主结论/变化卡/AI 的到期失效，保留历史且不自动重发；原资源停止和构建失败保留。[风险与经济面板期限](docs/32-economic-display-expiry.md)进一步隐藏到期的候选、比较和曲线，拒绝首次迟到响应及旧会话回调。后续类型修正后，新冻结基线的 459 项限定测试、构建前后完整 TypeScript 检查及本地 Next 生产构建通过；修正旧投入计划测试预期后，认证 HTTP 26 项通过。实际 Chromium 嵌套组件/图表的桌面与 390px 合成 DOM 专项 8 项通过，但不是完整工作台浏览器验收；真实数据资格、完整产品、Linux 与生产发布仍未完成。

[总览聚焦](docs/33-overview-clarity.md)进一步将证据缺口提前，风险、投入与研究详情默认折叠，“组合方案”保留完整面板。新的 975 文件冻结基线下，461 项限定回归、构建前后完整类型检查、默认 Next 构建、认证 HTTP 26 项及桌面/390px 完整 Next 路由、登录、精确重试、审阅/期限/退出和折叠交互的 20 项专项通过。均为本地合成资料验证，未提交或发布；不认证真实策略、完整产品或外网生产。

长期投入计划的研发计算连接见 [计划资本与连续历史比较](docs/19-planned-capital-historical-binding.md)：明确回顾性窗口与当前登记声明，不伪造过去预注册。[私有比较任务](docs/20-private-funded-comparison.md) 一键绑定偏好/投入/审阅来源，后台留存有期限的私有结果，按需独立重放后展示历史收益、成本与损失；来源失效则隐藏，core 按批清理。它不选取个人权重、不交易，也不证明来源许可或策略有效。真实数据/策略验收、原生交互验收和生产发布仍待完成。

新增按需[完整窗口曲线与持有对照](docs/22-funded-path-analysis.md)：分别看本金、净资产、盈亏和待释放现金，风险用全部估值点而不只看日末；展示滚动亏损的重叠样本统计，不将其当作未来概率或独立预注册基准。本地全量回归与桌面/手机 headless 交互通过，真实来源、原生/人工验收及发布尚未完成。

历史数据新增[有界分片与断点续采](docs/23-bounded-history-collection.md)，复用有效收据而不重复采价。港/美股两个早期交易日的内存读取成功，A 股早期窗口已缩小为空 SDK 返回，更深原因未确认；不将局部样本或虚构分片测试当作十年覆盖或真实策略验收。

已建立六个[真实 ETF 资料候选](docs/24-real-etf-source-candidates.md)，保留身份、暴露、来源时点、不同费用口径和具体缺口。它不是自动批准的目录或默认个人组合；三个 A 股候选早期窗口为空，两个美股候选局部读取成功，尚未完成长期资格。

新增[有界在线 AI 解释](docs/25-bounded-online-ai-explanation.md)：固定虚构探针已通过一次真实传输/事实校验；显式请求已拆成 SQLite 排队、不可变外发登记与独立后台处理，空闲启动清理不依赖浏览器。同库多进程去重，未知外发结果不重发；默认不自动生成付费请求。独立镜像/Compose 已编写，真实用途许可、正向 HTTP/后台集成、Linux 容器与生产验收仍缺。仅提取有限派生指标，不把软件测试称为在线投资顾问。

新增[站内研究通知](docs/26-in-app-research-notifications.md)：工作区右上角查看最近已提交的模型监测结果，已读独立持久化，不改变组合、决定、交易或外部投递状态。通知明确是历史记录，不代替当前有效结论；外部渠道、真实界面及生产验收仍待完成。

账户页提供[人工成交/实际交收回录](docs/27-manual-executed-fact-recording.md)、结构化独立对账和只读 [真实组合对照](docs/15-recorded-holdings-comparison.md)：用户自行交易后按独立资料转录，不查行情预填，不默认费用或交收；资料匹配不修改持仓或自动解决旧差异。完整人民币估值通过复核后，以整个账本净值比较研究目标，显示截止日期、现金、负债、非目标资产及在途证券。它不是券商原件认证、实时同步、盈利报告、交易清单或执行报告绑定；简化估值、账户级完整回录闭环与真实来源验收仍待完成。

公开文档定义通用产品规格，不携带个人已确认的资金计划或投资授权。个人约束、账户与资金计划仅在本地填写和保存，不随源码发布；具体目录、Git、Docker 与 CI 边界见 [公开与本地资料规则](docs/publication-privacy.md)。实现和验证证据另行记录，不能把设计规格当成已通过验收；实际账户数据、行情授权、参数批准和异机灾难恢复仍须按对应门槛完成。

## 工程结构

- `web/`：Next.js、认证、Web 唯一真实账本写入入口、附件和操作界面。
- `worker/accounting/`、`market/`、`performance/`、`research/`、`investor/`、`orchestration/`：Decimal 核算、数据批次/估值、收益、研究与模型计算及持久任务；研究不写真实资金。
- `contracts/v1/`、`migrations/`：共享 JSON Schema 与校验和固定的 SQLite 迁移。
- `data-workbench/etf-workbench.db`：新工作台库；不会隐式创建初始资金或从预算补余额。

资金计划入口为 `/workbench/funding`，支持日期化来源、投入批次、版本/延期及到账、执行事项关联；保存计划不创建现金或下单。实现边界见 [资金计划](docs/funding-plans.md)。账本支持 [证券转入、转出与在途](docs/security-transfers.md)，估值与绩效分离外部资本、历史成本与收益；缺时点、规则或来源时继续阻断，见 [逐流汇率核算](docs/performance-flow-fx.md)。[通用 CSV 导入](docs/csv-import.md) 支持原件零写检查、可视化显式映射、原件留存、不可变版本、逐行重复核对和原子确认，也保留高级 JSON 编辑；尚未认证具体券商原生格式。当前测试与未完成项见 [开发进度](docs/07-implementation-tracker.md)，不据此宣称生产或策略准入完成。
- 原 `data/observatory.db`：旧主题观测/ETF 模拟研究。原库不被新迁移触碰；通过 Online Backup 归档，旧记录不晋升为真实事实。

标的研究入口为 `/workbench/catalog`：按组合保留结构化来源、资料与持仓披露版本，支持分页和最多四个标的比较。披露不完整时显示覆盖率与重叠上下界，不将未知持仓归一化；目录记录不授予交易权限。实现与剩余核验见 [ETF 标的目录](docs/etf-catalog.md)。

证券身份审核入口为 `/workbench/market/listings`：对组合目录中的证券保存私有来源、身份快照、挂牌状态、产品结构、交易单位和分类的人审版本。未知、到期或不支持的产品阻断当前风险判断；改版使旧风险和批准失效，不修改真实持仓或全局核验字段。该人工审核不是发行人认证、加权穿透或交易授权，见 [身份审核边界](docs/listing-identity-reviews.md)。

月度评估入口为 `/workbench/evaluations`：人工保存明确的目标权重、容差和时间定义，另行启用未来周期；结果区分无需调整、候选提案和阻断。重试保留原周期与已知时间，不会自动审批、预占资金或下单。当前方法是显式目标比较，不是已经验证有效的 ETF 轮动算法；范围、固定发布器和验收边界见 [月度评估](docs/monthly-evaluations.md)。

策略研究入口为 `/workbench/research`：v1 保留仅新增资金的固定权重模型；v2 支持明确参数的月度排名轮动、卖出交收后再买入，以及同口径固定再平衡基准。页面展示研究资金、费用、收益、现金、换手与阻断摘要；不改写旧报告、不写真实账本，也不自动启用月度实盘调度。公式、数据时点和未完成项见 [轮动研究](docs/rotation-research.md)。

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

投资者工作区专项生产构建/HTTP 回归：`npm --prefix web run test:workbench:http -- --investor-only`。本地浏览器可用 `npm --prefix web run dev:fixture` 建立空临时库，先验证无账户的偏好引导；`web/scripts/seed-investor-browser-fixture.ts` 仅允许该临时目录，用明确标记的合成方案测试审阅与过期界面，不能运行于生产数据目录或作为真实策略生产者。

`web/scripts/seed-investor-browser-research.ts` 同样仅接受空金融事实的临时浏览器库，用于研究队列/合成计算验收。生产 core 自动检查独立研究请求，但不接受合成计算开关；没有合格输入时只发布缺口，不生成示例权重。内核和任务边界见 [投资者计算说明](worker/investor/README.md)。

独立 [私有研究数据链路](docs/14-private-research-data-pipeline.md) 已增加来源审阅、受限 SDK 收据、历史重建与显式研究准入；默认后台可计算已审阅来源，风险明确且阶段通过时生成探索历史参考方案，首页独立重放核验后可保存为观察模型。每次读取发现失效便隐藏旧权重并拒绝保存/恢复，可见页定期复核来源。重建与时点档案分开，模拟采集不能当成真实输入；后台操作不要求投资者首次填写 JSON。真实适用资料、真实来源纵切/连续监测、自动到期与备份联动清理仍待完成，本轮没有新增真实行情留存。

历史收据与独立 Confirmed 回调已接入版本化三地监测投影、引用元数据准入、默认 core 和 Node 独立重放；新增[日历驱动的自动监听](docs/14-private-research-data-pipeline.md#日历驱动的自动监听与后台准入)，由独立 longport 角色执行，漏窗不追认、不用历史快照补齐。[首个监测输入](docs/14-private-research-data-pipeline.md#首个监测输入的自动建立)可由 core 从已有、完整且当前已审阅的保留收据自动建立，不要求投资者准备 JSON；缺少真实采集、行动/FX 或唯一来源时仍阻断。旧历史接口仍拒绝当地当日，新回调不能改标为历史研究或实时投资资格；缺少任一目标覆盖仍阻断，准入不启用模型或更新金融事实。首次真实行情取得、三地连续链/资料许可、长期治理与生产发布尚缺，不能据模拟测试宣称持续真实监测已上线。

缺失初始监测价格时，新增[受控自动采集](docs/14-private-research-data-pipeline.md#缺失首份监测价格的受控自动采集)：仅复用已选研究模型的当前原来源，独立 longport 单次取得完整的过去交易日，再由 core 核验全部价格/行动/FX。原直接采集和收据格式保留；不猜测当日确认、许可、费用或到账，不覆盖已有输入。它不是首次真实研究资料取得或生产持续监测验收。

首页新增[采集进度](docs/14-private-research-data-pipeline.md#首页采集进度与时间失效)：区分首份价格补采和按市场收盘监听，显示已登记目标、有效租约、实际登记窗口、漏窗及失败；无任务时不推测下次时间。离线或编辑暂停刷新时仍更新到期显示，不把队列、租约或任务完成升级为行情合格、worker 在线或无需调整。只读进度不增加 JSON、采集按钮或自动交易。

连续模型测试适配器为 `tests/investor/model_fixture.py`，同样只允许直接位于系统临时目录的测试库且要求零真实组合。默认 core 不计算合成快照，也不会把软件测试变为“无需调整”。页面“刷新状态”只读取资料，不新建研究任务或资金事实；后台更新导致版本冲突时，先刷新核对，再重新作出决定。

`npm --prefix web test` 会先构建固定月度发布器。独立启动本地 worker 前，可运行 `npm --prefix web run build:evaluation-worker`；产物 `web/dist/monthly-evaluation.mjs` 不进入 Git 或 Docker 构建上下文，镜像从锁定依赖和源码重新构建。生产 worker 内含 Node.js 22 与匹配的 SQLite 原生模块，不从任务载荷接收脚本、结果或数据库路径。

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
