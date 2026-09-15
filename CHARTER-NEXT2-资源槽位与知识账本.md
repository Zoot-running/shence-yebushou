# 下一轮迭代章程 v7:资源类槽位 + 附件/容器分类 + 每题知识账本 + 极简执行令

> 触发:lewton 架构复盘(文件管道/planner-executor/极简 prompt/第 0 分钟并行)+ 用户裁定
> "模型识别不到每类任务的约束和资源 → 靠机制与先验注入,不靠模型当项目经理"。
> 状态:已批准("搞吧") → 本文件为落设计 → 实施顺序:①虎符 → ②校场 → ③④账本+极简令。
> ⑤ v6(停止规则/末段自动 R2/故障过滤)不变,本迭代不触碰。

## 目标(字典序:满分 > 用时 > 花费)

1. 让"附件题无容器依赖可全并行、容器题受平台 3 容器槽约束"成为**调度机制事实**,而不是主 agent 的自觉。
2. 让"每题的历史(思路骨架/死路/工件/未走分叉)"成为**执行者开工必读的文件**,重试从已知边界出发,零重复识别。
3. 把执行 prompt 从"每次抄全题面+入口+纪律"压成**一行指令**——框架由机制注入,省 token 且不丢上下文。

## ① 虎符 resourceClass 槽位(通用机制)

契约扩展(向后兼容;不传 = 现状):

- `WorkItem.resourceClass?: string` —— 缺省 `'default'`。
- `CampaignConfig.resourceLimits?: Record<string, number>` —— 每类上限;未列出的类继承 `concurrency`。

调度语义(两层闸):

- 全局闸 `freeSlots()` 不变(= concurrency − open 总数)。
- **类闸** `classFree(cls) = limit(cls) − open(cls)`,limit 缺省回退 concurrency。
- `dispatchNext()`:**跳过**优先级最高但类槽已满的项,派下一个类槽空闲的就绪项——排队头不被饱和类堵死(无 head-of-line blocking)。
- `dispatchNext()` 无槽/无可派项返回 `undefined`;**宿主派单循环必须以返回值判空退出**(原 `freeSlots()>0 && nextQueued().length>0` 循环在类饱和时死转——binding 与 runner 两处同改)。

可见性:`classUsage(): Record<cls, {open, limit}>`,状态面透出(主 agent 看得见哪类饱和)。

恢复:resourceLimits/resourceClass 随 config/items 序列化,restore 天然覆盖,零迁移。

## ② 校场 附件/容器分类(特化消费)

- 分类函数 `resourceClassOf(ch)`:题面含 `无需容器/纯附件/下载附件/attachment/静态文件/本地分析` → `'local'`(附件题);否则 `'container'`(容器题,保守兜底——错判最多牺牲并行度,不牺牲正确性)。
- setup:`resourceLimits = { container: containerSlots(默认 3,可配), local: concurrency }`。
- enqueue 自动按题类打 `resourceClass`;**可选 override 参数**——主 agent 明知某容器题已开容器、纯加人不需要新容器槽时改 `'local'`(多执行者同题并行不受 3 槽误伤)。
- 效果:第 0 分钟附件题全部入队即全并行;容器题最多 3 个在途,完成一个放一个 = 3 槽轮换。
- 容器题执行令注入实时 addrs;addrs 为空时执行令写明"容器未开:请主 agent xiaochang_start_container,或你自行调用(平台同时 3 个)"。
- list/status 透出每题类标签与类用量,主 agent 一看便知哪条资源线饱和。

## ③ 每题知识账本文件(持久记忆,四节)

路径:`boards/<ns>/<code>/KNOWLEDGE.md`(与 FINDINGS.md 同目录,执行者 bash 直读,无需工具)。

四节:

1. **① 题源思路骨架** —— 主 agent 维护(唯一写者):每条思路的出处(题面/hint/图谱/分叉)+ 骨架步骤。新工具 `xiaochang_knowledge_put` 整体改写本节,追加其余节。
2. **② 不可行教训** —— 死路 + 上下文缺口。自动累积:report 的 deadEnds/gaps。
3. **③ 回收工件** —— 凭证/文件路径/URL/脚本/发现。自动累积:report 的 observations(evidence)。
4. **④ 未走分叉** —— 自动累积:report 的 forks + `xiaochang_fork`(含跨会话信箱吸收)。

机制要点:

- 文件在 enqueue 前由机制初始化(四节骨架),执行令引用其绝对路径。
- 自动追加**按行去重**(同一条教训不重复生长文件)。
- 执行者不写账本(只经 fork/report 上报)——写者收敛,文件永远是主 agent 已读过的账本镜像。
- 重试零重复识别:重派执行者开工第一件事读 ①②,从死路边界+回收工件出发。

## ④ 极简执行令(机制注入框架)

enqueue 的 `prompt` 参数语义降级为**一句话指令**(思路/职责),机制包一层固定框架:

```
【校场执行令 · {code}】({类标签}, {difficulty}, {score}pts, {flag_count} flags)
题面: {description ≤1200}
入口: {addrs | 无需容器 | 容器未开提示}
共享战报: {boardPath}  知识账本(开工必读): {knowledgePath}  画像: {profilePath}
你的任务: {args.prompt}
纪律: ①先读知识账本,从已知边界出发,不重复死路,优先用回收工件;
      ②找到 flag 立即输出 FLAG_CANDIDATE: <flag>(主 agent 提交);
      ③死路/新分叉调 xiaochang_fork 上报;终态前把死路原因写清。
```

- 主 agent 不再抄题面/入口/战报纪律——框架自动注入,少 token、不丢关键上下文、零漏抄。
- 老快照恢复的旧 item 保留旧 prompt(不迁移)。
- skill/xiaochang 更新:enqueue 用法、知识账本读写纪律、类槽语义。

## 验收(本地干跑,mock v2)

- 附件题 g-m1..4 第 0 分钟全部派单并行(类闸不限);容器题 ≤3 在途,轮换。
- b-02 首轮失败后重派:执行令指向 KN(账本),② 已有死路条目,重试 prompt 一行指令。
- 虎符单测:类饱和跳过、未知类继承、classUsage、restore 往返。
- runner 单测:分类启发式、账本四节初始化/去重追加、执行令框架。
- 不碰 docker;托管打题时才进。

## 风险

- 类错判(local 误判 container):只损并行度;container 误判 local:执行者自行开容器会撞平台 3 槽(平台拒),start_container 已有 3 槽闸兜底 → 无正确性风险。
- 极简令丢上下文:框架强制注入题面/入口/账本/画像路径,主 agent 只剩思路职责——漏抄面收敛到 0。

## 实施与验证结果(2026-09-15, 本地干跑 mock v2 通过)

实施顺序与测试:

1. 虎符:resourceClass/resourceLimits/classUsage + dispatchNext 跳过饱和类;宿主派单循环两处(binding/runner)改为"dispatchNext 返回 undefined 即停"(旧式 while 条件在类饱和时死转)。单测 36/36(新增 4 条类闸用例)。
   - 附带修复:byPriority 同 tier 同 score 时返回 -1(比较器不一致)→ 补 return 0,注册顺序从此稳定(旧代码会把同优先级项打乱)。
2. 校场:resourceClassOf 启发式(无需容器/附件 → local,否则 container 保守兜底)+ setup resourceLimits {container:3, local:concurrency} + enqueue 自动打类(可 override)+ list/status 透出。单测 18/18(新增分类用例)。
3. 知识账本文件:KNOWLEDGE.md 四节,①主 agent(xiaochang_knowledge_put),②③④机制自动累积(report/fork/信箱吸收);restore 迁移兜底 syncKnowledgeFileFromLedger;行去重幂等。单测 18/18(新增 5 条四节用例)。
4. 极简执行令:enqueue 框架自动注入题面/入口/战报/账本/画像/纪律;prompt 只写指令。
5. v6 未动。

干跑证据(8 题 4400/4400, ~20 分钟):

- **类闸生效**:4 个附件题(g-m1..4)同一毫秒全部派单(第 0 分钟全并行);容器题同时刻仅 3 个在途(xb-071/xb-056/xb-088),b-02/xb-088-w2 排队,一个终态即轮换。
- **账本生效**:8/8 题 KNOWLEDGE.md 四节齐全;b-02 终局 28 条(①6 条骨架 ②8 条死路 ③9 条工件含凭据/注入载荷/路由表 ④4 条分叉)——执行者跨会话 xiaochang_fork → 信箱 → 主 agent absorb → 文件,链路全通。
- **极简令生效**:主 agent 全程一行指令,框架注入无漏抄。
- **工具修复**:mock 被执行者 curl -d 表单 body 打崩(JSON.parse 抛异常炸进程)→ parseBody 容错 + 路由 try/catch 兜底,平台永不因坏输入崩。

遗留候选(v7.1,下轮讨论):

- **fork 终态抑制**:终态题的迟到 fork 回放会再次唤醒主 agent,凭空产生增兵冲动(干跑实锤:收尾后 b-02 的迟到 fork 又唤醒一次)——纪律靠模型自觉不够,应在 wait/fork 机制层抑制"progress 已终态"的唤醒。
- mock 把所有题标 available 导致容器槽恒 3/3 满(不影响解题,仅统计噪声)。
