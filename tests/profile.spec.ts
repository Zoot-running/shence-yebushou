/**
 * 夜不收组织画像 L0 测试：创建/追加去重/置信度升级/渲染解析往返。
 */
import { describe, expect, it } from 'vitest'
import { addFact, createProfile, parse, render } from '../src/profile.ts'

describe('OrgProfile', () => {
  it('creates an empty profile', () => {
    const p = createProfile('acme', 123)
    expect(p.org).toBe('acme')
    expect(p.facts).toEqual([])
    expect(p.observedAt).toBe(123)
  })
  it('adds facts with default confidence', () => {
    const p = createProfile('acme')
    addFact(p, { kind: 'tech-stack', note: 'Flask + gunicorn' })
    expect(p.facts).toHaveLength(1)
    expect(p.facts[0]!.confidence).toBe('likely')
  })
  it('dedupes same kind+note and upgrades confidence', () => {
    const p = createProfile('acme')
    addFact(p, { kind: 'default-creds', note: 'admin/admin123' })
    addFact(p, { kind: 'default-creds', note: 'admin/admin123', confidence: 'confirmed' })
    expect(p.facts).toHaveLength(1)
    expect(p.facts[0]!.confidence).toBe('confirmed')
  })
  it('keeps distinct notes', () => {
    const p = createProfile('acme')
    addFact(p, { kind: 'default-creds', note: 'admin/admin123' })
    addFact(p, { kind: 'default-creds', note: 'root/toor' })
    expect(p.facts).toHaveLength(2)
  })
  it('renders and parses roundtrip', () => {
    const p = createProfile('acme', 1700000000000)
    addFact(p, { kind: 'tech-stack', note: 'Flask + gunicorn' })
    addFact(p, { kind: 'default-creds', note: 'admin/admin123', confidence: 'confirmed' })
    addFact(p, { kind: 'port-pattern', note: 'web 在 8080，管理口在 8443' })
    const md = render(p)
    const q = parse(md)
    expect(q.org).toBe('acme')
    expect(q.facts).toHaveLength(3)
    expect(q.facts.find(f => f.kind === 'default-creds')!.confidence).toBe('confirmed')
    expect(q.facts.find(f => f.kind === 'port-pattern')!.note).toBe('web 在 8080，管理口在 8443')
  })
  it('parses a foreign markdown without frontmatter into empty profile', () => {
    const q = parse('# 随便什么\n- 不是画像\n')
    expect(q.org).toBe('')
    expect(q.facts).toHaveLength(0)
  })
})
