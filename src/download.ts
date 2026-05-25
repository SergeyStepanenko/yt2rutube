import { $ } from "bun";
import path from "path";
import { mkdir } from "node:fs/promises";

const DOWNLOADS_DIR = path.resolve(import.meta.dir, "..", "downloads");

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

interface DownloadResult {
  id: string;
  title: string;
  directory: string;
  videoFile: string;
  subtitleFile: string | null;
}

async function download(url: string): Promise<DownloadResult> {
  const ytDlp = process.env.YT_DLP_PATH || "yt-dlp";
  console.log(`\nFetching metadata: ${url}`);
  const metaRaw = await $`${ytDlp} --dump-json --no-download ${url}`.text();
  const meta = JSON.parse(metaRaw);

  const title = sanitizeFilename(meta.title);
  const videoDir = path.join(DOWNLOADS_DIR, title);
  await mkdir(videoDir, { recursive: true });

  console.log(`Title: ${meta.title}`);
  console.log(`Directory: ${videoDir}`);

  const outputTemplate = path.join(videoDir, `${title}.%(ext)s`);

  console.log(`\nDownloading video in best quality...`);
  const proc = Bun.spawn(
    [
      ytDlp,
      "-f", "bestvideo+bestaudio/best",
      "--merge-output-format", "mp4",
      "-o", outputTemplate,
      "--no-playlist",
      "--retries", "3",
      "--fragment-retries", "3",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs", "en",
      "--sub-format", "srt",
      "--convert-subs", "srt",
      url,
    ],
    { stdout: "inherit", stderr: "inherit" }
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`yt-dlp exited with code ${exitCode}`);
  }

  const videoFile = path.join(videoDir, `${title}.mp4`);
  if (!(await Bun.file(videoFile).exists())) {
    throw new Error(`Video file not found: ${videoFile}`);
  }

  const srtFile = path.join(videoDir, `${title}.en.srt`);
  const subtitleFile = (await Bun.file(srtFile).exists()) ? srtFile : null;

  console.log(`\nDone!`);
  console.log(`  Video:     ${videoFile}`);
  console.log(`  Subtitles: ${subtitleFile ?? "not found"}`);

  return {
    id: meta.id,
    title: meta.title,
    directory: videoDir,
    videoFile,
    subtitleFile,
  };
}

const url = process.argv[2];
if (!url) {
  console.error("Usage:   bun run download <youtube-url>");
  console.error("Example: bun run download https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  process.exit(1);
}

try {
  await download(url);
} catch (err) {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
}
