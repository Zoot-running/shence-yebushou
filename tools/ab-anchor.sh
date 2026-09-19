#!/bin/bash
# 风神/锚定 A/B 干跑: 同 mock 同题, A=Standard persona, B=Anchored persona(DSH_ANCHOR_TEST=1)。
# 每臂 ~35min(预算内), 两臂串行 ~75min。证据: /tmp/dryrun-ab-{A,B}/driver.log + DEV_HOME storages。
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DSH_BIN="${DSH_BIN:-/tmp/hosted-build/dsh/apps/cli/lib/bin.js}"
DEV_HOME="${DEV_HOME:-/home/zrn/.dsh-dev}"
MOCK_PORT="${MOCK_PORT:-8399}"
DSK="$(grep -oE 'sk-[A-Za-z0-9]+' "$REPO/../.secrets/api-keys.md" | head -1)"

node "$REPO/tools/mock-tsecbench.mjs" "$MOCK_PORT" > /tmp/dryrun-ab-mock.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
sleep 1
curl -sf "http://127.0.0.1:$MOCK_PORT/health" >/dev/null || { echo "mock not up"; exit 1; }

for spec in "$REPO/packages/runner" "$REPO/../shence-jisi" "$REPO/../shence-hufu" "$REPO/../shence-dsh-compat"; do
  pkg="$(node -e "console.log(require('$spec/package.json').name)")"
  DSH_HOME="$DEV_HOME" node "$DSH_BIN" plugin --profile headless rm "$pkg" > /dev/null 2>&1 || true
  DSH_HOME="$DEV_HOME" node "$DSH_BIN" plugin --profile headless add "file:$spec" > /dev/null 2>&1
done

run_arm() {
  local ARM="$1"   # A | B
  local OUT="/tmp/dryrun-ab-$ARM"
  sudo rm -rf "$DEV_HOME/storages/xiaochang-fork-inbox" "$DEV_HOME/storages/hufu-campaigns"
  sudo rm -f "$DEV_HOME/storages/xiaochang-run-pending.jsonl" "$DEV_HOME/storages/xiaochang-v2-pending.json" \
             "$DEV_HOME/storages/xiaochang-orch-pending.json" "$DEV_HOME/storages/xiaochang-run-audit.jsonl"
  mkdir -p "$OUT"
  sudo cp "$REPO/skills/xiaochang/SKILL.md" /opt/xiaochang-skill.md
  local WORK="/tmp/dryrun-ab-$ARM-work"; sudo rm -rf "$WORK"; mkdir -p "$WORK"
  cd "$WORK"
  if [ "$ARM" = "B" ]; then export DSH_ANCHOR_TEST=1; else unset DSH_ANCHOR_TEST; fi
  DSH_HOME="$DEV_HOME" DEEPSEEK_BASE_URL=https://api.deepseek.com DEEPSEEK_API_KEY="$DSK" \
    timeout 2400 node "$DSH_BIN" --profile headless "$(cat "$REPO/tools/dryrun-order-ab.txt")" > "$OUT/driver.log" 2>&1 || true
  # 证据归档
  sudo cp "$DEV_HOME/storages/xiaochang-run-audit.jsonl" "$OUT/audit.jsonl" 2>/dev/null || true
  sudo cp -r "$DEV_HOME/storages/hufu-campaigns" "$OUT/campaigns" 2>/dev/null || true
  echo "── arm $ARM 完成: 证据在 $OUT"
}

run_arm A
run_arm B
echo "── A/B 两臂完成, 汇总见 tools/ab-report.mjs"
