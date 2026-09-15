# 校场（shence-yebushou@xiaochang）—— CTF 分支

继承夜不收（main 分支）的渗透能力，追加 CTF 特化：

- `skills/xiaochang/SKILL.md` —— 校场技能：CTF 目标说明（flag 约定/占位 flag 纪律/题源识别）、
  平台约定（hint 经济学、交卷口径）、知识治理纪律（本地私知只进 local/）。
- `src/adapters/tsecbench.ts` —— tsecbench 平台适配器（openapi 六原语，注入 fetch 纯逻辑可测）。
- `src/hint-ledger.ts` —— hint 经济学账本（每题 10% 扣分、原因、序列化）。
- `src/governance.ts` —— 知识治理扫描（flag 值/API 密钥/已知凭据检出，clean-room 打包前必跑）。
- `local/` —— 本地私知与组织画像（gitignore，永不入库/入镜像）。

## 验收记录（2026-09-05）

- L0：15 项全绿（画像 6 + 适配器/hint 账本/治理 9）。

## runner 插件（packages/runner）—— 校场编排器

夜不收适配器 × 虎符战役 × 集思通道的宿主侧编排:

- 平台六原语 + 容器槽位(3 上限)+ hint 经济学 + clean-room 门禁;
- 虎符大兵团: enqueue/dispatch/collect, 终态 report 自动剪枝;
- **F33 经验机制**: 终态结构化报告(deadEnds/forks/observations)→ 知识账本;
  分叉即时报(xiaochang_fork → 盘上信箱 → 主 agent 唤醒); 全局解题图(xiaochang_graph);
  派单自动附带死路/未走分叉/事实;
- **v2 决策内核宿主侧**(设计 [shence-jisi/METHODOLOGY/JISI-V2-DESIGN.md](https://github.com/Zoot-running/shence-jisi/blob/main/METHODOLOGY/JISI-V2-DESIGN.md)):
  - `xiaochang_report.why` 四归因(执行者提议 + 主 agent 终裁);
  - 通用难度校准(宿主映射 + 终局 Beta + 归因门控)+ 题型粗分类;
  - contextGaps 画像(缺口自动附进派单/二次征集);
  - `xiaochang_refanout` R2 一键二次征集(题面+死路+缺口+已试模型, 加模型发兵);
  - `xiaochang_status` ⚠️ 升级建议(死思路 ≥50%);
  - hint 单点守卫(仅主 agent 可调);
- **v7 资源类 + 知识账本 + 极简执行令**(章程 [CHARTER-NEXT2-资源槽位与知识账本.md](CHARTER-NEXT2-资源槽位与知识账本.md)):
  - 附件/容器题自动分类 → 虎符类闸: 附件题全并行, 容器题 3 槽轮换(`xiaochang_status` 的 resourceClasses 行);
  - 每题知识账本文件 `boards/<runId>/<code>/KNOWLEDGE.md` 四节(①题源思路骨架=主 agent 维护/`xiaochang_knowledge_put`, ②死路③工件④分叉=机制自动累积)——执行者开工必读, 重试零重复识别;
  - `xiaochang_enqueue` 极简执行令: prompt 只写一行指令, 题面/入口/账本/画像/纪律由机制注入;
- 本地干跑台: `tools/mock-tsecbench.mjs` + `tools/dryrun-local.sh`(不碰 docker),
  流程 = 讨论→改码→单测+干跑→上仓库→托管打包才进 docker。

## 理念

不教 AI 做事；私知与可泛化经验物理隔离（local/ vs 技能本体）；
满分 > 用时 > 花费(字典序)——赶工贵模型是正当花费。

