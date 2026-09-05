/**
 * 校场 L4 编排核心 L0：选题排序、flag 提取、clean-room 门禁、prompt 组装、
 * 预算、进度账（快照/恢复）、模型调度策略（模型 + 思考强度）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChallengeInfo } from '../../src/adapters/tsecbench.ts'
import {
  RunBudget,
  RunProgress,
  buildSolverPrompt,
  cleanRoomGate,
  extractFlags,
  policyFor,
  selectTargets,
} from '../src/orchestrator.ts'

const CH = (code: string, overrides: Partial<ChallengeInfo> = {}): ChallengeInfo => ({
  unique_code: code,
  difficulty: 'easy',
  total_score: 100,
  flag_count: 1,
  correct_flag_count: 0,
  is_completed: false,
  container_status: 'stopped',
  container_addr: [],
  description: 'desc',
  ...overrides,
})

describe('selectTargets', () => {
  it('filters completed and excluded, sorts by difficulty then score', () => {
    const list = [
      CH('a', { difficulty: 'hard', total_score: 500 }),
      CH('b', { difficulty: 'easy', total_score: 300 }),
      CH('c', { difficulty: 'easy', total_score: 100 }),
      CH('d', { difficulty: 'medium', total_score: 200 }),
      CH('done', { is_completed: true }),
    ]
    const picked = selectTargets(list, new Set(['d']))
    expect(picked.map(c => c.unique_code)).toEqual(['c', 'b', 'a'])
  })
  it('orders unknown difficulty last with stable code tiebreak', () => {
    const list = [CH('z', { difficulty: 'mystery' }), CH('a', { difficulty: 'easy' })]
    expect(selectTargets(list).map(c => c.unique_code)).toEqual(['a', 'z'])
  })
})

describe('extractFlags', () => {
  it('extracts and dedupes common CTF flag formats case-insensitively', () => {
    const text = 'got flag{abc_123} and Flag{abc_123} and HTB{xyz9} plus SEKAI{qqq_1}'
    expect(extractFlags(text)).toEqual(['flag{abc_123}', 'HTB{xyz9}', 'SEKAI{qqq_1}'])
  })
  it('ignores placeholder-looking short bodies', () => {
    expect(extractFlags('flag{...} and flag{ab}')).toEqual([])
  })
  it('returns [] for text without flags', () => {
    expect(extractFlags('nothing here')).toEqual([])
  })
})

describe('cleanRoomGate', () => {
  it('flags files that mention the challenge code', () => {
    const verdict = cleanRoomGate('web_sql_01', [
      { file: 'a.md', text: 'generic notes' },
      { file: 'b.md', text: 'web_sql_01 solution: use sqli' },
    ])
    expect(verdict.contaminated).toBe(true)
    expect(verdict.hits).toEqual(['b.md'])
  })
  it('is clean when no file mentions the code', () => {
    expect(cleanRoomGate('crypto_rsa_02', [{ file: 'a.md', text: 'other stuff' }]).contaminated).toBe(false)
  })
})

describe('buildSolverPrompt', () => {
  it('includes target, constraint and discipline sections; hint only when provided', () => {
    const prompt = buildSolverPrompt({
      skill: 'METHOD',
      challenge: CH('x', { description: 'attack me', flag_count: 2 }),
      addrs: ['10.0.0.1:8080'],
      round: 2,
      maxRounds: 3,
      found: ['flag{one}'],
    })
    expect(prompt).toContain('x')
    expect(prompt).toContain('attack me')
    expect(prompt).toContain('10.0.0.1:8080')
    expect(prompt).toContain('第 2/3 轮')
    expect(prompt).toContain('flag{one}')
    expect(prompt).toContain('METHOD')
    expect(prompt).not.toContain('官方提示')
  })
  it('includes the official hint section when provided', () => {
    const prompt = buildSolverPrompt({
      skill: 'M',
      challenge: CH('x'),
      addrs: [],
      round: 2,
      maxRounds: 3,
      found: [],
      hint: 'try admin/admin',
    })
    expect(prompt).toContain('官方提示')
    expect(prompt).toContain('try admin/admin')
  })
  it('carries the previous round work log forward', () => {
    const prompt = buildSolverPrompt({
      skill: 'M',
      challenge: CH('x'),
      addrs: [],
      round: 2,
      maxRounds: 3,
      found: [],
      previous: 'found a velocity SSTI',
    })
    expect(prompt).toContain('上一轮工作记录')
    expect(prompt).toContain('found a velocity SSTI')
    expect(prompt).toContain('不要重复侦察')
  })
})

describe('RunBudget', () => {
  it('tracks elapsed/remaining and exhaustion', () => {
    let now = 1000
    const budget = new RunBudget(5000, () => now)
    expect(budget.exhausted()).toBe(false)
    now = 5500
    expect(budget.elapsedMs()).toBe(4500)
    expect(budget.remainingMs()).toBe(500)
    now = 6001
    expect(budget.exhausted()).toBe(true)
  })
})

describe('RunProgress', () => {
  it('updates, serializes and restores', () => {
    const progress = new RunProgress()
    progress.update('a', { difficulty: 'easy', rounds: 1, flags: ['flag{1}'] })
    progress.update('a', { state: 'complete', flags: ['flag{1}', 'flag{2}'] })
    const restored = RunProgress.restore([progress.line()])
    expect(restored.get('a')?.state).toBe('complete')
    expect(restored.get('a')?.flags).toEqual(['flag{1}', 'flag{2}'])
    expect(restored.completedCodes()).toEqual(['a'])
  })
  it('restore tolerates corrupt trailing lines', () => {
    const progress = new RunProgress()
    progress.update('a', { state: 'complete' })
    const restored = RunProgress.restore([progress.line(), '{corrupt'])
    expect(restored.get('a')?.state).toBe('complete')
  })
})

describe('policyFor', () => {
  const policy = {
    model: 'kimi-k2.6',
    modelHard: 'glm-4.6',
    effort: 'high',
    effortHard: 'max',
    effortRetry: 'max',
  }

  it('easy/medium round 1 → default model and effort', () => {
    expect(policyFor(policy, 'easy', 1)).toEqual({ model: 'kimi-k2.6', reasoningEffort: 'high' })
    expect(policyFor(policy, 'medium', 1)).toEqual({ model: 'kimi-k2.6', reasoningEffort: 'high' })
  })
  it('hard/insane round 1 → hard model and effort', () => {
    expect(policyFor(policy, 'hard', 1)).toEqual({ model: 'glm-4.6', reasoningEffort: 'max' })
    expect(policyFor(policy, 'insane', 1)).toEqual({ model: 'glm-4.6', reasoningEffort: 'max' })
  })
  it('round 2+ escalates effort (retry) on the same model', () => {
    expect(policyFor(policy, 'easy', 2)).toEqual({ model: 'kimi-k2.6', reasoningEffort: 'max' })
    expect(policyFor(policy, 'hard', 3)).toEqual({ model: 'glm-4.6', reasoningEffort: 'max' })
  })
  it('drops effort entirely when policy defines none', () => {
    expect(policyFor({ model: 'kimi-k2.6', modelHard: 'glm-4.6' }, 'easy', 1)).toEqual({ model: 'kimi-k2.6' })
  })
})
