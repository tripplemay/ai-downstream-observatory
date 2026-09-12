# ETF 工作台受控发布手册

本文是操作流程，不是生产切换通过报告。发布工具不自动升级投资权限、不预置个人资金计划、不生成任何到账事实，也不接券商自动下单。

## 1. 目录、身份与秘密

目标 Linux 主机需要 Docker Engine、Compose **2.30+**、Node.js 22、Python 3、`flock`、`timeout`、`curl`。Compose 使用 `env_file.format: raw` 保留 scrypt 中的 `$`，不能换成会展开密码哈希的普通 env 插值。[Docker 服务配置](https://docs.docker.com/reference/compose-file/services/)

| 路径 | 用途 / 权限 |
| --- | --- |
| `/opt/observatory/data` | 原生产目录；只读归档来源，不改归属、不迁移为真实账本 |
| `/opt/observatory/releases/<40位SHA>` | 不可变代码、源码 hash 清单；与旧 checkout 分开 |
| `/opt/observatory/current` | 验证成功后才原子切换的发布目录链接 |
| `/opt/observatory/data-workbench` | 新事实库、认证库、原始附件；UID/GID 10001，0700 |
| `/opt/observatory/backups-workbench` | 本机加密备份；10001，0700；不等于异机副本 |
| `/opt/observatory/restores-workbench` | 每次恢复的新目录；10001，0700 |
| `/opt/observatory/release-evidence` | 发布命令与结果；root，0700；不公开下载 |
| `/etc/etf-workbench/runtime.env` | 密码 hash、会话 secret、HTTPS origin；root，0600 |
| `/etc/etf-workbench/backup.passphrase` | 独立随机备份口令；10001，0600；密钥另行保管 |
| `/etc/etf-workbench/release.env` | root 管理的 shell 配置；root，0600；不可使用不可信上传文件 |

Web/worker/tools 全部 `10001:10001`、只读 rootfs、丢弃全部 capability、`no-new-privileges`。挂载目录必须预先存在，不由 Compose 静默创建 root 目录；不递归 chown 原生产数据。Web 仅绑定 `127.0.0.1:5051`，沿用经过人工检查的宿主 HTTPS 反代。

首次生成秘密（授权操作员执行；以下不会在 stdout 输出秘密）：

```bash
sudo -i
export WORKBENCH_DEPLOY_ROOT=/opt/observatory
export WORKBENCH_ORIGIN=https://etf.vpanel.cc
read -r -s -p 'New workbench password (16+ characters): ' password
printf '%s' "$password" | node /path/to/reviewed-source/scripts/init-workbench-secrets.mjs
unset password
```

脚本拒绝已有 `/etc/etf-workbench`，不覆盖旧 secret；密码原文不写盘，不采用默认密码。口令和备份密钥应进入操作员的独立受控保管流程。`runtime.env` 使用**无引号的原始值**，不要 `source` 此文件，不要打印完整 `docker compose config` 或容器环境。

## 2. 发布前门槛

发布前必须逐项留证：

1. 审核准确提交 SHA；该 SHA 的自动 CI、容器 fixture、认证/业务 HTTP 回归通过。
2. 真实生产 SQLite Online Backup 副本迁移演练通过，旧数据未变；不能用本地小库或合成 fixture 代替。
3. 异机加密副本、密钥取得、全新环境恢复、补录备份后事件与对账演练通过。目标 **RPO ≤15 分钟、RTO ≤2 小时**。未测量即未达标。
4. 核对新版本与旧数据库迁移兼容性、可用磁盘/内存、WAL、认证配置、备份空间、原件可读性、来源缺口和账户对账状态。
5. 明确本次启用等级与用户发布批准。工程 CI 不替代实际账户验收、策略准入或实盘建议批准。

GitHub `production` Environment 必须在仓库设置中启用 required reviewers、限制发布分支；YAML 声明 environment 本身不会自动设置审批规则。

## 3. CI 与人工发布

`.github/workflows/ci.yml` 在 push/PR 自动运行，先 `npm ci`，再跑依赖 Node 迁移工具的 Python 跨语言测试；覆盖 Node 合约/迁移/恢复/发布 fixture、Web 单元/构建/HTTP、依赖审计与 Linux 容器冒烟。

`.github/workflows/deploy.yml` **只有 `workflow_dispatch`**：输入 main 上已审核的准确 40 位 SHA，复用 CI，通过生产 environment 后再发布。复用工作流使用本仓库调用，不传递生产 secret 给测试 job。[GitHub 复用工作流](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)

生产 job 需要以下受保护 Secrets：`VPS_HOST`、`VPS_USER`、`VPS_SSH_KEY`、`VPS_PATH`、**`VPS_SSH_HOST_KEY`**。主机公钥由独立渠道核验，不在发布时 `ssh-keyscan` 后无条件信任。当前执行脚本要求授权 root 操作员；若要非 root 发布账号，应另行设计受限 sudo，不放宽目录/secret 权限。

工作流上传 `git archive <SHA>`，核验压缩包 hash，生成每文件 hash 清单，并将代码置于新 releases 目录；不 `git reset` 当前 checkout、不 rsync 覆盖线上代码。相同 SHA 已有目录时验证清单，不能静默覆盖。

本机检查计划（无容器/数据写入）：

```bash
bash scripts/deploy-workbench.sh \
  --release <40位SHA> \
  --release-dir /opt/observatory/releases/<40位SHA> \
  --config /etc/etf-workbench/release.env
```

只有另加 `--execute` 才执行。正式执行顺序：

1. 校验代码/配置/路径/UID，获取独占发布锁，拒绝未经接管的既有新库或待恢复标记。
2. **先构建**准确 SHA 镜像、检查 UID/OCI revision/auth/备份密钥；此时旧服务保持运行。
3. 首次切换：对实际旧库在线快照，再停止旧 web/worker。升级：使用旧版本兼容镜像在线备份新账本，停止旧版本写者，再取最终迁移前备份。
4. 显式迁移 `etf-workbench.db`；首次切换再取旧库最终一致快照，逐表归档为 `legacy_archives` 和原 SQLite 附件。旧整数/BLOB 保留类型，旧模拟账户不是实际资金。
5. 当前库加密备份，并**恢复到全新演练目录**验证。该步骤只证明同机恢复，不冒充异机灾难恢复。
6. `up --wait` 等待 Web 就绪，核对 schema、健康接口、未登录 API 401、worker 数据库加载；成功后才切 current 链接。

所有备份、schema、镜像 ID、恢复和健康结果写入 `release-evidence/<SHA>-<UTC>/`。旧库及旧容器保留，不自动清理旧镜像、备份或归档。

旧库始终只读挂载。关闭最后写者的 WAL 库可能删除辅助文件，SQLite 无法在只读目录重建 `-shm`；因此只有已停写的最终归档传 `WORKBENCH_LEGACY_QUIESCED=1`，将主文件及存在的 WAL/rollback journal 一起流式校验复制到私有 staging，再使用 Online Backup 生成规范快照。初次在线备份不使用该分支；不得在写者仍运行时谎报 quiesced，也不得仅复制主文件忽略 WAL。

## 4. 独立工具命令

下列命令应从已批准的 `current` 发布目录执行，并由 root 读取受控 release 配置；不加载 `runtime.env`：

```bash
set -a
source /etc/etf-workbench/release.env
read -r WORKBENCH_RELEASE_SHA < /opt/observatory/current/.release-sha
set +a
cd /opt/observatory/current
docker compose --env-file /etc/etf-workbench/release.env -p etf-workbench run --rm --no-deps backup
```

迁移显式使用 `... run --rm --no-deps migrate`。迁移只创建 schema，不 seed 组合、账户、到账、持仓或价格。禁止在遗留 `observatory.db` 上运行新迁移。

恢复始终明确新目录名，不覆盖现有目录：

```bash
export WORKBENCH_RESTORE_ARCHIVE_NAME=workbench-<backup-id>.etfbackup
export WORKBENCH_RESTORE_TARGET_NAME=incident-<唯一编号>
docker compose --env-file /etc/etf-workbench/release.env -p etf-workbench run --rm --no-deps restore
```

恢复后存在 `RESTORE_PENDING_REVIEW`、清空的会话表、0600 新 `recovery-session.env`。该文件**尚未应用到线上进程**；操作员须把新 secret 安全替换进目标 runtime.env，确认旧会话失效、补录与对账完成，再按审核流程解除只读。不得直接 `source` 新 secret 后假设 Compose env_file 已更新。

备份加密、附件完整性、归档边界及异机接口见 [恢复操作说明](recovery-operations.md)。当前单附件上限 256 MiB；旧库超限会明确失败，不跳过原件。扩容应在 fixture 中调整并验证，不临时绕过。

## 5. 失败与回滚

- 构建或前置检查失败、旧写者尚未停止：旧服务继续运行，不覆盖数据库。
- 停写/迁移开始后失败：停止新写者、创建 `RESTORE_PENDING_REVIEW`，保留全部新事实、备份及证据；**不自动恢复旧库，也不自动重启旧调度**。
- 首笔新事实之前，可经审核撤回流量至旧环境；旧环境只拥有旧研究能力。
- 已有新事实后，只能兼容修复或隔离恢复、补录和对账。不得将迁移前 DB 覆盖当前 DB，不能把外部成交回滚成不存在。
- 恢复到新目录不能代替数据路径切换批准。若磁盘损坏/写满或附加材料缺失，保持阻断，不回退新空库。

## 6. 当前验证边界

2026-09-12 只读生产检查：旧发布 `f38d244d7b050a113e34da74d1d79bd466f7ef1b`；web/worker 仍为旧 observatory，原数据目录 UID 501；主 DB 110,592,000 字节，WAL 7,687,952 字节。因此不得仅复制主文件，也不能直接假定新的 UID 10001 可写旧目录。

本轮工具验证、容器隔离验证和生产切换是三件不同的事。具体执行证据见 `production-release-verification.md`。本手册不宣称生产已发布，也不宣称 RPO/RTO、异机恢复、真实账户对账、人工界面签核或投资策略有效性已达标。

### 2026-09-12 发布配置元信息复核

只读查询（未读取秘密值）确认：仓库只有 `VPS_HOST`、`VPS_PATH`、`VPS_SSH_KEY`、`VPS_USER` 四个 repository secrets，缺 `VPS_SSH_HOST_KEY`。environments API 返回 `total_count=0`，尚无 `production` environment、required reviewers 或部署分支限制。

目标主机 `/etc/etf-workbench` 及其三个配置/密钥文件、`/opt/observatory/current` 与 `data-workbench` 均不存在。因此这是首次切换，不能把 CI 成功当成可以立即执行发布。初始 owner 登录、真实旧库副本演练和独立恢复仍未完成。

如果另行批准先上线受限只读工程版，须把 `WORKBENCH_MODE=read_only` 写入 `release.env`/Compose 插值环境；仅写入 `runtime.env` 会被 Compose 的显式 environment 覆盖。该受限阶段不代表完整产品验收，也不授予投资权限。不得为通过演示而配置任意 `WORKBENCH_RELEASE_SHA256` 或伪造治理验证记录。

发布脚本现已在长构建后、停旧写者前、迁移前后、启动和 current 切换前复查恢复标记；迁移工具另在创建前、事务内及提交前复查。密码初始化采用与登录一致的 UTF-8 最大 1024 字节校验。二者有合成回归，但不替代实际网络路径上的 owner 登录和运行配置验收。
