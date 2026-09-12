# 生产交付工具链验证记录

记录日期：2026-09-12（操作者本地日期）。本轮仅实现工具和隔离验证，**未部署、未提交、未 push、未停止旧生产**。

## 已执行

| 检查 | 结果 / 边界 |
| --- | --- |
| `node --test tests/deployment/*.test.mjs` | 10/10；旧单主题/多主题/模拟账户、WAL 与无 SHM、原件加密往返、迟到恢复锁、默认 plan-only、secret 初始化、Compose 约束 |
| `node --test tests/migrations/*.test.mjs tests/recovery/*.test.mjs` | 26 项通过；新库幂等、迁移 checksum、旧库保护、恢复不覆盖新事实等；与发布 fixture 合跑 36/36 |
| `shellcheck scripts/deploy-workbench.sh tests/deployment/container-smoke.sh` | 通过 |
| `actionlint .github/workflows/ci.yml .github/workflows/deploy.yml` | 通过；未触发 GitHub 真实发布工作流 |
| Compose `--profile tools config --no-env-resolution` | 通过；未解析/打印生产 secret |
| 本机 Docker | Colima daemon 调用挂起，旧构建 EOF；未重启或清理用户 daemon |

CI、Docker 和脚本的运行证据不替代账本业务全量测试；最终 Web/Python 合并版本由主任务另行统一复跑。

## 远端隔离构建

经主任务明确批准，只在 `/opt/workbench-validation/20260912-2340` 构建，不修改 `/opt/observatory`。白名单源码打包，不包含 data/config/.env/node_modules/.next/.git。旧生产初始检查：RAM available 4206 MiB，磁盘可用 58 GiB，load 0.29/0.50/0.60，旧 Web 72 MiB / worker 5 MiB，loopback HTTP 200。构建采用 `COMPOSE_PARALLEL_LIMIT=1`。

| 制品 | SHA256 |
| --- | --- |
| 原始 `source.tar.gz` | `d81fc473958d1b0ca3aefc4272e16aba85427c0069e2abfe9b52436d6168fbe4` |
| 修复 `patch2.tar.gz` | `cdbda541fe681b65f0e4371d965958db90c63976013f1c11a2c526ebade4e531` |

原始快照的 Web/worker Docker 构建通过；首次容器工具测试发现 **只读挂载的冷 WAL 旧库无法创建 SHM**，归档明确失败，没有忽略数据或退回空库。修复使用显式 quiesced 私有副本恢复，然后 Online Backup，新增本地覆盖。初次失败日志 `container-build.log` 保留。

`source-patched` = 原始源码 + patch2；重试日志 `container-retry.log`。重试 **exit 0**，run ID `20260911T214826Z-228959`，通过：非 root、schema v7 空库迁移、冷 WAL 归档且新增真实事实 0、加密备份/全新目录恢复/重复恢复拒绝、Web 和 worker healthy、未认证 API 401。临时容器、网络和测试数据由 trap 清理。

| 镜像 | 不可变 image ID |
| --- | --- |
| Web | `sha256:00f6e3ef3fe3f1e0f2ad774485de8db051a460caff82f2e19a63d7292c31984f` |
| Worker | `sha256:e1e894ed441c87223332ce1e5325bec7cb9c86409c480baf1f7b4ce0b952bf85` |

生产后检：loopback HTTP 200；旧 web `6cb3aec669fa`、worker `7d66259e3b5a` 仍为原容器，StartedAt 仍为 `2026-08-24T16:08:18Z`，没有重启。RAM available 4242 MiB、磁盘可用 54 GiB。保留隔离验证镜像和源码，未清理其他项目资源。

结果在远端 `source-patched/artifacts/verification/container-20260911T214826Z-228959.json`，本地副本在 `artifacts/verification/release/`。此次镜像只验证该确定快照的容器布局与工具链，**不是仍在开发的最终提交**；后续纯发布脚本的停写复核与额外 fixture 在本地测试，不冒充该镜像内容。

## v8 完整源码隔离复验

本节取代上面 v7 记录作为当前容器交付依据；v7 和失败记录保留，不覆盖。最终源码包含恢复锁复核、UTF-8 密码限制以及 Web builder 的 `COPY scripts/ /app/scripts/`，没有跳过类型检查。

- 第一次 v8 构建在 `/opt/workbench-validation/20260912-v8-2312` 失败：`web/tests/governance-fixture.ts` 无法解析 builder 中缺失的迁移脚本。尚未执行迁移/恢复/启动；退出码 1。源码包 hash 为 `31ace9e0be5731c2264d5fdffcecc5e5c454fe7d0ed307c5f00f9e0dfe98eb46`，本地失败日志及生产前后状态保存在 `artifacts/verification/release/v8-20260912-2312/`。
- 补齐 builder 输入后，重新打包完整 257 个白名单文件，上传后逐文件校验。重试目录 `/opt/workbench-validation/20260912-v8-2316`，run ID `20260911T231619Z-427243`，`COMPOSE_PARALLEL_LIMIT=1 bash tests/deployment/container-smoke.sh` **exit 0**。
- 验证通过：非 root UID/GID 10001、schema **v8** 空库迁移、归档未生成实际事件、加密备份和全新目录恢复、重复恢复拒绝、Web/worker healthy、未认证 `/api/workbench` **401**。小型合成 fixture 恢复用时 **352 ms**。测试容器、网络和临时数据已由 trap 清理。

| 制品 | SHA256 / image ID |
| --- | --- |
| 最终 `source.tar.gz` | `f4d87546bc6b7c088275bd44c1bedb30b60cf4e8b94f84472d8c85681fe394b8` |
| 257 文件 `source-manifest.json` | `c7116ae166d12f48f8b2e82f953e3164f0115d463cabfd10861a74584c02c87f` |
| Web image | `sha256:f7d36ae71e4fa3efad25beaf30f46ad90969b4b737f77b29fddc87416d5c1b11` |
| Worker image | `sha256:eb8679934607f31922a2116a92b6929e371dc2bf5c069f5bb10a02397bf859f3` |

本地证据目录：`artifacts/verification/release/v8-20260912-2316/`。保留完整构建日志、源码 manifest、容器结果与生产前后状态；这是明确源码快照，不代表已经 commit、push 或切换生产。后续本页更新只补验证记录。

## 真实旧生产数据库副本演练

经另行明确批准，使用上述最终 Web 镜像，仅将正在运行的 `/opt/observatory/data` **只读挂载**，通过 SQLite Online Backup 获取一致副本，未复制主文件绕过 WAL，未对原库设置 quiesced，未停止旧进程。原库/WAL/SHM 均已核验为运行容器实际挂载中的常规文件。

Online Backup 时间区间为 **2026-09-11 23:23:15.015–23:23:16.826 UTC**；这表示工具捕获一致快照的区间，不把运行中的源文件散列冒充快照标识。副本为 **110,592,000 字节**。随后只对受控副本归一化 journal 为 DELETE，再由正式归档工具执行第二次 Online Backup，归档到独立 v8 新库。

核验覆盖所有 **17 张用户表、812,776 行**，逐表 schema hash、逐行 `source_key` / 序列化 SQLite 类型值 / 内容 hash 与计数全部一致；包括旧模拟账户的数据，但这些数据仅进入 legacy 归档。新库及恢复库的 `portfolios`、`accounts`、`ledger_heads`、`ledger_events`、`postings`、`position_movements` 均为 **0**。

| 制品 | 大小 / SHA256 |
| --- | --- |
| 第一份 Online Backup，经受控副本 journal 归一化 | 110,592,000 字节；`65d8dd178bcb4118a55f8c847b334bde428c5ba115015a7452a8a0989841fdfe` |
| 第二次 Online Backup 的原 SQLite 归档附件 | `854f3345fb1463225760933722df84086ca3a7a9b39b07acdb70d572e5ac4340` |
| 独立 v8 归档数据库 | 822,104,064 字节 |
| 加密备份包 | 932,701,236 字节；`628ddaace7a236483c09d6f1f04bb83637f042be1a9a8d210385432b0380930e` |
| 恢复后的原 SQLite 附件 | 重算 hash 为 `854f3345fb1463225760933722df84086ca3a7a9b39b07acdb70d572e5ac4340`，与归档附件一致 |

两份 SQLite 文件 hash 不同对应上述副本 journal 归一化与第二次 Online Backup 转换链；**不声称它们与运行中源物理文件逐字节相同**。逐表 schema/行内容/hash 比对是逻辑一致证据，归档附件与恢复附件的 `854f...` hash 相同才是该附件的恢复字节证据。

恢复后 schema v8、`quick_check`、外键检查、完整 legacy 行计数及附件重算 hash 均通过；同一目标重复恢复明确拒绝，`RESTORE_PENDING_REVIEW` 存在，新会话 secret 文件为 0600，未应用到任何运行环境。未导入实际投资资金或券商账户。

演练限制为 **1 CPU / 1 GiB / 900 秒超时**，实际完成 **379.483 秒**。阶段区间来自工具时间戳和结果文件时间戳，包含相邻完整性检查，不是独立性能基准：

| 阶段 | 秒 |
| --- | ---: |
| 原库 Online Backup | 1.811 |
| 私有副本准备及空库迁移 | 5.897 |
| 完整旧表归档 | 83.184 |
| 全部行对照及备份准备 | 74.028 |
| 新库 Online Backup | 9.293 |
| 附件校验及加密打包 | 68.125 |
| 恢复工具报告耗时 | 76.384 |
| 恢复后额外核验 | 60.762 |

真实副本、归档库、加密包与密钥仅保存在远端 `.../20260912-v8-2316/real-legacy-rehearsal/`，目录 0700、密钥和原件 0600，占约 2,880 MiB；没有下载真实原件到工作区。只下载聚合 `aggregate-result.json`、`phase-timings.json` 与健康记录，保存在上述本地证据目录。

最终生产后检 **2026-09-11 23:31:18 UTC**：HTTP **200**，旧 Web/worker 容器 ID、image hash、`2026-08-24T16:08:18Z` 启动时间和旧源码 HEAD `f38d244d7b050a113e34da74d1d79bd466f7ef1b` 均未变化。可用 RAM 3767 MiB、磁盘可用 49 GiB；演练容器已退出并删除，未清理其他项目资源。

这是单一真实旧库副本案例，不等同切换尾差重放、真实新账本对账、200 万行情目标负载测试，亦不认定生产 RPO/RTO。

## 尚未闭环

- 真实旧库副本归档/恢复演练已完成；**真实切换、停写后的最终尾差捕获、实际新账本券商对账与人工批准尚未执行**。
- 异机备份目的地、独立密钥取得、自动备份/告警/保留计划、模拟主机丢失后的恢复。
- **RPO ≤15 分钟、RTO ≤2 小时未测量、未验收**。同机第二目录和一次远端 fixture 都不是实际异机灾难恢复证明。
- 发布配置已只读检查、尚未配置：仓库 secrets 仅有 `VPS_HOST` / `VPS_PATH` / `VPS_SSH_KEY` / `VPS_USER`，缺 `VPS_SSH_HOST_KEY`；GitHub environments `total_count=0`，未设 `production` 环境审批；主机 `/etc/etf-workbench` 及所需三份配置文件、发布 `current` 和 `data-workbench` 均不存在。不能把工具可运行等同实际发布授权或配置就绪。
- 磁盘满/强制断电、达到设计数据规模的性能、恢复后备份尾差重放与真实券商对账，不由本工具冒烟测试覆盖。
- 本节指定源码已完成 v8 容器复验；后续源码或发布提交变化需重新 CI/构建/HTTP 回归。策略参数、真实行情资格、L3 建议和投资收益有效性另按验收门槛执行。
