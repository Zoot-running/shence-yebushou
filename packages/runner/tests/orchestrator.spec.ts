/**
 * 校场 v2 编排核心 L0：clean-room 门禁、工作项 id 解析、OBSERVATIONS 解析、
 * 进度账（快照/容错恢复）。
 * v2 调度权在主 agent——本文件只测纯机制。
 */
import { describe, expect, it } from 'vitest'
import {
  RunProgress,
  appendKnowledgeSection,
  attachmentFetchCandidates,
  attachmentLikely,
  baseId,
  buildWarmupPrompt,
  cleanRoomGate,
  codeOf,
  knowledgeSkeleton,
  parseObservations,
  dedupeForkPaths,
  truncateDirective,
  hintGate,
  replaceKnowledgeSection,
  resolveExecutor,
  resourceClassOf,
  roundOf,
  familyOf,
  hintGateV2,
  sealedClustersOf,
  parseHandoffForks,
  gradedLine,
  TEMPLATE_LIBRARY,
  templateOf,
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

describe('resolveExecutor', () => {
  const policy = { defaultModel: 'deepseek-v4-flash', defaultEffort: 'low', locked: false }

  it('unlocked: per-item override wins, default fills the gap', () => {
    expect(resolveExecutor({ model: 'kimi-k3', effort: 'max' }, policy)).toEqual({
      model: 'kimi-k3', effort: 'max', overriddenByLock: false,
    })
    expect(resolveExecutor({}, policy)).toEqual({
      model: 'deepseek-v4-flash', effort: 'low', overriddenByLock: false,
    })
  })
  it('locked: everything is forced to the default and overrides are flagged', () => {
    const locked = { ...policy, locked: true }
    expect(resolveExecutor({ model: 'kimi-k3' }, locked)).toEqual({
      model: 'deepseek-v4-flash', effort: 'low', overriddenByLock: true,
    })
    expect(resolveExecutor({}, locked)).toEqual({
      model: 'deepseek-v4-flash', effort: 'low', overriddenByLock: false,
    })
  })
})

describe('sweepLegacyWorkdir', () => {
  it('archives pre-run artifacts, keeps tooling and run scripts', () => {
    const { mkdtempSync, writeFileSync, utimesSync, readdirSync, existsSync } = require('node:fs') as typeof import('node:fs')
    const { tmpdir } = require('node:os') as typeof import('node:os')
    const { join } = require('node:path') as typeof import('node:path')
    const { sweepLegacyWorkdir } = require('../src/orchestrator.ts') as typeof import('../src/orchestrator.ts')
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'))
    const old = new Date('2026-09-07T00:00:00Z')
    const fresh = new Date('2026-09-08T02:00:00Z')
    const startedAt = Date.parse('2026-09-08T01:47:00Z')
    const touch = (p: string, t: Date): void => { writeFileSync(p, 'x'); utimesSync(p, t, t) }
    // 旧题号工件 → 归档
    const gdir = join(dir, 'g-02')
    require('node:fs').mkdirSync(gdir)
    touch(join(gdir, 'solve.py'), old)
    utimesSync(gdir, old, old)
    // 旧战报 → 归档（boards 整个目录）
    const bdir = join(dir, 'boards', 'g-03')
    require('node:fs').mkdirSync(bdir, { recursive: true })
    touch(join(bdir, 'FINDINGS.md'), old)
    utimesSync(join(dir, 'boards'), old, old)
    utimesSync(bdir, old, old)
    // 工具链/启动脚本/新工件 → 保留
    require('node:fs').mkdirSync(join(dir, '.venv'))
    touch(join(dir, '.venv', 'python'), old)
    touch(join(dir, 'run7-launch.sh'), old)
    require('node:fs').mkdirSync(join(dir, 'g-04'))
    touch(join(dir, 'g-04', 'work'), fresh)
    const moved = sweepLegacyWorkdir(dir, startedAt, '.archive/test')
    expect(moved).toBe(2) // g-02 目录 + boards 目录
    expect(existsSync(join(dir, '.archive', 'test', 'g-02', 'solve.py'))).toBe(true)
    expect(existsSync(join(dir, '.archive', 'test', 'boards', 'g-03', 'FINDINGS.md'))).toBe(true)
    expect(existsSync(join(dir, '.venv'))).toBe(true)
    expect(existsSync(join(dir, 'run7-launch.sh'))).toBe(true)
    expect(existsSync(join(dir, 'g-04'))).toBe(true)
    expect(readdirSync(dir)).toContain('.archive')
  })
})

describe('resourceClassOf (v7 附件/容器分类)', () => {
  it('classifies 无需容器/附件题 as local', () => {
    expect(resourceClassOf({ description: 'mock 题 g-m1: 计算 base64。无需容器; 工具只用 bash。' })).toBe('local')
    expect(resourceClassOf({ description: '下载附件 solve.zip 分析。' })).toBe('local')
    expect(resourceClassOf({ description: 'attachments: flag.png, 本地分析' })).toBe('local')
  })
  it('conservative default is container', () => {
    expect(resourceClassOf({ description: '某企业官网入口 /b02/ 目录。' })).toBe('container')
    expect(resourceClassOf({ description: '' })).toBe('container')
    expect(resourceClassOf({})).toBe('container')
  })
})

describe('knowledge file (v7 四节账本, 纯函数)', () => {
  it('skeleton has the four sections in order', () => {
    const s = knowledgeSkeleton('b-02')
    expect(s).toContain('## ① 题源思路骨架')
    expect(s).toContain('## ② 不可行教训')
    expect(s).toContain('## ③ 回收工件')
    expect(s).toContain('## ④ 未走分叉')
    expect(s.indexOf('①') < s.indexOf('②') && s.indexOf('②') < s.indexOf('③') && s.indexOf('③') < s.indexOf('④')).toBe(true)
  })
  it('append drops the placeholder and dedupes by exact line', () => {
    const s0 = knowledgeSkeleton('b-02')
    const s1 = appendKnowledgeSection(s0, 'dead', ['SSO 绕过不可行'])
    expect(s1).toContain('- SSO 绕过不可行')
    // ② 小节的占位行被条目替换(其他小节占位仍在——只查 ② 区间)
    const between = s1.slice(s1.indexOf('## ②'), s1.indexOf('## ③'))
    expect(between).not.toContain('(暂无)')
    const s2 = appendKnowledgeSection(s1, 'dead', ['SSO 绕过不可行', '爆破不可行: 有验证码'])
    // 幂等: 重复条目不重复生长
    expect(s2.split('- SSO 绕过不可行').length - 1).toBe(1)
    expect(s2).toContain('- 爆破不可行: 有验证码')
  })
  it('append keeps existing entries and appends after them', () => {
    const s0 = knowledgeSkeleton('b-02')
    const s1 = appendKnowledgeSection(s0, 'dead', ['A'])
    const s2 = appendKnowledgeSection(s1, 'dead', ['B'])
    expect(s2.indexOf('- A') < s2.indexOf('- B')).toBe(true)
    // 其他小节不受影响
    expect(s2).toContain('## ③ 回收工件\n- (暂无)')
  })
  it('replace rewrites ① entirely, keeps other sections', () => {
    const s0 = knowledgeSkeleton('b-02')
    const s1 = appendKnowledgeSection(s0, 'artifacts', ['凭证 admin/x'])
    const s2 = replaceKnowledgeSection(s1, 'skeleton', ['思路1: 官网信息泄露 → OA', '思路2: OA 搜索注入'])
    expect(s2).toContain('- 思路1: 官网信息泄露 → OA')
    expect(s2).toContain('- 思路2: OA 搜索注入')
    expect(s2).not.toContain('① 题源思路骨架\n- (暂无)')
    expect(s2).toContain('- 凭证 admin/x') // ③ 保留
  })
  it('append creates a missing section at the end of a partial file', () => {
    const s0 = knowledgeSkeleton('b-02')
    const stripped = s0.split('\n').filter(l => !l.startsWith('## ②')).join('\n')
    const s1 = appendKnowledgeSection(stripped, 'dead', ['X'])
    expect(s1).toContain('## ② 不可行教训\n- X')
  })
})

describe('v7.4 hintGate (hint 时机门禁)', () => {
  it('refuses before R2 (ideaRound<2)', () => {
    const g = hintGate({ ideaRound: 1, filteredFailed: 5 })
    expect(g.allowed).toBe(false)
    expect(g.missing.length).toBe(1)
    expect(g.missing[0]).toContain('R2')
  })
  it('refuses without filtered failures', () => {
    const g = hintGate({ ideaRound: 3, filteredFailed: 0 })
    expect(g.allowed).toBe(false)
    expect(g.missing[0]).toContain('失败')
  })
  it('allows only after R2 AND ≥1 filtered failure', () => {
    expect(hintGate({ ideaRound: 2, filteredFailed: 1 }).allowed).toBe(true)
    expect(hintGate({ ideaRound: 2, filteredFailed: 0 }).allowed).toBe(false)
    expect(hintGate({ ideaRound: 1, filteredFailed: 1 }).allowed).toBe(false)
  })
})

describe('v7.4 dedupeForkPaths (fork 源端去重)', () => {
  it('drops paths already in the inbox, keeps new ones', () => {
    const out = dedupeForkPaths(['SSO 绕过'], [
      { path: 'SSO 绕过' },
      { path: 'OA 注入' },
      { path: 'OA 注入' },
    ])
    expect(out.map(e => e.path)).toEqual(['OA 注入'])
  })
  it('keeps everything when inbox is empty', () => {
    expect(dedupeForkPaths([], [{ path: 'A' }, { path: 'B' }]).map(e => e.path)).toEqual(['A', 'B'])
  })
})

describe('v7.6 truncateDirective (方向段截断+反馈)', () => {
  it('passes short directives through untouched', () => {
    const r = truncateDirective('打 /api/reports/{id} 越权', 700)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('打 /api/reports/{id} 越权')
  })
  it('cuts long directives at the threshold and reports the cut point', () => {
    const long = 'A'.repeat(800)
    const r = truncateDirective(long, 700)
    expect(r.truncated).toBe(true)
    expect(r.cutAt).toBe(700)
    expect(r.text.length).toBeLessThan(730)
    expect(r.text).toContain('已截断')
    expect(r.cutTail).toBe('A'.repeat(60))
  })
})

describe('v7.8 开局饱和 helpers', () => {
  it('buildWarmupPrompt includes code/difficulty/score and asks for directions only', () => {
    const p = buildWarmupPrompt({ unique_code: 'a-01', description: '某系统', difficulty: 'easy', total_score: 300 })
    expect(p).toContain('a-01')
    expect(p).toContain('easy')
    expect(p).toContain('300')
    expect(p).toContain('方向/打点')
  })
  it('attachmentLikely detects 附件/源码/下载 keywords, ignores plain container text', () => {
    expect(attachmentLikely('下载附件, 里面是 source.py 与 output.txt')).toBe(true)
    expect(attachmentLikely('某企业官网入口 /b02/ 目录')).toBe(false)
    expect(attachmentLikely(undefined)).toBe(false)
  })
  it('attachmentFetchCandidates returns container-relative paths', () => {
    const c = attachmentFetchCandidates('g-25')
    expect(c.some(p => p.includes('g-25') || p.includes('g25'))).toBe(true)
    expect(c).toContain('/download')
  })
})

// ── v8.4 纯函数 ─────────────────────────────────────────────────────
describe('v8.4 familyOf 家族判定', () => {
  it('rev·VM/字节码', () => {
    expect(familyOf('某嵌入式设备厂商自研了一套内部执行机制来承载访问码校验')).toBe('rev-vm')
    expect(familyOf('bytecode vm')).toBe('rev-vm')
  })
  it('rev·序列号 / 授权客户端', () => {
    expect(familyOf('固件序列号校验器')).toBe('rev-serial')
    expect(familyOf('跨平台授权客户端')).toBe('rev-license')
  })
  it('web·多跳链 / 单机管理台 / ai·推理 / easy 收割', () => {
    expect(familyOf('某大型企业遭遇APT攻击, 官网入口, 内网横向, 泛微OA')).toBe('web-chain')
    expect(familyOf('企业级 Serverless 云函数管理控制台, 认证网关迁移')).toBe('web-console')
    expect(familyOf('请对目标AI推理服务')).toBe('ai-service')
    expect(familyOf('公司内部系统', 'easy')).toBe('easy-harvest')
  })
})

describe('v8.4 hintGateV2 客观判死闸', () => {
  it('settleNoFlag≥2 → 直接放行(不等 R2)', () => {
    expect(hintGateV2({ ideaRound: 1, settleNoFlag: 2, blockerConfirmed: false }).allowed).toBe(true)
  })
  it('ideaRound≥2 且 settleNoFlag≥1 → 放行', () => {
    expect(hintGateV2({ ideaRound: 2, settleNoFlag: 1, blockerConfirmed: false }).allowed).toBe(true)
  })
  it('blocker 被验证兵确认 → 放行', () => {
    expect(hintGateV2({ ideaRound: 1, settleNoFlag: 0, blockerConfirmed: true }).allowed).toBe(true)
  })
  it('零败绩 → 拒绝并给出缺项', () => {
    const g = hintGateV2({ ideaRound: 1, settleNoFlag: 0, blockerConfirmed: false })
    expect(g.allowed).toBe(false)
    expect(g.missing.length).toBe(2)
  })
})

describe('v8.4 sealedClustersOf 死路封印簇', () => {
  it('同方向 ≥3 条 → 成簇', () => {
    const clusters = sealedClustersOf([
      { path: '网关身份头: X-Auth-User' },
      { path: '网关身份头: X-Remote-User' },
      { path: '网关身份头: X-Forwarded-User' },
      { path: 'JWT alg=none' },
    ])
    expect(clusters).toEqual([{ direction: '网关身份头', count: 3 }])
  })
  it('不足 3 条不成簇', () => {
    expect(sealedClustersOf([{ path: 'A: 1' }, { path: 'A: 2' }, { path: 'B: 1' }])).toEqual([])
  })
})

describe('v8.4 parseHandoffForks 交接未竟动作', () => {
  it('抽取未竟/下一步行', () => {
    const text = '结论: 未破。\n- 未竟动作: 读 /root/credentials.zip\n- 下一步: 慢节奏试 fileserver SSH\n常规行不抽'
    const forks = parseHandoffForks(text)
    expect(forks.length).toBe(2)
    expect(forks[0]!.conclusion).toContain('credentials.zip')
    expect(forks[1]!.conclusion).toContain('fileserver SSH')
  })
})

describe('v8.4 gradedLine 分级账本行', () => {
  it('结论带过程(已试清单+来源)', () => {
    const line = gradedLine({
      kind: 'dead-end', path: '字段名保留点号', conclusion: '任何 Content-Type 都无法存活',
      testedVariants: ['urlencoded 点号', 'multipart 点号'], by: 'exec#s1-w1', at: 0,
    })
    expect(line).toContain('[已试: urlencoded 点号; multipart 点号]')
    expect(line).toContain('[by exec#s1-w1')
  })
})

describe('v8.4 模板库', () => {
  it('七族齐全且内容非空', () => {
    const fams = TEMPLATE_LIBRARY.map(t => t.family)
    expect(fams).toEqual(['rev-vm', 'rev-serial', 'rev-license', 'web-chain', 'web-console', 'ai-service', 'easy-harvest'])
    for (const t of TEMPLATE_LIBRARY) {
      expect(t.tactics.length).toBeGreaterThan(100)
      expect(t.traps.length).toBeGreaterThan(20)
    }
  })
  it('templateOf 查表', () => {
    expect(templateOf('rev-vm')?.name).toContain('VM')
    expect(templateOf('nope')).toBeUndefined()
  })
})
