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
