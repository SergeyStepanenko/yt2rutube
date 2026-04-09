import path from "path";
import { rm } from "node:fs/promises";
import { DB } from "./db";
import { Logger } from "./logger";
import { RutubeClient } from "./rutube";
import {
  fetchChannelVideos,
  fetchPlaylistVideos,
  fetchVideoInfo,
} from "./sources";
import { downloadVideo, type DownloadProgress } from "./downloader";
import { uploadToRutube } from "./uploader";
import { config } from "./config";

const DUB_SCRIPT = path.resolve("scripts/dub.py");
const VENV_PYTHON = path.resolve(".venv/bin/python3");

interface DubEvent {
  event: string;
  [key: string]: unknown;
}

export class Worker {
  private db: DB;
  private log: Logger;
  private rutube: RutubeClient;
  private running = false;
  private loggedIn = false;
  private _lastCycleAt: Date | null = null;
  private _isProcessing = false;
  private _currentVideoId: number | null = null;
  private _currentPhase: string | null = null;

  get lastCycleAt() { return this._lastCycleAt; }
  get isProcessing() { return this._isProcessing; }
  get currentVideoId() { return this._currentVideoId; }
  get currentPhase() { return this._currentPhase; }

  constructor(db: DB, log: Logger) {
    this.db = db;
    this.log = log;
    this.rutube = new RutubeClient();
  }

  private async ensureLogin(): Promise<void> {
    if (this.loggedIn) return;
    const email = process.env.RUTUBE_EMAIL;
    const password = process.env.RUTUBE_PASSWORD;
    if (!email || !password) {
      throw new Error("RUTUBE_EMAIL and RUTUBE_PASSWORD must be set");
    }
    await this.rutube.login(email, password);
    this.loggedIn = true;
    this.log.info("Rutube: авторизация успешна");
  }

  async runCycle(): Promise<void> {
    this._isProcessing = true;
    try {
      await this.ensureLogin();
      await this.discoverVideos();
      await this.processQueue();
      await this.retryFailed();
      this._lastCycleAt = new Date();
    } finally {
      this._isProcessing = false;
      this._currentVideoId = null;
      this._currentPhase = null;
    }
  }

  private async discoverVideos(): Promise<void> {
    const sources = this.db.getSources();
    this.log.info(`Обнаружение видео из ${sources.length} источников`);

    for (const source of sources) {
      try {
        let videos: Awaited<ReturnType<typeof fetchChannelVideos>> = [];

        if (source.type === "channel") {
          videos = await fetchChannelVideos(source.url);
        } else if (source.type === "playlist") {
          videos = await fetchPlaylistVideos(source.url);
        } else if (source.type === "video") {
          try {
            const v = await fetchVideoInfo(source.url);
            videos = [v];
          } catch {
            this.log.warn(`Не удалось получить инфо: ${source.url}`);
            continue;
          }
        }

        let added = 0;
        for (const v of videos) {
          if (v.width > 0 && v.height > 0 && v.width <= v.height) continue;
          const row = this.db.addVideo(
            v.youtubeId,
            v.youtubeUrl,
            v.title,
            v.duration,
            true,
            source.id
          );
          if (row) added++;
        }

        if (added > 0) {
          this.log.info(
            `${source.name ?? source.url}: +${added} новых видео`
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log.error(`Ошибка источника ${source.url}: ${msg}`);
      }
    }
  }

  private async processQueue(): Promise<void> {
    const pending = this.db.getPendingVideos(config.maxVideosPerCycle);
    if (pending.length === 0) {
      this.log.info("Нет видео в очереди");
      return;
    }

    this.log.info(`Обработка ${pending.length} видео`);

    for (const row of pending) {
      await this.processVideo(row.id);
    }
  }

  private async retryFailed(): Promise<void> {
    const retryable = this.db.getRetryableVideos(2);
    for (const row of retryable) {
      this.log.info(
        `Повторная попытка: ${row.title} (retry ${row.retries + 1})`
      );
      this.db.updateVideoStatus(row.id, "pending");
      await this.processVideo(row.id);
    }
  }

  private async processVideo(videoId: number): Promise<void> {
    const row = this.db.getVideoById(videoId);
    if (!row) return;

    this._currentVideoId = videoId;
    let downloadDir: string | null = null;

    try {
      // ── 1. Download ────────────────────────────────────────
      let mp4Path = row.file_path;
      let description = row.description ?? "";
      this._currentPhase = "downloading";

      if (!mp4Path || !(await Bun.file(mp4Path).exists())) {
        this.db.updateVideoStatus(row.id, "downloading", {
          progress: 0, speed: null, eta: null, error: null,
        });
        this.log.info(`Скачиваем: ${row.title}`, row.id);

        const dl = await downloadVideo(
          row.youtube_url,
          config.downloadsDir,
          (p: DownloadProgress) => {
            this.db.updateProgress(row.id, p.percent, p.speed, p.eta);
          }
        );

        mp4Path = dl.videoFile;
        downloadDir = dl.directory;
        description = dl.description;

        this.db.updateVideoStatus(row.id, "downloaded", {
          file_path: dl.videoFile,
          file_size: dl.fileSize,
          description: dl.description || null,
          progress: 100,
          speed: null, eta: null, error: null,
        });
        this.log.info(
          `Скачано: ${row.title} (${(dl.fileSize / 1024 / 1024).toFixed(1)} МБ)`,
          row.id
        );
      } else {
        this.log.info(`Файл уже скачан: ${row.title}`, row.id);
        downloadDir = path.dirname(mp4Path);
      }

      // ── 2. Translate (dub) ─────────────────────────────────
      this._currentPhase = "translating";
      let dubbedPath = row.dubbed_path;

      if (!dubbedPath || !(await Bun.file(dubbedPath).exists())) {
        const srtExists = await this.hasSrtFile(downloadDir!);

        if (srtExists) {
          this.db.updateVideoStatus(row.id, "translating", {
            progress: 0, speed: "перевод...", error: null,
          });
          this.log.info(`Переводим: ${row.title}`, row.id);

          dubbedPath = await this.runDubbing(
            downloadDir!, row.title, description, row.id
          );

          this.db.updateVideoStatus(row.id, "translated", {
            dubbed_path: dubbedPath,
            progress: 100, speed: null, error: null,
          });
          this.log.info(`Перевод готов: ${row.title}`, row.id);
        } else {
          this.log.warn(`Нет субтитров, загружаем оригинал: ${row.title}`, row.id);
          dubbedPath = mp4Path;
          this.db.updateVideoStatus(row.id, "translated", {
            dubbed_path: dubbedPath,
            progress: 100, speed: "без перевода", error: null,
          });
        }
      } else {
        this.log.info(`Перевод уже есть: ${row.title}`, row.id);
      }

      // ── 3. Duplicate check ─────────────────────────────────
      this._currentPhase = "checking";
      try {
        const existing = await this.rutube.findMyVideoByTitle(row.title);
        if (existing) {
          const existingUrl = existing.video_url as string || "";
          const existingId = existing.id as string || "";
          this.db.updateVideoStatus(row.id, "done", {
            rutube_id: existingId,
            rutube_url: existingUrl,
            rutube_status: "duplicate",
            progress: null, error: null, file_path: null,
          });
          this.log.info(`Дубликат на Rutube, пропускаем: ${row.title} → ${existingUrl}`, row.id);

          if (downloadDir) {
            try { await rm(downloadDir, { recursive: true, force: true }); } catch {}
          }
          return;
        }
      } catch (e) {
        this.log.warn(`Не удалось проверить дубли: ${e instanceof Error ? e.message : String(e)}`, row.id);
      }

      // ── 4. Translate metadata ────────────────────────────────
      this._currentPhase = "uploading";
      const uploadPath = dubbedPath!;

      let ruTitle = row.title;
      let ruDescription = description;
      try {
        this.log.info(`Переводим метаданные: ${row.title}`, row.id);
        const translated = await this.translateMetadata(row.title, description);
        ruTitle = translated.title;
        ruDescription = translated.description;
        this.log.info(`Название RU: ${ruTitle}`, row.id);
      } catch (e) {
        this.log.warn(`Не удалось перевести метаданные, используем оригинал: ${e instanceof Error ? e.message : String(e)}`, row.id);
      }

      // ── 5. Upload ──────────────────────────────────────────
      this.db.updateVideoStatus(row.id, "uploading", {
        progress: null, speed: null, eta: null, error: null,
      });
      this.log.info(`Загружаем на Rutube: ${ruTitle}`, row.id);

      const upload = await uploadToRutube(
        this.rutube,
        {
          mp4Path: uploadPath,
          title: ruTitle,
          description: ruDescription.slice(0, 5000),
          categoryId: config.rutubeCategory,
          isHidden: config.rutubeIsHidden,
        },
        (p) => {
          if (p.phase === "uploading_to_vps") {
            this.db.updateProgress(row.id, p.percent, p.detail, null);
          } else {
            this.db.updateProgress(row.id, -1, p.detail, null);
          }
        }
      );

      if (upload.status === "moderation" || upload.status === "no_action") {
        this.db.updateVideoStatus(row.id, "done", {
          rutube_id: upload.videoId,
          rutube_url: upload.videoUrl,
          rutube_status: upload.status,
          progress: null, error: null, file_path: null,
        });
        this.log.info(`Загружено: ${row.title} → ${upload.videoUrl}`, row.id);

        if (downloadDir) {
          try {
            await rm(downloadDir, { recursive: true, force: true });
            this.log.info(`Файлы удалены: ${downloadDir}`, row.id);
          } catch {}
        }
      } else {
        this.db.updateVideoStatus(row.id, "error", {
          rutube_id: upload.videoId,
          rutube_status: upload.status,
          error: `Rutube status: ${upload.status}`,
          retries: row.retries + 1,
          progress: null,
        });
        this.log.error(
          `Ошибка загрузки: ${row.title} — ${upload.status}`,
          row.id
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.db.updateVideoStatus(row.id, "error", {
        error: msg,
        retries: row.retries + 1,
        progress: null, speed: null, eta: null,
      });
      this.log.error(`Ошибка: ${row.title} — ${msg}`, row.id);
    } finally {
      this._currentVideoId = null;
      this._currentPhase = null;
    }
  }

  private async translateMetadata(
    title: string, description: string
  ): Promise<{ title: string; description: string }> {
    const apiKey = process.env.DEEP_SEEK_API_KEY;
    if (!apiKey) {
      return { title, description };
    }

    const descShort = description.slice(0, 1000).split("\n\n")[0] ?? "";

    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "Переведи название и описание YouTube-видео на русский язык. " +
              "Перевод должен быть естественным, не дословным. " +
              "Категория видео: Авто-мото / экстремальный спорт. " +
              "Верни JSON: {\"title\": \"...\", \"description\": \"...\"}. " +
              "Название — не длиннее 100 символов. Описание — информативное, до 500 символов. " +
              "Не добавляй ссылки и хэштеги. Только JSON, без markdown.",
          },
          {
            role: "user",
            content: JSON.stringify({ title, description: descShort }),
          },
        ],
      }),
    });

    if (!resp.ok) {
      throw new Error(`DeepSeek API error: ${resp.status}`);
    }

    const data = await resp.json() as {
      choices: { message: { content: string } }[];
    };
    let raw = data.choices[0]?.message?.content?.trim() ?? "";
    if (raw.startsWith("```")) {
      raw = raw.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(raw) as { title?: string; description?: string };
    return {
      title: (parsed.title ?? title).slice(0, 100),
      description: (parsed.description ?? description).slice(0, 5000),
    };
  }

  private async hasSrtFile(dir: string): Promise<boolean> {
    const glob = new Bun.Glob("*.en.srt");
    for await (const _ of glob.scan(dir)) {
      return true;
    }
    return false;
  }

  private async runDubbing(
    folder: string, title: string, description: string, videoId: number
  ): Promise<string> {
    const pythonCmd = await Bun.file(VENV_PYTHON).exists() ? VENV_PYTHON : "python3";

    const args = [pythonCmd, DUB_SCRIPT, folder];
    if (title) { args.push("--title", title); }
    if (description) { args.push("--description", description); }

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let lastFile = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let nlIdx: number;
        while ((nlIdx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nlIdx).trim();
          buf = buf.slice(nlIdx + 1);
          if (!line) continue;

          try {
            const ev = JSON.parse(line) as DubEvent;
            this.handleDubEvent(ev, videoId);
            if (ev.event === "done" && typeof ev.file === "string") {
              lastFile = ev.file;
            }
          } catch {
            this.log.info(`[dub] ${line}`, videoId);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`Dubbing failed (exit ${exitCode}): ${stderr.slice(-300)}`);
    }

    if (!lastFile) {
      const glob = new Bun.Glob("*[RU].mp4");
      for await (const file of glob.scan(folder)) {
        lastFile = path.join(folder, file);
        break;
      }
    }

    if (!lastFile) {
      throw new Error("Dubbed video file not found after dubbing");
    }

    return lastFile;
  }

  private handleDubEvent(ev: DubEvent, videoId: number): void {
    switch (ev.event) {
      case "step":
        this.db.updateProgress(
          videoId,
          ((ev.step as number) - 1) * 20,
          `шаг ${ev.step}/5: ${ev.name}`,
          null
        );
        break;
      case "step_done":
        this.db.updateProgress(videoId, (ev.step as number) * 20, null, null);
        break;
      case "translate_batch":
        this.db.updateProgress(
          videoId, 40,
          `перевод: пакет ${ev.batch}/${ev.total}`,
          null
        );
        break;
      case "translate_cached":
        this.log.info(`Кеш перевода: ${ev.segments} сегментов`, videoId);
        break;
      case "error":
        this.log.error(`[dub] ${ev.message}`, videoId);
        break;
      case "done":
        this.log.info(`[dub] Готово: ${ev.file} (${ev.size_mb} МБ)`, videoId);
        break;
    }
  }

  async startDaemon(): Promise<void> {
    this.running = true;
    this.log.info(
      `Daemon запущен, интервал: ${config.syncIntervalMs / 1000}с`
    );

    while (this.running) {
      try {
        await this.runCycle();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log.error(`Ошибка цикла: ${msg}`);
      }
      if (!this.running) break;
      this.log.info(
        `Следующий цикл через ${config.syncIntervalMs / 60000} мин`
      );
      await Bun.sleep(config.syncIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
    this.log.info("Daemon остановлен");
  }
}
