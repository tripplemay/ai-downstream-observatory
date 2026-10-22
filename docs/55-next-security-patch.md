# Next.js 安全补丁与发布门禁

2026-10-23 的 CI 依赖审计命中 Next.js 两项公告，业务 HTTP 回归通过不代表可以忽略依赖安全失败。

- [图片优化接口上游内存漏洞](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw)：官方列出受影响版本与 `15.5.28` 修复版，并提供 `sharp >= 0.35.5` 的缓解方式。工程原已覆盖该 sharp 版本，但不能据此忽略其他 Next.js 漏洞。
- [App Router / Server Actions 拒绝服务](https://github.com/vercel/next.js/security/advisories/GHSA-p3m5-59mp-jv5r)：官方要求升级；认证代码自身的正常回归不构成框架解析层漏洞已修复的证明。

本次仅将 Next.js 精确依赖从 `15.5.27` 升至 `15.5.28`，用包管理器更新同版本环境包、全部平台编译器与完整性摘要。保留现有 React、sharp、PostCSS 等依赖和覆盖项，不运行 `npm audit fix --force`，不跨主版本升级，不关闭或降级 CI 审计。

`tests/deployment/framework-security.test.mjs` 防止已知受影响范围、锁文件/编译器错配、sharp 缓解版本退回或忽略审计失败。该静态合同不能替代每次新鲜审计、实际构建、认证/HTTP 回归、Linux 镜像和精确提交 CI。

这是独立于产品增量的框架修复，不修改账户事实、研究策略、风险门槛、迁移或任何交易权限。合并不是生产部署；发布仍须当前容量检查、备份恢复、正常审批和外网验收。未经实际发布与核验，不能宣称生产已完成安全升级。
