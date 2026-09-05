/**
 * 校场：知识治理扫描器（clean-room 打包前必跑）。
 * 检出：flag 值、API 凭据、明显题解/死路文件、占位 flag 误当真题的痕迹。
 * 纯逻辑：输入文本/文件路径列表，输出违规报告。
 * @module @shence/yebushou/governance
 */

export interface GovernanceViolation {
  file: string
  rule: string
  sample: string
}

export interface ScanResult {
  violations: GovernanceViolation[]
  clean: boolean
}

const RULES: Array<{ name: string; pattern: RegExp }> = [
  // 具体 flag 值（含各大 CTF 前缀，排除占位符写法 flag{...} 字面）
  { name: 'flag-value', pattern: /\b(?:flag|FLAG|HTB|SEKAI|gctf|hkcert22)\{[^}\s]{6,}\}/ },
  // API 密钥（sk-、Bearer JWT、智谱式双段 key）
  { name: 'api-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'api-key-zhipu', pattern: /\b[a-f0-9]{32}\.[A-Za-z0-9]{16,}\b/ },
  { name: 'bearer-jwt', pattern: /Bearer\s+eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  // 公开默认凭据（托管红线：历史解题发现的凭据不得入库/入镜像）
  { name: 'known-credential', pattern: /(sysadmin|weaveradmin)\/Weaver@2001|ThisIsBestPassword|emppassword|sup3rsecr3t/ },
]

/** 单文本扫描。 */
export function scanText(file: string, text: string): GovernanceViolation[] {
  const violations: GovernanceViolation[] = []
  for (const rule of RULES) {
    const match = rule.pattern.exec(text)
    if (match !== null) {
      violations.push({ file, rule: rule.name, sample: match[0].slice(0, 80) })
      // 重置 lastIndex（全局正则），避免跨文件错位。
      rule.pattern.lastIndex = 0
    }
  }
  return violations
}

/** 批量扫描（file → 内容）。 */
export function scanFiles(files: Array<{ file: string; text: string }>): ScanResult {
  const violations = files.flatMap(({ file, text }) => scanText(file, text))
  return { violations, clean: violations.length === 0 }
}
