#!/usr/bin/env python3
"""
托管模式打包审计（clean-room 门禁，打包前必跑）。

依据: packaging/HOSTED-PACK-MANIFEST.md(白名单/黑名单/审计规则)。
行为: 扫描目录树, 输出违规报告; 有违规退出码 1(阻断打包), 干净退出 0。
用法:
  python3 hosted-pack-audit.py <目录> [--json]
自测:
  python3 hosted-pack-audit.py --self-test
"""

import argparse
import json
import os
import re
import sys

# ── 路径级黑名单(文件名或路径片段, 命中即违规) ──────────────────────
PATH_DENY = [
    "hosted-priors.md", "SOLUTIONS", "DEAD-ENDS", "creds-corpus",
    "xiaochang-archive", "boards", ".secrets", "storages",
    ".dsh", ".archive", "run-launch.sh", ".ovpn",
]

# 文件名模式(正则, 不区分大小写)
FILENAME_DENY = [
    re.compile(r".*-order\.txt$", re.I),          # 开战令(含 token)
    re.compile(r"run\d*-launch\.sh$", re.I),      # launch 脚本(含密钥)
    re.compile(r"(retro|war-report|plan|l4)-.*\.md$", re.I),  # 历史复盘/计划/战报
    re.compile(r".*\.jsonl$", re.I),              # usage/audit/snapshot 账本
]

# ── 内容级规则 ────────────────────────────────────────────────────────
CONTENT_RULES = [
    {
        "name": "flag-value",
        "pattern": re.compile(r"\b(?:flag|FLAG|HTB|SEKAI|gctf|hkcert22)\{[^}\s]{6,}\}"),
    },
    {"name": "api-key-sk", "pattern": re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b")},
    {"name": "api-key-zhipu", "pattern": re.compile(r"\b[a-f0-9]{32}\.[A-Za-z0-9]{16,}\b")},
    {"name": "bearer-jwt", "pattern": re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")},
    {
        "name": "known-credential",
        "pattern": re.compile(r"(sysadmin|weaveradmin)/Weaver@2001|ThisIsBestPassword|emppassword|sup3rsecr3t"),
    },
    {
        "name": "benchmark-token-literal",
        "pattern": re.compile(r"BENCHMARK_TOKEN\s*=\s*[A-Za-z0-9\-]{16,}"),
    },
]

# 扫描跳过(体积/速度); 二进制按 NUL 字节检测跳过
SKIP_DIRS = {"node_modules", ".git", "__pycache__"}
TEXT_MAX_BYTES = 4 * 1024 * 1024  # 超 4MB 的文本跳过(附注)


def is_text(data: bytes) -> bool:
    return b"\x00" not in data[:8192]


def scan_file(full_path: str, rel_path: str, violations: list) -> None:
    try:
        with open(full_path, "rb") as f:
            data = f.read()
    except OSError as exc:
        violations.append({"file": rel_path, "rule": "unreadable", "sample": str(exc)[:80]})
        return
    if not is_text(data):
        return
    if len(data) > TEXT_MAX_BYTES:
        violations.append({"file": rel_path, "rule": "too-large-skipped", "sample": f"{len(data)} bytes"})
        return
    text = data.decode("utf-8", errors="replace")
    for rule in CONTENT_RULES:
        m = rule["pattern"].search(text)
        if m:
            violations.append({"file": rel_path, "rule": rule["name"], "sample": m.group(0)[:80]})


def validate_seed(full_path: str, rel: str) -> list:
    """F33 ① 种子结构校验: 只允许 models[].dimensions.execution(规则 6 审计豁免的边界)。"""
    try:
        with open(full_path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as exc:
        return [{"file": rel, "rule": "seed-invalid-json", "sample": str(exc)[:80]}]
    if not isinstance(data, dict) or not isinstance(data.get("models"), dict):
        return [{"file": rel, "rule": "seed-bad-structure", "sample": "missing models object"}]
    violations = []
    for name, m in data["models"].items():
        dims = (m or {}).get("dimensions") if isinstance(m, dict) else None
        if not isinstance(dims, dict):
            violations.append({"file": rel, "rule": "seed-bad-structure", "sample": f"{name}: no dimensions"})
            continue
        extra = set(dims) - {"execution"}
        if extra:
            violations.append({"file": rel, "rule": "seed-forbidden-dimension", "sample": f"{name}: {sorted(extra)}"})
    return violations


def scan_tree(root: str) -> list:
    violations: list = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for d in list(dirnames):
            if d == "storages":
                # F33 ① 例外: storages 只允许 jisi-model-ledger.seed.json(结构校验), 其余全阻断。
                storages_dir = os.path.join(dirpath, d)
                try:
                    entries = os.listdir(storages_dir)
                except OSError:
                    entries = []
                for sfn in entries:
                    sp = os.path.join(storages_dir, sfn)
                    srel = os.path.relpath(sp, root).replace(os.sep, "/")
                    if os.path.isfile(sp) and sfn == "jisi-model-ledger.seed.json":
                        violations.extend(validate_seed(sp, srel))
                        scan_file(sp, srel, violations)
                    else:
                        violations.append({"file": srel, "rule": "denied-path", "sample": f"storages/{sfn}"})
                dirnames.remove(d)
                continue
            if any(p in d for p in PATH_DENY):
                violations.append(
                    {"file": os.path.join(dirpath, d), "rule": "denied-path", "sample": d}
                )
                dirnames.remove(d)
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root)
            if any(p in rel.replace(os.sep, "/") for p in PATH_DENY):
                violations.append({"file": rel.replace(os.sep, "/"), "rule": "denied-path", "sample": rel})
                continue
            if fn == "jisi-model-ledger.seed.json":
                violations.extend(validate_seed(full, rel.replace(os.sep, "/")))
                scan_file(full, rel.replace(os.sep, "/"), violations)
                continue
            if any(rx.match(fn) for rx in FILENAME_DENY):
                violations.append({"file": rel.replace(os.sep, "/"), "rule": "denied-filename", "sample": fn})
                continue
            scan_file(full, rel.replace(os.sep, "/"), violations)
    return violations


SELF_TEST_FIXTURES = {
    "good/README.md": "# clean file, nothing here",
    "good/skills/SKILL.md": "通用方法论: 先派单再深挖。",
    "bad/flag.txt": "flag{this-is-a-real-looking-flag}",
    "bad/keys.txt": "sk-abcdefghijklmnopqrst",
    "bad/hosted-priors.md": "机制先验内容",
    "bad/run9-order.txt": "BENCHMARK_TOKEN=69c960a7-ca0f-467e-9fbf-76591e164b92",
    "good/storages/jisi-model-ledger.seed.json": json.dumps(
        {"models": {"m1": {"dimensions": {"execution": {"easy": {"attempts": 3, "wins": 3}}}}}}
    ),
    "bad2/storages/jisi-model-ledger.seed.json": json.dumps(
        {"models": {"m1": {"dimensions": {"execution": {}, "idea": {"x": {"attempts": 1, "wins": 1}}}}}}
    ),
    "bad2/storages/other.json": "should be denied",
}


def self_test() -> int:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        for rel, content in SELF_TEST_FIXTURES.items():
            p = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(content)
        violations = scan_tree(tmp)
        got = {(v["file"].replace(os.sep, "/"), v["rule"]) for v in violations}
        want = {
            ("bad/flag.txt", "flag-value"),
            ("bad/keys.txt", "api-key-sk"),
            ("bad/hosted-priors.md", "denied-path"),
            ("bad/run9-order.txt", "denied-filename"),
            ("bad2/storages/jisi-model-ledger.seed.json", "seed-forbidden-dimension"),
            ("bad2/storages/other.json", "denied-path"),
        }
        if want <= got:
            print(f"self-test PASS ({len(violations)} violations)")
            return 0
        print(f"self-test FAIL: want {sorted(want)} got {sorted(got)}")
        return 1


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description="托管模式打包审计")
    parser.add_argument("path", nargs="?", help="要扫描的目录")
    parser.add_argument("--json", action="store_true", help="JSON 输出")
    parser.add_argument("--self-test", action="store_true", help="跑自测")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    if not args.path or not os.path.isdir(args.path):
        parser.error("需要目录路径(或 --self-test)")
    violations = scan_tree(args.path)
    if args.json:
        print(json.dumps({"violations": violations, "clean": not violations}, ensure_ascii=False))
    else:
        for v in violations:
            print(f"[{v['rule']}] {v['file']}: {v['sample']}")
        print(f"{len(violations)} violation(s)" + ("" if violations else " — CLEAN"))
    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
