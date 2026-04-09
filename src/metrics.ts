import type { DB } from "./db";

export function generatePrometheusMetrics(db: DB): string {
  const stats = db.getStats();
  const lines: string[] = [];

  lines.push("# HELP yt2rutube_videos_total Total number of videos in database");
  lines.push("# TYPE yt2rutube_videos_total gauge");
  lines.push(`yt2rutube_videos_total ${stats.total}`);

  lines.push("# HELP yt2rutube_videos_by_status Number of videos by status");
  lines.push("# TYPE yt2rutube_videos_by_status gauge");
  for (const [status, count] of Object.entries(stats)) {
    if (status === "total") continue;
    lines.push(`yt2rutube_videos_by_status{status="${status}"} ${count}`);
  }

  const uploadsPerDay = db.getUploadsPerDay(7);
  lines.push("# HELP yt2rutube_uploads_daily Daily successful uploads");
  lines.push("# TYPE yt2rutube_uploads_daily gauge");
  for (const row of uploadsPerDay) {
    lines.push(`yt2rutube_uploads_daily{date="${row.date}"} ${row.count}`);
  }

  const errorsPerDay = db.getErrorsPerDay(7);
  lines.push("# HELP yt2rutube_errors_daily Daily errors");
  lines.push("# TYPE yt2rutube_errors_daily gauge");
  for (const row of errorsPerDay) {
    lines.push(`yt2rutube_errors_daily{date="${row.date}"} ${row.count}`);
  }

  const sources = db.getSources();
  lines.push("# HELP yt2rutube_sources_total Total active sources");
  lines.push("# TYPE yt2rutube_sources_total gauge");
  lines.push(`yt2rutube_sources_total ${sources.length}`);

  return lines.join("\n") + "\n";
}
