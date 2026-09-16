# 托管模式打包清单（HOSTED-PACK-MANIFEST）

> 托管模式规则 6：**Agent 不可内置针对题目的历史答题记忆或解题方法——发现即作弊处置**。
> 规则 4：托管运行全程数据被审计和部分公开。本清单是打包的唯一依据——
> **黑名单默认拒绝，白名单逐项放行**。打包前必跑 `hosted-pack-audit.py`，非 0 退出即阻断。

## 白名单（可以进镜像的东西）

| 路径 | 内容 | 理由 |
|---|---|---|
| `packages/runner/`（lib/prompts） | xiaochang-runner 插件（工具+prompts） | 求解机制 |
| `packages/runner/prompts/` | 派单/执行者 prompt 模板 | 需确认无机制先验/历史内容（审计脚本扫） |
| `skills/xiaochang/SKILL.md` | 合规版技能（通用方法论，可溯源） | 求解方法论 |
| `skills/projectize/SKILL.md` | 行营三件套（五槽/六要素/四栏） | 方法论 |
| `skills/xingying/`（若有） | 行营 persona | 方法论 |
| `platforms/tsecbench/` | **公开**平台知识（错误码/API 惯例） | 平台公开文档等价物 |
| `src/governance.ts` | clean-room 运行时扫描器 | 门禁 |
| 合规版开战令 | 由主 agent 当 run 生成（无机制先验版） | 授权来源 |
| DSH 核心 + 插件依赖（node_modules 等） | 运行环境 | 不含业务知识 |

## 黑名单（**绝不**进镜像，审计脚本按此阻断）

| 路径/文件名模式 | 内容 | 红线依据 |
|---|---|---|
| `local/**`（hosted-priors.md / SOLUTIONS / DEAD-ENDS / creds-corpus 等） | 机制先验/历史题解/凭据语料 | 规则 6 |
| `boards/**`、`*.jsonl`（usage/audit/snapshot 账本） | 历史 run 产物 | 规则 6 |
| `*-order.txt`、`run*-launch.sh`、`*.ovpn` | 开战令含 token/凭据 | 规则 3（凭据走 env） |
| `.secrets/**`、`.dsh*`、`storages/**`（**无例外**） | 密钥/凭据/历史账本 | 规则 3 |
| `jisi-model-ledger.seed.json`（任何位置） | 能力账本种子 = 历史答题战绩 | **规则 6（2026-09-16 V1 榜一被撤实锤：平台判定"直接内置赛题信息和解法"——种子不再带豁免，托管镜像一律禁带）** |
| `retro-*.md`、`run*-war-report.md`、`plan-*.md`、`L4-*.md` | 历史复盘（含 flag/题解） | 规则 6 |
| `xiaochang-archive/**`、`.archive/**` | 历史会话快照 | 规则 6 |
| shence-jintuo（guard/watch） | 本地守护，沙箱一次性无重启语义 | 探索档案 §5 |

## 审计规则（hosted-pack-audit.py 实现）

1. **路径阻断**：命中黑名单文件名/目录 → violation。
2. **内容扫描**（文本文件）：
   - flag 值（`flag{...}`/`HTB{...}`/`SEKAI{...}` 等，≥6 字符非占位）；
   - API 密钥（`sk-`≥16 位、智谱双段 key、Bearer JWT）；
   - 已知公开默认凭据（sysadmin/Weaver@2001 等，run 史发现）；
   - `BENCHMARK_TOKEN=` 后跟具体值（开战令残留）。
3. **跳过**：二进制文件（含 NUL 字节）、`node_modules/**`（体积/速度）。
4. 退出码：0=clean；1=有 violation（阻断打包）。`--json` 输出机器可读报告。

## 打包流程（靠配置不靠纪律）

```
1. 组装镜像内容目录（只从白名单复制）
2. python3 packaging/hosted-pack-audit.py <镜像内容目录> [--json]
3. 退出码 0 才允许 docker build/save
4. 凭据一律不进镜像——运行时由平台 env_config 注入
```
