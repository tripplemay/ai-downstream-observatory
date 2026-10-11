# 年度投入观察的 AI 解释与失效

状态：2026-10-09，新资金默认 core 与独立 AI 后台的六项专项及冻结限定宽回归通过。当前只验证虚构资料与注入的模拟传输，不是生产 sidecar、真实网关、认证 HTTP 或原生界面验收。后续的[当前显示期限修复](31-current-display-expiry.md)独立追踪；本页旧失败工件不改记通过，仍不能发布为完整 P1。

## 连接到原有解释路径

[年度计划监测](29-planned-funding-core-monitor.md)的请求 v2 / 引擎 v4 / 检查点 v3 使用原有 `prepareInvestorAiExplanation` 和独立后台路径，不另建可以绕过资格的资金解释接口。Node 先独立重放当前确定性结论、历史来源和检查点；再只建立既有封闭 `ai-monitor-context-v1`。旧参考定义与低频定义都需通过同样检查。

外发仍只允许用户确认的 `model_ratios`、`target_deviation`、`strategy_trigger_codes`。本轮覆盖的证据是既有最大目标偏离、目标变化数量、可计算的估算成本比例及策略原因码，不新增资金计划字段。计划金额、日期、ID、绑定哈希、风险答案、持仓、账户和原行情不进入 context；原计划在本地重放，不作为 AI 输入。上下文截止时间是监测评估时点，不冒充资金到账时间。

原研究与当前监测资料的 `external_ai` 用途必须分别有效；用户的三类共享同意不能替代这些来源权利。虚构 fixture 中明确的权限仅用于软件测试，不认证香港行情使用、长期留存或生产主体。

## 一次显式请求，不是每轮自动调用

- 投资者明确请求才登记 AI 意图。GET、再次读取、关闭页面、后台正常复核或新的资金批次不会自动计费生成。
- 冷 Node 进程读取现有意图、重新核对来源/同意/版本，再领取独立外发登记。完成结果可被另一冷进程读取，重复后台轮次不重发。
- 新观察需要新的明确请求；即使正文或派生比例相同，也不能沿用旧观察的请求绑定。
- 模拟 AI 故意返回与确定性“需要决策”不同的 `maintain_research`，后台仍保持原决定、单位/现金、观察、模型、计划和 outbox；AI 不代替投资者采纳、批准或执行。

资金未到期并不保证其他规则不触发调整。最终日志确认旧参考 v1 在容差内“继续观察”，低频 v2 则由 `CALENDAR_POLICY_REVIEW` 产生“需要决策”，两者均没有提前的新资金触发；不是资金提前到账。正确验证是 AI 与当前确定性结论一致，且到期前没有 `NEW_PLANNED_FUNDING`，而不是把所有未到期案例强制归为“继续观察”。

## 版本和日期边界

1. 在年度释放前排队的意图，其期限不晚于复核边界。到达边界但 core 尚未发布新结果，冷后台先清理旧意图，零外发；新结果出现后仍需重新明确请求。
2. 保存新版计划时，旧排队意图与已完成正文均由后台维护失效；没有浏览器读取也能清理正文。请求、结果或未知外发头保留，不把清理变成可自动重试。
3. 请求已开始，期间改计划，发布前的独立重核丢弃旧输出；不展示旧解释，也不更改确定性模型。一次未知结果不触发重复外发。
4. 缺任一原研究或监测 AI 用途，确定性新资金结论可以仍为“需要决策”，但 AI 必须单独阻断，零意图/外发；不能让 AI 许可反向决定策略结论。

测试入口为 `web/tests/investor-planned-funding-ai.test.ts`，复用真正的计划命令、虚构来源准入和默认 core；独立 `investor-ai-process-fixture.ts` 运行通用后台函数并注入模拟传输。Python 另验证封闭 context 的全部内容与摘要。它没有执行生产固定 CLI、隔离 HTTPS 网关或完整 Next/cookie 链路；这些验收继续保留。

## 前轮发现的界面缺陷与后续修复

- **已复现：过期 AI 正文在时钟回拨后复活。** `InvestorAiPanel` 的本地 `now` 每秒直接采用 `Date.now()`；旧 `result` 仍留在组件，时钟回拨使期限重新满足。受控 hook/event harness 加载实际组件与真实客户端校验，验证有效时可见、到期隐藏、回拨后再次出现；只有一次 GET、零 POST，没有网关请求。证据为 `artifacts/verification/planned-funding-monitor/2026-10-09T14-59-27-228Z/ui-stale-clock-probe.json`，状态明确为 `REPRODUCED_EXPIRED_AI_TEXT_REVIVAL_NOT_RELEASE`，不是通过。
- **源码确认，完整组件运行尚待补验：主结论/变化卡期限未统一。** `InvestorWorkspace` 的 `currentOutcome` 来自原 `data.effective_outcome`，`displayNow` 只应用到持续观察栏。因此断网或读取失败跨过已知复核期限时，观察栏可隐藏 NAV，但主结论与变化卡仍可能使用旧数据。不能用后台提交 fencing 证明这条显示路径已经正确。

以上描述对应本页 14:59 轮次的旧代码；该轮未修复，不是当前源码仍有相同缺陷的证明。后续已统一显示投影与不回退时钟、点击失效及历史边界，组件事件专项和冻结回归另见[显示期限记录](31-current-display-expiry.md)。完整 UI/HTTP、Linux Node 22、类型/Next、真实资料/用途、留存/恢复/性能、精确 SHA/CI/审批及生产外网验收仍开放。完整目标仍见 [v2 追踪](v2-implementation-progress.md)。

## 验证记录

首轮未冻结开发专项为 **5/6**，错误是测试把两代定义的未到期资金都等同于“继续观察”。修正为与真实确定性观察比较，增加未到期状态和无提前资金触发断言；未改变生产策略/AI 规则，也没有放宽数据资格。最终冻结诊断纠正最初的旧参考归因，实际是低频 v2 的日历复核触发。专项修正后的单例通过不替代全组资格。失败摘要为 `artifacts/verification/planned-funding-monitor/2026-10-09-planned-funding-ai-development-attempt.json`；完整初次输出仅在工具会话。

最终 **24** 个冻结串行阶段：选定 Python **73** / Web **100** / 迁移全量 **169** / 本地恢复与发布脚本 **34**，合计 **376** 个限定测试通过；本轮新增 **6** 个用例，内部循环不额外计数。**968** 个源码前后一致，五个 worker 重建，**45** 项迁移 checksum 一致，自有 fixture 删除。证据 `artifacts/verification/planned-funding-monitor/2026-10-09T14-59-27-228Z/verification-summary.json`，状态 `SCOPED_PLANNED_FUNDING_CORE_AI_PASS_NOT_RELEASE`；界面缺陷工件保持独立，不因后台测试通过升级成界面 PASS。

后检 `postflight.json` 通过：相对上轮仅验证器变化和一份新测试，原合同/SQL/完整 manifest 字节不变；三个带 manifest 的 worker 源码/产物匹配，新增 TS 语法诊断零，Python 73 个用例 ID 无重复，104 个本地文档文件链接存在。选定 **1042** 个公开文本候选对四个现有凭据字面量零命中，私有目录 0700/五文件 0600；范围与 audience 仍匹配，但生产主体和行情用途未因此批准。阶段进程均退出，工程外自有空临时根已删除。扫描不是完整隐私/历史审计，语法检查不是语义类型检查，已复现 UI 缺陷仍未修复。

复跑入口仍为 `scripts/verify-planned-funding-monitor.mjs --temporary-root /absolute/private/short-temp`，指定可信 `WORKBENCH_TEST_PYTHON`，Node heap 与每阶段 deadline 沿用原边界。本轮无真实市场/网关、用户私有规划修改、commit/push/SSH/部署，也不重试低磁盘环境中此前 OOM 的完整构建。完整 Web/Python 全集、类型/Next、原生/HTTP、真实资料与生产验收继续开放，恢复/发布脚本测试不是本次生产恢复或发布。
