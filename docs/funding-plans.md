# P-04 资金计划：版本、到账匹配与执行归属

状态：工程子集已实现，未完成 P-04 全部产品验收，未取得任何真实投资准入。仅在隔离合成数据上验证；本模块不包含政策阈值建议、券商连接、自动下单或资金到账默认值。

## 1. 三类数据必须分开

| 数据 | 来源 | 不能代表什么 |
| --- | --- | --- |
| 计划来源与投入批次 | 人工发布的资金计划版本 | 不等于现金到账、交易授权或已经预留 |
| 到账匹配 | 人工将有效 `opening_cash` / `deposit` 事实的一部分归属到来源 | 不证明这笔现金仍留在账户，不隔离资金，也不创造收益 |
| 执行归属 | 人工将实际环境的买入提案项归属到投入批次 | 不审批提案、不预留资金、不生成成交事实 |

初始来源可匹配期初现金或建账后的真实入金；年度追加来源只匹配 `deposit`。界面的 `opening_amount` / `contribution_amount` 按匹配事实类型汇总，不能根据计划标签把实际入金改写为期初余额。

账户现金是可互换的：消费、提取、转账、换汇、结算和费用都可能改变余额。因此，不提供错误的“某一批次可用现金 = 累计到账 - 累计买入”公式；显示账户/币种级真实可用金额，并明确它不是交易许可。

## 2. 模型与不变式

迁移 `migrations/0009_funding_plans.sql`：

- `funding_plan_versions`：复用既有 append-only 表，新增计划 JSON 使用 `schema_version: 2`。
- `funding_plan_heads`：每个组合独立 `revision`，与 `ledger_revision` 分离。成功资金命令只推进资金 revision，不推进账本。
- `funding_plan_items`：不可变来源/批次快照；稳定逻辑 ID 跨版本保留，物理 ID 绑定当时计划版本。
- `funding_plan_links`：不可变到账/执行 attach 与 detach 事件；解除引用原关联，不 UPDATE/DELETE 原关联。
- 来源、批次、事实、提案和解除关系均校验组合范围；批次必须引用同版本、同币种的来源。
- 每次命令均写 `audit_events` 和 `command_dedup`；身份来自服务器会话，不能由命令载荷指定。

计划来源字段：`id, label, kind, currency, planned_amount, period_start, period_end, expected_arrival_date, account_id, status`。

投入批次字段：`id, source_id, label, planned_amount, account_id, invest_by, unspent_action, status`。

金额采用十进制字符串；拒绝浮点数、指数记法、负计划金额与超出账本精度的值。每个来源的非取消批次预算总和不得超过来源预算。来源/批次 ID 全局唯一，旧逻辑项不能从新版本中静默删除，只能明确取消。已有有效关联的币种、账户和期间不能通过编辑计划悄悄更换。

## 3. 服务与命令

入口：`web/src/server/funding-commands.ts` 的 `executeFundingCommand(db, actor, {operation, command}, options?)`。`options.now` 仅供可信服务器或合成测试调用，不属于 HTTP 命令。

所有命令共同字段：

```text
portfolio_id
expected_funding_revision
expected_ledger_revision
idempotency_key
reason
```

| operation | 附加字段 | 行为 |
| --- | --- | --- |
| `publish_plan` | `plan`, `acknowledge_shortfall` | 校验并追加完整计划版本；减少预算造成已匹配超额、取消已有到账的来源、把批次预算降至已执行与活动预留之下、或取消已有成交的批次时要求显式确认 |
| `defer_tranche` | `tranche_id`, `invest_by`, `unspent_action` | 新截止日期必须晚于今天与已有日期；追加版本并保留原期限/处理规则，不延长任何提案或订单期限 |
| `link_receipt` | `source_id`, `ledger_event_id`, `amount` | 仅匹配同币种、指定期间和账户范围内的有效事实；允许部分匹配，累计不得超过事实金额 |
| `unlink_receipt` | `link_id` | 追加解除记录；不退回资金、不删除事实 |
| `link_execution` | `tranche_id`, `proposal_item_id`, `expected_resources_hash` | 同币种、同账户范围的实际买入提案项只能有一个活动归属；重新核对资源快照 |
| `unlink_execution` | `link_id` | 仅在没有剩余活动预留时解除归属；不撤销实际成交 |

Zod 对全部层级拒绝未知字段。只有 `human` 可写；AI、策略和 worker 不可发布、修改或关联计划。交易参数和批准仍由治理模块独立控制。

同一事务使用 `BEGIN IMMEDIATE` 与双 revision CAS。幂等重试的业务载荷必须相同；revision 和资源 hash 不是业务载荷，重复已成功操作返回原收据，不能再次计数。不同内容复用相同键拒绝。

`WORKBENCH_MODE=read_only` 或 `RESTORE_PENDING_REVIEW` 存在时拒写；已有连接也会在事务开始和提交前重新检查。

业务错误由 `isFundingClientError(code)` 白名单识别，不能向 HTTP 返回原生 SQL、文件路径或未知异常信息。版本/资源冲突分别使用 `FUNDING_VERSION_CONFLICT` / `RESOURCE_CONFLICT`。

## 4. 一致读取与 UI 口径

`getFundingState(db, actor, portfolio_id, options?)` 使用一个一致读事务，导出 `FundingState` 类型，包含：

- `portfolio_id`, `ledger_revision`, `funding_revision`, `read_only`, `resources_hash`。
- `plan_status`: `confirmed_plan` / `needs_review` / `not_configured`；`plan`, `versions`。
- `accounts`：完整账户目录，不因没有现金行而隐藏空账户；不伪造零余额事实。
- `sources`：计划字段及 `matched_amount`, `opening_amount`, `contribution_amount`, `arrival_remaining`, `excess_arrival`, `assigned_amount`, `planned_unallocated`, `needs_review_count`, `due_status`。
- `tranches`：计划字段及币种、实际 `active_reservations`、已有效关联买入事实的 `executed_amount`、`budget_excess`、`execution_status`、待复核数量和期限状态。
- `links` 与 `link_history`：显示原关联状态和完整 attach/detach 审计行；解除记录不会覆盖原记录。
- `matchable_facts`：事实 ID、类型、账户、币种、金额、未匹配金额、经济时间/精度/时区和记录时间。
- `execution_items`：实际买入提案项、期限、账户/币种/数量/限价/费用及活动批次归属。
- `account_cash`：真实已结算余额、应付款、其他负债、冻结、活动预留与可用金额；`eligible_for_advice` 固定为 false，资金视图不授予投资权限。
- `warnings`, `totals`, `limits`：明确规划/现金隔离、现金可互换、待复核及分页展示限制。

`planned_unallocated` 表示计划预算尚未分配给投入批次，**不是闲置实际现金**。未到账来源、已到账来源和已预留投入不能合并成一个“可投资余额”。

`budget_excess = max(有效已执行金额 + 活动预留 - 计划批次金额, 0)`；超额和“计划已取消但有实际成交”必须显式告警，不能将确认超额当作风险批准。`execution_status` 独立显示 `unallocated` / `reserved` / `partially_executed` / `budget_executed` / `over_budget` / `cancelled_with_execution` / `needs_review`。`budget_executed` 只表示金额已达到计划预算，不证明订单全部成交或达到投资目标；`due_status` 保留独立日历状态。

同币种可用现金复用治理的纯函数 `availableResources`：已结算现金扣实际应付款、其他负债、现金冻结和活动买入预留；正应收款不作为可买资金。账户未对账/停用、市场权限缺失或风险输入失效仍可能禁止实际建议，不能根据正余额放行。

金额汇总在完整输入集上完成后才裁剪列表：版本最多 50、关联和历史最多 1,000、可匹配事实及提案项各最多 200；返回完整数量。当前没有历史分页 UI，因此不能把截断列表称为完整历史浏览。

## 5. 更正、取消和期限

- 原到账事实被更正/冲销后，旧匹配标记 `needs_review`，不继续计入已到账，也不自动指向替代事实。人工解除旧关联并重新核对替代事实。
- 日期精度为 `date` 且来源时区与计划时区不同，明确拒绝匹配，不能猜测它属于哪个日历日；秒级事实可按计划时区判断期间。
- 转账、换汇、分红、结算和买卖均不是新增外部到账，不进入可匹配来源列表。
- 执行报告中的 `partial` / `filled` 文本不构成实际成交；只有治理模块已经接受并保留证据的实际买入事实进入批次执行金额。
- 成交更正后旧执行关联待复核；只有不可变更正审计能证明替代链、且人工通过治理把当前有效替代事实明确关联到同一提案项，才消除对应旧关联的待复核提示。纯冲销、未重新关联和关联到其他提案项都不自动解决。`executed_amount` 仅汇总仍有效且已归属的事实，待复核时不是完整成交总额。
- 批次存在活动预留时，不允许取消或解除归属来隐藏它。先通过治理的取消/过期命令处理剩余预留；已经发生的事实始终保留。
- 延期、计划取消和归属解除都不会写账本、放款、换汇、制造现金或自动下单。已逾期只是状态提示；`unspent_action` 是记录的人工作业规则，并非自动执行脚本。

## 6. 旧计划与公开范围

旧 `year: 1..10` 相对年度计划没有明确日历日期，显示 `needs_review`，不自动推断起始年，也不会默认确认任何到账金额。旧版本和数据库保持不变，需人类明确发布 v2 版本后才进入新资金计划流程。

已确认仅公开代码、通用规格和合成示例；真实个人资金参数、到账日期、账户/券商标识、凭证和数据库留在本地，不作为公开默认值或测试输入。每次发布按[隐私检查规则](publication-privacy.md)核对实际暂存内容、构建上下文和 CI 工件。当前文件脱敏不代表已撤回历史副本；未经另行授权不重写公开历史。本文和新增测试仅使用明确合成的小额/通用样本。

## 7. 可复现验证与剩余边界

```sh
cd web
node --import tsx --test tests/funding*.test.ts tests/governance*.test.ts
npm run typecheck
cd ..
node --test tests/migrations/*.test.mjs
```

本次领域快照：资金测试 20 项（含主任务提供的 4 项首页摘要测试）与治理测试 27 项，共 47/47；迁移测试 22/22；TypeScript 检查通过。覆盖独立进程竞争同一到账、双 CAS、精确小数、只读恢复中途出现、v8 升级保留原账本、SQL 范围保护、到账更正失效、预留与部分成交/取消隔离。

同时修复治理跨模块失配：FX 单位统一为 `CNY_per_unit_currency`；实际风控调用 `valuationFreshness`，拒绝旧估值方法、缺失价格/FX 引用、不批准规则、错误 hash 和不匹配发布历史。治理 fixture 使用完整 v2 规则与观测引用，但仍是隔离合成验证，不是正式数据/工程/策略准入证据。

尚未完成：真实账户/凭证与日历验收、跨币种来源归属规则、无限历史分页、自动提醒/持续定投执行、真实券商端部分成交与恢复演练、正式生产登录及 P-04 全产品验收。资金计划不依赖或代替 D-01..D-08、G/S 准入批准，不宣称可持续盈利。
