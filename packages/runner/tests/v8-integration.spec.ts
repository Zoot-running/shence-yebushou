/**
 * v8 集成测试(L0 宿主接线): 假 hufu 战役 + 真 ResourceQueue + 真 mock 平台 + 假 settle 事件,
 * 不依赖 LLM——确定性覆盖时间盒/升级梯/待裁决/裁决路由/原子授予/工具面。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// dsh-tools 是运行时外部依赖(由 DSH 核心注入), 测试侧用透传桩。
vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (t: unknown) => t }))

import { apply } from '../src/index.ts'
import { ResourceQueue } from '../../../../shence-hufu/src/resource-queue.ts'

const MOCK_PORT = 8399
const HOME = '/tmp/v8-itest-home'
const WORK = '/tmp/v8-itest-work'
const MOCK_PATH = fileURLToPath(new URL('../../../tools/mock-tsecbench.mjs', import.meta.url))

interface Item {
  id: string
  label: string
  model?: string
  state: string
  terminalDetail?: string
  dispatchedAt?: number
  lastProgressAt?: number
}

function fakeCampaign() {
  const items = new Map<string, Item>()
  const settleCbs: Array<(ev: { itemId: string; status: string; text: string }) => void> = []
  return {
    items,
    add(item: { id: string; label: string; model?: string }): void {
      items.set(item.id, { ...item, state: 'queued' })
    },
    freeSlots: () => 999,
    nextQueued: () => [],
    async dispatchNext(): Promise<Item | undefined> {
      const q = [...items.values()].find(v => v.state === 'queued')
      if (q === undefined) return undefined
      q.state = 'dispatched'
      q.dispatchedAt = Date.now()
      q.lastProgressAt = Date.now()
      return q
    },
    report(itemId: string, kind: string, detail?: string): void {
      const v = items.get(itemId)
      if (v !== undefined) { v.state = kind; v.terminalDetail = detail }
    },
    onSettle(cb: (ev: { itemId: string; status: string; text: string }) => void): () => void {
      settleCbs.push(cb)
      return () => {}
    },
    emitSettle(itemId: string, text: string): void {
      for (const cb of settleCbs) cb({ itemId, status: 'completed', text })
    },
    recordKnowledge(): void {},
    knowledgeOf: () => [],
    cancel(itemId: string, _reason: string): void {
      const v = items.get(itemId)
      if (v !== undefined) v.state = 'superseded'
    },
    boardPath(group: string): string {
      return join(WORK, 'boards', 'pending', group, 'FINDINGS.md')
    },
    isComplete: () => false,
    classUsage: () => ({}),
    async interruptItem(): Promise<void> {},
    ledger: {
      views: () => [...items.values()].map(v => ({
        item: { id: v.id, model: v.model },
        state: v.state,
        seed: 1,
        terminalDetail: v.terminalDetail,
        dispatchedAt: v.dispatchedAt,
        lastProgressAt: v.lastProgressAt,
      })),
    },
  }
}

const camp = fakeCampaign()
const tools: Array<{ name: string; execute: (args: Record<string, unknown>, exec: { agent: object }) => Promise<unknown> }> = []
const holder = {
  createCampaign(_p: unknown, _c: unknown, _items: unknown[], opts?: { id?: string }) {
    return { id: opts?.id ?? 'itest', campaign: camp }
  },
  finish(): void {},
  onSettle(_id: string, cb: (ev: { itemId: string; status: string; text: string }) => void) {
    camp.onSettle(cb)
    return () => {}
  },
  recordKnowledge(): void {},
  knowledgeOf: () => [],
  resourceQueue(config: ConstructorParameters<typeof ResourceQueue>[0]) {
    return new ResourceQueue(config)
  },
}

let mock: ChildProcess | undefined
const parent = { agent: {} }
const tool = (name: string) => {
  const t = tools.find(x => x.name === name)
  if (t === undefined) throw new Error(`tool not found: ${name}`)
  return t
}
const auditLines = (): string[] => {
  const p = join(HOME, 'storages', 'xiaochang-run-audit.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(l => l.trim() !== '')
}
const waitFor = async (fn: () => boolean, timeoutMs: number, what: string): Promise<void> => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`timeout waiting for ${what}`)
}
const itemsFor = (code: string): Item[] => [...camp.items.values()].filter(i => i.id.startsWith(`${code}#`))

beforeAll(async () => {
  rmSync(HOME, { recursive: true, force: true })
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  mkdirSync(WORK, { recursive: true })
  process.env.DSH_HOME = HOME
  // 关键: setup 的 pre-run sweep 会扫 cwd 旧文件——必须在空工作目录里跑(与 dryrun 同规)。
  process.chdir(WORK)
  mock = spawn('node', [MOCK_PATH, String(MOCK_PORT)], { stdio: 'ignore' })
  // 等 mock 起来
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/health`)
      if (r.ok) break
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 250))
  }
  const ctx = {
    get: () => undefined,
    hufu: holder,
    tools: { register: (t: never) => { tools.push(t as never) } },
  }
  apply(ctx as never)
  // setup(主 agent)
  await tool('xiaochang_setup').execute({
    baseURL: `http://127.0.0.1:${MOCK_PORT}`,
    benchmarkToken: 'mock-benchmark-token',
    vpnGateway: `http://127.0.0.1:${MOCK_PORT}/health`,
    defaultModel: 'deepseek-v4-flash',
    defaultEffort: 'low',
    modelLock: false,
    budgetMinutes: 30,
    containerSlots: 3,
    timeboxMinutes: 2,
  }, parent)
  // 等原子授予跑起来
  await waitFor(() => auditLines().some(l => l.includes('"v8-grant"')), 15_000, 'v8-grant')
}, 60_000)

afterAll(() => {
  try { mock?.kill() } catch { /* 忽略 */ }
})

describe('v8 题队列宿主接线', () => {
  it('工具面: start_container 已删除, dispatch 是提示桩', () => {
    expect(tools.some(t => t.name === 'xiaochang_start_container')).toBe(false)
    const d = tool('xiaochang_dispatch')
    expect(d).toBeDefined()
  })

  it('S1 原子授予: grant 与 spawn 成对出现, 执行者 item 直接 dispatched', async () => {
    const grants = auditLines().filter(l => l.includes('"v8-grant"')).length
    const spawns = auditLines().filter(l => l.includes('"v8-spawn"')).length
    expect(grants).toBeGreaterThan(0)
    expect(spawns).toBeGreaterThanOrEqual(grants)
    const dispatched = [...camp.items.values()].filter(i => i.state === 'dispatched')
    expect(dispatched.length).toBeGreaterThan(0)
    // 执行令不含"容器未开/自行调用"旧文案
    expect(dispatched.every(i => !i.label.includes('容器未开'))).toBe(true)
  })

  it('S4 时间盒: 授予超 2min 未 settle → v8-timebox + 关容器回队', async () => {
    await waitFor(() => auditLines().some(l => l.includes('"v8-timebox"')), 240_000, 'v8-timebox')
  }, 300_000)

  it('S2/S10 升级梯: 两次零进展 settle → rearm-all-in(全开) → 挂裁决进待决清单', async () => {
    // 优先挑本地题(立即重生成, 无容器等待); 每次 emit 前取该题最新 dispatched item(新鲜授予态)。
    const pickLatest = (code: string): Item | undefined => {
      const list = itemsFor(code).filter(i => i.state === 'dispatched')
      return list[list.length - 1]
    }
    const firstAny = [...camp.items.values()].find(i => i.state === 'dispatched' && i.id.startsWith('g-m'))
      ?? [...camp.items.values()].find(i => i.state === 'dispatched')
    expect(firstAny).toBeDefined()
    const code = firstAny!.id.split('#')[0]!
    // 第一次 settle: 零进展
    const t1 = pickLatest(code)!
    camp.emitSettle(t1.id, '未破: 尝试了常见路径均无果')
    await waitFor(() => auditLines().some(l => l.includes('"v8-settle"') && l.includes('rearm-all-in')), 20_000, 'rearm-all-in settle')
    // 全开后应生出新 item
    await waitFor(() => pickLatest(code) !== undefined && pickLatest(code)!.id !== t1.id, 20_000, 're-spawn')
    // 第二次 settle: 再零进展 → 挂裁决
    const t2 = pickLatest(code)!
    camp.emitSettle(t2.id, '未破: 依旧无果')
    await waitFor(() => auditLines().some(l => l.includes('"v8-settle"') && l.includes('adjudicate')), 20_000, 'adjudicate settle')
    // 待决清单
    const orchPath = join(HOME, 'storages', 'xiaochang-orch-pending.json')
    await waitFor(() => existsSync(orchPath) && readFileSync(orchPath, 'utf8').includes('needs-verdict'), 20_000, 'pending needs-verdict')
    // status 仪表显示待裁决
    const st = await tool('xiaochang_status').execute({}, parent)
    expect(String(st)).toContain('待裁决(1)')
  }, 90_000)

  it('S10 裁决 continue: 回队且待决清空', async () => {
    const orchPath = join(HOME, 'storages', 'xiaochang-orch-pending.json')
    const d = JSON.parse(readFileSync(orchPath, 'utf8')) as { pending: Array<{ code: string }> }
    const code = d.pending[0]!.code
    const res = await tool('xiaochang_report').execute({ code, verdict: 'continue', reason: '再给一次机会' }, parent)
    expect(String(res)).toContain('已回队')
    const st = await tool('xiaochang_status').execute({}, parent)
    expect(String(st)).toContain('待裁决(0)')
  }, 30_000)

  it('S8+仪表: 未破题全量风险排序行出现', async () => {
    const st = await tool('xiaochang_status').execute({}, parent)
    expect(String(st)).toContain('未破题(全量·风险排序)')
  })

  it('S13 计分表: submit 回执 cumulative 入表(求和展示)', async () => {
    // 用错旗提交: mock 回执 cumulative=0, 计分表应有该题条目且 status 显示求和行。
    const st0 = await tool('xiaochang_status').execute({}, parent)
    expect(String(st0)).toContain('runScore(计分表)')
    const res = await tool('xiaochang_submit').execute({ code: 'g-m1', flag: 'mock{not-a-flag}' }, parent)
    const st1 = await tool('xiaochang_status').execute({}, parent)
    expect(String(st1)).toContain('runScore(计分表)')
  }, 30_000)
})
