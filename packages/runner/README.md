# @shence/xiaochang-runner —— 校场 L4 自主跑分编排器

神策 L4 真实验收的执行器：把「夜不收平台适配器 × 虎符战役账本 × 集思派单通道」
组成一条无人值守的跑分流水线，跑在 DSH 实例上。

## 组成

| 层 | 职责 | 出处 |
|---|---|---|
| 平台六原语 | 列题/启动/提交/关闭/hint/网关健康 | `src/adapters/tsecbench.ts`（夜不收 ctf 分支） |
| 求解调度 | 工作项 + 账本 + 优先级 + 槽位 + 序列化恢复 | 虎符 `ctx.hufu` |
| 派单 | 按次模型 + 思考强度 | 集思 `ctx.jisi`（经虎符绑定） |
| 编排核心 | 选题/flag 提取/clean-room/prompt/预算/进度账/模型策略 | `src/orchestrator.ts`（纯逻辑） |
| 知识红线 | hint 经济学（10%/次，上限可配） | `src/hint-ledger.ts` |
| 方法论 | 求解 prompt 内嵌黑盒通用知识 | `prompts/solver.md`（与 xiaochang 技能同源） |

## 工具

`xiaochang_start`（唯一入口；重复调用 = 崩溃恢复续跑）：

- `budgetMinutes`（默认 320）：总墙钟预算；从首条快照起算，崩溃恢复沿用。
- `concurrency`（默认 3，平台容器槽位上限 3）：求解并发。
- `roundsPerChallenge` / `roundTimeoutMinutes`：每题最多轮次、单轮超时。
- `maxHintsPerChallenge`（默认 1）：官方 hint 上限（每次扣该题 10%，向上取整）。
- **模型调度**：`model`（easy，默认 kimi-k3）、`modelMedium`（medium，默认 deepseek-v4-flash）、
  `modelHard`（hard/insane，默认 deepseek-v4-pro）、`effort`（默认 high）、`effortMedium`（默认 low）、
  `effortHard`（默认 max）、`effortRetry`（第 2 轮起升级，默认 max）。
  flash/pro 之分由 model 承载；思考强度由 reasoningEffort 承载（模型未宣告的 effort 由集思自动丢弃）。
- `knowledgeDir`：本地私知目录（clean-room 门禁扫描对象；出现该题号即弃权，宁可丢分不破红线）。
- `runBearerToken` + `runId`：平台会话凭据——全题终态或预算耗尽后立即 `finish` 停表。

## 运行位置（重要约定）

- **必须从专用工作目录启动 headless CLI**（`cd /home/zrn/xiaochang-work` 后运行）：
  求解器的 bash 工作区默认 = 进程 cwd。
  - 靶场附件（钓鱼邮件、恶意样本、pcap）是**真实攻击样本**——若 cwd 在
    /mnt/d（Windows 磁盘），Windows Defender 会报毒甚至隔离文件打断求解；
    ext4 工作目录（/home/zrn/...）Defender 不扫描。
  - 沙箱 workspace-write 以 cwd 为根，工作目录天然把求解器写入限制在园内。
- 跑完战役后清理工作目录内容；DSH checkout 保持干净（git status 无求解器残留）。

## 平台规则要点（tsecbench）

- 同一时间最多 3 道题容器在跑；**拿完 flag 立即 close**（编排器自动执行）。
- 每题可能多枚 flag：提交接口 `correct/awarded` 为权威；重复提交幂等（duplicate）。
- hint 后该题 flag 得分按比例扣减（默认 10%/次）。
- **排名规则**：同分者按 `score_elapsed_seconds`（达成最终得分耗时）排序——
  所以全题完成后编排器立即调 `/api/v1/runs/{id}/finish` 停表，而不是等 run 时限自然结束。

## 崩溃恢复

- 进度快照：`$DSH_HOME/storages/xiaochang-run.jsonl`（追加 JSONL，容错恢复取最近可解析行）。
- 审计轨迹：`$DSH_HOME/storages/xiaochang-run-audit.jsonl`（派单/终态/限流重试）。
- 进程死后再调一次 `xiaochang_start`：从快照恢复、清残留容器、继续未完成题目；
  丢掉的只是正在跑的那一轮（记账轮次 +1 重派）。
- 限流重试：求解器瞬时错误（429/rate limit 等，含空诊断静默失败）不消耗轮次，同轮最多重试 5 次。

## 知识红线（托管规则合规）

- **求解 prompt 只含四样东西**：平台题面与入口、通用黑盒方法论（`prompts/solver.md`，
  与 xiaochang 技能同源、不含任何题解）、本题本 run 已确认 flag、上一轮自己的
  工作记录（同题续跑）。
- **run 之间只继承公共知识**：方法论/技能是唯一跨 run 遗产；本地题解、历史 run
  快照与审计轨迹一律不进 prompt。
- **clean-room 门禁**：`knowledgeDir` 里出现某题号的文件即对该题弃权
  （宁可丢分不破红线）；本地私知只进 `local/`（gitignore），不进公开仓库。
- 治理扫描器（`src/governance.ts`）供打包/入库前阻断 flag 值与凭据。

## 已知边界（v1.1 待办）

- 战役账本不落盘（仅进度账落盘）：崩溃后账本级审计丢失，审计轨迹兜底。
- 求解器工具集沿用 DSH 子代理默认（bash/fs/web）；不支持按题定制工具。
- VPN 连接与 `BENCHMARK_TOKEN`/`BENCHMARK_BASE_URL` 由外部（jintuo 启动脚本）注入环境变量。
