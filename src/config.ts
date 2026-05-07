import path from "path";

export const config = {
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS) || 14_400_000,
  maxVideosPerCycle: Number(process.env.MAX_VIDEOS_PER_CYCLE) || 1,
  maxRetries: Number(process.env.MAX_RETRIES) || 3,
  defaultFetchLimit: Number(process.env.DEFAULT_FETCH_LIMIT) || 5,
  minDurationSec: Number(process.env.MIN_DURATION_SEC) || 60,
  maxDurationSec: Number(process.env.MAX_DURATION_SEC) || 1800,
  rutubeCategory: Number(process.env.RUTUBE_CATEGORY_ID) || 2,
  dailyUploadLimit: Number(process.env.DAILY_UPLOAD_LIMIT) || 15,
  rutubeIsHidden: false,
  downloadsDir: process.env.DOWNLOADS_DIR
    ? path.resolve(process.env.DOWNLOADS_DIR)
    : path.resolve("downloads"),
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve("data"),
  servePort: Number(process.env.SERVE_PORT) || 8333,
  adminPort: Number(process.env.ADMIN_PORT) || 3847,
};
