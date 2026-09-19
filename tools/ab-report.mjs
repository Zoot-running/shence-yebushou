#!/usr/bin/env node
/**
 * 锚定 A/B 汇总: 从 /tmp/dryrun-ab-{A,B}/ 证据统计两臂指标。
 * 指标: 出旗数 / submit 次数 / 各题首旗时间(以 audit submit/verdict 时间戳为序) / v8 事件计数。
 */
import { readFileSync, existsSync } from 'node:fs'

const METRICS = []
for (const arm of ['A', 'B']) {
  const dir = `/tmp/dryrun-ab-${arm}`
  const logPath = `${dir}/driver.log`
  const auditPath = `${dir}/audit.jsonl`
  if (!existsSync(logPath)) { console.log(`arm ${arm}: 缺 driver.log`); continue }
  const log = readFileSync(logPath, 'utf8')
  const audit = existsSync(auditPath)
    ? readFileSync(auditPath, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    : []
  // 从 driver.log 抓 submit 调用及其时间(主 agent 工具调用日志形态)
  const submitLines = [...log.matchAll(/\[tool\]\s+xiaochang_submit|xiaochang_submit \{/g)].length
  const finishLine = log.match(/xiaochang_finish[^\n]*score=([\d.]+)/)
  const finalScore = finishLine ? finishLine[1] : null
  const accepted = audit.filter(l => l.type === 'v8-submit-solved' || l.type === 'v8-submit-partial').length
  const rejected = audit.filter(l => l.type === 'v8-submit-reject').length
  const grants = audit.filter(l => l.type === 'v8-grant').length
  const settles = audit.filter(l => l.type === 'v8-settle').length
  const solvedMentions = [...log.matchAll(/已解|SOLVED|solved/gi)].length
  METRICS.push({ arm, finalScore, submitLines, accepted, rejected, grants, settles, solvedMentions })
}
console.log('=== 锚定 A/B 汇总 ===')
console.log('arm | 终局分 | submit调用 | 入账旗(accepted) | 被拒 | 授予 | settle')
for (const m of METRICS) {
  console.log(` ${m.arm}  | ${m.finalScore ?? '?'} | ${m.submitLines} | ${m.accepted} | ${m.rejected} | ${m.grants} | ${m.settles}`)
}
