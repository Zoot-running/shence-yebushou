// src/index.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync, readdirSync as readdirSync2, renameSync as renameSync2, statSync as statSync2, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join as join2 } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

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
    existing.at = Date.now();
    profile.observedAt = Date.now();
    return profile;
  }
  profile.facts.push({ ...fact, confidence: fact.confidence ?? "likely", at: Date.now() });
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
    "",
    "> \u672C\u6587\u4EF6\u89C4\u5219(\u673A\u5236\u4FDD\u8BC1, \u52FF\u8FDD\u53CD):",
    "> 1. **\u540C\u4E3B\u9898\u591A\u6761\u8BB0\u5F55, \u540E\u8005\u8986\u76D6\u524D\u8005**\u2014\u2014\u4EE5\u6700\u65B0\u4E00\u6761\u4E3A\u51C6(\u6309\u65F6\u95F4\u5012\u5E8F\u6392\u5217, \u6700\u65B0\u5728\u6700\u4E0A);",
    "> 2. \u8DEF\u5F84/\u811A\u672C\u7C7B\u8BB0\u5F55\u4F7F\u7528\u524D\u5148 ls \u9A8C\u8BC1\u5B58\u5728\u6027(\u6587\u4EF6\u53EF\u80FD\u5DF2\u88AB\u6362\u540D/\u5220\u9664);",
    "> 3. \u6BCF\u6761\u8BB0\u5F55\u7684\u65F6\u95F4\u6233\u7531\u673A\u5236\u81EA\u52A8\u76D6, \u65E0\u9700\u4F60\u6807\u6CE8\u6765\u6E90\u3002",
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
    const ordered = [...facts].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    for (const fact of ordered) {
      lines.push(`- ${fact.note}${fact.confidence === "confirmed" ? "\uFF08\u5DF2\u786E\u8BA4\uFF09" : ""}${fact.at !== void 0 ? ` [${new Date(fact.at).toISOString().slice(0, 16).replace("T", " ")}]` : ""}`);
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
      const m = note.match(/^(.*?)\s\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]$/);
      const raw = m !== null ? m[1] : note;
      let at;
      if (m !== null) {
        const parsedAt = Date.parse(m[2].replace(" ", "T") + ":00Z");
        if (!Number.isNaN(parsedAt)) at = parsedAt;
      }
      const confirmed = raw.endsWith("\uFF08\u5DF2\u786E\u8BA4\uFF09");
      profile.facts.push({
        kind: currentKind,
        note: confirmed ? raw.slice(0, -5) : raw,
        confidence: confirmed ? "confirmed" : "likely",
        ...at !== void 0 ? { at } : {}
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

// ../../src/attack-surfaces.ts
var ATTACK_SURFACES = {
  web: [
    { id: "recon", name: "\u4FA6\u5BDF/\u6307\u7EB9", keywords: ["recon", "\u6307\u7EB9", "banner", "\u76EE\u5F55", "dirsearch", "robots"] },
    { id: "authn", name: "\u8BA4\u8BC1", keywords: ["login", "\u8BA4\u8BC1", "password", "\u5BC6\u7801", "jwt", "session", "cookie", "captcha", "otp"] },
    { id: "sqli", name: "SQL \u6CE8\u5165", keywords: ["sqli", "sql injection", "\u6CE8\u5165", "select '", "union"] },
    { id: "xss", name: "XSS", keywords: ["xss", "script", "\u8DE8\u7AD9"] },
    { id: "ssrf", name: "SSRF", keywords: ["ssrf", "url=", "proxy", "fetch url"] },
    { id: "idor", name: "IDOR/\u8D8A\u6743", keywords: ["idor", "\u8D8A\u6743", "id=", "uuid", "\u6C34\u5E73\u6743\u9650"] },
    { id: "lfi", name: "\u6587\u4EF6\u5305\u542B/\u8BFB\u53D6", keywords: ["lfi", "rfi", "file=", "include", "path traversal", "\u76EE\u5F55\u7A7F\u8D8A", "file://"] },
    { id: "upload", name: "\u6587\u4EF6\u4E0A\u4F20", keywords: ["upload", "\u4E0A\u4F20", "multipart"] },
    { id: "rce", name: "\u547D\u4EE4/\u4EE3\u7801\u6267\u884C", keywords: ["rce", "exec", "command", "\u4EE3\u7801\u6267\u884C", "\u53CD\u5E8F\u5217\u5316", "deserial", "pickle", "eval"] },
    { id: "ssrf-intra", name: "\u5185\u7F51\u6A2A\u5411", keywords: ["\u5185\u7F51", "\u6A2A\u5411", "ssrf \u5185\u7F51", "intranet", "redis", "\u4EE3\u7406"] },
    { id: "crypto-weak", name: "\u5F31\u52A0\u5BC6/\u5F31\u5BC6\u94A5", keywords: ["\u5F31\u5BC6\u94A5", "\u786C\u7F16\u7801", "key leak", "weak crypto"] },
    { id: "logic", name: "\u4E1A\u52A1\u903B\u8F91", keywords: ["\u903B\u8F91", "\u8D8A\u6743\u903B\u8F91", "race", "\u6761\u4EF6\u7ADE\u4E89", "\u6298\u6263"] }
  ],
  crypto: [
    { id: "weak-param", name: "\u5F31\u53C2\u6570", keywords: ["n \u5C0F", "e=3", "\u5171\u6A21", "\u5C0F\u516C\u94A5", "factor", "yafu"] },
    { id: "congruence", name: "\u540C\u4F59/CRT", keywords: ["crt", "\u540C\u4F59", "chinese remainder"] },
    { id: "lattice", name: "\u683C\u653B\u51FB", keywords: ["lattice", "\u683C", "lll", "coppersmith", "hidden number"] },
    { id: "algebra", name: "\u4EE3\u6570\u7ED3\u6784", keywords: ["groebner", "\u591A\u9879\u5F0F", "\u6709\u9650\u57DF", "galois"] },
    { id: "padding", name: "Padding \u9884\u8A00\u673A", keywords: ["padding oracle", "bleichenbacher", "pkcs"] },
    { id: "reuse", name: "\u5BC6\u94A5/\u968F\u673A\u6570\u91CD\u7528", keywords: ["nonce reuse", "\u968F\u673A\u6570", "stream", "\u540C\u4E00\u5BC6\u94A5"] },
    { id: "side", name: "\u4FA7\u4FE1\u9053/\u6CC4\u9732", keywords: ["\u6CC4\u9732", "oracle", "crc", "\u566A\u58F0", "\u5019\u9009\u503C", "timing"] },
    { id: "impl", name: "\u5B9E\u73B0\u7F3A\u9677", keywords: ["\u5B9E\u73B0", "\u8F6E\u6570", "\u81EA\u5B9E\u73B0", "\u81EA\u5B9A\u4E49"] }
  ],
  pwn: [
    { id: "overflow", name: "\u6808\u6EA2\u51FA", keywords: ["overflow", "\u6808", "ret2", "rop", "buffer"] },
    { id: "heap", name: "\u5806\u5229\u7528", keywords: ["heap", "\u5806", "tcache", "uaf", "double free"] },
    { id: "fmt", name: "\u683C\u5F0F\u5316\u5B57\u7B26\u4E32", keywords: ["fmt", "format string", "\u683C\u5F0F\u5316"] },
    { id: "logic-bug", name: "\u903B\u8F91\u6F0F\u6D1E", keywords: ["\u903B\u8F91", "integer", "\u8D8A\u754C", "off-by-one"] },
    { id: "env", name: "\u73AF\u5883\u7ED5\u8FC7", keywords: ["canary", "pie", "aslr", "nx", "seccomp", "\u6C99\u7BB1"] }
  ],
  rev: [
    { id: "static", name: "\u9759\u6001\u5206\u6790", keywords: ["ida", "ghidra", "\u53CD\u7F16\u8BD1", "disassemble", "strings"] },
    { id: "dynamic", name: "\u52A8\u6001\u8C03\u8BD5", keywords: ["gdb", "\u8C03\u8BD5", "\u65AD\u70B9", "trace"] },
    { id: "crypto-inner", name: "\u5185\u7F6E\u7B97\u6CD5\u8FD8\u539F", keywords: ["\u7B97\u6CD5", "\u5BC6\u94A5\u8C03\u5EA6", "\u8FD8\u539F", "check", "\u6821\u9A8C"] },
    { id: "vm", name: "VM/\u89E3\u91CA\u5668", keywords: ["vm", "\u89E3\u91CA\u5668", "opcode", "\u865A\u62DF\u673A"] }
  ],
  forensics: [
    { id: "fs", name: "\u6587\u4EF6\u7CFB\u7EDF/\u78C1\u76D8", keywords: ["\u78C1\u76D8", "\u955C\u50CF", "filesystem", "mft"] },
    { id: "net", name: "\u6D41\u91CF\u5206\u6790", keywords: ["pcap", "\u6D41\u91CF", "wireshark", "\u534F\u8BAE"] },
    { id: "mem", name: "\u5185\u5B58\u53D6\u8BC1", keywords: ["\u5185\u5B58", "volatility", "dump"] },
    { id: "artifact", name: "\u5DE5\u4EF6\u89E3\u6790", keywords: ["\u65E5\u5FD7", "\u6D4F\u89C8\u5668", "\u6CE8\u518C\u8868", "artifact", "\u65F6\u95F4\u7EBF"] },
    { id: "stego", name: "\u9690\u5199", keywords: ["stego", "\u9690\u5199", "lsb", "metadata", "exif"] }
  ],
  misc: [
    { id: "generic", name: "\u901A\u7528\u7EBF\u7D22", keywords: ["\u7EBF\u7D22", "\u63D0\u793A", "\u7F16\u7801", "base64", "hex"] },
    { id: "guess", name: "\u5BC6\u7801\u5B66\u6742\u9879", keywords: ["\u5BC6\u7801", "\u52A0\u5BC6", "\u89E3\u5BC6"] }
  ]
};
function coverageOf(qtype, triedTexts) {
  const surfaces = ATTACK_SURFACES[qtype] ?? [];
  const covered = /* @__PURE__ */ new Set();
  for (const text of triedTexts) {
    const low = text.toLowerCase();
    for (const s of surfaces) {
      if (s.keywords.some((k) => low.includes(k))) covered.add(s.id);
    }
  }
  const uncovered = surfaces.filter((s) => !covered.has(s.id)).map((s) => `${s.id}(${s.name})`);
  return {
    qtype,
    total: surfaces.length,
    covered: covered.size,
    uncovered,
    ratio: surfaces.length === 0 ? 1 : covered.size / surfaces.length
  };
}

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
function resourceClassOf(ch) {
  const t = ch.description ?? "";
  if (/(无需容器|纯附件|附件题|下载附件|attachment|静态文件|本地分析|离线求解|只用\s*(bash|shell|脚本))/i.test(t)) return "local";
  return "container";
}
var KNOWLEDGE_SECTION_TITLES = [
  "\u2460 \u9898\u6E90\u601D\u8DEF\u9AA8\u67B6",
  "\u2461 \u4E0D\u53EF\u884C\u6559\u8BAD",
  "\u2462 \u56DE\u6536\u5DE5\u4EF6",
  "\u2463 \u672A\u8D70\u5206\u53C9"
];
function knowledgeSectionTitle(section) {
  switch (section) {
    case "skeleton":
      return KNOWLEDGE_SECTION_TITLES[0];
    case "dead":
      return KNOWLEDGE_SECTION_TITLES[1];
    case "artifacts":
      return KNOWLEDGE_SECTION_TITLES[2];
    case "forks":
      return KNOWLEDGE_SECTION_TITLES[3];
  }
}
function knowledgeSkeleton(code) {
  return [
    `# ${code} \u77E5\u8BC6\u8D26\u672C`,
    "",
    "> \u672C\u9898\u6C42\u89E3\u7684\u6301\u4E45\u8BB0\u5FC6: \u6267\u884C\u8005\u5F00\u5DE5\u7B2C\u4E00\u4EF6\u4E8B\u8BFB\u672C\u6587\u4EF6, \u4ECE\u5DF2\u77E5\u8FB9\u754C\u51FA\u53D1\u3002",
    "> \u2460 \u7531\u4E3B agent \u7EF4\u62A4(xiaochang_knowledge_put); \u2461\u2462\u2463 \u7531\u673A\u5236\u81EA\u52A8\u7D2F\u79EF(report/fork)\u3002",
    "",
    "## \u2460 \u9898\u6E90\u601D\u8DEF\u9AA8\u67B6",
    "- (\u6682\u65E0)",
    "",
    "## \u2461 \u4E0D\u53EF\u884C\u6559\u8BAD",
    "- (\u6682\u65E0)",
    "",
    "## \u2462 \u56DE\u6536\u5DE5\u4EF6",
    "- (\u6682\u65E0)",
    "",
    "## \u2463 \u672A\u8D70\u5206\u53C9",
    "- (\u6682\u65E0)",
    ""
  ].join("\n");
}
function sectionRange(lines, title) {
  const start = lines.findIndex((l) => l.startsWith(`## ${title}`));
  if (start < 0) return void 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return [start, end];
}
function appendKnowledgeSection(fileText, section, entries) {
  const title = knowledgeSectionTitle(section);
  const lines = fileText.split("\n");
  const range = sectionRange(lines, title);
  const fresh = entries.filter((e) => e.trim() !== "" && !lines.includes(`- ${e}`));
  if (fresh.length === 0) return fileText;
  const body = fresh.map((e) => `- ${e}`);
  if (range === void 0) {
    const out2 = [...lines];
    while (out2.length > 0 && out2[out2.length - 1] === "") out2.pop();
    out2.push("", `## ${title}`, ...body, "");
    return out2.join("\n");
  }
  const [start, end] = range;
  const block = lines.slice(start, end);
  const content = block.slice(1).filter((l) => l.trim() !== "");
  const placeholder = content.length === 1 && content[0] === "- (\u6682\u65E0)";
  const keep = placeholder ? [] : content;
  const out = [...lines.slice(0, start + 1), ...keep, ...body, ...lines.slice(end)];
  return out.join("\n");
}
function replaceKnowledgeSection(fileText, section, entries) {
  const title = knowledgeSectionTitle(section);
  const lines = fileText.split("\n");
  const body = entries.map((e) => `- ${e}`);
  const range = sectionRange(lines, title);
  if (range === void 0) {
    const out = [...lines];
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    out.push("", `## ${title}`, ...body, "");
    return out.join("\n");
  }
  const [start, end] = range;
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join("\n");
}
function hintGate(input) {
  const missing = [];
  if (input.ideaRound < 2) missing.push(`R2 \u4E8C\u6B21\u5F81\u96C6\u672A\u8D70(\u5F53\u524D\u7B2C ${input.ideaRound} \u8F6E, \u9700 \u22652)\u2014\u2014\u5148 xiaochang_refanout \u52A0\u6A21\u578B\u518D\u6253\u4E00\u8F6E`);
  if (input.filteredFailed < 1) missing.push("\u8BE5\u9898\u5C1A\u65E0\u8FC7\u6EE4\u540E\u5931\u8D25(\u9700 \u22651 \u6B21\u771F\u5B9E\u8D25\u7EE9)\u2014\u2014\u5148\u6D3E\u6267\u884C\u8005\u6253\u51FA\u771F\u5B9E\u7ED3\u679C");
  return { allowed: missing.length === 0, missing };
}
function dedupeForkPaths(existingPaths, entries) {
  const seen = new Set(existingPaths);
  const out = [];
  for (const e of entries) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    out.push(e);
  }
  return out;
}
function truncateDirective(text, max) {
  if (text.length <= max) return { text, truncated: false, cutAt: text.length, cutTail: "" };
  const head = text.slice(0, max);
  const cutTail = text.slice(max, max + 60);
  return { text: `${head}\u2026(\u65B9\u5411\u6BB5\u5DF2\u622A\u65AD)`, truncated: true, cutAt: max, cutTail };
}
function buildWarmupPrompt(ch) {
  return [
    `[\u5F00\u5C40\u6696\u8D26\u5F81\u96C6] \u9898\u76EE ${ch.unique_code}(${ch.difficulty ?? "unknown"}, ${ch.total_score ?? "?"}\u5206): \u53EA\u8981\u65B9\u5411/\u6253\u70B9, \u4E0D\u8981\u5B8C\u6574\u89E3\u6CD5\u3002`,
    `\u9898\u9762: ${(ch.description ?? "").slice(0, 800)}`,
    "\u8F93\u51FA: 2-3 \u6761\u5019\u9009\u601D\u8DEF, \u6BCF\u6761 = \u6253\u54EA(\u653B\u51FB\u9762) + \u4E3A\u4EC0\u4E48\u53EF\u884C + \u600E\u4E48\u9A8C\u8BC1; \u6CE8\u660E\u9898\u76EE\u7C7B\u578B\u5224\u65AD\u3002"
  ].join("\n");
}
function attachmentLikely(description) {
  return /(附件|源码|源代码|source|下载|\.zip|\.tar|\.gz|\.py\b|\.txt\b|\.png\b|\.pcap\b)/i.test(description ?? "");
}
function attachmentFetchCandidates(code) {
  const safe = code.replace(/-/g, "");
  return [
    `/att/${code}/`,
    `/att/${safe}/`,
    `/attachments/${code}/`,
    `/files/${code}.zip`,
    `/download/${code}`,
    `/download`,
    `/files/`,
    `/`
  ];
}

// src/challenge-orch.ts
var TIMEBOX_MS = 30 * 6e4;
var SUBMIT_GRACE_MS = 15 * 6e4;
var NEVER_DISPATCHED_BOOST_STEP_MS = 30 * 6e4;
var NEVER_DISPATCHED_BOOST_MAX = 3;
var BLOCKER_RE = /(攻击面\s*缺失|无攻击面|攻击面.*(?:不存在|缺失)|环境缺失|未随容器|平台.*未(?:发布|暴露)|未暴露|not exposed|no attack surface|unreachable|不可达|服务未启动|仅.*静态)/i;
function blockerConcluded(text) {
  return BLOCKER_RE.test(text);
}
function verifierVerdict(text) {
  const confirm = /(blocker\s*成立|确认|confirmed|攻击面\s*确实|确无|verify\s*ok)/i;
  const refute = /(推翻|不成立|refut|攻击面\s*存在|有攻击面|误判)/i;
  const c = confirm.test(text);
  const r = refute.test(text);
  if (c && !r) return "confirm";
  if (r && !c) return "refute";
  return "unclear";
}
function realProgress(p) {
  return p.forkDelta > 0 || p.artifactsDelta > 0;
}
function fingerprintOf(detail) {
  return detail.replace(/\s+/g, " ").trim().slice(0, 80);
}
function settleAction(orch, p) {
  if (p.flagCandidate) return "pending-flag";
  if (p.blockerConcluded) {
    if (orch.blockerCheck === "confirmed") return "adjudicate";
    if (orch.blockerCheck === "in-flight" || orch.blockerCheck === "refuted") {
    } else {
      return "verify-blocker";
    }
  }
  if (realProgress(p)) {
    if (orch.progressStreak + 1 >= 2) return "rearm-all-in";
    return "rearm";
  }
  const streak = orch.zeroProgressStreak + 1;
  if (streak === 1) return "rearm-all-in";
  return "adjudicate";
}
function applyVerifierResult(orch, verdict) {
  if (verdict === "confirm") orch.blockerCheck = "confirmed";
  else if (verdict === "refute") orch.blockerCheck = "refuted";
  else orch.blockerCheck = "none";
}
function applySettle(orch, action, detail, now) {
  orch.lastSettleFingerprint = fingerprintOf(detail);
  orch.grantedUntil = void 0;
  switch (action) {
    case "pending-flag":
      orch.state = "pending-adjudication";
      orch.grantedUntil = now + SUBMIT_GRACE_MS;
      orch.progressStreak = 0;
      break;
    case "rearm":
      orch.state = "queued";
      orch.zeroProgressStreak = 0;
      orch.progressStreak += 1;
      orch.r2Due = false;
      orch.multiSpawn = 0;
      break;
    case "rearm-all-in":
      orch.state = "queued";
      orch.zeroProgressStreak = 1;
      orch.progressStreak = 0;
      orch.r2Due = true;
      orch.multiSpawn = 3;
      break;
    case "adjudicate":
      orch.state = "pending-adjudication";
      orch.multiSpawn = 0;
      break;
    case "verify-blocker":
      orch.state = "queued";
      orch.blockerCheck = "in-flight";
      orch.r2Due = false;
      orch.multiSpawn = 1;
      break;
  }
  return orch;
}
function rearmByTimebox(orch) {
  orch.state = "queued";
  orch.grantedUntil = void 0;
  orch.multiSpawn = 0;
  return orch;
}
function adjudicate(orch, verdict) {
  switch (verdict) {
    case "continue":
    case "rotate":
      orch.state = "queued";
      orch.zeroProgressStreak = 0;
      orch.progressStreak = 0;
      orch.r2Due = false;
      orch.blockerCheck = "none";
      orch.grantedUntil = void 0;
      orch.lastSettleFingerprint = void 0;
      break;
    case "dead":
      orch.state = "dead";
      orch.grantedUntil = void 0;
      break;
    case "solved":
      orch.state = "solved";
      orch.grantedUntil = void 0;
      break;
  }
  return orch;
}
function grant(orch, snapshot, now, timeboxMs = TIMEBOX_MS) {
  orch.state = "granted";
  orch.attempts += 1;
  orch.lastGrantAt = now;
  orch.grantedUntil = now + timeboxMs;
  orch.neverDispatched = false;
  orch.snapshot = snapshot;
  orch.r2Due = false;
  return orch;
}
function timeboxExpired(orch, now) {
  if (orch.grantedUntil === void 0 || now <= orch.grantedUntil) return false;
  return orch.state === "granted" || orch.state === "pending-adjudication";
}
function neverDispatchedBoost(orch, now) {
  if (!orch.neverDispatched) return 0;
  return Math.min(NEVER_DISPATCHED_BOOST_MAX, Math.floor(Math.max(0, now - orch.createdAt) / NEVER_DISPATCHED_BOOST_STEP_MS));
}
function priorityOf(orch, totalScore, now) {
  if (orch.state === "solved" || orch.state === "dead" || orch.state === "pending-adjudication") return Number.NEGATIVE_INFINITY;
  const base = totalScore > 0 ? totalScore : 300;
  if (orch.neverDispatched) {
    const p = orch.priorityOverride ?? (2e3 - base) * 10;
    return 1e6 + p + neverDispatchedBoost(orch, now);
  }
  if (orch.priorityOverride !== void 0) return orch.priorityOverride;
  return base * (1 + 0.5 * neverDispatchedBoost(orch, now));
}
function compareRisk(a, b, scoreA, scoreB) {
  const queuedA = a.state === "queued" ? 0 : 1;
  const queuedB = b.state === "queued" ? 0 : 1;
  if (queuedA !== queuedB) return queuedA - queuedB;
  const neverA = a.neverDispatched ? 0 : 1;
  const neverB = b.neverDispatched ? 0 : 1;
  if (neverA !== neverB) return neverA - neverB;
  if (scoreB !== scoreA) return scoreB - scoreA;
  return a.attempts - b.attempts;
}
function newOrch(code, now) {
  return {
    code,
    state: "queued",
    attempts: 0,
    zeroProgressStreak: 0,
    progressStreak: 0,
    neverDispatched: true,
    directives: [],
    r2Due: false,
    multiSpawn: 0,
    settleNoFlag: 0,
    blockerCheck: "none",
    createdAt: now
  };
}
function makePending(code, kind, summary, detailPath, now) {
  return { code, kind, summary, detailPath, createdAt: now };
}
function flagLine(e) {
  return JSON.stringify(e);
}
function foldFlags(entries) {
  const byCode = /* @__PURE__ */ new Map();
  for (const e of entries) {
    let m = byCode.get(e.code);
    if (m === void 0) {
      m = /* @__PURE__ */ new Map();
      byCode.set(e.code, m);
    }
    m.set(e.flag, e);
  }
  return byCode;
}
function parseFlagLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const e = JSON.parse(line);
      if (typeof e.code === "string" && typeof e.flag === "string") out.push(e);
    } catch {
    }
  }
  return out;
}
function pendingFlagsOf(entries, code) {
  const folded = foldFlags(entries).get(code);
  if (folded === void 0) return [];
  return [...folded.values()].filter((e) => e.status === "pending");
}
function serializeOrchState(orch, pending, scoreTable = {}) {
  return JSON.stringify({
    orch: Object.fromEntries([...orch.entries()].map(([code, o]) => [code, o])),
    pending,
    scoreTable
  });
}
function parseOrchState(json) {
  const d = JSON.parse(json);
  const m = /* @__PURE__ */ new Map();
  for (const [code, o] of Object.entries(d.orch ?? {})) m.set(code, o);
  return { orch: m, pending: d.pending ?? [], scoreTable: d.scoreTable ?? {} };
}

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
var tickTimer;
function requireState() {
  if (state === void 0) throw new Error("xiaochang: not set up \u2014 call xiaochang_setup first");
  return state;
}
function progressTerminal(code) {
  try {
    const p = state?.progress.get(code);
    return p !== void 0 && (p.state === "complete" || p.state === "failed" || p.state === "skipped");
  } catch {
    return false;
  }
}
function audit(path, line) {
  try {
    appendFileSync(path, `${JSON.stringify(line)}
`);
  } catch {
  }
}
function readOutageWindows() {
  try {
    const p = join2(process.env.DSH_HOME ?? ".", "storages", "provider-outages.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter((r) => r !== null);
  } catch {
    return [];
  }
}
function filteredFailedOf(code, campaign) {
  const windows = readOutageWindows();
  let failed = 0;
  let excluded = 0;
  const excludedReasons = [];
  for (const v of campaign?.ledger.views() ?? []) {
    if (v.state !== "failed" && v.state !== "blocked" || codeOf(v.item.id) !== code) continue;
    const detail = v.terminalDetail ?? "";
    const provErr = /(TRANSPORT|MISSING_CREDENTIAL|rate limit|insufficient|余额|no API key)/i.test(detail);
    const inOutage = windows.some((w) => {
      const at = v.lastProgressAt ?? 0;
      return at >= w.from && (w.to === null || at <= w.to);
    });
    if (provErr || inOutage) {
      excluded += 1;
      if (provErr) excludedReasons.push("provider\u9519\u8BEF\u7B7E\u540D");
      if (inOutage) excludedReasons.push("\u6545\u969C\u7A97\u53E3\u5185");
    } else {
      failed += 1;
    }
  }
  return { failed, excluded, excludedReasons };
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
        try {
          appendKnowledgeFile(code, "forks", fresh.map((k) => `${k.path}${k.conclusion !== void 0 ? " \u2192 " + k.conclusion : ""}${k.evidence !== void 0 ? " (\u8BC1\u636E: " + k.evidence + ")" : ""}`));
        } catch {
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
  const knowledgeFilePath = (code) => join2(dirname(c().boardPath(code)), "KNOWLEDGE.md");
  function ensureKnowledgeFile(code) {
    const p = knowledgeFilePath(code);
    try {
      if (!existsSync(p)) {
        mkdirSync2(dirname(p), { recursive: true });
        writeFileSync(p, knowledgeSkeleton(code));
      }
    } catch {
    }
    return p;
  }
  function appendKnowledgeFile(code, section, entries) {
    if (campaign === void 0) return;
    const p = ensureKnowledgeFile(code);
    try {
      const text = readFileSync(p, "utf8");
      const next = appendKnowledgeSection(text, section, entries);
      if (next !== text) writeFileSync(p, next);
    } catch {
    }
  }
  function replaceKnowledgeFile(code, section, entries) {
    if (campaign === void 0) return;
    const p = ensureKnowledgeFile(code);
    try {
      writeFileSync(p, replaceKnowledgeSection(readFileSync(p, "utf8"), section, entries));
    } catch {
    }
  }
  function syncKnowledgeFileFromLedger(code) {
    if (campaign === void 0) return;
    const buckets = { dead: [], artifacts: [], forks: [] };
    for (const k of knowledgeOfCode(code)) {
      const text = `${k.path}${k.conclusion !== void 0 ? " \u2192 " + k.conclusion : ""}${k.evidence !== void 0 ? " (\u8BC1\u636E: " + k.evidence + ")" : ""}`;
      if (k.kind === "dead-end") buckets.dead.push(text);
      else if (k.kind === "fork") buckets.forks.push(text);
      else buckets.artifacts.push(text);
    }
    for (const section of ["dead", "artifacts", "forks"]) {
      if (buckets[section].length > 0) appendKnowledgeFile(code, section, buckets[section]);
    }
  }
  const flagsPath = () => join2(process.env.DSH_HOME ?? ".", "storages", "xiaochang-flags.jsonl");
  function readFlagEntries() {
    try {
      const p = flagsPath();
      return existsSync(p) ? parseFlagLines(readFileSync(p, "utf8")) : [];
    } catch {
      return [];
    }
  }
  function appendFlagEntry(e) {
    try {
      mkdirSync2(dirname(flagsPath()), { recursive: true });
      appendFileSync(flagsPath(), flagLine(e) + "\n");
    } catch {
    }
  }
  function recordFlagVerdict(code, flag, status, verdict) {
    appendFlagEntry({ code, flag, by: "submit", status, verdict, at: Date.now() });
    const s = state;
    if (s !== void 0) {
      s.orchVersion += 1;
    }
  }
  const orchFor = (code) => state?.orch.get(code);
  function bumpOrch(s) {
    s.orchVersion += 1;
  }
  function persistOrch(s) {
    try {
      writeFileSync(s.orchPath, serializeOrchState(s.orch, s.pendingAdj, s.scoreTable));
    } catch {
    }
  }
  function recordScore(s, code, cumulative) {
    s.scoreTable[code] = cumulative;
    bumpOrch(s);
    persistOrch(s);
  }
  function runScoreOf(s) {
    return Object.values(s.scoreTable).reduce((a, b) => a + b, 0);
  }
  function addPending(s, pa) {
    s.pendingAdj = s.pendingAdj.filter((x) => !(x.code === pa.code && x.kind === pa.kind)).concat(pa);
  }
  function removePending(s, code, kind) {
    s.pendingAdj = s.pendingAdj.filter((x) => x.code !== code || kind !== void 0 && x.kind !== kind);
  }
  async function releaseGrant(code) {
    const s = requireState();
    if (!s.grantedCodes.delete(code)) return;
    try {
      await s.containerQueue?.release();
    } catch {
    }
  }
  function findingsLines(code) {
    try {
      const p = c().boardPath(code);
      return existsSync(p) ? readFileSync(p, "utf8").split("\n").length : 0;
    } catch {
      return 0;
    }
  }
  function artifactCount(code) {
    let n = 0;
    for (const name2 of [code, code.replace(/-/g, "")]) {
      try {
        const dir = join2(process.cwd(), name2);
        if (existsSync(dir)) {
          for (const f of walk(dir)) if (!f.endsWith(".pyc")) n += 1;
        }
      } catch {
      }
    }
    return n;
  }
  function snapshotProgress(code) {
    return { at: Date.now(), findingsLines: findingsLines(code), forkCount: knowledgeOfCode(code).length, artifactCount: artifactCount(code) };
  }
  function ensureVq(code) {
    const s = requireState();
    const ch = s.challenges.get(code);
    let vq = s.v2[code];
    if (vq === void 0) {
      vq = {
        qtype: classifyQtype(ch?.description ?? ""),
        difficulty: difficultyPrior(ch?.total_score ?? 300),
        wins: 0,
        fails: 0,
        gaps: [],
        triedModels: [],
        ideaRound: 1,
        deadIdeas: 0,
        adopted: 0
      };
      s.v2[code] = vq;
      persistV2(s);
    }
    return vq;
  }
  function gapsTxtOf(code) {
    const s = requireState();
    const vq = s.v2[code];
    if (vq === void 0 || vq.gaps.length === 0) return "";
    return "\n\n\u5DF2\u77E5\u4E0A\u4E0B\u6587\u7F3A\u53E3(\u524D\u5E8F\u6267\u884C\u8005\u53CD\u9988\u7F3A\u7684\u4FE1\u606F, \u82E5\u4F60\u80FD\u8865\u5219\u8865, \u4E0D\u80FD\u8865\u5219\u660E\u786E\u8BF4\u7F3A\u4EC0\u4E48):\n" + vq.gaps.slice(-5).map((g) => `- ${g}`).join("\n");
  }
  async function validateExecutorModel(model) {
    const s = requireState();
    if (jisi === void 0) return null;
    try {
      if (s.modelWhitelist.length > 0 && !s.modelWhitelist.includes(model)) return `\u767D\u540D\u5355\u5916`;
      const listed = await jisi.listModels();
      if (!listed.some((m) => m.id === model)) return `\u4E0D\u5728\u6A21\u578B\u76EE\u5F55`;
      if (await jisi.isModelQuarantined?.(model)) return `provider \u4F59\u989D\u67AF\u7AED`;
    } catch {
    }
    return null;
  }
  function pickSpawnModel(_code, idx) {
    const s = requireState();
    const allow = (m) => s.modelWhitelist.length === 0 || s.modelWhitelist.includes(m);
    const mix = ["deepseek-v4-flash", "deepseek-flash", "glm-5.3"].filter(allow);
    if (mix.length === 0) return s.executorPolicy.defaultModel;
    return mix[idx % mix.length];
  }
  async function issueR2(code) {
    const s = requireState();
    if (jisi?.fanoutNotify === void 0 || parentAgent === void 0) return;
    const ch = s.challenges.get(code);
    if (ch === void 0) return;
    const vq = ensureVq(code);
    try {
      const prompt = buildRefanoutPrompt(code);
      const models = await pickRefanoutModels(vq);
      const ticket = jisi.fanoutNotify(parentAgent, { prompt }, models);
      vq.ideaRound += 1;
      vq.triedModels.push(...models.filter((m) => !vq.triedModels.includes(m)));
      s.v2[code] = vq;
      persistV2(s);
      audit(s.auditPath, { type: "v8-r2", code, models, ticket: ticket.id });
    } catch {
    }
  }
  const VERIFIER_DIRECTIVE = '[\u9A8C\u8BC1\u5175] \u72EC\u7ACB\u590D\u9A8C\u8D26\u672C\u91CC\u7684 blocker \u7ED3\u8BBA("\u65E0\u653B\u51FB\u9762/\u73AF\u5883\u7F3A\u5931/\u672A\u53D1\u5E03"\u7C7B): \u4E0D\u8981\u4FE1\u4EFB\u524D\u5E8F\u5224\u5B9A, \u91CD\u8DD1\u63A2\u6D4B\u786E\u8BA4\u3002\u8F93\u51FA\u5F00\u5934\u4E00\u884C "\u590D\u9A8C: \u786E\u8BA4" \u6216 "\u590D\u9A8C: \u63A8\u7FFB", \u9644\u8BC1\u636E; \u82E5\u63A8\u7FFB, \u7ACB\u5373\u7EE7\u7EED\u89E3\u9898(\u5148\u8BFB\u77E5\u8BC6\u8D26\u672C, \u4ECE\u5DF2\u77E5\u8FB9\u754C\u51FA\u53D1)\u3002';
  const spawnQueue = [];
  let spawning = false;
  async function pumpSpawns() {
    if (spawning) return;
    spawning = true;
    try {
      while (spawnQueue.length > 0) {
        const code = spawnQueue.shift();
        await grantAndSpawn(code).catch((err) => {
          const s = requireState();
          s.armed.delete(code);
          audit(s.auditPath, { type: "v8-spawn-error", code, error: String(err) });
        });
      }
    } finally {
      spawning = false;
    }
  }
  function requestSpawn(code) {
    spawnQueue.push(code);
    void pumpSpawns();
  }
  async function grantAndSpawn(code) {
    const s = requireState();
    s.armed.delete(code);
    const o = orchFor(code);
    if (o === void 0 || o.state !== "queued") return;
    try {
      const fresh = await s.adapter.listChallenges();
      for (const x of fresh) s.challenges.set(x.unique_code, x);
    } catch {
    }
    const ch = s.challenges.get(code);
    if (ch === void 0) return;
    const cls = resourceClassOf(ch);
    const prio = priorityOf(o, ch.total_score, Date.now());
    const snapshot = snapshotProgress(code);
    grant(o, snapshot, Date.now(), s.timeboxMs);
    const nSpawn = Math.max(1, Math.min(o.multiSpawn, 3));
    o.multiSpawn = 0;
    if (o.r2Due) {
      o.r2Due = false;
      void issueR2(code);
    }
    const vq = ensureVq(code);
    const picks = [];
    if (o.blockerCheck === "in-flight") {
      picks.push({ text: VERIFIER_DIRECTIVE });
    } else {
      const untried = o.directives.filter((d) => !d.tried);
      for (let i = 0; i < nSpawn; i++) {
        const d = untried.shift();
        if (d !== void 0) picks.push(d);
        else picks.push({ text: "\u6309\u8D26\u672C+\u753B\u50CF\u81EA\u7531\u7A81\u7834: \u5148\u8BFB\u77E5\u8BC6\u8D26\u672C, \u4ECE\u5DF2\u77E5\u8FB9\u754C\u51FA\u53D1, \u4E0D\u6253\u6B7B\u8DEF" });
      }
      for (const d of picks) {
        const orig = o.directives.find((x) => x.text === d.text);
        if (orig !== void 0) orig.tried = true;
      }
    }
    for (let i = 0; i < picks.length; i++) {
      const d = picks[i];
      const workNo = (s.enqCounters.get(code) ?? 0) + 1;
      s.enqCounters.set(code, workNo);
      const itemId = `${code}#s${o.attempts}-w${workNo}`;
      const executor = resolveExecutor({ model: d.model ?? pickSpawnModel(code, i), effort: d.effort }, s.executorPolicy);
      const err = await validateExecutorModel(executor.model);
      const model = err === null ? executor.model : s.executorPolicy.defaultModel;
      const label = buildExecFrame(code, d.text) + gapsTxtOf(code);
      c().add({
        id: itemId,
        label,
        model,
        reasoningEffort: executor.effort,
        board: code,
        resourceClass: cls,
        priority: { tier: tierOf(ch.difficulty), score: prio }
      });
      if (!vq.triedModels.includes(model)) vq.triedModels.push(model);
      persistV2(s);
      audit(s.auditPath, { type: "v8-spawn", id: itemId, code, attempts: o.attempts, model, class: cls });
    }
    let count = 0;
    try {
      while (count < 8) {
        const d2 = await c().dispatchNext();
        if (d2 === void 0) break;
        count += 1;
      }
    } catch (error) {
      audit(s.auditPath, { type: "v8-dispatch-error", code, error: String(error) });
    }
    audit(s.auditPath, { type: "v8-grant", code, spawn: picks.length, dispatched: count });
    bumpOrch(s);
    persistOrch(s);
    persistProgress(s);
  }
  function armQueue() {
    const s = requireState();
    const q = s.containerQueue;
    if (q === void 0) return;
    const now = Date.now();
    const codes = [...s.challenges.keys()].sort((a, b) => {
      const pa = priorityOf(s.orch.get(a) ?? newOrch(a, now), s.challenges.get(a)?.total_score ?? 300, now);
      const pb = priorityOf(s.orch.get(b) ?? newOrch(b, now), s.challenges.get(b)?.total_score ?? 300, now);
      return pb - pa;
    });
    for (const code of codes) {
      const o = s.orch.get(code);
      if (o === void 0 || o.state !== "queued") continue;
      if (s.armed.has(code)) continue;
      const p = s.progress.get(code);
      if (p !== void 0 && (p.state === "complete" || p.state === "failed" || p.state === "skipped")) continue;
      const ch = s.challenges.get(code);
      if (ch === void 0) continue;
      if (resourceClassOf(ch) === "local") {
        s.armed.add(code);
        requestSpawn(code);
        continue;
      }
      s.armed.add(code);
      void q.acquire(code).then((res) => {
        if (res.status === "granted") {
          s.grantedCodes.add(code);
          requestSpawn(code);
        } else {
          s.armed.delete(code);
          audit(s.auditPath, { type: "v8-arm-drop", code, status: res.status, reason: res.reason });
        }
      }).catch((err) => audit(s.auditPath, { type: "v8-arm-error", code, error: String(err) }));
    }
  }
  async function settleClassify(itemId, detail) {
    const s = requireState();
    const code = codeOf(itemId);
    const o = s.orch.get(code);
    if (o === void 0) return;
    if (s.settleProcessed.has(itemId)) return;
    s.settleProcessed.add(itemId);
    if (o.state !== "granted") return;
    const now = Date.now();
    const sn = o.snapshot;
    const pendingFlags = pendingFlagsOf(readFlagEntries(), code);
    const p = {
      flagCandidate: pendingFlags.length > 0,
      findingsDelta: sn !== void 0 ? Math.max(0, findingsLines(code) - sn.findingsLines) : 0,
      forkDelta: sn !== void 0 ? Math.max(0, knowledgeOfCode(code).length - sn.forkCount) : 0,
      artifactsDelta: sn !== void 0 ? Math.max(0, artifactCount(code) - sn.artifactCount) : 0,
      blockerConcluded: blockerConcluded(detail) || knowledgeOfCode(code).some((k) => k.kind === "dead-end" && blockerConcluded(`${k.path} ${k.conclusion ?? ""}`)),
      detail
    };
    if (o.blockerCheck === "in-flight") applyVerifierResult(o, verifierVerdict(detail));
    const action = settleAction(o, p);
    applySettle(o, action, detail, now);
    if (!p.flagCandidate) o.settleNoFlag += 1;
    const board = c().boardPath(code);
    if (action === "pending-flag") {
      addPending(s, makePending(code, "flag-candidate", `${code} \u6709\u65D7\u5F85\u63D0\u4EA4: \u5C3D\u5FEB xiaochang_submit(\u5BB9\u5668\u5728\u7EBF\u5BBD\u9650 15min, \u8D85\u65F6\u5BB9\u5668\u5173/\u65D7\u503C\u53EF\u80FD\u8F6E\u6362)`, board, now));
    } else if (action === "adjudicate") {
      const kind = o.blockerCheck === "confirmed" ? "blocker-verified" : "needs-verdict";
      const summary = kind === "blocker-verified" ? `${code} blocker \u5DF2\u88AB\u9A8C\u8BC1\u5175\u786E\u8BA4: \u4E3B agent \u88C1\u51B3 \u5224\u6B7B/\u7EED\u6253` : `${code} \u96F6\u8FDB\u5C55\xD7${o.zeroProgressStreak} \u6302\u88C1\u51B3: \u4E3B agent \u88C1\u51B3 \u5224\u6B7B/\u7EED\u6253/\u62C9hint(\u95F8\u5DF2\u5F00)`;
      addPending(s, makePending(code, kind, summary, board, now));
    }
    const hasOthers = c().ledger.views().some((x) => x.item.id !== itemId && codeOf(x.item.id) === code && (x.state === "dispatched" || x.state === "help" || x.state === "stalled"));
    if (action !== "pending-flag" && !hasOthers) {
      try {
        await s.adapter.close(code);
      } catch {
      }
      await releaseGrant(code);
      s.progress.update(code, { containerClosed: true });
    }
    audit(s.auditPath, { type: "v8-settle", itemId, code, action, flagCandidate: p.flagCandidate });
    bumpOrch(s);
    persistOrch(s);
    persistProgress(s);
    if (action !== "pending-flag") armQueue();
  }
  async function tickOrch() {
    const s = requireState();
    const now = Date.now();
    let changed = false;
    for (const [code, o] of s.orch) {
      if (!timeboxExpired(o, now)) continue;
      if (o.state === "pending-adjudication") removePending(s, code, "flag-candidate");
      try {
        await s.adapter.close(code);
      } catch {
      }
      await releaseGrant(code);
      rearmByTimebox(o);
      s.progress.update(code, { containerClosed: true });
      audit(s.auditPath, { type: "v8-timebox", code });
      changed = true;
    }
    if (changed) {
      bumpOrch(s);
      persistOrch(s);
      persistProgress(s);
      armQueue();
    }
  }
  function buildExecFrame(code, directive) {
    const s = requireState();
    const ch = s.challenges.get(code);
    if (ch === void 0) return directive;
    const cls = resourceClassOf(ch);
    const addrs = ch.container_addr.length > 0 ? ch.container_addr.join(",") : cls === "local" ? "\u65E0\u9700\u5BB9\u5668(\u672C\u5730\u6C42\u89E3: bash/python \u76F4\u5F00)" : "\u5BB9\u5668\u7531\u8C03\u5EA6\u673A\u5236\u6388\u4E88\u2014\u2014\u4F60\u6301\u69FD\u5F00\u5DE5, \u65E0\u9700\u81EA\u884C\u542F\u52A8/\u7B49\u5F85\u5BB9\u5668(\u6267\u884C\u8005\u6CA1\u6709 start_container \u5DE5\u5177)";
    const kn = ensureKnowledgeFile(code);
    return [
      `\u3010\u6821\u573A\u6267\u884C\u4EE4 \xB7 ${code}\u3011(${cls === "local" ? "\u9644\u4EF6\u9898\xB7\u5168\u5E76\u884C" : "\u5BB9\u5668\u9898\xB73\u69FD\u8F6E\u6362"}, ${ch.difficulty}, ${ch.total_score}pts, ${ch.flag_count} flags)`,
      `\u9898\u9762: ${(ch.description ?? "").slice(0, 1200)}`,
      `\u5165\u53E3: ${addrs}`,
      `\u5171\u4EAB\u6218\u62A5: ${c().boardPath(code)}`,
      `\u77E5\u8BC6\u8D26\u672C(\u5F00\u5DE5\u5FC5\u8BFB): ${kn}`,
      `\u753B\u50CF(\u5FEB\u901F\u8BFB): ${s.profilePath}`,
      `\u4F60\u7684\u4EFB\u52A1: ${directive}`,
      "\u7EAA\u5F8B: \u2460\u5148\u8BFB\u77E5\u8BC6\u8D26\u672C, \u4ECE\u5DF2\u77E5\u8FB9\u754C\u51FA\u53D1, \u4E0D\u91CD\u590D\u6B7B\u8DEF, \u4F18\u5148\u7528\u56DE\u6536\u5DE5\u4EF6;",
      "      \u2461\u627E\u5230 flag \u7ACB\u5373\u8C03 xiaochang_flag_report(code, flag) \u4E0A\u62A5\u5165\u65D7\u4ED3(\u4E3B agent \u8D1F\u8D23\u63D0\u4EA4);",
      "      \u2462\u6B7B\u8DEF/\u65B0\u5206\u53C9\u8C03 xiaochang_fork \u4E0A\u62A5; \u7EC8\u6001\u524D\u628A\u6B7B\u8DEF\u539F\u56E0\u5199\u6E05\u3002"
    ].join("\n");
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
      modelLock: { type: "boolean", description: "Lock: force ALL executors to defaultModel/defaultEffort, ignoring per-item overrides (user/parent-agent override). Default false (main agent may switch models per item)." },
      containerSlots: { type: "number", description: "v7 container-challenge concurrency slots (platform container cap). Default 3; attachment challenges are never constrained by this." },
      timeboxMinutes: { type: "number", description: "v8 single-grant timebox in minutes (default 30). Local dry runs may pass a smaller value to exercise the timebox path." },
      modelWhitelist: { type: "string", description: "v7.8 model whitelist (comma-separated; empty = no restriction). Local dry runs should pass deepseek models \u2014 unreachable models are excluded from auto-R2 and enqueue validation." }
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
        },
        containerSlots: args.containerSlots ?? 3,
        enqCounters: /* @__PURE__ */ new Map(),
        modelWhitelist: (typeof args.modelWhitelist === "string" ? args.modelWhitelist.split(",").map((m) => m.trim()) : args.modelWhitelist ?? []).filter((m) => m !== ""),
        orch: /* @__PURE__ */ new Map(),
        pendingAdj: [],
        orchPath: join2(home, "storages", `xiaochang-orch-${args.runId ?? "pending"}.json`),
        armed: /* @__PURE__ */ new Set(),
        grantedCodes: /* @__PURE__ */ new Set(),
        settleProcessed: /* @__PURE__ */ new Set(),
        orchVersion: 0,
        timeboxMs: (args.timeboxMinutes ?? 30) * 6e4,
        tickCount: 0,
        scoreTable: {}
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
          budgetMs: s.budgetMs,
          // v7 类闸: 附件题全并行(继承全局 concurrency)。
          // v7.8: 容器题不再在 dispatch 层限 3——3 槽是"容器启动数"约束, 由资源队列在 start 层管;
          // dispatch 层限 3 会把全战役并行掐成 3 车道(run 19097 实锤: 每题首派被拖 90 分钟)。
          resourceLimits: { local: s.concurrency }
        }, [], { id: stableId, boardNamespace: `${args.runId ?? "pending"}` });
        campaign = created.campaign;
        campaignId = created.id;
      }
      if (s.containerQueue === void 0 && holder.resourceQueue !== void 0) {
        s.containerQueue = holder.resourceQueue({
          capacity: s.containerSlots,
          pollMs: 3e3,
          defaultTimeoutMs: Math.max(10 * 60 * 6e4, s.budgetMs + 60 * 6e4),
          canGrant: async () => {
            try {
              const fresh2 = await s.adapter.listChallenges();
              for (const x of fresh2) s.challenges.set(x.unique_code, x);
              return openContainers(s).size < s.containerSlots;
            } catch {
              return false;
            }
          },
          grant: async (code) => {
            const ch = s.challenges.get(code);
            if (ch !== void 0 && ch.container_status === "available" && ch.container_addr.length > 0) return;
            if (ch !== void 0 && ch.container_status === "pending") return;
            await s.adapter.start(code);
            const fresh2 = await s.adapter.listChallenges();
            for (const x of fresh2) s.challenges.set(x.unique_code, x);
            s.progress.update(code, { difficulty: ch?.difficulty ?? "medium", containerClosed: false });
            persistProgress(s);
            audit(s.auditPath, { type: "container-start", code });
          }
        });
      }
      try {
        if (existsSync(s.orchPath)) {
          const back = parseOrchState(readFileSync(s.orchPath, "utf8"));
          s.orch = back.orch;
          s.pendingAdj = back.pending;
          s.scoreTable = back.scoreTable;
        }
        for (const ch of fresh) {
          if (!s.orch.has(ch.unique_code)) s.orch.set(ch.unique_code, newOrch(ch.unique_code, s.startedAt));
        }
      } catch {
      }
      persistOrch(s);
      if (campaignId !== void 0 && holder.onSettle !== void 0) {
        holder.onSettle(campaignId, (ev) => {
          void settleClassify(ev.itemId, ev.text).catch((err) => audit(s.auditPath, { type: "v8-settle-error", itemId: ev.itemId, error: String(err) }));
        });
      }
      if (tickTimer !== void 0) clearInterval(tickTimer);
      tickTimer = setInterval(() => {
        s.tickCount += 1;
        void tickOrch().catch((err) => audit(s.auditPath, { type: "v8-tick-error", error: String(err) }));
        armQueue();
      }, 3e4);
      tickTimer.unref?.();
      armQueue();
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
      let warmup = "";
      if (progress.all().length === 0 && jisi?.fanoutNotify !== void 0) {
        try {
          const allowModel = (m) => s.modelWhitelist.length === 0 || s.modelWhitelist.includes(m);
          const tickets = [];
          let hardMulti = 0;
          for (const ch of fresh) {
            const models = (ch.total_score ?? 0) >= 700 ? ["deepseek-flash", "glm-5.3"].filter(allowModel) : ["deepseek-flash"].filter(allowModel);
            if (models.length > 1) hardMulti += 1;
            const ticket = jisi.fanoutNotify(agent, { prompt: buildWarmupPrompt(ch) }, models);
            tickets.push(ticket.id);
          }
          warmup = `, \u6696\u8D26 fanout \u5DF2\u53D1 ${tickets.length} \u8DEF(hard \u9898 ${hardMulti} \u9053\u4E3A flash+glm-5.3 \u53CC\u8DEF, \u5176\u4F59 flash \u5355\u8DEF; \u62A5\u544A\u6309\u4FE1\u5C01\u5230\u8FBE\u8BF7\u7167\u5E38\u88C1\u51B3\u2014\u2014**\u6696\u8D26\u5DF2\u8986\u76D6\u5168\u9898, \u65E0\u9700\u518D jisi_fanout_bulk \u5168\u91CF\u53D1; \u53EA\u5BF9 hard/\u5361\u9898\u52A0\u6A21\u578B\u8865\u5F81**)`;
        } catch {
          warmup = ", \u6696\u8D26 fanout \u53D1\u9001\u5931\u8D25(\u53EF\u624B\u52A8 jisi_fanout_bulk \u5168\u91CF\u5F81\u96C6)";
        }
      }
      return `xiaochang_setup ok: ${fresh.length} challenges, concurrency=${s.concurrency} (no threshold), containerSlots=${args.containerSlots ?? 3}, budget ${Math.round(s.budgetMs / 6e4)}min, resume=${progress.all().length > 0}, campaign=${campaignId ?? stableId}, swept=${swept}${warmup}`;
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
        const cls = resourceClassOf(ch);
        return `${ch.unique_code} [${ch.difficulty}\xB7${cls === "local" ? "\u9644\u4EF6" : "\u5BB9\u5668"}] ${ch.total_score}pts flags=${ch.correct_flag_count}/${ch.flag_count} completed=${ch.is_completed} container=${ch.container_status} addrs=${ch.container_addr.join(",") || "-"} progress=${p?.state ?? "fresh"} | ${ch.description ?? ""}`;
      });
      const locals = fresh.filter((ch) => resourceClassOf(ch) === "local").length;
      const scoreLine = `runScore(\u8BA1\u5206\u8868\xB7\u5E73\u53F0\u6BCF\u9898\u7D2F\u8BA1\u5206\u6C42\u548C)=${runScoreOf(s)}/${score.max}${s.hintLedger.totalHints() > 0 ? `(hint \u5DF2\u6263\u7EA6 ${s.hintLedger.totalDeducted()} \u5206, \u5DF2\u542B\u5728\u6BCF\u9898\u7D2F\u8BA1\u5206\u5185)` : ""}`;
      const hintTxt = s.hintLedger.totalHints() > 0 ? `; hint \u5DF2\u770B ${s.hintLedger.totalHints()} \u6B21\u3001\u5DF2\u6263\u7EA6 ${s.hintLedger.totalDeducted()} \u5206` : "";
      return `${scoreLine} (${score.completed}/${fresh.length}; \u9644\u4EF6\u9898 ${locals} \u4E2A\u5168\u5E76\u884C, \u5BB9\u5668\u9898 ${fresh.length - locals} \u4E2A\u53D7 ${s.containerSlots} \u69FD\u7EA6\u675F${hintTxt})

${rows.join("\n")}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_close",
    description: 'Close a challenge container (release a platform slot; wakes the next challenge in the queue). v8: main agent ONLY \u2014 container scheduling decisions belong to the main agent; executors report "needs rotate" in their settle report instead.',
    parameters: { code: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (parentAgent !== void 0 && exec.agent !== parentAgent) {
        return 'xiaochang_close: \u62D2\u7EDD\u2014\u2014\u5BB9\u5668\u8C03\u5EA6\u662F\u4E3B agent \u4E13\u5C5E; \u6267\u884C\u8005\u9700\u8981\u6362\u5B9E\u4F8B\u8BF7\u5728\u7EC8\u6001\u62A5\u544A\u91CC\u5199"\u9700\u8981\u6362\u5B9E\u4F8B+\u7406\u7531"';
      }
      const s = requireState();
      await s.adapter.close(args.code);
      s.progress.update(args.code, { containerClosed: true });
      persistProgress(s);
      await releaseGrant(args.code);
      armQueue();
      return `closed ${args.code}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_sweep_attachments",
    description: "v7.8 attachment sweep (one call): for every challenge whose description suggests an attachment, run the open-container \u2192 download \u2192 close-container cycle through the resource queue (zero-token slot waiting), saving artifacts to <cwd>/att/<code>/ and returning a per-challenge manifest. Candidate download paths are conventional guesses \u2014 misses are left to executors to handle manually. Call this ONCE early in the campaign (the order prescribes it); safe to re-call anytime.",
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute() {
      const s = requireState();
      audit(s.auditPath, { type: "v8-sweep-noop" });
      return "xiaochang_sweep_attachments: v8 \u5DF2\u5E9F\u5F03(\u9644\u4EF6\u4E0B\u8F7D\u5E76\u5165\u9898\u961F\u5217\u6388\u4E88\u2014\u2014\u6267\u884C\u8005\u6301\u69FD\u5F00\u5DE5\u65F6\u81EA\u884C\u5904\u7406\u9644\u4EF6, \u65E0\u9700\u624B\u52A8\u6E05\u9053)\u3002\u76F4\u63A5\u8FDB\u5165\u4E0B\u4E00\u6B65\u5373\u53EF\u3002";
      const targets = [...s.challenges.values()].filter((ch) => attachmentLikely(ch.description));
      const manifest = [];
      let downloaded = 0;
      for (const ch of targets) {
        const code = ch.unique_code;
        try {
          const res = s.containerQueue !== void 0 ? await s.containerQueue.acquire(code, { timeoutMs: 45e3 }) : { status: "granted" };
          if (res.status !== "granted") {
            manifest.push(`${code}: \u5BB9\u5668\u6392\u961F ${res.status === "timeout" ? "\u8D85\u65F6" : "\u51FA\u961F"}\u2014\u2014\u7559\u7ED9\u6267\u884C\u8005\u5904\u7406`);
            continue;
          }
          s.grantedCodes.add(code);
          const fresh = await s.adapter.listChallenges();
          for (const x of fresh) s.challenges.set(x.unique_code, x);
          const addr = s.challenges.get(code)?.container_addr?.[0];
          const dir = join2(process.cwd(), "att", code);
          let saved = 0;
          if (addr !== void 0) {
            try {
              mkdirSync2(dir, { recursive: true });
            } catch {
            }
            for (const p of attachmentFetchCandidates(code)) {
              try {
                const ctrl = new AbortController();
                const to = setTimeout(() => ctrl.abort(), 8e3);
                const r = await fetch(`http://${addr}${p}`, { signal: ctrl.signal });
                clearTimeout(to);
                if (!r.ok) continue;
                const buf = Buffer.from(await r.arrayBuffer());
                if (buf.length < 16) continue;
                const ct = r.headers.get("content-type") ?? "";
                const ext = /zip/.test(ct) ? ".zip" : /tar/.test(ct) ? ".tar" : /json/.test(ct) ? ".json" : /text/.test(ct) ? ".txt" : ".bin";
                writeFileSync(join2(dir, `sweep-${saved + 1}${ext}`), buf);
                saved += 1;
              } catch {
              }
            }
          }
          try {
            await s.adapter.close(code);
          } catch {
          }
          await releaseGrant(code);
          s.progress.update(code, { containerClosed: true });
          downloaded += saved;
          manifest.push(`${code}: \u4E0B\u8F7D ${saved} \u4EF6${saved === 0 ? "(\u5019\u9009\u8DEF\u5F84\u65E0\u547D\u4E2D, \u7559\u7ED9\u6267\u884C\u8005)" : ""}`);
        } catch (error) {
          manifest.push(`${code}: \u5904\u7406\u5931\u8D25 ${String(error)}`);
        }
      }
      persistProgress(s);
      audit(s.auditPath, { type: "attachment-sweep", targets: targets.length, downloaded });
      return `\u9644\u4EF6\u6E05\u9053: \u7591\u4F3C\u9644\u4EF6\u9898 ${targets.length} \u9053, \u5171\u4E0B\u8F7D ${downloaded} \u4EF6\u5DE5\u4EF6\u5230 <cwd>/att/<code>/\u3002
${manifest.join("\n")}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_submit",
    description: "Submit a flag candidate (main agent ONLY \u2014 executors report FLAG_CANDIDATE to the main agent, who submits; single-point submission keeps the platform verdict path serialized). Returns the platform verdict (correct/awarded/cumulative/flag counts).",
    parameters: {
      code: { type: "string", required: true },
      flag: { type: "string", required: true, description: "Flag text (platform-annotated format, verbatim)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (parentAgent !== void 0 && exec.agent !== parentAgent) {
        return "xiaochang_submit: \u62D2\u7EDD\u2014\u2014submit \u662F\u4E3B agent \u4E13\u5C5E\u5355\u70B9(\u4EA4\u5377\u8DEF\u5F84\u4E32\u884C\u53EF\u5BA1\u8BA1); \u6267\u884C\u8005\u8BF7\u628A flag \u8F93\u51FA\u4E3A FLAG_CANDIDATE: <flag> \u4EA4\u7ED9\u4E3B agent \u63D0\u4EA4";
      }
      const s = requireState();
      const v8AfterSubmit = async (correct) => {
        const o = s.orch.get(args.code);
        if (o === void 0) return;
        if (correct) {
          removePending(s, args.code, "flag-candidate");
          const fresh = await s.adapter.listChallenges();
          for (const x of fresh) s.challenges.set(x.unique_code, x);
          const ch = s.challenges.get(args.code);
          const allFlags = ch !== void 0 && ch.flag_count > 0 && (ch.correct_flag_count ?? 0) >= ch.flag_count;
          if (allFlags) {
            adjudicate(o, "solved");
            removePending(s, args.code);
            try {
              await s.adapter.close(args.code);
            } catch {
            }
            await releaseGrant(args.code);
            try {
              s.containerQueue?.evict(args.code, "solved");
            } catch {
            }
            s.armed.delete(args.code);
            s.progress.update(args.code, { state: "complete", containerClosed: true });
            for (const v of c().ledger.views()) {
              if (codeOf(v.item.id) === args.code && ["queued", "dispatched", "help", "stalled"].includes(v.state)) {
                if (v.state !== "queued") {
                  try {
                    await c().interruptItem?.(v.item.id);
                  } catch {
                  }
                }
                try {
                  c().cancel(v.item.id, "challenge solved");
                } catch {
                }
              }
            }
            audit(s.auditPath, { type: "v8-submit-solved", code: args.code });
          } else {
            adjudicate(o, "continue");
            armQueue();
            audit(s.auditPath, { type: "v8-submit-partial", code: args.code });
          }
          bumpOrch(s);
          persistOrch(s);
          persistProgress(s);
        } else {
          adjudicate(o, "continue");
          removePending(s, args.code, "flag-candidate");
          bumpOrch(s);
          persistOrch(s);
          armQueue();
          audit(s.auditPath, { type: "v8-submit-reject", code: args.code });
        }
      };
      try {
        const recordWin = (flag) => {
          const p = s.progress.get(args.code);
          s.progress.update(args.code, { flags: [.../* @__PURE__ */ new Set([...p?.flags ?? [], flag])] });
          persistProgress(s);
          const difficulty = s.challenges.get(args.code)?.difficulty ?? "unknown";
          for (const v of c().ledger.views()) {
            if (v.state !== "done" || codeOf(v.item.id) !== args.code) continue;
            if (v.item.model === void 0) continue;
            if ((v.terminalDetail ?? "").includes(flag)) {
              jisi?.ledger.record(v.item.model, "execution", difficulty, true);
            }
          }
        };
        const res = await s.adapter.submit(args.code, args.flag);
        if (typeof res.cumulative_score === "number") recordScore(s, args.code, res.cumulative_score);
        if (res.correct) {
          recordWin(args.flag);
          recordFlagVerdict(args.code, args.flag, "accepted");
          await v8AfterSubmit(true);
          return JSON.stringify(res);
        }
        const desc = s.challenges.get(args.code)?.description ?? "";
        if (!args.flag.startsWith("flag{") && !args.flag.startsWith("HTB{") && !args.flag.startsWith("mock{") && /flag\{/.test(desc)) {
          const wrapped = `flag{${args.flag}}`;
          const res2 = await s.adapter.submit(args.code, wrapped);
          if (typeof res2.cumulative_score === "number") recordScore(s, args.code, res2.cumulative_score);
          if (res2.correct) {
            recordWin(wrapped);
            recordFlagVerdict(args.code, wrapped, "accepted");
            recordFlagVerdict(args.code, args.flag, "rejected", "\u88F8\u4E32\u53E3\u5F84\u4E0D\u5BF9");
            await v8AfterSubmit(true);
            return `\u88F8\u4E32\u88AB\u62D2, \u81EA\u52A8\u56DE\u9000\u5305\u88C5\u63D0\u4EA4\u6210\u529F: ${JSON.stringify(res2)}`;
          }
          recordFlagVerdict(args.code, args.flag, "rejected", JSON.stringify(res).slice(0, 80));
          recordFlagVerdict(args.code, wrapped, "rejected", JSON.stringify(res2).slice(0, 80));
          await v8AfterSubmit(false);
          return `\u88F8\u4E32\u88AB\u62D2(${JSON.stringify(res)}); \u5305\u88C5\u56DE\u9000\u4E5F\u88AB\u62D2(${JSON.stringify(res2)})\u2014\u2014\u4EE5\u5E73\u53F0\u5224\u5B9A\u4E3A\u51C6, \u6362\u503C\u6216\u6362\u9898\u9762\u53E3\u5F84`;
        }
        recordFlagVerdict(args.code, args.flag, "rejected", JSON.stringify(res).slice(0, 80));
        await v8AfterSubmit(false);
        return JSON.stringify(res);
      } catch (error) {
        return `submit error: ${String(error)}`;
      }
    }
  }));
  register(defineTool({
    name: "xiaochang_flag_report",
    description: "v8.3 flag depot report (executor): report a captured flag candidate into the per-run flag depot file (single JSONL, tool-only writer, dedup by code+value). A NEW pending value wakes the main agent immediately (its xiaochang_wait polls the depot) \u2014 the main agent submits and the verdict (accepted/rejected) is written back by xiaochang_submit automatically. Do NOT put flag values in your settle text; just call this tool.",
    parameters: {
      code: { type: "string", required: true },
      flag: { type: "string", required: true, description: "Flag value verbatim (platform format)." },
      evidence: { type: "string", description: "One line: where/how it was captured (for the main agent)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const entries = readFlagEntries();
      const folded = foldFlags(entries).get(args.code);
      const exist = folded?.get(args.flag);
      if (exist !== void 0) {
        return `xiaochang_flag_report: \u8BE5\u503C\u5DF2\u5728\u65D7\u4ED3(\u72B6\u6001=${exist.status}${exist.verdict !== void 0 ? "/" + exist.verdict : ""})\u2014\u2014\u4E0D\u91CD\u590D\u5199\u5165, \u65E0\u9700\u518D\u62A5`;
      }
      appendFlagEntry({ code: args.code, flag: args.flag, by: "executor", status: "pending", at: Date.now() });
      if (state !== void 0) {
        state.orchVersion += 1;
      }
      audit(state?.auditPath ?? join2(process.env.DSH_HOME ?? ".", "storages", "xiaochang-run-audit.jsonl"), { type: "v8-flag-report", code: args.code, evidence: (args.evidence ?? "").slice(0, 120) });
      return `xiaochang_flag_report: \u5DF2\u5165\u65D7\u4ED3(pending), \u4E3B agent \u5C06\u88AB\u5524\u9192\u63D0\u4EA4${args.evidence !== void 0 ? `; \u8BC1\u636E: ${args.evidence.slice(0, 100)}` : ""}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_flag_status",
    description: "v8.3 flag depot view: folded per-challenge flag status (pending / accepted / rejected). Main agent reads this before submitting; executors read it to avoid re-reporting/re-submitting known values.",
    parameters: {
      code: { type: "string", description: "One challenge code; omit for the full depot summary." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const folded = foldFlags(readFlagEntries());
      const lines = [];
      let pending = 0;
      let accepted = 0;
      let rejected = 0;
      for (const [code, m] of [...folded.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (args.code !== void 0 && code !== args.code) continue;
        for (const [flag, e] of m) {
          if (e.status === "pending") pending += 1;
          else if (e.status === "accepted") accepted += 1;
          else rejected += 1;
          lines.push(`  ${code} [${e.status}] ${flag.slice(0, 40)}${e.verdict !== void 0 ? " \u2014 " + e.verdict.slice(0, 60) : ""}${e.by !== "" ? " (by " + e.by + ")" : ""}`);
        }
      }
      return `\u65D7\u4ED3: pending=${pending} accepted=${accepted} rejected=${rejected}
${lines.join("\n") || "  (\u7A7A)"}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_hint",
    description: "Fetch the official hint (main agent ONLY; costs part of the challenge score, capped per challenge). v7.4 gate: refused until the challenge has gone through \u22651 R2 re-fanout (ideaRound\u22652) AND has \u22651 filtered failure (provider-outage failures excluded) \u2014 hint is the last resort after escalation, never a shortcut. The deduction is reported loudly and the platform's cumulative_score is the authoritative account.",
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
      const vq = s.v2[args.code];
      const ff = filteredFailedOf(args.code, campaign);
      const noFlagSettles = s.orch.get(args.code)?.settleNoFlag ?? 0;
      const gate = hintGate({ ideaRound: vq?.ideaRound ?? 1, filteredFailed: ff.failed + noFlagSettles });
      if (!gate.allowed) {
        return `xiaochang_hint: \u62D2\u7EDD(hint \u6263\u8BE5\u9898\u5206\u503C, \u662F R2+\u5931\u8D25\u540E\u7684\u6700\u540E\u624B\u6BB5): ${gate.missing.join("; ")}\u3002\u5F53\u524D\u8BE5\u9898 hint \u5DF2\u7528 ${used}/${s.maxHints}\u3001\u5DF2\u6263 ${s.hintLedger.get(args.code)?.deducted ?? 0} \u5206\u3002`;
      }
      const ch = s.challenges.get(args.code);
      const raw = await s.adapter.hint(args.code);
      const hint = raw.hint;
      if (hint === null || hint === void 0 || hint === "") return "xiaochang_hint: no hint available";
      const cost = s.hintLedger.record(args.code, ch?.total_score ?? 100, "main-agent requested");
      return `hint (${used + 1}/${s.maxHints} used): ${hint}
\u26A0\uFE0F \u672C\u6B21\u770B\u63D0\u793A\u5DF2\u6263\u8BE5\u9898\u7EA6 ${cost} \u5206(\u8BE5\u9898\u7D2F\u8BA1\u5DF2\u6263 ${s.hintLedger.get(args.code)?.deducted ?? cost}, \u5168\u5C40\u7D2F\u8BA1 ${s.hintLedger.totalDeducted()})\u2014\u2014\u6EE1\u5206\u8D26\u91CC\u8981\u6263\u6389; run \u603B\u5206\u4EE5 xiaochang_status \u7684 runScore(\u8BA1\u5206\u8868)\u4E3A\u51C6\u3002`;
    }
  }));
  register(defineTool({
    name: "xiaochang_enqueue",
    description: "v8: put a CHALLENGE into the challenge queue with a directive package (\u601D\u8DEF\u5305). The queue is the single scheduler: when a slot is granted, the mechanism starts the container (if needed) and spawns the executor bound to it \u2014 no manual start/dispatch. Re-call to add more directives (untried ones are consumed at each grant) or to raise priority. Executors never wait for containers; challenges wait, zero tokens.",
    parameters: {
      code: { type: "string", required: true },
      prompt: { type: "string", required: true, description: "The lean directive: the assigned approach/idea for this challenge (1-3 lines, \u2264700 chars). Do NOT paste the challenge description/addrs/board discipline \u2014 the frame injects those. Do NOT paste CVE/dictionary-style knowledge." },
      priority: { type: "number", description: "v8: explicit queue priority override (default = score density + never-dispatched boost)." },
      model: { type: "string", description: "Preferred executor model for this directive (falls back to default if invalid/unlisted)." },
      effort: { type: "string", description: "Reasoning effort for this directive." },
      round: { type: "number", description: "v8: ignored (kept for compatibility) \u2014 rounds are managed by the mechanism." },
      dependsOn: { type: "array", description: "v8: ignored (kept for compatibility)." },
      resourceClass: { type: "string", description: "v8: ignored (kept for compatibility) \u2014 class is auto by challenge type." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (parentAgent !== void 0 && exec.agent !== parentAgent) {
        return "xiaochang_enqueue: \u62D2\u7EDD\u2014\u2014\u5165\u9898\u961F\u5217\u662F\u4E3B agent \u4E13\u5C5E(\u5355\u8C03\u5EA6\u5668); \u6267\u884C\u8005\u53EA\u89E3\u81EA\u5DF1\u7684\u9898, \u6709\u53D1\u73B0\u7528 xiaochang_fork \u4E0A\u62A5";
      }
      const s = requireState();
      const ch = s.challenges.get(args.code);
      if (ch === void 0) return `xiaochang_enqueue: unknown challenge ${args.code}`;
      try {
        ensureKnowledgeFile(args.code);
        syncKnowledgeFileFromLedger(args.code);
      } catch {
      }
      const DIRECTIVE_MAX = 700;
      const trunc = truncateDirective(args.prompt, DIRECTIVE_MAX);
      let truncNotice = "";
      if (trunc.truncated) {
        truncNotice = `
\u26A0\uFE0F \u65B9\u5411\u6BB5\u622A\u65AD\u53CD\u9988: ${args.prompt.length}\u2192${DIRECTIVE_MAX} \u5B57\u7B26, \u622A\u70B9\u539F\u6587 "${trunc.cutTail}\u2026"\u3002\u88AB\u780D\u6389\u7684\u5185\u5BB9\u82E5\u662F\u5173\u952E\u9A8C\u8BC1\u70B9: \u2460\u7528 xiaochang_knowledge_put \u5199\u8FDB\u8BE5\u9898\u8D26\u672C\u2460/\u2462(\u6267\u884C\u8005\u5F00\u5DE5\u5FC5\u8BFB, \u4E0D\u5360 prompt), \u6216 \u2461\u518D enqueue \u4E00\u6761; \u82E5\u53EA\u662F CVE/\u53E3\u4EE4\u8BCD\u5178\u7C7B\u516C\u5171\u77E5\u8BC6, \u4E0D\u7528\u8865\u2014\u2014\u6267\u884C\u8005\u6A21\u578B\u81EA\u5E26\u3002`;
      }
      const o = s.orch.get(args.code) ?? (() => {
        const n = newOrch(args.code, s.startedAt);
        s.orch.set(args.code, n);
        return n;
      })();
      if (o.state === "solved" || o.state === "dead") {
        return `xiaochang_enqueue: \u62D2\u7EDD\u2014\u2014${args.code} \u5DF2${o.state === "solved" ? "\u89E3\u51FA" : "\u5224\u6B7B"}, \u4E0D\u518D\u5165\u961F`;
      }
      o.directives.push({ text: trunc.text, model: args.model, effort: args.effort, tried: false });
      if (args.priority !== void 0) o.priorityOverride = args.priority;
      if (o.state === "pending-adjudication") {
        adjudicate(o, "continue");
        removePending(s, args.code);
      }
      o.state = "queued";
      bumpOrch(s);
      persistOrch(s);
      persistProgress(s);
      audit(s.auditPath, { type: "v8-enqueue", code: args.code, directive: trunc.text.slice(0, 80), priority: args.priority });
      return `enqueued ${args.code} (directives=${o.directives.length}, \u961F\u5217\u4F18\u5148\u7EA7=${priorityOf(o, ch.total_score, Date.now())}, \u72B6\u6001=${o.state}; \u6388\u4E88\u7531\u673A\u5236 tick \u6B66\u88C5, \u65E0\u9700\u624B\u52A8 dispatch)${truncNotice}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_dispatch",
    description: "v8: REMOVED \u2014 dispatch is automatic. The challenge queue grants a container and spawns the executor in one atomic action; the main agent no longer dispatches manually. Call xiaochang_enqueue to put a challenge (with its directive package) into the queue.",
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute() {
      armQueue();
      return "xiaochang_dispatch: v8 \u5DF2\u5E9F\u9664\u624B\u52A8\u6D3E\u5355\u2014\u2014\u6388\u4E88\u5373\u6D3E\u5175, \u7531\u9898\u961F\u5217\u673A\u5236\u81EA\u52A8\u6267\u884C\u3002\u7ED9\u9898\u6295\u601D\u8DEF\u5305\u7528 xiaochang_enqueue, \u770B\u961F\u5217/\u5F85\u51B3\u7528 xiaochang_status\u3002";
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
        try {
          await c().interruptItem?.(v.item.id);
        } catch {
        }
        audit(s.auditPath, { type: "interrupt", id: v.item.id, code: codeOf(v.item.id), reason: "round timeout" });
        c().report(v.item.id, "failed", "round timeout");
        s.processed.add(baseId(v.item.id));
        void settleClassify(v.item.id, "round timeout");
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
        void settleClassify(v.item.id, detail).catch((err) => audit(s.auditPath, { type: "v8-settle-sweep-error", itemId: v.item.id, error: String(err) }));
      }
      persistProgress(s);
      persistProfile(s);
      void tickOrch();
      return rows.length === 0 ? "xiaochang_collect: nothing settled yet" : rows.join("\n\n");
    }
  }));
  register(defineTool({
    name: "xiaochang_report",
    description: "Adjudication (main agent ONLY). v8 verdicts: complete (flags captured, terminal) / failed (\u5224\u6B7B, terminal) / skipped (terminal) / continue (\u56DE\u961F\u7EED\u6253: re-queues the challenge, ladder reset) / rotate (\u6362\u5B9E\u4F8B: close + re-queue for a fresh container). Terminal verdicts close the container and prune the challenge's queued/in-flight sibling items; continue/rotate re-arm the challenge queue. Adjudicating removes the pending item from the dashboard.",
    parameters: {
      code: { type: "string", required: true },
      verdict: { type: "string", required: true, description: "complete | failed | skipped | continue | rotate" },
      reason: { type: "string", description: "Short reason (logged)." },
      deadEnds: { type: "array", description: "[{path, conclusion, evidence}] proven-infeasible paths." },
      forks: { type: "array", description: "[{path, conclusion, evidence}] untaken branches worth dispatching." },
      observations: { type: "array", description: "[{path, conclusion}] facts learned." },
      why: { type: "string", description: "v2 \u5F52\u56E0(failed \u65F6\u5FC5\u586B): model-weak | approach-dead-end | context-insufficient | platform-issue. \u4E24\u7EA7\u5224\u5B9A: \u6267\u884C\u8005\u62A5\u544A\u63D0\u8BAE, \u4F60\u7EC8\u88C1." },
      gaps: { type: "array", description: "v2 \u4E0A\u4E0B\u6587\u7F3A\u53E3(context-insufficient \u65F6): [\u7F3A\u4EC0\u4E48\u4FE1\u606F]. \u8FDB\u753B\u50CF contextGaps, \u4E0B\u6B21\u6D3E\u5355/\u4E8C\u6B21\u5F81\u96C6\u81EA\u52A8\u9644\u5E26." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (parentAgent !== void 0 && exec.agent !== parentAgent) {
        return "xiaochang_report: \u62D2\u7EDD\u2014\u2014\u88C1\u51B3\u662F\u4E3B agent \u4E13\u5C5E(\u5355\u8C03\u5EA6\u5668); \u6267\u884C\u8005\u53EA\u62A5\u544A\u7ED3\u679C, \u4EA4\u4E3B agent \u5224\u65AD";
      }
      const s = requireState();
      const v8Verdicts = /* @__PURE__ */ new Set(["complete", "failed", "skipped", "continue", "rotate"]);
      if (!v8Verdicts.has(args.verdict)) return `xiaochang_report: unknown verdict ${args.verdict} (complete|failed|skipped|continue|rotate)`;
      const verdict = args.verdict;
      const terminal = verdict === "complete" || verdict === "failed" || verdict === "skipped";
      const vq = s.v2[args.code] ?? { qtype: classifyQtype(s.challenges.get(args.code)?.description ?? ""), difficulty: difficultyPrior(s.challenges.get(args.code)?.total_score ?? 300), wins: 0, fails: 0, gaps: [], triedModels: [], ideaRound: 1, deadIdeas: 0, adopted: 0 };
      const why = args.why;
      const win = verdict === "complete";
      if (terminal && why !== "context-insufficient" && why !== "platform-issue") {
        vq.wins += win ? 1 : 0;
        vq.fails += win ? 0 : 1;
        vq.difficulty = calibrateDifficulty(vq);
        vq.lastVerdict = verdict;
      }
      if (args.gaps !== void 0 && args.gaps.length > 0) vq.gaps.push(...args.gaps);
      s.v2[args.code] = vq;
      persistV2(s);
      if (jisi !== void 0 && terminal) {
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
      const line = (e) => `${e.path}${e.conclusion !== void 0 ? " \u2192 " + e.conclusion : ""}${e.evidence !== void 0 ? " (\u8BC1\u636E: " + e.evidence + ")" : ""}`;
      try {
        if ((args.deadEnds?.length ?? 0) > 0) appendKnowledgeFile(args.code, "dead", args.deadEnds.map(line));
        if ((args.gaps?.length ?? 0) > 0) appendKnowledgeFile(args.code, "dead", args.gaps.map((g) => `\u7F3A\u53E3: ${g}`));
        if ((args.observations?.length ?? 0) > 0) appendKnowledgeFile(args.code, "artifacts", args.observations.map(line));
        if ((args.forks?.length ?? 0) > 0) appendKnowledgeFile(args.code, "forks", args.forks.map(line));
      } catch {
      }
      const o = s.orch.get(args.code);
      if (o !== void 0) {
        if (verdict === "complete") adjudicate(o, "solved");
        else if (verdict === "failed" || verdict === "skipped") adjudicate(o, "dead");
        else adjudicate(o, verdict === "rotate" ? "rotate" : "continue");
      }
      removePending(s, args.code);
      try {
        await s.adapter.close(args.code);
      } catch {
      }
      await releaseGrant(args.code);
      try {
        s.containerQueue?.evict(args.code, `challenge ${verdict}`);
      } catch {
      }
      s.armed.delete(args.code);
      if (terminal) {
        s.progress.update(args.code, { state: verdict === "complete" ? "complete" : verdict, reason: args.reason, containerClosed: true });
        for (const v of c().ledger.views()) {
          if (codeOf(v.item.id) === args.code && (v.state === "queued" || v.state === "dispatched" || v.state === "help" || v.state === "stalled")) {
            if (v.state !== "queued") {
              try {
                await c().interruptItem?.(v.item.id);
              } catch {
              }
              audit(s.auditPath, { type: "interrupt", id: v.item.id, code: args.code, reason: `challenge ${verdict}` });
            }
            try {
              c().cancel(v.item.id, `challenge ${verdict}: ${args.reason ?? ""}`);
            } catch {
            }
          }
        }
      } else {
        s.progress.update(args.code, { containerClosed: true });
        armQueue();
      }
      bumpOrch(s);
      persistOrch(s);
      persistProgress(s);
      audit(s.auditPath, { type: "verdict", code: args.code, state: verdict, reason: args.reason });
      return `${args.code} \u2192 ${verdict}${args.reason !== void 0 ? ` (${args.reason})` : ""}${terminal ? "" : " (\u5DF2\u56DE\u961F)"}`;
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
  const buildRefanoutPrompt = (code) => {
    const s = requireState();
    const ch = s.challenges.get(code);
    const vq = s.v2[code] ?? { qtype: classifyQtype(ch?.description ?? ""), difficulty: difficultyPrior(ch?.total_score ?? 300), wins: 0, fails: 0, gaps: [], triedModels: [], ideaRound: 1, deadIdeas: 0, adopted: 0 };
    const dead = knowledgeOfCode(code).filter((k) => k.kind === "dead-end").map((k) => `- ${k.path}: ${k.conclusion ?? ""}`).join("\n") || "(\u65E0)";
    const gaps = vq.gaps.length > 0 ? vq.gaps.map((g) => `- ${g}`).join("\n") : "(\u65E0)";
    const tried = vq.triedModels.length > 0 ? vq.triedModels.join(", ") : "(\u65E0)";
    return `[\u4E8C\u6B21\u601D\u8DEF\u5F81\u96C6 R${vq.ideaRound + 1}] \u9898\u76EE ${code}(${vq.qtype}, \u6821\u51C6\u96BE\u5EA6 ${vq.difficulty}/100)
\u9898\u9762: ${(ch?.description ?? "").slice(0, 1500)}
\u77E5\u8BC6\u8D26\u672C(\u53EF\u9009\u8BFB, \u524D\u5E8F\u9AA8\u67B6/\u6B7B\u8DEF/\u5DE5\u4EF6/\u5206\u53C9): ${ensureKnowledgeFile(code)}

\u5DF2\u77E5\u6B7B\u8DEF(\u524D\u5E8F\u601D\u8DEF\u5DF2\u8BC1\u4E0D\u53EF\u884C):
${dead}

\u8981\u6C42: \u5148\u6216\u5E76\u884C\u7528 web_search \u67E5\u516C\u5F00\u8D44\u6599(writeup/\u9898\u6E90/CVE \u5E93), \u6709\u51FA\u5904\u7684\u7EBF\u7D22\u5199\u8FDB\u601D\u8DEF\u5E76\u9644 URL; \u4E0D\u8981\u53EA\u51ED\u8BB0\u5FC6\u731C\u3002

\u4E0A\u4E0B\u6587\u7F3A\u53E3(\u524D\u5E8F\u6267\u884C\u8005\u53CD\u9988\u7F3A\u7684\u4FE1\u606F):
${gaps}

\u5DF2\u8BD5\u6A21\u578B: ${tried}
\u5DF2\u91C7\u7528\u601D\u8DEF ${vq.adopted} \u6761, \u5DF2\u6B7B ${vq.deadIdeas} \u6761\u3002

\u63D0\u95EE: \u5DF2\u77E5\u4EE5\u4E0A\u6B7B\u8DEF\u4E0E\u7F3A\u53E3\u4E4B\u540E, \u8FD8\u6709\u54EA\u4E9B**\u6CA1\u8BD5\u8FC7**\u7684\u65B9\u5411? \u4E0D\u8981\u91CD\u590D\u6B7B\u8DEF; \u6BCF\u6761\u7ED9: \u4E3A\u4EC0\u4E48\u53EF\u884C + \u9A8C\u8BC1\u70B9 + \u9700\u8981\u8865\u7684\u4E0A\u4E0B\u6587\u3002`;
  };
  const pickRefanoutModels = async (vq) => {
    const s = requireState();
    const allow = (m) => s.modelWhitelist.length === 0 || s.modelWhitelist.includes(m);
    if (jisi?.pickRank !== void 0) {
      const ranked = (await jisi.pickRank(vq.qtype, vq.difficulty, "idea")).filter((r) => allow(r.model));
      const fresh = ranked.filter((r) => !vq.triedModels.includes(r.model)).map((r) => r.model);
      if (fresh.length > 0) return fresh.slice(0, 3);
      if (ranked.length > 0) return ranked.slice(0, 3).map((r) => r.model);
    }
    const listed = await jisi?.listModels();
    return (listed ?? []).map((m) => m.id).filter(allow).slice(0, 3);
  };
  register(defineTool({
    name: "xiaochang_refanout",
    description: "V2 layer-3 R2 re-fanout: one call re-collects ideas for a stuck challenge WITH all prior context (R1 ideas alive+dead, dead-end list, context gaps, tried models) and ADDS models beyond the tried set (pick-ranked by idea fit, expensive models included when tried set is exhausted). Call it when xiaochang_status shows \u26A0\uFE0F upgrade suggestions, or when half the adopted ideas died.",
    parameters: {
      code: { type: "string", required: true }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (parentAgent !== void 0 && exec.agent !== parentAgent) {
        return "xiaochang_refanout: \u62D2\u7EDD\u2014\u2014\u4E8C\u6B21\u5F81\u96C6\u662F\u4E3B agent \u4E13\u5C5E(\u5355\u8C03\u5EA6\u5668); \u5361\u4F4F\u4E86\u8BF7\u628A\u7F3A\u53E3\u5199\u8FDB\u7EC8\u6001\u8F93\u51FA\u4EA4\u4E3B agent";
      }
      const s = requireState();
      const ch = s.challenges.get(args.code);
      if (ch === void 0) return `xiaochang_refanout: unknown challenge ${args.code}`;
      const vq = s.v2[args.code] ?? { qtype: classifyQtype(ch.description ?? ""), difficulty: difficultyPrior(ch.total_score), wins: 0, fails: 0, gaps: [], triedModels: [], ideaRound: 1, deadIdeas: 0, adopted: 0 };
      const agent = exec.agent;
      if (agent === void 0) return "xiaochang_refanout: requires a calling agent";
      const prompt = buildRefanoutPrompt(args.code);
      const models = await pickRefanoutModels(vq);
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
    description: `F33 fork alarm: you (executor) report branches with an explicit status \u2014 "untaken" (default): promising branch not taken, worth dispatching (goes to ledger \u2463 + the fork inbox; the main agent is woken by xiaochang_wait polling the inbox \u2014 NO direct interrupt, forks are collected in the main agent's normal rhythm); "dead-end": a path you PROVED infeasible (403/impossible/verified-fail) \u2014 archived silently to ledger \u2461 only, no inbox, no wake, no dispatch impulse. v7.1: untaken forks of already-terminal challenges are archived silently. v7.4: duplicate paths already in the inbox are skipped at the source.`,
    parameters: {
      code: { type: "string", required: true },
      forks: { type: "array", required: true, description: '[{path, conclusion, evidence, status}] \u2014 status: "untaken" (default, \u672A\u8D70\u5206\u53C9\u2192\u2463+\u4FE1\u7BB1, \u4E3B agent \u7ECF xiaochang_wait \u5524\u9192) | "dead-end" (\u5DF2\u8BC1\u6B7B\u8DEF\u2192\u53EA\u8FDB\u2461, \u4E0D\u5524\u9192\u4E0D\u6D3E\u5175).' }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      if (args.forks.length === 0) return "xiaochang_fork: no forks given";
      const fmt = (f) => `${f.path}${f.conclusion !== void 0 ? " \u2192 " + f.conclusion : ""}${f.evidence !== void 0 ? " (\u8BC1\u636E: " + f.evidence + ")" : ""}`;
      const deadEnds = args.forks.filter((f) => f.status === "dead-end");
      const untaken = args.forks.filter((f) => f.status !== "dead-end");
      const deadLines = deadEnds.map(fmt);
      if (deadEnds.length > 0) {
        const de = deadEnds.map((f) => ({ kind: "dead-end", path: f.path, conclusion: f.conclusion, evidence: f.evidence, by: "fork", at: Date.now() }));
        try {
          recordKnowledgeOnCode(args.code, de);
        } catch {
        }
        try {
          appendKnowledgeFile(args.code, "dead", deadLines);
        } catch {
        }
      }
      const terminalNow = progressTerminal(args.code);
      let entries = [];
      let inbox = "";
      let skipped = 0;
      if (untaken.length > 0) {
        const existingPaths = [];
        try {
          existingPaths.push(...readForkInbox(args.code).map((k) => k.path));
        } catch {
        }
        const fresh = dedupeForkPaths(existingPaths, untaken);
        skipped = untaken.length - fresh.length;
        entries = fresh.map((f) => ({ kind: "fork", path: f.path, conclusion: f.conclusion, evidence: f.evidence, by: "fork", at: Date.now() }));
        if (entries.length > 0 && !terminalNow) {
          try {
            inbox = writeForkInbox(args.code, entries);
          } catch {
          }
        }
        if (entries.length > 0) {
          try {
            recordKnowledgeOnCode(args.code, entries);
          } catch {
          }
          try {
            appendKnowledgeFile(args.code, "forks", entries.map((f) => fmt(f)));
          } catch {
          }
        }
      }
      const parts = [];
      if (deadEnds.length > 0) parts.push(`\u6B7B\u8DEF ${deadEnds.length} \u6761\u5DF2\u9759\u9ED8\u5165\u8D26\u2461(\u4E0D\u5524\u9192\u4E0D\u6D3E\u5175)`);
      if (skipped > 0) parts.push(`\u91CD\u590D path ${skipped} \u6761\u5DF2\u5728\u4FE1\u7BB1\u4E2D, \u6E90\u7AEF\u8DF3\u8FC7(\u4E0D\u91CD\u590D\u4E0A\u62A5)`);
      if (entries.length > 0) {
        parts.push(inbox !== "" ? `\u672A\u8D70\u5206\u53C9 ${entries.length} \u6761\u5DF2\u5199\u5165\u4FE1\u7BB1(${inbox})\u2014\u2014\u4E3B agent \u7684 xiaochang_wait \u8F6E\u8BE2\u5230\u5373\u5524\u9192, \u4E0D\u6253\u65AD\u5176\u5F53\u524D turn` : "\u672A\u8D70\u5206\u53C9: \u4FE1\u7BB1\u672A\u5199(\u7EC8\u6001\u6291\u5236\u6216\u5199\u5165\u5931\u8D25)");
        if (terminalNow) parts.push("\u9898\u5DF2\u7EC8\u6001: \u4EC5\u5B58\u6863\u5165\u8D26, \u672A\u5199\u4FE1\u7BB1/\u672A\u5524\u9192(\u4E0D\u6D3E\u5175)");
      }
      return `fork ${parts.join("; ") || "nothing to record"}:
${[...deadLines.map((l) => `- \u274C${l}`), ...entries.map((f) => `- \u{1F500}${fmt(f)}`)].join("\n")}`;
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
      const header = args.code !== void 0 ? `knowledgeFile=${ensureKnowledgeFile(args.code)}
` : "";
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
      return header + rows.join("\n");
    }
  }));
  register(defineTool({
    name: "xiaochang_knowledge_put",
    description: "v7 per-challenge knowledge ledger write (main agent only): rewrite section \u2460 \u9898\u6E90\u601D\u8DEF\u9AA8\u67B6 (idea source + skeleton steps; the one section you own) and/or append \u2461\u4E0D\u53EF\u884C\u6559\u8BAD/\u2462\u56DE\u6536\u5DE5\u4EF6/\u2463\u672A\u8D70\u5206\u53C9. The file is auto-accumulated by mechanism for \u2461\u2462\u2463 (report/fork) \u2014 call this mainly to maintain \u2460 and to add your own lessons. Executors read this file at work start; retries continue from the frontier instead of re-identifying.",
    parameters: {
      code: { type: "string", required: true },
      skeleton: { type: "array", description: "\u2460 \u9898\u6E90\u601D\u8DEF\u9AA8\u67B6 (REPLACES the section): one line per idea \u2014 source (\u9898\u9762/hint/\u56FE\u8C31/\u5206\u53C9) + skeleton steps." },
      deadEnds: { type: "array", description: "\u2461 append: proven-infeasible paths / missing context." },
      artifacts: { type: "array", description: "\u2462 append: recyclable artifacts \u2014 credentials, file paths, URLs, scripts, findings." },
      forks: { type: "array", description: "\u2463 append: untaken branches worth dispatching." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (parentAgent !== void 0 && exec.agent !== parentAgent) {
        return "xiaochang_knowledge_put: \u62D2\u7EDD\u2014\u2014\u77E5\u8BC6\u8D26\u672C\u2460\u662F\u4E3B agent \u4E13\u5C5E(\u9632\u5E76\u53D1\u6539\u5199\u601D\u8DEF\u9AA8\u67B6); \u6267\u884C\u8005\u7528 xiaochang_fork \u4E0A\u62A5\u5206\u53C9\u5373\u53EF";
      }
      const s = requireState();
      if (s.challenges.get(args.code) === void 0) return `xiaochang_knowledge_put: unknown challenge ${args.code}`;
      const applied = [];
      try {
        if (args.skeleton !== void 0) {
          replaceKnowledgeFile(args.code, "skeleton", args.skeleton);
          applied.push(`\u2460 \u9AA8\u67B6\u6539\u5199 ${args.skeleton.length} \u6761`);
        }
        if (args.deadEnds !== void 0) {
          appendKnowledgeFile(args.code, "dead", args.deadEnds);
          applied.push(`\u2461 \u6B7B\u8DEF +${args.deadEnds.length}`);
        }
        if (args.artifacts !== void 0) {
          appendKnowledgeFile(args.code, "artifacts", args.artifacts);
          applied.push(`\u2462 \u5DE5\u4EF6 +${args.artifacts.length}`);
        }
        if (args.forks !== void 0) {
          appendKnowledgeFile(args.code, "forks", args.forks);
          applied.push(`\u2463 \u5206\u53C9 +${args.forks.length}`);
        }
      } catch {
      }
      try {
        syncKnowledgeFileFromLedger(args.code);
      } catch {
      }
      return `xiaochang_knowledge_put: ${applied.join(", ") || "nothing to write"}
\u8D26\u672C: ${knowledgeFilePath(args.code)}`;
    }
  }));
  register(defineTool({
    name: "xiaochang_status",
    description: "Campaign status: ledger summary, per-challenge progress, budget remaining, open containers.",
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const s = requireState();
      const views = c().ledger.views();
      const count = (fn) => views.filter(fn).length;
      const remaining = Math.max(0, s.startedAt + s.budgetMs - Date.now());
      const progress = s.progress.all().map((p) => `${p.code}:${p.state}${p.state === "complete" ? `(${p.flags.length} flags)` : ""}`).join(", ");
      const escLines = [];
      const listed = await jisi?.listModels() ?? [];
      for (const [code, q2] of Object.entries(s.v2)) {
        const p = s.progress.get(code);
        if (p === void 0 || p.state === "complete" || p.state === "failed" || p.state === "skipped") continue;
        const ff = filteredFailedOf(code, campaign);
        const views2 = (campaign?.ledger.views() ?? []).filter((v) => codeOf(v.item.id) === code);
        const lastProgress = Math.max(0, ...views2.map((v) => v.lastProgressAt ?? 0));
        const noProgressMin = lastProgress > 0 ? Math.round((Date.now() - lastProgress) / 6e4) : 0;
        const deadTexts = knowledgeOfCode(code).filter((k) => k.kind === "dead-end").map((k) => `${k.path} ${k.conclusion ?? ""}`);
        const cov = coverageOf(q2.qtype, deadTexts);
        const ch = s.challenges.get(code);
        const remainingPoints = ch !== void 0 ? Math.max(0, Math.round(ch.total_score * (1 - (ch.correct_flag_count ?? 0) / (ch.flag_count || 1)))) : 0;
        const modelExhaustion = listed.length === 0 ? 1 : q2.triedModels.length / listed.length;
        const ruling = jisi?.judge?.({
          troops: q2.triedModels.length,
          filteredFailed: ff.failed,
          noProgressMin,
          difficulty: q2.difficulty,
          coverageRatio: cov.ratio,
          remainingPoints,
          modelExhaustion: Math.min(1, modelExhaustion),
          r2Count: Math.max(0, q2.ideaRound - 1)
        });
        if (ruling === void 0) continue;
        const exclTxt = ff.excluded > 0 ? ` (\u6545\u969C\u8FC7\u6EE4\u5254\u9664 ${ff.excluded}: ${[...new Set(ff.excludedReasons)].join("+")})` : "";
        const descQ = (ch?.description ?? "").replace(/"/g, "'").slice(0, 80);
        const searchHint = `
   \u{1F50D} \u5148\u641C\u516C\u5F00\u8D44\u6599\u518D\u5347\u7EA7: web_search("${code} ${descQ}") \u2192 \u7ED3\u679C\u5199\u8FDB\u8D26\u672C\u2462(xiaochang_knowledge_put artifacts); \u82E5\u641C\u7D22\u62A5\u9519(\u6258\u7BA1\u6C99\u7BB1\u65E0\u5916\u7F51)\u5219\u8DF3\u8FC7, \u76F4\u63A5 xiaochang_refanout, \u4E0D\u8981\u91CD\u8BD5\u641C\u7D22`;
        if (ruling.action === "escalate") escLines.push(`\u26A0\uFE0F ${code}: ${ruling.reasons[0] ?? ""}${exclTxt}${searchHint}`);
        if (ruling.action === "judge-dead") escLines.push(`\u26D4 ${code}: ${ruling.reasons[0] ?? ""}${exclTxt}${searchHint}`);
      }
      if (remaining <= 60 * 6e4) {
        const hardOpen = [];
        for (const [code, q2] of Object.entries(s.v2)) {
          const p = s.progress.get(code);
          if (p !== void 0 && (p.state === "complete" || p.state === "failed" || p.state === "skipped")) continue;
          if (q2.difficulty >= 55 && q2.lastVerdict !== "complete") hardOpen.push(code);
        }
        for (const code of hardOpen.slice(0, 3)) {
          const q2 = s.v2[code];
          if (q2.autoR2 !== true) {
            q2.autoR2 = true;
            s.v2[code] = q2;
            persistV2(s);
            if (jisi?.fanoutNotify !== void 0) {
              const prompt = buildRefanoutPrompt(code);
              const models = await pickRefanoutModels(q2);
              const ticket = jisi.fanoutNotify(parentAgent ?? exec?.agent, { prompt }, models);
              q2.ideaRound += 1;
              q2.triedModels.push(...models.filter((m) => !q2.triedModels.includes(m)));
              s.v2[code] = q2;
              persistV2(s);
              escLines.push(`\u23F0 \u672B\u6BB5\u81EA\u52A8 R2: ${code} \u5DF2\u81EA\u52A8\u53D1\u8D77\u4E8C\u6B21\u5F81\u96C6(${models.join(", ")}, ticket ${ticket.id})\u2014\u2014\u53EF jisi_fanout_drop \u6539\u5224`);
            } else {
              escLines.push(`\u23F0 \u672B\u6BB5\u8D76\u5DE5: ${code} \u672A\u7834\u4E14 jisi \u901A\u9053\u4E0D\u53EF\u7528 \u2192 \u624B\u52A8 xiaochang_refanout`);
            }
          }
        }
      }
      const escTxt = escLines.length > 0 ? `
\u5347\u7EA7\u5EFA\u8BAE:
${escLines.join("\n")}` : "";
      const usage = c().classUsage?.() ?? {};
      const usageTxt = Object.entries(usage).map(([cls, u]) => `${cls} ${u.open}/${u.limit}`).join(", ") || "n/a";
      const q = s.containerQueue;
      const qLine = q !== void 0 ? `containerQueue: granted=${q.grantedCount?.() ?? "?"}/${s.containerSlots} waiters=[${q.waiters().map((w) => w.holderId).join(",") || "\u65E0"}]` : "containerQueue: \u672A\u521D\u59CB\u5316";
      const now = Date.now();
      const pendingTxt = s.pendingAdj.length === 0 ? "\u65E0" : s.pendingAdj.map((pa) => `  ${pa.code} [${pa.kind}] ${pa.summary}${now - pa.createdAt > 30 * 6e4 ? " \u26A0\uFE0F\u672A\u88C1\u51B3>30min" : ""}`).join("\n");
      const orchCount = (st) => [...s.orch.values()].filter((o) => o.state === st).length;
      const openByCode = /* @__PURE__ */ new Map();
      for (const v of c().ledger.views()) {
        if (v.state !== "dispatched" && v.state !== "help" && v.state !== "stalled") continue;
        const code = codeOf(v.item.id);
        openByCode.set(code, (openByCode.get(code) ?? 0) + 1);
      }
      const unsolved = [...s.challenges.keys()].filter((code) => {
        const p = s.progress.get(code);
        return p === void 0 || p.state !== "complete" && p.state !== "failed" && p.state !== "skipped";
      });
      unsolved.sort((a, b) => {
        const oa = s.orch.get(a);
        const ob = s.orch.get(b);
        return compareRisk(
          oa ?? newOrch(a, s.startedAt),
          ob ?? newOrch(b, s.startedAt),
          s.challenges.get(a)?.total_score ?? 300,
          s.challenges.get(b)?.total_score ?? 300
        );
      });
      const unsolvedTxt = unsolved.length === 0 ? "\u65E0" : unsolved.map((code) => {
        const o = s.orch.get(code);
        if (o === void 0) return `${code}(\u65E0\u7F16\u6392\u6001)`;
        const inF = openByCode.get(code) ?? 0;
        const box = o.grantedUntil !== void 0 ? `/\u76D2\u5269${Math.max(0, Math.round((o.grantedUntil - now) / 6e4))}m` : "";
        const ladder = o.zeroProgressStreak > 0 ? `/\u68AF${o.zeroProgressStreak}` : "";
        const never = o.neverDispatched ? "/\u4ECE\u672A\u5F00\u5DE5" : "";
        return `${code}[${o.state}\xB7\u5728\u9014${inF}\xB7\u8BD5${o.attempts}${ladder}${box}${never}]`;
      }).join(" ");
      return [
        `campaign: open=${count((v) => v.state === "dispatched" || v.state === "help")} queued=${count((v) => v.state === "queued")} done=${count((v) => v.state === "done")} failed=${count((v) => v.state === "failed")} blocked=${count((v) => v.state === "blocked")}`,
        `resourceClasses: ${usageTxt}`,
        `orch: queued=${orchCount("queued")} granted=${orchCount("granted")} pending-adjudication=${orchCount("pending-adjudication")} solved=${orchCount("solved")} dead=${orchCount("dead")}`,
        `v8\u5FC3\u8DF3: tick=${s.tickCount} armed=${s.armed.size} grantedCodes=${s.grantedCodes.size} spawnQueue=${spawnQueue.length} spawning=${spawning}`,
        qLine,
        `budgetRemainingMin=${Math.round(remaining / 6e4)}`,
        `runScore(\u8BA1\u5206\u8868)=${runScoreOf(s)}${s.hintLedger.totalHints() > 0 ? `(hint \u5DF2\u6263\u7EA6 ${s.hintLedger.totalDeducted()} \u5206, \u5DF2\u542B)` : ""}`,
        `${(() => {
          const folded = foldFlags(readFlagEntries());
          let pend = 0;
          let acc = 0;
          let rej = 0;
          for (const m of folded.values()) for (const e of m.values()) {
            if (e.status === "pending") pend += 1;
            else if (e.status === "accepted") acc += 1;
            else rej += 1;
          }
          return "\u65D7\u4ED3: pending=" + pend + " accepted=" + acc + " rejected=" + rej;
        })()}`,
        `${(() => {
          const clusters = /* @__PURE__ */ new Map();
          for (const ch of s.challenges.values()) {
            const key = [...ch.container_addr].sort().join("|");
            if (key === "") continue;
            const list = clusters.get(key) ?? [];
            list.push(ch.unique_code);
            clusters.set(key, list);
          }
          const multi = [...clusters.values()].filter((l) => l.length > 1);
          return multi.length > 0 ? "\u540C\u9776\u573A\u7C07: " + multi.map((l) => l.sort().join("\u2194")).join(" | ") : "\u540C\u9776\u573A\u7C07: \u65E0";
        })()}`,
        `openContainers(\u5E73\u53F0\u89C6\u89D2, \u5F02\u6B65\u66F4\u65B0\u4F1A\u6EDE\u540E; \u69FD\u771F\u76F8\u4EE5 containerQueue \u884C\u4E3A\u51C6)=${[...openContainers(s)].join(",") || "none"}`,
        `hints=${s.hintLedger.totalHints()} (deducted ${s.hintLedger.totalDeducted()})`,
        `\u5F85\u88C1\u51B3(${s.pendingAdj.length}):
${pendingTxt}`,
        `\u672A\u7834\u9898(\u5168\u91CF\xB7\u98CE\u9669\u6392\u5E8F): ${unsolvedTxt}`,
        `progress: ${progress}`,
        escTxt
      ].join("\n");
    }
  }));
  register(defineTool({
    name: "xiaochang_wait",
    description: "Event-driven wait (F30): blocks the turn without spending any LLM tokens until (a) an executor settles, (b) the campaign ledger changes, (c) a new session message arrives, (d) a fork lands in the fork inbox for a NON-terminal challenge (executor xiaochang_fork; v7.1: late forks of already-terminal challenges are archived silently), or (e) the timeout. v7.6: pass code to wait ONLY on your own challenge (single-challenge executors MUST pass it \u2014 other challenges' activity will not wake you; global waits omit it). This is THE way to wait \u2014 never bash sleep for waiting.",
    parameters: {
      timeoutSeconds: { type: "number", description: "Max wait seconds (default 300, clamp 5..900)." },
      code: { type: "string", description: "v7.6 filter: only wake on events of this challenge (single-challenge executors must pass it)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const timeoutMs = Math.min(Math.max(args.timeoutSeconds ?? 300, 5), 900) * 1e3;
      const agent = exec.agent;
      const codeFilter = args.code;
      const ledgerSnap = () => {
        try {
          const views = campaign?.ledger.views() ?? [];
          const picked = codeFilter !== void 0 ? views.filter((v) => codeOf(v.item.id) === codeFilter) : views;
          return JSON.stringify(picked.map((v) => [v.item.id, v.state, v.terminalDetail ?? "", v.lastProgressAt ?? 0]));
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
        const unsub = campaignId !== void 0 && holder.onSettle !== void 0 ? holder.onSettle(campaignId, (ev) => {
          if (codeFilter !== void 0 && codeOf(ev.itemId) !== codeFilter) return;
          done(`xiaochang_wait: ${ev.itemId} settled (${ev.status})${ev.text !== "" ? ": " + ev.text.slice(0, 200) : ""}`);
        }) : () => {
        };
        const before = ledgerSnap();
        const iv = setInterval(() => {
          if (ledgerSnap() !== before) done("xiaochang_wait: campaign ledger changed");
        }, 2e3);
        const orchBefore = state?.orchVersion ?? 0;
        const oiv = setInterval(() => {
          if (state !== void 0 && state.orchVersion !== orchBefore) {
            done("xiaochang_wait: \u7F16\u6392\u6001\u53D8\u5316(settle \u7ED3\u7B97/\u56DE\u961F/\u88C1\u51B3/\u65F6\u95F4\u76D2)\u2014\u2014\u8BFB xiaochang_status");
          }
        }, 2e3);
        const flagSnap = () => {
          try {
            const pth = flagsPath();
            if (!existsSync(pth)) return "";
            const st = statSync2(pth);
            return `${st.mtimeMs}:${st.size}`;
          } catch {
            return "";
          }
        };
        let flagsBefore = flagSnap();
        const fgv = setInterval(() => {
          if (state === void 0) return;
          const nowSnap = flagSnap();
          if (nowSnap !== flagsBefore) {
            flagsBefore = nowSnap;
            done("xiaochang_wait: \u65D7\u4ED3\u65B0\u4E0A\u62A5\u2014\u2014\u8BFB xiaochang_flag_status \u5E76\u7ACB\u5373 xiaochang_submit");
          }
        }, 2e3);
        const seqBefore = agent?.session.seq ?? 0;
        const sv = setInterval(() => {
          if (agent !== void 0 && agent.session.seq > seqBefore) done("xiaochang_wait: session message arrived");
        }, 2e3);
        const inboxDir = forkInboxDir();
        const inboxSnap = () => {
          try {
            if (!existsSync(inboxDir)) return "";
            const files = codeFilter !== void 0 ? readdirSync2(inboxDir).filter((f) => f.endsWith(".jsonl") && f.replace(/\.jsonl$/, "") === codeFilter) : readdirSync2(inboxDir).filter((f) => f.endsWith(".jsonl"));
            return files.map((f) => {
              const st = statSync2(join2(inboxDir, f));
              return `${f}:${st.mtimeMs}:${st.size}`;
            }).join("|");
          } catch {
            return "";
          }
        };
        const evaluateInbox = (onlyCode) => {
          try {
            if (!existsSync(inboxDir)) return false;
            let live = false;
            for (const f of readdirSync2(inboxDir).filter((f2) => f2.endsWith(".jsonl"))) {
              const code = f.replace(/\.jsonl$/, "");
              if (onlyCode !== void 0 && code !== onlyCode) continue;
              if (!progressTerminal(code)) live = true;
              try {
                absorbForkInbox(code);
              } catch {
              }
            }
            return live;
          } catch {
            return true;
          }
        };
        let inboxBefore = inboxSnap();
        const fv = setInterval(() => {
          if (inboxSnap() === inboxBefore) return;
          inboxBefore = inboxSnap();
          if (state === void 0) {
            done("xiaochang_wait: fork inbox changed \u2014 read xiaochang_graph and dispatch the untaken branches");
            return;
          }
          if (evaluateInbox(codeFilter)) done("xiaochang_wait: fork inbox changed \u2014 read xiaochang_graph and dispatch the untaken branches");
        }, 2e3);
        const to = setTimeout(() => done(`xiaochang_wait: timeout after ${Math.round(timeoutMs / 1e3)}s, no event`), timeoutMs);
        cleanup = () => {
          unsub();
          clearInterval(iv);
          clearInterval(oiv);
          clearInterval(fgv);
          clearInterval(sv);
          clearInterval(fv);
          clearTimeout(to);
        };
        if (state !== void 0 && evaluateInbox(codeFilter)) {
          inboxBefore = inboxSnap();
          done("xiaochang_wait: fork inbox changed \u2014 read xiaochang_graph and dispatch the untaken branches");
        }
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
    async execute(args, exec) {
      if (parentAgent !== void 0 && exec.agent !== parentAgent) {
        return "xiaochang_finish: \u62D2\u7EDD\u2014\u2014\u6536\u5B98\u662F\u4E3B agent \u4E13\u5C5E(\u5355\u8C03\u5EA6\u5668); \u6267\u884C\u8005\u89E3\u5B8C\u9898\u76F4\u63A5\u6536\u5DE5\u5373\u53EF";
      }
      const s = requireState();
      let closedCount = 0;
      for (const ch of s.challenges.values()) {
        if (ch.container_status === "available" || ch.container_status === "pending") {
          try {
            await s.adapter.close(ch.unique_code);
          } catch {
          }
          closedCount += 1;
        }
        s.progress.update(ch.unique_code, { containerClosed: true });
      }
      for (const code of [...s.grantedCodes]) await releaseGrant(code);
      for (const w of s.containerQueue?.waiters() ?? []) {
        try {
          s.containerQueue?.evict(w.holderId, "campaign finished");
        } catch {
        }
      }
      if (tickTimer !== void 0) {
        clearInterval(tickTimer);
        tickTimer = void 0;
      }
      s.armed.clear();
      bumpOrch(s);
      persistOrch(s);
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
      const rs = runScoreOf(s);
      return `xiaochang_finish: score=${rs > 0 ? rs : score.score}/${score.max} (${score.completed}/${final.length} completed${score.completed === final.length ? ", ALL TERMINAL" : ""}${rs > 0 ? ", \u8BA1\u5206\u8868(\u5E73\u53F0\u6BCF\u9898\u7D2F\u8BA1\u5206\u6C42\u548C)" : ", \u672C\u5730\u4F30\u7B97\u5206"})
\u6392\u540D\u949F\uFF1A${clock}${guardMarker}`;
    }
  }));
}
export {
  apply,
  inject,
  name
};
