import path from "path";
import type { RutubeClient } from "./rutube";

export interface UploadOptions {
  mp4Path: string;
  title: string;
  description?: string;
  categoryId?: number;
  isHidden?: boolean;
}

export interface UploadProgress {
  phase: "uploading_to_vps" | "rutube_downloading" | "rutube_processing";
  percent: number;
  detail: string;
}

export interface UploadResult {
  videoId: string;
  videoUrl: string;
  status: string;
}

const POLL_MS = 10_000;
const MAX_WAIT_MS = 30 * 60 * 1000;

const VPS_HOST = () => process.env.VPS_HOST ?? "";
const VPS_USER = () => process.env.VPS_USER ?? "root";
const VPS_SSH_PORT = () => process.env.VPS_SSH_PORT ?? "22";
const VPS_PUBLIC_URL = () => (process.env.VPS_PUBLIC_URL ?? "").replace(/\/$/, "");
const VPS_VIDEO_DIR = "/var/www/yt2rutube";

export async function uploadToRutube(
  rutube: RutubeClient,
  options: UploadOptions,
  onProgress?: (p: UploadProgress) => void
): Promise<UploadResult> {
  const mp4Path = options.mp4Path;
  const file = Bun.file(mp4Path);
  if (!(await file.exists())) {
    throw new Error(`MP4 not found: ${mp4Path}`);
  }
  const fileSize = file.size;
  const fileSizeMB = (fileSize / 1024 / 1024).toFixed(1);
  const title = options.title.slice(0, 100);

  const host = VPS_HOST();
  const user = VPS_USER();
  const sshPort = VPS_SSH_PORT();
  const publicUrl = VPS_PUBLIC_URL();

  if (!host || !publicUrl) {
    throw new Error("VPS_HOST and VPS_PUBLIC_URL must be set in .env");
  }

  // Random filename to avoid collisions
  const remoteFilename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`;
  const remotePath = `${VPS_VIDEO_DIR}/${remoteFilename}`;
  const fileUrl = `${publicUrl}/${remoteFilename}`;

  try {
    // ── 1. Upload file to VPS via rsync ──────────────────────
    onProgress?.({
      phase: "uploading_to_vps",
      percent: 0,
      detail: `Загрузка на VPS: 0/${fileSizeMB} МБ`,
    });

    console.log(`[uploader] Uploading ${fileSizeMB} MB to ${user}@${host}:${remotePath}`);

    const rsyncProc = Bun.spawn(
      [
        "rsync", "-e", `ssh -p ${sshPort} -o StrictHostKeyChecking=no`,
        "--progress", "--partial",
        mp4Path,
        `${user}@${host}:${remotePath}`,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );

    // Parse rsync progress
    const reader = rsyncProc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // rsync output: "  1,234,567  42%   12.34MB/s   0:00:03"
        const lines = buf.split(/[\r\n]/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const m = line.match(/(\d+)%\s+([\d.]+\S+\/s)/);
          if (m && onProgress) {
            const pct = parseInt(m[1]!);
            const speed = m[2]!;
            const sentMB = ((pct / 100) * fileSize / 1024 / 1024).toFixed(1);
            onProgress({
              phase: "uploading_to_vps",
              percent: pct,
              detail: `Загрузка на VPS: ${sentMB}/${fileSizeMB} МБ (${speed})`,
            });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const rsyncStderr = await new Response(rsyncProc.stderr).text();
    const rsyncExit = await rsyncProc.exited;
    if (rsyncExit !== 0) {
      throw new Error(`rsync failed (exit ${rsyncExit}): ${rsyncStderr.slice(-200)}`);
    }

    onProgress?.({
      phase: "uploading_to_vps",
      percent: 100,
      detail: `Файл на VPS: ${fileSizeMB} МБ`,
    });
    console.log(`[uploader] File uploaded to VPS: ${fileUrl}`);

    // ── 2. Send URL to Rutube API ────────────────────────────
    onProgress?.({
      phase: "rutube_downloading",
      percent: 0,
      detail: "Отправлен запрос в Rutube...",
    });

    const upload = await rutube.uploadByUrl({
      url: fileUrl,
      title,
      description: options.description ?? "",
      isHidden: options.isHidden ?? false,
      categoryId: options.categoryId ?? 2,
    });

    const videoId = upload.videoId;
    const uploadStartedAt = Date.now();
    console.log(`[uploader] Rutube video_id: ${videoId}, file URL: ${fileUrl}`);

    // ── 3. Poll Rutube until done ────────────────────────────
    const deadline = Date.now() + MAX_WAIT_MS;
    let lastVideoUrl = "";
    let pollCount = 0;

    while (Date.now() < deadline) {
      await Bun.sleep(POLL_MS);
      pollCount++;

      try {
        const video = await rutube.getVideo(videoId);
        const reason = video.action_reason?.name as string | undefined;
        const pubStatus = video.publication_status as string | undefined;
        if (typeof video.video_url === "string") {
          lastVideoUrl = video.video_url;
        }

        const elapsed = Math.round((Date.now() - uploadStartedAt) / 1000);
        const elapsedStr = elapsed >= 60
          ? `${Math.floor(elapsed / 60)}м ${elapsed % 60}с`
          : `${elapsed}с`;

        let statusText: string;
        let phase: UploadProgress["phase"] = "rutube_downloading";

        if (reason === "downloading_video") {
          statusText = `Rutube скачивает файл (${fileSizeMB} МБ) — ${elapsedStr}`;
          phase = "rutube_downloading";
        } else if (pubStatus === "wait" || reason === "waiting") {
          statusText = `Rutube обрабатывает видео — ${elapsedStr}`;
          phase = "rutube_processing";
        } else if (pubStatus === "converting") {
          statusText = `Rutube конвертирует видео — ${elapsedStr}`;
          phase = "rutube_processing";
        } else if (reason) {
          statusText = `Rutube: ${reason} — ${elapsedStr}`;
        } else {
          statusText = `Ожидание Rutube — ${elapsedStr}`;
        }

        onProgress?.({ phase, percent: -1, detail: statusText });
        console.log(`[uploader] Poll #${pollCount}: reason=${reason}, pub=${pubStatus}, elapsed=${elapsedStr}`);

        if (reason === "no_action" || reason === "moderation") {
          return { videoId, videoUrl: lastVideoUrl, status: reason };
        }
        if (reason === "error_upload_video") {
          return { videoId, videoUrl: lastVideoUrl, status: "error_upload_video" };
        }
      } catch {
        // keep polling
      }
    }

    return { videoId, videoUrl: lastVideoUrl, status: "timeout" };
  } finally {
    // ── Cleanup: delete file from VPS ──────────────────────
    try {
      const delProc = Bun.spawn(
        ["ssh", `-p`, sshPort, "-o", "StrictHostKeyChecking=no", `${user}@${host}`, `rm -f ${remotePath}`],
        { stdout: "pipe", stderr: "pipe" }
      );
      await delProc.exited;
      console.log(`[uploader] Deleted from VPS: ${remotePath}`);
    } catch {
      console.warn(`[uploader] Failed to delete from VPS: ${remotePath}`);
    }
  }
}
