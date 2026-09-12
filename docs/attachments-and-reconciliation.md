# 原始附件与账户对账实施契约

状态：内部服务与受控下载已实施；UI、主 API 接入与浏览器业务验收另行验证。本文件解释实现，不改变 01 至 06 的投资未决项。

## 原始附件

- `storeJsonAttachment` 只接收组合 ID、账户 ID 和原始 JSON 文本，不接受客户端文件路径或存储键。
- 文本按 UTF-8 完整保留，空白、换行和键顺序不变。单件上限 4 MiB，不允许非法 UTF-8 字符替换。格式错误的原件也可以留存；解析失败不等于原件丢失。
- 存储键固定为 `attachments/<sha256>.json`，相对 `WORKBENCH_DATA_DIR`。目录权限 0700、文件权限 0600，先写文件并同步，再发布元数据。失败时可能遗留无数据库引用的内容寻址文件，不会发布指向尚未完整写入文件的记录。
- 同内容复用文件，但每个组合/账户必须拥有自己的 `store_attachment` 审计关联。授权读取同时验证当前账户所属组合、审计关联中的原始哈希/大小、元数据、真实字节内容；不因知道附件 ID 就开放读取。
- 下载不创建目录、不修复权限，不修改数据库或文件。拒绝符号链接、路径替换、非普通文件、权限不符、内容哈希/大小不符。有限长读取避免文件在检查后增长导致无界加载。
- `GET /api/workbench/attachments/<id>?portfolio=<portfolio_id>` 使用服务端 session；文件名由内容哈希生成，强制附件下载、禁止缓存与内容嗅探，不暴露服务器路径。
- 导入预览引用完整原件；确认入账前重新读取并校验原件。旧预览没有原件时不能确认，应重传原始文件建立可核对的引用。
- 恢复待审标记与只读运行模式禁止新增附件、预览确认和对账写入，但允许校验后下载已有原件。

## 对账输入

`reconcileAccount` 接收：

```ts
{
  portfolio_id,
  account_id,
  expected_revision,
  attachment_id,
  resolves_issue_ids?,
  resolution_reason?
}
```

不得同时提交一份与附件分离的“余额参数”。服务只从已授权附件读取以下 statement：

```json
{
  "schema_version": 1,
  "portfolio_id": "portfolio-id",
  "account_id": "account-id",
  "cutoff_at": "2026-01-02T00:00:00.000Z",
  "coverage": {
    "currencies": ["CNY"],
    "ledger_accounts": ["cash_settled", "trade_receivable", "trade_payable", "dividend_receivable", "transfer_in_transit", "other_liability", "cash_hold"],
    "positions_complete": true,
    "balances_complete": true
  },
  "balances": [
    {"currency": "CNY", "ledger_account": "cash_settled", "balance": "100"},
    {"currency": "CNY", "ledger_account": "trade_receivable", "balance": "0"},
    {"currency": "CNY", "ledger_account": "trade_payable", "balance": "0"},
    {"currency": "CNY", "ledger_account": "dividend_receivable", "balance": "0"},
    {"currency": "CNY", "ledger_account": "transfer_in_transit", "balance": "0"},
    {"currency": "CNY", "ledger_account": "other_liability", "balance": "0"},
    {"currency": "CNY", "ledger_account": "cash_hold", "balance": "0"}
  ],
  "positions": []
}
```

该格式是受控标准化对账声明，不假定券商原始对账单已按本格式提供。以后新增券商解析器仍须保留其原件与映射版本，不能将模板当作已完成券商验证。

金额按借方为正的账本口径：应付款通常为负，不得直接拿券商显示的无符号负债值比较。每个覆盖币种必须明确给出七类余额，零值也不省略；空持仓必须通过 `positions: []` 和 `positions_complete: true` 明确声明。持仓行使用 listing ID、币种和十进制数量，不以估值金额代替数量核对。成本、NAV 和策略表现不在该余额对账函数中判定。

### 证券转仓在途的附加证据

`schema_version: 1` 保持兼容。没有未完成证券在途 lot 的账户，可继续使用上述旧格式；有源端待交付或目标端待接收 lot 时，必须在原声明中**同时**补充：

```json
{
  "coverage": {
    "security_transits_complete": true
  },
  "security_transits": [
    {
      "transfer_event_id": "original-security-transfer-out-event-id",
      "source_account_id": "source-account-id",
      "target_account_id": "target-account-id",
      "listing_id": "listing-id",
      "currency": "CNY",
      "quantity": "4"
    }
  ]
}
```

这是追加到完整 statement 的字段示意，不是单独可提交的 statement；既有 coverage、现金余额、截止时点和持仓字段仍然必需。该补充可以依据转仓申请、出库/接收回执等凭证人工核对，**不假设券商余额表天然具有这些字段**，也不通过转仓计划推测实际在途事实。

- `positions` 只比较账户 `position_projections` 中的已入库/持有数量，不混入在途。转出后源账户的 settled 数量减少；目标账户在真实接收事件发生前不增加 settled 持仓。
- 同一未完成 lot 在源账户声明中代表待交付，在目标账户声明中代表待接收。两端均需明确确认剩余数量；它的资产归属仍在源账户，不能在目标重复计入持仓、现金或净资产。
- 按 `transfer_event_id` 逐 lot 核对，不按 ticker/总数量合并。部分接收、退回和拆分后的剩余数量必须与当前投影精确一致，不能沿用最初转出数量。
- 两端账户、组合、原始有效转出事件、证券和币种必须匹配；重复 lot、缺失 lot、额外/已关闭 lot、非正数量、数量差异或币种覆盖遗漏均生成对账 issues。未知/已冲销的转出 ID 不能替代当前有效转出事件。
- 不接受 `cost_amount`、`cost_known` 或客户端估值。历史成本未知或为零，仍需要逐份核对在途数量；数量匹配不等于成本已知、估值完整或获得交易权限。
- 显式声明覆盖时，即使没有在途，也须提供 `security_transits: []`。没有在途且完全不提供这组新字段的旧格式仍有效；有在途时缺省不能当作零。
- 在途涉及外币时，该币种也必须纳入 `coverage.currencies`，并明确七类现金/挂账余额；零余额不省略。
- 一端匹配只影响当前被核对账户，不自动启用另一端，不关闭另一端旧问题。活动在途不会因对账而被接收、退回、结算或删除。

## 截止时点与结果

- 当前实现比较当前投影，不重建任意历史投影。只在当前投影没有包含截止时点之后的该账户事实时允许比较；否则返回 `HISTORICAL_RECONCILIATION_UNSUPPORTED`。
- 截止检查包括 `security_transit_movements` 的源端和目标端；即使历史成本为零/未知、没有任何货币 posting，转出、部分接收、退回和源端拆分仍影响两端的对账截止范围。不能用较早 statement 核对较新在途投影。
- 日期粒度事实不能伪造盘中时刻；截止时点必须晚于该事实来源时区的完整日期。未来 statement 拒绝。
- 在 `BEGIN IMMEDIATE` 事务内重新检查当前账户范围、恢复只读状态和组合 ledger revision；陈旧输入返回版本冲突。
- 币种、挂账范围或持仓遗漏、重复行、未知证券以及数量/金额差异均保存 `reconciliation_runs/issues`，不自动生成调平分录。金额使用十进制精确比较，不设隐含容差。
- 完全匹配且没有该账户旧的未解决差异，才将该账户从待对账变为 active；不改变其他账户、不自动启用 disabled 账户，也不赋予市场交易权限。
- 新的一次匹配不静默关闭历史问题。需要显式提供 `resolves_issue_ids` 和非空原因，以新的匹配运行、附件和操作者为解决证据；跨账户问题和比旧问题更早的截止时点不能用于解决。

## 验证入口

```sh
cd web
npx tsx --test tests/attachments.test.ts tests/reconciliation.test.ts tests/ledger-imports.test.ts
node --import tsx --test tests/security-transit-reconciliation.test.ts tests/reconciliation.test.ts
npm run typecheck
```

专题测试覆盖 UTF-8 原件保留、权限、文件/目录符号链接、元数据及内容篡改、授权范围、只读下载、导入确认前完整性、十进制差异、证券/币种遗漏、显式挂账覆盖、截止时点、版本冲突及旧问题的显式解决。测试不使用真实账户或生产数据。

证券在途新增 8 项合成测试，连同既有账户对账 11 项共 19 项通过：已知/零/未知成本、源/目标双边覆盖、不得把待接收当持仓、逐 lot 数量/身份/币种/重复/缺失、部分接收/退回/拆分、零 monetary posting 的截止漏洞、显式解决旧问题、disabled 保留和无在途旧格式兼容。它们不替代真实券商转仓凭证验收。
