# 分红扣税与公司行动：实施契约

状态：2026-09-12 已实现并通过下述合成回归；不是完整 ACC-10 / E-04 验收或生产放行。不计算或推定任何司法辖区的适用税率。

## 1. 现金、权益和税额必须分开

- 保留已有 `dividend_accrual`（毛额权益确认）、`dividend_payment`（实际净现金支付）、`dividend`（毛额及扣税均明确的直接到账）。`listing_id` 可选；缺失时按账户/币种范围标记，不猜证券。
- `dividend_accrual.tax_status` 为 `unknown` / `estimated` / `confirmed`。unknown 不允许提供 tax；estimated/confirmed 必须显式给出非负累计 tax，且不超过毛额 amount。已封存旧事实有显式 tax、没有 status 时按旧显式税额解释；两者都缺少时为未知，绝不宣称最终零税。
- 新建直接 `dividend` 必须显式提供 tax，且状态为 confirmed（可省略 status 保留旧显式输入兼容）。其他情形用应收/支付分离，或下述真实净额事实。旧无税直接到账事实只保留审计/更正兼容，质量不认定完整；不原地改写历史现金。
- `dividend_net`：仅有可信实际净现金时记录 amount、`net_status: final | provisional`，不伪造毛额或税。借现金，贷 `unclassified_income`。final 表示该来源明确为最终净额，仅毛额/扣税分解缺失；否则为 provisional。
- `dividend_breakdown`：关联 dividend_net，给出 `gross_amount`、`tax`、`evidence_reference`，且 gross_amount-tax 等于原净现金。仅可有一个活动 breakdown。借未分类收入，贷毛收入，借税费；不动现金、NAV 或外部资本。后续更正走追加式更正，不覆盖旧 breakdown。
- provisional 净额的 breakdown 仅解决毛税结构，不自动确认净额最终性；必须再追加 confirmed 税认定（允许差额零），才解除净权益暂估。final 净额在补齐 breakdown 后可形成完整收入归因。

## 2. 累计税额认定与实际补扣

新增 `dividend_tax_assessment`：关联原始 dividend_accrual / dividend / 已有 breakdown 的 dividend_net，字段为累计 `tax`、`tax_status: estimated | confirmed`、`evidence_reference`。新的累计税额不得超过毛额。estimated 与 confirmed 都是认定状态，不等于实际现金支付。

每个原始分红单独从活动事实与分录重建：毛额、当前累计税、状态、实际净现金总额、应收和税应付。不得从全部 related 子事件统一减 amount。

```text
实际净现金总额 = 原始直接到账净额 + dividend_payment - dividend_tax_payment
新的净未结权益 = 毛额 - 新累计税 - 实际净现金总额
新的应收 = max(新的净未结权益, 0)
新的税应付 = min(新的净未结权益, 0)
本次税费变化 = 新累计税 - 原累计税
```

认定事件只调整 `dividend_receivable`、新负债科目 `dividend_tax_payable` 和 `expense`，始终不动现金。即使税额差为零，未知/暂估变为已确认也要新增事件和账本 revision。税应付作为负数负债纳入 NAV，不作为可投资现金。

实际净收入或退税到账用 `dividend_payment`，累计实际净现金不得超过毛额；支付后按同一净未结权益公式重算应收/税应付。暂估税额不能阻止登记已经核实的实际净现金，例如毛额 200、估税 30、实际到账 180，暂记现金 180、税应付 -10；以后税认定为 20 只消除该负债，不再增加现金。实际追加扣款用新 `dividend_tax_payment`，amount 为正、带 `evidence_reference`，不得超过同分红税应付绝对值。两类支付仅在现金和应收/税应付间结转，不再计收入或费用。所有关联同组合/账户/币种，禁止关联被冲销/替代的原事实。

例：毛额 200，税未知，先收净现金 180；确认累计税 20 只把应收 20 清零，现金仍 180。其后确认累计税 25，新增税应付 -5、费用 +5，现金不变；实际扣款 5 后现金 175、税应付为零。最终税调整回 20，产生应收 5，退款到账后现金恢复 180。每一事实均有独立来源和审计。

## 3. 复杂行动隔离和人工核实

新增两个零金额事实，仍追加 ledger revision 并使旧估值/风险输入过时：

- `corporate_action_notice`：`action_kind` 为 `dividend_entitlement` / `merger` / `liquidation` / `return_of_capital` / `other`；可选 listing_id；必填 `evidence_reference`。表示已发现但尚不能可靠转换的权益/数量/性质问题，不自动制造现金、股数或普通分红。未解决时相关日期 NAV/最终绩效 blocked。
- `corporate_action_resolution`：关联 notice，`resolution: not_applicable | recorded`，`supporting_event_ids` 与 `evidence_reference`。not_applicable 必须空支持列表；recorded 必须列出同组合、同账户的活动受支持经济事实，不能用入金/出金、另一个 notice 或自我引用充数。这是操作者核实记录，不是系统已自动验证券商规则。一个 notice 只允许一个活动 resolution。

通知和核实本身不参与货币时间顺序限制，但真实经济支持事实仍走正常更正/记账路径；不能用零金额标记把晚到的现金或数量变动绕过历史重放。支持事实更正时需重映射依赖，支持事实被撤销/越界时核实状态不能继续有效。普通余额对账不能解除未决事项。

## 4. 三类质量与时点

- 分开 NAV、最终税后绩效、收入归因质量，值均为 complete / provisional / blocked。
- 未最终的分红权益扣税、provisional 净额或旧无税直接到账：NAV/最终税后绩效暂估。缺失毛税分解的 final 净额：可信现金和 NAV 保留，最终净额口径收益可计算，但归因暂估。
- 已确认累计税与真实税应付负债可形成完整 NAV；实际支付只是资产/负债结转。解决质量不伪造已经支付。
- 未解决复杂行动：NAV/最终绩效 blocked，不因当前已清仓、仅有在途证券或行情规则声称完整而忽略。没有真实期初/资金/持仓事实时，只有 notice 不能让组合变成已起算。
- 按 revision、cutoff、knowledge_at 和 as_known/restated 模式重建活动事实。来源 hash、解决事实 hash、范围、每类质量、具体问题和方法版本冻结为 `ledger-fact-quality-v1` 证据，由 Web 独立重算并检漏。
- 未知事项的日期型通知从当地当日开始保守生效；日期型解决不得在当地当日盘中提前解封。晚到历史信息不能未经重述就变成当期收益。
- 方法升级为 NAV v4 / valuation-input-v3、performance v5 / performance-input-v5；旧方法保留审计但不复用为当前可信结果。原 external-flow v2 不改变：上述分红、税和隔离事实都不是外部投入。

## 5. 实施与测试边界

已实现独立 Decimal 核算、更正重放、scope/来源/CAS/原件/只读门禁、零差额状态事件、暂估质量、无持仓和在途事项、两种时点模式及三质量证据检漏。Web 逐项复核实际现金/负债分录、持仓、FX 和 NAV 总额；行情不能使用准备时点之后、持久化之前才获得的资料。区间包含未决事项时，不能只凭完整端点展示收益；as_known 晚补录历史经济事实要求重述，不能计作当期收益。

工作台新增九类分红/公司行动录入选择、原件预览和再次确认，根事件按账户分页查询并绑定账本版本。净额最终性、毛税拆分、应收与负数税应付分别显示。响应丢失时同批次使用同一确认请求重试；切换账户或账本版本后清除旧预览。普通余额对账不能解除未知税款或未决行动；最终净额只有归因未齐时不误挡可信现金对账。

当前证据：Web 281 项、Python 226 项、Node 58 项、生产构建 HTTP 45 项通过，见 [验收证据索引](08-acceptance-evidence-map.md)。原生浏览器使用空临时库完成未知税、实际到账、认定、补扣、退款、最终净额拆分、公司行动及同批次响应丢失重试。上述均为合成工程证据，不是实际税务处理确认。

已知边界：

- 复杂合并、清算和返还资本仍需人工核实及单独经济分录；notice/resolution 不是自动核算器。
- 标准 JSON 和专用表单支持新事实；现有 CSV 映射 v1 未扩为六个新增类型的原生券商模板。旧显式税字段保留兼容，未知税不再被重复识别归并为显式零税。
- 区间事实质量首版按事件边界重算，最坏复杂度 O(n²)；长期高事件量吞吐未验收，不能据单元测试宣称满足全部十年负载要求。
- 真实券商原件、适用税率/税务身份、复杂行动专业核算、完整键盘/读屏覆盖、v12 镜像及生产切换仍未验收。
