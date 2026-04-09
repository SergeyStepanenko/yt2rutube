import path from "path";

export const config = {
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS) || 3_600_000,
  maxVideosPerCycle: Number(process.env.MAX_VIDEOS_PER_CYCLE) || 5,
  maxRetries: Number(process.env.MAX_RETRIES) || 3,
  rutubeCategory: Number(process.env.RUTUBE_CATEGORY_ID) || 2,
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
