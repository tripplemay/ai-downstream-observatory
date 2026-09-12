# 估值消费端单位防线与 v2 方法

## 复现范围

本次复核区分了标准入口与已有存储数据，没有将隔离测试解释为生产账本已发生错误。

- 标准入库路径 `batches._normalized_observation()` 原本已校验 `close.unit == listings.currency`；不匹配批次不能验证/发布。
- FX 入库原本已要求 `CNY_per_unit_currency`、正值及 `not_applicable` basis。
- 原估值消费端未再次核对单位。通过临时测试数据库直接注入、刻意绕过上述标准校验的坏历史发布后，旧实现仍将错误币种价格/反向单位汇率视为 complete。此路径是消费端防御缺口，不是当前 ingestion 可以提交此类记录的证据。
- 原来持久化去重也可能返回同输入键下的旧 v1 结果，不能仅修改计算代码而不区分方法版本。

## 修复

- `worker/market/valuation.py` 在价格和 FX 的 PIT 选择完成后再次校验单位；最新选中行若有单位错误，阻断总 NAV，不回退旧报价制造可用结果。
- 价格仍只选 `unadjusted`，FX 仍只选 `not_applicable`；复权/总回报价不会替代未复权持仓市值。
- 错误代码为 `PRICE_CURRENCY_MISMATCH:<listing>` 或 `FX_UNIT_MISMATCH:<currency>`，总 `nav_cny=null`，相关估值项目不填伪造金额。
- 方法升级为 `decimal-nav-cny-v2:as_known/restated`。旧 v1 快照保留审计，不覆盖、不复用；当前 writer 拒绝提交旧版本 PreparedValuation。消费方必须将 v1 标为过期方法，不能继续作为当前绩效或建议依据。

## 验证

`tests/market/test_valuation_units.py` 在修复前复现 3 项失败，修复后覆盖：正常入库拒绝错币种/错 FX 口径、坏历史单位消费阻断、复权与未复权隔离、旧 v1 去重不复用且不可由当前 writer 提交。

```sh
python -m unittest tests.market.test_valuation_units -v
python -m unittest discover -s tests/market -v
```

所有场景均使用合成数据和临时数据库；未修改真实用户账本、历史发布、已有迁移或研究准入门槛。
