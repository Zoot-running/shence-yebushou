/**
 * 校场 v2：主 agent 工具集（调度权还给主 agent）。
 * runner 只做四件事：平台六原语、虎符战役执行（入队/派单/收果/剪枝）、
 * 状态与画像落盘、自动记账（超时败绩 + OBSERVATIONS 画像积累）。
 * 判断全归主 agent：何时征集思路（jisi_fanout）、派谁（jisi_model_report）、
 * 交不交卷、何时 finish——runner 提供工具与事实，不替主 agent 做决策。
 * @module @shence/xiaochang-runner
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HintLedger } from '../../../src/hint-ledger.ts'
import { addFact, createProfile, parse as parseProfile, render as renderProfile } from '../../../src/profile.ts'
import { TsecbenchAdapter, type ChallengeInfo, type FetchLike } from '../../../src/adapters/tsecbench.ts'
import { coverageOf } from '../../../src/attack-surfaces.ts'
import {
  RunProgress,
  appendKnowledgeSection,
  baseId,
  cleanRoomGate,
  codeOf,
  dedupeForkPaths,
  hintGate,
  knowledgeSkeleton,
  parseObservations,
  replaceKnowledgeSection,
  resolveExecutor,
  resourceClassOf,
  roundOf,
  sweepLegacyWorkdir,
  truncateDirective,
  type KnowledgeSection,
} from './orchestrator.ts'

export const name = 'shence-xiaochang-runner'
export const inject = ['tools', 'hufu', 'jisi']

/** 难度 → 虎符优先级 tier。 */
function tierOf(difficulty: string): number {
  if (difficulty === 'easy') return 0
  if (difficulty === 'medium') return 1
  if (difficulty === 'hard') return 2
  return 3
}

function nodeFetch(): FetchLike {
  return async (url, init = {}) => {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
    })
    return {
      ok: res.ok,
      status: res.status,
      json: async () => await res.json(),
    }
  }
}

/** 虎符服务面（最小类型面）。 */
interface HufuLike {
  add(item: { id: string; label: string; model?: string; reasoningEffort?: string; priority?: { tier: number; score: number }; dependsOn?: string[]; board?: string; resourceClass?: string }): void
  freeSlots(): number
  nextQueued(): unknown[]
  dispatchNext(): Promise<unknown>
  report(itemId: string, kind: 'done' | 'failed' | 'blocked', detail?: string): void
  onSettle?(listener: (event: { itemId: string; status: string; text: string }) => void): () => void
  recordKnowledge?(itemId: string, entries: Array<{ kind: string; path: string; conclusion?: string; evidence?: string; by?: string; at?: number }>): void
  knowledgeOf?(itemId: string): Array<{ kind: string; path: string; conclusion?: string; evidence?: string; by?: string; at?: number }>
  cancel(itemId: string, reason: string): void
  boardPath(group: string): string
  isComplete(): boolean
  /** v7 类闸可见性：每资源类 {open, limit}。 */
  classUsage?(): Record<string, { open: number; limit: number }>
  /** v7.5: 中止某在途项的执行者进程(剪枝/超时判负时真杀)。 */
  interruptItem?(itemId: string): Promise<void>
  ledger: {
    views(): Array<{ item: { id: string; model?: string }; state: string; seed: number; terminalDetail?: string; dispatchedAt?: number; lastProgressAt?: number }>
  }
}

/** 虎符宿主服务面（createCampaign 稳定 id 幂等恢复 + finish 归档）。 */
interface HufuHolderLike {
  createCampaign(p: unknown, c: object, items: unknown[], opts?: { id?: string }): { id: string; campaign: HufuLike }
  finish?(id: string): void
  onSettle?(id: string, listener: (event: { itemId: string; status: string; text: string }) => void): () => void
  recordKnowledge?(id: string, itemId: string, entries: Array<{ kind: string; path: string; conclusion?: string; evidence?: string; by?: string; at?: number }>): void
  knowledgeOf?(id: string, itemId: string): Array<{ kind: string; path: string; conclusion?: string; evidence?: string; by?: string; at?: number }>
  /** v7.6: 虎符通用竞争资源队列原语(canGrant/grant 由使用方注入)。 */
  resourceQueue?(config: {
    capacity: number
    canGrant(): Promise<boolean>
    grant?(holderId: string): Promise<void>
    pollMs?: number
    defaultTimeoutMs?: number
  }): {
    acquire(holderId: string, opts?: { timeoutMs?: number }): Promise<{ status: 'granted' | 'timeout' | 'evicted'; position?: number; reason?: string }>
    release(): Promise<void>
    evict(holderId: string, reason: string): boolean
    waiters(): Array<{ holderId: string; position: number }>
  }
}

/** 集思服务面（能力账本；fanout 由主 agent 经 jisi_fanout 工具调用）。 */
interface JisiLike {
  ledger: {
    record(model: string, dimension: 'execution' | 'idea', key: string, win: boolean): void
  }
  /** 模型目录（含 provider 归属）；enqueue 用其校验模型可派。 */
  listModels(): Promise<Array<{ id: string; provider: string }>>
  /** F35: 模型所属 provider 是否余额枯竭隔离(来自集思 sidecar)。 */
  isModelQuarantined?(model: string): Promise<boolean>
  /** v2: 加权入账(第 1 层)。 */
  recordV2?(r: { model: string; dimension: 'execution' | 'idea'; qtype: string; difficulty: number; weight: number; win: boolean; attribution?: string; note?: string }): void
  /** v2: 终局对账(采纳思路, 第 0 层)。 */
  settleAdoptions?(code: string, win: boolean, attribution: string | undefined): void
  /** v2: 契合度排名(第 2 层), 供 refanout 选模。 */
  pickRank?(qtype: string, difficulty: number, dimension: 'execution' | 'idea'): Promise<Array<{ model: string; thompson: number; mean: number; n: number }>>
  /** v2: fanout 发兵(notify 语义), 供 refanout 一键 R2。 */
  fanoutNotify?(parent: unknown, work: { prompt: string }, models: string[], opts?: Record<string, unknown>): { id: string; models: string[] }
  /** v2: 升级状态(采纳累计/已死)。 */
  adoptionStats?(code: string): { adopted: number; dead: number }
  /** v6: 停止规则裁决(序贯弃权)。 */
  judge?(input: { troops: number; filteredFailed: number; noProgressMin: number; difficulty: number; coverageRatio: number; remainingPoints: number; modelExhaustion: number; r2Count: number }): { action: 'continue' | 'escalate' | 'judge-dead'; reasons: string[] }

}

interface SetupArgs {
  baseURL?: string
  benchmarkToken?: string
  runBearerToken?: string
  runId?: number
  concurrency?: number
  budgetMinutes?: number
  roundTimeoutMinutes?: number
  maxHintsPerChallenge?: number
  knowledgeDir?: string
  profilePath?: string
  vpnGateway?: string
  /** 执行者缺省模型（未指定时）。 */
  defaultModel?: string
  /** 执行者缺省思考强度（未指定时）。 */
  defaultEffort?: string
  /** 模型锁：true = 强制所有执行者使用缺省模型/强度（用户/父 agent 锁定选项）。 */
  modelLock?: boolean
  /** v7: 容器题并发槽位(平台容器上限)。默认 3。 */
  containerSlots?: number
}

/** 每题 v2 状态(第 0/3 层)。 */
interface V2Question {
  qtype: string
  /** 校准后难度(0-100)。 */
  difficulty: number
  wins: number
  fails: number
  gaps: string[]
  triedModels: string[]
  ideaRound: number
  deadIdeas: number
  adopted: number
  lastVerdict?: string
  /** v6: 末段自动 R2 已发(防重复)。 */
  autoR2?: boolean
}
type V2State = Record<string, V2Question>

/** 题型粗分类(题面关键词启发式; misc 兜底)。 */
function classifyQtype(text: string): string {
  const t = text.toLowerCase()
  if (/(web|http|ssrf|xss|sqli?|csrf|javascript|php|flask|django|server|登录|接口|上传|rce.*web)/.test(t)) return 'web'
  if (/(rsa|aes|crypto|密文|加密|解密|elliptic|ecc|hash|padding)/.test(t)) return 'crypto'
  if (/(pwn|overflow|shellcode|rop|ret2|heap|栈|溢出|binary|elf|got)/.test(t)) return 'pwn'
  if (/(reverse|reversing|反编译|汇编|disassemble|ida|ghidra|逆向)/.test(t)) return 'rev'
  if (/(forensic|取证|pcap|流量|内存|disk|文件系统)/.test(t)) return 'forensics'
  return 'misc'
}

/** 难度先验映射(宿主层: 平台分 → 0-100)。 */
function difficultyPrior(score: number): number {
  return Math.min(100, Math.round(100 * (1 - Math.exp(-score / 600))))
}

/** 终局校准(贝叶斯, 归因门控在调用方)。 */
function calibrateDifficulty(q: { difficulty: number; wins: number; fails: number }): number {
  const k = 5
  const p0 = 1 - q.difficulty / 100
  const a = p0 * k + q.wins
  const b = (1 - p0) * k + q.fails
  return Math.round(100 * (1 - a / (a + b)))
}

interface CampaignState {
  baseURL: string
  benchmarkToken: string
  runBearerToken?: string
  runId?: number
  concurrency: number
  budgetMs: number
  roundTimeoutMs: number
  maxHints: number
  vpnGateway: string
  knowledgeDir: string
  profilePath: string
  snapshotPath: string
  auditPath: string
  startedAt: number
  adapter: TsecbenchAdapter
  progress: RunProgress
  profile: import('../../../src/profile.ts').OrgProfile
  hintLedger: HintLedger
  /** v2 决策内核状态(第 0/3 层): 每题 qtype/难度/缺口/已试模型/思路轮/死思路数。 */
  v2: V2State
  v2Path: string
  processed: Set<string>
  challenges: Map<string, ChallengeInfo>
  executorPolicy: ExecutorPolicy
  /** v7: 容器题并发槽位(平台容器上限)。 */
  containerSlots: number
  /** v7.4: 平台权威累计分(submit 回执的 cumulative_score)——满分判定以此为准, 不自算。 */
  platformScore?: number
  /** v7.6: 容器资源队列(虎符原语, 校场注入平台判定)。 */
  containerQueue?: Awaited<ReturnType<NonNullable<HufuHolderLike['resourceQueue']>>>
}

let state: CampaignState | undefined
let heartbeatTimer: ReturnType<typeof setInterval> | undefined

function requireState(): CampaignState {
  if (state === undefined) throw new Error('xiaochang: not set up — call xiaochang_setup first')
  return state
}

/** v7.1 终态抑制: progress 已终态(complete/failed/skipped) → 迟到 fork 只存档、不唤醒、不派兵。 */
function progressTerminal(code: string): boolean {
  try {
    const p = state?.progress.get(code)
    return p !== undefined && (p.state === 'complete' || p.state === 'failed' || p.state === 'skipped')
  } catch { return false } // 执行者会话无 state: 终态判定留给主 agent 的 wait 侧
}

function audit(path: string, line: object): void {
  try {
    appendFileSync(path, `${JSON.stringify(line)}\n`)
  } catch { /* 审计失败不影响主流程 */ }
}

/** v6: 读取供应商故障窗口 sidecar(dsh-compat 写, 纯文件通道)。 */
function readOutageWindows(): Array<{ provider: string; from: number; to: number | null }> {
  try {
    const p = join(process.env.DSH_HOME ?? '.', 'storages', 'provider-outages.jsonl')
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8').split('\n').filter(l => l.trim() !== '')
      .map(l => { try { return JSON.parse(l) as { provider: string; from: number; to: number | null } } catch { return null } })
      .filter((r): r is { provider: string; from: number; to: number | null } => r !== null)
  } catch { return [] }
}

/** v6: 该 code 的过滤失败计数——剔除故障窗口内与 provider 错误签名的失败(DS 故障夜实锤)。 */
function filteredFailedOf(code: string, campaign: HufuLike | undefined): { failed: number; excluded: number; excludedReasons: string[] } {
  const windows = readOutageWindows()
  let failed = 0
  let excluded = 0
  const excludedReasons: string[] = []
  for (const v of campaign?.ledger.views() ?? []) {
    if (v.state !== 'failed' || codeOf(v.item.id) !== code) continue
    const detail = v.terminalDetail ?? ''
    const provErr = /(TRANSPORT|MISSING_CREDENTIAL|rate limit|insufficient|余额|no API key)/i.test(detail)
    const inOutage = windows.some(w => {
      const at = v.lastProgressAt ?? 0
      return at >= w.from && (w.to === null || at <= w.to)
    })
    if (provErr || inOutage) {
      excluded += 1
      if (provErr) excludedReasons.push('provider错误签名')
      if (inOutage) excludedReasons.push('故障窗口内')
    } else {
      failed += 1
    }
  }
  return { failed, excluded, excludedReasons }
}

function persistV2(s: CampaignState): void {
  try { writeFileSync(s.v2Path, JSON.stringify(s.v2)) } catch { /* 落盘失败不致命 */ }
}

function persistProgress(s: CampaignState): void {
  try {
    mkdirSync(join(s.snapshotPath, '..'), { recursive: true })
    appendFileSync(s.snapshotPath, `${s.progress.line()}\n`)
  } catch { /* 落盘失败不致命 */ }
}

function persistProfile(s: CampaignState): void {
  try {
    mkdirSync(join(s.profilePath, '..'), { recursive: true })
    writeFileSync(s.profilePath, renderProfile(s.profile))
  } catch { /* 落盘失败不致命 */ }
}

/** 平台容器槽位：最多 3 个可用/启动中的容器。 */
function openContainers(s: CampaignState): Set<string> {
  const open = new Set<string>()
  for (const c of s.challenges.values()) {
    if (c.container_status === 'available' || c.container_status === 'pending') open.add(c.unique_code)
  }
  return open
}

/** 战役活跃项计数。 */
function openCount(campaign: HufuLike): number {
  return campaign.ledger.views().filter(v => v.state === 'dispatched' || v.state === 'help' || v.state === 'stalled').length
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** 轻量扫 cwd 遗留（pre-run sweep 兜底）：题号工件（g-*）与旧战报 FINDINGS.md，mtime 早于 startedAt。 */
function scanLegacyCwd(cwd: string, startedAt: number): string[] {
  const out: string[] = []
  const consider = (full: string): void => {
    try {
      if (statSync(full).mtimeMs < startedAt) out.push(full)
    } catch { /* 忽略 */ }
  }
  try {
    for (const name of readdirSync(cwd)) {
      if (!/^g[-_]?\d/.test(name) && name !== 'boards') continue
      const full = join(cwd, name)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        if (name === 'boards') {
          // 只看各组的 FINDINGS.md（跨 run 战报泄漏面）。
          for (const entry of readdirSync(full)) {
            const nested = join(full, entry)
            try {
              if (statSync(nested).isDirectory()) {
                for (const inner of readdirSync(nested)) {
                  if (inner === 'FINDINGS.md') consider(join(nested, inner))
                }
              }
            } catch { /* 忽略 */ }
          }
        } else {
          for (const file of walk(full)) {
            if (file.endsWith('.md') || file.endsWith('.txt') || file.endsWith('.py') || file.endsWith('.json') || file.endsWith('.html') || file.endsWith('.sh')) consider(file)
          }
        }
      } else {
        consider(full)
      }
    }
  } catch { /* 忽略 */ }
  return out
}

export function apply(ctx: Context): void {
  const jisi = (ctx as unknown as { get?: (name: string) => unknown }).get?.('jisi') as JisiLike | undefined
  const holder = (ctx as unknown as { hufu: HufuHolderLike }).hufu
  let campaign: HufuLike | undefined
  let campaignId: string | undefined
  let parentAgent: { followup(message: unknown): void } | undefined

  // F15+F23：审计心跳在插件装载层启动（每次进程 boot 都生效），不依赖 setup——
  // resumed 化身可能不重调 setup，绑 setup 会造成守护链误杀（run 7 02:28 实锤：
  // 分析 10 分钟无活动行 → guard 判假死）。
  heartbeatTimer = setInterval(() => {
    const home = process.env.DSH_HOME ?? '.'
    audit(join(home, 'storages', 'xiaochang-run-audit.jsonl'), { type: 'heartbeat', at: Date.now() })
  }, 120_000)
  ;(heartbeatTimer as { unref?: () => void }).unref?.()

  const c = (): HufuLike => {
    if (campaign === undefined) throw new Error('xiaochang: not set up — call xiaochang_setup first')
    return campaign
  }

  // ── F33 知识账本 helpers（apply 闭包内——campaign/campaignId/holder 都在这层作用域）──
  type KnowledgeIn = { kind: string; path: string; conclusion?: string; evidence?: string; by?: string; at?: number }
  // ── F33 ②b 分叉信箱: 执行者跨会话上报的可靠通道(盘文件, 主 agent 的
  //    xiaochang_wait 轮询该目录变化唤醒; 主 agent 读图时吸收进账本并归档)。
  //    设计缘由(run 17891 实锤): 执行者会话与主会话不在同一插件实例——
  //    in-memory campaign/parentAgent.followup 均不可达主 agent;
  //    而盘文件是本沙箱唯一跨会话/跨进程都可靠的信道(settle 走主进程 await)。
  const forkInboxDir = (): string => join(process.env.DSH_HOME ?? '.', 'storages', 'xiaochang-fork-inbox')
  function readForkInbox(code: string): KnowledgeIn[] {
    const p = join(forkInboxDir(), `${code}.jsonl`)
    if (!existsSync(p)) return []
    const out: KnowledgeIn[] = []
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try { out.push(JSON.parse(line) as KnowledgeIn) } catch { /* 坏行跳过 */ }
    }
    return out
  }
  function writeForkInbox(code: string, entries: KnowledgeIn[]): string {
    mkdirSync(forkInboxDir(), { recursive: true })
    const p = join(forkInboxDir(), `${code}.jsonl`)
    appendFileSync(p, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
    return p
  }
  /** 主 agent 侧: 信箱条目并入知识账本(去重幂等)并归档文件。 */
  function absorbForkInbox(code: string): void {
    const p = join(forkInboxDir(), `${code}.jsonl`)
    if (!existsSync(p)) return
    const entries = readForkInbox(code)
    if (entries.length > 0) {
      const seen = new Set<string>()
      for (const v of campaign?.ledger.views() ?? []) {
        if (codeOf(v.item.id) !== code) continue
        for (const k of campaign?.knowledgeOf?.(v.item.id) ?? []) {
          seen.add(`${(k as KnowledgeIn).path}#${(k as KnowledgeIn).at ?? 0}`)
        }
      }
      const fresh = entries.filter(e => !seen.has(`${e.path}#${e.at ?? 0}`))
      if (fresh.length > 0) {
        for (const v of campaign?.ledger.views() ?? []) {
          if (codeOf(v.item.id) !== code) continue
          try { holder.recordKnowledge?.(campaignId ?? '', v.item.id, fresh) } catch { /* 吸收失败不阻断 */ }
        }
        // v7: 吸收同时补写知识账本文件 ④(跨会话执行者上报的分叉在此落文件)。
        try {
          appendKnowledgeFile(code, 'forks', fresh.map(k => `${k.path}${k.conclusion !== undefined ? ' → ' + k.conclusion : ''}${k.evidence !== undefined ? ' (证据: ' + k.evidence + ')' : ''}`))
        } catch { /* 账本文件失败不阻断 */ }
      }
    }
    try { renameSync(p, `${p}.absorbed-${Date.now()}`) } catch { /* 归档失败不阻断 */ }
  }
  /** 把该 code 的全部 item 知识聚合(跨尝试累积)+ 盘上未吸收的分叉信箱。 */
  function knowledgeOfCode(code: string): KnowledgeIn[] {
    const out: KnowledgeIn[] = []
    if (campaign !== undefined) {
      for (const v of campaign.ledger.views()) {
        if (codeOf(v.item.id) !== code) continue
        const k = campaign.knowledgeOf?.(v.item.id) ?? []
        out.push(...k as KnowledgeIn[])
      }
    }
    out.push(...readForkInbox(code))
    return out
  }
  /** 把知识写入该 code 的全部已有 item。 */
  function recordKnowledgeOnCode(code: string, entries: KnowledgeIn[]): void {
    if (campaign === undefined || campaignId === undefined) return
    for (const v of campaign.ledger.views()) {
      if (codeOf(v.item.id) !== code) continue
      try { holder.recordKnowledge?.(campaignId, v.item.id, entries) } catch { /* 知识落账失败不阻断调度 */ }
    }
  }
  // ── v7 每题知识账本文件(四节: ①主 agent 写, ②③④机制自动累积) ──────
  // 与 FINDINGS.md 同目录; 执行者 bash 直读, 无需工具; 重试零重复识别。
  const knowledgeFilePath = (code: string): string => join(dirname(c().boardPath(code)), 'KNOWLEDGE.md')
  function ensureKnowledgeFile(code: string): string {
    const p = knowledgeFilePath(code)
    try {
      if (!existsSync(p)) {
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, knowledgeSkeleton(code))
      }
    } catch { /* 账本初始化失败不阻断调度 */ }
    return p
  }
  /** 账本追加(按行去重幂等); 执行者会话无战役 → no-op(靠信箱, 主 agent 吸收时写)。 */
  function appendKnowledgeFile(code: string, section: KnowledgeSection, entries: string[]): void {
    if (campaign === undefined) return
    const p = ensureKnowledgeFile(code)
    try {
      const text = readFileSync(p, 'utf8')
      const next = appendKnowledgeSection(text, section, entries)
      if (next !== text) writeFileSync(p, next)
    } catch { /* 追加失败不阻断 */ }
  }
  /** 账本改写(主 agent 重写 ① 思路骨架)。 */
  function replaceKnowledgeFile(code: string, section: KnowledgeSection, entries: string[]): void {
    if (campaign === undefined) return
    const p = ensureKnowledgeFile(code)
    try {
      writeFileSync(p, replaceKnowledgeSection(readFileSync(p, 'utf8'), section, entries))
    } catch { /* 改写失败不阻断 */ }
  }
  /** restore/迁移兜底: 把账本(虎符 knowledge + 分叉信箱)里已有的条目镜像进文件(行去重幂等)。 */
  function syncKnowledgeFileFromLedger(code: string): void {
    if (campaign === undefined) return
    const buckets: Record<'dead' | 'artifacts' | 'forks', string[]> = { dead: [], artifacts: [], forks: [] }
    for (const k of knowledgeOfCode(code)) {
      const text = `${k.path}${k.conclusion !== undefined ? ' → ' + k.conclusion : ''}${k.evidence !== undefined ? ' (证据: ' + k.evidence + ')' : ''}`
      if (k.kind === 'dead-end') buckets.dead.push(text)
      else if (k.kind === 'fork') buckets.forks.push(text)
      else buckets.artifacts.push(text)
    }
    for (const section of ['dead', 'artifacts', 'forks'] as const) {
      if (buckets[section].length > 0) appendKnowledgeFile(code, section, buckets[section])
    }
  }

  // ── v7 极简执行令框架: 主 agent 只写指令, 机制注入题面/入口/账本/画像/纪律 ──
  function buildExecFrame(code: string, directive: string): string {
    const s = requireState()
    const ch = s.challenges.get(code)
    if (ch === undefined) return directive
    const cls = resourceClassOf(ch)
    const addrs = ch.container_addr.length > 0
      ? ch.container_addr.join(',')
      : cls === 'local'
        ? '无需容器(本地求解: bash/python 直开)'
        : '容器未开: 请主 agent xiaochang_start_container, 或你自行调用(平台同时最多 3 个容器)'
    const kn = ensureKnowledgeFile(code)
    return [
      `【校场执行令 · ${code}】(${cls === 'local' ? '附件题·全并行' : '容器题·3槽轮换'}, ${ch.difficulty}, ${ch.total_score}pts, ${ch.flag_count} flags)`,
      `题面: ${(ch.description ?? '').slice(0, 1200)}`,
      `入口: ${addrs}`,
      `共享战报: ${c().boardPath(code)}`,
      `知识账本(开工必读): ${kn}`,
      `画像(快速读): ${s.profilePath}`,
      `你的任务: ${directive}`,
      '纪律: ①先读知识账本, 从已知边界出发, 不重复死路, 优先用回收工件;',
      '      ②找到 flag 立即输出 FLAG_CANDIDATE: <flag>(主 agent 负责提交);',
      '      ③死路/新分叉调 xiaochang_fork 上报; 终态前把死路原因写清。',
    ].join('\n')
  }

  const register = (tool: object): void => ctx.tools.register(tool as never)

  // ── setup：建/续战役 ──────────────────────────────────────────────
  register(defineTool({
    name: 'xiaochang_setup',
    description:
      'Set up (or resume) the tsecbench campaign state: platform adapter, hufu campaign (large slots, no artificial threshold), progress/profile restore. Idempotent — calling again resumes from the snapshot.',
    parameters: {
      baseURL: { type: 'string', description: 'BENCHMARK_BASE_URL (defaults to env).' },
      benchmarkToken: { type: 'string', description: 'BENCHMARK_TOKEN (defaults to env).' },
      runBearerToken: { type: 'string', description: 'Platform session Bearer token for early finish (stop the ranking clock). Falls back to env RUN_BEARER_TOKEN — but pass it explicitly when the order gives it (env fallback only saves you if omitted).' },
      runId: { type: 'number', description: 'Platform run id.' },
      concurrency: { type: 'number', description: 'Campaign slots. Default 999 (no artificial threshold; backpressure = CPU/RAM/provider limits only).' },
      budgetMinutes: { type: 'number', description: 'Wall-clock budget. Default 330.' },
      roundTimeoutMinutes: { type: 'number', description: 'Auto-report a dispatched item as failed after this long. Default 30.' },
      maxHintsPerChallenge: { type: 'number', description: 'Official hints per challenge (10% score each). Default 1.' },
      knowledgeDir: { type: 'string', description: 'Local private knowledge dir for the clean-room gate.' },
      profilePath: { type: 'string', description: 'Org-profile file path.' },
      vpnGateway: { type: 'string', description: 'VPN gateway health URL. Default http://10.0.100.58.' },
      defaultModel: { type: 'string', description: 'Executor default model when an item omits one. Default deepseek-v4-flash (you may set a per-run default that fits this run).' },
      defaultEffort: { type: 'string', description: 'Executor default reasoning effort. Default low.' },
      modelLock: { type: 'boolean', description: 'Lock: force ALL executors to defaultModel/defaultEffort, ignoring per-item overrides (user/parent-agent override). Default false (main agent may switch models per item).' },
      containerSlots: { type: 'number', description: 'v7 container-challenge concurrency slots (platform container cap). Default 3; attachment challenges are never constrained by this.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: SetupArgs, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('xiaochang_setup requires a calling agent')
      parentAgent = agent
      const env = process.env
      const baseURL = args.baseURL ?? env.BENCHMARK_BASE_URL
      const benchmarkToken = args.benchmarkToken ?? env.BENCHMARK_TOKEN
      if (baseURL === undefined || benchmarkToken === undefined) {
        return 'xiaochang_setup: BENCHMARK_BASE_URL and BENCHMARK_TOKEN required (args or env)'
      }
      const home = env.DSH_HOME ?? '.'
      // F24 按 run 隔离进度快照：跨 run 共用单一文件会把上一 run 的进度/画像
      // 恢复进新 run（run 8 实锤：setup 恢复出 run 7 的"全 40 题已完成"假进度）。
      const snapshotPath = join(home, 'storages', `xiaochang-run-${args.runId ?? 'pending'}.jsonl`)
      // 恢复：快照存在则续跑（预算起点沿用首条快照时间）。
      let progress = new RunProgress()
      let startedAt = Date.now()
      if (existsSync(snapshotPath)) {
        const lines = readFileSync(snapshotPath, 'utf8').split('\n').filter(l => l.trim() !== '')
        progress = RunProgress.restore(lines)
        const first = lines.length > 0 ? (JSON.parse(lines[0]!) as { at: number }).at : undefined
        if (first !== undefined) startedAt = first
      }
      // F30：setup 清旧守卫标记（防止上一进程残留标记误导 hosted-guard standing down）。
      try {
        const markerPath = process.env.GUARD_MARKER ?? join(process.cwd(), '.campaign-finished')
        if (existsSync(markerPath)) { const fs = await import('node:fs'); fs.unlinkSync(markerPath) }
      } catch { /* 忽略 */ }
      const s: CampaignState = {
        baseURL,
        benchmarkToken,
        // run 11 实锤：开战令写"工具会从进程环境读取"，但旧实现 runBearerToken 无 env 回退，
        // agent 省略传参 → finish 静默跳过平台停表 → 排名钟空转。补 env 回退（launch 脚本
        // 导出 RUN_BEARER_TOKEN；沙箱只挡 agent 的 bash 视图，插件进程 env 可见）。
        runBearerToken: args.runBearerToken ?? env.RUN_BEARER_TOKEN,
        runId: args.runId,
        concurrency: args.concurrency ?? 999,
        budgetMs: (args.budgetMinutes ?? 330) * 60_000,
        roundTimeoutMs: (args.roundTimeoutMinutes ?? 30) * 60_000,
        maxHints: args.maxHintsPerChallenge ?? 1,
        vpnGateway: args.vpnGateway ?? 'http://10.0.100.58',
        knowledgeDir: args.knowledgeDir ?? join(home, 'storages', 'xiaochang-knowledge'),
        profilePath: args.profilePath ?? join(home, 'storages', 'xiaochang-profile.md'),
        snapshotPath,
        auditPath: join(home, 'storages', 'xiaochang-run-audit.jsonl'),
        startedAt,
        adapter: new TsecbenchAdapter({ baseURL, benchmarkToken, vpnGateway: args.vpnGateway ?? 'http://10.0.100.58' }, nodeFetch()),
        progress,
        profile: createProfile('tsecbench-set'),
        hintLedger: new HintLedger(),
        v2: {},
        v2Path: join(home, 'storages', `xiaochang-v2-${args.runId ?? 'pending'}.json`),
        processed: new Set(),
        challenges: new Map(),
        executorPolicy: {
          defaultModel: args.defaultModel ?? 'deepseek-v4-flash',
          defaultEffort: args.defaultEffort ?? 'low',
          locked: args.modelLock ?? false,
        },
        containerSlots: args.containerSlots ?? 3,
        platformScore: undefined,
      }
      try {
        if (existsSync(s.profilePath)) s.profile = parseProfile(readFileSync(s.profilePath, 'utf8'))
      } catch { /* 画像损坏：空画像 */ }
      state = s
      // 稳定 campaignId：跨进程崩溃/重启幂等恢复（虎符快照），prompt 本体不丢（F18）。
      const stableId = `tsecbench-run-${args.runId ?? 'pending'}`
      // F5/F6 机制化：pre-run sweep——把早于本 run 开始时间的题号工件与旧 run 战报
      // 移入 cwd/.archive/<campaignId>/（靠配置隔离，不靠手工清扫）。
      const swept = sweepLegacyWorkdir(process.cwd(), s.startedAt, `.archive/${stableId}`)
      // F25：VPN 健康检查必须在注册战役之前——否则 setup 失败重试会撞
      // "campaign id already registered"（run 8 实锤：首调在 VPN 起来前注册了空战役，
      // 二调直接报错无法恢复）。检查不通过时什么都不注册，随时可安全重试。
      if (!(await s.adapter.gatewayHealthy())) {
        return 'xiaochang_setup: VPN gateway not healthy — connect the run VPN first (nothing registered; safe to retry)'
      }
      const fresh = await s.adapter.listChallenges()
      for (const ch of fresh) s.challenges.set(ch.unique_code, ch)
      // F25b：同进程幂等——进程内重复 setup 复用已建战役，不二次注册。
      if (campaign === undefined) {
        const created = holder.createCampaign(agent, {
          concurrency: s.concurrency,
          stallAfterMs: s.roundTimeoutMs + 10 * 60_000,
          heartbeatMs: 15 * 60_000,
          budgetMs: s.budgetMs,
          // v7 类闸: 容器题受平台容器上限(默认 3), 附件题全并行(继承全局 concurrency)。
          resourceLimits: { container: args.containerSlots ?? 3, local: s.concurrency },
        }, [], { id: stableId, boardNamespace: `${args.runId ?? 'pending'}` })
        campaign = created.campaign
        campaignId = created.id
      }
      // v7.6: 容器资源队列——虎符原语管排队/公平/单一授权点, 校场注入平台判定与 start 动作。
      // 执行者 start_container 阻塞在 acquire 上(零 token), 不再 LLM 热轮询; 同 code 合并等待位(共享容器)。
      if (s.containerQueue === undefined && holder.resourceQueue !== undefined) {
        s.containerQueue = holder.resourceQueue({
          capacity: s.containerSlots,
          pollMs: 3000,
          defaultTimeoutMs: 5 * 60_000,
          canGrant: async () => {
            try {
              const fresh = await s.adapter.listChallenges()
              for (const x of fresh) s.challenges.set(x.unique_code, x)
              return openContainers(s).size < s.containerSlots
            } catch { return false }
          },
          grant: async (code: string) => {
            const ch = s.challenges.get(code)
            // 同题先到者已开/正在开 → 不重复 start(共享容器)。
            if (ch !== undefined && ch.container_status === 'available' && ch.container_addr.length > 0) return
            if (ch !== undefined && ch.container_status === 'pending') return
            await s.adapter.start(code)
            const fresh = await s.adapter.listChallenges()
            for (const x of fresh) s.challenges.set(x.unique_code, x)
            s.progress.update(code, { difficulty: ch?.difficulty ?? 'medium', containerClosed: false })
            persistProgress(s)
            audit(s.auditPath, { type: 'container-start', code })
          },
        })
      }
      persistProgress(s)
      try {
        if (existsSync(s.v2Path)) s.v2 = JSON.parse(readFileSync(s.v2Path, 'utf8')) as V2State
        for (const ch of fresh) {
          if (s.v2[ch.unique_code] === undefined) {
            s.v2[ch.unique_code] = {
              qtype: classifyQtype(ch.description ?? ''),
              difficulty: difficultyPrior(ch.total_score),
              wins: 0, fails: 0, gaps: [], triedModels: [], ideaRound: 1, deadIdeas: 0, adopted: 0,
            }
          }
        }
      } catch { /* v2 状态损坏: 重建 */ }
      return `xiaochang_setup ok: ${fresh.length} challenges, concurrency=${s.concurrency} (no threshold), containerSlots=${args.containerSlots ?? 3}, budget ${Math.round(s.budgetMs / 60000)}min, resume=${progress.all().length > 0}, campaign=${campaignId ?? stableId}, swept=${swept}`
    },
  }))

  // ── list：题目 + 进度 + clean-room ─────────────────────────────────
  register(defineTool({
    name: 'xiaochang_list',
    description:
      'List platform challenges with progress and clean-room verdicts. Auto-marks challenges skipped when the local knowledge dir mentions their code (hosted-rules gate). Returns per-challenge: code, difficulty, score, flag_count, completed, container_status, addrs, description, and progress state.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute() {
      const s = requireState()
      const fresh = await s.adapter.listChallenges()
      for (const ch of fresh) s.challenges.set(ch.unique_code, ch)
      // clean-room 门禁：本地私知里出现该题号 → 弃权。
      // 扫描面（F5 扩扫）：knowledgeDir 全部 + cwd 中早于本 run 开始时间的遗留工件
      // （pre-run sweep 的兜底：漏网的上 run 题号目录/战报也算污染；本 run 自己的工件不受影响）。
      const localFiles: Array<{ file: string; text: string }> = []
      if (existsSync(s.knowledgeDir)) {
        for (const file of walk(s.knowledgeDir)) {
          try { localFiles.push({ file, text: readFileSync(file, 'utf8') }) } catch { /* 非文本 */ }
        }
      }
      const legacyWorkdirFiles = scanLegacyCwd(process.cwd(), s.startedAt)
      for (const file of legacyWorkdirFiles) {
        try { localFiles.push({ file, text: readFileSync(file, 'utf8') }) } catch { /* 非文本 */ }
      }
      for (const ch of fresh) {
        if (s.progress.get(ch.unique_code) !== undefined) continue
        const verdict = cleanRoomGate(ch.unique_code, localFiles)
        if (verdict.contaminated) {
          s.progress.update(ch.unique_code, { difficulty: ch.difficulty, state: 'skipped', reason: `clean-room: local knowledge mentions ${ch.unique_code}`, containerClosed: true })
        }
      }
      persistProgress(s)
      const score = s.adapter.scoreOf(fresh)
      const rows = fresh.map(ch => {
        const p = s.progress.get(ch.unique_code)
        const cls = resourceClassOf(ch)
        return `${ch.unique_code} [${ch.difficulty}·${cls === 'local' ? '附件' : '容器'}] ${ch.total_score}pts flags=${ch.correct_flag_count}/${ch.flag_count} completed=${ch.is_completed} container=${ch.container_status} addrs=${ch.container_addr.join(',') || '-'} progress=${p?.state ?? 'fresh'} | ${ch.description ?? ''}`
      })
      const locals = fresh.filter(ch => resourceClassOf(ch) === 'local').length
      const scoreLine = s.platformScore !== undefined
        ? `platformScore=${s.platformScore}/${score.max}(平台权威, 含 hint 扣分) 本地估算=${score.score}/${score.max}`
        : `score=${score.score}/${score.max}`
      const hintTxt = s.hintLedger.totalHints() > 0 ? `; hint 已看 ${s.hintLedger.totalHints()} 次、已扣约 ${s.hintLedger.totalDeducted()} 分` : ''
      return `${scoreLine} (${score.completed}/${fresh.length}; 附件题 ${locals} 个全并行, 容器题 ${fresh.length - locals} 个受 ${s.containerSlots} 槽约束${hintTxt})\n\n${rows.join('\n')}`
    },
  }))

  // ── 平台六原语 ────────────────────────────────────────────────────
  register(defineTool({
    name: 'xiaochang_start_container',
    description:
      'Start a challenge container (platform cap: 3). v7.6: waits in the resource queue with ZERO tokens — the call blocks here (polling platform state internally) until a slot frees, then starts automatically; same-challenge waiters share one container. Returns the addrs + board path. Timeout (5min) or challenge-terminal eviction return a message instead — do NOT spin your own retry loop.',
    parameters: {
      code: { type: 'string', required: true, description: 'Challenge unique_code.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string }) {
      const s = requireState()
      // F27：开容器前先刷新平台状态——close 后平台异步更新，本地缓存会误判。
      const fresh0 = await s.adapter.listChallenges()
      for (const x of fresh0) s.challenges.set(x.unique_code, x)
      const ch = s.challenges.get(args.code)
      if (ch === undefined) return `xiaochang_start_container: unknown challenge ${args.code}`
      // 共享容器短路: 该题容器已在 → 直接拿地址(同题多执行者不重复开)。
      if (ch.container_status === 'available' && ch.container_addr.length > 0) {
        return `already available: addrs=${ch.container_addr.join(',')}\nboardPath=${c().boardPath(args.code)}`
      }
      const q = s.containerQueue
      if (q === undefined) return 'xiaochang_start_container: 资源队列未初始化——先 xiaochang_setup'
      const res = await q.acquire(args.code, { timeoutMs: 5 * 60_000 })
      if (res.status === 'granted') {
        const fresh = await s.adapter.listChallenges()
        for (const x of fresh) s.challenges.set(x.unique_code, x)
        const now = s.challenges.get(args.code)
        const addrs = now?.container_addr ?? []
        return `started: addrs=${addrs.join(',')}\nboardPath=${c().boardPath(args.code)}`
      }
      if (res.status === 'timeout') {
        return `xiaochang_start_container: 排队位 ${res.position} 已等 5 分钟仍无容器槽——把"需要容器"写进战报后收工, 由主 agent 调度; 不要自己再写重试循环`
      }
      return `xiaochang_start_container: ${res.reason ?? '已出队'}——该题已终态/被中断, 无需容器; 收工等主 agent 处理`
    },
  }))

  register(defineTool({
    name: 'xiaochang_close',
    description: 'Close a challenge container (release a platform slot; wakes the next waiter in the resource queue).',
    parameters: { code: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string }) {
      const s = requireState()
      await s.adapter.close(args.code)
      s.progress.update(args.code, { containerClosed: true })
      persistProgress(s)
      // v7.6: 释放队列授权并唤醒队首(释放归机制, 不靠 agent 自觉)。
      try { await s.containerQueue?.release() } catch { /* 释放失败不阻断 */ }
      return `closed ${args.code}`
    },
  }))

  register(defineTool({
    name: 'xiaochang_submit',
    description:
      'Submit a flag candidate (main agent ONLY — executors report FLAG_CANDIDATE to the main agent, who submits; single-point submission keeps the platform verdict path serialized). Returns the platform verdict (correct/awarded/cumulative/flag counts).',
    parameters: {
      code: { type: 'string', required: true },
      flag: { type: 'string', required: true, description: 'Flag text (platform-annotated format, verbatim).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string; flag: string }, exec) {
      // v7.2: submit 主 agent 专属单点(2026-09-15 干跑实锤: fanout 思路模型直接交卷, 平台回执被悄悄吞掉)——
      // 执行者/征集模型一律经 FLAG_CANDIDATE 上报, 由主 agent 统一交卷, 平台判定路径串行可审计。
      if (parentAgent !== undefined && exec.agent !== parentAgent) {
        return 'xiaochang_submit: 拒绝——submit 是主 agent 专属单点(交卷路径串行可审计); 执行者请把 flag 输出为 FLAG_CANDIDATE: <flag> 交给主 agent 提交'
      }
      const s = requireState()
      try {
        const res = await s.adapter.submit(args.code, args.flag)
        // v7.4: 平台权威累计分入库——满分判定/展示以此为准(不自算 total_score 累加, hint 扣分天然算清)。
        if (typeof res.cumulative_score === 'number') s.platformScore = res.cumulative_score
        if (res.correct) {
          const p = s.progress.get(args.code)
          s.progress.update(args.code, { flags: [...new Set([...(p?.flags ?? []), args.flag])] })
          persistProgress(s)
          // 自动回记胜绩：终态输出里含该 flag 的执行者 → 集思能力账本记 execution win。
          const difficulty = s.challenges.get(args.code)?.difficulty ?? 'unknown'
          for (const v of c().ledger.views()) {
            if (v.state !== 'done' || codeOf(v.item.id) !== args.code) continue
            if (v.item.model === undefined) continue
            if ((v.terminalDetail ?? '').includes(args.flag)) {
              jisi?.ledger.record(v.item.model, 'execution', difficulty, true)
            }
          }
        }
        return JSON.stringify(res)
      } catch (error) {
        return `submit error: ${String(error)}`
      }
    },
  }))

  register(defineTool({
    name: 'xiaochang_hint',
    description:
      'Fetch the official hint (main agent ONLY; costs part of the challenge score, capped per challenge). v7.4 gate: refused until the challenge has gone through ≥1 R2 re-fanout (ideaRound≥2) AND has ≥1 filtered failure (provider-outage failures excluded) — hint is the last resort after escalation, never a shortcut. The deduction is reported loudly and the platform\'s cumulative_score is the authoritative account.',
    parameters: { code: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string }, exec) {
      // v2 第 3 层: hint 单点强制——只有主 agent(战役 setup 者)可调, 防多执行者同时看乱。
      if (parentAgent !== undefined && exec.agent !== parentAgent) {
        return 'xiaochang_hint: 拒绝——hint 是主 agent 专属单点(防多执行者同时看乱); 需要提示请向主 agent 请求'
      }
      const s = requireState()
      const used = s.hintLedger.get(args.code)?.hints ?? 0
      if (used >= s.maxHints) return 'xiaochang_hint: hint cap reached'
      // v7.4 时机门禁: hint 是扣分的最后手段——必须先走过 R2 二次征集且已有过滤后失败
      // (V1 实锤: 两条 hint 吃掉 180 分, agent 还浑然不知)。
      const vq = s.v2[args.code]
      const ff = filteredFailedOf(args.code, campaign)
      const gate = hintGate({ ideaRound: vq?.ideaRound ?? 1, filteredFailed: ff.failed })
      if (!gate.allowed) {
        return `xiaochang_hint: 拒绝(hint 扣该题分值, 是 R2+失败后的最后手段): ${gate.missing.join('; ')}。当前该题 hint 已用 ${used}/${s.maxHints}、已扣 ${s.hintLedger.get(args.code)?.deducted ?? 0} 分。`
      }
      const ch = s.challenges.get(args.code)
      const raw = await s.adapter.hint(args.code) as { hint?: string | null }
      const hint = raw.hint
      if (hint === null || hint === undefined || hint === '') return 'xiaochang_hint: no hint available'
      const cost = s.hintLedger.record(args.code, ch?.total_score ?? 100, 'main-agent requested')
      return `hint (${used + 1}/${s.maxHints} used): ${hint}\n⚠️ 本次看提示已扣该题约 ${cost} 分(该题累计已扣 ${s.hintLedger.get(args.code)?.deducted ?? cost}, 全局累计 ${s.hintLedger.totalDeducted()})——满分账里要扣掉; 权威分以 submit 回执的 cumulative_score / xiaochang_list 的 platformScore 为准。`
    },
  }))

  // ── 虎符执行 ──────────────────────────────────────────────────────
  register(defineTool({
    name: 'xiaochang_enqueue',
    description:
      'Enqueue one executor work item into the hufu campaign. v7 lean prompt: write ONLY the task directive (assigned idea/approach in one or two lines) — the mechanism wraps it with a fixed exec frame (challenge description, live container addrs, shared board path, per-challenge knowledge ledger path, org profile path, FLAG_CANDIDATE discipline). Executors read the knowledge ledger first (prior skeletons/dead-ends/artifacts/forks). resourceClass is auto-set by challenge type (attachment→local full-parallel; container→3-slot rotation); override only when you know better. Optional dependsOn makes it a DAG node. v7.6 prompt rules: directive ≤700 chars; do NOT paste CVE lists/default-credential dictionaries/product fingerprint tables — that knowledge already lives in the executor model and in the org profile; put reusable knowledge in the ledger (xiaochang_knowledge_put) and reference it. Overlong directives are truncated and you get a cut-point report to decide whether to rewrite.',
    parameters: {
      code: { type: 'string', required: true },
      round: { type: 'number', required: true, description: 'Round number (your own accounting).' },
      prompt: { type: 'string', required: true, description: 'The lean directive: the assigned approach/idea for this executor (1-3 lines, ≤700 chars). Do NOT paste the challenge description/addrs/board discipline — the frame injects those. Do NOT paste CVE/dictionary-style knowledge.' },
      model: { type: 'string', description: 'Executor model. Default deepseek-v4-flash (cheap fast path; override for hard challenges).' },
      effort: { type: 'string', description: 'Reasoning effort (unsupported efforts are dropped per model).' },
      dependsOn: { type: 'array', description: 'Item ids this item waits for (DAG).' },
      priority: { type: 'number', description: 'Priority score (higher first within difficulty tier).' },
      resourceClass: { type: 'string', description: 'Override the auto class: local (attachment-style, full parallel) or container (counts against the container slot cap). Auto by challenge type — override only when you know the container is already open or the type guess is wrong.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string; round: number; prompt: string; model?: string; effort?: string; dependsOn?: string[]; priority?: number; resourceClass?: string }, exec) {
      // v7.6: 调度权单点——只有主 agent 可派单(单调度器架构; 执行者无权改写战役)。
      if (parentAgent !== undefined && exec.agent !== parentAgent) {
        return 'xiaochang_enqueue: 拒绝——派单是主 agent 专属(单调度器); 执行者只解自己的题, 有发现用 xiaochang_fork 上报'
      }
      const s = requireState()
      const ch = s.challenges.get(args.code)
      if (ch === undefined) return `xiaochang_enqueue: unknown challenge ${args.code}`
      // v7: 账本文件就绪 + restore/迁移兜底镜像(账本知识全量进文件, 行去重幂等)。
      try { ensureKnowledgeFile(args.code); syncKnowledgeFileFromLedger(args.code) } catch { /* 账本失败不阻断派单 */ }
      // v2: 上下文缺口自动附带(contextGaps)——缺啥补啥, 不罚模型只补题。
      const vq = s.v2[args.code]
      let gapsTxt = ''
      if (vq !== undefined && vq.gaps.length > 0) {
        gapsTxt = '\n\n已知上下文缺口(前序执行者反馈缺的信息, 若你能补则补, 不能补则明确说缺什么):\n' + vq.gaps.slice(-5).map(g => `- ${g}`).join('\n')
      }
      // v7.6: 方向段截断(700 字符, 阈值按 run18728 真局派单分布 p50≈623 定)——超长截断并给主 agent 截点反馈。
      const DIRECTIVE_MAX = 700
      const trunc = truncateDirective(args.prompt, DIRECTIVE_MAX)
      let truncNotice = ''
      if (trunc.truncated) {
        truncNotice = `\n⚠️ 方向段截断反馈: ${args.prompt.length}→${DIRECTIVE_MAX} 字符, 截点原文 "${trunc.cutTail}…"。被砍掉的内容若是关键验证点: ①用 xiaochang_knowledge_put 写进该题账本①/③(执行者开工必读, 不占 prompt), 或 ②拆成多条派单; 若只是 CVE/口令词典类公共知识, 不用补——执行者模型自带。需要改写请重新 enqueue。`
      }
      // v7: 极简执行令框架(题面/入口/账本/画像/纪律由机制注入); 资源类自动按题类打, 可覆盖。
      const cls = args.resourceClass ?? resourceClassOf(ch)
      const label = buildExecFrame(args.code, trunc.text) + gapsTxt
      const seq = s.progress.get(args.code)?.rounds ?? 0
      const itemId = `${args.code}#s${args.round}-w${seq + 1}`
      // 执行者模型/强度：主 agent 逐项覆盖优先，缺省兜底；模型锁定时强制缺省。
      const executor = resolveExecutor({ model: args.model, effort: args.effort }, s.executorPolicy)
      // F8 护栏：模型必须出现在集思目录（能解析到 provider），否则拒绝入队——
      // 防"目录外模型"被静默送到默认 provider 后无声失败。
      if (jisi !== undefined) {
        const listed = await jisi.listModels()
        if (!listed.some(m => m.id === executor.model)) {
          return `xiaochang_enqueue: model ${executor.model} is not in the registered model catalog (jisi listModels) — pick a listed model`
        }
        // F35: 余额枯竭隔离——不让派单把 token 砸进没钱的口袋(会在 spawn 层无声失败)。
        if (await jisi.isModelQuarantined?.(executor.model)) {
          return `xiaochang_enqueue: model ${executor.model} 所属 provider 余额已枯竭(隔离中)——换模型; 并把"provider 余额不足"写进战报/最终消息提示用户充值`
        }
      }
      c().add({
        id: itemId,
        label,
        model: executor.model,
        reasoningEffort: executor.effort,
        ...(args.dependsOn !== undefined && args.dependsOn.length > 0 ? { dependsOn: args.dependsOn } : {}),
        board: args.code,
        resourceClass: cls,
        priority: { tier: tierOf(ch.difficulty), score: args.priority ?? ch.total_score },
      })
      s.progress.update(args.code, { difficulty: ch.difficulty, rounds: Math.max(s.progress.get(args.code)?.rounds ?? 0, args.round) })
      persistProgress(s)
      audit(s.auditPath, { type: 'enqueue', id: itemId, code: args.code, round: args.round, model: executor.model, effort: executor.effort, class: cls })
      return `enqueued ${itemId} (class=${cls}, executor=${executor.model}/${executor.effort}${executor.overriddenByLock ? ', OVERRIDDEN BY MODEL LOCK' : ''})${truncNotice}`
    },
  }))

  register(defineTool({
    name: 'xiaochang_dispatch',
    description:
      'Dispatch every READY queued item (DAG dependencies satisfied) while slots are free. Call this after enqueues and again each round — a finished item frees a slot immediately; no barrier ever waits for the slowest.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute() {
      const s = requireState()
      let count = 0
      // v7: 循环以 dispatchNext 返回 undefined 为准——类闸饱和(容器 3 槽满)时
      // freeSlots()>0 但顶部排队项全类饱和, 旧式 while 条件会死转。
      while (true) {
        const dispatched = await c().dispatchNext()
        if (dispatched === undefined) break
        count += 1
      }
      audit(s.auditPath, { type: 'dispatch-round', count, open: openCount(c()) })
      return `dispatched ${count} item(s); open=${openCount(c())}`
    },
  }))

  register(defineTool({
    name: 'xiaochang_collect',
    description:
      'Collect settled work items (terminal states) since the last collect, and auto-handle mechanics: round timeouts are reported as failed (with the detail), timeout losses are recorded to the jisi model ledger, and OBSERVATIONS sections flow into the org profile. Returns each item: id, code, round, state, and the executor output text.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute() {
      const s = requireState()
      const now = Date.now()
      const rows: string[] = []
      // 轮次超时自动判负（机制；判不判题由你随后 xiaochang_report 决定）。
      // 按难度差异化：easy 0.67× / medium 1.33× / hard 2×（老架构实证：难题要磨，
      // 一刀切 30 分钟会切碎攻坚连续性）。
      for (const v of c().ledger.views()) {
        if (v.state !== 'dispatched' && v.state !== 'help') continue
        const difficulty = s.challenges.get(codeOf(v.item.id))?.difficulty ?? 'medium'
        const factor = difficulty === 'easy' ? 0.67 : difficulty === 'hard' ? 2 : 1.33
        const timeout = Math.round(s.roundTimeoutMs * factor)
        const last = v.lastProgressAt ?? v.dispatchedAt
        if (last === undefined || now - last < timeout) continue
        // v7.5: 超时判负前真杀——账本级超时 ≠ 进程已停, 执行者可能还在烧 token。
        try { await c().interruptItem?.(v.item.id) } catch { /* 中断失败不阻断判负 */ }
        audit(s.auditPath, { type: 'interrupt', id: v.item.id, code: codeOf(v.item.id), reason: 'round timeout' })
        c().report(v.item.id, 'failed', 'round timeout')
        s.processed.add(baseId(v.item.id))
      }
      for (const v of c().ledger.views()) {
        if (v.state !== 'done' && v.state !== 'failed' && v.state !== 'blocked') continue
        const base = baseId(v.item.id)
        if (s.processed.has(base)) continue
        s.processed.add(base)
        const code = codeOf(v.item.id)
        const round = roundOf(v.item.id)
        const detail = v.terminalDetail ?? ''
        // 自动记账：超时败绩 → 集思能力账本（胜绩与思路对错由主 agent 经 jisi_record 记）。
        if (v.state === 'failed' && detail.includes('round timeout') && v.item.model !== undefined) {
          jisi?.ledger.record(v.item.model, 'execution', s.challenges.get(code)?.difficulty ?? 'unknown', false)
        }
        // v2 执行成色(第 1 层): 终态胜 → +winWeight; 超时负 → model-weak −failWeight。
        if (v.item.model !== undefined) {
          const vq = s.v2[code] ?? { qtype: classifyQtype(s.challenges.get(code)?.description ?? ''), difficulty: difficultyPrior(s.challenges.get(code)?.total_score ?? 300), wins: 0, fails: 0, gaps: [], triedModels: [], ideaRound: 1, deadIdeas: 0, adopted: 0 }
          if (v.state === 'done') {
            jisi?.recordV2?.({ model: v.item.model, dimension: 'execution', qtype: vq.qtype, difficulty: vq.difficulty, weight: Math.log(1 + vq.difficulty / 25), win: true, note: `${v.item.id} done` })
          } else if (v.state === 'failed' && detail.includes('round timeout')) {
            jisi?.recordV2?.({ model: v.item.model, dimension: 'execution', qtype: vq.qtype, difficulty: vq.difficulty, weight: Math.log(1 + 25 / vq.difficulty), win: false, attribution: 'model-weak', note: `${v.item.id} round timeout` })
          }
          if (!vq.triedModels.includes(v.item.model)) vq.triedModels.push(v.item.model)
          s.v2[code] = vq
          persistV2(s)
        }
        // 画像积累：OBSERVATIONS 小节自动并入题集画像。
        for (const note of parseObservations(detail)) addFact(s.profile, { kind: 'other', note })
        audit(s.auditPath, { type: 'terminal', id: v.item.id, state: v.state, round, detail: detail.slice(0, 300) })
        rows.push(`--- ${v.item.id} [${v.state}] round=${round} code=${code}\n${detail.slice(0, 6000)}`)
      }
      persistProgress(s)
      persistProfile(s)
      return rows.length === 0 ? 'xiaochang_collect: nothing settled yet' : rows.join('\n\n')
    },
  }))

  register(defineTool({
    name: 'xiaochang_report',
    description:
      'Report your judgment for a challenge: complete (flags captured) / failed (give up or rounds exhausted) / skipped. Closes the container and prunes the challenge\'s queued/in-flight sibling items (hufu cancel).',
    parameters: {
      code: { type: 'string', required: true },
      verdict: { type: 'string', required: true, description: 'complete | failed | skipped' },
      reason: { type: 'string', description: 'Short reason (logged).' },
      deadEnds: { type: 'array', description: '[{path, conclusion, evidence}] proven-infeasible paths.' },
      forks: { type: 'array', description: '[{path, conclusion, evidence}] untaken branches worth dispatching.' },
      observations: { type: 'array', description: '[{path, conclusion}] facts learned.' },
      why: { type: 'string', description: 'v2 归因(failed 时必填): model-weak | approach-dead-end | context-insufficient | platform-issue. 两级判定: 执行者报告提议, 你终裁.' },
      gaps: { type: 'array', description: 'v2 上下文缺口(context-insufficient 时): [缺什么信息]. 进画像 contextGaps, 下次派单/二次征集自动附带.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string; verdict: string; reason?: string; deadEnds?: Array<{ path: string; conclusion?: string; evidence?: string }>; forks?: Array<{ path: string; conclusion?: string; evidence?: string }>; observations?: Array<{ path: string; conclusion?: string }>; why?: string; gaps?: string[] }, exec) {
      // v7.6: 调度权单点——裁决/剪枝只有主 agent 可做。
      if (parentAgent !== undefined && exec.agent !== parentAgent) {
        return 'xiaochang_report: 拒绝——裁决是主 agent 专属(单调度器); 执行者只报告结果, 交主 agent 判断'
      }
      const s = requireState()
      const verdict = args.verdict === 'complete' ? 'complete' as const : args.verdict === 'failed' ? 'failed' as const : 'skipped' as const
      // v2: 归因门控的难度校准 + 终局对账 + 加权入账。
      const vq = s.v2[args.code] ?? { qtype: classifyQtype(s.challenges.get(args.code)?.description ?? ''), difficulty: difficultyPrior(s.challenges.get(args.code)?.total_score ?? 300), wins: 0, fails: 0, gaps: [], triedModels: [], ideaRound: 1, deadIdeas: 0, adopted: 0 }
      const why = args.why
      const win = verdict === 'complete'
      if (why !== 'context-insufficient' && why !== 'platform-issue') {
        vq.wins += win ? 1 : 0
        vq.fails += win ? 0 : 1
        vq.difficulty = calibrateDifficulty(vq)
        vq.lastVerdict = verdict
      }
      if (args.gaps !== undefined && args.gaps.length > 0) vq.gaps.push(...args.gaps)
      s.v2[args.code] = vq
      persistV2(s)
      if (jisi !== undefined) {
        // 终局对账: 采纳的思路, 题胜不加; 题败且归因 approach-dead-end → 罚思路模型(第 0 层)。
        jisi.settleAdoptions?.(args.code, win, why)
      }
      // F33: 结构化经验落账(全局解题图)——记账失败绝不阻断 verdict 主线(关容器/剪枝/落盘)。
      const entries: KnowledgeIn[] = [
        ...(args.deadEnds ?? []).map(e => ({ kind: 'dead-end', path: e.path, conclusion: e.conclusion, evidence: e.evidence, by: 'report', at: Date.now() })),
        ...(args.forks ?? []).map(e => ({ kind: 'fork', path: e.path, conclusion: e.conclusion, evidence: e.evidence, by: 'report', at: Date.now() })),
        ...(args.observations ?? []).map(e => ({ kind: 'observation', path: e.path, conclusion: e.conclusion, by: 'report', at: Date.now() })),
      ]
      try { if (entries.length > 0) recordKnowledgeOnCode(args.code, entries) } catch { /* 落账失败不阻断 */ }
      // v7: 知识账本文件自动累积——②死路/缺口, ③工件(observations), ④分叉; 失败不阻断。
      const line = (e: { path: string; conclusion?: string; evidence?: string }): string => `${e.path}${e.conclusion !== undefined ? ' → ' + e.conclusion : ''}${e.evidence !== undefined ? ' (证据: ' + e.evidence + ')' : ''}`
      try {
        if ((args.deadEnds?.length ?? 0) > 0) appendKnowledgeFile(args.code, 'dead', args.deadEnds!.map(line))
        if ((args.gaps?.length ?? 0) > 0) appendKnowledgeFile(args.code, 'dead', args.gaps!.map(g => `缺口: ${g}`))
        if ((args.observations?.length ?? 0) > 0) appendKnowledgeFile(args.code, 'artifacts', args.observations!.map(line))
        if ((args.forks?.length ?? 0) > 0) appendKnowledgeFile(args.code, 'forks', args.forks!.map(line))
      } catch { /* 账本文件失败不阻断 */ }
      try { await s.adapter.close(args.code) } catch { /* 平台侧已关 */ }
      // v7.6: 释放队列授权 + 终态出队(该题所有排队者摘除, 轮给下一家)。
      try { await s.containerQueue?.release() } catch { /* 释放失败不阻断 */ }
      try { s.containerQueue?.evict(args.code, `challenge ${verdict}`) } catch { /* 出队失败不阻断 */ }
      s.progress.update(args.code, { state: verdict, reason: args.reason, containerClosed: true })
      for (const v of c().ledger.views()) {
        if (codeOf(v.item.id) === args.code
          && (v.state === 'queued' || v.state === 'dispatched' || v.state === 'help' || v.state === 'stalled')) {
          // v7.5: 剪枝前真杀在途执行者——题已解(终态), 同题执行者继续跑就是空烧 token。
          if (v.state !== 'queued') {
            try { await c().interruptItem?.(v.item.id) } catch { /* 中断失败不阻断剪枝 */ }
            audit(s.auditPath, { type: 'interrupt', id: v.item.id, code: args.code, reason: `challenge ${verdict}` })
          }
          try { c().cancel(v.item.id, `challenge ${verdict}: ${args.reason ?? ''}`) } catch { /* 终态竞争 */ }
        }
      }
      persistProgress(s)
      audit(s.auditPath, { type: 'verdict', code: args.code, state: verdict, reason: args.reason })
      return `${args.code} → ${verdict}${args.reason !== undefined ? ` (${args.reason})` : ''}`
    },
  }))

  // ── 状态与收尾 ────────────────────────────────────────────────────
  register(defineTool({
    name: 'xiaochang_board',
    description: 'Read the shared findings board of a challenge (parallel workers\' coordination channel).',
    parameters: { code: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args: { code: string }) {
      const path = c().boardPath(args.code)
      try {
        const text = existsSync(path) ? readFileSync(path, 'utf8') : '(board not created yet)'
        return `path=${path}\n\n${text}`
      } catch (error) {
        return `xiaochang_board error: ${String(error)}`
      }
    },
  }))

  register(defineTool({
    name: 'xiaochang_profile',
    description: 'Read the current org profile (cross-challenge generic observations). Include it in your prompts ("read the profile first").',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute() {
      const s = requireState()
      return renderProfile(s.profile)
    },
  }))

  // v6: R2 prompt 组装(工具与 status 自动触发共用)。
  const buildRefanoutPrompt = (code: string): string => {
    const s = requireState()
    const ch = s.challenges.get(code)
    const vq = s.v2[code] ?? { qtype: classifyQtype(ch?.description ?? ''), difficulty: difficultyPrior(ch?.total_score ?? 300), wins: 0, fails: 0, gaps: [], triedModels: [], ideaRound: 1, deadIdeas: 0, adopted: 0 }
    const dead = knowledgeOfCode(code).filter(k => k.kind === 'dead-end').map(k => `- ${k.path}: ${k.conclusion ?? ''}`).join('\n') || '(无)'
    const gaps = vq.gaps.length > 0 ? vq.gaps.map(g => `- ${g}`).join('\n') : '(无)'
    const tried = vq.triedModels.length > 0 ? vq.triedModels.join(', ') : '(无)'
    return `[二次思路征集 R${vq.ideaRound + 1}] 题目 ${code}(${vq.qtype}, 校准难度 ${vq.difficulty}/100)
题面: ${(ch?.description ?? '').slice(0, 1500)}
知识账本(可选读, 前序骨架/死路/工件/分叉): ${ensureKnowledgeFile(code)}

已知死路(前序思路已证不可行):
${dead}

上下文缺口(前序执行者反馈缺的信息):
${gaps}

已试模型: ${tried}
已采用思路 ${vq.adopted} 条, 已死 ${vq.deadIdeas} 条。

提问: 已知以上死路与缺口之后, 还有哪些**没试过**的方向? 不要重复死路; 每条给: 为什么可行 + 验证点 + 需要补的上下文。`
  }
  /** v6: R2 选模(直接加模型, 未试过的优先)。 */
  const pickRefanoutModels = async (vq: { qtype: string; difficulty: number; triedModels: string[] }): Promise<string[]> => {
    if (jisi?.pickRank !== undefined) {
      const ranked = await jisi.pickRank(vq.qtype, vq.difficulty, 'idea')
      const fresh = ranked.filter(r => !vq.triedModels.includes(r.model)).map(r => r.model)
      if (fresh.length > 0) return fresh.slice(0, 3)
      if (ranked.length > 0) return ranked.slice(0, 3).map(r => r.model)
    }
    const listed = await jisi?.listModels()
    return (listed ?? []).map(m => m.id).slice(0, 3)
  }

  // ── v2 第 3 层: R2 二次征集(上下文带入 + 加模型) ────────────────
  register(defineTool({
    name: 'xiaochang_refanout',
    description:
      'V2 layer-3 R2 re-fanout: one call re-collects ideas for a stuck challenge WITH all prior context (R1 ideas alive+dead, dead-end list, context gaps, tried models) and ADDS models beyond the tried set (pick-ranked by idea fit, expensive models included when tried set is exhausted). Call it when xiaochang_status shows ⚠️ upgrade suggestions, or when half the adopted ideas died.',
    parameters: {
      code: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string }, exec) {
      // v7.6: 调度权单点——二次征集发兵只有主 agent 可做。
      if (parentAgent !== undefined && exec.agent !== parentAgent) {
        return 'xiaochang_refanout: 拒绝——二次征集是主 agent 专属(单调度器); 卡住了请把缺口写进终态输出交主 agent'
      }
      const s = requireState()
      const ch = s.challenges.get(args.code)
      if (ch === undefined) return `xiaochang_refanout: unknown challenge ${args.code}`
      const vq = s.v2[args.code] ?? { qtype: classifyQtype(ch.description ?? ''), difficulty: difficultyPrior(ch.total_score), wins: 0, fails: 0, gaps: [], triedModels: [], ideaRound: 1, deadIdeas: 0, adopted: 0 }
      const agent = exec.agent
      if (agent === undefined) return 'xiaochang_refanout: requires a calling agent'
      const prompt = buildRefanoutPrompt(args.code)
      const models = await pickRefanoutModels(vq)
      // ③ 发兵(notify): 主 agent 收到信封后照常 jisi_adjudicate 裁决。
      if (jisi?.fanoutNotify !== undefined) {
        const ticket = jisi.fanoutNotify(agent, { prompt }, models)
        vq.ideaRound += 1
        vq.triedModels.push(...models.filter(m => !vq.triedModels.includes(m)))
        s.v2[args.code] = vq
        persistV2(s)
        return `xiaochang_refanout: R${vq.ideaRound} 征集已发 (${models.join(', ')}, ticket ${ticket.id}).\n报告按 [fanout:${ticket.id}] 信封到达——到达后请 jisi_adjudicate 裁决(adopted/not-adopted/pending), 采纳即派单。\n\n发送的 prompt:\n${prompt.slice(0, 600)}...`
      }
      return `xiaochang_refanout: jisi 通道不可用。请用 jisi_fanout(prompt 见下, models=${models.join(', ')} 或按 jisi_pick ${vq.qtype}/${vq.difficulty} 取)。\n\n${prompt}`
    },
  }))

  // ── F33 ②b 分叉即时报 + ③ 全局解题图 ──────────────────────────
  register(defineTool({
    name: 'xiaochang_fork',
    description:
      'F33 fork alarm: you (executor) report branches with an explicit status — "untaken" (default): promising branch not taken, worth dispatching (goes to ledger ④ + the fork inbox; the main agent is woken by xiaochang_wait polling the inbox — NO direct interrupt, forks are collected in the main agent\'s normal rhythm); "dead-end": a path you PROVED infeasible (403/impossible/verified-fail) — archived silently to ledger ② only, no inbox, no wake, no dispatch impulse. v7.1: untaken forks of already-terminal challenges are archived silently. v7.4: duplicate paths already in the inbox are skipped at the source.',
    parameters: {
      code: { type: 'string', required: true },
      forks: { type: 'array', required: true, description: '[{path, conclusion, evidence, status}] — status: "untaken" (default, 未走分叉→④+信箱, 主 agent 经 xiaochang_wait 唤醒) | "dead-end" (已证死路→只进②, 不唤醒不派兵).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args: { code: string; forks: Array<{ path: string; conclusion?: string; evidence?: string; status?: 'untaken' | 'dead-end' }> }) {
      if (args.forks.length === 0) return 'xiaochang_fork: no forks given'
      const fmt = (f: { path: string; conclusion?: string; evidence?: string }): string => `${f.path}${f.conclusion !== undefined ? ' → ' + f.conclusion : ''}${f.evidence !== undefined ? ' (证据: ' + f.evidence + ')' : ''}`
      const deadEnds = args.forks.filter(f => f.status === 'dead-end')
      const untaken = args.forks.filter(f => f.status !== 'dead-end')
      const deadLines = deadEnds.map(fmt)
      // v7.2 dead-end 语义位: 死路只进②不可行教训(静默)——不信箱/不唤醒/不进④, 账本不再双写。
      if (deadEnds.length > 0) {
        const de: KnowledgeIn[] = deadEnds.map(f => ({ kind: 'dead-end', path: f.path, conclusion: f.conclusion, evidence: f.evidence, by: 'fork', at: Date.now() }))
        try { recordKnowledgeOnCode(args.code, de) } catch { /* 入账失败不阻断 */ }
        try { appendKnowledgeFile(args.code, 'dead', deadLines) } catch { /* 账本文件失败不阻断 */ }
      }
      // untaken: v7.4 B 源端去重(与信箱已有条目按 path 去重) + v7.1 终态抑制 + 信箱(唯一唤醒通道)。
      const terminalNow = progressTerminal(args.code)
      let entries: KnowledgeIn[] = []
      let inbox = ''
      let skipped = 0
      if (untaken.length > 0) {
        const existingPaths: string[] = []
        try { existingPaths.push(...readForkInbox(args.code).map(k => k.path)) } catch { /* 信箱读失败按空处理 */ }
        const fresh = dedupeForkPaths(existingPaths, untaken)
        skipped = untaken.length - fresh.length
        entries = fresh.map(f => ({ kind: 'fork', path: f.path, conclusion: f.conclusion, evidence: f.evidence, by: 'fork', at: Date.now() }))
        if (entries.length > 0 && !terminalNow) {
          try { inbox = writeForkInbox(args.code, entries) } catch { /* 信箱写失败 */ }
        }
        if (entries.length > 0) {
          try { recordKnowledgeOnCode(args.code, entries) } catch { /* 入账失败不阻断 */ }
          try { appendKnowledgeFile(args.code, 'forks', entries.map(f => fmt(f))) } catch { /* 账本文件失败不阻断 */ }
        }
      }
      const parts: string[] = []
      if (deadEnds.length > 0) parts.push(`死路 ${deadEnds.length} 条已静默入账②(不唤醒不派兵)`)
      if (skipped > 0) parts.push(`重复 path ${skipped} 条已在信箱中, 源端跳过(不重复上报)`)
      if (entries.length > 0) {
        parts.push(inbox !== '' ? `未走分叉 ${entries.length} 条已写入信箱(${inbox})——主 agent 的 xiaochang_wait 轮询到即唤醒, 不打断其当前 turn` : '未走分叉: 信箱未写(终态抑制或写入失败)')
        if (terminalNow) parts.push('题已终态: 仅存档入账, 未写信箱/未唤醒(不派兵)')
      }
      return `fork ${parts.join('; ') || 'nothing to record'}:\n${[...deadLines.map(l => `- ❌${l}`), ...entries.map(f => `- 🔀${fmt(f)}`)].join('\n')}`
    },
  }))

  register(defineTool({
    name: 'xiaochang_graph',
    description:
      'F33 global solving graph: per-challenge view of every attempt (seed/model/state/terminal detail) plus accumulated knowledge (dead-ends/forks/observations). This is the main agent\'s situational picture — read it before every dispatch decision.',
    parameters: {
      code: { type: 'string', description: 'One challenge code; omit for the full graph.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args: { code?: string }) {
      const s = requireState()
      // F33: 读图即吸收——先把盘上分叉信箱并入账本(幂等归档), 图永远是全局最新。
      const codes = args.code !== undefined ? [args.code] : [...new Set(c().ledger.views().map(v => codeOf(v.item.id)))]
      for (const code of codes) { try { absorbForkInbox(code) } catch { /* 吸收失败不阻断 */ } }
      const views = c().ledger.views().filter(v => args.code === undefined || codeOf(v.item.id) === args.code)
      if (views.length === 0) return `xiaochang_graph: no ledger items${args.code !== undefined ? ` for ${args.code}` : ''}`
      // v7: 单题视角附知识账本文件路径(主 agent 维护/执行者必读的持久记忆)。
      const header = args.code !== undefined ? `knowledgeFile=${ensureKnowledgeFile(args.code)}\n` : ''
      const rows: string[] = []
      for (const v of views) {
        const code = codeOf(v.item.id)
        const p = s.progress.get(code)
        const kindTag = { done: '✅', failed: '❌', blocked: '⛔', superseded: '♻️' }[v.state] ?? { queued: '⏳', dispatched: '🏃', help: '🙏', stalled: '🐌' }[v.state] ?? '·'
        rows.push(`${kindTag} ${v.item.id} [${v.state}] seed=${v.seed} model=${v.item.model ?? s.executorPolicy.defaultModel} effort=${v.item.reasoningEffort ?? s.executorPolicy.defaultEffort}${p !== undefined && p.flags.length > 0 ? ` flags=${p.flags.length}` : ''}${v.terminalDetail !== undefined ? `\n  终态: ${v.terminalDetail.slice(0, 400)}` : ''}`)
        const ks = campaign?.knowledgeOf?.(v.item.id) ?? []
        for (const k of ks as KnowledgeIn[]) {
          const tag = k.kind === 'dead-end' ? '❌死路' : k.kind === 'fork' ? '🔀未走分叉' : '📌事实'
          rows.push(`     [${tag}] ${k.path}${k.conclusion !== undefined ? ' → ' + k.conclusion : ''}${k.evidence !== undefined ? ' (证据: ' + k.evidence + ')' : ''}${k.by !== undefined ? ` — by ${k.by}` : ''}`)
        }
        if (p !== undefined) rows.push(`   progress: ${p.state} reason=${p.reason ?? '-'} containerClosed=${p.containerClosed}`)
      }
      return header + rows.join('\n')
    },
  }))

  // ── v7 知识账本写入(主 agent 专属: ①整体改写, ②③④追加) ──────────
  register(defineTool({
    name: 'xiaochang_knowledge_put',
    description:
      'v7 per-challenge knowledge ledger write (main agent only): rewrite section ① 题源思路骨架 (idea source + skeleton steps; the one section you own) and/or append ②不可行教训/③回收工件/④未走分叉. The file is auto-accumulated by mechanism for ②③④ (report/fork) — call this mainly to maintain ① and to add your own lessons. Executors read this file at work start; retries continue from the frontier instead of re-identifying.',
    parameters: {
      code: { type: 'string', required: true },
      skeleton: { type: 'array', description: '① 题源思路骨架 (REPLACES the section): one line per idea — source (题面/hint/图谱/分叉) + skeleton steps.' },
      deadEnds: { type: 'array', description: '② append: proven-infeasible paths / missing context.' },
      artifacts: { type: 'array', description: '③ append: recyclable artifacts — credentials, file paths, URLs, scripts, findings.' },
      forks: { type: 'array', description: '④ append: untaken branches worth dispatching.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string; skeleton?: string[]; deadEnds?: string[]; artifacts?: string[]; forks?: string[] }, exec) {
      // ① 由主 agent 专属维护(防多执行者同时改写思路骨架); 执行者经 xiaochang_fork 上报。
      if (parentAgent !== undefined && exec.agent !== parentAgent) {
        return 'xiaochang_knowledge_put: 拒绝——知识账本①是主 agent 专属(防并发改写思路骨架); 执行者用 xiaochang_fork 上报分叉即可'
      }
      const s = requireState()
      if (s.challenges.get(args.code) === undefined) return `xiaochang_knowledge_put: unknown challenge ${args.code}`
      const applied: string[] = []
      try {
        if (args.skeleton !== undefined) { replaceKnowledgeFile(args.code, 'skeleton', args.skeleton); applied.push(`① 骨架改写 ${args.skeleton.length} 条`) }
        if (args.deadEnds !== undefined) { appendKnowledgeFile(args.code, 'dead', args.deadEnds); applied.push(`② 死路 +${args.deadEnds.length}`) }
        if (args.artifacts !== undefined) { appendKnowledgeFile(args.code, 'artifacts', args.artifacts); applied.push(`③ 工件 +${args.artifacts.length}`) }
        if (args.forks !== undefined) { appendKnowledgeFile(args.code, 'forks', args.forks); applied.push(`④ 分叉 +${args.forks.length}`) }
      } catch { /* 写失败不阻断 */ }
      try { syncKnowledgeFileFromLedger(args.code) } catch { /* 镜像失败不阻断 */ }
      return `xiaochang_knowledge_put: ${applied.join(', ') || 'nothing to write'}\n账本: ${knowledgeFilePath(args.code)}`
    },
  }))

  register(defineTool({
    name: 'xiaochang_status',
    description: 'Campaign status: ledger summary, per-challenge progress, budget remaining, open containers.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(_args: Record<string, never>, exec?: { agent?: { followup(message: unknown): void } }) {
      const s = requireState()
      const views = c().ledger.views()
      const count = (fn: (v: { state: string }) => boolean): number => views.filter(fn).length
      const remaining = Math.max(0, s.startedAt + s.budgetMs - Date.now())
      const progress = s.progress.all().map(p => `${p.code}:${p.state}${p.state === 'complete' ? `(${p.flags.length} flags)` : ''}`).join(', ')
      // v6 不可行性判定(停止规则): 每题裁决 continue/escalate/judge-dead。
      const escLines: string[] = []
      const listed = await jisi?.listModels() ?? []
      for (const [code, q] of Object.entries(s.v2)) {
        const p = s.progress.get(code)
        if (p === undefined || p.state === 'complete' || p.state === 'failed' || p.state === 'skipped') continue
        const ff = filteredFailedOf(code, campaign)
        const views = (campaign?.ledger.views() ?? []).filter(v => codeOf(v.item.id) === code)
        const lastProgress = Math.max(0, ...views.map(v => v.lastProgressAt ?? 0))
        const noProgressMin = lastProgress > 0 ? Math.round((Date.now() - lastProgress) / 60000) : 0
        const deadTexts = knowledgeOfCode(code).filter(k => k.kind === 'dead-end').map(k => `${k.path} ${k.conclusion ?? ''}`)
        const cov = coverageOf(q.qtype as 'web' | 'crypto' | 'pwn' | 'rev' | 'forensics' | 'misc', deadTexts)
        const ch = s.challenges.get(code)
        const remainingPoints = ch !== undefined ? Math.max(0, Math.round(ch.total_score * (1 - (ch.correct_flag_count ?? 0) / (ch.flag_count || 1)))) : 0
        const modelExhaustion = listed.length === 0 ? 1 : q.triedModels.length / listed.length
        const ruling = jisi?.judge?.({
          troops: q.triedModels.length,
          filteredFailed: ff.failed,
          noProgressMin,
          difficulty: q.difficulty,
          coverageRatio: cov.ratio,
          remainingPoints,
          modelExhaustion: Math.min(1, modelExhaustion),
          r2Count: Math.max(0, q.ideaRound - 1),
        })
        if (ruling === undefined) continue
        const exclTxt = ff.excluded > 0 ? ` (故障过滤剔除 ${ff.excluded}: ${[...new Set(ff.excludedReasons)].join('+')})` : ''
        if (ruling.action === 'escalate') escLines.push(`⚠️ ${code}: ${ruling.reasons[0] ?? ''}${exclTxt}`)
        if (ruling.action === 'judge-dead') escLines.push(`⛔ ${code}: ${ruling.reasons[0] ?? ''}${exclTxt}`)
      }
      // v6 末段自动 R2: 预算 ≤60min 且 hard 未破且该题本窗口未发过 → 插件直接发兵(机制默认动作)。
      if (remaining <= 60 * 60_000) {
        const hardOpen: string[] = []
        for (const [code, q] of Object.entries(s.v2)) {
          // 进度已终态的题绝不重复征集(2026-09-15 干跑实锤: 只查 lastVerdict 会漏掉归因门控没写 lastVerdict 的已解题)。
          const p = s.progress.get(code)
          if (p !== undefined && (p.state === 'complete' || p.state === 'failed' || p.state === 'skipped')) continue
          if (q.difficulty >= 55 && q.lastVerdict !== 'complete') hardOpen.push(code)
        }
        for (const code of hardOpen.slice(0, 3)) {
          const q = s.v2[code]!
          if (q.autoR2 !== true) {
            q.autoR2 = true
            s.v2[code] = q
            persistV2(s)
            if (jisi?.fanoutNotify !== undefined) {
              const prompt = buildRefanoutPrompt(code)
              const models = await pickRefanoutModels(q)
              const ticket = jisi.fanoutNotify(parentAgent ?? (exec?.agent as unknown), { prompt }, models)
              q.ideaRound += 1
              q.triedModels.push(...models.filter(m => !q.triedModels.includes(m)))
              s.v2[code] = q
              persistV2(s)
              escLines.push(`⏰ 末段自动 R2: ${code} 已自动发起二次征集(${models.join(', ')}, ticket ${ticket.id})——可 jisi_fanout_drop 改判`)
            } else {
              escLines.push(`⏰ 末段赶工: ${code} 未破且 jisi 通道不可用 → 手动 xiaochang_refanout`)
            }
          }
        }
      }
      const escTxt = escLines.length > 0 ? `\n升级建议:\n${escLines.join('\n')}` : ''
      // v7 类闸可见性: 主 agent 一眼看清哪条资源线饱和。
      const usage = c().classUsage?.() ?? {}
      const usageTxt = Object.entries(usage).map(([cls, u]) => `${cls} ${u.open}/${u.limit}`).join(', ') || 'n/a'
      return [
        `campaign: open=${count(v => v.state === 'dispatched' || v.state === 'help')} queued=${count(v => v.state === 'queued')} done=${count(v => v.state === 'done')} failed=${count(v => v.state === 'failed')} blocked=${count(v => v.state === 'blocked')}`,
        `resourceClasses: ${usageTxt}`,
        `budgetRemainingMin=${Math.round(remaining / 60000)}`,
        `platformScore=${s.platformScore ?? 'n/a'}${s.platformScore !== undefined ? '(权威, 含 hint 扣分)' : ''}`,
        `openContainers=${[...openContainers(s)].join(',') || 'none'}`,
        `hints=${s.hintLedger.totalHints()} (deducted ${s.hintLedger.totalDeducted()})`,
        `progress: ${progress}`, escTxt,
      ].join('\n')
    },
  }))

  register(defineTool({
    name: 'xiaochang_wait',
    description:
      'Event-driven wait (F30): blocks the turn without spending any LLM tokens until (a) an executor settles, (b) the campaign ledger changes, (c) a new session message arrives, (d) a fork lands in the fork inbox for a NON-terminal challenge (executor xiaochang_fork; v7.1: late forks of already-terminal challenges are archived silently), or (e) the timeout. v7.6: pass code to wait ONLY on your own challenge (single-challenge executors MUST pass it — other challenges\' activity will not wake you; global waits omit it). This is THE way to wait — never bash sleep for waiting.',
    parameters: {
      timeoutSeconds: { type: 'number', description: 'Max wait seconds (default 300, clamp 5..900).' },
      code: { type: 'string', description: 'v7.6 filter: only wake on events of this challenge (single-challenge executors must pass it).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args: { timeoutSeconds?: number; code?: string }, exec) {
      const timeoutMs = Math.min(Math.max(args.timeoutSeconds ?? 300, 5), 900) * 1000
      const agent = exec.agent
      const codeFilter = args.code
      const ledgerSnap = (): string => {
        try {
          const views = campaign?.ledger.views() ?? []
          const picked = codeFilter !== undefined ? views.filter(v => codeOf(v.item.id) === codeFilter) : views
          return JSON.stringify(picked.map(v => [v.item.id, v.state, v.terminalDetail ?? '', v.lastProgressAt ?? 0]))
        } catch { return '' }
      }
      return await new Promise<string>((resolve) => {
        let settled = false
        let cleanup = (): void => {}
        const done = (why: string): void => {
          if (settled) return
          settled = true
          cleanup()
          resolve(why)
        }
        // ① 虎符 settle 事件（一次性执行者结算）——v7.6: 按 code 过滤(单题执行者不被全战役噪音唤醒)。
        const unsub = campaignId !== undefined && holder.onSettle !== undefined
          ? holder.onSettle(campaignId, ev => {
            if (codeFilter !== undefined && codeOf(ev.itemId) !== codeFilter) return
            done(`xiaochang_wait: ${ev.itemId} settled (${ev.status})${ev.text !== '' ? ': ' + ev.text.slice(0, 200) : ''}`)
          })
          : (): void => {}
        // ② 账本轮询兜底（超时判失败/主 agent 自己 report 等）——同按 code 过滤。
        const before = ledgerSnap()
        const iv = setInterval(() => { if (ledgerSnap() !== before) done('xiaochang_wait: campaign ledger changed') }, 2000)
        // ③ 会话新消息（continuable settle 通知等）
        const seqBefore = agent?.session.seq ?? 0
        const sv = setInterval(() => { if (agent !== undefined && agent.session.seq > seqBefore) done('xiaochang_wait: session message arrived') }, 2000)
        // ⑤ F33 分叉信箱: 执行者 xiaochang_fork 写盘 → 立即唤醒(跨会话可靠通道)
        const inboxDir = forkInboxDir()
        const inboxSnap = (): string => {
          try {
            if (!existsSync(inboxDir)) return ''
            const files = codeFilter !== undefined
              ? readdirSync(inboxDir).filter(f => f.endsWith('.jsonl') && f.replace(/\.jsonl$/, '') === codeFilter)
              : readdirSync(inboxDir).filter(f => f.endsWith('.jsonl'))
            return files.map(f => { const st = statSync(join(inboxDir, f)); return `${f}:${st.mtimeMs}:${st.size}` }).join('|')
          } catch { return '' }
        }
        // v7.1/v7.4 终态抑制 + 唤醒即清账: 信箱里每条 fork 吸收归档(终态题静默, 活跃题唤醒一次——
        // 吸收先于唤醒, 同一 fork 一生只唤醒一次, 不复读(定向验证局实锤的"未消费重复唤醒"由此根治);
        // 返回是否存在**非终态**题的 fork(决定是否唤醒)。
        const evaluateInbox = (onlyCode?: string): boolean => {
          try {
            if (!existsSync(inboxDir)) return false // 信箱尚未创建 = 无分叉
            let live = false
            for (const f of readdirSync(inboxDir).filter(f => f.endsWith('.jsonl'))) {
              const code = f.replace(/\.jsonl$/, '')
              if (onlyCode !== undefined && code !== onlyCode) continue
              if (!progressTerminal(code)) live = true
              try { absorbForkInbox(code) } catch { /* 吸收失败: 文件仍在, 下次再试(可能重复唤醒, 可接受兜底) */ }
            }
            return live
          } catch { return true } // 真读盘错误: 保守唤醒
        }
        let inboxBefore = inboxSnap()
        const fv = setInterval(() => {
          if (inboxSnap() === inboxBefore) return
          inboxBefore = inboxSnap()
          if (state === undefined) {
            // 执行者会话无 progress 语义: 沿用旧行为(变化即唤醒)
            done('xiaochang_wait: fork inbox changed — read xiaochang_graph and dispatch the untaken branches')
            return
          }
          // 主 agent: 终态题 fork 静默归档(不唤醒, 防迟到回放增兵冲动); 活跃题 fork 照常唤醒。
          if (evaluateInbox(codeFilter)) done('xiaochang_wait: fork inbox changed — read xiaochang_graph and dispatch the untaken branches')
        }, 2000)
        // ④ 超时
        const to = setTimeout(() => done(`xiaochang_wait: timeout after ${Math.round(timeoutMs / 1000)}s, no event`), timeoutMs)
        cleanup = () => { unsub(); clearInterval(iv); clearInterval(sv); clearInterval(fv); clearTimeout(to) }
        // v7.1 wait 入口评估: 两次 wait 之间写入的 fork 不落盲区——终态题归档(不唤醒), 活跃题立即唤醒。
        if (state !== undefined && evaluateInbox(codeFilter)) {
          inboxBefore = inboxSnap()
          done('xiaochang_wait: fork inbox changed — read xiaochang_graph and dispatch the untaken branches')
        }
      })
    },
  }))

  register(defineTool({
    name: 'xiaochang_finish',
    description:
      'Close all open containers, stop the ranking clock via the platform finish endpoint (when all challenges are terminal or you decide to end), and return the final platform score. force=true writes the hosted-guard marker even when not all-terminal (verification/early-stop runs only — the formal campaign must reach all-terminal).',
    parameters: {
      force: { type: 'boolean', description: 'Write the guard stand-down marker even if not all-terminal. For verification/emergency runs only.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { force?: boolean }, exec) {
      // v7.6: 调度权单点——收官只有主 agent 可做(执行者误调 = 战役终结)。
      if (parentAgent !== undefined && exec.agent !== parentAgent) {
        return 'xiaochang_finish: 拒绝——收官是主 agent 专属(单调度器); 执行者解完题直接收工即可'
      }
      const s = requireState()
      let closedCount = 0
      for (const ch of s.challenges.values()) {
        if (ch.container_status === 'available' || ch.container_status === 'pending') {
          try { await s.adapter.close(ch.unique_code) } catch { /* 忽略 */ }
          closedCount += 1
        }
        s.progress.update(ch.unique_code, { containerClosed: true })
      }
      // v7.6: 收尾释放全部授权并清空排队者。
      for (let i = 0; i < closedCount; i++) { try { await s.containerQueue?.release() } catch { /* 忽略 */ } }
      for (const w of s.containerQueue?.waiters() ?? []) {
        try { s.containerQueue?.evict(w.holderId, 'campaign finished') } catch { /* 忽略 */ }
      }
      persistProgress(s)
      // 虎符收尾：终态快照落盘并移入归档（防下个进程误恢复本战役）。
      if (campaignId !== undefined) holder.finish?.(campaignId)
      const final = await s.adapter.listChallenges()
      const score = s.adapter.scoreOf(final)
      const allTerminal = final.every(ch => ch.is_completed || ['failed', 'skipped'].includes(s.progress.get(ch.unique_code)?.state ?? ''))
      // F30 托管守卫标记：全终态才算战役完成——hosted-guard 见到标记才 standing down
      // （没打完的局, driver 怎么退都会被 guard 重拉; 停表条款由此机制化）。
      let guardMarker = ''
      if (allTerminal || args.force === true) {
        try {
          const markerPath = process.env.GUARD_MARKER ?? join(process.cwd(), '.campaign-finished')
          writeFileSync(markerPath, JSON.stringify({ at: Date.now(), score: score.score, max: score.max, completed: score.completed }))
          guardMarker = `\n守卫标记已写（${markerPath}）——进程退出后沙箱结束、平台判局终。`
        } catch { /* 标记失败不影响收尾 */ }
      }
      // run 11 实锤（F28）：旧实现平台停表失败/缺参时静默吞掉、工具仍返回成功，
      // agent 误报 "clock stopped"，排名钟空转 ~5 分钟靠值守方补调才停。
      // 新规：停表结果必须在返回值里大声报告——绝不静默成功，也绝不在没停表时报停表。
      let clock: string
      if (s.runBearerToken === undefined || s.runId === undefined) {
        clock = '⚠️ 平台停表未执行（排名钟仍在走）：缺 runBearerToken/runId。请补调 xiaochang_setup 传入 runId+runBearerToken（或 env RUN_BEARER_TOKEN）后重试 xiaochang_finish'
      } else if (!allTerminal) {
        clock = 'ℹ️ 存在非终态题，未调平台停表'
      } else {
        try {
          const res = await fetch(`${s.baseURL}/api/v1/runs/${s.runId}/finish`, {
            method: 'POST',
            headers: { authorization: `Bearer ${s.runBearerToken}` },
          })
          if (!res.ok) throw new Error(`finish ${res.status}`)
          clock = '✅ 平台停表已确认（HTTP 200）'
        } catch (error) {
          clock = `⚠️ 平台停表调用失败：${String(error)} —— 排名钟仍在走，请重试 xiaochang_finish`
        }
      }
      return `xiaochang_finish: score=${s.platformScore ?? score.score}/${score.max} (${score.completed}/${final.length} completed${score.completed === final.length ? ', ALL TERMINAL' : ''}${s.platformScore !== undefined ? ', 平台权威分' : ', 本地估算分'})\n排名钟：${clock}${guardMarker}`
    },
  }))
}
