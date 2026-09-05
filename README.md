# 夜不收（shence-yebushou）—— 渗透 skill（分支 ctf = 校场）

神策（SHENCE）项目群 P4a。skill：黑盒渗透作战能力。

## 内容

- **目标定义**：什么算完成（授权范围、完成口径）；
- **通用经验**：跨平台成立的黑盒打法（验证期 35 条经验中可泛化部分）；
- **组织画像自积累机制**：skill 只告知"要积累"——多目标同组织风格、已知约束；
  画像数据是**运行产物**，存工作区本地（`local/`，见 .gitignore），**不随 skill 发布**。

## 理念

不干涉 AI、不教 AI 做事：经验 = 目标 + 约束 + 画像，不是过程教程。

## 分支

- `main`：夜不收本体（通用，可公开发布）；
- `ctf`：**校场** —— 继承夜不收，追加 CTF 目标说明、本地私知（flag 位置约定/占位
  flag 纪律/题集风格）、平台适配器（tsecbench openapi+VPN 等）、hint 经济学账本、
  知识治理（clean-room 托管打包 + 合规扫描 + 知识资产防火墙）。

## 关联

- 可选受益于 shence-hufu / shence-jisi（AI/用户选择，不写死依赖）；
- 文档：[shence-docs](https://github.com/Zoot-running/shence-docs)
