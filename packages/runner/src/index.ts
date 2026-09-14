/**
 * 校场 v2：主 agent 工具集（调度权还给主 agent）。
 * runner 只做四件事：平台六原语、虎符战役执行（入队/派单/收果/剪枝）、
 * 状态与画像落盘、自动记账（超时败绩 + OBSERVATIONS 画像积累）。
 * 判断全归主 agent：何时征集思路（jisi_fanout）、派谁（jisi_model_report）、
 * 交不交卷、何时 finish——runner 提供工具与事实，不替主 agent 做决策。
 * @module @shence/xiaochang-runner
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HintLedger } from '../../../src/hint-ledger.ts'
import { addFact, createProfile, parse as parseProfile, render as renderProfile } from '../../../src/profile.ts'
import { TsecbenchAdapter, type ChallengeInfo, type FetchLike } from '../../../src/adapters/tsecbench.ts'
import {
  RunProgress,
  baseId,
  cleanRoomGate,
  codeOf,
  parseObservations,
  resolveExecutor,
  roundOf,
  sweepLegacyWorkdir,
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
  add(item: { id: string; label: string; model?: string; reasoningEffort?: string; priority?: { tier: number; score: number }; dependsOn?: string[]; board?: string }): void
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
}

let state: CampaignState | undefined
let heartbeatTimer: ReturnType<typeof setInterval> | undefined

function requireState(): CampaignState {
  if (state === undefined) throw new Error('xiaochang: not set up — call xiaochang_setup first')
  return state
}

function audit(path: string, line: object): void {
  try {
    appendFileSync(path, `${JSON.stringify(line)}\n`)
  } catch { /* 审计失败不影响主流程 */ }
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
  function renderKnowledge(code: string): string {
    const ks = knowledgeOfCode(code)
    if (ks.length === 0) return ''
    const lines = ['已知情报(自动附带, 前序执行者沉淀)']
    for (const k of ks) {
      const tag = k.kind === 'dead-end' ? '❌死路' : k.kind === 'fork' ? '🔀未走分叉' : '📌事实'
      lines.push(`- [${tag}] ${k.path}${k.conclusion !== undefined ? ' → ' + k.conclusion : ''}${k.evidence !== undefined ? ' (证据: ' + k.evidence + ')' : ''}`)
    }
    return lines.join('\n')
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
        }, [], { id: stableId, boardNamespace: `${args.runId ?? 'pending'}` })
        campaign = created.campaign
        campaignId = created.id
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
      return `xiaochang_setup ok: ${fresh.length} challenges, concurrency=${s.concurrency} (no threshold), budget ${Math.round(s.budgetMs / 60000)}min, resume=${progress.all().length > 0}, campaign=${campaignId ?? stableId}, swept=${swept}`
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
        return `${ch.unique_code} [${ch.difficulty}] ${ch.total_score}pts flags=${ch.correct_flag_count}/${ch.flag_count} completed=${ch.is_completed} container=${ch.container_status} addrs=${ch.container_addr.join(',') || '-'} progress=${p?.state ?? 'fresh'} | ${ch.description ?? ''}`
      })
      return `score=${score.score}/${score.max} (${score.completed}/${fresh.length})\n\n${rows.join('\n')}`
    },
  }))

  // ── 平台六原语 ────────────────────────────────────────────────────
  register(defineTool({
    name: 'xiaochang_start_container',
    description: 'Start a challenge container (platform cap: 3 containers at once). Seeds the shared findings board and returns its path — include the board path + read/append discipline in every executor prompt you build.',
    parameters: {
      code: { type: 'string', required: true, description: 'Challenge unique_code.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string }) {
      const s = requireState()
      // F27：开容器前先刷新平台状态——close 后平台异步更新，本地缓存会误判
      // "cap reached"（run 8 实测：平台已全停，本地 openContainers 仍记 3 个）。
      const fresh0 = await s.adapter.listChallenges()
      for (const x of fresh0) s.challenges.set(x.unique_code, x)
      const ch = s.challenges.get(args.code)
      if (ch === undefined) return `xiaochang_start_container: unknown challenge ${args.code}`
      if (ch.container_status === 'available' && ch.container_addr.length > 0) {
        return `already available: addrs=${ch.container_addr.join(',')}\nboardPath=${c().boardPath(args.code)}`
      }
      if (openContainers(s).size >= 3) {
        return 'xiaochang_start_container: platform cap reached (3 containers open) — close a finished challenge first'
      }
      const started = await s.adapter.start(args.code)
      const fresh = await s.adapter.listChallenges()
      for (const x of fresh) s.challenges.set(x.unique_code, x)
      s.progress.update(args.code, { difficulty: ch.difficulty, containerClosed: false })
      persistProgress(s)
      audit(s.auditPath, { type: 'container-start', code: args.code })
      return `started: addrs=${started.container_addr.join(',')}\nboardPath=${c().boardPath(args.code)}`
    },
  }))

  register(defineTool({
    name: 'xiaochang_close',
    description: 'Close a challenge container (release a platform slot).',
    parameters: { code: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string }) {
      const s = requireState()
      await s.adapter.close(args.code)
      s.progress.update(args.code, { containerClosed: true })
      persistProgress(s)
      return `closed ${args.code}`
    },
  }))

  register(defineTool({
    name: 'xiaochang_submit',
    description: 'Submit a flag candidate. Returns the platform verdict (correct/awarded/cumulative/flag counts).',
    parameters: {
      code: { type: 'string', required: true },
      flag: { type: 'string', required: true, description: 'Flag text (platform-annotated format, verbatim).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string; flag: string }) {
      const s = requireState()
      try {
        const res = await s.adapter.submit(args.code, args.flag)
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
    description: 'Fetch the official hint (deducts ~10% of the challenge score per hint; capped per challenge). Returns the hint text.',
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
      const ch = s.challenges.get(args.code)
      const raw = await s.adapter.hint(args.code) as { hint?: string | null }
      const hint = raw.hint
      if (hint === null || hint === undefined || hint === '') return 'xiaochang_hint: no hint available'
      s.hintLedger.record(args.code, ch?.total_score ?? 100, 'main-agent requested')
      return `hint (${used + 1}/${s.maxHints} used): ${hint}`
    },
  }))

  // ── 虎符执行 ──────────────────────────────────────────────────────
  register(defineTool({
    name: 'xiaochang_enqueue',
    description:
      'Enqueue one executor work item into the hufu campaign. You (the main agent) compose the prompt — include: challenge description, container addrs, the shared board path with read/append discipline, the org profile, the assigned approach (idea), and the FLAG_CANDIDATE output convention. Optional dependsOn makes it a DAG node (runs after dependencies reach a terminal state).',
    parameters: {
      code: { type: 'string', required: true },
      round: { type: 'number', required: true, description: 'Round number (your own accounting).' },
      prompt: { type: 'string', required: true, description: 'The full executor prompt.' },
      model: { type: 'string', description: 'Executor model. Default deepseek-v4-flash (cheap fast path; override for hard challenges).' },
      effort: { type: 'string', description: 'Reasoning effort (unsupported efforts are dropped per model).' },
      dependsOn: { type: 'array', description: 'Item ids this item waits for (DAG).' },
      priority: { type: 'number', description: 'Priority score (higher first within difficulty tier).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string; round: number; prompt: string; model?: string; effort?: string; dependsOn?: string[]; priority?: number }) {
      const s = requireState()
      const ch = s.challenges.get(args.code)
      if (ch === undefined) return `xiaochang_enqueue: unknown challenge ${args.code}`
      // F33: 派单自动携带该题已知情报(死路/未走分叉/事实)——任何种子/模型都从已知边界出发。
      // 知识读取失败绝不阻断派单(调度 > 记账)。
      let prior = ''
      try { prior = renderKnowledge(args.code) } catch { /* 附情报失败: 按无知识派单 */ }
      // v2: 上下文缺口自动附带(contextGaps)——缺啥补啥, 不罚模型只补题。
      const vq = s.v2[args.code]
      let gapsTxt = ''
      if (vq !== undefined && vq.gaps.length > 0) {
        gapsTxt = '\n\n已知上下文缺口(前序执行者反馈缺的信息, 若你能补则补, 不能补则明确说缺什么):\n' + vq.gaps.slice(-5).map(g => `- ${g}`).join('\n')
      }
      const label = (prior + gapsTxt) !== '' ? args.prompt + '\n\n' + prior + gapsTxt : args.prompt
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
        priority: { tier: tierOf(ch.difficulty), score: args.priority ?? ch.total_score },
      })
      s.progress.update(args.code, { difficulty: ch.difficulty, rounds: Math.max(s.progress.get(args.code)?.rounds ?? 0, args.round) })
      persistProgress(s)
      audit(s.auditPath, { type: 'enqueue', id: itemId, code: args.code, round: args.round, model: executor.model, effort: executor.effort })
      return `enqueued ${itemId} (executor=${executor.model}/${executor.effort}${executor.overriddenByLock ? ', OVERRIDDEN BY MODEL LOCK' : ''})`
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
      while (c().freeSlots() > 0 && c().nextQueued().length > 0) {
        await c().dispatchNext()
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
    async execute(args: { code: string; verdict: string; reason?: string; deadEnds?: Array<{ path: string; conclusion?: string; evidence?: string }>; forks?: Array<{ path: string; conclusion?: string; evidence?: string }>; observations?: Array<{ path: string; conclusion?: string }>; why?: string; gaps?: string[] }) {
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
      try { await s.adapter.close(args.code) } catch { /* 平台侧已关 */ }
      s.progress.update(args.code, { state: verdict, reason: args.reason, containerClosed: true })
      for (const v of c().ledger.views()) {
        if (codeOf(v.item.id) === args.code
          && (v.state === 'queued' || v.state === 'dispatched' || v.state === 'help' || v.state === 'stalled')) {
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
      const s = requireState()
      const ch = s.challenges.get(args.code)
      if (ch === undefined) return `xiaochang_refanout: unknown challenge ${args.code}`
      const vq = s.v2[args.code] ?? { qtype: classifyQtype(ch.description ?? ''), difficulty: difficultyPrior(ch.total_score), wins: 0, fails: 0, gaps: [], triedModels: [], ideaRound: 1, deadIdeas: 0, adopted: 0 }
      const agent = exec.agent
      if (agent === undefined) return 'xiaochang_refanout: requires a calling agent'
      // ① 拼装 R2 prompt: 题面+画像+死路+缺口+已试(R1 全部思路已在知识账本, 主 agent 裁决过的 adopted 也在)。
      const dead = knowledgeOfCode(args.code).filter(k => k.kind === 'dead-end').map(k => `- ${k.path}: ${k.conclusion ?? ''}`).join('\n') || '(无)'
      const gaps = vq.gaps.length > 0 ? vq.gaps.map(g => `- ${g}`).join('\n') : '(无)'
      const tried = vq.triedModels.length > 0 ? vq.triedModels.join(', ') : '(无)'
      const prompt = `[二次思路征集 R${vq.ideaRound + 1}] 题目 ${args.code}(${vq.qtype}, 校准难度 ${vq.difficulty}/100)
题面: ${(ch.description ?? '').slice(0, 1500)}

已知死路(前序思路已证不可行):
${dead}

上下文缺口(前序执行者反馈缺的信息):
${gaps}

已试模型: ${tried}
已采用思路 ${vq.adopted} 条, 已死 ${vq.deadIdeas} 条。

提问: 已知以上死路与缺口之后, 还有哪些**没试过**的方向? 不要重复死路; 每条给: 为什么可行 + 验证点 + 需要补的上下文。`
      // ② 选模: 直接加模型——pick 排名里未试过的优先(增添信息), 全试过则连已试也不排除(全量兜底)。
      let models: string[] = []
      if (jisi?.pickRank !== undefined) {
        const ranked = await jisi.pickRank(vq.qtype, vq.difficulty, 'idea')
        const fresh = ranked.filter(r => !vq.triedModels.includes(r.model)).map(r => r.model)
        models = fresh.length > 0 ? fresh.slice(0, 3) : ranked.slice(0, 3).map(r => r.model)
      }
      if (models.length === 0) {
        const listed = await jisi?.listModels()
        models = (listed ?? []).map(m => m.id).slice(0, 3)
      }
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
      'F33 fork alarm: you (executor) found untaken promising branches or hard-won evidence — record them as fork knowledge AND wake the main agent immediately (followup, zero wait). The main agent alone decides whether to dispatch (single scheduler).',
    parameters: {
      code: { type: 'string', required: true },
      forks: { type: 'array', required: true, description: '[{path, conclusion, evidence}] untaken branches worth dispatching.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args: { code: string; forks: Array<{ path: string; conclusion?: string; evidence?: string }> }) {
      if (args.forks.length === 0) return 'xiaochang_fork: no forks given'
      const entries: KnowledgeIn[] = args.forks.map(f => ({ kind: 'fork', path: f.path, conclusion: f.conclusion, evidence: f.evidence, by: 'fork', at: Date.now() }))
      const lines = entries.map(f => `- 🔀 ${f.path}${f.conclusion !== undefined ? ' → ' + f.conclusion : ''}${f.evidence !== undefined ? ' (证据: ' + f.evidence + ')' : ''}`)
      // 可靠通道: 写盘分叉信箱——主 agent 的 xiaochang_wait 轮询到变化即唤醒(跨会话/跨进程)。
      let inbox = ''
      try { inbox = writeForkInbox(args.code, entries) } catch { /* 信箱写失败 */ }
      // 同进程直接入账(主 agent 自调 fork 时生效; 执行者会话里 campaign 不存在则为 no-op)。
      try { recordKnowledgeOnCode(args.code, entries) } catch { /* 入账失败不阻断 */ }
      // followup 仅同进程可达(执行者会话里 parentAgent 不是主 agent, 跨进程不可达——
      // 不做虚假承诺; 真正唤醒靠上面的信箱+wait 轮询)。
      const sameProcess = parentAgent !== undefined && campaign !== undefined
      if (sameProcess) {
        parentAgent?.followup(createUserMessage({
          content: [{ type: 'text', text: `🔀 分叉即时报(${args.code}): 发现 ${entries.length} 条未走分叉, 已入账+信箱。由你(主 agent)决定是否 jisi_fanout_bulk / xiaochang_enqueue 增兵。\n${lines.join('\n')}` }],
          source: { kind: 'user' },
        }))
      }
      return `fork ${inbox !== '' ? '已写入分叉信箱(' + inbox + '), 主 agent 的 xiaochang_wait 会被唤醒并在读图时吸收' : '信箱写入失败'}${sameProcess ? '; 同进程已直接入账并唤醒' : ''}:\n${lines.join('\n')}`
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
      return rows.join('\n')
    },
  }))

  register(defineTool({
    name: 'xiaochang_status',
    description: 'Campaign status: ledger summary, per-challenge progress, budget remaining, open containers.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute() {
      const s = requireState()
      const views = c().ledger.views()
      const count = (fn: (v: { state: string }) => boolean): number => views.filter(fn).length
      const remaining = Math.max(0, s.startedAt + s.budgetMs - Date.now())
      const progress = s.progress.all().map(p => `${p.code}:${p.state}${p.state === 'complete' ? `(${p.flags.length} flags)` : ''}`).join(', ')
      // v2 第 3 层: 升级状态机可见性(采纳/已死计数来自集思裁决账)。
      const escLines: string[] = []
      for (const [code, q] of Object.entries(s.v2)) {
        const st = jisi?.adoptionStats?.(code) ?? { adopted: q.adopted, dead: q.deadIdeas }
        if (st.adopted === 0) continue
        if (st.dead / st.adopted >= 0.5) {
          escLines.push(`⚠️ ${code}: 死思路 ${st.dead}/${st.adopted} ≥50% → 建议 xiaochang_refanout 二次征集(难度${q.difficulty}, 已试 ${q.triedModels.join(',') || '无'})`)
        }
      }
      const escTxt = escLines.length > 0 ? `\n升级建议:\n${escLines.join('\n')}` : ''
      return [
        `campaign: open=${count(v => v.state === 'dispatched' || v.state === 'help')} queued=${count(v => v.state === 'queued')} done=${count(v => v.state === 'done')} failed=${count(v => v.state === 'failed')} blocked=${count(v => v.state === 'blocked')}`,
        `budgetRemainingMin=${Math.round(remaining / 60000)}`,
        `openContainers=${[...openContainers(s)].join(',') || 'none'}`,
        `hints=${s.hintLedger.totalHints()} (deducted ${s.hintLedger.totalDeducted()})`,
        `progress: ${progress}`, escTxt,
      ].join('\n')
    },
  }))

  register(defineTool({
    name: 'xiaochang_wait',
    description:
      'Event-driven wait (F30): blocks the turn without spending any LLM tokens until (a) an executor settles, (b) the campaign ledger changes, (c) a new session message arrives, (d) a fork lands in the fork inbox (executor xiaochang_fork), or (e) the timeout. This is THE way to wait — never bash sleep for waiting. Returns what woke it.',
    parameters: {
      timeoutSeconds: { type: 'number', description: 'Max wait seconds (default 300, clamp 5..900).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args: { timeoutSeconds?: number }, exec) {
      const timeoutMs = Math.min(Math.max(args.timeoutSeconds ?? 300, 5), 900) * 1000
      const agent = exec.agent
      const ledgerSnap = (): string => {
        try { return JSON.stringify(campaign?.ledger.views().map(v => [v.item.id, v.state, v.terminalDetail ?? '', v.lastProgressAt ?? 0])) } catch { return '' }
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
        // ① 虎符 settle 事件（一次性执行者结算）
        const unsub = campaignId !== undefined && holder.onSettle !== undefined
          ? holder.onSettle(campaignId, ev => done(`xiaochang_wait: ${ev.itemId} settled (${ev.status})${ev.text !== '' ? ': ' + ev.text.slice(0, 200) : ''}`))
          : (): void => {}
        // ② 账本轮询兜底（超时判失败/主 agent 自己 report 等）
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
            return readdirSync(inboxDir).filter(f => f.endsWith('.jsonl'))
              .map(f => { const st = statSync(join(inboxDir, f)); return `${f}:${st.mtimeMs}:${st.size}` })
              .join('|')
          } catch { return '' }
        }
        const inboxBefore = inboxSnap()
        const fv = setInterval(() => { if (inboxSnap() !== inboxBefore) done('xiaochang_wait: fork inbox changed — read xiaochang_graph and dispatch the untaken branches') }, 2000)
        // ④ 超时
        const to = setTimeout(() => done(`xiaochang_wait: timeout after ${Math.round(timeoutMs / 1000)}s, no event`), timeoutMs)
        cleanup = () => { unsub(); clearInterval(iv); clearInterval(sv); clearInterval(fv); clearTimeout(to) }
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
    async execute(args: { force?: boolean }) {
      const s = requireState()
      for (const ch of s.challenges.values()) {
        if (ch.container_status === 'available' || ch.container_status === 'pending') {
          try { await s.adapter.close(ch.unique_code) } catch { /* 忽略 */ }
        }
        s.progress.update(ch.unique_code, { containerClosed: true })
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
      return `xiaochang_finish: score=${score.score}/${score.max} (${score.completed}/${final.length} completed${score.completed === final.length ? ', ALL TERMINAL' : ''})\n排名钟：${clock}${guardMarker}`
    },
  }))
}
