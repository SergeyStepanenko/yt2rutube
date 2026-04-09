FROM oven/bun:1 AS base
WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 ffmpeg curl gnupg ca-certificates procps && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp && \
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .

RUN mkdir -p /app/data /app/downloads

EXPOSE 3847
EXPOSE 8333

ENV DATA_DIR=/app/data
ENV DOWNLOADS_DIR=/app/downloads
ENV ADMIN_PORT=3847
ENV SERVE_PORT=8333

CMD ["bun", "run", "src/server.ts"]
