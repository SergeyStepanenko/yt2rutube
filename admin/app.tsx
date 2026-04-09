import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API = "/api";

function useFetch<T>(url: string, interval = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(() => {
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        setData(d as T);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [url]);

  useEffect(() => {
    refetch();
    const id = setInterval(refetch, interval);
    return () => clearInterval(id);
  }, [refetch, interval]);

  return { data, loading, refetch };
}

interface Stats {
  stats: Record<string, number>;
  sourcesCount: number;
  lastCycleAt: string | null;
  isProcessing: boolean;
  currentVideoId: number | null;
  currentPhase: string | null;
}

interface Source {
  id: number;
  type: string;
  url: string;
  name: string | null;
  enabled: number;
  created_at: string;
}

interface Video {
  id: number;
  youtube_id: string;
  youtube_url: string;
  title: string;
  status: string;
  rutube_id: string | null;
  rutube_url: string | null;
  rutube_status: string | null;
  error: string | null;
  retries: number;
  file_size: number | null;
  progress: number | null;
  speed: string | null;
  eta: string | null;
  updated_at: string;
}

interface LogEntry {
  id: number;
  level: string;
  message: string;
  video_id: number | null;
  created_at: string;
}

const PIPELINE_STEPS = [
  { key: "pending", label: "Очередь", icon: "⏳" },
  { key: "downloading", label: "Скачивание", icon: "⬇️" },
  { key: "downloaded", label: "Скачано", icon: "💾" },
  { key: "translating", label: "Перевод", icon: "🌐" },
  { key: "translated", label: "Переведено", icon: "✅" },
  { key: "uploading", label: "Загрузка", icon: "⬆️" },
  { key: "done", label: "Готово", icon: "🎬" },
];

const STATUS_ORDER: Record<string, number> = {};
PIPELINE_STEPS.forEach((s, i) => { STATUS_ORDER[s.key] = i; });
STATUS_ORDER.error = -1;
STATUS_ORDER.skipped = -2;

function PipelineIndicator({ status }: { status: string }) {
  const currentIdx = STATUS_ORDER[status] ?? -1;
  return (
    <div className="pipeline-indicator">
      {PIPELINE_STEPS.map((step, i) => {
        let cls = "pipeline-step";
        if (status === "error" || status === "skipped") {
          cls += " inactive";
        } else if (i < currentIdx) {
          cls += " completed";
        } else if (i === currentIdx) {
          cls += " active";
        } else {
          cls += " inactive";
        }
        return (
          <React.Fragment key={step.key}>
            {i > 0 && <div className={`pipeline-line ${i <= currentIdx && status !== "error" ? "completed" : ""}`} />}
            <div className={cls} title={step.label}>
              <span className="step-icon">{step.icon}</span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function StatsGrid({ stats }: { stats: Stats }) {
  const s = stats.stats;
  const inProgress =
    (s.downloading ?? 0) +
    (s.translating ?? 0) +
    (s.uploading ?? 0) +
    (s.processing ?? 0);

  return (
    <div className="stats-grid">
      <div className="stat-card">
        <div className="label">Всего</div>
        <div className="value">{s.total ?? 0}</div>
      </div>
      <div className="stat-card blue">
        <div className="label">В очереди</div>
        <div className="value">{s.pending ?? 0}</div>
      </div>
      <div className="stat-card yellow">
        <div className="label">Скачивание</div>
        <div className="value">{s.downloading ?? 0}</div>
      </div>
      <div className="stat-card purple">
        <div className="label">Перевод</div>
        <div className="value">{s.translating ?? 0}</div>
      </div>
      <div className="stat-card yellow">
        <div className="label">Загрузка</div>
        <div className="value">{s.uploading ?? 0}</div>
      </div>
      <div className="stat-card green">
        <div className="label">Готово</div>
        <div className="value">{s.done ?? 0}</div>
      </div>
      <div className="stat-card red">
        <div className="label">Ошибки</div>
        <div className="value">{s.error ?? 0}</div>
      </div>
    </div>
  );
}

function AddVideoForm({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (res.ok) {
        setUrl("");
        onAdded();
      } else {
        const data = (await res.json()) as { error?: string };
        alert(data.error || "Ошибка");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="input-row">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://youtube.com/watch?v=..."
          disabled={loading}
        />
        <button type="submit" disabled={loading}>
          {loading ? "..." : "Добавить"}
        </button>
      </div>
    </form>
  );
}

function AddChannelForm({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), name: name.trim() || undefined }),
      });
      if (res.ok) {
        setUrl("");
        setName("");
        onAdded();
      } else {
        const data = (await res.json()) as { error?: string };
        alert(data.error || "Ошибка");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="input-row">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://youtube.com/@channel"
          disabled={loading}
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Название (необязательно)"
          disabled={loading}
          style={{ maxWidth: 200 }}
        />
        <button type="submit" disabled={loading}>
          {loading ? "..." : "Добавить канал"}
        </button>
      </div>
    </form>
  );
}

function SourcesPanel({
  sources,
  refetch,
}: {
  sources: Source[];
  refetch: () => void;
}) {
  async function remove(id: number) {
    await fetch(`${API}/sources/${id}`, { method: "DELETE" });
    refetch();
  }

  return (
    <div className="panel">
      <h2>Источники ({sources.length})</h2>
      <AddChannelForm onAdded={refetch} />
      <ul className="source-list">
        {sources.map((s) => (
          <li key={s.id} className="source-item">
            <span className="source-type">{s.type}</span>
            {s.name && <span className="name">{s.name}</span>}
            <span className="url">{s.url}</span>
            <button className="danger" onClick={() => remove(s.id)}>
              Удалить
            </button>
          </li>
        ))}
        {sources.length === 0 && (
          <li className="source-item" style={{ color: "var(--text-dim)" }}>
            Нет источников. Добавьте канал или плейлист выше.
          </li>
        )}
      </ul>
    </div>
  );
}

function AddVideoPanel({ onAdded }: { onAdded: () => void }) {
  return (
    <div className="panel">
      <h2>Добавить видео</h2>
      <p style={{ color: "var(--text-dim)", fontSize: 13, marginBottom: 12 }}>
        Вставьте ссылку на YouTube видео для добавления в очередь
      </p>
      <AddVideoForm onAdded={onAdded} />
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  all: "Все",
  pending: "Очередь",
  downloading: "Скачивание",
  translating: "Перевод",
  uploading: "Загрузка",
  done: "Готово",
  error: "Ошибки",
  skipped: "Пропущено",
};

function statusDescription(status: string, speed: string | null, rutubeStatus: string | null): string {
  switch (status) {
    case "pending": return "В очереди";
    case "downloading": return speed || "Скачивание с YouTube...";
    case "downloaded": return "Скачано, ожидает перевода";
    case "translating": return speed || "Перевод EN→RU (DeepSeek + Demucs + TTS)...";
    case "translated": return "Перевод готов, ожидает загрузки";
    case "uploading":
      return speed || "Загрузка...";
    case "done":
      if (rutubeStatus === "duplicate") return "Дубликат (уже на Rutube)";
      return "Опубликовано на Rutube";
    case "error": return "Ошибка";
    case "skipped": return "Пропущено";
    default: return status;
  }
}

function VideoItem({
  v,
  isActive,
  onReset,
  onSkip,
  onDelete,
}: {
  v: Video;
  isActive: boolean;
  onReset: () => void;
  onSkip: () => void;
  onDelete: () => void;
}) {
  const isInProgress = ["downloading", "translating", "uploading"].includes(v.status);
  const hasNumericProgress = isInProgress && v.progress !== null && v.progress >= 0;
  const isProcessingOnRutube = v.status === "uploading" && v.progress !== null && v.progress < 0;

  return (
    <li className={`video-item ${isActive ? "active-video" : ""}`}>
      <div className="video-row-top">
        <span className={`badge ${v.status}`}>{v.status}</span>
        <span className="title">{v.title}</span>
        <span className="meta">
          {v.rutube_url ? (
            <a
              href={v.rutube_url}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--green)" }}
            >
              Rutube
            </a>
          ) : v.error ? (
            <span style={{ color: "var(--red)" }} title={v.error}>
              {v.error.slice(0, 80)}
            </span>
          ) : null}
          {v.retries > 0 && (
            <span style={{ marginLeft: 8 }}>retry: {v.retries}</span>
          )}
        </span>
        <span className="actions">
          {(v.status === "error" || v.status === "skipped") && (
            <button className="small secondary" onClick={onReset}>
              Повторить
            </button>
          )}
          {v.status === "pending" && (
            <button className="small secondary" onClick={onSkip}>
              Пропустить
            </button>
          )}
          <button className="danger" onClick={onDelete}>
            &times;
          </button>
        </span>
      </div>

      <PipelineIndicator status={v.status} />

      <div className="video-status-desc">
        {statusDescription(v.status, isProcessingOnRutube ? null : v.speed, v.rutube_status)}
      </div>

      {hasNumericProgress && (
        <div className="progress-row">
          <div className="progress-bar">
            <div
              className={`progress-fill ${v.status === "uploading" ? "upload" : v.status === "translating" ? "translate" : ""}`}
              style={{ width: `${Math.min(v.progress!, 100)}%` }}
            />
          </div>
          <span className="progress-text">
            {v.progress!.toFixed(1)}%
            {v.file_size && v.file_size > 0 && (
              <span className="size">
                {(v.file_size / 1024 / 1024).toFixed(0)} МБ
              </span>
            )}
            {v.eta && v.eta !== "—" && (
              <span className="eta">ETA {v.eta}</span>
            )}
          </span>
        </div>
      )}

      {isProcessingOnRutube && (
        <div className="rutube-processing">
          <span className="processing-spinner" />
          <span className="processing-detail">{v.speed || "Ожидание ответа от Rutube..."}</span>
        </div>
      )}
    </li>
  );
}

function VideosSection({
  videos,
  total,
  filter,
  setFilter,
  page,
  setPage,
  refetch,
  currentVideoId,
}: {
  videos: Video[];
  total: number;
  filter: string;
  setFilter: (f: string) => void;
  page: number;
  setPage: (p: number) => void;
  refetch: () => void;
  currentVideoId: number | null;
}) {
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  async function resetVideo(id: number) {
    await fetch(`${API}/videos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
    refetch();
  }

  async function skipVideo(id: number) {
    await fetch(`${API}/videos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "skip" }),
    });
    refetch();
  }

  async function deleteVideo(id: number) {
    await fetch(`${API}/videos/${id}`, { method: "DELETE" });
    refetch();
  }

  return (
    <div className="videos-section">
      <h2>Видео ({total})</h2>
      <div className="filter-bar">
        {Object.entries(STATUS_LABELS).map(([key, label]) => (
          <button
            key={key}
            className={filter === key ? "active" : ""}
            onClick={() => {
              setFilter(key);
              setPage(0);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <ul className="video-list">
        {videos.map((v) => (
          <VideoItem
            key={v.id}
            v={v}
            isActive={v.id === currentVideoId}
            onReset={() => resetVideo(v.id)}
            onSkip={() => skipVideo(v.id)}
            onDelete={() => deleteVideo(v.id)}
          />
        ))}
        {videos.length === 0 && (
          <li className="empty-state">Нет видео</li>
        )}
      </ul>

      {totalPages > 1 && (
        <div className="pagination">
          <button
            className="small secondary"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            &larr; Назад
          </button>
          <span>
            {page + 1} / {totalPages}
          </span>
          <button
            className="small secondary"
            disabled={page >= totalPages - 1}
            onClick={() => setPage(page + 1)}
          >
            Вперёд &rarr;
          </button>
        </div>
      )}
    </div>
  );
}

function LogsSection({ logs }: { logs: LogEntry[] }) {
  return (
    <div className="logs-section">
      <h2>Логи (последние 100)</h2>
      <ul className="log-list">
        {logs.map((l) => (
          <li key={l.id} className="log-item">
            <span className="time">
              {new Date(l.created_at + "Z").toLocaleTimeString("ru")}
            </span>
            <span className={`badge ${l.level}`}>{l.level}</span>
            <span className="msg">{l.message}</span>
          </li>
        ))}
        {logs.length === 0 && (
          <li className="empty-state">Нет логов</li>
        )}
      </ul>
    </div>
  );
}

function PipelineLegend() {
  return (
    <div className="pipeline-legend">
      <h3>Пайплайн обработки видео</h3>
      <div className="legend-steps">
        {PIPELINE_STEPS.map((step, i) => (
          <React.Fragment key={step.key}>
            {i > 0 && <span className="legend-arrow">→</span>}
            <span className="legend-step">
              <span className="step-icon">{step.icon}</span>
              {step.label}
            </span>
          </React.Fragment>
        ))}
      </div>
      <p className="legend-desc">
        YouTube → Скачивание + субтитры → Перевод EN→RU (DeepSeek + Demucs + Edge-TTS) → Загрузка через прокси на Rutube
      </p>
    </div>
  );
}

function App() {
  const { data: stats, refetch: refetchStats } = useFetch<Stats>(
    `${API}/stats`,
    3000
  );
  const { data: sources, refetch: refetchSources } = useFetch<Source[]>(
    `${API}/sources`,
    5000
  );
  const { data: logs, refetch: refetchLogs } = useFetch<LogEntry[]>(
    `${API}/logs?limit=100`,
    5000
  );

  const [videoFilter, setVideoFilter] = useState("all");
  const [videoPage, setVideoPage] = useState(0);

  const statusParam = videoFilter === "all" ? "" : `&status=${videoFilter}`;
  const { data: videosData, refetch: refetchVideos } = useFetch<{
    videos: Video[];
    total: number;
  }>(`${API}/videos?limit=50&offset=${videoPage * 50}${statusParam}`, 2000);

  function refetchAll() {
    refetchStats();
    refetchSources();
    refetchVideos();
    refetchLogs();
  }

  async function triggerSync() {
    await fetch(`${API}/sync`, { method: "POST" });
    setTimeout(refetchAll, 1000);
  }

  if (!stats) {
    return <div className="empty-state">Загрузка...</div>;
  }

  return (
    <>
      <header>
        <h1>
          yt2<span>rutube</span>
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            className={`worker-badge ${stats.isProcessing ? "active" : "idle"}`}
          >
            <span className="dot" />
            {stats.isProcessing
              ? stats.currentPhase
                ? `${stats.currentPhase}...`
                : "Синхронизация..."
              : "Ожидание"}
          </div>
          {stats.lastCycleAt && (
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
              Последний цикл:{" "}
              {new Date(stats.lastCycleAt).toLocaleTimeString("ru")}
            </span>
          )}
          <button
            className="sync-btn"
            onClick={triggerSync}
            disabled={stats.isProcessing}
          >
            Запустить синхронизацию
          </button>
        </div>
      </header>

      <PipelineLegend />
      <StatsGrid stats={stats} />

      <div className="panels">
        <SourcesPanel sources={sources ?? []} refetch={refetchAll} />
        <AddVideoPanel onAdded={refetchAll} />
      </div>

      <VideosSection
        videos={videosData?.videos ?? []}
        total={videosData?.total ?? 0}
        filter={videoFilter}
        setFilter={setVideoFilter}
        page={videoPage}
        setPage={setVideoPage}
        refetch={refetchAll}
        currentVideoId={stats.currentVideoId}
      />

      <LogsSection logs={logs ?? []} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
