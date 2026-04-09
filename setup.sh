#!/bin/bash
set -e

echo "=== yt2rutube — установка на сервер ==="
echo ""

# 1. Bun
if ! command -v bun &>/dev/null; then
  echo "[1/4] Устанавливаем Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
else
  echo "[1/4] Bun уже установлен: $(bun --version)"
fi

# 2. yt-dlp + ffmpeg
echo "[2/4] Устанавливаем yt-dlp и ffmpeg..."
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
  echo "  yt-dlp уже установлен"
fi

# 3. Dependencies
echo "[3/4] Устанавливаем зависимости..."
bun install

# 4. Env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[4/4] Создан .env — ОБЯЗАТЕЛЬНО заполни:"
  echo "  - RUTUBE_EMAIL"
  echo "  - RUTUBE_PASSWORD"
  echo "  - PUBLIC_URL=http://<IP-сервера>:8333"
else
  echo "[4/4] .env уже существует"
fi

# Create dirs
mkdir -p data downloads

echo ""
echo "=== Готово! ==="
echo ""
echo "Заполни .env, затем:"
echo "  bun run start     — запуск app + worker"
echo "  bun run dev       — запуск с hot reload"
echo "  bun run monitoring — запуск Grafana + Prometheus (нужен Docker)"
echo ""
echo "Порты:"
echo "  :3847  — админка"
echo "  :8333  — файловый сервер (нужен открытый для Rutube)"
echo "  :4283  — Grafana (опционально, через Docker)"
echo "  :9147  — Prometheus (опционально, через Docker)"
