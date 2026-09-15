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
