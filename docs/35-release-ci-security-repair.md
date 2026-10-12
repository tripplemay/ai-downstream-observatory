# 发布验证与构建依赖修复

状态：2026-10-12 发布候选修复说明，不是生产切换或投资有效性通过报告。

## CI 完整性

旧 CI 将所有 Python、Web、合同、构建和 HTTP 测试串行放在一个 30 分钟任务中。
完整发现的 Python 用例现按模块分为 8 片；每片记录用例 ID、发现集合摘要、实际
源码提交和执行结果。保留类/模块 fixture 顺序，不缩减发现模式或断言。分片单测
及集合核对要求不重不漏。

Web 仍发现原 `tests/*.test.ts` 文件集合，按文件分为 8 片。片内串行运行文件，
避免 Node 自动并发再叠加 Python 子进程造成资源争抢；应用内部的并发/竞争场景
不改动，原子性断言与 fixture 超时均保留。每片先构建固定跨语言发布器，保留
完整 TAP 和文件集合收据。合同/恢复、类型/构建/HTTP/审计、Linux 容器另行运行。
所有任务仍受 30 分钟上限控制，生产工作流等待全部验证，不配置忽略失败。

SDK 接口用例依赖独立的 `requirements-market-longport.txt`。测试任务安装经过
hash 固定的 4.3.7 wheel，仅离线核对接口；不提供真实凭据、不取得行情权限，也
不启用生产 provider。修正过时的用例数量断言，并核对新增角色互斥场景确实执行。

## 依赖与样式

- Next.js 更新至 15.5.27，对应官方安全补丁；不改变账户/研究准入。
  [Next.js 公告](https://github.com/advisories/GHSA-4jqv-mc3x-m676)
- Sharp 更新至 0.35.5；固定修补版的 source-map-js、fast-uri 和 selector parser。
  [Sharp 公告](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)
- 旧 Tailwind 3 构建链包含尚无上游修复的 braces，改用 Tailwind 4.3.3 的 PostCSS
  构建链，移除原 watcher/glob 依赖链，不对 npm audit 设置豁免或只扫描生产依赖。
  [braces 公告](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
- 显式加载现有主题配置，保留当前语义色、已使用的旧调色板、阴影与透明焦点
  轮廓；调色板保留 MIT 许可。构建升级需另验桌面/手机、深浅主题、通知弹窗和
  键盘焦点，不把编译成功当成视觉批准。现代 CSS 浏览器能力是前提，老旧浏览器
  未在此轮声明支持。[迁移资料](https://tailwindcss.com/docs/upgrade-guide)

## 不改变的边界

不导入个人规划或合成样例到生产；不预置风险答案、现金或持仓，不自动交易。
真实来源、持续三地数据、策略资格、满载性能、持续异机备份及 RPO/RTO 仍需各自
验收。单次加密快照恢复、软件 CI 与技术上线不能替代上述证明。
