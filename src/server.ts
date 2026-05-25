import path from "path";
import { config } from "./config";
import { DB } from "./db";
import { Logger } from "./logger";
import { Worker } from "./worker";
import { createApiServer } from "./api";
import adminHtml from "../admin/index.html";

const db = new DB();
const log = new Logger(db);

const recovered = db.recoverStuckVideos();
if (recovered > 0) {
  log.info(`Recovered ${recovered} stuck videos (downloading/uploading → pending)`);
}

const worker = new Worker(db, log);
const api = createApiServer(db, log, worker);

const ADMIN_DIR = path.resolve(import.meta.dir, "../admin");

const server = Bun.serve({
  port: config.adminPort,
  routes: {
    "/": adminHtml,
  },
  async fetch(req) {
    const url = new URL(req.url);

    if (
      url.pathname.startsWith("/api") ||
      url.pathname === "/metrics"
    ) {
      return api.fetch(req);
    }

    const staticExts = [".ico", ".png", ".svg", ".webmanifest"];
    if (staticExts.some((ext) => url.pathname.endsWith(ext))) {
      const filePath = path.join(ADMIN_DIR, path.basename(url.pathname));
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }
    }

    return new Response("Not found", { status: 404 });
  },
  development: {
    hmr: true,
    console: true,
  },
});

log.info(`Admin UI: http://localhost:${config.adminPort}`);
log.info(`Metrics:  http://localhost:${config.adminPort}/metrics`);

worker.startDaemon().catch((e) => {
  log.error(`Daemon crashed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

process.on("SIGINT", () => {
  log.info("Shutting down...");
  worker.stop();
  server.stop();
  db.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  worker.stop();
  server.stop();
  db.close();
  process.exit(0);
});
