/**
 * 夜不收组织画像格式（纯逻辑）：创建/追加事实（去重）/渲染/解析。
 * 画像 = 本地运行产物（local/profiles/<org>.md），不随技能发布。
 * @module @shence/yebushou/profile
 */

export type FactKind = 'tech-stack' | 'default-creds' | 'port-pattern' | 'defense' | 'style' | 'intel-source' | 'other'

export interface OrgFact {
  kind: FactKind
  note: string
  confidence?: 'confirmed' | 'likely'
}

export interface OrgProfile {
  org: string
  observedAt: number
  facts: OrgFact[]
}

const FRONTMATTER = 'yebushou-profile'

export function createProfile(org: string, observedAt = Date.now()): OrgProfile {
  return { org, observedAt, facts: [] }
}

/** 追加事实：同 kind+note 去重；新事实置信度缺省 likely。 */
export function addFact(profile: OrgProfile, fact: OrgFact): OrgProfile {
  const existing = profile.facts.find(f => f.kind === fact.kind && f.note === fact.note)
  if (existing !== undefined) {
    // 已有事实：升级为 confirmed（若有新证据），更新时间戳。
    if (fact.confidence === 'confirmed') existing.confidence = 'confirmed'
    profile.observedAt = Date.now()
    return profile
  }
  profile.facts.push({ ...fact, confidence: fact.confidence ?? 'likely' })
  profile.observedAt = Date.now()
  return profile
}

/** 渲染为 markdown（画像文件内容）。 */
export function render(profile: OrgProfile): string {
  const lines = [
    '---',
    FRONTMATTER,
    `org: ${profile.org}`,
    `observed_at: ${new Date(profile.observedAt).toISOString()}`,
    '---',
    `# 组织画像：${profile.org}`,
    '',
  ]
  const byKind = new Map<FactKind, OrgFact[]>()
  for (const fact of profile.facts) {
    const list = byKind.get(fact.kind) ?? []
    list.push(fact)
    byKind.set(fact.kind, list)
  }
  const kindNames: Record<FactKind, string> = {
    'tech-stack': '技术栈',
    'default-creds': '默认凭据',
    'port-pattern': '端口惯例',
    'defense': '已知防御',
    'style': '开发风格',
    'intel-source': '公开信息源',
    'other': '其他',
  }
  for (const kind of Object.keys(kindNames) as FactKind[]) {
    const facts = byKind.get(kind)
    if (facts === undefined) continue
    lines.push(`## ${kindNames[kind]}`)
    for (const fact of facts) {
      lines.push(`- ${fact.note}${fact.confidence === 'confirmed' ? '（已确认）' : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** 解析 markdown 画像文件。 */
export function parse(content: string): OrgProfile {
  const lines = content.split('\n')
  let org = ''
  let observedAt = Date.now()
  if (lines[0] === '---' && lines[1] === FRONTMATTER) {
    for (const line of lines) {
      if (line.startsWith('org: ')) org = line.slice(5).trim()
      if (line.startsWith('observed_at: ')) {
        const parsed = Date.parse(line.slice(13).trim())
        if (!Number.isNaN(parsed)) observedAt = parsed
      }
      if (line === '---' && org.length > 0) break
    }
  }
  const profile = createProfile(org, observedAt)
  const kindMap: Record<string, FactKind> = {
    '技术栈': 'tech-stack',
    '默认凭据': 'default-creds',
    '端口惯例': 'port-pattern',
    '已知防御': 'defense',
    '开发风格': 'style',
    '公开信息源': 'intel-source',
    '其他': 'other',
  }
  let currentKind: FactKind | undefined
  for (const line of lines) {
    if (line.startsWith('## ')) {
      currentKind = kindMap[line.slice(3).trim()]
      continue
    }
    if (line.startsWith('- ') && currentKind !== undefined) {
      const note = line.slice(2)
      const confirmed = note.endsWith('（已确认）')
      profile.facts.push({
        kind: currentKind,
        note: confirmed ? note.slice(0, -5) : note,
        confidence: confirmed ? 'confirmed' : 'likely',
      })
    }
  }
  return profile
}
