#!/usr/bin/env node
/**
 * mock-tsecbench —— 本地干跑台(无需平台/无需 VPN): 模拟 tsecbench 六原语,
 * 让完整插件链(夜不收 runner × 虎符 × 集思 × 行营)在本地 docker 沙箱内
 * 对假题集打一场真实战役。用途: 每次改代码后先本地干跑验证机制,
 * 再走托管验证轮, 最后正式局。
 *
 * 题目设计: 每题 flag 藏在题面里(base64), 执行者读题面→解码→submit。
 * 这样"读题/解/交卷/战报/画像/账本"全链路都被真实走一遍,
 * 但单题 1-3 分钟、整场 ~15 分钟、token 费 ¥1-3。
 *
 * 用法: node tools/mock-tsecbench.mjs [port]  (默认 8399)
 */
import http from 'node:http'

const PORT = Number(process.argv[2] ?? 8399)
const TOKEN = 'mock-benchmark-token'

const FLAGS = [
  'mock{loc4l_dryrun_01}',
  'mock{loc4l_dryrun_02}',
  'mock{loc4l_dryrun_03}',
  'mock{loc4l_dryrun_04}',
  'mock{loc4l_dryrun_05}',
  'mock{loc4l_dryrun_06}',
]
const challenges = FLAGS.map((flag, i) => {
  const b64 = Buffer.from(flag).toString('base64')
  return {
    unique_code: `g-m${i + 1}`,
    difficulty: i < 2 ? 'easy' : i < 4 ? 'medium' : 'hard',
    total_score: i < 2 ? 300 : i < 4 ? 500 : 1000,
    flag_count: 1,
    correct_flag_count: 0,
    is_completed: false,
    container_status: 'available',
    container_addr: [],
    description: `mock 题 g-m${i + 1}: 计算 base64 字符串 ${b64} 的原文并提交 flag{原文}。无需容器; 工具只用 bash(echo <b64> | base64 -d)。`,
  }
})
const hints = { 'g-m1': 'base64 -d 是标准工具', 'g-m2': 'base64 -d 是标准工具' }

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const auth = req.headers.authorization
  if (url.pathname !== '/health' && auth !== `Bearer ${TOKEN}`) {
    return json(res, 401, { detail: 'unauthorized' })
  }
  const p = url.pathname
  const q = url.searchParams

  if (p === '/health') return json(res, 200, { status: 'ok', ok: true, mock: 'dryrun' })
  if (p === '/openapi/v1/challenges' && req.method === 'GET') {
    return json(res, 200, { challenges })
  }
  if (p === '/openapi/v1/challenges/start' && req.method === 'POST') {
    const code = q.get('unique_code')
    const ch = challenges.find(c => c.unique_code === code)
    if (!ch) return json(res, 404, { detail: 'unknown challenge' })
    ch.container_status = 'running'
    ch.container_addr = [`10.0.100.${20 + challenges.indexOf(ch)}`]
    return json(res, 200, { container_addr: ch.container_addr })
  }
  if (p === '/openapi/v1/challenges/submit' && req.method === 'POST') {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const { unique_code, flag } = JSON.parse(body || '{}')
      const ch = challenges.find(c => c.unique_code === unique_code)
      if (!ch) return json(res, 404, { detail: 'unknown challenge' })
      const correct = ch.correct_flag_count === 0 && flag === FLAGS[challenges.indexOf(ch)]
      if (correct) {
        ch.correct_flag_count = 1
        ch.is_completed = true
      }
      return json(res, 200, {
        correct,
        awarded: correct ? ch.total_score : 0,
        cumulative_score: challenges.filter(c => c.is_completed).reduce((s, c) => s + c.total_score, 0),
        correct_flag_count: ch.correct_flag_count,
        total_flag_count: ch.flag_count,
        matched_flag_index: correct ? 0 : null,
      })
    })
    return
  }
  if (p === '/openapi/v1/challenges/close' && req.method === 'POST') {
    const code = q.get('unique_code')
    const ch = challenges.find(c => c.unique_code === code)
    if (ch) { ch.container_status = 'available'; ch.container_addr = [] }
    return json(res, 200, { closed: true })
  }
  if (p === '/openapi/v1/challenges/hint' && req.method === 'GET') {
    const code = q.get('unique_code')
    return json(res, 200, { hint: hints[code] ?? '这题用标准库就够' })
  }
  return json(res, 404, { detail: `no mock route: ${req.method} ${p}` })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`mock-tsecbench listening on :${PORT} (token=${TOKEN})`)
})
