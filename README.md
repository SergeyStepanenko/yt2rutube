# yt2rutube

Downloads videos from YouTube and uploads them to Rutube via API.

## Problem

Rutube is a Russian video platform that does not have an official import tool from YouTube. This project automates the full pipeline: download from YouTube, serve the file over HTTP, and push it to Rutube so their backend pulls and ingests it.

## Requirements

- [Bun](https://bun.sh/) >= 1.0
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (in PATH)
- [FFmpeg](https://ffmpeg.org/) (in PATH)
- A Rutube account

## Setup

```bash
bun install
cp .env.example .env
# Fill in .env with your Rutube credentials
```

## Usage

```bash
bun run index.ts <youtube-url>
```

Example:

```bash
bun run index.ts "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

## How it works

1. `yt-dlp` downloads the video from YouTube into `downloads/`
2. A local HTTP server (port 8333) serves the file
3. The script authenticates with the Rutube API using email/password
4. Sends the file URL to Rutube — their platform fetches the video itself
5. The server stays up for 5 minutes to give Rutube time to pull the file

## Important: public file server

The Rutube API downloads the video by URL. A local `localhost:8333` is only reachable from your machine.

You need a **public URL**. Options:

- **ngrok**: `ngrok http 8333`, then set `PUBLIC_BASE_URL` in `.env`
- **VPS/server**: run the project on a server with a public IP
- **Cloudflare Tunnel**: drop-in ngrok alternative

## Structure

```
src/
  youtube.ts   — video download via yt-dlp
  rutube.ts    — Rutube API client (auth, upload)
  serve.ts     — minimal file HTTP server
  pipeline.ts  — orchestrator: download → serve → upload
index.ts       — CLI entry point
downloads/     — downloaded files
```
