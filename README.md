# 夜不收（shence-yebushou）—— 渗透 skill（分支 ctf = 校场）

神策（SHENCE）项目群 P4a。

- `skills/yebushou/SKILL.md` —— 技能本体：目标定义 + 跨平台通用经验 + **组织画像自积累机制**
  （画像只产出、不内置；本地产物在 `local/profiles/`，已 gitignore）。
- `src/profile.ts` —— 组织画像格式（纯逻辑：创建/追加去重/渲染/解析），L0 6 项全绿。
- 分支 `ctf`（校场）：CTF 目标说明、平台适配器（tsecbench）、hint 经济学账本、知识治理扫描。

## 理念

不教 AI 做事：经验 = 目标 + 约束 + 画像，不是过程教程。

## 部署（dev 实例）

把 `skills/yebushou/` 复制到 DSH 技能根目录（项目根 `.agents/skills/` 或自定义 root），
目录监听自动发现，无需重启。
