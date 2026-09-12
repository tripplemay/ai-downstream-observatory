# 单用户认证实施与运维

状态：已实施；本地单元、生产构建与隔离 HTTP 回归通过。尚不代表生产部署或最终 E-23/E-24 全部验收通过。

## 配置

所有配置均为服务端变量，不使用 `NEXT_PUBLIC_` 前缀：

| 变量 | 要求 |
| --- | --- |
| `WORKBENCH_PASSWORD_HASH` | `npm --prefix web run auth:hash-password` 交互生成的 scrypt 摘要；密码至少 16 字符，不把原密码写入命令参数或仓库 |
| `WORKBENCH_SESSION_SECRET` | 独立生成、至少 32 字符的高熵秘密，通过部署秘密注入 |
| `WORKBENCH_ORIGIN` | 唯一外部访问 origin，例如 `https://portfolio.example.test`，不带路径；生产拒绝 HTTP |
| `WORKBENCH_DATA_DIR` | 持久数据目录绝对路径；认证状态写入其中的 `auth.sqlite` |

认证缺项或格式非法时拒绝登录与私有数据访问，不设置默认密码、不提供认证关闭开关。仅开发/测试环境允许 localhost 的 HTTP。反向代理应保留浏览器 Origin，不能用请求的 Host 或任意 `X-Forwarded-*` 动态决定可信 origin。TLS 在生产入口终止，应用仅绑定可信内网或回环地址。

密码生成命令默认隐藏输入；自动化必须显式使用 `--stdin`，标准输入应来自秘密管理器而非命令字面量。改变密码摘要、session 秘密或 origin 会使既有服务端 session 失效。秘密轮换后重启应用即可生效。

## 边界

- `iron-session` 密封 Cookie 仅携带随机 session ID 与到期时间；`auth.sqlite` 存 ID 摘要、配置版本和撤销状态。
- session 固定 8 小时，使用 `HttpOnly`、`Secure`、`SameSite=Strict`、`Path=/`；生产 Cookie 名使用 `__Host-` 前缀。退出不仅删除 Cookie，也服务端撤销，旧 Cookie 重放无效。
- 单用户全局持久限速：每 15 分钟最多 10 次登录尝试，拒绝时返回 429 与 Retry-After。不信任可伪造的代理 IP 头来分桶；公开服务仍需入口级流量、连接和慢请求限制。
- 页面/DAL 使用 `requireSession()`；JSON route 使用 `requireApiSession()`；Server Action/写 route 使用 `requireMutationSession()`，逐入口授权并检查 Origin。返回身份为 `{ userId: "owner", sessionId }`。
- 登录、退出均只支持 POST 并校验 Origin；登录请求体流式限制 4 KiB。无 GET 写操作。新增导出、下载或写入口不得仅依赖布局或导航隐藏。
- 根布局、登录页、工作台静态导航不读取旧研究数据库。旧查询统一通过已鉴权 facade，旧底层文件只可由 facade 引用。
- `/api/health` 是公开最小存活探针，仅返回 `{"status":"ok"}`，不代表依赖就绪、不返回账户或任务信息。
- `auth.sqlite` 与账本分开。恢复备份后必须轮换 session 秘密，防止恢复旧认证库后使曾撤销的 Cookie 再次有效。

## 验证

在仓库 `web` 目录执行：

```sh
npm ci
npm run test:auth
npm run typecheck
npm run build
npm run test:auth:http
npm run test:workbench:http
npm audit --audit-level=moderate
```

本轮证据（2026-09-12）：8 个认证单元测试通过，TypeScript 与生产构建通过，隔离 HTTP 回归通过，依赖审计 0 条漏洞。HTTP 回归自行启动生产构建、使用随机合成密码/秘密及临时目录，覆盖未配置拒绝、私有读取、直接 Action 请求、Origin 拒绝、登录、Cookie 属性、服务端退出撤销与过期，并断言整个过程未创建研究库或真实账本库。它不是浏览器 TLS/代理部署验证，也不覆盖后续新增入口的业务授权。

`test:workbench:http` 默认重新构建，并在临时迁移库上完整验证账户建档、预算不入账、真实流水、幂等、跨组合账户引用拒绝、导入预览/确认/陈旧预览刷新、买入与结算、并发 revision 冲突、API 错误脱敏与退出撤销。超大 chunked 请求在 5 MiB 限额处终止并关闭连接，后续合法请求仍须成功。每次运行生成 `artifacts/verification/workbench-http/<UTC时间>/manifest.json`、`report.md`、构建日志与脱敏服务器日志；manifest 记录构建 ID、源文件哈希和逐项结果。运行期间代码发生变化时标记 STALE，不能作为该新版本的发布证据。`--no-build` 只用于诊断已有构建，不替代最终重建验收。

浏览器走查使用 `npm run dev:fixture`：服务仅监听 `http://127.0.0.1:3147`，独立 `.next-fixture` 构建目录与系统临时目录账本。脚本中的公开固定密码仅用于合成夹具，session 秘密随机生成且不打印，不继承生产认证配置。必须使用上述完整 origin；Ctrl-C 停止后清除临时账本。此工具不得用于生产部署。

## 依赖与依据

固定 Next.js `15.5.25`，保留 15.x 维护分支；React/ReactDOM `19.1.9`，iron-session `9.0.1`。Next 的 2026 年 8 月公告给出的 15.x 修复下限为 `15.5.24`；安装时核验注册表与锁文件后选择同分支更高补丁。[Next.js 安全公告](https://nextjs.org/blog/august-2026-security-release)

服务端 DAL 与动作入口必须分别鉴权，不能以布局检查替代。[Next.js 15 认证文档](https://nextjs.org/docs/15/app/guides/authentication)

iron-session 本身的密封 Cookie 不负责服务端撤销，因此另存 session 状态并逐请求校验。[iron-session API 与撤销说明](https://github.com/vvo/iron-session)

现有 Next.js 15.x 的传递依赖另固定 `postcss 8.5.28`、`sharp 0.35.4` 与 `nanoid 3.3.19`，以消除安装时审计发现的问题；升级 Next 后仍需重新核验这些 overrides，而不是永久假定兼容或安全。
