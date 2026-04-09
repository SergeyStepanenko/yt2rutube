# yt2rutube

Скачивает видео с YouTube и загружает на Rutube через API.

## Требования

- [Bun](https://bun.sh/) >= 1.0
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (в PATH)
- [FFmpeg](https://ffmpeg.org/) (в PATH)
- Аккаунт на Rutube

## Установка

```bash
bun install
cp .env.example .env
# Заполни .env своими данными Rutube
```

## Использование

```bash
bun run index.ts <youtube-url>
```

Пример:

```bash
bun run index.ts "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

## Как это работает

1. `yt-dlp` скачивает видео с YouTube в `downloads/`
2. Поднимается локальный HTTP-сервер (порт 8333), отдающий файл
3. Скрипт авторизуется в Rutube API по email/password
4. Отправляет URL файла в Rutube — платформа сама скачивает видео
5. Сервер работает 5 минут, чтобы Rutube успел забрать файл

## Важно: доступность файлового сервера

Rutube API скачивает видео по URL. Локальный `localhost:8333` доступен только с вашей машины.

Для работы нужен **публичный URL**. Варианты:

- **ngrok**: `ngrok http 8333`, затем указать URL в `PUBLIC_BASE_URL` в `.env`
- **VPS/сервер**: запустить проект на сервере с публичным IP
- **Cloudflare Tunnel**: аналог ngrok

## Структура

```
src/
  youtube.ts   — скачивание видео через yt-dlp
  rutube.ts    — клиент Rutube API (авторизация, загрузка)
  serve.ts     — мини-сервер для отдачи файлов
  pipeline.ts  — оркестратор: скачать → отдать → загрузить
index.ts       — точка входа (CLI)
downloads/     — скачанные файлы
```
