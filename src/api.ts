import type { DB } from "./db";
import type { Logger } from "./logger";
import type { Worker } from "./worker";
import { generatePrometheusMetrics } from "./metrics";
import { fetchVideoInfo, fetchChannelVideos } from "./sources";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function cors(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export function createApiServer(db: DB, log: Logger, worker: Worker) {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const method = req.method;
      const pathname = url.pathname;

      if (method === "OPTIONS") return cors();

      // --- Metrics ---
      if (pathname === "/metrics") {
        return new Response(generatePrometheusMetrics(db), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      // --- API Routes ---

      // Stats overview
      if (pathname === "/api/stats" && method === "GET") {
        const stats = db.getStats();
        const sources = db.getSources();
        const settings = db.getAllSettings();
        return json({
          stats,
          sourcesCount: sources.length,
          lastCycleAt: worker.lastCycleAt?.toISOString() ?? null,
          isProcessing: worker.isProcessing,
          currentVideoId: worker.currentVideoId,
          currentPhase: worker.currentPhase,
          settings,
        });
      }

      // Sources
      if (pathname === "/api/sources" && method === "GET") {
        return json(db.getAllSources());
      }

      if (pathname === "/api/sources" && method === "POST") {
        const body = (await req.json()) as {
          type: string;
          url: string;
          name?: string;
        };
        if (!body.type || !body.url) {
          return json({ error: "type and url required" }, 400);
        }
        const source = db.addSource(body.type, body.url, body.name);
        log.info(`Source added: ${body.url}`);
        return json(source, 201);
      }

      const sourceMatch = pathname.match(/^\/api\/sources\/(\d+)$/);
      if (sourceMatch && method === "DELETE") {
        const id = Number(sourceMatch[1]);
        db.deleteSource(id);
        log.info(`Source #${id} deleted`);
        return json({ ok: true });
      }

      if (sourceMatch && method === "PATCH") {
        const id = Number(sourceMatch[1]);
        const body = (await req.json()) as {
          name?: string | null;
          enabled?: number;
          fetch_limit?: number;
        };
        db.updateSource(id, body);
        return json({ ok: true });
      }

      // Settings
      if (pathname === "/api/settings" && method === "GET") {
        return json(db.getAllSettings());
      }

      if (pathname === "/api/settings" && method === "PATCH") {
        const body = (await req.json()) as Record<string, string>;
        const allowed = ["sync_interval_ms", "max_videos_per_cycle", "min_duration", "max_duration", "auto_discover"];
        for (const key of allowed) {
          if (body[key] !== undefined) {
            db.setSetting(key, String(body[key]));
          }
        }
        log.info("Settings updated");
        return json(db.getAllSettings());
      }

      // Videos
      if (pathname === "/api/videos" && method === "GET") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const status = url.searchParams.get("status") ?? undefined;
        const sourceId = url.searchParams.get("source_id")
          ? Number(url.searchParams.get("source_id"))
          : undefined;
        const result = db.getAllVideos(offset, limit, status, sourceId);
        return json(result);
      }

      // Add single video URL
      if (pathname === "/api/videos" && method === "POST") {
        const body = (await req.json()) as { url: string };
        if (!body.url) return json({ error: "url required" }, 400);

        try {
          const info = await fetchVideoInfo(body.url);
          const row = db.addVideo(
            info.youtubeId,
            info.youtubeUrl,
            info.title,
            info.duration,
            info.width > info.height
          );
          if (!row) {
            return json({ error: "Video already exists" }, 409);
          }
          log.info(`Video added manually: ${info.title}`);
          return json(row, 201);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg }, 400);
        }
      }

      // Add channel — fetch all horizontal videos (no limit for initial add)
      if (pathname === "/api/channels" && method === "POST") {
        const body = (await req.json()) as { url: string; name?: string; fetch_limit?: number };
        if (!body.url) return json({ error: "url required" }, 400);

        const source = db.addSource("channel", body.url, body.name, body.fetch_limit);
        log.info(`Channel added: ${body.url}`);

        const minDur = db.getSettingNum("min_duration", 60);
        const maxDur = db.getSettingNum("max_duration", 1800);

        (async () => {
          try {
            const videos = await fetchChannelVideos(body.url);
            let added = 0;
            for (const v of videos) {
              if (v.width > 0 && v.height > 0 && v.width <= v.height) continue;
              if (v.duration > 0 && (v.duration < minDur || v.duration > maxDur)) continue;
              const row = db.addVideo(
                v.youtubeId,
                v.youtubeUrl,
                v.title,
                v.duration,
                true,
                source.id
              );
              if (row) added++;
            }
            log.info(
              `Channel ${body.name ?? body.url}: found ${videos.length} videos, added ${added}`
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log.error(`Error fetching channel ${body.url}: ${msg}`);
          }
        })();

        return json({ source, message: "Channel added, videos being discovered in background" }, 202);
      }

      const videoMatch = pathname.match(/^\/api\/videos\/(\d+)$/);
      if (videoMatch && method === "DELETE") {
        const id = Number(videoMatch[1]);
        db.deleteVideo(id);
        return json({ ok: true });
      }

      if (videoMatch && method === "PATCH") {
        const id = Number(videoMatch[1]);
        const body = (await req.json()) as { action: string };
        if (body.action === "reset") {
          db.resetVideo(id);
          log.info(`Video #${id} reset to pending`);
          return json({ ok: true });
        }
        if (body.action === "skip") {
          db.updateVideoStatus(id, "skipped");
          return json({ ok: true });
        }
        return json({ error: "Unknown action" }, 400);
      }

      // Bulk actions
      if (pathname === "/api/videos/bulk" && method === "POST") {
        const body = (await req.json()) as { action: string };
        if (body.action === "reset_errors") {
          const count = db.resetAllErrors();
          log.info(`Reset ${count} errors`);
          return json({ ok: true, count });
        }
        if (body.action === "skip_pending") {
          const count = db.skipAllPending();
          log.info(`Skipped ${count} pending videos`);
          return json({ ok: true, count });
        }
        return json({ error: "Unknown action" }, 400);
      }

      // Logs
      if (pathname === "/api/logs" && method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return json(db.getRecentLogs(limit));
      }

      // Trigger manual cycle
      if (pathname === "/api/sync" && method === "POST") {
        if (worker.isProcessing) {
          return json({ error: "Sync already in progress" }, 409);
        }
        worker.runCycle().catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          log.error(`Manual sync failed: ${msg}`);
        });
        return json({ message: "Sync started" }, 202);
      }

      // Worker status
      if (pathname === "/api/worker" && method === "GET") {
        return json({
          isProcessing: worker.isProcessing,
          lastCycleAt: worker.lastCycleAt?.toISOString() ?? null,
        });
      }

      // Serve admin frontend for any non-API path
      if (!pathname.startsWith("/api") && pathname !== "/metrics") {
        return new Response(null, { status: 404 });
      }

      return json({ error: "Not found" }, 404);
    },
  };
}
