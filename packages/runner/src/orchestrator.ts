/**
 * 校场 v2 编排核心（纯逻辑，L0 可测）。
 * v2 调度权在主 agent：这里只保留纯机制——clean-room 门禁、工作项 id 解析、
 * OBSERVATIONS 解析（画像积累）、进度账（JSONL 快照/容错恢复）。
 * 思路征集与执行者选择由主 agent 经 jisi_fanout / jisi_model_report 决定。
 * @module @shence/xiaochang-runner/orchestrator
 */

import type { ChallengeInfo } from '../../../src/adapters/tsecbench.ts'

export interface CleanRoomVerdict {
  contaminated: boolean
  hits: string[]
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
