# 风险候选与长期经济结果的显示期限

状态：2026-10-11 UTC，显示期限修复及后续类型修正仍未发布。新冻结基线的 459 项限定回归、构建前后完整 `tsc` 及本地 Next 生产构建通过；仅修正 HTTP 测试后，认证 HTTP 26/26 通过。桌面与 390px 的实际 Chromium 嵌套组件/图表合成 DOM 专项 8/8 通过。原同源分段 443 项、OOM、类型错误和 HTTP 失败均保留；不是全工程、完整 v2、真实策略或生产验收。

本文下方计数与构建认证各自记录的冻结字节。后续完整 Next 页面验证和首页信息重排见[总览聚焦](33-overview-clarity.md)；本次重排后的组件另建基线，不沿用这里的 459 项、旧构建或独立组件 DOM 结果认证新首页。

## 用户看到的变化

- 风险来源到期时，仅隐藏候选的历史回撤与角色冲击；通用损失算术、未确认风险状态和明确选择入口保留，不替你选预算。
- 长期比较到期时，旧配置、净资产、盈亏与成本汇总同时隐藏，不把旧结果当作当前比较。核对仍由人工点击发起 GET，没有自动重算或新建研究。
- 完整窗口曲线独立遵守比较版本的期限。即使父面板没有刷新，到期也隐藏结果、取消在途读取并锁住旧比较的读取入口，提示刷新工作台。
- 时钟回拨、隐藏页恢复和仅在渲染时出现的前跳都不能使已经失效的结果复活。原始研究与历史观察不改写。

## 时钟、迟到响应和会话边界

共享 `useInvestorDisplayTime` 保留相同的 SSR/首次客户端 `checked_at` 基线，并提供 `readNow()`。点击与响应解析时直接推进已有墙钟/经过时长的上界，不能依赖最近一次渲染留下的时点。`useInvestorDisplayClock` 保留原数值接口，既有工作台/采集展示继续复用。

首轮专项发现：比较请求尚未返回时，页面还没有 `valid_until`，因而可能没有到期定时器。如果此时经过期限又回拨墙钟，仅用显示 ref 和 `Date.now()` 会把迟到结果交给解析器。新实现直接读取经过时长，首次 AI 响应同样处理；异步曲线哈希核验结束后还会再次检查期限。

比较/曲线面板独立处理会话失效、在途取消和旧身份响应；旧 401 不得清空新绑定的有效结果。旧按钮回调不能在新身份、锁定或已失效期限下启动读取。AI 的缓存生成回调也检查最新身份与 disabled 状态，不能因旧闭包发出额外 POST。

这是保守本地显示规则，不是可信系统时间、后台已完成、市场新鲜度或提供方用途认证。服务端 owner、当前版本、有效来源、会话和期限检查继续独立执行。AI 外发范围仍仅为 `model_ratios`、`target_deviation`、`strategy_trigger_codes`；本轮真实行情/网关调用为零。

## 测试与失败记录

- 原时钟 6、当前投影 4、工作台 5；AI 增至 9；新增经济面板 10，共 34 个事件/hook 用例。
- 使用实际编译的组件、共享时钟和严格客户端解析器；经济与风险资料是人工构造的严格合同及小型算术轨迹，不是已许可、持久登记的真实策略生产者。
- 此事件/hook 阶段未执行曲线结果子组件、图表/ResizeObserver、设计系统和 DOM。后续八例实际 Chromium 专项见下文；两类证据不混同，也不升级为完整工作台或人工原生验收。
- 首轮 27/32：三处 React default/Fragment 替身问题、一处在 loading 后取旧按钮的测试取样问题、一处真实首次迟到响应时间检查遗漏。修正 harness/取样和生产时钟后，增加两例 AI 边界，34/34 通过；原断言未放宽。
- 证据：`artifacts/verification/economic-display-expiry/2026-10-11/development-events.log`、`development-result.json`、`development-corrected-events.log`。本地开发专项不是冻结发布证明。

首轮宽回归 `artifacts/verification/planned-funding-monitor/2026-10-11T03-52-38-131Z` 保留失败：五个 worker 和 Python 23 通过，下一 Web 阶段 TAP 记录 12/12、约 965 ms，但外层得到 `ETIMEDOUT`，墙钟约 939 秒。对应系统记录为 03:52:37 UTC 空闲休眠，04:08:17 UTC 恢复，约 940 秒。以 `sleep-correlation.json` 保留关联证据，不把失败改成通过，也不推定应用性能超时根因已经完全排除。

重跑仅添加本次自有进程的 `caffeinate -i -s` 保护，原每阶段 300 秒上限和断言不变。验证器每阶段开始检查系统盘至少 2 GiB 可用；这不是阶段内资源看门狗。旧 [22 项及系统盘停止记录](31-current-display-expiry.md)也完整保留，不与新的测试重复累加。

## 冻结源码的分段补验

- 第二轮 `artifacts/verification/planned-funding-monitor/2026-10-11T05-43-31-172Z/` 记录的前 33 阶段通过，但本次外层编排的 20 分钟上限在最后的恢复测试阶段终止父进程。外层随后删除临时目录，影响了尚未结束的子进程；原恢复日志为 10/34 通过、24 项失败，主要记录临时路径缺失。该轮没有原始最终摘要，不能称为完整成功，也不能覆盖失败日志。
- 独立补验先核对原阶段进程已退出，并在新临时目录执行相同恢复/发布脚本测试，34/34 通过；结束后先终止本次自有进程组再删除临时目录。没有重放已成功的业务阶段来掩盖编排失误。
- 前后 **975** 个来源哈希一致，合并范围为 **34** 个阶段：Python **73**、Web **167**、迁移 **169**、恢复/发布脚本 **34**，共 **443** 项。34 个组件事件已包含在 Web 167 内，不重复相加。**45** 项迁移 checksum、原后台/worker/合同/SQL/manifest 字节保持原基线。
- 证据为 `artifacts/verification/economic-display-expiry/2026-10-11/frozen-continuation/verification-summary.json`；状态严格为 `SCOPED_FROZEN_SOURCE_SPLIT_VERIFICATION_PASS_NOT_SINGLE_RUN_NOT_RELEASE`，`single_uninterrupted_regression_pass=false`。这是同源分段限定验收，不是全工程、完整单次回归、容器或生产资格。

## 历史构建失败与后续门槛

随后独立尝试全量 `tsc --noEmit --incremental false`，使用 768 MiB heap、原 300 秒单阶段上限。日志确认 `Allocation failed - JavaScript heap out of memory`；外层返回 `ETIMEDOUT` / `SIGTERM`，墙钟约 1397 秒。系统休眠记录与该时段重叠，不能把墙钟耗时当作连续 CPU 计算或据此认证性能。失败保留在 `typecheck.log` 与 `build-verification.json`；Next 构建和构建后类型检查均未执行，没有 HTTP/原生验收。构建临时目录已清理，没有注入私人运行配置。

当时系统盘已恢复至约 16 GiB 可用，但交换内存仍显著占用，没有盲目提高堆上限或放宽断言重试。后续先检查实际内存压力和限定导入依赖，资源预检满足后才执行下文的受保护全量检查；不以新的成功覆盖本段失败。

只读配置诊断枚举 **581** 个根文件，约 5.13 MB：src 317、tests 174、scripts 20、`.next` 57、`.next-fixture` 10 和三份配置/声明。没有创建编译 Program 或枚举导入依赖，也没有删去测试/生成类型来换取类型检查通过；这不是内存根因定位或语义验收。证据 `typecheck-scope-diagnostic.json`。

## 原分段基线的静态后检

`postflight.json` 核对同源分段证据、相对前次基线的八个修改/两个新增来源、原后台/worker/合同/SQL/迁移清单不变、三个 worker manifest 与产物匹配，以及四份文档的本地链接。选定公开候选中的四个当前配置凭据字面量零命中；仓库外私有根保持 0700、五份既有文件 0600，现有用户同意仍限三类派生证据且本地受众绑定/期限匹配。这里只扫描选定当前字面量，不是完整历史隐私审计，也不认证生产主体或提供方用途。原阶段进程均已退出，后检没有真实行情/网关调用、私人方案写入或生产变更。

## 后续完整语义检查与新冻结基线

先以未改的编译选项检查五个显示组件及导入依赖，570 个编译文件零诊断；再检查两个事件测试入口及依赖，722 个文件暴露 `acquisition.ts` 的固定字段摘要参数类型错误。显式传递已通过原运行时合同核验的字段，不加 `any`、不跳过原封闭校验；事件入口随后零诊断通过。

系统内存压力查询满足预检，才将完整检查的 Node heap 设为 1024 MiB，同时保留全部配置/测试，新增 1280 MiB 自有进程 RSS、系统内存/10 GiB 磁盘保护及 120 秒墙钟上限。完整 `tsc --noEmit --incremental false --extendedDiagnostics --pretty false` 实际检查 1522 个编译文件、约 918 MB 编译内存，先明确报告另外三个错误，而不是 OOM：

- 通知已读时点的 `unknown` 比较：分开核对原空账户字段，解析时点为局部 string，并复用同一已校验值；保留过去/未来时点及绑定限制。
- 确认行情收据测试的未知 bindings：增加真实数组断言后访问原字段，不删去收据核对。
- 当前显示测试把 v2 判别联合扩成不合法的 live 模式：显式确认该 fixture 为原 v1，再测试原允许模式，不用强制断言伪造 v2 合同。

修正后完整 `tsc` 零诊断、退出 0，墙钟约 6.35 秒；原一次探针路径/清理编排失败、局部诊断失败、全量三个错误及最初 OOM 均保留。经济面板的既有第十例同时实际加入未知字段拒绝，纠正原标题与测试内容不一致；用例数量仍为 34，不放宽原断言。

该阶段只修改两个服务文件和三个测试文件。`type-fix-final/source-before.json` 冻结新 975 文件；原 443 项分段证据不拿来认证修改后的源码。没有对个人方案、策略、合同/迁移、用户许可或生产进行修改。

## 新基线的限定回归与生产构建

- 新临时库从头完成原验证器的 34 个串行阶段，443 项全部通过；没有外层提前删除 fixture，原每阶段 300 秒上限保留。再验证通知已读 7 项、三地确认收据 9 项，共 **459** 项：Python 73、Web 183、迁移 169、恢复/发布脚本 34。组件 34 已包含，不重复相加；不是全工程回归。
- `artifacts/verification/planned-funding-monitor/2026-10-11T12-31-50-746Z/verification-summary.json` 保留完整单次宽回归；额外 16 项和前后 975 文件哈希见 `type-fix-final/regression-summary.json`。45 项迁移 checksum、旧合同/worker/SQL 保持不变，五个 worker 重建。
- 实际默认 `next build` 通过，约 24.1 秒，build ID `3WOk19kjqgBuqZhtqCFog`。未改编译配置，未打开构建禁用的数据库，未注入私有凭据；Next 正常更新忽略的生成声明。自有进程组最高 RSS 约 1.39 GiB，系统可用内存最低 34%；资源保护未触发。这不是压力、容器或生产性能证明。
- 构建前后完整 `tsc --noEmit --incremental false --extendedDiagnostics --pretty false` 均退出 0、零诊断，约 6.35 / 6.79 秒；全部原配置与测试保留。证据为 `semantic-full-2026-10-11T12-28-21.735Z/runner-summary.json`、`semantic-full-2026-10-11T12-57-21.427Z/runner-summary.json` 及 `type-fix-final/next-build-summary.json`。

## 投入计划的认证 HTTP 验证

首轮实际生产构建、认证 API 和新临时库验证为 **22 通过 / 1 失败**，停止于 HTTP-I16，不是此前的 HTTP-I15。旧测试要求保存资金计划后 `latest` 与 `model_watch` 全对象不变，和默认 core 已实现的“当前绑定改变即失效”相冲突。原失败见 `workbench-http/2026-10-11T12-59-01-203Z/manifest.json`。

只修改 `web/scripts/investor-http-cases.mjs` 的断言：保持 profile、plan、research task 核对，新增逐表比较 12 个研究/监测/决定表的原始行及载荷；要求当前观察 `insufficient_evidence`、`MONITOR_FUNDING_PLAN_CHANGED`、旧 NAV 隐藏、模型/输入/检查点身份不变，旧建议采纳返回 400 且不推进 revision。不修改产品逻辑来保留过时建议。

同一个构建、新临时库重跑认证 HTTP **26/26** 通过，包含投入计划保存、精确重试、SSR、偏好变化、比较登记与来源撤回。新冻结 975 文件期间无变化。证据 `http-funding-followup/summary.json` 与 `workbench-http/2026-10-11T13-08-14-327Z/manifest.json`。相对于 459 项及构建基线唯一源码差异是该 HTTP 测试文件；原 459 项没有再次重跑，不把两个清单伪称完全相同。两份 HTTP 都是本地 loopback/虚构凭据和资料，不验证外网 TLS 或生产。

## 实际 Chromium 嵌套 DOM 专项

使用实际风险、长期比较、嵌套分析、SVG 图表、ResizeObserver 和设计系统组件，加载本次 Next 构建的 CSS；不是前述组件替身。测试工装在独立静态页挂载组件，严格资料由既有合成 fixture 生成，GET 由 Playwright 拦截，禁止非本机请求及任何 POST。它没有经过完整 Next 路由、登录和工作台容器。

桌面 **1440px** 与手机 **390px** 各四例，共 **8/8**：

- 实际完整嵌套读取、三种曲线、有限坐标、ResizeObserver 自适应、键盘滑块和资金路径切换；精确到期隐藏风险候选与全部经济结果，回拨/唤醒不复活，通用损失算术和未知预算保留。
- 独立分析组件在没有父级刷新时到期，旧曲线隐藏且读取入口禁用。
- 在途曲线到期后 Chromium 记录 `net::ERR_ABORTED`，迟到回复和回拨不恢复结果。
- 会话失效或 scope 锁定清除嵌套结果；只有显式 GET，无隐式计算、预算命令或交易。

证据 `browser-dom-fixed/verification.json`、`browser-metafile.json` 和桌面/手机到期前后截图；实际检查截图可见栅格、图表和失效提示，无横向溢出、pageerror 或外部请求。首次生成工装的 ESM 名称冲突及目录重用错误保留于 `browser-dom/failed-build.json`，均发生在浏览器执行前；没有通过修改产品代码解决。此处不是人工批准、完整可用性、无障碍、真实生产者或真实策略验收。

完整 P0/P1/P2、真实三地资料/用途及连续监测、留存/恢复、Linux Node 22、完整样式与原生界面、精确 SHA/CI/审批、生产和外网业务验收仍按 [v2 追踪](v2-implementation-progress.md)分别留证；此文不宣称目标完成或已经上线。
