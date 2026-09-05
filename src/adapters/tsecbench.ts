/**
 * 校场：tsecbench 平台适配器（openapi 客户端，注入 fetch，纯逻辑可测）。
 * 六原语：列题/启动/提交/关闭/hint/健康（VPN 网关）。
 * @module @shence/yebushou/adapters/tsecbench
 */

export interface TsecbenchConfig {
  baseURL: string
  benchmarkToken: string
  vpnGateway: string
}

export interface ChallengeInfo {
  unique_code: string
  difficulty: string
  total_score: number
  flag_count: number
  correct_flag_count: number
  is_completed: boolean
  container_status: string
  container_addr: string[]
  description: string
}

export interface SubmitResult {
  correct: boolean
  awarded: number
  cumulative_score: number
  correct_flag_count: number
  total_flag_count: number
  matched_flag_index: number | null
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export class TsecbenchAdapter {
  constructor(
    private readonly config: TsecbenchConfig,
    private readonly fetch: FetchLike,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { BENCHMARK_TOKEN: this.config.benchmarkToken, 'Content-Type': 'application/json', ...extra }
  }

  async listChallenges(): Promise<ChallengeInfo[]> {
    const res = await this.fetch(`${this.config.baseURL}/openapi/v1/challenges`, { headers: this.headers() })
    if (!res.ok) throw new Error(`tsecbench: listChallenges failed (${res.status})`)
    const data = await res.json() as ChallengeInfo[] | { challenges: ChallengeInfo[] }
    return Array.isArray(data) ? data : data.challenges
  }

  /** 完成口径：按 is_completed 统计（权威，score_events 有滞后）。 */
  scoreOf(challenges: ChallengeInfo[]): { completed: number; score: number; max: number } {
    let score = 0
    let completed = 0
    for (const c of challenges) {
      if (c.is_completed) {
        completed += 1
        score += c.total_score
      }
    }
    return { completed, score, max: challenges.reduce((sum, c) => sum + c.total_score, 0) }
  }

  async start(uniqueCode: string): Promise<{ container_addr: string[] }> {
    const res = await this.fetch(`${this.config.baseURL}/openapi/v1/challenges/start?unique_code=${encodeURIComponent(uniqueCode)}`, { method: 'POST', headers: this.headers() })
    if (!res.ok) throw new Error(`tsecbench: start ${uniqueCode} failed (${res.status}): ${JSON.stringify(await res.json())}`)
    return await res.json() as { container_addr: string[] }
  }

  async submit(uniqueCode: string, flag: string): Promise<SubmitResult> {
    const res = await this.fetch(`${this.config.baseURL}/openapi/v1/challenges/submit`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ unique_code: uniqueCode, flag }),
    })
    if (!res.ok) throw new Error(`tsecbench: submit ${uniqueCode} failed (${res.status}): ${JSON.stringify(await res.json())}`)
    return await res.json() as SubmitResult
  }

  async close(uniqueCode: string): Promise<void> {
    const res = await this.fetch(`${this.config.baseURL}/openapi/v1/challenges/close?unique_code=${encodeURIComponent(uniqueCode)}`, { method: 'POST', headers: this.headers() })
    if (!res.ok) throw new Error(`tsecbench: close ${uniqueCode} failed (${res.status})`)
  }

  async hint(uniqueCode: string): Promise<unknown> {
    const res = await this.fetch(`${this.config.baseURL}/openapi/v1/challenges/hint?unique_code=${encodeURIComponent(uniqueCode)}`, { headers: this.headers() })
    if (!res.ok) throw new Error(`tsecbench: hint ${uniqueCode} failed (${res.status})`)
    return await res.json()
  }

  /** VPN 网关健康预检（status==ok 才可打）。 */
  async gatewayHealthy(): Promise<boolean> {
    try {
      const res = await this.fetch(this.config.vpnGateway)
      const data = await res.json() as { status?: string }
      return data.status === 'ok'
    } catch {
      return false
    }
  }
}
