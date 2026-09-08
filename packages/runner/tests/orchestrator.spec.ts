/**
 * 校场 v2 编排核心 L0：clean-room 门禁、工作项 id 解析、OBSERVATIONS 解析、
 * 进度账（快照/容错恢复）。
 * v2 调度权在主 agent——本文件只测纯机制。
 */
import { describe, expect, it } from 'vitest'
import {
  RunProgress,
  baseId,
  cleanRoomGate,
  codeOf,
  parseObservations,
  resolveExecutor,
  roundOf,
} from '../src/orchestrator.ts'

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

describe('codeOf / roundOf / baseId', () => {
  it('parses v2 item ids', () => {
    expect(codeOf('g-39#s3-w2')).toBe('g-39')
    expect(roundOf('g-39#s3-w2')).toBe(3)
    expect(baseId('g-39#s3-w2')).toBe('g-39#s3-w2')
    expect(baseId('g-39#s3-w2-r3')).toBe('g-39#s3-w2')
    expect(codeOf('g-12#s1')).toBe('g-12')
    expect(roundOf('g-12#s1')).toBe(1)
  })
  it('falls back safely for malformed ids', () => {
    expect(codeOf('odd-id')).toBe('odd-id')
    expect(roundOf('odd-id')).toBe(1)
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

describe('resolveExecutor', () => {
  const policy = { defaultModel: 'deepseek-v4-flash', defaultEffort: 'low', locked: false }

  it('unlocked: per-item override wins, default fills the gap', () => {
    expect(resolveExecutor({ model: 'kimi-k3', effort: 'max' }, policy)).toEqual({
      model: 'kimi-k3', effort: 'max', overriddenByLock: false,
    })
    expect(resolveExecutor({}, policy)).toEqual({
      model: 'deepseek-v4-flash', effort: 'low', overriddenByLock: false,
    })
  })
  it('locked: everything is forced to the default and overrides are flagged', () => {
    const locked = { ...policy, locked: true }
    expect(resolveExecutor({ model: 'kimi-k3' }, locked)).toEqual({
      model: 'deepseek-v4-flash', effort: 'low', overriddenByLock: true,
    })
    expect(resolveExecutor({}, locked)).toEqual({
      model: 'deepseek-v4-flash', effort: 'low', overriddenByLock: false,
    })
  })
})

describe('sweepLegacyWorkdir', () => {
  it('archives pre-run artifacts, keeps tooling and run scripts', () => {
    const { mkdtempSync, writeFileSync, utimesSync, readdirSync, existsSync } = require('node:fs') as typeof import('node:fs')
    const { tmpdir } = require('node:os') as typeof import('node:os')
    const { join } = require('node:path') as typeof import('node:path')
    const { sweepLegacyWorkdir } = require('../src/orchestrator.ts') as typeof import('../src/orchestrator.ts')
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'))
    const old = new Date('2026-09-07T00:00:00Z')
    const fresh = new Date('2026-09-08T02:00:00Z')
    const startedAt = Date.parse('2026-09-08T01:47:00Z')
    const touch = (p: string, t: Date): void => { writeFileSync(p, 'x'); utimesSync(p, t, t) }
    // 旧题号工件 → 归档
    const gdir = join(dir, 'g-02')
    require('node:fs').mkdirSync(gdir)
    touch(join(gdir, 'solve.py'), old)
    utimesSync(gdir, old, old)
    // 旧战报 → 归档（boards 整个目录）
    const bdir = join(dir, 'boards', 'g-03')
    require('node:fs').mkdirSync(bdir, { recursive: true })
    touch(join(bdir, 'FINDINGS.md'), old)
    utimesSync(join(dir, 'boards'), old, old)
    utimesSync(bdir, old, old)
    // 工具链/启动脚本/新工件 → 保留
    require('node:fs').mkdirSync(join(dir, '.venv'))
    touch(join(dir, '.venv', 'python'), old)
    touch(join(dir, 'run7-launch.sh'), old)
    require('node:fs').mkdirSync(join(dir, 'g-04'))
    touch(join(dir, 'g-04', 'work'), fresh)
    const moved = sweepLegacyWorkdir(dir, startedAt, '.archive/test')
    expect(moved).toBe(2) // g-02 目录 + boards 目录
    expect(existsSync(join(dir, '.archive', 'test', 'g-02', 'solve.py'))).toBe(true)
    expect(existsSync(join(dir, '.archive', 'test', 'boards', 'g-03', 'FINDINGS.md'))).toBe(true)
    expect(existsSync(join(dir, '.venv'))).toBe(true)
    expect(existsSync(join(dir, 'run7-launch.sh'))).toBe(true)
    expect(existsSync(join(dir, 'g-04'))).toBe(true)
    expect(readdirSync(dir)).toContain('.archive')
  })
})
