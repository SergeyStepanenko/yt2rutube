import path from "path";
import { downloadVideo, type VideoMeta } from "./youtube";
import { RutubeClient } from "./rutube";
import { startFileServer } from "./serve";

interface TransferResult {
  youtube: VideoMeta;
  rutubeVideoId: string;
  rutubeRaw: Record<string, any>;
}

/**
 * Full pipeline: YouTube → local disk → Rutube.
 *
 * 1. Downloads the video from YouTube via yt-dlp
 * 2. Starts a local HTTP server for the file
 * 3. Authenticates with Rutube
 * 4. Sends the file URL to the Rutube API
 * 5. Stops the server (optionally, after a timeout)
 */
export async function transfer(
  youtubeUrl: string,
  options?: {
    rutubeEmail?: string;
    rutubePassword?: string;
    maxHeight?: number;
    categoryId?: number;
    isHidden?: boolean;
    /** Public URL if the file is already accessible externally (e.g. via ngrok) */
    publicBaseUrl?: string;
    /** Wait time (ms) before stopping the server so Rutube can finish downloading */
    serveTimeout?: number;
  }
): Promise<TransferResult> {
  const email = options?.rutubeEmail ?? process.env.RUTUBE_EMAIL;
  const password = options?.rutubePassword ?? process.env.RUTUBE_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "Rutube credentials required. Set RUTUBE_EMAIL and RUTUBE_PASSWORD in .env"
    );
  }

  // 1. Download the video
  console.log(`\n[1/4] Downloading video: ${youtubeUrl}`);
  const video = await downloadVideo(youtubeUrl, options?.maxHeight);
  console.log(`      Done: ${video.title} (${video.id})`);

  // 2. Start the file server
  console.log(`\n[2/4] Starting file server...`);
  const server = startFileServer();
  const filename = path.basename(video.filepath);
  const fileUrl = options?.publicBaseUrl
    ? `${options.publicBaseUrl}/${filename}`
    : `${server.url}/${filename}`;

  console.log(`      File available at: ${fileUrl}`);

  try {
    // 3. Authenticate with Rutube
    console.log(`\n[3/4] Authenticating with Rutube...`);
    const rutube = new RutubeClient();
    await rutube.login(email, password);

    // 4. Upload
    console.log(`\n[4/4] Sending video to Rutube...`);
    const result = await rutube.uploadByUrl({
      url: fileUrl,
      title: video.title,
      description: video.description,
      isHidden: options?.isHidden,
      categoryId: options?.categoryId,
    });

    console.log(`\n  Video sent to Rutube!`);
    console.log(`  Video ID: ${result.videoId}`);

    // Give Rutube time to download the file before stopping the server
    const timeout = options?.serveTimeout ?? 5 * 60 * 1000;
    console.log(
      `\n  Server will keep running for ${timeout / 1000}s so Rutube can download the file...`
    );
    console.log(`  (Press Ctrl+C to stop early)\n`);

    await Bun.sleep(timeout);
    server.stop();

    return { youtube: video, rutubeVideoId: result.videoId, rutubeRaw: result.raw };
  } catch (err) {
    server.stop();
    throw err;
  }
}
