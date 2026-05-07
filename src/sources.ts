export interface VideoInfo {
  youtubeId: string;
  youtubeUrl: string;
  title: string;
  duration: number; // seconds
  width: number;
  height: number;
}

function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

async function runYtDlp(
  args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const cookieArgs: string[] = [];
  const cookieFile = process.env.YT_COOKIES_FILE;
  if (cookieFile) cookieArgs.push("--cookies", cookieFile);
  const ytDlp = process.env.YT_DLP_PATH || "yt-dlp";
  const proc = Bun.spawn([ytDlp, ...cookieArgs, "--sleep-requests", "2", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, stdout, stderr };
}

function parseJsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function pickYoutubeUrl(obj: Record<string, unknown>, id: string): string {
  const u = obj.url ?? obj.webpage_url ?? obj.original_url;
  if (typeof u === "string" && u.length > 0) return u;
  return watchUrl(id);
}

function entryToPartial(
  obj: Record<string, unknown>
): {
  youtubeId: string;
  youtubeUrl: string;
  title: string;
  duration: number;
  width: number;
  height: number;
} | null {
  const rawId = obj.id;
  const id =
    typeof rawId === "string"
      ? rawId
      : rawId !== null && rawId !== undefined
        ? String(rawId)
        : "";
  if (!id) return null;
  const title =
    typeof obj.title === "string" && obj.title.length > 0
      ? obj.title
      : "Untitled";
  const duration =
    typeof obj.duration === "number" && Number.isFinite(obj.duration)
      ? obj.duration
      : 0;
  const width =
    typeof obj.width === "number" && Number.isFinite(obj.width)
      ? obj.width
      : 0;
  const height =
    typeof obj.height === "number" && Number.isFinite(obj.height)
      ? obj.height
      : 0;
  return {
    youtubeId: id,
    youtubeUrl: pickYoutubeUrl(obj, id),
    title,
    duration,
    width,
    height,
  };
}

async function enrichWithFullJson(
  partial: NonNullable<ReturnType<typeof entryToPartial>>
): Promise<VideoInfo | null> {
  if (partial.width > 0 && partial.height > 0) {
    if (partial.width > partial.height) return partial as VideoInfo;
    return null;
  }

  const { ok, stdout, stderr } = await runYtDlp([
    "--dump-json",
    "--no-download",
    partial.youtubeUrl,
  ]);
  if (!ok) return null;

  const objs = parseJsonLines(stdout);
  const full = objs[0];
  if (!full) return null;

  const merged = entryToPartial(full);
  if (!merged) return null;

  const v: VideoInfo = {
    youtubeId: merged.youtubeId,
    youtubeUrl: merged.youtubeUrl,
    title: merged.title || partial.title,
    duration: merged.duration || partial.duration,
    width: merged.width,
    height: merged.height,
  };
  if (v.width > v.height) return v;
  return null;
}

function listArgs(url: string, limit?: number): string[] {
  const args = [
    "--dump-json",
    "--flat-playlist",
    "--no-download",
    "--no-warnings",
  ];
  if (limit !== undefined && limit > 0) {
    args.push("--playlist-end", String(limit));
  }
  args.push(url);
  return args;
}

export async function fetchChannelVideos(
  channelUrl: string,
  limit?: number
): Promise<VideoInfo[]> {
  const { ok, stdout } = await runYtDlp(listArgs(channelUrl, limit));
  if (!ok) return [];

  const results: VideoInfo[] = [];
  for (const obj of parseJsonLines(stdout)) {
    const partial = entryToPartial(obj);
    if (!partial) continue;
    if (partial.width > 0 && partial.height > 0 && partial.width <= partial.height) continue;
    results.push({
      youtubeId: partial.youtubeId,
      youtubeUrl: partial.youtubeUrl,
      title: partial.title,
      duration: partial.duration,
      width: partial.width,
      height: partial.height,
    });
  }
  return results;
}

export async function fetchPlaylistVideos(
  playlistUrl: string,
  limit?: number
): Promise<VideoInfo[]> {
  const { ok, stdout } = await runYtDlp(listArgs(playlistUrl, limit));
  if (!ok) return [];

  const results: VideoInfo[] = [];
  for (const obj of parseJsonLines(stdout)) {
    const partial = entryToPartial(obj);
    if (!partial) continue;
    if (partial.width > 0 && partial.height > 0 && partial.width <= partial.height) continue;
    results.push({
      youtubeId: partial.youtubeId,
      youtubeUrl: partial.youtubeUrl,
      title: partial.title,
      duration: partial.duration,
      width: partial.width,
      height: partial.height,
    });
  }
  return results;
}

export async function fetchVideoInfo(videoUrl: string): Promise<VideoInfo> {
  const { ok, stdout, stderr } = await runYtDlp([
    "--dump-json",
    "--no-download",
    "--no-warnings",
    videoUrl,
  ]);
  if (!ok) {
    throw new Error(stderr.trim() || "yt-dlp failed to fetch video info");
  }

  const objs = parseJsonLines(stdout);
  const obj = objs[0];
  if (!obj) {
    throw new Error("yt-dlp returned no JSON for video");
  }

  const partial = entryToPartial(obj);
  if (!partial) {
    throw new Error("Could not parse video id from yt-dlp output");
  }

  if (partial.width > 0 && partial.height > 0) {
    if (partial.width <= partial.height) {
      throw new Error("Video is not horizontal (landscape)");
    }
    return partial as VideoInfo;
  }

  const enriched = await enrichWithFullJson(partial);
  if (!enriched) {
    throw new Error("Video is not horizontal or metadata incomplete");
  }
  return enriched;
}
