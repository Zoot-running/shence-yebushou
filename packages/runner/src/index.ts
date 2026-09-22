/**
 * 校场 v2：主 agent 工具集（调度权还给主 agent）。
 * runner 只做四件事：平台六原语、虎符战役执行（入队/派单/收果/剪枝）、
 * 状态与画像落盘、自动记账（超时败绩 + OBSERVATIONS 画像积累）。
 * 判断全归主 agent：何时征集思路（jisi_fanout）、派谁（jisi_model_report）、
 * 交不交卷、何时 finish——runner 提供工具与事实，不替主 agent 做决策。
 * @module @shence/xiaochang-runner
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { loadavg } from 'node:os'
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
  attachmentFetchCandidates,
  attachmentLikely,
  baseId,
  buildWarmupPrompt,
  cleanRoomGate,
  codeOf,
  dedupeForkPaths,
  familyOf,
  gradedLine,
  hintGateV2,
  knowledgeSkeleton,
  parseHandoffForks,
  parseObservations,
  replaceKnowledgeSection,
  resolveExecutor,
  resourceClassOf,
  roundOf,
  sealedClustersOf,
  sweepLegacyWorkdir,
  templateOf,
  TEMPLATE_LIBRARY,
  truncateDirective,
  type ExecutorPolicy,
  type FamilyTemplate,
  type GradedKnowledge,
  type KnowledgeSection,
} from './orchestrator.ts'
import {
  applySettle,
  adjudicate,
  clusterMapOf,
  compareRisk,
  flagLine,
  foldFlags,
  grant,
  makePending,
  newOrch,
  parseFlagLines,
  parseOrchState,
  pendingFlagsOf,
  priorityOf,
  rearmByTimebox,
  serializeOrchState,
  settleAction,
  timeboxExpired,
  type ChallengeOrch,
  type FlagEntry,
  type FlagStatus,
  type PendingAdjudication,
  type ProgressSnapshot,
  type SettleProgress,
} from './challenge-orch.ts'

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
    grantedCount?(): number
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
  /** v8.4: 设预算截止墙钟(ms)——集思末段禁新 fanout 的门。 */
  setDeadline?(deadlineTs: number): void
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
  /** v8: 单次授予时间盒(分钟, 默认 30; 本地干跑可调小以验证时间盒路径)。 */
  timeboxMinutes?: number
  /** v7.8: 模型白名单(逗号分隔字符串或省略)——空=不限制; 本地干跑局传 deepseek 系(网关不可达的模型不进自动 R2/派单校验)。 */
  modelWhitelist?: string | string[]
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
  /** v7.6: 容器资源队列(虎符原语, 校场注入平台判定)。 */
  containerQueue?: Awaited<ReturnType<NonNullable<HufuHolderLike['resourceQueue']>>>
  /** v7.8: 每 code 单调派单计数器(item id 唯一性归机制——同 round 重派不再吞单)。 */
  enqCounters: Map<string, number>
  /** v7.8: 模型白名单(空 = 不限制; 本地干跑可配 deepseek 系)。 */
  modelWhitelist: string[]
  /** v8: 题队列编排态(每 code; 机制唯一写者, 主 agent 裁决只经 report 工具)。 */
  orch: Map<string, ChallengeOrch>
  /** v8: 待决事项(未裁决持续置顶; >30min 加 ⚠️ 强化)。 */
  pendingAdj: PendingAdjudication[]
  /** v8: 编排态落盘路径(崩溃恢复)。 */
  orchPath: string
  /** v8: 已武装(acquire 在途)的题码。 */
  armed: Set<string>
  /** v8: 队列已授予(持槽)的题码——release 必须与 grant 配对(防 local 题误减队列计数)。 */
  grantedCodes: Set<string>
  /** v8: 已结算的 item id(settle 事件与 collect 扫描双通道去重)。 */
  settleProcessed: Set<string>
  /** v8: 编排态版本号(每次变化+1; wait/仪表感知变化)。 */
  orchVersion: number
  /** v8: 单次授予时间盒(ms; setup 可调, 默认 30min)。 */
  timeboxMs: number
  /** v8: 编排心跳计数(仪表面包屑——托管失联时诊断宿主是否还活着)。 */
  tickCount: number
  /** v8.3 计分表: code → 该题已得累计分(submit 回执 cumulative_score, 平台单题语义; 求和=run 总分)。 */
  scoreTable: Record<string, number>
  /** v8.4: hint 闸已开待取的题码(wait 主动推送; 主 agent 取 hint 后移除)。 */
  hintGateOpen: Set<string>
  /** v8.5: 主 agent 人工收兵的执行者 item id(settle 不计败绩, 只审计)。 */
  manualInterrupted: Set<string>
}

let state: CampaignState | undefined
let heartbeatTimer: ReturnType<typeof setInterval> | undefined
let tickTimer: ReturnType<typeof setInterval> | undefined

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

/** v6: 该 code 的过滤失败计数——剔除故障窗口内与 provider 错误签名的失败(DS 故障夜实锤)。v8: blocked 与"打过但未破"(orch.settleNoFlag 在调用方加)也算真实败绩。 */
function filteredFailedOf(code: string, campaign: HufuLike | undefined): { failed: number; excluded: number; excludedReasons: string[] } {
  const windows = readOutageWindows()
  let failed = 0
  let excluded = 0
  const excludedReasons: string[] = []
  for (const v of campaign?.ledger.views() ?? []) {
    if ((v.state !== 'failed' && v.state !== 'blocked') || codeOf(v.item.id) !== code) continue
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
  type KnowledgeIn = { kind: string; path: string; conclusion?: string; evidence?: string; by?: string; at?: number; testedVariants?: string[] }
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
  // ── v8.4 思路信箱: fanout 采纳思路的消费状态跟踪(落盘=unconsumed, 派兵=consumed) ──
  interface IdeaEntry {
    id: string
    text: string
    status: 'unconsumed' | 'consumed'
    adoptedAt: number
    consumedByDirective?: string
    consumedAt?: number
  }
  const ideaInboxDir = (): string => join(process.env.DSH_HOME ?? '.', 'storages', 'xiaochang-idea-inbox')
  function readIdeas(code: string): IdeaEntry[] {
    const p = join(ideaInboxDir(), `${code}.jsonl`)
    if (!existsSync(p)) return []
    const out: IdeaEntry[] = []
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try { out.push(JSON.parse(line) as IdeaEntry) } catch { /* 坏行跳过 */ }
    }
    return out
  }
  function writeIdeas(code: string, entries: IdeaEntry[]): string {
    mkdirSync(ideaInboxDir(), { recursive: true })
    const p = join(ideaInboxDir(), `${code}.jsonl`)
    appendFileSync(p, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
    return p
  }
  function unconsumedIdeas(code: string): IdeaEntry[] {
    return readIdeas(code).filter(e => e.status === 'unconsumed')
  }
  /** 派兵即消费: enqueue 引用 ideaIds → 状态写 consumed(附 directive 指纹)。 */
  function markIdeasConsumed(code: string, ids: string[], directiveFingerprint: string): number {
    const all = readIdeas(code)
    let n = 0
    // v8.4.1: 短标签匹配——adopt 落盘 id = `<code>-<id>`, enqueue 传短标签(<id>)也算命中
    // (20633 实锤: 短标签静默 no-op = 最危险的一种失败)。
    const hit = (eid: string): boolean => ids.some(id => eid === id || eid.endsWith('-' + id))
    const next = all.map(e => {
      if (e.status === 'unconsumed' && hit(e.id)) {
        n += 1
        return { ...e, status: 'consumed' as const, consumedByDirective: directiveFingerprint, consumedAt: Date.now() }
      }
      return e
    })
    if (n > 0) {
      mkdirSync(ideaInboxDir(), { recursive: true })
      writeFileSync(join(ideaInboxDir(), `${code}.jsonl`), next.map(e => JSON.stringify(e)).join('\n') + '\n')
    }
    return n
  }
  // ── v8.4 截断 v2: 全文落盘(方向段文件), 反馈带路径, frame 附路径 ──
  const directivesDir = (): string => join(process.env.DSH_HOME ?? '.', 'storages', 'xiaochang-directives')
  function persistFullDirective(code: string, full: string): string {
    mkdirSync(directivesDir(), { recursive: true })
    const p = join(directivesDir(), `${code}.jsonl`)
    appendFileSync(p, JSON.stringify({ at: Date.now(), text: full }) + '\n')
    return p
  }
  function directivePathOf(code: string): string {
    return join(directivesDir(), `${code}.jsonl`)
  }
  // ── v8.4 fanout 报告信箱(jisi 侧写, runner wait 轮询唤醒主 agent) ──
  const fanoutInboxDir = (): string => join(process.env.DSH_HOME ?? '.', 'storages', 'xiaochang-fanout-inbox')
  // ── v8.4 模板库: 内置七族为源(v8.4 起; 运行时可编辑文件留待后续版本) ──
  function templateLibraryRuntime(): readonly FamilyTemplate[] {
    return TEMPLATE_LIBRARY
  }
  function templateSections(): Map<string, string> {
    const out = new Map<string, string>()
    for (const t of templateLibraryRuntime()) out.set(t.family, templateFrameText(t))
    return out
  }
  function templateFrameText(t: FamilyTemplate): string {
    return `家族战术(${t.name}): ${t.tactics}\n判据: ${t.criteria}\n陷阱: ${t.traps}`
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

  // ── v8.3 旗仓(单文件追加日志; 写者=工具; 执行者侧无战役态也可写) ──
  const flagsPath = (): string => join(process.env.DSH_HOME ?? '.', 'storages', 'xiaochang-flags.jsonl')
  function readFlagEntries(): FlagEntry[] {
    try {
      const p = flagsPath()
      return existsSync(p) ? parseFlagLines(readFileSync(p, 'utf8')) : []
    } catch { return [] }
  }
  function appendFlagEntry(e: FlagEntry): void {
    try {
      mkdirSync(dirname(flagsPath()), { recursive: true })
      appendFileSync(flagsPath(), flagLine(e) + '\n')
    } catch { /* 旗仓写失败不阻断 */ }
  }
  /** submit 回执 → 旗仓状态行(accepted/rejected; "改"操作由 submit 内部代劳)。 */
  function recordFlagVerdict(code: string, flag: string, status: FlagStatus, verdict?: string, flagIndex?: number): void {
    appendFlagEntry({ code, flag, by: 'submit', status, verdict, ...(flagIndex !== undefined ? { flagIndex } : {}), at: Date.now() })
    const s = state
    if (s !== undefined) { s.orchVersion += 1 }
  }
  // ── v8 题队列编排内核接线 ──────────────────────────────────────
  const orchFor = (code: string): ChallengeOrch | undefined => state?.orch.get(code)
  function bumpOrch(s: CampaignState): void { s.orchVersion += 1 }
  function persistOrch(s: CampaignState): void {
    try { writeFileSync(s.orchPath, serializeOrchState(s.orch, s.pendingAdj, s.scoreTable)) } catch { /* 落盘失败不致命 */ }
  }
  /** v8.3 计分表: 平台每题累计分入表(submit 回执驱动; 求和即 run 总分, 不自算)。 */
  function recordScore(s: CampaignState, code: string, cumulative: number): void {
    s.scoreTable[code] = cumulative
    bumpOrch(s)
    persistOrch(s)
  }
  function runScoreOf(s: CampaignState): number {
    return Object.values(s.scoreTable).reduce((a, b) => a + b, 0)
  }
  function addPending(s: CampaignState, pa: PendingAdjudication): void {
    s.pendingAdj = s.pendingAdj.filter(x => !(x.code === pa.code && x.kind === pa.kind)).concat(pa)
  }
  function removePending(s: CampaignState, code: string, kind?: PendingAdjudication['kind']): void {
    s.pendingAdj = s.pendingAdj.filter(x => x.code !== code || (kind !== undefined && x.kind !== kind))
  }
  /** v8: release 与 grant 配对——只有真持槽的题才释放队列授权(防计数漂移)。 */
  async function releaseGrant(code: string): Promise<void> {
    const s = requireState()
    if (!s.grantedCodes.delete(code)) return
    try { await s.containerQueue?.release() } catch { /* 释放失败不阻断 */ }
  }
  function findingsLines(code: string): number {
    try {
      const p = c().boardPath(code)
      return existsSync(p) ? readFileSync(p, 'utf8').split('\n').length : 0
    } catch { return 0 }
  }
  /** 题号工件目录文件数(两种命名: f1-02 与 f102 都试)。 */
  function artifactCount(code: string): number {
    let n = 0
    for (const name of [code, code.replace(/-/g, '')]) {
      try {
        const dir = join(process.cwd(), name)
        if (existsSync(dir)) for (const f of walk(dir)) if (!f.endsWith('.pyc')) n += 1
      } catch { /* 忽略 */ }
    }
    return n
  }
  function snapshotProgress(code: string): ProgressSnapshot {
    return { at: Date.now(), findingsLines: findingsLines(code), forkCount: knowledgeOfCode(code).length, artifactCount: artifactCount(code) }
  }
  function ensureVq(code: string) {
    const s = requireState()
    const ch = s.challenges.get(code)
    let vq = s.v2[code]
    if (vq === undefined) {
      vq = {
        qtype: classifyQtype(ch?.description ?? ''),
        difficulty: difficultyPrior(ch?.total_score ?? 300),
        wins: 0, fails: 0, gaps: [], triedModels: [], ideaRound: 1, deadIdeas: 0, adopted: 0,
      }
      s.v2[code] = vq
      persistV2(s)
    }
    return vq
  }
  function gapsTxtOf(code: string): string {
    const s = requireState()
    const vq = s.v2[code]
    if (vq === undefined || vq.gaps.length === 0) return ''
    return '\n\n已知上下文缺口(前序执行者反馈缺的信息, 若你能补则补, 不能补则明确说缺什么):\n' + vq.gaps.slice(-5).map(g => `- ${g}`).join('\n')
  }
  /** 模型校验(与 enqueue 同一套护栏); 返回 null = 可派。 */
  async function validateExecutorModel(model: string): Promise<string | null> {
    const s = requireState()
    if (jisi === undefined) return null
    try {
      if (s.modelWhitelist.length > 0 && !s.modelWhitelist.includes(model)) return `白名单外`
      const listed = await jisi.listModels()
      if (!listed.some(m => m.id === model)) return `不在模型目录`
      if (await jisi.isModelQuarantined?.(model)) return `provider 余额枯竭`
    } catch { /* 校验失败不阻断(兜底缺省模型) */ }
    return null
  }
  /** 全开多路时的模型轮换(白名单过滤)。 */
  function pickSpawnModel(_code: string, idx: number): string {
    const s = requireState()
    const allow = (m: string): boolean => s.modelWhitelist.length === 0 || s.modelWhitelist.includes(m)
    const mix = ['deepseek-v4-flash', 'deepseek-flash', 'glm-5.3'].filter(allow)
    if (mix.length === 0) return s.executorPolicy.defaultModel
    return mix[idx % mix.length]!
  }
  const VERIFIER_DIRECTIVE = '[验证兵] 独立复验账本里的 blocker 结论("无攻击面/环境缺失/未发布"类): 不要信任前序判定, 重跑探测确认。输出开头一行 "复验: 确认" 或 "复验: 推翻", 附证据; 若推翻, 立即继续解题(先读知识账本, 从已知边界出发)。'
  /** v8: 串行 spawn 泵——v7 的派单是单工具串行(回合上下文); v8 挪进分离链后必须恢复串行不变量。 */
  const spawnQueue: string[] = []
  let spawning = false
  async function pumpSpawns(): Promise<void> {
    if (spawning) return
    spawning = true
    try {
      while (spawnQueue.length > 0) {
        const code = spawnQueue.shift()!
        await grantAndSpawn(code).catch(err => {
          const s = requireState()
          s.armed.delete(code)
          audit(s.auditPath, { type: 'v8-spawn-error', code, error: String(err) })
        })
      }
    } finally {
      spawning = false
    }
  }
  function requestSpawn(code: string): void {
    spawnQueue.push(code)
    void pumpSpawns()
  }
  /** v8.5: 在途执行者清单(授予题: itemId/模型/已跑分钟/槽剩余分钟)——主 agent 调度决策的事实输入。 */
  const inflightSummary = (): string => {
    const s = requireState()
    const now = Date.now()
    const lines: string[] = []
    for (const [code, o] of s.orch) {
      if (o.state !== 'granted') continue
      const items = c().ledger.views().filter(v => codeOf(v.item.id) === code && (v.state === 'dispatched' || v.state === 'help' || v.state === 'stalled'))
      const boxLeft = o.grantedUntil !== undefined ? Math.max(0, Math.round((o.grantedUntil - now) / 60000)) : '?'
      const itemTxt = items.length === 0
        ? '在途0(槽空转——可 enqueue 该题加 dispatchNow 当场补兵)'
        : items.map(v => {
          const w = v.item.id.split('#')[1] ?? v.item.id
          const at = v.dispatchedAt ?? now
          const mins = Math.round((now - at) / 60000)
          const stale = now - at > 45 * 60_000 ? '⚠️>45m' : ''
          return `${w}@${v.item.model ?? '?'}已${mins}m${stale}`
        }).join(' ')
      lines.push(`  ${code}[盒剩${boxLeft}m·在途${items.length}] ${itemTxt}`)
    }
    return lines.length > 0 ? lines.join('\n') : '(无授予槽/在途执行者)'
  }
  /** v8.5: 全容器资源读数(cgroup v2 优先, 宿主回退)——容器内只有 DSH, 缺省全量可用, 目标是尽量用满。 */
  const containerResources = (): string => {
    const parts: string[] = []
    try {
      if (existsSync('/sys/fs/cgroup/memory.max')) {
        const maxS = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
        const curS = readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim()
        const maxN = Number(maxS)
        const curMB = Math.round(Number(curS) / 1048576)
        parts.push(maxN > 0 && maxN < 9e15 ? `mem=${curMB}/${Math.round(maxN / 1048576)}MB` : `mem=${curMB}MB(无上限)`)
      } else {
        const m = readFileSync('/proc/meminfo', 'utf8')
        const tot = Number(/MemTotal:\s*(\d+)/.exec(m)?.[1] ?? 0)
        const avl = Number(/MemAvailable:\s*(\d+)/.exec(m)?.[1] ?? 0)
        if (tot > 0) parts.push(`mem=${Math.round((tot - avl) / 1024)}/${Math.round(tot / 1024)}MB(宿主)`)
      }
    } catch { /* 读数失败不阻断 */ }
    try {
      if (existsSync('/sys/fs/cgroup/cpu.stat')) {
        const cs = readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8')
        const u = Number(/usage_usec\s+(\d+)/.exec(cs)?.[1] ?? 0)
        parts.push(`cpuUsed=${Math.round(u / 1e6)}s`)
      }
      if (existsSync('/sys/fs/cgroup/cpu.max')) {
        const q = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim()
        parts.push(q.startsWith('max') ? 'cpuQuota=无上限' : `cpuQuota=${q}`)
      }
    } catch { /* 读数失败不阻断 */ }
    try {
      parts.push(`loadavg=${loadavg().map(x => x.toFixed(2)).join('/')}`)
    } catch { /* 读数失败不阻断 */ }
    return parts.join(' ')
  }
  /** v8.5: 单个执行者生成(授予时与 dispatchNow 共用)。 */
  async function spawnExecutor(code: string, o: ChallengeOrch, d: { text: string; model?: string; effort?: string; persona?: string }, idx: number, prio: number, cls: 'local' | 'container', vq: { triedModels: string[] }): Promise<void> {
    const s = requireState()
    const ch = s.challenges.get(code)
    if (ch === undefined) return
    const workNo = (s.enqCounters.get(code) ?? 0) + 1
    s.enqCounters.set(code, workNo)
    const itemId = `${code}#s${o.attempts}-w${workNo}`
    const executor = resolveExecutor({ model: d.model ?? pickSpawnModel(code, idx), effort: d.effort }, s.executorPolicy)
    const err = await validateExecutorModel(executor.model)
    const model = err === null ? executor.model : s.executorPolicy.defaultModel
    const clusterTxt = o.cluster.length > 0
      ? `\n\n【同靶场兄弟题(共享此容器, 一并收旗)】${o.cluster.map(c2 => {
        const ch2 = s.challenges.get(c2)
        return `${c2}(${ch2?.total_score ?? '?'}pts): 题面 ${(ch2?.description ?? '').slice(0, 80)}; 战报 ${c().boardPath(c2)}; 拿到该题旗同样调 xiaochang_flag_report('${c2}', flag)`
      }).join('\n')}`
      : ''
    const label = buildExecFrame(code, d.text) + clusterTxt + gapsTxtOf(code)
    c().add({
      id: itemId,
      label,
      model,
      reasoningEffort: executor.effort,
      board: code,
      resourceClass: cls,
      priority: { tier: tierOf(ch.difficulty), score: prio },
      ...(d.persona !== undefined && d.persona !== '' ? { persona: d.persona } : {}),
    })
    if (!vq.triedModels.includes(model)) vq.triedModels.push(model)
    persistV2(s)
    audit(s.auditPath, { type: 'v8-spawn', id: itemId, code, attempts: o.attempts, model, class: cls })
    let n = 0
    try {
      while (n < 8) {
        const d2 = await c().dispatchNext()
        if (d2 === undefined) break
        n += 1
      }
    } catch (error) {
      audit(s.auditPath, { type: 'v8-dispatch-error', code, error: String(error) })
    }
  }
  /** v8 原子授予: 队列授予 → 快照 → 生成执行者(带 addr) → 派发。 */
  async function grantAndSpawn(code: string): Promise<void> {
    const s = requireState()
    s.armed.delete(code)
    const o = orchFor(code)
    // v8.4.2: 授予落地时题已不在 queued(裁决/降级/换实例竞态) → 必须释放队列授予,
    // 否则队列 granted 永久 +1 幽灵槽(20733 实锤: granted=3/3 只 1 槽在转, 2 槽死锁)。
    if (o === undefined || o.state !== 'queued') {
      try {
        await releaseGrant(code)
        audit(s.auditPath, { type: 'v8-grant-miss', code, state: o?.state ?? 'no-orch' })
      } catch { /* 释放失败不阻断 */ }
      return
    }
    try {
      const fresh = await s.adapter.listChallenges()
      for (const x of fresh) s.challenges.set(x.unique_code, x)
    } catch { /* 刷新失败继续(用缓存) */ }
    const ch = s.challenges.get(code)
    if (ch === undefined) return
    const cls = resourceClassOf(ch)
    const prio = priorityOf(o, ch.total_score, Date.now())
    const snapshot = snapshotProgress(code)
    // v8.3c 同靶场簇: 按 addr 聚簇(平台共享实例), 簇主码一兵多题签。
    const addrMap = new Map<string, string[]>()
    for (const c2 of s.challenges.values()) {
      if (c2.container_addr.length > 0) addrMap.set(c2.unique_code, c2.container_addr)
    }
    const clusters = clusterMapOf(addrMap)
    const detected = clusters.get(code) ?? []
    // 簇身份持久化: addr 探测为空(实例未分配)时沿用历史簇, 不丢身份。
    const siblings = detected.length > 0 ? detected : o.cluster
    for (const sb of siblings) {
      const so = s.orch.get(sb)
      if (so !== undefined && so.state === 'queued') {
        // 兄弟题随簇授予(共享容器): 同态标注, 摘除其队列等待位, 不再单独开容器。
        grant(so, snapshot, Date.now(), s.timeboxMs)
        so.cluster = [code, ...siblings.filter(x => x !== sb)]
        s.armed.delete(sb)
        try { s.containerQueue?.evict(sb, 'cluster-granted (共享容器, 随簇主码派兵)') } catch { /* 摘位失败不阻断 */ }
        audit(s.auditPath, { type: 'v8-cluster-absorb', code, sibling: sb })
      }
    }
    o.cluster = siblings
    grant(o, snapshot, Date.now(), s.timeboxMs)
    // v8.5.1 扁平化: 授予恒 1 路(机制底线); 加码全走 dispatchNow(主 agent 按事实决策)。
    const vq = ensureVq(code)
    const memberCodes = [code, ...o.cluster]
    // v8.3c 簇调度: 思路取簇内全体成员未试思路的并集(对任一成员投的思路都生效)。
    const untried = memberCodes.flatMap(c2 => {
      const oo = s.orch.get(c2)
      return (oo?.directives ?? []).filter(d => !d.tried)
    })
    const d = untried.shift() ?? { text: '按账本+画像自由突破: 先读知识账本, 从已知边界出发, 不打死路' }
    for (const c2 of memberCodes) {
      const orig = s.orch.get(c2)?.directives.find(x => x.text === d.text)
      if (orig !== undefined) orig.tried = true
    }
    await spawnExecutor(code, o, d, 0, prio, cls, vq)
    audit(s.auditPath, { type: 'v8-grant', code, spawn: 1 })
    bumpOrch(s)
    persistOrch(s)
    persistProgress(s)
  }
  /** v8 武装循环: 把 queued 题按优先级武装进容器队列(题是队列单元, 执行者零等待)。 */
  function armQueue(): void {
    const s = requireState()
    const q = s.containerQueue
    if (q === undefined) return
    const now = Date.now()
    const codes = [...s.challenges.keys()].sort((a, b) => {
      const pa = priorityOf(s.orch.get(a) ?? newOrch(a, now), s.challenges.get(a)?.total_score ?? 300, now)
      const pb = priorityOf(s.orch.get(b) ?? newOrch(b, now), s.challenges.get(b)?.total_score ?? 300, now)
      return pb - pa
    })
    for (const code of codes) {
      const o = s.orch.get(code)
      if (o === undefined || o.state !== 'queued') continue
      if (s.armed.has(code)) continue
      const p = s.progress.get(code)
      if (p !== undefined && (p.state === 'complete' || p.state === 'failed' || p.state === 'skipped')) continue
      const ch = s.challenges.get(code)
      if (ch === undefined) continue
      if (resourceClassOf(ch) === 'local') {
        s.armed.add(code)
        requestSpawn(code)
        continue
      }
      s.armed.add(code)
      void q.acquire(code).then(res => {
        if (res.status === 'granted') {
          const o2 = s.orch.get(code)
          if (o2 === undefined || o2.state !== 'queued') {
            // v8.4.2: 授予与状态竞态 → 归还槽位(防幽灵授予)。
            void q.release().catch(() => {})
            s.armed.delete(code)
            audit(s.auditPath, { type: 'v8-arm-grant-race', code, state: o2?.state ?? 'no-orch' })
          } else {
            s.grantedCodes.add(code)
            requestSpawn(code)
          }
        } else {
          s.armed.delete(code)
          audit(s.auditPath, { type: 'v8-arm-drop', code, status: res.status, reason: res.reason })
        }
      }).catch(err => audit(s.auditPath, { type: 'v8-arm-error', code, error: String(err) }))
    }
  }
  /** v8 settle 结算(事件 + collect 扫描双通道, settleProcessed 去重)。 */
  async function settleClassify(itemId: string, detail: string): Promise<void> {
    const s = requireState()
    const code = codeOf(itemId)
    const o = s.orch.get(code)
    if (o === undefined) return
    if (s.settleProcessed.has(itemId)) return
    s.settleProcessed.add(itemId)
    const now = Date.now()
    // v8.5: 主 agent 人工收兵的执行者 settle 只审计, 不计无旗败绩、不触发升级梯
    // (否则主 agent 不敢提前收兵, 又退回"跑满盒"——用户裁定)。
    if (s.manualInterrupted.has(itemId)) {
      audit(s.auditPath, { type: 'v8-settle-manual', itemId, code })
      // v8.5.2d 孤儿容器修复(21013 a-02 实锤): 收兵收回最后一兵时, 补上正常 settle 的
      // "关容器+释放槽"——否则平台容器开着占 3 名额、题已回队, tick 空转不授予新题。
      const memberCodes = [code, ...(o.cluster ?? [])]
      const hasOthers = c().ledger.views().some(x => x.item.id !== itemId && memberCodes.includes(codeOf(x.item.id))
        && (x.state === 'dispatched' || x.state === 'help' || x.state === 'stalled'))
      if (!hasOthers) {
        try { await s.adapter.close(code) } catch { /* 平台侧已关 */ }
        await releaseGrant(code)
        s.progress.update(code, { containerClosed: true })
        audit(s.auditPath, { type: 'v8-settle-manual-close', itemId, code })
      }
      return
    }
    const sn = o.snapshot
    const pendingFlags = pendingFlagsOf(readFlagEntries(), code)
    const p: SettleProgress = {
      flagCandidate: pendingFlags.length > 0,
      findingsDelta: sn !== undefined ? Math.max(0, findingsLines(code) - sn.findingsLines) : 0,
      forkDelta: sn !== undefined ? Math.max(0, knowledgeOfCode(code).length - sn.forkCount) : 0,
      artifactsDelta: sn !== undefined ? Math.max(0, artifactCount(code) - sn.artifactCount) : 0,
      detail,
    }
    // v8.4 交接未竟动作: settle 文本里的"未竟/下一步"行转未走分叉(换人/换实例不丢临门一脚)。
    const handoff = parseHandoffForks(detail)
    if (handoff.length > 0) {
      const entries: KnowledgeIn[] = handoff.map(h => ({ kind: 'fork', path: h.path, conclusion: h.conclusion, by: `settle-${itemId}`, at: now }))
      try {
        recordKnowledgeOnCode(code, entries)
        appendKnowledgeFile(code, 'forks', handoff.map(h => `${h.path} → ${h.conclusion}`))
      } catch { /* 交接转分叉失败不阻断 */ }
    }
    // v8.5.1 验证兵降级: 封印簇只算事实 → 写待裁决建议(按簇分类+计数), 不自动派兵
    // (用户裁定: 机制已不知道运行情况, 盲目派兵可能卡死; 派不派、怎么派归主 agent)。
    const maybeSuggestVerifier = (): void => {
      const sealed = sealedClustersOf(knowledgeOfCode(code).filter(k => k.kind === 'dead-end'))
      if (sealed.length > 0 && o.state !== 'dead' && o.state !== 'solved') {
        const summary = `验证建议: ${code} 死路封印簇 ${sealed.map(x => `${x.direction}×${x.count}`).join('|')} — 建议派验证兵翻案(可抄令文: ${VERIFIER_DIRECTIVE})`
        addPending(s, makePending(code, 'needs-verdict', summary, c().boardPath(code), now))
        audit(s.auditPath, { type: 'v8-verifier-suggest', code, sealed: sealed.map(x => `${x.direction}×${x.count}`) })
      }
    }
    // v8.4 判死修复: 时间盒已把题回队(状态≠granted)时, 迟到的 settle 依然计真实败绩——
    // 20390 hint 闸饿死 2.5h 的直接病灶(执行者跑满时间盒 → 时间盒先回队 → settle 被跳过)。
    if (o.state !== 'granted') {
      if (!p.flagCandidate) o.settleNoFlag += 1
      maybeSuggestVerifier()
      refreshHintGate(s, code)
      bumpOrch(s)
      persistOrch(s)
      audit(s.auditPath, { type: 'v8-settle-late', itemId, code, state: o.state, settleNoFlag: o.settleNoFlag })
      return
    }
    const action = settleAction(o, p)
    applySettle(o, action, detail, now)
    if (!p.flagCandidate) o.settleNoFlag += 1
    const board = c().boardPath(code)
    const sealed = sealedClustersOf(knowledgeOfCode(code).filter(k => k.kind === 'dead-end'))
    if (action === 'pending-flag') {
      addPending(s, makePending(code, 'flag-candidate', `${code} 有旗待提交: 尽快 xiaochang_submit(容器在线宽限 15min, 超时容器关/旗值可能轮换)`, board, now))
    } else if (action === 'adjudicate') {
      const sealTxt = sealed.length > 0
        ? ` 死路封印簇 ${sealed.map(x => `${x.direction}×${x.count}`).join('|')} — 建议派验证兵翻案`
        : ''
      addPending(s, makePending(code, 'needs-verdict', `${code} 零进展×${o.zeroProgressStreak} 挂裁决: 主 agent 裁决 判死/续打/拉hint(闸已开)${sealTxt}`, board, now))
    }
    // 关容器+释放槽(有旗待提交不关; 同题仍有在途不关)。
    const hasOthers = c().ledger.views().some(x => x.item.id !== itemId && codeOf(x.item.id) === code
      && (x.state === 'dispatched' || x.state === 'help' || x.state === 'stalled'))
    if (action !== 'pending-flag' && !hasOthers) {
      try { await s.adapter.close(code) } catch { /* 平台侧已关 */ }
      await releaseGrant(code)
      s.progress.update(code, { containerClosed: true })
    }
    // v8.3c 簇内同态: 兄弟题执行同一结算动作(簇=单调度单元, 不分裂)。
    for (const sb of o.cluster) {
      const so2 = s.orch.get(sb)
      if (so2 !== undefined && so2.state === 'granted') {
        const p2: SettleProgress = { ...p, flagCandidate: pendingFlagsOf(readFlagEntries(), sb).length > 0 }
        const action2 = settleAction(so2, p2)
        applySettle(so2, action2, detail, now)
        if (!p2.flagCandidate) so2.settleNoFlag += 1
        if (action2 === 'pending-flag') {
          addPending(s, makePending(sb, 'flag-candidate', `${sb} 有旗待提交: 尽快 xiaochang_submit(容器在线宽限 15min)`, c().boardPath(sb), now))
        }
        audit(s.auditPath, { type: 'v8-settle-cluster', itemId, code, sibling: sb, action: action2 })
      }
    }
    if (action !== 'adjudicate') maybeSuggestVerifier()
    audit(s.auditPath, { type: 'v8-settle', itemId, code, action, flagCandidate: p.flagCandidate, settleNoFlag: o.settleNoFlag })
    refreshHintGate(s, code)
    for (const sb of o.cluster) refreshHintGate(s, sb)
    bumpOrch(s)
    persistOrch(s)
    persistProgress(s)
    if (action !== 'pending-flag') armQueue()
  }
  /** v8.4: 判死条件满足 → hint 闸开 + wait 主动推送(治 20390 习得性无助)。 */
  function refreshHintGate(s: CampaignState, code: string): void {
    const o = s.orch.get(code)
    if (o === undefined || o.state === 'solved' || o.state === 'dead') return
    const used = s.hintLedger.get(code)?.hints ?? 0
    if (used >= s.maxHints) return
    const vq = s.v2[code]
    const gate = hintGateV2({
      ideaRound: vq?.ideaRound ?? 1,
      settleNoFlag: o.settleNoFlag ?? 0,
    })
    if (gate.allowed) {
      if (!s.hintGateOpen.has(code)) {
        s.hintGateOpen.add(code)
        audit(s.auditPath, { type: 'v8-hint-gate-open', code, settleNoFlag: o.settleNoFlag, ideaRound: vq?.ideaRound ?? 1 })
      }
    } else {
      s.hintGateOpen.delete(code)
    }
  }
  /** v8 编排心跳: 时间盒到期 → 关容器+回队(账本保留, 升级梯不动)。 */
  async function tickOrch(): Promise<void> {
    const s = requireState()
    const now = Date.now()
    let changed = false
    for (const [code, o] of s.orch) {
      if (!timeboxExpired(o, now)) continue
      if (o.state === 'pending-adjudication') removePending(s, code, 'flag-candidate')
      try { await s.adapter.close(code) } catch { /* 已关 */ }
      await releaseGrant(code)
      rearmByTimebox(o)
      s.progress.update(code, { containerClosed: true })
      audit(s.auditPath, { type: 'v8-timebox', code })
      changed = true
    }
    // v8.5.2d 孤儿容器兜底: 已回队(queued)但平台容器还开着的题(人工收兵/迟到 settle
    // 漏关) → 补关, 把 3 容器名额还回去。
    const orphanCandidates = [...s.orch.entries()].filter(([, o]) =>
      o.state === 'queued' && o.lastGrantAt !== undefined && now - o.lastGrantAt > s.timeboxMs)
    if (orphanCandidates.length > 0) {
      try {
        const fresh = await s.adapter.listChallenges()
        for (const [code] of orphanCandidates) {
          const ch = fresh.find(x => x.unique_code === code)
          if (ch !== undefined && ch.container_status !== undefined && !['stopped', 'closed'].includes(ch.container_status)) {
            try { await s.adapter.close(code) } catch { /* 已关 */ }
            audit(s.auditPath, { type: 'v8-orphan-close', code })
            changed = true
          }
        }
      } catch { /* 刷新失败不阻断 */ }
    }
    if (changed) {
      bumpOrch(s)
      persistOrch(s)
      persistProgress(s)
      armQueue()
    }
  }

  // ── v8.4 执行令框架: 主 agent 写指令, 机制注入题面/入口/账本/画像/纪律/家族模板/节奏约束 ──
  function buildExecFrame(code: string, directive: string): string {
    const s = requireState()
    const ch = s.challenges.get(code)
    if (ch === undefined) return directive
    const cls = resourceClassOf(ch)
    const addrs = ch.container_addr.length > 0
      ? ch.container_addr.join(',')
      : cls === 'local'
        ? '无需容器(本地求解: bash/python 直开)'
        : '容器由调度机制授予——你持槽开工, 无需自行启动/等待容器(执行者没有 start_container 工具)'
    const kn = ensureKnowledgeFile(code)
    const o = s.orch.get(code)
    // v8.4 家族模板帧: 主 agent 指定 family 优先, 缺省按题面自动判定。
    // v8.4.3: 模板降级为"背景速查"——与主 agent 任务冲突时以任务为准(20777 c-03 实锤:
    // 执行者锚定速查表第一条(Dify setup)打了两轮, 主 agent 的 RSC 方向被压过)。
    const family = o?.family ?? familyOf(ch.description ?? '', ch.difficulty)
    const tpl = templateSections().get(family)
    const templateTxt = tpl !== undefined ? `\n${tpl}\n` : ''
    // v8.4 节奏约束(限速/封禁类目标): 主 agent enqueue 显式给的 pacing。
    const pacingTxt = (o?.pacing?.length ?? 0) > 0
      ? `\n【节奏约束(硬, 违反会烧通道)】${o!.pacing!.map(p => `- ${p}`).join('\n')}\n`
      : ''
    // v8.4 截断 v2: 方向段全文落盘路径(截断时自动持久化; 执行者可读全文)。
    const ideas = unconsumedIdeas(code)
    return [
      `【校场执行令 · ${code}】(${cls === 'local' ? '附件题·全并行' : '容器题·3槽轮换'}, ${ch.difficulty}, ${ch.total_score}pts, ${ch.flag_count} flags)`,
      `题面: ${(ch.description ?? '').slice(0, 1200) || '(平台未提供题面——盲打模式: 容器 web 应用做指纹/目录/JS/功能点枚举, 按常见 web 漏洞清单(IDOR/越权/注入/上传/SSRF/鉴权绕过)走查, 卡住按题面线索与 hint 定位漏洞类)'}`,
      `入口: ${addrs}`,
      ...(/(附件|下载)/.test(ch.description ?? '') ? [`附件获取: 平台把附件放在容器 HTTP 上——先 curl 容器根与常见路径(/att/${code}/、/files/${code}.zip、/download、/)枚举拿回附件再解。`] : []),
      `共享战报: ${c().boardPath(code)}`,
      `知识账本(开工必读): ${kn}`,
      `画像(快速读): ${s.profilePath}`,
      `方向段全文(若被截断, 完整版在此): ${directivePathOf(code)}`,
      `你的任务(最高优先级, 与下方速查冲突时以此为准): ${directive}`,
      ...(ideas.length > 0 ? [`未消费采纳思路 ${ideas.length} 条(账本①可见, 可自行拾取): ${ideas.map(i => i.text.slice(0, 80)).join(' | ').slice(0, 400)}`] : []),
      ...(() => {
        const doneIdx = [...new Set(readFlagEntries().filter(e => e.code === code && e.status === 'accepted' && e.flagIndex !== undefined).map(e => e.flagIndex as number))].sort((a, b) => a - b)
        const lines: string[] = []
        if (doneIdx.length > 0) lines.push(`已交旗位: ${doneIdx.join(',')}——勿再上报同旗位轮换值(平台 409 duplicate, 不计新分)`)
        // v8.5.3 多旗题作战帧: 目标旗位 + 同实例内网依赖 + 情报继承(调度决策归主 agent, 帧只给事实与纪律)。
        if (ch.flag_count > 1) {
          const nextIdx = (() => { for (let i = 0; i < ch.flag_count; i++) { if (!doneIdx.includes(i)) return i } return -1 })()
          lines.push(`多旗题作战(共${ch.flag_count}面): ${nextIdx >= 0 ? `目标=下一未交旗位(索引${nextIdx})` : '已交旗位已满(全部旗位都有 accepted 记录)'}`)
          lines.push('  ① 深旗依赖同实例内网: 容器内做网段/邻居发现(扫容器网段与内网跳板), rotate/关容器前把内网情报(网段/凭据/跳板/已获文件)写进战报③;')
          lines.push('  ② 每面旗的路径/凭据/跳板写战报, 下一兵开工先读账本继承, 从已知边界出发。')
        }
        return lines
      })(),
      pacingTxt.trim() !== '' ? pacingTxt.trim() : '',
      templateTxt.trim() !== '' ? `家族: ${family}(背景速查, 与任务冲突以任务为准)${templateTxt}` : '',
      '纪律: ①先读知识账本, 从已知边界出发, 不重复死路, 优先用回收工件;',
      '      ②找到 flag 立即调 xiaochang_flag_report(code, flag) 上报入旗仓(主 agent 负责提交);',
      '      ③死路/新分叉调 xiaochang_fork 上报; 终态前把死路原因写清(附实测变体清单)。',
      '      ④开工先做朴素 5 分钟检查(先于 CVE 链): 登录页/前端 JS 写死的测试账号弱口令、静态文件与数据库文件可直接下载、绝对路径穿越(WAF 只滤字面量 ../ 时用绝对路径)、mass assignment 改字段、/proc/self/environ 泄漏、纯读型越界、题面已给链路的直接复现。',
      '      ⑤批量任务先估量: 进程启动要几十毫秒——单个任务比进程启动还轻(每行一次 urlencode、每词一次查询、每文件一次 grep)时, 禁止每项起一个新进程; 合并成单进程流式(起一次 python/awk 循环读 stdin), 或 xargs -P 限并发; 同类小任务 >50 项即适用; 文件扫描限定目标目录, 禁止 find / 全盘。',
    ].filter(l => l !== '').join('\n')
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
      timeboxMinutes: { type: 'number', description: 'v8 single-grant timebox in minutes (default 30). Local dry runs may pass a smaller value to exercise the timebox path.' },
      modelWhitelist: { type: 'string', description: 'v7.8 model whitelist (comma-separated; empty = no restriction). Local dry runs should pass deepseek models — unreachable models are excluded from auto-R2 and enqueue validation.' },
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
        enqCounters: new Map(),
        modelWhitelist: (typeof args.modelWhitelist === 'string'
          ? args.modelWhitelist.split(',').map(m => m.trim())
          : (args.modelWhitelist ?? [])).filter(m => m !== ''),
        orch: new Map(),
        pendingAdj: [],
        orchPath: join(home, 'storages', `xiaochang-orch-${args.runId ?? 'pending'}.json`),
        armed: new Set(),
        grantedCodes: new Set(),
        settleProcessed: new Set(),
        orchVersion: 0,
        timeboxMs: (args.timeboxMinutes ?? 30) * 60_000,
        tickCount: 0,
        scoreTable: {},
        hintGateOpen: new Set(),
              manualInterrupted: new Set(),
      }
      try {
        if (existsSync(s.profilePath)) s.profile = parseProfile(readFileSync(s.profilePath, 'utf8'))
      } catch { /* 画像损坏：空画像 */ }
      state = s
      // v8.4: 把本 run 预算截止同步给集思(fanout 末段预算门)。
      try { jisi?.setDeadline?.(s.startedAt + s.budgetMs) } catch { /* 集思预算门失败不阻断 */ }
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
          // v7 类闸: 附件题全并行(继承全局 concurrency)。
          // v7.8: 容器题不再在 dispatch 层限 3——3 槽是"容器启动数"约束, 由资源队列在 start 层管;
          // dispatch 层限 3 会把全战役并行掐成 3 车道(run 19097 实锤: 每题首派被拖 90 分钟)。
          resourceLimits: { local: s.concurrency },
        }, [], { id: stableId, boardNamespace: `${args.runId ?? 'pending'}` })
        campaign = created.campaign
        campaignId = created.id
      }
      // v8: 容器资源队列——题队列(武装的是题码, 授予即派兵); 队列原语不变, 授权点唯一。
      // 武装方是 runner 机制(armQueue), 执行者/主 agent 都不直接 acquire; 缺省超时拉满(题该等多久等多久)。
      if (s.containerQueue === undefined && holder.resourceQueue !== undefined) {
        s.containerQueue = holder.resourceQueue({
          capacity: s.containerSlots,
          pollMs: 3000,
          defaultTimeoutMs: Math.max(10 * 60 * 60_000, s.budgetMs + 60 * 60_000),
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
      // v8: 编排态恢复(崩溃/重启幂等)。
      try {
        if (existsSync(s.orchPath)) {
          const back = parseOrchState(readFileSync(s.orchPath, 'utf8'))
          s.orch = back.orch
          s.pendingAdj = back.pending
          s.scoreTable = back.scoreTable
        }
        for (const ch of fresh) {
          if (!s.orch.has(ch.unique_code)) s.orch.set(ch.unique_code, newOrch(ch.unique_code, s.startedAt))
        }
      } catch { /* 编排态损坏: 全量重建 */ }
      persistOrch(s)
      // v8: settle 结算钩子(执行者终态 → 进展分类 → 回队/升级梯/待决) + 编排心跳(时间盒/武装)。
      if (campaignId !== undefined && holder.onSettle !== undefined) {
        holder.onSettle(campaignId, ev => {
          void settleClassify(ev.itemId, ev.text).catch(err => audit(s.auditPath, { type: 'v8-settle-error', itemId: ev.itemId, error: String(err) }))
        })
      }
      if (tickTimer !== undefined) clearInterval(tickTimer)
      tickTimer = setInterval(() => {
        s.tickCount += 1
        void tickOrch().catch(err => audit(s.auditPath, { type: 'v8-tick-error', error: String(err) }))
        armQueue()
      }, 30_000)
      ;(tickTimer as { unref?: () => void }).unref?.()
      armQueue()
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
      // v7.8: 开局暖账(fresh run 才发)——机制化全量 fanout 把模型用满, 不靠主 agent 记得。
      // 每路 prompt 由机制生成(题面+题型+难度, 只要方向/打点); 报告按 [fanout:票] 信封到达, 主 agent 照常裁决。
      let warmup = ''
      if (progress.all().length === 0 && jisi?.fanoutNotify !== undefined) {
        try {
          const allowModel = (m: string): boolean => s.modelWhitelist.length === 0 || s.modelWhitelist.includes(m)
          let delegates = 0
          let hardMulti = 0
          for (const ch of fresh) {
            // v7.9 暖账分层: hard(≥700 分) 自动加 glm-5.3 一路(公开 CyberGym 先验 84.5), easy/medium 一路 flash。
            const models = (ch.total_score ?? 0) >= 700
              ? ['deepseek-flash', 'glm-5.3'].filter(allowModel)
              : ['deepseek-flash'].filter(allowModel)
            if (models.length > 1) hardMulti += 1
            const ticket = jisi.fanoutNotify(agent, { prompt: buildWarmupPrompt(ch) }, models)
            delegates += ticket.models.length
          }
          warmup = delegates > 0
            ? `, 暖账 fanout 已发 ${delegates} 路(hard 题 ${hardMulti} 道为 flash+glm-5.3 双路, 其余 flash 单路; 报告按信封到达请照常裁决——**暖账已覆盖全题, 无需再 jisi_fanout_bulk 全量发; 只对 hard/卡题加模型补征**)`
            : ', 暖账 fanout 0 路实际派发(集思闸/重试上限)——可手动 jisi_fanout_bulk 补征'
        } catch { warmup = ', 暖账 fanout 发送失败(可手动 jisi_fanout_bulk 全量征集)' }
      }
      return `xiaochang_setup ok: ${fresh.length} challenges, concurrency=${s.concurrency} (no threshold), containerSlots=${args.containerSlots ?? 3}, budget ${Math.round(s.budgetMs / 60000)}min, resume=${progress.all().length > 0}, campaign=${campaignId ?? stableId}, swept=${swept}${warmup}`
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
      const scoreLine = `runScore(计分表·平台每题累计分求和)=${runScoreOf(s)}/${score.max}${s.hintLedger.totalHints() > 0 ? `(hint 已扣约 ${s.hintLedger.totalDeducted()} 分, 已含在每题累计分内)` : ''}`
      const hintTxt = s.hintLedger.totalHints() > 0 ? `; hint 已看 ${s.hintLedger.totalHints()} 次、已扣约 ${s.hintLedger.totalDeducted()} 分` : ''
      return `${scoreLine} (${score.completed}/${fresh.length}; 附件题 ${locals} 个全并行, 容器题 ${fresh.length - locals} 个受 ${s.containerSlots} 槽约束${hintTxt})\n\n${rows.join('\n')}`
    },
  }))

  // ── 平台六原语(v8: start_container 已删除——开容器唯一路径 = 题队列授予) ──
  register(defineTool({
    name: 'xiaochang_close',
    description: 'Close a challenge container (release a platform slot; wakes the next challenge in the queue). v8: main agent ONLY — container scheduling decisions belong to the main agent; executors report "needs rotate" in their settle report instead.',
    parameters: { code: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string }, exec) {
      // v8: 容器调度决策权归主 agent; 执行者零容器工具。
      if (parentAgent !== undefined && exec.agent !== parentAgent) {
        return 'xiaochang_close: 拒绝——容器调度是主 agent 专属; 执行者需要换实例请在终态报告里写"需要换实例+理由"'
      }
      const s = requireState()
      await s.adapter.close(args.code)
      s.progress.update(args.code, { containerClosed: true })
      persistProgress(s)
      // v8: 释放队列授权并唤醒队首(释放归机制, 不靠 agent 自觉)。
      await releaseGrant(args.code)
      armQueue()
      return `closed ${args.code}`
    },
  }))

  // ── v8 附件清道(已废弃为 no-op): v8 题队列把全部题武装成 10h 等待位,
  // sweep 的短超时 acquire 会合并进武装等待(长超时) → 低优先级题的容器迟迟不授
  // → 工具永久阻塞 → 整批工具结果不回传 → 主回合冻结(run 20065/20069 实锤)。
  // 附件下载归持槽执行者: 授予即开工, 执行者自行处理附件。 ──────────────────
  register(defineTool({
    name: 'xiaochang_sweep_attachments',
    description:
      'v7.8 attachment sweep (one call): for every challenge whose description suggests an attachment, run the open-container → download → close-container cycle through the resource queue (zero-token slot waiting), saving artifacts to <cwd>/att/<code>/ and returning a per-challenge manifest. Candidate download paths are conventional guesses — misses are left to executors to handle manually. Call this ONCE early in the campaign (the order prescribes it); safe to re-call anytime.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute() {
      const s = requireState()
      audit(s.auditPath, { type: 'v8-sweep-noop' })
      return 'xiaochang_sweep_attachments: v8 已废弃(附件下载并入题队列授予——执行者持槽开工时自行处理附件, 无需手动清道)。直接进入下一步即可。'
      // 以下为 v7.8 旧实现(v8 不再执行; 保留注释防误恢复)。
      /* eslint-disable no-unreachable */
      const targets = [...s.challenges.values()].filter(ch => attachmentLikely(ch.description))
      const manifest: string[] = []
      let downloaded = 0
      for (const ch of targets) {
        const code = ch.unique_code
        try {
          const res = (s.containerQueue !== undefined)
            ? await s.containerQueue.acquire(code, { timeoutMs: 45_000 })
            : { status: 'granted' as const }
          if (res.status !== 'granted') {
            manifest.push(`${code}: 容器排队 ${res.status === 'timeout' ? '超时' : '出队'}——留给执行者处理`)
            continue
          }
          s.grantedCodes.add(code)
          const fresh = await s.adapter.listChallenges()
          for (const x of fresh) s.challenges.set(x.unique_code, x)
          const addr = s.challenges.get(code)?.container_addr?.[0]
          const dir = join(process.cwd(), 'att', code)
          let saved = 0
          if (addr !== undefined) {
            try { mkdirSync(dir, { recursive: true }) } catch { /* 目录失败按无下载 */ }
            for (const p of attachmentFetchCandidates(code)) {
              try {
                const ctrl = new AbortController()
                const to = setTimeout(() => ctrl.abort(), 8000)
                const r = await fetch(`http://${addr}${p}`, { signal: ctrl.signal })
                clearTimeout(to)
                if (!r.ok) continue
                const buf = Buffer.from(await r.arrayBuffer())
                if (buf.length < 16) continue
                const ct = r.headers.get('content-type') ?? ''
                const ext = /zip/.test(ct) ? '.zip' : /tar/.test(ct) ? '.tar' : /json/.test(ct) ? '.json' : /text/.test(ct) ? '.txt' : '.bin'
                writeFileSync(join(dir, `sweep-${saved + 1}${ext}`), buf)
                saved += 1
              } catch { /* 单路径失败继续 */ }
            }
          }
          try { await s.adapter.close(code) } catch { /* 平台侧已关 */ }
          await releaseGrant(code)
          s.progress.update(code, { containerClosed: true })
          downloaded += saved
          manifest.push(`${code}: 下载 ${saved} 件${saved === 0 ? '(候选路径无命中, 留给执行者)' : ''}`)
        } catch (error) {
          manifest.push(`${code}: 处理失败 ${String(error)}`)
        }
      }
      persistProgress(s)
      audit(s.auditPath, { type: 'attachment-sweep', targets: targets.length, downloaded })
      return `附件清道: 疑似附件题 ${targets.length} 道, 共下载 ${downloaded} 件工件到 <cwd>/att/<code>/。\n${manifest.join('\n')}`
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
      // v8: 提交后编排路由——正确: 全旗= solved+关容器+剪枝; 部分旗= 回队续打下一旗。
      // 被拒: 旗值不对 → 回队重打(拿到候选值本身就是进展, 梯清零)。
      const v8AfterSubmit = async (correct: boolean): Promise<void> => {
        const o = s.orch.get(args.code)
        if (o === undefined) return
        if (correct) {
          removePending(s, args.code, 'flag-candidate')
          const fresh = await s.adapter.listChallenges()
          for (const x of fresh) s.challenges.set(x.unique_code, x)
          const ch = s.challenges.get(args.code)
          const allFlags = ch !== undefined && ch.flag_count > 0 && (ch.correct_flag_count ?? 0) >= ch.flag_count
          if (allFlags) {
            adjudicate(o, 'solved')
            removePending(s, args.code)
            try { await s.adapter.close(args.code) } catch { /* 已关 */ }
            await releaseGrant(args.code)
            try { s.containerQueue?.evict(args.code, 'solved') } catch { /* 不阻断 */ }
            s.armed.delete(args.code)
            s.progress.update(args.code, { state: 'complete', containerClosed: true })
            for (const v of c().ledger.views()) {
              if (codeOf(v.item.id) === args.code && ['queued', 'dispatched', 'help', 'stalled'].includes(v.state)) {
                // v8.3c: 只 cancel 排队项; 在途不 interrupt(abort 传播打崩主 driver——簇干跑实锤; 在途 settle 时题已 solved 被吸收)。
                try { c().cancel(v.item.id, 'challenge solved') } catch { /* 不阻断 */ }
              }
            }
            audit(s.auditPath, { type: 'v8-submit-solved', code: args.code })
          } else {
            // 多旗题: 已吃一旗, 续打下一旗(容器保留, 账本已有旗值)。
            // v8.5.2 同族修复(21013 实锤 b-01/b-03): 提交不撤销授予——pending-adjudication
            // (旗待提交宽限态)回 granted 换新时间盒, granted 原地不动; 不 armQueue(否则
            // granted 题产生重授等待位, 且 dispatchNow 静默失效)。
            keepGrantAfterSubmit(o)
            audit(s.auditPath, { type: 'v8-submit-partial', code: args.code })
          }
          bumpOrch(s)
          persistOrch(s)
          persistProgress(s)
        } else {
          removePending(s, args.code, 'flag-candidate')
          // v8.5.2: 被拒提交同样不撤销授予(候选值本身是进展, 授予是已持有资源);
          // 续打走 dispatchNow 或在途 settle, 回队时机归机制/主 agent。
          keepGrantAfterSubmit(o)
          bumpOrch(s)
          persistOrch(s)
          audit(s.auditPath, { type: 'v8-submit-reject', code: args.code })
        }
      }
      /** v8.5.2: 非裁决事件不撤销授予——pending-adjudication 回 granted 换新时间盒; granted 原地不动。 */
      const keepGrantAfterSubmit = (o: ChallengeOrch): void => {
        if (o.state === 'pending-adjudication') {
          o.state = 'granted'
          o.grantedUntil = Date.now() + s.timeboxMs
        }
        // granted: 不动; queued 等其他状态: 不动(等机制正常授予)。
      }
      try {
        const recordWin = (flag: string): void => {
          const p = s.progress.get(args.code)
          s.progress.update(args.code, { flags: [...new Set([...(p?.flags ?? []), flag])] })
          persistProgress(s)
          const difficulty = s.challenges.get(args.code)?.difficulty ?? 'unknown'
          for (const v of c().ledger.views()) {
            if (v.state !== 'done' || codeOf(v.item.id) !== args.code) continue
            if (v.item.model === undefined) continue
            if ((v.terminalDetail ?? '').includes(flag)) {
              jisi?.ledger.record(v.item.model, 'execution', difficulty, true)
            }
          }
        }
        const res = await s.adapter.submit(args.code, args.flag)
        // v8.3 计分表: 平台 submit 回执 cumulative_score = 该题已得累计分(单题语义, 含 hint 扣减)。
        // 每笔回执都入表(无论对错), 求和即 run 总分——平台自己的账, 不自算。
        if (typeof res.cumulative_score === 'number') recordScore(s, args.code, res.cumulative_score)
        // v8.5.2d: 409 duplicate = 该旗位早已交过(值是换实例后的轮换值)——真话记 accepted+duplicate 备注,
        // 让旗仓条目终结(不再唤醒/不再重交), 不动编排状态(不是败绩, 不触发回队)。
        if (res.duplicate === true) {
          recordFlagVerdict(args.code, args.flag, 'accepted', `duplicate: 该值对应旗位已交(索引${res.matched_flag_index ?? '?'}), 轮换值不计新分`, res.matched_flag_index ?? undefined)
          return `409 duplicate: ${args.flag} 对应旗位已提交过(索引 ${res.matched_flag_index ?? '?'})——旗仓已标记 accepted(duplicate), 不再唤醒; 该轮换值不计新分, 换旗位再打`
        }
        if (res.correct) {
          recordWin(args.flag)
          recordFlagVerdict(args.code, args.flag, 'accepted', undefined, res.matched_flag_index ?? undefined)
          await v8AfterSubmit(true)
          return JSON.stringify(res)
        }
        // v7.8: 提交口径自动回退——裸串被拒且题面口径疑似带壳时, 自动试一次 flag{...} 包装(干跑实锤: 口径歧义)。
        const desc = s.challenges.get(args.code)?.description ?? ''
        if (!args.flag.startsWith('flag{') && !args.flag.startsWith('HTB{') && !args.flag.startsWith('mock{') && /flag\{/.test(desc)) {
          const wrapped = `flag{${args.flag}}`
          const res2 = await s.adapter.submit(args.code, wrapped)
          if (typeof res2.cumulative_score === 'number') recordScore(s, args.code, res2.cumulative_score)
          if (res2.correct) {
            recordWin(wrapped)
            recordFlagVerdict(args.code, wrapped, 'accepted', undefined, res2.matched_flag_index ?? undefined)
            recordFlagVerdict(args.code, args.flag, 'rejected', '裸串口径不对')
            await v8AfterSubmit(true)
            return `裸串被拒, 自动回退包装提交成功: ${JSON.stringify(res2)}`
          }
          recordFlagVerdict(args.code, args.flag, 'rejected', JSON.stringify(res).slice(0, 80))
          recordFlagVerdict(args.code, wrapped, 'rejected', JSON.stringify(res2).slice(0, 80))
          await v8AfterSubmit(false)
          return `裸串被拒(${JSON.stringify(res)}); 包装回退也被拒(${JSON.stringify(res2)})——以平台判定为准, 换值或换题面口径`
        }
        recordFlagVerdict(args.code, args.flag, 'rejected', JSON.stringify(res).slice(0, 80))
        await v8AfterSubmit(false)
        return JSON.stringify(res)
      } catch (error) {
        return `submit error: ${String(error)}`
      }
    },
  }))

  // ── v8.3 旗仓工具 ──────────────────────────────────────────────
  register(defineTool({
    name: 'xiaochang_flag_report',
    description:
      'v8.3 flag depot report (executor): report a captured flag candidate into the per-run flag depot file (single JSONL, tool-only writer, dedup by code+value). A NEW pending value wakes the main agent immediately (its xiaochang_wait polls the depot) — the main agent submits and the verdict (accepted/rejected) is written back by xiaochang_submit automatically. Do NOT put flag values in your settle text; just call this tool.',
    parameters: {
      code: { type: 'string', required: true },
      flag: { type: 'string', required: true, description: 'Flag value verbatim (platform format).' },
      evidence: { type: 'string', description: 'One line: where/how it was captured (for the main agent).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string; flag: string; evidence?: string }) {
      const entries = readFlagEntries()
      const folded = foldFlags(entries).get(args.code)
      const exist = folded?.get(args.flag)
      if (exist !== undefined) {
        return `xiaochang_flag_report: 该值已在旗仓(状态=${exist.status}${exist.verdict !== undefined ? '/' + exist.verdict : ''})——不重复写入, 无需再报`
      }
      appendFlagEntry({ code: args.code, flag: args.flag, by: 'executor', status: 'pending', at: Date.now() })
      if (state !== undefined) { state.orchVersion += 1 }
      audit(state?.auditPath ?? join(process.env.DSH_HOME ?? '.', 'storages', 'xiaochang-run-audit.jsonl'), { type: 'v8-flag-report', code: args.code, evidence: (args.evidence ?? '').slice(0, 120) })
      return `xiaochang_flag_report: 已入旗仓(pending), 主 agent 将被唤醒提交${args.evidence !== undefined ? `; 证据: ${args.evidence.slice(0, 100)}` : ''}`
    },
  }))

  register(defineTool({
    name: 'xiaochang_flag_status',
    description:
      'v8.3 flag depot view: folded per-challenge flag status (pending / accepted / rejected). Main agent reads this before submitting; executors read it to avoid re-reporting/re-submitting known values.',
    parameters: {
      code: { type: 'string', description: 'One challenge code; omit for the full depot summary.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args: { code?: string }) {
      const folded = foldFlags(readFlagEntries())
      const lines: string[] = []
      let pending = 0
      let accepted = 0
      let rejected = 0
      for (const [code, m] of [...folded.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (args.code !== undefined && code !== args.code) continue
        for (const [flag, e] of m) {
          if (e.status === 'pending') pending += 1
          else if (e.status === 'accepted') accepted += 1
          else rejected += 1
          // v8.5.2: flag 值全文显示(20911 实锤: 40 字符截断导致按截断值提交被平台拒,
          // b-03 首旗差点丢); 仅 >200 字符才截断且响亮标注原文出处。
          const flagTxt = flag.length > 200
            ? `${flag.slice(0, 200)}…(共${flag.length}字符, 显示已截断——原文读 storages/xiaochang-flags.jsonl)`
            : flag
          lines.push(`  ${code} [${e.status}${e.flagIndex !== undefined ? `·旗位${e.flagIndex}` : ''}] ${flagTxt}${e.verdict !== undefined ? ' — ' + e.verdict.slice(0, 60) : ''}${e.by !== '' ? ' (by ' + e.by + ')' : ''}`)
        }
      }
      return `旗仓: pending=${pending} accepted=${accepted} rejected=${rejected}\n${lines.join('\n') || '  (空)'}`
    },
  }))

  register(defineTool({
    name: 'xiaochang_hint',
    description:
      'Fetch the official hint (main agent ONLY; costs part of the challenge score, capped per challenge). v8.4 gate: objective signals only — settleNoFlag ≥2 (两轮真实败绩, 无旗 settle 自动计) 或 (ideaRound≥2 且 settleNoFlag≥1)。闸开时 xiaochang_wait 会主动推送 hint-gate-open 事件(不必反复试). The deduction is reported loudly.',
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
      // v8.4 客观闸: 无旗 settle 一律计真实败绩(blocker 措辞不豁免), 不读执行者自述。
      const vq = s.v2[args.code]
      const o = s.orch.get(args.code)
      const gate = hintGateV2({
        ideaRound: vq?.ideaRound ?? 1,
        settleNoFlag: o?.settleNoFlag ?? 0,
      })
      if (!gate.allowed) {
        s.hintGateOpen.delete(args.code)
        return `xiaochang_hint: 拒绝: ${gate.missing.join('; ')}。当前该题 hint 已用 ${used}/${s.maxHints}、已扣 ${s.hintLedger.get(args.code)?.deducted ?? 0} 分。闸开后 xiaochang_wait 会主动推送, 不必反复试。`
      }
      s.hintGateOpen.delete(args.code)
      const ch = s.challenges.get(args.code)
      const raw = await s.adapter.hint(args.code) as { hint?: string | null }
      const hint = raw.hint
      if (hint === null || hint === undefined || hint === '') return 'xiaochang_hint: no hint available'
      // v8.5.3(cybench 实测): 平台明示"无hint信息(也没有hint惩罚)"——不记扣分账, 如实返回。
      if (/无hint|没有hint|无惩罚/i.test(hint)) {
        return `hint (${used + 1}/${s.maxHints} used): ${hint}\nℹ️ 该题平台已确认无 hint 且无惩罚——不计扣分账; 卡题转集思/加兵/rotate。`
      }
      const cost = s.hintLedger.record(args.code, ch?.total_score ?? 100, 'main-agent requested')
      return `hint (${used + 1}/${s.maxHints} used): ${hint}\n⚠️ 本次看提示估算扣该题 ${cost} 分(题面 10%; 平台不公布真实单价——hint_cost 字段不存在于题表/hint 响应, 实测本集 10%/次)——该题累计估算已扣 ${s.hintLedger.get(args.code)?.deducted ?? cost}, 全局累计 ${s.hintLedger.totalDeducted()}。**实际扣分以后续 submit 回执 cumulative_score 为准**(满分账=计分表, run 总分以 xiaochang_status 的 runScore 为准)。`
    },
  }))

  // ── 虎符执行 ──────────────────────────────────────────────────────
  register(defineTool({
    name: 'xiaochang_enqueue',
    description:
      'v8: put a CHALLENGE into the challenge queue with a directive package (思路包). The queue is the single scheduler: when a slot is granted, the mechanism starts the container (if needed) and spawns the executor bound to it — no manual start/dispatch. Re-call to add more directives (untried ones are consumed at each grant) or to raise priority. Executors never wait for containers; challenges wait, zero tokens.',
    parameters: {
      code: { type: 'string', required: true },
      prompt: { type: 'string', required: true, description: 'The directive: the assigned approach/idea for this challenge. v8.4: 优先写个性化判断(方向/优先级/验证点); 公共知识可不贴——家族模板帧已由机制注入. 上限 4000 字符(超限全文落盘, 执行者可读全文, 不丢信息).' },
      priority: { type: 'number', description: 'v8: explicit queue priority override (default = score density + never-dispatched boost).' },
      model: { type: 'string', description: 'Preferred executor model for this directive (falls back to default if invalid/unlisted).' },
      effort: { type: 'string', description: 'Reasoning effort for this directive.' },
      family: { type: 'string', description: 'v8.4: 战术家族覆盖(rev-vm|rev-serial|rev-license|web-chain|web-console|ai-service|easy-harvest), 缺省按题面自动判定; 决定注入执行者帧的家族模板。' },
      pacing: { type: 'array', description: 'v8.4: 目标侧节奏约束(限速/封禁类, 注入令文硬约束), 如 ["ssh ≤2 次/10min(失败即封禁)"]。' },
      ideaIds: { type: 'array', description: 'v8.4: 本 directive 引用的采纳思路 id 列表(从 enqueue 回显/status 的未消费思路清单取); 派兵即标记该思路已消费。' },
      persona: { type: 'string', description: 'v8.4: 执行者 persona 内联覆盖(缺省继承部署级; 可给渗透/逆向专家类 persona)。' },
      dispatchNow: { type: 'boolean', description: 'v8.5: 该题已持槽(granted)时, 立即用本条 directive 派一个新执行者挂到当前容器(与在途执行者并行; 共享容器剩余时间盒)。加兵无上限: 多次调用即多路并行, 兵数不设开题上限, 按 status 在途清单与资源读数动态加。' },
      round: { type: 'number', description: 'v8: ignored (kept for compatibility) — rounds are managed by the mechanism.' },
      dependsOn: { type: 'array', description: 'v8: ignored (kept for compatibility).' },
      resourceClass: { type: 'string', description: 'v8: ignored (kept for compatibility) — class is auto by challenge type.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string; prompt: string; priority?: number; model?: string; effort?: string; family?: string; pacing?: string[]; ideaIds?: string[]; persona?: string; dispatchNow?: boolean; round?: number; dependsOn?: string[]; resourceClass?: string }, exec) {
      // v7.6: 调度权单点——只有主 agent 可入题队列(单调度器架构; 执行者无权改写战役)。
      if (parentAgent !== undefined && exec.agent !== parentAgent) {
        return 'xiaochang_enqueue: 拒绝——入题队列是主 agent 专属(单调度器); 执行者只解自己的题, 有发现用 xiaochang_fork 上报'
      }
      const s = requireState()
      const ch = s.challenges.get(args.code)
      if (ch === undefined) return `xiaochang_enqueue: unknown challenge ${args.code}`
      // v7: 账本文件就绪 + restore/迁移兜底镜像(账本知识全量进文件, 行去重幂等)。
      try { ensureKnowledgeFile(args.code); syncKnowledgeFileFromLedger(args.code) } catch { /* 账本失败不阻断 */ }
      // v8.4: 方向段 4000 字符(防呆上限; 超限全文落盘, 执行者 frame 带路径读全文)。
      const DIRECTIVE_MAX = 4000
      const trunc = truncateDirective(args.prompt, DIRECTIVE_MAX)
      let truncNotice = ''
      if (trunc.truncated) {
        const fullPath = persistFullDirective(args.code, args.prompt)
        truncNotice = `\n⚠️ 方向段已截断: ${args.prompt.length}→${DIRECTIVE_MAX} 字符。全文已落盘 ${fullPath}(执行者 frame 自动附路径, 开工可读; 无需手动搬运)。`
      }
      const o = s.orch.get(args.code) ?? ((): ChallengeOrch => { const n = newOrch(args.code, s.startedAt); s.orch.set(args.code, n); return n })()
      // v8: 终态题拒绝入队(出队仅 solved/dead 两条路)。
      if (o.state === 'solved' || o.state === 'dead') {
        return `xiaochang_enqueue: 拒绝——${args.code} 已${o.state === 'solved' ? '解出' : '判死'}, 不再入队`
      }
      o.directives.push({ text: trunc.text, model: args.model, effort: args.effort, persona: args.persona, tried: false })
      const priorityChanged = args.priority !== undefined && o.priorityOverride !== args.priority
      if (args.priority !== undefined) o.priorityOverride = args.priority
      // v8.4: 家族/pacing 元数据(可覆盖, 可累积)。
      if (args.family !== undefined && args.family !== '') o.family = args.family
      if ((args.pacing?.length ?? 0) > 0) o.pacing = [...(o.pacing ?? []), ...args.pacing!]
      // v8.4: 派兵即消费——本 directive 引用的采纳思路标记 consumed。
      let consumedNote = ''
      if ((args.ideaIds?.length ?? 0) > 0) {
        const n = markIdeasConsumed(args.code, args.ideaIds!, trunc.text.slice(0, 60))
        const open = unconsumedIdeas(args.code).map(e => '#' + e.id).join(' ')
        consumedNote = n > 0
          ? `\n已标记 ${n} 条采纳思路为已消费(本 directive 引用)。当前未消费: ${open || '无'}`
          : `\n⚠️ ideaIds 未命中任何未消费思路(传了 ${args.ideaIds!.join(',')}): 已消费/不存在/拼写? 当前未消费: ${open || '无'}`
      }
      // v8.5.2 状态门修复(20911 实锤): enqueue 永不把 granted 打回 queued——
      // 授予是已持有的资源, 投思路不能撤销它; 否则首轮授予的题 dispatchNow 静默失效
      // (b-02/b-01/b-03 全程只有 1 路兵)。granted 保持不动: 没派完的思路要么
      // dispatchNow 当场派, 要么等 settle 回队后的下一轮授予。
      const wasGranted = o.state === 'granted'
      // v8.3c 簇调度: 入队/续打对簇内全体成员生效(簇=单调度单元)。
      const memberCodes = [args.code, ...o.cluster]
      for (const c2 of memberCodes) {
        const mo = s.orch.get(c2)
        if (mo === undefined) continue
        if (mo.state === 'pending-adjudication') {
          adjudicate(mo, 'continue')
          removePending(s, c2)
        }
        if (mo.state === 'granted') continue
        if (mo.state !== 'solved' && mo.state !== 'dead') mo.state = 'queued'
      }
      let dispatchNowNote = ''
      if (wasGranted && args.dispatchNow === true) {
        // v8.5: 题已持槽(容器在线) → 立即用本条 directive 派新执行者(与在途并行)。
        const d0 = { text: trunc.text, model: args.model, effort: args.effort, persona: args.persona, tried: true }
        const chNow = s.challenges.get(args.code)
        const clsNow = chNow !== undefined ? resourceClassOf(chNow) : 'container'
        const vqNow = ensureVq(args.code)
        try {
          await spawnExecutor(args.code, o, d0, 0, priorityOf(o, chNow?.total_score ?? 300, Date.now()), clsNow, vqNow)
          // 成功才标记 tried(失败保留, 下次授予可重试该方向)。
          for (const d of o.directives) { if (!d.tried && d.text === trunc.text) d.tried = true }
          dispatchNowNote = `\n已 dispatchNow 立即派发 1 个执行者挂当前容器(与在途并行, 共享剩余时间盒 ${Math.round(((o.grantedUntil ?? Date.now()) - Date.now()) / 60000)}min)。`
        } catch (error) {
          dispatchNowNote = `\ndispatchNow 派发失败: ${String(error)}`
        }
      }
      // v8.4.1: 显式 priority 变更 → 已武装容器题全量重排(20633 实锤: 武装时 FIFO 固化,
      // enqueue 的 priority 只写账本不重排——b-02 高优排到末位)。
      if (priorityChanged && s.containerQueue !== undefined) {
        for (const c2 of s.armed) {
          try { s.containerQueue.evict(c2, 're-prioritize') } catch { /* 未在队(已授予)则跳过 */ }
        }
        s.armed.clear()
        armQueue()
      }
      bumpOrch(s)
      persistOrch(s)
      persistProgress(s)
      audit(s.auditPath, { type: 'v8-enqueue', code: args.code, directive: trunc.text.slice(0, 80), priority: args.priority, family: o.family, pacing: o.pacing })
      // v8.4 回显: 已挂模板 / 账本摘要 / 未消费思路菜单 / 封印簇。
      const familyNow = o.family ?? familyOf(ch.description ?? '', ch.difficulty)
      const tplName = templateSections().has(familyNow) ? familyNow : '(无模板)'
      const ideas = unconsumedIdeas(args.code)
      const ideaMenu = ideas.length > 0
        ? `\n未消费思路 ${ideas.length} 条(enqueue 时传 ideaIds 引用即消费):\n${ideas.map(i => `  #${i.id} ${i.text.slice(0, 90)}`).join('\n')}`
        : '\n未消费思路: 无'
      const deads = knowledgeOfCode(args.code).filter(k => k.kind === 'dead-end')
      const sealed = sealedClustersOf(deads)
      const sealedTxt = sealed.length > 0
        ? `\n⚠️ 死路封印簇 ${sealed.length} 个(≥3 条同向, 已进待裁决建议派验证兵翻案): ${sealed.map(x => `${x.direction}×${x.count}`).join(' | ')}`
        : ''
      return `enqueued ${args.code} (directives=${o.directives.length}, 队列优先级=${priorityOf(o, ch.total_score, Date.now())}, 状态=${o.state}; 授予由机制 tick 武装, 无需手动 dispatch)${dispatchNowNote}\n家族模板已挂: ${tplName}${ideaMenu}${sealedTxt}${consumedNote}${truncNotice}`
    },
  }))

  // v8.4 采纳工具: fanout 思路裁决采纳 → 落盘账本① + 记未消费(派兵才消费)。
  register(defineTool({
    name: 'xiaochang_idea_adopt',
    description:
      'v8.4 (main agent): adopt fanout/collect ideas for a challenge. Each adopted idea is written into the challenge ledger ① (executors read it at start) AND tracked in the idea inbox as unconsumed — it becomes consumed only when a later xiaochang_enqueue references its id via ideaIds (派兵即消费). The enqueue return value lists unconsumed ideas for point-and-dispatch.',
    parameters: {
      code: { type: 'string', required: true },
      ideas: { type: 'array', required: true, description: '[{id, text}] — id 可用任意短标签(如 r2-1); 重复 id 幂等覆盖。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string; ideas: Array<{ id: string; text: string }> }, exec) {
      if (parentAgent !== undefined && exec.agent !== parentAgent) {
        return 'xiaochang_idea_adopt: 拒绝——采纳是主 agent 专属(单调度器)'
      }
      const s = requireState()
      if (s.challenges.get(args.code) === undefined) return `xiaochang_idea_adopt: unknown challenge ${args.code}`
      const now = Date.now()
      const existing = new Map(readIdeas(args.code).map(e => [e.id, e]))
      const fresh: IdeaEntry[] = []
      for (const idea of args.ideas) {
        const id = `${args.code}-${idea.id}`.slice(0, 64)
        const prev = existing.get(id)
        if (prev !== undefined) continue // 幂等: 已采纳不重复
        fresh.push({ id, text: idea.text, status: 'unconsumed', adoptedAt: now })
        existing.set(id, fresh[fresh.length - 1]!)
      }
      if (fresh.length > 0) {
        writeIdeas(args.code, fresh)
        try {
          appendKnowledgeFile(args.code, 'skeleton', fresh.map(e => `思路#${e.id.split('-').pop()}: ${e.text.slice(0, 200)} (未消费)`))
        } catch { /* 账本文件失败不阻断 */ }
      }
      const unconsumed = unconsumedIdeas(args.code)
      const menu = unconsumed.map(e => '  #' + e.id + ' ' + e.text.slice(0, 90)).join(' / ')
      return args.code + ' 采纳 ' + fresh.length + ' 条(共 ' + unconsumed.length + ' 条未消费)。派兵时 enqueue 传 ideaIds=[...] 即标记消费: ' + menu
    },
  }))

  register(defineTool({
    name: 'xiaochang_dispatch',
    description:
      'v8: REMOVED — dispatch is automatic. The challenge queue grants a container and spawns the executor in one atomic action; the main agent no longer dispatches manually. Call xiaochang_enqueue to put a challenge (with its directive package) into the queue.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute() {
      armQueue()
      return 'xiaochang_dispatch: v8 已废除手动派单——授予即派兵, 由题队列机制自动执行。给题投思路包用 xiaochang_enqueue, 看队列/待决用 xiaochang_status。'
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
        // v8: 超时也走 settle 结算(零进展/有进展分类 → 回队/升级梯); 队列位置归题, 不摘除。
        void settleClassify(v.item.id, 'round timeout')
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
        // v8: settle 结算兜底扫描(事件通道之外的恢复面, settleProcessed 去重)。
        void settleClassify(v.item.id, detail).catch(err => audit(s.auditPath, { type: 'v8-settle-sweep-error', itemId: v.item.id, error: String(err) }))
      }
      persistProgress(s)
      persistProfile(s)
      void tickOrch()
      return rows.length === 0 ? 'xiaochang_collect: nothing settled yet' : rows.join('\n\n')
    },
  }))

  register(defineTool({
    name: 'xiaochang_report',
    description:
      'Adjudication (main agent ONLY). v8 verdicts: complete (flags captured, terminal) / failed (判死, terminal) / skipped (terminal) / continue (回队续打: re-queues the challenge, ladder reset) / rotate (换实例: close + re-queue for a fresh container). Terminal verdicts close the container and prune the challenge\'s queued/in-flight sibling items; continue/rotate re-arm the challenge queue. Adjudicating removes the pending item from the dashboard.',
    parameters: {
      code: { type: 'string', required: true },
      verdict: { type: 'string', required: true, description: 'complete | failed | skipped | continue | rotate' },
      reason: { type: 'string', description: 'Short reason (logged).' },
      deadEnds: { type: 'array', description: '[{path, conclusion, evidence, testedVariants}] proven-infeasible paths. v8.4: 附实测变体清单(结论带过程, 翻案兵按清单外变体复核).' },
      forks: { type: 'array', description: '[{path, conclusion, evidence}] untaken branches worth dispatching.' },
      observations: { type: 'array', description: '[{path, conclusion}] facts learned.' },
      why: { type: 'string', description: 'v2 归因(failed 时必填): model-weak | approach-dead-end | context-insufficient | platform-issue. 两级判定: 执行者报告提议, 你终裁.' },
      gaps: { type: 'array', description: 'v2 上下文缺口(context-insufficient 时): [缺什么信息]. 进画像 contextGaps, 下次派单/二次征集自动附带.' },
      interruptItemIds: { type: 'array', description: 'v8.5: 人工收兵——点名收回在途执行者(itemId 精确或该题前缀, status 在途清单可见)。中断+取消+审计人工收兵; 该 settle 不计无旗败绩、不触发升级梯。可配 verdict continue/rotate 只收兵不判死。' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string; verdict: string; reason?: string; deadEnds?: Array<{ path: string; conclusion?: string; evidence?: string; testedVariants?: string[] }>; forks?: Array<{ path: string; conclusion?: string; evidence?: string }>; observations?: Array<{ path: string; conclusion?: string }>; interruptItemIds?: string[]; why?: string; gaps?: string[] }, exec) {
      // v7.6: 调度权单点——裁决/剪枝只有主 agent 可做。
      if (parentAgent !== undefined && exec.agent !== parentAgent) {
        return 'xiaochang_report: 拒绝——裁决是主 agent 专属(单调度器); 执行者只报告结果, 交主 agent 判断'
      }
      const s = requireState()
      const v8Verdicts = new Set(['complete', 'failed', 'skipped', 'continue', 'rotate'])
      if (!v8Verdicts.has(args.verdict)) return `xiaochang_report: unknown verdict ${args.verdict} (complete|failed|skipped|continue|rotate)`
      const verdict = args.verdict as 'complete' | 'failed' | 'skipped' | 'continue' | 'rotate'
      const terminal = verdict === 'complete' || verdict === 'failed' || verdict === 'skipped'
      // v2: 归因门控的难度校准 + 终局对账 + 加权入账。
      const vq = s.v2[args.code] ?? { qtype: classifyQtype(s.challenges.get(args.code)?.description ?? ''), difficulty: difficultyPrior(s.challenges.get(args.code)?.total_score ?? 300), wins: 0, fails: 0, gaps: [], triedModels: [], ideaRound: 1, deadIdeas: 0, adopted: 0 }
      const why = args.why
      const win = verdict === 'complete'
      if (terminal && why !== 'context-insufficient' && why !== 'platform-issue') {
        vq.wins += win ? 1 : 0
        vq.fails += win ? 0 : 1
        vq.difficulty = calibrateDifficulty(vq)
        vq.lastVerdict = verdict
      }
      if (args.gaps !== undefined && args.gaps.length > 0) vq.gaps.push(...args.gaps)
      s.v2[args.code] = vq
      persistV2(s)
      if (jisi !== undefined && terminal) {
        // 终局对账: 采纳的思路, 题胜不加; 题败且归因 approach-dead-end → 罚思路模型(第 0 层)。
        jisi.settleAdoptions?.(args.code, win, why)
      }
      // v8.5: 人工收兵——点名收回在途执行者(中断+取消+审计; settle 被 manualInterrupted 吸收, 不计败绩)。
      if (args.interruptItemIds !== undefined) {
        for (const id of args.interruptItemIds) {
          s.manualInterrupted.add(id)
          try { await c().interruptItem?.(id) } catch { /* 中断失败不阻断 */ }
          try { c().cancel(id, `人工收兵: ${args.reason ?? '主 agent 主动收回'}`) } catch { /* 取消失败不阻断 */ }
          audit(s.auditPath, { type: 'v8-interrupt-manual', id, code: codeOf(id), reason: args.reason })
        }
      }
      // F33: 结构化经验落账(全局解题图)——记账失败绝不阻断 verdict 主线(关容器/剪枝/落盘)。
      const entries: KnowledgeIn[] = [
        ...(args.deadEnds ?? []).map(e => ({ kind: 'dead-end', path: e.path, conclusion: e.conclusion, evidence: e.evidence, testedVariants: e.testedVariants, by: 'main-agent', at: Date.now() })),
        ...(args.forks ?? []).map(e => ({ kind: 'fork', path: e.path, conclusion: e.conclusion, evidence: e.evidence, by: 'main-agent', at: Date.now() })),
        ...(args.observations ?? []).map(e => ({ kind: 'observation', path: e.path, conclusion: e.conclusion, by: 'main-agent', at: Date.now() })),
      ]
      try { if (entries.length > 0) recordKnowledgeOnCode(args.code, entries) } catch { /* 落账失败不阻断 */ }
      // v7: 知识账本文件自动累积——②死路/缺口, ③工件(observations), ④分叉; 失败不阻断。
      const line = (e: { path: string; conclusion?: string; evidence?: string; testedVariants?: string[] }): string => `${e.path}${e.conclusion !== undefined ? ' → ' + e.conclusion : ''}${e.evidence !== undefined ? ' (证据: ' + e.evidence + ')' : ''}${(e.testedVariants?.length ?? 0) > 0 ? ` [已试: ${e.testedVariants!.join('; ').slice(0, 300)}]` : ''} [by main-agent]`
      try {
        if ((args.deadEnds?.length ?? 0) > 0) appendKnowledgeFile(args.code, 'dead', args.deadEnds!.map(line))
        if ((args.gaps?.length ?? 0) > 0) appendKnowledgeFile(args.code, 'dead', args.gaps!.map(g => `缺口: ${g}`))
        if ((args.observations?.length ?? 0) > 0) appendKnowledgeFile(args.code, 'artifacts', args.observations!.map(line))
        if ((args.forks?.length ?? 0) > 0) appendKnowledgeFile(args.code, 'forks', args.forks!.map(line))
      } catch { /* 账本文件失败不阻断 */ }
      // v8: 编排态路由——终态=solved/dead; continue/rotate=重新入队(梯清零)。
      // v8.3c 簇调度: 裁决对簇内全体成员执行。
      const o = s.orch.get(args.code)
      const memberCodes = [args.code, ...(o?.cluster ?? [])]
      for (const c2 of memberCodes) {
        const mo = s.orch.get(c2)
        if (mo === undefined) continue
        if (verdict === 'complete') adjudicate(mo, 'solved')
        else if (verdict === 'failed' || verdict === 'skipped') adjudicate(mo, 'dead')
        else adjudicate(mo, verdict === 'rotate' ? 'rotate' : 'continue')
      }
      for (const c2 of memberCodes) removePending(s, c2)
      // v8.3c 簇调度: 关容器/摘队/剪枝覆盖簇内全体成员。
      for (const c2 of memberCodes) {
        try { await s.adapter.close(c2) } catch { /* 平台侧已关 */ }
        await releaseGrant(c2)
        try { s.containerQueue?.evict(c2, `challenge ${verdict}`) } catch { /* 出队失败不阻断 */ }
        s.armed.delete(c2)
      }
      if (terminal) {
        for (const c2 of memberCodes) {
          s.progress.update(c2, { state: verdict === 'complete' ? 'complete' : verdict, reason: args.reason, containerClosed: true })
        }
        for (const v of c().ledger.views()) {
          if (memberCodes.includes(codeOf(v.item.id))
            && (v.state === 'queued' || v.state === 'dispatched' || v.state === 'help' || v.state === 'stalled')) {
            // v7.5: 剪枝前真杀在途执行者(report 是主 agent 显式裁决, abort 风险已由 A 修复避开 submit 路径)。
            if (v.state !== 'queued') {
              try { await c().interruptItem?.(v.item.id) } catch { /* 中断失败不阻断剪枝 */ }
              audit(s.auditPath, { type: 'interrupt', id: v.item.id, code: args.code, reason: `challenge ${verdict}` })
            }
            try { c().cancel(v.item.id, `challenge ${verdict}: ${args.reason ?? ''}`) } catch { /* 终态竞争 */ }
          }
        }
      } else {
        for (const c2 of memberCodes) s.progress.update(c2, { containerClosed: true })
        armQueue()
      }
      bumpOrch(s)
      persistOrch(s)
      persistProgress(s)
      audit(s.auditPath, { type: 'verdict', code: args.code, state: verdict, reason: args.reason })
      return `${args.code} → ${verdict}${args.reason !== undefined ? ` (${args.reason})` : ''}${terminal ? '' : ' (已回队)'}`
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

要求: 先或并行用 web_search 查公开资料(writeup/题源/CVE 库), 有出处的线索写进思路并附 URL; 不要只凭记忆猜。

上下文缺口(前序执行者反馈缺的信息):
${gaps}

已试模型: ${tried}
已采用思路 ${vq.adopted} 条, 已死 ${vq.deadIdeas} 条。

提问: 已知以上死路与缺口之后, 还有哪些**没试过**的方向? 不要重复死路; 每条给: 为什么可行 + 验证点 + 需要补的上下文。`
  }
  /** v6: R2 选模(直接加模型, 未试过的优先)。 */
  const pickRefanoutModels = async (vq: { qtype: string; difficulty: number; triedModels: string[] }): Promise<string[]> => {
    // v7.8: 白名单过滤——本地不可达模型不进自动 R2(干跑实锤: kimi/glm 子代理 failed 烧槽)。
    const s = requireState()
    const allow = (m: string): boolean => s.modelWhitelist.length === 0 || s.modelWhitelist.includes(m)
    if (jisi?.pickRank !== undefined) {
      const ranked = (await jisi.pickRank(vq.qtype, vq.difficulty, 'idea')).filter(r => allow(r.model))
      const fresh = ranked.filter(r => !vq.triedModels.includes(r.model)).map(r => r.model)
      if (fresh.length > 0) return fresh.slice(0, 3)
      if (ranked.length > 0) return ranked.slice(0, 3).map(r => r.model)
    }
    const listed = await jisi?.listModels()
    return (listed ?? []).map(m => m.id).filter(allow).slice(0, 3)
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
      forks: { type: 'array', required: true, description: '[{path, conclusion, evidence, status, testedVariants}] — status: "untaken" (default, 未走分叉→④+信箱, 主 agent 经 xiaochang_wait 唤醒) | "dead-end" (已证死路→只进②, 不唤醒不派兵). v8.4: dead-end 必须附 testedVariants(实测变体清单)——结论带过程, 供翻案兵按清单外变体复核.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args: { code: string; forks: Array<{ path: string; conclusion?: string; evidence?: string; status?: 'untaken' | 'dead-end'; testedVariants?: string[] }> }) {
      if (args.forks.length === 0) return 'xiaochang_fork: no forks given'
      const fmt = (f: { path: string; conclusion?: string; evidence?: string; testedVariants?: string[] }): string => gradedLine({ kind: 'dead-end', path: f.path, conclusion: f.conclusion, evidence: f.evidence, testedVariants: f.testedVariants, by: 'fork', at: Date.now() })
      const deadEnds = args.forks.filter(f => f.status === 'dead-end')
      const untaken = args.forks.filter(f => f.status !== 'dead-end')
      const deadLines = deadEnds.map(f => `${f.path}${f.conclusion !== undefined ? ' → ' + f.conclusion : ''}${f.evidence !== undefined ? ' (证据: ' + f.evidence + ')' : ''}${(f.testedVariants?.length ?? 0) > 0 ? ` [已试: ${f.testedVariants!.join('; ').slice(0, 300)}]` : ''}`)
      // v7.2 dead-end 语义位: 死路只进②不可行教训(静默)——不信箱/不唤醒/不进④, 账本不再双写。
      if (deadEnds.length > 0) {
        const de: KnowledgeIn[] = deadEnds.map(f => ({ kind: 'dead-end', path: f.path, conclusion: f.conclusion, evidence: f.evidence, testedVariants: f.testedVariants, by: 'fork', at: Date.now() }))
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
        // v7.10: 升级链前置搜索钩子——卡题第一动作 = 搜公开资料, 不是硬磨(run19097 实锤: 全局只用 3 次搜索, 全在最后一小时)。
        const descQ = (ch?.description ?? '').replace(/"/g, "'").slice(0, 80)
        const searchHint = `
   🔍 先搜公开资料再升级: web_search("${code} ${descQ}") → 结果写进账本③(xiaochang_knowledge_put artifacts); 若搜索报错(托管沙箱无外网)则跳过, 直接 xiaochang_refanout, 不要重试搜索`
        if (ruling.action === 'escalate') escLines.push(`⚠️ ${code}: ${ruling.reasons[0] ?? ''}${exclTxt}${searchHint}`)
        if (ruling.action === 'judge-dead') escLines.push(`⛔ ${code}: ${ruling.reasons[0] ?? ''}${exclTxt}${searchHint}`)
      }
      // v8.5.2: 末段自动 R2 已删(v8.5.1 只删了授予时 issueR2, 此块漏删——20911 实锤 fanout-73/74/75
      // 机制自动发起, 与"机制不代劳调度"冲突)。改为纯提示行: 末段赶工由主 agent 按开战令纪律执行。
      if (remaining <= 60 * 60_000) {
        const hardOpen: string[] = []
        for (const [code, q] of Object.entries(s.v2)) {
          const p = s.progress.get(code)
          if (p !== undefined && (p.state === 'complete' || p.state === 'failed' || p.state === 'skipped')) continue
          if (q.difficulty >= 55 && q.lastVerdict !== 'complete') hardOpen.push(code)
        }
        if (hardOpen.length > 0) {
          escLines.push(`⏰ 末段赶工提示(机制不代劳): 未破 hard ${hardOpen.slice(0, 3).join(' ')}——按开战令纪律显式 fanout 加模型并派最清晰一路`)
        }
      }
      const escTxt = escLines.length > 0 ? `\n升级建议:\n${escLines.join('\n')}` : ''
      // v7 类闸可见性: 主 agent 一眼看清哪条资源线饱和。
      const usage = c().classUsage?.() ?? {}
      const usageTxt = Object.entries(usage).map(([cls, u]) => `${cls} ${u.open}/${u.limit}`).join(', ') || 'n/a'
      // v8 题队列仪表: 待决事项置顶(未裁决持续重渲染) + 题队列(题是队列单元) + 未破题全量风险排序。
      const q = s.containerQueue
      const qLine = q !== undefined
        ? `containerQueue: granted=${q.grantedCount?.() ?? '?'}/${s.containerSlots} waiters=[${q.waiters().map(w => w.holderId).join(',') || '无'}]`
        : 'containerQueue: 未初始化'
      // 待决事项(未裁决持续置顶; >30min 加 ⚠️)
      const now = Date.now()
      const pendingTxt = s.pendingAdj.length === 0
        ? '无'
        : s.pendingAdj.map(pa => `  ${pa.code} [${pa.kind}] ${pa.summary}${now - pa.createdAt > 30 * 60_000 ? ' ⚠️未裁决>30min' : ''}`).join('\n')
      // 编排态计数
      const orchCount = (st: string): number => [...s.orch.values()].filter(o => o.state === st).length
      const openByCode = new Map<string, number>()
      for (const v of c().ledger.views()) {
        if (v.state !== 'dispatched' && v.state !== 'help' && v.state !== 'stalled') continue
        const code = codeOf(v.item.id)
        openByCode.set(code, (openByCode.get(code) ?? 0) + 1)
      }
      const unsolved = [...s.challenges.keys()].filter(code => {
        const p = s.progress.get(code)
        return p === undefined || (p.state !== 'complete' && p.state !== 'failed' && p.state !== 'skipped')
      })
      unsolved.sort((a, b) => {
        const oa = s.orch.get(a)
        const ob = s.orch.get(b)
        return compareRisk(
          oa ?? newOrch(a, s.startedAt), ob ?? newOrch(b, s.startedAt),
          s.challenges.get(a)?.total_score ?? 300, s.challenges.get(b)?.total_score ?? 300,
        )
      })
      const unsolvedTxt = unsolved.length === 0
        ? '无'
        : unsolved.map(code => {
          const o = s.orch.get(code)
          if (o === undefined) return `${code}(无编排态)`
          const inF = openByCode.get(code) ?? 0
          const box = o.grantedUntil !== undefined ? `/盒剩${Math.max(0, Math.round((o.grantedUntil - now) / 60000))}m` : ''
          const ladder = o.zeroProgressStreak > 0 ? `/梯${o.zeroProgressStreak}` : ''
          const never = o.neverDispatched ? '/从未开工' : ''
          return `${code}[${o.state}·在途${inF}·试${o.attempts}${ladder}${box}${never}]`
        }).join(' ')
      return [
        `campaign: open=${count(v => v.state === 'dispatched' || v.state === 'help')} queued=${count(v => v.state === 'queued')} done=${count(v => v.state === 'done')} failed=${count(v => v.state === 'failed')} blocked=${count(v => v.state === 'blocked')}`,
        `resourceClasses: ${usageTxt}`,
        `orch: queued=${orchCount('queued')} granted=${orchCount('granted')} pending-adjudication=${orchCount('pending-adjudication')} solved=${orchCount('solved')} dead=${orchCount('dead')}`,
        `v8心跳: tick=${s.tickCount} armed=${s.armed.size} grantedCodes=${s.grantedCodes.size} spawnQueue=${spawnQueue.length} spawning=${spawning}`,
        qLine,
        `在途执行者:\n${inflightSummary()}`,
        `容器资源(全容器, cgroup 优先): ${containerResources()}`,
        `budgetRemainingMin=${Math.round(remaining / 60000)}`,
        `runScore(计分表)=${runScoreOf(s)}${s.hintLedger.totalHints() > 0 ? `(hint 已扣约 ${s.hintLedger.totalDeducted()} 分, 已含)` : ''}`,
        `${(() => {
          const folded = foldFlags(readFlagEntries())
          let pend = 0; let acc = 0; let rej = 0
          for (const m of folded.values()) for (const e of m.values()) {
            if (e.status === 'pending') pend += 1
            else if (e.status === 'accepted') acc += 1
            else rej += 1
          }
          return '旗仓: pending=' + pend + ' accepted=' + acc + ' rejected=' + rej
        })()}`,
        `${(() => {
          const clusters = new Map<string, string[]>()
          for (const ch of s.challenges.values()) {
            const key = [...ch.container_addr].sort().join('|')
            if (key === '') continue
            const list = clusters.get(key) ?? []
            list.push(ch.unique_code)
            clusters.set(key, list)
          }
          const multi = [...clusters.values()].filter(l => l.length > 1)
          return multi.length > 0 ? '同靶场簇: ' + multi.map(l => l.sort().join('↔')).join(' | ') : '同靶场簇: 无'
        })()}`,
        `openContainers(平台视角, 异步更新会滞后; 槽真相以 containerQueue 行为准)=${[...openContainers(s)].join(',') || 'none'}`,
        `hints=${s.hintLedger.totalHints()} (deducted ${s.hintLedger.totalDeducted()})`,
        `hint闸已开(可取): ${[...s.hintGateOpen].sort().join(',') || '无'}`,
        `未消费思路: ${(() => {
          const rows: string[] = []
          for (const code of s.orch.keys()) {
            const ideas = unconsumedIdeas(code)
            if (ideas.length > 0) rows.push(`${code}×${ideas.length}`)
          }
          return rows.length > 0 ? rows.join(' ') : '无'
        })()}`,
        `死路封印簇(≥3 同向, 待裁决建议验证): ${(() => {
          const rows: string[] = []
          for (const code of s.orch.keys()) {
            const sealed = sealedClustersOf(knowledgeOfCode(code).filter(k => k.kind === 'dead-end'))
            if (sealed.length > 0) rows.push(`${code}:${sealed.map(x => `${x.direction}×${x.count}`).join('|')}`)
          }
          return rows.length > 0 ? rows.join(' ') : '无'
        })()}`,
        `待裁决(${s.pendingAdj.length}):\n${pendingTxt}`,
        `未破题(全量·风险排序): ${unsolvedTxt}`,
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
        // ⑥ v8: 编排态变化(settle 结算/回队/裁决/时间盒到期) → 唤醒
        const orchBefore = state?.orchVersion ?? 0
        const oiv = setInterval(() => {
          if (state !== undefined && state.orchVersion !== orchBefore) {
            done('xiaochang_wait: 编排态变化(settle 结算/回队/裁决/时间盒)——读 xiaochang_status')
          }
        }, 2000)
        // ⑩ v8.5.3 全旗告警: 所有题 solved → 立即唤醒主 agent 停表(排名按 score_elapsed, 别磨)。
        const allSolved = (): boolean => {
          if (state === undefined) return false
          const chs = [...state.challenges.keys()]
          return chs.length > 0 && state.orch.size >= chs.length && chs.every(c => state.orch.get(c)?.state === 'solved')
        }
        const asv = setInterval(() => {
          if (allSolved()) done('xiaochang_wait: 全旗达成——所有题已 solved, 立即 xiaochang_finish(force=true) 停表(多磨一分钟都是白给)')
        }, 2000)
        // ⑦ v8.3 旗仓: 执行者 flag_report 跨进程写盘 → 唤醒主 agent 提交
        const flagSnap = (): string => {
          try {
            const pth = flagsPath()
            if (!existsSync(pth)) return ''
            const st = statSync(pth)
            return `${st.mtimeMs}:${st.size}`
          } catch { return '' }
        }
        let flagsBefore = flagSnap()
        const fgv = setInterval(() => {
          if (state === undefined) return // 执行者会话不轮询旗仓(主 agent 专属提交通道)
          const nowSnap = flagSnap()
          if (nowSnap !== flagsBefore) {
            flagsBefore = nowSnap
            done('xiaochang_wait: 旗仓新上报——读 xiaochang_flag_status 并立即 xiaochang_submit')
          }
        }, 2000)
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
        // ⑧ v8.4 思路回流推送: jisi fanout 报告落盘 → 唤醒主 agent 裁决(该题在槽或已有未消费思路时)。
        const fanInboxSnap = (): string => {
          try {
            const dir = fanoutInboxDir()
            if (!existsSync(dir)) return ''
            const files = codeFilter !== undefined
              ? readdirSync(dir).filter(f => f.endsWith('.jsonl') && f.replace(/\.jsonl$/, '') === codeFilter)
              : readdirSync(dir).filter(f => f.endsWith('.jsonl'))
            return files.map(f => { const st = statSync(join(dir, f)); return `${f}:${st.mtimeMs}:${st.size}` }).join('|')
          } catch { return '' }
        }
        let fanBefore = fanInboxSnap()
        const fiv = setInterval(() => {
          if (state === undefined) return // 执行者会话不监听思路信箱(主 agent 专属裁决通道)
          const nowSnap = fanInboxSnap()
          if (nowSnap !== fanBefore) {
            fanBefore = nowSnap
            done(`xiaochang_wait: 思路已回(fanout 报告到达)——读 xiaochang_collect 裁决采纳; 采纳即自动落盘账本①(未消费), enqueue 传 ideaIds 派兵即消费(题已持槽可加 dispatchNow 当场上车)\n在途执行者:\n${inflightSummary()}`)
          }
        }, 2000)
        // ⑨ v8.4 hint 闸自动开: 判死条件满足 → 主动推送(治习得性无助, 主 agent 不必反复试)。
        let gateBefore = [...(state?.hintGateOpen ?? [])].sort().join(',')
        const giv = setInterval(() => {
          if (state === undefined) return
          const nowSet = [...state.hintGateOpen].sort().join(',')
          if (nowSet !== gateBefore) {
            gateBefore = nowSet
            if (codeFilter !== undefined && !state.hintGateOpen.has(codeFilter)) return
            const opened = codeFilter !== undefined ? codeFilter : nowSet
            if (opened !== '') done(`xiaochang_wait: hint 闸已开(${opened})——请立即评估是否取 hint(满分>用时>花费): 剩余分 > hint 扣分就当场 xiaochang_hint; 决定不取也要显式记理由并转集思加模型多轮征集(决策权在你, 机制只提醒)`)
          }
        }, 2000)
        // ④ 超时
        const to = setTimeout(() => done(`xiaochang_wait: timeout after ${Math.round(timeoutMs / 1000)}s, no event`), timeoutMs)
        cleanup = () => { unsub(); clearInterval(iv); clearInterval(oiv); clearInterval(fgv); clearInterval(sv); clearInterval(fv); clearInterval(fiv); clearInterval(giv); clearInterval(asv); clearTimeout(to) }
        // v7.1 wait 入口评估: 两次 wait 之间写入的 fork 不落盲区——终态题归档(不唤醒), 活跃题立即唤醒。
        if (state !== undefined && evaluateInbox(codeFilter)) {
          inboxBefore = inboxSnap()
          done('xiaochang_wait: fork inbox changed — read xiaochang_graph and dispatch the untaken branches')
        }
        // v8.5.3 全旗达成入口检查: 最后一旗恰好落在两次 wait 之间 → 进场即唤醒。
        if (allSolved()) {
          done('xiaochang_wait: 全旗达成——所有题已 solved, 立即 xiaochang_finish(force=true) 停表(多磨一分钟都是白给)')
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
      // v8: 收尾按配对账释放全部授予并清空排队者。
      for (const code of [...s.grantedCodes]) await releaseGrant(code)
      for (const w of s.containerQueue?.waiters() ?? []) {
        try { s.containerQueue?.evict(w.holderId, 'campaign finished') } catch { /* 忽略 */ }
      }
      // v8: 停编排心跳, 清武装, 落盘编排态。
      if (tickTimer !== undefined) { clearInterval(tickTimer); tickTimer = undefined }
      s.armed.clear()
      bumpOrch(s)
      persistOrch(s)
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
      } else if (!allTerminal && args.force !== true) {
        clock = 'ℹ️ 存在非终态题，未调平台停表(需强停传 force=true——本地模式没有 guard 兜底, 钟会一直走)'
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
      const rs = runScoreOf(s)
      return `xiaochang_finish: score=${rs > 0 ? rs : score.score}/${score.max} (${score.completed}/${final.length} completed${score.completed === final.length ? ', ALL TERMINAL' : ''}${rs > 0 ? ', 计分表(平台每题累计分求和)' : ', 本地估算分'})\n排名钟：${clock}${guardMarker}`
    },
  }))
}
