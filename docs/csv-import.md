# 通用 CSV 原件、人工映射与入账

状态：已接入原件零写检查、可视化字段映射向导、不可变映射版本、逐行预览/重复核对、原子确认及高级 JSON 编辑；属于通用显式映射，不是券商原生适配器。具体券商须提供获授权的脱敏样本并单独核验，不宣称已经支持或认证其原生格式；D-07、ACC-18 和 P-02 的完整验收仍未闭环。

## 1. 范围和固定边界

解析器采用 [RFC 4180 第 2 节的引号、双引号转义和引用内换行规则](https://www.rfc-editor.org/rfc/rfc4180.html#section-2)，分隔符与记录换行必须显式声明，不做格式猜测。支持范围为：

- 编码仅 `utf-8`；接受文件开头的 UTF-8 BOM，非法 UTF-8、UTF-16/二进制控制符拒绝，不使用替代字符容错解码。其他编码需将来明确增加可追溯转换；当前不猜 GBK/GB18030。
- `delimiter` 为 `,` / `;` / tab；`record_separator` 为 `crlf` / `lf` / `either`。引用内换行保留原样；引用外裸 CR 拒绝。
- 第一条记录必须是表头；不跳过说明行、不搜索“看起来像表头”的行、不忽略空数据记录。
- 表头原样保留；重复表头，以及 Unicode NFC/两侧空白规范化后发生歧义的表头拒绝。映射与实际表头必须精确一致，包括顺序和空格。
- 字节上限 4 MiB；数据最多 10,000 行、每行最多 128 列；原始字段最多 64 KiB、原始记录最多 256 KiB、单个表头最多 256 字节；映射文档最多 256 KiB。这些上限不是客户端可提高的选项。
- 文件名、扩展名、公式、宏、URL 和单元格内容都不是可执行代码；纯解析/映射模块无网络、文件系统或数据库写操作。上传服务另行留存原件和审计证据。

## 2. 稳定函数契约

`web/src/server/ledger/csv.ts`：

```ts
parseCsvBytes(bytes: Uint8Array, dialect: CsvDialect): CsvDocument
csvFormulaLike(value: string): boolean
```

每条记录保留 `cells` 和原件定位：`record_number`（表头为 1）、`line_start` / `line_end`（物理行从 1 开始）、`byte_start` / `byte_end`（原始 UTF-8 文件零起点、左闭右开，不含记录结束换行；包含引用内换行）。BOM 计入原件 hash 与字节偏移，不加入首个表头字段。

列宽错误、空数据记录等可恢复错误按行完整报告；畸形引号、非法编码、控制符、资源超限等无法可靠确定后续行界限的问题作为文件级错误处理，不猜测后续记录、不提交已解析前缀。

`web/src/server/ledger/csv-mapping.ts`：

```ts
parseCsvMapping(raw: string): CsvMapping
normalizeCsvDecimal(raw: string, format: CsvDecimalFormat): string
mapCsvImport(bytes: Uint8Array, mapping: unknown, context: CsvImportContext): CsvMappingResult
```

`csvMappingSchema` 及 `CsvMapping` / `CsvImportContext` 类型可直接导入；版本为 `csv-import-mapping-v1`。JSON 字符串使用现有严格 JSON 解析器，拒绝重复 key 和深度超限；Zod 拒绝未知字段。保存/确认入口取服务端会话身份，不信任文件中的操作者或授权字段。

可信调用上下文由服务端读取，而非从 CSV 或客户端接受授权目录：

```ts
{
  portfolio_id: string,
  account_id: string,
  accounts: Array<{id: string, portfolio_id: string}>,
  listings: Array<{id: string, currency: string}>
}
```

一次导入只允许指定账户；跨组合账户拒绝，目标账户必须在同一组合。证券代码通过明确 lookup/constant 映射成 `listing_id`，并与上下文中的币种匹配；`000001` 永远不会先转成数字 `1`。实际成交可能发生在已退市证券上，因此本解析器不把“当前可买”作为历史事实导入条件；最终关系与经济规则由账本预览再次检查。

## 3. 映射必须写明的内容

映射顶层包含：

```text
schema_version, mapping_id, version, title, dialect
expected_headers, ignored_columns
account, event_type, source_id, source_event_id, reason
effective_at, rules
```

- `account` / `event_type` 只能是显式常量或字符串查找表；不猜“买入”“入金”等券商原生值的含义。
- `rules` 为每种标准事件提供独立字段映射；本版覆盖既有现金、持仓、成交、费用、分红、换汇、现金转账、拆分等 15 类基础事实，不包含后续新增证券在途转移事件。
- 可使用 `constant`、`lookup`、`column`、`decimal` 四类绑定。除常量外均明确源列；字符串是否 trim、空值是否允许 omit 必须写明。
- 所有原始列必须映射或列入 `ignored_columns`；不得同时映射又忽略同一列。忽略是人的明确声明，不代表系统认定该列没有财务含义。
- `listing_id`、`target_account_id`、`related_event_id` 只允许明确常量或 lookup，不把券商原生代码/流水号当作内部数据库 ID。
- 成交、换汇、转出必须显式声明费用映射；分红确认须显式声明税费。费用/税空值不能 omit 后默认为零；确实为零时需用户明确映射常量 `"0"` 或真实零值列。
- 期初持仓成本允许按既有账本口径未知，但会返回 `CSV_OPENING_COST_UNKNOWN`，不能虚构为零成本。

数字格式必须明确：`decimal_separator`、`grouping_separator`、`negative_style`、`allow_leading_plus`、`trim`。支持显式声明的常规三位分组、括号负数、逗号小数等；拒绝无声明的千分位、货币符号、百分号、指数、NaN/Infinity、畸形分组和超精度值。金额使用十进制字符串与 `Decimal`，不经 `Number`，不舍入原始事实。

日期只支持明确选定的 `YYYY-MM-DD` / `YYYY/MM/DD` / `YYYYMMDD` / `ISO8601_OFFSET`，并要求明确 IANA `source_timezone`。日期型保留 `time_precision: date`；时间戳必须含秒与 UTC/偏移，最多毫秒精度，转为准确 UTC 值。无时区时间、无效日历日期、闰秒和超出本版精度的时间戳拒绝，不猜时区、不截断。

## 4. 输出与确认边界

输出包含：

- `document`：原字节 hash、BOM、表头、原始单元格、全部可定位记录及语法问题。
- `rows`：每行原始定位/内容、`errors`、`warnings` 和标准候选 `command`。同一行可包含多个独立映射错误。
- `content_hash`, `mapping_hash`, `context_hash`, `preview_hash` 及解析器/映射器版本。原件字节、映射版本、上下文目录或转换结果变化都会改变绑定 hash。
- `standard_rows`：仅当全部记录无结构/映射错误时提供完整数组，否则为 `null`，不会悄悄过滤错误行。
- `status`: `parse_error` / `mapping_errors` / `requires_ledger_preview`；`can_preview` 不等于可确认入账。
- `broker_format_verified` 始终为 `false`，不能通过输入一个 `approved` 或 `PASS` 字段改变。

标准行兼容现有 JSON 导入输入，不含客户端 `portfolio_id`、`expected_revision`、`idempotency_key`。CSV 服务端注入范围和确定性行键并运行账本预检，以验证余额、依赖事实、时间先后、成交本金/费用及跨文件重复。仅 CSV 解析通过，不能确认真实事实。

没有可靠来源记录号时，保留每一行并报告 `CSV_RELIABLE_SOURCE_ID_MISSING`，不能删除两笔金额相同的真实交易，也不能声称已验证业务去重。

公式型内容仅是原始文本：`=`, `+`, `-`, `@` 等前缀会产生 `CSV_FORMULA_LIKE_TEXT_NOT_EXECUTED`。数值列中的公式因不符合十进制格式被拒绝；备注里的公式保留为惰性文本。负数也可能被保守标记，此标记不是恶意判定。UI 按文本转义；原件下载保持原字节，不中和或改写公式。如新增电子表格导出，必须另外进行公式中和，不能宣称原件适合安全地自动打开。

## 5. 上传、封存与确认

`POST /api/workbench/csv` 接受 multipart 字段 `portfolio_id`、`account_id`、`expected_revision`、`mapping`、`file`，每项恰好一次。会话与同源检查先于读取请求体；传输总限额 5 MiB，再分别检查 4 MiB CSV 和 256 KiB 映射。非 UTF-8、重复/未知字段或伪造范围拒绝。

- CSV 原字节保存为按内容 hash 命名的 `.csv`，MIME 为 `text/csv`；映射原文另存 `.json`。同字节不同 MIME 不是同一附件，不将标准行 JSON 冒充券商原件。目录 0700、文件 0600，下载时重核 hash/大小/类型/授权，拒 symlink。CSV 和既有 JSON 均纳入加密备份/恢复。
- v11 表 `csv_mapping_versions` 以组合/账户/映射标识/版本唯一锁定定义；内容变化须新版本。同定义空白不同的再次上传保留自己的原文附件，首次封存版本不被替换。
- `csv_import_manifests` 锁定原件、映射、解析/映射器版本、相关目录上下文、原文定位、标准行、预检结果、候选与 review hash；封存后批次输入与 `import_rows` 不可改写。相关上市标识/账户上下文改变会失效，无关目录新增不误失效。
- 预览在 savepoint 执行事实路径然后回滚，不产生资金或持仓。状态错误但有经济字段确切匹配的历史行可标 `link_only`：只能核对后关联，不能以此绕过时间顺序而新增事实。关键解析、映射、来源冲突仍阻断整批。
- 确认沿 `/api/workbench` 的 `confirm_import`，必须提交封存预览 hash、账本 revision 和 `csv_review`。服务端按批次保存的 parser 路由，不能省略 review 后从 JSON 入口绕过。
- 同一立即事务重新读取/重算证据、相关上下文及候选，确认实际选定计划，写每行 `csv_import_outcomes` 和审计，再变为 confirmed。终态不可补写行结果；中途错误或恢复只读门禁使全批回滚。
- 确认重试核对封存证据、原 review 与逐行结果，只返回原回执；不会声称用新版解析器重新解析了历史批次，也不会重新入账。相同原件一旦确认，不能换映射创建第二套资金解释，必须走事实更正。

## 6. 逐行重复核对

可靠来源号的范围为账户、`source_id`、`source_event_id`、事件类型。相同来源不同经济内容拒绝；确认的人工关联也参与之后 CSV、JSON 和直接事实入口的来源去重，不能换文件后丢失来源绑定。同文件重复来源跟随首行的实际关联结果，不因首行人工关联而再次新增资金。

缺少来源号或存在同账户现有/前行候选的行必须逐一提交决定和非空理由：

```json
{
  "acknowledge_unverified_mapping": true,
  "review_hash": "<server preview hash for candidates>",
  "rows": [{"row": 1, "action": "record_distinct", "reason": "已核实为独立发生的一笔"}]
}
```

另两种决定为 `link_existing` + `event_id`，或 `link_prior_row` + `prior_row`；只能选服务器确切经济候选，前行必须更早。弱匹配只提示，不允许直接关联。所有必须核对行恰好覆盖一次，不能多行、漏行或重复行；全局勾选不能代替逐行判断。确切相同不等于已证明同一笔真实交易，独立等值事实仍允许经核对后分别记账。

候选按十进制标准化及实际时点匹配，日期型保留时区、秒型按 UTC 瞬间；扫描当前活动事实，过滤冲销和已被替代事实。候选累计超过 100,000 明确拒绝，不悄悄截断。去重提示不保证穷尽所有跨格式重叠。

账户账本默认使用可视化向导，也保留高级 JSON 编辑模式。流程为：

1. 选择真实导入账户和 UTF-8 CSV 原件，检查逗号、分号和 TAB 三个方言候选；必须人工选择分隔符与允许的记录换行，候选有效不代表交易含义正确。
2. 明确来源、日期列/格式/时区、来源号是否可靠、事件类型、账户、上市标识和各类经济字段。没有资金、费用、税额或券商模板默认值；明确零值仍需人工输入。
3. 对照映射从完整原值分页读取，每页最多 100 项、256 KiB，保留前导零和公式样式文本。按列展示的有限样本会标注截断，不用于推断全部值或生成截断对照键。已建对照每组 25 项；未覆盖值会阻断，不跳行。
4. 明确忽略未用列，核对完整映射 JSON，再生成并应用到原文件。任何映射编辑、原文件或账本上下文变化使已生成映射失效。新检查会先提示清除向导草稿。
5. 保存证据并预览，按原有逐行决定及整批确认链入账。客户端复算文件 SHA-256，检查结果、应用映射和预览必须绑定同一原件。加载或曾提交的版本作为编辑参照，服务器最终强制不可覆盖；预览失败也可能已封存，修改定义需明确新版本。

`POST /api/workbench/csv/inspect` 使用认证会话、同源检查、实际账户范围和整数 revision CAS；接受 `file`、`portfolio_id`、`account_id`、`expected_revision`、`dialect`（`auto` 或明确 JSON 方言），可选 `values` 分页请求。认证先于读取请求体，复用现有文件/行/字段解析限额；响应最多 2 MiB。账户及上市标识选项各最多 1,000 项且各受 256 KiB 限额，提供 total/truncated；可明确填写未展示的完整标识，最终由服务器核验。

检查只读完整原件和目录，不保存附件、映射、批次、审计或事实，不改变 revision；恢复只读模式也允许检查。保存预览和确认仍是写操作，受恢复锁限制。检查与映射只验证结构和显式声明，不证明原件真实性或券商格式认证。

逐行预览每页 25 行、每组重复候选 20 项，跨页保留全部决定；没有自动勾选或默认重复判定。普通预览在范围/版本变化后失效，但**未决确认不静默清除**：原请求、批次、原文和人工决定保留，同账户即使 revision 已推进仍只重试完全相同的序列化请求；强制切换范围后须恢复原账户或明确放弃本页重试信息。确认期间锁定组合/账户切换，并可查询服务器状态；服务器确认成功但页面刷新失败时明确区分，不把刷新错误当成未入账。

服务器收到有效范围的 CSV 确认请求后，先独立封存原请求，再调用原确认引擎；同一登录会话可在后退、前进或刷新后，从恢复记录查询原请求及实际批次状态。恢复不自动发送确认，失败尝试不等于入账，未到达服务器的请求也不会自动恢复。普通链接及整页离开仍有提示，但不能依赖 Next.js 同文档后退/前进必定弹出提示。详见下节。

下载原件与映射用于独立核对，不等于已完成账户对账。向导及恢复入口的原生桌面/窄屏/无障碍、BFCache 与中断故障交互验收仍须单独完成，服务和 React callback 测试不替代浏览器验收。

### 6.1 确认尝试与只读恢复

- schema v14 的 `csv_confirmation_attempts` 是 append-only 请求证据，不是财务事实或人工批准。按 actor 与服务端 session hash 隔离；即使两个登录都是 `owner`，也不能读取彼此尝试。只保存已通过严格外层结构和批次范围核对的请求；人工 review 错误仍可能留下尝试，以便说明失败原因。
- 保留原 UTF-8 字节对应的文本、BOM、空白、字段顺序、原 revision 和 SHA-256。相同会话、批次及原文字节幂等；不同人工决定是新的尝试，不覆盖旧请求。每条最大 5 MiB，每会话最多 128 条 / 64 MiB；重复原文先查幂等，不因已达到预算而阻断原样重试。预算限制不通过删除旧证据规避。
- `GET /api/workbench/csv/recovery` 分页返回元数据，默认 10、最大 20 条；不会为列表加载全部请求正文，也不宣称正文已核验。按 `id` 或 `batch` + `payload_hash` 查询详情，才重核正文、附件、映射和确认结果，详情上限 24 MiB。所有 GET 均只读、禁止缓存，恢复只读锁下仍可查询。
- 详情中的实际 receipts 来自已确认结果和审计链核验，不是封存预检。`attempt_matches=false` 明确表示批次由另一份人工决定完成，不能认定此尝试执行成功，更不能再次入账。批次未确认或原 review 无效时保留阻断，不能自动修正、换 revision 或猜测人工选择。
- Web 恢复原批次、原范围和原请求后，用户才可决定是否原样重试；重试仍调用既有 `confirm_import`、幂等、CAS、来源去重和恢复锁门禁。已确认结果仅显示并刷新账户，刷新结束前保持范围锁。
- 浏览器不将完整请求放入 local/session storage。`GET /api/auth/session` 返回域隔离的客户端会话绑定值，而非 SID；CSV Web 上传和确认另带 `X-Workbench-Session-Binding`，服务器在读请求体前核对，防止探针之后 Cookie 换会话却提交旧载荷。该可选头不替代 Cookie 认证或同源校验，旧 API 调用保持兼容。页面初始及重新可见时先隐藏并核验；受保护弹窗也必须位于隐藏边界内部，不能回退到 `document.body`。退出、跨标签退出或会话改变清除本页恢复状态；新登录不自动读取旧会话请求。服务端证据仍保留，退出不是撤销事实或删除审计。
- 请求封存与确认事务刻意分离：在两者之间中断会留下未确认尝试，不会制造财务事实；确认后丢失响应可由实际回执识别。历史 v13 之前没有封存的请求不能追溯生成完整原文，只能核对已有批次和账本。

## 7. 可复现测试与未完成项

```sh
cd web
node --import tsx --test tests/csv*.test.ts
npm run typecheck
```

测试覆盖解析/映射边界、原件和 MIME/授权、真实服务预览/确认/重试、人工重复处理与来源别名、完整性门禁、事务回滚、相关上下文变更及备份恢复。当前完整运行数量、HTTP/浏览器证据和版本绑定见 [验收证据索引](08-acceptance-evidence-map.md)。

10,000 行解析及 50,000 条事实候选索引均为合成边界测试，不代表 10,000 行数据库确认的 60 秒目标。仍需后台导入任务、大批量确认性能/故障测试、向导完整交互验收，以及真实券商去标识样本的费用/结算/撤单/部分成交/编码和最终账户对账验收。当前通用映射不支持新增证券实物/在途及未知税/公司行动事件；使用对应专用入口，不将其伪装成基础事件，也不预填真实账户事实。
