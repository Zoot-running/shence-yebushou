/**
 * 校场 v8 题队列编排内核测试：settle 分类、升级梯、裁决出边、时间盒、
 * blocker 验证兵、优先级提权、风险排序、序列化。
 */
import { describe, expect, it } from 'vitest'
import {
  SUBMIT_GRACE_MS,
  clusterMapOf,
  flagLine,
  foldFlags,
  parseFlagLines,
  pendingFlagsOf,
  TIMEBOX_MS,
  adjudicate,
  applySettle,
  applyVerifierResult,
  blockerConcluded,
  compareRisk,
  fingerprintOf,
  grant,
  makePending,
  neverDispatchedBoost,
  newOrch,
  parseOrchState,
  priorityOf,
  rearmByTimebox,
  serializeOrchState,
  settleAction,
  timeboxExpired,
  verifierVerdict,
  zeroProgress,
  type ChallengeOrch,
  type SettleProgress,
} from '../src/challenge-orch.ts'

const T0 = 1_800_000_000_000
const prog = (over: Partial<SettleProgress> = {}): SettleProgress => ({
  flagCandidate: false,
  findingsDelta: 0,
  forkDelta: 0,
  artifactsDelta: 0,
  blockerConcluded: false,
  detail: '未破',
  ...over,
})

describe('settleAction 升级梯', () => {
  it('有进展(新 fork) → rearm 不加路', () => {
    const o = newOrch('a-01', T0)
    grant(o, { at: T0, findingsLines: 0, forkCount: 0, artifactCount: 0 }, T0)
    expect(settleAction(o, prog({ forkDelta: 2 }))).toBe('rearm')
    applySettle(o, 'rearm', '未破 有新分叉', T0 + 1000)
    expect(o.state).toBe('queued')
    expect(o.zeroProgressStreak).toBe(0)
  })

  it('战报行数不算进展(v8.3): 只写战报 → 零进展 → rearm-all-in', () => {
    const o = newOrch('a-02', T0)
    expect(settleAction(o, prog({ findingsDelta: 5 }))).toBe('rearm-all-in')
  })

  it('有进展×2(新fork连击) → rearm-all-in 升级', () => {
    const o = newOrch('a-02b', T0)
    o.progressStreak = 1
    expect(settleAction(o, prog({ forkDelta: 1 }))).toBe('rearm-all-in')
    applySettle(o, 'rearm-all-in', '有进展但未出旗×2', T0 + 1000)
    expect(o.progressStreak).toBe(0)
  })

  it('有进展(新工件) → rearm', () => {
    const o = newOrch('a-03', T0)
    expect(settleAction(o, prog({ artifactsDelta: 3 }))).toBe('rearm')
  })

  it('零进展×1 → rearm-all-in 且 R2 标记 + 3 路生成', () => {
    const o = newOrch('a-04', T0)
    grant(o, { at: T0, findingsLines: 2, forkCount: 0, artifactCount: 0 }, T0)
    expect(settleAction(o, prog({ detail: '未破' }))).toBe('rearm-all-in')
    applySettle(o, 'rearm-all-in', '未破', T0 + 1000)
    expect(o.state).toBe('queued')
    expect(o.zeroProgressStreak).toBe(1)
    expect(o.r2Due).toBe(true)
    expect(o.multiSpawn).toBe(3)
  })

  it('零进展×2 → adjudicate(离开自动轮转)', () => {
    const o = newOrch('a-05', T0)
    o.zeroProgressStreak = 1
    expect(settleAction(o, prog())).toBe('adjudicate')
    applySettle(o, 'adjudicate', '未破', T0 + 1000)
    expect(o.state).toBe('pending-adjudication')
  })

  it('FLAG_CANDIDATE → pending-flag(不自动回队, 提交宽限)', () => {
    const o = newOrch('a-06', T0)
    grant(o, { at: T0, findingsLines: 0, forkCount: 0, artifactCount: 0 }, T0)
    const p = prog({ flagCandidate: true, detail: 'FLAG_CANDIDATE: flag{x}' })
    expect(settleAction(o, p)).toBe('pending-flag')
    applySettle(o, 'pending-flag', p.detail, T0 + 1000)
    expect(o.state).toBe('pending-adjudication')
    expect(o.zeroProgressStreak).toBe(0)
    expect(o.grantedUntil).toBe(T0 + 1000 + SUBMIT_GRACE_MS)
    // 宽限后时间盒照常切(旗值随容器轮换, 主 agent 应尽快提交)
    expect(timeboxExpired(o, T0 + 1000 + SUBMIT_GRACE_MS + 1)).toBe(true)
  })

  it('有进展会重置零进展连击', () => {
    const o = newOrch('a-07', T0)
    o.zeroProgressStreak = 1
    applySettle(o, 'rearm', '有发现', T0 + 1000)
    expect(o.zeroProgressStreak).toBe(0)
  })
})

describe('blocker 检测与验证兵', () => {
  it('识别 blocker 结论措辞', () => {
    expect(blockerConcluded('未破 — 攻击面缺失（平台端口暴露不含 Dify 后端 API）')).toBe(true)
    expect(blockerConcluded('环境缺失: 服务未启动')).toBe(true)
    expect(blockerConcluded('not exposed / unreachable')).toBe(true)
    expect(blockerConcluded('执行者超时, 未解出')).toBe(false)
    expect(blockerConcluded('SQL 注入被过滤')).toBe(false)
  })

  it('blocker×1 → verify-blocker(派验证兵)', () => {
    const o = newOrch('c-03', T0)
    const p = prog({ blockerConcluded: true, detail: '未破 — 攻击面缺失' })
    expect(settleAction(o, p)).toBe('verify-blocker')
    applySettle(o, 'verify-blocker', p.detail, T0 + 1000)
    expect(o.state).toBe('queued')
    expect(o.blockerCheck).toBe('in-flight')
  })

  it('验证兵确认 → adjudicate; 推翻 → 落回普通规则', () => {
    const o = newOrch('c-03', T0)
    o.blockerCheck = 'in-flight'
    applyVerifierResult(o, verifierVerdict('复验: blocker 成立, 确认无攻击面'))
    expect(o.blockerCheck).toBe('confirmed')
    expect(settleAction(o, prog({ blockerConcluded: true, detail: '确认' }))).toBe('adjudicate')

    const o2 = newOrch('c-06', T0)
    o2.blockerCheck = 'in-flight'
    applyVerifierResult(o2, verifierVerdict('推翻: 攻击面存在, RSC 端点可用'))
    expect(o2.blockerCheck).toBe('refuted')
    // 推翻后有新发现 → 普通 rearm
    expect(settleAction(o2, prog({ blockerConcluded: true, forkDelta: 1, detail: '推翻' }))).toBe('rearm')
  })

  it('verifierVerdict 解析: confirm/refute/unclear', () => {
    expect(verifierVerdict('复验完成: 确认 blocker 成立')).toBe('confirm')
    expect(verifierVerdict('推翻: 不成立, 有攻击面')).toBe('refute')
    expect(verifierVerdict('没有结论')).toBe('unclear')
    expect(verifierVerdict('确认过但又被推翻')).toBe('unclear')
  })
})

describe('裁决出边', () => {
  it('continue → 重新入队且梯清零', () => {
    const o = newOrch('b-02', T0)
    o.state = 'pending-adjudication'
    o.zeroProgressStreak = 2
    adjudicate(o, 'continue')
    expect(o.state).toBe('queued')
    expect(o.zeroProgressStreak).toBe(0)
    expect(o.grantedUntil).toBeUndefined()
  })

  it('rotate → 同 continue(关容器由宿主做)', () => {
    const o = newOrch('b-02', T0)
    o.state = 'pending-adjudication'
    adjudicate(o, 'rotate')
    expect(o.state).toBe('queued')
  })

  it('dead → 终态出队', () => {
    const o = newOrch('b-02', T0)
    adjudicate(o, 'dead')
    expect(o.state).toBe('dead')
  })

  it('solved → 终态', () => {
    const o = newOrch('b-02', T0)
    adjudicate(o, 'solved')
    expect(o.state).toBe('solved')
  })

  it('continue 清掉 blocker 已确认标记与指纹', () => {
    const o = newOrch('c-03', T0)
    o.blockerCheck = 'confirmed'
    o.lastSettleFingerprint = '攻击面缺失'
    adjudicate(o, 'continue')
    expect(o.blockerCheck).toBe('none')
    expect(o.lastSettleFingerprint).toBeUndefined()
  })
})

describe('授予/时间盒', () => {
  it('grant 落地: attempts+1, 时间盒, neverDispatched=false', () => {
    const o = newOrch('d-01', T0)
    grant(o, { at: T0, findingsLines: 0, forkCount: 0, artifactCount: 0 }, T0)
    expect(o.state).toBe('granted')
    expect(o.attempts).toBe(1)
    expect(o.grantedUntil).toBe(T0 + TIMEBOX_MS)
    expect(o.neverDispatched).toBe(false)
  })

  it('30min 内未到期, 之后到期', () => {
    const o = newOrch('d-02', T0)
    grant(o, { at: T0, findingsLines: 0, forkCount: 0, artifactCount: 0 }, T0)
    expect(timeboxExpired(o, T0 + TIMEBOX_MS - 1)).toBe(false)
    expect(timeboxExpired(o, T0 + TIMEBOX_MS + 1)).toBe(true)
  })

  it('非 granted 态不会到期', () => {
    const o = newOrch('d-03', T0)
    expect(timeboxExpired(o, T0 + TIMEBOX_MS + 99)).toBe(false)
  })

  it('rearmByTimebox: 回队且升级梯刻度保留(≠零进展)', () => {
    const o = newOrch('d-04', T0)
    o.zeroProgressStreak = 1
    grant(o, { at: T0, findingsLines: 0, forkCount: 0, artifactCount: 0 }, T0)
    rearmByTimebox(o)
    expect(o.state).toBe('queued')
    expect(o.grantedUntil).toBeUndefined()
    expect(o.zeroProgressStreak).toBe(1)
  })
})

describe('优先级与风险排序', () => {
  it('从未开工随时间提权(每30min+1档, 上限3)', () => {
    const o = newOrch('e3-04', T0)
    expect(neverDispatchedBoost(o, T0)).toBe(0)
    expect(neverDispatchedBoost(o, T0 + 30 * 60_000)).toBe(1)
    expect(neverDispatchedBoost(o, T0 + 90 * 60_000)).toBe(3)
    expect(neverDispatchedBoost(o, T0 + 240 * 60_000)).toBe(3)
  })

  it('已派过的题不再提权', () => {
    const o = newOrch('e3-04', T0)
    grant(o, { at: T0, findingsLines: 0, forkCount: 0, artifactCount: 0 }, T0)
    expect(neverDispatchedBoost(o, T0 + 120 * 60_000)).toBe(0)
  })

  it('priorityOf 两段式(v8.4.1): 首轮公平带内 hard 优先 > 分值密度; 显式 override 直通; 终态/待裁决不可入队', () => {
    const o = newOrch('e3-04', T0)
    // 从未开工: 进首轮公平带(1_000_000 基线), 带内按分值密度排(hard 先来, 20633 教训)
    expect(priorityOf(o, 250, T0)).toBe(1_000_000 + 250 * 10)
    // 已开工: 分值密度(提权档只属于从未开工的题, 已开工不再提权)
    o.neverDispatched = false
    expect(priorityOf(o, 250, T0)).toBe(250)
    expect(priorityOf(o, 250, T0 + 60 * 60_000)).toBe(250)
    o.priorityOverride = 999
    expect(priorityOf(o, 250, T0)).toBe(999)
    o.priorityOverride = undefined
    // v8.4.1: 主 agent 覆盖直通(跳出公平带, 不再被 1_000_000 段吞掉)
    const o2 = newOrch('e3-03', T0)
    o2.priorityOverride = 777
    expect(priorityOf(o2, 250, T0)).toBe(777)
    o.state = 'pending-adjudication'
    expect(priorityOf(o, 250, T0)).toBe(Number.NEGATIVE_INFINITY)
    o.state = 'dead'
    expect(priorityOf(o, 250, T0)).toBe(Number.NEGATIVE_INFINITY)
  })

  it('compareRisk: 排队中 > granted; 从未开工 > 已开工; 高分 > 低分', () => {
    const a = newOrch('a', T0)   // queued, never, 250
    const b = newOrch('b', T0)   // queued, never, 500
    const c = newOrch('c', T0)   // queued, 已开工(grant 后 rearm 回队)
    const d = newOrch('d', T0)   // granted
    grant(c, { at: T0, findingsLines: 0, forkCount: 0, artifactCount: 0 }, T0)
    applySettle(c, 'rearm', '有进展', T0 + 1000)
    grant(d, { at: T0, findingsLines: 0, forkCount: 0, artifactCount: 0 }, T0)
    expect(compareRisk(a, b, 250, 500)).toBeGreaterThan(0) // b(500) 排在 a(250) 前
    expect(compareRisk(b, c, 500, 250)).toBeLessThan(0)    // b(never) 排在 c(已开工) 前
    expect(compareRisk(c, d, 250, 250)).toBeLessThan(0)    // c(queued) 排在 d(granted) 前
  })
})

describe('指纹与序列化', () => {
  it('fingerprintOf 压平截断', () => {
    expect(fingerprintOf('  未破 — 攻击面  缺失\n\n(平台端口暴露不含 Dify 后端 API)')).toBe('未破 — 攻击面 缺失 (平台端口暴露不含 Dify 后端 API)'.slice(0, 80))
  })

  it('序列化 round-trip', () => {
    const o = newOrch('f1-02', T0)
    grant(o, { at: T0, findingsLines: 3, forkCount: 1, artifactCount: 0 }, T0)
    o.directives.push({ text: 'PEEK/HIST 泄漏', tried: false })
    const pending = [makePending('c-03', 'blocker-verified', 'c-03 待裁决', '/opt/work/boards/pending/c-03/FINDINGS.md', T0)]
    const json = serializeOrchState(new Map([['f1-02', o]]), pending, { 'f1-02': 600, 'a-01': 100 })
    const back = parseOrchState(json)
    const o2 = back.orch.get('f1-02')!
    expect(o2.state).toBe('granted')
    expect(o2.attempts).toBe(1)
    expect(o2.grantedUntil).toBe(T0 + TIMEBOX_MS)
    expect(o2.directives[0]!.text).toBe('PEEK/HIST 泄漏')
    expect(back.pending[0]!.kind).toBe('blocker-verified')
    expect(back.scoreTable['f1-02']).toBe(600)
    expect(back.scoreTable['a-01']).toBe(100)
  })
})

describe('同靶场簇', () => {
  it('clusterMapOf: 同 addr 聚簇, 异 addr/空 addr 不入簇', () => {
    const m = new Map<string, string[]>([
      ['a-18', ['10.0.1.5']],
      ['d-02', ['10.0.1.5']],
      ['b-01', ['10.0.2.1']],
      ['c-01', []],
      ['e-01', ['10.0.1.5']],
    ])
    const clusters = clusterMapOf(m)
    expect(clusters.get('a-18')!.sort()).toEqual(['d-02', 'e-01'])
    expect(clusters.get('d-02')!.sort()).toEqual(['a-18', 'e-01'])
    expect(clusters.has('b-01')).toBe(false)
    expect(clusters.has('c-01')).toBe(false)
  })
})

describe('旗仓纯函数', () => {
  it('parseFlagLines 坏行跳过 / foldFlags 同键后行覆盖', () => {
    const e1 = flagLine({ code: 'b-02', flag: 'flag{a}', by: 'x', status: 'pending', at: 1 })
    const e2 = flagLine({ code: 'b-02', flag: 'flag{a}', by: 'submit', status: 'accepted', at: 2 })
    const e3 = flagLine({ code: 'b-02', flag: 'flag{b}', by: 'x', status: 'pending', at: 3 })
    const entries = parseFlagLines([e1, e2, 'bad-line', e3].join('\n'))
    expect(entries).toHaveLength(3)
    const folded = foldFlags(entries).get('b-02')!
    expect(folded.get('flag{a}')!.status).toBe('accepted') // 后行覆盖
    expect(pendingFlagsOf(entries, 'b-02').map(e => e.flag)).toEqual(['flag{b}'])
    expect(pendingFlagsOf(entries, 'a-01')).toEqual([])
  })
})

describe('zeroProgress 判定', () => {
  it('全零 → 零进展', () => {
    expect(zeroProgress(prog())).toBe(true)
    expect(zeroProgress(prog({ findingsDelta: 1 }))).toBe(true)
  })
  it('有fork/有工件/有旗 → 非零进展; 战报行数不算', () => {
    expect(zeroProgress(prog({ findingsDelta: 2 }))).toBe(true)
    expect(zeroProgress(prog({ forkDelta: 1 }))).toBe(false)
    expect(zeroProgress(prog({ artifactsDelta: 1 }))).toBe(false)
    expect(zeroProgress(prog({ flagCandidate: true }))).toBe(false)
  })
})

describe('v8.4.1 priorityOf: 显式 priority 直通 + 从未开工段 hard 优先', () => {
  it('显式 priorityOverride 跳出公平段(直通排序)', () => {
    const easy = newOrch('g-e', 0); easy.priorityOverride = undefined
    const hard = newOrch('b-h', 0); hard.priorityOverride = 5000
    // 无 override 的 neverDispatched easy 在 1_000_000 段; override 的 hard 直通 5000
    expect(priorityOf(hard, 1800, 0)).toBe(5000)
    expect(priorityOf(easy, 300, 0)).toBeGreaterThan(1_000_000)
  })
  it('从未开工段内按分值密度排(hard 先来, 20633 教训)', () => {
    const easy = newOrch('g-e', 0)
    const hard = newOrch('b-h', 0)
    expect(priorityOf(hard, 1800, 0)).toBeGreaterThan(priorityOf(easy, 300, 0))
  })
  it('override 与 1_000_000 段比较: override 大者胜出(可按分值给 override)', () => {
    const a = newOrch('a', 0); a.priorityOverride = 18000
    const b = newOrch('b', 0); b.priorityOverride = 3000
    expect(priorityOf(a, 1800, 0)).toBeGreaterThan(priorityOf(b, 300, 0))
  })
})
