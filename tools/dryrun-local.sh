#!/bin/bash
# 本地干跑(不碰 docker): mock 平台 + 本地 headless(与沙箱同版 DSH checkout)。
# 流程: 讨论→改码→单测→本脚本干跑→上仓库; 托管打包时才进 docker。
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DSH_BIN="${DSH_BIN:-/tmp/hosted-build/dsh/apps/cli/lib/bin.js}"
DEV_HOME="${DEV_HOME:-/home/zrn/.dsh-dev}"
MOCK_PORT="${MOCK_PORT:-8399}"
node "$REPO/tools/mock-tsecbench.mjs" "$MOCK_PORT" > /tmp/dryrun-mock.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
sleep 1
curl -sf "http://127.0.0.1:$MOCK_PORT/health" >/dev/null || { echo "mock not up"; exit 1; }
DSK="$(grep -oE 'sk-[A-Za-z0-9]+' "$REPO/../.secrets/api-keys.md" | head -1)"
# 关键: dev profile 的 file: 安装是"拷贝"——每次干跑前必须重装四个插件, 否则跑的是旧 lib(2026-09-14 实锤)。
for spec in "$REPO/packages/runner" "$REPO/../shence-jisi" "$REPO/../shence-hufu" "$REPO/../shence-dsh-compat"; do
  pkg="$(node -e "console.log(require('$spec/package.json').name)")"
  DSH_HOME="$DEV_HOME" node "$DSH_BIN" plugin --profile headless rm "$pkg" > /dev/null 2>&1 || true
  DSH_HOME="$DEV_HOME" node "$DSH_BIN" plugin --profile headless add "file:$spec" > /dev/null 2>&1
done
# 清理上次干跑残留(dev home 的 storages)——进度快照也要清: setup 从它恢复 startedAt,
# 旧快照会让 budget 起点在"过去" → 预算瞬间过期 → freeSlots=0 派不出单(2026-09-15 实锤)。
sudo rm -rf "$DEV_HOME/storages/xiaochang-fork-inbox" "$DEV_HOME/storages/hufu-campaigns"
sudo rm -f "$DEV_HOME/storages/xiaochang-run-pending.jsonl" "$DEV_HOME/storages/xiaochang-v2-pending.json" "$DEV_HOME/storages/xiaochang-orch-pending.json" "$DEV_HOME/storages/xiaochang-flags.jsonl"
# 关键: driver 必须在专用 workdir 跑——runner 的 pre-run sweep 会清扫 cwd 的"旧工件",
# 从仓库目录开跑会把整个仓库扫进 .archive(2026-09-14 实锤, 已修)。
WORK="/tmp/dryrun-work"; sudo rm -rf "$WORK"; mkdir -p "$WORK"
sudo cp "$REPO/skills/xiaochang/SKILL.md" /opt/xiaochang-skill.md
cd "$WORK"
DSH_HOME="$DEV_HOME" DEEPSEEK_BASE_URL=https://api.deepseek.com DEEPSEEK_API_KEY="$DSK" \
  timeout 3300 node "$DSH_BIN" --profile headless "$(cat "$REPO/tools/dryrun-order.txt")" > /tmp/dryrun-driver.log 2>&1 || true
echo "── 干跑证据(dev home storages) ──"
SNAP=$(find "$DEV_HOME/storages/hufu-campaigns" -name "*.json" 2>/dev/null | head -1)
echo "[分叉信箱]"; ls "$DEV_HOME/storages/xiaochang-fork-inbox/" 2>/dev/null | head -8 || echo "  (无)"
echo "[知识账本条目]"
grep -o '"kind":"fork"' "$SNAP" 2>/dev/null | wc -l | xargs echo "  fork:" || true
grep -o '"kind":"dead-end"' "$SNAP" 2>/dev/null | wc -l | xargs echo "  dead-end:" || true
grep -o '"kind":"observation"' "$SNAP" 2>/dev/null | wc -l | xargs echo "  observation:" || true
echo "[v7 知识账本文件]"
find "$WORK/boards" -name "KNOWLEDGE.md" 2>/dev/null | sort | while read -r f; do
  n=$(grep -cE '^## ' "$f" 2>/dev/null || echo 0)
  entries=$(grep -E '^- ' "$f" 2>/dev/null | grep -cv '(暂无)' || echo 0)
  echo "  ${f#$WORK/}: sections=$n entries=$entries"
done || echo "  (无)"
echo "[v7 类闸配置]"
grep -o '"resourceLimits":{[^}]*}' "$SNAP" 2>/dev/null | head -1 || echo "  (无)"
grep -o '"resourceClass":"[a-z]*"' "$SNAP" 2>/dev/null | sort | uniq -c || true
echo "[driver 尾行]"; tail -3 /tmp/dryrun-driver.log 2>/dev/null || true
