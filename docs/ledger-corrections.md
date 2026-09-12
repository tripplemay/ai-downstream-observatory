# 账本更正、撤销与历史补录

实现入口：`web/src/server/ledger/corrections.ts` 的 `correctLedger(db, actor, command, options)`。普通 `recordFact` 仍拒绝早于当前经济日期的事实；不存在跳过时间顺序的客户端参数。

## 不变量

- 旧事实、原分录、持仓变动和原附件不修改、不删除。更正追加反向分录，再追加按经济顺序重算的事实。
- 冲销行 `event_type=reversal`、`reversal_of=原事件 ID`；生效日期和精度沿用原事实，`recorded_at` 为更正时刻。原历史可见性不被改写。
- 从最早受影响位置开始，冲销原时间后缀；保留前缀重建投影；按最终顺序重放后缀。移动平均成本、卖出收益、拆分成本和相关结算引用重新计算，不用现金或收益“调平”。
- 买卖/结算和转出/转入依赖必须完整。金额不兼容时整笔更正回滚；需要改变结算金额或撤销两腿时在同一命令明确列出。
- 更正、投影、审计、版本号和幂等结果处于同一个 SQLite `BEGIN IMMEDIATE` 事务。陈旧版本拒绝；同键同内容重试返回原结果，不重复冲销。
- 仅受影响账户重新进入待对账。为了顺序而重放、且事实效果未变的其他账户保持原状态；`disabled` 永不自动启用。
- 既有导入原件与 `import_batch_id` 保留。替代行通过审计中的 `supersedes_event_id`、`correction_id` 连接原事实及更正证据；重新导入原旧文件不会复活被撤销的事实。

## 命令

共同字段：`portfolio_id`、`expected_revision`、`idempotency_key`、`attachment_id`、`reason`、`changes`。

`changes` 可混合：

1. `{"action":"void","event_id":"..."}`。
2. `{"action":"replace","event_id":"...","replacement":{fact,effective_at,time_precision,source_timezone}}`。
3. `{"action":"insert","local_id":"...","record":{fact,effective_at,time_precision,source_timezone,source_id,source_event_id?}}`。

`replace` 和 `insert` 可携带 `before_event_id` 或 `after_event_id`，但不能同时携带。新插入或移动到已有同日/同一时刻的事实必须明确顺序锚点；锚点必须与该事实经济日期/时刻相同且仍存在。保留原时刻的替代默认沿用原顺序。`insert:<local_id>` 可以引用同一命令中先前新增的事实，供顺序锚点或 `fact.related_event_id` 使用。

`replacement` 初版不得改变账户、事实类型、币种和证券 ID。其他经济字段仍受原事实 schema 与引擎约束。改变这些身份需要单独经过审核的撤销/新增，不是直接改写身份。

证据附件必须已经写入受控目录。显式变更涉及的每个账户都必须有该附件的服务端授权关系；跨组合或未关联账户拒绝。附件读回核验 hash、长度、权限与路径，幂等重试也重新核验，客户端不能提交路径。

## 当前明确边界

- 支持全部日期精度且同一源时区，或全部 UTC 秒精度的历史。混合日期/秒精度、日期跨时区的顺序不作推测，返回明确错误。
- 一次最多 100 项显式变更，冲销数量加重放数量最多 5000。超限需要分阶段审查，不静默截断。
- 不自动补写缺失的结算、到账、转入、费用或价格；未结算余额可以存在，并继续由对账显式覆盖。
- 更正不会自动解决既有对账问题，也不授予市场交易权限。
- `getActiveLedgerEvents(db, portfolioId, atRevision?)` 用于读取某个已发布版本的有效事实。更正或导入原子批次的中间版本返回 `REVISION_NOT_PUBLISHED`。
- 历史 `as_known` 按 `recorded_at` 过滤原有及追加分录；`restated` 允许全可见原分录与冲销自然相消。持仓 `cost_known` 应从有效事实重建，不应对反向 boolean 求和。

## 验证

`cd web && npx tsx --test tests/ledger-corrections.test.ts`：20 条合成测试，覆盖不可变原件/事实、日期锚点、晚到买入重算卖出成本、独立干净基线复算、连续更正、多账户转账与 FX、结算依赖、未知成本恢复、禁用状态、幂等/CAS、跨范围及附件篡改、导入来源链、非有限数字哈希拒绝，以及事务中途出现只读恢复锁时整批回滚。

`node --test tests/migrations/contracts.test.mjs`：冲销事件单独的 payload 契约；普通事实不能冒充冲销。

这些测试不使用真实账户、不触及生产数据；HTTP/UI 集成另行验收。
