# 人工核实资料与 LongPort 日价格采集

状态：v17 工作区实现，尚非生产、真实行情覆盖或投资准入验收。遵守[公开边界](publication-privacy.md)：公开代码和通用示例，个人方案、凭据与真实采集证据仅留本地。

## 本轮范围

- 每次明确选择同一组合、同一市场的 1–4 个已登记 listing；日期范围含首尾，最多 31 个自然日。
- CN/HK/US 的证券映射与交易日历先保存组合私有 JSON 来源，再由人明确审核新版本；不自动抓取来源 URL。
- 固定官方 `longport==4.3.7`、`Period.Day`、`AdjustType.NoAdjust`、`TradeSessions.Intraday`；只读取 QuoteContext，不构造 TradeContext、不下单。
- SDK 对象转为精确 JSON 的不可变 `sdk_projection`。这不是 HTTP/protobuf 网络原始字节，也不声称证券可买、供应商认证或历史 PIT 完整。
- 证券身份、账户可买性、ETF 状态、政策、策略和风险批准仍走原有独立流程；资料审核或价格发布不修改这些权限。
- 本路径绑定 catalog listing，不验证 `instrument.asset_class` 已为 ETF；`unknown` 品种仍可保存资料。支持 ETF 价格采集不等于已认证 ETF 身份或生命周期。

## 私有来源、审核版本和 CAS

`/workbench/market` 提供资料与采集入口。`/api/workbench/market` 的 POST 只接受 `store_source`、`publish_reference`；GET 提供组合目录及受作用域保护的来源/版本读取。写入要求有效会话和 Origin；UI 固定附带当前会话绑定，API 在提供该 header 时复核它与当前会话一致。下载不通过公开静态目录。

1. **保存来源**：命令含 `portfolio_id`、`idempotency_key`、`reference`、`content_text`。正文为严格 UTF-8 JSON object，不含重复 key，最多 1 MiB。保留原字符串及其字节 SHA-256；不把上传者给出的文本标成供应商网络回执。
2. **人工审核**：命令含 `expected_version`、来源 ID/hash、核实理由、显式 `acknowledgement:true` 与 `document:{kind,facts}`。空缺项不能由 AI 或默认值补齐。
3. **冻结版本**：服务器生成身份、`known_at`、审核人和完整 `market-reference-version-v1`。`review_basis` 固定为 `human_reviewed_not_provider_verified`；版本 hash 覆盖规范化完整文档，来源 hash 仍覆盖原 UTF-8 字节。审计绑定输入、结果、组合、审核人和时点。
4. **更新 head**：按 `(portfolio_id,kind,scope_key)` 独立 CAS，从 1 开始逐次加一。来源、版本不可更新、删除或用 REPLACE 覆盖；更正只能追加，不重写旧来源。

资料字段：

| kind | facts | scope |
|---|---|---|
| mapping | `provider:longport`、`listing_id`、`provider_symbol`、`market`、`exchange`、`currency`、`valid_from`、`valid_to:null\|date` | `listing_id` |
| calendar | `market`、`exchange`、`timezone`、`range_start`、`range_end`、`days[{date,kind,close_at}]` | `market:exchange` |

mapping 有效区间为 `[valid_from,valid_to)`；市场、交易所和币种必须与已有 listing 一致，provider symbol 仅检查对应市场的后缀和格式。不向供应商查询真实 ticker 身份，也不交叉认证 SSE/SZSE 与代码后缀；真实证券映射关系仍需来源证据。日历范围内每个自然日恰好一条，`kind` 为 `full`、`half` 或 `closed`；营业日 `close_at` 为 UTC 六位小数、对应当地日期，休市日为 null。必须明确半日市、休市和时区，不能从周一至周五推定真实日历。`close_at` 是交易收市时间，**不是行情发布时刻**。

## 从请求到不可变发布

价格任务沿现有 `/api/workbench` 的 `enqueue_task`，外层命令含组合、账本 CAS、幂等键、`command_type:market_collect_prices` 及以下 payload。示例只说明协议；ID 必须换为本地已经审核的资料版本，不预置真实证券或个人参数。

```json
{
  "schema_version": "market-price-collect-v1",
  "provider": "longport",
  "mapping_version_ids": ["synthetic-mapping-version"],
  "calendar_version_ids": ["synthetic-calendar-version"],
  "start_date": "2026-01-02",
  "end_date": "2026-01-02",
  "expected_publication_revision": 0,
  "publish": true
}
```

任务不能携带 URL、凭据、请求头、SDK 方法、原始价格、回执或调用方知识时间。版本集合必须匹配组合、市场、有效期和完整日历，不能混用旧 head 或多余日历。

服务器按 `provider:longport:prices:` 加 `SHA256({portfolio_id,market,listing_ids:sorted})` 生成完整集合 scope。单一证券不能覆盖同集合中其他证券的当前快照；改变集合得到不同 scope。消费者只用明确发布批次的 members，不把不同历史批次任意拼接。

1. 专属 Worker 核对当前 lease/fence、引用 head、发布时间 CAS、恢复锁，冻结选择证据。
2. 在数据库写事务外按 listing 稳定顺序调用隔离 SDK；每次调用前后复核 lease 和恢复状态。完整结果逐条检查 Decimal、OHLC、时区、范围和预期交易日期。
3. 缺少、重复、多余、未来或未结束日期、空结果及可能的 1000 条截断都拒绝；不回退旧窗口、不填零或虚构停牌价格。这里证明与**人审日历**的集合一致，不认证人审资料本身正确。
4. 聚合原件为规范 UTF-8 `longport-batch-projection-v1`，保留每个 SDK 投影；回执为 `market-sdk-capture-v1`，批次为 `market-price-provider-batch-v1`。SDK 版本、映射/日历证明、调用开始/结束、原件/规范化/文档 hash 均绑定。
5. 最后短事务再次复核来源 head、lease/fence、知识时间、恢复锁、内容 hash 和发布 CAS；捕获、批次、成员、发布及任务结果原子完成。任一步失败不替换旧发布。

v17 的 `market_sdk_captures.raw_body` 为最多 2 MiB 的 BLOB，规范化与批次 JSON 各最多 4 MiB；因此原件随既有数据库加密备份，不依赖未登记的外部文件。`market_provider_captures` 继续只承载 v16 ECB 原件，两类捕获不能互相授权错误来源的批次。

`publish=false` 仅保存验证结果，不能通过旧发布 CLI 将已结束任务事后升级为发布。当前应重新发起具有当前 CAS 的明确采集请求；未实现独立的“发布既有捕获”授权命令。

## 时间、修订和消费边界

- 输出保留当地日期及 `time_precision:date`。SDK 自带 timestamp 单独留在投影，不推断为收盘或发布时间；日期不会被日历 `close_at` 偷换成秒级市场事实。
- `published_at` 缺失保持未知，`ingested_at` 为当前实际收件时点；本地 capture/revision ID 不冒充供应商修订号。今天下载的旧价格不是过去当天已知的证据。
- Python 重放投影，Web 独立核对映射、日期集合、价格与来源 hash、任务和引用证明；不是仅看 `source_mode` 标签就接受。
- 新采集/发布以及当前使用要求有效的最新引用。引用 head 更新后，旧捕获不能继续冒充当前资料；restated 新鲜度还须对照当前引用。具有冻结知识时点的历史重放按当时已知版本验证，不因后来修改而删除原证据。
- 估值、绩效和策略仍必须通过原币/口径、收市、陈旧期、税和公司行动质量规则。仅日期价格不解锁需要精确时点的外部流或研究输入，也不授予实盘建议权限。

## 专属运行时，不自动部署

| 边界 | 当前实现 |
|---|---|
| Core | 不安装 LongPort；`core` role 不派发或领取 `market_collect_prices` |
| Provider | `Dockerfile.market-provider` 独立 CPython 3.11 / Trixie，固定基础镜像 digest；`requirements-market-longport.txt` 固定 4.3.7 的已审 CPython 3.11 wheel hashes，仅二进制、`--no-deps --require-hashes` |
| 身份和环境 | UID/GID 10001、只读根文件系统、去 capabilities；独立 `market-provider.env`，不复用 Web 会话/密码配置，不打包 Node publisher |
| 领取 | `longport` role 只领取价格任务；生产默认 lease 300 秒，拒绝小于 180 秒；同一工作台数据库中的所有组合共享价格任务 mutex |
| SDK 子进程 | `-I`、固定脚本、UTC、私有临时目录与空 `.env`、环境 allowlist、stdin 凭据；父进程 30 秒 timeout/进程组清理，子进程内核 SIGALRM 30 秒硬截止 |
| 前置条件 | CLI 在打开数据库前检查批准 SDK 版本与凭据；缺配置不触碰业务数据库；不自动刷新 token |
| Compose | `docker-compose.market-provider.yml` 为显式可选 profile；基础生产部署脚本不自动启用或部署它 |

全局 mutex 的范围是共享数据库，不是跨独立数据库或其他软件的供应商账户级锁。运行环境、供应商账户并发和许可仍需运维核实。上述镜像定义和离线测试不等于本轮实际 Linux 镜像已通过；需新 exact-SHA CI 执行。

## 验证入口与尚未完成项

下列命令只使用合成资料和临时库。使用已安装核心依赖的 Python，并让 `WORKBENCH_PYTHON`、`WORKBENCH_TEST_PYTHON` 指向同一解释器；Node 跨语言测试前先安装 `web` 依赖。

```sh
node --test tests/migrations/market-prices.test.mjs
node --test tests/deployment/provider-container.test.mjs tests/deployment/release.test.mjs
python -m unittest tests.market.test_market_references tests.market.test_price_collection -v
python -m unittest tests.orchestration.test_provider_roles tests.market.test_provider_deadline -v
```

`web/tests/market-references.test.ts` 覆盖来源/审核服务；`market-price-{source,consumers}.test.ts` 独立验证实际 Python 产物，`market-reference-{client,workspace}.test.ts` 覆盖客户端和真实组件回调。未决请求只存在本页内存，明确重试保持原字节/幂等键；导航警告和新页核对不代表持久恢复，强制离开仍可能丢失。JSON 解析错误不回显私有原文。

`tests/deployment/provider-container-smoke.sh` 在 Linux CI 构建真实 native SDK 镜像，随后以 `--network none`、无凭据导入 SDK、检查签名与拒绝坏 child 输入；它不构造 QuoteContext，不请求行情，也不代替账户权限检查。

已完成的本地冻结源码回归见 [07](07-implementation-tracker.md#price-collection-worktree-v17) 和 [08](08-acceptance-evidence-map.md#price-collection-v17)。本地测试通过不能替代尚未验证的新提交镜像、真实市场或生产结果。

仍未完成：供应商适用许可/原件保存条件、实际 A/HK/US 数据和权限、权威映射与交易日历、定期自动采集、原生桌面/窄屏/辅助技术交互、完整故障与规模验收、异机恢复、生产配置与上线，以及任何 D/G/S 投资准入。
真实网络原件、SDK 投影和私人权限证据必须放 `.private/` 或受控数据目录，不能放入 CI 上传的 `artifacts/verification/`；代码和通用示例不包含个人资金、券商选择或凭据。
