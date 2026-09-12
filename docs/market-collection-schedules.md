# 周期参考汇率采集

状态：v18 实现与验证中，不是生产或投资准入报告。

## 能力与边界

在 `/workbench/market/schedules` 显式保存、启用或暂停 ECB daily 参考汇率采集。
保存总是产生暂停版本；新组合没有自动创建的调度、币种选择或触发时间。
这是市场数据更新，不创建资金、交易、估值、策略批准或投资建议。
LongPort 价格采集仍是独立显式任务，本轮不把它自动加入周期调度。

每个完整数据 scope 每个 UTC 日期只有一个持久槽位；一个请求可以有有限次数的
任务尝试，不承诺每天只有一次网络访问。已发送的网络请求不能因暂停而撤回，
但暂停、改版或重新启用会使旧授权下尚未提交的结果失效。

## 用户操作

1. 选择组合，填写币种集合、UTC 触发时分、起止日期、截止窗口和最大尝试次数。
2. 保存并核对暂停版本、原始定义 hash 和范围；明确确认后才能启用。
3. 查看槽位的计划时间、截止时间、任务状态、尝试次数及捕获摘要。
4. 暂停不删除已发布的数据。重新启用不补发已经存在的当日槽位，也不重新绑定旧请求。

同状态的新命令也会产生新 control，并结束旧授权；只有同幂等键、完全相同的命令
才返回原回执且不新增记录。更换 CAS、理由或状态后继续使用旧键会冲突。启停使用
独立调度 CAS，不因无关账本更新阻止人工暂停。触发点恰好等于启用时刻允许执行，
晚于触发点的启用不能追认该周期。

计划时间、实际接收时间和源 `rate_date` 分开显示。周末或其他情况下，成功访问
daily feed 仍可能取得旧日期的参考汇率；不能显示成“今日行情已更新”。
供应商未提供的精确发布时间继续保持未知，参考汇率也不是可执行换汇报价。

## 契约与持久身份

`contracts/v1/collection-schedule.schema.json` 定义 `collection-schedule-v1`：

- 固定 `provider=ecb`、`feed=daily`、`frequency=daily`、`timezone=UTC`、`publish=true`。
- 1–8 个显式且不重复的已支持币种，UTC 时分、有效日期范围。
- 截止窗口 60–86400 秒，最大尝试次数 1–5，`missed_policy=record_no_backfill`。
- 定义原始 UTF-8 最多 64 KiB，按原文计算 SHA-256；拒绝重复 JSON 键和额外字段。
- 请求中没有 URL、令牌、供应商响应、调用方时钟或预填 publication revision。

真实范围为 `provider:ecb:fx:daily:<排序后的币种集合>`，不含组合 ID。
`provider:ecb:reference-fx` 是 source ID，不是调度或 publication scope。
一个组合可以保存多个不同 scope；修改币种集合要建立新的调度身份。
同 scope 不允许跨组合同时启用，冲突时不返回另一组合的私有调度资料。

迁移 `0018_collection_schedules.sql` 只追加五张表：

| 表 | 职责 |
|---|---|
| `collection_schedules` | 不可变的组合与 scope 身份 |
| `collection_schedule_versions` | 原定义、hash、版本和保存审计 |
| `collection_schedule_controls` | 每次保存、启用、暂停的不可变授权时间线 |
| `collection_schedule_heads` | 当前 control 与版本的 CAS 指针；全库启用 scope 唯一 |
| `collection_schedule_slots` | 全库 `(scope_key, period)` 唯一的日槽位、原启用授权及请求绑定 |

所有控制时间使用 UTC 六位小数；授权和执行窗口均是半开区间。槽位不复制 job
终态：请求、执行、失败、尝试和捕获从现有 `command_requests/job_runs/job_attempts`
及 provider 表关联获得。`missed` 没有伪造的命令、任务或捕获。

## 发现、执行和验真

core 常驻 Worker 使用现有轮询发现到期槽位，不另起 cron。先处理扫描范围内
仍有效的当前窗口，再有界、轮转地补记旧槽位。丢失内存扫描提示不改变持久身份。
启用前的触发点不能追认为授权；历史漏跑依据当时的 enabled control 区间核验。

- `DEADLINE_EXPIRED`：截止先到或与授权结束同时到达；不下载旧日 daily feed 冒充历史数据。
- `AUTHORIZATION_ENDED`：截止前已暂停、改版或改变授权；只记录未执行，不新发网络请求。
- `requested`：事务内冻结当时 publication CAS 和普通 `market_collect` 载荷，actor
  固定为 `system:collection-discovery`，随后由原 dispatcher 建立真实 job。

下载前、下载后、原子持久化前及写入成功 job 终态前重新检查授权、版本、恢复锁、
lease 和时间窗口。旧 publication CAS 在下载和提交前核对；不会自动改成新 head。
最终检查失败会回滚该事务的捕获、发布和成功终态。网络错误按原任务机制有限重试，
已撤销或过期的授权不靠自动重试复活。

Python 与 Web 分别核验原始定义、连续 control、人工审计、系统请求和捕获时间。
数据库及两个独立验真器拒绝 `system:` 身份冒充人工授权；审计结构和命令字段严格
匹配。理由的 UTF-16 长度和空白判断采用一致语义，避免跨语言误放行或误拒绝。
历史合法捕获只使用其原授权区间；后续暂停不追溯撤销此前已完成的数据。
任何 `system:` actor 没有合法槽位绑定都不能借普通人工导入路径取得供应商证明。

## 运维与公开边界

`--collection-discovery-limit` 控制每次发现的新增槽位预算；它不扩大 provider role。
LongPort Worker 不发现或执行 ECB 调度。恢复只读状态下允许私有读取，禁止控制、
发现、任务写入及发布。

每个调度完整历史的验证预算为 1024 个 control。保存/启用最多生成 revision 1023，
最后一个 revision 只保留给从 enabled 到 paused 的人工操作。耗尽后不自动续授权，
必须安排维护；幂等重传不占新 revision。该限制不能被误写成无限制运行承诺。

个人调度定义、真实原件、账户资料和凭据不进入公开源码、镜像或公开 CI 工件。
`artifacts/verification/` 只保存隔离合成测试证据，真实采集仍保存在受控数据库或
私有目录中。旧迁移、账本事实、ECB 原始 BLOB 和现有价格采集语义不重写。

## 验证入口与未完成项

- 迁移/契约：`tests/migrations/collection-schedules.test.mjs`。
- 发现与执行：`tests/orchestration/test_collections.py` 和既有采集回归。
- Web：`web/tests/collection-schedule*.test.ts`、市场来源与市场 API 回归。
- HTTP：`HTTP-SC01..04`，真实授权时间触发、独立合成 Worker、在途 HTTP 暂停和历史验真。

具体通过数、源码 hash、构建和 CI 只能以本次冻结后的结果为准。原生浏览器、
实际部署节奏、真实资料、通知传输、全负载与异机恢复仍需单独验证；这些测试不
授予策略批准，不证明投资收益，也不缩减原六份规划的完整验收范围。
