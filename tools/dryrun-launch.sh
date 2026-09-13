#!/bin/bash
# 本地干跑: mock-tsecbench + v17 沙箱镜像完整插件链(夜不收×虎符×集思×行营)。
# 用法: bash tools/dryrun-launch.sh
# 观察: /tmp/dryrun-storages/xiaochang-fork-inbox/*.jsonl(执行者分叉写信箱)
#       → *.absorbed-*(主 agent 读图吸收) → hufu-campaigns 快照含 kind:"fork" 条目
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_PORT="${MOCK_PORT:-8399}"
STORAGES="${DRYRUN_STORAGES:-/tmp/dryrun-storages}"
IMAGE="${DRYRUN_IMAGE:-shence-hosted:v17-formal}"

rm -rf "$STORAGES"; mkdir -p "$STORAGES"
node "$REPO/tools/mock-tsecbench.mjs" "$MOCK_PORT" > /tmp/dryrun-mock.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
sleep 1
curl -sf "http://127.0.0.1:$MOCK_PORT/health" >/dev/null || { echo "mock not up"; exit 1; }

DSK="$(grep -oE 'sk-[A-Za-z0-9]+' "$REPO/../.secrets/api-keys.md" | head -1)"
echo "dryrun: mock :$MOCK_PORT, storages=$STORAGES, image=$IMAGE"
timeout 3300 docker run --rm --network host \
  -e DSH_HOME=/opt/dsh-home \
  -e DSH_PERMISSION_MODE=danger-full-access \
  -e DSH_PRESET=xingying \
  -e DEEPSEEK_BASE_URL=https://api.deepseek.com \
  -e DEEPSEEK_API_KEY="$DSK" \
  -e TZ=Asia/Shanghai \
  -e GUARD_MAX_RUNTIME=3200 \
  -e GUARD_CMD='node /opt/dsh/apps/cli/lib/bin.js --profile headless "$(cat /tmp/dryrun-order.txt)"' \
  -v "$STORAGES":/opt/dsh-home/storages \
  -v "$REPO/tools/dryrun-order.txt":/tmp/dryrun-order.txt:ro \
  --entrypoint /opt/hosted-guard.sh \
  "$IMAGE" > /tmp/dryrun-driver.log 2>&1 || true

echo "── 干跑证据 ──"
echo "[分叉信箱]"
ls -la "$STORAGES/xiaochang-fork-inbox/" 2>/dev/null || echo "  (无信箱目录)"
echo "[知识账本快照中的 fork/dead-end 条目]"
grep -o '"kind":"fork"' "$STORAGES"/hufu-campaigns/*.json 2>/dev/null | wc -l | xargs echo "  fork 条目数:"
grep -o '"kind":"dead-end"' "$STORAGES"/hufu-campaigns/*.json 2>/dev/null | wc -l | xargs echo "  dead-end 条目数:"
echo "[driver 尾行]"
tail -3 /tmp/dryrun-driver.log 2>/dev/null || true
