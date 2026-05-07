import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "path";
import { config } from "./config";

export type VideoStatus =
  | "pending"
  | "downloading"
  | "downloaded"
  | "translating"
  | "translated"
  | "uploading"
  | "uploaded"
  | "processing"
  | "done"
  | "error"
  | "skipped";

export interface SourceRow {
  id: number;
  type: string;
  url: string;
  name: string | null;
  enabled: number;
  fetch_limit: number;
  created_at: string;
}

export interface SettingRow {
  key: string;
  value: string;
}

export interface VideoRow {
  id: number;
  youtube_id: string;
  youtube_url: string;
  title: string;
  description: string | null;
  duration: number | null;
  is_horizontal: number;
  source_id: number | null;
  status: VideoStatus;
  rutube_id: string | null;
  rutube_url: string | null;
  rutube_status: string | null;
  file_path: string | null;
  dubbed_path: string | null;
  file_size: number | null;
  error: string | null;
  retries: number;
  progress: number | null;
  speed: string | null;
  eta: string | null;
  created_at: string;
  updated_at: string;
}

export interface LogRow {
  id: number;
  level: string;
  message: string;
  video_id: number | null;
  created_at: string;
}

export interface VideoStats {
  total: number;
  pending: number;
  downloading: number;
  downloaded: number;
  translating: number;
  translated: number;
  uploading: number;
  uploaded: number;
  processing: number;
  done: number;
  error: number;
  skipped: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('channel','playlist','video','search')),
  url TEXT NOT NULL UNIQUE,
  name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  fetch_limit INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  youtube_id TEXT NOT NULL UNIQUE,
  youtube_url TEXT NOT NULL,
  title TEXT NOT NULL,
  duration INTEGER,
  is_horizontal INTEGER NOT NULL DEFAULT 1,
  source_id INTEGER REFERENCES sources(id),
  status TEXT NOT NULL DEFAULT 'pending',
  rutube_id TEXT,
  rutube_url TEXT,
  rutube_status TEXT,
  file_path TEXT,
  file_size INTEGER,
  error TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_youtube_id ON videos(youtube_id);
CREATE INDEX IF NOT EXISTS idx_videos_source_id ON videos(source_id);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL CHECK(level IN ('info','warn','error')),
  message TEXT NOT NULL,
  video_id INTEGER REFERENCES videos(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
`;

export class DB {
  private db: Database;

  constructor(dbPath?: string) {
    const p = dbPath ?? path.join(config.dataDir, "yt2rutube.db");
    mkdirSync(path.dirname(p), { recursive: true });
    this.db = new Database(p);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const cols = this.db
      .prepare("PRAGMA table_info(videos)")
      .all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("progress")) {
      this.db.exec("ALTER TABLE videos ADD COLUMN progress REAL DEFAULT NULL");
    }
    if (!names.has("speed")) {
      this.db.exec("ALTER TABLE videos ADD COLUMN speed TEXT DEFAULT NULL");
    }
    if (!names.has("eta")) {
      this.db.exec("ALTER TABLE videos ADD COLUMN eta TEXT DEFAULT NULL");
    }
    if (!names.has("description")) {
      this.db.exec("ALTER TABLE videos ADD COLUMN description TEXT DEFAULT NULL");
    }
    if (!names.has("dubbed_path")) {
      this.db.exec("ALTER TABLE videos ADD COLUMN dubbed_path TEXT DEFAULT NULL");
    }

    const srcCols = this.db
      .prepare("PRAGMA table_info(sources)")
      .all() as { name: string }[];
    const srcNames = new Set(srcCols.map((c) => c.name));
    if (!srcNames.has("fetch_limit")) {
      this.db.exec("ALTER TABLE sources ADD COLUMN fetch_limit INTEGER NOT NULL DEFAULT 5");
    }
  }

  recoverStuckVideos(): number {
    const r1 = this.db.run(
      `UPDATE videos SET status = 'pending', progress = NULL, speed = NULL, eta = NULL, updated_at = datetime('now')
       WHERE status IN ('downloading', 'uploading', 'processing', 'translating')`
    );
    return r1.changes;
  }

  // --- Sources ---

  addSource(type: string, url: string, name?: string, fetchLimit?: number): SourceRow {
    const limit = fetchLimit ?? config.defaultFetchLimit;
    const stmt = this.db.prepare(
      `INSERT INTO sources (type, url, name, fetch_limit) VALUES (?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET type=excluded.type, name=COALESCE(excluded.name, sources.name), enabled=1
       RETURNING *`
    );
    return stmt.get(type, url, name ?? null, limit) as SourceRow;
  }

  getSources(): SourceRow[] {
    return this.db
      .prepare("SELECT * FROM sources WHERE enabled = 1 ORDER BY id")
      .all() as SourceRow[];
  }

  getAllSources(): SourceRow[] {
    return this.db
      .prepare("SELECT * FROM sources ORDER BY id")
      .all() as SourceRow[];
  }

  removeSource(id: number): void {
    this.db.prepare("UPDATE sources SET enabled = 0 WHERE id = ?").run(id);
  }

  deleteSource(id: number): void {
    this.db.prepare("DELETE FROM sources WHERE id = ?").run(id);
  }

  updateSource(
    id: number,
    fields: Partial<{ name: string | null; enabled: number; fetch_limit: number }>
  ): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (fields.name !== undefined) { sets.push("name = ?"); vals.push(fields.name); }
    if (fields.enabled !== undefined) { sets.push("enabled = ?"); vals.push(fields.enabled); }
    if (fields.fetch_limit !== undefined) { sets.push("fetch_limit = ?"); vals.push(fields.fetch_limit); }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE sources SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  // --- Settings ---

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, value);
  }

  getAllSettings(): Record<string, string> {
    const rows = this.db.prepare("SELECT * FROM settings").all() as SettingRow[];
    const result: Record<string, string> = {};
    for (const r of rows) result[r.key] = r.value;
    return result;
  }

  getSettingNum(key: string, fallback: number): number {
    const v = this.getSetting(key);
    if (v === null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  // --- Videos ---

  addVideo(
    youtubeId: string,
    youtubeUrl: string,
    title: string,
    duration?: number,
    isHorizontal = true,
    sourceId?: number
  ): VideoRow | null {
    const result = this.db.run(
      `INSERT OR IGNORE INTO videos (youtube_id, youtube_url, title, duration, is_horizontal, source_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [youtubeId, youtubeUrl, title, duration ?? null, isHorizontal ? 1 : 0, sourceId ?? null]
    );
    if (result.changes === 0) return null;
    return this.getVideo(youtubeId);
  }

  getVideo(youtubeId: string): VideoRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM videos WHERE youtube_id = ?")
        .get(youtubeId) as VideoRow | null) ?? null
    );
  }

  getVideoById(id: number): VideoRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM videos WHERE id = ?")
        .get(id) as VideoRow | null) ?? null
    );
  }

  updateVideoStatus(
    id: number,
    status: VideoStatus,
    extra?: Partial<{
      rutube_id: string | null;
      rutube_url: string | null;
      rutube_status: string | null;
      file_path: string | null;
      dubbed_path: string | null;
      file_size: number | null;
      description: string | null;
      error: string | null;
      retries: number | null;
      progress: number | null;
      speed: string | null;
      eta: string | null;
    }>
  ): void {
    const sets = ["status = ?", "updated_at = datetime('now')"];
    const vals: (string | number | null)[] = [status];

    if (extra) {
      const allowed = [
        "rutube_id",
        "rutube_url",
        "rutube_status",
        "file_path",
        "dubbed_path",
        "file_size",
        "description",
        "error",
        "retries",
        "progress",
        "speed",
        "eta",
      ] as const;
      for (const key of allowed) {
        if (extra[key] !== undefined) {
          sets.push(`${key} = ?`);
          vals.push(extra[key] as string | number | null);
        }
      }
    }

    vals.push(id);
    this.db
      .prepare(`UPDATE videos SET ${sets.join(", ")} WHERE id = ?`)
      .run(...vals);
  }

  getPendingVideos(limit = 10): VideoRow[] {
    return this.db
      .prepare(
        "SELECT * FROM videos WHERE status IN ('pending', 'downloaded', 'translated') ORDER BY id DESC LIMIT ?"
      )
      .all(limit) as VideoRow[];
  }

  getRetryableVideos(limit = 5): VideoRow[] {
    return this.db
      .prepare(
        `SELECT * FROM videos WHERE status = 'error' AND retries < ?
         ORDER BY updated_at ASC LIMIT ?`
      )
      .all(config.maxRetries, limit) as VideoRow[];
  }

  getRetryableUploadVideos(limit = 5): VideoRow[] {
    return this.db
      .prepare(
        `SELECT * FROM videos WHERE status = 'error' AND retries < ? AND dubbed_path IS NOT NULL
         ORDER BY updated_at ASC LIMIT ?`
      )
      .all(config.maxRetries, limit) as VideoRow[];
  }

  getDailyUploadCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM videos
         WHERE status = 'done' AND rutube_id IS NOT NULL
         AND updated_at >= date('now')`
      )
      .get() as { cnt: number };
    return row.cnt;
  }

  getStats(): VideoStats {
    const rows = this.db
      .prepare(
        "SELECT status, COUNT(*) as cnt FROM videos GROUP BY status"
      )
      .all() as { status: string; cnt: number }[];

    const stats: VideoStats = {
      total: 0,
      pending: 0,
      downloading: 0,
      downloaded: 0,
      translating: 0,
      translated: 0,
      uploading: 0,
      uploaded: 0,
      processing: 0,
      done: 0,
      error: 0,
      skipped: 0,
    };
    for (const row of rows) {
      stats[row.status as keyof Omit<VideoStats, "total">] = row.cnt;
      stats.total += row.cnt;
    }
    return stats;
  }

  getRecentVideos(limit = 50): VideoRow[] {
    return this.db
      .prepare("SELECT * FROM videos ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as VideoRow[];
  }

  getAllVideos(
    offset = 0,
    limit = 100,
    status?: string,
    sourceId?: number
  ): { videos: VideoRow[]; total: number } {
    let where = "1=1";
    const params: (string | number)[] = [];
    if (status) {
      where += " AND status = ?";
      params.push(status);
    }
    if (sourceId) {
      where += " AND source_id = ?";
      params.push(sourceId);
    }

    const countParams = [...params];
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) as cnt FROM videos WHERE ${where}`)
        .get(...countParams) as { cnt: number }
    ).cnt;

    const allParams: (string | number)[] = [...params, limit, offset];
    const videos = this.db
      .prepare(
        `SELECT * FROM videos WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
      )
      .all(...allParams) as VideoRow[];

    return { videos, total };
  }

  updateProgress(
    id: number,
    progress: number,
    speed: string | null,
    eta: string | null,
    fileSize?: number
  ): void {
    const sets = ["progress = ?", "speed = ?", "eta = ?", "updated_at = datetime('now')"];
    const vals: (string | number | null)[] = [progress, speed, eta];
    if (fileSize !== undefined) {
      sets.push("file_size = ?");
      vals.push(fileSize);
    }
    vals.push(id);
    this.db
      .prepare(`UPDATE videos SET ${sets.join(", ")} WHERE id = ?`)
      .run(...vals);
  }

  deleteVideo(id: number): void {
    this.db.prepare("DELETE FROM videos WHERE id = ?").run(id);
  }

  resetVideo(id: number): void {
    this.db
      .prepare(
        "UPDATE videos SET status = 'pending', error = NULL, retries = 0, updated_at = datetime('now') WHERE id = ?"
      )
      .run(id);
  }

  resetAllErrors(): number {
    const r = this.db.run(
      "UPDATE videos SET status = 'pending', error = NULL, retries = 0, updated_at = datetime('now') WHERE status = 'error'"
    );
    return r.changes;
  }

  skipAllPending(): number {
    const r = this.db.run(
      "UPDATE videos SET status = 'skipped', updated_at = datetime('now') WHERE status = 'pending'"
    );
    return r.changes;
  }

  

  // --- Logs ---

  addLog(level: string, message: string, videoId?: number): void {
    this.db
      .prepare("INSERT INTO logs (level, message, video_id) VALUES (?, ?, ?)")
      .run(level, message, videoId ?? null);
  }

  getRecentLogs(limit = 100): LogRow[] {
    return this.db
      .prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?")
      .all(limit) as LogRow[];
  }

  // --- Metrics ---

  getUploadsPerDay(days = 30): { date: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT date(updated_at) as date, COUNT(*) as count
         FROM videos WHERE status = 'done'
         GROUP BY date(updated_at)
         ORDER BY date DESC LIMIT ?`
      )
      .all(days) as { date: string; count: number }[];
  }

  getErrorsPerDay(days = 30): { date: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT date(updated_at) as date, COUNT(*) as count
         FROM videos WHERE status = 'error'
         GROUP BY date(updated_at)
         ORDER BY date DESC LIMIT ?`
      )
      .all(days) as { date: string; count: number }[];
  }

  close(): void {
    this.db.close();
  }
}
