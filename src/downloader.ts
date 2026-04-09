import path from "path";
import { mkdir } from "node:fs/promises";

export interface DownloadResult {
  id: string;
  title: string;
  description: string;
  directory: string;
  videoFile: string;
  subtitleFile: string | null;
  fileSize: number;
}

export interface DownloadProgress {
  percent: number;
  speed: string;
  eta: string;
  totalSize: string;
}

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function parseProgress(line: string): DownloadProgress | null {
  // yt-dlp output: [download]  45.2% of  984.22MiB at  12.34MiB/s ETA 00:42
  const m = line.match(
    /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\S+)\s+at\s+([\d.]+\S+\/s)\s+ETA\s+(\S+)/
  );
  if (m) {
    return {
      percent: parseFloat(m[1]!),
      totalSize: m[2]!,
      speed: m[3]!,
      eta: m[4]!,
    };
  }
  // Merging line: [download]  100% of  984.22MiB
  const m2 = line.match(/\[download\]\s+100%\s+of\s+~?([\d.]+\S+)/);
  if (m2) {
    return { percent: 100, totalSize: m2[1]!, speed: "—", eta: "00:00" };
  }
  return null;
}

export async function downloadVideo(
  url: string,
  downloadsDir: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult> {
  await mkdir(downloadsDir, { recursive: true });

  const metaProc = Bun.spawn(
    ["yt-dlp", "--dump-json", "--no-download", url],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [metaOut, metaErr] = await Promise.all([
    new Response(metaProc.stdout).text(),
    new Response(metaProc.stderr).text(),
  ]);
  const metaCode = await metaProc.exited;
  if (metaCode !== 0) {
    throw new Error(
      `yt-dlp metadata failed (${metaCode}): ${metaErr.trim() || "unknown error"}`
    );
  }

  const metaLine = metaOut
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!metaLine) throw new Error("yt-dlp returned empty metadata");

  const meta = JSON.parse(metaLine) as { id?: string; title?: string; description?: string };
  if (!meta.id) throw new Error("yt-dlp metadata missing video id");

  const title = sanitizeFilename(meta.title ?? "video");
  const videoDir = path.join(downloadsDir, title);
  await mkdir(videoDir, { recursive: true });

  const outputTemplate = path.join(videoDir, `${title}.%(ext)s`);

  const proc = Bun.spawn(
    [
      "yt-dlp",
      "-f", "bestvideo+bestaudio/best",
      "--merge-output-format", "mp4",
      "-o", outputTemplate,
      "--no-playlist",
      "--retries", "3",
      "--fragment-retries", "3",
      "--newline",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs", "en",
      "--sub-format", "srt",
      "--convert-subs", "srt",
      url,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  // Stream stdout for progress parsing
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nlIdx);
        buf = buf.slice(nlIdx + 1);
        if (onProgress) {
          const p = parseProgress(line);
          if (p) onProgress(p);
        }
      }
      // Also check carriage return (yt-dlp uses \r for in-place updates)
      while ((nlIdx = buf.indexOf("\r")) !== -1) {
        const line = buf.slice(0, nlIdx);
        buf = buf.slice(nlIdx + 1);
        if (onProgress) {
          const p = parseProgress(line);
          if (p) onProgress(p);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `yt-dlp exited with code ${exitCode}${stderrText ? `: ${stderrText.trim()}` : ""}`
    );
  }

  const videoFile = path.join(videoDir, `${title}.mp4`);
  if (!(await Bun.file(videoFile).exists())) {
    throw new Error(`Video file not found after download: ${videoFile}`);
  }

  const srtFile = path.join(videoDir, `${title}.en.srt`);
  const subtitleFile = (await Bun.file(srtFile).exists()) ? srtFile : null;
  const fileSize = Bun.file(videoFile).size;

  return {
    id: meta.id,
    title: meta.title ?? title,
    description: meta.description ?? "",
    directory: videoDir,
    videoFile,
    subtitleFile,
    fileSize,
  };
}
