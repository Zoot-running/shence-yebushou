/**
 * 校场 v2：主 agent 工具集（调度权还给主 agent）。
 * runner 只做四件事：平台六原语、虎符战役执行（入队/派单/收果/剪枝）、
 * 状态与画像落盘、自动记账（超时败绩 + OBSERVATIONS 画像积累）。
 * 判断全归主 agent：何时征集思路（jisi_fanout）、派谁（jisi_model_report）、
 * 交不交卷、何时 finish——runner 提供工具与事实，不替主 agent 做决策。
 * @module @shence/xiaochang-runner
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HintLedger } from '../../../src/hint-ledger.ts'
import { addFact, createProfile, parse as parseProfile, render as renderProfile } from '../../../src/profile.ts'
import { TsecbenchAdapter, type ChallengeInfo, type FetchLike } from '../../../src/adapters/tsecbench.ts'
import {
  RunProgress,
  baseId,
  cleanRoomGate,
  codeOf,
  parseObservations,
  roundOf,
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
  cancel(itemId: string, reason: string): void
  boardPath(group: string): string
  isComplete(): boolean
  ledger: {
    views(): Array<{ item: { id: string; model?: string }; state: string; seed: number; terminalDetail?: string; dispatchedAt?: number; lastProgressAt?: number }>
  }
}

/** 集思服务面（能力账本；fanout 由主 agent 经 jisi_fanout 工具调用）。 */
interface JisiLike {
  ledger: {
    record(model: string, dimension: 'execution' | 'idea', key: string, win: boolean): void
  }
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
  processed: Set<string>
  challenges: Map<string, ChallengeInfo>
}

let state: CampaignState | undefined

function requireState(): CampaignState {
  if (state === undefined) throw new Error('xiaochang: not set up — call xiaochang_setup first')
  return state
}

function audit(path: string, line: object): void {
  try {
    appendFileSync(path, `${JSON.stringify(line)}\n`)
  } catch { /* 审计失败不影响主流程 */ }
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
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

export function apply(ctx: Context): void {
  const jisi = (ctx as unknown as { get?: (name: string) => unknown }).get?.('jisi') as JisiLike | undefined
  const holder = (ctx as unknown as { hufu: { createCampaign(p: unknown, c: object, items: unknown[]): HufuLike } }).hufu
  let campaign: HufuLike | undefined

  const c = (): HufuLike => {
    if (campaign === undefined) throw new Error('xiaochang: not set up — call xiaochang_setup first')
    return campaign
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
      runBearerToken: { type: 'string', description: 'Platform session Bearer token for early finish (stop the ranking clock).' },
      runId: { type: 'number', description: 'Platform run id.' },
      concurrency: { type: 'number', description: 'Campaign slots. Default 999 (no artificial threshold; backpressure = CPU/RAM/provider limits only).' },
      budgetMinutes: { type: 'number', description: 'Wall-clock budget. Default 330.' },
      roundTimeoutMinutes: { type: 'number', description: 'Auto-report a dispatched item as failed after this long. Default 30.' },
      maxHintsPerChallenge: { type: 'number', description: 'Official hints per challenge (10% score each). Default 1.' },
      knowledgeDir: { type: 'string', description: 'Local private knowledge dir for the clean-room gate.' },
      profilePath: { type: 'string', description: 'Org-profile file path.' },
      vpnGateway: { type: 'string', description: 'VPN gateway health URL. Default http://10.0.100.58.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: SetupArgs, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('xiaochang_setup requires a calling agent')
      const env = process.env
      const baseURL = args.baseURL ?? env.BENCHMARK_BASE_URL
      const benchmarkToken = args.benchmarkToken ?? env.BENCHMARK_TOKEN
      if (baseURL === undefined || benchmarkToken === undefined) {
        return 'xiaochang_setup: BENCHMARK_BASE_URL and BENCHMARK_TOKEN required (args or env)'
      }
      const home = env.DSH_HOME ?? '.'
      const snapshotPath = join(home, 'storages', 'xiaochang-run.jsonl')
      // 恢复：快照存在则续跑（预算起点沿用首条快照时间）。
      let progress = new RunProgress()
      let startedAt = Date.now()
      if (existsSync(snapshotPath)) {
        const lines = readFileSync(snapshotPath, 'utf8').split('\n').filter(l => l.trim() !== '')
        progress = RunProgress.restore(lines)
        const first = lines.length > 0 ? (JSON.parse(lines[0]!) as { at: number }).at : undefined
        if (first !== undefined) startedAt = first
      }
      const s: CampaignState = {
        baseURL,
        benchmarkToken,
        runBearerToken: args.runBearerToken,
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
        processed: new Set(),
        challenges: new Map(),
      }
      try {
        if (existsSync(s.profilePath)) s.profile = parseProfile(readFileSync(s.profilePath, 'utf8'))
      } catch { /* 画像损坏：空画像 */ }
      state = s
      campaign = holder.createCampaign(agent, {
        concurrency: s.concurrency,
        stallAfterMs: s.roundTimeoutMs + 10 * 60_000,
        heartbeatMs: 15 * 60_000,
        budgetMs: s.budgetMs,
      }, [])
      if (!(await s.adapter.gatewayHealthy())) {
        return 'xiaochang_setup: VPN gateway not healthy — connect the run VPN first'
      }
      const fresh = await s.adapter.listChallenges()
      for (const ch of fresh) s.challenges.set(ch.unique_code, ch)
      persistProgress(s)
      return `xiaochang_setup ok: ${fresh.length} challenges, concurrency=${s.concurrency} (no threshold), budget ${Math.round(s.budgetMs / 60000)}min, resume=${progress.all().length > 0}`
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
      const localFiles: Array<{ file: string; text: string }> = []
      if (existsSync(s.knowledgeDir)) {
        for (const file of walk(s.knowledgeDir)) {
          try { localFiles.push({ file, text: readFileSync(file, 'utf8') }) } catch { /* 非文本 */ }
        }
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
    async execute(args: { code: string }) {
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
      model: { type: 'string', description: 'Executor model (leave empty to let the platform default run).' },
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
      const seq = s.progress.get(args.code)?.rounds ?? 0
      const itemId = `${args.code}#s${args.round}-w${seq + 1}`
      c().add({
        id: itemId,
        label: args.prompt,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.effort !== undefined ? { reasoningEffort: args.effort } : {}),
        ...(args.dependsOn !== undefined && args.dependsOn.length > 0 ? { dependsOn: args.dependsOn } : {}),
        board: args.code,
        priority: { tier: tierOf(ch.difficulty), score: args.priority ?? ch.total_score },
      })
      s.progress.update(args.code, { difficulty: ch.difficulty, rounds: Math.max(s.progress.get(args.code)?.rounds ?? 0, args.round) })
      persistProgress(s)
      audit(s.auditPath, { type: 'enqueue', id: itemId, code: args.code, round: args.round, model: args.model })
      return `enqueued ${itemId}`
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
      for (const v of c().ledger.views()) {
        if (v.state !== 'dispatched' && v.state !== 'help') continue
        const last = v.lastProgressAt ?? v.dispatchedAt
        if (last === undefined || now - last < s.roundTimeoutMs) continue
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
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string; verdict: string; reason?: string }) {
      const s = requireState()
      const verdict = args.verdict === 'complete' ? 'complete' as const : args.verdict === 'failed' ? 'failed' as const : 'skipped' as const
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
      return [
        `campaign: open=${count(v => v.state === 'dispatched' || v.state === 'help')} queued=${count(v => v.state === 'queued')} done=${count(v => v.state === 'done')} failed=${count(v => v.state === 'failed')} blocked=${count(v => v.state === 'blocked')}`,
        `budgetRemainingMin=${Math.round(remaining / 60000)}`,
        `openContainers=${[...openContainers(s)].join(',') || 'none'}`,
        `hints=${s.hintLedger.totalHints()} (deducted ${s.hintLedger.totalDeducted()})`,
        `progress: ${progress}`,
      ].join('\n')
    },
  }))

  register(defineTool({
    name: 'xiaochang_finish',
    description:
      'Close all open containers, stop the ranking clock via the platform finish endpoint (when all challenges are terminal or you decide to end), and return the final platform score.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute() {
      const s = requireState()
      for (const ch of s.challenges.values()) {
        if (ch.container_status === 'available' || ch.container_status === 'pending') {
          try { await s.adapter.close(ch.unique_code) } catch { /* 忽略 */ }
        }
        s.progress.update(ch.unique_code, { containerClosed: true })
      }
      persistProgress(s)
      const final = await s.adapter.listChallenges()
      const score = s.adapter.scoreOf(final)
      const allTerminal = final.every(ch => ch.is_completed || ['failed', 'skipped'].includes(s.progress.get(ch.unique_code)?.state ?? ''))
      if (allTerminal && s.runBearerToken !== undefined && s.runId !== undefined) {
        try {
          const res = await fetch(`${s.baseURL}/api/v1/runs/${s.runId}/finish`, {
            method: 'POST',
            headers: { authorization: `Bearer ${s.runBearerToken}` },
          })
          if (!res.ok) throw new Error(`finish ${res.status}`)
        } catch (error) {
          console.error(`xiaochang: finishRun failed: ${String(error)}`)
        }
      }
      return `xiaochang_finish: score=${score.score}/${score.max} (${score.completed}/${final.length} completed${score.completed === final.length ? ', ALL TERMINAL' : ''})`
    },
  }))
}
