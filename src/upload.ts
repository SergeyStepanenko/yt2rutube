import path from "path";
import { RutubeClient } from "./rutube";
import { startTunnel } from "./tunnel";

const videoPath = process.argv[2];

if (!videoPath) {
  console.error("Usage:   bun run upload <path-to-video-or-folder>");
  console.error("Example: bun run upload 'downloads/Best MotoGP™ Moments 🔥 2026 US GP'");
  process.exit(1);
}

const email = process.env.RUTUBE_EMAIL;
const password = process.env.RUTUBE_PASSWORD;

if (!email || !password) {
  console.error("Set RUTUBE_EMAIL and RUTUBE_PASSWORD in .env");
  process.exit(1);
}

const resolvedPath = path.resolve(videoPath);

let mp4Path: string;
let title: string;

if (resolvedPath.endsWith(".mp4") && await Bun.file(resolvedPath).exists()) {
  mp4Path = resolvedPath;
  title = path.basename(resolvedPath, ".mp4");
} else {
  const glob = new Bun.Glob("*.mp4");
  let found = "";
  for await (const file of glob.scan(resolvedPath)) {
    found = path.join(resolvedPath, file);
    break;
  }
  if (!found) {
    console.error(`No .mp4 file found: ${resolvedPath}`);
    process.exit(1);
  }
  mp4Path = found;
  title = path.basename(path.dirname(mp4Path));
}

const file = Bun.file(mp4Path);
const fileSize = file.size;
console.log(`\nFile:  ${mp4Path}`);
console.log(`Size:  ${(fileSize / 1024 / 1024).toFixed(1)} MB`);
console.log(`Title: ${title}`);

const PORT = Number(process.env.SERVE_PORT) || 8333;

// 1. Server that serves a single specific file at /video.mp4
console.log(`\n[1/5] Starting file server...`);
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const urlPath = new URL(req.url).pathname;
    if (urlPath === "/video.mp4") {
      return new Response(Bun.file(mp4Path), {
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(fileSize),
        },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});
console.log(`       Server: http://localhost:${PORT}/video.mp4`);

// 2. Tunnel
console.log(`[2/5] Starting cloudflared tunnel...`);
const tunnel = await startTunnel(PORT);
const fileUrl = `${tunnel.publicUrl}/video.mp4`;
console.log(`       Public URL: ${fileUrl}`);

try {
  // 3. Authentication
  console.log(`\n[3/5] Authenticating with Rutube...`);
  const rutube = new RutubeClient();
  await rutube.login(email, password);

  // 4. Upload
  console.log(`[4/5] Sending video to Rutube...`);
  const result = await rutube.uploadByUrl({
    url: fileUrl,
    title: title.slice(0, 100),
    description: "",
    isHidden: false,
    categoryId: 2,
  });

  console.log(`\n       Video sent!`);
  console.log(`       Video ID: ${result.videoId}`);

  // 5. Wait for Rutube to download the file
  const waitMinutes = 10;
  console.log(`\n[5/5] Waiting up to ${waitMinutes} minutes for Rutube to download the file...`);
  console.log(`       (Ctrl+C to stop early)\n`);

  for (let i = 0; i < waitMinutes * 6; i++) {
    await Bun.sleep(10_000);
    try {
      const video = await rutube.getVideo(result.videoId);
      const reason = video.action_reason?.name;
      const statusStr = reason ?? "processing";
      process.stdout.write(`\r       Status: ${statusStr}          `);

      if (reason === "no_action" || reason === "moderation") {
        console.log(`\n\n       Rutube processed the file! Status: ${reason}`);
        console.log(`       URL: ${video.video_url}`);
        break;
      }
      if (reason === "error_upload_video") {
        console.log(`\n\n       Upload error on Rutube's side.`);
        console.log(`       Rutube may have failed to download the file.`);
        break;
      }
    } catch {
      process.stdout.write(`\r       Checking...                     `);
    }
  }
} finally {
  tunnel.stop();
  server.stop();
  console.log("\nServer and tunnel stopped.");
}
