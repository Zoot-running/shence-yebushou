// src/index.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync, readdirSync as readdirSync2, renameSync as renameSync2, statSync as statSync2, writeFileSync, appendFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

// ../../src/hint-ledger.ts
var HintLedger = class _HintLedger {
  records = /* @__PURE__ */ new Map();
  /** 记一次 hint；返回本次扣分。 */
  record(challengeCode, fullScore, reason) {
    const cost = Math.max(1, Math.ceil(fullScore * 0.1));
    const rec = this.records.get(challengeCode) ?? { challengeCode, hints: 0, deducted: 0, reasons: [] };
    rec.hints += 1;
    rec.deducted += cost;
    rec.reasons.push(reason);
    this.records.set(challengeCode, rec);
    return cost;
  }
  get(challengeCode) {
    return this.records.get(challengeCode);
  }
  all() {
    return [...this.records.values()];
  }
  totalDeducted() {
    return this.all().reduce((sum, r) => sum + r.deducted, 0);
  }
  totalHints() {
    return this.all().reduce((sum, r) => sum + r.hints, 0);
  }
  /** 序列化（随 run 归档）。 */
  dump() {
    return this.all().map((r) => ({ ...r, reasons: [...r.reasons] }));
  }
  static restore(records) {
    const ledger = new _HintLedger();
    for (const rec of records) {
      ledger.records.set(rec.challengeCode, { ...rec, reasons: [...rec.reasons] });
    }
    return ledger;
  }
};

// ../../src/profile.ts
var FRONTMATTER = "yebushou-profile";
function createProfile(org, observedAt = Date.now()) {
  return { org, observedAt, facts: [] };
}
function addFact(profile, fact) {
  const existing = profile.facts.find((f) => f.kind === fact.kind && f.note === fact.note);
  if (existing !== void 0) {
    if (fact.confidence === "confirmed") existing.confidence = "confirmed";
    profile.observedAt = Date.now();
    return profile;
  }
  profile.facts.push({ ...fact, confidence: fact.confidence ?? "likely" });
  profile.observedAt = Date.now();
  return profile;
}
function render(profile) {
  const lines = [
    "---",
    FRONTMATTER,
    `org: ${profile.org}`,
    `observed_at: ${new Date(profile.observedAt).toISOString()}`,
    "---",
    `# \u7EC4\u7EC7\u753B\u50CF\uFF1A${profile.org}`,
    ""
  ];
  const byKind = /* @__PURE__ */ new Map();
  for (const fact of profile.facts) {
    const list = byKind.get(fact.kind) ?? [];
    list.push(fact);
    byKind.set(fact.kind, list);
  }
  const kindNames = {
    "tech-stack": "\u6280\u672F\u6808",
    "default-creds": "\u9ED8\u8BA4\u51ED\u636E",
    "port-pattern": "\u7AEF\u53E3\u60EF\u4F8B",
    "defense": "\u5DF2\u77E5\u9632\u5FA1",
    "style": "\u5F00\u53D1\u98CE\u683C",
    "intel-source": "\u516C\u5F00\u4FE1\u606F\u6E90",
    "other": "\u5176\u4ED6"
  };
  for (const kind of Object.keys(kindNames)) {
    const facts = byKind.get(kind);
    if (facts === void 0) continue;
    lines.push(`## ${kindNames[kind]}`);
    for (const fact of facts) {
      lines.push(`- ${fact.note}${fact.confidence === "confirmed" ? "\uFF08\u5DF2\u786E\u8BA4\uFF09" : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
function parse(content) {
  const lines = content.split("\n");
  let org = "";
  let observedAt = Date.now();
  if (lines[0] === "---" && lines[1] === FRONTMATTER) {
    for (const line of lines) {
      if (line.startsWith("org: ")) org = line.slice(5).trim();
      if (line.startsWith("observed_at: ")) {
        const parsed = Date.parse(line.slice(13).trim());
        if (!Number.isNaN(parsed)) observedAt = parsed;
      }
      if (line === "---" && org.length > 0) break;
    }
  }
  const profile = createProfile(org, observedAt);
  const kindMap = {
    "\u6280\u672F\u6808": "tech-stack",
    "\u9ED8\u8BA4\u51ED\u636E": "default-creds",
    "\u7AEF\u53E3\u60EF\u4F8B": "port-pattern",
    "\u5DF2\u77E5\u9632\u5FA1": "defense",
    "\u5F00\u53D1\u98CE\u683C": "style",
    "\u516C\u5F00\u4FE1\u606F\u6E90": "intel-source",
    "\u5176\u4ED6": "other"
  };
  let currentKind;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      currentKind = kindMap[line.slice(3).trim()];
      continue;
    }
    if (line.startsWith("- ") && currentKind !== void 0) {
      const note = line.slice(2);
      const confirmed = note.endsWith("\uFF08\u5DF2\u786E\u8BA4\uFF09");
      profile.facts.push({
        kind: currentKind,
        note: confirmed ? note.slice(0, -5) : note,
        confidence: confirmed ? "confirmed" : "likely"
      });
    }
  }
  return profile;
}

// ../../src/adapters/tsecbench.ts
var TsecbenchAdapter = class {
  constructor(config, fetch2) {
    this.config = config;
    this.fetch = fetch2;
  }
  config;
  fetch;
  headers(extra) {
    return { BENCHMARK_TOKEN: this.config.benchmarkToken, "Content-Type": "application/json", ...extra };
  }
  async listChallenges() {
    const res = await this.fetch(`${this.config.baseURL}/openapi/v1/challenges`, { headers: this.headers() });
    if (!res.ok) throw new Error(`tsecbench: listChallenges failed (${res.status})`);
    const data = await res.json();
    return Array.isArray(data) ? data : data.challenges;
  }
  /** 完成口径：按 is_completed 统计（权威，score_events 有滞后）。 */
  scoreOf(challenges) {
    let score = 0;
    let completed = 0;
    for (const c of challenges) {
      if (c.is_completed) {
        completed += 1;
        score += c.total_score;
      }
    }
    return { completed, score, max: challenges.reduce((sum, c) => sum + c.total_score, 0) };
  }
  async start(uniqueCode) {
    const res = await this.fetch(`${this.config.baseURL}/openapi/v1/challenges/start?unique_code=${encodeURIComponent(uniqueCode)}`, { method: "POST", headers: this.headers() });
    if (!res.ok) throw new Error(`tsecbench: start ${uniqueCode} failed (${res.status}): ${JSON.stringify(await res.json())}`);
    return await res.json();
  }
  async submit(uniqueCode, flag) {
    const res = await this.fetch(`${this.config.baseURL}/openapi/v1/challenges/submit`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ unique_code: uniqueCode, flag })
    });
    if (!res.ok) throw new Error(`tsecbench: submit ${uniqueCode} failed (${res.status}): ${JSON.stringify(await res.json())}`);
    return await res.json();
  }
  async close(uniqueCode) {
    const res = await this.fetch(`${this.config.baseURL}/openapi/v1/challenges/close?unique_code=${encodeURIComponent(uniqueCode)}`, { method: "POST", headers: this.headers() });
    if (!res.ok) throw new Error(`tsecbench: close ${uniqueCode} failed (${res.status})`);
  }
  async hint(uniqueCode) {
    const res = await this.fetch(`${this.config.baseURL}/openapi/v1/challenges/hint?unique_code=${encodeURIComponent(uniqueCode)}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`tsecbench: hint ${uniqueCode} failed (${res.status})`);
    return await res.json();
  }
  /** VPN 网关健康预检（status==ok 才可打）。 */
  async gatewayHealthy() {
    try {
      const res = await this.fetch(this.config.vpnGateway);
      const data = await res.json();
      return data.status === "ok";
    } catch {
      return false;
    }
  }
};

// src/orchestrator.ts
import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
function sweepLegacyWorkdir(cwd, startedAt, archiveRel) {
  const KEEP_DIRS = /* @__PURE__ */ new Set([".venv", ".gocache", ".gopath", ".g10test", ".git", "node_modules", ".archive"]);
  const KEEP_FILE_RE = /^run\d+-(launch|order)\.(sh|txt)$/;
  let moved = 0;
  try {
    for (const name2 of readdirSync(cwd)) {
      if (name2.startsWith(".") && !name2.startsWith(".run")) continue;
      if (KEEP_DIRS.has(name2)) continue;
      if (KEEP_FILE_RE.test(name2)) continue;
      const full = join(cwd, name2);
      const stat = statSync(full);
      if (stat.mtimeMs >= startedAt) continue;
      mkdirSync(join(cwd, archiveRel), { recursive: true });
      renameSync(full, join(cwd, archiveRel, name2));
      moved += 1;
    }
  } catch {
  }
  return moved;
}
function cleanRoomGate(code, localFiles) {
  const hits = [];
  for (const { file, text } of localFiles) {
    if (text.includes(code)) hits.push(file);
  }
  return { contaminated: hits.length > 0, hits };
}
function codeOf(itemId) {
  const match = /^(.+?)#s?\d+/.exec(itemId);
  return match !== null ? match[1] : itemId;
}
function roundOf(itemId) {
  const match = /#s?(\d+)/.exec(itemId);
  const parsed = match !== null ? Number(match[1]) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}
function baseId(itemId) {
  return itemId.replace(/-r\d+$/, "");
}
function parseObservations(text, cap = 5) {
  const section = /OBSERVATIONS\s*[:：]([\s\S]*)$/i.exec(text);
  if (section === null) return [];
  const out = [];
  for (const line of section[1].split("\n")) {
    const body = line.replace(/^[-*\d.\s]+/, "").trim();
    if (body === "" || body.toLowerCase().includes("flag{")) continue;
    out.push(body.slice(0, 200));
    if (out.length >= cap) break;
  }
  return out;
}
function resolveExecutor(requested, policy) {
  if (policy.locked) {
    return {
      model: policy.defaultModel,
      effort: policy.defaultEffort,
      overriddenByLock: requested.model !== void 0 && requested.model !== policy.defaultModel || requested.effort !== void 0 && requested.effort !== policy.defaultEffort
    };
  }
  return {
    model: requested.model ?? policy.defaultModel,
    effort: requested.effort ?? policy.defaultEffort,
    overriddenByLock: false
  };
}
var RunProgress = class _RunProgress {
  records = /* @__PURE__ */ new Map();
  static fromJSON(data) {
    const progress = new _RunProgress();
    const records = data?.challenges ?? [];
    for (const record of records) {
      if (record?.code === void 0) continue;
      progress.records.set(record.code, {
        code: record.code,
        difficulty: record.difficulty ?? "unknown",
        state: record.state ?? "solving",
        reason: record.reason,
        rounds: record.rounds ?? 0,
        flags: record.flags ?? [],
        containerClosed: record.containerClosed ?? false
      });
    }
    return progress;
  }
  static restore(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.trim() === "") continue;
      try {
        return _RunProgress.fromJSON(JSON.parse(line));
      } catch {
      }
    }
    return new _RunProgress();
  }
  update(code, patch) {
    const current = this.records.get(code) ?? {
      code,
      difficulty: "unknown",
      state: "solving",
      rounds: 0,
      flags: [],
      containerClosed: false
    };
    this.records.set(code, { ...current, ...patch, code });
  }
  get(code) {
    return this.records.get(code);
  }
  all() {
    return [...this.records.values()];
  }
  completedCodes() {
    return this.all().filter((p) => p.state === "complete").map((p) => p.code);
  }
  skippedCodes() {
    return this.all().filter((p) => p.state === "skipped").map((p) => p.code);
  }
  /** 单行 JSONL 快照。 */
  line() {
    return JSON.stringify({ at: Date.now(), challenges: this.all() });
  }
};

// src/index.ts
var name = "shence-xiaochang-runner";
var inject = ["tools", "hufu", "jisi"];
function tierOf(difficulty) {
  if (difficulty === "easy") return 0;
  if (difficulty === "medium") return 1;
  if (difficulty === "hard") return 2;
  return 3;
}
function nodeFetch() {
  return async (url, init = {}) => {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body
    });
    return {
      ok: res.ok,
      status: res.status,
      json: async () => await res.json()
    };
  };
}
function classifyQtype(text) {
  const t = text.toLowerCase();
  if (/(web|http|ssrf|xss|sqli?|csrf|javascript|php|flask|django|server|登录|接口|上传|rce.*web)/.test(t)) return "web";
  if (/(rsa|aes|crypto|密文|加密|解密|elliptic|ecc|hash|padding)/.test(t)) return "crypto";
  if (/(pwn|overflow|shellcode|rop|ret2|heap|栈|溢出|binary|elf|got)/.test(t)) return "pwn";
  if (/(reverse|reversing|反编译|汇编|disassemble|ida|ghidra|逆向)/.test(t)) return "rev";
  if (/(forensic|取证|pcap|流量|内存|disk|文件系统)/.test(t)) return "forensics";
  return "misc";
}
function difficultyPrior(score) {
  return Math.min(100, Math.round(100 * (1 - Math.exp(-score / 600))));
}
function calibrateDifficulty(q) {
  const k = 5;
  const p0 = 1 - q.difficulty / 100;
  const a = p0 * k + q.wins;
  const b = (1 - p0) * k + q.fails;
  return Math.round(100 * (1 - a / (a + b)));
}
var state;
var heartbeatTimer;
function requireState() {
  if (state === void 0) throw new Error("xiaochang: not set up \u2014 call xiaochang_setup first");
  return state;
}
function audit(path, line) {
  try {
    appendFileSync(path, `${JSON.stringify(line)}
`);
  } catch {
  }
}
function persistV2(s) {
  try {
    writeFileSync(s.v2Path, JSON.stringify(s.v2));
  } catch {
  }
}
function persistProgress(s) {
  try {
    mkdirSync2(join2(s.snapshotPath, ".."), { recursive: true });
    appendFileSync(s.snapshotPath, `${s.progress.line()}
`);
  } catch {
  }
}
function persistProfile(s) {
  try {
    mkdirSync2(join2(s.profilePath, ".."), { recursive: true });
    writeFileSync(s.profilePath, render(s.profile));
  } catch {
  }
}
function openContainers(s) {
  const open = /* @__PURE__ */ new Set();
  for (const c of s.challenges.values()) {
    if (c.container_status === "available" || c.container_status === "pending") open.add(c.unique_code);
  }
  return open;
}
function openCount(campaign) {
  return campaign.ledger.views().filter((v) => v.state === "dispatched" || v.state === "help" || v.state === "stalled").length;
}
function walk(dir) {
  const out = [];
  for (const name2 of readdirSync2(dir)) {
    const full = join2(dir, name2);
    const stat = statSync2(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
function scanLegacyCwd(cwd, startedAt) {
  const out = [];
  const consider = (full) => {
    try {
      if (statSync2(full).mtimeMs < startedAt) out.push(full);
    } catch {
    }
  };
  try {
    for (const name2 of readdirSync2(cwd)) {
      if (!/^g[-_]?\d/.test(name2) && name2 !== "boards") continue;
      const full = join2(cwd, name2);
      const stat = statSync2(full);
      if (stat.isDirectory()) {
        if (name2 === "boards") {
          for (const entry of readdirSync2(full)) {
            const nested = join2(full, entry);
            try {
              if (statSync2(nested).isDirectory()) {
                for (const inner of readdirSync2(nested)) {
                  if (inner === "FINDINGS.md") consider(join2(nested, inner));
                }
              }
            } catch {
            }
          }
        } else {
          for (const file of walk(full)) {
            if (file.endsWith(".md") || file.endsWith(".txt") || file.endsWith(".py") || file.endsWith(".json") || file.endsWith(".html") || file.endsWith(".sh")) consider(file);
          }
        }
      } else {
        consider(full);
      }
    }
  } catch {
  }
  return out;
}
function apply(ctx) {
  const jisi = ctx.get?.("jisi");
  const holder = ctx.hufu;
  let campaign;
  let campaignId;
  let parentAgent;
  heartbeatTimer = setInterval(() => {
    const home = process.env.DSH_HOME ?? ".";
    audit(join2(home, "storages", "xiaochang-run-audit.jsonl"), { type: "heartbeat", at: Date.now() });
  }, 12e4);
  heartbeatTimer.unref?.();
  const c = () => {
    if (campaign === void 0) throw new Error("xiaochang: not set up \u2014 call xiaochang_setup first");
    return campaign;
  };
  const forkInboxDir = () => join2(process.env.DSH_HOME ?? ".", "storages", "xiaochang-fork-inbox");
  function readForkInbox(code) {
    const p = join2(forkInboxDir(), `${code}.jsonl`);
    if (!existsSync(p)) return [];
    const out = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line));
      } catch {
      }
    }
    return out;
  }
  function writeForkInbox(code, entries) {
    mkdirSync2(forkInboxDir(), { recursive: true });
    const p = join2(forkInboxDir(), `${code}.jsonl`);
    appendFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return p;
  }
  function absorbForkInbox(code) {
    const p = join2(forkInboxDir(), `${code}.jsonl`);
    if (!existsSync(p)) return;
    const entries = readForkInbox(code);
    if (entries.length > 0) {
      const seen = /* @__PURE__ */ new Set();
      for (const v of campaign?.ledger.views() ?? []) {
        if (codeOf(v.item.id) !== code) continue;
        for (const k of campaign?.knowledgeOf?.(v.item.id) ?? []) {
          seen.add(`${k.path}#${k.at ?? 0}`);
        }
      }
      const fresh = entries.filter((e) => !seen.has(`${e.path}#${e.at ?? 0}`));
      if (fresh.length > 0) {
        for (const v of campaign?.ledger.views() ?? []) {
          if (codeOf(v.item.id) !== code) continue;
          try {
            holder.recordKnowledge?.(campaignId ?? "", v.item.id, fresh);
          } catch {
          }
        }
      }
    }
    try {
      renameSync2(p, `${p}.absorbed-${Date.now()}`);
    } catch {
    }
  }
  function knowledgeOfCode(code) {
    const out = [];
    if (campaign !== void 0) {
      for (const v of campaign.ledger.views()) {
        if (codeOf(v.item.id) !== code) continue;
        const k = campaign.knowledgeOf?.(v.item.id) ?? [];
        out.push(...k);
      }
    }
    out.push(...readForkInbox(code));
    return out;
  }
  function recordKnowledgeOnCode(code, entries) {
    if (campaign === void 0 || campaignId === void 0) return;
    for (const v of campaign.ledger.views()) {
      if (codeOf(v.item.id) !== code) continue;
      try {
        holder.recordKnowledge?.(campaignId, v.item.id, entries);
      } catch {
      }
    }
  }
  function renderKnowledge(code) {
    const ks = knowledgeOfCode(code);
    if (ks.length === 0) return "";
    const lines = ["\u5DF2\u77E5\u60C5\u62A5(\u81EA\u52A8\u9644\u5E26, \u524D\u5E8F\u6267\u884C\u8005\u6C89\u6DC0)"];
    for (const k of ks) {
      const tag = k.kind === "dead-end" ? "\u274C\u6B7B\u8DEF" : k.kind === "fork" ? "\u{1F500}\u672A\u8D70\u5206\u53C9" : "\u{1F4CC}\u4E8B\u5B9E";
      lines.push(`- [${tag}] ${k.path}${k.conclusion !== void 0 ? " \u2192 " + k.conclusion : ""}${k.evidence !== void 0 ? " (\u8BC1\u636E: " + k.evidence + ")" : ""}`);
    }
    return lines.join("\n");
  }
  const register = (tool) => ctx.tools.register(tool);
  register(defineTool({
    name: "xiaochang_setup",
    description: "Set up (or resume) the tsecbench campaign state: platform adapter, hufu campaign (large slots, no artificial threshold), progress/profile restore. Idempotent \u2014 calling again resumes from the snapshot.",
    parameters: {
      baseURL: { type: "string", description: "BENCHMARK_BASE_URL (defaults to env)." },
      benchmarkToken: { type: "string", description: "BENCHMARK_TOKEN (defaults to env)." },
      runBearerToken: { type: "string", description: "Platform session Bearer token for early finish (stop the ranking clock). Falls back to env RUN_BEARER_TOKEN \u2014 but pass it explicitly when the order gives it (env fallback only saves you if omitted)." },
      runId: { type: "number", description: "Platform run id." },
      concurrency: { type: "number", description: "Campaign slots. Default 999 (no artificial threshold; backpressure = CPU/RAM/provider limits only)." },
      budgetMinutes: { type: "number", description: "Wall-clock budget. Default 330." },
      roundTimeoutMinutes: { type: "number", description: "Auto-report a dispatched item as failed after this long. Default 30." },
      maxHintsPerChallenge: { type: "number", description: "Official hints per challenge (10% score each). Default 1." },
      knowledgeDir: { type: "string", description: "Local private knowledge dir for the clean-room gate." },
      profilePath: { type: "string", description: "Org-profile file path." },
      vpnGateway: { type: "string", description: "VPN gateway health URL. Default http://10.0.100.58." },
      defaultModel: { type: "string", description: "Executor default model when an item omits one. Default deepseek-v4-flash (you may set a per-run default that fits this run)." },
      defaultEffort: { type: "string", description: "Executor default reasoning effort. Default low." },
      modelLock: { type: "boolean", description: "Lock: force ALL executors to defaultModel/defaultEffort, ignoring per-item overrides (user/parent-agent override). Default false (main agent may switch models per item)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("xiaochang_setup requires a calling agent");
      parentAgent = agent;
      const env = process.env;
      const baseURL = args.baseURL ?? env.BENCHMARK_BASE_URL;
      const benchmarkToken = args.benchmarkToken ?? env.BENCHMARK_TOKEN;
      if (baseURL === void 0 || benchmarkToken === void 0) {
        return "xiaochang_setup: BENCHMARK_BASE_URL and BENCHMARK_TOKEN required (args or env)";
      }
      const home = env.DSH_HOME ?? ".";
      const snapshotPath = join2(home, "storages", `xiaochang-run-${args.runId ?? "pending"}.jsonl`);
      let progress = new RunProgress();
      let startedAt = Date.now();
      if (existsSync(snapshotPath)) {
        const lines = readFileSync(snapshotPath, "utf8").split("\n").filter((l) => l.trim() !== "");
        progress = RunProgress.restore(lines);
        const first = lines.length > 0 ? JSON.parse(lines[0]).at : void 0;
        if (first !== void 0) startedAt = first;
      }
      try {
        const markerPath = process.env.GUARD_MARKER ?? join2(process.cwd(), ".campaign-finished");
        if (existsSync(markerPath)) {
          const fs = await import("node:fs");
          fs.unlinkSync(markerPath);
        }
      } catch {
      }
      const s = {
        baseURL,
        benchmarkToken,
        // run 11 实锤：开战令写"工具会从进程环境读取"，但旧实现 runBearerToken 无 env 回退，
        // agent 省略传参 → finish 静默跳过平台停表 → 排名钟空转。补 env 回退（launch 脚本
        // 导出 RUN_BEARER_TOKEN；沙箱只挡 agent 的 bash 视图，插件进程 env 可见）。
        runBearerToken: args.runBearerToken ?? env.RUN_BEARER_TOKEN,
        runId: args.runId,
        concurrency: args.concurrency ?? 999,
        budgetMs: (args.budgetMinutes ?? 330) * 6e4,
        roundTimeoutMs: (args.roundTimeoutMinutes ?? 30) * 6e4,
        maxHints: args.maxHintsPerChallenge ?? 1,
        vpnGateway: args.vpnGateway ?? "http://10.0.100.58",
        knowledgeDir: args.knowledgeDir ?? join2(home, "storages", "xiaochang-knowledge"),
        profilePath: args.profilePath ?? join2(home, "storages", "xiaochang-profile.md"),
        snapshotPath,
        auditPath: join2(home, "storages", "xiaochang-run-audit.jsonl"),
        startedAt,
        adapter: new TsecbenchAdapter({ baseURL, benchmarkToken, vpnGateway: args.vpnGateway ?? "http://10.0.100.58" }, nodeFetch()),
        progress,
        profile: createProfile("tsecbench-set"),
        hintLedger: new HintLedger(),
        v2: {},
        v2Path: join2(home, "storages", `xiaochang-v2-${args.runId ?? "pending"}.json`),
        processed: /* @__PURE__ */ new Set(),
        challenges: /* @__PURE__ */ new Map(),
        executorPolicy: {
          defaultModel: args.defaultModel ?? "deepseek-v4-flash",
          defaultEffort: args.defaultEffort ?? "low",
          locked: args.modelLock ?? false
        }
      };
      try {
        if (existsSync(s.profilePath)) s.profile = parse(readFileSync(s.profilePath, "utf8"));
      } catch {
      }
      state = s;
      const stableId = `tsecbench-run-${args.runId ?? "pending"}`;
      const swept = sweepLegacyWorkdir(process.cwd(), s.startedAt, `.archive/${stableId}`);
      if (!await s.adapter.gatewayHealthy()) {
        return "xiaochang_setup: VPN gateway not healthy \u2014 connect the run VPN first (nothing registered; safe to retry)";
      }
      const fresh = await s.adapter.listChallenges();
      for (const ch of fresh) s.challenges.set(ch.unique_code, ch);
      if (campaign === void 0) {
        const created = holder.createCampaign(agent, {
          concurrency: s.concurrency,
          stallAfterMs: s.roundTimeoutMs + 10 * 6e4,
          heartbeatMs: 15 * 6e4,
          budgetMs: s.budgetMs
        }, [], { id: stableId, boardNamespace: `${args.runId ?? "pending"}` });
        campaign = created.campaign;
        campaignId = created.id;
      }
      persistProgress(s);
      try {
        if (existsSync(s.v2Path)) s.v2 = JSON.parse(readFileSync(s.v2Path, "utf8"));
        for (const ch of fresh) {
          if (s.v2[ch.unique_code] === void 0) {
            s.v2[ch.unique_code] = {
              qtype: classifyQtype(ch.description ?? ""),
              difficulty: difficultyPrior(ch.total_score),
              wins: 0,
              fails: 0,
              gaps: [],
              triedModels: [],
              ideaRound: 1,
              deadIdeas: 0,
              adopted: 0
            };
          }
        }
      } catch {
      }
      return `xiaochang_setup ok: ${fresh.length} challenges, concurrency=${s.concurrency} (no threshold), budget ${Math.round(s.budgetMs / 6e4)}min, resume=${progress.all().length > 0}, campaign=${campaignId ?? stableId}, swept=${swept}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_list",
    description: "List platform challenges with progress and clean-room verdicts. Auto-marks challenges skipped when the local knowledge dir mentions their code (hosted-rules gate). Returns per-challenge: code, difficulty, score, flag_count, completed, container_status, addrs, description, and progress state.",
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute() {
      const s = requireState();
      const fresh = await s.adapter.listChallenges();
      for (const ch of fresh) s.challenges.set(ch.unique_code, ch);
      const localFiles = [];
      if (existsSync(s.knowledgeDir)) {
        for (const file of walk(s.knowledgeDir)) {
          try {
            localFiles.push({ file, text: readFileSync(file, "utf8") });
          } catch {
          }
        }
      }
      const legacyWorkdirFiles = scanLegacyCwd(process.cwd(), s.startedAt);
      for (const file of legacyWorkdirFiles) {
        try {
          localFiles.push({ file, text: readFileSync(file, "utf8") });
        } catch {
        }
      }
      for (const ch of fresh) {
        if (s.progress.get(ch.unique_code) !== void 0) continue;
        const verdict = cleanRoomGate(ch.unique_code, localFiles);
        if (verdict.contaminated) {
          s.progress.update(ch.unique_code, { difficulty: ch.difficulty, state: "skipped", reason: `clean-room: local knowledge mentions ${ch.unique_code}`, containerClosed: true });
        }
      }
      persistProgress(s);
      const score = s.adapter.scoreOf(fresh);
      const rows = fresh.map((ch) => {
        const p = s.progress.get(ch.unique_code);
        return `${ch.unique_code} [${ch.difficulty}] ${ch.total_score}pts flags=${ch.correct_flag_count}/${ch.flag_count} completed=${ch.is_completed} container=${ch.container_status} addrs=${ch.container_addr.join(",") || "-"} progress=${p?.state ?? "fresh"} | ${ch.description ?? ""}`;
      });
      return `score=${score.score}/${score.max} (${score.completed}/${fresh.length})

${rows.join("\n")}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_start_container",
    description: "Start a challenge container (platform cap: 3 containers at once). Seeds the shared findings board and returns its path \u2014 include the board path + read/append discipline in every executor prompt you build.",
    parameters: {
      code: { type: "string", required: true, description: "Challenge unique_code." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const s = requireState();
      const fresh0 = await s.adapter.listChallenges();
      for (const x of fresh0) s.challenges.set(x.unique_code, x);
      const ch = s.challenges.get(args.code);
      if (ch === void 0) return `xiaochang_start_container: unknown challenge ${args.code}`;
      if (ch.container_status === "available" && ch.container_addr.length > 0) {
        return `already available: addrs=${ch.container_addr.join(",")}
boardPath=${c().boardPath(args.code)}`;
      }
      if (openContainers(s).size >= 3) {
        return "xiaochang_start_container: platform cap reached (3 containers open) \u2014 close a finished challenge first";
      }
      const started = await s.adapter.start(args.code);
      const fresh = await s.adapter.listChallenges();
      for (const x of fresh) s.challenges.set(x.unique_code, x);
      s.progress.update(args.code, { difficulty: ch.difficulty, containerClosed: false });
      persistProgress(s);
      audit(s.auditPath, { type: "container-start", code: args.code });
      return `started: addrs=${started.container_addr.join(",")}
boardPath=${c().boardPath(args.code)}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_close",
    description: "Close a challenge container (release a platform slot).",
    parameters: { code: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const s = requireState();
      await s.adapter.close(args.code);
      s.progress.update(args.code, { containerClosed: true });
      persistProgress(s);
      return `closed ${args.code}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_submit",
    description: "Submit a flag candidate. Returns the platform verdict (correct/awarded/cumulative/flag counts).",
    parameters: {
      code: { type: "string", required: true },
      flag: { type: "string", required: true, description: "Flag text (platform-annotated format, verbatim)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const s = requireState();
      try {
        const res = await s.adapter.submit(args.code, args.flag);
        if (res.correct) {
          const p = s.progress.get(args.code);
          s.progress.update(args.code, { flags: [.../* @__PURE__ */ new Set([...p?.flags ?? [], args.flag])] });
          persistProgress(s);
          const difficulty = s.challenges.get(args.code)?.difficulty ?? "unknown";
          for (const v of c().ledger.views()) {
            if (v.state !== "done" || codeOf(v.item.id) !== args.code) continue;
            if (v.item.model === void 0) continue;
            if ((v.terminalDetail ?? "").includes(args.flag)) {
              jisi?.ledger.record(v.item.model, "execution", difficulty, true);
            }
          }
        }
        return JSON.stringify(res);
      } catch (error) {
        return `submit error: ${String(error)}`;
      }
    }
  }));
  register(defineTool({
    name: "xiaochang_hint",
    description: "Fetch the official hint (deducts ~10% of the challenge score per hint; capped per challenge). Returns the hint text.",
    parameters: { code: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (parentAgent !== void 0 && exec.agent !== parentAgent) {
        return "xiaochang_hint: \u62D2\u7EDD\u2014\u2014hint \u662F\u4E3B agent \u4E13\u5C5E\u5355\u70B9(\u9632\u591A\u6267\u884C\u8005\u540C\u65F6\u770B\u4E71); \u9700\u8981\u63D0\u793A\u8BF7\u5411\u4E3B agent \u8BF7\u6C42";
      }
      const s = requireState();
      const used = s.hintLedger.get(args.code)?.hints ?? 0;
      if (used >= s.maxHints) return "xiaochang_hint: hint cap reached";
      const ch = s.challenges.get(args.code);
      const raw = await s.adapter.hint(args.code);
      const hint = raw.hint;
      if (hint === null || hint === void 0 || hint === "") return "xiaochang_hint: no hint available";
      s.hintLedger.record(args.code, ch?.total_score ?? 100, "main-agent requested");
      return `hint (${used + 1}/${s.maxHints} used): ${hint}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_enqueue",
    description: "Enqueue one executor work item into the hufu campaign. You (the main agent) compose the prompt \u2014 include: challenge description, container addrs, the shared board path with read/append discipline, the org profile, the assigned approach (idea), and the FLAG_CANDIDATE output convention. Optional dependsOn makes it a DAG node (runs after dependencies reach a terminal state).",
    parameters: {
      code: { type: "string", required: true },
      round: { type: "number", required: true, description: "Round number (your own accounting)." },
      prompt: { type: "string", required: true, description: "The full executor prompt." },
      model: { type: "string", description: "Executor model. Default deepseek-v4-flash (cheap fast path; override for hard challenges)." },
      effort: { type: "string", description: "Reasoning effort (unsupported efforts are dropped per model)." },
      dependsOn: { type: "array", description: "Item ids this item waits for (DAG)." },
      priority: { type: "number", description: "Priority score (higher first within difficulty tier)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const s = requireState();
      const ch = s.challenges.get(args.code);
      if (ch === void 0) return `xiaochang_enqueue: unknown challenge ${args.code}`;
      let prior = "";
      try {
        prior = renderKnowledge(args.code);
      } catch {
      }
      const vq = s.v2[args.code];
      let gapsTxt = "";
      if (vq !== void 0 && vq.gaps.length > 0) {
        gapsTxt = "\n\n\u5DF2\u77E5\u4E0A\u4E0B\u6587\u7F3A\u53E3(\u524D\u5E8F\u6267\u884C\u8005\u53CD\u9988\u7F3A\u7684\u4FE1\u606F, \u82E5\u4F60\u80FD\u8865\u5219\u8865, \u4E0D\u80FD\u8865\u5219\u660E\u786E\u8BF4\u7F3A\u4EC0\u4E48):\n" + vq.gaps.slice(-5).map((g) => `- ${g}`).join("\n");
      }
      const label = prior + gapsTxt !== "" ? args.prompt + "\n\n" + prior + gapsTxt : args.prompt;
      const seq = s.progress.get(args.code)?.rounds ?? 0;
      const itemId = `${args.code}#s${args.round}-w${seq + 1}`;
      const executor = resolveExecutor({ model: args.model, effort: args.effort }, s.executorPolicy);
      if (jisi !== void 0) {
        const listed = await jisi.listModels();
        if (!listed.some((m) => m.id === executor.model)) {
          return `xiaochang_enqueue: model ${executor.model} is not in the registered model catalog (jisi listModels) \u2014 pick a listed model`;
        }
        if (await jisi.isModelQuarantined?.(executor.model)) {
          return `xiaochang_enqueue: model ${executor.model} \u6240\u5C5E provider \u4F59\u989D\u5DF2\u67AF\u7AED(\u9694\u79BB\u4E2D)\u2014\u2014\u6362\u6A21\u578B; \u5E76\u628A"provider \u4F59\u989D\u4E0D\u8DB3"\u5199\u8FDB\u6218\u62A5/\u6700\u7EC8\u6D88\u606F\u63D0\u793A\u7528\u6237\u5145\u503C`;
        }
      }
      c().add({
        id: itemId,
        label,
        model: executor.model,
        reasoningEffort: executor.effort,
        ...args.dependsOn !== void 0 && args.dependsOn.length > 0 ? { dependsOn: args.dependsOn } : {},
        board: args.code,
        priority: { tier: tierOf(ch.difficulty), score: args.priority ?? ch.total_score }
      });
      s.progress.update(args.code, { difficulty: ch.difficulty, rounds: Math.max(s.progress.get(args.code)?.rounds ?? 0, args.round) });
      persistProgress(s);
      audit(s.auditPath, { type: "enqueue", id: itemId, code: args.code, round: args.round, model: executor.model, effort: executor.effort });
      return `enqueued ${itemId} (executor=${executor.model}/${executor.effort}${executor.overriddenByLock ? ", OVERRIDDEN BY MODEL LOCK" : ""})`;
    }
  }));
  register(defineTool({
    name: "xiaochang_dispatch",
    description: "Dispatch every READY queued item (DAG dependencies satisfied) while slots are free. Call this after enqueues and again each round \u2014 a finished item frees a slot immediately; no barrier ever waits for the slowest.",
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute() {
      const s = requireState();
      let count = 0;
      while (c().freeSlots() > 0 && c().nextQueued().length > 0) {
        await c().dispatchNext();
        count += 1;
      }
      audit(s.auditPath, { type: "dispatch-round", count, open: openCount(c()) });
      return `dispatched ${count} item(s); open=${openCount(c())}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_collect",
    description: "Collect settled work items (terminal states) since the last collect, and auto-handle mechanics: round timeouts are reported as failed (with the detail), timeout losses are recorded to the jisi model ledger, and OBSERVATIONS sections flow into the org profile. Returns each item: id, code, round, state, and the executor output text.",
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute() {
      const s = requireState();
      const now = Date.now();
      const rows = [];
      for (const v of c().ledger.views()) {
        if (v.state !== "dispatched" && v.state !== "help") continue;
        const difficulty = s.challenges.get(codeOf(v.item.id))?.difficulty ?? "medium";
        const factor = difficulty === "easy" ? 0.67 : difficulty === "hard" ? 2 : 1.33;
        const timeout = Math.round(s.roundTimeoutMs * factor);
        const last = v.lastProgressAt ?? v.dispatchedAt;
        if (last === void 0 || now - last < timeout) continue;
        c().report(v.item.id, "failed", "round timeout");
        s.processed.add(baseId(v.item.id));
      }
      for (const v of c().ledger.views()) {
        if (v.state !== "done" && v.state !== "failed" && v.state !== "blocked") continue;
        const base = baseId(v.item.id);
        if (s.processed.has(base)) continue;
        s.processed.add(base);
        const code = codeOf(v.item.id);
        const round = roundOf(v.item.id);
        const detail = v.terminalDetail ?? "";
        if (v.state === "failed" && detail.includes("round timeout") && v.item.model !== void 0) {
          jisi?.ledger.record(v.item.model, "execution", s.challenges.get(code)?.difficulty ?? "unknown", false);
        }
        if (v.item.model !== void 0) {
          const vq = s.v2[code] ?? { qtype: classifyQtype(s.challenges.get(code)?.description ?? ""), difficulty: difficultyPrior(s.challenges.get(code)?.total_score ?? 300), wins: 0, fails: 0, gaps: [], triedModels: [], ideaRound: 1, deadIdeas: 0, adopted: 0 };
          if (v.state === "done") {
            jisi?.recordV2?.({ model: v.item.model, dimension: "execution", qtype: vq.qtype, difficulty: vq.difficulty, weight: Math.log(1 + vq.difficulty / 25), win: true, note: `${v.item.id} done` });
          } else if (v.state === "failed" && detail.includes("round timeout")) {
            jisi?.recordV2?.({ model: v.item.model, dimension: "execution", qtype: vq.qtype, difficulty: vq.difficulty, weight: Math.log(1 + 25 / vq.difficulty), win: false, attribution: "model-weak", note: `${v.item.id} round timeout` });
          }
          if (!vq.triedModels.includes(v.item.model)) vq.triedModels.push(v.item.model);
          s.v2[code] = vq;
          persistV2(s);
        }
        for (const note of parseObservations(detail)) addFact(s.profile, { kind: "other", note });
        audit(s.auditPath, { type: "terminal", id: v.item.id, state: v.state, round, detail: detail.slice(0, 300) });
        rows.push(`--- ${v.item.id} [${v.state}] round=${round} code=${code}
${detail.slice(0, 6e3)}`);
      }
      persistProgress(s);
      persistProfile(s);
      return rows.length === 0 ? "xiaochang_collect: nothing settled yet" : rows.join("\n\n");
    }
  }));
  register(defineTool({
    name: "xiaochang_report",
    description: "Report your judgment for a challenge: complete (flags captured) / failed (give up or rounds exhausted) / skipped. Closes the container and prunes the challenge's queued/in-flight sibling items (hufu cancel).",
    parameters: {
      code: { type: "string", required: true },
      verdict: { type: "string", required: true, description: "complete | failed | skipped" },
      reason: { type: "string", description: "Short reason (logged)." },
      deadEnds: { type: "array", description: "[{path, conclusion, evidence}] proven-infeasible paths." },
      forks: { type: "array", description: "[{path, conclusion, evidence}] untaken branches worth dispatching." },
      observations: { type: "array", description: "[{path, conclusion}] facts learned." },
      why: { type: "string", description: "v2 \u5F52\u56E0(failed \u65F6\u5FC5\u586B): model-weak | approach-dead-end | context-insufficient | platform-issue. \u4E24\u7EA7\u5224\u5B9A: \u6267\u884C\u8005\u62A5\u544A\u63D0\u8BAE, \u4F60\u7EC8\u88C1." },
      gaps: { type: "array", description: "v2 \u4E0A\u4E0B\u6587\u7F3A\u53E3(context-insufficient \u65F6): [\u7F3A\u4EC0\u4E48\u4FE1\u606F]. \u8FDB\u753B\u50CF contextGaps, \u4E0B\u6B21\u6D3E\u5355/\u4E8C\u6B21\u5F81\u96C6\u81EA\u52A8\u9644\u5E26." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const s = requireState();
      const verdict = args.verdict === "complete" ? "complete" : args.verdict === "failed" ? "failed" : "skipped";
      const vq = s.v2[args.code] ?? { qtype: classifyQtype(s.challenges.get(args.code)?.description ?? ""), difficulty: difficultyPrior(s.challenges.get(args.code)?.total_score ?? 300), wins: 0, fails: 0, gaps: [], triedModels: [], ideaRound: 1, deadIdeas: 0, adopted: 0 };
      const why = args.why;
      const win = verdict === "complete";
      if (why !== "context-insufficient" && why !== "platform-issue") {
        vq.wins += win ? 1 : 0;
        vq.fails += win ? 0 : 1;
        vq.difficulty = calibrateDifficulty(vq);
        vq.lastVerdict = verdict;
      }
      if (args.gaps !== void 0 && args.gaps.length > 0) vq.gaps.push(...args.gaps);
      s.v2[args.code] = vq;
      persistV2(s);
      if (jisi !== void 0) {
        jisi.settleAdoptions?.(args.code, win, why);
      }
      const entries = [
        ...(args.deadEnds ?? []).map((e) => ({ kind: "dead-end", path: e.path, conclusion: e.conclusion, evidence: e.evidence, by: "report", at: Date.now() })),
        ...(args.forks ?? []).map((e) => ({ kind: "fork", path: e.path, conclusion: e.conclusion, evidence: e.evidence, by: "report", at: Date.now() })),
        ...(args.observations ?? []).map((e) => ({ kind: "observation", path: e.path, conclusion: e.conclusion, by: "report", at: Date.now() }))
      ];
      try {
        if (entries.length > 0) recordKnowledgeOnCode(args.code, entries);
      } catch {
      }
      try {
        await s.adapter.close(args.code);
      } catch {
      }
      s.progress.update(args.code, { state: verdict, reason: args.reason, containerClosed: true });
      for (const v of c().ledger.views()) {
        if (codeOf(v.item.id) === args.code && (v.state === "queued" || v.state === "dispatched" || v.state === "help" || v.state === "stalled")) {
          try {
            c().cancel(v.item.id, `challenge ${verdict}: ${args.reason ?? ""}`);
          } catch {
          }
        }
      }
      persistProgress(s);
      audit(s.auditPath, { type: "verdict", code: args.code, state: verdict, reason: args.reason });
      return `${args.code} \u2192 ${verdict}${args.reason !== void 0 ? ` (${args.reason})` : ""}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_board",
    description: "Read the shared findings board of a challenge (parallel workers' coordination channel).",
    parameters: { code: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const path = c().boardPath(args.code);
      try {
        const text = existsSync(path) ? readFileSync(path, "utf8") : "(board not created yet)";
        return `path=${path}

${text}`;
      } catch (error) {
        return `xiaochang_board error: ${String(error)}`;
      }
    }
  }));
  register(defineTool({
    name: "xiaochang_profile",
    description: 'Read the current org profile (cross-challenge generic observations). Include it in your prompts ("read the profile first").',
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute() {
      const s = requireState();
      return render(s.profile);
    }
  }));
  register(defineTool({
    name: "xiaochang_refanout",
    description: "V2 layer-3 R2 re-fanout: one call re-collects ideas for a stuck challenge WITH all prior context (R1 ideas alive+dead, dead-end list, context gaps, tried models) and ADDS models beyond the tried set (pick-ranked by idea fit, expensive models included when tried set is exhausted). Call it when xiaochang_status shows \u26A0\uFE0F upgrade suggestions, or when half the adopted ideas died.",
    parameters: {
      code: { type: "string", required: true }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const s = requireState();
      const ch = s.challenges.get(args.code);
      if (ch === void 0) return `xiaochang_refanout: unknown challenge ${args.code}`;
      const vq = s.v2[args.code] ?? { qtype: classifyQtype(ch.description ?? ""), difficulty: difficultyPrior(ch.total_score), wins: 0, fails: 0, gaps: [], triedModels: [], ideaRound: 1, deadIdeas: 0, adopted: 0 };
      const agent = exec.agent;
      if (agent === void 0) return "xiaochang_refanout: requires a calling agent";
      const dead = knowledgeOfCode(args.code).filter((k) => k.kind === "dead-end").map((k) => `- ${k.path}: ${k.conclusion ?? ""}`).join("\n") || "(\u65E0)";
      const gaps = vq.gaps.length > 0 ? vq.gaps.map((g) => `- ${g}`).join("\n") : "(\u65E0)";
      const tried = vq.triedModels.length > 0 ? vq.triedModels.join(", ") : "(\u65E0)";
      const prompt = `[\u4E8C\u6B21\u601D\u8DEF\u5F81\u96C6 R${vq.ideaRound + 1}] \u9898\u76EE ${args.code}(${vq.qtype}, \u6821\u51C6\u96BE\u5EA6 ${vq.difficulty}/100)
\u9898\u9762: ${(ch.description ?? "").slice(0, 1500)}

\u5DF2\u77E5\u6B7B\u8DEF(\u524D\u5E8F\u601D\u8DEF\u5DF2\u8BC1\u4E0D\u53EF\u884C):
${dead}

\u4E0A\u4E0B\u6587\u7F3A\u53E3(\u524D\u5E8F\u6267\u884C\u8005\u53CD\u9988\u7F3A\u7684\u4FE1\u606F):
${gaps}

\u5DF2\u8BD5\u6A21\u578B: ${tried}
\u5DF2\u91C7\u7528\u601D\u8DEF ${vq.adopted} \u6761, \u5DF2\u6B7B ${vq.deadIdeas} \u6761\u3002

\u63D0\u95EE: \u5DF2\u77E5\u4EE5\u4E0A\u6B7B\u8DEF\u4E0E\u7F3A\u53E3\u4E4B\u540E, \u8FD8\u6709\u54EA\u4E9B**\u6CA1\u8BD5\u8FC7**\u7684\u65B9\u5411? \u4E0D\u8981\u91CD\u590D\u6B7B\u8DEF; \u6BCF\u6761\u7ED9: \u4E3A\u4EC0\u4E48\u53EF\u884C + \u9A8C\u8BC1\u70B9 + \u9700\u8981\u8865\u7684\u4E0A\u4E0B\u6587\u3002`;
      let models = [];
      if (jisi?.pickRank !== void 0) {
        const ranked = await jisi.pickRank(vq.qtype, vq.difficulty, "idea");
        const fresh = ranked.filter((r) => !vq.triedModels.includes(r.model)).map((r) => r.model);
        models = fresh.length > 0 ? fresh.slice(0, 3) : ranked.slice(0, 3).map((r) => r.model);
      }
      if (models.length === 0) {
        const listed = await jisi?.listModels();
        models = (listed ?? []).map((m) => m.id).slice(0, 3);
      }
      if (jisi?.fanoutNotify !== void 0) {
        const ticket = jisi.fanoutNotify(agent, { prompt }, models);
        vq.ideaRound += 1;
        vq.triedModels.push(...models.filter((m) => !vq.triedModels.includes(m)));
        s.v2[args.code] = vq;
        persistV2(s);
        return `xiaochang_refanout: R${vq.ideaRound} \u5F81\u96C6\u5DF2\u53D1 (${models.join(", ")}, ticket ${ticket.id}).
\u62A5\u544A\u6309 [fanout:${ticket.id}] \u4FE1\u5C01\u5230\u8FBE\u2014\u2014\u5230\u8FBE\u540E\u8BF7 jisi_adjudicate \u88C1\u51B3(adopted/not-adopted/pending), \u91C7\u7EB3\u5373\u6D3E\u5355\u3002

\u53D1\u9001\u7684 prompt:
${prompt.slice(0, 600)}...`;
      }
      return `xiaochang_refanout: jisi \u901A\u9053\u4E0D\u53EF\u7528\u3002\u8BF7\u7528 jisi_fanout(prompt \u89C1\u4E0B, models=${models.join(", ")} \u6216\u6309 jisi_pick ${vq.qtype}/${vq.difficulty} \u53D6)\u3002

${prompt}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_fork",
    description: "F33 fork alarm: you (executor) found untaken promising branches or hard-won evidence \u2014 record them as fork knowledge AND wake the main agent immediately (followup, zero wait). The main agent alone decides whether to dispatch (single scheduler).",
    parameters: {
      code: { type: "string", required: true },
      forks: { type: "array", required: true, description: "[{path, conclusion, evidence}] untaken branches worth dispatching." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      if (args.forks.length === 0) return "xiaochang_fork: no forks given";
      const entries = args.forks.map((f) => ({ kind: "fork", path: f.path, conclusion: f.conclusion, evidence: f.evidence, by: "fork", at: Date.now() }));
      const lines = entries.map((f) => `- \u{1F500} ${f.path}${f.conclusion !== void 0 ? " \u2192 " + f.conclusion : ""}${f.evidence !== void 0 ? " (\u8BC1\u636E: " + f.evidence + ")" : ""}`);
      let inbox = "";
      try {
        inbox = writeForkInbox(args.code, entries);
      } catch {
      }
      try {
        recordKnowledgeOnCode(args.code, entries);
      } catch {
      }
      const sameProcess = parentAgent !== void 0 && campaign !== void 0;
      if (sameProcess) {
        parentAgent?.followup(createUserMessage({
          content: [{ type: "text", text: `\u{1F500} \u5206\u53C9\u5373\u65F6\u62A5(${args.code}): \u53D1\u73B0 ${entries.length} \u6761\u672A\u8D70\u5206\u53C9, \u5DF2\u5165\u8D26+\u4FE1\u7BB1\u3002\u7531\u4F60(\u4E3B agent)\u51B3\u5B9A\u662F\u5426 jisi_fanout_bulk / xiaochang_enqueue \u589E\u5175\u3002
${lines.join("\n")}` }],
          source: { kind: "user" }
        }));
      }
      return `fork ${inbox !== "" ? "\u5DF2\u5199\u5165\u5206\u53C9\u4FE1\u7BB1(" + inbox + "), \u4E3B agent \u7684 xiaochang_wait \u4F1A\u88AB\u5524\u9192\u5E76\u5728\u8BFB\u56FE\u65F6\u5438\u6536" : "\u4FE1\u7BB1\u5199\u5165\u5931\u8D25"}${sameProcess ? "; \u540C\u8FDB\u7A0B\u5DF2\u76F4\u63A5\u5165\u8D26\u5E76\u5524\u9192" : ""}:
${lines.join("\n")}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_graph",
    description: "F33 global solving graph: per-challenge view of every attempt (seed/model/state/terminal detail) plus accumulated knowledge (dead-ends/forks/observations). This is the main agent's situational picture \u2014 read it before every dispatch decision.",
    parameters: {
      code: { type: "string", description: "One challenge code; omit for the full graph." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const s = requireState();
      const codes = args.code !== void 0 ? [args.code] : [...new Set(c().ledger.views().map((v) => codeOf(v.item.id)))];
      for (const code of codes) {
        try {
          absorbForkInbox(code);
        } catch {
        }
      }
      const views = c().ledger.views().filter((v) => args.code === void 0 || codeOf(v.item.id) === args.code);
      if (views.length === 0) return `xiaochang_graph: no ledger items${args.code !== void 0 ? ` for ${args.code}` : ""}`;
      const rows = [];
      for (const v of views) {
        const code = codeOf(v.item.id);
        const p = s.progress.get(code);
        const kindTag = { done: "\u2705", failed: "\u274C", blocked: "\u26D4", superseded: "\u267B\uFE0F" }[v.state] ?? { queued: "\u23F3", dispatched: "\u{1F3C3}", help: "\u{1F64F}", stalled: "\u{1F40C}" }[v.state] ?? "\xB7";
        rows.push(`${kindTag} ${v.item.id} [${v.state}] seed=${v.seed} model=${v.item.model ?? s.executorPolicy.defaultModel} effort=${v.item.reasoningEffort ?? s.executorPolicy.defaultEffort}${p !== void 0 && p.flags.length > 0 ? ` flags=${p.flags.length}` : ""}${v.terminalDetail !== void 0 ? `
  \u7EC8\u6001: ${v.terminalDetail.slice(0, 400)}` : ""}`);
        const ks = campaign?.knowledgeOf?.(v.item.id) ?? [];
        for (const k of ks) {
          const tag = k.kind === "dead-end" ? "\u274C\u6B7B\u8DEF" : k.kind === "fork" ? "\u{1F500}\u672A\u8D70\u5206\u53C9" : "\u{1F4CC}\u4E8B\u5B9E";
          rows.push(`     [${tag}] ${k.path}${k.conclusion !== void 0 ? " \u2192 " + k.conclusion : ""}${k.evidence !== void 0 ? " (\u8BC1\u636E: " + k.evidence + ")" : ""}${k.by !== void 0 ? ` \u2014 by ${k.by}` : ""}`);
        }
        if (p !== void 0) rows.push(`   progress: ${p.state} reason=${p.reason ?? "-"} containerClosed=${p.containerClosed}`);
      }
      return rows.join("\n");
    }
  }));
  register(defineTool({
    name: "xiaochang_status",
    description: "Campaign status: ledger summary, per-challenge progress, budget remaining, open containers.",
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute() {
      const s = requireState();
      const views = c().ledger.views();
      const count = (fn) => views.filter(fn).length;
      const remaining = Math.max(0, s.startedAt + s.budgetMs - Date.now());
      const progress = s.progress.all().map((p) => `${p.code}:${p.state}${p.state === "complete" ? `(${p.flags.length} flags)` : ""}`).join(", ");
      const escLines = [];
      for (const [code, q] of Object.entries(s.v2)) {
        const st = jisi?.adoptionStats?.(code) ?? { adopted: q.adopted, dead: q.deadIdeas };
        if (st.adopted === 0) continue;
        if (st.dead / st.adopted >= 0.5) {
          escLines.push(`\u26A0\uFE0F ${code}: \u6B7B\u601D\u8DEF ${st.dead}/${st.adopted} \u226550% \u2192 \u5EFA\u8BAE xiaochang_refanout \u4E8C\u6B21\u5F81\u96C6(\u96BE\u5EA6${q.difficulty}, \u5DF2\u8BD5 ${q.triedModels.join(",") || "\u65E0"})`);
        }
      }
      const escTxt = escLines.length > 0 ? `
\u5347\u7EA7\u5EFA\u8BAE:
${escLines.join("\n")}` : "";
      return [
        `campaign: open=${count((v) => v.state === "dispatched" || v.state === "help")} queued=${count((v) => v.state === "queued")} done=${count((v) => v.state === "done")} failed=${count((v) => v.state === "failed")} blocked=${count((v) => v.state === "blocked")}`,
        `budgetRemainingMin=${Math.round(remaining / 6e4)}`,
        `openContainers=${[...openContainers(s)].join(",") || "none"}`,
        `hints=${s.hintLedger.totalHints()} (deducted ${s.hintLedger.totalDeducted()})`,
        `progress: ${progress}`,
        escTxt
      ].join("\n");
    }
  }));
  register(defineTool({
    name: "xiaochang_wait",
    description: "Event-driven wait (F30): blocks the turn without spending any LLM tokens until (a) an executor settles, (b) the campaign ledger changes, (c) a new session message arrives, (d) a fork lands in the fork inbox (executor xiaochang_fork), or (e) the timeout. This is THE way to wait \u2014 never bash sleep for waiting. Returns what woke it.",
    parameters: {
      timeoutSeconds: { type: "number", description: "Max wait seconds (default 300, clamp 5..900)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const timeoutMs = Math.min(Math.max(args.timeoutSeconds ?? 300, 5), 900) * 1e3;
      const agent = exec.agent;
      const ledgerSnap = () => {
        try {
          return JSON.stringify(campaign?.ledger.views().map((v) => [v.item.id, v.state, v.terminalDetail ?? "", v.lastProgressAt ?? 0]));
        } catch {
          return "";
        }
      };
      return await new Promise((resolve) => {
        let settled = false;
        let cleanup = () => {
        };
        const done = (why) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(why);
        };
        const unsub = campaignId !== void 0 && holder.onSettle !== void 0 ? holder.onSettle(campaignId, (ev) => done(`xiaochang_wait: ${ev.itemId} settled (${ev.status})${ev.text !== "" ? ": " + ev.text.slice(0, 200) : ""}`)) : () => {
        };
        const before = ledgerSnap();
        const iv = setInterval(() => {
          if (ledgerSnap() !== before) done("xiaochang_wait: campaign ledger changed");
        }, 2e3);
        const seqBefore = agent?.session.seq ?? 0;
        const sv = setInterval(() => {
          if (agent !== void 0 && agent.session.seq > seqBefore) done("xiaochang_wait: session message arrived");
        }, 2e3);
        const inboxDir = forkInboxDir();
        const inboxSnap = () => {
          try {
            if (!existsSync(inboxDir)) return "";
            return readdirSync2(inboxDir).filter((f) => f.endsWith(".jsonl")).map((f) => {
              const st = statSync2(join2(inboxDir, f));
              return `${f}:${st.mtimeMs}:${st.size}`;
            }).join("|");
          } catch {
            return "";
          }
        };
        const inboxBefore = inboxSnap();
        const fv = setInterval(() => {
          if (inboxSnap() !== inboxBefore) done("xiaochang_wait: fork inbox changed \u2014 read xiaochang_graph and dispatch the untaken branches");
        }, 2e3);
        const to = setTimeout(() => done(`xiaochang_wait: timeout after ${Math.round(timeoutMs / 1e3)}s, no event`), timeoutMs);
        cleanup = () => {
          unsub();
          clearInterval(iv);
          clearInterval(sv);
          clearInterval(fv);
          clearTimeout(to);
        };
      });
    }
  }));
  register(defineTool({
    name: "xiaochang_finish",
    description: "Close all open containers, stop the ranking clock via the platform finish endpoint (when all challenges are terminal or you decide to end), and return the final platform score. force=true writes the hosted-guard marker even when not all-terminal (verification/early-stop runs only \u2014 the formal campaign must reach all-terminal).",
    parameters: {
      force: { type: "boolean", description: "Write the guard stand-down marker even if not all-terminal. For verification/emergency runs only." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const s = requireState();
      for (const ch of s.challenges.values()) {
        if (ch.container_status === "available" || ch.container_status === "pending") {
          try {
            await s.adapter.close(ch.unique_code);
          } catch {
          }
        }
        s.progress.update(ch.unique_code, { containerClosed: true });
      }
      persistProgress(s);
      if (campaignId !== void 0) holder.finish?.(campaignId);
      const final = await s.adapter.listChallenges();
      const score = s.adapter.scoreOf(final);
      const allTerminal = final.every((ch) => ch.is_completed || ["failed", "skipped"].includes(s.progress.get(ch.unique_code)?.state ?? ""));
      let guardMarker = "";
      if (allTerminal || args.force === true) {
        try {
          const markerPath = process.env.GUARD_MARKER ?? join2(process.cwd(), ".campaign-finished");
          writeFileSync(markerPath, JSON.stringify({ at: Date.now(), score: score.score, max: score.max, completed: score.completed }));
          guardMarker = `
\u5B88\u536B\u6807\u8BB0\u5DF2\u5199\uFF08${markerPath}\uFF09\u2014\u2014\u8FDB\u7A0B\u9000\u51FA\u540E\u6C99\u7BB1\u7ED3\u675F\u3001\u5E73\u53F0\u5224\u5C40\u7EC8\u3002`;
        } catch {
        }
      }
      let clock;
      if (s.runBearerToken === void 0 || s.runId === void 0) {
        clock = "\u26A0\uFE0F \u5E73\u53F0\u505C\u8868\u672A\u6267\u884C\uFF08\u6392\u540D\u949F\u4ECD\u5728\u8D70\uFF09\uFF1A\u7F3A runBearerToken/runId\u3002\u8BF7\u8865\u8C03 xiaochang_setup \u4F20\u5165 runId+runBearerToken\uFF08\u6216 env RUN_BEARER_TOKEN\uFF09\u540E\u91CD\u8BD5 xiaochang_finish";
      } else if (!allTerminal) {
        clock = "\u2139\uFE0F \u5B58\u5728\u975E\u7EC8\u6001\u9898\uFF0C\u672A\u8C03\u5E73\u53F0\u505C\u8868";
      } else {
        try {
          const res = await fetch(`${s.baseURL}/api/v1/runs/${s.runId}/finish`, {
            method: "POST",
            headers: { authorization: `Bearer ${s.runBearerToken}` }
          });
          if (!res.ok) throw new Error(`finish ${res.status}`);
          clock = "\u2705 \u5E73\u53F0\u505C\u8868\u5DF2\u786E\u8BA4\uFF08HTTP 200\uFF09";
        } catch (error) {
          clock = `\u26A0\uFE0F \u5E73\u53F0\u505C\u8868\u8C03\u7528\u5931\u8D25\uFF1A${String(error)} \u2014\u2014 \u6392\u540D\u949F\u4ECD\u5728\u8D70\uFF0C\u8BF7\u91CD\u8BD5 xiaochang_finish`;
        }
      }
      return `xiaochang_finish: score=${score.score}/${score.max} (${score.completed}/${final.length} completed${score.completed === final.length ? ", ALL TERMINAL" : ""})
\u6392\u540D\u949F\uFF1A${clock}${guardMarker}`;
    }
  }));
}
export {
  apply,
  inject,
  name
};
