var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/index.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
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
var state;
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
function persistProgress(s) {
  try {
    mkdirSync(join(s.snapshotPath, ".."), { recursive: true });
    appendFileSync(s.snapshotPath, `${s.progress.line()}
`);
  } catch {
  }
}
function persistProfile(s) {
  try {
    mkdirSync(join(s.profilePath, ".."), { recursive: true });
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
  const { readdirSync, statSync } = __require("node:fs");
  const out = [];
  for (const name2 of readdirSync(dir)) {
    const full = join(dir, name2);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
function apply(ctx) {
  const jisi = ctx.get?.("jisi");
  const holder = ctx.hufu;
  let campaign;
  const c = () => {
    if (campaign === void 0) throw new Error("xiaochang: not set up \u2014 call xiaochang_setup first");
    return campaign;
  };
  const register = (tool) => ctx.tools.register(tool);
  register(defineTool({
    name: "xiaochang_setup",
    description: "Set up (or resume) the tsecbench campaign state: platform adapter, hufu campaign (large slots, no artificial threshold), progress/profile restore. Idempotent \u2014 calling again resumes from the snapshot.",
    parameters: {
      baseURL: { type: "string", description: "BENCHMARK_BASE_URL (defaults to env)." },
      benchmarkToken: { type: "string", description: "BENCHMARK_TOKEN (defaults to env)." },
      runBearerToken: { type: "string", description: "Platform session Bearer token for early finish (stop the ranking clock)." },
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
      const env = process.env;
      const baseURL = args.baseURL ?? env.BENCHMARK_BASE_URL;
      const benchmarkToken = args.benchmarkToken ?? env.BENCHMARK_TOKEN;
      if (baseURL === void 0 || benchmarkToken === void 0) {
        return "xiaochang_setup: BENCHMARK_BASE_URL and BENCHMARK_TOKEN required (args or env)";
      }
      const home = env.DSH_HOME ?? ".";
      const snapshotPath = join(home, "storages", "xiaochang-run.jsonl");
      let progress = new RunProgress();
      let startedAt = Date.now();
      if (existsSync(snapshotPath)) {
        const lines = readFileSync(snapshotPath, "utf8").split("\n").filter((l) => l.trim() !== "");
        progress = RunProgress.restore(lines);
        const first = lines.length > 0 ? JSON.parse(lines[0]).at : void 0;
        if (first !== void 0) startedAt = first;
      }
      const s = {
        baseURL,
        benchmarkToken,
        runBearerToken: args.runBearerToken,
        runId: args.runId,
        concurrency: args.concurrency ?? 999,
        budgetMs: (args.budgetMinutes ?? 330) * 6e4,
        roundTimeoutMs: (args.roundTimeoutMinutes ?? 30) * 6e4,
        maxHints: args.maxHintsPerChallenge ?? 1,
        vpnGateway: args.vpnGateway ?? "http://10.0.100.58",
        knowledgeDir: args.knowledgeDir ?? join(home, "storages", "xiaochang-knowledge"),
        profilePath: args.profilePath ?? join(home, "storages", "xiaochang-profile.md"),
        snapshotPath,
        auditPath: join(home, "storages", "xiaochang-run-audit.jsonl"),
        startedAt,
        adapter: new TsecbenchAdapter({ baseURL, benchmarkToken, vpnGateway: args.vpnGateway ?? "http://10.0.100.58" }, nodeFetch()),
        progress,
        profile: createProfile("tsecbench-set"),
        hintLedger: new HintLedger(),
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
      campaign = holder.createCampaign(agent, {
        concurrency: s.concurrency,
        stallAfterMs: s.roundTimeoutMs + 10 * 6e4,
        heartbeatMs: 15 * 6e4,
        budgetMs: s.budgetMs
      }, []).campaign;
      if (!await s.adapter.gatewayHealthy()) {
        return "xiaochang_setup: VPN gateway not healthy \u2014 connect the run VPN first";
      }
      const fresh = await s.adapter.listChallenges();
      for (const ch of fresh) s.challenges.set(ch.unique_code, ch);
      persistProgress(s);
      return `xiaochang_setup ok: ${fresh.length} challenges, concurrency=${s.concurrency} (no threshold), budget ${Math.round(s.budgetMs / 6e4)}min, resume=${progress.all().length > 0}`;
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
    async execute(args) {
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
      const seq = s.progress.get(args.code)?.rounds ?? 0;
      const itemId = `${args.code}#s${args.round}-w${seq + 1}`;
      const executor = resolveExecutor({ model: args.model, effort: args.effort }, s.executorPolicy);
      c().add({
        id: itemId,
        label: args.prompt,
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
      reason: { type: "string", description: "Short reason (logged)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const s = requireState();
      const verdict = args.verdict === "complete" ? "complete" : args.verdict === "failed" ? "failed" : "skipped";
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
      return [
        `campaign: open=${count((v) => v.state === "dispatched" || v.state === "help")} queued=${count((v) => v.state === "queued")} done=${count((v) => v.state === "done")} failed=${count((v) => v.state === "failed")} blocked=${count((v) => v.state === "blocked")}`,
        `budgetRemainingMin=${Math.round(remaining / 6e4)}`,
        `openContainers=${[...openContainers(s)].join(",") || "none"}`,
        `hints=${s.hintLedger.totalHints()} (deducted ${s.hintLedger.totalDeducted()})`,
        `progress: ${progress}`
      ].join("\n");
    }
  }));
  register(defineTool({
    name: "xiaochang_finish",
    description: "Close all open containers, stop the ranking clock via the platform finish endpoint (when all challenges are terminal or you decide to end), and return the final platform score.",
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute() {
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
      const final = await s.adapter.listChallenges();
      const score = s.adapter.scoreOf(final);
      const allTerminal = final.every((ch) => ch.is_completed || ["failed", "skipped"].includes(s.progress.get(ch.unique_code)?.state ?? ""));
      if (allTerminal && s.runBearerToken !== void 0 && s.runId !== void 0) {
        try {
          const res = await fetch(`${s.baseURL}/api/v1/runs/${s.runId}/finish`, {
            method: "POST",
            headers: { authorization: `Bearer ${s.runBearerToken}` }
          });
          if (!res.ok) throw new Error(`finish ${res.status}`);
        } catch (error) {
          console.error(`xiaochang: finishRun failed: ${String(error)}`);
        }
      }
      return `xiaochang_finish: score=${score.score}/${score.max} (${score.completed}/${final.length} completed${score.completed === final.length ? ", ALL TERMINAL" : ""})`;
    }
  }));
}
export {
  apply,
  inject,
  name
};
