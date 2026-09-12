# Research worker

这是隔离的研究计算模块，不是实盘交易或策略准入服务。它只写 `research_*`、`simulation_events`、`ai_runs` 和研究证据；不写真实账本、策略批准、激活或券商订单。

## 当前可以复现什么

- 固定目标权重，以新增人民币现金买入；支持按目标缺口分配或固定比例分配，以及分批投入比例。
- 资金到账与决策日期分开。策略与基准使用同一到账日、初始资金、成本、FX 和执行规则；尚未投入的现金保留在组合内。
- 数量在决策时固定，使用严格晚于决策时间的下一可交易收盘价模拟成交。若之后价格上涨导致超出预留现金预算，跳过而不是利用未来价格回算数量。
- 人民币 NAV、现金流利润、精确 TWR、ACT/365 XIRR、单位净值回撤与恢复时间。资金增加不会被记为盈利。
- 显式佣金、最低费用、滑点和换汇费；分红税额、拆分、应收股息及原币到账来自冻结输入。
- 每次决策保留 `proposed` / `unchanged`、订单及模拟成交证据。合成价格跳涨不自动产生买入前收益。

目前三个研究窗口分别从初始资金重新开始，**不是连续十年的持仓历史**。没有卖出、杠杆、现金利息、自动汇回外币股息、实盘结算引擎或未来模拟跟踪。佣金和税覆盖均为输入假设，尚未完成券商、账户可买性及完整税务核验。

## 输入与时点

共享结构契约在 `contracts/v1/research-{dataset,plan,parameters}.schema.json`。金额与权重必须是十进制字符串。

- `assets` 显式给出市场、币种、数量步长、上市/退市区间和证据。
- `sessions` 给出市场本地交易日、UTC 收盘时刻、数据可用时刻及是否允许成交。模块校验日期/时点一致性；不会推测休市日，也不会补齐缺失行情。
- 本版本仅接受精确到秒的未复权收盘价，配合显式公司行动；不接受用复权价加现金股息的双重计收益。
- `historical_point_in_time` 要求公开时点和已核验历史档案标记；`actual_replay` 还要求价格/FX 当时已经摄取，公司行动必须附 `ingested_at` 且不晚于事件时刻。重建数据不升级成当时已知证据。
- 决策使用当时可见数据；成交与净值曲线可以使用该交易日收盘后声明可用的最终收盘值。这是事后估值，不代表收盘前可以看见它。
- 本收盘模型没有独立的实时成交回报流，故拒绝在任一输入市场的收盘至数据可用间隔内安排决策，避免尚未可见的成交金额泄漏进可用现金。
- 外币估值或买入必须有当时可见、未过期的人民币汇率；缺价、缺 FX、缺公司行动覆盖均阻断计算。

非合成实验必须引用数据库中精确的 `market_publication_events` 版本，使用 `snapshot_from_publications()` 生成快照。输入观察值必须逐项等于发布版本，不能改成最新版本或事后修订值。日历、生命周期、许可与公司行动证据仍需要人工验证，字段存在不代表外部事实真实。

`plan` 预登记假设、证伪条件、三个不重叠窗口、决策日、候选参数、每阶段试验预算、成本、基准及税覆盖。`initial_capital_cny` 和每笔 `contributions` 的金额、币种及日期须显式提供；真实个人约束仅在本地填写，不从公开示例预置。仓库中的固定数值 fixture 均为合成研究输入，不是个人资金计划或收益预测。

## 注册、计算与留出集

```python
from worker.research import (
    register_experiment, register_trial, prepare_trial, persist_trial,
    freeze_candidate, unseal_holdout,
)

register_experiment(db, "experiment:1", portfolio_id, plan, dataset, actor_id)
trial = register_trial(db, "experiment:1", "train", parameters, "train:1", actor_id)
prepared = prepare_trial(db, trial["id"])
run = persist_trial(db, prepared)
```

- 实验、数据、参数、实现代码、依赖锁文件、相关 schema 与时区数据均有哈希记录。已登记后实现改变必须重新登记试验，不能静默重跑不同版本。
- 失败试验也消耗预登记预算；相同幂等键返回原试验，不产生隐蔽的第二次尝试。
- 训练和验证成功后，人工 `freeze_candidate()` 选择已完成验证的候选；存在未完成搜索试验时不能冻结。冻结后不能继续搜索。
- 人工 `unseal_holdout()` 记录理由，之后只允许冻结参数进行一次留出集试验。
- 这是执行流程隔离，**不是加密盲测**。原始留出数据仍在本地快照中，无法证明操作人此前没有看过。默认标记 `not_independently_verified`；同一数据哈希曾解封则记 `contaminated`。
- `S-01` 至 `S-10` 均保持 `NOT_RUN` 或 `BLOCKED`，`live_advice_eligible=false`。数据质量声明、成功计算、良好回测表现均不自动改变这些状态。

### 调度 / Web 接口

建议命令 `research_trial` 的 payload 仅为 `{"trial_id":"trial:..."}`。

`prepare_trial()` 使用只读快照并在写事务外计算；`persist_trial()` 是短事务提交，可嵌入调度器 lease/fencing 的 `JobCommit` effect。计算阶段 `research_runs` 保持 `queued`，运行状态由持久任务展示；这样进程崩溃不会遗留永久 `running` 研究行。`record_trial_failure()` 可在 fenced effect 中记录终态失败。

`PreparedResearch` 是可信 worker 内部对象，不能从 HTTP、AI 或外部 JSON 反序列化后直接提交。Web 只提交试验 ID；注册、冻结和解封必须先经过 Web 身份认证/人工授权。所有写入复用动态只读/恢复复核锁。当前同步 CLI 不需要调度器，但生产重复执行应使用任务幂等键和 fencing。

## AI 只读研究审阅

`review_context(db, run_id)` 只导出已成功研究报告的少量数字证据及来源哈希，不导出账户、券商原始文件或完整行情。`request_review()` 给可信 provider 回调的只有静态系统提示和该数据副本，没有数据库连接或工具。

回调必须自行设置真实网络超时；目前没有接入任何真实模型提供商。也可将外部返回文本交给 `record_review()` / `review-file` 做离线验证。

- 输出须满足 `ai-research-review.schema.json`；禁止重复键、非有限数、超限文本、未知字段、无来源事实或伪造数值。
- 事实必须精确匹配引用指标；派生指标保留计算精度，不强制按账本金钱精度舍入。
- 推断、支持/反对证据、未知项、风险和失效条件分栏存储。自由文本始终是不可信文本，不执行其中的指令或 SQL。
- `valid` 只表示格式和已引用数值通过检查，**不表示推断真实、来源已人工复核或策略获批**。质量记录始终保留 `investment_gate_passed=false`、`tool_calls_permitted=0`、`output_executed=false`。

## CLI 与测试

先使用项目统一迁移器建立新 workbench 数据库，再安装 `requirements-workbench.txt`。不加载旧 `worker/db.py`。

```sh
python -m worker.research --db /absolute/workbench.db register \
  --experiment experiment:1 --portfolio portfolio:1 \
  --plan /absolute/plan.json --dataset /absolute/dataset.json --actor operator:1
python -m worker.research --db /absolute/workbench.db trial \
  --experiment experiment:1 --phase train --parameters /absolute/parameters.json \
  --key train:1 --actor operator:1
python -m worker.research --db /absolute/workbench.db run --trial trial:GENERATED_ID
python -m worker.research --db /absolute/workbench.db freeze \
  --experiment experiment:1 --validation-trial trial:VALIDATED_ID --actor operator:1 --reason "选择理由"
python -m worker.research --db /absolute/workbench.db unseal \
  --experiment experiment:1 --actor operator:1 --reason "独立留出评估"
python -m worker.research --db /absolute/workbench.db review-file \
  --run research:GENERATED_ID --model provider:model --file /absolute/review.json

python -m unittest discover -s tests/research -v
WORKBENCH_PYTHON=python node --test tests/research/contracts.test.mjs
```

所有自动化场景使用临时数据库和明确标记的合成数据。测试通过仅证明这些计算与边界行为，不代表真实数据接入、S 类策略验收、长期盈利或生产系统整体验收。

历史检索索引、旧/新完整结果对照以及每市场 3300 个合成交易日的性能记录见 `docs/research-index-benchmark.md`。该基准不代替真实十年投资数据验收。
