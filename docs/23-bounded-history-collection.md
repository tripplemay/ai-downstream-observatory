# 多年历史分片与断点续采

## 目标与边界

为“真实资料 → 参考组合”准备多年日线，不再逐条填写窗口。策略仍以分散配置、新现金优先修复、低频再平衡为基准；此功能不选择 ETF、个人风险或权重。

新增高级本地命令 `plan-history` / `collect-history`，不是投资者首次使用的要求。软件验证使用虚构资料与模拟 SDK；没有为真实账户填写许可批准、保存真实行情到研究库、开启生产采集或部署。

## 1. 计划与复用

- 只接受当前所有者和既有 rights/listing/calendar 审阅 ID。沿用私有研究、留存、展示、备份四项用途门槛；缺项、过期、撤回、被新审阅替代或范围不符直接拒绝，不从 Key 前缀推断适用协议。
- 最长 3660 个自然日，结束必须早于市场当前当地日期。按起点连续划分不重叠的 31 天窗口，覆盖全部自然日；预期交易日期只取已审阅完整日历和证券生命周期，不以工作日算法推断真实开市。
- 全休市或上市前的片段标记 `no_sessions`，不发空请求、不补零。整个区间没有可交易日期时拒绝，不显示“覆盖完成”。
- `plan-history` 不读凭据、不访问供应商、不写库。输出哈希、日期、数量、状态和收据 ID，不输出价格。哈希绑定范围、审阅 ID/内容哈希及各请求；有效期同时受来源与已复用载荷留存期限制。
- 仅复用同审阅集合、仍有载荷、当前有效、请求恰好等于计划分片且经过收据/投影重放的 capture。默认拒绝测试注入。重叠、重复或错位窗口不能自动选择“最新”，需显式整理范围和输入选择，不删除原记录。
- `price_coverage_complete` 只证明当前收据与审阅日期集合相等，不证明官方日历、公司行动、总收益、历史时点档案、许可或投资资格。多证券快照仍受最多 1000 个 capture 限制，不是任意 20 个证券十年数据都可组装。

## 2. 有界采集

先检查计划，再明确提交它的 `plan_hash`。以下路径、ID 和哈希均为占位符，不能作为真实资料批准：

```sh
python -m worker.investor.data_pipeline \
  --db /private/workbench/research.db --workspace WORKSPACE --actor OWNER \
  plan-history --rights-review RIGHTS --listing-review LISTING --calendar-review CALENDAR \
  --start 2016-01-01 --end 2025-12-31

python -m worker.investor.data_pipeline \
  --db /private/workbench/research.db --workspace WORKSPACE --actor OWNER \
  collect-history --rights-review RIGHTS --listing-review LISTING --calendar-review CALENDAR \
  --start 2016-01-01 --end 2025-12-31 --plan-hash PLAN_SHA256 \
  --credentials-file /private/config/longbridge.env --max-calls 4
```

- 每次默认最多 1 次、硬上限 4 次，串行且调用起点至少间隔 1 秒；不保证同账户其他进程的全局配额。保留固定 SDK、日线/不复权/正常时段、隔离 UTC 子进程和每次 30 秒截止；不重试、不刷新 Token、不访问账户/交易接口，不允许自定义端点或测试数据开关。
- 每片独立在短事务内提交，网络期间不持有写锁。调用前及提交事务内检查保留中的重叠窗口，两个连接竞争不能同时提交重复价格；原来源和恢复锁保护保留。
- 后续每片重新验证所有者、审阅、计划及已有收据。任一失败立即停止，只输出固定错误码；此前成功片段保留，不回滚它们或写空数据。重新运行 `plan-history` 查看状态，再明确续采；不后台重试。
- 同一有效计划只处理缺失片段，全部完成时不读凭据、不调用 SDK、不写库。时钟回退不能通过忽略未来收据再采一次；恢复锁下即使全部完成也拒绝 `collect-history`。
- 过期或已审计删除的载荷不复用，采集不会自行删除旧载荷；WAL/备份及到期清理仍走现有流程。单窗口命令默认行为、财务合同和迁移不变。

## 3. 真实早期样本（2026-10-08）

既有内存检查器使用仓库外凭据，每个请求仅尝试一次，无行情持久化、研究库访问或自动重试：

| 标的 | 区间与显式预期日期 | 结果 |
| --- | --- | --- |
| `510300.SH` | 2016-09-19 / 2016-09-20 | `LONGPORT_PROVIDER_CALL_FAILED` |
| `2800.HK` | 2016-09-19 / 2016-09-20 | `sample_read_ok`，2 根日线 |
| `SPY.US` | 2016-09-19 / 2016-09-20 | `sample_read_ok`，2 根日线 |
| `510300.SH` | 2020-03-16 / 2020-03-17 | `LONGPORT_PROVIDER_CALL_FAILED` |

失败未输出部分行情。固定错误码隐藏供应商异常和子进程校验细节，不能据此区分认证、权限、覆盖或响应形态，也不能断言 A 股历史接口普遍不可用。此前近期 A 股成功记录仍保留于 [12](12-longbridge-apikey-server-access.md)。

日期参考[上交所 2016 中秋休市公告](https://www.sse.com.cn/disclosure/announcement/general/c/c_20160906_4174153.shtml)、[港交所 2016 证券交易日历](https://www.hkex.com.hk/eng/prod/dataprod/Documents/HKEx%20Trading%20Calendar%202016.pdf)、[NYSE/ICE 2016 休市公告](https://ir.theice.com/press/news-details/2014/NYSE-Group-2016-Holiday-Calendar-and-Early-Closings/default.aspx)和[上交所 2020 年休市安排](https://www.sse.com.cn/disclosure/announcement/general/c/c_20191220_4969627.shtml)；只用于两日诊断，没有建立完整审阅日历或交收规则。

官方[历史 K 线文档](https://open.longbridge.com/zh-CN/docs/quote/pull/history-candlestick)列出三地多年日线范围，但账户与固定 SDK 的实际可读范围仍须验证，成功样本不等于连续十年覆盖。[交易日接口](https://open.longbridge.com/zh-CN/docs/quote/pull/trade-day)只支持最近一年、单请求不超过一个月，不能用来补造十年日历或历史交收。接口能力、适用协议、长期留存/备份及外部 AI 传输条件分开核验。

### 3.1 早期 A 股诊断补查

同日新增内存检查器的显式 `--diagnose`，只区分固定 SDK 调用阶段和白名单校验码；默认持久采集不改变。保留原失败，不将它们覆写为新诊断。

| 同一标的 `510300.SH` | 显式检查结果 |
| --- | --- |
| 2016-09-19 / 2016-09-20 | 首次粗分类为 `EMPTY_OR_POSSIBLY_TRUNCATED_RESPONSE`；细分空/容器/截断后明确重放，得到 `LONGPORT_EMPTY_RESPONSE` |
| 2020-03-16 / 2020-03-17 | `LONGPORT_EMPTY_RESPONSE` |
| 2026-09-21 至 2026-09-24 | `sample_read_ok`，4 根日线 |

本轮共四次显式请求，2016 窗口有一次诊断细分后的重放，不是“每窗口仅一次”。没有后台重试、Token 刷新、数据库访问、价格持久化或输出。近期控制使用同一凭据、固定 SDK、正常时段、不复权和 OHLCV 校验；只说明该路径当时可读近期数据。

两个早期窗口均在历史方法正常返回之后得到空 list/tuple，未进入逐根 OHLCV 或预期集合校验，故此前不应先归因于十进制、时区、认证或日期解析。空结果的更深原因仍未确认：不能将其当作供应商明确返回无行情/无权限码，也不能据此断言市场历史范围、换源或放宽校验。下一步在保持此证据的基础上核对特定 ETF 历史覆盖及 SDK/服务兼容性；完整多年数据、行动和 FX 准入仍不成立。

诊断回归涵盖成功投影一致、默认错误保留、固定阶段、业务码精确类型/操作范围、恶意异常不泄露、空/容器/截断区分、子进程固定退出码、传输截止/上限和 CLI 边界。证据仅为本地元数据和合成测试；不替代真实参考组合或 VPS 验收。

## 4. 验收与后续

专项覆盖三地十年虚构分片、无写计划、批次上限、收据复用、失败恢复、重复/错位拒绝、来源变化、到期/时钟回退、恢复锁、双连接竞争及最终 dataset 组装。成功只证明软件行为，不证明真实许可、价格或盈利。

继续补真实 ETF 身份/费用/暴露、日历与交收、分红拆并份及 FX；诊断 A 股响应缺口，再在适用用途明确后验收真实留存和来源到参考组合纵切。真实参考组合、自动更新、AI 与生产验收未被本功能替代。
