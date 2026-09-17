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
  /** v7.9: 机制自动盖的时间戳(追加顺序=权威序, 后者覆盖前者)——不靠子代理自标记。 */
  at?: number
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
    existing.at = Date.now() // v7.9: 时间戳随新证据刷新——"后者覆盖前者"由 at 排序体现。
    profile.observedAt = Date.now()
    return profile
  }
  profile.facts.push({ ...fact, confidence: fact.confidence ?? 'likely', at: Date.now() })
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
    '> 本文件规则(机制保证, 勿违反):',
    '> 1. **同主题多条记录, 后者覆盖前者**——以最新一条为准(按时间倒序排列, 最新在最上);',
    '> 2. 路径/脚本类记录使用前先 ls 验证存在性(文件可能已被换名/删除);',
    '> 3. 每条记录的时间戳由机制自动盖, 无需你标注来源。',
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
    // v7.9: 时间倒序渲染——最新在最上, "后者覆盖前者"由排序自然体现(零遍历标记旧记录)。
    const ordered = [...facts].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    for (const fact of ordered) {
      lines.push(`- ${fact.note}${fact.confidence === 'confirmed' ? '（已确认）' : ''}${fact.at !== undefined ? ` [${new Date(fact.at).toISOString().slice(0, 16).replace('T', ' ')}]` : ''}`)
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
      // v7.9: 剥离机制时间戳后缀 [YYYY-MM-DD HH:MM](若有), 时间戳回填 at。
      const m = note.match(/^(.*?)\s\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]$/)
      const raw = m !== null ? m[1]! : note
      let at: number | undefined
      if (m !== null) {
        const parsedAt = Date.parse(m[2]!.replace(' ', 'T') + ':00Z')
        if (!Number.isNaN(parsedAt)) at = parsedAt
      }
      const confirmed = raw.endsWith('（已确认）')
      profile.facts.push({
        kind: currentKind,
        note: confirmed ? raw.slice(0, -5) : raw,
        confidence: confirmed ? 'confirmed' : 'likely',
        ...(at !== undefined ? { at } : {}),
      })
    }
  }
  return profile
}
