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
  buildIdeaPrompt,
  buildSolverPrompt,
  cleanRoomGate,
  codeOf,
  extractFlags,
  parseIdeas,
  policyFor,
  roundOf,
  selectTargets,
} from './orchestrator.ts'
import type { ModelPolicy } from './orchestrator.ts'

export const name = 'shence-xiaochang-runner'
export const inject = ['tools', 'hufu', 'jisi']

interface StartArgs {
  concurrency?: number
  model?: string
  modelMedium?: string
  modelHard?: string
  effort?: string
  effortMedium?: string
  effortHard?: string
  effortRetry?: string
  /** 集思思路征集模型（hard/escalation 轮次 fanout）。 */
  fanoutModels?: string[]
  /** 每题每轮最多执行多少条思路（虎符并行上限）。 */
  maxIdeasPerChallenge?: number
  /** 每个模型最多出几条思路。 */
  maxIdeasPerModel?: number
  budgetMinutes?: number
  roundsPerChallenge?: number
  roundTimeoutMinutes?: number
  maxHintsPerChallenge?: number
  knowledgeDir?: string
  baseURL?: string
  benchmarkToken?: string
  vpnGateway?: string
  /** 可选：平台会话 Bearer token + run id —— 全题终态/预算耗尽后立即 finish 停止计时。 */
  runBearerToken?: string
  runId?: number
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
      model: { type: 'string', description: 'Solver model for easy challenges. Default kimi-k3.' },
      modelMedium: { type: 'string', description: 'Solver model for medium challenges. Default deepseek-v4-flash.' },
      modelHard: { type: 'string', description: 'Solver model for hard/insane challenges. Default deepseek-v4-pro.' },
      effort: { type: 'string', description: 'Reasoning effort for easy (off/low/high/max). Default high.' },
      effortMedium: { type: 'string', description: 'Reasoning effort for medium. Default low (flash fast path).' },
      effortHard: { type: 'string', description: 'Reasoning effort for hard/insane. Default max.' },
      effortRetry: { type: 'string', description: 'Reasoning effort from round 2 on (escalation). Default max.' },
      fanoutModels: { type: 'array', description: 'Idea-gathering models (jisi fanout) for hard/escalation rounds. Default [deepseek-v4-pro, kimi-k3, glm-5.3].' },
      maxIdeasPerChallenge: { type: 'number', description: 'Max approaches executed in parallel per challenge round. Default 6.' },
      maxIdeasPerModel: { type: 'number', description: 'Max approaches each idea model may propose. Default 3.' },
      budgetMinutes: { type: 'number', description: 'Total wall-clock budget. Default 320.' },
      roundsPerChallenge: { type: 'number', description: 'Max solver rounds per challenge. Default 3.' },
      roundTimeoutMinutes: { type: 'number', description: 'Per-round solver timeout. Default 20.' },
      maxHintsPerChallenge: { type: 'number', description: 'Official hints per challenge (10% score each). Default 1.' },
      knowledgeDir: { type: 'string', description: 'Local private knowledge dir for the clean-room gate.' },
      baseURL: { type: 'string', description: 'BENCHMARK_BASE_URL (defaults to env BENCHMARK_BASE_URL).' },
      benchmarkToken: { type: 'string', description: 'BENCHMARK_TOKEN (defaults to env BENCHMARK_TOKEN).' },
      vpnGateway: { type: 'string', description: 'VPN gateway health URL. Default http://10.0.100.58.' },
      runBearerToken: { type: 'string', description: 'Optional platform session Bearer token to finish the run early (stop the ranking clock).' },
      runId: { type: 'number', description: 'Optional platform run id for early finish.' },
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
  const jisi = (ctx as unknown as { get?: (name: string) => unknown }).get?.('jisi') as JisiLike | undefined
  const config = {
    concurrency: Math.min(3, args.concurrency ?? 3),
    budgetMs: (args.budgetMinutes ?? 320) * 60_000,
    maxRounds: args.roundsPerChallenge ?? 3,
    roundTimeoutMs: (args.roundTimeoutMinutes ?? 20) * 60_000,
    maxHints: args.maxHintsPerChallenge ?? 1,
    vpnGateway: args.vpnGateway ?? 'http://10.0.100.58',
    knowledgeDir: args.knowledgeDir ?? join(env.DSH_HOME ?? '.', 'storages', 'xiaochang-knowledge'),
    policy: {
      model: args.model ?? 'kimi-k3',
      modelMedium: args.modelMedium ?? 'deepseek-v4-flash',
      modelHard: args.modelHard ?? 'deepseek-v4-pro',
      effort: args.effort ?? 'high',
      effortMedium: args.effortMedium ?? 'low',
      effortHard: args.effortHard ?? 'max',
      effortRetry: args.effortRetry ?? 'max',
    } satisfies ModelPolicy,
    fanoutModels: args.fanoutModels ?? ['deepseek-v4-pro', 'kimi-k3', 'glm-5.3'],
    maxIdeasPerChallenge: args.maxIdeasPerChallenge ?? 6,
    maxIdeasPerModel: args.maxIdeasPerModel ?? 3,
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
  // (code, round) → 该轮已消耗的限流重试次数（round 不变、不消耗 maxRounds）。
  const rateRetries = new Map<string, number>()
  // (code, round) → 该轮求解 prompt（限流重试用同一 prompt）。
  const roundLabels = new Map<string, string>()
  // code → 最近一轮求解者的工作记录（下一轮续跑，轮次间不丢进度）。
  const lastRoundDetail = new Map<string, string>()

  // 战役：工作项 = 每题的每轮求解；账本自动喂终态报告（宿主绑定）。
  const holder = (ctx as unknown as { hufu: { createCampaign(p: unknown, c: object, items: unknown[]): HufuLike } }).hufu
  const campaign = holder.createCampaign(agent, {
    concurrency: config.concurrency,
    stallAfterMs: config.roundTimeoutMs + 10 * 60_000,
    heartbeatMs: 15 * 60_000,
    budgetMs: config.budgetMs,
  }, [])

  const auditPath = join(env.DSH_HOME ?? '.', 'storages', 'xiaochang-run-audit.jsonl')
  const audit = (line: object): void => {
    try {
      appendFileSync(auditPath, `${JSON.stringify(line)}\n`)
    } catch { /* 审计失败不影响主流程 */ }
  }
  let lastHeartbeatAt = 0

  persist(snapshotPath, progress)

  const summaryLines: string[] = []
  try {
    // 0. 启动清理：崩溃/重启残留的容器全部关闭（campaign 从空重建，无在途轮次）。
    const startup = await adapter.listChallenges()
    for (const c of startup) challenges.set(c.unique_code, c)
    for (const c of startup) {
      if (c.container_status === 'available' || c.container_status === 'pending') {
        try { await adapter.close(c.unique_code) } catch { /* 忽略 */ }
      }
    }

    while (!budget.exhausted()) {
      // 0b. 刷新平台视图（容器状态/完成度——崩溃恢复后以平台为准）。
      const fresh = await adapter.listChallenges()
      for (const c of fresh) challenges.set(c.unique_code, c)

      const targets = selectTargets([...challenges.values()], new Set([...progress.completedCodes(), ...progress.skippedCodes()]))
      if (targets.length === 0) break
      // 复活：仅剩 failed 且预算余量充足 → 重置轮次再战（保完成率线）。
      const openTargets = targets.filter(t => progress.get(t.unique_code)?.state !== 'failed')
      if (openTargets.length === 0 && budget.remainingMs() > 30 * 60_000) {
        for (const p of progress.all()) {
          if (p.state === 'failed' && challenges.get(p.code)?.is_completed !== true) {
            progress.update(p.code, { state: 'solving', rounds: 0, reason: 'revisit: fresh rounds' })
            summaryLines.push(`${p.code}: revisit with fresh rounds`)
          }
        }
        rateRetries.clear()
        roundLabels.clear()
        continue
      }

      // 1. 关闭终态题的容器：以平台状态为准（containerClosed 仅作提示，不阻止重试关闭）。
      for (const p of progress.all()) {
        if (p.state !== 'complete' && p.state !== 'failed' && p.state !== 'skipped') continue
        const c = challenges.get(p.code)
        if (c === undefined || (c.container_status !== 'available' && c.container_status !== 'pending')) continue
        try {
          await adapter.close(p.code)
          progress.update(p.code, { containerClosed: true })
        } catch { /* 关闭失败：下一轮循环按平台状态重试（不再因本地标志泄漏槽位） */ }
      }

      // 2. 处理终态工作项：交卷 / 推进下一轮 / 限流重试（轮次取自工作项 id，不取账本 seed）。
      let changed = false
      for (const view of campaign.ledger.views()) {
        const terminal = view.state === 'done' || view.state === 'failed' || view.state === 'blocked'
        if (!terminal) continue
        // 迟到的求解输出：即使该工作项已被处理（如超时判失败后真答复才到），
        // 也把工作记录喂给下一轮续跑——轮次间不丢进度。
        const lateDetail = (view.terminalDetail ?? '').trim()
        if (lateDetail !== '' && !lateDetail.startsWith('[diagnostic]') && !lateDetail.includes('round timeout')) {
          const lateCode = codeOf(view.item.id)
          lastRoundDetail.set(lateCode, lateDetail)
        }
        if (processed.has(view.item.id)) continue
        processed.add(view.item.id)
        const code = codeOf(view.item.id)
        const round = roundOf(view.item.id)
        const p = progress.get(code)
        audit({ type: 'terminal', id: view.item.id, state: view.state, round, detail: (view.terminalDetail ?? '').slice(0, 400) })
        if (p === undefined || p.state === 'complete' || p.state === 'failed' || p.state === 'skipped') continue
        // 剪枝项（cancel → blocked）不再处理：不得重试、不得推进轮次。
        if (view.state === 'blocked') {
          audit({ type: 'canceled', id: view.item.id, round })
          continue
        }
        // 记录本轮工作记录，供下一轮续跑（超时/未完成的轮次不丢侦察成果）。
        if (lateDetail !== '') {
          lastRoundDetail.set(code, lateDetail)
        }
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
          progress.update(code, { flags: merged, rounds: round })
          if (merged.length >= flagCount) {
            progress.update(code, { state: 'complete' })
            // 拿完 flag 立即关容器（排名按 score_elapsed_seconds：越快越靠前）。
            try { await adapter.close(code) } catch { /* 忽略 */ }
            progress.update(code, { containerClosed: true })
            // 剪枝：同题其余排队/在途思路项全部取消，槽位与队列立即释放。
            for (const sibling of campaign.ledger.views()) {
              if (sibling.item.id !== view.item.id && codeOf(sibling.item.id) === code
                && (sibling.state === 'queued' || sibling.state === 'dispatched' || sibling.state === 'help' || sibling.state === 'stalled')) {
                try { campaign.cancel(sibling.item.id, 'challenge complete (sibling idea)') } catch { /* 终态竞争：忽略 */ }
              }
            }
            summaryLines.push(`${code}: complete (${merged.length}/${flagCount} flags, ${round} round(s))`)
          } else if (round >= config.maxRounds) {
            progress.update(code, { state: 'failed', reason: `rounds exhausted with ${merged.length}/${flagCount} flags` })
            summaryLines.push(`${code}: failed (${merged.length}/${flagCount} after ${round} rounds)`)
          } else {
            summaryLines.push(`${code}: round ${round} done, ${merged.length}/${flagCount} flags`)
          }
        } else {
          // 限流/瞬时错误（含空诊断的静默失败）：不消耗轮次，同轮重试（最多 5 次）。
          const detail = view.terminalDetail ?? ''
          const transient = /429|rate.?limit|overload|too many|限流|频率|busy/i.test(detail) || detail.trim() === ''
          const retryKey = `${code}#${round}`
          const retries = rateRetries.get(retryKey) ?? 0
          if (transient && retries < 5) {
            rateRetries.set(retryKey, retries + 1)
            audit({ type: 'rate-retry', code, round, retries: retries + 1 })
            const cached = roundLabels.get(retryKey)
            const challenge = challenges.get(code)
            const dispatchPolicy = policyFor(config.policy, challenge?.difficulty ?? 'hard', round)
            campaign.add({
              id: `${retryKey}-r${retries + 1}`,
              label: cached ?? `retry ${code} round ${round}`,
              model: dispatchPolicy.model,
              ...(dispatchPolicy.reasoningEffort !== undefined ? { reasoningEffort: dispatchPolicy.reasoningEffort } : {}),
              priority: { tier: tierOf(challenge?.difficulty ?? 'hard'), score: 9999 },
            })
            summaryLines.push(`${code}: round ${round} transient failure (retry ${retries + 1}/5)`)
          } else {
            progress.update(code, { rounds: round })
            if (round >= config.maxRounds) {
              progress.update(code, { state: 'failed', reason: `solver ${view.state} at round ${round}: ${detail.slice(0, 120)}` })
              summaryLines.push(`${code}: failed (solver ${view.state} at round ${round})`)
            } else {
              summaryLines.push(`${code}: round ${round} ${view.state}, advancing`)
            }
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
            progress.update(target.unique_code, { containerClosed: false })
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
        const dispatchPolicy = policyFor(config.policy, target.difficulty, seed)

        // 集思开路：hard/insane 从第 1 轮、其余难度从第 2 轮起，先 fanout 征集思路；
        // 思路到手模型即释放；思路拆成虎符工作项并行执行（执行者 ≠ 思路提供者）。
        const fanoutDue = (target.difficulty === 'hard' || target.difficulty === 'insane') || seed >= 2
        let ideas: string[] = []
        if (fanoutDue && jisi !== undefined && config.fanoutModels.length > 0) {
          try {
            const ideaWork = {
              prompt: buildIdeaPrompt({
                challenge: target,
                addrs,
                round: seed,
                found,
                hint,
                previous: lastRoundDetail.get(target.unique_code),
                maxIdeas: config.maxIdeasPerModel,
              }),
            }
            const ideaReports = await jisi.fanout(agent, ideaWork, config.fanoutModels, {
              reasoningEffort: dispatchPolicy.reasoningEffort ?? 'high',
              background: false,
            })
            ideas = parseIdeas(ideaReports.map(r => r.text), config.maxIdeasPerChallenge)
            audit({ type: 'fanout', code: target.unique_code, round: seed, models: config.fanoutModels, ideas: ideas.length })
          } catch (error) {
            audit({ type: 'fanout-error', code: target.unique_code, round: seed, detail: String(error).slice(0, 200) })
            ideas = [] // 集思失败不致命：回落单执行者路径
          }
        }
        if (ideas.length === 0) ideas = ['']
        for (const [index, approach] of ideas.entries()) {
          const label = buildSolverPrompt({
            skill,
            challenge: target,
            addrs,
            round: seed,
            maxRounds: config.maxRounds,
            found,
            hint,
            previous: lastRoundDetail.get(target.unique_code),
            ...(approach !== '' ? { approach } : {}),
          })
          const itemId = ideas.length === 1 && approach === ''
            ? `${target.unique_code}#s${seed}`
            : `${target.unique_code}#s${seed}-i${index + 1}`
          roundLabels.set(`${target.unique_code}#${seed}`, label)
          campaign.add({
            id: itemId,
            label,
            model: dispatchPolicy.model,
            ...(dispatchPolicy.reasoningEffort !== undefined ? { reasoningEffort: dispatchPolicy.reasoningEffort } : {}),
            priority: { tier: tierOf(target.difficulty), score: target.total_score * (config.maxRounds - seed + 1) },
          })
          audit({ type: 'enqueue', code: target.unique_code, round: seed, model: dispatchPolicy.model, effort: dispatchPolicy.reasoningEffort, addrs, approach: approach === '' ? undefined : approach.slice(0, 80) })
        }
        progress.update(target.unique_code, { difficulty: target.difficulty, rounds: seed })
        changed = true
      }

      // 5. 派单（槽位空闲即派；限流重试项优先，避免挤占新轮次）。
      while (campaign.freeSlots() > 0 && campaign.nextQueued().length > 0) {
        const view = await campaign.dispatchNext()
        if (view !== undefined && view !== null && typeof view === 'object' && 'item' in view) {
          audit({ type: 'dispatch', id: (view as { item: { id: string } }).item.id })
        }
      }

      if (changed) persist(snapshotPath, progress)
      // 心跳：循环存活 + 关键计数落审计（无变化时段也不再"监控失明"）。
      const lastHeartbeat = lastHeartbeatAt
      const heartbeatNow = Date.now()
      if (heartbeatNow - lastHeartbeat >= 120_000) {
        lastHeartbeatAt = heartbeatNow
        audit({
          type: 'heartbeat',
          budgetRemainingMs: budget.remainingMs(),
          open: campaign.ledger.views().filter(v => v.state === 'dispatched' || v.state === 'help').length,
          queued: campaign.ledger.views().filter(v => v.state === 'queued').length,
          complete: progress.all().filter(p => p.state === 'complete').length,
          failed: progress.all().filter(p => p.state === 'failed').length,
        })
      }
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

  // 全题终态或预算耗尽 → 立即 finish 停表（排名按 score_elapsed_seconds，先跑完先靠前）。
  const allTerminal = final.every(c => c.is_completed || (progress.get(c.unique_code)?.state === 'failed' || progress.get(c.unique_code)?.state === 'skipped'))
  if (allTerminal || budget.exhausted()) {
    await finishRun(baseURL, args.runBearerToken, args.runId)
  }

  const result = [
    `xiaochang run finished`,
    `score=${score.score}/${score.max} (${score.completed}/${final.length} challenges completed)`,
    `hints=${hintLedger.totalHints()} (deducted ${hintTotal})`,
    `budgetUsedMs=${budget.elapsedMs()}`,
    `challenges=${progress.all().map(p => `${p.code}:${p.state}`).join(', ')}`,
  ].join('\n')
  return result
}

/** 平台前端 API：结束 run 停止计时（需要会话 Bearer token 与 run id）。 */
async function finishRun(baseURL: string, bearerToken: string | undefined, runId: number | undefined): Promise<void> {
  if (bearerToken === undefined || runId === undefined || bearerToken === '') return
  try {
    const res = await fetch(`${baseURL}/api/v1/runs/${runId}/finish`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken}` },
    })
    if (!res.ok) {
      throw new Error(`finish ${res.status}`)
    }
  } catch (error) {
    // 停表失败不致命：平台会在 run 时限到达时自动结束。
    console.error(`xiaochang: finishRun failed: ${String(error)}`)
  }
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
  cancel(itemId: string, reason: string): void
  isComplete(): boolean
  ledger: {
    views(): Array<{ item: { id: string }; state: string; seed: number; terminalDetail?: string; dispatchedAt?: number; lastProgressAt?: number }>
  }
}

/** 集思服务面（思路 fanout；报告原样返回，不做综合）。 */
interface JisiLike {
  fanout(parent: unknown, work: { prompt: string }, models: readonly string[], opts?: {
    reasoningEffort?: string
    background?: boolean
  }): Promise<Array<{ status: string; text: string }>>
}
