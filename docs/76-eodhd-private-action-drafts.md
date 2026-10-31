# EODHD 私有公司行动交叉核验草稿

## 范围

EODHD 是独立的分红、拆分交叉核验来源，不替代长桥报价、发行人资料或交易所身份核验。此增量只接通私有草稿的持续取得与保管；空数组不证明没有公司行动，取得成功也不批准研究或交易。

固定示例宇宙为 `VT.US`、`BND.US`，每个标的分别查询 `div`、`splits`。实际所有者声明、有效期、首次允许日期和凭据只配置于私有环境，不把个人规划放入公开仓库。注册默认关闭，显式启用不补发此前日期；可提前登记未来生效的声明，但生效前不登记请求。

- 时区 `America/New_York`，当地 01:00 后才发现任务。
- 每次只取截至当地前一天的 365 个自然日。重复夏令时小时不增加次数。
- 整个实例共享固定目标/类型/当地日期槽，四项合计每天最多四次；多工作区、换声明、启停或新键不能增加额度。
- 四个请求意图及 `max_attempts=1` 任务在网络前原子持久化。只有隔离 `longport` 行情进程执行，core、verifier 和 Web 不调用此提供方。
- 一次未知、超时、鉴权、限流或提交失败不重试。已知失败或无法确定的执行阻止同日剩余网络调用；不换 demo Token、标的或来源绕过。
- EODHD 任务使用实例级互斥，并向临近的确认收盘监听让出执行机会。互斥不构成延迟或容量 SLA。

## 传输与终态

只允许固定 `eodhd.com` HTTPS 端点；验证公网解析地址和证书，不使用代理、重定向或 HTTP 自动重试。响应大小、记录数、字段、十进制精度、重复事件、格式和时间均有封闭边界。保留日期精度，未提供的公告时间、税、身份与完整性维持未知，不推断成零或已证实。

Token 从独立的单链接、所有者可读、0600 普通文件读取，传输子进程只通过 stdin 接收，不进入 argv、环境、出处 URL、回执、异常文本或数据库。子进程有内核期限并禁用 core dump；父进程独立重放原始字节、传输及派生哈希，并拒绝反射的凭据。

网络不持数据库写事务。调用前、返回后及最终提交均检查当前时钟、所有者、原控制、日期/有效期、停止、只读、恢复锁、原任务身份及租约；调用前要求原剩余预算，不延长原租约或重新开槽。调用后暂停只能阻止提交，不能声称已经撤销远端请求。

最终回执、审计、共享原文字节和任务终态在同一 fenced 事务中提交。迁移 52 对来源元数据、任务和尝试增加针对性不可变约束：不能重置、替换、删除或提高次数；无捕获收据不能标记成功。其他任务的原语义不变。

## 草稿、留存和备份

所有回执始终为未审阅、未准入、公司行动不完整且不能提供实时建议。模拟采集有不可替换的专用资格，普通读取拒绝模拟；CLI 不提供模拟、任意 URL、回拨时钟、手动抓取或重试选项。

原文按工作区和 SHA-256 去重，多个日期的捕获回执可引用同一份字节，各自保留独立时间和权限，不通过复用延长旧回执。原文保存十个 UTC 日历年，闰日按目标年二月末截止；这与采集声明有效期分开。停用采集不扩大权利，不自动抹除已单独授权保管的档案。

到期读取立即拒绝，不依赖清理是否运行。默认 core 将草稿清理纳入现有共享删除预算，每项审计和删除独立原子提交；共享 BLOB 必须等待所有引用的保管期终结。SQL 删除不等于物理安全擦除，WAL、旧页和备份中可能仍有字节。

沿用私有加密备份及最多一份本机当前恢复点，不新增独立备份任务。恢复保留每日槽、未知尝试、哈希和共享字节，保持恢复待审锁，不自动继续采集。恢复历史快照后仍须人工核对原实例外部额度，不能将回滚当作额度重置。

## 配置与运维

现有部署配置默认 `WORKBENCH_EODHD_ENABLED=0`。显式设置为 `1` 时必须同时启用隔离行情进程，并指定独立的 `WORKBENCH_EODHD_CREDENTIALS_FILE`。文件必须为 UID 10001、0600、单链接，不能与 Web/长桥/备份/发布配置共用，也不能存放在数据、备份、恢复或发布目录下。

`docker-compose.eodhd-drafts.yml` 只给行情容器挂载只读 `/run/etf-workbench/eodhd.env`，不挂到 Web、core、verifier 或备份角色。内容格式：

```dotenv
# Only write the real value into the private file, never a public example.
EODHD_API_TOKEN=REPLACE_IN_PRIVATE_FILE_ONLY
```

启动及发布前置检查只核对文件配置，不请求来源，也不授予采集权。实际声明须通过私有 owner CLI 另行登记和启用：

```text
python -m worker.investor.data_pipeline --db /private/data/workbench.db --workspace WORKSPACE --actor OWNER register-eodhd-authority --file /private/config/eodhd-policy.json
python -m worker.investor.data_pipeline --db /private/data/workbench.db --workspace WORKSPACE --actor OWNER control-eodhd-authority --authority AUTHORITY --enable
python -m worker.investor.data_pipeline --db /private/data/workbench.db --workspace WORKSPACE --actor OWNER inspect-eodhd-request --request REQUEST
```

另有 `check-eodhd-capture` 和到期的 `purge-eodhd-capture`；CLI 只输出固定状态、计数与哈希，不输出原文、事件金额、许可摘录或 Token。停止使用时显式 `--disable`，不删除意图来重新采集。

## 验收边界

新增离线测试覆盖时区/窗口、全实例预算、并发、未知尝试、SQL 防重置、晚期失败、暂停/到期/租约、原文去重、留存及角色隔离。独立 Node 验证非空 51→52 迁移保留全部旧行及 rowid、失败回滚、真实 Compose 配置，以及一份临时加密备份恢复后仍禁止自动运行。

这些均不等于真实 API、完整 CI、生产启用、公司行动审阅、持续监测或投资资格。生产须使用精确通过的提交、受保护发布和单独的私有配置核验；不存在隐式数据准入或交易授权。

官方参考：[分红与拆分 API](https://eodhd.com/financial-apis/api-splits-dividends)、[订阅与免费限额](https://eodhd.com/pricing)、[使用条款](https://eodhd.com/financial-apis/terms-conditions)。具体用途仍由适用协议及所有者私有声明约束，本文不提供供应商认证或法律结论。
