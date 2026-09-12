# 治理、风控、批准与执行预留

## 当前状态与不能跨越的边界

本轮实现的是治理及执行控制的可验证子集，不是实盘策略准入结论。

- 用户尚未批准真实 D-01 至 D-08，工程测试通过不代替政策批准。
- **真实 `governance_verification` worker 尚未实现**。目前只有受信完成记录的登记/校验接口和合成测试。系统不自动生成正式 G-03/G-04 通过记录。
- **`WORKBENCH_RELEASE_SHA256` 当前 compose 未透传，也未配置**。它须匹配实际部署版本的正式验证源文件 manifest hash；缺失即阻断。不能填一个默认 hash、沿用测试 hash 或为了演示跳过检查。
- 正式 S-01 至 S-10、前向模拟、数据许可和真实策略阈值仍需独立验证及人工审阅。当前 Python 探索结果不会自动变为 `formal_verified`。
- 工具不向任何券商下单；批准、准备执行、报告下单均不生成真实成交。

## API 与身份

`web/src/server/governance/service.ts` 导出以下函数，均使用 `(db, actor, command, options?)`。可信服务端身份为 `{ id, kind: "human" | "strategy" | "ai" }`；HTTP 从 session 构造 `human`，不能读取客户端传来的身份。AI 不能调用任何写操作；策略身份仅可创建候选建议及运行风控。

| 函数 | 作用 |
|---|---|
| `createPolicyVersion` / `createStrategyVersion` | 人类创建严格校验的候选版本，不自动生效 |
| `approveAccountCapability` | 人类登记有账户范围原件、有效期及明确交易范围的权限 |
| `activatePolicy` | 绑定政策/策略版本、四门槛证据和当前估值；已有激活只能关闭，不能改写历史 |
| `createProposal` / `runRiskCheck` | 持久化不可变建议和风控输入/结果；不完整输入显示阻断 |
| `approveProposal` / `prepareExecution` | 人类批准具体建议并预留；执行前复核批准版本及全部关键风险输入 |
| `cancelRemainder` / `expireProposal` | 释放尚未成交的剩余预留，不撤销真实事实 |
| `recordExecutionReport` | 记录用户报告已下单/部分成交/成交/撤单等消息，不当作已确认成交 |
| `recordExecutionFact` | 同事务调用既有账本服务记录成交，并消费对应预留；迟到或偏离建议的事实仍入账并标记偏离 |

共同字段为 `portfolio_id`、`expected_revision`、`idempotency_key`、`reason`。详细字段的唯一运行时契约在 `schemas.ts`；未填写阈值、非法金额或多余身份字段均拒绝。`options.releaseHash` 仅供可信内部执行环境/合成测试，HTTP 不暴露该参数。

只读 `getGovernanceState(db, actor, portfolioId)` 允许 AI 获取结构化摘要，使用一个 SQLite 读事务返回版本、激活、权限、验证记录、建议、风控、批准、预留与执行报告。各集合有查询上限；历史明细仍保留在数据库，不代表全部返回。公开错误使用 `isGovernanceClientError`，不返回原生 SQL、附件路径或任意错误后缀。

## 实际放行条件

G-01 需要明确政策版本和 D 项批准。G-02 每个相关账户必须已对账、无未解决差异，且有明确账户/市场/币种/证券方向权限；证券状态、ETF 属性、交易单位和价格步长需已核验。登记证券仍为 `unverified`，本模块不会自动提升挂牌状态。

G-03/G-04 的附件只是**人工审阅声明**，不是执行结果的权威来源。必须引用 `governance_verification_runs` 不可变记录；它绑定：

- 政策与策略内容 hash、组合和门槛。
- suite/tool 版本、源文件 manifest 及其 hash、完整执行 manifest 及其 hash。
- 每项检查的实际执行状态和产物 hash、执行起止时刻。
- `system:governance-verifier` 创建的内部请求，以及已完成的 `governance_verification` job。
- G-04 关联正式模拟结果的准入级别和指标；上传附件中的数字不能覆盖模拟结果。

只有正式、版本匹配、全部适用检查已执行通过的记录可用于实际建议。`synthetic`、`reconstructed`、研究/模拟环境、`not_run`、失败、来源版本不匹配、没有正式策略结果的记录均阻断。人工修改附件写上 PASS 无法改变这些结果。

`verification.ts` 的 `registerCompletedVerification(db, jobId)` 是未接 HTTP/Server Action 的离线内部接口，只从可信已完成任务读取结果，不接收用户上传的 PASS/指标。迁移 `0008_governance_verification.sql` 同时通过触发器限制来源并保持验证记录 append-only。实际验证 runner 仍待实现，不能由该接口存在推断已经完成验收。

## 资金、数量及风险约束

按账户和币种精确计算可用额：已结算现金减买入应付、其他已知负债、去重后的冻结和活动买入预留。负的卖出净应收也保守扣除。未结算卖出回款、预计入金/转账和另一账户/币种的现金不支撑本次买入。

权限证据明确确认券商冻结口径不重复包含工作台预留或交易应付款。没有这个口径则不能放行。卖出使用实际持仓数量减活动卖出预留。

检查包括整手/价格步长、非复权交易价、源数据可获得时间及新鲜度、价差、折溢价、成交量/成交额、参与率、明确费用下限/上限、价格缓冲、单笔金额、现金下限，以及证券/指数/市场/币种/地区/行业集中度和策略预算。未成交买入预留也计入后续集中度及策略预算，不能只占现金而重复分配风险额度。同账户同证券未净额化的多条需求直接阻断。

首版支持 `manual_target_v1`、显式 ETF 白名单和单一已核验地区/行业分类；没有自动策略生成、证券核验、外部券商同步、多维穿透推断或自由放宽阈值。未知成本、未知暴露、未覆盖账户和不足数据均保守阻断。

## 并发与执行事实

- 风控批准在 `BEGIN IMMEDIATE` 内重新核验实际资金、预留和输入 hash。两个独立进程各申请 60,000、账户仅有 100,000 时，至多一个成功。
- 批准不改 ledger revision；预留是执行状态，不是资产、现金流或损益事实。
- 下单/部分成交报告只记录消息，不扣真实现金、不增加持仓、不消费预留。
- `recordExecutionFact` 将真实成交与预留消费放入同一个事务；数量按实际成交减少，剩余金额采用保守向上取 18 位精度，防止提前多释放。
- 取消/过期保留已成交部分；随后收到的真实成交仍入账，标记过期、取消、超量或价格偏离，不复活清单。
- 通用独立事实入口仍可记账。若真实成交未通过本关联入口，对应预留不会被猜测匹配而自动释放，短时可能保守重复占用；须关联核对或明确取消剩余预留，不能因此把事实拒记。
- 账本、市场、激活、账户及风险输入改变后，执行前检查拒绝旧批准；部分成交后的剩余执行须从新实际状态重新评估，不重发整张旧清单。

## 验证与后续

`cd web && npx tsx --test tests/governance.test.ts` 覆盖人类/AI 权限、G/S 证据阻断、版本失效、实际双进程预留竞争、卖出数量、应付/冻结/预留现金、整手/价格/费用/集中度、部分成交、取消/过期、恢复锁原子回滚和错误脱敏。

合成 fixture 直接在一次性临时库中构造受信任务行，专门验证状态机；此权限不经过 HTTP，记录及参数不导入生产。fixture 不证明任何真实策略、工程检查或投资阈值已获批准。真实验证 runner、正式源版本绑定、证据生成与生产准入仍需分别闭环。

## Web 操作入口

`/workbench/governance` 提供组合范围内的版本、准入、清单、风控、审批、预占与执行回报视图。
当前为标准 JSON 命令界面：选择操作、填写操作字段及依据、人工确认后仅执行当前步骤。
修改载荷或切换组合会取消确认；读取期间账本版本变化会重读或要求刷新，不混用不同账本版本。

HTTP 使用 `POST /api/workbench`，格式为 `{ "action": "governance", "command": { "operation": "操作标识", "command": { "操作字段": "..." } } }`。
组合、版本与幂等键由页面加入外层治理 command；可信身份只取服务端 session。
`record_execution_fact` 的内层 `command` 可省略 `portfolio_id`、`expected_revision`、`idempotency_key` 和 `reason`，服务端适配器从外层派生；显式范围/版本冲突直接拒绝。
内层仍须提供真实来源记录号、实际时点/精度/时区和严格 `fact`，不能把券商报告的状态当作事实载荷。

查询使用 `GET /api/workbench?portfolio=组合标识&view=governance`，恢复只读模式允许查看，不允许审批、预留或记账。
标准载荷并非自动交易 API：operation 白名单没有下单或受信验证登记入口。
