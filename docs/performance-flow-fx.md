# 逐事件外部资金流与证券流：绩效 v4

## 本轮范围

对应 ACC-11 / ACC-14 / ACC-15 的一个窄切片：把有效账本中的外币外部资金流，按发生时点的可信参考汇率折成人民币，并冻结可追溯证据。

这不是实盘数据源接入，也不代表全部会计、策略或真实账户验收完成。没有实际可信历史资料时仍然阻断；合成测试不构成投资或交易准入。

逐流 FX 最初在 v3 实现，现与证券流统一为 `snapshot-performance-cny-v4`、`performance-input-v4` 和 `flow-fx-evidence-v2`，配合 v3 估值。证据存入现有不可变 `performance_runs.market_manifest` 和 `result_json`；旧 v1/v2/v3 绩效仅保留审计，不参与新计算去重。证券在途事实使用迁移 v10，详见 [证券转移](security-transfers.md)。

## 金额与事件边界

- 只取有效事件的 `external_capital` posting；外部净流量为 `-posting.amount`。投入为正，提款为负。
- 外币逐笔计算 `amount_cny = amount_native * fx_rate`；人民币直接使用 1。
- 汇率方向固定 `CNY_per_unit_currency`。不得用期末汇率、最近方便取得的汇率、默认 1 或实际换汇成交率替换事件时点参考率。
- 例：期初人民币 100，USD 100 入金参考率 7，期末美元参考率 7.7 且无其他变化。期末 NAV 为 870，外部流为 700，损益为 70，而非 0。
- 内部转账、实际换汇、买卖结算、分红和费用不成为外部投入；不新增虚构人民币现金、手续费或外部资本分录。
- reversal 不作为新提款；可见撤销使原 posting 失效，重放事件使用新的 posting ID 重新绑定。旧记录和旧绩效证据不覆盖。
- 外部证券划入/划出使用同一时点人工确认的原币市值，而非历史成本；冻结数量、价值依据与原事实 hash，并核对对应持仓 movement。内部证券转仓不产生资本流。期中新增账户期初快照的原有阻断不解除。

## 命令

继续使用同环境 worker 的 `performance` 命令，或现有 CLI；Web 不提交计算结果、绑定对象或 `PreparedPerformance`。

```json
{
  "valuation_ids": ["valuation:earlier", "valuation:later"],
  "evaluation_timezone": "Asia/Shanghai",
  "flow_fx_rules": {
    "schema_version": "flow-fx-rules-v1",
    "approved": false,
    "fx_scope": "fx:reference",
    "max_fx_age_seconds": 86400,
    "time_policy": "event_second_strict"
  }
}
```

以上是未批准配置示例，不会使外币流通过。实际批准要求可信人工命令来源，`approved: true` 和非空白 `approval_evidence`；年龄上限必须明确核对，不能把示例一天当普遍适用规则。批准只涉及数据质量，不赋予策略激活或交易权限。

只有 CNY 外部流时无需配置 FX，但证券流仍需真实秒级时点和确认市值依据。没有外币流时不因缺 FX scope 产生虚假阻断。外币流缺规则、未批准或缺证据时，报告保留逐流问题但所有全期损益、总流量、收益率、XIRR 和回撤不可用；缺失金额是 `null`，不是 0。

## PIT 与修订

1. 外币事件及任何币种证券流只接受秒级发生时点。日期精度不足时，若源时区整日可能与评价区间重叠，就记录阻断证据；`flow_time` / `evaluation_date` 留空，不猜实际时刻。
2. `as_known`：经济 cutoff 和 FX 知识 cutoff 均为事件时点。报价观察时点不得晚于事件；来源公开、实际 ingestion 和本地批次发布时间均不得晚于知识 cutoff。后来补录的历史数据不能冒充当时系统已知。
3. `restated`：经济 cutoff 仍是事件时点；全次计算使用同一服务端冻结知识时点。后补资料可参与重述，不改写既有 as-known 结果。
4. 选择该知识时点最新的不可变 publication，并仅从它的 batch membership 选历史报价；不会从整个 observation 表或任意旧批次偷偷借资料。当前发布批次缺所需历史曲线时，必须补充经过核验的完整历史发布，再重算。
5. 日频报价在源时区整日结束后才可视为观察完成；观察年龄按事件时点计算。必须是 `FX:<currency>`、`fx_cny_per_unit`、`not_applicable`、正确单位、正数和正确 source。缺公开时间、synthetic、reconstructed、陈旧或歧义资料均阻断。
6. 对 as-known 逐流引用，还检查事件之后、报告结束之前的所有中间发布。若它们改变事件 cutoff 可选参考率，报告 `FLOW_FX_KNOWLEDGE_CHANGED_RESTATE_REQUIRED`。后续批次省略修订行不能掩盖已有修订；只在报告结束之后发生的更新不追溯改写该历史报告。
7. restated NAV 继续要求同一当前账本版本、当前所消费市场头；不能混用新流量 FX 与旧 restated NAV 来源。NAV 与流量消费相同货币 FX 时，来源 scope 必须一致。

## 证据与原子性

完整结构见：

- `contracts/v1/flow-fx-rules.schema.json`
- `contracts/v1/flow-fx-evidence-v2.schema.json`
- `contracts/v1/performance-input-v4.schema.json`

每个有效资本 posting 都有一条 `external_flow_evidence`，含 CNY。字段冻结事件 / posting ID、原行哈希、事件 payload hash、原币金额、发生时点/时区/精度、模式与知识时点、规则 hash、精确 publication 引用、报价原文非空字段、报价 hash、source validation hash / evidence、换算金额和质量原因。

`binding_id` 是该证据对象去掉 `binding_id` 后的 canonical SHA-256。事件和 posting hash 使用 `SELECT *` 原行；observation hash 使用原行去掉 null 字段后的对象。manifest 与 result 中证据列表完全相同。ASCII 键按代码点排序，Python / Node 共同验证，不跨机器寻找另一套 hash 实现。

金额保持十进制字符串。乘积可能超过 18 位小数，派生 `amount_cny` 使用独立十进制契约，不套账本现金小数位约束，不为展示舍入后回写事实。

准备阶段只读，持久化在现有 fenced transaction 内完成。所有实际消费的 FX scope 都加入 head CAS，即使首尾 NAV 只有人民币；账本或市场头竞争更新、lease 过期、只读模式、恢复待复核标记都会拒写。持久化再次校验 v4 manifest、证据 hash 和规则 hash。CLI / worker 不接受外部准备对象。

## 仍保留的收益方法边界

- 只有逐流 FX，不等于具备每次流入前后 NAV。
- 有外部流的快照区间仍为 `modified_dietz_estimate`；混合区间仍明确标记估算，不能改称精确 TWR。
- CNY 日期精度**现金**流继续使用已有显式源时区日终假设；若快照切过未知日，仍阻断。证券流不得沿用该现金假设。
- XIRR 保留 ACT/365、投资者符号和评价时区；无根、多根、同日或输入缺失不伪造 0%。
- 回撤仅覆盖提供的单位净值快照，不表示完整交易日或盘中风险。

## 复现与验证

先增加失败测试，验证旧版拒绝新参数且旧输入缺少 v3 防护，再实现新计算。测试数据库均为临时合成资料；`manual_verified` fixture 标签不代表真实资料已验真。

```sh
/tmp/etf-workbench-python-venv/bin/python -m unittest discover -s tests/performance -p 'test_*.py' -v
env WORKBENCH_PYTHON=/tmp/etf-workbench-python-venv/bin/python node --test tests/performance/*.test.mjs
```

`tests/performance/test_flow_fx.py` 覆盖真实临时账本到估值到绩效路径、多个原币流/提款、期末 FX 不改历史投入、CNY-only、内部流排除、冲销重放、晚到资料/修订、省略历史成员、来源质量、单位/basis/正值/歧义、日期和公开时点、超 18 位派生小数、CAS/lease/恢复锁及证据篡改。

`tests/performance/flow-contracts.test.mjs` 用 Python 实际产出的 fixture 在 Ajv 校验 manifest、规则、证据和跨语言 binding hash；拒绝数字类型金额、客户端 FX 注入和越权字段。结构有效不替代数据库来源校验或人工权限。

初版 v3 切片记录为 Python 47 项、Node 跨语言合同 1 项通过，不能作为现在 v4 的通过凭证。当前新增 `tests/performance/test_security_flows.py`；同版全量结果见 [进度与证据](07-implementation-tracker.md)。真实资料验收仍独立进行。
