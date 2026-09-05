/**
 * 校场 L0 测试：tsecbench 适配器（mock fetch）、hint 账本、治理扫描。
 */
import { describe, expect, it } from 'vitest'
import { TsecbenchAdapter } from '../src/adapters/tsecbench.ts'
import type { FetchLike } from '../src/adapters/tsecbench.ts'
import { HintLedger } from '../src/hint-ledger.ts'
import { scanFiles, scanText } from '../src/governance.ts'

function mockFetch(handler: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => unknown): FetchLike {
  return async (url, init) => {
    const value = handler(url, init)
    return {
      ok: true,
      status: 200,
      json: async () => value,
    }
  }
}

const SAMPLE_CHALLENGES = [
  {
    unique_code: 'a-01', difficulty: 'easy', total_score: 300, flag_count: 1,
    correct_flag_count: 1, is_completed: true, container_status: 'stopped', container_addr: [], description: 'x',
  },
  {
    unique_code: 'a-02', difficulty: 'hard', total_score: 500, flag_count: 1,
    correct_flag_count: 0, is_completed: false, container_status: 'stopped', container_addr: [], description: 'y',
  },
]

describe('TsecbenchAdapter', () => {
  it('listChallenges + scoreOf 完成口径', async () => {
    const calls: string[] = []
    const adapter = new TsecbenchAdapter(
      { baseURL: 'https://t.example', benchmarkToken: 'bt-1', vpnGateway: 'http://10.0.100.58' },
      mockFetch((url) => { calls.push(url); return SAMPLE_CHALLENGES }),
    )
    const challenges = await adapter.listChallenges()
    expect(challenges).toHaveLength(2)
    expect(adapter.scoreOf(challenges)).toEqual({ completed: 1, score: 300, max: 800 })
    expect(calls[0]).toContain('/openapi/v1/challenges')
  })
  it('submit sends flag with token header', async () => {
    let captured: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } } | undefined
    const adapter = new TsecbenchAdapter(
      { baseURL: 'https://t.example', benchmarkToken: 'bt-1', vpnGateway: 'http://g' },
      mockFetch((url, init) => { captured = { url, init }; return { correct: true, awarded: 300, cumulative_score: 300, correct_flag_count: 1, total_flag_count: 1, matched_flag_index: 0 } }),
    )
    const result = await adapter.submit('a-01', 'flag{test}')
    expect(result.correct).toBe(true)
    expect(captured!.init!.headers!['BENCHMARK_TOKEN']).toBe('bt-1')
    expect(JSON.parse(captured!.init!.body!)).toEqual({ unique_code: 'a-01', flag: 'flag{test}' })
  })
  it('start/close use query params', async () => {
    const urls: string[] = []
    const adapter = new TsecbenchAdapter(
      { baseURL: 'https://t.example', benchmarkToken: 'bt-1', vpnGateway: 'http://g' },
      mockFetch((url) => { urls.push(url); return url.includes('start') ? { container_addr: ['10.0.0.2:80'] } : {} }),
    )
    const started = await adapter.start('a-01')
    await adapter.close('a-01')
    expect(started.container_addr).toEqual(['10.0.0.2:80'])
    expect(urls[0]).toContain('unique_code=a-01')
    expect(urls[1]).toContain('unique_code=a-01')
  })
  it('gatewayHealthy checks status ok', async () => {
    const ok = new TsecbenchAdapter({ baseURL: 'b', benchmarkToken: 't', vpnGateway: 'http://g' },
      mockFetch(() => ({ status: 'ok' })))
    expect(await ok.gatewayHealthy()).toBe(true)
    const bad = new TsecbenchAdapter({ baseURL: 'b', benchmarkToken: 't', vpnGateway: 'http://g' },
      mockFetch(() => ({ status: 'down' })))
    expect(await bad.gatewayHealthy()).toBe(false)
  })
})

describe('HintLedger', () => {
  it('records 10% per hint with ceil-to-1 and reasons', () => {
    const ledger = new HintLedger()
    expect(ledger.record('a-01', 300, 'blind sql stuck')).toBe(30)
    expect(ledger.record('a-01', 300, 'second look')).toBe(30)
    expect(ledger.record('a-02', 100, 'x')).toBe(10)
    expect(ledger.get('a-01')).toMatchObject({ hints: 2, deducted: 60 })
    expect(ledger.totalDeducted()).toBe(70)
    expect(ledger.totalHints()).toBe(3)
  })
  it('restores from dump', () => {
    const ledger = new HintLedger()
    ledger.record('a-01', 300, 'r')
    const restored = HintLedger.restore(ledger.dump())
    expect(restored.get('a-01')).toMatchObject({ hints: 1, deducted: 30 })
  })
})

describe('Governance scan', () => {
  it('detects flag values and api keys', () => {
    const result = scanFiles([
      { file: 'a.md', text: '答案是 flag{real-flag-value-123456}' },
      { file: 'b.md', text: 'KIMI_API_KEY=sk-abcdefghijklmnopqrstuvwx' },
    ])
    expect(result.clean).toBe(false)
    expect(result.violations.map(v => v.rule)).toEqual(expect.arrayContaining(['flag-value', 'api-key']))
  })
  it('ignores placeholder flag{...} and clean text', () => {
    const result = scanFiles([
      { file: 'c.md', text: '占位 flag 纪律：仓库里的 flag{...} 是占位值' },
      { file: 'd.md', text: '通用方法论，无敏感内容' },
    ])
    expect(result.clean).toBe(true)
  })
  it('detects known leaked credentials', () => {
    expect(scanText('x.md', '默认凭据 sysadmin/Weaver@2001 可登录').length).toBeGreaterThan(0)
  })
})
