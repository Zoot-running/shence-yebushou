/**
 * 校场 v2 编排核心（纯逻辑，L0 可测）。
 * v2 调度权在主 agent：这里只保留纯机制——clean-room 门禁、工作项 id 解析、
 * OBSERVATIONS 解析（画像积累）、进度账（JSONL 快照/容错恢复）。
 * 思路征集与执行者选择由主 agent 经 jisi_fanout / jisi_model_report 决定。
 * @module @shence/xiaochang-runner/orchestrator
 */

import type { ChallengeInfo } from '../../../src/adapters/tsecbench.ts'
import { mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface CleanRoomVerdict {
  contaminated: boolean
  hits: string[]
}

/**
 * pre-run sweep（F5 机制化）：把 cwd 里早于 startedAt 的题号工件/旧 run 战报
 * 移入归档目录，防止上一 run 的解与 flag 泄漏进本 run（run 6 前 27 分钟旧工件红利）。
 * 保留：工具链目录、启动脚本（run*-launch/order）、普通隐藏配置；`.run*` 旧会话副本归档。
 * @param cwd - 战役工作目录。
 * @param startedAt - 本 run 开始时间戳（早于它的都是上一 run 遗留）。
 * @param archiveRel - 归档相对目录（如 `.archive/tsecbench-run-15998`）。
 * @returns 移走的条目数。
 */
export function sweepLegacyWorkdir(cwd: string, startedAt: number, archiveRel: string): number {
  const KEEP_DIRS = new Set(['.venv', '.gocache', '.gopath', '.g10test', '.git', 'node_modules', '.archive'])
  const KEEP_FILE_RE = /^run\d+-(launch|order)\.(sh|txt)$/
  let moved = 0
  try {
    for (const name of readdirSync(cwd)) {
      // 普通隐藏配置保留；.run*（旧会话副本）要归档。
      if (name.startsWith('.') && !name.startsWith('.run')) continue
      if (KEEP_DIRS.has(name)) continue
      if (KEEP_FILE_RE.test(name)) continue
      const full = join(cwd, name)
      const stat = statSync(full)
      if (stat.mtimeMs >= startedAt) continue
      mkdirSync(join(cwd, archiveRel), { recursive: true })
      renameSync(full, join(cwd, archiveRel, name))
      moved += 1
    }
  } catch { /* 清场失败不致命（下个 run 再扫） */ }
  return moved
}

/**
 * clean-room 门禁：本地私知文件中出现该题 unique_code 即视为污染
 * （flag 值/凭据级污染由治理扫描器在打包前阻断；本门禁按题作废求解权）。
 */
export function cleanRoomGate(code: string, localFiles: ReadonlyArray<{ file: string; text: string }>): CleanRoomVerdict {
  const hits: string[] = []
  for (const { file, text } of localFiles) {
    if (text.includes(code)) hits.push(file)
  }
  return { contaminated: hits.length > 0, hits }
}

/** 工作项 id → 题目号（`<code>#s<round>-w<n>` / 限流重试后缀 `<code>#<round>-r<n>` 兼容）。 */
export function codeOf(itemId: string): string {
  const match = /^(.+?)#s?\d+/.exec(itemId)
  return match !== null ? match[1]! : itemId
}

/** 轮次取自工作项 id（`<code>#s<round>...`），与账本 seed 无关。 */
export function roundOf(itemId: string): number {
  const match = /#s?(\d+)/.exec(itemId)
  const parsed = match !== null ? Number(match[1]) : 1
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

/** 基础项 id：去掉重试后缀（`-r<n>`），同项重试共用同一基础键。 */
export function baseId(itemId: string): string {
  return itemId.replace(/-r\d+$/, '')
}

/**
 * 从求解器输出里解析 OBSERVATIONS 小节（≤N 条可泛化观察，供题集画像积累）。
 * 不含 flag/题解细节（由主 agent 构建的 prompt 约定保证，解析只做结构提取）。
 */
export function parseObservations(text: string, cap = 5): string[] {
  const section = /OBSERVATIONS\s*[:：]([\s\S]*)$/i.exec(text)
  if (section === null) return []
  const out: string[] = []
  for (const line of section[1]!.split('\n')) {
    const body = line.replace(/^[-*\d.\s]+/, '').trim()
    if (body === '' || body.toLowerCase().includes('flag{')) continue
    out.push(body.slice(0, 200))
    if (out.length >= cap) break
  }
  return out
}

export type ChallengeState = 'solving' | 'complete' | 'failed' | 'skipped'

/** 执行者模型策略：用户/父 agent 的缺省与锁定。 */
export interface ExecutorPolicy {
  /** 未指定时的缺省模型。 */
  defaultModel: string
  /** 未指定时的缺省思考强度。 */
  defaultEffort: string
  /** 锁定：true 时忽略逐项覆盖，强制所有执行者使用缺省模型/强度。 */
  locked: boolean
}

export interface ExecutorResolution {
  model: string
  effort: string
  /** 逐项覆盖被锁定策略强制替换。 */
  overriddenByLock: boolean
}

/**
 * 解析一次派单的执行者模型/强度：
 * 锁定 → 缺省值强制生效（逐项覆盖被忽略并标注）；
 * 未锁定 → 逐项覆盖优先，缺省兜底（主 agent 自主换模型）。
 */
export function resolveExecutor(requested: { model?: string; effort?: string }, policy: ExecutorPolicy): ExecutorResolution {
  if (policy.locked) {
    return {
      model: policy.defaultModel,
      effort: policy.defaultEffort,
      overriddenByLock: (requested.model !== undefined && requested.model !== policy.defaultModel)
        || (requested.effort !== undefined && requested.effort !== policy.defaultEffort),
    }
  }
  return {
    model: requested.model ?? policy.defaultModel,
    effort: requested.effort ?? policy.defaultEffort,
    overriddenByLock: false,
  }
}

export interface ChallengeProgress {
  code: string
  difficulty: string
  state: ChallengeState
  reason?: string
  /** 最近一轮（主 agent 记账）。 */
  rounds: number
  /** 已确认正确的 flag。 */
  flags: string[]
  containerClosed: boolean
}

/** run 进度账（JSONL 快照，崩溃恢复）。 */
export class RunProgress {
  private readonly records = new Map<string, ChallengeProgress>()

  static fromJSON(data: unknown): RunProgress {
    const progress = new RunProgress()
    const records = (data as { challenges?: Array<Partial<ChallengeProgress>> } | undefined)?.challenges ?? []
    for (const record of records) {
      if (record?.code === undefined) continue
      progress.records.set(record.code, {
        code: record.code,
        difficulty: record.difficulty ?? 'unknown',
        state: (record.state ?? 'solving') as ChallengeState,
        reason: record.reason,
        rounds: record.rounds ?? 0,
        flags: record.flags ?? [],
        containerClosed: record.containerClosed ?? false,
      })
    }
    return progress
  }

  static restore(lines: readonly string[]): RunProgress {
    // 从尾到头找最近一条可解析快照（容忍崩溃时的半行/坏行）。
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!
      if (line.trim() === '') continue
      try {
        return RunProgress.fromJSON(JSON.parse(line))
      } catch {
        /* 坏行：继续向前找 */
      }
    }
    return new RunProgress()
  }

  update(code: string, patch: Partial<Omit<ChallengeProgress, 'code'>>): void {
    const current = this.records.get(code) ?? {
      code,
      difficulty: 'unknown',
      state: 'solving' as ChallengeState,
      rounds: 0,
      flags: [],
      containerClosed: false,
    }
    this.records.set(code, { ...current, ...patch, code })
  }

  get(code: string): ChallengeProgress | undefined {
    return this.records.get(code)
  }

  all(): ChallengeProgress[] {
    return [...this.records.values()]
  }

  completedCodes(): string[] {
    return this.all().filter(p => p.state === 'complete').map(p => p.code)
  }

  skippedCodes(): string[] {
    return this.all().filter(p => p.state === 'skipped').map(p => p.code)
  }

  /** 单行 JSONL 快照。 */
  line(): string {
    return JSON.stringify({ at: Date.now(), challenges: this.all() })
  }
}

// ── v7: 附件/容器分类 + 每题知识账本(纯函数, 无 IO——便于单测) ─────

/** v7 附件/容器分类(题面启发式; container 保守兜底——错判只损并行度不损正确性)。 */
export function resourceClassOf(ch: { description?: string }): 'local' | 'container' {
  const t = ch.description ?? ''
  if (/(无需容器|纯附件|附件题|下载附件|attachment|静态文件|本地分析|离线求解|只用\s*(bash|shell|脚本))/i.test(t)) return 'local'
  return 'container'
}

/** 知识账本四节标题(顺序即文件顺序)。 */
export const KNOWLEDGE_SECTION_TITLES = [
  '① 题源思路骨架',
  '② 不可行教训',
  '③ 回收工件',
  '④ 未走分叉',
] as const

export type KnowledgeSection = 'skeleton' | 'dead' | 'artifacts' | 'forks'

/** 小节名 → 文件标题。 */
export function knowledgeSectionTitle(section: KnowledgeSection): string {
  switch (section) {
    case 'skeleton': return KNOWLEDGE_SECTION_TITLES[0]
    case 'dead': return KNOWLEDGE_SECTION_TITLES[1]
    case 'artifacts': return KNOWLEDGE_SECTION_TITLES[2]
    case 'forks': return KNOWLEDGE_SECTION_TITLES[3]
  }
}

/** 四节骨架(文件初始化内容)。 */
export function knowledgeSkeleton(code: string): string {
  return [
    `# ${code} 知识账本`,
    '',
    '> 本题求解的持久记忆: 执行者开工第一件事读本文件, 从已知边界出发。',
    '> ① 由主 agent 维护(xiaochang_knowledge_put); ②③④ 由机制自动累积(report/fork)。',
    '',
    '## ① 题源思路骨架',
    '- (暂无)',
    '',
    '## ② 不可行教训',
    '- (暂无)',
    '',
    '## ③ 回收工件',
    '- (暂无)',
    '',
    '## ④ 未走分叉',
    '- (暂无)',
    '',
  ].join('\n')
}

/** 定位小节区间: 返回 [startLine, endLine) 的行号(0-based 数组索引)。小节不存在返回 undefined。 */
function sectionRange(lines: string[], title: string): [number, number] | undefined {
  const start = lines.findIndex(l => l.startsWith(`## ${title}`))
  if (start < 0) return undefined
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) { end = i; break }
  }
  return [start, end]
}

/**
 * 追加行到指定小节(按行去重, 幂等)。小节缺失时自动补建(追加到文件末尾)。
 * 纯函数: 输入输出都是文本, 不落盘。
 */
export function appendKnowledgeSection(fileText: string, section: KnowledgeSection, entries: string[]): string {
  const title = knowledgeSectionTitle(section)
  const lines = fileText.split('\n')
  const range = sectionRange(lines, title)
  const fresh = entries.filter(e => e.trim() !== '' && !lines.includes(`- ${e}`))
  if (fresh.length === 0) return fileText
  const body = fresh.map(e => `- ${e}`)
  if (range === undefined) {
    // 小节不存在: 文件末尾补 `## 小节` + 条目。
    const out = [...lines]
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    out.push('', `## ${title}`, ...body, '')
    return out.join('\n')
  }
  const [start, end] = range
  const block = lines.slice(start, end)
  // 小节内容 = 去标题与空行后的条目行; 只有占位行时丢弃占位, 否则保留已有条目再追加。
  const content = block.slice(1).filter(l => l.trim() !== '')
  const placeholder = content.length === 1 && content[0] === '- (暂无)'
  const keep = placeholder ? [] : content
  const out = [...lines.slice(0, start + 1), ...keep, ...body, ...lines.slice(end)]
  return out.join('\n')
}

/**
 * 整体改写某小节(upsert): 主 agent 重写 ① 思路骨架用。其余行不动。
 * 小节缺失时补建在文件末尾。
 */
export function replaceKnowledgeSection(fileText: string, section: KnowledgeSection, entries: string[]): string {
  const title = knowledgeSectionTitle(section)
  const lines = fileText.split('\n')
  const body = entries.map(e => `- ${e}`)
  const range = sectionRange(lines, title)
  if (range === undefined) {
    const out = [...lines]
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    out.push('', `## ${title}`, ...body, '')
    return out.join('\n')
  }
  const [start, end] = range
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n')
}

// ── v7.4: hint 时机门禁 + fork 源端去重(纯函数) ─────────────────────

/**
 * hint 放行条件(V1 实锤 180 分教训): 必须已走过 ≥1 次 R2 二次征集(ideaRound≥2)
 * 且该题已有 ≥1 次过滤后失败(供应商故障不计)——hint 是扣分的最后手段, 不是捷径。
 */
export function hintGate(input: { ideaRound: number; filteredFailed: number }): { allowed: boolean; missing: string[] } {
  const missing: string[] = []
  if (input.ideaRound < 2) missing.push(`R2 二次征集未走(当前第 ${input.ideaRound} 轮, 需 ≥2)——先 xiaochang_refanout 加模型再打一轮`)
  if (input.filteredFailed < 1) missing.push('该题尚无过滤后失败(需 ≥1 次真实败绩)——先派执行者打出真实结果')
  return { allowed: missing.length === 0, missing }
}

/** fork 源端去重: 与信箱已有条目按 path 去重——只压重复上报, 不吞真分叉。 */
export function dedupeForkPaths(existingPaths: readonly string[], entries: Array<{ path: string }>): Array<{ path: string }> {
  const seen = new Set(existingPaths)
  const out: Array<{ path: string }> = []
  for (const e of entries) {
    if (seen.has(e.path)) continue
    seen.add(e.path)
    out.push(e)
  }
  return out
}

// ── v7.6: 方向段截断(带反馈信息, 纯函数) ────────────────────────────

export interface TruncateResult {
  text: string
  truncated: boolean
  cutAt: number
  /** 被砍掉的开头片段(反馈给主 agent: 截在哪)。 */
  cutTail: string
}

/**
 * 硬截断方向段: 超 max 截掉尾部并附截点上下文——主 agent 收到截断反馈后
 * 决定是改写短版还是把被砍内容放进知识账本(阈值按 run18728 真局数据: p50≈623)。
 */
export function truncateDirective(text: string, max: number): TruncateResult {
  if (text.length <= max) return { text, truncated: false, cutAt: text.length, cutTail: '' }
  const head = text.slice(0, max)
  const cutTail = text.slice(max, max + 60)
  return { text: `${head}…(方向段已截断)`, truncated: true, cutAt: max, cutTail }
}

// ── v7.8: 开局饱和机制(暖账 fanout / 附件判定 / 下载候选路径, 纯函数) ─────

/** 开局暖账征集 prompt(机制生成, 不靠主 agent 手写)。 */
export function buildWarmupPrompt(ch: { unique_code: string; description?: string; difficulty?: string; total_score?: number }): string {
  return [
    `[开局暖账征集] 题目 ${ch.unique_code}(${ch.difficulty ?? 'unknown'}, ${ch.total_score ?? '?'}分): 只要方向/打点, 不要完整解法。`,
    `题面: ${(ch.description ?? '').slice(0, 800)}`,
    '输出: 2-3 条候选思路, 每条 = 打哪(攻击面) + 为什么可行 + 怎么验证; 注明题目类型判断。',
  ].join('\n')
}

/** 附件题判定(宽松: 描述提到附件/源码文件/下载 → 大概率有本地工件)。 */
export function attachmentLikely(description?: string): boolean {
  return /(附件|源码|源代码|source|下载|\.zip|\.tar|\.gz|\.py\b|\.txt\b|\.png\b|\.pcap\b)/i.test(description ?? '')
}

/** 附件下载候选路径(容器 HTTP 服务的常见约定; 全 miss 时留给执行者手工处理)。 */
export function attachmentFetchCandidates(code: string): string[] {
  const safe = code.replace(/-/g, '')
  return [
    `/att/${code}/`, `/att/${safe}/`, `/attachments/${code}/`, `/files/${code}.zip`,
    `/download/${code}`, `/download`, `/files/`, `/`,
  ]
}

// ── v8.4: 战术模板库 + 家族判定(模板帧注入) ──────────────────────────

export interface FamilyTemplate {
  family: string
  name: string
  /** 成本递增打法(注入 executor frame, 与主 agent directive 并列)。 */
  tactics: string
  /** 判据: 每步"命中才算数"。 */
  criteria: string
  /** 本家族已知过早闭合陷阱(20390 实锤案例)。 */
  traps: string
}

/** 七族模板(v8.4 初稿; 来源 18728 令文打法 + 20390 教训, 见 DESIGN/XIAOCHANG-V8-战术模板库.md)。 */
export const TEMPLATE_LIBRARY: readonly FamilyTemplate[] = [
  {
    family: 'rev-vm',
    name: 'rev·自研VM/字节码保护',
    tactics: '优先绕开 VM, 别一上来全解: ①strings/熵值找明文凭据, 定位 bytecode blob(高熵非代码区); ②宿主层绕过(最高杠杆)——LD_PRELOAD hook printf/puts/write/send 直取凭据, 或 patch VM 校验返回值恒"通过", 自解密型 hook mprotect/mmap dump 运行时内存; ③比较 opcode handler 直读两寄存器(一边常是常量口令); ④兜底才提 opcode 语义表写 lift 脚本。',
    criteria: 'hook 输出里出现 FLAG{/flag{ 才算命中; patch 后任意输入通过且输出变化。',
    traps: 'disasm 里 putc 打字面量 "."、load 被共享尾丢弃 ≠ "坏构建诱饵"——先按预期语义重解释(操作数归属、putc 该打 acc)再判诱饵;"纯诱饵构建"结论必须附已试语义组合清单。',
  },
  {
    family: 'rev-serial',
    name: 'rev·序列号/校验器',
    tactics: '①strings 拿 invalid/denied/granted 串 → 反推输入-校验-输出链; ②LD_PRELOAD hook sscanf/atoi/strcmp/memcmp/puts/printf/write 打印两侧参数(最高杠杆, 一次运行拿期望 SN 与凭据); ③SN 公式反变换(前缀+分段+校验位, 求和取模/CRC 写 Python); ④objdump 搜 movabs/cmp $imm 常量序列拼期望值; ⑤patch 失败分支恒真。',
    criteria: 'hook 打印的期望值代入原程序必须输出 granted/凭据。',
    traps: '沙箱无 gdb——不要写 gdb 断点方案(20390 f2-07 令文犯过)。',
  },
  {
    family: 'rev-license',
    name: 'rev·授权客户端/跨平台',
    tactics: '①先判技术栈(成本差 10 倍): file+strings 分流——.NET(mscoree)→strings 捞 IL 常量; Java(PK..)→zipfile 解 jar; Electron(app.asar)→手解 asar 读 JS 明文; Go(Go build ID)→pclntab。②原生 ELF → LD_PRELOAD hook strcmp/memcmp/sscanf/atoi 打印参数, 或恒返回 0 放行。③license→密钥派生: 找 KDF 常数(PBKDF2/SHA-256 IV/AES S-box)pycryptodome 离线重算。④patch 凭据输出函数为无条件执行。',
    criteria: '重放/打补丁后输出与原样逐字节一致。',
    traps: '先花 10 分钟扫工件预置(license/credential 文件、env、README)——有些题逆向只是烟雾。',
  },
  {
    family: 'web-chain',
    name: 'web·多跳AP链(多旗等权)',
    tactics: '广度优先(等权旗先扫浅层, 每得一旗立即报): ①外网打点 nmap 全端口+指纹+dirsearch 大字典+robots/www.zip/.git/.bak/.sql/前端 JS 注释, 老组件 nday; ②旗1 优先"读文件"类(file/path/id/name 参数、....// 绕过单次 ../ 替换、绝对路径 /challenge/flag*.txt)、备份泄露、弱口令、未授权接口、SQLi; ③shell 后固定侦察: find -iname "*flag*"、grep -rIl "flag{" /var/www /tmp /home /opt、env、/proc/1/environ、/etc/hosts、ip a、ss -lntup; ④内网踩点文件优先: /etc/hosts、~/.ssh/{known_hosts,config}、~/.bash_history、nginx upstream、docker-compose.yml; ⑤建代理(必做): chisel/ligolo-ng/frp/socat 或复用 SSRF/LFI 通道; ⑥内网高频点: Redis 6379 未授权写 authorized_keys/crontab > MySQL 弱口令+secure_file_priv 空写 webshell > Tomcat manager war > SMB/NFS > Jenkins; ⑦核心机密: /data、/opt/secret、DB dump grep flag、跨机分片拼接、响应头/cookie/JWT/log 全查。',
    criteria: '每旗原文+出处双记录; 限速类目标记录封禁行为并遵守节奏约束。',
    traps: '限速/封禁目标的 pacing 是硬约束(看令文节奏约束段), 勿大爆破烧通道; 题面点名的产品名(如泛微OA)要进词表构造。',
  },
  {
    family: 'web-console',
    name: 'web·单机管理台/网关',
    tactics: '①读容器内源码/前端 JS bundle(内联 VITE_*/NEXT_PUBLIC_* 常直接给 token); ②网关/身份层绕过清单(路径规范化变体表、身份头注入表、新旧路由差集); ③JWT 全家(alg=none、RS256→HS256、kid 穿越、弱密钥、旧 token 重放); ④参数名/编码机制边界(含未闭合方括号类变体); ⑤运行时能力矩阵(env/沙箱函数/proc/出网/legacy runtime 差分)。',
    criteria: '身份注入必须"401→200 且 body 随注入值变化"才算命中(防假阳性)。',
    traps: '字段名/编码类"任何 X 都无法存活"的封印结论必须附实测变体清单(20390 a-18 实锤: php[code.execute 未闭合方括号)。',
  },
  {
    family: 'ai-service',
    name: 'ai·推理服务',
    tactics: '①零成本指纹到版本(11434 Ollama /api/version、8000 vLLM /v1/models、Triton /v2/health、8265 Ray /api/jobs/、8080-8082 TorchServe /ping、7860 Gradio、5000 MLflow、8888 Jupyter; openapi.json+Server 头+/metrics 交叉); ②CVE 对号: Ray CVE-2023-48022 未授权提交 job、Ollama /api/pull 路径穿越写 ld.so.preload(<0.1.47)、TorchServe CVE-2023-43654 url SSRF 加载 .mar、MLflow 反序列化; ③优先任意文件读(Gradio /file=、Ollama /api/create FROM /challenge/flag.txt)而非 RCE。',
    criteria: '文件读先 /etc/passwd 打通基线再读旗。',
    traps: '服务 down 不代表题死——先重试/换入口并留证, 别陷入等待轮询。',
  },
  {
    family: 'easy-harvest',
    name: 'easy·收割',
    tactics: '串行清题 + 单题 15 分钟时间盒, 无进展记死路跳下一题。默认凭据/CVE 速查: Langflow /api/v1/validate/code、Dify /console/api/setup 劫持、Open WebUI 首注册即管理员、Neo4j neo4j/neo4j 或未授权 tx/commit、Gremlin 8182 Groovy Runtime.exec、HugeGraph CVE-2024-27348、n8n /rest/owner/setup 接管、若依 admin/admin123、Nacos nacos/nacos、Jenkins/Grafana admin/admin、Shiro rememberMe、Actuator /env+/heapdump、JimuReport 未授权 SSTI、SSH 弱口令小字典。',
    criteria: 'flag 原文+出处; 15 分钟计时从容器就绪起算。',
    traps: '不要恋战; 每应用类型只试一次默认凭据表, 失败即记死路换下一题。',
  },
]

/** 家族自动判定(题面关键词, 主 agent enqueue 可用 family 覆盖)。 */
export function familyOf(description: string, difficulty?: string): string {
  const d = description ?? ''
  const dl = difficulty ?? ''
  if (/(自研.*(VM|执行机制|字节码)|bytecode|虚拟(机|指令)|解释器)/i.test(d)) return 'rev-vm'
  if (/(序列号|serial|校验器|固件.*(校验|授权))/i.test(d)) return 'rev-serial'
  if (/(授权(客户端|逻辑)|license|许可证|跨平台.*(客户端|授权))/i.test(d)) return 'rev-license'
  if (/(OA|官网|内网|横向|APT|多阶段|旗链|渗透测试.*(企业|公司)|核心业务)/i.test(d)) return 'web-chain'
  if (/(管理(控制台|平台|系统)|网关|Serverless|云函数|迁移)/i.test(d)) return 'web-console'
  if (/(AI|推理|模型|Ollama|vLLM|Triton|TorchServe|Ray|Gradio|MLflow|Jupyter|智能)/i.test(d)) return 'ai-service'
  if (dl === 'easy' || /(公司内部|内部系统|请对目标)/i.test(d)) return 'easy-harvest'
  return 'web-console'
}

export function templateOf(family?: string): FamilyTemplate | undefined {
  if (family === undefined) return undefined
  return TEMPLATE_LIBRARY.find(t => t.family === family)
}

// ── v8.4: hint 闸 v2(客观判死 + 主动开闸) ────────────────────────────

/**
 * v8.4 hint 放行条件(客观信号, 不读执行者自述措辞):
 *  - 真实败绩 = settleNoFlag ≥ 1(无旗 settle 一律计, blocker 措辞不豁免)且 ideaRound ≥ 2;
 *  - 或者 blocker 已被验证兵确认(题侧问题坐实, 直接放行);
 *  - 或者 settleNoFlag ≥ 2(两轮真实败绩, 不再等 R2——防 R2 管道自身卡死)。
 */
export function hintGateV2(input: { ideaRound: number; settleNoFlag: number; blockerConfirmed: boolean }): { allowed: boolean; missing: string[] } {
  const missing: string[] = []
  if (input.blockerConfirmed) return { allowed: true, missing: [] }
  if (input.settleNoFlag >= 2) return { allowed: true, missing: [] }
  if (input.ideaRound < 2) missing.push(`R2 二次征集未走(当前第 ${input.ideaRound} 轮)——先 xiaochang_refanout 加模型再打一轮`)
  if (input.settleNoFlag < 1) missing.push('该题尚无真实败绩(无旗 settle ≥1 自动计)——先派执行者打一轮')
  return { allowed: missing.length === 0, missing }
}

// ── v8.4: 死路封印簇检测(翻案兵触发) ─────────────────────────────────

/** 死路方向 = path 首段(冒号/箭头前), 归一化。 */
export function directionOf(path: string): string {
  const m = /^([^:→]+?)(?:[:：]|→|$)/.exec(path.trim())
  return (m?.[1] ?? path).trim().slice(0, 40)
}

/** 同方向 ≥N 条 dead-end 的封印簇。 */
export function sealedClustersOf(deadEnds: Array<{ path: string }>, n = 3): Array<{ direction: string; count: number }> {
  const byDir = new Map<string, number>()
  for (const e of deadEnds) {
    const dir = directionOf(e.path)
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1)
  }
  return [...byDir.entries()].filter(([, count]) => count >= n).map(([direction, count]) => ({ direction, count })).sort((a, b) => b.count - a.count)
}

// ── v8.4: settle 交接"未竟动作"解析(转未走分叉) ───────────────────────

/** 从 settle 终态文本抽取"交接/未竟/下一步"类行, 转成 fork 条目(避免换人/换实例丢临门一脚)。 */
export function parseHandoffForks(detail: string): Array<{ path: string; conclusion: string }> {
  const out: Array<{ path: string; conclusion: string }> = []
  const re = /^(?:[-*•]|\d+[.)])\s*(?:未竟|未完成|待办|下一步|交接|留待|继续要|还没|尚未)(?:动作|事项|:)?\s*(.{6,200})$/gm
  for (const m of detail.matchAll(re)) {
    const line = m[1]!.trim()
    if (line.length === 0 || /^$/.test(line)) continue
    out.push({ path: `交接未竟: ${line.slice(0, 60)}`, conclusion: line })
  }
  return out.slice(0, 5)
}

// ── v8.4: 账本分级条目行(provenance + testedVariants 内联) ────────────

export interface GradedKnowledge {
  kind: 'observation' | 'conclusion' | 'dead-end' | 'fork' | 'flag-path'
  path: string
  conclusion?: string
  evidence?: string
  testedVariants?: string[]
  by: string
  at: number
  /** 同向封印者(死路簇成员, 供翻案兵复核)。 */
  sealedBy?: string[]
}

/** 分级条目 → 账本行(测试清单与来源内联, 保证"结论带过程")。 */
export function gradedLine(e: GradedKnowledge): string {
  const parts = [e.path]
  if (e.conclusion !== undefined && e.conclusion !== '') parts.push(` → ${e.conclusion}`)
  if (e.evidence !== undefined && e.evidence !== '') parts.push(` (证据: ${e.evidence.slice(0, 300)})`)
  if (e.testedVariants !== undefined && e.testedVariants.length > 0) parts.push(` [已试: ${e.testedVariants.join('; ').slice(0, 300)}]`)
  if (e.sealedBy !== undefined && e.sealedBy.length > 0) parts.push(` [同向封印×${e.sealedBy.length}]`)
  parts.push(` [by ${e.by} ${new Date(e.at).toISOString().slice(11, 19)}Z]`)
  return `- ${parts.join('')}`
}
