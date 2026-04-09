# yt2rutube — Прогресс проекта

## Суть проекта

Автоматизация переноса видео с YouTube на Rutube: скачивание, перевод аудиодорожки с английского на русский, загрузка на Rutube.

---

## Часть 1: Автоматизация YouTube → Rutube

### Архитектура

Daemon-процесс на Bun (TypeScript), работающий на VPS (RUVDS), с мониторингом через Grafana/Prometheus и Admin UI.

### Компоненты

| Модуль | Файл | Описание |
|--------|------|----------|
| База данных | `src/db.ts` | SQLite (`bun:sqlite`) — sources, videos, logs. UNIQUE по youtube_id, статусы видео, прогресс, retry |
| Конфиг | `src/config.ts` | Интервалы, порты, категория Rutube, пути |
| Worker | `src/worker.ts` | Основной цикл: discover → download → проверка дублей → upload. Retry логика, прогресс-бар |
| Downloader | `src/downloader.ts` | `yt-dlp` — скачивание видео + субтитры, парсинг прогресса |
| Uploader | `src/uploader.ts` | Bun.serve для раздачи файла, Rutube API uploadByUrl, polling статуса, прогресс трансфера |
| Rutube API | `src/rutube.ts` | Авторизация, upload, getVideo, patchVideo, **getMyVideos, findMyVideoByTitle** (проверка дублей) |
| Sources | `src/sources.ts` | `yt-dlp --dump-json` — метаданные каналов/плейлистов/видео, фильтр горизонтальных |
| Tunnel | `src/tunnel.ts` | PUBLIC_URL (прямой IP) или fallback на cloudflared |
| API | `src/api.ts` | REST API для Admin UI: stats, sources, videos, logs, sync, metrics |
| Server | `src/server.ts` | Entry point — DB, Logger, Worker, API. Graceful shutdown |
| Logger | `src/logger.ts` | Консоль + БД, цветной вывод с таймстемпами |
| Metrics | `src/metrics.ts` | Prometheus-формат из данных БД |
| Admin UI | `admin/app.tsx` | React SPA — статистика, управление источниками, видео, прогресс-бары, логи |

### Деплой

- **Приложение**: напрямую на VPS (не Docker) через systemd (`yt2rutube.service`)
- **Мониторинг**: Docker Compose — Prometheus (`:9147`) + Grafana (`:4283`)
- **Сервер**: RUVDS, Bun runtime
- **Порты**: Admin UI `:3847`, файловый сервер `:8333`

### Ключевые решения

1. **Отказ от ngrok** — лимиты сессий, interstitial-страницы, bandwidth
2. **Отказ от cloudflared в Docker** — Rutube блокировал IP датацентра (403)
3. **PUBLIC_URL** — прямой IP сервера, tunnel не нужен
4. **Проверка дублей** — перед загрузкой запрос `GET /api/video/person/` на Rutube, поиск по title
5. **Удаление файлов** — только после успешной загрузки (при ошибке — файлы остаются для retry)
6. **Восстановление** — при старте сбрасываются зависшие статусы `downloading/uploading → pending`

---

## Часть 2: Перевод аудиодорожки EN → RU

### Идея

Скачивать с YouTube видео на английском, переводить аудиодорожку на русский язык, сохраняя фоновые звуки (музыку, шумы моторов, аплодисменты), и загружать на Rutube видео с русской озвучкой.

### Исследование (9 апреля 2026)

Проанализированы подходы:
- **API-сервисы**: ElevenLabs ($0.50-1.10/мин), Pinch ($0.50/мин), Transmonkey
- **Self-hosted**: SoniTranslate, AutoDub, ZastTranslate
- **Компоненты**: Demucs (разделение аудио), Whisper (транскрипция), XTTS v2 / F5-TTS (озвучка)

**Ключевой инсайт**: YouTube-субтитры через `yt-dlp` полностью убирают необходимость в Whisper (самый тяжёлый этап). Субтитры уже содержат текст с таймкодами.

### Итоговый пайплайн

```
YouTube видео (.mp4 + .en.srt)
        │
        ▼
[1] FFmpeg — извлечение аудио → original_audio.wav
        │
        ▼
[2] Demucs MLX — разделение на stems:
        ├── vocals.wav (голос)
        ├── drums.wav
        ├── bass.wav
        └── other.wav
        │
        ├── drums + bass + other → background.wav (фон)
        │
        ▼
[3] Claude API — перевод субтитров EN → RU
        │   (сохраняет стиль комментария)
        │   → subtitles_ru.srt + translation_cache.json
        │
        ▼
[4] Edge-TTS — синтез русской речи
        │   (голос: ru-RU-DmitryNeural, rate +10%)
        │   → tts_segments/seg_NNNN.mp3
        │
        ▼
[5] FFmpeg — сведение:
        │   background.wav + все seg_NNNN.mp3 (по таймкодам)
        │   atempo для ускорения длинных фраз
        │   → dubbed_audio.wav
        │
        ▼
[6] FFmpeg — финальное видео:
        оригинальное видео (video stream copy) + dubbed_audio.wav
        → <name> [RU].mp4
```

### Технические детали

#### Разделение аудио — Demucs MLX
- Модель: `htdemucs` (Hybrid Transformer Demucs)
- Порт для Apple Silicon: `demucs-mlx` — нативное ускорение через Metal GPU
- Скорость на M1 Pro 16 ГБ:
  - 6 мин аудио → **25 сек**
  - 12.5 мин аудио → **60 сек**
- Качество: бит-в-бит идентично PyTorch (SDR 9.2 dB)
- 4 стема: drums, bass, other, vocals

#### Обработка субтитров
YouTube auto-generated субтитры имеют перекрывающиеся временные окна с повторяющимся текстом. Логика мерджа:
1. Дедупликация текста (удаление повторов из перекрывающихся окон)
2. Очистка: удаление `>> [Music]`, `>> [screaming]`, `[laughter]`
3. Мерж смежных фрагментов (gap < 1.5с) с ограничением 8с на сегмент
4. Фильтрация пустых/коротких сегментов

#### Перевод — Claude API (Anthropic)
- Модель: `claude-sonnet-4-20250514`
- Батчи по 15 сегментов
- Retry при 429/529 с экспоненциальным backoff
- Кеширование в `translation_cache.json` — при повторном запуске перевод не повторяется
- Промпт сохраняет стиль (спортивный комментарий, эмоции)

#### Озвучка — Edge-TTS (Microsoft)
- Бесплатный API (без ключа)
- Голос: `ru-RU-DmitryNeural` (мужской)
- Альтернатива: `ru-RU-SvetlanaNeural` (женский)
- Rate: `+10%` для более динамичного звучания
- ~1 сек на сегмент

#### Сведение — FFmpeg
- `amix` для наложения сегментов на фон
- `adelay` для позиционирования по таймкодам
- `atempo` для ускорения фраз, которые длиннее оригинала (до 1.5x)
- `volume` компенсация после amix
- Video stream copy (без перекодирования видео)

### Установка зависимостей (macOS, Apple Silicon)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install 'demucs-mlx[convert]' edge-tts
# ffmpeg нужен (brew install ffmpeg)
```

### Запуск

```bash
source .venv/bin/activate
python3 scripts/dub.py "downloads/<Название видео>"
```

Скрипт: `scripts/dub.py` — универсальный, принимает папку с `.mp4` и `.en.srt`.

### Результаты файлов в папке видео

| Файл | Описание |
|------|----------|
| `*.mp4` | Оригинальное видео |
| `*.en.srt` | Оригинальные субтитры (EN) |
| `original_audio.wav` | Извлечённое аудио |
| `vocals.wav` | Голосовая дорожка (EN) |
| `drums.wav` | Ударные/перкуссия |
| `bass.wav` | Басы |
| `other.wav` | Остальные инструменты |
| `background.wav` | Фон (drums+bass+other) |
| `translation_cache.json` | Кеш перевода (для повторных запусков) |
| `subtitles_ru.srt` | Русские субтитры |
| `tts_segments/` | MP3-файлы озвученных сегментов |
| `dubbed_audio.wav` | Финальная аудиодорожка (фон + русская речь) |
| `* [RU].mp4` | **Готовое видео с русской озвучкой** |

### Тестовые видео

1. **Best MotoGP™ Moments 🔥 2026 US GP** — 6:17, спортивный комментарий
2. **Three-Rider Double Backflip Train - World First in Wales** — 12:37, экстремальный спорт

### Стоимость на 1 видео

| Компонент | Стоимость |
|-----------|----------|
| Demucs MLX | Бесплатно (локально) |
| Claude перевод | ~$0.01-0.03 |
| Edge-TTS | Бесплатно |
| FFmpeg | Бесплатно |

### Возможные улучшения

- **Клонирование голоса**: F5-TTS MLX или XTTS v2 — голос будет похож на оригинального спикера (вместо стандартного Дмитрия)
- **Диаризация**: Pyannote — определение нескольких спикеров для разных голосов
- **Синхронизация губ**: подгонка скорости речи per-segment более точная
- **Интеграция в worker**: автоматический перевод при скачивании, перед загрузкой на Rutube
- **GPU VPS**: переезд на сервер с GPU для быстрой обработки Demucs/TTS (~5000 руб/мес)

---

## Окружение

- **Runtime**: Bun (TypeScript) для основного приложения
- **Python**: 3.14 + venv для пайплайна перевода
- **Железо для дублирования**: MacBook M1 Pro, 16 ГБ unified memory
- **VPS**: RUVDS (для основного приложения + мониторинг)
- **API**: Rutube, Anthropic (Claude), Microsoft Edge-TTS
- **Инструменты**: yt-dlp, ffmpeg, demucs-mlx, edge-tts
