# 长桥 API Key：只读验证与 VPS 接入

状态：2026-10-08，本地传统凭据读取三地各一个 ETF 的近期短窗口日线已通过；新增显式、脱敏的历史诊断，A 股两个早期窗口的 SDK 返回为空。工程已支持私有文件检查及容器环境检查。未切换生产行情源、启用采集计划或完成 Linux 真实行情验收。

本文只包含通用配置与连通测试元数据，不记录个人资金计划、账户、凭据或行情价格原件。标的仅用于接口验证，不是投资推荐。

## 1. 与 OAuth 的关系

API Key 与 OAuth 是两条独立认证路线。长桥当前仍支持传统 App Key、App Secret、Access Token；不能用传统 Token 替代 OAuth Token。[官方快速开始](https://open.longbridge.com/zh-CN/docs/getting-started)

本工程的服务器候选路线复用已锁定的 `longport==4.3.7` 只读 SDK 适配器，不因官方 SDK 更名而自动升级依赖。官方 CLI OAuth 检查仍保留为可选诊断，见 [11](11-longbridge-ai-market-data-access.md)；两种检查均不自动登录、切换认证或访问交易接口。

API Key 适合通过独立私有环境文件注入后台容器；这不意味着永不过期。传统 Access Token 的有效期、撤销与轮换由运营者管理，本轮不会调用刷新接口。首次生产使用前，应轮换曾在聊天或其他不适合保密的渠道出现过的凭据。

## 2. 凭据输入规则

接受以下任一完整集合，不混用、不拼接、不隐式优先选择：

| 命名空间 | 必须具备的三项 |
| --- | --- |
| 当前名称 | `LONGBRIDGE_APP_KEY`、`LONGBRIDGE_APP_SECRET`、`LONGBRIDGE_ACCESS_TOKEN` |
| 兼容名称 | `LONGPORT_APP_KEY`、`LONGPORT_APP_SECRET`、`LONGPORT_ACCESS_TOKEN` |

示意内容，不能作为真实凭据使用：

```dotenv
LONGBRIDGE_APP_KEY=REPLACE_LOCALLY
LONGBRIDGE_APP_SECRET=REPLACE_LOCALLY
LONGBRIDGE_ACCESS_TOKEN=REPLACE_LOCALLY
```

本地检查文件须使用绝对路径、普通非符号链接文件、当前用户所有且无 group/other 权限，建议文件 `0600`、父目录 `0700`；硬链接也拒绝。检查器仅按数据解析 `KEY=VALUE`，不执行 `source`、shell 展开或 dotenv 搜索；不要使用 `export`、引号包装或空格。允许空行和整行注释，重复/未知键、混合命名空间、缺项、空值及超长内容均失败。文件上限 32 KiB，每个值上限 8192 字节。

显式 `--credentials-env` 仅从进程环境读取上述三项，适用于 Docker `env_file` 已注入凭据的行情容器。它与 `--credentials-file` 互斥；失败不会改读另一种来源或用户 HOME。凭据值不出现在命令参数中，也不会自动传入 Web、core 或 verifier。

## 3. 有界只读检查

需要 Python 3.11，以及仓库锁定的 `requirements-workbench.txt`、`requirements-market-longport.txt`。两组依赖安装时遵循已有哈希锁定，不替换生产环境或旧 `.venv`。以下使用虚构标的和私有路径占位符：

```sh
python -m worker.market inspect-longbridge-apikey \
  --credentials-file /private/config/longbridge.env \
  --symbol SYNTH.US --currency USD \
  --start 2025-06-05 --end 2025-06-06 \
  --expected-date 2025-06-05 --expected-date 2025-06-06
```

在已由受控 `env_file` 注入凭据的独立 provider 容器中，同一检查使用：

```sh
python -m worker.market inspect-longbridge-apikey --credentials-env \
  --symbol SYNTH.US --currency USD \
  --start 2025-06-05 --end 2025-06-06 \
  --expected-date 2025-06-05 --expected-date 2025-06-06
```

此命令没有数据库参数，不创建或读取工作台库，也不要求先建立账户、导入交易或批准策略。它是内部数据接入检查，不是投资工作台的用户主流程。

执行边界：

- 固定 SDK 版本、公开服务地址、`QuoteContext` 和日线接口；仅 `day/none/regular`，最长 31 个自然日。
- Symbol、市场与调用者声明的币种必须兼容，但这不核实 ETF 身份或实际产品币种。预期日期必须显式给出，检查器不推断交易日历。
- 凭据经受控 stdin 传入隔离 UTC 子进程，不继承用户凭据、代理、任意服务地址或数据库环境。私有临时目录中只有空 `.env`。
- 父进程 30 秒截止、跨 exec 的内核定时器、输入 64 KiB、输出 2 MiB、诊断 16 KiB 上限；stdin/stdout/stderr 同时有界处理，中断会清理进程组。
- SDK 投影只在内存中处理，重新核对请求绑定、调用时间范围、固定版本和规范重放。精确十进制、int64 成交量及市场当地日期检查不使用浮点数。
- 不保存/输出价格；不访问资金、持仓或订单，不刷新 Token，不自动重试。程序限制调用范围，不声称凭据本身已被供应商限制为只读。

成功退出 `0`，仅输出 `status=sample_read_ok`、数量、日期和未验收标记。失败退出 `1`，仅输出固定错误码；SDK 子进程隐藏供应商异常详情，`LONGPORT_PROVIDER_CALL_FAILED` 不能单独区分认证、权限、网络或数据覆盖问题。不能把失败转成部分成功、补零或示例行情。

### 3.1 显式安全诊断

上述检查可以额外添加 `--diagnose`，用于内部排查，而非首次使用要求。默认检查、正式持久采集和历史续采的错误行为不变；该开关不能更改 SDK、端点、接口、窗口或校验规则。

- 配置建立、行情上下文建立、历史方法调用分别输出固定阶段码。阶段只定位失败位置，不能单凭 `QUOTE_CONTEXT_SETUP_FAILED` 判定密码或网络问题。
- 仅在历史方法抛出已加载 SDK 的 `OpenApiException` 时，识别精确整数业务码 `301600/301602/301603/301604/301606/301607`，分别映射请求、服务端、无行情、权限、限频和月度标的配额问题。参照[官方历史接口错误码](https://open.longbridge.com/zh-CN/docs/quote/pull/history-candlestick)；其他接口、字符串码、未知码、异常文本或自称有 `code` 属性的任意异常不作此分类。
- SDK 正常返回后，空 list/tuple 为 `LONGPORT_EMPTY_RESPONSE`；容器类型错误和可能截断分别区分。OHLCV、日期重复/越界、预期集合不符等校验仍拒绝，输出对应白名单码，不放宽数据准入。
- 子进程只以预置退出码表达诊断，不输出异常消息、trace ID、凭据、部分价格或 SDK 对象；父进程只把白名单退出码映射回固定标签。超时、信号、输入/输出上限和进程清理仍优先保护传输。
- 成功元数据与默认检查完全相同，不把诊断成功升级成价格正确、完整覆盖、许可或生产资格；不自动重试、换源、刷新 Token、写数据库或交易。

`EMPTY_RESPONSE` 是 SDK 返回形态，不等同于供应商明确返回 `301603`，也不能证明标的未上市、休市、无权限或整个 A 股历史接口不可用。真实诊断样本和保留的原失败见[多年采集记录](23-bounded-history-collection.md#31-早期-a-股诊断补查)。

## 4. 当前实际读取证据

验证于 2026-10-06 UTC / 2026-10-07 本地日期进行，使用上述正式检查入口、传统 API Key 和固定旧 SDK。统一请求区间为 2026-09-21 至 2026-09-25，未读取最新报价：

| 市场 | 连通测试标的 | 日线数量 | 通过检查的市场当地日期 |
| --- | --- | --- | --- |
| A 股 | `510300.SH` | 4 | 2026-09-21 至 2026-09-24 |
| 港股 | `2800.HK` | 5 | 2026-09-21 至 2026-09-25 |
| 美股 | `SPY.US` | 5 | 2026-09-21 至 2026-09-25 |

三个调用均返回 `sample_read_ok`，基本 OHLCV 校验和调用者预期日期集合相等检查通过。将 A 股相同请求的预期集合仅新增 2026-09-25 后，命令退出 `1`、返回固定 `LONGPORT_PROVIDER_CALL_FAILED`，不输出部分结果或补造价格。该日休市的官方依据见 [OAuth 验证记录](11-longbridge-ai-market-data-access.md#51-本地最小读取结果)。

本轮只证明三个标的的局部日线读取和旧 SDK/服务兼容性，未证明全部市场权限、价格准确性、报价实时性、长期历史覆盖、VPS 网络可达性或持续运行稳定性。公开测试全部使用独立构造的合成凭据与行情，不复制真实价格原件。

另以显式环境输入重新读取上述 A 股窗口，`--credentials-env` 同样返回 `sample_read_ok` 和 4 根日线；这是本机环境别名路径的实际验证，不冒充 Linux 容器或生产 VPS 的验证。

## 5. VPS 发布边界

已有 `docker-compose.market-provider.yml` 为独立、非 root、无额外端口的可选行情角色，通过 Docker 的 `env_file` 注入凭据。生产文件由 root 所有且 `0600`，容器不需要直接读取宿主私有文件；不要为检查把文件改成所有人可读。`--credentials-env` 可复用这个角色的环境；本地文件检查的当前用户所有权规则不用于替代服务器发布前置检查。

现有默认 `WORKBENCH_MARKET_PROVIDER_ENABLED=0` 保持不变。启用仍通过经过审核的发布 SHA、独立环境文件、离线 SDK/角色/schema 前置检查及生产审批，具体见 [生产发布手册](production-release-runbook.md#可选价格-worker-的发布边界)。上线后的只读样本检查与离线导入检查是不同验收，不混为一谈。

即使启动 provider，也必须独立审核证券映射、价格采集计划和行情许可，再启用持续采集；其持久采集流程与本检查器的内存诊断不是同一个流程。留存、备份和外部 AI 使用条件见 [选型许可门槛](10-market-data-source-selection.md#5-授权与长期留证必须先解决的冲突)。本轮未上传凭据、修改服务器、触发 CI 发布或开启计划。

## 6. 下一步

先核验策略所需的历史、分红/拆并份、总收益、ETF 身份/费用及可适用的数据用途，再接研究参考组合生成和组合优先首页。数据不足时显示具体缺口，而不是虚构持仓或让用户先完成复杂账本。VPS 原生依赖、真实网络、Token 轮换及持续故障恢复另行验收；本地读取与回归通过不替代这些准入条件。

## 7. OpenAPI 专属许可复核（2026-10-07）

官方 [法律文档入口](https://open.longbridge.com/docs/legal) 分新加坡和香港版本，并要求按账户适用地区选用，不能仅凭域名、Key 前缀或营销介绍判断。

- [新加坡 API 非商业许可](https://open.longbridge.com/docs/legal/api-license-agreement-sg) 第 1 节明确个人用途的有限 API 代码许可；第 2 节另列第三方披露等限制。
- [香港 API 非商业许可](https://open.longbridge.com/docs/legal/api-license-agreement-hk) 第 1 节同样覆盖开发本人使用的工具、平台或界面；API 代码许可不等于行情原件的留存、备份、转发或外部模型使用权。

据此，不能笼统认定个人 API 工具或 VPS 部署均被禁止；但上述条款未单独明示本工程所需的长期行情归档及外部 AI 传输条件。当前工程仍区分个人工具代码许可、账户行情权限、行情数据用途与产品研究资格，不将其中一项当成其余项已获授权。待确认的是账户适用协议及数据用途，不要求为了开发后台队列再开新券商账户。

本次只浏览官方公开条款，没有新增行情读取、保存真实价格、上传到外部 AI 或修改 VPS。源码中的合成研究导入器拒绝真实数据，生产 core worker 默认不执行合成研究，不靠人工填写“已许可”字段取得生产资格。

### 7.1 香港版本的边界补查（2026-10-08）

[香港用户数据授权](https://open.longbridge.com/docs/legal/user-data-authorization-hk)说明按所选功能和授权页范围向第三方 AI 终端共享数据；新增类别需要明确选择。工程不能仅因持有传统 API Key 就推断已选择全部 OAuth/AI 数据范围，也不把平台对用户数据的保存规则当作本工程的行情归档授权。

[香港平台免责声明](https://open.longbridge.com/docs/legal/developers-platform-disclaimer-hk)将客户端协议、平台和交易所规则纳入适用条件，并不保证行情完整、及时或准确；其交易指令条款强调人工控制。工作台仍只读取行情、由用户自行决定交易，不因开发者接口包含交易能力而扩大权限。

据以上公开文件的工程判断：本人使用的工具代码、选定的 AI 共享范围、行情原件长期留存/备份和第三方供应商规则不能互相替代。适用实体确认只用于私有配置，不写入公开默认；真实持续留存仍需核对实际适用资料。上述判断不等于认定 VPS 或所有外部 AI 一概禁止。
