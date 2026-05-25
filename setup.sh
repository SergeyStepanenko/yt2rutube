#!/bin/bash
set -e

echo "=== yt2rutube — server setup ==="
echo ""

# 1. Bun
if ! command -v bun &>/dev/null; then
  echo "[1/4] Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
else
  echo "[1/4] Bun already installed: $(bun --version)"
fi

# 2. yt-dlp + ffmpeg
echo "[2/4] Installing yt-dlp and ffmpeg..."
if command -v apt-get &>/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq ffmpeg python3
elif command -v yum &>/dev/null; then
  sudo yum install -y ffmpeg python3
fi

if ! command -v yt-dlp &>/dev/null; then
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod +x /usr/local/bin/yt-dlp
else
  echo "  yt-dlp already installed"
fi

# 3. Dependencies
echo "[3/4] Installing dependencies..."
bun install

# 4. Env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[4/4] Created .env — REQUIRED: fill in the following:"
  echo "  - RUTUBE_EMAIL"
  echo "  - RUTUBE_PASSWORD"
  echo "  - PUBLIC_URL=http://<SERVER-IP>:8333"
else
  echo "[4/4] .env already exists"
fi

# Create dirs
mkdir -p data downloads

echo ""
echo "=== Done! ==="
echo ""
echo "Fill in .env, then:"
echo "  bun run start      — start app + worker"
echo "  bun run dev        — start with hot reload"
echo "  bun run monitoring — start Grafana + Prometheus (requires Docker)"
echo ""
echo "Ports:"
echo "  :3847  — admin UI"
echo "  :8333  — file server (must be open for Rutube)"
echo "  :4283  — Grafana (optional, via Docker)"
echo "  :9147  — Prometheus (optional, via Docker)"
