# 校场（shence-yebushou@ctf）—— CTF 分支

继承夜不收（main 分支）的渗透能力，追加 CTF 特化：

- `skills/xiaochang/SKILL.md` —— 校场技能：CTF 目标说明（flag 约定/占位 flag 纪律/题源识别）、
  平台约定（hint 经济学、交卷口径）、知识治理纪律（本地私知只进 local/）。
- `src/adapters/tsecbench.ts` —— tsecbench 平台适配器（openapi 六原语，注入 fetch 纯逻辑可测）。
- `src/hint-ledger.ts` —— hint 经济学账本（每题 10% 扣分、原因、序列化）。
- `src/governance.ts` —— 知识治理扫描（flag 值/API 密钥/已知凭据检出，clean-room 打包前必跑）。
- `local/` —— 本地私知与组织画像（gitignore，永不入库/入镜像）。

## 验收记录（2026-09-05）

- L0：15 项全绿（画像 6 + 适配器/hint 账本/治理 9）。

## 理念

不教 AI 做事；私知与可泛化经验物理隔离（local/ vs 技能本体）。
