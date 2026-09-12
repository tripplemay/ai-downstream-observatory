# 证券实物转移：记账、在途与收益边界

日期：2026-09-12。实现说明，不是券商接入或投资政策验收。

## 事实类型

| 类型 | 用途 | 必需事实 |
|---|---|---|
| `security_in` | 组合外部转入证券 | 账户、上市标识、原币、数量、转入时的原币市值总额及同一时点的核实依据；历史成本可缺失 |
| `security_out` | 转出到组合外部 | 同上；成本由现有持仓释放，不能客户端覆盖 |
| `security_transfer_out` | 组合内账户之间发出转仓 | 来源/目标账户、同一上市标识/币种、数量 |
| `security_transfer_in` | 目标账户实际接收，可分批 | 原转出事件 ID、实际接收数量、目标账户及相同上市标识/币种 |
| `security_transfer_return` | 转仓失败或部分退回 | 原转出事件 ID、实际退回数量、来源账户及相同上市标识/币种 |

- 本工作台不执行券商转仓。记录必须已经发生；资金预算、转仓申请和预计到账不是实际接收。
- 同一组合内转仓必须显式使用内部三种类型，不能录成一出一入的外部资本流；跨组合则分别确认各自边界。
- 手续费另记 `fee`，这些证券事实不接受附带费用/税字段，也不自动判断证券税务成本。
- 外部 `market_value` 是本次数量的原币总市值，不是单价、净额、当前行情或历史成本。`value_evidence` 保存 `security-transfer-value-v1`、依据引用、实际时点、时间精度和 IANA 来源时区；时点/精度/时区必须与事件一致。
- 表单将人工确认值写入标准事实 JSON 原件，经现有预览/确认链保存。不表示系统已核验引用所指的原始券商凭证；真实券商样本仍待提供。

## 账本与所有权

外部转入的市值计外部资本，历史成本计管理成本；两者差额只进入
`capital_valuation_adjustment`，不作为现金、收入或 NAV 资产再加一次。
未知成本保持 `cost_known=false`，其后卖出不能把全部收入当作已知盈利。

内部发出时，已入库持仓减少，新增以原转出事件 ID 标识的在途批次。
来源账户保留所有权，目标账户在真实接收前没有可卖持仓。逐批维护
`security_transit_movements` 的追加记录及可重建投影；携带成本科目
`inventory_in_transit_cost` 也不能直接计入 NAV。

部分接收/退回按**剩余成本 × 本次数量 / 剩余数量**分配到 18 位小数，
half-even 舍入；最后全部接收/退回拿走所有残余成本。来源账户发生拆分时，
同时调整其已入库和仍由其拥有的在途批次数量，成本不变；目标已收到的份额
按目标账户自己的拆分事实处理，不能重复应用。

历史更正使用原有追加冲销和重放机制，重新关联替代后的转出批次。不能只作废
转出而保留接收/退回依赖，也不能原地改写原批次或伪造成本调整。

## 估值、收益与风控

- 估值方法升级为 `decimal-nav-cny-v3`，输入为 `valuation-input-v2`。
  在途项 `security_in_transit_market_value` 按当时数量 × 未复权价格 × FX
  计入来源账户一次，与目标已入库份额分开；保存原转出 ID、目标账户、
  数量及价格/FX 引用。Python 生成，Web 从不可变 movements 独立重算复核。
- 绩效升级为 `snapshot-performance-cny-v4`、`performance-input-v4`。
  外部证券市值作为资本流扣除，内部转仓不构成组合出入金。
  `flow-fx-evidence-v2` 绑定证券数量、确认市值、价值依据和原 fact hash；
  外币按事件时点的已核实 FX 转换，不用期末 FX 代替。
- 所有币种（包括 CNY）的仅日期外部证券流，在可能影响所选期间时阻断绩效；
  不凭空补盘中价格或默认日终流入。事实仍可先入账，待真实时点核实后更正。
- 新增投资风控将来源拥有的在途纳入集中度、币种和策略暴露，并绑定输入摘要；
  可卖量只使用已入库持仓扣除预留。在途不能用于卖出或现金买入预算。
- 旧估值 v2 / 绩效 v3 保留审计，但标记方法已过时；不得继续当作当前有效结果。

## 对账和交互

有未完成批次时，来源/目标账户各自对账都必须明确提供转仓覆盖及逐批数量。
`positions` 仍仅表示已入库持仓。附加转仓凭证检查不等于券商自动提供了该字段。
详见 [原件与对账](attachments-and-reconciliation.md)。

账本页面提供五种事实的表单：先预览、不产生事实；核对冻结内容后确认。
修改字段或切换组合/账本版本会清除确认内容。确认响应丢失时保留同一批次，
重试不会重复入账。没有批次时不能确认接收/退回，没有资料时不推断证券可买性。

## 回归入口与未闭环项

- `web/tests/security-transfer-{engine,service}.test.ts`
- `web/tests/security-transit-reconciliation.test.ts`
- `web/tests/valuation-freshness.test.ts`
- `tests/accounting/test_security_transfers.py`
- `tests/market/test_security_transfers.py`
- `tests/performance/test_security_flows.py`
- `tests/migrations/workbench.test.mjs` 的 v9 升级案例
- `web/scripts/test-workbench-http.mjs` 的 `HTTP-SEC01`

仍需真实来源凭证、完整公司行动/税务情形、目标部署镜像和恢复验证、正式
账户/策略准入。测试仅使用临时合成账本，不授权实际转仓、交易或保证收益。
