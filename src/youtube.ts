import { $ } from "bun";
import path from "path";

export interface VideoMeta {
  id: string;
  title: string;
  description: string;
  filepath: string;
  thumbnailUrl: string | null;
  duration: number | null;
  tags: string[];
}

const DOWNLOADS_DIR = path.resolve(import.meta.dir, "..", "downloads");

export async function downloadVideo(
  url: string,
  maxHeight = 1080
): Promise<VideoMeta> {
  await Bun.write(Bun.file(DOWNLOADS_DIR + "/.keep"), "");

  const metaRaw =
    await $`yt-dlp --dump-json --no-download ${url}`.text();
  const meta = JSON.parse(metaRaw);

  const outputTemplate = path.join(DOWNLOADS_DIR, "%(id)s.%(ext)s");

  const proc = Bun.spawn(
    [
      "yt-dlp",
      "-f", `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]`,
      "--merge-output-format", "mp4",
      "-o", outputTemplate,
      "--no-playlist",
      "--retries", "3",
      "--fragment-retries", "3",
      url,
    ],
    { stdout: "inherit", stderr: "inherit" }
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`yt-dlp exited with code ${exitCode}`);
  }

  const filepath = path.join(DOWNLOADS_DIR, `${meta.id}.mp4`);
  const file = Bun.file(filepath);
  if (!(await file.exists())) {
    throw new Error(`Downloaded file not found: ${filepath}`);
  }

  return {
    id: meta.id,
    title: meta.title ?? "",
    description: meta.description ?? "",
    filepath,
    thumbnailUrl: meta.thumbnail ?? null,
    duration: meta.duration ?? null,
    tags: meta.tags ?? [],
  };
}

export async function getVideoInfo(url: string): Promise<Record<string, any>> {
  const raw = await $`yt-dlp --dump-json --no-download ${url}`.text();
  return JSON.parse(raw);
}
