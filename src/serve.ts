import path from "path";

const DOWNLOADS_DIR = path.resolve(import.meta.dir, "..", "downloads");
const PORT = Number(process.env.SERVE_PORT) || 8333;

/**
 * Rutube API downloads video by URL —
 * this mini-server serves downloaded files over HTTP
 * so Rutube can fetch them.
 */
export function startFileServer(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const urlPath = new URL(req.url).pathname;
      const decoded = decodeURIComponent(urlPath.slice(1));

      if (!decoded || decoded.includes("..")) {
        return new Response("Not found", { status: 404 });
      }

      const filepath = path.join(DOWNLOADS_DIR, decoded);
      const file = Bun.file(filepath);

      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }

      const ext = path.extname(filepath).toLowerCase();
      const contentType = ext === ".srt" ? "text/plain" : "video/mp4";

      return new Response(file, {
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(file.size),
        },
      });
    },
  });

  const baseUrl = `http://localhost:${server.port}`;
  console.log(`File server started: ${baseUrl}`);

  return {
    url: baseUrl,
    stop: () => server.stop(),
  };
}
