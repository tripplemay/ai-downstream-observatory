# 历史人民币计价汇率接入

进展记录日期：2026-10-12；本记录不代表完整研究组合已上线。

## 范围

新增独立的 ECB 全历史 XML 读取器，供私有研究来源准备使用；不扩大旧 `daily` / `hist_90d` 行情采集合同，也不自动审批来源、发布组合或创建金融事实。

- `worker/market/providers/ecb.py`：新增固定 HTTPS 地址的 `download_ecb_history_xml`，单次下载最多 16 MiB、最长 30 秒。保留证书校验、公网 DNS 地址检查、禁止重定向/压缩、HTTP 头检查和流式字节上限。旧下载仍为 2 MiB。
- `worker/market/providers/ecb_history.py`：`parse_history_xml` 校验整份文件，最多 10,000 个日期、400,000 个 XML 节点、四层结构；查询窗口小于 3,660 个自然日，币种仅为 USD/HKD。拒绝 DTD、实体、异常编码、重复日期/币种、未来日期、非正数和未知结构。
- `build_fx_drafts`：生成现有 `fx` 事实合同及 `{title, reference, excerpt}` 来源草稿；不返回 approved 决定，不访问数据库。后续显式复核通过后才使用既有 `store_source` / `review_source`。

## 计价与时间语义

ECB 官方提供[参考汇率完整时间序列](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)，不是可成交报价。本模块明确注明来源为 ECB，并注明人民币交叉换算与历史时间假设；使用条件见[ECB Copyright](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html)。

人民币每单位外币为 `CNY_per_EUR / currency_per_EUR`，以精确有理数计算，再按 ROUND_HALF_EVEN 保留最多 18 位小数，不经过浮点数。解析投影保留两个原始交叉腿；来源元数据绑定原始字节 SHA-256、查询范围与草稿事实哈希。

- 全历史文件包含一些 CNY 尚未提供的早期日期，也包含已经退出流通的币种。范围外的合法早期行不影响后期查询，但仍检查其日期、结构、币种重复及数值；范围内缺少 CNY 或请求币种时整次查询拒绝。
- 不补工作日、不补周末、不假设港币固定汇率，也不将最新汇率套到全部历史。
- `observed_at` 使用原始日期在 Europe/Berlin 的当地午夜作为**日期锚点**，不是已知的盘中观测或发布时间。
- `assumed_available_at` 使用下一自然日在 Europe/Berlin 的当地午夜，明确作为保守历史重建假设；跨夏令时按 IANA 时区计算，不固定 UTC 偏移。
- 今天下载的历史不是当时保管的时点档案；原始发布时间仍未知。草稿不能单凭哈希获得网络来源、实时行情或完整交易日覆盖认证。

## 验证与发布边界

`tests/market/test_ecb_history.py` 使用虚构 XML/HTTP 验证全历史窗口、精确换算、旧合同不放宽、缺失拒绝、夏令时、草稿未批准及传输/XML 防护。真实文件仅保存在私有运维路径，不能进入公开仓库或 CI 测试样本。

已在隔离 VPS 容器取得完整文件，并独立核对本机/VPS 的字节及事实哈希；之后通过已部署版本的来源审阅 API 写入生产 FX 来源。该操作不更新生产服务代码，不准入完整研究输入，也不创建参考组合；金融表前后哈希一致。

生产来源的 30 日审阅有效期是操作复核周期，不被表示为 ECB 授权期限。未来更新需要明确生成新资料和复核，不能静默延长旧来源或旧研究结论。

历史价格、ETF 身份与企业行动、交易/交收日历及策略分期验收仍需分别完成。汇率来源可用不代表“真实组合生成”和“持续监测”已经完成；页面仍应如实显示未完成的研究输入。
