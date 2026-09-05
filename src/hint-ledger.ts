/**
 * 校场：hint 经济学账本（纯逻辑）。
 * 平台规则：官方 hint 扣该题 10% 分；账本记录每题 hint 次数与已扣分，供预算决策。
 * @module @shence/yebushou/hint-ledger
 */

export interface HintRecord {
  challengeCode: string
  hints: number
  /** 已扣分（每次 hint = 题面分的 10%，向上取整到 1）。 */
  deducted: number
  reasons: string[]
}

export class HintLedger {
  private readonly records = new Map<string, HintRecord>()

  /** 记一次 hint；返回本次扣分。 */
  record(challengeCode: string, fullScore: number, reason: string): number {
    const cost = Math.max(1, Math.ceil(fullScore * 0.1))
    const rec = this.records.get(challengeCode) ?? { challengeCode, hints: 0, deducted: 0, reasons: [] }
    rec.hints += 1
    rec.deducted += cost
    rec.reasons.push(reason)
    this.records.set(challengeCode, rec)
    return cost
  }

  get(challengeCode: string): HintRecord | undefined {
    return this.records.get(challengeCode)
  }

  all(): HintRecord[] {
    return [...this.records.values()]
  }

  totalDeducted(): number {
    return this.all().reduce((sum, r) => sum + r.deducted, 0)
  }

  totalHints(): number {
    return this.all().reduce((sum, r) => sum + r.hints, 0)
  }

  /** 序列化（随 run 归档）。 */
  dump(): HintRecord[] {
    return this.all().map(r => ({ ...r, reasons: [...r.reasons] }))
  }

  static restore(records: HintRecord[]): HintLedger {
    const ledger = new HintLedger()
    for (const rec of records) {
      ledger.records.set(rec.challengeCode, { ...rec, reasons: [...rec.reasons] })
    }
    return ledger
  }
}
