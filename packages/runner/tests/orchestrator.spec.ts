/**
 * 校场 L4 编排核心 L0：选题排序、flag 提取、clean-room 门禁、prompt 组装、
 * 预算、进度账（快照/恢复）、模型调度策略（模型 + 思考强度）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChallengeInfo } from '../../src/adapters/tsecbench.ts'
import {
  RunBudget,
  RunProgress,
  baseId,
  buildIdeaPrompt,
  buildSolverPrompt,
  cleanRoomGate,
  codeOf,
  extractFlags,
  parseIdeas,
  parseObservations,
  policyFor,
  rotateModel,
  roundOf,
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

describe('codeOf / roundOf', () => {
  it('parses round items and rate-retry items', () => {
    expect(codeOf('g-39#s3')).toBe('g-39')
    expect(roundOf('g-39#s3')).toBe(3)
    expect(codeOf('g-39#3-r1')).toBe('g-39')
    expect(roundOf('g-39#3-r1')).toBe(3)
    expect(codeOf('g-12#s1')).toBe('g-12')
    expect(roundOf('g-12#s1')).toBe(1)
  })
  it('falls back safely for malformed ids', () => {
    expect(codeOf('odd-id')).toBe('odd-id')
    expect(roundOf('odd-id')).toBe(1)
  })
  it('baseId strips retry suffixes and keeps the idea index', () => {
    expect(baseId('g-18#s1-i2')).toBe('g-18#s1-i2')
    expect(baseId('g-18#s1-i2-r3')).toBe('g-18#s1-i2')
    expect(baseId('g-18#s1')).toBe('g-18#s1')
  })
  it('rotateModel cycles through the executor rotation', () => {
    const models = ['kimi-k3', 'deepseek-v4-flash', 'deepseek-v4-pro']
    expect(rotateModel(models, 0)).toBe('kimi-k3')
    expect(rotateModel(models, 3)).toBe('kimi-k3')
    expect(rotateModel(models, 5)).toBe('deepseek-v4-pro')
  })
})

describe('buildIdeaPrompt / parseIdeas', () => {
  it('asks only for ideas with the IDEA n format convention', () => {
    const prompt = buildIdeaPrompt({
      challenge: CH('x', { description: 'break me' }),
      addrs: ['10.0.0.1:80'],
      round: 1,
      found: [],
      maxIdeas: 3,
    })
    expect(prompt).toContain('只出思路')
    expect(prompt).toContain('IDEA n:')
    expect(prompt).toContain('break me')
    expect(prompt).toContain('最多 3 条')
  })
  it('parses multiple ideas from raw fanout reports, dedupes and caps', () => {
    const ideas = parseIdeas([
      'IDEA 1: 先扫端口 — 看 banner — 按 CVE 打\nIDEA 2: 试默认凭据\nIDEA 3: 看源码附件',
      'IDEA 1: 先扫端口 — 看 banner — 按 CVE 打\nIDEA 2: 从加密附件入手',
    ], 4)
    expect(ideas).toHaveLength(4)
    expect(ideas[0]).toContain('先扫端口')
    expect(ideas[1]).toContain('默认凭据')
    expect(ideas[2]).toContain('源码附件')
    expect(ideas[3]).toContain('加密附件')
    // cap 生效：只取前 3 条
    const capped = parseIdeas([
      'IDEA 1: a\nIDEA 2: b\nIDEA 3: c\nIDEA 4: d',
    ], 3)
    expect(capped).toHaveLength(3)
  })
  it('ignores empty/none ideas', () => {
    expect(parseIdeas(['IDEA 0: none', 'IDEA 1:   '], 5)).toEqual([])
  })
  it('executor prompt carries the assigned approach section', () => {
    const prompt = buildSolverPrompt({
      skill: 'M',
      challenge: CH('x'),
      addrs: [],
      round: 1,
      maxRounds: 3,
      found: [],
      approach: '先试 SQL 注入',
    })
    expect(prompt).toContain('本条要执行的思路')
    expect(prompt).toContain('先试 SQL 注入')
  })
  it('executor prompt carries the shared board and org profile sections', () => {
    const prompt = buildSolverPrompt({
      skill: 'M',
      challenge: CH('x'),
      addrs: [],
      round: 1,
      maxRounds: 3,
      found: [],
      boardPath: '/work/x/FINDINGS.md',
      profile: '# 画像\ntech',
    })
    expect(prompt).toContain('同题共享战报')
    expect(prompt).toContain('/work/x/FINDINGS.md')
    expect(prompt).toContain('题集组织画像')
    expect(prompt).toContain('tech')
  })
})

describe('parseObservations', () => {
  it('extracts generic observation lines and drops flag values', () => {
    const text = 'done.\nOBSERVATIONS:\n- 容器多为 python 服务\n- 常见路径 /challenge/flag.txt\n- flag{secret_value}'
    expect(parseObservations(text)).toEqual(['容器多为 python 服务', '常见路径 /challenge/flag.txt'])
  })
  it('returns [] without the section', () => {
    expect(parseObservations('nothing here')).toEqual([])
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
    model: 'kimi-k3',
    modelMedium: 'deepseek-v4-flash',
    modelHard: 'glm-5.3',
    effort: 'high',
    effortMedium: 'low',
    effortHard: 'max',
    effortRetry: 'max',
  }

  it('easy round 1 → default model and effort', () => {
    expect(policyFor(policy, 'easy', 1)).toEqual({ model: 'kimi-k3', reasoningEffort: 'high' })
  })
  it('medium round 1 → medium model and effort', () => {
    expect(policyFor(policy, 'medium', 1)).toEqual({ model: 'deepseek-v4-flash', reasoningEffort: 'low' })
  })
  it('hard/insane round 1 → hard model and effort', () => {
    expect(policyFor(policy, 'hard', 1)).toEqual({ model: 'glm-5.3', reasoningEffort: 'max' })
    expect(policyFor(policy, 'insane', 1)).toEqual({ model: 'glm-5.3', reasoningEffort: 'max' })
  })
  it('round 2+ escalates effort (retry) on the same model', () => {
    expect(policyFor(policy, 'easy', 2)).toEqual({ model: 'kimi-k3', reasoningEffort: 'max' })
    expect(policyFor(policy, 'medium', 2)).toEqual({ model: 'deepseek-v4-flash', reasoningEffort: 'max' })
    expect(policyFor(policy, 'hard', 3)).toEqual({ model: 'glm-5.3', reasoningEffort: 'max' })
  })
  it('medium falls back to the default model when modelMedium is absent', () => {
    const simple = { model: 'kimi-k3', modelHard: 'glm-5.3', effort: 'high' }
    expect(policyFor(simple, 'medium', 1)).toEqual({ model: 'kimi-k3', reasoningEffort: 'high' })
  })
  it('drops effort entirely when policy defines none', () => {
    expect(policyFor({ model: 'kimi-k3', modelHard: 'glm-5.3' }, 'easy', 1)).toEqual({ model: 'kimi-k3' })
  })
})
