/**
 * L0: 攻击面覆盖(夜不收通用领域知识, 从集思迁出)。
 */
import { describe, expect, it } from 'vitest'
import { coverageOf } from '../src/attack-surfaces.ts'

describe('攻击面覆盖(L3 分母)', () => {
  it('web 死路关键词归入对应面', () => {
    const cov = coverageOf('web', ['SQL 注入 union select 被 WAF 拦截(死路)', 'lfi 目录穿越失败'])
    expect(cov.covered).toBeGreaterThanOrEqual(2)
    expect(cov.uncovered.length).toBeLessThan(cov.total)
  })
  it('全量覆盖 → 饱和', () => {
    const first = coverageOf('web', [])
    const cov2 = coverageOf('web', first.uncovered.map(u => u))
    expect(cov2.ratio).toBe(1)
  })
  it('未知题型回落 misc 不抛错', () => {
    const cov = coverageOf('misc', ['任意文本'])
    expect(cov.total).toBeGreaterThan(0)
  })
})
