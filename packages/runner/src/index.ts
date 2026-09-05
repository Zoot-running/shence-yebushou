/**
 * 校场 L4 自主跑分编排插件：xiaochang_start 工具。
 * 组成：夜不收适配器（平台六原语）＋虎符战役（求解工作项账本）＋集思通道（按次模型）。
 * 宿主循环负责容器生命周期（≤3 槽位）、flag 交卷、hint 经济学、clean-room 门禁、
 * JSONL 快照（崩溃恢复 = 重新调用工具即续跑）。
 * @module @shence/xiaochang-runner
 */

import { readFileSync } from 'node:fs'
import { appendFileSync, existsSync, mkdirSync, readFileSync as readJsonlSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HintLedger } from '../../../src/hint-ledger.ts'
import { TsecbenchAdapter, type ChallengeInfo, type FetchLike } from '../../../src/adapters/tsecbench.ts'
import {
  RunBudget,
  RunProgress,
  buildSolverPrompt,
  cleanRoomGate,
  extractFlags,
  policyFor,
  selectTargets,
} from './orchestrator.ts'
import type { ModelPolicy } from './orchestrator.ts'

export const name = 'shence-xiaochang-runner'
export const inject = ['tools', 'hufu']

interface StartArgs {
  concurrency?: number
  model?: string
  modelHard?: string
  effort?: string
  effortHard?: string
  effortRetry?: string
  budgetMinutes?: number
  roundsPerChallenge?: number
  roundTimeoutMinutes?: number
  maxHintsPerChallenge?: number
  knowledgeDir?: string
  baseURL?: string
  benchmarkToken?: string
  vpnGateway?: string
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** 难度 → 虎符优先级 tier。 */
function tierOf(difficulty: string): number {
  if (difficulty === 'easy') return 0
  if (difficulty === 'medium') return 1
  if (difficulty === 'hard') return 2
  return 3
}

/** 平台六原语在 Node fetch 上的适配。 */
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

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'xiaochang_start',
    description:
      'Start (or resume) an autonomous benchmark run on tsecbench: clean-room gated solver rounds driven by the hufu campaign over the jisi channel, with container lifecycle management, flag submission, hint economics, and JSONL crash-recovery snapshots. Returns the final summary. Runs for up to budgetMinutes.',
    parameters: {
      concurrency: { type: 'number', description: 'Solver concurrency (container slots, max 3). Default 3.' },
      model: { type: 'string', description: 'Solver model for easy/medium challenges. Default kimi-k2.6.' },
      modelHard: { type: 'string', description: 'Solver model for hard/insane challenges. Default glm-4.6.' },
      effort: { type: 'string', description: 'Reasoning effort for default rounds (off/low/high/max). Default high.' },
      effortHard: { type: 'string', description: 'Reasoning effort for hard/insane challenges. Default max.' },
      effortRetry: { type: 'string', description: 'Reasoning effort from round 2 on (escalation). Default max.' },
      budgetMinutes: { type: 'number', description: 'Total wall-clock budget. Default 320.' },
      roundsPerChallenge: { type: 'number', description: 'Max solver rounds per challenge. Default 3.' },
      roundTimeoutMinutes: { type: 'number', description: 'Per-round solver timeout. Default 20.' },
      maxHintsPerChallenge: { type: 'number', description: 'Official hints per challenge (10% score each). Default 1.' },
      knowledgeDir: { type: 'string', description: 'Local private knowledge dir for the clean-room gate.' },
      baseURL: { type: 'string', description: 'BENCHMARK_BASE_URL (defaults to env BENCHMARK_BASE_URL).' },
      benchmarkToken: { type: 'string', description: 'BENCHMARK_TOKEN (defaults to env BENCHMARK_TOKEN).' },
      vpnGateway: { type: 'string', description: 'VPN gateway health URL. Default http://10.0.100.58.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => false,
    async execute(args: StartArgs, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('xiaochang_start requires a calling agent')
      return await run(ctx, args, agent)
    },
  }))
}

async function run(ctx: Context, args: StartArgs, agent: unknown): Promise<string> {
  const env = process.env
  const baseURL = args.baseURL ?? env.BENCHMARK_BASE_URL
  const benchmarkToken = args.benchmarkToken ?? env.BENCHMARK_TOKEN
  if (baseURL === undefined || benchmarkToken === undefined) {
    return 'xiaochang: BENCHMARK_BASE_URL and BENCHMARK_TOKEN are required (args or env)'
  }
  const config = {
    concurrency: Math.min(3, args.concurrency ?? 3),
    budgetMs: (args.budgetMinutes ?? 320) * 60_000,
    maxRounds: args.roundsPerChallenge ?? 3,
    roundTimeoutMs: (args.roundTimeoutMinutes ?? 20) * 60_000,
    maxHints: args.maxHintsPerChallenge ?? 1,
    vpnGateway: args.vpnGateway ?? 'http://10.0.100.58',
    knowledgeDir: args.knowledgeDir ?? join(env.DSH_HOME ?? '.', 'storages', 'xiaochang-knowledge'),
    policy: {
      model: args.model ?? 'kimi-k2.6',
      modelHard: args.modelHard ?? 'glm-4.6',
      effort: args.effort ?? 'high',
      effortHard: args.effortHard ?? 'max',
      effortRetry: args.effortRetry ?? 'max',
    } satisfies ModelPolicy,
  }
  const snapshotPath = join(env.DSH_HOME ?? '.', 'storages', 'xiaochang-run.jsonl')

  const adapter = new TsecbenchAdapter({ baseURL, benchmarkToken, vpnGateway: config.vpnGateway }, nodeFetch())
  if (!(await adapter.gatewayHealthy())) {
    return 'xiaochang: VPN gateway is not healthy — connect the run VPN first (see jintuo/l4 notes)'
  }

  const skill = readFileSync(new URL('../prompts/solver.md', import.meta.url), 'utf8')

  // 恢复：读快照（崩溃后重新调用本工具即续跑）。
  let progress: RunProgress
  let budget: RunBudget
  if (existsSync(snapshotPath)) {
    const lines = readJsonlSync(snapshotPath, 'utf8').split('\n').filter(line => line.trim() !== '')
    progress = RunProgress.restore(lines)
    const startedAt = lines.length > 0 ? (JSON.parse(lines[0]!) as { at: number }).at : undefined
    budget = new RunBudget(config.budgetMs, Date.now, startedAt)
  } else {
    progress = new RunProgress()
    budget = new RunBudget(config.budgetMs)
  }

  const initial = await adapter.listChallenges()
  const challenges = new Map(initial.map(c => [c.unique_code, c]))

  // clean-room 门禁：本地私知里出现过该题号 → 本题放弃求解（宁可丢分不破红线）。
  const localFiles: Array<{ file: string; text: string }> = []
  if (existsSync(config.knowledgeDir)) {
    for (const entry of readdirRecursive(config.knowledgeDir)) {
      try {
        localFiles.push({ file: entry, text: readJsonlSync(entry, 'utf8') })
      } catch { /* 非文本文件跳过 */ }
    }
  }
  for (const challenge of initial) {
    if (progress.get(challenge.unique_code) !== undefined) continue
    const verdict = cleanRoomGate(challenge.unique_code, localFiles)
    if (verdict.contaminated) {
      progress.update(challenge.unique_code, {
        difficulty: challenge.difficulty,
        state: 'skipped',
        reason: `clean-room: local knowledge mentions ${challenge.unique_code}`,
        containerClosed: true,
      })
    }
  }

  const hintLedger = new HintLedger()
  const processed = new Set<string>()
  const solverOutputs = new Map<string, string>()

  // 战役：工作项 = 每题的每轮求解；账本自动喂终态报告（宿主绑定）。
  const holder = (ctx as unknown as { hufu: { createCampaign(p: unknown, c: object, items: unknown[]): HufuLike } }).hufu
  const campaign = holder.createCampaign(agent, {
    concurrency: config.concurrency,
    stallAfterMs: config.roundTimeoutMs + 10 * 60_000,
    heartbeatMs: 15 * 60_000,
    budgetMs: config.budgetMs,
  }, [])
  void solverOutputs

  persist(snapshotPath, progress)

  const summaryLines: string[] = []
  try {
    while (!budget.exhausted()) {
      // 0. 刷新平台视图（容器状态/完成度——崩溃恢复后以平台为准）。
      const fresh = await adapter.listChallenges()
      for (const c of fresh) challenges.set(c.unique_code, c)

      const targets = selectTargets([...challenges.values()], new Set([...progress.completedCodes(), ...progress.skippedCodes()]))
      if (targets.length === 0) break

      // 1. 关闭终态题的容器。
      for (const p of progress.all()) {
        if ((p.state === 'complete' || p.state === 'failed' || p.state === 'skipped') && !p.containerClosed) {
          const c = challenges.get(p.code)
          if (c !== undefined && (c.container_status === 'available' || c.container_status === 'pending')) {
            try { await adapter.close(p.code) } catch { /* 平台侧已关或异常 */ }
          }
          progress.update(p.code, { containerClosed: true })
        }
      }

      // 2. 处理终态工作项：交卷 / 推进下一轮 / 判失败。
      let changed = false
      for (const view of campaign.ledger.views()) {
        if (processed.has(view.item.id)) continue
        const terminal = view.state === 'done' || view.state === 'failed' || view.state === 'blocked'
        if (!terminal) continue
        processed.add(view.item.id)
        const code = codeOf(view.item.id)
        const seed = view.seed
        const p = progress.get(code)
        if (p === undefined || p.state === 'complete' || p.state === 'failed' || p.state === 'skipped') continue
        if (view.state === 'done') {
          const flags = extractFlags(view.terminalDetail ?? '')
          const accepted: string[] = []
          for (const flag of flags) {
            try {
              const res = await adapter.submit(code, flag)
              if (res.correct && !accepted.includes(flag)) accepted.push(flag)
            } catch { /* duplicate/校验错误忽略 */ }
          }
          const merged = [...new Set([...p.flags, ...accepted])]
          const challenge = challenges.get(code)
          const flagCount = challenge?.flag_count ?? Number.POSITIVE_INFINITY
          progress.update(code, { flags: merged, rounds: seed })
          if (merged.length >= flagCount) {
            progress.update(code, { state: 'complete' })
            summaryLines.push(`${code}: complete (${merged.length}/${flagCount} flags, ${seed} round(s))`)
          } else if (seed >= config.maxRounds) {
            progress.update(code, { state: 'failed', reason: `rounds exhausted with ${merged.length}/${flagCount} flags` })
            summaryLines.push(`${code}: failed (${merged.length}/${flagCount} after ${seed} rounds)`)
          } else {
            summaryLines.push(`${code}: round ${seed} done, ${merged.length}/${flagCount} flags`)
          }
        } else {
          progress.update(code, { rounds: seed })
          if (seed >= config.maxRounds) {
            progress.update(code, { state: 'failed', reason: `solver ${view.state} at round ${seed}` })
            summaryLines.push(`${code}: failed (solver ${view.state} at round ${seed})`)
          } else {
            summaryLines.push(`${code}: round ${seed} ${view.state}, retrying`)
          }
        }
        changed = true
      }

      // 3. 轮次超时：挂起的求解按失败处理，由下一轮接管。
      const now = Date.now()
      for (const view of campaign.ledger.views()) {
        if (view.state !== 'dispatched' && view.state !== 'help') continue
        const last = view.lastProgressAt ?? view.dispatchedAt
        if (last === undefined || now - last < config.roundTimeoutMs) continue
        campaign.report(view.item.id, 'failed', 'round timeout')
        processed.add(view.item.id)
      }

      // 4. 为需要继续/新开的题派下一轮（容器 ≤ 3）。
      const openContainers = new Set<string>()
      for (const c of challenges.values()) {
        if (c.container_status === 'available' || c.container_status === 'pending') openContainers.add(c.unique_code)
      }
      for (const target of targets) {
        const p = progress.get(target.unique_code)
        const rounds = p?.rounds ?? 0
        const terminal = p?.state === 'complete' || p?.state === 'failed' || p?.state === 'skipped'
        if (terminal) continue
        const activeRound = [...campaign.ledger.views()].some(v => codeOf(v.item.id) === target.unique_code && (v.state === 'dispatched' || v.state === 'help' || v.state === 'queued'))
        if (activeRound) continue
        // 容器准备：available 直接用；stopped 启动；pending 等待。
        let addrs: string[]
        if (target.container_status === 'available' && target.container_addr.length > 0) {
          addrs = target.container_addr
        } else if (target.container_status === 'stopped' || target.container_status === '') {
          if (openContainers.size >= 3) continue // 平台槽位上限
          try {
            const started = await adapter.start(target.unique_code)
            addrs = started.container_addr
          } catch {
            continue // 平台限流/资源不足，下一轮再试
          }
        } else {
          continue // pending：等待平台就绪
        }
        const seed = rounds + 1
        if (seed > config.maxRounds) {
          progress.update(target.unique_code, { state: 'failed', reason: 'rounds exhausted' })
          summaryLines.push(`${target.unique_code}: failed (rounds exhausted)`)
          continue
        }
        // hint 经济学：新轮次且本轮之后仍无 flag 时才考虑官方 hint。
        let hint: string | undefined
        const used = hintLedger.get(target.unique_code)?.hints ?? 0
        const found = p?.flags ?? []
        if (seed >= 2 && used < config.maxHints && found.length === 0) {
          try {
            const raw = await adapter.hint(target.unique_code) as { hint?: string | null }
            if (raw.hint !== null && raw.hint !== undefined && raw.hint !== '') {
              hint = raw.hint
              hintLedger.record(target.unique_code, target.total_score, `round ${seed} stuck`)
            }
          } catch { /* 已通关题无 hint；忽略 */ }
        }
        const label = buildSolverPrompt({
          skill,
          challenge: target,
          addrs,
          round: seed,
          maxRounds: config.maxRounds,
          found,
          hint,
        })
        const dispatchPolicy = policyFor(config.policy, target.difficulty, seed)
        campaign.add({
          id: `${target.unique_code}#s${seed}`,
          label,
          model: dispatchPolicy.model,
          ...(dispatchPolicy.reasoningEffort !== undefined ? { reasoningEffort: dispatchPolicy.reasoningEffort } : {}),
          priority: { tier: tierOf(target.difficulty), score: target.total_score * (config.maxRounds - seed + 1) },
        })
        progress.update(target.unique_code, { difficulty: target.difficulty, rounds: seed })
        changed = true
      }

      // 5. 派单（槽位空闲即派）。
      while (campaign.freeSlots() > 0 && campaign.nextQueued().length > 0) {
        await campaign.dispatchNext()
      }

      if (changed) persist(snapshotPath, progress)
      if (campaign.isComplete() && campaign.ledger.views().length > 0 && targets.length === 0) break
      await sleep(5000)
    }
  } finally {
    // 收敛：关闭所有仍开着的容器（尽力）。
    for (const p of progress.all()) {
      if (!p.containerClosed) {
        try { await adapter.close(p.code) } catch { /* 忽略 */ }
        progress.update(p.code, { containerClosed: true })
      }
    }
    persist(snapshotPath, progress)
  }

  // 最终成绩（平台口径）。
  const final = await adapter.listChallenges()
  const score = adapter.scoreOf(final)
  const hintTotal = hintLedger.totalDeducted()
  const result = [
    `xiaochang run finished`,
    `score=${score.score}/${score.max} (${score.completed}/${final.length} challenges completed)`,
    `hints=${hintLedger.totalHints()} (deducted ${hintTotal})`,
    `budgetUsedMs=${budget.elapsedMs()}`,
    `challenges=${progress.all().map(p => `${p.code}:${p.state}`).join(', ')}`,
  ].join('\n')
  return result
}

function codeOf(itemId: string): string {
  return itemId.split('#s')[0] ?? itemId
}

function persist(path: string, progress: RunProgress): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const line = `${progress.line()}\n`
  if (existsSync(path)) {
    appendFileSync(path, line)
  } else {
    writeFileSync(path, line)
  }
}

function readdirRecursive(dir: string): string[] {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...readdirRecursive(full))
    else out.push(full)
  }
  return out
}

/** 虎符服务面（最小类型面，运行时经 ctx.hufu 注入）。 */
interface HufuLike {
  add(item: { id: string; label: string; model?: string; reasoningEffort?: string; priority?: { tier: number; score: number } }): void
  freeSlots(): number
  nextQueued(): unknown[]
  dispatchNext(): Promise<unknown>
  report(itemId: string, kind: 'done' | 'failed' | 'blocked', detail?: string): void
  isComplete(): boolean
  ledger: {
    views(): Array<{ item: { id: string }; state: string; seed: number; terminalDetail?: string; dispatchedAt?: number; lastProgressAt?: number }>
  }
}
