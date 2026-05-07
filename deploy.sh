#!/bin/bash
set -euo pipefail

VPS_USER="root"
VPS_HOST="80.71.152.129"
VPS_PATH="/root/yt2rutube"

MACBOOK_USER="ssassistant"
MACBOOK_HOST="192.168.1.38"
MACBOOK_PATH="/Users/ssassistant/work/yt2rutube"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RSYNC_OPTS=(
  -az
  --delete
  --exclude='.git'
  --exclude='node_modules'
  --exclude='.venv'
  --exclude='data'
  --exclude='downloads'
  --exclude='logs'
  --exclude='.env'
  --exclude='*.db'
  --exclude='*.db-wal'
  --exclude='*.db-shm'
)

echo "=== Deploy yt2rutube ==="
echo ""

# ── VPS ────────────────────────────────────────────────────────────────────────
echo "[1/4] Sync → VPS..."
rsync "${RSYNC_OPTS[@]}" "$SCRIPT_DIR/" "$VPS_USER@$VPS_HOST:$VPS_PATH/"

echo "[2/4] Install deps on VPS..."
ssh "$VPS_USER@$VPS_HOST" "cd $VPS_PATH && /root/.bun/bin/bun install --frozen-lockfile"

echo "[3/4] Restart service on VPS..."
ssh "$VPS_USER@$VPS_HOST" "systemctl restart yt2rutube && systemctl is-active yt2rutube"

# ── MacBook worker ─────────────────────────────────────────────────────────────
echo "[4/4] Sync → MacBook worker..."
rsync "${RSYNC_OPTS[@]}" "$SCRIPT_DIR/" "$MACBOOK_USER@$MACBOOK_HOST:$MACBOOK_PATH/"
rsync -az "$SCRIPT_DIR/.env" "$MACBOOK_USER@$MACBOOK_HOST:$MACBOOK_PATH/.env"

ssh "$MACBOOK_USER@$MACBOOK_HOST" "cd $MACBOOK_PATH && /Users/ssassistant/.bun/bin/bun install --frozen-lockfile"

# Restart src/server.ts (main worker on MacBook)
ssh "$MACBOOK_USER@$MACBOOK_HOST" "
  pkill -f 'src/server.ts' 2>/dev/null || true
  sleep 2
  cd $MACBOOK_PATH
  nohup /Users/ssassistant/.bun/bin/bun run src/server.ts >> logs/server.log 2>&1 &
  echo \"MacBook server restarted (PID \$!)\"
"

echo ""
echo "=== Done ==="
