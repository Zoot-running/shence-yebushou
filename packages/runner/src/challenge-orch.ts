/**
 * 校场 v8：题队列编排内核（纯函数层）。
 * 队列单元 = 题；授予 = 启容器 + 从账本生成执行者 + 注入地址（宿主层执行）。
 * 本模块承载: 每题编排态、settle 结算分类、升级梯、时间盒、优先级/风险排序、
 * blocker 检测与验证兵、裁决出边、持久化序列化。零 IO 依赖, 全部可单测。
 * @module @shence/xiaochang-runner/challenge-orch
 */

export type OrchState = 'queued' | 'granted' | 'pending-adjudication' | 'solved' | 'dead'

export type PendingKind =
  | 'needs-rotate'
  | 'needs-verdict'
  | 'hint-candidate'
  | 'blocker-verified'
  | 'flag-candidate'

export interface PendingAdjudication {
  code: string
  kind: PendingKind
  /** 首行收敛格式: `code + 状态 + 需要什么动作`。 */
  summary: string
  detailPath: string
  createdAt: number
}

/** 一条思路包（主 agent enqueue 写入; 授予时从账本+此表生成执行者）。 */
export interface Directive {
  text: string
  model?: string
  effort?: string
  tried: boolean
}

/** 授予时对账本/工件拍快照, settle 时比对算零进展。 */
export interface ProgressSnapshot {
  at: number
  findingsLines: number
  forkCount: number
  artifactCount: number
}

export interface ChallengeOrch {
  code: string
  state: OrchState
  /** 授予次数（grant 时 +1）。 */
  attempts: number
  /** 连续零进展次数（升级梯刻度）。 */
  zeroProgressStreak: number
  lastGrantAt?: number
  /** 时间盒到期墙钟（grantedUntil = lastGrantAt + TIMEBOX_MS）。 */
  grantedUntil?: number
  neverDispatched: boolean
  /** 主 agent 显式优先级（缺省 = 分值密度 + 从未开工提权）。 */
  priorityOverride?: number
  directives: Directive[]
  /** 回队后应发 R2（零进展×1 全开标记）。 */
  r2Due: boolean
  /** 下次授予要生成的执行者路数（零进展×1 全开 = 3 路; 授予时消费归零）。 */
  multiSpawn: number
  /** settle 无旗累计次数（hint 闸把"打过但未破"计入 filtered-failed）。 */
  settleNoFlag: number
  /** blocker 类结论（无攻击面/环境缺失…）核验状态。 */
  blockerCheck: 'none' | 'in-flight' | 'confirmed' | 'refuted'
  /** 上次 settle 结论指纹（同结论检测）。 */
  lastSettleFingerprint?: string
  snapshot?: ProgressSnapshot
  createdAt: number
}

/** settle 结算输入（宿主从账本/文件差异计算, 零模型主观）。 */
export interface SettleProgress {
  /** 终态文本含 FLAG_CANDIDATE（等主 agent 提交, 不自动回队）。 */
  flagCandidate: boolean
  /** FINDINGS.md 开工前 vs settle 后行数差。 */
  findingsDelta: number
  /** settle 窗口内新 fork 条目数。 */
  forkDelta: number
  /** /opt/work/{code}/ 新增工件文件数。 */
  artifactsDelta: number
  /** 终态/fork 含 blocker 结论（无攻击面/环境缺失…）。 */
  blockerConcluded: boolean
  detail: string
}

export type SettleAction =
  | 'pending-flag'   // 有 FLAG_CANDIDATE: 等主 agent 提交
  | 'rearm'          // 有进展: 回队不加路（继承账本）
  | 'rearm-all-in'   // 零进展×1: 全开（未试思路全派 + R2 全模型 + 多模型混打）
  | 'adjudicate'     // 零进展×2 / blocker 已确认: 挂主 agent 裁决（离开自动轮转）
  | 'verify-blocker' // blocker 结论×1: 派验证兵（独立复验, 推翻即续打）

export type AdjudicationVerdict = 'continue' | 'rotate' | 'dead' | 'solved'

/** 单次授予时间盒（19429 无种子局中位 7min / p90 27min, 30 覆盖 p90）。 */
export const TIMEBOX_MS = 30 * 60_000
/** FLAG_CANDIDATE 待提交宽限（提交必须容器在线; 宽限后时间盒照常切）。 */
export const SUBMIT_GRACE_MS = 15 * 60_000
/** 从未开工提权步长/上限（每 30min +1 档, 上限 3 档）。 */
export const NEVER_DISPATCHED_BOOST_STEP_MS = 30 * 60_000
export const NEVER_DISPATCHED_BOOST_MAX = 3

/** blocker 类结论词表（命中 → 该题触发验证兵; 仅按结论措辞, 不按"题难"措辞）。 */
const BLOCKER_RE = /(攻击面\s*缺失|无攻击面|攻击面.*(?:不存在|缺失)|环境缺失|未随容器|平台.*未(?:发布|暴露)|未暴露|not exposed|no attack surface|unreachable|不可达|服务未启动|仅.*静态)/i

export function blockerConcluded(text: string): boolean {
  return BLOCKER_RE.test(text)
}

/** 验证兵结论解析（机制读 settle 终态文本, 不靠模型调用新工具）。 */
export function verifierVerdict(text: string): 'confirm' | 'refute' | 'unclear' {
  const confirm = /(blocker\s*成立|确认|confirmed|攻击面\s*确实|确无|verify\s*ok)/i
  const refute = /(推翻|不成立|refut|攻击面\s*存在|有攻击面|误判)/i
  const c = confirm.test(text)
  const r = refute.test(text)
  if (c && !r) return 'confirm'
  if (r && !c) return 'refute'
  return 'unclear'
}

/** 零进展 = settle 无旗 AND 战报新增发现行≤1 AND 新 fork=0 AND 无新工件。 */
export function zeroProgress(p: SettleProgress): boolean {
  return !p.flagCandidate && p.findingsDelta <= 1 && p.forkDelta === 0 && p.artifactsDelta === 0
}

/** settle 结论指纹：首段文本压平截断（同结论检测, 如"攻击面缺失"×2）。 */
export function fingerprintOf(detail: string): string {
  return detail.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/**
 * settle 结算分类（升级梯核心）。
 * 调用约定（宿主）: 若 orch.blockerCheck === 'in-flight'（本次 settle 是验证兵）,
 * 先 applyVerifierResult(orch, verifierVerdict(detail)) 再调本函数。
 */
export function settleAction(orch: ChallengeOrch, p: SettleProgress): SettleAction {
  if (p.flagCandidate) return 'pending-flag'
  if (p.blockerConcluded) {
    if (orch.blockerCheck === 'confirmed') return 'adjudicate'
    if (orch.blockerCheck === 'in-flight' || orch.blockerCheck === 'refuted') {
      // 验证兵本次/此前已推翻 → 落回普通规则（blocker 结论不再拦截）。
    } else {
      return 'verify-blocker'
    }
  }
  if (!zeroProgress(p)) return 'rearm'
  const streak = orch.zeroProgressStreak + 1
  if (streak === 1) return 'rearm-all-in'
  return 'adjudicate'
}

/** 验证兵结论回写（在 settleAction 之前调用）。 */
export function applyVerifierResult(orch: ChallengeOrch, verdict: 'confirm' | 'refute' | 'unclear'): void {
  if (verdict === 'confirm') orch.blockerCheck = 'confirmed'
  else if (verdict === 'refute') orch.blockerCheck = 'refuted'
  else orch.blockerCheck = 'none'
}

/** settle 动作落地（原地改写, 返回 orch 便于链式）。 */
export function applySettle(orch: ChallengeOrch, action: SettleAction, detail: string, now: number): ChallengeOrch {
  orch.lastSettleFingerprint = fingerprintOf(detail)
  orch.grantedUntil = undefined
  switch (action) {
    case 'pending-flag':
      // 有旗待提交: 给主 agent 提交宽限(提交需容器在线), 宽限后时间盒照常切。
      orch.state = 'pending-adjudication'
      orch.grantedUntil = now + SUBMIT_GRACE_MS
      break
    case 'rearm':
      orch.state = 'queued'
      orch.zeroProgressStreak = 0
      orch.r2Due = false
      orch.multiSpawn = 0
      break
    case 'rearm-all-in':
      orch.state = 'queued'
      orch.zeroProgressStreak = 1
      orch.r2Due = true
      orch.multiSpawn = 3
      break
    case 'adjudicate':
      orch.state = 'pending-adjudication'
      orch.multiSpawn = 0
      break
    case 'verify-blocker':
      orch.state = 'queued'
      orch.blockerCheck = 'in-flight'
      orch.r2Due = false
      orch.multiSpawn = 1
      break
  }
  return orch
}

/** 时间盒到期回队: 关容器(宿主做)后回队, 账本保留, 升级梯刻度不动(≠零进展)。 */
export function rearmByTimebox(orch: ChallengeOrch): ChallengeOrch {
  orch.state = 'queued'
  orch.grantedUntil = undefined
  orch.multiSpawn = 0
  return orch
}

/** 主 agent 裁决落地（裁决出边）。 */
export function adjudicate(orch: ChallengeOrch, verdict: AdjudicationVerdict): ChallengeOrch {
  switch (verdict) {
    case 'continue':
    case 'rotate':
      // 裁决 = 主 agent 明确再投资源: 重新入队, 升级梯清零, attempts 保留。
      orch.state = 'queued'
      orch.zeroProgressStreak = 0
      orch.r2Due = false
      orch.blockerCheck = 'none'
      orch.grantedUntil = undefined
      orch.lastSettleFingerprint = undefined
      break
    case 'dead':
      orch.state = 'dead'
      orch.grantedUntil = undefined
      break
    case 'solved':
      orch.state = 'solved'
      orch.grantedUntil = undefined
      break
  }
  return orch
}

/** 授予落地（原子授予在宿主层执行后调用）。 */
export function grant(orch: ChallengeOrch, snapshot: ProgressSnapshot, now: number, timeboxMs: number = TIMEBOX_MS): ChallengeOrch {
  orch.state = 'granted'
  orch.attempts += 1
  orch.lastGrantAt = now
  orch.grantedUntil = now + timeboxMs
  orch.neverDispatched = false
  orch.snapshot = snapshot
  orch.r2Due = false
  return orch
}

/** 时间盒到期（授予时长超 30min 且未出旗; 含 flag-candidate 待提交宽限后的锁槽态）。 */
export function timeboxExpired(orch: ChallengeOrch, now: number): boolean {
  if (orch.grantedUntil === undefined || now <= orch.grantedUntil) return false
  return orch.state === 'granted' || orch.state === 'pending-adjudication'
}

/** 从未开工提权档数（每 30min +1, 上限 3）。 */
export function neverDispatchedBoost(orch: ChallengeOrch, now: number): number {
  if (!orch.neverDispatched) return 0
  return Math.min(NEVER_DISPATCHED_BOOST_MAX, Math.floor(Math.max(0, now - orch.createdAt) / NEVER_DISPATCHED_BOOST_STEP_MS))
}

/**
 * 队列优先级(两段式):
 * - 首轮公平带: 从未开工的题全部排在已开工题之前(1_000_000 基线), 带内按分值升序(easy 先行清场,
 *   校准本 run 旗值习惯; 主 agent 覆盖 +1_000_000 生效);
 * - 此后: 主 agent 覆盖 > 分值密度 × (1 + 0.5×从未开工提权档)。
 * 终态/待裁决 = 不可入队。
 */
export function priorityOf(orch: ChallengeOrch, totalScore: number, now: number): number {
  if (orch.state === 'solved' || orch.state === 'dead' || orch.state === 'pending-adjudication') return Number.NEGATIVE_INFINITY
  const base = totalScore > 0 ? totalScore : 300
  if (orch.neverDispatched) {
    const p = orch.priorityOverride ?? (2_000 - base) * 10
    return 1_000_000 + p + neverDispatchedBoost(orch, now)
  }
  if (orch.priorityOverride !== undefined) return orch.priorityOverride
  return base * (1 + 0.5 * neverDispatchedBoost(orch, now))
}

/**
 * 仪表风险排序比较器（a 排在 b 前 = 更"该被看见"）:
 * 排队中(0在途)优先 > 从未开工优先 > 分值高优先 > 尝试少优先。
 */
export function compareRisk(a: ChallengeOrch, b: ChallengeOrch, scoreA: number, scoreB: number): number {
  const queuedA = a.state === 'queued' ? 0 : 1
  const queuedB = b.state === 'queued' ? 0 : 1
  if (queuedA !== queuedB) return queuedA - queuedB
  const neverA = a.neverDispatched ? 0 : 1
  const neverB = b.neverDispatched ? 0 : 1
  if (neverA !== neverB) return neverA - neverB
  if (scoreB !== scoreA) return scoreB - scoreA
  return a.attempts - b.attempts
}

export function newOrch(code: string, now: number): ChallengeOrch {
  return {
    code,
    state: 'queued',
    attempts: 0,
    zeroProgressStreak: 0,
    neverDispatched: true,
    directives: [],
    r2Due: false,
    multiSpawn: 0,
    settleNoFlag: 0,
    blockerCheck: 'none',
    createdAt: now,
  }
}

export function makePending(code: string, kind: PendingKind, summary: string, detailPath: string, now: number): PendingAdjudication {
  return { code, kind, summary, detailPath, createdAt: now }
}

/** 编排态 + 待决事项 序列化（JSON 文件, 崩溃恢复）。 */
/** v8.3 计分表: code → 该题已得累计分(平台 submit 回执 cumulative_score, 单题语义)。 */
export type ScoreTable = Record<string, number>

export function serializeOrchState(orch: ReadonlyMap<string, ChallengeOrch>, pending: readonly PendingAdjudication[], scoreTable: ScoreTable = {}): string {
  return JSON.stringify({
    orch: Object.fromEntries([...orch.entries()].map(([code, o]) => [code, o])),
    pending,
    scoreTable,
  })
}

export function parseOrchState(json: string): { orch: Map<string, ChallengeOrch>; pending: PendingAdjudication[]; scoreTable: ScoreTable } {
  const d = JSON.parse(json) as { orch?: Record<string, ChallengeOrch>; pending?: PendingAdjudication[]; scoreTable?: ScoreTable }
  const m = new Map<string, ChallengeOrch>()
  for (const [code, o] of Object.entries(d.orch ?? {})) m.set(code, o as ChallengeOrch)
  return { orch: m, pending: d.pending ?? [], scoreTable: d.scoreTable ?? {} }
}
