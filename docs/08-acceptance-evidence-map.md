# ETF 投资工作台：验收证据与缺口映射

版本：v0.15 | 日期：2026-09-25 | 状态：公开通用版阶段性证据索引，非验收或放行报告

依据：[01 投资约束](01-investment-mandate.md)、[02 产品需求](02-product-requirements.md)、[03 决策治理](03-decision-policy.md)、[04 数据与核算](04-data-and-accounting.md)、[05 架构迁移](05-architecture-and-migration.md)、[06 验证验收](06-validation-and-acceptance.md)。六份原始个人 v1.0 基线已在本地保存；公开版以通用模板替换个人参数，不是范围削减，也不缩减验收要求。

## 1. 如何解释本表

- **代码存在、测试存在、某次测试通过、完整用例验收、生产放行、策略准入是六件不同的事。** 测试名称带 `E-xx` 或 `F-xx`，不表示已经覆盖该编号的全部预期。
- 本表“已有子集”只描述当前可定位的实现；“复现证据”指测试入口或已留存的运行工件。只有工件中实际运行的那个版本、输入和范围可以称通过。
- `NOT_RUN` 表示完整验收尚未执行或未形成完整证据包；`BLOCKED` 表示还缺实现、经核验资料或独立批准。两者都不能转换成整个门槛的 `PASS`。下表不使用“部分 PASS”作为正式状态。
- 目前有合成单元、跨语言、HTTP、浏览器和隔离容器验证。v21 已实现仅运行固定现金贡献中性子检查的受控验证 Worker，**不等于完整 E-02、G-03/G-04 或任何 S 门槛验收；仍没有正式 live 数据/账户样本验收和新工作台生产部署验收**。旧站 HTTP 200、远端 fixture 成功、测试中创建的政策和验证记录均不能替代它们。
- L-0 文档确认保持有效；本表不能宣布 L-1/L-2 全部验收，更不能升级 L-3。D-01 至 D-08 未完成细节继续阻塞相应能力；计划预算不等于实际余额，只有已核实本金及到账事实才能入账。
- 公开边界已确认：**公开代码和通用示例，个人方案本地隔离，提交前核验 index**。金额精度、并发及性能测试中的明确合成数值仅为 fixture，不是个人投资参数。
- 新一轮以已核验公开提交 `b2f9cce1d02c9eaec74630c5f3016c018d2142bf` 为基线：[CI 36077599219](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/36077599219) 的 test/container 两个 job 成功，Python 636、Web 896、Node 231 通过加 1 跳过、HTTP 103；原始 ZIP/成员和精确源码已核验。修复客户端的窄范围原生传输复验为 3 笔事实/3 回执/revision 3/CNY 6，原文件名及 CSV/mapping 字节一致；不继承旧客户端 27 行矩阵。当前 v24 新增附件审计索引、同事务证据读取去重和固定 Worker 事务 API 边界诊断，**旧 CI/native 不覆盖这些新代码**。以下历史段保留当时状态。
- 性能判定仍按原文：核心查询 p95 不超过 2 秒、批准/小批记账 p95 不超过 1 秒，每类至少 1,000 个有效并发样本及完整混合工作负载、4 vCPU/8 GiB/本地 SSD。最大值超过 1 秒不自动等于 p95 门槛失败；小样本 p95 达标也不代表验收。事务 callback 区间不是精确 SQLite 持锁时间，BEGIN/最终提交区间还含包装开销，不以这些诊断伪造锁等待验收。
- v24 本地冻结回归：Python **647/647**、Web **909/909**、Node **233 通过 / 1 跳过**、HTTP **103/103**；schema 24、构建 `7t0pNLDHifOPuUBinR6aw`，574 个 HTTP 源文件起止及随后复核一致。manifest SHA256 `7f1687b9a5a716ff50659a4284447c9b047f794492650caf5e01cb8a5721db62`，路径 `artifacts/verification/workbench-http/2026-09-25T01-27-00-040Z/manifest.json`。两次独立新库的万行预览/确认为 4.687/4.818 秒、4.698/5.218 秒，回执和余额正确且无探针错误；取得真实固定子进程事务 API 计时，但样本、完整混合负载与目标硬件仍不足，不新增完整 P/ACC/E/S 验收项。新提交 CI、原生和生产验收需分别核验，不能继承前一提交绿灯。
- 本轮之前已验证的公开基线为 schema v23、NAV v4、绩效 v5：提交 `777dd2dabd1fb37b512420091d0a12b81fa2e072` 的 [CI 36067569470](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/36067569470) 两个 job 成功，Python 636、Web 835、Node 231 通过加 1 项默认未开启的生命周期检查、HTTP 102。其容器 CSV 检查只证明加载及拒绝坏 lease，不是正常 CSV 全链或 OS 网络隔离验收。当前增量把 CSV 主界面接入后台任务，新增分别授权、分页复核、取消及原样重试；**代码迁移不等于原生交互、完整故障、并发性能或生产验收**，不得继承旧版本 CI 成功状态。详见 [实现进度](07-implementation-tracker.md)和 [后台 CSV 合同](csv-background-imports.md)。以下历史运行段保留原版本与时点。
- 本轮最终本地回归：Python **636/636**、Web **883/883**、Node **231 通过 / 1 项默认生命周期检查跳过**，HTTP **103/103**；构建 `SfHfbL8HxP6sSiBkXGKJ2`，566 个 HTTP 源码文件起止及随后复核一致。工件 `artifacts/verification/workbench-http/2026-09-24T23-32-46-311Z/manifest.json`，SHA256 `afa235d1e735192cdea8fa21d6847ed251d09699093ee8d16bc9799524f6aaee`。30 秒客户端总期限覆盖会话探测、读取和哈希，不撤回已受理任务；没有自动重试或同步降级。发现并修复原生 FormData 改写映射换行和映射命令 Unicode 理由长度投影不一致，人工复核理由原限制不变，旧失败日志保留。尚未绑定新公开提交及其 CI，不沿用上一版绿灯。
- 本轮原生 **有限子集**：Tabbit 合成开发库的 27 行 CSV 经真实后台预览、退出/新会话重新复核和单独确认，得到 **26 笔事实、27 条回执、revision 26、CNY 351**；分页 25+2、重复行关联、附件响应哈希、账户 A-B-A 清理、跨会话显式取消及恢复只读已核对。桌面复核、390px 回执和桌面只读截图已查看；仅证明附件响应字节，不证明 OS 下载保存。工件 `artifacts/verification/browser-csv-background-v24/native-20260924T232105Z/`；临时进程/端口/库目录与任务页已清理，没有再次重启浏览器。异步 checkbox 的一次立即断言失败保留，随后独立只读观察确认结果；未重放操作。此子集不覆盖原生丢包/超时、完整 BFCache/无障碍、万行交互或生产版本，不新增完整 P/ACC/E/S 已验收项。
- 后续公开提交 `1c15cc7803a27d808e43e0846370faaf72f8ca1b` 的 [CI 36075093464](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/36075093464) **失败**：Python 636 通过，Web 880 通过 / 3 项 multipart 解析失败，后续构建/HTTP 等跳过且没有 validation ZIP；容器有限 smoke 成功不替代整体。Node 22 拒绝旧 `filename` + `filename*` 文件头，Node 25 接受；已改固定文件 part 名及严格原名 header，保留原 CSV/mapping/input hash 语义。跨 Node 25.7/22.23.3 纯传输各 10/10、route 13/13、client/真实 worker 集成 23/23 通过；不是原 CI 22.23.2 的通过声明。上两项本地/27 行原生段保留旧版本边界，不直接继承给此兼容修复。
- 兼容修复最终本地：Python **636/636**、Web **896/896**、Node **231 通过 / 1 跳过**、HTTP **103/103**，类型/构建/认证 HTTP 通过；构建 `QgObTgPeYSIxI1ThQWiOo`、567 源码起止及当前匹配。manifest `artifacts/verification/workbench-http/2026-09-25T00-18-24-034Z/manifest.json`，SHA256 `ecd119659bdfbd83220a43183b020febd0eaf2cee1542ccdc90e8742bf732c3f`。发布检查点的新窄范围原生复验仍在进行，新精确提交 CI 及工件尚待核验；不继承旧客户端 native、不把本地通过写成新 CI 或生产通过。
- 来源基线是持续变化的工作区，不是单一已签核 release。下列结果需在最终源码冻结后统一重跑，补齐 release SHA、锁文件、schema、环境、fixture、退出码、差异及签核。
- v23 本地冻结回归：Python **636/636**、Web **826/826**、Node **232/232**（开启生命周期检查）、HTTP **102/102**；生产构建 `PlToWRxOkh4U2SONqGhzT`，555 个 HTTP 源码清单起止一致。证据 `artifacts/verification/workbench-http/2026-09-24T21-11-56-711Z/manifest.json`，SHA256 `a7ef20542c25a3ac6f021cbedde7a61395c0346f2d26f2fa792aaebba2c9f19d`。全规模合成库的万行预览/确认分别 8.928/9.316 秒，但并发写入仍有 **2 次锁超时**，因此 5.1 性能未通过；主 CSV UI 仍未迁移，不增加完整 P/ACC/E/S 已验收项。原始失败记录、最终日志与量测保存在 `artifacts/verification/csv-background-v23/`。

## 2. 证据目录与复现入口

最新混合 HTTP 工具见 [复现说明](mixed-workload-verification.md)。两个独立新库
`artifacts/verification/mixed-workload-v27/smoke-2/`、`smoke-3/` 均完成真实认证、
正常 core Worker、行情发布、估值、CSV 预览/确认、记账和批准/取消；四类负载各
20/20 成功，独立 Python baseline/preview/complete 校验通过。各后台流程窗口内
均有各类真实请求重叠，但不是精确 SQLite 持锁重叠、1,000 样本或目标硬件性能通过。
第一轮 macOS 临时路径别名校验失败保留；修正为真实路径，没有放松 oracle。

`smoke-5` 的在线正确性检查通过，但独立保全副本回放发现附件目录被复制为
`0755`，不符合独立验证器要求的 `0700`，因此回放明确失败。旧证据和失败记录
保留，不把它解释为恢复通过。后续保全改为显式私有目录、逐文件权限及原字节
哈希核验，新库 `smoke-6` 在线检查通过。其独立私有副本只读回放也实际通过，
仅修改期望输入中的两处副本路径，原工件字节、模式及目录清单未变，输出与原
终态 oracle 一致；记录在 `smoke-6/replay/verification-result.json`。此结果仍是
合成正确性，不是完整恢复/性能/生产放行；不能以复制成功代替可重放证明。

本次另沿用已恢复的 Tabbit，没有再次重启。原生开发环境 27 行 CSV 得到 26 笔
合成事实、27 条回执、revision 26、CNY 351；确认前零事实、人工重复行关联、
25+2 分页、390px 回执及退出后 401 已核对，任务页、进程、端口和临时库已清理。
工件 `artifacts/verification/browser-csv-background-v24/native-20260925-resumed/`。
期间共享 schema 编写曾触发开发热更新/500，修复后只读恢复同一任务并确认；
两次错误标签断言和一次忽略滚动条的布局断言也保留。这是有明确阶段边界的
原生子集，**不是单一冻结源码的无中断全链，不继承为最终生产构建验收**。

本表用下列短名指向具体文件。测试源码可说明断言范围，但不能单独证明最近一次构建、生产服务或真实数据已经通过。

| 短名 | 实现与可复现测试 | 当前证据边界 |
|---|---|---|
| LEDGER | `web/src/server/ledger/{decimal,engine,service}.ts`；`web/tests/ledger-{engine,service}.test.ts` | 十进制事件、交易日/结算、期初状态、CAS、幂等、投影重建；仅受支持事件及合成事实 |
| IMPORT | `web/src/server/ledger/{imports,attachments,reconciliation}.ts`；`web/tests/{ledger-imports,attachments,reconciliation,strict-json}.test.ts` | 标准 JSON 原件、预览/整批确认、哈希和范围、显式对账；不是原生券商 CSV 适配 |
| CORRECTION | `web/src/server/ledger/corrections.ts`；`web/tests/ledger-corrections.test.ts`；[更正边界](ledger-corrections.md) | 追加冲销/替代、依赖重放、历史视图；支持子集有明确拒绝边界 |
| DIVIDEND | [分红与公司行动边界](dividends-and-corporate-actions.md)；`web/src/server/ledger/{fact-quality,fact-quality-db,dividend-queries}.ts`；`worker/accounting/fact_quality.py`；`web/tests/{fact-quality,dividend-ledger-engine,dividend-ledger-service,dividend-input,dividend-workspace}.test.ts` | 未知税不当零税；累计税确认不改现金，实际补扣另记；净额/归因分离，公司行动通知/解决及时间范围质量证据；真实资料与完整人工闭环未验收 |
| SECURITIES | [证券转移](security-transfers.md)；`web/tests/security-transfer-*.test.ts`、`security-transit-reconciliation.test.ts`；Python `test_security_transfers.py` / `test_security_flows.py` | 外部确认市值资本流、内部逐批在途、部分到达/退回/拆分/更正、两端覆盖；合成数据，不是券商实际转仓核验 |
| CSV | [CSV 导入](csv-import.md)；`web/src/server/ledger/csv*.ts`；`csv-{workspace,mapping-wizard,mapping-builder,recovery-panel,recovery-client}.tsx/ts`；`web/tests/csv*.test.ts` | 零写检查、完整原值分页、可视化显式映射与高级 JSON；有界原件上传、不可变版本/逐行预检、人工重复决定、原子确认/重试和来源别名；v14 会话隔离的原请求封存与只读恢复，无自动确认；无真实券商格式认证 |
| CSV-BG | [后台 CSV 合同](csv-background-imports.md)；`web/src/server/csv-background/`、`web/src/app/api/workbench/csv/jobs/route.ts`、`worker/orchestration/csv_imports.py`、`csv-background-{workspace,client,review}.tsx/ts`；`web/tests/csv-background*.test.ts`、`tests/orchestration/test_csv_imports.py`、`web/scripts/csv-background-http-cases.mjs` | v23 人工明确授权预览/确认、固定 Node 整批事务、Python/TS 独立回执验真、跨会话有限查询/取消和有界分页；主界面分别授权、严格客户端绑定及原字节手动重试，旧恢复入口不再新建同步 CSV。退出不撤回已接受委托，原请求恢复仍隔离原会话。完整 proof 未删除；元数据当前批次状态与历史 result 区分。优化后满规模量测无写锁超时，但尾延迟和样本要求仍未达标，完整原生交互、故障和负载验收尚未闭环 |
| ACCOUNTING | `worker/accounting/`；`tests/accounting/{test_accounting,test_golden_contract}.py`；`tests/accounting/golden.json` | Decimal 金标准和收益函数；包括固定种子往返属性测试，不等于完整随机业务序列覆盖 |
| MARKET | `worker/market/`；`tests/market/{test_market,test_valuation_units}.py`、`contracts.test.mjs` | NAV v4、显式批次/发布历史、原币/FX 单位检查与独立事实质量证明；缺资料不输出精确 NAV；没有外部实时采集器验收 |
| PROVIDER | [采集边界](market-provider-collection.md)；`worker/market/{collection,providers/ecb,providers/longport}.py`；`web/src/server/market-source.ts`；`test_collection.py`、`test_market_collection.py`、`provider-captures.test.mjs`、`market-source.test.ts` | ECB 固定 HTTPS 到私有原始 BLOB、发布及双端验真已做独立本地实际网络验证；v16 exact-SHA CI 已过。LongPort 新共享路径见 PRICE；SDK 投影不是 HTTP 原件，两者均不授予账户/策略权限 |
| PRICE | [价格采集](market-price-collection.md)；`worker/market/{references,price_collection}.py`；`web/src/server/{market-references,market-price-source.ts}`；`test_market_references.py`、`test_price_collection.py`、`test_provider_roles.py`、`market-prices.test.mjs`、`provider-container.test.mjs` | v17 人审映射/日历版本、完整集合 scope、固定 SDK 日价格、原子发布、引用/PIT/当前 head 独立验真；日期不补造秒级发布；真实权限/数据/权威日历、专属镜像与原生 UI 仍未验收 |
| PERFORMANCE | `worker/performance/{pipeline,flows}.py`；`tests/performance/{test_pipeline,test_market_integrity,test_flow_fx,test_security_flows}.py`；`web/tests/valuation-freshness.test.ts` | v5 现金/证券逐事件 FX、fact/posting/event/PIT/发布证据和分红/公司行动点与区间质量证明；迟到事实/修订与重述；Python 产物经 Web 独立复核；完整验收及真实资料未完成 |
| FUNDING | `web/src/server/funding/`、`funding-commands.ts`、`funding-summary.ts`；`web/tests/funding*.test.ts`；[资金计划边界](funding-plans.md) | 日期化多币种来源/批次、版本/延期、到账/执行关联、预算/现金分离、超额及更正复核；不授予投资权限 |
| CATALOG | [标的目录边界](etf-catalog.md)；`web/src/server/catalog/`；`web/tests/catalog*.test.ts`；`tests/migrations/catalog.test.mjs`；`worker/research/holdings_overlap.py`；`tests/research/test_holdings_overlap.py` | 组合私有研究版本、独立 CAS/分页/范围、结构化 JSON 来源下载、账户证据摘要、最多 4 标的比较；部分披露不归一化、异期不伪同日，TS/Python 重叠一致；未认证真实 ETF/发行商原件或交易准入 |
| GOVERNANCE | `web/src/server/governance/`、`governance-commands.ts`；`web/tests/governance{,-commands}.test.ts`、`governance-race-worker.ts` | 人工版本、证据门槛、风控/预留、执行回报/事实关联；正例使用临时库中的显式合成准入 fixture，不是有效政策 |
| RESEARCH | `worker/research/`；`tests/research/{test_research,test_cli,test_market_index}.py`；`contracts.test.mjs` | 固定权重现金投入研究、PIT 时序、实验登记/冻结/解封、离线 AI 审阅；不含完整月度轮动或持续前向模拟 |
| JOB | `worker/orchestration/`、`web/src/server/workbench-commands.ts`；`tests/orchestration/{test_jobs,test_research_commands,test_evaluations,test_evaluations_bridge}.py` | 授权请求到 Worker、lease/fencing、重试、结果/outbox 原子写入；月度发现有界扫描和固定发布桥；没有真实通知传输 |
| MONTHLY | [月度评估](monthly-evaluations.md)；`web/src/server/evaluation/`、`web/tests/evaluation*.test.ts` | 显式目标、人工启停、原周期知识边界、独立重试、完整证据方可无需调整；真实 Python/Node/SQLite 进程链及原子候选生成；不是完整轮动或实盘有效性证明 |
| AUTH | `web/src/server/auth/`；`web/tests/auth.test.ts`、`auth-http.integration.ts` | 服务端会话、撤销、过期、限速、Origin、缺配置拒绝；生产 TLS/代理及运维配置另验 |
| MIGRATION | `migrations/manifest.json`；`tests/migrations/*.test.mjs`；`tests/deployment/release.test.mjs`；`web/tests/fact-quality.test.ts` | 工作区迁移至 v17，旧事实、周期、回执及 v16 ECB 原件不变；新资料版本和 SDK 捕获不可改，head CAS 与来源类型隔离；新镜像及最终切换尾差尚需另验 |
| RECOVERY | `scripts/{backup-workbench,restore-workbench,archive-legacy}.mjs`；`tests/recovery/backup-restore.test.mjs` | 一致性备份、加密、附件清单、全新目录恢复、只读标记、不覆盖新事实；不是异机 RPO/RTO 验收 |
| HTTP27 | [报告](../artifacts/verification/workbench-http/2026-09-11T22-47-15-552Z/report.md)及同目录 `manifest.json`；`web/scripts/test-workbench-http.mjs` | 27 个 HTTP 场景的阶段快照，详见下文 |
| HTTP32 | `artifacts/verification/workbench-http/2026-09-12T00-31-30-306Z/{report.md,manifest.json}`；`web/scripts/test-workbench-http.mjs` | v9 生产构建与新增资金计划 HTTP 场景；仍为本地合成 fixture，详见 2.4 |
| HTTP33 | `artifacts/verification/workbench-http/2026-09-12T01-19-25-293Z/{report.md,manifest.json}`；`web/scripts/test-workbench-http.mjs` | v10 构建、证券预览/确认/部分到达/退回；最终源码 250 项前后一致，详见 2.5 |
| UI | `artifacts/verification/browser-{foundation,operations,decisions}/report.md` 与同目录截图 | 合成账户桌面/窄屏目标流程；不是全部键盘、读屏或完整投资闭环验收 |
| IMAGE | [隔离构建与发布核验](production-release-verification.md)；`artifacts/verification/release/v8-20260912-2316/`；`tests/deployment/container-smoke.sh` | v8 隔离容器和真实旧库副本归档/恢复通过；旧 v7 工件仍保留；没有替换旧生产，未证明异机恢复或生产 owner 登录 |
| INDEX | [研究索引对照说明](research-index-benchmark.md)；`tests/research/{performance_baseline,index-benchmark-result}.json` | 90 日完整报告等价、3300 合成交易日的新算法重放与终值检查；不是 05/06 的全工作负载性能验收 |

### 2.1 HTTP27 的准确范围

- 运行时间：`2026-09-11T22:47:15.552Z` 至 `2026-09-11T22:47:31.210Z`，schema `8`，构建 ID `k6c00yLkpJZbcJWziascs`。
- 工件记录 `passed=27, failed=0`，运行期间 `source_changed_during_run=[]`；输入是新迁移临时库与合成账户/凭据，结束后清理临时数据库。
- `HTTP-00..17` 覆盖迁移/登录/输入边界、预算与事实分离、幂等/CAS、导入、结算、错误脱敏和退出；`HTTP-18..24` 增加原件下载、对账、未核验证券登记、Web-to-Worker 估值/绩效、恢复锁、更正；`HTTP-25..26` 覆盖研究/治理读取隔离和研究任务不产生真实事实。
- **HTTP27 未证明治理全套正向批准/预留/部分成交的浏览器闭环，也未证明真实市场/券商/AI/邮件连接。** 这些不能由 `HTTP-25` 的“未获批准”负例替代。
- 编写本文时，市场估值、前端和新鲜度检查等文件已与此 manifest 的结束哈希不同，且新文件不一定属于旧清单。该工件不得标为“最新源码全通过”。最终由集成负责人补上冻结版本的新 manifest/报告，不改写旧证据。

### 2.2 重跑命令

根目录运行；Python 使用安装了 `requirements-workbench.txt` 的隔离环境，不依赖系统解释器恰好有包：

```sh
node --test tests/migrations/*.test.mjs
node --test tests/recovery/*.test.mjs tests/market/*.test.mjs tests/research/*.test.mjs tests/orchestration/*.test.mjs tests/deployment/*.test.mjs
python -m unittest discover -s tests/accounting -v
python -m unittest discover -s tests/market -v
python -m unittest discover -s tests/performance -v
python -m unittest discover -s tests/orchestration -v
python -m unittest discover -s tests/research -v
```

在 `web/` 运行；跨语言测试及 HTTP fixture 同时设置 `WORKBENCH_PYTHON` 和 `WORKBENCH_TEST_PYTHON`，均指向该隔离解释器：

```sh
npm test
npm run typecheck
npm run build
npm run test:auth:http
npm run test:workbench:http
```

以上是重跑入口，不是本文新执行并通过的整套验收记录。镜像/恢复演练另按 [发布运行手册](production-release-runbook.md)、[恢复运行手册](recovery-operations.md)在隔离环境执行；不可把示例路径换为真实库后无审批运行。

### 2.3 冻结源码后的追加回归（不改写前次工件）

- 新 HTTP27：`artifacts/verification/workbench-http/2026-09-11T23-10-40-674Z`，运行至 `2026-09-11T23:10:55.640Z`，schema v8，build `nfeqzr5gpw2NBFGCGDcvt`，27/27 通过，`source_changed_during_run=[]`。它包含估值 v2 单位/PIT、绩效 v2 来源绑定、研究/治理集成和恢复迁移门禁补丁后的源码。上节 HTTP27 短名及旧工件仍保留原运行范围，新增工件不拓展那 27 个场景的断言。
- Web 112/112、Python 160/160 已通过；TypeScript、认证 HTTP、shellcheck、npm audit 通过，依赖审计为 0 项。最终补丁后的根目录 Node 全量结果见 [07 进度记录](07-implementation-tracker.md)。这些是合成工程回归，不是 69 项完整验收。
- 新增浏览器行为记录 `artifacts/verification/browser-decisions/refresh-guards-20260912.md`：刷新清除人工确认；读取 503 或两次版本不一致禁用提交；恢复读取不恢复旧确认；切换组合清空载荷/依据/确认。故障仅由浏览器拦截响应注入，结束后无账户/事实/任务，退出后 API 401。
- 发布补强：迁移创建前、事务起点和提交前检查恢复标记；发布长构建后、停旧写者前及切换关键点重复检查。首次受控只读初始化仍只建空 schema。初始化密码按登录相同的 UTF-8 字节上限拒绝，超限不生成秘密目录。这不替代真实 owner 登录与生产代理验收。
- 当前源码的隔离 v8 镜像已通过，run `20260911T231619Z-427243`；最初构建发现遗漏 builder scripts 目录，补齐后通过，未关闭类型检查。真实旧生产库 Online Backup 副本的 17 张用户表、812,776 行逐行内容/哈希核验通过；独立空 v8 库归档及 932,701,236 字节加密包恢复通过，实际账户/事实始终 0。全流程 379.483 秒、恢复进程 76.384 秒（1 CPU/1 GiB，同机），不等于生产 RTO、切换尾差或异机恢复验收。详见 [生产发布验证](production-release-verification.md)。
- 公开边界现已确认：公开代码和通用示例，个人方案本地隔离，提交前核验 index；本历史工件不证明脱敏已覆盖暂存区，也不声称 commit/push 或发布工作流已完成。推送/CI 与正式生产切换分别记录，不据本节宣布 L-1/L-2/L-3 已验收。

### 2.4 资金计划与逐流 FX 的 v9 历史回归

- 新实现为资金计划版本/关联与 performance v3，详见 FUNDING、PERFORMANCE 和 [逐流 FX 说明](performance-flow-fx.md)。旧绩效 v1/v2 标记过时，不以旧完整状态继续展示可用收益。
- 同版工程回归：Web 147/147、Python 180/180、根目录 Node 46/46；TypeScript、认证 HTTP、shellcheck、npm audit 通过，依赖漏洞为 0。
- 新 HTTP32 工件：`artifacts/verification/workbench-http/2026-09-12T00-31-30-306Z`，schema 9，build `fUrKvxbFw1rcI85svrs1o`，运行 `00:31:30.306Z` 至 `00:31:46.278Z`，32/32 通过。231 文件的运行前后清单一致，浏览器复核后再比对仍无差异。新增 F01..F05 覆盖计划无现金、严格鉴权/格式/CAS、部分到账上限/幂等、缩减预算/延期/解除匹配和恢复只读。
- 浏览器最终干净 v9 fixture 通过计划录入、真实合成入金后匹配、延期、空账户选择、刷新/切组合撤销确认、503 禁写、明确冲突后新尝试、已提交但回包丢失后原请求幂等重试、1440/390px 暗色布局及退出 401。报告：`artifacts/verification/browser-funding/report.md`。临时库已清理，测试凭据和 25.01 元均为合成数据。
- 摘要复用计划 hash/items 验真；坏证据只返回待核对与空预算，不阻断事实读取。治理端修正 FX 标准单位并复用 v2 估值验证。资金批次超预算、取消后仍有成交、未核对更正均明确警示。
- 此次仅本地代码/构建/测试；上述 v8 容器与真实旧库演练不是 v9 镜像证明。未暂存本轮变更，未推送，未替换生产，未取得 D/S 投资准入。

### 2.5 证券转移、在途与 CSV 基础的 v10 回归

- 估值 v3 / 绩效 v4、证券五种事实、在途追加 movements、部分接收/退回/拆分、更正重放及来源/目标分别对账已实现；详见 SECURITIES。外部确认市值是资本流，不能把历史成本差额当期间利润；所有币种的仅日期外部证券流保留收益阻断。
- 冻结后回归：Web 189/189，Python 199/199（accounting 55、market 28、orchestration 24、performance 58、research 34），根目录 Node 48/48；TypeScript、认证 HTTP、shellcheck 和生产依赖审计通过，漏洞为 0。
- HTTP33：schema 10，build `ES7lzBrbEWzQPr0lrtKP5`，运行 `2026-09-12T01:19:25.293Z` 至 `01:19:41.016Z`，33/33 通过。250 项源码运行前后及随后复核均无变化；manifest SHA-256 为 `10e3a9e34d69eaf37761f89ec651f247280601836799ffa2c5a9348aa49156ad`。
- 原生浏览器通过外部转入、内部全部发出、部分接收/最终退回、改字段撤销预览、实际提交后丢回包再原批次重试、390px 暗色与桌面浅色、退出 401。三张截图已打开检查；报告 `artifacts/verification/browser-securities/report.md`。
- 独立复核发现目录超过 1000 条时接收已显示批次会失败；改为从所选在途批次取 listing/currency，专门测试及最终构建通过。该分页特例未再次做原生浏览器操作，不将此前截图冒称为修复后的证明。
- CSV 基础 15 项通过，保留字节/行位置、明确映射和数值格式、禁止公式执行；原始 CSV 到不可变映射/预览/确认的生产接入仍未实现。没有认证国内券商或跨境券商原生格式。
- 六份 v1.0 规格不变；本轮未暂存/提交/推送，原 index tree 保留。没有 v10 容器、异机恢复或生产发布证明，不升级任何 D/G/S/完整验收门槛。

### 2.6 通用 CSV 确认链的 v11 回归

- Web 236/236、Python 199/199、根目录 Node 58/58（本次包含 migrations 和 flow contracts）；TypeScript、认证 HTTP、shellcheck、依赖审计通过，漏洞 0。完整命令/环境及失败前置运行见 [07 进度记录](07-implementation-tracker.md)。
- 最终生产构建 `gorUQLjTLYwvNA5cMv6uC`，HTTP 41/41（增加 CSV01..08），schema v11；`artifacts/verification/workbench-http/2026-09-12T02-03-43-133Z`，运行区间 `02:03:43.133Z` 至 `02:03:45.638Z`，264 个源码条目在运行中和随后核对均未改变。manifest SHA-256：`fe19de0f2edeaa001746edfb16b393af5941feaf7628fcace32414133b616384`。
- HTTP 最初发现全局 CSP 覆盖附件 sandbox，补专用下载路径规则后重建通过；没有删断言或将服务函数单测冒充网络验证。CSV01..08 覆盖真实 multipart 原件/映射下载、零事实预览、缺确认拒绝、原子确认/重试、坏文件/体积/编码、身份/范围/CAS 和恢复锁。
- 服务回归覆盖同文件人工关联后的重复行、跨 CSV/JSON/direct 来源别名、金额冲突、未变账本 revision 的别名竞争、同批来源禁止改绑、历史确切行只关联、证据不可变与事务回滚。CSV 字节/MIME 亦有加密备份恢复回归。
- 原生浏览器记录：`artifacts/verification/browser-csv/report.md`。26 行跨两页全部人工核对、末页未完成禁止确认；服务端真实提交后注入 503，重试 body 完全相同，最终 25 笔事实、CNY 448.125；暗色桌面/暗亮移动端、A-B-A 清除确认与退出后 API 401。该浏览器用本地开发 fixture，不是生产环境。
- 无真实券商样本、可视化映射向导、10,000 行确认性能、新 v11 远程镜像或异机恢复结论；ACC-18/P-02/E-24、生产发布与策略准入保持未完整验收。

## 3. E-01 至 E-32 工程用例

“完整状态”针对 06 原用例全部预期及相应证据要求。子集断言已存在不消除右栏缺口。

| 编号 / 完整状态 | 当前已有子集 | 可复现证据 | 尚缺的验收条件 |
|---|---|---|---|
| E-01 / NOT_RUN | 创建组合保存资金计划不产生现金/事实；未开账和缺政策不放行 | LEDGER `F01/F02`；MARKET `test_uninitialized_budget_does_not_create_assets`；HTTP27 `05/25` | 冻结版本逐步验证“仅计划 -> 资产 -> 请求建议”完整界面/服务端结果，并记录计划修改与零事实证明 |
| E-02 / NOT_RUN | 已核实期初本金与追加到账事实组成累计投入；预算不生成实际余额，入金不作为利润 | LEDGER；ACCOUNTING `test_F02_funding_is_not_profit`；HTTP27 `06/23` | 同一端到端输入贯通估值/绩效及资金计划状态，人工核对现金、NAV、净投入和损益；实际到账资料仍待 D-04 |
| E-03 / NOT_RUN | 交易日确认数量与应收应付、独立结算；均价成本/费用金标准 | LEDGER `F03/F04`；ACCOUNTING `F03/F04`；MARKET `test_cash_only_and_trade_date_nav_then_settlement`；HTTP27 `13` | 同版 F-03/F-04 全阶段 Web/Worker 证据包，含部分卖出、估值、费用及跨币种来源精度核对 |
| E-04 / BLOCKED | 分红应收/支付、未知与暂估税、累计税确认、实际补扣/退税、净额分解、公司行动隔离与质量 UI；再投仍为独立事实 | DIVIDEND；LEDGER `F05/F13`；ACCOUNTING `F05/F13`；RESEARCH `test_dividend_tax_and_split_do_not_fake_total_return` | 真实公司行动/权益适配；税差状态、原件和 UI 的完整人工验收；再投和复杂合并/清盘不能冒充普通分红 |
| E-05 / NOT_RUN | 在途/到账、双币种 FX 桥、手续费；买入预算严格按账户币种 | LEDGER `F06/F07`；CORRECTION 成对转账/FX；GOVERNANCE 现金/权限负例 | 多账户完整资金依赖链与回录 UI 验收；实际资金路径、可换汇/转账权限及收费证据未取得 |
| E-06 / BLOCKED | TWR/Dietz、XIRR 诊断、回撤、v5 现金/证券流逐笔 FX 与点/区间事实质量跨语言验真 | ACCOUNTING `PerformanceTests/XirrTests`；PERFORMANCE；SECURITIES；DIVIDEND | 真实历史流量/FX 资料；多期归因/基准；完整金标准、容差/残差和缺口 UI 的正式验收 |
| E-07 / NOT_RUN | 原件重传、跨文件来源去重、语义冲突、同额不同来源保留 | IMPORT `source cross-file duplicates...`；LEDGER 幂等；HTTP27 `07/10/12` | 国内/跨境券商脱敏样本和无可靠来源 ID 的人工疑似重复流程；不能把当前拒绝缺字段当完整券商去重能力 |
| E-08 / BLOCKED | 部分真实成交消耗剩余预留，回报不入账，取消只释放余量 | GOVERNANCE `E21...partial fills`、report 幂等；IMPORT；HTTP27 `10` | 分次独立费用关联执行事项、原生分笔文件验证；实际状态驱动新的剩余目标/建议生成尚不完整，不自动重下原单 |
| E-09 / BLOCKED | 缺价/FX 不填零；人审日历明确 full/half/closed、当前引用和截止；公司行动缺口标质量 | MARKET 估值测试；PRICE；ACCOUNTING `QualityTests`；HTTP27 `21` | 权威 A/HK/US 日历与公司行动提供方、真实休市样例、质量规则批准；人审记录不能替代资料真实性验收 |
| E-10 / BLOCKED | 空/缺页/重复/冲突批次不替换当前发布，遗漏不停用证券；SDK 单市场完整集合日期核对 | MARKET `test_empty_or_partial_never_replaces_publication_or_disables_listing`、page tests；PRICE；MIGRATION | 真实 ETF 清单采集适配、分页/覆盖率异常与独立退市证据生命周期；固定日价格子路径不认证全量市场覆盖 |
| E-11 / NOT_RUN | 口径分键，未复权估值与调整序列隔离；SDK 固定 Day/NoAdjust/regular，消费端独立核对 | MARKET `test_price_basis_keeps_separate_observation_keys`、`test_valuation_units.py`；PRICE；RESEARCH 口径负例 | 冻结版本混合真实来源/修订/分红样例、完整 HTTP/镜像与展示验收；SDK 投影不得冒充网络原字节 |
| E-12 / BLOCKED | effective/recorded 与发布/获取时间分离；as_known/restated；人审版本 known_at 与更新失效/历史重放 | CORRECTION；MARKET；PRICE；PERFORMANCE 行情修订测试；RESEARCH PIT；HTTP27 `24` | 真实发布时间/修订档案、财报和披露适配；全链真实决策重放；日历 close_at 不补造价格 published_at，日期精度不足继续拒绝 |
| E-13 / NOT_RUN | 冲销/替代追加不可改；后续成本及结算依赖重放；与干净顺序基线比较 | CORRECTION `corrected average-cost history equals...`、import provenance；HTTP27 `24` | 最终同版多事件随机序列/跨语言全投影对照、历史报告人工核对；混合精度/跨时区日期/超过 5000 步仍需受限范围签核 |
| E-14 / BLOCKED | 未知成本保留未知，不将卖出全额当利润；外部证券确认市值与成本分离、内部在途仅计一次；区间新增开账不制造收益 | LEDGER；SECURITIES；CORRECTION；PERFORMANCE | 真实转仓凭证、经核对期初市值/绩效起点及全生命周期验收；日期外部证券流仍阻断收益，不能声称全生命周期盈利 |
| E-15 / NOT_RUN | 38 位/18 小数约束、Decimal、非有限数/浮点/指数拒绝；代码保留字符串 | LEDGER 精度负例；ACCOUNTING `DecimalBoundaryTests`；MIGRATION contracts；IMPORT strict JSON | 完整原生文件格式解析/来源量子与舍入规则样本；极值跨语言逐步比较、原文隔离和展示的最终证据 |
| E-16 / BLOCKED | listing 分市场份额；风险使用私有人审 index/region/sector 分类与 currency，并拒缺失分类；分类不是加权穿透 | GOVERNANCE 浓度/缺信息检查及 listing-review 输入指纹；ACCOUNTING FX 交叉项；MARKET 标识 | 基金穿透覆盖/披露时效、同指数多产品对照、组合多期资产/FX 金额归因及残差界面未完整实现 |
| E-17 / NOT_RUN | AI 无写/批准权限；政策/策略严格语义、缺阈值拒绝、候选不自动生效 | GOVERNANCE `E17`、伪造验证任务负例；RESEARCH `AIReviewTests`；HTTP27 `25` | 最终同版对抗固定/预留案例和人工质检；覆盖所有将来 provider/tool 边界，而非只校验离线 JSON |
| E-18 / BLOCKED | 显式月度目标的 unchanged/proposed/blocked、固定月槽位、次日输入变化不重复发现、原知识边界及独立重试；零订单不冒充无需调整 | MONTHLY；JOB；RESEARCH 的旧回放只作历史研究 | 完整轮动算法、排名改变和授权例外、真实行情/日历及原生界面闭环仍需实现/验收，不能从显式目标比较外推 |
| E-19 / NOT_RUN | 批准/执行前重新读取 ledger、market、policy、账户/预留摘要；变更拒绝 | GOVERNANCE `E19`、`execution preparation rechecks...`；HTTP27 `08/14` | 治理正向 HTTP/浏览器全流程，版本改变/价格窗口/账户变更覆盖矩阵；发布版本与最终镜像复核 |
| E-20 / NOT_RUN | 合成并发 fixture：两个独立进程争 100000 现金、各预留 60000，最多一个批准；卖出数量预留 | GOVERNANCE 并发进程及 sell tests；ACCOUNTING 预留不减 NAV | 目标部署负载下重复并发/锁等待/故障注入证据；不能以一次正确竞争证明性能或全部组合情形 |
| E-21 / NOT_RUN | 取消/过期后真实成交仍记账并标偏离；只消费未成交余量，不自动复活建议 | GOVERNANCE `E21`、expiry tests；CORRECTION 来源不复活 | 原生券商迟到文件到导入/执行关联/对账全流程，以及残余目标重算；明确通用事实入口不猜测对应预留 |
| E-22 / NOT_RUN | portfolio/account/research-run 隔离；实际事实契约拒模拟；查询有范围与上限 | MIGRATION scope tests；RESEARCH registry；`web/tests/research-workspace.test.ts`；HTTP27 `25/26` | 多账户/多策略/多模拟运行“最新”查询完整矩阵；实际收益与各研究窗口的页面人工验收 |
| E-23 / NOT_RUN | 私有页、API、Server Action/DAL、下载服务端鉴权；过期/撤销/限速/Origin | AUTH；IMPORT 附件越权；HTTP27 `01..03/08/16..18/25` | 最终生产 TLS/反代/安全 Cookie、所有新入口清单、配置轮换及真实网络路径验证；生产登录不以本地 HTTP 替代 |
| E-24 / BLOCKED | 受控哈希路径、无 symlink、原件重哈希、5 MiB 流式限制、严格 JSON；CSV MIME/原字节、不可变映射与确认链，公式惰性 | IMPORT；CSV；RECOVERY；AUTH；HTTP27 `04/18` | 导出公式、Markdown/HTML、解析压力/故障和真实券商格式仍需完整集成验收 |
| E-25 / BLOCKED | 离线 AI 输出结构/引用/数字检查，提示注入与伪造权限不转为动作 | RESEARCH `AIReviewTests`；JOB 研究请求拒身份注入 | 无真实模型/检索 provider；真实超时、受限检索/SSRF、批准降级方案、脱敏预留案例与人工来源支持度质检 |
| E-26 / BLOCKED | 持久任务、失败重试、lease/fencing、旧提交拒绝、恢复锁中途回滚 | JOB `test_jobs.py`、`test_research_commands.py`；HTTP27 `21/26` | 真实采集故障、OS 级 kill/restart、长计算 heartbeat、跨日策略补跑；当前没有周期调度不等于已证明及时决策 |
| E-27 / BLOCKED | 业务结果与 outbox 原子写入；幂等语义冲突可查 | JOB `test_effect_job_and_outbox_commit_atomically`、failed-effect rollback | **通知发送器未实现**；发送成功后响应丢失、独立重试/重复风险提示、真实渠道配置及故障注入尚缺 |
| E-28 / NOT_RUN | 决策后下一收盘固定数量执行，不赚选样日翻倍；未来成交价不倒推数量 | RESEARCH `test_E28_selection_day_double_is_not_earned_by_next_close_buy` 及 future-price/cash tests；INDEX | 当前固定权重研究子集外的旧 MOM/轮动仍不能沿用；每个拟准入算法及执行模型须用同版时序案例重验 |
| E-29 / BLOCKED | 单一迁移/no seed；候选/激活分开；研究绑定实现/参数 hash；旧站归档只读 | MIGRATION fresh/no-op；GOVERNANCE 版本；RESEARCH 固定实现；HTTP27 `00/25/26` | 完整监测、图表、周期报告对参数切换的一致性未闭环；旧历史不拼新收益；真实部署冷启动仍需验证 |
| E-30 / NOT_RUN | 缩小 COPY、忽略 data/config、非 root、私有附件/备份；隔离镜像检查 | IMAGE；AUTH；RECOVERY；`tests/deployment/release.test.mjs` | 最终 v12 源码镜像的层/客户端/日志扫描和凭据配置；旧 v7/v8 容器 fixture 不覆盖当前代码及生产秘密边界 |
| E-31 / BLOCKED | 新空库、旧单主题/多主题归档、WAL、版本冲突/中断/幂等；真实旧库副本 17 表 812,776 行逐行/计数/哈希及恢复验证 | MIGRATION；`tests/deployment/release.test.mjs`；IMAGE | 最终切换时点尾差与连续性证明、真实生产新版本完整验收；同机副本成功不意味着已切换 |
| E-32 / BLOCKED | Online Backup、加密/附件 manifest、损坏拒绝、原子恢复、不覆盖现有目录、恢复只读 | RECOVERY；JOB/LEDGER 提交前恢复锁；IMAGE | 真异机恢复/独立密钥故障域、备份后尾部事实重放对账、磁盘满/断写/切换失败全注入；RPO 15 分钟/RTO 2 小时未测量 |

## 4. ACC-01 至 ACC-19 核算规范

以下均为**未完成整体验收**的实现映射；E 编号沿用上一节的状态，不因本表重复引用升级。

| 编号 | 当前实现与复现证据 | 尚缺条件 / 明确受限范围 |
|---|---|---|
| ACC-01 规划/事实/投影分层 | 资金计划版本/来源/批次/关联独立于现金；批准不记成交；actual/research 隔离。FUNDING、LEDGER、GOVERNANCE、MIGRATION；E-01/02/22 | 真实计划及各类历史投影全链验收；不能以合成研究替换真实历史 |
| ACC-02 组合范围 | 多账户/币种、期初现金/持仓和未知成本，查询按组合。LEDGER、PERFORMANCE；E-05/14/22 | 真实启动日与起算权益核对、证券实物外部流和新增账户边界；D-04 未完成 |
| ACC-03 证券标识 | instrument/listing、市场/交易所/字符串代码；新增组合私有身份/挂牌/产品结构/整手/价步的人审版本、来源与身份哈希、过期和双时点检查；与账户权限分离；MARKET、GOVERNANCE；E-10/15/16 | 实际发行人/交易所身份与生命周期核验、完整来源别名有效期、份额差异与历史可买性；原生券商映射/穿透资料 |
| ACC-04 精度 | 财务字符串、Decimal >=50 位、边界/非有限数拒绝、half-even 参考测试。LEDGER、ACCOUNTING、contracts；E-15 | 原生来源解析与每券商确认量子、舍入差异审计；未支持格式不得宽松转 number |
| ACC-05 时间语义 | UTC/来源时区/date 精度、系统实际获取时间、as_known/restated、修订不当成收益。MARKET、CORRECTION、PERFORMANCE、RESEARCH；E-12 | 真实来源披露时间核验；全部旧档案 PIT 可信性；混合精度歧义仍需拒绝而非伪造顺序 |
| ACC-06 事件/分录 | 逐币种平衡、独立数量、不可变事件、head/幂等/审计同事务；更正追加。LEDGER、CORRECTION；E-03/13 | 完整随机混合序列/故障下跨语言投影对照，所有将来事件类型及迁移后的真实对账 |
| ACC-07 事件处理 | 开账、资金、买卖/结算、费用、分红、FX、现金转账、证券外部流/内部在途及部分接收/退回、拆分、更正。LEDGER、ACCOUNTING、SECURITIES | 真实证券转仓/复杂公司行动、原生券商摘要复合事件及未知税费流程验收 |
| ACC-08 可用资金/预留 | 已结算现金扣应付款、显式 hold、active buy reservation；卖出数量预留；事实关联时原子释放。GOVERNANCE；E-19/20/21 | 真实券商 hold 去重证明；外部未知下单/通用导入与预留关联的操作流程；账户可用资金核验 |
| ACC-09 成本/损益 | 每账户 listing 原币移动均价；费用费用化；未知成本保留；在途分配到 18 位、末笔取残余，更正重放守恒。LEDGER、CORRECTION、SECURITIES | 券商管理/税务成本差异说明与真实样本对账；未由合成成本链测试替代实物转仓原件验真 |
| ACC-10 分红/公司行动 | 未知税/暂估/确认、净额与税前归因分离、累计税差不改现金、实际补扣/退税、应收/应付税、公司行动通知/解决与独立质量证明；拆分成本守恒。DIVIDEND、LEDGER、RESEARCH；E-04/11 | 权益与除息时点真实来源；完整税差/更正/再投 UI 人工闭环与真实合并/清盘隔离验收；不得以已有状态机替代原件核查 |
| ACC-11 FX/调拨 | 两币种原始腿/桥、在途只计一次；外部流逐笔历史参考 FX 及来源/PIT 验真。LEDGER、MARKET、PERFORMANCE；E-05/06 | 实际历史 FX/到账资料、汇兑执行差全期归因；实际跨境能力不得假定 |
| ACC-12 NAV | NAV v4 金额/数量按 cutoff 重构、未复权市价替成本、应付税计负债；缺价/FX/未决税与公司行动返回 null 和质量；预留不减 NAV。MARKET、PERFORMANCE、DIVIDEND；E-03/09/11 | 真实日历/权益覆盖规则批准；全部历史区间与 UI 缺口验收；当前版本单位、PIT、税与公司行动的完整集成证据 |
| ACC-13 市场契约 | 来源/单位/时间/口径/修订、页原文、成员集合、历史发布与 CAS。MARKET、MIGRATION；E-10/11/12 | 真实 provider/许可、原始材料独立核验、生命周期与完整穿透、定期刷新；填 source hash 不等于已下载核验 |
| ACC-14 外流/损益 | external_capital 区分现金/外部证券与内部交易；逐有效 posting 冻结确认市值、原 fact 和事件当时 FX；修订不当利润。PERFORMANCE、SECURITIES | 真实起算、转仓时点/价值、FX 资料；外币流或任何币种证券流仅日期精度时继续 blocked，不借用期末汇率 |
| ACC-15 TWR/Dietz | 纯函数精确分段；真实快照无流量精确，有流量缺前后 NAV 标 Dietz；date-only 标假设。ACCOUNTING、PERFORMANCE；E-06 | 自动生成外部流前后可靠估值；完整精确 TWR 不是任意两端 NAV 都可得到；缺段/重启区间 UI 验收 |
| ACC-16 XIRR | ACT/365、统一评价时区、同日合并、多根/无根/残差诊断。ACCOUNTING、PERFORMANCE；E-06 | 按真实完整原币流及当时 FX 重放；界面全部异常状态、实际区间与年化文案验收 |
| ACC-17 回撤/基准/归因 | 单位化快照回撤/修复辅助函数；研究同到账/成本/FX 基准；单段 FX 交叉项。ACCOUNTING、PERFORMANCE、RESEARCH；E-06/16 | **真实组合多期金额归因、影子基准、滚动对照/压力暴露尚不完整**；快照回撤不声称覆盖未观察低点 |
| ACC-18 导入契约 | JSON/CSV 原件 bytes/hash、零写检查与可视化显式映射、不可变版本/行校验、逐行人工重复处理、整批确认、来源别名、行到事件链。IMPORT、CSV、CORRECTION；E-07/15/24 | 国内/跨境券商原生格式、向导原生完整交互；1 万行后台导入能力与性能未验收 |
| ACC-19 对账/更正 | 同账户显式覆盖所有币种/证券/挂账，差异留档；更正重放、旧原件可查、只失效受影响账户且保留 disabled。IMPORT、CORRECTION；E-13/21 | 目前对账不支持任意历史 cutoff；券商可用资金/hold 与账本余额需独立证据；真实样本/全链人工核对仍缺 |

## 5. P-01 至 P-08 产品需求

| 编号 / 整体状态 | 当前可用实现子集及证据 | 尚缺产品闭环 |
|---|---|---|
| P-01 / BLOCKED | 空组合/账户、开账、未知成本、显式对账和权限；LEDGER、IMPORT、GOVERNANCE、HTTP27 `05/19/20` | D-04/D-07 真实账户与启动资料；实物转入及完整起算确认；权限证据不能由市场名称推定 |
| P-02 / BLOCKED | 标准 JSON 与通用 CSV 原件、零写检查/可视化映射、版本封存、逐行重复核对、预览确认、事实/更正、对账、附件及当前会话原请求恢复；IMPORT、CSV、CORRECTION、HTTP27 `09..12/18/19/24` | 券商原生适配、向导/恢复/BFCache 原生故障验收、分次费用/执行关联；支持列表之外事件不能编造成已支持 |
| P-03 / BLOCKED | 原币现金/持仓、CNY NAV 质量、不可变绩效、TWR/Dietz/XIRR/快照回撤；MARKET、PERFORMANCE、UI | 完整真实资金流 FX、归因/影子基准/暴露与压力、全部时间/估算状态 UI；实际数据和账户回归 |
| P-04 / BLOCKED | 日期化初始/追加来源、计划版本、批次截止/延期/未执行处理、到账匹配与执行关联、可用现金/预留分离、超预算和更正警示；FUNDING、GOVERNANCE、HTTP32 F01..F05、资金浏览器流程 | 用户确认实际年度计划/资料、D-05 投入选择与授权、完整多账户资金依赖及执行闭环验收 |
| P-05 / BLOCKED | ETF/listing 登记、发布批次、口径与可买性证据；CATALOG 私有目录、版本化费率/标签/持仓披露、四标的比较、重叠上下界；v19 新增有来源/期限的身份与生命周期人审，不再靠全局 fixture 核验字段通行 | 真实提供方/原件及身份生命周期认证、当前费用/流动性/折溢价资料、等价份额识别和完整加权穿透；人审不冒充提供方或投资批准，原生审核/比较/窄屏尚待验 |
| P-06 / BLOCKED | 人工标准载荷候选、风险、审批/预占、执行前重查、回报与真实事实分开；GOVERNANCE、UI | 周期不操作/阻断状态机、多策略净额聚合、自动剩余目标重算、资金依赖、多步向导/替代方案；完整合成券商执行闭环验收 |
| P-07 / BLOCKED | 研究预注册/预算/冻结/解封、不可变结果、同口径基准、离线 AI 结构/来源核验；RESEARCH、JOB、HTTP27 `26` | S-01..10 全未验收；真实数据/模型、稳健性矩阵、持续前向模拟、正式阈值与有限预算批准 |
| P-08 / BLOCKED | 服务端认证、审计、数据质量阻断、CAS/预留、lease/fencing/outbox、恢复只读；AUTH、JOB、RECOVERY、IMAGE | 通知传输、生产节奏/监控告警、暂停恢复业务流程、目标负载/故障与异机恢复、生产配置和最终部署验收 |

## 6. S-01 至 S-10 策略门槛

**没有任何 S 项在本轮获验收。** 下列工程机制是将来收集证据的基础，不是策略通过证据。研究的 `live_advice_eligible=false` 不得由 UI、上传 `PASS` 文本或人工“已阅”改成策略合格。

| 编号 / 状态 | 已有支持机制或合成回归 | 必须补充的正式证据 |
|---|---|---|
| S-01 / BLOCKED | MARKET provenance/PIT 字段、发布快照与 RESEARCH 数据冻结 | 来源许可、真实历史可获得时间/修订档案、退市/上市全集与幸存者偏差独立审查；用户填写 historical 标签不构成证明 |
| S-02 / BLOCKED | RESEARCH 时序、现金/成本/FX/基准回归；INDEX 等价检查；E-28 子集 | 拟准入算法全部适用 E 用例与真实数据可重放证据；E-18 月度轮动等未完成，不能从固定权重回归外推 |
| S-03 / BLOCKED | 计划/搜索预算、失败保留、候选冻结与一次解封；RegistryTests | 正式预注册签核、可证明未提前查看的 holdout 与实验全集；当前未加密隔离，近似数据重复试探未全面识别 |
| S-04 / NOT_RUN | 可登记训练/验证/留出试验和参数；窗口独立重启 | 预定多时段/滚动验证、邻域、成本/延迟/缺失敏感性全矩阵，含失败窗口和多重搜索解释 |
| S-05 / BLOCKED | 研究基准与策略同资金到账/币种/成本/FX/执行时点 | D-03 正式基准；可实施真实被动配置与简单策略对照，完整影子账户和共同评价区间 |
| S-06 / BLOCKED | 严格要求显式 admission thresholds；不接受空阈值和临时放宽 | D-01/D-02/D-06 预先批准条件、真实样本外证据量、净收益/回撤/修复与风险统计；不取 fixture 数字充当授权 |
| S-07 / BLOCKED | 回放模式区分实际当时可知与重构，不回填及时决策 | 持续真实时间前向模拟未实现/运行；冻结规则、实时决策、摩擦、失败/漏执行和批准观察量全部需积累 |
| S-08 / BLOCKED | account capability、对账、现金/结算/整手/费用风控接口 | D-04/D-07 国内与跨境券商资料、可买清单、实际费用/资金路径、真实稳定数据与运行证据 |
| S-09 / NOT_RUN | 离线 AI 引用/数字/权限负例及结果存档 | 若策略依赖 AI：真实模型版本、固定与预留质检、有/无 AI 同条件对照；不依赖 AI 也需经批准声明范围，不能自行标 N/A |
| S-10 / BLOCKED | 候选/激活分离、有限范围审批与审计；伪造验证任务拒绝 | 真实策略/政策/预算/启停条件和证据包、用户独立签核；D 未决、G/S 未通过不能由工程开发授权替代 |

### 6.1 G 门槛与受信验证的特别限制

- G-01 需要真实已批准政策，G-02 需要经确认账户及权限；临时测试附件与合成对账不代表用户资料已核实。
- `web/src/server/governance/verification.ts` 只有受信内部登记/校验接口，没有用户/AI HTTP 操作；它要求受信任务、suite/tool、文件与 manifest hash、适用版本和正式结果。
- v21 已实现独立 `verifier` role 的真实执行链，但只覆盖固定合成工程子检查 `E-02.cash-contribution-neutrality.v1`，不等于完整 E-02 或正式 G-03/G-04。结果固定 `gate_eligible=false`、`completed_requirements=[]`；见[受控验收边界](controlled-verification.md)。完整 E/S 适配器和正式证据仍未完成，旧 v1 临时库成功任务不会升级为 v2 证据。
- `WORKBENCH_RELEASE_SHA256` 未配置，当前 Compose 未透传；不能为演示塞入任意 hash 打开实盘门槛。最终必须绑定已核验源码 manifest 与实际运行版本。
- 当前研究不产出经独立核验的 `admission_grade=formal_verified`。S 证据不足不能靠手改研究成功标签、上传 PASS 或人工确认阅读而升级。

## 7. 横向尚缺的验收证据

这些要求跨多个编号，不能在每行重复引用一个快测试后宣称完成：

1. **属性/跨语言业务序列**：现有固定种子算术与部分重放对照不覆盖“入金 -> 买卖 -> 结算 -> 转账 -> 更正 -> 公司行动”的完整随机状态机，需逐步平衡/投影/幂等/净投入及预留断言。
2. **完整人工闭环**：已有 1440×900、390×844 的局部浏览器记录。尚缺从合成国内/跨境券商开户到初始/追加事实、估值、建议/批准、部分成交、对账、剩余建议及月度归因的一次完整运行；键盘/读屏、金额/质量可见性和失败恢复仍需覆盖。
3. **目标负载**：未完成 4 vCPU/8 GiB、10 账户/1000 证券/200 万行情/5 万事件、同时发布/估值/查询/批准的测试；未有核心查询及原子命令各 1000 次冷/热样本的 p50/p95/p99、锁等待、错误率/资源证据。INDEX 的 3300 合成日约 4.46 秒只说明特定研究输入，不证明上述预算。
4. **后台导入**：当前标准 JSON 的大小/行数限制和同步确认不能替代 1 万行后台预览/确认 60 秒、可查询状态和重启恢复验收。
5. **故障/恢复**：已有事务回滚/lease/恢复标记/坏备份测试，仍缺提交前后 kill、磁盘满/断写、通知响应丢失、异机密钥与备份取回、尾部事实对账、实际 RPO/RTO。
6. **最终发布证据**：最终源码/依赖/manifest -> 构建 -> 新镜像层/客户端秘密扫描 -> 生产备份副本演练 -> 经批准切换 -> 实际 SHA/image/schema/认证/任务/对账/备份核验，必须是可串联的一份新证据包。v8 隔离镜像和真实副本演练现已完成，但旧站存活或隔离成功不是新系统部署完成；公开范围已确认，提交前 index 隐私核验、生产保护配置、异机恢复及最终切换仍须闭环。

## 8. 后续开发与验收优先级

1. **维持正确性边界与版本绑定**：当前迁移 v13 / NAV v4 / 绩效 v5 的工程同版证据见第 10 节，生产/镜像/完整验收仍须补齐；后续变更须重跑并更新源码工件，不拿旧版本计数替代当前验收。
2. **补齐 L-1 账本闭环**：完成新增可视化映射的原生及导航故障验收，补后台大批量任务与吞吐验证；完成已实现的未知税费/公司行动状态与 UI 的完整验收，核实真实起算规则，取得授权脱敏样例后核验国内/跨境券商适配，不预填真实事实。
3. **补齐产品而非只增接口**：完成已加入的目录分页/比较原生 UI 验收与真实资料采集；补历史查询、真实归因/基准、月度“不操作”周期状态、剩余建议及完整执行/资金闭环；维持实盘门槛关闭。
4. **完成运行可靠性**：后台大导入、周期调度、通知传输、监控、压力/故障与异机恢复，再做真实生产副本演练及最终发布签核。
5. **研究最后独立准入**：先明确 D 选择，取得可信数据/费用/可买规则，注册正式实验、稳健性与前向模拟，建立真正受信验证 Worker；逐项取得 S/G 证据及人工批准后才讨论 L-3。任何工程进度都不保证持续盈利。

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-09-12 | 建立 32 个 E、19 个 ACC、8 个 P、10 个 S 的逐项实现/证据/缺口映射；HTTP27 标记为阶段性，保留生产、真实资料、正式策略与恢复/性能未验收边界 |
| v0.2 | 2026-09-12 | 追加 v8/估值 v2/绩效 v2 最终集成 HTTP 工件与浏览器刷新/作用域故障检查；记录恢复迁移门禁和密码字节边界补强，不升级任何完整验收状态 |
| v0.3 | 2026-09-12 | 资金计划、逐事件 FX 与 v9 集成回归；保留计划/事实、真实数据和发布边界 |
| v0.4 | 2026-09-12 | 证券实物流/在途、v3 估值/v4 绩效、两端对账、CSV 基础及 v10 回归；不升级完整验收/生产/策略门槛 |
| v0.5 | 2026-09-12 | v11 CSV 原件/不可变映射/逐行重复核对/来源绑定与原子确认，高级 Web 入口；不升级券商认证、完整验收或发布门槛 |
| v0.6 | 2026-09-12 | 公开版以通用预算/券商示例替换个人参数；原始六份基线本地隔离、提交前核验 index；更新迁移 v12、NAV v4/绩效 v5 与分红税/公司行动实现索引，不声明新最终回归或升级验收门槛 |
| v0.7 | 2026-09-12 | v13 组合私有目录、披露覆盖/重叠与 API 工件；公开研究资金参数重新建立通用基准，保留旧原件；浏览器目录验收中断单独记录，不升级 P-05 或发布门槛 |
| v0.8 | 2026-09-12 | 备份并刷新旧 index，复核实际暂存内容；补 Docker 私有目录排除与路径回归，记录新构建 HTTP50；仅用于公开代码检查点，不升级生产或投资准入 |
| v0.9 | 2026-09-12 | CSV 零写检查、可视化显式映射、原值分页、跨 revision 未决确认保护及 HTTP57；合成核算/导入 fixture 去关联并重跑，不升级券商认证、完整原生验收或发布门槛 |

## 9. v12 分红扣税与公开边界：本次同版证据

本节补充 v0.6 的运行工件，不把 E-04 / ACC-10 或其他完整门槛改为 PASS。

| 范围 | 本次结果及工件 |
|---|---|
| Web | 281/281；`artifacts/verification/final-regression/web-dividend-v12-final.log`；包括分红引擎/账本/更正、质量复算、对账、查询与表单输入 |
| Python | 226/226；`python-dividend-v12-post-privacy.log`；含真实 TS 账本到 NAV/绩效、时点与期间质量、负数税应付和可投现金 |
| Node 契约/迁移/恢复等 | 58/58；`node-dividend-v12-post-privacy.log`；严格共享契约与迁移检查，旧层不被静默重写 |
| 生产构建 HTTP | 45/45；`artifacts/verification/workbench-http/2026-09-12T03-07-10-027Z/{report.md,manifest.json}`；新建组合无个人计划默认值、分红预览/幂等确认、实际收付/税认定、公司行动、范围及整数 CAS |
| 原生浏览器 | `artifacts/verification/browser-dividends/report.md`；桌面/窄屏、净额归因与负债可见、响应丢失后相同请求重试、账户切换清除预览、退出后 401 |
| 其他检查 | typecheck、认证 HTTP、shellcheck 通过；`audit-dividend-v12.log` 为生产依赖零已报告漏洞；不替代镜像/生产运行安全验收 |

HTTP 构建标识为 `zsylCE98VErz5CO_yavMh`，schema 12，开始于
`2026-09-12T03:07:10.027Z`，结束于 `2026-09-12T03:07:12.667Z`。
282 项源文件哈希运行前后及随后复核一致。manifest SHA-256 为
`f3c2e8693e75440934469a206e92b1ba0d705eff03e72ce6e570cd8d67b4f9df`。
首次 HTTP 候选在移除默认计划后暴露旧 funding 预期，已修复测试并整套重跑；失败工件
`2026-09-12T03-05-16-389Z` 留档，不算通过证据。

新增 [分红实施边界](dividends-and-corporate-actions.md)：未知/暂估税不是零税；累计税额认定不是实际现金扣款；最终净额可仅归因不完整；公司行动核实不是自动复杂核算。期间未决事项不能被完整端点掩盖，晚补录不能作为当期利润，未来于准备时点的行情不能因延迟持久化而被采用。CSV 重复识别也不能把未知税归并为已确认零税。

公开代码与通用示例的边界已确认并落到工作树：个人方案原件本地隔离，公开模板保留原需求编号，新建组合无默认资金计划，历史本地计划不改写。旧暂存区尚未更新，提交前仍须对最终 index 重新检查；当前没有 commit/push 或生产切换。

**未闭环**：真实券商/税务依据、复杂公司行动自动核算、CSV 新类型原生模板、长期大量事件的区间质量吞吐（现最坏 O(n²)）、完整 UI/无障碍、v12 镜像及异机恢复、全部产品与 E/S 门槛和生产签核。

## 10. v13 私有标的目录：本次同版证据

| 范围 | 结果与工件 |
|---|---|
| Web | 315/315；`artifacts/verification/final-regression/web-catalog-v13.log` |
| Python | 244/244，35.086 秒；`python-catalog-v13.log`；含 17 项持仓重叠、五组跨语言 golden 与通用资金基准 |
| Node 契约/迁移/恢复 | 63/63；`node-catalog-v13-final.log`；新增 v12 到 v13 的五项迁移校验 |
| HTTP50 | `artifacts/verification/workbench-http/2026-09-12T12-23-57-265Z/{report.md,manifest.json}`；50/50，新增 `CAT01..05` |
| 构建与工具 | build `CVIVVyLIjP7cDu6zR1jU5`；typecheck、认证 HTTP、shellcheck 通过；生产依赖审计零已报告漏洞 |
| 原生浏览器 | `artifacts/verification/browser-catalog/report.md`；仅目录加入、已提交丢响应的相同请求重试、来源保存得到确认；后续流程未完成，无新视觉通过声明 |

HTTP50 开始 `2026-09-12T12:23:57.265Z`，结束 `2026-09-12T12:24:00.321Z`，schema 13。
304 项源文件前后及随后核对一致，manifest SHA-256：
`1c4bb87d80c25bdb6a64dcc655fa924c10a6071f10202cf627b028f0e4373640`。
首次 root Node/HTTP 使用了缺少 `jsonschema` 的解释器而失败；保留失败日志，正确指定两个 Python 环境变量后整套重跑，不把首次失败计为通过。

目录资料与账户私有原件、全局证券身份、政策、现金和持仓隔离。公开来源记录仅为人工提交的结构化 JSON，不代表发行商原件认证。标签不作为加权风控暴露，未知费率与持仓缺口不填零；异日期比较只针对对应历史向量。既有风险路径中活动买预留所用证券资料现纳入输入 hash，有定向回归。

浏览器运行时消失后未重放不确定操作。原 fixture 的只读快照证明目录 revision 3、经济 revision 0、两条目录记录和一个来源，无 profile/holdings 版本。开发服务健康请求超时且有高 CPU/异常报告栈；保留样本后停止该测试进程树，没有据此归因生产故障。资料发布/比较、分页修复、切换隔离与不确定请求 guard 的完整原生、窄屏、无障碍验收仍待继续。

隐私复查发现旧长窗口 fixture 仍与个人金额组合相同，已备份本地并改为无关合成数值，实际重跑 benchmark 与公开 multi90 基线；不改写旧 oracle、短样本或冒充旧运行时间。提交前仍须清理并检查旧暂存区。**P-05、全 E/S、镜像/异机恢复、真实数据与生产上线仍未完成。**

## 11. 公开代码检查点：暂存区与构建复核

本节更新上文历史记录中的“旧暂存区待检查”状态：已本地备份并完整刷新 index，
复核 365 个暂存文件、3,048,056 bytes，与工作树逐字节一致；未跟踪非忽略文件
和受保护数据路径均为零。旧个人计划绑定已移除，本轮未发现真实秘密、个人账户/
券商信息或个人绝对路径。随后追加的通用发布说明另行复核；检查范围及长期规则见
[公开与本地资料规则](publication-privacy.md)，不将文本扫描表述为绝对保证。

Docker 现排除根及嵌套 `.private`。路径边界回归已加入 Node 套件，最新 64/64；
全量 npm audit 为零已报告漏洞。新的生产构建 HTTP 50/50、schema 13，build
`_IFKKZvXTDE0gEl0OZ8sk`，304 项源文件运行前后及随后复核一致。工件目录
`artifacts/verification/workbench-http/2026-09-12T12-36-41-073Z/`，manifest SHA-256：
`bc05b00fe6099f0181117beddc1c5ee21b53fba6d0255ae5439ff0c4dd22e91a`。
应用代码未改变，Web 315/315、Python 244/244 仍对应上述基线；本地 Node 25.7.0
不能代替 CI 的 Linux/Node 22 及当前镜像验证。

本节是提交前证据，实际 commit/push/CI 结果以 Git 和工作流记录为准。普通 push
不触发生产发布。原生目录验收、未完成产品能力、最终镜像/异机恢复、真实数据、
全部 E/S/G 和生产签核仍保留未完成状态。

## 12. CSV 可视化映射：历史 v13 同版证据

| 范围 | 结果与工件 |
|---|---|
| Web | 371/371；`artifacts/verification/final-regression/web-csv-wizard-private-safe.log`；新增 inspector、响应校验、纯映射 builder、确认状态及真实服务链 56 项 |
| Python | 244/244，40.029 秒；`python-csv-wizard-private-safe.log`；F-02 使用重新构造的合成金额，预期入金损益仍为零 |
| Node | 73/73；`node-csv-wizard-final.log`；资金计划不能变成事实的迁移样例同步使用无关合成预算 |
| HTTP57 / build | `artifacts/verification/workbench-http/2026-09-12T13-52-56-430Z/{report.md,manifest.json}`；新增 `INS01..07` 并扩展恢复只读检查，57/57 |
| 其他 | typecheck、认证 HTTP、shellcheck 通过，全量 npm audit 零已报告漏洞 |
| 原生界面 | 本次没有通过声明：Tabbit 运行时不可用，重启许可尚待用户回复；没有使用其他浏览器绕过，也没有把 API/纯状态测试冒充完整交互验收 |

最终生产构建为 `4XqxSRMTtJj6a_l4Pj0c-`，schema 13；运行时间
`2026-09-12T13:52:56.430Z` 至 `2026-09-12T13:53:12.686Z`。
320 项源文件前后及随后复核一致，manifest SHA-256：
`656e1800ea88946016b27be6be3127abbefcabde7f55b1ec2657ea35cad52b4f`。
同日较早两次向导 HTTP 运行保留，不改写为本次源码结果。

检查认证/同源校验先于请求体，沿用原 parser 限额；候选不自动选语义，完整原值分页
与截断样本分开。客户端完整响应校验与本地 SHA-256 绑定后才应用映射，fee/tax
保持明确输入，失败预览也锁定映射版本。真实服务测试从零写检查经过版本 fork、
逐行人工决定、原子确认到原件/回执追溯；没有新券商认证、自动交易或收益承诺。

未决确认在同范围 revision 变化后保留原载荷；核对服务器状态确认成功后保留审计。
普通链接/整页刷新有离页提示，但 Next.js 同文档后退/前进未保证提示及持久恢复，
页面明确告知这一边界。原生桌面/窄屏/无障碍、真实券商样本、1 万行后台导入与
确认性能、全部 E/S/G 和生产签核仍未闭环。

本轮再次审查公开集合，替换旧 F-01/F-02、HTTP 和迁移计划样例中的关联现金数值，
保留本地旧原件并重跑。上节提交前文本扫描不是绝对保证；当前替换不撤回已公开的
Git 历史或旧 CI 工件，本轮未重写历史。个人规划和真实账户资料仍不进入新提交。

## 13. CSV 确认恢复与会话隔离：v14 同版证据

| 范围 | 本轮结果 |
|---|---|
| Web | 438/438；`artifacts/verification/final-regression/web-csv-recovery-v14-final.log`；含原请求服务/GET、响应完整性、实际组件 callback、会话与 Portal 边界 |
| Python | 244/244；`python-csv-recovery-v14.log`；合成财务/市场/研究/Worker 回归 |
| Node | 81/81；`node-csv-recovery-v14-all.log`；新增 v13 到 v14 的八项迁移约束与旧数据保持检查 |
| 构建与 HTTP | build `3fnrZ4DRzdltM29QC7Z8V`；schema 14；63/63，新增 `HTTP-REC01..06` |
| 其他 | `typecheck-csv-recovery-v14-final.log`、`auth-http-csv-recovery-v14.log`、`shellcheck-csv-recovery-v14.log` 通过；`audit-csv-recovery-v14.log` 为零已报告漏洞 |
| 原生与发布 | 未新增通过声明；Tabbit 运行时不可用，未擅自重启或切换浏览器。当前结果不是最终镜像、异机恢复或生产部署 |

HTTP 工件为 `artifacts/verification/workbench-http/2026-09-12T14-40-42-218Z/{manifest.json,report.md}`，
运行 `2026-09-12T14:40:42.218Z` 至 `2026-09-12T14:40:59.874Z`。
340 项源码在前后及随后核对一致；manifest SHA-256：
`c10b1f76475525d7ef839824d20f5158ac0f36662a87877cffd928e001c72628`。
首次 `2026-09-12T14-39-48-063Z` 运行因 Next 合并 `Vary` 响应头的过严等值断言失败，
改为明确要求 `Cookie` token 后从干净库重建重跑；旧失败工件未删除。

新 HTTP 覆盖丢弃成功响应正文后经 GET 恢复原 UTF-8/BOM/空白/字段序与真实 receipts、
同原文单尝试/单事实、失败 review 留痕且显式更正生成新尝试、同 owner 不同 SID
隔离、陈旧会话绑定拒绝且零写、只读恢复及严格分页/查询。服务测试补充容量预算、
不可变证据/篡改拒绝及详情才核验正文的边界。确认仍经原幂等/CAS/来源去重引擎。

组件 callback 测试曾实际复现恢复后账户刷新未完成就解锁的窗口，修复后由 RED 转 GREEN；
另覆盖迟到失败不复活会话数据、无自动 POST、显式重试原字节及 401 清理。
受保护 Radix Portal 改为边界内真实 container，未验证或 container 未就绪不回退 body；
SSR/实际 wrapper 测试通过，但不是原生弹窗、BFCache 或可访问性验收。

本轮没有公开个人原件或把真实资金/账户放入默认值。上述本地结果不自行证明新提交的
远程 CI 或生产发布；实际 SHA、镜像和工作流必须另行绑定。P-02、完整 ACC/E/S/G、
真实券商数据、1 万行后台导入、异机恢复及生产签核仍保持未完整验收。

## 14. 明确授权的月度目标评估：v15 本地候选证据

| 范围 | 本轮结果 |
|---|---|
| Web | 498/498，零跳过；含 15 项实际 Python 发现/领取到 Node 发布器测试，以及 3 项固定 bundle 子进程测试 |
| Python | 284/284；首次运行暴露新增测试的随机队列顺序假设，修复合成 job 的持久化时序后重跑；业务调度规则未改，失败日志保留 |
| Node | 95/95；包括 v15 不可变调度/周期/尝试迁移，以及新容器运行证明格式的拒绝测试 |
| 构建与 HTTP | build `YppVpXF8n7Vgh5sOLLvJI`，schema 15，67/67；新增 `HTTP-EV01..04`，366 项源文件前后及随后复核一致 |
| 其他 | 类型检查、认证 HTTP 与 shellcheck 通过，全量 npm audit 为零已报告漏洞；当前镜像、精确提交 CI、原生界面与生产发布不从本地结果推定 |

日志前缀为 `artifacts/verification/final-regression/monthly-evaluation-v15-release-`；
Python 通过日志为 `python-retry.log`，首次失败为 `python.log`。
HTTP 工件：`artifacts/verification/workbench-http/2026-09-12T16-00-40-270Z/`；
manifest SHA-256：`393a9dc59b39f024e437b5300b84d7f92796f73823869bf66e058895c3cbbc94`。

本切片要求保存调度绑定明确 identity、精确版本和原 UTF-8 哈希回执；客户端异步
核验后再次检查会话/组合/只读边界，没有自动 POST。月度周期保留原知识时点，
迟到撤销/自然过期不能抹掉当时待处理活动；全部 NAV 分项价格/FX 向量必须匹配，
账户、能力和门槛资料不能来自未来。无需调整仍需完整差异与全组合风控证据。

固定 CLI 使用真实时钟的历史 fixture 如实记录截止期阻断；它证明跨语言原子完成，
不证明过期周期有权建议交易。真实 proposed/unchanged 另有受控时间的发布器正例。
HTTP 新例主要证明鉴权、严格输入、空默认、全库逻辑零写和恢复边界，不能冒充
正向策略准入。容器 fixture 新增 Python 固定路径到 Node 22/native SQLite 的实际
非特权拒绝证明，但仍待本提交 Linux CI 执行；本地 Docker daemon 不可用。

Tabbit 仍返回 `BROWSER_RUNTIME_UNAVAILABLE`，没有新增原生桌面/窄屏/键盘/BFCache
通过声明。E-18 继续 BLOCKED：显式目标比较不等于完整轮动算法、真实数据/日历、
持续前向模拟或实盘有效性。个人方案仅存本地；未授权任何策略启用、交易或生产切换。

## 15. 月度轮动研究：v2 本地候选证据

| 范围 | 本轮结果 |
|---|---|
| Web | 513/513，零跳过；新增真实 Request 到 Python 研究链路与只读资金/费用/阻断摘要测试；其认证 seam 替身不冒充网络认证 |
| Python | 358/358，40.495 秒；含 39 项执行、24 项精确信号、7 项 v2 语义契约及 4 项实现绑定回归；旧 v1 报告/oracle 保持通过 |
| Node | 96/96；共享 Ajv v1/v2 严格版本契约与既有迁移/恢复/部署回归 |
| 构建与 HTTP | 新构建 `Acaofnbv1hbjSYFc-1Mn7`，schema 15，69/69；新增 `HTTP-R01/R02` 为真实 Cookie/会话绑定网络请求到 Python Worker，不是测试替身 |
| 其他 | 类型检查、认证 HTTP 与 shellcheck 通过；全量 npm audit 为零已报告漏洞；原生界面、远程 CI/镜像及生产不由本地结果推定 |

HTTP 工件：`artifacts/verification/workbench-http/2026-09-12T16-51-33-968Z/`；
运行 `2026-09-12T16:51:33.968Z` 至 `16:51:52.432Z`，378 项源文件前后及随后
复核一致；manifest SHA-256：
`1dc9b7b5a2aef16565c793268153a4b432f917aa9b0ba928d01bc0c342e2213b`。
日志位于 `artifacts/verification/final-regression/`，前缀 `rotation-v2`；最终
Python 为 `rotation-v2-final-python.log`，HTTP 为 `rotation-v2-final-http.log`。

首轮 HTTP 工件 `2026-09-12T16-50-08-351Z` 真实通过 R01，但 R02 的测试 helper
误将语义失败任务预期为 CLI exit 0。只修断言为规范 exit 2，仍要求真实 job、
attempt、错误码及零财务写入；从干净库重新构建、重跑后通过。原失败工件保留。

v2 显式冻结 MOM/MA、总回报口径、候选池、仓位槽、容差和交收日历；精确有理数
排名不用浮点近似判同分。月初首个声明决策独占周期，阻断不偷偷利用新数据重试。
实际模拟买卖、股票交收、卖款应收及到账有独立事件，卖款到账前不能用于依赖买单，
价格上涨不能事后重算原数量。拆分和除息期间的理论价格保留原价/行动证据，不伪装
真实报价或计入买入前收益。费用、滑点、FX 和现金舍入单列，研究不写真实账本。

R01 核对 18 张实际组合/账本/治理表完整行哈希不变；R02 对版本混用、伪造字段和
会话拒绝入队，对结构合法但金额无效的输入保留真实 failed job。实现改变的专项
测试在 prepare/persist 两阶段证明全库零变化；完成报告保留原字节/哈希/事件。

当前只是 E-18/E-28 相关研究与执行子路径，不将 E-18 或 S-01..S-10 改为完整通过。
`actual_replay` 不是实时形成的前向历史；三个窗口仍独立起步；排名单函数性能记录
不代表完整多年研究、存储、后台任务负载验收。真实数据/日历与许可、连续前向模拟、
实际调度接入、可信验证 Worker、原生桌面/窄屏/键盘、异机恢复及生产发布仍未闭环。
个人方案和账户资料继续仅在本地，所有公开数值为通用合成示例。

### 首次公开提交的 CI 差异

公开提交 `d6ac32ba330ab80b57b40dcbafdbfc84837086e1` 的 CI `34706708278`
总体失败：Python 358 项与隔离容器 job 通过，Web 512/513；后续 Node、构建、
HTTP 和 audit 未执行。失败为原月度界面测试的 `request 4`：固定四次事件循环
刷新不能保证真实 WebCrypto 已完成，而测试先于 POST 入队注入了响应。
需要通过实际请求/哈希完成信号修正等待，保留错误回执拒绝和未决原文保护；新提交
的完整 CI 必须另外核验。本地 69 项通过或容器单项成功不能覆盖该失败状态。

跟进只修改测试 harness 与证据文档：明确保留真实哈希 Promise，用事件驱动等待
请求入队，不再从固定 tick 数推测 POST 已发出；错误 hash 和版本分别验证拒绝、
原文保留、确认清除及单次 POST。受控延迟已 RED 复现，定向 16 项与组件 25 轮
通过；本地全 Web 514/514、类型检查及新构建 HTTP 69/69 通过。
新 HTTP 工件 `artifacts/verification/workbench-http/2026-09-12T17-06-35-118Z/`，
build `sEkIoKGmHirFndk_aAYTy`，schema 15，378 项源码前后及随后一致；manifest
SHA-256 `d3a65f80d902076b8e97c88a23759f07e0584d9c764ff92f3c2e9ef9769dd186`。
日志前缀为 `rotation-v2-ci-followup`；没有业务放宽、跳过坏回执检查或新增策略准入。
下一准确提交的远程 CI 结果仍须另行核对，旧失败不改写。

<a id="price-collection-v17"></a>

## 16. 人审引用与价格采集：v17 工作区边界

### 已公开 v16 的独立后续证据

提交 `926dc4ce4912b7cd8768d315a398d43d8ed51fc0`、tree
`9d45a68699d007b76f60e562fc7322c034ed71ad` 的
[CI 34710911980](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/34710911980)
已成功。该版本 Python 443、Web 524、根目录 Node 107、HTTP 72，以及 Linux core
镜像迁移/健康检查/本地加密恢复通过。容器 run `20260912T182101Z-2244` 实际使用
schema 16、Node v22.23.2、UID 10001，加载 native SQLite 后拒坏 lease 且全库逻辑不变；
16 个迁移 checksum 和固定 bundle hash 与同提交对应。

本地完整证据位于 `artifacts/verification/github-ci/34710911980/`，包含
`provider-v16-ci.log` 及下载的 container JSON。恢复保持人工复审标记、废除旧会话，
重复目标拒绝覆盖；`independent_host_restore=false`。这个镜像不含 LongPort native SDK；
合成适配器测试不证明真实 SDK 权限、行情覆盖或新 v17 provider 镜像。没有生产切换。

### v17 实现与定向验证，不外推全量通过

| 子路径 | 当前实现 / 已执行定向检查 | 未证边界 |
|---|---|---|
| 引用 | `market_reference_sources/versions/heads`，严格 JSON 原文、组合隔离、审核人/输入/结果/hash 绑定、连续版本 CAS；审核级别仅 `human_reviewed_not_provider_verified` | 权威来源、供应商背书、账户或策略批准不能由上传/审核推导 |
| 请求与采集 | 同组合/市场 1–4 catalog listing、最多 31 自然日、明确映射/日历版本；SDK projection → 有界 BLOB → 原子批次/发布/任务；独立 Python/Web 重放 | 未验证 ETF asset_class、供应商真实 ticker 身份或生命周期；没有本轮真实 A/HK/US 许可/数据验收；日期 close_at 不变成 published_at |
| 时序 | 当前资料更新阻断当前使用，历史按冻结知识时点保留；缺/重复/多余/未来 bar 拒绝，未知发布时间保持未知 | 未完整验收真实历史修订、休市/半日市、PIT 档案或周期采集 |
| 迁移 | `node --test tests/migrations/*.test.mjs`：69/69，其中新 v17 11 项；旧 v16 全表值及 ECB BLOB 字节保持、重复迁移零写、SDK/ECB 不能互冒充 | 不是完整 v17 工作区回归或镜像升级验收 |
| 运行隔离 | `provider-container.test.mjs`：8/8；含实际 CLI 前置配置拒绝、角色隔离、跨连接/组合 mutex、kernel deadline、strict report gate；其调用的 Python 8 项不重复累计 | Docker 配置与脚本审查不是实际容器；本轮 optional image 仍待 exact-SHA Linux CI |
| 公开边界 | `release.test.mjs`：17/17；3 种凭据 basename 的 Git 实际排除、Docker 递归规则及模板不误屏蔽，日期化通用文档 | 不是未来任何路径/工件的秘密扫描保证；提交前仍核实际 index |

API/UI 入口为 `/api/workbench/market`、`/workbench/market` 和原有 `enqueue_task` 的
`market_collect_prices`。核心 Worker 不装 SDK、不派发/领取价格任务；独立 provider
role 使用专属凭据、非 root Trixie 镜像、固定 CPython 3.11 wheel hashes，lease 最少
180 秒/默认 300 秒、同库价格互斥和 30 秒子进程内核截止。可选 Compose 未自动加入
生产部署脚本。测试和源码入口详见 [价格采集边界](market-price-collection.md)。

冻结源码本地回归：Python **488/488**、Web **559/559**、根目录 Node **127/127**，
无失败或跳过；类型、构建、认证 HTTP、shellcheck、依赖检查通过，npm audit 为 0。
完整 HTTP **77/77**，schema 17、build `xen1hgaLxyanVXxYT9nph`；425 项源码运行前后
及随后核对一致。工件为 `artifacts/verification/workbench-http/2026-09-12T19-25-41-402Z/`，
manifest SHA-256 `ad9b146d6343fae4875e5223a3f36c589f12f2a037e2b15fc4c63d31ffddd713`。
HTTP-MP01..05 覆盖人审资料、两标的一次合成捕获、独立消费验真、失败原子性及
引用修订；不会因此授予实际行情或投资准入。完整范围与失败前置记录见 [07](07-implementation-tracker.md#price-collection-worktree-v17)。

尚无新提交绑定的 Linux core/provider 镜像或生产结果。原生浏览器诊断仍为
`BROWSER_RUNTIME_UNAVAILABLE`，未擅自重启，不能以 10 项组件 callback 替代原生验收。
未决请求仅保存在页面内存；离页警告不是持久恢复，也不能阻止所有强制关闭。
真实许可/价格/权威引用、recurrence、完整原生 UI、独立恢复、上线以及 D/G/S 门槛
仍未完成；E-09/10/12 等保持 BLOCKED，E-11 等仍 NOT_RUN。个人方案、私人 provider
凭据和真实网络证据不得进入公开源码、镜像或 CI 上传的 `artifacts/verification/`。

### 后续 CI 失败与报告修正检查点

已公开提交 `1bb5b76bb1dabbf9de880b5247868186a4b42897` 的
[CI 34714360107](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/34714360107)
整体失败：test job 和 schema 17 core 镜像迁移/本地恢复通过；provider 镜像已构建并
加载真实 SDK，但报告错误读取无文件的 PyO3 `openapi.__file__`。provider JSON 为
0 字节，不能视为通过；完整日志及两份工件保留在
`artifacts/verification/github-ci/34714360107/`。这一后续结果不改写上文的历史时点。

仅修正 smoke helper 与测试：绑定实际 `longport.longport` 原生扩展的对象身份、
loader 和文件/origin 后再取二进制 hash，严格报告门槛不变。真实本地 SDK helper
检查和三个错误绑定负例通过，未构造 QuoteContext、未用凭据或访问行情。
根目录 Node **128/128**、shellcheck 通过；未改应用构建的 HTTP 再次 **77/77**，
425 项源码保持一致。新工件为 `artifacts/verification/workbench-http/2026-09-12T19-44-28-183Z/`，
manifest SHA-256 `05833f18f1520d873191bbf0080a0367993c3d70b2cff138ba8b438ecd604e4b`。
修正提交仍须新的全量 CI 与 Linux provider 报告，不据本地检查宣布镜像或生产通过。

### 后续镜像通过，HTTP 传输检查仍未闭环

提交 `7fcf136ae4ad894a3b07a479e1be446140ce0687` 的
[CI 34715193188](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/34715193188)
已通过 core/provider 两种 Linux 镜像检查，真实 SDK 原生二进制及 adapter 绑定通过；
报告明确无凭据、无网络、未构造 QuoteContext，不能升级为真实行情许可或数据验收。
Python 488、Web 559、根目录 Node 128 通过；HTTP 46 项通过后，`HTTP-INS03` 的
`fetch failed` 导致整次 CI 失败，audit 未运行。425 项源首尾及提交 blob 一致。
完整日志、原始 ZIP、GitHub metadata 与校验结果在
`artifacts/verification/github-ci/34715193188/`，不改写上一次失败报告。

旧日志未记录具体网络 cause 或 header/body 阶段。合成 Node 22 实验可复现多种
相同症状，不能据此断言原 CI 的唯一原因。三个分块超限探针改为 `node:http`：
无 Content-Length、keep-alive、只写限制加一字节且不结束请求，必须得到完整
413、精确 JSON 错误和服务端 close；reset、半截响应或超时仍失败，不重试。
另补安全的请求阶段和错误码诊断；不修改服务端限流或取消逻辑。此测试变更仍须
新回归与同版 CI，生产、真实资料和完整投资准入仍未验收。

本地最终修正候选：根目录 Node **148/148**、HTTP **77/77**；20 项独立 loopback
传输测试在 Node 25.7.0 和 22.22.0 均通过，含审查补入的重复/转义键拒绝，不等同
CI 运行环境。应用代码未改、沿用原构建。最终工件为
`artifacts/verification/workbench-http/2026-09-12T20-07-03-623Z/manifest.json`，
SHA-256 `32b77e6ac139e18324d9459b20a79ca64438ba54628bc427d1a106314c6137d0`；
427 项源码首尾及随后核验一致。原候选及失败日志保留；新提交仍须同版 CI。

## 17. 显式周期参考汇率采集 v18

实现入口为 `/workbench/market/schedules`、市场 API、`worker/orchestration/collections.py`
与迁移 0018，完整边界见 [周期采集说明](market-collection-schedules.md)。新组合无默认
调度；人工保存必为暂停，人工启用后才发现全局 scope/date 槽位。错过窗口仅留
missed 记录，不用今日 daily feed 冒充历史观察。每次控制结束旧授权；原 key 的
完全相同命令才幂等返回，更换 CAS 不能套用旧回执。

下载前后、原子发布前及 job 成功终态前均重新核授权、lease、截止与恢复锁；
旧 publication CAS 不自动重基。跨截止的最终提交会完整回滚，后续暂停不撤销
合法历史捕获。SQL/Python/Web 拒绝 system 身份冒充人工，审计字段和字符串语义
一致；1024 control 的最后一次只保留给从 enabled 到 paused，耗尽需维护。

- 最终本地 Python **525/525**、Web **598/598**、根目录 Node **165/165**，无失败/跳过；
  类型、生产构建、认证 HTTP、shellcheck 与依赖审计通过，漏洞报告为 0。
- HTTP **81/81**，schema 18、build `BoaC-frR1nw0aU3kBfgp3`，446 项源码首尾及随后
  核对一致。`HTTP-SC01..04` 真实等待 UTC 触发，经独立合成 Worker 与实际暂停 API
  验证一次成功发布、另一在途结果拒绝、恢复启用不重放和双端历史验真；账本事实不变。
- 工件：`artifacts/verification/workbench-http/2026-09-12T21-02-02-761Z/manifest.json`；
  SHA-256 `fcf2571d1e48d8c256982ad38461aeddcb0024b10a633c8f01a669de86bc208d`。
  首次 HTTP 用错误预期测试 CAS 0；修正为 400，并另测合法错配 CAS 的 409 后重跑，
  原失败工件保留，未放宽业务约束。其他审查修订与 RED/GREEN 证据见 [07 记录](07-implementation-tracker.md#daily-collection-schedules-worktree-v18)。
- 原生 Tabbit 仍无法连接（exit 69），未重启、未冒称原生交互通过。新同提交 CI/镜像、
  真实资料、部署节奏、通知传输、全负载与异机恢复仍需独立证据；本次没有生产切换。

以上仅市场采集子路径的工程检查，不升级原 P/ACC/E/S 全部门槛，不取得投资批准
或盈利证明。个人方案、真实账户/供应商原件与凭据仍不得进入公开源、镜像或 CI 工件。

## 18. 私有证券身份与交易规格审核 v19

正常登记、加入组合目录、保存原件、人工审核版本现在可经公开服务/API 连成完整
路径。输入绑定当前 identity hash、组合私有 source hash 和 review CAS；回执可
独立重算，历史原件与审计不可覆盖。未知、过期、停牌、非 ETF、杠杆/反向或不完整
规格不能回退到旧版全局标记。人工审核不等于发行人/供应商认证、账户权限或策略
准入，也不是成分股权重穿透。详见 [身份审核说明](listing-identity-reviews.md)。

- 最终本地 Python **553/553**、Web **657/657**、根目录 Node **176/176**，无失败或
  跳过；类型、生产构建、认证 HTTP、shellcheck 与完整 npm audit 通过，漏洞为 0。
- HTTP **84/84**，schema 19、build `84JnvqtajOFVmJ_on4c97`，465 项源码首尾及随后
  核验一致。`HTTP-LR01..03` 实际走认证 HTTP：普通登记到私有人审、不改全局批准或
  账本；错误会话/身份/CAS/私有来源拒绝；新停牌版本使旧资格失效，恢复锁仍可读
  历史且不可写。所有原件和账户均为合成测试材料。
- 工件：`artifacts/verification/workbench-http/2026-09-12T22-12-44-065Z/manifest.json`；
  SHA-256 `743d023d10b08af5229636cdff37bde52bcffcef38029eae3f56b636f3d28e53`。
  风控定向回归另覆盖 SDK `PRICE:<listing_id>` 消费、合法非固定 series 名称、冲突
  同刻观察、未来一微秒拒绝和审核变更/到期使旧批准失效；缺失流动性仍然阻断。
- Tabbit 当前诊断仍是 `BROWSER_RUNTIME_UNAVAILABLE`，没有原生浏览器验收、生产
  切换或真实供应商数据验证。组件 callback 不替代桌面/移动端、无障碍或 BFCache。

P/ACC/E/S 原范围保持不变。实际权威资料、合法流动性输入、完整穿透、投资准入、
同提交 Linux 镜像、异机恢复及生产发布仍需各自证据，不能据此将未决门槛改为通过。

### v19 同提交 CI 与后续原生问题修复

`2244c7779e7faee0a4ef7cf08fd228ffbcf55c95` 的
[CI 34733804426](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/34733804426)
已终态通过：Python 553、Web 657、Node 176、HTTP 84，两种 Linux 镜像为 schema 19；
465 个 HTTP 源码 hash 与准确提交一致，日志、GitHub metadata 及两个 ZIP digest 已核验。
这关闭该提交的工程 CI/镜像项，不关闭真实数据、投资准入、异机恢复或生产门槛。

浏览器服务后来恢复。合成 schema-19 开发 fixture 原生基线 **10 PASS / 1 FAIL**，
实际发布三个人审版本，并验证历史、组合隔离、只读和退出后返回。失败是 390px 下
长阻断码溢出；额外 200 字符名称及 40 字符代码/交易所也复现同类问题。布局补丁后
同 fixture 原生复测 390/1440 均无页面溢出，内容完整换行；新增 callback 防回退
测试先 RED 后 GREEN，定向 **13/13**。原失败记录未改写成通过。

证据在 `artifacts/verification/browser-listing-v19/verification-result.json`，
SHA-256 `7e80c0e399d55b10a8f8369bd3fe164ad9ed7e0bf5d1b862f669c416c4402f34`；
七张截图均已查看，最终合成库完整性正常、外键异常 0、账本事件 0，fixture 已停止。
该复测不是 schema-20、生产构建、跨标签在途会话竞态、键盘/读屏或 BFCache 完整验收。
上述 CI 早于布局和周期知识边界修复，修复后的源码仍需新的完整回归与提交绑定。

## 19. 原周期证券审核知识边界 v20

正常服务和真实 Python discovery/claim 到 Node publisher 的定向复现发现：周期创建后
写入与知识截止恰好同时间戳的新审核，能进入第一次准备或重新准备。既有批准仍报
`APPROVAL_STALE`，prepare/commit 间的变化仍报 `EVALUATION_INPUT_CHANGED`；原缺口
在于后一次调用没有持久化的原周期审核版本上界，不能据这两个旧保护宣称已经覆盖。

0020 为审核建立不可覆盖的事务序列，在周期 INSERT 同事务冻结组合水位；月度消费
同时限制知识时间与序列，并重核当前版本，包含零目标和重试。同一时间戳但先于周期
创建的合法资料仍可用，后写版本不可吸入；不以一律拒绝同刻资料替代正常闭环。
旧周期只记 `legacy_missing`、保留原历史，不伪造其水位。新输入及风险 hash 绑定原
边界，普通审核历史查询和实际批准的语义不变。

这仅修复证券审核的周期知识边界，不能代表全部输入的 PIT、完整 E/S、真实行情、
投资准入或生产发布通过。独立审查及冻结源码本地回归已通过：Python **553/553**、
Web **675/675**、根目录 Node **188/188**，无失败/跳过；类型、生产构建、认证 HTTP、
shellcheck 和完整 npm audit 通过，漏洞为 0。新迁移 12 项、边界 12 项、风险分支 5 项
及布局防回退已包含在总数中，不重复累计。风险分支实际包含已记账/对账/估值的在途、
普通持仓、正常批准产生的买入预留和跨组合/伪造边界，不将零持仓测试外推到这些路径。

HTTP **84/84**、schema 20、build `bGn--Ekiglyo7VgG4U0oW`，470 个源码 hash 首尾及随后
一致；工件为 `artifacts/verification/workbench-http/2026-09-13T03-20-05-384Z/manifest.json`，
SHA-256 `260027271abeebeec9b0d6fb2d2b7bbfd40f8bbdfe863bc5870a72855c198858`。
新建 schema-20 原生开发 fixture 另有 **5/5 PASS**，验证 UI 发布、刷新精确历史、390px
布局和退出隔离，并核自动审核 sequence、账本事件 0、完整性正常。证据在
`artifacts/verification/browser-listing-v20/verification-result.json`，SHA-256
`5e31e4ed9e063300f238e727f3f908c4300fc131e1499d7df0559b941a99a5bf`，fixture 已停止。
此原生 smoke 没有周期，不能替代周期逻辑、BFCache、键盘/读屏或生产构建验收。
v20 同提交 CI/镜像、全部发布和投资门槛仍需独立证据，本轮没有生产切换。

## 20. 受控合成工程检查 v21

已实现[受控验收链](controlled-verification.md)：人类会话请求、当前源码上下文、
专用 verifier 租约、真实 Node 账本与 Python 估值/绩效、不可变原件和独立 TS 复核。
SQLite 迁移 21 保留旧 1-20 字节；部署脚本能发现并停止旧版实际存在的 writer，
包含新 verifier 的启动、失败停止、健康与无网络检查，不假定 v20 已存在此服务。

固定检查只验证现金追加不能冒充盈利，并诚实保留 Modified Dietz 估计质量；
`gate_eligible=false`、`completed_requirements=[]`。本节**不升级任何完整 E、S、
G 或生产验收状态**，不使用用户实际资金/券商，也不创建真实账本事实或下单。

2026-09-25 本地冻结源码回归：Python **590/590**、Web **743/743**、Node **214/214**，
无失败/跳过；最后一项包含显式开启的测试服务生命周期检查，不是原生 UI。
类型、生产构建、认证 HTTP、shellcheck 通过，npm audit 报告 0 个漏洞。
12 类协调篡改在 Python/TS 两侧使用相同字节复核；错误收益实际终止为 fail，
孤立 surrogate/异常控制符不会留下无法执行的请求，篡改 dedup 回执不能转向别的请求。

真实生产构建 HTTP **91/91**，schema 21，build `ltJVTfkb8Ibq8-2AK22a0`；509 个源码
hash 首尾一致。工件：`artifacts/verification/workbench-http/2026-09-24T17-22-03-354Z/manifest.json`，
SHA-256 `26f06913221c130d9dd3d64e49933e0ba7c91679aad81a97b00aa3fec5372cd5`。
新 VF01-07 覆盖正常请求/真实 CLI/独立 proof、原件 SHA、跨作用域/会话、幂等和恢复只读。
最终日志以 `verification-v21-hardened` 为前缀，保留先前失败及修复记录，不拿旧计数替代。

上述发布前本地检查点中，原生浏览器因 `BROWSER_RUNTIME_UNAVAILABLE` 为 **NOT_RUN**；本地 Docker daemon 不可用，
没有本地容器 PASS。精确提交 CI/镜像、完整产品验收、真实数据/策略和生产切换仍需证据。
个人规划原件继续留在被 Git 与 Docker 排除的本地目录，八份保留基线 SHA 校验全部一致。

### v21 已发布提交的 CI 与获准重启后的原生检查

`6fd08ae73574bfcb9d6971ea8262a39ca85ebb69` 的
[CI 36034497147](https://github.com/tripplemay/ai-downstream-observatory/actions/runs/36034497147)
两项 job 均终态成功：Python 590、Web 743、HTTP 91；Node 为 213 通过、1 项默认未开启
的生命周期测试跳过，不能把本地显式开启后的 214/214 混称为 CI 结果。509 项 HTTP
源码均逐字节 hash 匹配该提交；两个原始 ZIP 匹配 GitHub digest，下载原件经本地
Python/TS 独立复核。容器实际执行固定 verifier，200 项源码清单、bundle、sidecar 与
本地一致。Provider 原生 smoke 不含联网、凭证或实际 quote context；同机加密恢复
不等于异机恢复。工件：`artifacts/verification/github-ci/36034497147/verification-result.json`。

用户明确允许后只重启一次 Tabbit，恢复了原生验收能力。全新合成 schema-21 fixture
实际经 UI 建立空组合、显式提交一次检查、得到真实 Worker 结果，并检查 A-B-A 隔离、
390px 布局、恢复只读与跨标签退出清空/401。普通和只读浏览器网络原件均与 SQLite
BLOB 的 17,678 字节及 SHA 一致；工具不支持下载事件和下载管理页，因此不声称验证
了 OS 保存对话框或下载管理器。另行标明的 DOM-only 长 ID 仅是布局压力测试。

冻结版本发现一项同值导航缺陷：重复选择当前组合会清空页面和重试草稿，而 effect
依赖未变，不会重新读取；手动刷新可恢复，未增加 POST 或跨组合披露。该失败保留，
不得用后续正常 A-B-A 通过覆盖。证据在
`artifacts/verification/browser-verification-v21/6fd08ae-native-restart1/`；测试进程、目录、
端口和任务标签均清理，用户原标签保留。后续修复须有独立回归证据。

后续最小修复按完整 `(portfolio, requestId)` 元组做同值早退。新增 3 项 callback
回归先复现 2 失败，再全部通过，并保留详情返回两条路径。全新原生 fixture 复验
确认同值事件保留草稿、确认和已核数据，GET/POST 数均不增加；真实提交/完成、详情
按钮返回与重选组合返回、A-B-A、只读、跨标签退出均通过。没有再次重启浏览器，
fixture 已清理。原生增量证据：
`artifacts/verification/browser-verification-v21/6fd08ae-scope-guard-rerun1/`。
503 未决请求原字节和幂等键保留仅有 callback 回归，不冒充原生网络故障测试。

修复后的本地 Python **590/590**、Web **746/746**、Node **214/214**（原生清理后显式
开启 lifecycle）、类型、生产构建、认证 HTTP、
shellcheck 与零漏洞 audit 通过；生产构建 HTTP **91/91**、build
`O39kAIKakMvv1G3N-z0ME`，509 项源码首尾及随后核验一致。工件：
`artifacts/verification/workbench-http/2026-09-24T17-54-10-331Z/manifest.json`。
组件 SHA 为 `cd616026a6b1ce492635a51469a57d6464383f6e1f8909238b7e722dc1390d47`；
固定 verifier 的 200 项源码 hash 未变，但不据此宣称它覆盖 UI 或整版发布。
上述已发布 CI 早于修复，不替代新提交的 CI。
原生增量正式记录为 **11 PASS / 1 NOT_VERIFIED**，未验证项为 OS 下载保存完成。

仓库仍缺 `VPS_SSH_HOST_KEY` 和受保护的 production Environment；未读取 secret 值、
连接服务器或发起部署。本节不升级完整 P/ACC/E/S、真实数据、投资准入或生产门槛。
